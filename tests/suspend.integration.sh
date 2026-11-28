#!/bin/sh
# Run with: sh tests/suspend.integration.sh  (HSI_KEEP=1 keeps the scratch folder)
# By-hand integration check of agent suspension (GLOSSARY.md: Suspend, Wake,
# Stand-in). Not part of the automatic test run: it is not a tests/*.test.* file.
#
# It never touches the real hc core or a real agent. It starts a disposable
# core (its own session, socket, state folder and core config, with a freshly
# built stand-in and herdr-shell as the core's `shell`), and two fake agents:
#   - "pi", started by `hc run` (root=agent), and
#   - "claude", typed into fish in a terminal that hc started with its shell
#     (root=shell).
# The policy runs inside the Herdr mod, so this script repeats its suspension
# steps with hc commands: re-check (with a process snapshot), keep, re-check
# status and turn, set the suspension record, signal the main program
# (SIGKILL for root=agent, then SIGTERM to every process under the agent in
# the snapshot; SIGKILL to the shell for root=shell). Then it sends a message with
# plain `hc send` and checks that the message is the woken agent's first
# prompt, that the address, name, labels, parent and child terminal did not change, that
# nothing ran in a shell, that a send during the switch was refused as
# unavailable, and that the stand-in's footprint is 10 MB or less. The fake
# agents are found only through the PATH that the core gives its shells, so a
# wake also checks that PATH. 30 s after the wakes it checks that the wake
# watchdog left the woken agents' reports alone.
#
# Then two real Pi agents, started by `hc run` (root=agent) with a throwaway
# HOME and a fake MCP helper (an extension starts it). No wake and no network
# access are needed. One is suspended with SIGKILL: its terminal stays live with
# the same address, the stand-in takes over and the helper processes end. The
# other gets SIGTERM instead, as the policy did before: Pi turns it into exit
# code 0 and hc ends the terminal (the reason for SIGKILL). Everything is
# removed on exit.
#
# Needs bun (to build the stand-in), node, fish, pi and hc. A core started inside
# an agent sandbox cannot start programs: run it from a normal terminal, or
# through a throwaway terminal (hc run --rm --no-notify -- sh <this file>).
set -eu

project=$(cd "$(dirname "$0")/.." && pwd)
for tool in hc node bun fish; do
  command -v "$tool" >/dev/null 2>&1 || { echo "suspend.integration: $tool is not on PATH" >&2; exit 1; }
done
# Without a real pi, the real Pi checks are skipped (and said so); the fake
# agents still run.
has_pi=false
command -v pi >/dev/null 2>&1 && has_pi=true
HC=$(command -v hc)
NODE=$(command -v node)
FISH=$(command -v fish)
PI=$(command -v pi || true)

# Set once the disposable core answered from its socket under $work. Cleanup
# stops a core only when that same core still answers: if hc ever ignored
# these variables, it would reach the real core, which must never be stopped.
work=
core_id=
core_socket=
# The wake watchdog (suspend/watchdog.ts) runs `hc get` 30 s after a wake; 2 s
# more for it to finish. `hc get` starts a stopped core, so the core stops
# only after the last watchdog ran.
last_wake=
wait_watchdogs() {
  [ -n "$last_wake" ] || return 0
  left=$((last_wake + 32 - $(date +%s)))
  if [ "$left" -gt 0 ]; then echo "--- waiting ${left}s for the wake watchdogs"; sleep "$left"; fi
  last_wake=
}
disposable_core() {
  [ -n "$core_id" ] && [ -S "$core_socket" ] && [ "$(hc server status --json 2>/dev/null | json 't.core?.id' 2>/dev/null)" = "$core_id" ]
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if disposable_core; then
    wait_watchdogs
    for t in $(cat "$work/terminals" 2>/dev/null); do
      hc keep "$t" --off >/dev/null 2>&1 || :
      hc kill "$t" >/dev/null 2>&1 || :
    done
    sleep 0.5
    for t in $(cat "$work/terminals" 2>/dev/null); do hc rm "$t" >/dev/null 2>&1 || :; done
    hc server stop >/dev/null 2>&1 || :
  elif [ -n "$core_socket" ] && [ -S "$core_socket" ]; then
    echo "suspend.integration: a core at $core_socket could not be identified, so it was not stopped" >&2
  fi
  case $work in
    /tmp/hsi.?*|/private/tmp/hsi.?*) ;;
    *) exit "$status" ;;
  esac
  # Programs left running from the scratch folder (the stand-ins and the fake
  # agents, which run as "sh <script>") are ours. The folder goes in through
  # the environment, so awk's own command line does not match.
  ps -axo pid=,command= 2>/dev/null | W="$work/" awk '{ c = $2; if (c ~ /(^|\/)sh$/) c = $3; if (index(c, ENVIRON["W"]) == 1) print $1 }' |
    while read -r pid; do kill -KILL "$pid" 2>/dev/null || :; done
  if [ -n "${HSI_KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# A short, physical path: the core's socket lives under it (socket paths are
# limited to about 100 bytes), and hc reports physical folders (/private/tmp).
scratch=$(mktemp -d /tmp/hsi.XXXXXX) || exit 1
work=$(cd "$scratch" && pwd -P) || exit 1

# From here on every hc command reaches the disposable core only: hc finds its
# core from HC_SESSION, HC_SOCKET and the XDG folders (plans/agent-suspension.md, F4).
unset HC_TERMINAL_SOCKET HC_TERMINAL_ID HC_SOCKET HC_SCOPE
# And no Pi setting from the caller (a Pi agent's own session, for example).
for v in $(env | sed -n 's/^\(PI_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export HC_SESSION="hsi$$"
export XDG_STATE_HOME="$work/state" XDG_CONFIG_HOME="$work/config" XDG_RUNTIME_DIR="$work/run"
export XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache"
mkdir -p "$XDG_STATE_HOME" "$XDG_CONFIG_HOME/herdr-core" "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$work/home"
chmod 700 "$XDG_RUNTIME_DIR"
core_socket="$XDG_RUNTIME_DIR/herdr-core/$HC_SESSION.sock"

failures=0
ok() { echo "ok - $*"; }
not_ok() { echo "FAIL - $*"; failures=$((failures + 1)); }
die() { echo "FAIL - $*" >&2; exit 1; }
check() { # check <description> <command...>: a check that does not stop the run
  description=$1; shift
  if "$@"; then ok "$description"; else not_ok "$description"; fi
}

# json <expression> [args...]: evaluates a JS expression of t (the JSON on
# stdin) and a (the args). Strings print bare, other values as JSON.
json() {
  "$NODE" -e '
    const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const [expression, ...a] = process.argv.slice(1);
    const v = new Function("t", "a", `return (${expression});`)(t, a);
    process.stdout.write(v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  ' "$@"
}
get() { hc get "$1" --json; }
field() { get "$1" | json "$2"; }
# The address, name, parent and labels: what other agents and mods depend on.
# skip: a label left out (the suspension record while suspended).
identity() {
  get "$1" | json '({ address: t.address, name: t.name, parent: t.parent,
    labels: Object.fromEntries(Object.entries(t.labels).filter(([k]) => k !== a[0]).sort()) })' "${2:-}"
}
# wait_until <seconds> <what> <shell code>: runs the code every 0.1 s until it succeeds.
wait_until() {
  limit=$(($1 * 10)); what=$2; code=$3; n=0
  until eval "$code"; do
    n=$((n + 1)); [ "$n" -lt "$limit" ] || die "timed out waiting for $what"
    sleep 0.1
  done
}
reports() { # reports <terminal> <app> <state>
  [ "$(field "$1" '`${t.status?.app}:${t.status?.state}`')" = "$2:$3" ]
}
# descendants <ps snapshot> <pid>: every pid under pid.
descendants() {
  awk -v root="$2" '
    function walk(p,   n, i, a) { n = split(kids[p], a, " "); for (i = 1; i <= n; i++) { print a[i]; walk(a[i]) } }
    { kids[$2] = kids[$2] " " $1 }
    END { walk(root) }' "$1"
}
# not_helpers <ps snapshot> <pid> [except]: the children of pid, except one,
# whose command line does not contain "mcp" (the default helper allow-list).
# Only children, as in the policy: a process under a helper is part of it.
not_helpers() {
  awk -v p="$2" -v except="${3:-}" '$2 == p && $1 != except && index($0, "mcp") == 0' "$1"
}
alive() { for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }
footprint_kb() {
  if [ -r "/proc/$1/status" ]; then awk '/^VmRSS:/ { print $2; exit }' "/proc/$1/status"
  else footprint -f bytes --noCategories "$1" 2>/dev/null | awk '/phys_footprint:/ { print int($2 / 1024); exit }'
  fi
}

echo "scratch folder: $work (core session $HC_SESSION)"

# The stand-in and herdr-shell, installed side by side as install.sh does.
suspend_bin="$work/suspend"
mkdir -p "$suspend_bin"
sh "$project/suspend/build.sh" "$suspend_bin/herdr-standin" > "$work/build.log" 2>&1 || { cat "$work/build.log" >&2; die "stand-in build"; }
cp "$project/suspend/herdr-shell" "$suspend_bin/herdr-shell"
chmod +x "$suspend_bin/herdr-shell"
printf 'shell = ["%s"]\n' "$suspend_bin/herdr-shell" > "$XDG_CONFIG_HOME/herdr-core/config.toml"

# The fake agents. Each start records its program path, folder and words
# (NUL-separated) under runs/<address>/<n>, reports idle like a real agent
# (OSC 7501, plans/agent-suspension.md F5), and records every line it reads.
bin="$work/bin"
runs="$work/runs"
mkdir -p "$bin" "$runs"
cat > "$bin/pi" <<EOF
#!/bin/sh
dir="$runs/\${HC_TERMINAL_ID:-unknown}"
mkdir -p "\$dir"
n=1; while [ -e "\$dir/\$n" ]; do n=\$((n + 1)); done
run="\$dir/\$n"; mkdir "\$run"
printf '%s' "\$0" > "\$run/exe"
pwd -P > "\$run/cwd"
printf '%s\0' "\$@" > "\$run/argv"
: > "\$run/stdin"
printf '\033]7501;state=idle:app=%s\033\\\\' "\${0##*/}"
printf 'fake %s, start %s\n' "\${0##*/}" "\$n"
while IFS= read -r line; do printf '%s\n' "\$line" >> "\$run/stdin"; done
EOF
cp "$bin/pi" "$bin/claude"
# A fake MCP server for the real Pi agents: a helper (its command line
# contains "mcp") with a child of its own, like npm exec and its node.
cat > "$bin/hsi-mcp-helper" <<'EOF'
#!/bin/sh
if [ "${1:-}" = child ]; then while :; do sleep 1; done; fi
sh "$0" child &
wait
EOF
chmod +x "$bin/pi" "$bin/claude" "$bin/hsi-mcp-helper"
ln -s "$HC" "$bin/hc"
# Only the fake agents, hc and the system folders: a real pi or claude cannot
# be found, by hc run, by the core's shells or by a wake.
# A disposable HOME too, so nothing falls back to the real ~/.local/state,
# ~/.claude or ~/.pi.
export PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SHELL="$FISH" HOME="$work/home"
# The real Pi agents load this extension from the disposable HOME. It starts
# the fake MCP server as Pi's child.
mkdir -p "$HOME/.pi/agent/extensions"
cat > "$HOME/.pi/agent/extensions/hsi-mcp.js" <<EOF
import { spawn } from "node:child_process";
export default function () {
  spawn("$bin/hsi-mcp-helper", [], { stdio: "ignore" });
}
EOF

hc server start >/dev/null || die "the disposable core did not start"
[ -S "$core_socket" ] || die "the disposable core has no socket at $core_socket"
core_id=$(hc server status --json | json 't.core?.id')
[ -n "$core_id" ] || die "the disposable core does not answer"
ok "disposable core started (id ${core_id%"${core_id#????????}"})"

# start <hc run words...>: starts a terminal and prints its address.
start() {
  started=$(hc run --bg "$@" 2>&1) || die "hc run $*: $started"
  address=$(printf '%s' "$started" | json 't.address' 2>/dev/null) || address=
  [ -n "$address" ] || die "hc run $*: $started"
  echo "$address" >> "$work/terminals"
  echo "$address"
}

parent=$(start --name hsi-parent --no-parent -- sleep 3600)

# The hc run agent: Pi with its recovery record and a real-looking session.
wd_run="$work/wd-run"
mkdir -p "$wd_run" "$work/sessions"
pi_session=019a8c3e-5b7d-7f21-9e44-2c1d0a6b8f13
pi_file="$work/sessions/2026-11-16T05-00-00-000Z_$pi_session.jsonl"
printf '{"type":"session","version":3,"id":"%s","timestamp":"2026-11-16T05:00:00.000Z","cwd":"%s"}\n' "$pi_session" "$wd_run" > "$pi_file"
printf '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-16T05:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Reply pong"}]}}\n' >> "$pi_file"
pi_recovery=$(printf '{"version":1,"sessionId":"%s","sessionFile":"%s","cwd":"%s","args":["--model","fake-model"]}' "$pi_session" "$pi_file" "$wd_run")
run_agent=$(start --name hsi-run --parent "$parent" --cwd "$wd_run" \
  --label herdr.last-agent=pi --label "herdr.pi-recovery=$pi_recovery" -- pi --model fake-model)
wait_until 10 "the hc run agent to report idle" 'reports "$run_agent" pi idle'

# The fish-hosted agent: Claude with the resume report its plugin writes
# (herdr.resume), typed into the shell that hc started (herdr-shell, no
# label, so fish). The hc run Pi above keeps the old herdr.pi-recovery label,
# so the wakes cover both the report and the legacy adapter.
wd_fish="$work/wd-fish"
mkdir -p "$wd_fish"
claude_session=4f0c2a9e-7d1b-4c8e-a3f5-6b2e9d0c1a7f
# Its transcript: the stand-in wakes Claude only when it exists.
mkdir -p "$HOME/.claude/projects/-hsi-wd-fish"
claude_proof="$HOME/.claude/projects/-hsi-wd-fish/$claude_session.jsonl"
printf '{"type":"user","sessionId":"%s"}\n' "$claude_session" > "$claude_proof"
claude_report=$(printf '{"version":1,"agent":"claude","session":"%s","argv":["claude","--model","haiku","--resume","%s"],"cwd":"%s","proof":"%s","pid":1,"at":1}' \
  "$claude_session" "$claude_session" "$wd_fish" "$claude_proof")
fish_agent=$(start --name hsi-fish --parent "$parent" --cwd "$wd_fish" \
  --label herdr.last-agent=claude --label "herdr.resume=$claude_report")
wait_until 10 "fish in the shell terminal" '[ "$(field "$fish_agent" "t.foreground?.name")" = fish ]'
check "herdr-shell started \$SHELL in a terminal without the label" [ "$(field "$fish_agent" 't.argv?.[0]')" = "$suspend_bin/herdr-shell" ]
# The full path, so even a fish that rebuilt its PATH cannot start a real claude.
hc send "$fish_agent" "$bin/claude --model haiku" >/dev/null || die "typing the fake claude into fish"
wait_until 15 "the fish-hosted agent to report idle" 'reports "$fish_agent" claude idle'

# record <agent> <root>: the suspension record for the terminal JSON on stdin.
record() {
  json 'JSON.stringify({ version: 1, agent: a[0], root: a[1], cwd: t.foreground.cwd, since: Date.now() })' "$1" "$2"
}

# suspend <terminal> <agent> <expected root>: the policy's steps, in order.
# Sets standin_pid and under_agent (every process under a root=agent agent).
suspend() {
  t=$1; agent=$2; expected_root=$3
  # 1. Read the terminal again: a live, idle, resumable agent, with only
  #    helper processes, from one process snapshot.
  before=$(get "$t")
  [ "$(printf '%s' "$before" | json '`${t.state}:${t.status?.state}`')" = live:idle ] || die "$t is not a live idle agent"
  pid=$(printf '%s' "$before" | json 't.pid')
  agent_pid=$(printf '%s' "$before" | json 't.foreground?.pid')
  found_root=$(printf '%s' "$before" | json 't.pid === t.foreground?.pid ? "agent" : "shell"')
  check "$t: the main program is the $expected_root (root=$found_root)" [ "$found_root" = "$expected_root" ]
  ps -axo pid=,ppid=,command= > "$work/ps-$t"
  [ -z "$(not_helpers "$work/ps-$t" "$agent_pid")" ] || die "$t: the agent runs processes that are not helpers"
  if [ "$found_root" = shell ]; then
    [ -z "$(not_helpers "$work/ps-$t" "$pid" "$agent_pid")" ] || die "$t: the hosting shell runs other jobs"
    under_agent=
  else
    under_agent=$(descendants "$work/ps-$t" "$pid")
  fi
  # 2. Keep the terminal, so the signal leaves it live.
  hc keep "$t" >/dev/null || die "hc keep $t"
  # 3. Status and turn did not change.
  after=$(get "$t")
  watched='`${t.status?.state}:${t.turn}:${t.pid}:${t.foreground?.pid}`'
  [ "$(printf '%s' "$before" | json "$watched")" = "$(printf '%s' "$after" | json "$watched")" ] || die "$t changed during the steps"
  # 4. The suspension record.
  hc label "$t" "herdr.suspended=$(printf '%s' "$before" | record "$agent" "$found_root")" >/dev/null || die "hc label $t"
  # 5. End the main program. hc starts herdr-shell, which starts the stand-in.
  #    root=agent: SIGKILL, which no agent can turn into an exit code, then
  #    SIGTERM to the processes under it. root=shell: SIGKILL to the shell
  #    (interactive bash and zsh ignore SIGTERM); the agent in front gets SIGHUP.
  if [ "$found_root" = agent ]; then
    kill -KILL "$pid"
    # shellcheck disable=SC2086
    [ -z "$under_agent" ] || kill -TERM $under_agent 2>/dev/null || :
  else
    kill -KILL "$pid"
  fi
  # While hc switches programs it shows no pid, and a plain send is refused.
  wait_until 5 "hc to see $t's program end" '[ "$(field "$t" "t.pid ?? 0")" != "$pid" ]'
  if [ -z "$(field "$t" t.pid)" ]; then
    probe_rc=0
    probe=$(hc send "$t" "switch probe; touch $work/ran-probe-$t" --json 2>&1) || probe_rc=$?
    probe_kind=$(printf '%s' "$probe" | json 't.error?.kind' 2>/dev/null || :)
    check "$t: a send during the switch is refused as unavailable (exit $probe_rc, $probe_kind)" \
      [ "$probe_rc:$probe_kind" = 5:unavailable ]
  else
    not_ok "$t: the switch ended before a send could be tried"
  fi
  wait_until 10 "$t's stand-in to report idle" 'reports "$t" herdr-standin idle'
  standin_pid=$(field "$t" 't.pid')
  check "$t: the terminal is still live, at the same address" [ "$(field "$t" '`${t.state}:${t.address}`')" = "live:$t" ]
  # From ps: hc can show the program that herdr-shell replaced for a while.
  # hc starts login shells on macOS, so herdr-shell passes -l on there.
  main=$(ps -o command= -p "$standin_pid" 2>/dev/null || :)
  expected_main="$suspend_bin/herdr-standin $agent $t $(field "$t" t.name)"
  [ "$(uname -s)" != Darwin ] || expected_main="$expected_main -l"
  check "$t: the stand-in is the main program ($main)" [ "$main" = "$expected_main" ]
  check "$t: the agent process ended" sh -c "[ -n '$agent_pid' ] && ! kill -0 '$agent_pid' 2>/dev/null"
  if [ -n "$under_agent" ]; then
    n=0
    # shellcheck disable=SC2086
    while alive $under_agent && [ "$n" -lt 50 ]; do n=$((n + 1)); sleep 0.1; done
    # shellcheck disable=SC2086
    check "$t: the processes under the agent ended ($(echo $under_agent))" eval '! alive $under_agent'
  fi
  kb=$(footprint_kb "$standin_pid")
  check "$t: the stand-in's footprint is 10 MB or less (${kb:-unknown} KB)" sh -c "[ -n '$kb' ] && [ '$kb' -le 10240 ]"
}

# wake <terminal> <agent> <message>: a plain send, then waits for the agent's second start.
wake() {
  t=$1; agent=$2
  hc send "$t" "$3" >/dev/null || die "hc send $t"
  last_wake=$(date +%s)
  wait_until 15 "$t's agent to start again" '[ -e "$runs/$t/2/argv" ]'
  wait_until 10 "$t's woken agent to report idle" 'reports "$t" "$agent" idle'
}

# words <file> <expected words...>: the NUL-separated words of a start.
words() {
  file=$1; shift
  printf '%s\0' "$@" > "$file.expected"
  cmp -s "$file" "$file.expected"
}
show_words() { tr '\0' ' ' < "$1"; }

for case in "$run_agent pi agent" "$fish_agent claude shell"; do
  set -- $case
  t=$1; agent=$2; root=$3
  echo "--- $t: $agent, root=$root"
  # A child terminal, which must survive its parent's suspension and wake.
  child=$(start --name "hsi-child-$agent" --parent "$t" -- sleep 3600)
  identity_before=$(identity "$t")
  recorded_cwd=$(field "$t" 't.foreground.cwd')
  suspend "$t" "$agent" "$root"
  check "$t: address, name, labels and parent unchanged while suspended" [ "$(identity "$t" herdr.suspended)" = "$identity_before" ]

  message="first prompt for $agent; touch $work/ran-$t \$(touch $work/ran-sub-$t)"
  wake "$t" "$agent" "$message"
  run="$runs/$t/2"
  if [ "$agent" = pi ]; then
    check "$t: woken with its session, options and the message as first prompt ($(show_words "$run/argv"))" \
      words "$run/argv" --session "$pi_file" --model fake-model -- "$message"
  else
    check "$t: woken with its options, session and the message as first prompt ($(show_words "$run/argv"))" \
      words "$run/argv" --model haiku --resume "$claude_session" -- "$message"
  fi
  check "$t: the wake found the fake $agent through the core's PATH ($(cat "$run/exe"))" [ "$(cat "$run/exe")" = "$bin/$agent" ]
  check "$t: the woken agent runs in the recorded folder" [ "$(cat "$run/cwd")" = "$recorded_cwd" ]
  check "$t: woken in place (same main program pid as the stand-in)" [ "$(field "$t" 't.pid')" = "$standin_pid" ]
  if [ "$root" = shell ]; then
    # The wrapper uses job control, so hc names the agent in front, not the
    # wrapper: the policy sees root=shell again and can suspend it again.
    # hc samples the program in front every 500 ms: give it a few samples.
    n=0
    while [ "$(field "$t" 't.foreground?.pid ?? 0')" = "$standin_pid" ] && [ "$n" -lt 30 ]; do n=$((n + 1)); sleep 0.1; done
    check "$t: hc names the woken agent in front, not the shell wrapper" \
      [ "$(field "$t" 't.foreground?.pid ?? 0')" != "$standin_pid" ]
  fi
  check "$t: address, name, labels and parent unchanged after the wake" [ "$(identity "$t")" = "$identity_before" ]
  check "$t: its child terminal is still live and still its child" [ "$(field "$child" '`${t.state}:${t.parent}`')" = "live:$t" ]
  check "$t: the message was not typed into the woken agent again" [ ! -s "$run/stdin" ]
  check "$t: one start before the suspension and one wake" [ ! -e "$runs/$t/3" ]
  check "$t: no received text ran as a shell command" \
    sh -c "! ls '$work'/ran-* >/dev/null 2>&1"
done

# The real Pi agents (root=agent), with a throwaway session in the disposable
# HOME. Their own PATH adds node's folder, which Pi's launcher needs.
wd_pi="$work/wd-pi"
mkdir -p "$wd_pi"
real_pi() { # real_pi <name>: starts a real Pi and waits for its idle report and its helper.
  t=$(start --name "$1" --parent "$parent" --cwd "$wd_pi" --label herdr.last-agent=pi -- \
    env PATH="$(dirname "$NODE"):$PATH" "$PI")
  wait_until 60 "the real Pi in $t to report idle" 'reports "$t" pi idle'
  wait_until 30 "the real Pi in $t to start its helper" \
    'ps -axo ppid=,command= | awk -v p="$(field "$t" t.pid)" '\''$1 == p && /hsi-mcp-helper/ { f = 1 } END { exit !f }'\'''
  echo "$t"
}

if $has_pi; then
echo "--- real pi, root=agent: SIGKILL"
pi_kill=$(real_pi hsi-pi-kill)
identity_before=$(identity "$pi_kill")
suspend "$pi_kill" pi agent
check "$pi_kill: the snapshot found the helper processes under the real Pi" [ -n "$under_agent" ]
check "$pi_kill: address, name, labels and parent unchanged while suspended" [ "$(identity "$pi_kill" herdr.suspended)" = "$identity_before" ]
sleep 2
check "$pi_kill: the stand-in still holds the live terminal 2 s later" \
  [ "$(field "$pi_kill" '`${t.state}:${t.pid}:${t.status?.app}`')" = "live:$standin_pid:herdr-standin" ]

echo "--- real pi, root=agent: SIGTERM (what the policy sent before ticket 15)"
pi_term=$(real_pi hsi-pi-term)
term_pid=$(field "$pi_term" t.pid)
check "$pi_term: the real Pi is the main program (root=agent)" [ "$(field "$pi_term" 't.pid === t.foreground?.pid')" = true ]
hc keep "$pi_term" >/dev/null || die "hc keep $pi_term"
hc label "$pi_term" "herdr.suspended=$(get "$pi_term" | record pi agent)" >/dev/null || die "hc label $pi_term"
kill -TERM "$term_pid"
wait_until 15 "$pi_term to end or start a new program" \
  '[ "$(field "$pi_term" "t.state")" != live ] || { p=$(field "$pi_term" "t.pid"); [ -n "$p" ] && [ "$p" != "$term_pid" ]; }'
term_end=$(field "$pi_term" '`${t.state}, exit_code ${t.exit_code}, signal ${t.signal}`')
check "$pi_term: SIGTERM to a real Pi as root=agent ends the kept terminal ($term_end)" \
  [ "$term_end" = "finished, exit_code 0, signal null" ]
else
echo "--- real pi: SKIPPED (pi is not on PATH)"
fi

# The woken agents reported, so the wake watchdogs must leave their reports alone.
wait_watchdogs
check "$run_agent: the wake watchdog left the woken agent's report alone" reports "$run_agent" pi idle
check "$fish_agent: the wake watchdog left the woken agent's report alone" reports "$fish_agent" claude idle
check "no received text ran as a shell command, in any case" sh -c "! ls '$work'/ran-* >/dev/null 2>&1"

echo "---"
if [ "$failures" -eq 0 ]; then echo "all checks passed"; else echo "$failures check(s) failed"; exit 1; fi
