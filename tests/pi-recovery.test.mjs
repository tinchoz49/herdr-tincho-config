import assert from "node:assert/strict";
import test from "node:test";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import extension from "../pi/extensions/herdr-recovery/index.js";
import { recoveryArgs } from "../pi/extensions/herdr-recovery/args.js";
import { parseReport } from "../herdr/mods/tab-tree/resume-report.js";

const cwd = "/projects/example";

test("preserves reusable options, aliases, repetitions and relative resource paths", () => {
  assert.deepEqual(recoveryArgs([
    "--provider", "openai", "--model", "model", "--thinking", "high",
    "-t", "-write", "-xt", "bash", "-e", "./custom.ts", "-e", "builtin:mcp",
    "--skill", "~/skills", "--theme", "dark.json", "--prompt-template", "prompts",
    "--session-dir", "sessions", "-ne", "-nbt", "--no-mcp", "-na", "--offline",
  ], cwd), [
    "--provider", "openai", "--model", "model", "--thinking", "high",
    "--tools", "-write", "--exclude-tools", "bash", "--extension", `${cwd}/custom.ts`, "--extension", "builtin:mcp",
    "--skill", `${homedir()}/skills`, "--theme", `${cwd}/dark.json`, "--prompt-template", `${cwd}/prompts`,
    "--session-dir", `${cwd}/sessions`, "--no-extensions", "--no-builtin-tools", "--no-mcp", "--no-approve", "--offline",
  ]);
});

test("does not replay prompts, attachments, old selectors or names", () => {
  assert.deepEqual(recoveryArgs([
    "--session", "old", "--session-id", "old-id", "--fork", "parent", "--name", "old-name",
    "--continue", "-r", "--no-session", "do the task", "@input.md", "--thinking", "high",
    "--", "--model", "this is a prompt",
  ], cwd), ["--thinking", "high"]);
});

test("omits credentials and inline system prompts without leaking flag-like values", () => {
  const result = recoveryArgs(["--api-key", "--model", "--system-prompt", "private", "--append-system-prompt", "private2", "--thinking", "high"], cwd);
  assert.deepEqual(result, ["--thinking", "high"]);
});

test("unknown flags and trust approvals stop capture rather than guessing arity", () => {
  for (const flag of ["--custom-token", "--custom-token=secret", "--approve", "-a"]) {
    assert.deepEqual(recoveryArgs(["--offline", flag, "--model", "secret"], cwd), ["--offline"]);
  }
});

test("rejects control characters and missing values", () => {
  assert.deepEqual(recoveryArgs(["--model", "bad\nvalue", "--thinking"], cwd), []);
});

const dir = mkdtempSync(join(tmpdir(), "pi-recovery-"));
// A session file that exists on disk, as Pi has it after the first message.
function sessionFile(name) {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `{"id":"${name}"}\n`);
  return file;
}

function harness({ terminal = "t42", argv = [], exec, file = sessionFile("current") } = {}) {
  const handlers = new Map();
  const calls = [];
  const notices = [];
  const oldArgv = process.argv;
  const oldTerminal = process.env.HC_TERMINAL_ID;
  process.argv = ["node", "pi", ...argv];
  if (terminal === null) delete process.env.HC_TERMINAL_ID;
  else process.env.HC_TERMINAL_ID = terminal;
  try {
    extension({
      on: (event, fn) => handlers.set(event, fn),
      exec: async (...args) => { calls.push(args); return exec ? exec(...args) : { code: 0 }; },
    });
  } finally {
    process.argv = oldArgv;
    if (oldTerminal === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = oldTerminal;
  }
  const ctx = {
    mode: "tui", cwd,
    sessionManager: { getSessionFile: () => file, getSessionId: () => "current" },
    ui: { notify: (...args) => notices.push(args) },
  };
  return { handlers, calls, notices, ctx, emit: (event, data = {}) => handlers.get(event)?.(data, ctx) };
}

const PREFIX = "herdr.resume=";
// The value of the herdr.resume label in the call `n` (default: the last).
const written = (h, n = h.calls.length - 1) => h.calls[n][1][3].slice(PREFIX.length);
const reportAt = (h, n) => JSON.parse(written(h, n));

// The contract with the mod: every non-empty value written is accepted by the
// reader the recovery arrow, the suspension rules and the stand-in use.
function assertAccepted(h) {
  for (let n = 0; n < h.calls.length; n++) {
    const value = written(h, n);
    if (value) assert.ok(parseReport(value), `the mod rejects call ${n}: ${value}`);
  }
}

test("records the resume report and the agent with one shell-free command and bounded timeout", async () => {
  const file = sessionFile("current");
  const h = harness({ argv: ["--thinking", "high", "original task"], file });
  const before = Date.now();
  await h.emit("session_start", { reason: "startup" });
  const [command, args, options] = h.calls[0];
  assert.equal(command, "hc");
  assert.deepEqual(args.slice(0, 3), ["label", "t42", "herdr.last-agent=pi"]);
  assert.equal(args.length, 5);
  assert.ok(args[3].startsWith(PREFIX));
  assert.equal(args[4], "herdr.pi-recovery=", "the old label, which names an older conversation, is removed");
  const report = reportAt(h, 0);
  assert.ok(report.at >= before && report.at <= Date.now());
  assert.deepEqual(report, {
    version: 1, agent: "pi", session: "current", argv: ["pi", "--session", file, "--thinking", "high"],
    cwd, proof: file, pid: process.pid, at: report.at,
  });
  assert.equal(options.timeout, 3000);
  assertAccepted(h);
  await h.emit("agent_start");
  assert.equal(h.calls.length, 1, "an unchanged report does not cause a subprocess on every turn");
  assert.equal(h.handlers.has("session_shutdown"), false, "exit must leave the resume report intact");
});

test("never writes a value into the old herdr.pi-recovery label, only removes it", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.deepEqual(h.calls.flatMap(([, args]) => args).filter((a) => a.startsWith("herdr.pi-recovery")), ["herdr.pi-recovery="]);
});

test("a new session writes an empty report until its file exists, then the report", async () => {
  const file = join(dir, "new-session.jsonl");
  const h = harness({ file });
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1][2], "herdr.last-agent=pi");
  assert.equal(written(h, 0), "");
  await h.emit("agent_start");
  assert.equal(h.calls.length, 1, "still no file: nothing new to write");
  // Pi writes the file with the first message, after agent_start: the run's
  // settling writes the report.
  writeFileSync(file, "{}\n");
  await h.emit("agent_settled");
  assert.equal(h.calls.length, 2);
  assert.equal(reportAt(h, 1).proof, file);
  assert.deepEqual(reportAt(h, 1).argv, ["pi", "--session", file]);
  assertAccepted(h);
});

test("preserves --no-sandbox and following options without a warning", async () => {
  const argv = ["--no-sandbox", "--model", "some-model", "--thinking", "high"];
  assert.deepEqual(recoveryArgs(argv, cwd), argv);
  const h = harness({ argv });
  await h.emit("session_start", { reason: "startup" });
  assert.deepEqual(reportAt(h, 0).argv.slice(3), argv);
  assert.deepEqual(h.notices, []);
  assertAccepted(h);
});

test("omitted launch options do not produce a warning on startup or reload", async () => {
  for (const argv of [["--custom-option", "value"], ["--api-key", "secret"], ["--system-prompt", "private"], ["--approve"]]) {
    const h = harness({ argv });
    await h.emit("session_start", { reason: "startup" });
    await h.emit("session_start", { reason: "reload" });
    assert.deepEqual(reportAt(h, 0).argv.slice(3), []);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.notices, []);
    assertAccepted(h);
  }
});

test("new, resume, fork and reload update the session reference", async () => {
  const h = harness({ argv: ["--model", "m"] });
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    const file = sessionFile(reason);
    h.ctx.sessionManager.getSessionId = () => reason;
    h.ctx.sessionManager.getSessionFile = () => file;
    await h.emit("session_start", { reason });
    const report = reportAt(h);
    assert.equal(report.session, reason);
    assert.equal(report.proof, file);
    assert.deepEqual(report.argv, ["pi", "--session", file, "--model", "m"]);
  }
  assert.equal(h.calls.length, 5);
  assertAccepted(h);
});

test("ephemeral sessions clear a previous resume report", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.ok(written(h, 0));
  h.ctx.sessionManager.getSessionFile = () => undefined;
  await h.emit("session_start", { reason: "new" });
  assert.equal(h.calls.at(-1)[1][3], PREFIX);
  await h.emit("agent_start");
  assert.equal(h.calls.length, 2, "an unchanged empty value is not rewritten");
  assertAccepted(h);
});

test("does nothing outside Herdr or in nested non-interactive Pi modes", async () => {
  assert.equal(harness({ terminal: null }).handlers.size, 0);
  const h = harness();
  for (const mode of ["print", "json", "rpc"]) {
    h.ctx.mode = mode;
    await h.emit("session_start");
    await h.emit("agent_start");
  }
  assert.equal(h.calls.length, 0);
});

test("failed saves warn without exposing output and retry on the next turn", async () => {
  let attempt = 0;
  const h = harness({ exec: () => {
    if (++attempt === 1) throw new Error("private output");
    return { code: attempt === 2 ? 1 : 0, stderr: "private output" };
  } });
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_start");
  await h.emit("agent_start");
  assert.equal(h.calls.length, 3);
  assert.equal(h.notices.length, 1);
  assert.equal(JSON.stringify(h.notices).includes("private output"), false);
});
