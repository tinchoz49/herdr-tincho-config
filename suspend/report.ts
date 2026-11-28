// The Claude reporter: run by the herdr-resume Claude Code plugin
// (claude/herdr-resume) on SessionStart and Stop, it writes Claude's resume
// report into the hc terminal's herdr.resume label, as Pi's extension does for
// Pi. Spec: .scratch/resume-report/spec.md; hook facts: ticket 01.
//
// It runs inside Claude's hook, so it must never block or disturb Claude: it
// always exits 0, prints nothing (SessionStart's stdout is added to Claude's
// context), and does one process walk and one hc label with short timeouts.
// Everything that touches the system goes through ReportIo, so tests replace
// it with fakes.

import { claudeOptions } from "../herdr/mods/tab-tree/claude-options.js";
import { LABEL, SESSION, CLAUDE_OPTIONS } from "../herdr/mods/tab-tree/recipes.js";
import { RESUME, parseReport } from "../herdr/mods/tab-tree/resume-report.js";

export interface ReportIo {
  env: Record<string, string | undefined>;
  /** The pid of the process that started the reporter (the hook's shell, or Claude itself). */
  ppid: number;
  /** The hook's JSON on stdin, as text. */
  stdin(): Promise<string>;
  /** A process's exact argv, or null when it cannot be read. */
  argv(pid: number): Promise<string[] | null>;
  /** A process's parent pid, or null. */
  parent(pid: number): Promise<number | null>;
  exists(path: string): boolean;
  hc(args: string[]): Promise<number>;
  now(): number;
}

// Hops from the reporter's parent up to Claude. Ticket 01 (H3) saw Claude as
// the direct parent; a hook shell that does not exec its command adds one.
const HOPS = 3;

const printable = (s: unknown): s is string => typeof s === "string" && s.length > 0 && !/[\x00-\x1f\x7f]/.test(s);
const absolute = (s: unknown): s is string => printable(s) && s.startsWith("/");

/** Whether an argv is a Claude launch: its program is `claude`, by name or path. */
export const isClaude = (argv: string[]) => argv[0] === "claude" || (argv[0]?.endsWith("/claude") ?? false);

/**
 * Whether a Claude argv runs in print mode (-p, --print, or -p inside a group
 * of short options such as -cp), before any `--`. A print Claude that a tool
 * starts inherits HC_TERMINAL_ID and must never replace its parent's report.
 */
export function isPrint(argv: string[]): boolean {
  for (const word of argv.slice(1)) {
    if (word === "--") return false;
    if (word === "--print" || word.startsWith("--print=")) return true;
    if (/^-[A-Za-z]*p[A-Za-z]*$/.test(word)) return true;
  }
  return false;
}

// Claude's process: the first of the reporter's ancestors, at most HOPS up,
// whose argv is a Claude launch.
async function findClaude(io: ReportIo): Promise<{ pid: number; argv: string[] } | null> {
  let pid: number | null = io.ppid;
  for (let hop = 0; hop < HOPS && pid != null && pid > 1; hop++) {
    const argv = await io.argv(pid);
    if (argv && isClaude(argv)) return { pid, argv };
    pid = await io.parent(pid);
  }
  return null;
}

/**
 * The herdr.resume value for a hook: the report, or "" while the transcript
 * does not exist yet (a new or cleared session before its first reply), or
 * null when the hook's input is unusable and nothing should be written.
 */
export function reportValue(hook: unknown, claude: { pid: number; argv: string[] }, io: Pick<ReportIo, "exists" | "now">): string | null {
  const { session_id: session, transcript_path: proof, cwd } = (hook ?? {}) as Record<string, unknown>;
  if (!printable(session) || session.includes("/") || !absolute(cwd)) return null;
  if (!absolute(proof) || !io.exists(proof)) return "";
  const argv = ["claude", ...claudeOptions(claude.argv.slice(1), cwd), "--resume", session];
  const value = JSON.stringify({ version: 1, agent: "claude", session, argv, cwd, proof, pid: claude.pid, at: io.now() });
  // The mod reads this with parseReport: a report it would reject means
  // nothing to resume, so say so instead of leaving an older one.
  return parseReport(value) ? value : "";
}

/** One hook run. Resolves when done; never rejects. */
export async function report(agent: string | undefined, io: ReportIo): Promise<void> {
  try {
    const terminal = io.env.HC_TERMINAL_ID;
    if (agent !== "claude" || !printable(terminal)) return;
    let hook: unknown;
    try { hook = JSON.parse(await io.stdin()); } catch { return; }
    const claude = await findClaude(io);
    if (!claude || isPrint(claude.argv)) return;
    const value = reportValue(hook, claude, io);
    if (value === null) return;
    // The same call clears the labels the Claude polling used to write
    // (herdr.claude-session, herdr.claude-options): the legacy adapter reads
    // them only while herdr.resume is missing, and this one never is again.
    await io.hc(["label", terminal, `${LABEL}=claude`, `${RESUME}=${value}`, `${SESSION}=`, `${CLAUDE_OPTIONS}=`]);
  } catch {
    // A failed write is retried by the next hook (the next reply).
  }
}
