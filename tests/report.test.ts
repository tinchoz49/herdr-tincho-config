import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isPrint, report, reportValue, type ReportIo } from "../suspend/report";
import { procargs, processArgv, processParent } from "../suspend/report-main";
import { parseReport } from "../herdr/mods/tab-tree/resume-report.js";

// Fakes only at the boundary: the hook's stdin, the process table, the file
// system, hc and the clock. The reporter logic runs unchanged.

const SESSION = "0193b6c2-aaaa-bbbb-cccc-000000000001";
const PROOF = `/home/me/.claude/projects/-work/${SESSION}.jsonl`;
const NOW = 1795614571208;
const CLAUDE = 41230;

type Options = {
  env?: Record<string, string | undefined>;
  hook?: Record<string, unknown> | string;
  // pid -> [argv, parent pid]; the reporter's parent is 500.
  processes?: Record<number, [string[], number]>;
  files?: string[];
  hcCode?: number;
  hcThrows?: boolean;
};

const hookInput = (source: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION, transcript_path: PROOF, cwd: "/work", hook_event_name: "SessionStart", source, ...extra,
});

function harness({ env = { HC_TERMINAL_ID: "t42" }, hook = hookInput("startup"), processes, files = [PROOF], hcCode = 0, hcThrows = false }: Options = {}) {
  const table = processes ?? { 500: [["claude", "--model", "haiku"], 1] };
  const calls: string[][] = [];
  const io: ReportIo = {
    env,
    ppid: 500,
    stdin: async () => typeof hook === "string" ? hook : JSON.stringify(hook),
    argv: async (pid) => table[pid]?.[0] ?? null,
    parent: async (pid) => table[pid]?.[1] ?? null,
    exists: (path) => files.includes(path),
    hc: async (args) => {
      calls.push(args);
      if (hcThrows) throw new Error("no hc");
      return hcCode;
    },
    now: () => NOW,
  };
  return { io, calls, run: (agent = "claude") => report(agent, io) };
}

// The herdr.resume value in an hc call.
const resumeIn = (args: string[]) => args.find((a) => a.startsWith("herdr.resume="))!.slice("herdr.resume=".length);

describe("each SessionStart source", () => {
  for (const source of ["startup", "resume", "clear", "compact"]) {
    test(`${source}: one label call with the report and the agent`, async () => {
      const h = harness({ hook: hookInput(source) });
      await h.run();
      expect(h.calls.length).toBe(1);
      const [label, terminal, agent, resume, ...rest] = h.calls[0];
      expect([label, terminal, agent]).toEqual(["label", "t42", "herdr.last-agent=claude"]);
      expect(resume.startsWith("herdr.resume=")).toBe(true);
      // The old polling's labels are cleared in the same call.
      expect(rest).toEqual(["herdr.claude-session=", "herdr.claude-options="]);
      expect(JSON.parse(resumeIn(h.calls[0]))).toEqual({
        version: 1, agent: "claude", session: SESSION, argv: ["claude", "--model", "haiku", "--resume", SESSION],
        cwd: "/work", proof: PROOF, pid: 500, at: NOW,
      });
    });
  }

  test("a new or cleared session before its first reply writes an empty report", async () => {
    for (const source of ["startup", "clear"]) {
      const h = harness({ hook: hookInput(source), files: [] });
      await h.run();
      expect(h.calls).toEqual([["label", "t42", "herdr.last-agent=claude", "herdr.resume=", "herdr.claude-session=", "herdr.claude-options="]]);
    }
  });
});

test("Stop after the first reply writes the report, once the transcript exists", async () => {
  const files: string[] = [];
  const h = harness({ hook: hookInput("startup"), files });
  await h.run();
  expect(resumeIn(h.calls[0])).toBe("");
  files.push(PROOF);
  const stop = harness({ hook: { session_id: SESSION, transcript_path: PROOF, cwd: "/work", hook_event_name: "Stop" }, files });
  await stop.run();
  expect(parseReport(resumeIn(stop.calls[0]))?.session).toBe(SESSION);
});

describe("writes nothing", () => {
  test("outside hc (no HC_TERMINAL_ID)", async () => {
    for (const env of [{}, { HC_TERMINAL_ID: "" }]) {
      const h = harness({ env });
      await h.run();
      expect(h.calls).toEqual([]);
    }
  });

  test("for a print Claude (-p, --print, a short-option group)", async () => {
    for (const argv of [["claude", "-p", "hi"], ["claude", "--model", "haiku", "--print"], ["/usr/local/bin/claude", "-cp", "x"], ["claude", "--print=true"]]) {
      const h = harness({ processes: { 500: [argv, 1] } });
      await h.run();
      expect(h.calls).toEqual([]);
    }
  });

  test("when Claude is not among the 3 nearest ancestors", async () => {
    const shells = { 500: [["sh", "-c", "x"], 501], 501: [["sh"], 502], 502: [["zsh"], 503], 503: [["claude"], 1] } satisfies Options["processes"];
    const h = harness({ processes: shells });
    await h.run();
    expect(h.calls).toEqual([]);
    for (const argv of [["claude-code"], ["node", "/x/claude"], ["notclaude"]]) {
      const other = harness({ processes: { 500: [argv, 1] } });
      await other.run();
      expect(other.calls).toEqual([]);
    }
    const unreadable = harness({ processes: {} });
    await unreadable.run();
    expect(unreadable.calls).toEqual([]);
  });

  test("for another agent name, or a hook input it cannot read", async () => {
    const other = harness();
    await other.run("pi");
    expect(other.calls).toEqual([]);
    for (const hook of ["not json", { ...hookInput("startup"), session_id: "a/b" }, { ...hookInput("startup"), cwd: "relative" }, { transcript_path: PROOF }]) {
      const h = harness({ hook });
      await h.run();
      expect(h.calls).toEqual([]);
    }
  });
});

test("finds Claude through a hook shell, up to 3 hops", async () => {
  const h = harness({ processes: { 500: [["/bin/sh", "-c", "cmd"], 501], 501: [["bash"], 502], 502: [["/Users/me/.local/bin/claude", "--effort", "high"], 1] } });
  await h.run();
  const report = JSON.parse(resumeIn(h.calls[0]));
  expect(report.pid).toBe(502);
  expect(report.argv).toEqual(["claude", "--effort", "high", "--resume", SESSION]);
});

describe("launch options", () => {
  const argvFor = async (words: string[]) => {
    const h = harness({ processes: { 500: [["claude", ...words], 1] } });
    await h.run();
    return JSON.parse(resumeIn(h.calls[0])).argv.slice(1, -2);
  };

  test("kept: allowlisted options, words with spaces intact, relative folders resolved against cwd", async () => {
    expect(await argvFor(["--model", "haiku", "--allowedTools", "Bash(git *)", "Edit", "--add-dir", "lib", "--verbose"]))
      .toEqual(["--model", "haiku", "--allowed-tools", "Bash(git *)", "Edit", "--add-dir", "/work/lib", "--verbose"]);
  });

  test("dropped: prompts, secrets, settings, and the old session selector", async () => {
    expect(await argvFor(["--model", "opus", "--settings", "/s.json", "--system-prompt", "secret", "--session-id", "x", "-c", "fix the bug"]))
      .toEqual(["--model", "opus"]);
    // An older --resume stops capture (its value is optional); the new one is added.
    expect(await argvFor(["--model", "opus", "--resume", "old-id", "--verbose"])).toEqual(["--model", "opus"]);
    expect(await argvFor([])).toEqual([]);
  });
});

test("a failed or missing hc never throws", async () => {
  for (const options of [{ hcCode: 1 }, { hcThrows: true }]) {
    const h = harness(options);
    await h.run();
    expect(h.calls.length).toBe(1);
  }
});

test("contract: every non-empty value written passes the mod's parseReport", async () => {
  const sources = ["startup", "resume", "clear", "compact"];
  const argvs = [["claude"], ["claude", "--model", "haiku", "--add-dir", "../x", "--tools", "", "--"], ["/opt/claude", "--dangerously-skip-permissions"]];
  let checked = 0;
  for (const source of sources) for (const argv of argvs) {
    const h = harness({ hook: hookInput(source), processes: { 500: [argv, 1] } });
    await h.run();
    const value = resumeIn(h.calls[0]);
    expect(value).not.toBe("");
    expect(parseReport(value)).not.toBeNull();
    checked++;
  }
  expect(checked).toBe(12);
  // A report the mod would reject is written as "nothing to resume".
  expect(reportValue({ ...hookInput("startup"), session_id: "bad\u0007id" }, { pid: 1, argv: ["claude"] }, { exists: () => true, now: () => NOW })).toBeNull();
  expect(reportValue(hookInput("startup"), { pid: 0, argv: ["claude"] }, { exists: () => true, now: () => NOW })).toBe("");
});

test("print mode is read only before --", () => {
  expect(isPrint(["claude", "--", "-p"])).toBe(false);
  expect(isPrint(["claude", "--model", "p"])).toBe(false);
  expect(isPrint(["claude", "-p"])).toBe(true);
});

describe("the real process table", () => {
  test("procargs splits KERN_PROCARGS2's layout", () => {
    const enc = new TextEncoder();
    const body = enc.encode("/bin/claude\0\0\0\0claude\0--allowed-tools\0Bash(git *)\0KEY=env\0");
    const buffer = new Uint8Array(4 + body.length);
    new DataView(buffer.buffer).setInt32(0, 3, true);
    buffer.set(body, 4);
    expect(procargs(buffer)).toEqual(["claude", "--allowed-tools", "Bash(git *)"]);
    expect(procargs(new Uint8Array(2))).toBeNull();
  });

  test("reads this process's exact argv and parent", async () => {
    const argv = processArgv(process.pid);
    expect(argv).not.toBeNull();
    expect(argv!.length).toBeGreaterThan(0);
    if (process.platform === "linux") expect(argv).toEqual(readFileSync(`/proc/${process.pid}/cmdline`, "utf8").split("\0").filter(Boolean));
    expect(await processParent(process.pid)).toBe(process.ppid);
    expect(processArgv(2 ** 30)).toBeNull();
    expect(await processParent(2 ** 30)).toBeNull();
  });

  test("a word with spaces survives, unlike ps -o args=", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)", "a b"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(100);
      expect(processArgv(child.pid)?.slice(-1)).toEqual(["a b"]);
    } finally {
      child.kill();
    }
  });
});
