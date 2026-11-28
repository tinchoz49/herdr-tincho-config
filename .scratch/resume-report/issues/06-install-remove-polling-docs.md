# 06: Install the Claude plugin, remove the polling, update the docs

Status: done
Type: task
Blocked by: 03, 04, 05

**What to build:**
- `install.sh` builds and installs `herdr-agent-report`, and installs the Claude plugin the way H6 found works without prompts. Both are covered in `tests/install.test.sh`.
- The Claude polling in `tab-tree` goes: `rememberSessions`, its 10 s timer, `claudeLaunch` and `rememberClaudeLaunch`.
- README: a "Resume report" section replaces the per-agent recovery and launch-option sections. GLOSSARY: add **Resume report**, and redefine **Resumable agent** as "has a resume report whose proof is on disk". CHANGELOG entry.
- `sh tests/suspend.integration.sh` passes with a real Pi and a real Claude.

## Comments

**2026-11-26, ticket 06 implementation (child of t144), uncommitted:**

- **install.sh:** one `build.sh` call makes `herdr-standin` and `herdr-agent-report` (the second only when `suspend/report-main.ts` exists); both are recorded in `installed-suspend` by the same source hash, rebuilt when it changes or either binary is missing, kept on a failed build. After a build it runs `herdr-agent-report </dev/null` once (macOS first-launch delay). `standin_sources` now also follows `./x.js` imports inside the herdr modules until stable (claude-options.js is reached through resume-report.js too).
- **Claude plugin:** `install_claude` runs `claude plugin marketplace add <repo>/claude` then `claude plugin install herdr-resume@herdr-tincho-config --scope user` (stdin /dev/null). Done once per repo folder: `installed-claude` holds `<sha of the folder path> herdr-resume@herdr-tincho-config`; `--force` runs both again. No `claude` on PATH: `claude: skipped (no claude on PATH)` plus the two commands. Failure: stderr message with the log, not recorded, never fatal. Not in `--watch`'s stamp (the marketplace loads in place).
- **Polling removed:** `rememberSessions`, its 10 s timer and `sessionsBusy` (main.js); `claudeLaunch`, `rememberClaudeLaunch` (resume.js); `claudeCandidate`, `processIdentity`, `claudeLaunchWords`; `claudeOptionsLabel`; the re-export in recipes.js; resume.js's unused `SESSION` re-export. `claude-polling.js` is now `claude-process.js` (only `isClaude`, used by suspend-policy.js); its test became `tests/claude-process.test.mjs` (the isClaude detection tables kept). Timer lists in 3 tests now `[3000, 15000]`.
- **Reporter:** its one `hc label` call now also writes `herdr.claude-session=` and `herdr.claude-options=` (tests/report.test.ts updated).
- **Docs:** README "Resume report" section (format, proof rule, legacy labels, Pi and Claude subsections with launch options, plugin install), ↻ section rewritten (no RECIPES), old "Pi recovery metadata" and "Claude launch options" sections folded in, Unused agents / wake / Install / Known limits updated. GLOSSARY: **Resume report** added, **Resumable agent** redefined. CHANGELOG: Added + Removed entries.
- **Tests:** node 292/292, bun 87/87, install.test.sh all pass (new: reporter build/rebuild incl. transitive import, plugin once/--force/other folder, no claude, failing claude), herdr-shell.test.sh passes. Test PATH now also drops folders with a real `claude`.
- **Left:** `tests/suspend.integration.sh` with a real Pi and Claude (not run, per brief) — it still sets the legacy `herdr.claude-session`/`herdr.claude-options` labels for its fake Claude, which the legacy adapter still reads. The real install (`./install.sh`) and a manual `/clear` check in an hc terminal are not done.
