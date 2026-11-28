// What herdr-tincho-config still knows of each agent, now that recovery,
// the suspension rules and the stand-in read its resume report
// (resume-report.js): the label names, the old labels' formats (read by the
// legacy adapter), the suspension record, and the
// session picker ↻ opens without a report (spec Q1). The stand-in imports this
// file at build time, so it must never import "herdr", and a change here needs
// a stand-in rebuild.

// Persistent terminal labels.
export const LABEL = "herdr.last-agent";
export const SESSION = "herdr.claude-session";
export const PI_RECOVERY = "herdr.pi-recovery";
export const SUSPENDED = "herdr.suspended";
export const CLAUDE_OPTIONS = "herdr.claude-options";
// The app name the stand-in reports over OSC 7501 (suspend/standin.ts).
export const STANDIN_APP = "herdr-standin";

// Close single quotes around escapes: sh, bash, zsh and fish agree on this,
// including literal backslashes (fish treats \\ specially inside quotes).
export const shellQuote = (s) => `'${s.replace(/[\\']/g, (c) => c === "'" ? "'\\''" : "'\\\\'")}'`;
// A command word: a string without control characters, possibly empty.
/** @param {unknown} s @returns {s is string} */
const word = (s) => typeof s === "string" && !/[\x00-\x1f\x7f]/.test(s);
const printable = (s) => word(s) && s.length > 0;
const absolute = (s) => printable(s) && s.startsWith("/");

export function piRecovery(raw) {
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !printable(value.sessionId) || !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(value.sessionId)) return null;
    if (value.sessionFile != null && !absolute(value.sessionFile)) return null;
    if (!absolute(value.cwd)) return null;
    if (!Array.isArray(value.args) || !value.args.every(printable)) return null;
    return value;
  } catch { return null; }
}

// The record a suspension leaves in SUSPENDED: which agent to wake (its
// report's agent key), whether a shell hosted it ("shell") or hc started it
// directly ("agent"), the folder it ran in, and when it was suspended (ms).
// Anything else is not a suspension.
/** @typedef {{ version: 1, agent: string, root: "shell" | "agent", cwd: string, since: number }} Suspension */
/** @param {string | undefined} raw @returns {Suspension | null} */
export function suspension(raw) {
  try {
    const value = JSON.parse(/** @type {string} */ (raw));
    if (value?.version !== 1 || typeof value.agent !== "string" || !/^[a-z0-9-]+$/.test(value.agent) || !["shell", "agent"].includes(value.root)) return null;
    if (!absolute(value.cwd) || !Number.isSafeInteger(value.since) || value.since < 0) return null;
    return { version: 1, agent: value.agent, root: value.root, cwd: value.cwd, since: value.since };
  } catch { return null; }
}

// ↻ without a resume report, or with one whose conversation is not on disk
// (spec Q1): the agent's own session picker, never a new conversation. Only
// ↻ uses it; a suspension needs a report. tab: the tab's name, which Claude's
// picker opens on. report: the report whose proof is missing, for its folder
// (Pi's picker lists that folder's sessions) and Pi's launch options.
/** @typedef {{ tab?: string | null, report?: { agent: string, argv: string[], cwd: string } | null }} PickerInput */
/** @type {Record<string, (input: PickerInput) => { cwd: string | null, argv: string[] }>} */
const PICKERS = {
  claude: ({ tab, report }) => ({ cwd: report?.agent === "claude" ? report.cwd : null, argv: ["claude", "--resume", ...(tab ? [tab] : [])] }),
  pi: ({ report }) => {
    if (report?.agent !== "pi") return { cwd: null, argv: ["pi", "--resume"] };
    // pi --session <file> <options>: the picker keeps the options.
    const options = report.argv[1] === "--session" ? report.argv.slice(3) : [];
    return { cwd: report.cwd, argv: ["pi", "--resume", ...options] };
  },
};

// Whether ↻ has a picker for this agent.
/** @param {unknown} agent @returns {agent is string} */
export const hasPicker = (agent) => typeof agent === "string" && Object.hasOwn(PICKERS, agent);

// The line ↻ types to open an agent's picker, or null for an agent without
// one. The program and --resume bare, every other word quoted.
/** @param {string} agent @param {PickerInput} [input] @returns {string | null} */
export function pickerLine(agent, input = {}) {
  if (!hasPicker(agent)) return null;
  const { cwd, argv: [program, flag, ...rest] } = PICKERS[agent](input);
  return `${cwd ? `cd ${shellQuote(cwd)} && ` : ""}${[program, flag, ...rest.map(shellQuote)].join(" ")}`;
}
