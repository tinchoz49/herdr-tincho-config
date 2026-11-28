import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_OPTIONS } from "../herdr/mods/tab-tree/recipes.js";
import { claudeOptions, claudeOptionsRecord } from "../herdr/mods/tab-tree/claude-options.js";

// The words after the program, as Claude's foreground argv shows them (F2).
test("the launch options seen for F2 are kept, and the prompt after them is dropped", () => {
  assert.deepEqual(claudeOptions(["--model", "haiku", "--permission-mode", "default", "--add-dir", "/tmp", "--", "<prompt>"], "/work"),
    ["--model", "haiku", "--permission-mode", "default", "--add-dir", "/tmp"]);
});

test("tool and folder lists keep every value, under one canonical name", () => {
  assert.deepEqual(claudeOptions(["--allowedTools", "Bash(git *)", "Edit", "--disallowedTools", "WebFetch", "--tools", "Read", "--model", "opus"]),
    ["--allowed-tools", "Bash(git *)", "Edit", "--disallowed-tools", "WebFetch", "--tools", "Read", "--model", "opus"]);
  assert.deepEqual(claudeOptions(["--allowed-tools", "Edit", "--disallowed-tools", "Bash", "--"]),
    ["--allowed-tools", "Edit", "--disallowed-tools", "Bash"]);
  assert.deepEqual(claudeOptions(["--add-dir", "/a", "/b c", "--add-dir", "/d", "--"]), ["--add-dir", "/a", "/b c", "--add-dir", "/d"]);
});

test("a list at the end is dropped, because Claude takes a trailing prompt into it", () => {
  assert.deepEqual(claudeOptions(["--model", "haiku", "--add-dir", "/tmp", "fix the secret bug"], "/work"), ["--model", "haiku"]);
  assert.deepEqual(claudeOptions(["--tools", "Read"]), []);
  assert.deepEqual(claudeOptions(["--add-dir"]), []);
});

test("an empty list is dropped, and an empty tool list is kept", () => {
  assert.deepEqual(claudeOptions(["--add-dir", "--model", "opus"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--tools", "", "--"]), ["--tools", ""]);
});

test("relative folders are resolved against the launch folder; without one they are dropped", () => {
  assert.deepEqual(claudeOptions(["--add-dir", ".", "../lib", "sub/./x/", "/abs", "~/notes", "--plugin-dir", "plugins/mine", "--"], "/work/app"),
    ["--add-dir", "/work/app", "/work/lib", "/work/app/sub/x", "/abs", "~/notes", "--plugin-dir", "/work/app/plugins/mine"]);
  assert.deepEqual(claudeOptions(["--add-dir", "../../../..", "--"], "/work"), ["--add-dir", "/"]);
  for (const cwd of [undefined, null, "", "relative", "/bad\ncwd"]) {
    assert.deepEqual(claudeOptions(["--add-dir", "lib", "/abs", "--plugin-dir", "p", "--model", "opus"], cwd), ["--add-dir", "/abs", "--model", "opus"], String(cwd));
  }
});

test("reusable switches are kept", () => {
  const flags = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--bare", "--brief",
    "--chrome", "--no-chrome", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--ide", "--restricted",
    "--safe-mode", "--strict-mcp-config", "--verbose"];
  assert.deepEqual(claudeOptions([...flags, "--model", "opus"]), [...flags, "--model", "opus"]);
});

test("prompts, system prompts, credentials and session selectors are dropped, and capture goes on after them", () => {
  const secrets = [
    "fix the secret bug", "@notes.md",
    "--system-prompt", "You are secret", "--append-system-prompt", "--looks-like-an-option",
    "--system-prompt-file", "/p.txt", "--append-system-prompt-file", "/q.txt",
    "--agents", '{"r":{"prompt":"secret"}}', "--settings", '{"apiKeyHelper":"secret"}',
    "--session-id", "0b2e…", "-n", "my name", "--name", "my name", "-c", "--continue", "--fork-session",
    "--mcp-config", "/mcp.json", '{"env":{"TOKEN":"secret"}}', "--betas", "beta-1", "--file", "file_abc:doc.txt",
    "--plugin-url", "https://token@host/p.zip", "--debug-file", "/log", "--environment", "ccpool_1",
    "--remote-control-session-name-prefix", "box",
  ];
  const kept = claudeOptions(["--model", "opus", ...secrets, "--effort", "high", "--"]);
  assert.deepEqual(kept, ["--model", "opus", "--effort", "high"]);
  assert.doesNotMatch(JSON.stringify(kept), /secret|name|0b2e|token|beta|file|mcp|log|ccpool|box/i);
});

test("a kept option that only works with a dropped one is dropped too", () => {
  assert.deepEqual(claudeOptions(["--strict-mcp-config", "--mcp-config", "/m.json", "--model", "opus", "--"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--agent", "rev", "--agents", '{"rev":{}}', "--verbose"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--settings", "/s.json", "--bare", "--verbose"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--strict-mcp-config", "--agent", "rev", "--bare", "--"]), ["--strict-mcp-config", "--agent", "rev", "--bare"]);
});

test("options with an optional value stop capture, so their value or a prompt is never taken as an option", () => {
  for (const stop of ["-r", "--resume", "-d", "--debug", "-w", "--worktree", "--remote-control", "--teleport", "--from-pr",
    "--cloud", "--prompt-suggestions", "--tmux", "--resume=abc", "--debug=hooks"]) {
    assert.deepEqual(claudeOptions(["--model", "opus", stop, "--verbose", "--effort", "high"]), ["--model", "opus"], stop);
  }
});

test("capture stops at an unknown option instead of guessing its arity, and at --", () => {
  assert.deepEqual(claudeOptions(["--model", "opus", "--some-new-option", "--verbose", "--effort", "high"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--model", "opus", "-cv", "--verbose"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--model", "opus", "-p", "--verbose"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--model", "opus", "--", "--verbose", "--effort", "high"]), ["--model", "opus"]);
  assert.deepEqual(claudeOptions(["--verbose=yes", "--model", "opus"]), []);
});

test("control characters stop capture, in options and in values", () => {
  assert.deepEqual(claudeOptions(["--verbose", "--model", "op\x1bus", "--effort", "high"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--verbose", "--allowed-tools", "Edit", "Ba\nsh", "--model", "opus"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--verbose", "--mo\x7fdel", "opus"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--verbose", 7, "--model", "opus"]), ["--verbose"]);
  assert.deepEqual(claudeOptions(["--verbose", "--model"]), ["--verbose"]);
});

test("the --name=value form is read like two words", () => {
  assert.deepEqual(claudeOptions(["--model=opus", "--add-dir=/x", "prompt", "--system-prompt=secret", "--allowedTools=Edit", "--"]),
    ["--model", "opus", "--add-dir", "/x", "--allowed-tools", "Edit"]);
  assert.deepEqual(claudeOptions(["--plugin-dir=p", "--model=", "--"], "/w"), ["--plugin-dir", "/w/p", "--model", ""]);
});

test("the old label holds a versioned record of the options", () => {
  assert.equal(CLAUDE_OPTIONS, "herdr.claude-options");
  const raw = JSON.stringify({ version: 1, options: ["--model", "haiku", "--add-dir", "/work/lib"] });
  assert.deepEqual(claudeOptionsRecord(raw), ["--model", "haiku", "--add-dir", "/work/lib"]);
});

test("malformed, future-version and control-containing records are ignored", () => {
  for (const raw of [undefined, null, "", "null", "[]", "1", "not json", ...[
    { version: 2, options: ["--model", "opus"] }, { version: "1", options: ["--model", "opus"] }, { options: ["--model", "opus"] },
    { version: 1 }, { version: 1, options: "--model opus" }, { version: 1, options: [7] }, { version: 1, options: {} },
    { version: 1, args: ["--model", "opus"] },
    { version: 1, options: ["--model", "op\nus"] }, { version: 1, options: ["--model", "op\x1bus"] }, { version: 1, options: ["--model\x7f", "opus"] },
  ].map(JSON.stringify)]) {
    assert.equal(claudeOptionsRecord(raw), null, String(raw));
  }
});

test("a record with anything but kept options is ignored, so a label written by hand cannot add a secret or a prompt", () => {
  for (const args of [
    ["--settings", '{"apiKeyHelper":"x"}'], ["--model", "opus", "--mcp-config", "/m.json"], ["--system-prompt", "x"],
    ["--allowedTools", "Edit"], ["--add-dir", "relative"], ["--model", "opus", "prompt"], ["--resume", "id"],
    ["--model"], ["--add-dir"], ["--model", "opus", "--", "prompt"],
    ["--strict-mcp-config", "--mcp-config", "/m.json"],
  ]) {
    assert.equal(claudeOptionsRecord(JSON.stringify({ version: 1, options: args })), null, JSON.stringify(args));
  }
  assert.deepEqual(claudeOptionsRecord(JSON.stringify({ version: 1, options: [] })), []);
  assert.deepEqual(claudeOptionsRecord(JSON.stringify({ version: 1, options: ["--tools", "", "--add-dir", "/a", "~/b", "--verbose"] })),
    ["--tools", "", "--add-dir", "/a", "~/b", "--verbose"]);
});

test("the allowlist module imports nothing, so the reporter and the stand-in can build it without the Herdr host", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../herdr/mods/tab-tree/claude-options.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m);
});
