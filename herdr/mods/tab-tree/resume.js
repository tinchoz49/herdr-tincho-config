// Bringing an agent back in a terminal that lost it (hc server stop, a crash,
// a reboot). herdr-core keeps nothing of the program it lost: each agent's
// plugin leaves its resume report on the terminal (resume-report.js), and the
// core keeps the labels across restarts.

import { hc, exec } from "herdr";
import { LABEL, SUSPENDED, STANDIN_APP, pickerLine } from "./recipes.js";
import { reportOf, resumeLine, proofHeld } from "./resume-report.js";
export { LABEL, hasPicker } from "./recipes.js";

// Types a command line into the terminal's shell, so the person's own agent
// commands (functions, wrappers) run it.
export function send(address, line) {
  return hc(["send", address, line]);
}

// An agent is only an agent to Herdr if it reports its status (OSC 7501).
// Claude asks the terminal once, as it starts, whether it may (`OSC 7501 ; ?`);
// with no reply in time it never reports, and its tab looks like a plain shell
// for good. Many resumed at once can miss that window. So resumes run one at a
// time, each is checked until it reports, and one that doesn't is exited and
// started again.
const TRIES = 3;
const REPORT_MS = 20000;
const EXIT_MS = 10000;

async function info(address) {
  const r = await hc(["get", address]).catch(() => null);
  try { return r && r.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

// The shell is in front again, or the terminal is gone.
const atShell = (j) => !j || j.state !== "live" || !j.foreground || j.foreground.pid === j.pid;

// The shells the app's program table knows (programs.json "shells").
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd", "elvish", "xonsh", "tcsh", "csh", "ksh", "ion"]);
// hc's configured shell (suspend/herdr-shell), a script that sh runs.
export const HERDR_SHELL = "herdr-shell";
/** @param {unknown} word */
const programName = (word) => typeof word === "string" ? word.split(/[\\/]/).pop().replace(/^-/, "") : "";

// What runs in front of a terminal, from its foreground process, never from a
// status report: { name, shell }, or null when hc gave no foreground argv. A
// launch wrapper (sh -c '"$@"; exec ...' sh <command>: the stand-in's wake for
// root=shell, and the app's own launchers) counts as the command it runs.
// t: from terminals() or hc get.
/** @param {Record<string, any> | null | undefined} t @returns {{ name: string, shell: boolean } | null} */
export function frontProgram(t) {
  let argv = t?.foreground?.argv;
  if (!Array.isArray(argv) || !argv.length) return null;
  while (argv.length > 4 && SHELLS.has(programName(argv[0])) && /^-[a-z]*c$/.test(argv[1]) &&
    typeof argv[2] === "string" && (argv[2].includes('"$@"') || argv[2].startsWith("command $argv[2..]"))) argv = argv.slice(4);
  if (SHELLS.has(programName(argv[0])) && programName(argv[1]) === HERDR_SHELL) return { name: HERDR_SHELL, shell: false };
  const name = programName(argv[0]) || (typeof t.foreground.name === "string" ? t.foreground.name : "");
  return { name, shell: SHELLS.has(name) };
}

/** @param {Record<string, any> | null | undefined} t */
export const standinInFront = (t) => frontProgram(t)?.name === STANDIN_APP || t?.foreground?.name === STANDIN_APP;

// The stand-in, or herdr-shell (which starts it), runs in front: what holds a
// suspended agent's terminal while the suspension label is set.
/** @param {Record<string, any> | null | undefined} t */
export const holderInFront = (t) => standinInFront(t) || frontProgram(t)?.name === HERDR_SHELL;

// The stand-in's own report (terminals() keeps it in report, hc get in
// status), in any state.
/** @param {Record<string, any> | null | undefined} t */
const standinReport = (t) => (t?.report?.app ?? t?.status?.app) === STANDIN_APP;
/** @param {Record<string, any> | null | undefined} t */
const stateOf = (t) => typeof t?.status === "string" ? t.status : t?.status?.state ?? t?.report?.state ?? null;

// A wake shows as waking for at most this long after it began, unless the
// stand-in is still in front.
export const WAKE_MS = 30_000;

// Whether a stand-in is waking its agent: its "working" report is there (it
// stays after the stand-in replaced itself, until the woken agent reports,
// fact F5), and either the stand-in is still in front, or the wake (that
// report, at status_ms) began less than WAKE_MS ago. After that the report is
// stale: the woken agent exited, or it never reported (Claude can miss its
// status handshake), and what runs in front tells what the terminal is.
/** @param {Record<string, any> | null | undefined} t @param {number} now */
export function waking(t, now) {
  if (!standinReport(t) || stateOf(t) !== "working") return false;
  return standinInFront(t) || (Number.isFinite(t.status_ms) && now - t.status_ms < WAKE_MS);
}

// A stand-in holds the terminal (GLOSSARY.md): it carries the suspension
// label, or its own report is still there and no shell is in front, or it is
// waking the agent (it removes the label just before it replaces itself). A
// stand-in is the terminal's main program, so atShell() passes for it:
// recovery must never type into it. A stale wake report with a shell in front
// (the woken agent exited) does not hold the terminal.
const standin = (j, now = Date.now()) => Object.hasOwn(j?.labels ?? {}, SUSPENDED) ||
  (standinReport(j) && (waking(j, now) || !frontProgram(j)?.shell));

async function until(cx, address, ms, done, check) {
  for (let t = 0; t < ms; t += 500) {
    check();
    const j = await info(address);
    check();
    if (done(j)) return j;
    await cx.sleep(500);
  }
  check();
  return info(address);
}

async function attempt(cx, address, line, check) {
  for (let i = 1; i <= TRIES; i++) {
    check();
    await send(address, line);
    // Reported: an agent. Back at the shell: it quit (an error, a picker left).
    const j = await until(cx, address, REPORT_MS, (j) => Boolean(j?.reported) || (j && atShell(j)), check);
    check();
    if (!j || j.reported || atShell(j)) return;
    // Running without reporting: quit it and start it again.
    await hc(["send", address, "/exit"]).catch(() => null);
    const out = await until(cx, address, EXIT_MS, atShell, check);
    check();
    if (!atShell(out) || standin(out)) return; // it didn't quit: leave it as it is
  }
}

// One queue per sidebar, never per module: 0.1.14 shares module state even
// after every copy closes. Cancelled host awaits stay pending, not rejected.
// Separate copies can recover concurrently; within one copy all agents remain
// serial. Keep only spawn-owned cx in requests, never an event/init context.
export function createRecovery() {
  let queue = Promise.resolve();
  let closed = false;
  const check = () => { if (closed) throw new Error("Recovery owner closed"); };
  function enqueue(task) {
    if (closed) return Promise.resolve(null);
    queue = queue.then(() => { check(); return task(); }).catch(() => null);
    return queue;
  }
  return {
    // Synchronous: close drains JS jobs before the host retires this copy.
    // Already-issued commands cannot be recalled; forbid every follow-up.
    close() { closed = true; queue = Promise.resolve(); },
    // ↻: the line its resume report gives, run in the report's folder. Without
    // a report, or when the report's conversation is not on disk, the agent's
    // picker (spec Q1). target: agent (the last-agent label), labels, tab (the
    // tab's name, for Claude's picker), cwd (the shell's folder: a legacy
    // Claude report names none).
    /** @param {{ agent?: string | null, labels?: Record<string, string>, tab?: string | null, cwd?: string | null }} target */
    recover(cx, address, { agent = null, labels = {}, tab = null, cwd = null } = {}) {
      return enqueue(async () => {
        const line = await recoveryLine(labels, { agent, tab, cwd });
        check();
        if (!line) return;
        // Read the terminal just before typing: a ↻ shown before a suspension
        // (a stale click) must not type into the stand-in.
        const current = await info(address);
        check();
        if (!current || standin(current)) return;
        // Pi must not use Claude's report timeout and /exit retry: its session
        // picker can wait indefinitely. Send once, only while still at a shell.
        if (line.agent === "pi") {
          if (current.state === "live" && atShell(current)) await send(address, line.text);
          return;
        }
        await attempt(cx, address, line.text, check);
      });
    },
  };
}

// What ↻ types for a terminal, and for which agent: its report's line while
// the conversation is on disk, else the picker. null: nothing to recover.
/**
 * @param {Record<string, string>} labels
 * @param {{ agent?: string | null, tab?: string | null, cwd?: string | null }} [options]
 * @returns {Promise<{ agent: string, text: string } | null>}
 */
export async function recoveryLine(labels, { agent = null, tab = null, cwd = null } = {}) {
  const report = reportOf(labels, { agent, cwd });
  if (report && await reportHeld(report)) return { agent: report.agent, text: resumeLine(report) };
  const picker = report?.agent ?? agent;
  const text = picker ? pickerLine(picker, { tab, report }) : null;
  return text ? { agent: picker, text } : null;
}

// Whether ↻ has anything to offer: a report, or a picker for the last agent.
// The agent it names, or null.
/** @param {Record<string, string>} labels @param {{ agent?: string | null, cwd?: string | null }} [options] */
export function recoverable(labels, { agent = null, cwd = null } = {}) {
  const report = reportOf(labels, { agent, cwd });
  if (report) return report.agent;
  return agent && pickerLine(agent) ? agent : null;
}

// proofHeld's file access for one report, through processes the host runs.
// readHead: the first bytes of a regular file, or null. list: only the
// folders that hold the report's <session>.jsonl, which is all proofHeld looks
// for in a listing (a legacy Claude report): one process instead of one per
// project folder. home: read from the shell, only for that report.
/** @param {import("./resume-report.js").ResumeReport} report @returns {Promise<Parameters<typeof proofHeld>[1]>} */
async function proofIo(report) {
  let home = "";
  if (report.legacy && !report.proof) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"']).catch(() => /** @type {null} */ (null));
    if (r?.code === 0 && r.stdout.startsWith("/")) home = r.stdout;
  }
  return {
    async readHead(path, bytes) {
      const r = await exec("sh", ["-c", 'test -f "$1" && head -c "$2" "$1"', "sh", path, String(bytes)]).catch(() => /** @type {null} */ (null));
      return r?.code === 0 ? r.stdout : null;
    },
    async list(dir) {
      const script = 'cd "$1" || exit 1; for f in */"$2.jsonl"; do test -f "$f" && printf "%s\\n" "${f%%/*}"; done; exit 0';
      const r = await exec("sh", ["-c", script, "sh", dir, report.session]).catch(() => /** @type {null} */ (null));
      return r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
    },
    home,
  };
}

// Whether a report's conversation is on disk (resume-report.js proofHeld),
// read with processes: ↻ and the suspension rules' slow rule.
/** @param {import("./resume-report.js").ResumeReport | null} report */
export async function reportHeld(report) {
  return Boolean(report) && proofHeld(report, await proofIo(/** @type {any} */ (report)));
}

export function remember(address, agent) {
  return hc(["label", address, `${LABEL}=${agent}`]);
}
