# 04: Pi's extension writes the resume report

Status: done
Type: task
Blocked by: 02

**What to build:** `pi/extensions/herdr-recovery` writes `herdr.resume` (and `herdr.last-agent=pi`) in place of `herdr.pi-recovery`:
- argv `pi --session <sessionFile> <recoveryArgs(...)>`, cwd `ctx.cwd`, proof = the session file, and `pid` and `at`.
- It writes an empty report while the session file doesn't exist yet. `agent_start` writes again once it exists.
- It keeps the tui-only and `HC_TERMINAL_ID` guards and the warning when a write fails.

**Done when:** tests cover a new session (empty until the first message), `/resume` and fork (new session), print mode (no write), and kept launch options.
