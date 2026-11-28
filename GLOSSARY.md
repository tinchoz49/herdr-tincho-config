# herdr-tincho-config

Personal Herdr app setup: layouts, mods, themes and Pi recovery. This glossary
names the concepts the mods work with.

## Agents and terminals

**Terminal**:
A persistent hc terminal with a stable address (`t7` or a name), labels, and parent/child links. It outlives the program running in it when kept.
_Avoid_: Pane, tab (those are window concepts that show a terminal)

**Main program**:
The program hc started in a terminal: either an agent itself, or a shell hosting one. A normal exit of the main program ends the terminal; a loss by signal in a kept terminal does not.
_Avoid_: Root process, root program

**Hosting shell**:
A shell that is a terminal's main program and runs an agent in front of it.

**Agent**:
A coding-agent program (Claude, Pi) running in a terminal and reporting its status to Herdr.

**Resumable agent**:
An agent whose terminal records which agent ran and the session to resume, so a recipe can start it again with its conversation.

## Suspension

**Suspend**:
To end an unused agent's process to free memory while its terminal stays live and its conversation stays resumable.
_Avoid_: Freeze, pause, discard, sleep, hibernate

**Suspended agent**:
A resumable agent whose process was ended by suspension; its terminal keeps its address, labels and links, so messages can still reach it.

**Wake**:
To start a suspended agent again from its session, because a message arrived, you clicked its row in the sidebar, or you pressed Enter in its stand-in. Focus alone never wakes it.
_Avoid_: Resume, recover, restore

**Recovery**:
Bringing back an agent whose process was lost to a crash, `hc server stop` or a reboot, from the ↻ button on its tab.
_Avoid_: Resume (the agent CLI flag, not our concept), wake, restore

**Launch options**:
The reusable command-line options an agent was started with (model, sandbox, tools), kept so recovery and waking start it the same way. Prompts, credentials and session selectors are never part of them.
_Avoid_: Args, flags, argv

**Unused agent**:
A resumable agent that is idle past the configured threshold, not focused in any window, not running its own background processes, not blocked, and not pinned.

**Stand-in**:
The tiny program that holds a suspended agent's terminal, receives the messages sent to it, and wakes the agent with them.
_Avoid_: Placeholder, stub, sleeper, proxy

**Pinned agent**:
An agent marked "Never suspend".
_Avoid_: Protected, locked
