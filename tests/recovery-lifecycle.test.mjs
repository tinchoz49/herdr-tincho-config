import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { LABEL } from "../herdr/mods/tab-tree/recipes.js";
import { RESUME } from "../herdr/mods/tab-tree/resume-report.js";

// No subprocesses, real sessions, or session files. The 0.1.14 scheduler leaves
// cancelled sleeps/host promises pending (scheduler.rs:534,1217). Model that,
// plus completions already queued when View.close runs, at the host boundary.
const scope = new AsyncLocalStorage();
const elements = new Map();
function element() {
  let id;
  const proxy = new Proxy({}, { get: (_, method) => (...args) => {
    if (method === "id") { id = args[0]; elements.set(id, {}); }
    if (method === "on_click") elements.get(id).click = args[0];
    if (method === "when" && args[0]) args[1](proxy);
    return proxy;
  } });
  return proxy;
}
let calls = [];
let violations = [];
let respond;
const shell = { state: "live", pid: 1, foreground: { pid: 1 } };
const running = { state: "live", pid: 1, foreground: { pid: 2 } };
const ok = (value = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) });
// Resume reports as the agents' plugins write them.
const report = (agent, session, argv, proof) => ({ [RESUME]: JSON.stringify({ version: 1, agent, session, argv, cwd: "/fake/project", proof, pid: 7, at: 1 }) });
const labels = report("pi", "exact-session", ["pi", "--session", "/fake/session.jsonl", "--thinking", "high"], "/fake/session.jsonl");
const claudeLabels = report("claude", "saved-session", ["claude", "--resume", "saved-session"], "/fake/saved-session.jsonl");
const PI_LINE = "cd '/fake/project' && 'pi' '--session' '/fake/session.jsonl' '--thinking' 'high'";
const CLAUDE_LINE = "cd '/fake/project' && 'claude' '--resume' 'saved-session'";
// Every proof file holds both sessions.
const heads = ok({ sessionId: "saved-session", id: "exact-session" });
const host = {
  hc: (...args) => invoke("hc", args), exec: (...args) => invoke("exec", args),
  spaces: () => [], panes: () => [], terminals: () => [], machines: () => [],
  run() {}, openOverlay() {}, theme: () => ({}), shared() {}, setShared() {}, home: () => "/fake", layout: () => null,
  focused: () => null, settings: () => ({}), readTextFile: async () => null,
};
function invoke(kind, args) {
  const owner = scope.getStore();
  const call = { kind, args, owner };
  calls.push(call);
  return Promise.resolve(respond(call));
}
const key = Symbol.for("herdr.lifecycle.test-host");
globalThis[key] = { host, element };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const hook = registerHooks({ resolve(specifier, context, next) {
  const prelude = 'const { host, element } = globalThis[Symbol.for("herdr.lifecycle.test-host")];';
  const sources = {
    herdr: `${prelude} export const { ${Object.keys(host).join(", ")} } = host;`,
    "gpui-kit": `${prelude} export class View {} export const div = element, image = element, svg = element;`,
    "gpui-base": `${prelude} export const v_flex = element, h_flex = element;`,
  };
  if (sources[specifier]) return { url: "data:text/javascript," + encodeURIComponent(sources[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
const { default: TabTree } = await import("../herdr/mods/tab-tree/main.js");
hook.deregister();

const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
  // Record separately: production intentionally catches failed recovery tasks.
  assert.deepEqual(violations, [], "no late notifications or invalid context use");
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function sidebar(name, { immediateSleep = false } = {}) {
  const view = new TabTree();
  const owner = { name, closed: false, sleeps: [], tasks: [], timers: [] };
  const taskCx = {
    notify() { if (owner.closed) violations.push("late task notification"); },
    sleep(ms) {
      if (scope.getStore() !== owner) violations.push("sleep has wrong owner");
      if (owner.closed) violations.push("sleep after close");
      const gate = deferred();
      owner.sleeps.push({ ...gate, ms });
      if (immediateSleep) gate.resolve();
      return gate.promise;
    },
  };
  const eventCx = {
    notify() {}, stop_propagation() {},
    sleep: () => { violations.push("retained event cx"); throw new Error("retained event cx"); },
    timer: { every: (ms, callback) => owner.timers.push({ ms, callback }) },
    spawn(callback) {
      const task = scope.run(owner, () => callback(taskCx));
      owner.tasks.push(task);
    },
  };
  view.init({}, eventCx);
  return {
    view, owner,
    click(address, agent = "pi", metadata = {}) {
      view.labels.set(address, { [LABEL]: agent, ...metadata });
      view.hovered = address;
      view.tabRow({}, {}, { id: address, named: false }, { p: { terminal: address, program: { shell: true, name: "sh" } }, kids: [] }, false, "", null);
      elements.get(`tab-resume-${address}`).click({}, eventCx);
    },
    close() { view.close?.(eventCx); owner.closed = true; },
  };
}
function reset() {
  calls = [];
  violations = [];
  respond = ({ kind, args }) => kind === "exec" ? heads : args[0][0] === "get" ? ok(shell) : ok();
}
const sends = (owner) => calls.filter((c) => c.kind === "hc" && c.args[0][0] === "send" && (!owner || c.owner === owner)).map((c) => c.args[0]);

test("closing a sidebar asleep with active and queued recovery does not stall its replacement", async () => {
  reset();
  respond = ({ args }) => args[0][0] === "get" ? ok(running) : ok();
  const old = sidebar("old");
  old.click("active", "claude");
  old.click("queued");
  await flush();
  assert.equal(old.owner.sleeps.length, 1);
  assert.deepEqual(sends(old.owner), [["send", "active", "claude --resume"]]);
  old.close(); // The pending sleep deliberately never settles.
  respond = ({ args }) => args[0][0] === "get" ? ok(shell) : ok();
  const fresh = sidebar("fresh");
  fresh.click("new");
  await flush();
  assert.deepEqual(sends(fresh.owner), [["send", "new", "pi --resume"]]);
  assert.deepEqual(sends(old.owner), [["send", "active", "claude --resume"]]);
  const before = calls.length;
  old.owner.sleeps[0].resolve(); // A continuation already queued at close.
  await flush();
  assert.equal(calls.length, before, "stale sleep cannot probe, exit, or release queued work");
  await Promise.all(old.owner.tasks);
});

const boundaries = ["Pi file exec", "Pi shell get", "Pi send", "Claude stand-in check get", "Claude send", "Claude report get", "Claude final report get", "Claude /exit", "Claude exit get"];
for (const boundary of boundaries) {
  test(`close during ${boundary}: new copy starts; late completion cannot follow up`, async () => {
    reset();
    const gate = deferred();
    let held = false, gets = 0, exiting = false;
    const old = sidebar("old", { immediateSleep: true });
    respond = (call) => {
      const { kind, args, owner } = call;
      const [verb, , line] = args[0];
      if (owner !== old.owner) return verb === "get" ? ok(shell) : ok();
      if (verb === "get") gets++;
      if (line === "/exit") exiting = true;
      const match = {
        "Pi file exec": kind === "exec",
        "Pi shell get": verb === "get",
        "Pi send": verb === "send",
        // Claude's first get checks for a stand-in, before anything is typed.
        "Claude stand-in check get": verb === "get" && gets === 1,
        "Claude send": verb === "send",
        "Claude report get": verb === "get" && gets === 2,
        "Claude final report get": verb === "get" && gets === 42,
        "Claude /exit": line === "/exit",
        "Claude exit get": verb === "get" && exiting,
      }[boundary];
      if (match && !held) { held = true; return gate.promise; }
      return verb === "get" ? ok(boundary.startsWith("Pi") ? shell : running) : ok();
    };
    old.click("active", boundary.startsWith("Pi") ? "pi" : "claude", boundary === "Pi file exec" ? labels : {});
    old.click("queued", "pi", labels);
    for (let i = 0; i < 20 && !held; i++) await flush();
    assert.equal(held, true, `reached ${boundary}`);
    old.close();
    const oldCalls = calls.filter((c) => c.owner === old.owner).length;
    const fresh = sidebar("fresh");
    fresh.click("new");
    await flush();
    assert.deepEqual(sends(fresh.owner), [["send", "new", "pi --resume"]]);
    assert.equal(calls.filter((c) => c.owner === old.owner).length, oldCalls);
    // Native cancellation normally leaves the gate pending. Also exercise a
    // result whose JS continuation was ready when synchronous close ran.
    gate.resolve(boundary === "Pi file exec" ? heads : ok(boundary === "Claude final report get" ? running : shell));
    await flush();
    await Promise.all(old.owner.tasks);
    assert.equal(calls.filter((c) => c.owner === old.owner).length, oldCalls, "no stale probes, retries, /exit, or queued exec");
    old.click("after-close");
    await flush();
    assert.equal(calls.filter((c) => c.owner === old.owner).length, oldCalls, "closed owner refuses new requests");
  });
}

test("close before the queue starts cancels all requests without host work", async () => {
  reset();
  const old = sidebar("old");
  old.click("one", "pi", labels);
  old.click("two", "claude");
  old.close();
  await flush();
  await Promise.all(old.owner.tasks);
  assert.deepEqual(calls, []);
});

test("rejected recovery releases the owner's queue and exact Pi recovery stays once-only", async () => {
  reset();
  const failed = deferred();
  const normal = respond;
  respond = (call) => call.kind === "hc" && call.args[0][0] === "send" && call.args[0][1] === "failed" ? failed.promise : normal(call);
  const copy = sidebar("owner");
  copy.click("failed", "claude");
  copy.click("pi", "pi", labels);
  await flush();
  assert.deepEqual(sends(), [["send", "failed", "claude --resume"]]);
  failed.reject(new Error("mock send rejected"));
  await flush();
  await Promise.all(copy.owner.tasks);
  assert.deepEqual(sends(), [
    ["send", "failed", "claude --resume"],
    ["send", "pi", PI_LINE],
  ]);
  assert.equal(copy.owner.sleeps.length, 0);
  assert.deepEqual(calls.filter((c) => c.kind === "exec").map((c) => c.args), [["sh", ["-c", 'test -f "$1" && head -c "$2" "$1"', "sh", "/fake/session.jsonl", "4096"]]]);
});

test("Claude retries remain serial, bounded, and hold queued Pi until they finish", async () => {
  reset();
  const copy = sidebar("owner", { immediateSleep: true });
  let exiting = false;
  respond = ({ args }) => {
    const [verb, address, line] = args[0];
    if (verb === "send" && address === "claude") exiting = line === "/exit";
    if (verb === "s") return heads; // the proof check (exec sh ...)
    return verb === "get" ? ok(address === "pi" || exiting ? shell : running) : ok();
  };
  copy.click("claude", "claude", claudeLabels);
  copy.click("pi");
  for (let i = 0; i < 30; i++) await flush();
  await Promise.all(copy.owner.tasks);
  assert.deepEqual(sends(), [
    ["send", "claude", CLAUDE_LINE], ["send", "claude", "/exit"],
    ["send", "claude", CLAUDE_LINE], ["send", "claude", "/exit"],
    ["send", "claude", CLAUDE_LINE], ["send", "claude", "/exit"],
    ["send", "pi", "pi --resume"],
  ]);
  assert.equal(copy.owner.sleeps.length, 120);
  assert.ok(copy.owner.sleeps.every(({ ms }) => ms === 500));
  assert.deepEqual(copy.owner.timers.map(({ ms }) => ms), [15000], "the suspension pass is the only periodic work");
});

test("closing one simultaneous sidebar does not cancel another owner's queue", async () => {
  reset();
  const gate = deferred();
  const normal = respond;
  const first = sidebar("first");
  const second = sidebar("second");
  respond = (call) => call.owner === first.owner ? gate.promise : normal(call);
  first.click("stalled", "pi", labels);
  await flush();
  assert.equal(calls.filter((c) => c.owner === first.owner).length, 1);
  second.click("second", "pi", labels);
  first.close();
  await flush();
  assert.deepEqual(sends(second.owner), [["send", "second", PI_LINE]]);
  assert.deepEqual(sends(first.owner), []);
});

// A stand-in is the terminal's main program, so the "at a shell" check
// (foreground.pid === pid) passes for it. Recovery reads the terminal just
// before it types and refuses one: a ↻ shown before the agent was suspended
// (a stale click) types nothing.
const standin = { ...shell, labels: { "herdr.suspended": JSON.stringify({ version: 1, agent: "pi", root: "agent", cwd: "/fake/project", since: 1 }) }, status: { app: "herdr-standin", state: "idle" } };
for (const agent of ["pi", "claude"]) {
  test(`a stale ↻ click types nothing into a suspended ${agent} agent's stand-in`, async () => {
    reset();
    respond = ({ kind, args }) => kind === "exec" ? heads : args[0][0] === "get" ? ok(standin) : ok();
    const copy = sidebar("owner", { immediateSleep: true });
    copy.click("t7", agent, agent === "pi" ? labels : claudeLabels);
    for (let i = 0; i < 5; i++) await flush();
    await Promise.all(copy.owner.tasks);
    assert.deepEqual(sends(), []);
  });
}

test("recovery types nothing while a stand-in wakes its agent, label already removed", async () => {
  reset();
  // The stand-in removed its label and replaced itself with the agent, which
  // has not reported yet: the stand-in's "working" report is still there.
  const waking = { ...shell, labels: {}, status: { app: "herdr-standin", state: "working" } };
  respond = ({ kind, args }) => kind === "exec" ? heads : args[0][0] === "get" ? ok(waking) : ok();
  const copy = sidebar("owner", { immediateSleep: true });
  copy.click("t7", "pi", labels);
  copy.click("t8", "claude");
  for (let i = 0; i < 5; i++) await flush();
  await Promise.all(copy.owner.tasks);
  assert.deepEqual(sends(), []);
});

// The woken agent never reported: the stand-in's "working" report stays. Once
// the wake is over (30 s, and the stand-in is not in front), a shell in front
// gets recovery again; anything else in front (the agent itself, or the wake's
// sh wrapper running it) gets nothing typed into it.
const staleWake = (front, ageMs) => ({ ...shell, labels: {}, status: { app: "herdr-standin", state: "working" }, status_ms: Date.now() - ageMs, reported: true,
  foreground: { pid: 1, argv: front } });
for (const [what, front, ageMs, typed] of [
  ["a shell in front, 60 s after the wake", ["/opt/homebrew/bin/fish", "-l"], 60_000, true],
  ["a shell in front, 5 s after the wake", ["/opt/homebrew/bin/fish", "-l"], 5_000, false],
  ["the stand-in still in front, 60 s after the wake", ["/data/bin/herdr-standin", "pi", "t7", ""], 60_000, false],
  ["the woken agent in front, unreported", ["claude", "--resume", "abc"], 60_000, false],
  ["the wake's sh wrapper in front", ["/bin/sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh", "claude", "--resume", "abc"], 60_000, false],
]) {
  test(`recovery after a wake whose agent never reported: ${what}`, async () => {
    reset();
    respond = ({ kind, args }) => kind === "exec" ? heads : args[0][0] === "get" ? ok(staleWake(front, ageMs)) : ok();
    const copy = sidebar("owner", { immediateSleep: true });
    copy.click("t7", "pi", labels);
    for (let i = 0; i < 5; i++) await flush();
    await Promise.all(copy.owner.tasks);
    assert.deepEqual(sends(), typed ? [["send", "t7", PI_LINE]] : []);
  });
}
