import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { CLAUDE_OPTIONS, PI_RECOVERY, SESSION, shellQuote } from "../herdr/mods/tab-tree/recipes.js";
import { RESUME } from "../herdr/mods/tab-tree/resume-report.js";

test("shell quoting round-trips literals in installed supported shells", () => {
  const values = ["a b", "it's", "$(exit 3); `exit 4`", "back\\slash", "double\\\\slash", "\\'", "a\"b", ""];
  let checked = 0;
  for (const shell of ["sh", "bash", "zsh", "fish"]) {
    const result = spawnSync(shell, ["-c", `printf '%s\\n' ${values.map(shellQuote).join(" ")}`], { encoding: "utf8" });
    if (result.error?.code === "ENOENT") continue;
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(result.stdout, values.join("\n") + "\n", shell);
    checked++;
  }
  assert.ok(checked > 0);
});

// The mod's host module exists only in Herdr. Route that import to a stub;
// all production command construction and queue logic runs unchanged. The
// fake exec answers the proof checks by the script they run: files maps a
// path to its content (missing: not a file).
let calls = [];
let current;
let files;
const HOME = "/home/me";
const hostKey = Symbol.for("herdr.recovery.test-host");
globalThis[hostKey] = {
  hc: async (args) => {
    calls.push(["hc", args]);
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify(current) };
    return { code: 0, stdout: "" };
  },
  exec: async (command, args) => {
    calls.push(["exec", command, args]);
    const script = args[1];
    if (script.includes('"$HOME"')) return { code: 0, stdout: HOME };
    if (script.includes("for f in")) {
      const [dir, session] = args.slice(3);
      const folders = Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith(`/${session}.jsonl`)).map((p) => p.slice(dir.length + 1).split("/")[0]);
      return { code: 0, stdout: folders.map((f) => `${f}\n`).join("") };
    }
    const path = args[3];
    return Object.hasOwn(files, path) ? { code: 0, stdout: files[path].slice(0, Number(args[4])) } : { code: 1, stdout: "" };
  },
};
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "herdr") return { url: "data:text/javascript," + encodeURIComponent('export const { hc, exec } = globalThis[Symbol.for("herdr.recovery.test-host")];'), shortCircuit: true };
    return next(specifier, context);
  },
});
const { createRecovery, recoveryLine, recoverable } = await import("../herdr/mods/tab-tree/resume.js");
hook.deregister();
let recovery;
const recover = (address, target) => recovery.recover(cx, address, target);
const cx = { sleep: async () => assert.fail("a reported or Pi recovery must not wait or retry") };

const PI_FILE = "/sessions/it's a session.jsonl";
const pi = { version: 1, agent: "pi", session: "session-123", argv: ["pi", "--session", PI_FILE, "--thinking", "high"],
  cwd: "/project", proof: PI_FILE, pid: 41, at: 1 };
const claude = { version: 1, agent: "claude", session: "claude-id", argv: ["claude", "--model", "haiku", "--resume", "claude-id"],
  cwd: "/work/app", proof: "/home/me/.claude/projects/-work-app/claude-id.jsonl", pid: 42, at: 1 };
const resume = (report) => ({ [RESUME]: JSON.stringify(report) });
function reset() {
  recovery = createRecovery();
  calls = [];
  current = { state: "live", pid: 1, foreground: { pid: 1 }, reported: true };
  files = { [PI_FILE]: JSON.stringify({ type: "session", id: "session-123" }) + "\n", [claude.proof]: JSON.stringify({ sessionId: "claude-id" }) + "\n" };
}
const sent = () => calls.filter(([kind, args]) => kind === "hc" && args[0] === "send").map(([, args]) => args);

test("a report written by a plugin recovers with its exact argv, every word quoted, in its folder", async () => {
  reset();
  await recover("t41", { agent: "pi", labels: resume(pi), tab: "tab name" });
  await recover("t42", { agent: "claude", labels: resume(claude), tab: "tab name" });
  assert.deepEqual(sent(), [
    ["send", "t41", "cd '/project' && 'pi' '--session' '/sessions/it'\\''s a session.jsonl' '--thinking' 'high'"],
    ["send", "t42", "cd '/work/app' && 'claude' '--model' 'haiku' '--resume' 'claude-id'"],
  ]);
  assert.deepEqual(calls[0], ["exec", "sh", ["-c", 'test -f "$1" && head -c "$2" "$1"', "sh", PI_FILE, "4096"]]);
});

test("the report names the agent, whatever the last-agent label says", async () => {
  reset();
  assert.deepEqual(await recoveryLine(resume(claude), { agent: "pi" }), { agent: "claude", text: "cd '/work/app' && 'claude' '--model' 'haiku' '--resume' 'claude-id'" });
});

test("a report whose proof is missing or holds another session opens the agent's picker in its folder", async () => {
  for (const content of [undefined, "", JSON.stringify({ type: "session", id: "another-session" })]) {
    reset();
    if (content === undefined) files = {};
    else files[PI_FILE] = files[claude.proof] = content;
    await recover("t41", { agent: "pi", labels: resume(pi) });
    await recover("t42", { agent: "claude", labels: resume(claude), tab: "it's a tab" });
    assert.deepEqual(sent(), [
      ["send", "t41", "cd '/project' && pi --resume '--thinking' 'high'"],
      ["send", "t42", "cd '/work/app' && claude --resume 'it'\\''s a tab'"],
    ], String(content));
  }
});

test("without a report, ↻ opens the last agent's picker (spec Q1)", async () => {
  reset();
  current.reported = true;
  await recover("t1", { agent: "claude", labels: {}, tab: "it's a tab" });
  await recover("t2", { agent: "claude", labels: {} });
  await recover("t3", { agent: "pi", labels: {} });
  await recover("t4", { agent: "codex", labels: {} });
  await recover("t5", { agent: null, labels: {} });
  assert.deepEqual(sent(), [["send", "t1", "claude --resume 'it'\\''s a tab'"], ["send", "t2", "claude --resume"], ["send", "t3", "pi --resume"]]);
  assert.equal(calls.some(([kind]) => kind === "exec"), false);
});

test("an empty or broken herdr.resume means nothing to resume, and the old labels are not read", async () => {
  const old = { [PI_RECOVERY]: JSON.stringify({ version: 1, sessionId: "session-123", sessionFile: PI_FILE, cwd: "/project", args: [] }), [SESSION]: "claude-id" };
  for (const raw of ["", "not json", JSON.stringify({ ...pi, argv: [] })]) {
    reset();
    await recover("t41", { agent: "pi", labels: { ...old, [RESUME]: raw } });
    assert.deepEqual(sent(), [["send", "t41", "pi --resume"]], raw);
  }
});

test("a legacy Pi label still recovers its exact session", async () => {
  reset();
  const record = { version: 1, sessionId: "session-123", sessionFile: PI_FILE, cwd: "/project", args: ["--thinking", "high"] };
  await recover("t41", { agent: "pi", labels: { [PI_RECOVERY]: JSON.stringify(record), [SESSION]: "wrong-agent" } });
  assert.deepEqual(sent(), [["send", "t41", "cd '/project' && 'pi' '--session' '/sessions/it'\\''s a session.jsonl' '--thinking' 'high'"]]);
});

test("legacy Claude labels still recover in the shell's folder, once the transcript is found in a project folder", async () => {
  reset();
  const labels = { [SESSION]: "claude-id", [CLAUDE_OPTIONS]: JSON.stringify({ version: 1, options: ["--model", "haiku"] }) };
  await recover("t42", { agent: "claude", labels, tab: "tab", cwd: "/work/app" });
  files = {};
  await recover("t43", { agent: "claude", labels, tab: "tab", cwd: "/work/app" });
  assert.deepEqual(sent(), [
    ["send", "t42", "cd '/work/app' && 'claude' '--model' 'haiku' '--resume' 'claude-id'"],
    ["send", "t43", "cd '/work/app' && claude --resume 'tab'"],
  ]);
  // One process lists the folders that hold the transcript, not one per folder.
  const lists = calls.filter(([kind, , args]) => kind === "exec" && args[1].includes("for f in"));
  assert.deepEqual(lists[0][2].slice(3), [`${HOME}/.claude/projects`, "claude-id"]);
});

test("↻ is offered for a report or for an agent with a picker", () => {
  assert.equal(recoverable(resume(claude), { agent: null }), "claude");
  assert.equal(recoverable({}, { agent: "pi" }), "pi");
  assert.equal(recoverable({}, { agent: "codex" }), null);
  assert.equal(recoverable(resume({ ...pi, agent: "codex", argv: ["codex", "resume", "x"] }), { agent: "pi" }), "codex");
  assert.equal(recoverable({}, { agent: null }), null);
});

test("does not type into a terminal that is gone, no longer at a shell, or held by a stand-in", async () => {
  for (const state of [null, { state: "finished" }, { state: "live", pid: 1, foreground: { pid: 2 } },
    { state: "live", pid: 1, foreground: { pid: 1 }, labels: { "herdr.suspended": "{}" } }]) {
    reset();
    current = state;
    await recover("t41", { agent: "pi", labels: resume(pi) });
    assert.deepEqual(sent(), [], JSON.stringify(state));
  }
});

test("the real proof scripts: the head is bounded, a missing or empty file fails, and the listing finds only folders holding the transcript", async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "resume-proof-test-"));
  try {
    reset();
    await recover("t41", { agent: "pi", labels: resume(pi) });
    const [, command, args] = calls[0];
    const path = join(dir, "session ' quote.jsonl");
    const probe = () => spawnSync(command, [...args.slice(0, 3), path, "4096"], { encoding: "utf8" });
    assert.notEqual(probe().status, 0);
    await writeFile(path, "");
    assert.equal(probe().stdout, "");
    await writeFile(path, "x".repeat(10000));
    assert.equal(Buffer.byteLength(probe().stdout), 4096);

    reset();
    await recover("t42", { agent: "claude", labels: { [SESSION]: "claude-id" }, cwd: "/work/app" });
    const [, listCommand, listArgs] = calls.find(([kind, , a]) => kind === "exec" && a[1].includes("for f in"));
    for (const folder of ["-a", "-b b", "-c"]) await mkdir(join(dir, folder));
    await writeFile(join(dir, "-b b", "claude-id.jsonl"), "{}");
    await writeFile(join(dir, "-c", "other.jsonl"), "{}");
    const list = (d) => spawnSync(listCommand, [...listArgs.slice(0, 3), d, "claude-id"], { encoding: "utf8" });
    assert.equal(list(dir).stdout, "-b b\n");
    assert.equal(list(join(dir, "missing")).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
