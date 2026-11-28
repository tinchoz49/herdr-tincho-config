import assert from "node:assert/strict";
import test from "node:test";
import { isClaude } from "../herdr/mods/tab-tree/claude-process.js";

const terminal = (key, extra = {}) => ({
  address: "t1", state: "live", pid: 10, argv: ["zsh"],
  foreground: { pid: 11, argv: [key] },
  program: { key, agent: true, shell: false }, report: { app: key, state: "idle" },
  labels: { "herdr.last-agent": "claude" }, ...extra,
});

test("other agents and shells are not Claude, even with old Claude labels", () => {
  for (const key of ["pi", "codex", "opencode", "shell"]) {
    const t = terminal(key, { report: key === "shell" ? null : { app: key }, program: { key, shell: key === "shell", agent: key !== "shell" },
      labels: { "herdr.last-agent": "claude", "herdr.claude-session": "old" } });
    assert.equal(isClaude(t), false, key);
  }
});

test("Claude program, reported app, and reliable command-position argv are Claude", () => {
  const cases = [
    terminal("claude", { report: null }),
    terminal("claude", { report: { app: "claude-code", state: "working" } }),
    terminal("agent", { report: { app: "claude-code" } }),
    terminal("shell", { report: { app: "claude-code" } }),
    terminal("claude", { program: null, report: null }),
    terminal("agent", { report: null, foreground: { pid: 11, argv: ["/usr/local/bin/claude"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["node", "/pkg/@anthropic-ai/claude-code/cli.js", "--resume", "old"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["bun", "/bin/claude.js"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["zsh", "-ic", '"$@"; exec "$0" -i', "zsh", "claude"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["fish", "-ic", "command $argv[2..]; exec $argv[1] -i", "fish", "claude"] } }),
    terminal("agent", { program: null, report: null, foreground: null, argv: ["claude"] }),
    // hc get keeps the OSC 7501 report in status.
    terminal("agent", { report: undefined, status: { app: "claude" } }),
  ];
  for (const t of cases) assert.equal(isClaude(t), true, JSON.stringify(t));
});

test("argv fallback cannot turn arguments, stale launch commands, or recovery labels into Claude", () => {
  const cases = [
    terminal("claude", { report: { app: "pi" } }),
    terminal("pi", { program: null, argv: ["claude"], foreground: null }),
    terminal("codex", { program: null, argv: ["claude"], foreground: null }),
    terminal("shell", { program: null, report: null }),
    terminal("pi", { report: null, argv: ["claude"] }),
    terminal("codex", { report: null, argv: ["claude"] }),
    terminal("shell", { report: null, argv: ["claude"] }),
    terminal("agent", { report: { app: "unrelated" }, argv: ["claude"] }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["node", "/pkg/pi.js", "claude"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["echo", "claude"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["zsh", "-c", "echo claude"] } }),
    terminal("program", { report: null, foreground: { pid: 11, argv: ["node", "--eval", "claude"] } }),
    terminal("program", { report: null, argv: ["claude"], foreground: { pid: 11, argv: [] } }),
    terminal("agent", { report: null, program: null, argv: ["zsh"], foreground: null }),
  ];
  for (const t of cases) assert.equal(isClaude(t), false, JSON.stringify(t));
});

