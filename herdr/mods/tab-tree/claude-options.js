// Claude's launch options allowlist: which words of a Claude command line are
// kept when it is started again. Used by the Claude plugin's reporter
// (suspend/report.ts), which writes them into Claude's resume report, and by
// the legacy adapter (resume-report.js), which reads the old
// herdr.claude-options label. The reporter and the stand-in build this file in
// at compile time, so it must import nothing.

// A command word: a string without control characters, possibly empty.
/** @param {unknown} s @returns {s is string} */
const word = (s) => typeof s === "string" && !/[\x00-\x1f\x7f]/.test(s);
/** @param {unknown} s @returns {s is string} */
const printable = (s) => word(s) && s.length > 0;
/** @param {unknown} s @returns {s is string} */
const absolute = (s) => printable(s) && s.startsWith("/");

// Claude's launch options: only known, reusable options, by canonical name.
// Never prompts, credentials, system prompts or session selectors. Claude's
// own parser decides the arity of each option, so an option missing from these
// tables stops capture instead of being guessed (claude --help, 2.1.325).
// Options with an optional value (--resume, --debug, --worktree,
// --remote-control, --teleport, --from-pr, --cloud, --prompt-suggestions,
// --tmux) are deliberately missing: they stop capture.
const ownNames = (names) => names.map((name) => [name, name]);
// One value each. --system-prompt-snapshot takes on/off, never prompt text.
const CLAUDE_VALUES = new Map(ownNames(["--model", "--permission-mode", "--effort", "--fallback-model", "--agent",
  "--setting-sources", "--autocompact", "--system-prompt-snapshot", "--plugin-dir"]));
// Every following word up to the next option. Claude takes a trailing prompt
// into such a list too, so a list at the end of the words is never kept.
const CLAUDE_LISTS = new Map([...ownNames(["--add-dir", "--allowed-tools", "--disallowed-tools", "--tools"]),
  ["--allowedTools", "--allowed-tools"], ["--disallowedTools", "--disallowed-tools"]]);
// Values that are folders, relative to the folder Claude started in.
const CLAUDE_PATHS = new Set(["--add-dir", "--plugin-dir"]);
// No value.
const CLAUDE_SWITCHES = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--ax-screen-reader",
  "--bare", "--brief", "--chrome", "--no-chrome", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections",
  "--ide", "--restricted", "--safe-mode", "--strict-mcp-config", "--verbose"]);
// Dropped with their value, even one that looks like an option: prompts,
// system prompts, settings and agents that can hold secrets, session
// selectors, and options that only fit one run.
const CLAUDE_DROPPED_VALUES = new Set(["--system-prompt", "--system-prompt-file", "--append-system-prompt",
  "--append-system-prompt-file", "--agents", "--settings", "--session-id", "-n", "--name", "--plugin-url", "--debug-file",
  "--environment", "--remote-control-session-name-prefix"]);
// Dropped with every value up to the next option: MCP configs can hold
// credentials, and files and beta headers fit one run.
const CLAUDE_DROPPED_LISTS = new Set(["--mcp-config", "--file", "--betas"]);
// Dropped: the session label already names the session these lead to.
const CLAUDE_DROPPED_SWITCHES = new Set(["-c", "--continue", "--fork-session"]);
// A kept option that works only with a dropped one goes too: only the MCP
// servers of --mcp-config, an agent that --agents defines, the login that
// --bare reads from --settings.
const CLAUDE_NEEDS = new Map([["--strict-mcp-config", "--mcp-config"], ["--agent", "--agents"], ["--bare", "--settings"]]);

const option = (s) => word(s) && s.startsWith("-");

// An absolute or home path stays as Claude got it. A relative one is joined
// to the launch folder, or null without one. (Pi's args.js resolves its own
// paths; this module imports nothing, so it cannot share that code.)
/** @param {string} path @param {unknown} cwd */
function folder(path, cwd) {
  if (path.startsWith("/") || path === "~" || path.startsWith("~/")) return path;
  if (!absolute(cwd)) return null;
  const parts = [];
  for (const part of `${cwd}/${path}`.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// The launch options in the words after Claude's program name. cwd is the
// folder Claude started in, for relative paths. Bare words are prompts or
// files to attach, never options.
/** @param {unknown[]} words @param {unknown} [cwd] @returns {string[]} */
export function claudeOptions(words, cwd) {
  /** @type {string[][]} */
  const kept = []; // [name, ...values] for each kept option
  const dropped = new Set();
  /** @param {string} name @param {string[]} values */
  const keep = (name, values) => {
    const resolved = CLAUDE_PATHS.has(name) ? values.map((value) => folder(value, cwd)).filter((value) => value !== null) : values;
    if (resolved.length) kept.push([name, ...resolved]);
  };
  for (let i = 0; i < words.length; i++) {
    const current = words[i];
    if (!word(current) || current === "--") break;
    if (!current.startsWith("-")) continue;
    // --name=value is the same option as --name value.
    const eq = current.startsWith("--") ? current.indexOf("=") : -1;
    const name = eq < 0 ? current : current.slice(0, eq);
    const inline = eq < 0 ? null : current.slice(eq + 1);
    // A list ends at the next option; with =, only the inline value is its
    // own and any later bare word is input.
    let end = i + 1;
    if (inline === null) while (end < words.length && !option(words[end])) end++;
    if (CLAUDE_VALUES.has(name)) {
      const value = inline ?? words[++i];
      if (!word(value)) break;
      keep(CLAUDE_VALUES.get(name), [value]);
    } else if (CLAUDE_LISTS.has(name)) {
      const values = inline === null ? words.slice(i + 1, end) : [inline];
      if ((inline === null && end === words.length) || !values.every(word)) break;
      keep(CLAUDE_LISTS.get(name), /** @type {string[]} */ (values));
      i = end - 1;
    } else if (CLAUDE_DROPPED_LISTS.has(name)) {
      dropped.add(name);
      i = end - 1;
    } else if (CLAUDE_DROPPED_VALUES.has(name)) {
      dropped.add(name);
      if (inline === null) i++;
    } else if (inline === null && CLAUDE_SWITCHES.has(name)) {
      kept.push([name]);
    } else if (!(inline === null && CLAUDE_DROPPED_SWITCHES.has(name))) {
      break;
    }
  }
  return kept.filter(([name]) => !dropped.has(CLAUDE_NEEDS.get(name))).flat();
}

// The options in an old herdr.claude-options label ({ version: 1, options }),
// or null. Only a record that the allowlist itself would keep counts, so a
// label set by hand adds no other option.
/** @param {unknown} raw @returns {string[] | null} */
export function claudeOptionsRecord(raw) {
  try {
    const value = JSON.parse(/** @type {string} */ (raw));
    if (value?.version !== 1 || !Array.isArray(value.options) || !value.options.every(word)) return null;
    const options = claudeOptions([...value.options, "--"]);
    return options.length === value.options.length && options.every((o, i) => o === value.options[i]) ? options : null;
  } catch { return null; }
}
