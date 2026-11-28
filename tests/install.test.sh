#!/bin/sh
# Run with: sh tests/install.test.sh. All installs use disposable fixtures.
set -eu

project=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/herdr-install-test.XXXXXX")
# macOS's TMPDIR ends in a slash. pwd drops the doubled one, as the installer's
# own paths do, so the expected paths match what it writes.
scratch=$(cd "$scratch" && pwd)
watch_pid=
cleanup() {
  if [ -n "$watch_pid" ]; then
    kill "$watch_pid" 2>/dev/null || :
    wait "$watch_pid" 2>/dev/null || :
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_file() { [ -f "$1" ] || fail "missing $1"; }
assert_absent() { [ ! -e "$1" ] || fail "unexpected $1"; }
assert_same() { cmp -s "$1" "$2" || fail "$1 differs from $2"; }
assert_log() { grep -F -e "$1" "$log" >/dev/null || fail "missing log: $1"; }
# The caller's PATH without folders that hold a bun or a claude, so a real
# Bun never builds anything here and the real Claude config is never touched.
# Tests that need them put a fake one first.
nobun_path=$(printf '%s\n' "$PATH" | tr ':' '\n' | while IFS= read -r dir; do
  if [ -n "$dir" ] && [ ! -x "$dir/bun" ] && [ ! -x "$dir/claude" ]; then printf '%s:' "$dir"; fi
done)
nobun_path=${nobun_path%:}
hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
fixture() {
  case_dir="$scratch/$1"
  repo="$case_dir/repo with spaces"
  home="$case_dir/home"
  state="$case_dir/state"
  config=
  app_override=
  pi_override=
  data_override=
  run_path=$nobun_path
  app="$home/.config/herdr-app"
  bin="$home/.local/share/herdr-tincho-config/bin"
  core="$home/.config/herdr-core/config.toml"
  pi="$home/.pi/agent"
  record="$state/herdr-tincho-config"
  log="$case_dir/output"
  mkdir -p "$repo/herdr/mods/example" "$repo/pi/extensions/herdr-recovery" "$home/.pi"
  cp "$project/install.sh" "$repo/install.sh"
  printf 'herdr-v1\n' > "$repo/herdr/mods/example/main.js"
  # Own fixture files: never depend on concurrently created extension code.
  printf 'pi-v1\n' > "$repo/pi/extensions/herdr-recovery/index.ts"
  printf 'export {};\n' > "$repo/pi/extensions/herdr-recovery/types.d.ts"
  printf 'pi spaced\n' > "$repo/pi/extensions/herdr-recovery/with spaces.ts"
  printf 'herdr shared\n' > "$repo/herdr/shared.txt"
  printf 'pi shared\n' > "$repo/pi/shared.txt"
  printf 'ignored.txt\n' > "$repo/.gitignore"
  git -C "$repo" init -q
  git -C "$repo" add .
  printf 'ignored\n' > "$repo/pi/ignored.txt"
  printf 'new\n' > "$repo/pi/extensions/herdr-recovery/new.ts"
}
run() {
  # Do not inherit any real install roots, git overrides, or shell startup files.
  env -i PATH="$run_path" HOME="$home" XDG_CONFIG_HOME="$config" \
    XDG_STATE_HOME="$state" XDG_DATA_HOME="$data_override" HERDR_APP_HOME="$app_override" \
    PI_CODING_AGENT_DIR="$pi_override" sh "$repo/install.sh" "$@"
}
# Stand-in and reporter sources in the fixture repo: the real build script
# and launcher, and small stand-ins for the TypeScript sources and the shared
# modules. claude-options.js is imported only through resume-report.js.
suspend_sources() {
  mkdir -p "$repo/suspend" "$repo/herdr/mods/tab-tree"
  cp "$project/suspend/build.sh" "$project/suspend/herdr-shell" "$repo/suspend/"
  printf 'import "./standin";\n' > "$repo/suspend/main.ts"
  printf 'import { recipe } from "../herdr/mods/tab-tree/recipes.js";\nexport const standin = 1;\n' > "$repo/suspend/standin.ts"
  printf 'export const recipe = 1;\n' > "$repo/herdr/mods/tab-tree/recipes.js"
  printf 'import "./report";\n' > "$repo/suspend/report-main.ts"
  printf 'import { parseReport } from "../herdr/mods/tab-tree/resume-report.js";\n' > "$repo/suspend/report.ts"
  printf 'import { claudeOptionsRecord } from "./claude-options.js";\nexport const parseReport = 1;\n' > "$repo/herdr/mods/tab-tree/resume-report.js"
  printf 'export const claudeOptionsRecord = 1;\n' > "$repo/herdr/mods/tab-tree/claude-options.js"
}
# A fake bun first on PATH. $1: aot (has `bun compile`), standard (only
# `bun build --compile`) or broken (every build fails). Each build writes a
# different file, like a build that is not reproducible, and is logged in
# $builds, one line per build.
fake_bun() {
  builds="$case_dir/bun-builds"
  mkdir -p "$case_dir/fake-bin"
  : > "$builds"
  cat > "$case_dir/fake-bin/bun" <<EOF
#!/bin/sh
mode=$1
if [ "\$*" = 'compile --help' ]; then [ \$mode = aot ]; exit; fi
[ "\$1" = compile ] && [ \$mode != aot ] && exit 1
printf '%s\n' "\$*" >> '$builds'
[ \$mode = broken ] && { echo 'error: fake build failure' >&2; exit 1; }
out=
while [ \$# -gt 0 ]; do [ "\$1" = --outfile ] && out=\$2; shift; done
printf 'built by fake bun, process %s\n' \$\$ > "\$out"
EOF
  chmod +x "$case_dir/fake-bin/bun"
  run_path="$case_dir/fake-bin:$nobun_path"
}
# Builds of the stand-in (one per pass that builds); report_count: of the reporter.
build_count() { grep -c '/suspend/main\.ts$' "$builds" || :; }
report_count() { grep -c '/suspend/report-main\.ts$' "$builds" || :; }
# A fake claude first on PATH: it logs each call's arguments in $claude_calls,
# and fails `plugin install` when $1 is broken.
fake_claude() {
  claude_calls="$case_dir/claude-calls"
  mkdir -p "$case_dir/fake-claude"
  : > "$claude_calls"
  cat > "$case_dir/fake-claude/claude" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> '$claude_calls'
[ '${1:-ok}' = broken ] && [ "\$2" = install ] && { echo 'error: fake install failure' >&2; exit 1; }
exit 0
EOF
  chmod +x "$case_dir/fake-claude/claude"
  run_path="$case_dir/fake-claude:$run_path"
}
claude_count() { wc -l < "$claude_calls" | tr -d ' '; }

fixture no-pi
rmdir "$home/.pi"
run > "$log"
assert_file "$app/mods/example/main.js"
assert_log 'pi: skipped'
assert_absent "$home/.pi"
assert_absent "$record/installed-pi"
assert_absent "$record/installed-pi.files"
assert_absent "$record/installed-pi.next"
# Skipping must preserve a manifest from a previously removed Pi setup.
printf 'previous Pi state\n' > "$record/installed-pi"
cp "$record/installed-pi" "$case_dir/pi-record"
run --force > "$log"
assert_log 'pi: skipped'
assert_absent "$home/.pi"
assert_same "$case_dir/pi-record" "$record/installed-pi"
# An unrelated file named .pi is not an existing Pi directory.
printf 'not a directory\n' > "$home/.pi"
run > "$log"
assert_log 'pi: skipped'
[ -f "$home/.pi" ] || fail 'changed non-directory .pi'
assert_same "$case_dir/pi-record" "$record/installed-pi"
echo 'ok - absent Pi is skipped without creating directories or modifying Pi state'

fixture defaults
run --help > "$log"
assert_log 'PI_CODING_AGENT_DIR'
if grep -F 'set -eu' "$log" >/dev/null; then fail 'help includes shell code'; fi
assert_absent "$app"
assert_absent "$pi"
run > "$log"
assert_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
assert_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
assert_file "$pi/extensions/herdr-recovery/types.d.ts"
assert_file "$pi/extensions/herdr-recovery/with spaces.ts"
assert_file "$pi/extensions/herdr-recovery/new.ts"
assert_absent "$pi/ignored.txt"
assert_same "$repo/herdr/shared.txt" "$app/shared.txt"
assert_same "$repo/pi/shared.txt" "$pi/shared.txt"
cp "$record/installed" "$case_dir/herdr-record"
cp "$record/installed-pi" "$case_dir/pi-record"
run > "$log"
assert_log 'herdr: 0 installed, 0 skipped'
assert_log 'pi: 0 installed, 0 skipped'
assert_same "$case_dir/herdr-record" "$record/installed"
assert_same "$case_dir/pi-record" "$record/installed-pi"
echo 'ok - default roots, independent keys, untracked files, idempotence'

fixture overrides
rmdir "$home/.pi" # A nonempty explicit override opts in without a default Pi home.
config="$case_dir/xdg config"
app="$config/herdr-app"
pi_override="$case_dir/custom pi"
pi=$pi_override
run > "$log"
assert_file "$app/mods/example/main.js"
assert_file "$pi/extensions/herdr-recovery/index.ts"
assert_absent "$home/.config/herdr-app"
assert_absent "$home/.pi/agent"
app_override="$case_dir/custom herdr"
app=$app_override
run > "$log"
assert_file "$app/mods/example/main.js"
assert_log 'pi: 0 installed, 0 skipped'
echo 'ok - XDG, Herdr and Pi destination overrides'

fixture conflicts
run > "$log"
printf 'local herdr\n' > "$app/mods/example/main.js"
printf 'local pi\n' > "$pi/extensions/herdr-recovery/index.ts"
cp "$app/mods/example/main.js" "$case_dir/local-herdr"
cp "$pi/extensions/herdr-recovery/index.ts" "$case_dir/local-pi"
cp "$record/installed" "$case_dir/herdr-record"
cp "$record/installed-pi" "$case_dir/pi-record"
run > "$log"
assert_log 'herdr: 0 installed, 1 skipped'
assert_log 'pi: 0 installed, 1 skipped'
assert_same "$case_dir/local-herdr" "$app/mods/example/main.js"
assert_same "$case_dir/local-pi" "$pi/extensions/herdr-recovery/index.ts"
assert_same "$case_dir/herdr-record" "$record/installed"
assert_same "$case_dir/pi-record" "$record/installed-pi"
run --force > "$log"
assert_same "$case_dir/local-herdr" "$app/mods/example/main.js.orig"
assert_same "$case_dir/local-pi" "$pi/extensions/herdr-recovery/index.ts.orig"
assert_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
assert_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
echo 'ok - local conflicts and force backups in both roots'

fixture preexisting
mkdir -p "$app/mods/example" "$pi/extensions/herdr-recovery"
printf 'unmanaged herdr\n' > "$app/mods/example/main.js"
printf 'unmanaged pi\n' > "$pi/extensions/herdr-recovery/index.ts"
run > "$log"
assert_log 'herdr: 1 installed, 1 skipped'
assert_log 'pi: 4 installed, 1 skipped'
if grep 'mods/example/main.js' "$record/installed" >/dev/null; then fail 'claimed unmanaged Herdr file'; fi
if grep 'extensions/herdr-recovery/index.ts' "$record/installed-pi" >/dev/null; then fail 'claimed unmanaged Pi file'; fi
echo 'ok - unmanaged destination files are not claimed'

fixture stale
run > "$log"
rm "$repo/herdr/mods/example/main.js"
rm -rf "$repo/pi"
run > "$log"
assert_log 'stale      mods/example/main.js:'
assert_log 'stale      extensions/herdr-recovery/index.ts:'
assert_file "$app/mods/example/main.js"
assert_file "$pi/extensions/herdr-recovery/index.ts"
run > "$log"
assert_log 'stale      mods/example/main.js:'
assert_log 'stale      extensions/herdr-recovery/index.ts:'
rm "$app/mods/example/main.js" "$pi/extensions/herdr-recovery/index.ts"
run > "$log"
if grep 'mods/example/main.js' "$record/installed" >/dev/null; then fail 'retained removed stale Herdr file'; fi
if grep 'extensions/herdr-recovery/index.ts' "$record/installed-pi" >/dev/null; then fail 'retained removed stale Pi file'; fi
echo 'ok - stale files persist and are reported until manually removed'

fixture legacy
mkdir -p "$record" "$app/mods/example"
printf 'legacy installed content\n' > "$app/mods/example/main.js"
printf 'legacy stale\n' > "$app/old.txt"
printf '%s mods/example/main.js\n' "$(hash "$app/mods/example/main.js")" > "$record/installed"
printf '%s old.txt\n' "$(hash "$app/old.txt")" >> "$record/installed"
run > "$log"
assert_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
assert_log 'stale      old.txt:'
grep -F "$(hash "$repo/herdr/mods/example/main.js") mods/example/main.js" "$record/installed" >/dev/null || fail 'legacy key changed'
assert_file "$pi/extensions/herdr-recovery/index.ts"
echo 'ok - old unprefixed Herdr manifests update without migration or conflicts'

fixture archive
rm -rf "$repo/.git" "$repo/pi/ignored.txt"
printf 'generated\n' > "$repo/herdr/mods/example/gpui-kit.d.ts"
printf '{}\n' > "$repo/herdr/mods/example/jsconfig.json"
run > "$log"
assert_absent "$app/mods/example/gpui-kit.d.ts"
assert_absent "$app/mods/example/jsconfig.json"
assert_file "$pi/extensions/herdr-recovery/types.d.ts"
rm -rf "$repo/pi"
run > "$log"
assert_log 'stale      extensions/herdr-recovery/index.ts:'
echo 'ok - non-git checkout, existing Herdr exclusions, missing Pi source'

fixture atomic
mkdir -p "$case_dir/bin"
real_cp=$(command -v cp)
# Reject all content copies except staging writes. mv must publish them.
printf '#!/bin/sh\ncase "$2" in *.install-tmp) ;; *) exit 91 ;; esac\nexec "%s" "$@"\n' "$real_cp" > "$case_dir/bin/cp"
chmod +x "$case_dir/bin/cp"
run_path="$case_dir/bin:$PATH"
run > "$log"
printf 'herdr-v2\n' > "$repo/herdr/mods/example/main.js"
printf 'pi-v2\n' > "$repo/pi/extensions/herdr-recovery/index.ts"
run > "$log"
assert_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
assert_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
[ -z "$(find "$app" "$pi" -name '*.install-tmp' -print)" ] || fail 'staging files remain'
echo 'ok - first installs and managed updates use staging writes'

fixture standin-aot
suspend_sources
fake_bun aot
run > "$log"
[ "$(build_count)" = 1 ] || fail "expected one build, got $(build_count)"
grep -F 'compile --trim-locales en --no-compile-function-source --outfile' "$builds" >/dev/null ||
  fail "not the ahead-of-time compile: $(cat "$builds")"
grep -F 'built by fake bun' "$bin/herdr-standin" >/dev/null || fail 'stand-in not installed'
[ -x "$bin/herdr-standin" ] || fail 'stand-in not executable'
[ "$(report_count)" = 1 ] || fail "expected one reporter build, got $(report_count)"
grep -F 'built by fake bun' "$bin/herdr-agent-report" >/dev/null || fail 'reporter not installed'
[ -x "$bin/herdr-agent-report" ] || fail 'reporter not executable'
assert_log 'built      herdr-standin and herdr-agent-report (ahead-of-time compile)'
assert_same "$repo/suspend/herdr-shell" "$bin/herdr-shell"
[ -x "$bin/herdr-shell" ] || fail 'herdr-shell not executable'
[ -z "$(find "$bin" -name '*.install-tmp' -print)" ] || fail 'staging files remain'
assert_file "$app/mods/example/main.js"
# Nothing is added to PATH: no shell startup file is written.
[ -z "$(cd "$home" && find . -name '.*rc' -o -name '.*profile' -o -name config.fish)" ] ||
  fail 'a shell startup file was written'
if grep -F 'PATH' "$log" >/dev/null; then fail 'install talks about PATH'; fi
echo 'ok - the ahead-of-time compile installs the stand-in, the reporter and herdr-shell outside PATH'

fixture standin-standard
suspend_sources
fake_bun standard
data_override="$case_dir/xdg data"
bin="$data_override/herdr-tincho-config/bin"
run > "$log"
[ "$(build_count)" = 1 ] || fail "expected one build, got $(build_count)"
grep -F 'build --compile --minify --outfile' "$builds" >/dev/null ||
  fail "not the standard compile: $(cat "$builds")"
assert_log 'standard compile'
[ -x "$bin/herdr-standin" ] || fail 'stand-in not installed in XDG_DATA_HOME'
[ -x "$bin/herdr-shell" ] || fail 'herdr-shell not installed in XDG_DATA_HOME'
assert_absent "$home/.local/share"
echo 'ok - without bun compile, the standard compile is used; XDG_DATA_HOME is honored'

fixture standin-no-bun
suspend_sources
run > "$log"
assert_log 'suspend: skipped (no bun)'
assert_file "$app/mods/example/main.js"
assert_file "$pi/extensions/herdr-recovery/index.ts"
assert_absent "$home/.local/share"
assert_absent "$record/installed-suspend"
echo 'ok - without bun the stand-in is skipped and the rest installs'

fixture standin-rebuild
suspend_sources
fake_bun aot
run > "$log"
cp "$record/installed-suspend" "$case_dir/suspend-record"
cp "$bin/herdr-standin" "$case_dir/first-build"
# Keyed by the source hash: never by the hash of the (unreproducible) binary.
entry=$(awk '$2 == "herdr-standin" { print $1 }' "$record/installed-suspend")
[ -n "$entry" ] || fail 'no manifest entry for herdr-standin'
[ "$entry" != "$(hash "$bin/herdr-standin")" ] || fail 'herdr-standin keyed by its output'
grep -F "$entry herdr-agent-report" "$record/installed-suspend" >/dev/null ||
  fail 'herdr-agent-report not recorded by the same source hash'
grep -F "$(hash "$repo/suspend/herdr-shell") herdr-shell" "$record/installed-suspend" >/dev/null ||
  fail 'herdr-shell not recorded'
run > "$log"
[ "$(build_count)" = 1 ] || fail 'an unchanged second run rebuilt the stand-in'
assert_log 'suspend: 0 installed'
assert_same "$case_dir/suspend-record" "$record/installed-suspend"
assert_same "$case_dir/first-build" "$bin/herdr-standin"
# Each source rebuilds it: the shared recipe module and a stand-in source.
printf 'export const recipe = 2;\n' > "$repo/herdr/mods/tab-tree/recipes.js"
run > "$log"
[ "$(build_count)" = 2 ] || fail 'a recipe change did not rebuild the stand-in'
entry2=$(awk '$2 == "herdr-standin" { print $1 }' "$record/installed-suspend")
[ "$entry2" != "$entry" ] || fail 'the source hash did not change'
printf 'import { recipe } from "../herdr/mods/tab-tree/recipes.js";\nexport const standin = 2;\n' > "$repo/suspend/standin.ts"
run > "$log"
[ "$(build_count)" = 3 ] || fail 'a stand-in source change did not rebuild the stand-in'
[ "$(report_count)" = 3 ] || fail 'the reporter was not rebuilt with the stand-in'
# The reporter's own sources rebuild both, also a file it imports only through
# another shared module (claude-options.js through resume-report.js).
printf 'export const claudeOptionsRecord = 2;\n' > "$repo/herdr/mods/tab-tree/claude-options.js"
run > "$log"
[ "$(report_count)" = 4 ] || fail 'an allowlist change did not rebuild the reporter'
printf 'import "./report";\n// 2\n' > "$repo/suspend/report-main.ts"
run > "$log"
[ "$(report_count)" = 5 ] || fail 'a reporter source change did not rebuild the reporter'
[ "$(build_count)" = 5 ] || fail 'the stand-in was not rebuilt with the reporter'
# A test file and a Herdr file the stand-in does not import rebuild nothing.
printf 'test\n' > "$repo/suspend/standin.test.ts"
printf 'herdr-v2\n' > "$repo/herdr/mods/example/main.js"
run > "$log"
[ "$(build_count)" = 5 ] || fail 'a file outside the stand-in rebuilt it'
# A deleted binary is built again without a source change.
rm "$bin/herdr-standin"
run > "$log"
[ "$(build_count)" = 6 ] || fail 'a missing stand-in was not rebuilt'
rm "$bin/herdr-agent-report"
run > "$log"
[ "$(report_count)" = 7 ] || fail 'a missing reporter was not rebuilt'
# A launcher change installs herdr-shell, and nothing is built.
printf '# local\n' >> "$repo/suspend/herdr-shell"
run > "$log"
[ "$(build_count)" = 7 ] || fail 'a launcher change rebuilt the stand-in'
assert_same "$repo/suspend/herdr-shell" "$bin/herdr-shell"
echo 'ok - the stand-in and the reporter are keyed by their source hash and rebuilt only when it changes'

fixture standin-broken
suspend_sources
fake_bun aot
run > "$log"
cp "$bin/herdr-standin" "$case_dir/first-build"
cp "$bin/herdr-agent-report" "$case_dir/first-report"
cp "$record/installed-suspend" "$case_dir/suspend-record"
printf 'export const standin = 2;\n' > "$repo/suspend/standin.ts"
printf 'herdr-v2\n' > "$repo/herdr/mods/example/main.js"
fake_bun broken
run > "$log" 2>&1 || fail 'a failed build failed the install'
assert_log 'building herdr-standin and herdr-agent-report failed'
assert_log 'fake build failure'
assert_same "$case_dir/first-build" "$bin/herdr-standin"
assert_same "$case_dir/first-report" "$bin/herdr-agent-report"
assert_same "$case_dir/suspend-record" "$record/installed-suspend"
assert_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
[ -z "$(find "$bin" -name '*.install-tmp' -print)" ] || fail 'staging files remain'
fake_bun aot
run > "$log"
[ "$(build_count)" = 1 ] || fail 'the next run did not retry the failed build'
[ "$(report_count)" = 1 ] || fail 'the next run did not build the reporter'
echo 'ok - a failed build keeps the installed binaries and is retried on the next run'

fixture shell-key-missing
suspend_sources
fake_bun aot
run > "$log"
printf 'shell = ["%s/herdr-shell"]\n' "$bin" > "$case_dir/expected"
assert_same "$case_dir/expected" "$core"
echo 'ok - a missing herdr-core config is created with only the shell key'

fixture shell-key-other-keys
suspend_sources
fake_bun aot
mkdir -p "$(dirname "$core")"
# Today's real file: a comment and one key. The new key goes after it.
printf '# Show a lost kept program'"'"'s last screen above the recovery shell.\nrestore_screen = true\n' > "$core"
chmod 600 "$core"
run > "$log"
{
  printf '# Show a lost kept program'"'"'s last screen above the recovery shell.\nrestore_screen = true\n'
  printf 'shell = ["%s/herdr-shell"]\n' "$bin"
} > "$case_dir/expected"
assert_same "$case_dir/expected" "$core"
[ "$(ls -l "$core" | cut -c1-10)" = '-rw-------' ] || fail 'the config lost its mode'
[ -z "$(find "$(dirname "$core")" -name '*.install-tmp' -print)" ] || fail 'staging files remain'
# Tables: the key goes at the top level, before the comments over the first
# table; a list over several lines that holds a nested list is not a table.
cat > "$core" <<'EOF'
notes = false   # a comment
heartbeat = [
  [1, "]"],
]

# The machines.
[machine.box]
shell = "not the top-level key"
EOF
run > "$log"
{
  printf 'notes = false   # a comment\nheartbeat = [\n  [1, "]"],\n]\n'
  printf 'shell = ["%s/herdr-shell"]\n' "$bin"
  printf '\n# The machines.\n[machine.box]\nshell = "not the top-level key"\n'
} > "$case_dir/expected"
assert_same "$case_dir/expected" "$core"
assert_absent "$core.orig"
echo 'ok - an existing herdr-core config keeps its other keys, comments and mode'

# The inode changes when a file is written by a rename.
inode() { ls -i "$1" | awk '{ print $1 }'; }
fixture shell-key-same
suspend_sources
fake_bun aot
mkdir -p "$(dirname "$core")"
# The same value with other spacing, a trailing comma and a comment.
printf 'restore_screen = true\nshell = [ "%s/herdr-shell", ]  # mine\n' "$bin" > "$core"
cp "$core" "$case_dir/before"
before=$(inode "$core")
run > "$log"
assert_same "$case_dir/before" "$core"
[ "$(inode "$core")" = "$before" ] || fail 'an identical shell value was written again'
assert_absent "$core.orig"
if grep -E '^(set|skipped|overwrote) +shell' "$log" >/dev/null; then fail "reported an identical shell value: $(cat "$log")"; fi
echo 'ok - an identical shell value is left alone'

fixture shell-key-conflict
suspend_sources
fake_bun aot
mkdir -p "$(dirname "$core")"
printf '# mine\nshell = [\n  "fish",\n  "-l",\n]\nrestore_screen = true\n' > "$core"
cp "$core" "$case_dir/before"
before=$(inode "$core")
run > "$log"
assert_same "$case_dir/before" "$core"
[ "$(inode "$core")" = "$before" ] || fail 'a conflicting shell value was written'
assert_absent "$core.orig"
assert_log "skipped    shell in $core"
assert_log '"fish",'
assert_log '--force'
run --force > "$log"
assert_same "$case_dir/before" "$core.orig"
{
  printf '# mine\n'
  printf 'shell = ["%s/herdr-shell"]\n' "$bin"
  printf 'restore_screen = true\n'
} > "$case_dir/expected"
assert_same "$case_dir/expected" "$core"
assert_log "overwrote  shell in $core"
# Now identical: a second --force changes nothing and keeps the .orig copy.
cp "$core" "$case_dir/after"
run --force > "$log"
assert_same "$case_dir/after" "$core"
assert_same "$case_dir/before" "$core.orig"
echo 'ok - a conflicting shell value is reported and kept; --force replaces it with a .orig copy'

fixture shell-key-no-bun
suspend_sources
run --force > "$log"
assert_log 'suspend: skipped (no bun)'
assert_absent "$home/.config/herdr-core"
mkdir -p "$(dirname "$core")"
printf 'shell = ["fish"]\n' > "$core"
cp "$core" "$case_dir/before"
run --force > "$log"
assert_same "$case_dir/before" "$core"
assert_absent "$core.orig"
echo 'ok - without bun the shell key is left unchanged, even with --force'

fixture shell-key-unreadable
suspend_sources
fake_bun aot
mkdir -p "$(dirname "$core")"
# A multi-line string can hide a line that looks like a table or a key: the
# installer reports and keeps such a file.
for content in 'motd = """\n[not a table]\n"""\n' "motd = '''\nshell = 1\n'''\n"; do
  printf "$content" > "$core"
  cp "$core" "$case_dir/before"
  run --force > "$log"
  assert_same "$case_dir/before" "$core"
  assert_absent "$core.orig"
  assert_log "skipped    shell in $core"
done
# A quoted key can hold "=" and brackets; the list after it still ends.
printf '"a=[b" = [1,\n2]\nh = [\n[1]\n]\nshell = ["fish"]\n' > "$core"
run --force > "$log"
{
  printf '"a=[b" = [1,\n2]\nh = [\n[1]\n]\n'
  printf 'shell = ["%s/herdr-shell"]\n' "$bin"
} > "$case_dir/expected"
assert_same "$case_dir/expected" "$core"
echo 'ok - a config with multi-line strings is reported and kept; quoted keys are read'

fixture shell-key-xdg
suspend_sources
fake_bun aot
config="$case_dir/xdg config"
app="$config/herdr-app"
run > "$log"
printf 'shell = ["%s/herdr-shell"]\n' "$bin" > "$case_dir/expected"
assert_same "$case_dir/expected" "$config/herdr-core/config.toml"
assert_absent "$core"
echo 'ok - the herdr-core config follows XDG_CONFIG_HOME'

# The Claude plugin's marketplace in the fixture repo (claude/).
claude_sources() {
  mkdir -p "$repo/claude/.claude-plugin"
  cp "$project/claude/.claude-plugin/marketplace.json" "$repo/claude/.claude-plugin/"
}
plugin=herdr-resume@herdr-tincho-config

fixture claude-plugin
claude_sources
fake_claude
run > "$log"
printf 'plugin marketplace add %s\nplugin install %s --scope user\n' "$repo/claude" "$plugin" > "$case_dir/expected"
assert_same "$case_dir/expected" "$claude_calls"
assert_log "installed  Claude plugin $plugin"
assert_file "$app/mods/example/main.js"
# Recorded once per repo folder: a second run calls claude no more.
run > "$log"
[ "$(claude_count)" = 2 ] || fail "a second run called claude again: $(cat "$claude_calls")"
if grep -F 'Claude plugin' "$log" >/dev/null; then fail 'a second run reported the plugin again'; fi
# --force runs both commands again (both do nothing when it is installed).
run --force > "$log"
[ "$(claude_count)" = 4 ] || fail "--force did not reinstall the plugin: $(cat "$claude_calls")"
# Another repo folder installs again.
printf 'x %s\n' "$plugin" > "$record/installed-claude"
run > "$log"
[ "$(claude_count)" = 6 ] || fail 'a plugin from another folder was not reinstalled'
echo 'ok - the Claude plugin is installed from the repo marketplace once per folder, again with --force'

fixture claude-plugin-no-claude
claude_sources
run > "$log"
assert_log 'claude: skipped (no claude on PATH)'
assert_log "claude plugin install $plugin --scope user"
assert_file "$app/mods/example/main.js"
assert_file "$pi/extensions/herdr-recovery/index.ts"
assert_absent "$record/installed-claude"
assert_absent "$home/.claude"
echo 'ok - without claude the plugin is skipped with the commands to run, and the rest installs'

fixture claude-plugin-broken
claude_sources
suspend_sources
fake_bun aot
fake_claude broken
run > "$log" 2>&1 || fail 'a failed plugin install failed the install'
assert_log "installing the plugin $plugin failed"
assert_log 'fake install failure'
assert_absent "$record/installed-claude"
assert_file "$app/mods/example/main.js"
[ -x "$bin/herdr-agent-report" ] || fail 'the reporter was not installed'
fake_claude
run > "$log"
assert_log "installed  Claude plugin $plugin"
echo 'ok - a failed plugin install stops nothing else and is retried on the next run'

# watch_until <what> <command...>: runs the command every 0.1 s until it
# succeeds, for up to 10 s, and fails if the watcher exits meanwhile.
watch_until() {
  what=$1; shift
  attempts=0
  until "$@"; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100 ] || fail "watch did not $what"
    kill -0 "$watch_pid" 2>/dev/null || fail 'watch exited'
    sleep 0.1
  done
}
wait_same() { watch_until "update $2" cmp -s "$1" "$2"; }
wait_log() { watch_until "report $1" grep -F "$1" "$log" >/dev/null; }
# start_watch <PATH>: starts `install.sh --watch` with that PATH and sets
# watch_pid. A fake sleep goes first on its PATH and records each poll's sleep
# in $sleeps (install.sh sleeps only between polls). install.sh exits when a
# source file disappears while a pass copies it, so a test renames or removes
# sources only between passes: wait_idle waits for two new sleeps. The second
# starts after a pass that saw every earlier change, so no pass runs or is
# due until the next change.
start_watch() {
  sleeps="$case_dir/sleeps"
  mkdir -p "$case_dir/watch-bin"
  : > "$sleeps"
  printf '#!/bin/sh\necho >> "%s"\nexec "%s" "$@"\n' "$sleeps" "$(command -v sleep)" > "$case_dir/watch-bin/sleep"
  chmod +x "$case_dir/watch-bin/sleep"
  # exec avoids leaving the watched installer behind when the test kills its pid.
  (exec env -i PATH="$case_dir/watch-bin:$1" HOME="$home" XDG_STATE_HOME="$state" \
    sh "$repo/install.sh" --watch > "$log" 2>&1) &
  watch_pid=$!
}
sleep_count() { wc -l < "$sleeps" | tr -d ' '; }
slept() { [ "$(sleep_count)" -ge "$1" ]; }
wait_idle() { watch_until 'finish its pass' slept $(($(sleep_count) + 2)); }
fixture watch
start_watch "$nobun_path"
wait_log 'pi: 5 installed, 0 skipped'
printf 'herdr-v2\n' > "$repo/herdr/mods/example/main.js"
printf 'pi-v2\n' > "$repo/pi/extensions/herdr-recovery/index.ts"
wait_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
wait_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
printf 'herdr-v3\n' > "$repo/herdr/mods/example/main.js"
printf 'pi-v3\n' > "$repo/pi/extensions/herdr-recovery/index.ts"
wait_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
wait_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
wait_idle
mv "$repo/herdr/shared.txt" "$repo/herdr/renamed.txt"
mv "$repo/pi/shared.txt" "$repo/pi/renamed.txt"
wait_same "$repo/herdr/renamed.txt" "$app/renamed.txt"
wait_same "$repo/pi/renamed.txt" "$pi/renamed.txt"
wait_log 'stale      shared.txt:'
assert_file "$app/shared.txt"
assert_file "$pi/shared.txt"
kill "$watch_pid"
wait "$watch_pid" 2>/dev/null || :
watch_pid=
echo 'ok - watch handles repeated same-size edits and renames in both trees'

fixture watch-conditional
rmdir "$home/.pi"
start_watch "$nobun_path"
wait_log 'pi: skipped'
assert_absent "$home/.pi"
assert_absent "$record/installed-pi"
mkdir "$home/.pi"
# Existing --watch notices setup eligibility without requiring a source edit.
wait_log 'pi: 5 installed, 0 skipped'
wait_same "$repo/pi/extensions/herdr-recovery/index.ts" "$pi/extensions/herdr-recovery/index.ts"
wait_idle
cp "$record/installed-pi" "$case_dir/pi-record"
mv "$home/.pi" "$home/saved-pi"
# A Herdr edit gives us a deterministic completed pass after Pi is removed.
printf 'herdr-v2\n' > "$repo/herdr/mods/example/main.js"
wait_same "$repo/herdr/mods/example/main.js" "$app/mods/example/main.js"
assert_absent "$home/.pi"
assert_same "$case_dir/pi-record" "$record/installed-pi"
kill "$watch_pid"
wait "$watch_pid" 2>/dev/null || :
watch_pid=
echo 'ok - watch activates existing Pi and never recreates a removed Pi home'

built() { [ "$(build_count)" = "$1" ]; }
wait_builds() { watch_until "reach $1 builds" built "$1"; }
fixture watch-standin
suspend_sources
fake_bun aot
start_watch "$run_path"
wait_log 'suspend: 3 installed'
wait_log 'set        shell'
before=$(inode "$core")
# Idle: the new binary and the manifest are not sources, so nothing rebuilds.
sleep 2.5
[ "$(build_count)" = 1 ] || fail "idle watch rebuilt the stand-in ($(build_count) builds)"
printf 'export const standin = 2;\n' > "$repo/suspend/standin.ts"
wait_builds 2
printf '# edited\n' >> "$repo/suspend/herdr-shell"
wait_same "$repo/suspend/herdr-shell" "$bin/herdr-shell"
sleep 1.5
[ "$(build_count)" = 2 ] || fail "watch rebuilt the stand-in after a launcher edit ($(build_count) builds)"
[ "$(inode "$core")" = "$before" ] || fail 'watch wrote the shell key again'
kill "$watch_pid"
wait "$watch_pid" 2>/dev/null || :
watch_pid=
echo 'ok - watch rebuilds the stand-in once per source change and never while idle'
echo 'All installer tests passed.'
