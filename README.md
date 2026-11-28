# herdr-tincho-config

My Herdr app setup: layouts, mods, themes and an optional Pi recovery extension,
kept here and installed on any machine with one script. Nothing in it is tied to one machine: paths come
from `$HOME` and the XDG variables.

## Set up a machine

Needs the Herdr app (`herdr-app`, `hc`), `git` and a POSIX shell.

```sh
git clone <this repo> && cd herdr-tincho-config
./install.sh
herdr-app do layout.switch --name tincho
```

## How it's laid out

```
herdr/            mirrors the Herdr app home (~/.config/herdr-app)
  layouts/          tincho.json
  mods/             tab-tree/, tab-menu/, tag-prompt/, tab-picker/, tincho-status/
                    tincho-files/, tincho-changes/ (personal panel copies)
  themes/           catppuccin-latte.json, catppuccin-frappe.json
pi/              mirrors Pi's agent directory (~/.pi/agent)
  extensions/       herdr-recovery/ (writes Pi's resume report)
claude/          a Claude Code marketplace: herdr-resume/ (writes Claude's resume report)
suspend/         the stand-in, herdr-shell and Claude's reporter
                 (see Suspending unused agents, Resume report)
tests/           recovery and isolated installer tests
install.sh       copies herdr/ and pi/ into their respective homes,
                 builds the stand-in and the reporter, installs the Claude plugin
```

`install.sh` puts every file under `herdr/` at the same path in the Herdr app
home: `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`, else
`~/.config/herdr-app`. A new mod, layout or theme only needs its file in the
right folder here.

**Pi installation is conditional.** The installer copies `pi/` only when
`~/.pi` is already a directory, or you explicitly set `PI_CODING_AGENT_DIR` to
a nonempty path. The destination is `$PI_CODING_AGENT_DIR`, otherwise
`~/.pi/agent`. Without either condition, it prints `pi: skipped` and does not
create a Pi directory or change its installation manifest. `--force` does not
opt in. An explicit custom directory opts in even if it does not exist yet:

```sh
PI_CODING_AGENT_DIR="$HOME/custom-pi-agent" ./install.sh
```

The recovery extension has no npm dependencies. When it is installed, run
`/reload` in existing Pi sessions to load it; new Pi sessions discover it
automatically. If you set up Pi later, rerun `./install.sh`. The Claude
plugin is installed the same way when `claude` is on `PATH`
([Install](#install)).

- Copies, not symlinks: Herdr doesn't reload a mod through a symlink. Each
  file is written whole and renamed into place, since Herdr reads a file the
  moment it changes and keeps the old one if it catches it half-written.
- It records what it installed (`$XDG_STATE_HOME/herdr-tincho-config/installed`,
  default `~/.local/state/...`; Pi uses a separate `installed-pi` manifest).
  A file changed on that machine since the last
  install is skipped and reported, with the `diff` to compare. `--force`
  overwrites it and keeps the old one as `<file>.orig`.
- A file removed from the repo is reported on every run, never deleted.
- The files Herdr writes into mod folders (`gpui-kit.d.ts`, `jsconfig.json`)
  are ignored by git and never installed.

## Working on it

```sh
./install.sh                                      # install after edits, before testing
herdr-app check ~/.config/herdr-app/mods/<name>   # after each mod change
herdr-app status                                  # file and mod errors
herdr-app shot /tmp/herdr.png                     # what the window shows
node --test tests/*.test.mjs                      # Node 22.19+; no live sessions
sh tests/install.test.sh                         # disposable homes; includes --watch
sh tests/suspend.integration.sh                  # by hand only; disposable hc core
```

Use one-shot installs while developing; no watcher needs to run between edits.
The optional `./install.sh --watch` mode remains available, but repeatedly
hashes enabled source trees while idle, so avoid leaving it running unnecessarily.
It notices when `~/.pi` appears or disappears; while Pi is skipped, it does not
hash the Pi source tree or recreate a removed Pi directory.

Edit here, never in `~/.config/herdr-app` (the next install reports that as
a conflict). Shipped Herdr mods and layouts are replaced on every Herdr start:
clone them (`herdr-app do mod.clone --name <mod> --as <new>`) and move the
clone here.

Reference: `herdr-app --skill`, `~/.config/herdr-app/AGENTS.md`, and the
generated `herdr.d.ts` / `gpui-kit.d.ts` next to it.

## Settings

Herdr's `settings.json` isn't in this repo: Herdr writes it itself (zoom keys,
for example), so the installer would keep reporting it as changed. Set these
by hand in `~/.config/herdr-app/settings.json` on each machine:

```json
{ "telemetry": false, "font": "GeistMono Nerd Font Mono", "minimum_contrast": 2 }
```

`minimum_contrast: 2` makes Herdr swap terminal text below 2:1 against its
background for near-white or near-black. Without it, programs that draw
ANSI 0 on Base or light text on a blue selection (Fresh's "system" theme)
are hard to read.

Optional: `"tincho.suspend"` in the same file (see
[Suspending unused agents](#suspending-unused-agents)), and
`restore_screen = true` in `~/.config/herdr-core/config.toml`.

## Keys

`keys.json` isn't in this repo either (it holds every key, Herdr's defaults
included). Add this section by hand to `~/.config/herdr-app/keys.json`, so
⌘P opens `tab-picker` instead of the shipped picker in this layout:

```json
"layout:tincho": { "cmd-p": "mod.open:tab-picker" }
```

And this line to its `"terminal"` section, so ⌘F opens Herdr's find bar
(screen and scrollback, since 0.1.13). A `keys.json` written by an older Herdr
doesn't get it:

```json
"cmd-f": "terminal.search",
```

## Layout: `tincho`

The shipped `main` layout without the spaces list, agents list and top tab
bar. The left sidebar is a single `tab-tree` list between the brand bar and
the settings footer. Pane headers and the Files/Changes UI stay as in
`main`; the panels use the personal copies below. The status bar is
`tincho-status`.

### Files and Changes

Use **Files** and **Changes** on the right side of the status bar, just before
**Commands**, to open the side panel. The visible panel's button is highlighted;
click it again to hide the panel, or click the other button to switch views.
No extra keyboard shortcuts are installed.

#### Idle work

`tincho-files` and `tincho-changes` preserve the shipped UI and Git actions
without changing the shipped originals. Hidden ancestors and inactive stack
tabs stop background reads and refresh follow-ups. In-flight results are
ignored after an observed hide or location change; explicit user commits can
finish while hidden.

Visible local panels refresh on filesystem events, with a 60-second safety
refresh. Remote locations, failed watches, and exhausted watch slots retain a
10-second fallback. Unchanged refreshes do not request redraws, and unrelated
renders do not serialize the entire tree or diff.

Herdr has no hide/show callback or cancellable `watchFolder` API. One pending
fallback may wake after hiding, then stops; outstanding native waits remain
until an event. Same-root waits are reused, with at most four pending waits per
panel copy. Reveal refreshes after an observed suspension. A very brief
hide/reveal without any intervening callback retains the existing freshness
bound rather than guaranteeing an immediate refresh.

See `herdr/mods/tincho-panel/CONTRACT.md` for the lifecycle contract and each
panel's `PROVENANCE.md` for its source. The small `work.js` helper is copied
identically into both mods because Herdr forbids sibling-directory imports;
a test enforces equality.

## Themes

Catppuccin, following its style guide
(https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md):

- `catppuccin-latte` (light) and `catppuccin-frappe` (dark). `tincho` uses
  `{ "light": "catppuccin-latte", "dark": "catppuccin-frappe" }`, so it
  follows the macOS appearance. The theme picker overrides it.
- Terminal colors: the guide's ANSI mapping (black/white from Surface/Subtext,
  brights generated with its formula), cursor Rosewater, selection Overlay 2
  at 25% over Base. One deviation: Frappé's bright black (ANSI 8) is Overlay 2
  instead of Surface 2, because programs use it for comments and hints and
  Surface 2 is too dim on Base.
- Interface: Base for panes, Mantle for the sidebar, Crust behind the cards,
  Surface 0/1 for hover and selection, Overlay 0 borders, Lavender for the
  focused pane (accent), Subtext 0 labels, Overlay 1 subtle text. Agent
  status: working Blue, needs you Yellow, done Green, idle Overlay 1.

## Mod: `tab-tree`

Every tab, grouped by its Herdr space (one group per space, in the spaces'
order).

- Group header: avatar (same colors as the shipped spaces list), space name,
  machine and the branch of its main-checkout tab when it isn't main/master.
  Hover for `+` (new tab, in the repo's main checkout when its tabs are in
  one), chevron folds it, click shows the space, right-click opens its menu.
- Drag and drop (a drag starts after the pointer moves 4px, so a click still
  clicks; a ghost of the row follows the pointer and a line shows the drop
  slot: the upper half of a row drops above it, the lower half below;
  leaving the sidebar cancels):
  - a space's header onto another space: reorders the spaces (`space.move`),
    so `ctrl-1..9` and space next/prev follow the sidebar.
  - a tab within its space: reorders it (`tab.move`).
  - a tab into another space on the same machine: moves it there, programs
    still running. Herdr has no command for it, so the mod parks each of the
    tab's terminals (`terminal.park`: the pane goes, the process stays), then
    points their `herdr.space` / `herdr.tab` labels at the target
    (`hc label`), and Herdr adopts them there as one new tab. Dropped on a
    space's header, the tab goes first.
- Worktree tabs carry `- <worktree>` after their name. A split pane shows
  its own worktree only when it differs from its tab's.
- Tab row: its primary pane (the first pane of its split tree). Shows the
  tab name when someone named it, else what runs there:
  - agent: program icon, its session name (the title it sets, e.g. Claude
    Code's `/rename`; the program's name when it has none), status (spinner /
    Needs you / done dot / idle ring)
  - shell at its prompt: muted, the folder name (or the shell, when the
    folder is the workspace itself)
  - program (nvim, lazygit, ...): its icon and name, then its title or folder
- Split panes list under their tab at one level, indented past the tab's
  icon, in the order of the split tree (depth first), however deep a split or
  sub-agent is. The tree comes from
  herdr-core's `herdr-app` document (`doc.get` over `hc connect`), re-read
  whenever the panes change. Pane rows focus that pane on click.

Grey detail text never repeats the workspace or the row's own name.

The mod shares its outline (groups, tab names, icons, status) as
`tab-tree.outline` for `tab-picker`.

### Resuming agents (`herdr/mods/tab-tree/resume.js`)

herdr-core keeps nothing of a program it lost (`hc server stop`, a restart, a
crash): the terminal comes back as a fresh shell. So the mod records it
itself: every few seconds it labels each local terminal running an agent with
`herdr.last-agent=<program key>` (`claude`, `pi`, `codex`, ...). The core keeps
labels across restarts.

Hover a tab back at a shell prompt for ↻. It reads the terminal's
[resume report](#resume-report):

- A report whose conversation is on disk: ↻ types
  `cd '<cwd>' && '<argv[0]>' '<argv[1]>' ...`, every word quoted. That is the
  exact conversation that terminal last ran, started with its launch options.
- A report whose conversation is missing, or no report: ↻ opens the agent's
  own session picker, never a new conversation and never `--continue` (it
  takes the folder's latest conversation, often another tab's). Claude:
  `claude --resume '<tab name>'` in a named tab, else `claude --resume`. Pi:
  `pi --resume` with the report's launch options. With a report, both run in
  its folder. Only Claude and Pi have a picker.

Pi is sent once, after checking the terminal is still at its shell; it does
not use Claude's report timeout and `/exit` retries, which could interrupt the
picker. Recovery never types into a suspended agent's terminal: ↻ isn't
shown there.

Recovery requests run serially within each sidebar copy. The queue belongs to
the view instance—not module scope, which Herdr 0.1.14 shares across copies.
Closing the sidebar invalidates its queued work and follow-ups; a replacement
sidebar can recover independently even if an old native promise never settles.
Already-issued commands cannot be recalled. Separate sidebar copies have
independent queues. Hiding the sidebar does not close it or cancel recovery.

No `herdr.last-agent` label and no report, or an agent without a picker: no
button. Remote machines get no button.

### Resume report

Each agent says how to continue its own conversation. A plugin that runs
inside the agent (Pi's extension, the Claude plugin) writes it on the
agent's terminal, as one label, `herdr.resume`, with the same format for every
agent:

```json
{
  "version": 1,
  "agent": "pi",
  "session": "0193b6c2-example",
  "argv": ["pi", "--session", "/home/me/.pi/agent/sessions/x.jsonl", "--model", "sonnet"],
  "cwd": "/home/me/project",
  "proof": "/home/me/.pi/agent/sessions/x.jsonl",
  "pid": 41230,
  "at": 1795614571208
}
```

- `agent`: the program key. `session`: the conversation id. `argv`: the whole
  command that continues it, launch options included. `cwd`: the folder to
  run it in. `proof`: the file that holds the conversation. `pid`: the agent
  process that wrote it. `at`: when (ms).
- An empty value means "nothing to resume": an ephemeral session, or a new
  one before its first message.
- **Proof rule:** a report counts only while its `proof` file exists and its
  first 4 KB name the session. ↻, the suspension rules and the stand-in all
  check it, the same way (`resume-report.js`). A missing proof is given as the
  reason ("its conversation file … is missing").
- The mod and the stand-in validate the whole report: a report that breaks a
  rule counts as no report. They never run `argv` through a shell: the
  stand-in starts it directly, ↻ quotes every word.
- The plugins write `herdr.resume` and `herdr.last-agent` in one `hc label`
  call. They write only inside hc (`HC_TERMINAL_ID`) and only for an
  interactive session, so an agent that a tool starts never replaces its
  parent's report. They keep the report when the agent exits: ↻ needs it then.
- herdr-tincho-config holds no per-agent recipe: a new agent needs only a
  plugin that writes this report.

Before this report, Pi wrote `herdr.pi-recovery`, and the mod polled Claude
every 10 s and wrote `herdr.claude-session` and `herdr.claude-options`. The
mod still reads those old labels, only while a terminal has no
`herdr.resume` label at all, so agents that were suspended or lost before the
upgrade still wake and recover. The plugins clear them when they write a
report. That reading goes one release later.

#### Pi (`pi/extensions/herdr-recovery/`)

The extension writes Pi's report on `session_start` (startup, `/reload`,
`/new`, `/resume`, `/fork`), and again at each turn, so a new session gets its
report once Pi writes its file and a failed write is retried without polling.
It writes only in Pi's `tui` mode. Its `argv` is
`pi --session <session file> <launch options>`, and its proof is the session
file. It writes an empty report while the file doesn't exist (also for
`--no-session`). A failed write shows one warning.

Launch options come from Pi's `process.argv`, not Herdr's process inspection:
Pi changes its process title, which can hide its arguments from the OS.

- Preserved value options: `--provider`, `--model`, `--models`, `--thinking`,
  `--tools`, `--exclude-tools`, `--use-theme`, and `--tui-mode`.
- Preserved paths: `--extension`, `--skill`, `--prompt-template`, `--theme`,
  and `--session-dir`. Relative paths become absolute against the launch
  directory; `builtin:` extension identifiers stay unchanged.
- Preserved switches: `--no-tools`, `--no-builtin-tools`, `--no-extensions`,
  `--no-mcp`, `--no-skills`, `--no-prompt-templates`, `--no-themes`,
  `--no-context-files`, `--no-approve`, `--no-sandbox`, `--offline`, and `--verbose`.
  Supported short aliases are normalized to their long forms.
- Not replayed: initial prompts, `@file` inputs, old session selectors, and the
  launch-time session name. `--api-key`, inline system prompts and trust
  approvals are not saved. Unknown flags (including extension-specific flags)
  stop option capture: their values cannot safely be distinguished from later
  options.

These are **launch options**, not a snapshot of all runtime settings. For
example, a saved `--model` or `--thinking` overrides changes made later inside
Pi. Shell wrappers, environment variables, credentials and Node runtime flags
are not captured.

The extension must be loaded. With `--no-extensions`, explicitly add
`-e ~/.pi/agent/extensions/herdr-recovery/index.js` (adjust for a custom agent
directory). It has no npm dependencies. When it is installed, run `/reload`
in existing Pi sessions to load it. It targets Pi's current `session_start`
lifecycle (verified with Pi 1.5.0).

#### Claude (`claude/herdr-resume/`)

A Claude Code plugin, `herdr-resume`, in this repo's own marketplace
(`claude/`). Its `SessionStart` and `Stop` hooks run `herdr-agent-report
claude`, a small program built with Bun next to the stand-in
(`suspend/report.ts`). It reads the hook's input, finds the Claude process
above it and reads its exact argv, and writes the report: `argv` is
`claude <launch options> --resume <session id>`, and the proof is the
transcript Claude names. The transcript exists only after the first reply, so
a new or cleared session gets an empty report until then. It skips print
mode (`-p`, `--print`). It always exits 0 and prints nothing, so it never
disturbs Claude. When the program isn't installed, the hooks do nothing.

`./install.sh` installs the plugin for your user when `claude` is on `PATH`
(see [Install](#install)). By hand:

```sh
claude plugin marketplace add "$PWD/claude"
claude plugin install herdr-resume@herdr-tincho-config --scope user
```

Claude loads a folder marketplace in place, so an edit to the plugin applies
at Claude's next session. The hooks find the program through
`XDG_DATA_HOME`, so Claude must see the same value as the installer did.

Claude's launch options (`herdr/mods/tab-tree/claude-options.js`):
`--resume` alone doesn't keep the model.

- Kept: `--model`, `--permission-mode`, `--effort`, `--fallback-model`,
  `--agent`, `--setting-sources`, `--plugin-dir` and a few more with one
  value; switches such as `--dangerously-skip-permissions` and `--verbose`;
  the lists `--add-dir`, `--allowed-tools`, `--disallowed-tools` and `--tools`,
  only when another option or `--` follows them (Claude takes a trailing
  prompt into a list). Relative folders become absolute.
- Never kept: prompts, system prompts, `--settings`, `--agents`,
  `--mcp-config` (they can hold credentials), `--file`, `--betas`, and session
  selectors (`--continue`, `--session-id`, `--name`).
- An unknown option, or one with an optional value (`--resume`, `--debug`,
  `--worktree`, ...), stops capture. The words after it are dropped.
- A bare word in the middle of a list (`--add-dir /x text --model m`) is kept
  as a folder, as Claude itself reads it.

## Suspending unused agents

An idle agent still holds its memory (about 250 MB for a Pi agent, plus its
MCP servers). `tab-tree` **suspends** unused agents: it ends the agent's
process, but the terminal stays live with the same address, name, labels,
parent and children. A small **stand-in** program holds the terminal. Other
agents keep using plain `hc send`: the message wakes the agent and becomes its
first prompt. Nothing in hc changes.

The words used here are defined in [`GLOSSARY.md`](GLOSSARY.md). Why it works
this way: [ADR 0001](docs/adr/0001-suspended-agents-reached-through-a-stand-in.md).
The design and the facts checked for it: [`plans/agent-suspension.md`](plans/agent-suspension.md).

### Unused agents

An agent is suspended only when all of these hold:

- It's resumable: its terminal has a [resume report](#resume-report) from
  the agent running there, and the report's proof file holds its session.
  When the proof is missing, the automatic pass tries that agent again after
  5 minutes.
- It's `idle` or `done` for the threshold, counted from the later of its last
  status change and the last time its tab was focused.
- Its tab isn't the focused tab of any Herdr window.
- It isn't `working` or `blocked`.
- It isn't pinned (**Never suspend**).
- It runs on this machine. Remote agents are never suspended.
- It runs no processes of its own except helpers. A helper is a process whose
  command line contains an entry of `helpers` (default `mcp`, which matches
  the MCP servers under each Pi agent). A process under a helper counts as
  part of it. A dev server, a watcher or a build keeps the agent awake. For
  an agent inside your shell, the shell's other jobs (`npm run dev &`) must
  be helpers too.

Child terminals don't count. They keep running when their parent is
suspended, and a parent that waits on its children already counts as
`working`.

One copy of `tab-tree` acts, even with several windows open. Right before it
suspends an agent, it reads the terminal again and stops if anything changed.
Suspension happens only while the Herdr app is open.

How the agent's process ends depends on what hc started in the terminal:

- **An agent that hc started directly** (`hc run pi …`, how herdr subagents
  start) gets `SIGKILL`. Pi turns `SIGTERM` into a normal exit (code 0), and
  hc ends a terminal whose program exits normally, even a kept one; no program
  can turn `SIGKILL` into an exit. Then every process that was under the agent
  (its MCP servers and their children) gets `SIGTERM`. Pi 1.5.2 appends each
  entry to its session file as it happens (`appendFileSync` in its session
  manager, read in its source), so an idle Pi loses nothing.
  `tests/suspend.integration.sh` checks both signals with a real Pi.
- **An agent inside your shell** (fish, bash or zsh): the shell gets
  `SIGKILL`. Interactive bash and zsh ignore `SIGTERM`, and zsh turns `SIGHUP`
  into a normal exit, so only `SIGKILL` counts as a lost program for every
  shell. With the shell gone, the agent in front receives `SIGHUP` and shuts
  down cleanly, its session saved (checked with bash, zsh and fish).

### Suspension settings

In `~/.config/herdr-app/settings.json` (set by hand, see [Settings](#settings)):

```json
"tincho.suspend": { "after_minutes": 30, "helpers": ["mcp"] }
```

These are the defaults when the key is missing. A missing or invalid field
keeps its default. `"tincho.suspend": false` or `"after_minutes": 0` turns
automatic suspension off. **Suspend now** still works then, with the same
helpers.

To see the agent's last screen above the stand-in's line, set
`restore_screen = true` in `~/.config/herdr-core/config.toml`. hc's default is
`false`, and the stand-in then shows only its line.

### Suspend now and Never suspend

Right-click an agent tab on this machine:

- **Suspend now** skips the threshold. Every other rule still applies. The
  item shows "Suspending…", then "Suspended" or "Can't suspend: <reason>"
  (focused, working, blocked, background processes, pinned, not resumable,
  remote terminal, suspension not installed, and so on). It can show the
  reason before you click; click anyway to check again. With no answer for a
  minute, it shows "no answer from tab tree".
- **Never suspend** pins the agent (the label `herdr.never-suspend=1`). On a
  pinned agent the item reads **Remove Never suspend**. From a shell:
  `hc label t7 herdr.never-suspend=1`, and `hc label t7 herdr.never-suspend=`
  to remove it.

### What you see

- In the sidebar, a suspended agent's row has a dimmed name and icon and 💤
  (only while the stand-in or `herdr-shell` is in front). While the agent
  starts again, the row shows "waking…". A stand-in that can't wake the
  agent shows "Needs you".
- In the terminal: the agent's last screen (with `restore_screen`), then a
  line like `💤 pi suspended at 14:05 · wakes on a message or a click on its
  row · Enter wakes it`.
- For other agents, a suspended agent is an idle agent: `hc send --if idle`,
  `hc wait` and `hc send --wait` work as usual.

### What wakes an agent

- **A message**: `hc send` from another agent, hc's own notes about a child,
  or a line you type in the stand-in and confirm with Enter. Messages that
  arrive within 500 ms of the first one go in together, as one first prompt.
  The stand-in never runs what it receives.
- **A click** on its tab or pane row in the sidebar.

Focus alone never wakes an agent. Herdr moves the focus on its own (after a
tab closes or an agent exits, into a new split, through ⌘P or the
next-agent command), so a suspended tab that just got the focus stays
suspended until you click its row or press Enter.
- **Enter** on an empty line in the stand-in, also through `hc attach` from a
  plain terminal. The agent wakes with no prompt.

The agent starts from its exact session, in its recorded folder, with its
launch options. An agent that ran inside your shell returns to a shell prompt
when you exit it (a login shell on macOS, as hc starts them). An agent that
hc started directly ends its terminal, as before.

A message sent while the terminal switches to the stand-in never runs as a
command. For a short moment hc has no program in the terminal and
refuses the send as `unavailable`; the sender can send it again. After that,
while `herdr-shell` and the stand-in start, hc delivers it: the text waits in
the terminal's input, and the stand-in reads everything that arrived before
it was ready as one message, with its lines joined by newlines (input that
reaches it in two separate reads can become two messages). When
`herdr-shell` waits on an error (below), it keeps the lines with text for
the stand-in.

The stand-in starts the report's `argv` directly (no shell) in its `cwd`.
When the session is gone (no resume report, or its proof file is missing or
holds another session), the stand-in doesn't wake the agent. It saves the messages in
`${XDG_STATE_HOME:-~/.local/state}/herdr-tincho-config/undelivered/`,
shows the file's path and reports `blocked`, so hc tells the parent. A wake
that fails for another reason, or an unexpected error in the stand-in, ends
the same way. The stand-in never exits on its own, because a normal exit
would end the kept terminal.

A woken agent normally reports its status at once. Claude can miss that
step, and hc would then show the stand-in's `working` report for good, so
`hc wait` and `hc send --if idle` would treat the agent as busy. Right before
it starts the agent, the stand-in leaves a small watchdog (`/bin/sh`). It
reads the terminal once, 30 s later. If the terminal is live, hc still shows
the report the stand-in made when the wake began, and the stand-in isn't in front,
it reports `idle` for the terminal, once.
In every other case it does nothing. The sidebar stops showing "waking…"
after the same 30 s.

### Restarts, crashes and repairs

- Suspended agents stay suspended through `hc server stop` and the next core
  start (checked on a disposable core, fact F1 in the
  [plan](plans/agent-suspension.md)). The terminal keeps its address and
  labels, and starts the stand-in again. A reboot should behave the same,
  since it also ends in a core start, but that wasn't checked.
- Suspension keeps the terminal (`hc keep`). If the agent crashes after it
  woke, the terminal stays, with a shell and ↻.
- A live agent never shows 💤. When a terminal keeps the suspension label but
  another program runs in it (a failed step, or a label set by hand),
  `tab-tree` removes the label at its next pass once the label is 60 s old.
  The stand-in and `herdr-shell` are left alone. A menu that just asked to
  suspend that agent then says "Can't suspend: stale suspension label
  removed". A wake that no agent reports for is ended by the stand-in's
  watchdog after 30 s (see [What wakes an agent](#what-wakes-an-agent)).

### Install

`./install.sh` with Bun on `PATH`:

- Builds the stand-in (`suspend/build.sh`) with Bun's small ahead-of-time
  compile (`bun compile`, canary builds only today). Without it, it uses
  `bun build --compile --minify` (stable Bun: a bit more memory, much larger
  on disk). An idle stand-in uses about 7.5 MB. Without Bun it prints
  `suspend: skipped (no bun)` and leaves hc's `shell` setting alone.
- The same build makes Claude's reporter, `herdr-agent-report` (see
  [Claude](#claude-claudeherdr-resume)), and runs it once, so macOS's check
  of a new program doesn't slow Claude's first hook.
- Installs `herdr-standin`, `herdr-agent-report` and `herdr-shell` into
  `${XDG_DATA_HOME:-~/.local/share}/herdr-tincho-config/bin/`, which is not
  on `PATH`.
- Records them in the `installed-suspend` manifest (next to `installed`), by
  the hash of their sources (`suspend/`, and the `herdr/` modules they
  import: `recipes.js`, `resume-report.js`, `claude-options.js`). It rebuilds
  both only when a source changes or a binary is missing. Upgrading Bun
  doesn't rebuild: delete the installed `herdr-standin` to get a build with
  the new Bun. A failed build keeps the old binaries and is tried again on
  the next run.
- Sets `shell = ["<bin>/herdr-shell"]` in
  `${XDG_CONFIG_HOME:-~/.config}/herdr-core/config.toml` and keeps every other
  key. A different `shell` value is reported as a conflict and kept;
  `--force` replaces it and keeps the old file as `config.toml.orig`. A file
  it can't read (a multi-line string, for example) is reported and never
  edited: set the line by hand. If the stand-in isn't installed (its first
  build failed), the key stays as it is. hc uses the new shell for programs
  it starts after that; running programs keep running.

`herdr-shell`, `herdr-standin` and `herdr-agent-report` are program files: a
new version replaces them even when they were changed on this machine.

With `claude` on `PATH` (Bun not needed), it also installs the Claude plugin:
`claude plugin marketplace add <repo>/claude`, then
`claude plugin install herdr-resume@herdr-tincho-config --scope user`. It
does this once per repo folder (recorded in `installed-claude`); `--force`
runs both again, and they change nothing when the plugin is there. Without
`claude` it prints `claude: skipped (no claude on PATH)` and the two
commands. A failure is reported, stops nothing else, and is tried again on
the next run.

Every new terminal starts through `herdr-shell`. It reads its terminal's
labels with `hc get` and starts the stand-in when the terminal is suspended,
else your `$SHELL` (`/bin/sh` when unset), with the arguments hc gave it.
hc starts login shells on macOS but runs a configured `shell` exactly as
written, so on macOS, with no arguments, `herdr-shell` starts `$SHELL -l`.
The stand-in's handover to your shell and the shell after an agent that ran
inside it do the same. While hc restarts, `herdr-shell` tries again for
about 2 s. On any other error it shows the error and waits for Enter on an
empty line. It never starts a shell unless hc said the terminal isn't
suspended. Nothing is suspended ("suspension not installed") until both
programs are installed and `herdr-shell` is hc's `shell`.

### Idle work

- One 15 s pass in each `tab-tree` copy; only the leading copy acts. It
  starts no process unless an agent is past its threshold, a **Suspend now**
  request waits, or a stale label needs removing. It checks the installation
  at most every 5 minutes.
- One watchdog per wake: a `/bin/sh` that sleeps 30 s, runs `hc get` once
  and exits.
- A 60 s heartbeat in Herdr's shared state keeps the leader choice. Every mod
  re-renders then.
- About 15 ms per new terminal for `herdr-shell`'s label check.
- No labeling timer: `herdr.last-agent` is written from render, when a pane
  shows an agent its terminal hasn't recorded yet (one `hc label`, once).

### Known limits

- Automatic suspension happens only while the Herdr app is open. Focus times
  are kept in memory, so after an app restart only the status time counts.
- A message pasted milliseconds before the signal can be lost. Preventing
  that needs an hc change.
- A send during the switch to the stand-in is refused only while hc has no
  program in the terminal (a short moment). Later sends in the switch
  arrive, but several of them become one message.
- A helper is any process whose command line contains a `helpers` entry, so
  with the default `mcp`, a dev server under a path such as
  `~/projects/mcp-foo/` counts as a helper and doesn't keep its agent awake.
- A Claude that hc started directly gets `SIGKILL` like Pi. That it loses
  nothing then wasn't checked.
- The watchdog's `idle` report has no app name. hc shows it until the woken
  agent reports on its own.
- `./install.sh` and `tab-tree` find the bin folder and herdr-core's config
  from `XDG_DATA_HOME` and `XDG_CONFIG_HOME`. If the Herdr app runs with other
  values than your shell, it reports "suspension not installed" or checks a
  different config than the one hc reads. The check reads `config.toml`, not
  the running core; whether a running core uses a new `shell` value for its
  next program, or only after it restarts, wasn't checked.
- **Suspend now** on an agent that an automatic suspension is suspending at
  that moment can answer "Can't suspend: already suspended". A request made
  in the same instant that the leader removes old requests can be lost; the
  menu then says "no answer from tab tree" after a minute, and only when it
  redraws.
- Unsent text typed into an agent and left past the threshold is lost.
- Every new terminal pays about 15 ms for the label check.
- Bun's small ahead-of-time compile is experimental and canary only today.
  The standard compile covers stable Bun.
- Only agents with a resume report on this machine are suspended: today
  Claude (with the plugin installed) and Pi (with the extension).
- hc has no hook that runs a command when a message reaches a terminal. Such
  a hook would make the stand-in unnecessary; it's worth requesting
  ([ADR 0001](docs/adr/0001-suspended-agents-reached-through-a-stand-in.md)).
- Not checked: a first-run Claude dialog (folder trust) during a wake may
  drop the first prompt. Claude then reports `blocked`, and hc tells the
  parent. A folder that already has a session is already trusted.

### Checking it by hand

`sh tests/suspend.integration.sh`, from a normal terminal outside an agent
sandbox, builds the stand-in and runs a disposable hc core under `/tmp` with
fake Claude and Pi agents. It suspends both, sends a message to each, and
checks the first prompt, the address, labels, parent and child, and that
nothing ran in a shell. Then it starts two real Pi agents with `hc run`, in a
throwaway `HOME` and with a fake MCP server: `SIGKILL` keeps the first
terminal live with the stand-in and ends the helpers, and `SIGTERM` ends the
second terminal with exit code 0. It needs `bun`, `node`, `fish`, `pi` and
`hc`, and takes about a minute. It never touches your core or agents. It
isn't part of `node --test`. From inside an agent sandbox, run it in a
throwaway terminal: `hc run --rm --no-notify -- sh tests/suspend.integration.sh`.

## Mod: `tab-picker`

⌘P (see Keys). Herdr's shipped picker, cloned, showing the tabs as the
sidebar does: grouped by space, and named as the sidebar names them, with the program's icon instead of its name
("Claude Code"). It reads `tab-tree.outline`; in a layout without `tab-tree`
it falls back to one group per space. "new tab" and "new space" stay pinned
under the list, ↑/↓ reach them too.

## Mod: `tincho-status`

The status bar. The shipped `workspace-status` (machine, branch, agents,
palette hint), with the branch of the focused pane instead of the space's,
plus an always-visible **PR off / PR on** toggle. PR lookup is **disabled by
default**. Click the toggle to enable or disable GitHub PR, CI and review-bot
data globally across live status-bar copies. The choice persists through
Herdr's shared state (`tincho-status.pr-enabled`); only boolean `true` enables
it, so an absent or malformed value stays off. The focused pane's branch
remains visible while PR lookup is off.

With PR lookup enabled:

```text
⎇ TBD-1890   PR on   ⇄ #6131   CI ✓   CodeRabbit ✓   Cursor ● 2   Copilot ✓   Sonar ✓   Review ● changes · 3 open
```

- `#6131` opens the PR in the browser. Every item has a tooltip with details
  (who approved, how many threads are open).
- CI: every check but CodeRabbit's and Sonar's, the newest run of each
  (skipped ones left out): a spinner and passed/total while any runs, an
  orange dot and "n failed" (the tooltip names them) when one failed, ✓ when
  all passed. A pushed branch with no PR still shows `no PR  CI …`, from
  the checks on its newest commit on GitHub (`gh api .../commits/<branch>/check-runs`
  and `/status`).
- CodeRabbit, Cursor, Copilot: a spinner while CodeRabbit's check runs, an
  orange dot with the number of unresolved threads it opened, a check when it
  reviewed and none are open, a grey dot when it hasn't reviewed.
- Sonar: SonarQube Cloud's check (only in repos that run it).
- Review: people only (bots left out): changes requested, approved,
  commented or none, plus their unresolved threads.

When enabled, GitHub is reached only through `gh`, in the focused pane's
folder and on its space's machine: `gh pr view <branch>`, then one
`gh api graphql` for review threads. If `gh pr view` reports no PR, the mod
tries the branch's check runs, then commit statuses when check runs are
available. With no PR or checks, the data section stays hidden. Bots are
recognized by login, the same list as resolve-ticket's `watch-lib.js`.

Enabling starts a fresh focused-branch lookup immediately. Each live
status-bar copy owns at most one 60-second refresh timer while enabled;
focus changes also look up uncached or stale branches. A lookup already in
progress for a branch is not duplicated. Hidden copies remain alive under
Herdr's lifecycle rules and can still refresh while enabled.

Disabling hides PR/CI/bot data, cancels the refresh timer and owned lookup
tasks, clears cached results, and invalidates in-flight work. No new `gh`
requests start while disabled; a pending result cannot trigger follow-up
GraphQL/check/status requests or overwrite a newer off/on cycle. An `exec`
that has already started **cannot be killed by this toggle** and may finish.
Closing cancels the copy's owned tasks; Herdr also stops owned tasks on mod
reload. The background-jobs popup never starts PR lookups or a PR timer.

### Background jobs

Beside the agent count, `2 background jobs` counts live terminals launched
under the **focused terminal**, including nested descendants. It includes
agents, builds, tests, and servers, but excludes terminals that already have
panes and terminals whose processes have exited. A live agent reporting `done`
still counts; it can accept another task. The item is hidden when there are no
matching jobs, and uses the attention color if any job is blocked or in error.

Click the count for a compact, jobs-only list with names, terminal addresses,
and statuses—no header or footer. It fits up to seven rows before scrolling.
Jobs that need attention come first. Click a row (or use ↑/↓ and Enter) to
**peek** at its terminal without creating a permanent pane; Esc or clicking
outside closes the job list. The terminal preview keeps Herdr's standard
header with Keep and Close controls. It adds an 8px inset so the header and
terminal backgrounds stay inside the rounded frame. Escape inside the preview
goes to the terminal, as it does in Herdr's built-in preview. The popup keeps the parent it was opened for even
while it takes keyboard focus, and its contents update as jobs start, finish,
or move into panes. Plain commands show `Running`, not an invented agent
status. Launch arguments are not displayed. Keyboard navigation scrolls the
selected row into view, including when wrapping through long lists.

No keyboard shortcut is installed. A built-in command-palette entry is blocked
by Herdr's missing mod-command discovery support; see
[`docs/research/herdr-command-palette.md`](docs/research/herdr-command-palette.md).
The corner workaround applies only to this job list and its preview, not
Herdr's Settings or previews opened elsewhere.

The count and popup read Herdr's live `terminals()` and `panes()` snapshots;
there are no extra subprocesses or polling timers. Ancestry uses full terminal
addresses so local and remote terminal IDs do not collide.

## Tags

One short tag per terminal, to tell agents apart at a glance: it shows as a
chip after the row's name in the `tab-tree` sidebar (tab rows and pane rows).
It's the terminal's `tag` label in herdr-core, so it survives restarts.

- Right-click a tab or pane row > Set tag… (Change tag… once it has one)
  opens `tag-prompt`: Enter saves, an empty box removes the tag, Esc cancels.
  The sidebar's right-click menu is `tab-menu`, a copy of Herdr's `menu` mod
  (v0.1.13) with that item added: Herdr's menu has fixed items. Herdr's
  command palette lists only the app's own commands, so it can't offer it.
- From a shell or an agent: `hc label t4r tag=review-me`, `hc label t4r tag=`
  to remove it, `hc ls --label tag=review-me` to find it.
