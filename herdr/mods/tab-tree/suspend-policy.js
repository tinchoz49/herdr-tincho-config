// The suspension policy (GLOSSARY.md: Suspend, Unused agent, Wake), run by
// the tab-tree mod. The eligibility rules say which agents are unused agents;
// each rule that fails gives its own reason, so "Suspend now" can say what to
// change. createSuspender() runs the rules on a timer: one copy of the mod
// leads and suspends unused agents in ordered steps. wakeClicked() wakes a
// suspended agent whose row you click in the sidebar.

import { settings, focused, panes, terminals, shared, setShared, readTextFile, exec, hc } from "herdr";
import { SESSION, PI_RECOVERY, SUSPENDED, STANDIN_APP, piRecovery, suspension } from "./recipes.js";
import { isClaude } from "./claude-polling.js";
import { frontProgram, holderInFront, piSessionHeld, claudeTranscript } from "./resume.js";

export const NEVER_SUSPEND = "herdr.never-suspend";

// Remote addresses carry their machine: mini/t7. Suspension acts only on
// this machine's core.
/** @param {string} address */
const remote = (address) => address.includes("/");

/** @param {unknown} s */
const printable = (s) => typeof s === "string" && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);

// The agent running now, from its own report (terminals() keeps it in report,
// hc get in status), else from the program table. Never from the last-agent
// label: that describes an agent the terminal may have lost.
/** @param {Record<string, any>} t @returns {"claude" | "pi" | null} */
function agentOf(t) {
  if (isClaude(t)) return "claude";
  const app = t?.report?.app ?? t?.status?.app;
  const key = typeof app === "string" && app ? app : t?.program?.agent ? t.program.key : null;
  return /^pi$/i.test(key ?? "") ? "pi" : null;
}

// What makes each agent resumable, so a wake continues the same conversation
// (never a picker). labeled: its session in the terminal's labels. onDisk:
// that session on disk, read with a process (a slow rule): Claude's
// transcript (a Claude that never got a prompt names a session without one),
// or a Pi session file that holds the recorded session (Pi may write it only
// after the first message). Without it the wake could not continue the
// conversation, and its messages would be lost or blocked.
/** @typedef {(labels: Record<string, string>) => boolean} LabelCheck */
/** @type {Record<"claude" | "pi", { labeled: LabelCheck, onDisk: (labels: Record<string, string>) => Promise<boolean> }>} */
const RESUMABLE = {
  claude: {
    labeled: (labels) => printable(labels[SESSION]),
    onDisk: (labels) => claudeTranscript(labels[SESSION]),
  },
  pi: {
    // An ID-only record (no session file) is refused by the stand-in's wake,
    // so suspending it would only leave a blocked stand-in.
    labeled: (labels) => Boolean(piRecovery(labels[PI_RECOVERY])?.sessionFile),
    onDisk: (labels) => piSessionHeld(piRecovery(labels[PI_RECOVERY])),
  },
};

// The terminals being looked at in this copy's window: the one with the
// keyboard or shown, and every terminal of a pane in the focused tab. A
// terminal in no pane is in no tab.
/** @returns {Set<string>} */
function focusedHere() {
  const f = focused();
  const here = new Set();
  if (!f) return here;
  for (const address of [f.terminal, f.shown, f.agent]) if (typeof address === "string" && address) here.add(address);
  for (const p of panes()) if (p.tab === f.tab && typeof p.terminal === "string" && p.terminal) here.add(p.terminal);
  return here;
}

const MINUTE = 60_000;
/** @param {Record<string, any>} t @returns {string | null} */
const statusOf = (t) => typeof t?.status === "string" ? t.status : t?.status?.state ?? null;

// Why an agent is not an unused agent, one reason per rule, checked in this
// order: automatic suspension is off, a remote terminal, already suspended
// (the label is set), not resumable (no session label), pinned, in the
// focused tab, working, blocked, not idle (no agent status), idle for less
// than the threshold (or no status time), then the rules that start a
// process: not resumable (no session on disk), a process table that cannot be
// read, and a descendant process that is not a helper.
/** @typedef {"off" | "remote" | "suspended" | "not-resumable" | "pinned" | "focused" | "working" | "blocked" | "not-idle" | "recent" | "background" | "processes-unknown"} Reason */
/** @typedef {{ unused: true, agent: "claude" | "pi" } | { unused: false, reason: Reason }} Verdict */
// What the suspension signal goes to (the suspension record's root): the
// agent itself as the terminal's main program, or the shell that hosts it.
/** @typedef {"agent" | "shell"} Root */

// terminal: from terminals() or hc get (status as a word or as an object;
// foreground.pid is needed for the process check). focusedAt: the last time
// (ms) the terminal's tab was focused, null when unknown (after an app
// restart). manual: "Suspend now", which skips only the threshold and works
// while automatic suspension is off. focusedTerminals: the terminals in the
// focused tab of any window (each copy of the mod sees only its own window's
// focus). skipSlowRules skips the slow rules, the ones that start a process
// (the session on disk and the process rule): the verdict then holds except
// for those. snapshot.table receives the process table the rules read.
/**
 * @param {Record<string, any>} terminal
 * @param {{ now?: number, focusedAt?: number | null, manual?: boolean, focusedTerminals?: Set<string> | null, skipSlowRules?: boolean }} [options]
 * @param {{ table?: ProcessTable | null, place?: { agentPid: number, root: Root } }} [snapshot]
 * @returns {Promise<Verdict>}
 */
export async function unusedAgent(terminal, { now = Date.now(), focusedAt = null, manual = false, focusedTerminals = null, skipSlowRules = false } = {}, snapshot = {}) {
  const config = suspendSettings();
  if (!manual && !config.auto) return { unused: false, reason: "off" };
  if (typeof terminal.address !== "string" || remote(terminal.address)) return { unused: false, reason: "remote" };
  const labels = terminal.labels ?? {};
  if (Object.hasOwn(labels, SUSPENDED)) return { unused: false, reason: "suspended" };
  const agent = agentOf(terminal);
  if (!agent || !RESUMABLE[agent].labeled(labels)) return { unused: false, reason: "not-resumable" };
  if (labels[NEVER_SUSPEND] === "1") return { unused: false, reason: "pinned" };
  if (focusedHere().has(terminal.address) || focusedTerminals?.has(terminal.address)) return { unused: false, reason: "focused" };
  const status = statusOf(terminal);
  if (status === "working") return { unused: false, reason: "working" };
  if (status === "blocked") return { unused: false, reason: "blocked" };
  if (status !== "idle" && status !== "done") return { unused: false, reason: "not-idle" };
  // Idle since its last status change, or since its tab was last focused when
  // that is later: an agent someone was just reading is not unused yet.
  // "Suspend now" (manual) skips only this rule.
  if (!manual) {
    if (!Number.isFinite(terminal.status_ms)) return { unused: false, reason: "recent" };
    const since = Math.max(terminal.status_ms, Number.isFinite(focusedAt) ? focusedAt : -Infinity);
    if (now - since < config.afterMinutes * MINUTE) return { unused: false, reason: "recent" };
  }
  if (skipSlowRules) return { unused: true, agent };
  if (!await RESUMABLE[agent].onDisk(labels)) return { unused: false, reason: "not-resumable" };
  snapshot.table = await processTable();
  snapshot.place = agentPlace(snapshot.table, terminal, agent);
  const allHelpers = onlyHelpers(snapshot.table, terminal.pid, snapshot.place.agentPid, config.helpers);
  if (allHelpers === null) return { unused: false, reason: "processes-unknown" };
  if (!allHelpers) return { unused: false, reason: "background" };
  return { unused: true, agent };
}

/** @typedef {{ parents: Map<number, number>, children: Map<number, { pid: number, command: string }[]> }} ProcessTable */

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh"]);
/** @param {string} command */
const programName = (command) => (command.trim().split(/\s+/)[0] ?? "").split("/").pop() ?? "";

// Where the agent runs. When hc names a program in front other than the main
// program, a shell hosts the agent in front (root=shell). When they are the
// same, the main program is usually the agent (root=agent). But a shell
// without job control, like the stand-in's `/bin/sh -c '"$@"; exec $SHELL'`
// wrapper after waking an agent that ran inside a shell, keeps the agent in
// its own process group, so hc names the shell in front: then the shell's
// child that runs the agent is the agent, and the shell hosts it.
/**
 * @param {ProcessTable | null} table @param {Record<string, any>} terminal @param {string} agent
 * @returns {{ agentPid: number, root: Root }}
 */
function agentPlace(table, terminal, agent) {
  const main = terminal.pid;
  const front = terminal.foreground?.pid;
  if (front !== main) return { agentPid: front, root: "shell" };
  const parent = table?.parents.get(main);
  const own = (table?.children.get(parent) ?? []).find((p) => p.pid === main);
  if (own && SHELLS.has(programName(own.command))) {
    const child = (table?.children.get(main) ?? []).find((p) => programName(p.command) === agent);
    if (child) return { agentPid: child.pid, root: "shell" };
  }
  return { agentPid: main, root: "agent" };
}

// Every process on this machine with its parent and command line, or null
// when ps cannot be read.
/** @returns {Promise<ProcessTable | null>} */
async function processTable() {
  const r = await exec("ps", ["-axo", "pid=,ppid=,command="]).catch(() => /** @type {null} */ (null));
  if (r?.code !== 0 || typeof r.stdout !== "string") return null;
  /** @type {ProcessTable} */
  const table = { parents: new Map(), children: new Map() };
  for (const line of r.stdout.split("\n")) {
    // A process without a command line (a zombie) still counts, as no helper.
    const m = /^\s*(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    table.parents.set(pid, ppid);
    if (!table.children.has(ppid)) table.children.set(ppid, []);
    table.children.get(ppid).push({ pid, command: m[3] ?? "" });
  }
  return table;
}

// Every process under pid in the table, parents before their children.
/** @param {ProcessTable | null} table @param {number} pid @returns {number[]} */
function descendants(table, pid) {
  /** @type {number[]} */
  const found = [];
  const seen = new Set([pid]);
  /** @param {number} parent */
  const walk = (parent) => {
    for (const child of table?.children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child.pid);
      walk(child.pid);
    }
  };
  walk(pid);
  return found;
}

// Whether every descendant process of the agent (its foreground program) is a
// helper: its command line, or the command line of an ancestor between it and
// the agent, contains an entry of the allow-list. So the children of an MCP
// server (uvx -> python) are part of that helper, and only the agent's direct
// children need to match. When a shell hosts the agent (the terminal's main
// program is not the agent), the signal goes to that shell, so its other
// children (a job started with &) must be helpers too; the child on the way
// to the agent (the agent, or a launch wrapper) is the agent's own line.
// Null when the process table cannot tell.
/** @param {ProcessTable | null} table @param {number} mainPid @param {number} agentPid @param {string[]} helpers @returns {boolean | null} */
function onlyHelpers(table, mainPid, agentPid, helpers) {
  /** @param {unknown} pid @returns {pid is number} */
  const known = (pid) => Number.isSafeInteger(pid) && /** @type {number} */ (pid) > 0 && Boolean(table?.parents.has(/** @type {number} */ (pid)));
  if (!table || !known(agentPid)) return null;
  /** @param {number} pid */
  const helpersOnly = (pid, except = -1) => (table.children.get(pid) ?? [])
    .every((child) => child.pid === except || helpers.some((h) => child.command.includes(h)));
  if (!helpersOnly(agentPid)) return false;
  if (mainPid === agentPid) return true;
  if (!known(mainPid)) return null;
  // The shell's child on the way to the agent. The hop limit ends the walk
  // on a parent loop (a table read while pids were reused).
  let line = agentPid;
  for (let hops = 0; table.parents.get(line) !== mainPid; hops++) {
    line = table.parents.get(line);
    if (!known(line) || hops > 64) return null;
  }
  return helpersOnly(mainPid, line);
}

const DEFAULT_MINUTES = 30;
const DEFAULT_HELPERS = ["mcp"];

// The app setting "tincho.suspend": { after_minutes, helpers }. false or
// after_minutes 0 turns automatic suspension off (afterMinutes null); the
// helper allow-list still applies to manual suspension. A missing or invalid
// field keeps its default. An empty helper would match every command line.
/** @returns {{ auto: boolean, afterMinutes: number | null, helpers: string[] }} */
export function suspendSettings() {
  const value = settings()?.["tincho.suspend"];
  /** @type {Record<string, any>} */
  const fields = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const helpers = Array.isArray(fields.helpers) && fields.helpers.every((h) => typeof h === "string")
    ? fields.helpers.filter((h) => h.length > 0) : [...DEFAULT_HELPERS];
  const minutes = fields.after_minutes;
  if (value === false || minutes === 0) return { auto: false, afterMinutes: null, helpers };
  const afterMinutes = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MINUTES;
  return { auto: true, afterMinutes, helpers };
}

// The signal that ends the terminal's main program. hc treats a death by
// signal as a loss, so a kept terminal starts its configured shell
// (herdr-shell) in place; an exit with a code is final, and the terminal ends.
// SIGKILL in both cases, because no program can turn it into an exit code:
// - root=shell: interactive bash and zsh ignore SIGTERM, and zsh turns SIGHUP
//   into exit 1. With the shell gone, the kernel sends the agent in front
//   SIGHUP, its clean shutdown (checked with bash, zsh and fish).
// - root=agent: Pi (and maybe Claude) turns SIGTERM and SIGHUP into exit
//   code 0. Its helpers (MCP servers) then get SIGTERM, so they don't
//   outlive it.
/** @type {Record<Root, string>} */
const SIGNAL = { agent: "KILL", shell: "KILL" };

/** @param {string} address @returns {Promise<Record<string, any> | null>} */
async function coreTerminal(address) {
  const r = await hc(["get", address, "--json"]).catch(() => /** @type {null} */ (null));
  try { return r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { return null; }
}

/** @param {Promise<{ code: number } | null>} run */
const succeeds = async (run) => (await run.catch(() => /** @type {null} */ (null)))?.code === 0;

// The first word of herdr-core's `shell` setting, or null. hc reads it as a
// word list (shell = ["nu"]) among the top-level keys of config.toml. This is
// a small TOML reader for that one key: basic and literal strings, an array
// over several lines, and comments.
/** @param {unknown} text @returns {string | null} */
function configuredShell(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A table header ends the top-level keys.
    if (/^\s*\[/.test(lines[i])) return null;
    const key = /^\s*(?:shell|"shell"|'shell')\s*=\s*/.exec(lines[i]);
    if (!key) continue;
    const value = [lines[i].slice(key[0].length), ...lines.slice(i + 1)].join("\n");
    const first = /^\[(?:\s|#[^\n]*\n)*("(?:[^"\\\n]|\\.)*"|'[^'\n]*')/.exec(value);
    if (!first) return null;
    const quoted = first[1];
    if (quoted.startsWith("'")) return quoted.slice(1, -1);
    try { return JSON.parse(quoted); } catch { return null; }
  }
  return null;
}

// Prints the bin folder the installer puts the stand-in and the launcher in,
// and herdr-core's config file, in the user's environment. Exits 0 only when
// both programs are there.
const INSTALL_PATHS = `bin="\${XDG_DATA_HOME:-$HOME/.local/share}/herdr-tincho-config/bin"
printf '%s\\n%s\\n' "$bin" "\${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/config.toml"
test -x "$bin/herdr-standin" && test -x "$bin/herdr-shell"`;

// Whether suspension can work: the stand-in and herdr-shell are installed,
// and herdr-shell is hc's configured shell. Otherwise a lost agent would come
// back as a plain shell, and a message would run in it.
/** @returns {Promise<boolean>} */
async function suspensionInstalled() {
  const r = await exec("sh", ["-c", INSTALL_PATHS]).catch(() => /** @type {null} */ (null));
  if (r?.code !== 0) return false;
  const [bin, config] = r.stdout.split("\n");
  if (!bin?.startsWith("/") || !config?.startsWith("/")) return false;
  const text = await readTextFile(config).catch(() => /** @type {null} */ (null));
  return configuredShell(text) === `${bin}/herdr-shell`;
}

/** @typedef {Reason | "not-installed" | "gone" | "changed" | "failed" | "closed" | "repaired"} Outcome */

// A suspension label younger than this is never repaired: the steps between
// the label (4) and the stand-in's start take far less.
const REPAIR_MS = 60_000;

// Whether a terminal carries a suspension label that no stand-in holds: it is
// live and local, and hc shows a program in front that is neither the
// stand-in nor herdr-shell (which starts the stand-in, or waits when it
// cannot), and the label is REPAIR_MS old or more (or has no readable time).
// That happens when the mod closed between steps 4 and 5, or when someone set
// the label by hand.
/** @param {Record<string, any> | null | undefined} t @param {number} now */
function staleLabel(t, now) {
  if (typeof t?.address !== "string" || remote(t.address) || t.state !== "live") return false;
  const labels = t.labels ?? {};
  if (!Object.hasOwn(labels, SUSPENDED)) return false;
  if (!frontProgram(t) || holderInFront(t)) return false;
  const since = suspension(labels[SUSPENDED])?.since;
  return !(Number.isFinite(since) && now - since < REPAIR_MS);
}

// Shared state (setShared/shared) between the copies of the mod, one per
// window that shows tab-tree.
//
// WINDOWS: each copy's entry, by its id, with a heartbeat:
//   { [id]: { at: ms, focused: { [address]: ms }, seen: { [address]: ms } } }
//   focused: the terminals in its window's focused tab now, each with the
//   time since when it has been there without a break. seen: the last time
//   each terminal left its window's focused tab (the idle clock).
// A copy writes its entry when its window's focus changes, and at least every
// HEARTBEAT_MS (from the pass). An entry older than STALE_MS is ignored (a
// copy that stopped without closing, or one from before an app restart).
export const SUSPEND_WINDOWS = "tincho.suspend.windows";
const HEARTBEAT_MS = 60_000;
const STALE_MS = 150_000;
// A last-focus time older than this never holds back a suspension (unless
// the threshold is longer).
const SEEN_MS = 24 * 60 * MINUTE;

// Focus never wakes a suspended agent: Herdr moves the focus on its own (a
// closed tab, a new split, a pane that replaces an ended one). It wakes on a
// click on its row in the sidebar (wakeClicked), Enter in its stand-in, or a
// message.

// A stand-in that waits for a message: the suspension label, and an idle
// report from the stand-in itself (not "working" while it wakes the agent,
// nor "blocked" when the session is missing).
/** @param {Record<string, any> | undefined} t */
const idleStandin = (t) => Object.hasOwn(t?.labels ?? {}, SUSPENDED) &&
  (t?.report?.app ?? t?.status?.app) === STANDIN_APP && statusOf(t) === "idle";

/** @typedef {{ at: number, focused: Record<string, number>, seen: Record<string, number> }} WindowEntry */

// The entry point for other mods (ticket 09's "Suspend now" menu item).
//
// SUSPEND_REQUESTS, written by any mod: { [address]: ms }. Set a terminal's
// value to Date.now() to request a manual suspension of it: every rule
// applies except the threshold, also while automatic suspension is off. The
// leader handles each request once, as soon as it re-renders after the
// setShared; a request older than REQUEST_MS is ignored, so a request made
// while no copy leads never acts much later. Never remove another mod's
// entries: replace your own value. The leader's pass removes the requests
// that can no longer act.
//
// SUSPEND_STATE, written by the leader only:
//   { agents: { [address]: { auto: Outcome | null, manual: Outcome | null } },
//     results: { [address]: { requested: ms | null, suspended: boolean, reason: Outcome | null, at: ms,
//                             source: "manual" | "auto" | "repair", step?: "keep" | "label" | "signal", rolledBack?: boolean } } }
//   agents: each local agent's current reason, from the last pass (every
//   15 s): auto for automatic suspension, manual for "Suspend now". null
//   means no rule fails, except maybe a rule that starts a process: to keep
//   the pass cheap, the session on disk and the process table are read only
//   for an agent about to be suspended, so "background", "processes-unknown"
//   and a "not-resumable" for a session not on disk show up only after an
//   attempt (and in results). results: the latest outcome for each terminal,
//   kept for RESULT_MS: of a manual request (source "manual"; requested is
//   the request's value), of an automatic suspension that failed ("auto"),
//   or of a label repair ("repair"). An automatic or repair result keeps the
//   requested value of the result it replaces (null without one), so a
//   request is still answered once. A failure says its step (keep, label or
//   signal); for the signal, rolledBack says whether the label came off
//   again (the agent still ran).
// A reason is an Outcome: a rule from unusedAgent(), or "not-installed" (the
// stand-in or herdr-shell is missing, or herdr-shell is not hc's shell; in
// agents only after a pass had an agent past its threshold),
// "gone" (the terminal ended), "changed" (its status, turn or program changed
// during the steps), "failed" (an hc command or the signal failed),
// "closed" (the mod closed), or "repaired" (the leader removed a label that
// no stand-in held, see staleLabel()).
export const SUSPEND_REQUESTS = "tincho.suspend.requests";
export const SUSPEND_STATE = "tincho.suspend.state";
const REQUEST_MS = 60_000;
const RESULT_MS = 10 * 60_000;
// After a slow rule refused an agent (background processes,
// or no session on disk), the pass checks it again only after this long.
const RECHECK_MS = 5 * 60_000;
// The slow rules' reasons (they start a process, see unusedAgent()). A "not-resumable" from a suspension comes from the
// session on disk: the pass already checked the session label.
/** @type {Set<Outcome | null>} */
const SLOW_RULES = new Set(["background", "processes-unknown", "not-resumable"]);
// The pass checks the installation again only after this long (each
// suspension checks it itself).
const INSTALL_CHECK_MS = 5 * 60_000;

/** @typedef {"keep" | "label" | "signal"} Step */
/** @typedef {{ step?: Step, rolledBack?: boolean }} Failure where a suspension failed, and whether its label came off again */
/** @typedef {{ requested: number | null, suspended: boolean, reason: Outcome | null, at: number, source: "manual" | "auto" | "repair" } & Failure} RequestResult */
/** @typedef {{ agents: Record<string, { auto: Outcome | null, manual: Outcome | null }>, results: Record<string, RequestResult> }} SuspendState */

/** @param {unknown} value @returns {Record<string, any>} */
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? /** @type {any} */ (value) : {};

// Whether a request's value can still act: a time less than REQUEST_MS ago
// (and not far ahead, from a wrong clock).
/** @param {unknown} requested @param {number} now */
const liveRequest = (requested, now) => Number.isFinite(requested) && now - /** @type {number} */ (requested) < REQUEST_MS && /** @type {number} */ (requested) - now < STALE_MS;

/** @returns {SuspendState} */
function currentState() {
  const value = record(shared(SUSPEND_STATE));
  return { agents: record(value.agents), results: record(value.results) };
}

/** @typedef {{ suspended: true } | ({ suspended: false, reason: Outcome } & Failure)} SuspendOutcome */

// The reason of a verdict or of a suspension's outcome, null when it passed.
/** @param {Verdict | SuspendOutcome} result @returns {Outcome | null} */
const reasonOf = (result) => "reason" in result ? result.reason : null;

/** @returns {Record<string, WindowEntry>} */
const windowEntries = () => record(shared(SUSPEND_WINDOWS));

/** @param {unknown} entry @param {number} now @returns {entry is WindowEntry} */
const fresh = (entry, now) => Number.isFinite(/** @type {any} */ (entry)?.at) && now - /** @type {any} */ (entry).at < STALE_MS;

/** @param {string} address @returns {Record<string, any> | undefined} */
const terminalAt = (address) => terminals().find((t) => t?.address === address);

/** @param {Record<string, any>} t */
const localAgent = (t) => typeof t?.address === "string" && !remote(t.address) && Boolean(t.program?.agent || t.report);

/**
 * One copy of the policy, for one copy of the mod. No timer of its own runs
 * more often than the pass:
 * - observe(), from render: reads this window's focus, the other copies'
 *   entries and the manual requests. It changes nothing outside this copy and
 *   returns true when act() has work.
 * - act(), outside render (cx.spawn): publishes this copy's entry, and the
 *   leader handles manual requests.
 * - pass(), every 15 s: the heartbeat, and the leader's shared reasons and
 *   automatic suspension. It reads no process when no agent qualifies.
 * @param {{ id?: string, clock?: () => number }} [options]
 */
export function createSuspender({ id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, clock = Date.now } = {}) {
  let closed = false;
  /** @type {Map<string, number>} */
  const since = new Map(); // this window's focused terminals -> since when
  /** @type {Map<string, number>} */
  const seen = new Map(); // terminal -> when it last left this window's focused tab
  let published = -Infinity;
  let focusChanged = true; // the entry must be (re)published
  let due = false; // observe() asked for an act()
  let passing = false;
  /** @type {Set<string>} */
  const requesting = new Set(); // terminals whose request this copy is handling
  /** @type {boolean | null} */
  let installed = null; // from the last installed check (null before one)
  let installedAt = -Infinity;
  /** @param {number} now */
  async function checkInstalled(now) {
    installed = await suspensionInstalled();
    installedAt = now;
    return installed;
  }
  /** @type {Map<string, { key: string, reason: Outcome, at: number }>} */
  const heldBack = new Map(); // terminal -> the slow rule that refused it last, for which process
  // Suspensions run one at a time.
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const serial = (job) => {
    const run = queue.then(job);
    queue = run.then(() => {}, () => {});
    return run;
  };

  // This window's focus, into memory. True when it changed.
  /** @param {number} now */
  function track(now) {
    const here = focusedHere();
    let changed = false;
    for (const address of [...since.keys()]) {
      if (here.has(address)) continue;
      since.delete(address);
      seen.set(address, now);
      changed = true;
    }
    for (const address of here) if (!since.has(address)) { since.set(address, now); changed = true; }
    const keep = Math.max(SEEN_MS, (suspendSettings().afterMinutes ?? 0) * MINUTE);
    for (const [address, at] of seen) if (now - at >= keep) seen.delete(address);
    return changed;
  }

  // Reads the entries, replaces its own and drops stale ones, with no await
  // in between: the copies share one script runtime (resume.js), so no other
  // copy writes in the middle. observe() repairs an entry that a write lost.
  /** @param {number} now */
  function publish(now) {
    focusChanged = false;
    /** @type {Record<string, WindowEntry>} */
    const entries = {};
    for (const [other, entry] of Object.entries(windowEntries())) if (other !== id && fresh(entry, now)) entries[other] = entry;
    entries[id] = { at: now, focused: Object.fromEntries(since), seen: Object.fromEntries(seen) };
    setShared(SUSPEND_WINDOWS, entries);
    published = now;
  }

  // The leader: the copy with the lowest id among the fresh entries. A copy
  // whose own entry is missing or stale never leads.
  /** @param {number} [now] */
  function leading(now = clock()) {
    if (closed) return false;
    const ids = Object.entries(windowEntries()).filter(([, entry]) => fresh(entry, now)).map(([other]) => other);
    return ids.includes(id) && ids.every((other) => other >= id);
  }

  // The focus of every window: the terminals focused now (with the earliest
  // time since when), and when each terminal last left a focused tab. This
  // copy's own window counts from memory.
  /** @param {number} now */
  function focusView(now) {
    const focused = new Map(since);
    const last = new Map(seen);
    for (const [other, entry] of Object.entries(windowEntries())) {
      if (other === id || !fresh(entry, now)) continue;
      for (const [address, at] of Object.entries(record(entry.focused))) {
        if (Number.isFinite(at)) focused.set(address, Math.min(focused.get(address) ?? Infinity, at));
      }
      for (const [address, at] of Object.entries(record(entry.seen))) {
        if (Number.isFinite(at)) last.set(address, Math.max(last.get(address) ?? -Infinity, at));
      }
    }
    return { focused, last };
  }

  /** @param {ReturnType<typeof focusView>} view @param {string} address */
  const rulesInput = (view, address) => ({ focusedAt: view.last.get(address) ?? null, focusedTerminals: new Set(view.focused.keys()) });

  // The requests in SUSPEND_REQUESTS that wait for this copy: [address, requested].
  /** @param {number} now @returns {[string, number][]} */
  function newRequests(now) {
    const requests = Object.entries(record(shared(SUSPEND_REQUESTS)));
    if (!requests.length) return [];
    const { results } = currentState();
    return requests.filter(([address, requested]) => liveRequest(requested, now) &&
      !requesting.has(address) && !((results[address]?.requested ?? -Infinity) >= requested));
  }

  // For render: records this window's focus, and says whether act() has work
  // (once, until act() runs). Changes nothing outside this copy.
  /** @param {number} [now] */
  function observe(now = clock()) {
    if (closed) return false;
    if (track(now)) focusChanged = true;
    // Another copy's write dropped this copy's entry: write it again.
    if (published > -Infinity && !Object.hasOwn(windowEntries(), id)) focusChanged = true;
    const work = focusChanged || (leading(now) && newRequests(now).length > 0);
    if (!work || due) return false;
    due = true;
    return true;
  }

  /** @param {(state: SuspendState) => Partial<SuspendState>} change @param {number} now */
  function writeState(change, now) {
    const current = currentState();
    const next = { ...current, ...change(current) };
    next.results = Object.fromEntries(Object.entries(next.results).filter(([, r]) => now - r?.at < RESULT_MS));
    if (JSON.stringify(next) !== JSON.stringify(current)) setShared(SUSPEND_STATE, next);
  }

  // Shares an outcome in results. requested: the manual request it answers;
  // left out, the replaced result's value stays.
  /**
   * @param {string} address @param {RequestResult["source"]} source
   * @param {SuspendOutcome | { suspended: false, reason: Outcome }} outcome
   * @param {number} now @param {number} [requested]
   */
  function share(address, source, outcome, now, requested) {
    writeState((state) => {
      /** @type {RequestResult} */
      const result = { requested: requested ?? state.results[address]?.requested ?? null, suspended: outcome.suspended, reason: reasonOf(outcome), at: now, source };
      if ("step" in outcome) result.step = outcome.step;
      if ("rolledBack" in outcome) result.rolledBack = outcome.rolledBack;
      return { results: { ...state.results, [address]: result } };
    }, now);
  }

  // The leader removes the requests that can no longer act (newRequests()):
  // older than REQUEST_MS, or not a time. Read and write with no await in
  // between, so another mod's new request stays.
  /** @param {number} now */
  function pruneRequests(now) {
    const requests = Object.entries(record(shared(SUSPEND_REQUESTS)));
    const kept = requests.filter(([, requested]) => liveRequest(requested, now));
    if (kept.length < requests.length) setShared(SUSPEND_REQUESTS, Object.fromEntries(kept));
  }

  // The leader handles each new manual request once and shares its result.
  /** @param {number} now */
  async function handleRequests(now) {
    await Promise.all(newRequests(now).map(([address, requested]) => {
      requesting.add(address);
      return serial(async () => {
        const outcome = await suspend(address, { now, manual: true });
        if (!closed) share(address, "manual", outcome, now, requested);
      }).finally(() => requesting.delete(address));
    }));
  }

  // Removes a suspension label that no stand-in holds (staleLabel()), after
  // reading the terminal again, and shares the repair.
  /** @param {string} address @param {number} now */
  async function repair(address, now) {
    const current = await coreTerminal(address);
    if (closed || !staleLabel(current, now)) return;
    const removed = await succeeds(hc(["label", address, `${SUSPENDED}=`]));
    if (!closed) share(address, "repair", { suspended: false, reason: removed ? "repaired" : "failed" }, now);
  }

  // The work observe() found, outside render.
  /** @param {{ now?: number }} [options] */
  async function act({ now = clock() } = {}) {
    due = false;
    if (closed) return;
    if (focusChanged) publish(now);
    if (leading(now)) await handleRequests(now);
  }

  // A click on a row in the sidebar: an empty Enter in each idle stand-in among
  // these terminals wakes its agent. Only a click wakes; focus never does.
  /** @param {string[]} addresses */
  async function wakeClicked(addresses) {
    if (closed) return;
    await Promise.all([...new Set(addresses)].map((address) => {
      if (typeof address !== "string" || remote(address) || !idleStandin(terminalAt(address))) return null;
      return hc(["keys", address, "enter"]).catch(() => /** @type {null} */ (null));
    }));
  }

  // The ordered suspension steps. Any failed check aborts, and nothing more
  // is changed (an earlier keep stays: it is harmless). One exception: when
  // the signal fails while the agent still runs, the label comes off again;
  // otherwise the sidebar would show a live agent as suspended.
  /**
   * @param {string} address
   * @param {{ now?: number, manual?: boolean }} [options]
   * @returns {Promise<SuspendOutcome>}
   */
  async function suspend(address, { now = clock(), manual = false } = {}) {
    /** @param {Outcome} reason @param {Failure} [more] @returns {SuspendOutcome} */
    const abort = (reason, more = {}) => ({ suspended: false, reason, ...more });
    if (!await checkInstalled(now)) return abort("not-installed");
    if (closed) return abort("closed");
    // 1. Read the terminal again: still an unused agent.
    const before = await coreTerminal(address);
    if (closed) return abort("closed");
    if (before?.state !== "live") return abort("gone");
    /** @type {{ table?: ProcessTable | null, place?: { agentPid: number, root: Root } }} */
    const snapshot = {};
    const verdict = await unusedAgent(before, { now, manual, ...rulesInput(focusView(now), address) }, snapshot);
    if (closed) return abort("closed");
    if ("reason" in verdict) return abort(verdict.reason);
    const pid = before.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return abort("processes-unknown");
    // A shell hosts the agent when the main program is not the agent itself
    // (agentPlace, read in step 1).
    /** @type {Root} */
    const root = snapshot.place?.root ?? (pid === before.foreground?.pid ? "agent" : "shell");
    // The agent's helpers, every process under it in the process snapshot of
    // step 1 (each child of the agent is a helper, or step 1 refused it): a
    // wrapper (uvx, npx) may not pass SIGTERM on to the server it started.
    const helpers = root === "agent" ? descendants(snapshot.table, pid).map(String) : [];
    const label = suspension(JSON.stringify({ version: 1, agent: verdict.agent, root, cwd: before.foreground?.cwd, since: now }));
    if (!label) return abort("not-resumable");
    // 2. Keep the terminal, so the signal leaves it live.
    if (!await succeeds(hc(["keep", address]))) return abort("failed", { step: "keep" });
    if (closed) return abort("closed");
    // 3. Read status and turn again: no change since step 1.
    const after = await coreTerminal(address);
    if (closed) return abort("closed");
    if (after?.state !== "live") return abort("gone");
    if (statusOf(after) !== statusOf(before) || after.turn !== before.turn || after.pid !== pid ||
        after.foreground?.pid !== before.foreground?.pid) return abort("changed");
    // 4. The record herdr-shell and the stand-in read.
    if (!await succeeds(hc(["label", address, `${SUSPENDED}=${JSON.stringify(label)}`]))) return abort("failed", { step: "label" });
    if (closed) return abort("closed");
    // 5. End the main program: hc starts herdr-shell, which starts the stand-in.
    if (!await succeeds(exec("kill", [`-${SIGNAL[root]}`, String(pid)]))) {
      // The signal also fails when the main program already ended: then hc
      // starts herdr-shell, which needs the label to start the stand-in.
      // A label that cannot come off stays until the leader repairs it.
      const now = await coreTerminal(address);
      const ended = now && (now.state !== "live" || now.pid !== pid);
      const rolledBack = !ended && await succeeds(hc(["label", address, `${SUSPENDED}=`]));
      return abort("failed", { step: "signal", rolledBack });
    }
    // A helper that already ended makes kill fail: that is fine.
    if (helpers.length) await exec("kill", ["-TERM", ...helpers]).catch(() => /** @type {null} */ (null));
    return { suspended: true };
  }

  // Which process an agent runs, and its last status change: a slow rule's
  // result holds for them only.
  /** @param {Record<string, any>} t */
  const processKey = (t) => `${t.foreground?.pid}:${t.status_ms}`;

  // Every 15 s: the heartbeat, then the leader shares each local agent's
  // reasons and suspends the unused agents one at a time. Without an agent
  // past its threshold it starts no process: the installation is checked
  // only then, at most every INSTALL_CHECK_MS (a suspension also checks it),
  // so "not-installed" shows in the reasons from that check on.
  /** @param {number} [now] */
  async function pass(now = clock()) {
    if (closed) return;
    if (focusChanged || now - published >= HEARTBEAT_MS) publish(now);
    if (passing || !leading(now)) return;
    passing = true;
    try {
      const { auto } = suspendSettings();
      const view = focusView(now);
      /** @type {SuspendState["agents"]} */
      const agents = {};
      /** @type {string[]} */
      const candidates = [];
      for (const terminal of terminals()) {
        if (!localAgent(terminal)) continue;
        const address = terminal.address;
        const input = { now, skipSlowRules: true, ...rulesInput(view, address) };
        /** @type {Outcome | null} */
        let manual = reasonOf(await unusedAgent(terminal, { ...input, manual: true }));
        /** @type {Outcome | null} */
        let automatic = auto ? reasonOf(await unusedAgent(terminal, input)) : "off";
        if (closed) return;
        const previous = heldBack.get(address);
        if (previous && previous.key !== processKey(terminal)) heldBack.delete(address);
        const held = heldBack.get(address);
        if (held) {
          manual ??= held.reason;
          // Check it again only after a while.
          if (automatic === null && now - held.at < RECHECK_MS) automatic = held.reason;
        }
        agents[address] = { auto: automatic, manual };
        if (automatic === null) candidates.push(address);
      }
      for (const address of heldBack.keys()) if (!Object.hasOwn(agents, address)) heldBack.delete(address);
      if (candidates.length && (installed === null || now - installedAt >= INSTALL_CHECK_MS)) {
        await checkInstalled(now);
        if (closed) return;
      }
      if (installed === false) {
        for (const reasons of Object.values(agents)) {
          if (reasons.auto === null) reasons.auto = "not-installed";
          if (reasons.manual === null) reasons.manual = "not-installed";
        }
      }
      writeState(() => ({ agents }), now);
      pruneRequests(now);
      // Labels that no stand-in holds, also while automatic suspension is off.
      for (const terminal of terminals()) {
        if (!staleLabel(terminal, now)) continue;
        if (closed || !leading(now)) return;
        await serial(() => repair(terminal.address, now));
      }
      if (!installed) return;
      for (const address of candidates) {
        if (closed || !leading(now)) return;
        const outcome = await serial(() => suspend(address, { now }));
        if (closed) return;
        const terminal = terminalAt(address);
        const reason = reasonOf(outcome);
        if (reason === "failed") share(address, "auto", outcome, now);
        if (SLOW_RULES.has(reason) && terminal) {
          heldBack.set(address, { key: processKey(terminal), reason, at: now });
        }
      }
    } finally {
      passing = false;
    }
  }

  return {
    id,
    observe,
    act,
    pass,
    leading,
    suspend,
    wakeClicked,
    // Removes this copy's entry, so another copy leads at once.
    close() {
      if (closed) return;
      closed = true;
      const entries = windowEntries();
      if (!Object.hasOwn(entries, id)) return;
      delete entries[id];
      setShared(SUSPEND_WINDOWS, entries);
    },
  };
}
