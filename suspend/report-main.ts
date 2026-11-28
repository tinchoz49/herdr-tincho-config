// herdr-agent-report <agent>: the Claude plugin's hook command
// (claude/herdr-resume/hooks/hooks.json); the hook's JSON arrives on stdin.
// The real ReportIo: kept thin, no reporter logic here (see report.ts).
// Built next to the stand-in by suspend/build.sh.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readFileSync } from "node:fs";
import { report, type ReportIo } from "./report";

// Every subprocess gets this long; the whole run gets DEADLINE.
const TIMEOUT = 1500;
const DEADLINE = 4000;

/** Splits KERN_PROCARGS2's buffer: argc, the exec path, NUL padding, then argc words. */
export function procargs(buffer: Uint8Array): string[] | null {
  if (buffer.length < 4) return null;
  const argc = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(0, true);
  let at = buffer.indexOf(0, 4); // end of the exec path
  if (argc <= 0 || at < 0) return null;
  while (at < buffer.length && buffer[at] === 0) at++;
  const decoder = new TextDecoder();
  const words: string[] = [];
  while (words.length < argc) {
    const end = buffer.indexOf(0, at);
    if (end < 0) return null;
    words.push(decoder.decode(buffer.subarray(at, end)));
    at = end + 1;
  }
  return words;
}

// macOS: the exact argv through sysctl(KERN_PROCARGS2). `ps -o args=` joins
// the words with spaces, which loses words such as "Bash(git *)".
let libc: ReturnType<typeof openLibc> | null = null;
function openLibc() {
  return dlopen("libc.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
}
const CTL_KERN = 1, KERN_ARGMAX = 8, KERN_PROCARGS2 = 49;
function darwinArgv(pid: number): string[] | null {
  libc ??= openLibc();
  const sysctl = (name: number[], out: Uint8Array) => {
    const mib = new Int32Array(name);
    const size = new BigUint64Array([BigInt(out.length)]);
    return libc!.symbols.sysctl(ptr(mib), name.length, ptr(out), ptr(size), null, 0) === 0 ? Number(size[0]) : -1;
  };
  const max = new Uint8Array(4);
  if (sysctl([CTL_KERN, KERN_ARGMAX], max) !== 4) return null;
  const buffer = new Uint8Array(new DataView(max.buffer).getInt32(0, true));
  const size = sysctl([CTL_KERN, KERN_PROCARGS2, pid], buffer);
  return size > 0 ? procargs(buffer.subarray(0, size)) : null;
}

/** A process's exact argv, or null. */
export function processArgv(pid: number): string[] | null {
  try {
    if (process.platform === "darwin") return darwinArgv(pid);
    const words = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (words.at(-1) === "") words.pop();
    return words.length ? words : null;
  } catch {
    return null;
  }
}

async function run(argv: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: TIMEOUT });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
}

/** A process's parent pid, or null. */
export async function processParent(pid: number): Promise<number | null> {
  let text: string;
  if (process.platform === "linux") {
    try {
      // The field after the state, after the last ")" (the name may hold one).
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      text = stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[1] ?? "";
    } catch { return null; }
  } else {
    const r = await run(["ps", "-o", "ppid=", "-p", String(pid)]);
    if (r.code !== 0) return null;
    text = r.stdout.trim();
  }
  const parent = Number(text);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
}

export function system(): ReportIo {
  return {
    env: process.env,
    ppid: process.ppid,
    stdin: () => Bun.stdin.text(),
    argv: async (pid) => processArgv(pid),
    parent: processParent,
    exists: (path) => { try { return existsSync(path); } catch { return false; } },
    hc: async (args) => (await run(["hc", ...args])).code,
    now: () => Date.now(),
  };
}

if (import.meta.main) {
  // Never hold Claude up, whatever hangs.
  setTimeout(() => process.exit(0), DEADLINE);
  for (const event of ["uncaughtException", "unhandledRejection"]) process.on(event, () => process.exit(0));
  report(process.argv[2], system()).finally(() => process.exit(0));
}
