# 01: Check the Claude hook facts inside an hc terminal

Status: resolved
Type: research

**What to find out:** facts the Claude plugin (ticket 05) depends on, checked in a disposable hc terminal with a throwaway Claude session. This ticket changes no code. Record each answer with its evidence (the command and its output) under `## Answer`.

- **H1:** The stdin JSON of `SessionStart` for each `source` (`startup`, `resume`, `clear`, `compact`), and of `UserPromptSubmit`. Do both have `session_id`, `transcript_path` and `cwd`?
- **H2:** Does the hook's environment have `HC_TERMINAL_ID`?
- **H3:** The hook's process ancestry (`ps -o pid,ppid,args`): how many hops up to the Claude process, and does its argv show the launch options (compare with fact F2 in the agent-suspension plan)?
- **H4:** Does `transcript_path` exist at `SessionStart` for a new session, or only after the first prompt? Do its first 4 KB contain the session id? This answers spec Q3.
- **H5:** Do hooks fire in `claude -p` started from a tool inside an interactive Claude, and how does the reporter tell that it's `-p` (argv, or a field in stdin)?
- **H6:** How the installer can install a plugin with no prompts: a local marketplace (`claude plugin marketplace add <dir>` + `claude plugin install`), or `hooks` in `~/.claude/settings.json`. This answers spec Q4.
- **H7:** How long a hook may run before Claude's prompt waits on it, so the reporter stays well under that.

## Answer

Checked on 2026-11-26 with Claude Code (`claude --model haiku`) in disposable hc terminals (`t1hd`, `t1hf`, both removed). A logging hook was set through `--settings`, and later through a plugin on a throwaway `CLAUDE_CONFIG_DIR`. Log: the session scratchpad's `hookspike/hooks.log`.

- **H1, stdin:** every event has `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `scratchpad_dir`.
  - `SessionStart` adds `source` and `model`.
  - `UserPromptSubmit` adds `prompt`, `prompt_id` and `permission_mode`.
  - `SessionEnd` adds `reason` and `prompt_id`.
  - Sources seen: `startup`, `resume`, `clear`. `compact` wasn't tested.
  - `/clear` fires `SessionEnd` (reason `clear`) for the old id, then `SessionStart` (source `clear`) with a new id.
  - `/exit` fires `SessionEnd` with reason `prompt_input_exit`, and the terminal finishes with exit code 0.
- **H2:** `HC_TERMINAL_ID` is set in the hook's environment (`t1hd`).
- **H3:** the hook command's parent is the Claude process itself, one hop up: `claude --model haiku --resume <id> --settings …`. Its argv shows every launch option, which matches fact F2. The reporter reads `ps -o args= -p $PPID`. To be safe, it walks up until it finds a process whose args start with `claude`, at most 3 hops.
- **H4:** the transcript does **not** exist at `SessionStart` for a new or cleared session, nor during the first `UserPromptSubmit`. It exists at `Stop`, after the first reply, and at `SessionEnd`. When it exists, the session id appears in its first 4 KB: the first line is `{"type":"last-prompt",…,"sessionId":"<id>"}`, with 5–6 matches. **Spec Q3: the proof rule "first 4 KB contain the session id" holds for Claude.** For `resume`, the transcript exists already at `SessionStart`.
  - **So the plugin uses `SessionStart` and `Stop`, not `UserPromptSubmit`.**
- **H5:** hooks **do** fire in `claude -p`, with the inherited `HC_TERMINAL_ID`. stdin has no field that marks print mode, but the parent's argv shows `claude -p …`. The reporter must skip when that argv contains `-p` or `--print`.
- **H6:** a local marketplace installs with no prompt:
  ```sh
  claude plugin marketplace add <repo>/claude      # holds .claude-plugin/marketplace.json
  claude plugin install herdr-resume@herdr-tincho-config --scope user
  ```
  `claude plugin validate <dir>` passes (it warns that `author` is missing). The plugin's `SessionStart` hook fired after the install. **Spec Q4: use the local marketplace.** The marketplace is "declared in user settings", so the installer writes nothing into `settings.json` itself.
- **H7:** not measured. The logging hook (one `ps` walk plus file reads) didn't noticeably delay the prompt. The reporter does one `ps` walk and one `hc label`, and exits 0 whatever happens.
