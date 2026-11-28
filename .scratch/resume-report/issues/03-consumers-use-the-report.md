# 03: Recovery, suspension and the stand-in read only the report

Status: done
Type: task
Blocked by: 02

**What to build:**
- ↻ recovery types `resumeLine(reportOf(labels))`. Without a report, it uses the picker fallback (spec Q1).
- `RESUMABLE` in `suspend-policy.js` becomes one rule: `reportOf(labels)` is present (fast rule) and `proofHeld` (slow rule). The reasons stay "not-resumable" or the missing proof.
- In `standin.ts`, `sessionMissing` and its own `claudeTranscript` go. The wake execs `report.argv` in `report.cwd` after `proofHeld`, and the messages go in as they do today.
- The per-agent session code in `recipes.js` goes: the STARTS and INPUTS session parts, `piRecovery`, `holdsPiSession`, and the Claude allowlist (which moves in ticket 05). A picker-only table may stay for spec Q1.

**Done when:** the existing suspension, stand-in and recovery tests pass after being rewritten against reports, plus new tests: a report written by a plugin wakes with its exact argv, and a missing proof refuses with the reason. The stand-in is rebuilt.

## Comments

**2026-11-26, ticket 03 implementation (agent t-child of t144):**

- `recipes.js` keeps: label constants, `shellQuote`, `piRecovery`, the Claude allowlist, `suspension()`, and a picker-only table (`PICKERS`, `hasPicker`, `pickerLine`) for spec Q1. Gone: STARTS, INPUTS, `recipe`, `recoveryLine`, `RECIPES`, `holdsPiSession`.
- `suspension()` now accepts any report agent key (`[a-z0-9-]+`), not only claude/pi.
- ↻ (`resume.js` `recover(cx, address, { agent, labels, tab, cwd })`): report + proof held → `resumeLine(report)`. Report with proof missing → the agent's picker in `report.cwd` (Pi keeps the options after `--session <file>`; Claude opens on the tab name). This now applies to Claude too (before, Claude typed `--resume <id>` without a check). No report → picker as before. Pi still sends once; other agents keep the report/`/exit` retry.
- Behaviour change: a legacy Pi ID-only record (no session file) now opens the picker on ↻ (proof null), where it used to type `pi --session <id>` in the recorded folder.
- Legacy Claude on ↻ uses the shell pane's `cwd` (as before: it ran in the shell's folder). The mod's proof io finds the transcript folder in one `sh` (a glob for `<id>.jsonl`), not one process per project folder.
- Suspension: fast rule = `reportOf(labels, { agent, cwd: foreground.cwd })` exists and its agent is the running agent; slow rule = `reportHeld` (proofHeld through `exec sh`). Reasons unchanged ("not-resumable").
- Stand-in: legacy Pi report wakes in `pi.cwd` (the report's), not the suspension record's cwd. A report whose agent differs from the record's agent is refused ("it has no resume report"). The stand-in's tab-name argument is now unused.
- Left: README.md line 238 still names `RECIPES` (outside this ticket's files).
