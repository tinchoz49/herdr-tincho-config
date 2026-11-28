import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standin, type System } from "../suspend/standin";

// Fakes only at the boundary: the terminal, hc, the file system, the clock
// and the process replacement. The stand-in logic runs unchanged.

const SESSION_FILE = "/sessions/pi.jsonl";
const PI_RECORD = JSON.stringify({ version: 1, sessionId: "pi-id", sessionFile: SESSION_FILE, cwd: "/recorded", args: ["--model", "m"] });
const SINCE = new Date(2026, 10, 16, 14, 5).getTime();
const suspended = (root: "shell" | "agent", agent = "pi") => JSON.stringify({ version: 1, agent, root, cwd: "/project", since: SINCE });
const PROJECTS = "/home/me/.claude/projects";
const CLAUDE_PROOF = `${PROJECTS}/-project/claude-id.jsonl`;
// Resume reports as the agents' plugins write them.
const resume = (agent: string, session: string, argv: string[], proof: string) =>
  JSON.stringify({ version: 1, agent, session, argv, cwd: "/project", proof, pid: 41, at: 1 });
const PI_REPORT = resume("pi", "pi-id", ["pi", "--session", SESSION_FILE, "--model", "m"], SESSION_FILE);
const CLAUDE_REPORT = resume("claude", "claude-id", ["claude", "--resume", "claude-id"], CLAUDE_PROOF);
const piLabels = (root: "shell" | "agent" = "agent") => ({ "herdr.suspended": suspended(root), "herdr.resume": PI_REPORT });
const claudeLabels = (root: "shell" | "agent" = "agent") => ({ "herdr.suspended": suspended(root, "claude"), "herdr.resume": CLAUDE_REPORT });
// The labels written before herdr.resume (the legacy adapter reads them).
const legacyPi = (root: "shell" | "agent" = "agent") => ({ "herdr.suspended": suspended(root), "herdr.pi-recovery": PI_RECORD });
const legacyClaude = (root: "shell" | "agent" = "agent") => ({ "herdr.suspended": suspended(root, "claude"), "herdr.claude-session": "claude-id" });

// Claude's transcripts: <id>.jsonl in a folder per project.
const TRANSCRIPTS: Record<string, string[]> = { "-other": ["x.jsonl"], "-project": ["claude-id.jsonl", "abc.jsonl"] };

type Options = {
  labels?: Record<string, string> | null;
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  exec?: (argv: string[]) => string | null | Promise<string>;
  hc?: (args: string[]) => { code: number; stdout: string } | undefined;
  saveFails?: boolean;
  backgroundFails?: boolean;
  transcripts?: Record<string, string[]>;
  platform?: string;
};

function fake(options: Options = {}) {
  const writes: string[] = [];
  const steps: string[] = [];
  const execs: string[][] = [];
  const backgrounds: string[][] = [];
  const saved: Record<string, string> = {};
  const timers: { at: number; run: () => void }[] = [];
  let now = SINCE + 60_000;
  let onData: ((chunk: string) => void) | null = null;
  let onError: ((error: unknown) => void) | null = null;
  const transcripts = options.transcripts ?? TRANSCRIPTS;
  const sys: System = {
    env: { HOME: "/home/me", SHELL: "/bin/fish", ...options.env },
    platform: options.platform ?? "linux",
    unsetenv: (name) => { steps.push(`unsetenv ${name}`); delete sys.env[name]; },
    list: async (dir) => (dir === PROJECTS ? Object.keys(transcripts) : []),
    background: async (argv) => {
      steps.push(`background ${argv.slice(4).join(" ")}`);
      backgrounds.push(argv);
      if (options.backgroundFails) throw new Error("fork failed");
    },
    onError: (handler) => { onError = handler; },
    write: (text) => { writes.push(text); },
    listen: (handler) => { onData = handler; },
    raw: (on) => { steps.push(`raw ${on}`); },
    hc: async (args) => {
      steps.push(`hc ${args.join(" ")}`);
      const answer = options.hc?.(args);
      if (answer) return answer;
      if (args[0] === "get") return options.labels === null ? { code: 3, stdout: "" } : { code: 0, stdout: JSON.stringify({ address: args[1], labels: options.labels ?? piLabels() }) };
      return { code: 0, stdout: "{}" };
    },
    readHead: async (path) => {
      if (options.files && path in options.files) return options.files[path] ?? null;
      if (path === SESSION_FILE) return '{"type":"session","id":"pi-id"}\n{"type":"message"}';
      const [folder, file] = path.startsWith(`${PROJECTS}/`) ? path.slice(PROJECTS.length + 1).split("/") : [];
      return transcripts[folder]?.includes(file) ? `{"sessionId":"${file.replace(/\.jsonl$/, "")}"}` : null;
    },
    save: async (path, text) => { if (options.saveFails) throw new Error("read-only file system"); steps.push(`save ${path}`); saved[path] = text; },
    chdir: (path) => { steps.push(`chdir ${path}`); return null; },
    exec: (argv) => {
      steps.push(`exec ${argv[0]}`);
      execs.push(argv);
      const error = options.exec?.(argv) ?? null;
      return error === null ? new Promise<string>(() => {}) : Promise.resolve(error);
    },
    now: () => now,
    after: (ms, run) => { timers.push({ at: now + ms, run }); },
  };
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return {
    sys, writes, steps, execs, saved, backgrounds,
    async fail(error: unknown) { onError!(error); await settle(); },
    screen: () => writes.join(""),
    // The handover never returns, as a real exec never does: do not wait for it.
    async start(args = ["pi", "t7", "worker"]) { void standin(args, sys); await settle(); },
    async input(chunk: string) { onData!(chunk); await settle(); },
    async tick(ms: number) {
      const until = now + ms;
      await settle();
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const report = (state: string, msg?: string) => `\x1b]7501;state=${state}:app=herdr-standin${msg ? `:msg=${Buffer.from(msg).toString("base64")}` : ""}\x1b\\`;
const reports = (screen: string) => [...screen.matchAll(/\x1b\]7501;state=(\w+)/g)].map((m) => m[1]);
const PI_WAKE = ["pi", "--session", SESSION_FILE, "--model", "m"];

describe("start", () => {
  test("shows the suspension line, turns on bracketed paste and reports idle", async () => {
    const t = fake();
    await t.start();
    expect(t.steps).toContain("hc get t7 --json");
    expect(t.steps).toContain("raw true");
    expect(t.screen()).toContain("\x1b[?2004h");
    expect(t.screen()).toContain("💤 pi suspended at 14:05 · wakes on a message or a click on its row · Enter wakes it");
    expect(t.screen().endsWith(report("idle"))).toBe(true);
    expect(t.execs).toEqual([]);
  });

  test("without its suspension label it hands the terminal to $SHELL", async () => {
    const t = fake({ labels: { "herdr.last-agent": "pi" } });
    await t.start();
    expect(t.execs).toEqual([["/bin/fish"]]);
    expect(t.steps).not.toContain("raw true");
    expect(reports(t.screen())).toEqual([]);
  });

  test("the stale-label handover uses /bin/sh when $SHELL is unset", async () => {
    const t = fake({ labels: {}, env: { SHELL: undefined } });
    await t.start();
    expect(t.execs).toEqual([["/bin/sh"]]);
  });

  test("the handover passes its shell arguments on", async () => {
    const t = fake({ labels: {}, platform: "darwin" });
    await t.start(["pi", "t7", "worker", "-l", "two words"]);
    expect(t.execs).toEqual([["/bin/fish", "-l", "two words"]]);
  });

  test("on macOS, with no shell arguments, the handover starts a login shell, as hc does", async () => {
    const mac = fake({ labels: {}, platform: "darwin" });
    await mac.start();
    expect(mac.execs).toEqual([["/bin/fish", "-l"]]);
    const linux = fake({ labels: {}, platform: "linux" });
    await linux.start();
    expect(linux.execs).toEqual([["/bin/fish"]]);
  });

  test("retries hc while the core restarts, and never starts a shell when hc fails", async () => {
    let tries = 0;
    const t = fake({ labels: {}, hc: (args) => (args[0] === "get" && ++tries < 3 ? { code: 5, stdout: "" } : undefined) });
    await t.start();
    await t.tick(1000);
    expect(tries).toBe(3);
    expect(t.execs).toEqual([["/bin/fish"]]);

    const broken = fake({ labels: null });
    await broken.start();
    expect(broken.execs).toEqual([]);
    expect(reports(broken.screen())).toEqual(["blocked"]);
  });
});

describe("input", () => {
  test("a pasted block is one message, and its Enter adds nothing", async () => {
    const t = fake();
    await t.start();
    await t.input(paste("hello there"));
    await t.tick(200);
    await t.input("\r");
    await t.tick(300);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "hello there"]]);
  });

  test("a paste keeps its newlines and escape sequences, even split across reads", async () => {
    const t = fake();
    await t.start();
    const text = "line one\r\nline two\rline \x1b[31mred\x1b[0m and \x1b[A arrow";
    const whole = paste(text);
    await t.input(whole.slice(0, 3));
    await t.input(whole.slice(3, 20));
    await t.input(whole.slice(20, whole.length - 3));
    await t.input(whole.slice(whole.length - 3));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "line one\nline two\nline \x1b[31mred\x1b[0m and \x1b[A arrow"]]);
  });

  test("a typed line followed by Enter is one message; keys and control characters are not text", async () => {
    const t = fake();
    await t.start();
    await t.input("helo");
    await t.input("\x7flo\x1b[D\x03 you");
    await t.input("\r");
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "hello you"]]);
    expect(t.screen()).toContain("helo");
  });

  test("an empty Enter wakes the agent with no prompt", async () => {
    const t = fake();
    await t.start();
    await t.input("\r");
    await t.tick(500);
    expect(t.execs).toEqual([PI_WAKE]);
  });

  test("lines typed into the cooked terminal before raw mode (one read, LF endings) are one message", async () => {
    const t = fake();
    await t.start();
    await t.input("first line\nsecond line\n");
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "first line\nsecond line"]]);
  });

  test("cooked lines whose Enter arrives after raw mode are still one message", async () => {
    const t = fake();
    await t.start();
    await t.input("one\ntwo");
    await t.input("\r");
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "one\ntwo"]]);
  });

  test("an Enter pressed before raw mode (a lone LF) is an empty wake", async () => {
    const t = fake();
    await t.start();
    await t.input("\n");
    await t.tick(500);
    expect(t.execs).toEqual([PI_WAKE]);
  });

  test("input is never run before the agent wakes", async () => {
    const t = fake();
    await t.start();
    await t.input(paste("rm -rf ~"));
    await t.input("echo hi\r");
    expect(t.execs).toEqual([]);
  });
});

describe("lines kept by herdr-shell", () => {
  const PENDING = { HERDR_STANDIN_PENDING: "kept line one\nkept line two" };

  test("are one message of the next wake, and the variable is gone before any replacement", async () => {
    const t = fake({ env: PENDING });
    await t.start();
    expect(t.steps[0]).toBe("unsetenv HERDR_STANDIN_PENDING");
    await t.tick(200);
    await t.input(paste("and a send"));
    await t.tick(300);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "kept line one\nkept line two\n\nand a send"]]);
  });

  test("are saved when the session is missing", async () => {
    const t = fake({ env: PENDING, labels: { "herdr.suspended": suspended("agent", "claude") } });
    await t.start(["claude", "t3", "worker"]);
    await t.tick(500);
    expect(Object.values(t.saved)).toEqual(["kept line one\nkept line two"]);
  });

  test("are dropped with a note, never run, when the terminal is not suspended", async () => {
    const t = fake({ env: PENDING, labels: {} });
    await t.start();
    expect(t.execs).toEqual([["/bin/fish"]]);
    expect(t.steps.indexOf("unsetenv HERDR_STANDIN_PENDING")).toBeLessThan(t.steps.indexOf("exec /bin/fish"));
    expect(t.screen()).toContain("dropped");
    expect(t.screen()).not.toContain("kept line");
  });
});

describe("batching", () => {
  test("waits 500 ms after the first message, then wakes once with all messages joined by blank lines", async () => {
    const t = fake();
    await t.start();
    await t.input(paste("first"));
    await t.tick(300);
    await t.input(paste("second\nwith two lines"));
    await t.tick(100);
    await t.input("third\r");
    await t.tick(99);
    expect(t.execs).toEqual([]);
    await t.tick(1);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "first\n\nsecond\nwith two lines\n\nthird"]]);
  });

  test("an empty Enter opens the same window, so a message right after it is delivered", async () => {
    const t = fake();
    await t.start();
    await t.input("\r");
    await t.tick(250);
    await t.input(paste("late"));
    await t.tick(250);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "late"]]);
  });

  test("a paste still arriving when the window ends is waited for", async () => {
    const t = fake();
    await t.start();
    await t.input(paste("one"));
    await t.input("\x1b[200~long");
    await t.tick(500);
    expect(t.execs).toEqual([]);
    await t.input(" paste\x1b[201~");
    expect(t.execs).toEqual([[...PI_WAKE, "--", "one\n\nlong paste"]]);
  });
});

describe("status reports", () => {
  test("idle on start, working once the wake begins", async () => {
    const t = fake();
    await t.start();
    expect(reports(t.screen())).toEqual(["idle"]);
    await t.input(paste("go"));
    expect(reports(t.screen())).toEqual(["idle"]);
    await t.tick(500);
    expect(reports(t.screen())).toEqual(["idle", "working"]);
    expect(t.screen()).toContain(report("working"));
  });

  test("blocked, with the reason, when the session is missing", async () => {
    const t = fake({ files: { [SESSION_FILE]: '{"type":"session","id":"another"}' } });
    await t.start();
    await t.input(paste("go"));
    await t.tick(500);
    expect(reports(t.screen())).toEqual(["idle", "blocked"]);
    expect(t.screen()).toMatch(/\x1b\]7501;state=blocked:app=herdr-standin:msg=[A-Za-z0-9+/=]+\x1b\\/);
  });
});

describe("wake", () => {
  test("root=agent: enters the recorded folder, removes the label, then replaces itself with the recipe", async () => {
    const t = fake({ labels: piLabels("agent") });
    await t.start(["pi", "t7", "worker"]);
    await t.input(paste("-starts with a dash"));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "-starts with a dash"]]);
    const wake = t.steps.slice(t.steps.indexOf("chdir /project"));
    expect(wake).toEqual(["chdir /project", "hc label t7 herdr.suspended=", "background t7 30", "raw false", "exec pi"]);
    expect(t.screen().lastIndexOf("\x1b[?2004l")).toBeGreaterThan(t.screen().lastIndexOf("\x1b[?2004h"));
  });

  test("root=shell: runs the recipe under /bin/sh -c, then returns to $SHELL", async () => {
    const t = fake({ labels: claudeLabels("shell") });
    await t.start(["claude", "t9", "worker"]);
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.execs).toHaveLength(1);
    const [sh, flag, script, name, ...command] = t.execs[0];
    expect([sh, flag, name]).toEqual(["/bin/sh", "-c", "sh"]);
    expect(command).toEqual(["claude", "--resume", "claude-id", "--", "hi"]);
    expect(t.steps).toContain("hc label t9 herdr.suspended=");
    expect(t.steps.indexOf("hc label t9 herdr.suspended=")).toBeLessThan(t.steps.indexOf("exec /bin/sh"));
    // Job control first: the agent gets its own process group, so hc names the
    // agent (not this wrapper) as the program in front, and the policy can
    // suspend it again as root=shell.
    expect(script.startsWith("set -m; ")).toBe(true);
    // The script runs the words it is given, then the user's shell.
    const run = Bun.spawnSync(["/bin/sh", "-c", script, name, "printf", "%s|", "a b", "--", "it's\nmultiline"], { env: { SHELL: "/bin/echo" } });
    expect(run.stdout.toString()).toBe("a b|--|it's\nmultiline|\n");
  });

  test("root=shell: the shell after the agent gets the shell arguments, or -l on macOS", async () => {
    const tail = async (options: Options, args: string[]) => {
      const t = fake({ labels: claudeLabels("shell"), ...options });
      await t.start(["claude", "t9", "worker", ...args]);
      await t.input("\r");
      await t.tick(500);
      const [, , script, name] = t.execs[0];
      const run = Bun.spawnSync(["/bin/sh", "-c", script, name, "true"], { env: { SHELL: "/bin/echo" } });
      return run.stdout.toString();
    };
    expect(await tail({ platform: "linux" }, ["-i", "it's"])).toBe("-i it's\n");
    expect(await tail({ platform: "darwin" }, [])).toBe("-l\n");
    expect(await tail({ platform: "linux" }, [])).toBe("\n");
  });

  test("legacy labels: Claude wakes from its recorded session id, in the record's folder", async () => {
    const t = fake({ labels: { ...legacyClaude("agent"), "herdr.claude-session": "abc" } });
    await t.start(["claude", "t9", "worker"]);
    await t.input("\r");
    await t.tick(500);
    expect(t.execs[0].slice(0, 3)).toEqual(["claude", "--resume", "abc"]);
    expect(t.steps).toContain("chdir /project");
  });

  test("legacy labels: Claude wakes with its recorded launch options, as recovery starts it", async () => {
    const t = fake({ labels: { ...legacyClaude("agent"), "herdr.claude-options": JSON.stringify({ version: 1, options: ["--model", "haiku"] }) } });
    await t.start(["claude", "t9", "worker"]);
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.execs).toEqual([["claude", "--model", "haiku", "--resume", "claude-id", "--", "hi"]]);
  });

  test("a report written by a plugin wakes with its exact argv, in its own folder", async () => {
    const argv = ["/opt/bin/claude", "--model", "it's haiku", "--add-dir", "/a b", "--resume", "claude-id"];
    const labels = { "herdr.suspended": suspended("agent", "claude"),
      "herdr.resume": JSON.stringify({ version: 1, agent: "claude", session: "claude-id", argv, cwd: "/elsewhere", proof: CLAUDE_PROOF, pid: 9, at: 2 }) };
    const t = fake({ labels });
    await t.start(["claude", "t9", "worker"]);
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.execs).toEqual([[...argv, "--", "hi"]]);
    expect(t.steps).toContain("chdir /elsewhere");
    expect(t.steps).not.toContain("chdir /project");
  });

  test("legacy labels: Pi wakes from its recovery record, in its recorded folder", async () => {
    const t = fake({ labels: legacyPi("agent") });
    await t.start();
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "hi"]]);
    expect(t.steps).toContain("chdir /recorded");
  });

  test("a report from another agent than the suspended one does not wake it", async () => {
    const t = fake({ labels: { "herdr.suspended": suspended("agent"), "herdr.resume": CLAUDE_REPORT } });
    await t.start();
    await t.input("\r");
    await t.tick(500);
    expect(t.execs).toEqual([]);
    expect(t.screen()).toContain("pi not woken: it has no resume report");
  });

  test("a failed replacement puts the label back and keeps the messages", async () => {
    const t = fake({ exec: () => "No such file or directory" });
    await t.start();
    await t.input(paste("keep me"));
    await t.tick(500);
    expect(t.steps).toContain(`hc label t7 herdr.suspended=${suspended("agent")}`);
    expect(Object.values(t.saved)).toEqual(["keep me"]);
    expect(reports(t.screen()).at(-1)).toBe("blocked");
    expect(t.screen()).toContain("No such file or directory");
  });
});

describe("failed wakes and errors", () => {
  test("every failed wake that reported working, empty or not, reports blocked again", async () => {
    const t = fake({ exec: () => "No such file or directory" });
    await t.start();
    for (let i = 0; i < 2; i++) { await t.input("\r"); await t.tick(500); }
    expect(reports(t.screen())).toEqual(["idle", "working", "blocked", "working", "blocked"]);
  });

  test("a wake that fails after its working report (folder, label) ends blocked", async () => {
    const t = fake({ hc: (args) => (args[0] === "label" ? { code: 3, stdout: "" } : undefined) });
    await t.start();
    await t.input("\r");
    await t.tick(500);
    await t.input("\r");
    await t.tick(500);
    expect(reports(t.screen())).toEqual(["idle", "working", "blocked", "working", "blocked"]);
    expect(t.execs).toEqual([]);
  });

  test("a rejected replacement puts the label back, keeps the messages and reports blocked", async () => {
    const t = fake({ exec: () => Promise.reject(new Error("ffi broke")) });
    await t.start();
    await t.input(paste("keep me"));
    await t.tick(500);
    expect(t.steps).toContain(`hc label t7 herdr.suspended=${suspended("agent")}`);
    expect(t.steps.lastIndexOf("raw true")).toBeGreaterThan(t.steps.lastIndexOf("raw false"));
    expect(Object.values(t.saved)).toEqual(["keep me"]);
    expect(reports(t.screen()).at(-1)).toBe("blocked");
    expect(t.screen()).toContain("ffi broke");
  });

  test("an error inside the wake takes the missing-session path, and the stand-in still wakes later", async () => {
    let first = true;
    const t = fake();
    t.sys.chdir = () => { if (first) { first = false; throw new Error("disk gone"); } return null; };
    await t.start();
    await t.input(paste("one"));
    await t.tick(500);
    expect(Object.values(t.saved)).toEqual(["one"]);
    expect(t.screen()).toContain("disk gone");
    expect(reports(t.screen()).at(-1)).toBe("blocked");
    await t.input(paste("two"));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "two"]]);
  });

  test("an unexpected error keeps the collected messages, reports blocked, and input still works", async () => {
    const t = fake();
    await t.start();
    await t.input(paste("held"));
    await t.fail(new Error("boom"));
    expect(Object.values(t.saved)).toEqual(["held"]);
    expect(t.screen()).toContain("boom");
    expect(reports(t.screen()).at(-1)).toBe("blocked");
    await t.tick(500);
    expect(t.execs).toEqual([]);
    await t.input(paste("again"));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "again"]]);
  });

  test("an error while reading the terminal at start holds the terminal, blocked, and keeps typed messages", async () => {
    const t = fake({ env: { XDG_STATE_HOME: "/state" } });
    t.sys.hc = async () => { throw new Error("spawn failed"); };
    await t.start();
    expect(t.execs).toEqual([]);
    expect(reports(t.screen())).toEqual(["blocked"]);
    await t.input(paste("hello"));
    await t.tick(500);
    expect(Object.values(t.saved)).toEqual(["hello"]);
  });
});

describe("watchdog", () => {
  // The watchdog the stand-in started, run for real with a fake hc on PATH
  // and no wait. It returns what it wrote to the terminal and the hc calls.
  async function watchdog(argv: string[], answer: { code: number; json?: unknown; spaced?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "standin-watchdog-"));
    try {
      const json = answer.json === undefined ? "" : JSON.stringify(answer.json);
      writeFileSync(join(dir, "answer"), answer.spaced ? json.replaceAll('":', '": ').replaceAll(',"', ', "') : json); // Python's json.dumps style
      writeFileSync(join(dir, "hc"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/calls"\ncat "${dir}/answer"\nexit ${answer.code}\n`, { mode: 0o755 });
      const run = Bun.spawn([...argv.slice(0, -1), "0"], { env: { PATH: `${dir}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      const written = await new Response(run.stdout).text(); // the end comes when the background part ends
      await run.exited;
      let calls: string[] = [];
      try { calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { /* none */ }
      return { written, calls };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const started = async () => {
    const t = fake();
    await t.start();
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.backgrounds).toHaveLength(1);
    return t.backgrounds[0];
  };
  const terminal = (status: unknown, foreground: unknown, statusMs = Date.now() - 60_000) => ({
    address: "t7", argv: ["/x/herdr-shell"], foreground, labels: { note: "\"app\":\"herdr-standin\"" }, name: "worker", pid: 11, state: "live", status, status_ms: statusMs,
  });
  const STANDIN_REPORT = { app: "herdr-standin", state: "working" };
  const AGENT_FRONT = { argv: ["pi", "", ""], cwd: "/project", name: "node", pid: 11 };
  const IDLE = "\x1b]7501;state=idle\x1b\\";

  test("the wake starts it with /bin/sh for its terminal and 30 s, before the replacement", async () => {
    const argv = await started();
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(4)).toEqual(["t7", "30"]);
  });

  test("a wake that cannot start it still wakes the agent", async () => {
    const t = fake({ backgroundFails: true });
    await t.start();
    await t.input(paste("hi"));
    await t.tick(500);
    expect(t.execs).toEqual([[...PI_WAKE, "--", "hi"]]);
  });

  test("a wake that fails before the replacement starts none", async () => {
    const t = fake({ labels: { "herdr.suspended": suspended("agent", "claude") } });
    await t.start(["claude", "t3", "worker"]);
    await t.input("\r");
    await t.tick(500);
    expect(t.backgrounds).toEqual([]);
  });

  test("writes one idle report with no app when the stand-in's report is stale and the stand-in is not in front", async () => {
    const result = await watchdog(await started(), { code: 0, json: terminal(STANDIN_REPORT, AGENT_FRONT) });
    expect(result.calls).toEqual(["get t7 --json"]);
    expect(result.written).toBe(IDLE);
  });

  test("reads hc's JSON with spaces too", async () => {
    const result = await watchdog(await started(), { code: 0, json: terminal(STANDIN_REPORT, AGENT_FRONT), spaced: true });
    expect(result.written).toBe(IDLE);
  });

  test("a label named status_ms does not hide the report time", async () => {
    const json = { ...terminal(STANDIN_REPORT, AGENT_FRONT), labels: { status_ms: "9999999999999" } };
    const result = await watchdog(await started(), { code: 0, json });
    expect(result.written).toBe(IDLE);
  });

  for (const [name, answer] of [
    ["the stand-in is in front (its path)", { code: 0, json: terminal(STANDIN_REPORT, { argv: ["/bin dir/herdr-standin", "pi", "t7", "worker"], cwd: "/", name: "herdr-standin", pid: 11 }) }],
    ["the stand-in is in front (its name only)", { code: 0, json: terminal(STANDIN_REPORT, { argv: ["x"], cwd: "/", name: "herdr-standin", pid: 11 }) }],
    ["the stand-in is in front (a bare argv)", { code: 0, json: terminal(STANDIN_REPORT, { argv: ["herdr-standin"], cwd: "/", name: "bun", pid: 11 }) }],
    ["the woken agent reported", { code: 0, json: terminal({ app: "pi", state: "idle" }, AGENT_FRONT) }],
    ["nothing reports", { code: 0, json: terminal(null, AGENT_FRONT) }],
    ["a later wake reported after it started", { code: 0, json: terminal(STANDIN_REPORT, AGENT_FRONT, Date.now() + 120_000) }],
    ["hc gives no report time", { code: 0, json: { ...terminal(STANDIN_REPORT, AGENT_FRONT), status_ms: null } }],
    ["hc fails", { code: 3, json: { error: { kind: "not_found" } } }],
    ["the terminal is finished", { code: 0, json: { ...terminal(STANDIN_REPORT, null), state: "finished" } }],
    ["the woken agent reported and a label is named app", { code: 0, json: { ...terminal({ app: "pi", state: "idle" }, AGENT_FRONT), labels: { app: "herdr-standin" } } }],
  ] as [string, { code: number; json: unknown }][]) {
    test(`writes nothing when ${name}`, async () => {
      const result = await watchdog(await started(), answer);
      expect(result.calls).toEqual(["get t7 --json"]);
      expect(result.written).toBe("");
    });
  }
});

describe("missing session", () => {
  const missing = async (options: Options, args = ["pi", "t1/x", "worker"]) => {
    const t = fake({ env: { XDG_STATE_HOME: "/state" }, ...options });
    await t.start(args);
    await t.input(paste("first"));
    await t.input("second\r");
    await t.tick(500);
    return t;
  };

  for (const [name, options] of [
    ["the Pi session file is absent", { files: { [SESSION_FILE]: undefined as unknown as string } }],
    ["the Pi session file holds another id", { files: { [SESSION_FILE]: '{"type":"session","id":"other"}' } }],
    ["the report is empty (nothing to resume)", { labels: { "herdr.suspended": suspended("agent"), "herdr.resume": "", "herdr.pi-recovery": PI_RECORD } }],
    ["the report is broken", { labels: { "herdr.suspended": suspended("agent"), "herdr.resume": "{" } }],
    ["Claude's transcript is missing", { labels: claudeLabels(), transcripts: { "-project": ["another.jsonl"] } }],
    ["legacy: the Pi record has no session file", { labels: { "herdr.suspended": suspended("agent"), "herdr.pi-recovery": JSON.stringify({ version: 1, sessionId: "pi-id", cwd: "/r", args: [] }) } }],
    ["there is no report", { labels: { "herdr.suspended": suspended("agent") } }],
    ["Claude has no report", { labels: { "herdr.suspended": suspended("agent", "claude") } }],
    ["legacy: Claude's session has no transcript", { labels: legacyClaude(), transcripts: { "-project": ["another.jsonl"] } }],
    ["legacy: Claude has no projects folder", { labels: legacyClaude(), transcripts: {} }],
    ["legacy: Claude's session id is a path", { labels: { ...legacyClaude(), "herdr.claude-session": "../-project/claude-id" } }],
  ] as [string, Options][]) {
    test(`${name}: messages saved, path shown, blocked reported, no wake`, async () => {
      const t = await missing(options);
      expect(t.execs).toEqual([]);
      expect(t.steps).not.toContain("hc label t1/x herdr.suspended=");
      const paths = Object.keys(t.saved);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/^\/state\/herdr-tincho-config\/undelivered\/t1_x-\d+\.txt$/);
      expect(t.saved[paths[0]]).toBe("first\n\nsecond");
      expect(t.screen()).toContain(paths[0]);
      expect(reports(t.screen()).at(-1)).toBe("blocked");
    });
  }

  test("a missing proof refuses the wake with the reason", async () => {
    const t = await missing({ files: { [SESSION_FILE]: undefined as unknown as string } });
    expect(t.screen()).toContain(`pi not woken: its conversation file ${SESSION_FILE} is missing or holds another session.`);
    const legacy = await missing({ labels: legacyClaude(), transcripts: {} }, ["claude", "t1/x", "worker"]);
    expect(legacy.screen()).toContain("claude not woken: its session claude-id has no conversation on disk.");
  });

  test("repeated empty wakes (Enter presses) report blocked each time, and show their reason once", async () => {
    const t = fake({ labels: { "herdr.suspended": suspended("agent", "claude") } });
    await t.start(["claude", "t3", "worker"]);
    for (let i = 0; i < 3; i++) { await t.input("\r"); await t.tick(500); }
    expect(reports(t.screen())).toEqual(["idle", "blocked", "blocked", "blocked"]);
    expect(t.screen().split("not woken").length - 1).toBe(1);
    await t.input(paste("a message"));
    await t.tick(500);
    expect(reports(t.screen())).toEqual(["idle", "blocked", "blocked", "blocked", "blocked"]);
    expect(t.screen().split("not woken").length - 1).toBe(2);
  });

  test("when the file cannot be written, the messages are shown but kept out of the status", async () => {
    const t = fake({ labels: { "herdr.suspended": suspended("agent", "claude") }, saveFails: true });
    await t.start(["claude", "t3", "worker"]);
    await t.input(paste("secret plan"));
    await t.tick(500);
    expect(t.screen()).toContain("secret plan");
    const msg = t.screen().match(/state=blocked:app=herdr-standin:msg=([A-Za-z0-9+/=]+)/)![1];
    expect(Buffer.from(msg, "base64").toString()).toBe("claude not woken: it has no resume report. Could not save the messages: read-only file system");
  });

  test("the undelivered folder defaults to ~/.local/state", async () => {
    const t = fake({ labels: { "herdr.suspended": suspended("agent", "claude") } });
    await t.start(["claude", "t3", "worker"]);
    await t.input(paste("hi"));
    await t.tick(500);
    expect(Object.keys(t.saved)[0]).toMatch(/^\/home\/me\/\.local\/state\/herdr-tincho-config\/undelivered\/t3-\d+\.txt$/);
  });
});
