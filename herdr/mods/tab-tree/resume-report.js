// The resume report (GLOSSARY.md: Resume report): how an agent's own plugin
// says to continue its conversation. Every agent writes the same label,
// herdr.resume, so recovery (↻), the suspension rules and the stand-in read one
// format and hold no per-agent recipe. Spec: .scratch/resume-report/spec.md.
//
// The stand-in imports this file at build time, so it must never import
// "herdr", and a change here needs a stand-in rebuild.

import { SESSION, PI_RECOVERY, CLAUDE_OPTIONS, shellQuote, piRecovery } from "./recipes.js";
import { claudeOptionsRecord } from "./claude-options.js";

export const RESUME = "herdr.resume";

/** @typedef {{ version: 1, agent: string, session: string, argv: string[], cwd: string, proof: string | null, pid: number | null, at: number, legacy?: true }} ResumeReport */

// A word of a command: no control characters, possibly empty.
/** @param {unknown} s @returns {s is string} */
const word = (s) => typeof s === "string" && !/[\x00-\x1f\x7f]/.test(s);
/** @param {unknown} s @returns {s is string} */
const printable = (s) => word(s) && s.length > 0;
/** @param {unknown} s @returns {s is string} */
const absolute = (s) => printable(s) && s.startsWith("/");
// The program: a bare name found on PATH, or an absolute path. Never a
// relative path, which would depend on the folder it runs in.
/** @param {unknown} s */
const program = (s) => absolute(s) || (printable(s) && /^[A-Za-z0-9._+-]+$/.test(s));
/** @param {unknown} n */
const count = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

// The report in a herdr.resume label, or null: empty, unreadable, or breaking
// any rule. A rule broken anywhere makes the whole report count as missing.
/** @param {unknown} raw @returns {ResumeReport | null} */
export function parseReport(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value?.version !== 1) return null;
  if (typeof value.agent !== "string" || !/^[a-z0-9-]+$/.test(value.agent)) return null;
  if (!printable(value.session) || value.session.includes("/")) return null;
  if (!Array.isArray(value.argv) || !value.argv.length || !program(value.argv[0]) || !value.argv.every(word)) return null;
  if (!absolute(value.cwd) || !absolute(value.proof)) return null;
  if (!count(value.pid) || value.pid === 0 || !count(value.at)) return null;
  return { version: 1, agent: value.agent, session: value.session, argv: [...value.argv], cwd: value.cwd, proof: value.proof, pid: value.pid, at: value.at };
}

// The report built from the labels written before herdr.resume existed: Pi's
// herdr.pi-recovery, or Claude's herdr.claude-session and
// herdr.claude-options. It starts the agent exactly as the old recipes did.
// cwd: the folder a Claude report runs in (Claude's labels never named one),
// e.g. the suspension record's. Deleted one release after herdr.resume.
/** @param {Record<string, string>} labels @param {{ agent?: string | null, cwd?: string | null }} [options] @returns {ResumeReport | null} */
export function legacyReport(labels, { agent = null, cwd = null } = {}) {
  const pi = piRecovery(labels[PI_RECOVERY]);
  if (pi && agent !== "claude") {
    const file = pi.sessionFile ?? null;
    return { version: 1, agent: "pi", session: pi.sessionId, argv: ["pi", "--session", file ?? pi.sessionId, ...pi.args],
      cwd: pi.cwd, proof: file, pid: null, at: 0, legacy: true };
  }
  const session = labels[SESSION];
  if (agent !== "pi" && printable(session) && !session.includes("/") && absolute(cwd)) {
    const options = claudeOptionsRecord(labels[CLAUDE_OPTIONS]) ?? [];
    return { version: 1, agent: "claude", session, argv: ["claude", ...options, "--resume", session],
      cwd, proof: null, pid: null, at: 0, legacy: true };
  }
  return null;
}

// The report for a terminal: its herdr.resume label, else, only while that
// label was never written, one built from the old labels. An empty
// herdr.resume means "nothing to resume" (a new session before its first
// message): the old labels then name an older conversation.
/** @param {Record<string, string> | undefined} labels @param {{ agent?: string | null, cwd?: string | null }} [options] */
export function reportOf(labels, options) {
  if (!labels) return null;
  if (Object.hasOwn(labels, RESUME)) return parseReport(labels[RESUME]);
  return legacyReport(labels, options);
}

// The line ↻ types into the terminal's shell. Every word is quoted, the
// program too: nothing in a report is ever parsed by the shell.
/** @param {ResumeReport} report */
export function resumeLine(report) {
  return `cd ${shellQuote(report.cwd)} && ${report.argv.map(shellQuote).join(" ")}`;
}

const HEAD = 4096;

// Whether the conversation is on disk: the proof file exists and its first
// 4 KB name the session (a replaced file holds another conversation). A
// legacy Claude report names no file: its transcript is searched for in every
// project folder, ~/.claude/projects/*/<session>.jsonl.
/**
 * @param {ResumeReport | null} report
 * @param {{ readHead: (path: string, bytes: number) => Promise<string | null>, list: (dir: string) => Promise<string[]>, home: string }} io
 */
export async function proofHeld(report, io) {
  if (!report) return false;
  const holds = async (/** @type {string} */ path) => {
    const head = await io.readHead(path, HEAD).catch(() => null);
    return typeof head === "string" && head.slice(0, HEAD).includes(report.session);
  };
  if (report.proof) return holds(report.proof);
  if (!(report.legacy && report.agent === "claude") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(report.session)) return false;
  // As before herdr.resume: the file's presence is enough (older transcripts
  // may not start with the session id).
  const projects = `${io.home}/.claude/projects`;
  for (const folder of await io.list(projects).catch(() => [])) {
    if (typeof await io.readHead(`${projects}/${folder}/${report.session}.jsonl`, 1).catch(() => null) === "string") return true;
  }
  return false;
}

// Why the report cannot be resumed, in words for the stand-in's line and the
// "Can't suspend" reason, or null when it can.
/** @param {ResumeReport | null} report @param {Parameters<typeof proofHeld>[1]} io */
export async function proofMissing(report, io) {
  if (!report) return "it has no resume report";
  if (await proofHeld(report, io)) return null;
  return report.proof ? `its conversation file ${report.proof} is missing or holds another session`
    : `its session ${report.session} has no conversation on disk`;
}
