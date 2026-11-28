import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_OPTIONS, PI_RECOVERY, SESSION } from "../herdr/mods/tab-tree/recipes.js";
import { RESUME, legacyReport, parseReport, proofHeld, proofMissing, reportOf, resumeLine } from "../herdr/mods/tab-tree/resume-report.js";

// A report as Pi's extension writes it.
const piReport = {
  version: 1, agent: "pi", session: "0193b6c2", cwd: "/work/app", proof: "/home/me/.pi/sessions/one.jsonl",
  argv: ["pi", "--session", "/home/me/.pi/sessions/one.jsonl", "--model", "sonnet"], pid: 4123, at: 1795614571208,
};
const raw = (extra = {}) => JSON.stringify({ ...piReport, ...extra });

test("a report that follows every rule is read whole", () => {
  assert.deepEqual(parseReport(raw()), piReport);
  // An empty word is allowed after the program (an option's empty value).
  assert.deepEqual(parseReport(raw({ argv: ["/usr/local/bin/pi", "--tools", ""] }))?.argv, ["/usr/local/bin/pi", "--tools", ""]);
});

test("an empty, unreadable or unversioned label is no report", () => {
  for (const value of [undefined, "", "{", "null", "[]", raw({ version: 2 }), JSON.stringify({ ...piReport, version: undefined })]) {
    assert.equal(parseReport(value), null, String(value));
  }
});

test("each rule of the format, broken, makes the whole report missing", () => {
  const broken = {
    "agent with capitals": { agent: "Pi" },
    "agent missing": { agent: undefined },
    "session empty": { session: "" },
    "session with a slash": { session: "../x" },
    "session with a newline": { session: "a\nb" },
    "argv not a list": { argv: "pi --session x" },
    "argv empty": { argv: [] },
    "relative program": { argv: ["./pi", "--session", "x"] },
    "program with a space": { argv: ["p i"] },
    "empty program": { argv: ["", "x"] },
    "control character in a word": { argv: ["pi", "--model", "a\u0007"] },
    "a word that is not a string": { argv: ["pi", 7] },
    "relative cwd": { cwd: "work" },
    "missing proof": { proof: undefined },
    "relative proof": { proof: "one.jsonl" },
    "pid zero": { pid: 0 },
    "pid not an integer": { pid: 1.5 },
    "negative time": { at: -1 },
  };
  for (const [name, extra] of Object.entries(broken)) assert.equal(parseReport(raw(extra)), null, name);
});

test("unknown keys are ignored, and never reach the caller", () => {
  assert.deepEqual(parseReport(raw({ extra: "x" })), piReport);
});

test("the line for ↻ quotes every word, the program and the folder too", () => {
  assert.equal(resumeLine({ ...piReport, cwd: "/it's here", argv: ["pi", "--session", "/s/a b.jsonl"] }),
    "cd '/it'\\''s here' && 'pi' '--session' '/s/a b.jsonl'");
});

test("herdr.resume wins over the old labels; without it the old labels make the report", () => {
  const pi = JSON.stringify({ version: 1, sessionId: "old", sessionFile: "/s/old.jsonl", cwd: "/p", args: ["--thinking", "high"] });
  assert.equal(reportOf({ [RESUME]: raw(), [PI_RECOVERY]: pi })?.session, "0193b6c2");
  assert.equal(reportOf({ [PI_RECOVERY]: pi })?.session, "old");
  // An empty or broken herdr.resume is "nothing to resume": the old labels name an older conversation.
  assert.equal(reportOf({ [RESUME]: "", [PI_RECOVERY]: pi }), null);
  assert.equal(reportOf({ [RESUME]: "{", [PI_RECOVERY]: pi }), null);
  assert.equal(reportOf(undefined), null);
  assert.equal(reportOf({}), null);
});

test("an old Pi record starts Pi as its recipe did: the session file, else the id, with its launch options", () => {
  const record = { version: 1, sessionId: "session-123", sessionFile: "/sessions/one.jsonl", cwd: "/project", args: ["--thinking", "high"] };
  assert.deepEqual(legacyReport({ [PI_RECOVERY]: JSON.stringify(record) }), {
    version: 1, agent: "pi", session: "session-123", argv: ["pi", "--session", "/sessions/one.jsonl", "--thinking", "high"],
    cwd: "/project", proof: "/sessions/one.jsonl", pid: null, at: 0, legacy: true,
  });
  const idOnly = legacyReport({ [PI_RECOVERY]: JSON.stringify({ ...record, sessionFile: null }) });
  assert.deepEqual([idOnly?.argv, idOnly?.proof], [["pi", "--session", "session-123", "--thinking", "high"], null]);
});

test("old Claude labels start Claude with its options before --resume, in the folder the caller gives", () => {
  const labels = { [SESSION]: "claude-session", [CLAUDE_OPTIONS]: JSON.stringify({ version: 1, options: ["--model", "haiku"] }) };
  assert.deepEqual(legacyReport(labels, { cwd: "/work/app" }), {
    version: 1, agent: "claude", session: "claude-session", argv: ["claude", "--model", "haiku", "--resume", "claude-session"],
    cwd: "/work/app", proof: null, pid: null, at: 0, legacy: true,
  });
  // Without a folder, or with options set by hand, it is no report, or has no options.
  assert.equal(legacyReport(labels), null);
  assert.deepEqual(legacyReport({ [SESSION]: "s", [CLAUDE_OPTIONS]: JSON.stringify({ version: 1, options: ["--api-key", "x"] }) }, { cwd: "/w" })?.argv,
    ["claude", "--resume", "s"]);
});

test("the agent a caller expects picks between old labels for two agents", () => {
  const labels = { [SESSION]: "c", [PI_RECOVERY]: JSON.stringify({ version: 1, sessionId: "p", sessionFile: null, cwd: "/p", args: [] }) };
  assert.equal(legacyReport(labels, { agent: "claude", cwd: "/w" })?.agent, "claude");
  assert.equal(legacyReport(labels, { agent: "pi", cwd: "/w" })?.agent, "pi");
});

// Files as the proof check reads them: path -> content.
const disk = (files, home = "/home/me") => ({
  home,
  readHead: async (path, bytes) => Object.hasOwn(files, path) ? files[path].slice(0, bytes) : null,
  list: async (dir) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]))],
});

test("the proof holds while the file exists and names the session in its first 4 KB", async () => {
  const report = parseReport(raw());
  assert.equal(await proofHeld(report, disk({ [piReport.proof]: '{"type":"session","id":"0193b6c2"}\n' })), true);
  assert.equal(await proofHeld(report, disk({})), false, "missing");
  assert.equal(await proofHeld(report, disk({ [piReport.proof]: '{"type":"session","id":"another"}\n' })), false, "replaced");
  assert.equal(await proofHeld(report, disk({ [piReport.proof]: `${"x".repeat(4096)}0193b6c2` })), false, "past 4 KB");
  assert.equal(await proofHeld(null, disk({})), false);
  // A failing read counts as missing.
  assert.equal(await proofHeld(report, { home: "/h", list: async () => [], readHead: async () => { throw new Error("EACCES"); } }), false);
});

test("an old Claude report is held by a transcript in any project folder; an old Pi record without a file never is", async () => {
  const claude = legacyReport({ [SESSION]: "abc" }, { cwd: "/w" });
  assert.equal(await proofHeld(claude, disk({ "/home/me/.claude/projects/-w/abc.jsonl": '{"type":"summary"}' })), true);
  assert.equal(await proofHeld(claude, disk({ "/home/me/.claude/projects/-w/other.jsonl": "abc" })), false);
  const idOnly = legacyReport({ [PI_RECOVERY]: JSON.stringify({ version: 1, sessionId: "p", sessionFile: null, cwd: "/p", args: [] }) });
  assert.equal(await proofHeld(idOnly, disk({})), false);
});

test("the reason a report cannot be resumed names what is missing", async () => {
  assert.equal(await proofMissing(null, disk({})), "it has no resume report");
  assert.equal(await proofMissing(parseReport(raw()), disk({})), `its conversation file ${piReport.proof} is missing or holds another session`);
  assert.equal(await proofMissing(legacyReport({ [SESSION]: "abc" }, { cwd: "/w" }), disk({})), "its session abc has no conversation on disk");
  assert.equal(await proofMissing(parseReport(raw()), disk({ [piReport.proof]: "0193b6c2" })), null);
});
