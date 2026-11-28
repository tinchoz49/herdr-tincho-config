import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { LABEL, PI_RECOVERY, SUSPENDED } from "../herdr/mods/tab-tree/recipes.js";

// How tab-tree runs the suspension policy: from render, through cx.spawn and
// the task's cx.timer.after. Only the Herdr host and the UI kit are fakes.
const NOW = Date.now();
const record = JSON.stringify({ version: 1, sessionId: "s", sessionFile: "/s.jsonl", cwd: "/p", args: [] });
const standin = {
  address: "t7", state: "live", pid: 400, argv: ["/bin/sh"], turn: 1,
  foreground: { pid: 400, argv: ["herdr-standin", "pi", "t7", ""], cwd: "/p" },
  status: "idle", report: { app: "herdr-standin", state: "idle" }, status_ms: NOW, program: { key: "herdr-standin", agent: false, shell: false },
  labels: { [LABEL]: "pi", [PI_RECOVERY]: record, [SUSPENDED]: JSON.stringify({ version: 1, agent: "pi", root: "agent", cwd: "/p", since: NOW }) },
};
const store = new Map();
const calls = [];
const host = {
  spaces: () => [], machines: () => [], run() {}, openOverlay() {}, theme: () => ({}), home: () => "/fake", layout: () => null,
  panes: () => [{ pane: "pane-7", terminal: "t7", tab: "tab-7", focused: true }],
  terminals: () => structuredClone([standin]),
  focused: () => ({ space: "s", tab: "tab-7", pane: "pane-7", terminal: "t7", shown: null, agent: null, cwd: "/p" }),
  settings: () => ({}),
  shared: (key) => structuredClone(store.get(key)),
  setShared: (key, value) => { store.set(key, structuredClone(value)); return null; },
  readTextFile: async () => null,
  exec: async (...args) => { calls.push(["exec", ...args]); return { code: 1, stdout: "", stderr: "" }; },
  hc: async (args) => { calls.push(["hc", ...args]); return { code: 0, stdout: "{}", stderr: "" }; },
};
const key = Symbol.for("herdr.suspension-mod.test-host");
globalThis[key] = host;
globalThis.localStorage = { getItem: () => null, setItem() {} };
const hook = registerHooks({ resolve(specifier, context, next) {
  const sources = {
    herdr: `export const { ${Object.keys(host).join(", ")} } = globalThis[Symbol.for("herdr.suspension-mod.test-host")];`,
    "gpui-kit": "export class View {} export const div = null, image = null, svg = null;",
    "gpui-base": "export const v_flex = null, h_flex = null;",
  };
  if (sources[specifier]) return { url: "data:text/javascript," + encodeURIComponent(sources[specifier]), shortCircuit: true };
  return next(specifier, context);
} });
const { default: TabTree } = await import("../herdr/mods/tab-tree/main.js");
const { SUSPEND_WINDOWS } = await import("../herdr/mods/tab-tree/suspend-policy.js");
hook.deregister();

// A context whose tasks and timers are recorded; tasks run at once.
function context() {
  const cx = {
    tasks: [], every: [], after: [],
    notify() {},
    spawn(body) { cx.tasks.push(Promise.resolve().then(() => body(cx))); return { cancel() {} }; },
    timer: {
      every: (ms, handler) => { cx.every.push({ ms, handler }); return { cancel() {} }; },
      after: (ms, handler) => { const timer = { ms, handler, cancelled: false, cancel() { timer.cancelled = true; } }; cx.after.push(timer); return timer; },
    },
  };
  return cx;
}
const settle = async (cx) => { for (let i = 0; i < 5; i++) await Promise.all(cx.tasks); };

test("the policy adds one 15 s timer to tab-tree; focus wakes nothing, a click on the tab wakes its stand-in", async () => {
  const view = new TabTree();
  const initCx = context();
  view.init({}, initCx);
  assert.deepEqual(initCx.every.map(({ ms }) => ms), [15000]);
  // Render observes; its task publishes, and arms no timer for the focused stand-in.
  const renderCx = context();
  view.observeSuspension(renderCx);
  assert.equal(calls.length, 0, "no command from render");
  await settle(renderCx);
  assert.ok(store.get(SUSPEND_WINDOWS)?.[view.suspender.id]);
  assert.equal(renderCx.after.length, 0);
  // A second render with nothing new starts no task.
  const again = context();
  view.observeSuspension(again);
  assert.equal(again.tasks.length, 0);
  assert.deepEqual(calls, []);
  // A click on its tab row: Enter in the stand-in.
  await view.wakeTab("tab-7");
  assert.deepEqual(calls, [["hc", "keys", "t7", "enter"]]);
  view.close();
  assert.equal(store.get(SUSPEND_WINDOWS)?.[view.suspender.id], undefined);
});
