import assert from "node:assert/strict";
import test from "node:test";
import { SUSPENDED, hasPicker, pickerLine, suspension } from "../herdr/mods/tab-tree/recipes.js";

const report = (agent, argv, cwd = "/project") => ({ agent, argv, cwd });

test("Claude's picker opens on the tab's name, else lists every session", () => {
  assert.equal(pickerLine("claude", { tab: "it's a tab" }), "claude --resume 'it'\\''s a tab'");
  assert.equal(pickerLine("claude", { tab: null }), "claude --resume");
  assert.equal(pickerLine("claude"), "claude --resume");
});

test("a picker for a report whose proof is missing runs in the report's folder", () => {
  assert.equal(pickerLine("claude", { tab: "tab", report: report("claude", ["claude", "--resume", "x"], "/it's") }), "cd '/it'\\''s' && claude --resume 'tab'");
});

test("Pi's picker keeps the report's launch options, and never reads another agent's report", () => {
  assert.equal(pickerLine("pi", { report: report("pi", ["pi", "--session", "/s.jsonl", "--thinking", "high"]) }), "cd '/project' && pi --resume '--thinking' 'high'");
  assert.equal(pickerLine("pi", { report: report("claude", ["claude", "--model", "haiku", "--resume", "x"]) }), "pi --resume");
  assert.equal(pickerLine("claude", { tab: "t", report: report("pi", ["pi", "--session", "/s.jsonl"]) }), "claude --resume 't'");
  assert.equal(pickerLine("pi"), "pi --resume");
});

test("an agent without a picker has none", () => {
  for (const agent of ["codex", "toString", "__proto__", ""]) {
    assert.equal(hasPicker(agent), false, agent);
    assert.equal(pickerLine(agent), null, agent);
  }
  assert.equal(hasPicker("claude") && hasPicker("pi"), true);
});

const suspended = { version: 1, agent: "pi", root: "shell", cwd: "/project", since: 1763300000000 };

test("a valid suspension record is read back", () => {
  assert.equal(SUSPENDED, "herdr.suspended");
  assert.deepEqual(suspension(JSON.stringify(suspended)), suspended);
  const claude = { version: 1, agent: "claude", root: "agent", cwd: "/", since: 0 };
  assert.deepEqual(suspension(JSON.stringify(claude)), claude);
  // Any report's agent key: the record keeps the agent its report named.
  const codex = { ...suspended, agent: "codex" };
  assert.deepEqual(suspension(JSON.stringify(codex)), codex);
});

test("malformed, future-version, relative-folder and control-containing suspension records are rejected", () => {
  for (const raw of [undefined, "", "null", "[]", "1", "not json", ...[
    { ...suspended, version: 2 }, { ...suspended, version: "1" }, { ...suspended, version: undefined },
    { ...suspended, agent: "Codex" }, { ...suspended, agent: "../pi" }, { ...suspended, agent: "" }, { ...suspended, agent: undefined },
    { ...suspended, root: "fish" }, { ...suspended, root: undefined },
    { ...suspended, cwd: "project" }, { ...suspended, cwd: "" }, { ...suspended, cwd: 7 }, { ...suspended, cwd: undefined },
    { ...suspended, cwd: "/pro\nject" }, { ...suspended, cwd: "/pro\x1b[31mject" }, { ...suspended, cwd: "/project\x7f" },
    { ...suspended, since: -1 }, { ...suspended, since: 1.5 }, { ...suspended, since: "1763300000000" }, { ...suspended, since: undefined },
  ].map(JSON.stringify)]) {
    assert.equal(suspension(raw), null, String(raw));
  }
});

test("the suspension record keeps only its own fields", () => {
  assert.deepEqual(suspension(JSON.stringify({ ...suspended, extra: "x" })), suspended);
});

test("the shared recipe module imports nothing, so the stand-in can build it without the Herdr host", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../herdr/mods/tab-tree/recipes.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m);
});
