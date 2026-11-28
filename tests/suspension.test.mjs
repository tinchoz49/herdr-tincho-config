import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, PI_RECOVERY, SESSION, SUSPENDED } from "../herdr/mods/tab-tree/recipes.js";

// Mock only the Herdr host and the processes it starts: hc, ps and kill are
// fakes; `sh` runs for real against a disposable home, so the installed check
// sees real files. Each copy of the mod runs in its own window: `window`
// names the window whose focus focused() returns.
let appSettings;
let windows; // window name -> focused() value
let window;
let paneList;
let terminalList;
let store; // shared state
let core; // address -> hc get answers (or functions that give one), in order; the last one repeats
let failing; // hc or exec commands that fail: "keep", "label", "keys", "kill"
let processRows;
let calls;
let home;
let shRuns = 0; // how many times `sh` ran (the installed check)
let shEnv; // more environment for `sh`, as the app's real environment would have it
const hostKey = Symbol.for("herdr.suspension.test-host");

const runSh = (args, env) => new Promise((resolve) => {
  execFile("sh", args, { env }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
});

globalThis[hostKey] = {
  settings: () => structuredClone(appSettings),
  focused: () => structuredClone(windows[window] ?? null),
  panes: () => structuredClone(paneList),
  terminals: () => structuredClone(terminalList),
  shared: (key) => structuredClone(store.get(key)),
  setShared: (key, value) => { store.set(key, structuredClone(value)); return null; },
  readTextFile: async (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  exec: async (command, args) => {
    if (command === "sh") shRuns++;
    if (command === "sh") return runSh(args, { HOME: home, PATH: process.env.PATH, ...shEnv });
    calls.push([command, ...args]);
    if (command === "ps") return { code: 0, stdout: processRows.map((r) => r.join(" ")).join("\n") + "\n", stderr: "" };
    if (command === "kill") return failing.has("kill") ? { code: 1, stdout: "", stderr: "kill: no such process" } : { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected exec: ${command}`);
  },
  hc: async (args) => {
    calls.push(["hc", ...args]);
    const [command, address] = args;
    if (failing.has(command)) return { code: 3, stdout: "", stderr: `{"error":{"kind":"not_found"}}` };
    if (command === "get") {
      const answers = core[address];
      if (!answers?.length) return { code: 3, stdout: "", stderr: `{"error":{"kind":"not_found"}}` };
      const next = answers.length > 1 ? answers.shift() : answers[0];
      const answer = typeof next === "function" ? next() : next;
      return { code: 0, stdout: JSON.stringify(answer) + "\n", stderr: "" };
    }
    if (["keep", "label", "keys"].includes(command)) return { code: 0, stdout: "{}\n", stderr: "" };
    throw new Error(`unexpected hc: ${args.join(" ")}`);
  },
};
const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "herdr") return { url: moduleUrl(`export const { settings, focused, panes, terminals, shared, setShared, readTextFile, exec, hc } = globalThis[Symbol.for("herdr.suspension.test-host")];`), shortCircuit: true };
    return next(specifier, context);
  },
});
const policy = await import("../herdr/mods/tab-tree/suspend-policy.js");
hook.deregister();
const { createSuspender, SUSPEND_REQUESTS, SUSPEND_STATE } = policy;

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
// Pi's session file of session-1 (makeHome() writes Claude's transcript).
const sessions = mkdtempSync(join(tmpdir(), "suspension-test-sessions-"));
writeFileSync(join(sessions, "one.jsonl"), JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/project" }) + "\n");
const piRecord = JSON.stringify({ version: 1, sessionId: "session-1", sessionFile: join(sessions, "one.jsonl"), cwd: "/project", args: [] });

// t7: a Pi agent that hc started directly (its main program is the agent).
// t8: a Claude agent inside fish (the shell is the main program). Both idle
// for an hour, each in its own tab; tab-1 (t1, a shell) is focused.
const piCore = (extra = {}) => ({
  address: "t7", state: "live", pid: 100, argv: ["pi"], keep: false, turn: 4,
  foreground: { pid: 100, argv: ["pi", "", ""], cwd: "/project" },
  status: { app: "pi", state: "idle" }, status_ms: NOW - 60 * MINUTE,
  labels: { [LABEL]: "pi", [PI_RECOVERY]: piRecord }, ...extra,
});
const claudeCore = (extra = {}) => ({
  address: "t8", state: "live", pid: 200, argv: ["fish"], keep: false, turn: 9,
  foreground: { pid: 201, argv: ["claude", "--model", "haiku"], cwd: "/work/app" },
  status: { app: "claude-code", state: "idle" }, status_ms: NOW - 60 * MINUTE,
  labels: { [LABEL]: "claude", [SESSION]: "claude-session" }, ...extra,
});
// As terminals() describes the same terminal: the status as a word, the
// report beside it, and the program table's entry.
const listed = (j) => ({
  ...j, status: j.status?.state ?? null, report: j.status,
  program: { key: j.status?.app === "claude-code" ? "claude" : j.status?.app ?? "shell", agent: Boolean(j.status), shell: !j.status },
});
const shellCore = { address: "t1", state: "live", pid: 50, argv: ["fish"], turn: 0, foreground: { pid: 50, argv: ["fish"], cwd: "/" }, status: null, status_ms: null, labels: {} };

function makeHome({ standin = true, shell = true, config } = {}) {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "suspension-test-"));
  const bin = join(home, ".local/share/herdr-tincho-config/bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, present] of [["herdr-standin", standin], ["herdr-shell", shell]]) {
    if (!present) continue;
    writeFileSync(join(bin, name), "#!/bin/sh\n");
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(home, ".config/herdr-core"), { recursive: true });
  const text = config === undefined ? `restore_screen = true\nshell = ["${bin}/herdr-shell"]\n` : config;
  if (text !== null) writeFileSync(join(home, ".config/herdr-core/config.toml"), text);
  mkdirSync(join(home, ".claude/projects/-work-app"), { recursive: true });
  writeFileSync(join(home, ".claude/projects/-work-app/claude-session.jsonl"), '{"type":"user"}\n');
  return bin;
}

function reset() {
  appSettings = {};
  windows = { one: { space: "space-1", tab: "tab-1", pane: "pane-1", terminal: "t1", shown: null, agent: null, cwd: "/" } };
  window = "one";
  paneList = [
    { pane: "pane-1", terminal: "t1", tab: "tab-1", focused: true },
    { pane: "pane-7", terminal: "t7", tab: "tab-7", focused: false },
    { pane: "pane-8", terminal: "t8", tab: "tab-8", focused: false },
  ];
  core = { t1: [shellCore], t7: [piCore()], t8: [claudeCore()] };
  terminalList = [listed(shellCore), listed(piCore()), listed(claudeCore())];
  store = new Map();
  failing = new Set();
  processRows = [[1, 0, "/sbin/launchd"], [90, 1, "hc server"], [100, 90, "pi"], [101, 100, "npm exec shadcn@latest mcp"],
    [200, 90, "fish"], [201, 200, "claude"], [50, 90, "fish"]];
  calls = [];
  shEnv = {};
  makeHome();
}

// What the policy did to terminals and processes, without the process table reads.
const actions = () => calls.filter(([command]) => command !== "ps");
const labelOf = (call) => JSON.parse(call.at(-1).slice(`${SUSPENDED}=`.length));

test.after(() => { if (home) rmSync(home, { recursive: true, force: true }); rmSync(sessions, { recursive: true, force: true }); });

// A Pi woken from root=shell before the stand-in's wrapper used job control:
// the wrapper (100) is the main program and what hc names in front; pi (105)
// is its child. It is suspended as root=shell: the wrapper gets SIGKILL, and
// pi gets SIGHUP from the kernel, its clean shutdown.
test("an agent under the stand-in's shell wrapper is suspended as root shell", async () => {
  reset();
  core.t7 = [piCore({ argv: ["/bin/herdr-shell"], foreground: { pid: 100, argv: ["/bin/sh", "-c", "..."], cwd: "/project" } })];
  processRows = [[1, 0, "/sbin/launchd"], [90, 1, "hc server"], [100, 90, "/bin/sh -c \"$@\"; exec \"${SHELL:-/bin/sh}\" sh pi"],
    [105, 100, "pi"], [106, 105, "npm exec shadcn@latest mcp"], [200, 90, "fish"], [201, 200, "claude"], [50, 90, "fish"]];
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: true });
  const done = actions();
  assert.equal(labelOf(done[3]).root, "shell");
  assert.deepEqual(done.filter(([command]) => command === "kill"), [["kill", "-KILL", "100"]]);
});

test("a suspension checks, keeps, checks again, labels and signals, in that order", async () => {
  reset();
  const s = createSuspender({ id: "a" });
  assert.deepEqual(await s.suspend("t7", { now: NOW }), { suspended: true });
  assert.deepEqual(actions().map((c) => c.slice(0, 3)), [
    ["hc", "get", "t7"], ["hc", "keep", "t7"], ["hc", "get", "t7"], ["hc", "label", "t7"], ["kill", "-KILL", "100"], ["kill", "-TERM", "101"],
  ]);
  const label = actions()[3];
  assert.equal(label.length, 4);
  assert.deepEqual(labelOf(label), { version: 1, agent: "pi", root: "agent", cwd: "/project", since: NOW });
});

// Pi (and Claude) turn SIGTERM and SIGHUP into an exit with code 0, which hc
// treats as final: the terminal would end. SIGKILL cannot become an exit code.
test("an agent that is the terminal's main program gets SIGKILL, then its helpers from the process snapshot get SIGTERM", async () => {
  reset();
  // Every process of a helper: a wrapper (uvx) may not pass SIGTERM on.
  processRows.push([102, 100, "uvx some-mcp-server"], [103, 102, "python -m server"]);
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: true });
  assert.deepEqual(actions().filter(([command]) => command === "kill"), [["kill", "-KILL", "100"], ["kill", "-TERM", "101", "102", "103"]]);
  // Claude as the main program takes the same path; without helpers, only SIGKILL.
  reset();
  core.t8 = [claudeCore({ pid: 201, argv: ["claude"] })];
  processRows = processRows.filter(([pid]) => pid !== 200).map((r) => r[0] === 201 ? [201, 90, "claude"] : r);
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t8", { now: NOW }), { suspended: true });
  assert.deepEqual(actions().filter(([command]) => command === "kill"), [["kill", "-KILL", "201"]]);
  assert.equal(labelOf(actions().find((c) => c[1] === "label")).root, "agent");
});

test("no helper gets a signal when the main program's SIGKILL fails", async () => {
  reset();
  failing.add("kill");
  await createSuspender({ id: "a" }).suspend("t7", { now: NOW });
  assert.deepEqual(actions().filter(([command]) => command === "kill"), [["kill", "-KILL", "100"]]);
});

// Interactive bash and zsh ignore SIGTERM, and zsh turns SIGHUP into exit 1
// (final). SIGKILL is a loss for every shell, and the kernel then sends the
// agent in front SIGHUP, its clean shutdown (checked with bash, zsh, fish).
test("an agent inside a shell is recorded with root shell, and the shell gets SIGKILL", async () => {
  reset();
  const s = createSuspender({ id: "a" });
  assert.deepEqual(await s.suspend("t8", { now: NOW }), { suspended: true });
  const done = actions();
  assert.deepEqual(labelOf(done[3]), { version: 1, agent: "claude", root: "shell", cwd: "/work/app", since: NOW });
  // The terminal's main program (fish, 200), never the agent in front (201),
  // and nothing else.
  assert.deepEqual(done.slice(4), [["kill", "-KILL", "200"]]);
});

test("step 1 aborts when the agent is no longer unused, before anything changes", async () => {
  for (const [answer, reason] of [
    [piCore({ status: { app: "pi", state: "working" } }), "working"],
    [piCore({ status_ms: NOW - MINUTE }), "recent"],
    [piCore({ labels: { [LABEL]: "pi", [PI_RECOVERY]: piRecord, "herdr.never-suspend": "1" } }), "pinned"],
    [piCore({ state: "finished" }), "gone"],
    [null, "gone"],
    // Without a folder to wake in, the agent cannot be started again.
    [piCore({ foreground: { pid: 100, argv: ["pi"], cwd: null } }), "not-resumable"],
  ]) {
    reset();
    core.t7 = answer ? [answer] : [];
    const s = createSuspender({ id: "a" });
    assert.deepEqual(await s.suspend("t7", { now: NOW }), { suspended: false, reason }, reason);
    assert.deepEqual(actions(), [["hc", "get", "t7", "--json"]], reason);
  }
});

test("step 2 aborts when the terminal cannot be kept", async () => {
  reset();
  failing.add("keep");
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: false, reason: "failed", step: "keep" });
  assert.deepEqual(actions().map((c) => c[1]), ["get", "keep"]);
});

test("step 3 aborts when the status or the turn changed after the keep", async () => {
  for (const [second, reason] of [
    [piCore({ status: { app: "pi", state: "working" } }), "status"],
    // A whole turn went by: the status is idle again, but the turn moved on.
    [piCore({ turn: 5 }), "turn"],
    [piCore({ pid: 300, foreground: { pid: 300, argv: ["pi"], cwd: "/project" } }), "program"],
    [piCore({ state: "finished" }), "finished"],
  ]) {
    reset();
    core.t7 = [piCore(), second];
    const result = await createSuspender({ id: "a" }).suspend("t7", { now: NOW });
    assert.deepEqual(result, { suspended: false, reason: reason === "finished" ? "gone" : "changed" }, reason);
    assert.deepEqual(actions().map((c) => c[1]), ["get", "keep", "get"], reason);
  }
});

test("step 4 aborts when the label cannot be set: no signal", async () => {
  reset();
  failing.add("label");
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: false, reason: "failed", step: "label" });
  assert.deepEqual(actions().map((c) => c[1]), ["get", "keep", "get", "label"]);
});

test("step 5 reports a signal that could not be sent, and removes the label from the agent that still runs", async () => {
  reset();
  failing.add("kill");
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: false, reason: "failed", step: "signal", rolledBack: true });
  assert.deepEqual(actions().map((c) => c[0] === "kill" ? "kill" : c[1]), ["get", "keep", "get", "label", "kill", "get", "label"]);
  // Without the label, the sidebar shows the live agent, not a suspended one.
  assert.deepEqual(actions().at(-1), ["hc", "label", "t7", `${SUSPENDED}=`]);
});

test("step 5 keeps the label when the signal failed because the main program already ended", async () => {
  for (const gone of [piCore({ pid: 400, foreground: { pid: 400, argv: ["herdr-standin"], cwd: "/" } }), piCore({ state: "lost" })]) {
    reset();
    failing.add("kill");
    // Steps 1 and 3 see the agent; after the failed signal, hc already
    // started herdr-shell (a new main program), which reads the label.
    core.t7 = [piCore(), piCore(), gone];
    assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: false, reason: "failed", step: "signal", rolledBack: false });
    assert.deepEqual(actions().map((c) => c[0] === "kill" ? "kill" : c[1]), ["get", "keep", "get", "label", "kill", "get"], gone.state);
  }
});

test("a closed copy stops between steps", async () => {
  reset();
  const s = createSuspender({ id: "a" });
  // The mod closes while step 1 reads the terminal.
  core.t7 = [() => { s.close(); return piCore(); }];
  assert.deepEqual(await s.suspend("t7", { now: NOW }), { suspended: false, reason: "closed" });
  assert.deepEqual(actions().map((c) => c[1]), ["get"]);
});

test("nothing is suspended while the stand-in or the launcher is missing, or the launcher is not hc's shell", async () => {
  const cases = {
    "no stand-in": () => makeHome({ standin: false }),
    "no launcher": () => makeHome({ shell: false }),
    "no core config": () => makeHome({ config: null }),
    "no shell key": () => makeHome({ config: "restore_screen = true\n" }),
    "another shell": () => makeHome({ config: 'shell = ["/opt/homebrew/bin/fish"]\n' }),
    "a shell key in a table": () => { const bin = makeHome(); writeFileSync(join(home, ".config/herdr-core/config.toml"), `[other]\nshell = ["${bin}/herdr-shell"]\n`); },
    // hc reads shell as a word list (shell = ["nu"]).
    "a plain string": () => { const bin = makeHome(); writeFileSync(join(home, ".config/herdr-core/config.toml"), `shell = "${bin}/herdr-shell"\n`); },
    "the launcher as an argument": () => { const bin = makeHome(); writeFileSync(join(home, ".config/herdr-core/config.toml"), `shell = ["/bin/sh", "${bin}/herdr-shell"]\n`); },
    "a commented-out key": () => { const bin = makeHome(); writeFileSync(join(home, ".config/herdr-core/config.toml"), `# shell = ["${bin}/herdr-shell"]\n`); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    reset();
    setup();
    const s = createSuspender({ id: "a" });
    assert.deepEqual(await s.suspend("t7", { now: NOW }), { suspended: false, reason: "not-installed" }, name);
    assert.deepEqual(await s.suspend("t7", { now: NOW, manual: true }), { suspended: false, reason: "not-installed" }, name);
    assert.deepEqual(actions(), [], name);
  }
});

test("the launcher counts as hc's shell in the forms a TOML file can write it", async () => {
  for (const config of [
    (bin) => `shell = ["${bin}/herdr-shell"]\n`,
    (bin) => `# core settings\nrestore_screen = true\n  shell=[ '${bin}/herdr-shell' ]  # suspension\n\n[machine.mini]\nshell = ["fish"]\n`,
    (bin) => `"shell" = [\n  "${bin}/herdr-shell", # the launcher\n]\n`,
  ]) {
    reset();
    const bin = join(home, ".local/share/herdr-tincho-config/bin");
    writeFileSync(join(home, ".config/herdr-core/config.toml"), config(bin));
    assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: true }, config(bin));
  }
});

test("the XDG data and config folders are honored", async () => {
  reset();
  const data = join(home, "data");
  const config = join(home, "config");
  const bin = join(data, "herdr-tincho-config/bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["herdr-standin", "herdr-shell"]) { writeFileSync(join(bin, name), "#!/bin/sh\n"); chmodSync(join(bin, name), 0o755); }
  mkdirSync(join(config, "herdr-core"), { recursive: true });
  writeFileSync(join(config, "herdr-core/config.toml"), `shell = ["${bin}/herdr-shell"]\n`);
  // The default folders hold another shell: only the XDG folders count.
  writeFileSync(join(home, ".config/herdr-core/config.toml"), 'shell = ["fish"]\n');
  shEnv = { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config };
  assert.deepEqual(await createSuspender({ id: "a" }).suspend("t7", { now: NOW }), { suspended: true });
});

// The mod's side of the policy: render calls observe(), and when it asks,
// cx.spawn runs act() with cx.timer.after as the timer. Each copy renders in
// its own window (focused() answers for that window). Timers are fakes that
// elapse() fires.
let clockNow = NOW;
let timers = [];
const schedule = (ms, run) => {
  const timer = { ms, run, at: clockNow, cancelled: false, fired: false, cancel() { timer.cancelled = true; } };
  timers.push(timer);
  return timer;
};
const copy = (id) => createSuspender({ id, clock: () => clockNow });
async function render(s, name, now) {
  window = name;
  clockNow = now;
  if (s.observe(now)) await s.act({ now, schedule });
}
async function elapse(name, now) {
  window = name;
  clockNow = now;
  for (const timer of timers) {
    if (timer.cancelled || timer.fired || timer.at + timer.ms > now) continue;
    timer.fired = true;
    await timer.run();
  }
}
const inWindow = async (name, call) => { window = name; return call(); };
const suspendedAddresses = () => actions().filter(([command]) => command === "hc").filter(([, c]) => c === "label").map(([, , address]) => address);
const focusT7 = { space: "space-1", tab: "tab-7", pane: "pane-7", terminal: "t7", shown: null, agent: null, cwd: "/project" };
const resetCopies = () => { reset(); timers = []; clockNow = NOW; windows.two = { ...windows.one }; };

test("with two copies, only one leads and acts", async () => {
  resetCopies();
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  await render(b, "two", NOW);
  assert.equal(a.leading(NOW), true);
  assert.equal(b.leading(NOW), false);
  await inWindow("two", () => b.pass(NOW));
  assert.deepEqual(actions(), []);
  await inWindow("one", () => a.pass(NOW));
  assert.deepEqual(suspendedAddresses(), ["t7", "t8"]);
  assert.deepEqual(actions().filter(([c]) => c === "kill"), [["kill", "-KILL", "100"], ["kill", "-TERM", "101"], ["kill", "-KILL", "200"]]);
});

test("a copy leads only once its own entry is published, and a stale or closed leader hands over", async () => {
  resetCopies();
  const a = copy("a");
  const b = copy("b");
  assert.equal(a.leading(NOW), false);
  await render(b, "two", NOW);
  assert.equal(a.leading(NOW), false);
  assert.equal(b.leading(NOW), true);
  await render(a, "one", NOW);
  assert.equal(b.leading(NOW), false);
  // a's heartbeat stops (its window closed without closing the copy): after a
  // while, b leads again. b's heartbeat comes from its pass.
  const later = NOW + 200_000;
  await inWindow("two", () => b.pass(later));
  assert.equal(b.leading(later), true);
  assert.equal(a.leading(later), false);
  // a keeps its heartbeat, then closes.
  await inWindow("one", () => a.pass(later));
  assert.equal(b.leading(later), false);
  a.close();
  assert.equal(b.leading(later), true);
});

test("a copy whose entry another copy's write dropped writes it again on its next render", async () => {
  resetCopies();
  const a = copy("a");
  await render(a, "one", NOW);
  store.set(policy.SUSPEND_WINDOWS, {});
  assert.equal(a.leading(NOW), false);
  await render(a, "one", NOW + 10);
  assert.equal(a.leading(NOW + 10), true);
});

test("a terminal focused in another window is never suspended", async () => {
  resetCopies();
  windows.two = { ...windows.one, tab: "tab-7", pane: "pane-7", terminal: "t7" };
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  await render(b, "two", NOW);
  await inWindow("one", () => a.pass(NOW));
  assert.deepEqual(suspendedAddresses(), ["t8"]);
  assert.deepEqual(await inWindow("one", () => a.suspend("t7", { now: NOW, manual: true })), { suspended: false, reason: "focused" });
});

test("the focus of a window whose copy stopped is ignored", async () => {
  resetCopies();
  windows.two = { ...windows.one, tab: "tab-7", pane: "pane-7", terminal: "t7" };
  const a = copy("a");
  const b = copy("b");
  await render(b, "two", NOW - 200_000);
  await render(a, "one", NOW);
  await inWindow("one", () => a.pass(NOW));
  assert.deepEqual(suspendedAddresses(), ["t7", "t8"]);
});

test("the idle clock counts from when the tab was last focused, in this window or another", async () => {
  for (const where of ["one", "two"]) {
    resetCopies();
    terminalList = terminalList.filter((t) => t.address !== "t8");
    const a = copy("a");
    const b = copy("b");
    const other = where === "one" ? a : b;
    let suspendedAt = null;
    // A pass in each copy every minute (their heartbeats keep both entries
    // fresh). From 39 to 10 minutes ago someone looked at t7 (idle for an
    // hour), with no render in between.
    for (let at = NOW - 40 * MINUTE; at <= NOW + 25 * MINUTE && suspendedAt === null; at += MINUTE) {
      if (at === NOW - 39 * MINUTE) windows[where] = focusT7;
      if (at === NOW - 10 * MINUTE) windows[where] = { ...focusT7, tab: "tab-1", pane: "pane-1", terminal: "t1" };
      await render(other, where, at);
      await inWindow("two", () => b.pass(at));
      await inWindow("one", () => a.pass(at));
      if (suspendedAddresses().length) suspendedAt = at;
    }
    // 30 minutes after the look ended.
    assert.equal(suspendedAt, NOW + 20 * MINUTE, where);
    assert.deepEqual(suspendedAddresses(), ["t7"], where);
  }
});

test("observe() changes nothing outside its copy and runs no command", async () => {
  resetCopies();
  const a = copy("a");
  const before = JSON.stringify([...store]);
  window = "one";
  assert.equal(a.observe(NOW), true);
  // Asked once until act() runs.
  assert.equal(a.observe(NOW + 10), false);
  windows.one = { ...windows.one, tab: "tab-7", pane: "pane-7", terminal: "t7" };
  assert.equal(a.observe(NOW + 20), false);
  assert.equal(JSON.stringify([...store]), before);
  assert.deepEqual(calls, []);
  await a.act({ now: NOW + 30, schedule });
  assert.deepEqual(Object.keys(store.get(policy.SUSPEND_WINDOWS)), ["a"]);
  // Nothing new: no more work.
  assert.equal(a.observe(NOW + 40), false);
});

// t7 after its suspension: herdr-shell started the stand-in, which reports idle.
const standinRecord = JSON.stringify({ version: 1, agent: "pi", root: "agent", cwd: "/project", since: NOW - 5 * MINUTE });
function suspendT7(report = { app: "herdr-standin", state: "idle" }) {
  const j = piCore({ pid: 400, argv: ["/bin/sh", "herdr-shell"], foreground: { pid: 400, argv: ["herdr-standin", "pi", "t7", ""], cwd: "/project" },
    status: report, labels: { ...piCore().labels, [SUSPENDED]: standinRecord }, keep: true });
  core.t7 = [j];
  terminalList = terminalList.map((t) => t.address === "t7" ? { ...listed(j), program: { key: "herdr-standin", agent: false, shell: false } } : t);
}
const presses = () => actions().filter(([, command]) => command === "keys");

test("focus never wakes a suspended agent: a focused tab, a close, a new pane, any window", async () => {
  resetCopies();
  suspendT7();
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  await render(b, "two", NOW);
  // Selected, handed over by a closed tab, and focused in another window.
  windows.one = focusT7;
  await render(a, "one", NOW + 10);
  paneList = paneList.filter((p) => p.tab !== "tab-1");
  windows.two = focusT7;
  await render(b, "two", NOW + 20);
  await render(a, "one", NOW + 30);
  // A stand-in moved into the focused tab (a split, a replaced pane).
  windows.one = { ...focusT7, tab: "tab-8", pane: "pane-8", terminal: "t8" };
  paneList = [...paneList, { pane: "pane-9", terminal: "t7", tab: "tab-8", focused: false }];
  await render(a, "one", NOW + 40);
  await elapse("one", NOW + 60_000);
  assert.deepEqual([timers, presses()], [[], []]);
});

test("a click on a suspended agent's row presses one empty Enter in its stand-in", async () => {
  resetCopies();
  suspendT7();
  const a = copy("a");
  await a.wakeClicked(["t7", "t7"]);
  assert.deepEqual(presses(), [["hc", "keys", "t7", "enter"]]);
});

test("a click wakes nothing that is not an idle stand-in, nor a remote terminal", async () => {
  for (const [name, setup] of [
    // The label is set, but the agent has not ended yet (between steps 4 and 5).
    ["agent still running", () => { core.t7 = [piCore({ labels: { ...piCore().labels, [SUSPENDED]: standinRecord } })]; terminalList = terminalList.map((t) => t.address === "t7" ? listed(core.t7[0]) : t); }],
    ["waking", () => suspendT7({ app: "herdr-standin", state: "working" })],
    ["session missing", () => suspendT7({ app: "herdr-standin", state: "blocked" })],
    ["not suspended", () => {}],
  ]) {
    resetCopies();
    setup();
    await copy("a").wakeClicked(["t7", "t1", "t8"]);
    assert.deepEqual(presses(), [], name);
  }
  resetCopies();
  suspendT7();
  await copy("a").wakeClicked(["box/t7"]);
  assert.deepEqual(presses(), []);
});

test("a closed copy wakes nothing on a click", async () => {
  resetCopies();
  suspendT7();
  const a = copy("a");
  a.close();
  await a.wakeClicked(["t7"]);
  assert.deepEqual(presses(), []);
});

// Another mod (ticket 09's menu) asks for a manual suspension.
const request = (address, at) => store.set(SUSPEND_REQUESTS, { ...(store.get(SUSPEND_REQUESTS) ?? {}), [address]: at });
const state = () => store.get(SUSPEND_STATE);

test("a manual request skips the threshold, and its result is shared with the requester", async () => {
  resetCopies();
  // Idle for one minute only: too recent for automatic suspension.
  core.t7 = [piCore({ status_ms: NOW - MINUTE })];
  terminalList = terminalList.map((t) => t.address === "t7" ? listed(core.t7[0]) : t);
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(suspendedAddresses(), ["t8"]);
  calls = [];
  // The request's setShared re-renders every mod.
  request("t7", NOW + 100);
  await render(a, "one", NOW + 250);
  assert.deepEqual(suspendedAddresses(), ["t7"]);
  assert.deepEqual(state().results.t7, { requested: NOW + 100, suspended: true, reason: null, at: NOW + 250, source: "manual" });
  // Handled once.
  calls = [];
  await render(a, "one", NOW + 500);
  await render(a, "one", NOW + 750);
  assert.deepEqual(actions(), []);
});

test("a manual request whose signal fails is shared as failed, with the label removed again", async () => {
  resetCopies();
  failing.add("kill");
  const a = copy("a");
  await render(a, "one", NOW);
  calls = [];
  request("t7", NOW + 100);
  await render(a, "one", NOW + 250);
  assert.deepEqual(state().results.t7, { requested: NOW + 100, suspended: false, reason: "failed", at: NOW + 250, source: "manual", step: "signal", rolledBack: true });
  assert.deepEqual(actions().filter((c) => c[1] === "label").map((c) => c.at(-1).split("=")[1] === ""), [false, true]);
});

test("a manual request still applies every other rule, and the requester gets the reason", async () => {
  for (const [answer, reason] of [
    [piCore({ status: { app: "pi", state: "working" } }), "working"],
    [piCore({ status: { app: "pi", state: "blocked" } }), "blocked"],
    [piCore({ labels: { [LABEL]: "pi" } }), "not-resumable"],
    [piCore({ labels: { ...piCore().labels, "herdr.never-suspend": "1" } }), "pinned"],
  ]) {
    resetCopies();
    core.t7 = [answer];
    const a = copy("a");
    request("t7", NOW);
    await render(a, "one", NOW + 250);
    assert.deepEqual(state().results.t7, { requested: NOW, suspended: false, reason, at: NOW + 250, source: "manual" }, reason);
    assert.deepEqual(actions(), [["hc", "get", "t7", "--json"]], reason);
  }
  resetCopies();
  makeHome({ standin: false });
  const a = copy("a");
  request("t7", NOW);
  await render(a, "one", NOW + 250);
  assert.deepEqual(state().results.t7, { requested: NOW, suspended: false, reason: "not-installed", at: NOW + 250, source: "manual" });
  assert.deepEqual(actions(), []);
});

test("a request for a focused agent is refused", async () => {
  resetCopies();
  windows.one = focusT7;
  const a = copy("a");
  request("t7", NOW);
  await render(a, "one", NOW + 250);
  assert.equal(state().results.t7.reason, "focused");
});

test("only the leader handles requests, and an old request is ignored", async () => {
  resetCopies();
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  request("t7", NOW);
  await render(b, "two", NOW + 250);
  assert.deepEqual(actions(), []);
  assert.equal(state(), undefined);
  resetCopies();
  const c = copy("c");
  request("t7", NOW - 2 * MINUTE);
  await render(c, "one", NOW);
  assert.deepEqual(actions(), []);
});

test("while automatic suspension is off, nothing is suspended automatically, but manual requests still work", async () => {
  for (const value of [false, { after_minutes: 0 }]) {
    resetCopies();
    appSettings = { "tincho.suspend": value };
    const a = copy("a");
    await render(a, "one", NOW);
    await a.pass(NOW);
    await a.pass(NOW + 60 * MINUTE);
    assert.deepEqual(suspendedAddresses(), [], JSON.stringify(value));
    request("t7", NOW + 60 * MINUTE);
    await render(a, "one", NOW + 60 * MINUTE + 250);
    assert.deepEqual(suspendedAddresses(), ["t7"], JSON.stringify(value));
    assert.equal(state().results.t7.suspended, true);
  }
});

test("the leader shares each local agent's current reason, automatic and manual", async () => {
  resetCopies();
  appSettings = { "tincho.suspend": { after_minutes: 120 } };
  windows.one = { ...focusT7, tab: "tab-8", pane: "pane-8", terminal: "t8" };
  const remote = { ...listed(piCore()), address: "mini/t3" };
  terminalList.push(remote, { ...listed(piCore({ status: { app: "pi", state: "working" } })), address: "t9" });
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(state().agents, {
    t7: { auto: "recent", manual: null },
    t8: { auto: "focused", manual: "focused" },
    t9: { auto: "working", manual: "working" },
  });
  appSettings = { "tincho.suspend": false };
  await a.pass(NOW + 15_000);
  assert.deepEqual(state().agents.t7, { auto: "off", manual: null });
  // The installation is checked when an agent is past its threshold.
  makeHome({ standin: false });
  await a.pass(NOW + 30_000);
  assert.deepEqual(state().agents.t7, { auto: "off", manual: null });
  appSettings = {};
  await a.pass(NOW + 45_000);
  assert.deepEqual(state().agents.t7, { auto: "not-installed", manual: "not-installed" });
  // That check holds for the reasons until the next one.
  appSettings = { "tincho.suspend": false };
  await a.pass(NOW + 60_000);
  assert.deepEqual(state().agents.t7, { auto: "off", manual: "not-installed" });
  assert.deepEqual(suspendedAddresses(), []);
});

test("a pass starts no process while no agent is past its threshold", async () => {
  resetCopies();
  appSettings = { "tincho.suspend": { after_minutes: 120 } };
  const a = copy("a");
  await render(a, "one", NOW);
  const runs = shRuns;
  for (let i = 0; i <= 20; i++) await a.pass(NOW + i * 15_000);
  assert.deepEqual(calls, []);
  assert.equal(shRuns, runs);
});

test("while suspension is not installed, the installed check runs at most once every five minutes", async () => {
  resetCopies();
  makeHome({ standin: false });
  const a = copy("a");
  await render(a, "one", NOW);
  const runs = shRuns;
  for (let i = 0; i < 20; i++) await a.pass(NOW + i * 15_000);
  assert.equal(shRuns - runs, 1);
  assert.deepEqual(state().agents.t7, { auto: "not-installed", manual: "not-installed" });
  await a.pass(NOW + 5 * MINUTE);
  assert.equal(shRuns - runs, 2);
  // Installed since: the next check finds it, and the agents are suspended.
  makeHome();
  await a.pass(NOW + 10 * MINUTE);
  assert.deepEqual(suspendedAddresses(), ["t7", "t8"]);
});

test("the leader removes requests older than a minute, and requests that can never act, from the shared requests", async () => {
  resetCopies();
  appSettings = { "tincho.suspend": false };
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  await render(b, "two", NOW);
  const requests = { t7: NOW - MINUTE, t8: NOW - MINUTE + 1, t1: "soon", t9: NOW + 10 * MINUTE };
  store.set(SUSPEND_REQUESTS, requests);
  await inWindow("two", () => b.pass(NOW));
  assert.deepEqual(store.get(SUSPEND_REQUESTS), requests);
  await inWindow("one", () => a.pass(NOW));
  assert.deepEqual(store.get(SUSPEND_REQUESTS), { t8: NOW - MINUTE + 1 });
  await inWindow("one", () => a.pass(NOW + 15_000));
  assert.deepEqual(store.get(SUSPEND_REQUESTS), {});
});

test("an agent whose session is not on disk is not suspended, and is checked again only after five minutes", async () => {
  resetCopies();
  rmSync(join(home, ".claude/projects/-work-app/claude-session.jsonl"));
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(suspendedAddresses(), ["t7"]);
  const t8Gets = () => actions().filter((c) => c[1] === "get" && c[2] === "t8").length;
  assert.equal(t8Gets(), 1);
  await a.pass(NOW + 15_000);
  await a.pass(NOW + 4 * MINUTE);
  assert.equal(t8Gets(), 1);
  assert.deepEqual(state().agents.t8, { auto: "not-resumable", manual: "not-resumable" });
  await a.pass(NOW + 5 * MINUTE);
  assert.equal(t8Gets(), 2);
  // A manual request reads it again at once.
  request("t8", NOW + 5 * MINUTE);
  await render(a, "one", NOW + 5 * MINUTE + 250);
  assert.equal(state().results.t8.reason, "not-resumable");
  assert.equal(t8Gets(), 3);
});

test("an agent kept by its background processes gets its process table read again only after five minutes", async () => {
  resetCopies();
  processRows.push([102, 100, "npm run dev"]);
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  const reads = () => calls.filter(([command]) => command === "ps").length;
  // t7 kept by its dev server; t8 (no child process) suspended.
  assert.deepEqual(suspendedAddresses(), ["t8"]);
  assert.equal(reads(), 2);
  core.t8 = [claudeCore({ foreground: { pid: 200, argv: ["herdr-standin", "claude", "t8", ""], cwd: "/work/app" }, labels: { ...claudeCore().labels, [SUSPENDED]: "{}" } })];
  terminalList = terminalList.map((t) => t.address === "t8" ? listed(core.t8[0]) : t);
  await a.pass(NOW + 15_000);
  await a.pass(NOW + 4 * MINUTE);
  assert.equal(reads(), 2);
  assert.deepEqual(state().agents.t7, { auto: "background", manual: "background" });
  await a.pass(NOW + 5 * MINUTE);
  assert.equal(reads(), 3);
});

// Repairs (ticket 14). A suspension label on a live terminal that no stand-in
// holds (the mod closed between steps 4 and 5, or someone set it by hand)
// is removed by the leader's regular pass, once it is 60 s old.
const t7Calls = () => actions().filter(([, , address]) => address === "t7").map((c) => c.slice(0, 4));
const leftover = (since, extra = {}) => piCore({ labels: { ...piCore().labels, [SUSPENDED]: JSON.stringify({ version: 1, agent: "pi", root: "agent", cwd: "/project", since }) }, ...extra });
const showT7 = (j) => { core.t7 = [j]; terminalList = terminalList.map((t) => t.address === "t7" ? listed(j) : t); };

test("the leader removes a label left on a live agent 60 s after it was set, and shares the repair", async () => {
  resetCopies();
  showT7(leftover(NOW - MINUTE));
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(t7Calls(), [["hc", "get", "t7", "--json"], ["hc", "label", "t7", `${SUSPENDED}=`]]);
  assert.deepEqual(state().results.t7, { requested: null, suspended: false, reason: "repaired", at: NOW, source: "repair" });
});

test("a label younger than 60 s is left alone", async () => {
  resetCopies();
  showT7(leftover(NOW - MINUTE + 1));
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(t7Calls(), []);
  assert.equal(state().results?.t7, undefined);
});

test("a label is left alone while its stand-in or herdr-shell is in front, or when hc shows nothing in front", async () => {
  for (const front of [
    { pid: 400, argv: ["/data/bin/herdr-standin", "pi", "t7", ""], cwd: "/project" },
    { pid: 400, argv: ["/bin/sh", "/data/bin/herdr-shell"], cwd: "/project" },
    undefined,
  ]) {
    resetCopies();
    showT7(leftover(NOW - 10 * MINUTE, { pid: 400, foreground: front, status: null }));
    const a = copy("a");
    await render(a, "one", NOW);
    await a.pass(NOW);
    assert.deepEqual(t7Calls(), [], JSON.stringify(front));
  }
});

test("a label set by hand on a plain shell is removed", async () => {
  resetCopies();
  const j = { ...shellCore, labels: { [SUSPENDED]: "1" } };
  core.t1 = [j];
  terminalList = terminalList.map((t) => t.address === "t1" ? listed(j) : t);
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(actions().filter(([, , address]) => address === "t1").map((c) => c.slice(0, 4)), [["hc", "get", "t1", "--json"], ["hc", "label", "t1", `${SUSPENDED}=`]]);
  assert.equal(state().results.t1.reason, "repaired");
});

test("the repair reads the terminal again: a stand-in that started since the last listing keeps its label", async () => {
  resetCopies();
  showT7(leftover(NOW - 10 * MINUTE));
  core.t7 = [leftover(NOW - 10 * MINUTE, { pid: 400, foreground: { pid: 400, argv: ["herdr-standin", "pi", "t7", ""], cwd: "/project" } })];
  const a = copy("a");
  await render(a, "one", NOW);
  await a.pass(NOW);
  assert.deepEqual(t7Calls(), [["hc", "get", "t7", "--json"]]);
});

test("labels are repaired while automatic suspension is off, but only by the leader", async () => {
  resetCopies();
  appSettings = { "tincho.suspend": false };
  showT7(leftover(NOW - 10 * MINUTE));
  const a = copy("a");
  const b = copy("b");
  await render(a, "one", NOW);
  await render(b, "two", NOW);
  await b.pass(NOW);
  assert.deepEqual(t7Calls(), []);
  await a.pass(NOW);
  assert.deepEqual(t7Calls().at(-1), ["hc", "label", "t7", `${SUSPENDED}=`]);
});

// Failures in automatic passes go to the same shared results as requests.
test("an automatic suspension that fails is shared in the results, with its step", async () => {
  for (const [fail, answers, expected] of [
    ["kill", null, { step: "signal", rolledBack: true }],
    ["kill", [piCore(), piCore(), piCore({ state: "lost" })], { step: "signal", rolledBack: false }],
    ["keep", null, { step: "keep" }],
    ["label", null, { step: "label" }],
  ]) {
    resetCopies();
    appSettings = {};
    windows.one = { ...focusT7, tab: "tab-8", pane: "pane-8", terminal: "t8" }; // t8 stays live
    failing.add(fail);
    if (answers) core.t7 = answers;
    const a = copy("a");
    await render(a, "one", NOW);
    await a.pass(NOW);
    assert.deepEqual(state().results.t7, { requested: null, suspended: false, reason: "failed", at: NOW, source: "auto", ...expected }, `${fail} ${expected.rolledBack}`);
  }
});

test("an automatic result keeps the request a manual result answered, so that request is not handled twice", async () => {
  resetCopies();
  failing.add("kill");
  windows.one = { ...focusT7, tab: "tab-8", pane: "pane-8", terminal: "t8" };
  const a = copy("a");
  await render(a, "one", NOW);
  request("t7", NOW + 100);
  await render(a, "one", NOW + 250);
  assert.equal(state().results.t7.requested, NOW + 100);
  assert.equal(state().results.t7.source, "manual");
  await a.pass(NOW + 15_000);
  assert.deepEqual(state().results.t7, { requested: NOW + 100, suspended: false, reason: "failed", at: NOW + 15_000, source: "auto", step: "signal", rolledBack: true });
  calls = [];
  await render(a, "one", NOW + 15_250);
  assert.deepEqual(actions(), []);
});
