# Spec: one resume report from every agent

Status: ready-for-agent

Sources: the conversation of 2026-11-26 (OSC 7577 investigated and not adopted, because Pi's report drops launch options), the glossary, the agent-suspension spec, and the code as of `7fe62a7`.

## Problem Statement

Recovery (↻), the suspension rules and the stand-in each need the same three things for an agent: the command that continues its conversation, the folder to run it in, and proof that the conversation exists on disk. Today herdr-tincho-config works these out itself, differently for each agent:

- Pi: an extension writes `herdr.pi-recovery` (session id, session file, folder, launch options). `recipes.js` turns it into `pi --session <file> <options>`. `holdsPiSession` checks the file's header.
- Claude: nothing runs inside Claude. `tab-tree` polls every 10 s, reads Claude's internal `~/.claude/sessions/<pid>.json`, parses the process argv against an allowlist in `recipes.js`, and writes `herdr.claude-session` and `herdr.claude-options`. `claudeTranscript` searches `~/.claude/projects/*/<id>.jsonl`.
- The per-agent knowledge appears 3 times: `recipes.js` (STARTS, INPUTS), `suspend-policy.js` (RESUMABLE) and `standin.ts` (`sessionMissing`, its own `claudeTranscript`).

As a result:

- Each new agent (Codex, OpenCode) needs changes in all 3 places.
- Claude's session label can lag by up to 10 s after `/clear` or `/resume`, so a suspension or ↻ in that window continues the wrong conversation.
- Claude is only labelled while the Herdr app is open.
- `~/.claude/sessions/<pid>.json` is not a documented interface.

## Solution

Each agent harness reports how to resume itself, through a plugin that runs inside that harness: Pi's extension, and a new Claude Code plugin with hooks. Every plugin writes the same thing, a **resume report**: one label, one format. herdr-tincho-config reads only the resume report. It holds no per-agent recipe, allowlist or session check.

```text
Pi extension ──┐
               ├─ hc label <terminal> herdr.resume=<report>
Claude plugin ─┘
                    │
   resume-report.js (shared by the mod and the stand-in)
     ├── ↻ recovery: cd <cwd> && <argv, quoted>
     ├── suspension rules: report present + proof on disk = resumable
     └── stand-in wake: exec argv in cwd, after the same proof check
```

## The resume report

The label is `herdr.resume`, and its value is versioned JSON:

```json
{
  "version": 1,
  "agent": "pi",
  "session": "0193b6c2-…",
  "argv": ["pi", "--session", "/Users/me/.pi/sessions/x.jsonl", "--model", "sonnet"],
  "cwd": "/Users/me/project",
  "proof": "/Users/me/.pi/sessions/x.jsonl",
  "pid": 41230,
  "at": 1795614571208
}
```

| Key | Meaning | Rule |
|---|---|---|
| `agent` | The program key (`claude`, `pi`), for `herdr.last-agent`, the sidebar icon and the stand-in's line | `[a-z0-9-]+` |
| `session` | The conversation id | printable, no `/` |
| `argv` | The full command that continues this conversation the same way, launch options included | `argv[0]` is a bare program name or an absolute path; each word is printable; never a prompt, a credential, or a session selector other than this session |
| `cwd` | The folder to run it in | absolute |
| `proof` | A file that holds the conversation | absolute; it is resumable only while this file exists and its first 4 KB contain `session` |
| `pid` | The agent process that reported | positive integer |
| `at` | When it reported (ms) | an older report never replaces a newer one |

**An empty value** means "nothing to resume", for example an ephemeral session, or a new session before its first message.

**Plugins must:**
- report only inside hc (`HC_TERMINAL_ID` is set), and only for an interactive session: Pi in `tui` mode, Claude without `-p`/`--print`. A child agent that a tool starts must never replace its parent's report.
- report when the session starts or changes (new, resume, fork, clear), and again once the proof file exists (after the first message). They retry a failed write on the next turn.
- build `argv` from their own allowlist of launch options. The allowlists move out of herdr-tincho-config: Pi's `args.js` stays in Pi's extension, and Claude's allowlist moves from `recipes.js` into the Claude plugin.
- write `herdr.resume` and `herdr.last-agent` in one `hc label` call.
- keep the report when the agent exits, because ↻ needs it then.

**Consumers must:**
- validate the report fully, and treat an invalid report as no report.
- never run argv through a shell. The stand-in execs it directly. ↻ types `cd <cwd> && <each word, shell-quoted>`.
- check `proof` before they suspend and before they wake. A missing proof is reported as the reason ("its conversation file … is missing").

## Changes

1. **New module `herdr/mods/tab-tree/resume-report.js`:** `parseReport`, `resumeLine`, `proofHeld(report, readHead)`, and a legacy adapter. It imports nothing from `"herdr"`, so the stand-in can import it at build time, as it does `recipes.js` today.
2. **Consumers:**
   - ↻ recovery uses `resumeLine`.
   - `RESUMABLE` in `suspend-policy.js` becomes one generic rule.
   - `sessionMissing` and `claudeTranscript` in `standin.ts` become `proofHeld`.
   - The suspension record keeps `agent` from the report.
3. **Pi extension:** writes `herdr.resume` in place of `herdr.pi-recovery`. Its argv is `pi --session <file> <args.js options>`, its proof is the session file, and it writes nothing until that file exists.
4. **Claude plugin (new):** a Claude Code plugin in this repo with `SessionStart` and `Stop` hooks. The transcript only exists after the first reply (ticket 01, H4). They call a small reporter binary built with bun, like the stand-in. The reporter:
   - reads the hook's stdin (`session_id`, `transcript_path`, `cwd`, `source`),
   - finds the Claude process and its argv by walking up its parents,
   - applies the Claude allowlist,
   - builds `claude <options> --resume <id>` with proof = `transcript_path`.
5. **Removed:**
   - the Claude polling in `tab-tree` (`rememberSessions`, `claudeLaunch`, `rememberClaudeLaunch`),
   - the per-agent STARTS and INPUTS for sessions,
   - the labels `herdr.claude-session`, `herdr.claude-options` and `herdr.pi-recovery` (read only by the legacy adapter).
6. **Installer:** installs the Claude plugin and the reporter binary next to the Pi extension and the stand-in.

## Migration

The legacy adapter turns the old labels (`herdr.pi-recovery`, and `herdr.claude-session` + `herdr.claude-options`) into a report. It does this only when `herdr.resume` is missing. Agents that are suspended now, or that crashed before the upgrade, therefore still wake and recover. The adapter is deleted one release later.

## Out of scope

- OSC 7577. Pi's 7577 report drops launch options. If herdr ships 7577, the Claude reporter could also emit it, but that is a separate decision.
- Codex and OpenCode plugins. The format allows them, and none is built here.

## Questions

- **Q1. ↻ without a report:** decided (2026-11-26): keep the picker fallback (`claude --resume` or `pi --resume` in the recorded folder) for ↻ only, never for suspension.
- **Q2. Quit on purpose:** should a plugin clear the report when the user quits on purpose (Pi `/quit`; Claude `SessionEnd` with reason `prompt_input_exit`)? Then ↻ isn't offered for a session the user ended. That changes today's behaviour, where ↻ is offered after any exit. Decided (2026-11-26): no. Plugins keep the report on every exit, and ↻ stays offered after any exit.
- **Q3. Claude's proof:** answered by ticket 01: yes, the first line of the transcript holds `sessionId`.
- **Q4. Claude plugin install:** answered by ticket 01: a local marketplace (`claude plugin marketplace add <dir>`, then `claude plugin install herdr-resume@herdr-tincho-config --scope user`), with no prompt.
