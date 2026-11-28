# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
No versioned releases have been published yet; the initial development work is
consolidated below.

## [Unreleased]

### Added

- Resume report: every agent's own plugin writes one label, `herdr.resume`,
  with the command that continues its conversation, its folder and a proof
  file. ↻ recovery, the suspension rules and the stand-in read only that
  report and check the proof before they act; ↻ falls back to the agent's
  session picker. Pi's extension writes it in place of `herdr.pi-recovery`.
  A new Claude Code plugin, `herdr-resume`, writes Claude's from its
  `SessionStart` and `Stop` hooks through `herdr-agent-report`, so a
  `/clear` or `/resume` is reported at once and without the Herdr app open.
  The old labels are still read while a terminal has no report, for one
  release.
- The installer builds and installs `herdr-agent-report` next to the stand-in
  (rebuilt when its sources change), and installs the Claude plugin from the
  repo's marketplace when `claude` is on `PATH`; without it, it prints the
  commands to run by hand.

- Personal `tincho` layout with a grouped tab and pane sidebar, tighter terminal
  padding, and Catppuccin Latte and Frappé themes.
- Sidebar session titles, agent status indicators, and drag-and-drop ordering
  of tabs and spaces, including moving tabs between spaces on the same machine.
- Tab picker using the sidebar's groups and names.
- Persistent terminal tags, displayed as sidebar chips and editable through a
  custom context menu and tag prompt.
- Agent recovery button backed by persistent terminal labels.
- Exact Claude conversation recovery using recorded session IDs, with named-tab
  and interactive-picker fallbacks.
- Pi extension that records session identity, session-file location, working
  directory, and supported launch options, including `--no-sandbox`.
- Exact Pi recovery with bounded session-header validation and safe picker
  fallback for missing, invalid, or mismatched session files. Prompts,
  credentials, and inline system prompts are not saved for replay.
- Status-bar GitHub PR information, CI and Sonar checks, automated review
  summaries, human review status, and unresolved-thread details.
- Globally persisted PR-check toggle, disabled by default. Disabling stops new
  requests and refresh timers and prevents stale results from restoring data.
- Background-job counts scoped to hidden, live descendants of the focused
  terminal, including agents and ordinary commands.
- Jobs-only popup with live updates, keyboard navigation, and temporary terminal
  previews that preserve the standard Keep and Close controls.
- Files and Changes buttons on the right side of the status bar to open, switch,
  and hide the side panel, with active-state highlighting.
- Personal Files and Changes mods with visibility-aware refreshes, native
  filesystem watching, bounded pending watch requests, and remote/failure
  polling fallbacks.
- Conflict-aware installer for Herdr configuration and Pi extensions, with
  atomic writes, separate installation manifests, configurable destinations,
  and backups when forcing an overwrite.
- Suspension of unused agents: idle Claude and Pi agents are ended to free
  memory while their terminals keep their address, labels and links. A
  stand-in holds each suspended terminal and wakes the agent from its session
  when a message arrives, when you click its row in the sidebar, or on
  Enter; focus alone never wakes it, since Herdr moves the focus on its own.
  The messages become the first prompt. Configurable with
  `tincho.suspend` (`after_minutes`, `helpers`; `false` or `0` turns automatic
  suspension off). An agent that hc started directly gets `SIGKILL`, then its
  helper processes `SIGTERM` (Pi turns `SIGTERM` into a normal exit, which
  would end the terminal); a shell that hosts an agent (fish, bash or zsh)
  gets `SIGKILL` too, and the agent in front then gets `SIGHUP`. Claude
  counts as resumable only with its transcript on disk, Pi only with a
  session file that holds its session; otherwise the agent isn't suspended.
  A wake that finds the session gone keeps the messages in an `undelivered`
  file and reports `blocked`. On macOS, `herdr-shell` and the stand-in start your
  shell as a login shell, as hc does.
- Sidebar 💤 and "waking…" states, and **Suspend now** and **Never suspend**
  items in the tab menu, with the reason when an agent cannot be suspended.
  Stale suspension labels are removed on their own. A woken agent that never
  reports its status is reported `idle` once by a watchdog after 30 s, so hc
  and `hc wait` don't treat it as busy for good.
- Claude launch options kept through an allow-list, and replayed by recovery
  and waking.
- Installer builds the stand-in with Bun (ahead-of-time compile, else the
  standard compile, skipped without Bun), installs it with `herdr-shell`
  outside `PATH`, and sets herdr-core's `shell` key, reporting a different
  value as a conflict unless `--force` is given.
- By-hand integration script for suspension on a disposable hc core
  (`tests/suspend.integration.sh`).
- Regression coverage for recovery, panel lifecycle, status controls, background
  jobs, and installer behavior.
- Provenance documents and research notes covering command-palette limitations,
  idle work, and Herdr update compatibility.

### Changed

- Pi extension installation is conditional: an existing `~/.pi` directory or a
  nonempty explicit `PI_CODING_AGENT_DIR` is required. Otherwise the installer
  skips Pi without creating its directory or modifying its manifest, including
  with `--force`. The optional watch mode follows the same rule and detects
  changes in Pi-directory availability.
- Agent rows use session titles where available; pane rows are listed flat
  beneath their tab.
- Catppuccin Frappé's bright-black terminal color uses Overlay 2 for readability.
- Claude session probes run only for positively identified local, live Claude
  processes. Pi, Codex, shells, remote terminals, and exited terminals are skipped.
- Pi recovery metadata is captured on session events and unchanged records are
  not rewritten. Unsupported or sensitive launch arguments are omitted silently;
  actual metadata-save failures still produce a warning.
- Hidden Files and Changes panels stop background I/O follow-ups. Visible local
  panels use filesystem events plus a 60-second safety refresh; remote or
  unavailable-watch paths retain a 10-second fallback.
- Unchanged panel refreshes avoid redraw requests, and ordinary renders do not
  serialize entire file trees or diffs.
- Development instructions use one-shot `./install.sh` runs. The optional
  installer watch mode remains available; no additional watcher dependency is
  required.
- Recovery queues belong to individual sidebar instances to support Herdr
  0.1.14's shared module lifetime. Requests remain serial within each sidebar.
- Provenance and research documents use portable paths instead of personal
  home-directory or machine-specific temporary checkout paths.

### Fixed

- Recovery in a replacement sidebar could stall behind an old, cancelled
  operation whose promise never settled. Closing a sidebar now invalidates its
  queued work and follow-ups without blocking a new instance.
- Late recovery completions could continue probing or retrying after the sidebar
  closed. Close guards now prevent those follow-up commands; already-issued
  commands cannot be recalled.
- Pi recovery could select the wrong conversation through folder-based recovery
  or replay into an invalid session file. Recovery now validates the recorded
  session and sends its command only once while the terminal is at a shell.
- Claude recovery uses bounded, serial startup retries; unnamed tabs without a
  recorded session open the picker rather than using `--continue`.
- Process changes during Claude session probes are rejected before stale
  recovery metadata can be written.
- Clicking a tab's close button no longer starts a drag, and sidebar/list IDs
  preserve scrolling when the pointer leaves the sidebar.
- Background-job lists have an explicit viewport, bounded popup height, and
  selection scrolling. Stale clicks cannot preview exited or newly pane-backed
  jobs.
- Background-job popup and terminal-preview backgrounds no longer protrude past
  rounded frame corners; terminal previews use an inset.
- Repeated quiet hide/show cycles reuse pending native watch requests instead of
  accumulating new waits. Pending waits are bounded across folder changes.
- Stale panel responses cannot replace data after an observed hide, location
  change, or close. Explicit user commits may still finish while hidden.
- Panel refreshes redraw correctly when an intermediate state was rendered and
  then restored, including untracked-file counts and truncation warnings.
- Changes list sizing and scrolling incorporate Herdr 0.1.14's upstream fix:
  a flex-sized viewport and explicit scrollbar replace the old capped wrapper,
  while retaining our custom idle-work guards.

### Removed

- The mod's 10 s Claude polling: it no longer reads
  `~/.claude/sessions/<pid>.json` or writes `herdr.claude-session` and
  `herdr.claude-options`; the Claude plugin's report replaces them, and the
  reporter clears both labels.
- Tracking and installation of Herdr's machine-managed `settings.json`.
  Machine-specific settings remain outside this repository.
- Experimental sideways-swipe sidebar resizing, which interfered with list
  scrolling.
