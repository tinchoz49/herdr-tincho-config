import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { LABEL, SUSPENDED } from "../herdr/mods/tab-tree/recipes.js";

// What the sidebar shows for a suspended or waking agent (ticket 08). The host
// and the element builders are fakes at the module boundary; each element
// records its calls and children, so a test reads what a row shows.
const NODE = Symbol("node");
function element(arg) {
  const node = { arg, calls: [], kids: [] };
  const proxy = new Proxy({}, { get: (_, method) => {
    if (method === NODE) return node;
    return (...args) => {
      node.calls.push([method, ...args]);
      if (method === "when" && args[0]) args[1](proxy);
      if (method === "child") node.kids.push(args[0]);
      if (method === "children") node.kids.push(...args[0]);
      return proxy;
    };
  } });
  return proxy;
}
// What the host shows, for tests that render the whole sidebar.
const world = { spaces: [], panes: [], terminals: [], hc: [] };
const host = {
  hc: async (args) => { world.hc.push(args); return { code: 0, stdout: "{}" }; }, exec: async () => ({ code: 0, stdout: "" }),
  spaces: () => world.spaces, panes: () => world.panes, terminals: () => world.terminals, machines: () => [],
  run() {}, openOverlay() {}, theme: () => ({}), shared() {}, setShared() {}, home: () => "/home", layout: () => world.layout ?? null,
  focused: () => null, settings: () => ({}), readTextFile: async () => null,
};
globalThis[Symbol.for("herdr.sidebar-suspension.test-host")] = { host, element };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const hook = registerHooks({ resolve(specifier, context, next) {
  const prelude = 'const { host, element } = globalThis[Symbol.for("herdr.sidebar-suspension.test-host")];';
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

const theme = { dim: "DIM", foreground: "FG", muted: "MUTED", working: "WORKING", blocked: "BLOCKED", idle: "IDLE", done: "DONE", hover: "HOVER", selected: "SELECTED", raised: "RAISED", input: "INPUT", accent: "#123456" };
const nodes = (root) => {
  const all = [];
  const walk = (x) => { const n = x?.[NODE]; if (!n) return; all.push(n); n.kids.forEach(walk); };
  walk(root);
  return all;
};
const texts = (root) => nodes(root).flatMap((n) => n.kids.filter((k) => typeof k === "string"));
const ids = (root) => nodes(root).flatMap((n) => n.calls.filter(([m]) => m === "id").map(([, id]) => id));
const colorOf = (root, text) => {
  const n = nodes(root).find((x) => x.kids.includes(text));
  return n?.calls.filter(([m]) => m === "text_color").at(-1)?.[1];
};

const record = JSON.stringify({ version: 1, agent: "pi", root: "agent", cwd: "/home/project", since: 1 });
// A stand-in holds the terminal: it reports as the herdr-standin app.
const standin = (status = "idle") => ({ pane: "p7", terminal: "t7", tab: "tab7", title: "Fix the parser", cwd: "/home/project", status, app: "herdr-standin", program: { key: "agent", name: "herdr-standin", icon: null, tint: false, agent: false, shell: false } });
const agent = (status = "idle") => ({ ...standin(status), app: "pi", program: { key: "pi", name: "Pi", icon: "icons/pi.svg", tint: true, agent: true, shell: false } });
const shell = () => ({ ...standin(), title: "fish", status: null, app: null, program: { key: "shell", name: "fish", icon: null, tint: false, agent: false, shell: true } });

// front: the argv of what runs in front of the terminal (hc's foreground).
const STANDIN_ARGV = ["/data/bin/herdr-standin", "pi", "t7", ""];
const HERDR_SHELL_ARGV = ["/bin/sh", "/data/bin/herdr-shell"];
function row(p, labels, { collapsed = false, hovered = false, front = p.app === "herdr-standin" ? STANDIN_ARGV : ["pi", "", ""] } = {}) {
  const view = new TabTree();
  view.folded = new Set();
  view.labels = new Map([["t7", labels]]);
  view.cores = new Map([["t7", { address: "t7", state: "live", labels, foreground: { pid: 400, argv: front, name: front[0] } }]]);
  view.hovered = hovered ? "tab7" : null;
  return view.tabRow(theme, { active: false }, { id: "tab7", named: false }, { p, kids: [] }, collapsed, "project", null);
}
const suspended = { [LABEL]: "pi", [SUSPENDED]: record };

test("a suspended agent's row shows a dimmed name and 💤", () => {
  const r = row(standin(), suspended);
  assert.ok(texts(r).includes("Fix the parser"));
  assert.equal(colorOf(r, "Fix the parser"), "DIM");
  assert.ok(texts(r).includes("💤"));
  // An agent that runs shows its name in full color, and no 💤.
  const live = row(agent(), { [LABEL]: "pi" });
  assert.equal(colorOf(live, "Fix the parser"), "FG");
  assert.ok(!texts(live).includes("💤"));
});

test("a suspended agent's row in the narrow sidebar shows 💤 and a dimmed icon", () => {
  const r = row(standin(), suspended, { collapsed: true });
  assert.ok(texts(r).includes("💤"));
  assert.ok(nodes(r).some((n) => n.calls.some(([m, v]) => m === "opacity" && v < 1)));
  assert.ok(!texts(row(agent(), { [LABEL]: "pi" }, { collapsed: true })).includes("💤"));
});

test("a suspended agent without a title goes by its agent, not by the stand-in", () => {
  const r = row({ ...standin(), title: "" }, suspended);
  assert.ok(texts(r).includes("pi"));
  assert.ok(!texts(r).includes("herdr-standin"));
});

test("a stand-in that cannot wake still says it needs you", () => {
  const r = row(standin("blocked"), suspended);
  assert.ok(texts(r).includes("Needs you"));
});

test("a waking agent shows waking… from the stand-in's working report until the woken agent reports", () => {
  // The stand-in reports working, then removes its label and replaces itself.
  for (const labels of [suspended, { [LABEL]: "pi" }]) {
    const r = row(standin("working"), labels);
    assert.ok(texts(r).includes("waking…"));
    assert.ok(!texts(r).includes("💤"));
  }
  // The woken agent reported its own status.
  const woken = row(agent("working"), { [LABEL]: "pi" });
  assert.ok(!texts(woken).includes("waking…"));
});

test("↻ is never offered on a suspended terminal, but a kept terminal back at a shell still offers it", () => {
  assert.ok(!ids(row(standin(), suspended, { hovered: true })).includes("tab-resume-tab7"));
  // herdr-shell, before the stand-in reports: a shell with the label.
  assert.ok(!ids(row(shell(), suspended, { hovered: true, front: HERDR_SHELL_ARGV })).includes("tab-resume-tab7"));
  // A label that no stand-in holds, on a shell: the leader removes it soon.
  assert.ok(!ids(row(shell(), suspended, { hovered: true, front: ["fish"] })).includes("tab-resume-tab7"));
  // An agent that crashed after its first suspension: kept, at a shell, no label.
  assert.ok(ids(row(shell(), { [LABEL]: "pi" }, { hovered: true })).includes("tab-resume-tab7"));
});

// The whole sidebar, rendered at a fixed time: one tab whose pane p shows the
// terminal core (as terminals() lists it). Spawned tasks run at once; a sleep
// is recorded and resolved only by the test.
const NOW = 1_800_000_000_000;
function render(p, core, { now = NOW, hovered = false, collapsed = false } = {}) {
  world.spaces = [{ id: "s1", name: "project", machine: null, active: true, tabs: [{ id: "tab7", named: false, active: true, status: p.status }] }];
  world.panes = [p];
  world.terminals = [core];
  const sleeps = [];
  const timers = [];
  let notified = 0;
  const task = { notify: () => { notified++; }, sleep: (ms) => new Promise((resolve) => sleeps.push({ ms, resolve })), timer: { after() {}, every() {} } };
  const cx = { notify() {}, timer: { every: (ms) => timers.push(ms), after() {} }, spawn: (run) => { run(task); } };
  const view = new TabTree();
  view.init({}, cx);
  view.now = () => now;
  view.hovered = hovered ? "tab7" : null;
  world.layout = collapsed ? { id: "sidebar", size: { px: 60 } } : null;
  const tree = view.render(cx);
  return { tree, view, cx, sleeps, timers, notified: () => notified };
}
const shellArgv = ["/opt/homebrew/bin/fish", "-l"];
// A woken agent's terminal: the stand-in reported working at statusMs, then
// replaced itself with front (the argv of the process in front).
const wokenCore = (front, statusMs, { pid = 400, frontPid = pid, labels = { [LABEL]: "pi" } } = {}) => ({
  address: "t7", state: "live", pid, argv: ["/bin/sh", "/data/bin/herdr-shell"], labels,
  foreground: { pid: frontPid, argv: front, cwd: "/home/project", name: front[0] },
  status: "working", report: { app: "herdr-standin", state: "working" }, status_ms: statusMs, reported: true,
});
const spinner = (root) => nodes(root).some((n) => n.arg === "mods/workspace-chrome/spinner.svg");

test("waking… lasts while the woken agent has not reported, for less than 30 s after the wake", () => {
  const { tree } = render(standin("working"), wokenCore(["pi", "", ""], NOW - 29_999));
  assert.ok(texts(tree).includes("waking…"));
});

test("30 s after a wake whose agent never reported, a shell in front shows as a shell with ↻", () => {
  // root=shell: the agent exited and the wake's sh replaced itself with $SHELL.
  const core = wokenCore(shellArgv, NOW - 30_000);
  const { tree } = render(standin("working"), core, { hovered: true });
  assert.ok(!texts(tree).includes("waking…"));
  assert.ok(ids(tree).includes("tab-resume-tab7"));
  assert.ok(texts(tree).includes("fish"));
  assert.ok(!spinner(tree), "no working spinner from the stale report");
});

test("30 s after a wake whose agent never reported, the agent in front shows as a plain program, without ↻", () => {
  // Claude missed its status handshake: it runs, but never reports.
  for (const front of [["claude", "--resume", "abc"], ["/bin/sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh", "claude", "--resume", "abc"]]) {
    const { tree } = render(standin("working"), wokenCore(front, NOW - 30_000), { hovered: true });
    assert.ok(!texts(tree).includes("waking…"), front.join(" "));
    assert.ok(!ids(tree).includes("tab-resume-tab7"), front.join(" "));
    assert.ok(texts(tree).includes("claude"), front.join(" "));
  }
});

test("waking… holds while the stand-in itself is still in front, however long ago the wake began", () => {
  const core = wokenCore(["/data/bin/herdr-standin", "pi", "t7", ""], NOW - 10 * 60_000);
  assert.ok(texts(render(standin("working"), core).tree).includes("waking…"));
});

test("the narrow sidebar drops a stale waking report too", () => {
  const { tree } = render(standin("working"), wokenCore(shellArgv, NOW - 30_000), { collapsed: true });
  assert.ok(!spinner(tree));
});

test("a waking row re-renders by itself when its 30 s end, with a one-shot sleep and no new timer", async () => {
  const { sleeps, timers, notified } = render(standin("working"), wokenCore(["pi", "", ""], NOW - 10_000));
  assert.deepEqual(sleeps.map(({ ms }) => ms), [20_000]);
  assert.deepEqual(timers, [15000]);
  await new Promise((resolve) => setImmediate(resolve)); // the render's other tasks
  const before = notified();
  sleeps[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified(), before + 1);
  // A stale report and a terminal with no wake schedule nothing.
  assert.deepEqual(render(standin("working"), wokenCore(shellArgv, NOW - 30_000)).sleeps, []);
  assert.deepEqual(render(agent("idle"), { ...wokenCore(["pi"], NOW - 10_000), status: "idle", report: { app: "pi", state: "idle" } }).sleeps, []);
});

test("a live agent that reports its own status never shows 💤, even with a leftover suspension label", () => {
  const r = row(agent("idle"), suspended);
  assert.ok(!texts(r).includes("💤"));
  assert.equal(colorOf(r, "Fix the parser"), "FG");
});

test("💤 shows while herdr-shell is in front, before the stand-in reports, also under the old agent's report", () => {
  assert.ok(texts(row(shell(), suspended, { front: HERDR_SHELL_ARGV })).includes("💤"));
  // The agent's last report stays until the stand-in reports its own.
  assert.ok(texts(row(agent("idle"), suspended, { front: HERDR_SHELL_ARGV })).includes("💤"));
  assert.ok(texts(row(agent("idle"), suspended, { front: STANDIN_ARGV })).includes("💤"));
});

test("a live agent with a leftover label never shows 💤, also before it reports its status", () => {
  // Claude before its status handshake: the program table knows it, no report.
  const silent = { ...agent(), status: null, app: null, program: { key: "claude", name: "Claude", icon: "icons/claude.svg", tint: true, agent: true, shell: false } };
  const r = row(silent, suspended, { front: ["claude", "--resume", "abc"] });
  assert.ok(!texts(r).includes("💤"));
  assert.equal(colorOf(r, "Fix the parser"), "FG");
});

// The last-agent labeling (remember(), run from render): the label says which
// agent ↻ starts again. No timer: a new agent or program re-renders the mod.
async function labelPass(p, labels) {
  world.panes = [p];
  world.terminals = [{ address: "t7", state: "live", labels }];
  world.hc = [];
  const handlers = [];
  const cx = { notify() {}, timer: { every: (ms, run) => handlers.push({ ms, run }), after() {} }, spawn: (run) => { run(cx); } };
  const view = new TabTree();
  view.init({}, { ...cx, spawn() {} });
  assert.deepEqual(handlers.map(({ ms }) => ms), [15000], "no labeling timer");
  view.remember(cx);
  await new Promise((resolve) => setImmediate(resolve));
  return world.hc.filter(([command]) => command === "label");
}

test("a running agent is recorded as the terminal's last agent", async () => {
  assert.deepEqual(await labelPass(agent(), {}), [["label", "t7", `${LABEL}=pi`]]);
});

test("a stand-in is never recorded as the terminal's last agent", async () => {
  // The app's generic agent entry describes any program that reports.
  const reporting = { ...standin(), program: { key: "agent", name: "herdr-standin", icon: null, tint: false, agent: true, shell: false } };
  assert.deepEqual(await labelPass(reporting, { [LABEL]: "pi", [SUSPENDED]: record }), []);
  assert.deepEqual(await labelPass(reporting, { [LABEL]: "pi" }), []);
  // The suspension label is set, but the agent's old report is still there.
  assert.deepEqual(await labelPass({ ...agent(), program: { key: "agent", name: "agent", icon: null, tint: false, agent: true, shell: false } }, { [LABEL]: "pi", [SUSPENDED]: record }), []);
});
