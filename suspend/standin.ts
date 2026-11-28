// The stand-in: holds a suspended agent's terminal, collects the messages sent
// to it, never runs them, and wakes the agent with them as its first prompt.
// Started by herdr-shell as `herdr-standin <agent> <address> <name> [shell arguments...]`.
//
// Everything that touches the process or the terminal goes through System, so
// tests replace it with fakes. The start command comes from the shared recipe
// module that recovery uses; this file builds it into the binary.

import { PI_RECOVERY, SESSION, STANDIN_APP, SUSPENDED, holdsPiSession, shellQuote, piRecovery, recipe, suspension, type Suspension } from "../herdr/mods/tab-tree/recipes.js";
import { createInput, trimLineBreaks, type InputEvent } from "./input";
import { watchdog } from "./watchdog";

export interface System {
  env: Record<string, string | undefined>;
  /** process.platform */
  platform: string;
  /** Removes a variable from the environment that a replacement inherits. */
  unsetenv(name: string): void;
  /** Writes to the terminal, synchronously, so nothing is lost on exec. */
  write(text: string): void;
  /** Starts reading the terminal. */
  listen(onData: (chunk: string) => void): void;
  /** Raw mode on while the stand-in reads, off before it hands the terminal over. */
  raw(on: boolean): void;
  hc(args: string[]): Promise<{ code: number; stdout: string }>;
  /** The names in a folder; none when it cannot be read. */
  list(dir: string): Promise<string[]>;
  /** The start of a file, or null when it cannot be read. */
  readHead(path: string): Promise<string | null>;
  /** Writes a private file, creating its folders. */
  save(path: string, text: string): Promise<void>;
  /** Changes the working folder; an error text on failure. */
  chdir(path: string): string | null;
  /** Runs argv detached (its own session), with the terminal as its output, and waits until it exits. */
  background(argv: string[]): Promise<void>;
  /** Replaces this process (execvp). Never settles on success; the error text on failure. */
  exec(argv: string[]): Promise<string>;
  now(): number;
  after(ms: number, run: () => void): void;
  /** Calls handler for an uncaught error or an unhandled rejection, and keeps the process alive: an ordinary exit would end a kept terminal. */
  onError(handler: (error: unknown) => void): void;
}

const APP = STANDIN_APP;
// Lines that herdr-shell read while it waited (its error path), one message.
export const PENDING = "HERDR_STANDIN_PENDING";
const BATCH_MS = 500;
const RETRY_MS = 200;
const RETRIES = 10; // about 2 s while the core restarts
// Runs the words it is given, then the user's shell with shellWords, so
// exiting the agent returns to a prompt. `set -m` (job control) gives the
// agent its own process group: hc then names the agent, not this wrapper, as
// the program in front, and the policy can suspend it again (root=shell).
const thenShell = (shellWords: string[]) => `set -m; "$@"; exec "\${SHELL:-/bin/sh}"${shellWords.map((w) => ` ${shellQuote(w)}`).join("")}`;

type Status = "idle" | "working" | "blocked";
// An OSC 7501 status report (fact F5 in plans/agent-suspension.md).
const report = (state: Status, msg?: string) =>
  `\x1b]7501;state=${state}:app=${APP}${msg ? `:msg=${Buffer.from(msg).toString("base64")}` : ""}\x1b\\`;
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
type Suspended = { record: Suspension; labels: Record<string, string> };

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const printable = (s: unknown): s is string => typeof s === "string" && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);

export async function standin(args: string[], sys: System): Promise<void> {
  const [agentArg = "agent", address = "", name = "", ...shellArgs] = args;
  // The user's shell starts with the arguments hc gave herdr-shell. hc starts
  // login shells on macOS, and a configured shell gets none, so -l there.
  const shellWords = shellArgs.length ? shellArgs : sys.platform === "darwin" ? ["-l"] : [];
  const pause = (ms: number) => new Promise<void>((done) => sys.after(ms, done));
  // Never passed on to the agent or a shell.
  const pending = trimLineBreaks(sys.env[PENDING] ?? "");
  if (PENDING in sys.env) sys.unsetenv(PENDING);
  let agent = agentArg;
  let batch: string[] | null = null; // the messages of the wake being collected
  let batchGeneration = 0; // ends the window of a batch that an error already handled
  let windowClosed = false; // the 500 ms after the first message are over
  let waking = false;
  let reported: Status | null = null; // the last report
  const reportStatus = (state: Status, msg?: string) => { sys.write(report(state, msg)); reported = state; };

  // An unexpected error takes the missing-session path: the collected messages
  // go to a file and the stand-in reports blocked. It never exits.
  sys.onError((error) => {
    if (waking) { sys.write(`\r\n${APP}: ${describe(error)}\r\n`); return; } // the wake handles its own messages
    const messages = takeBatch();
    void keepUndelivered(messages, `unexpected error: ${describe(error)}`).catch(() => {});
  });

  // hc refuses with exit 5 (unavailable) while the core restarts (fact F4 in plans/agent-suspension.md).
  async function hc(words: string[]) {
    for (let attempt = 0; ; attempt++) {
      const result = await sys.hc(words);
      if (result.code !== 5 || attempt >= RETRIES) return result;
      await pause(RETRY_MS);
    }
  }

  async function readLabels(): Promise<Record<string, string> | null> {
    try {
      const result = await hc(["get", address, "--json"]);
      if (result.code !== 0) return null;
      const labels = JSON.parse(result.stdout)?.labels ?? {};
      return typeof labels === "object" && !Array.isArray(labels) ? labels : null;
    } catch { return null; }
  }

  // A stale stand-in: the terminal is not suspended, so it gets the user's shell.
  async function handover() {
    if (pending.trim()) sys.write(`${APP}: this terminal is not suspended; the lines typed while herdr-shell waited were dropped, not run.\r\n`);
    for (const shell of [sys.env.SHELL, "/bin/sh"]) {
      if (!shell) continue;
      const error = await sys.exec([shell, ...shellWords]).catch(describe);
      sys.write(`${APP}: cannot start ${shell}: ${error}\r\n`);
    }
  }

  const labels = await readLabels();
  if (labels && !Object.hasOwn(labels, SUSPENDED)) return handover();
  const recordText = labels?.[SUSPENDED];
  const record = suspension(recordText);
  agent = record?.agent ?? agentArg;
  // Without a readable record the stand-in can only hold the terminal; it never falls back to a shell.
  const suspended: Suspended | { cannotWake: string } = labels === null ? { cannotWake: `hc could not read terminal ${address}` }
    : record === null ? { cannotWake: "its suspension record is unreadable" } : { record, labels };

  // Why the recorded session cannot be resumed, or null. Never a picker or a new conversation.
  async function sessionMissing({ record, labels }: Suspended): Promise<string | null> {
    if (record.agent === "claude") {
      const id = labels[SESSION];
      if (!printable(id)) return "Claude has no session id";
      return await claudeTranscript(id) ? null : `Claude's session ${id} has no transcript`;
    }
    const recovery = piRecovery(labels[PI_RECOVERY]);
    if (!recovery?.sessionFile) return "Pi has no session file";
    const head = await sys.readHead(recovery.sessionFile);
    return holdsPiSession(head, recovery.sessionId) ? null : `its session file ${recovery.sessionFile} is missing or holds another session`;
  }

  // Claude keeps a session's conversation in ~/.claude/projects/<folder>/<id>.jsonl.
  // A session id without that file cannot be resumed (fact F2 in plans/agent-suspension.md).
  async function claudeTranscript(id: string): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return false;
    const projects = `${sys.env.HOME ?? ""}/.claude/projects`;
    for (const folder of await sys.list(projects)) {
      if (await sys.readHead(`${projects}/${folder}/${id}.jsonl`) !== null) return true;
    }
    return false;
  }

  // Returns only when the agent was not woken, with the reason.
  async function tryWake(): Promise<string> {
    if ("cannotWake" in suspended) return suspended.cannotWake;
    const missing = await sessionMissing(suspended);
    if (missing) return missing;
    const { record, labels } = suspended;
    const start = recipe(record.agent, labels, { tab: name || null, picker: false });
    if (!start) return `${agent} has no recipe`;
    reportStatus("working");
    sys.write(`waking ${agent}…\r\n`);
    const cwd = start.cwd ?? record.cwd;
    const chdirError = sys.chdir(cwd);
    if (chdirError) return `cannot enter ${cwd}: ${chdirError}`;
    if ((await hc(["label", address, `${SUSPENDED}=`])).code !== 0) return "hc could not remove its suspension label";
    const messages = batch ?? [];
    const words = messages.length ? [...start.argv, "--", messages.join("\n\n")] : start.argv;
    const argv = record.root === "shell" ? ["/bin/sh", "-c", thenShell(shellWords), "sh", ...words] : words;
    await sys.background(watchdog(address)).catch(() => {});
    sys.write("\x1b[?2004l");
    sys.raw(false);
    const error = await sys.exec(argv).catch(describe);
    // Still here: the replacement failed, so the terminal stays suspended.
    sys.raw(true);
    sys.write("\x1b[?2004h");
    await hc(["label", address, `${SUSPENDED}=${recordText}`]);
    return `cannot start ${argv[0]}: ${error}`;
  }

  function undeliveredPath() {
    const state = sys.env.XDG_STATE_HOME?.startsWith("/") ? sys.env.XDG_STATE_HOME : `${sys.env.HOME ?? ""}/.local/state`;
    return `${state}/herdr-tincho-config/undelivered/${address.replace(/[^A-Za-z0-9._-]/g, "_")}-${sys.now()}.txt`;
  }

  // Not woken: keep the messages in a file, say where, and report blocked so
  // hc tells the parent. Every failed wake reports blocked again; an empty
  // one (a focus press) shows its reason on the screen only once.
  async function keepUndelivered(messages: string[], reason: string) {
    let note = `${agent} not woken: ${reason}.`;
    let shown = note;
    if (messages.length) {
      const path = undeliveredPath();
      const text = messages.join("\n\n");
      try {
        await sys.save(path, text);
        shown = note += ` Messages saved to ${path}`;
      } catch (error) {
        note += ` Could not save the messages: ${(error as Error).message}`;
        shown = `${note}\n${text}`;
      }
    }
    if (messages.length || reported !== "blocked") sys.write(`\r\n💤 ${shown.replace(/\n/g, "\r\n")}\r\n`);
    reportStatus("blocked", note);
  }

  function takeBatch() {
    const messages = batch ?? [];
    batch = null;
    batchGeneration++;
    windowClosed = false;
    return messages;
  }

  async function wake() {
    waking = true;
    let reason: string;
    try { reason = await tryWake(); } catch (error) { reason = `unexpected error: ${describe(error)}`; }
    const messages = takeBatch();
    try { await keepUndelivered(messages, reason); } catch { /* shown as far as it got */ }
    waking = false;
    maybeWake();
  }

  function maybeWake() {
    if (windowClosed && !waking && !input.pasting) void wake();
  }

  function onEvent(event: InputEvent) {
    if (batch === null) {
      batch = [];
      const generation = batchGeneration;
      sys.after(BATCH_MS, () => { if (generation === batchGeneration) { windowClosed = true; maybeWake(); } });
    }
    if ("message" in event) batch.push(event.message);
  }

  const input = createInput(onEvent, (text) => sys.write(text));
  sys.raw(true);
  sys.listen((chunk) => { input.feed(chunk); maybeWake(); });
  sys.write("\x1b[?2004h");
  sys.write(`\r\n💤 ${agent} suspended at ${record ? clock(record.since) : "--:--"} · wakes on a message or a click on its row · Enter wakes it\r\n`);
  if ("cannotWake" in suspended) {
    // Blocked, so hc refuses sends and tells the parent; typed messages are kept in files.
    sys.write(`💤 ${agent} cannot wake: ${suspended.cannotWake}. Typed messages are kept in files.\r\n`);
    reportStatus("blocked", `${agent} cannot wake: ${suspended.cannotWake}`);
  } else {
    reportStatus("idle");
  }
  if (pending.trim()) onEvent({ message: pending });
}
