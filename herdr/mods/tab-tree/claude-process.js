// Whether a terminal runs Claude, from what the core says of its process: the
// app it reports (OSC 7501), its program key, or its argv. The suspension rules
// use it to name the agent in front (suspend-policy.js).

const claude = (name) => /^(claude|claude-code)$/i.test(name);
const base = (path) => typeof path === "string" ? path.split(/[\\/]/).pop().replace(/^-/, "").replace(/\.exe$/i, "") : "";

// The words after Claude's program name in argv, or null when argv is not a
// Claude launch. Deliberately narrower than the app's display-name detection:
// never search arbitrary arguments (e.g. `pi "fix claude"`) or evaluate shell
// command text.
/** @param {unknown} argv @returns {unknown[] | null} */
function claudeWords(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const first = base(argv[0]);
  if (claude(first)) return argv.slice(1);
  if (["node", "bun"].includes(first)) {
    const script = argv[1];
    return typeof script === "string" && !script.startsWith("-") &&
      (/^(claude|claude-code)\.(js|mjs|cjs)$/i.test(base(script)) || /(?:^|[\\/])@anthropic-ai[\\/]claude-code[\\/]cli\.js$/.test(script))
      ? argv.slice(2) : null;
  }
  // The exact launch wrappers used by Herdr (programs.rs), not `sh -c ...`.
  if (["sh", "bash", "zsh", "fish"].includes(first) && argv.length > 4 &&
      /^-[a-z]*c$/.test(argv[1]) &&
      ['"$@"; exec "$0" -i', "command $argv[2..]; exec $argv[1] -i"].includes(argv[2])) {
    return claudeWords(argv.slice(4));
  }
  return null;
}

// The argv of the process in front. Launch argv is not current evidence when
// another foreground PID is known.
const frontArgv = (t) => t?.foreground?.argv?.length ? t.foreground.argv
  : t?.foreground?.pid && t.foreground.pid !== t.pid ? null : t?.argv;

// Current process metadata only. Recovery labels describe a previous agent.
// terminals() exposes OSC 7501 as report; hc get keeps it in status.
export function isClaude(t) {
  const app = t?.report?.app ?? t?.status?.app;
  if (typeof app === "string" && app) return claude(app);
  const key = t?.program?.key;
  if (key === "claude") return true;
  if (t?.program?.shell || (key && !["agent", "program", "node", "bun"].includes(key))) return false;
  return claudeWords(frontArgv(t)) !== null;
}
