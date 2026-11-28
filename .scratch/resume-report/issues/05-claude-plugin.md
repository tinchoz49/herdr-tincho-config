# 05: A Claude Code plugin that writes the resume report

Status: done
Type: task
Blocked by: 01, 02

**What to build:**
- `claude/herdr-resume/`: a Claude Code plugin with `SessionStart` and `Stop` hooks (ticket 01, H4) that run `herdr-agent-report claude`.
- `suspend/report.ts`: the reporter, built with bun like the stand-in. It:
  - reads the hook's stdin,
  - stops unless `HC_TERMINAL_ID` is set and the session is interactive: the parent's argv has no `-p`/`--print` (H5),
  - finds the Claude process and its argv (H3),
  - applies the Claude allowlist (moved from `recipes.js` with its tests),
  - writes `claude <options> --resume <session_id>`, with cwd from stdin and proof = `transcript_path`,
  - writes an empty report while the transcript is missing (H4).
- It always exits 0, quickly (H7). A failed `hc label` never blocks Claude.

**Done when:** reporter tests cover each `source`, `-p` (no write), options kept and dropped, and a missing transcript. A manual run in an hc terminal shows the label change at once on `/clear`.

## Comments

Implemented 2026-11-26 (uncommitted, for t144 to review).

- **Files:** `claude/.claude-plugin/marketplace.json`, `claude/herdr-resume/{.claude-plugin/plugin.json,hooks/hooks.json}`, `suspend/report.ts` (logic, injectable `ReportIo`), `suspend/report-main.ts` (real IO + entry), `suspend/build.sh`, `herdr/mods/tab-tree/claude-options.js` (moved allowlist), `recipes.js` (block removed, re-export kept for `resume.js`'s polling), `resume-report.js` (import only), `tests/report.test.ts` (19), `tests/claude-options.test.mjs` (new import path + "imports nothing").
- **Exact argv, not `ps -o args=`:** ps joins words with spaces, so `--allowed-tools "Bash(git *)"` would split. The reporter reads argv with `sysctl(KERN_PROCARGS2)` through bun:ffi on macOS and `/proc/<pid>/cmdline` on Linux; `ps -o ppid=` (or `/proc/<pid>/stat`) only when a hop is not Claude. Measured in the throwaway install: the hook's parent is Claude itself (0 ps calls).
- **Old labels not cleared:** `rememberClaudeLaunch` rewrites `herdr.claude-session` whenever it differs, every 10 s, so clearing it on every hook would make the two writers fight (an extra label write per turn, flicker). It buys nothing: `reportOf` ignores the old labels once `herdr.resume` exists, even empty. Ticket 06 removes the polling and then adds `herdr.claude-session=` `herdr.claude-options=` to the reporter's call (comment in `report.ts`).
- **hooks.json binary path:** `r="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-tincho-config/bin/herdr-agent-report"; [ -x "$r" ] || exit 0; exec "$r" claude` — the same expression as install.sh's `$bin`, expanded by the hook shell. No templating; does nothing when not installed; `exec` keeps Claude the direct parent. Not `${CLAUDE_PLUGIN_ROOT}` (the binary is a 89 MB build output, not plugin content) and not a PATH name (the bin folder is deliberately off PATH). Limit: Claude must see the same `XDG_DATA_HOME` as the installer did.
- **Checked:** `claude plugin validate claude` passes (warns only about no icon). Throwaway `CLAUDE_CONFIG_DIR`: marketplace add + install with no prompt; a stub reporter in `$XDG_DATA_HOME/herdr-tincho-config/bin` got the SessionStart JSON on stdin with Claude as its parent. Re-running add/install is a no-op (exit 0); a directory marketplace "loads in place" from the repo, so plugin edits apply at the next session without reinstall. Built binary under a fake `claude`/`hc`: one `hc label` call, nothing on stdout/stderr, exit 0, ~20 ms warm; the first run of a fresh binary took 1.8 s (macOS first-launch check).
- **Ticket 06, install.sh must:**
  1. call `sh suspend/build.sh "$bin/herdr-standin.install-tmp" "$bin/herdr-agent-report.install-tmp"` (the reporter is built only when a second output is given; one output keeps today's behaviour), then chmod 755 + mv both, keeping the installed copies on failure;
  2. add `suspend/report.ts`, `suspend/report-main.ts` and `herdr/mods/tab-tree/claude-options.js` to `standin_sources` (the stand-in now builds in claude-options.js through resume-report.js, so it belongs there already);
  3. when `claude` is on PATH: `claude plugin marketplace add "$repo/claude"` then `claude plugin install herdr-resume@herdr-tincho-config --scope user` (both idempotent);
  4. optionally run the new binary once (`herdr-agent-report </dev/null` exits at once) to take the first-launch delay off Claude's first hook;
  5. remove the Claude polling, the re-export in `recipes.js`, and add the old-label removal to `report.ts`; update `tests/install.test.sh` build counts if it checks the reporter.
- **Open:** (a) an argv like `claude --resume X --model m` loses options after `--resume` (the moved allowlist stops at optional-value options; ↻ writes options before `--resume`, so herdr's own resumes keep them). (b) The reporter writes on every Stop (no dedupe across processes; `at` changes each time) — one `hc label` per reply. (c) Not done here: the manual `/clear` check in a real hc terminal needs ticket 06's install.
