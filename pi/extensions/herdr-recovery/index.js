import { existsSync } from "node:fs";
import { recoveryArgs } from "./args.js";

// The label name is repeated here on purpose: this extension is installed into
// ~/.pi apart from the mod, so it cannot import resume-report.js. A contract
// test checks that the mod accepts every report this file writes.
const RESUME = "herdr.resume";

/** @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi */
export default function (pi) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  // Pi keeps process.argv even when its process title hides the OS argv.
  const launchArgs = recoveryArgs(process.argv.slice(2), process.cwd());
  let saved;
  let warned = false;

  async function remember(_event, ctx) {
    // A print/RPC Pi launched by a tool inherits HC_TERMINAL_ID. It must not
    // replace the interactive parent's resume report.
    if (ctx.mode !== "tui") return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    // An empty report while there is nothing to resume: an ephemeral session,
    // or a new one whose file Pi writes with its first message. Either way it
    // clears the previous conversation. agent_start writes again once it exists.
    const report = sessionFile && existsSync(sessionFile) ? {
      version: 1,
      agent: "pi",
      session: ctx.sessionManager.getSessionId(),
      argv: ["pi", "--session", sessionFile, ...launchArgs],
      cwd: ctx.cwd,
      proof: sessionFile,
    } : null;
    // The change test leaves out `at`, so a quiet turn writes nothing.
    const key = report ? JSON.stringify(report) : "";
    if (key === saved) return;
    const value = report ? JSON.stringify({ ...report, pid: process.pid, at: Date.now() }) : "";
    try {
      // Also removes the label older versions wrote, which named an older conversation.
      const result = await pi.exec("hc", ["label", terminal, "herdr.last-agent=pi", `${RESUME}=${value}`, "herdr.pi-recovery="], { timeout: 3000 });
      if (result.code !== 0) throw new Error("label failed");
      saved = key;
    } catch {
      if (!warned) {
        ctx.ui.notify("Herdr could not save Pi's resume report. Check that hc is available; it will retry on your next turn.", "warning");
        warned = true;
      }
    }
  }

  pi.on("session_start", remember);
  // Retry failed writes without polling, including after a core restart, and
  // write the report once a new session's file exists.
  pi.on("agent_start", remember);
  // Pi writes a new session's file with its first message, after agent_start:
  // once the run settles the file exists (Pi's own OSC 7577 report waits too).
  pi.on("agent_settled", remember);
  // Keep the label on exit: that is when the sidebar needs it.
}
