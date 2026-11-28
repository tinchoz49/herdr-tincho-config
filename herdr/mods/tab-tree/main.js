// One sidebar list: every tab, grouped by its Herdr space. A tab reads as its
// primary pane (the first one in its split tree); panes split off it nest
// under it, following who was split from whom. Each row says what runs there:
// an agent (with its status), an idle shell, or a program (nvim, lazygit, ...).
// Hover a tab back at a shell prompt for ↻: it recovers the agent the terminal
// last ran (resume.js). No record of one, no button.
// A suspended agent's tab shows a dimmed name and 💤, and "waking…" while its
// stand-in wakes it; it never offers ↻.
// It also runs the suspension policy (suspend-policy.js): unused agents are
// suspended, and a suspended agent wakes when you click its row (not on focus).
// Drag a group's header above or below another group to reorder the spaces.
// Drag a tab between two rows to reorder it, or into another space to move it
// there, programs still running. A ghost of the row follows the pointer and a
// line shows where it lands; leaving the sidebar cancels the drag.
// Click a space to show it, a tab to select it, a pane to focus it; right-click
// for the shipped menu; hover a tab for close, a space for +.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, terminals, machines, run, openOverlay, theme, shared, setShared, exec, hc, home, layout } from "herdr";
import { LABEL, RECIPES, WAKE_MS, createRecovery, remember, claudeLaunch, rememberClaudeLaunch, waking, frontProgram, holderInFront } from "./resume.js";
import { claudeCandidate, processIdentity } from "./claude-polling.js";
import { SUSPENDED, STANDIN_APP, suspension } from "./recipes.js";
import { createSuspender } from "./suspend-policy.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as in the shipped mods.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const TAG = "tag"; // the label tag-prompt sets (right-click > Set tag…): one short tag per terminal, shown as a chip
const ICONS = "mods/workspace-chrome";
// The avatar colors the shipped spaces list uses, so a space keeps its color.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// The most urgent of some statuses (RANK), or null.
const topStatus = (statuses) => statuses.reduce((m, st) => ((RANK[st] ?? 0) > (RANK[m] ?? 0) ? st : m), null);

// A program table entry (herdr.d.ts Program) for a program the table did not
// describe: a shell, or a plain program, without an icon.
const plainProgram = (name, shell) => ({ key: shell ? "shell" : "program", name, icon: null, tint: false, tile: null, color: null, shell, agent: false });

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Whether a terminal's labels carry the suspension label.
/** @param {Record<string, string> | undefined} labels */
const labeledSuspended = (labels) => Object.hasOwn(labels ?? {}, SUSPENDED);

const same = (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop() || "/";
function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : base(cwd);
}

// What a pane is doing: an agent, a shell waiting at its prompt, a program, or a mod.
function kind(p) {
  if (!p.terminal) return "mod";
  if (p.program?.agent || p.status) return "agent";
  if (p.program?.shell) return "shell";
  return "program";
}

// Who was split from whom: splitting pane X puts [X, new] where X was, so in
// every container the first child is the one the others came from. Its first
// leaf heads the container; the other children hang under it.
function lineage(node) {
  if (node?.type === "block") return { pane: node.id, kids: [] };
  const items = (node?.children ?? []).map(lineage).filter(Boolean);
  if (!items.length) return null;
  items[0].kids.push(...items.slice(1));
  return items[0];
}

// One JSON-RPC call to herdr-core: the tab trees live in its "herdr-app" document.
async function docGet(on) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: on ? { name: "herdr-app", on } : { name: "herdr-app" } });
  const r = await exec("sh", ["-c", 'printf "%s\\n" "$1" | hc connect', "sh", req]);
  return JSON.parse(r.stdout.split("\n")[0]).result?.value ?? null;
}

export default class TabTree extends View {
  init(_props, cx) {
    this.recovery = createRecovery();
    this.trees = {}; // tab id -> lineage root, pane ids as panes() names them
    this.sig = null;
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    this.hovered = null;
    this.press = null; // what the left button went down on: a tab or a group, and where
    this.drag = null; // that press, once the pointer moved far enough to make it a drag
    this.dragged = false; // the last press became a drag: its click must not select
    this.target = null; // where it lands: { g, j, before } (j: tab row, -1: top of the space)
    this.pointer = null; // the pointer, relative to the sidebar, for the ghost
    this.git = {}; // [machine, folder] -> { repo, root, name, worktree }, null: not a repo
    this.asking = new Set();
    this.labeling = new Set(); // `${address}=${agent}` labels on their way to the core
    this.labels = new Map(); // address -> its core labels, as of the last render
    cx.timer.every(3000, (cx) => this.remember(cx));
    this.sessionsBusy = false;
    cx.timer.every(10000, (cx) => this.rememberSessions(cx));
    // One policy per copy; only the leading copy acts (several windows can
    // show tab-tree at once). Focus and manual requests are observed in
    // render; the 15 s pass is the only periodic work (it never overlaps
    // itself).
    this.suspender = createSuspender();
    cx.timer.every(15000, (cx) => cx.spawn(() => this.suspender.pass()));
    this.refresh(cx);
  }

  close() {
    this.recovery.close();
    this.suspender.close();
  }

  // From render: the policy records the focus and the manual requests; what
  // it must do about them (publish, requests) starts outside render, in a task.
  observeSuspension(cx) {
    if (!this.suspender.observe()) return;
    cx.spawn(() => this.suspender.act());
  }

  // A terminal's tag (its `tag` label) as a small chip, or nothing.
  tagChip(t, address) {
    const tag = address ? this.labels.get(address)?.[TAG] : null;
    if (!tag) return null;
    return div().flex_none().max_w(110).truncate().px(5).h(16).rounded(4).bg(t.accent + "26")
      .text_size(10.5).font_medium().text_color(t.accent).flex().items_center().child(tag);
  }

  // Re-read the split trees whenever the panes or their order change.
  watch(cx) {
    const sig = panes().map((p) => `${p.tab}:${p.pane}`).join(",");
    if (sig === this.sig) return;
    this.sig = sig;
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return void (this.again = true);
    this.loading = true;
    cx.spawn(async (cx) => {
      do {
        this.again = false;
        const trees = {};
        for (const m of machines()) {
          if (m.layout !== "ready") continue;
          const prefix = m.name ? `${m.name}/` : "";
          try {
            const doc = await docGet(m.name);
            for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) {
              const root = lineage(t.root);
              const fix = (n) => ({ pane: prefix + n.pane, kids: n.kids.map(fix) });
              if (root) trees[prefix + t.id] = fix(root);
            }
          } catch {
            // Keep what that machine showed; the flat fallback covers new tabs.
            const mine = (id) => (prefix ? id.startsWith(prefix) : !id.includes("/"));
            for (const [id, tree] of Object.entries(this.trees)) if (mine(id)) trees[id] ??= tree;
          }
        }
        this.trees = trees;
      } while (this.again);
      this.loading = false;
      cx.notify();
    });
  }

  // The tab's lineage with live panes, depth first. Panes the doc doesn't know
  // yet (just split) hang under the primary until the next read.
  tree(tab, ps) {
    const mine = ps.filter((p) => p.tab === tab.id);
    const byId = new Map(mine.map((p) => [p.pane, p]));
    const used = new Set();
    const live = (n) => {
      const p = byId.get(n.pane);
      const kids = n.kids.map(live).flat();
      if (!p) return kids;
      used.add(p.pane);
      return [{ p, kids }];
    };
    const roots = this.trees[tab.id] ? live(this.trees[tab.id]) : [];
    const root = roots[0] ?? (mine[0] && { p: mine[0], kids: [] });
    if (!root) return null;
    used.add(root.p.pane);
    root.kids.push(...roots.slice(1), ...mine.filter((p) => !used.has(p.pane)).map((p) => ({ p, kids: [] })));
    return root;
  }

  // Which repo a folder is in, and its worktree when it's a linked one. One git
  // call per folder, the first time a pane is seen there; undefined until then.
  gitOf(on, cwd, cx) {
    if (!cwd) return null;
    const key = JSON.stringify([on ?? null, cwd]);
    if (key in this.git) return this.git[key];
    if (this.asking.has(key)) return undefined;
    this.asking.add(key);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd, on });
        const [common, top] = r.stdout.trim().split("\n");
        const root = common?.endsWith("/.git") ? common.slice(0, -5) : common;
        this.git[key] = r.code !== 0 || !top ? null
          : { repo: JSON.stringify([on ?? null, common]), root, name: base(root).replace(/\.git$/, ""), worktree: top !== root ? base(top) : null };
      } catch {
        this.git[key] = null;
      }
      this.asking.delete(key);
      cx.notify();
    });
    return undefined;
  }

  // Labels each local terminal with the agent running in it (LABEL), so the
  // core still knows it after losing the agent; the ↻ button reads it back.
  // Never a stand-in: the app's generic agent entry describes it (it reports
  // its status), and while the suspension label is set the pane may still
  // show the suspended agent's last report.
  remember(cx) {
    const labels = new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
    for (const p of panes()) {
      const agent = p.program?.agent && p.program.key;
      if (!agent || !p.terminal || p.terminal.includes("/") || !labels.has(p.terminal)) continue;
      if (p.app === STANDIN_APP || labeledSuspended(labels.get(p.terminal))) continue;
      const key = `${p.terminal}=${agent}`;
      if (labels.get(p.terminal)[LABEL] === agent || this.labeling.has(key)) continue;
      this.labeling.add(key);
      cx.spawn(async () => {
        await remember(p.terminal, agent).catch(() => null);
        this.labeling.delete(key);
      });
    }
  }

  // Labels each local terminal running Claude with its session id (SESSION)
  // and launch options (CLAUDE_OPTIONS), so recovery (↻) and a wake continue
  // that exact conversation, started the same way. One pass at a time, terminals in turn.
  rememberSessions(cx) {
    if (this.sessionsBusy) return;
    // Every core terminal, not panes(): sub-agents run in terminals no pane lists.
    const todo = terminals().filter(claudeCandidate).map((t) => ({ address: t.address, identity: processIdentity(t) }));
    if (!todo.length) return;
    this.sessionsBusy = true;
    try {
      cx.spawn(async () => {
        try {
          for (const { address, identity } of todo) {
            const current = () => terminals().find((t) => t.address === address && claudeCandidate(t) && processIdentity(t) === identity);
            const before = current();
            if (!before) continue;
            const found = await claudeLaunch(address, before).catch(() => null);
            const after = current();
            if (found && after) await rememberClaudeLaunch(address, found, after.labels ?? {}).catch(() => null);
          }
        } finally {
          this.sessionsBusy = false;
        }
      });
    } catch (error) {
      this.sessionsBusy = false;
      throw error;
    }
  }

  fold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  status(t, st) {
    if (st === "working") return svg(`${ICONS}/spinner.svg`).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (st === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (st === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (st === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  // Whether a stand-in holds the terminal (GLOSSARY.md: Suspended agent,
  // Stand-in): "waking" from the stand-in's working report until the woken
  // agent reports its own status (the report outlives the stand-in's
  // replacement by the agent, fact F5), "suspended" while the suspension label
  // is set and the stand-in or herdr-shell (which starts it) runs in front,
  // else null. A live agent is never shown suspended, even when a suspension
  // label was left on its terminal (the policy removes it).
  // render() has already dropped a stale waking report (shownPane()).
  heldState(p) {
    if (!p.terminal) return null;
    if (p.app === STANDIN_APP && p.status === "working") return "waking";
    if (!this.suspensionLabel(p.terminal)) return null;
    const core = this.cores?.get(p.terminal);
    return holderInFront(core) ? "suspended" : null;
  }

  /** @param {string} address */
  suspensionLabel(address) {
    return labeledSuspended(this.labels.get(address));
  }

  now() {
    return Date.now();
  }

  // The pane as the sidebar shows it. A stand-in's "working" report that is no
  // longer a wake (waking() in resume.js: the woken agent exited, or never
  // reported) is dropped: the pane shows what runs in front instead, a shell
  // (with ↻) or a plain program. cores: terminals() by address.
  shownPane(p, now) {
    const core = p.terminal ? this.cores?.get(p.terminal) : null;
    if (!core || p.app !== STANDIN_APP || p.status !== "working" || waking(core, now)) return p;
    const front = frontProgram(core);
    const shell = Boolean(front?.shell);
    return { ...p, status: null, app: null, program: plainProgram(front?.name || "program", shell) };
  }

  // A wake that ends by the clock changes no terminal, so nothing re-renders
  // the row: one cx.sleep re-renders the view at the earliest end of a wake now shown
  // (WAKE_MS after it began; a stand-in still in front is checked again
  // WAKE_MS later). No periodic timer.
  scheduleWakeEnd(cx, now) {
    let next = Infinity;
    for (const core of this.cores.values()) {
      if (!waking(core, now)) continue;
      const end = core.status_ms + WAKE_MS;
      next = Math.min(next, end > now ? end : now + WAKE_MS);
    }
    if (next === Infinity || (this.wakeCheck ?? Infinity) <= next) return;
    this.wakeCheck = next;
    cx.spawn(async (cx) => {
      await cx.sleep(next - now);
      if (this.wakeCheck === next) this.wakeCheck = Infinity;
      cx.notify();
    });
  }

  // What a row shows where its status goes: "waking…" or 💤 for a terminal a
  // stand-in holds (held: heldState()), else the status st. A stand-in that
  // cannot wake reports blocked: that shows as usual. narrow: the rail has no
  // room for words, so waking shows the spinner.
  heldStatus(t, p, held, st, narrow = false) {
    if (held === "waking") return narrow ? this.status(t, "working") : div().flex_none().text_size(11.5).text_color(t.working).child("waking…");
    if (held === "suspended" && p.status !== "blocked") return div().flex_none().text_size(narrow ? 10 : 11.5).child("💤");
    return this.status(t, st) ?? div();
  }

  // name: what runs there; detail: where, or what it says about itself.
  describe(p) {
    const k = kind(p);
    if (k === "mod") return { k, name: p.title || p.mod, detail: "" };
    if (k === "shell") return { k, name: folder(p.cwd) || p.program.name, detail: p.program.name };
    const title = (p.title ?? "").trim();
    const telling = title && title !== p.program?.name && !/^[~/]/.test(title);
    // An agent goes by its session's name (the title it sets, e.g. Claude Code's
    // /rename), minus any leading status glyph: the icon already says which agent.
    const session = k === "agent" && telling ? title.replace(/^[^\p{L}\p{N}]+/u, "") : "";
    if (session) return { k, name: session, detail: "" };
    // A stand-in goes by the agent it holds.
    if (p.app === STANDIN_APP) {
      const labels = this.labels.get(p.terminal) ?? {};
      return { k, name: suspension(labels[SUSPENDED])?.agent ?? labels[LABEL] ?? "agent", detail: folder(p.cwd) };
    }
    return { k, name: p.program?.name || title || "program", detail: telling ? title : folder(p.cwd) };
  }

  // dim: a suspended agent's icon, faded like its name.
  glyph(t, p, k, size, dim = false) {
    return (icon(p.program, size, k === "shell" ? t.dim : t.foreground)
      ?? svg(`${ICONS}/${k === "mod" ? "square" : "terminal"}.svg`).size(size).flex_none().text_color(t.dim))
      .when(dim, (el) => el.opacity(0.5));
  }

  // A tab's name and detail as its row shows them (the picker shows the same).
  // g: its group's name; wt: the worktree its primary pane is in, if a linked one.
  label(tab, root, g, wt) {
    const p = root.p;
    const d = this.describe(p);
    // The group header already says where: no detail that repeats it, the name or the worktree.
    const name = tab.named ? tab.name : d.k === "shell" && (same(d.name, g) || same(d.name, wt)) ? p.program.name : d.name;
    // A named tab's agent or shell goes without saying: its icon says it.
    const raw = tab.named ? (d.k === "shell" || d.k === "agent" ? "" : d.name) : d.detail;
    const detail = same(raw, g) || same(raw, name) || same(raw, wt) ? "" : raw;
    return { d, name, detail };
  }

  // Shares the list as the sidebar groups and names it ("tab-tree.outline"), for
  // the tab-picker mod (⌘P). Only when it changed: every mod re-renders on a set.
  publish(groups) {
    const outline = groups.map((g) => {
      const home = g.spaces[0];
      return {
        key: g.key, name: g.name, space: home.id, color: (shared("space.colors") ?? {})[home.id] ?? "ansi6",
        tabs: g.tabs.map(({ s, tab, root, wt }) => {
          const { d, name, detail } = this.label(tab, root, g.name, wt);
          const pr = root.p.program;
          return {
            id: tab.id, name, detail, wt, kind: d.k, status: tab.status ?? null, here: Boolean(s.active && tab.active),
            icon: pr?.icon ? { path: pr.icon, tint: Boolean(pr.tint) } : null, more: this.count(root) - 1,
          };
        }),
      };
    });
    const json = JSON.stringify(outline);
    if (json !== this.published) { this.published = json; setShared("tab-tree.outline", outline); }
  }

  // The tab's own row: its primary pane, under the tab's name when someone named it.
  // g: its group's name; wt: the worktree its primary pane is in, if a linked one.
  tabRow(t, s, tab, root, collapsed, g, wt) {
    const p = root.p;
    const { d, name, detail } = this.label(tab, root, g, wt);
    const on = s.active && tab.active;
    const kidsOpen = root.kids.length > 0 && !this.folded.has(tab.id);
    const held = this.heldState(p);
    // Back at a shell prompt: ↻ recovers the agent the terminal last ran. Never
    // in a stand-in: it is the main program, so it looks like a shell. Nor
    // while the suspension label is set: recovery refuses to type then.
    const local = !held && d.k === "shell" && p.terminal && !p.terminal.includes("/") && !this.suspensionLabel(p.terminal);
    const last = local ? this.labels.get(p.terminal)?.[LABEL] : null;
    const agent = last && RECIPES[last] ? last : null;
    const hovered = this.hovered === tab.id;
    if (collapsed) {
      return h_flex().id(`tab-${tab.id}`).h(28).flex_none().justify_center().items_center().gap(3).rounded(7)
        .when(on, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
        .on_click(() => { run("tab.select", { id: tab.id }); this.wakeTab(tab.id); })
        .child(this.glyph(t, p, d.k, 15, held === "suspended"))
        .child(this.heldStatus(t, p, held, tab.status, true));
    }
    return h_flex()
      .id(`tab-${tab.id}`)
      .h(30)
      .flex_none()
      .pl(8)
      .pr(6)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((el) => el.bg(t.hover)))
      .on_hover((h, cx) => {
        if (h) this.hovered = tab.id;
        else if (this.hovered === tab.id) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.press = { kind: "tab", tab, root, s, machine: s.machine ?? null, name, k: d.k, x: e.position.x, y: e.position.y };
        this.dragged = false;
      })
      .on_click(() => { if (!this.dragged) { run("tab.select", { id: tab.id }); this.wakeTab(tab.id); } })
      .on_mouse_down("right", () => openOverlay({ mod: "tab-menu", kind: "popup", width: 220, height: 270, props: { tab: "tab", target: { id: tab.id, space: s.id, terminal: p.terminal } } }))
      .child(div().id(`tab-fold-${tab.id}`).w(12).flex_none().text_color(t.dim)
        .when(root.kids.length > 0, (el) => el.hover((el) => el.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.fold(tab.id, cx); })
          .child(svg(`${ICONS}/chevron-${kidsOpen ? "down" : "right"}.svg`).size(11))))
      .child(this.glyph(t, p, d.k, 16, held === "suspended"))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_shrink(1).min_w(0).max_w(190).truncate().text_color(held ? t.dim : d.k === "shell" && !tab.named ? t.muted : t.foreground).child(name))
        .when(Boolean(this.tagChip(t, p.terminal)), (el) => el.child(this.tagChip(t, p.terminal)))
        .when(Boolean(wt), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.muted).child(`- ${wt}`)))
        .when(Boolean(detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(detail))))
      .when(!kidsOpen && root.kids.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${this.count(root) - 1}`)))
      .when(hovered && Boolean(agent), (el) => el.child(div().id(`tab-resume-${tab.id}`).flex_none().px(3).rounded(4).text_size(13).text_color(t.dim)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip(`Resume ${agent}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const labels = this.labels.get(p.terminal) ?? {};
          cx.spawn(async (cx) => { await this.recovery.recover(cx, p.terminal, agent, labels, tab.named ? tab.name : null); });
        })
        .child("↻")))
      .when(hovered, (el) => el.child(div().id(`tab-close-${tab.id}`).flex_none().p(2).rounded(4).text_color(t.dim)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        // Its own press: the row's would arm a drag of the tab being closed.
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
        .child(svg(`${ICONS}/x.svg`).size(12))))
      .when(!hovered, (el) => el.child(this.heldStatus(t, p, held, p.status)));
  }

  // A click on a tab row wakes the suspended agents in that tab (focus alone
  // never does: see suspend-policy.js).
  wakeTab(id) {
    return this.suspender.wakeClicked(panes().filter((x) => x.tab === id).map((x) => x.terminal));
  }

  count(n) {
    return 1 + n.kids.reduce((sum, k) => sum + this.count(k), 0);
  }

  // A split pane under its tab, with tree lines like the agents list's sub-agents.
  // c: { s, g, wt, cx }: its space, group name and the tab's worktree. A pane
  // says its own worktree only when it differs from its tab's.
  paneRow(t, c, n, lines) {
    const p = n.p;
    const d = this.describe(p);
    const held = this.heldState(p);
    const git = p.terminal ? this.gitOf(c.s.machine, p.cwd, c.cx) : null;
    const wt = git && (git.worktree ?? null) !== c.wt ? git.worktree ?? base(git.root) : null;
    if (d.k === "shell" && (same(d.name, c.g) || same(d.name, git?.worktree))) d.name = p.program.name;
    if (same(d.detail, c.g) || same(d.detail, d.name) || same(d.detail, git?.worktree)) d.detail = "";
    return h_flex()
      .id(`pane-${p.pane}`)
      .h(26)
      .flex_none()
      // The tree line starts under the tab's icon (8 pad + 12 chevron + 8 gap
      // = 28), so the pane's own icon sits clearly to the right of its tab's.
      .pl(34)
      .pr(6)
      .items_center()
      .rounded(7)
      .text_size(12.5)
      .cursor_pointer()
      .when(p.focused, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click(() => { run("pane.focus", { pane: p.pane }); if (p.terminal) this.suspender.wakeClicked([p.terminal]); })
      .on_mouse_down("right", () => openOverlay({ mod: "tab-menu", kind: "popup", width: 240, height: 300, props: { tab: "pane", target: { pane: p.pane, terminal: p.terminal } } }))
      .children(lines.map((l) => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .child(div().mr(7).child(this.glyph(t, p, d.k, 14, held === "suspended")))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_shrink(0).max_w(130).truncate().text_color(held ? t.dim : p.focused ? t.foreground : t.muted).child(d.name))
        .when(Boolean(this.tagChip(t, p.terminal)), (el) => el.child(this.tagChip(t, p.terminal)))
        .when(Boolean(wt), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`- ${wt}`)))
        .when(Boolean(d.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(d.detail))))
      .child(this.heldStatus(t, p, held, p.status));
  }

  // Every pane under the tab at one level, depth first, however deep its split
  // or parent agent: one elbow each, no stacked indent.
  paneRows(t, c, n) {
    const flat = [];
    const walk = (x) => { for (const k of x.kids) { flat.push(k); walk(k); } };
    walk(n);
    return flat.map((k, i) => this.paneRow(t, c, k, [i === flat.length - 1 ? "└" : "├"]));
  }

  // A group's header: its space. Click shows it, + opens a tab there, right-click
  // is its menu.
  groupHeader(t, g, collapsed) {
    const home = g.spaces[0];
    const colors = shared("space.colors") ?? {};
    const color = colors[home.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const open = !this.folded.has(g.key);
    const hovered = this.hovered === g.key;
    const active = g.spaces.some((s) => s.active);
    const top = topStatus(g.tabs.map((x) => x.tab.status));
    const id = g.key.replace(/[^\w-]/g, "_");
    const avatar = this.avatar(fill, g.name);
    const select = () => run("space.select", { id: home.id });
    if (collapsed) {
      return h_flex().id(`group-${id}`).h(30).mt(6).flex_none().justify_center().items_center().on_click(select).child(avatar);
    }
    // The main checkout's branch, unless it's main/master.
    const raw = g.tabs.find((x) => !x.wt && x.root.p.branch)?.root.p.branch;
    const branch = raw && raw !== "main" && raw !== "master" && raw !== g.name ? raw : "";
    return h_flex()
      .id(`group-${id}`)
      .h(30)
      .mt(8)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_hover((h, cx) => {
        if (h) this.hovered = g.key;
        else if (this.hovered === g.key) this.hovered = null;
        cx.notify();
      })
      .on_mouse_down("left", (e) => {
        this.press = { kind: "group", key: g.key, machine: g.machine, name: g.name, fill, x: e.position.x, y: e.position.y };
        this.dragged = false;
      })
      // A tab dragged over a header lands at the top of that space.
      .on_mouse_move((_e, cx) => {
        if (this.press?.kind !== "tab" || this.press.machine !== g.machine) return;
        const shown = open && g.tabs.length > 0;
        this.aim(shown ? { g: g.key, j: 0, before: true } : { g: g.key, j: -1 }, cx);
      })
      .on_click(() => { if (!this.dragged) select(); })
      .on_mouse_down("right", () => openOverlay({ mod: "tab-menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: home.id } } }))
      .child(avatar)
      .child(div().flex_shrink(0).max_w(140).truncate().font_semibold().text_color(active ? t.foreground : t.muted).child(g.name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child([home.machine, branch].filter(Boolean).join(" · ")))
      .when(!open && top && top !== "idle", (el) => el.child(this.status(t, top) ?? div()))
      .when(hovered, (el) => el.child(div().id(`group-new-tab-${id}`).flex_none().p(3).rounded(4).text_color(t.dim)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip("New tab")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.new", g.root ? { space: home.id, folder: g.root } : { space: home.id }); })
        .child(svg(`${ICONS}/plus.svg`).size(13))))
      .child(div().id(`group-fold-${id}`).flex_none().p(2).rounded(4).text_color(t.dim)
        .hover((el) => el.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.fold(g.key, cx); })
        .child(svg(`${ICONS}/chevron-${open ? "down" : "right"}.svg`).size(11)));
  }

  // One group per Herdr space, in the spaces' order. A tab still says the git
  // worktree its primary pane is in; the group's + opens a tab in its repo's
  // main checkout when its tabs are in one.
  groups(sp, ps, cx) {
    return sp.map((s) => {
      const g = { key: `space:${s.id}`, name: s.name, root: null, machine: s.machine ?? null, spaces: [s], tabs: [] };
      for (let tab of s.tabs) {
        const root = this.tree(tab, ps);
        if (!root) continue;
        if (this.recomputedTabs?.has(tab.id)) tab = { ...tab, status: topStatus(ps.filter((p) => p.tab === tab.id).map((p) => p.status)) };
        const git = root.p.terminal ? this.gitOf(s.machine, root.p.cwd, cx) : null;
        g.root ??= git?.root ?? null;
        g.tabs.push({ s, tab, root, wt: git?.worktree ?? null });
      }
      return g;
    });
  }

  // Moves a tab's terminals to another space on the same machine, as one new
  // tab there; the programs keep running. Herdr has no command for it: park
  // each terminal (its pane goes, the process stays), then point its
  // herdr.space / herdr.tab labels at the target, and Herdr adopts it there.
  // index: where it goes in that space (1 = first); left out, it goes last.
  moveTab(tab, root, to, cx, index) {
    const terms = [];
    const walk = (n) => { if (n.p.terminal) terms.push(n.p.terminal); n.kids.forEach(walk); };
    walk(root);
    if (!terms.length) return;
    const local = (id) => id.split("/").pop();
    const id = "tb" + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const prefix = to.machine ? `${to.machine}/` : "";
    cx.spawn(async (cx) => {
      const sleep = (ms) => new Promise((r) => cx.timer.after(ms, () => r()));
      const shown = () => panes().some((p) => terms.includes(p.terminal));
      for (const t of terms) run("terminal.park", { terminal: t });
      // Parking applies once the machine replies: relabel only after the panes are gone.
      for (let i = 0; i < 30 && shown(); i++) await sleep(100);
      for (const t of terms) await hc(["label", t, `herdr.space=${local(to.id)}`, `herdr.tab=${id}`]).catch(() => null);
      for (let i = 0; i < 30 && !panes().some((p) => p.tab === prefix + id); i++) await sleep(100);
      if (index) run("tab.move", { id: prefix + id, index });
      run("tab.select", { id: prefix + id });
    });
  }

  // New spaces get the least used avatar color, as the shipped spaces list does.
  colors(sp) {
    const palette = Object.keys(MARK);
    const ids = new Set(sp.map((s) => s.id));
    const all = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(all).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[s.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  // Drops group `from` just before (or after) group `to`: the spaces go in the new
  // group order, each where its first group puts it, via space.move (it keeps
  // machines apart).
  drop(groups, from, to, before) {
    const keys = groups.map((g) => g.key);
    const a = keys.indexOf(from);
    if (a < 0 || from === to || !keys.includes(to)) return;
    keys.splice(a, 1);
    const b = keys.indexOf(to);
    keys.splice(before ? b : b + 1, 0, from);
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const order = [];
    for (const k of keys) for (const s of byKey.get(k).spaces) if (!order.includes(s.id)) order.push(s.id);
    for (const s of spaces()) if (!order.includes(s.id)) order.push(s.id);
    order.forEach((id, i) => {
      if (spaces()[i]?.id !== id) run("space.move", { id, index: i + 1 });
    });
  }

  avatar(fill, name) {
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
      .text_size(10.5).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?");
  }

  // Points the drag at a drop slot; repaints only once it's a drag and the slot changed.
  aim(target, cx) {
    const old = this.target;
    this.target = target;
    if (this.drag && (old?.g !== target.g || old?.j !== target.j || old?.before !== target.before)) cx.notify();
  }

  // Before a drag starts, a press only arms it: it starts once the pointer has
  // moved 4px, so a click with a shaky hand still just clicks.
  track(e, cx) {
    const pr = this.press;
    if (!pr) return;
    if (!this.drag) {
      if (Math.hypot(e.position.x - pr.x, e.position.y - pr.y) < 4) return;
      this.drag = pr;
      this.dragged = true;
    }
    this.pointer = e.local_position;
    cx.notify();
  }

  cancel(cx) {
    const was = this.drag;
    this.press = this.drag = this.target = this.pointer = null;
    if (was) cx.notify();
  }

  // The release: a space goes before or after the group it's over; a tab goes
  // to its slot, by tab.move in its own space or moveTab into another one.
  finish(groups, cx) {
    const d = this.drag, tg = this.target;
    this.cancel(cx);
    const g = d && tg && groups.find((x) => x.key === tg.g);
    if (!g) return;
    if (d.kind === "group") return this.drop(groups, d.key, tg.g, tg.before);
    const to = g.spaces[0];
    const ids = to.tabs.map((x) => x.id);
    let p = tg.j < 0 ? 0 : ids.indexOf(g.tabs[tg.j].tab.id) + (tg.before ? 0 : 1);
    if (to.id !== d.s.id) return this.moveTab(d.tab, d.root, to, cx, p + 1);
    const a = ids.indexOf(d.tab.id);
    if (a < p) p -= 1;
    if (p !== a) run("tab.move", { id: d.tab.id, index: p + 1 });
  }

  // What follows the pointer while dragging: the row's icon and name, just off
  // the cursor so it never sits between the pointer and the rows it's over.
  ghost(t) {
    const d = this.drag, at = this.pointer;
    if (!d || !at) return null;
    return h_flex().absolute().left(at.x + 14).top(at.y + 6).max_w(220).h(28).px(10).gap(8).items_center()
      .rounded(8).bg(t.raised).border_1().border_color(t.input).shadow_md().opacity(0.92)
      .text_color(t.foreground)
      .child(d.kind === "tab" ? this.glyph(t, d.root.p, d.k, 15) : this.avatar(d.fill, d.name))
      .child(div().min_w(0).truncate().when(d.kind === "group", (el) => el.font_semibold()).child(d.name));
  }

  // Files / Changes: open the layout's side panel on that view, as the shipped
  // tabs bar does. Click the lit one again to close the panel.
  panelButtons(t) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return [];
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    const views = [["files", "Files", "mods/files/file.svg"], ["changes", "Changes", "mods/changes/changes.svg"]];
    return views.filter(([id]) => enabled.includes(id)).map(([id, label, icon]) => {
      const on = !panel.hidden && body.active === id;
      return div().id(`panel-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip(label)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        })
        .child(svg(icon).size(14));
    });
  }

  render(cx) {
    this.watch(cx);
    this.observeSuspension(cx);
    const t = theme();
    const collapsed = narrow();
    const now = this.now();
    const cores = terminals();
    this.cores = new Map(cores.map((t) => [t.address, t]));
    this.labels = new Map(cores.map((t) => [t.address, t.labels ?? {}]));
    this.scheduleWakeEnd(cx, now);
    const raw = panes();
    const ps = raw.map((p) => this.shownPane(p, now));
    // A tab whose pane lost a stale report: its status from its panes again.
    this.recomputedTabs = new Set(ps.filter((p, i) => p !== raw[i]).map((p) => p.tab));
    const sp = spaces();
    this.colors(sp);
    const groups = this.groups(sp, ps, cx);
    this.publish(groups);
    const d = this.drag, tg = this.target;
    // The drop line: across the slot's edge, inset like the rows.
    const line = (el, before) => el.child(div().absolute().left(6).right(4).h(2).rounded(1).bg(t.accent)
      .when(before, (l) => l.top(0)).when(!before, (l) => l.bottom(0)));
    const rows = groups.map((g, i) => {
      const tabs = this.folded.has(g.key) ? [] : g.tabs.map(({ s, tab, root, wt }, j) => {
        const kids = collapsed || this.folded.has(tab.id) ? [] : this.paneRows(t, { s, g: g.name, wt, cx }, root);
        const mine = d?.kind === "tab" && d.tab.id === tab.id;
        const slot = d?.kind === "tab" && !mine && tg?.g === g.key && tg.j === j;
        // A tab with its panes: the upper half of the block drops above it, the lower half below.
        return v_flex()
          .id(`tab-box-${tab.id}`)
          .relative()
          .flex_none()
          .when(mine, (el) => el.opacity(0.4))
          .on_mouse_move((e, cx) => {
            if (this.press?.kind !== "tab" || this.press.machine !== g.machine) return;
            this.aim({ g: g.key, j, before: e.local_position.y < e.bounds.height / 2 }, cx);
          })
          .child(this.tabRow(t, s, tab, root, collapsed, g.name, wt))
          .children(kids)
          .when(slot, (el) => line(el, tg.before));
      });
      // A tab on its way to another space: that space lights up.
      const into = d?.kind === "tab" && tg?.g === g.key && d.s.id !== g.spaces[0].id;
      const slot = d?.kind === "group" && d.key !== g.key && tg?.g === g.key;
      return v_flex()
        .id(`group-box-${i}`)
        .relative()
        .flex_none()
        .rounded(8)
        .when(d?.kind === "group" && d.key === g.key, (el) => el.opacity(0.4))
        .when(into, (el) => el.bg(t.accent + "1f").border_1().border_color(t.accent))
        // Spaces move only among their machine's: space.move stays inside one.
        .on_mouse_move((e, cx) => {
          if (this.press?.kind !== "group" || this.press.machine !== g.machine) return;
          this.aim({ g: g.key, j: null, before: e.local_position.y < e.bounds.height / 2 }, cx);
        })
        .child(this.groupHeader(t, g, collapsed))
        .children(tabs)
        .when(slot, (el) => line(el, tg.before));
    });
    return v_flex()
      // A fixed id: on_hover makes this element track its hover, and without
      // one it lost its identity, and the list inside its scroll position,
      // each time the pointer left the sidebar.
      .id("tab-tree-root")
      .size_full()
      .min_h(0)
      .relative()
      .overflow_hidden()
      .bg(t.chrome)
      .text_size(13)
      .on_mouse_move((e, cx) => this.track(e, cx))
      .on_mouse_up("left", (_e, cx) => this.finish(groups, cx))
      .on_hover((h, cx) => { if (!h) this.cancel(cx); })
      .when(!collapsed, (el) => el.child(h_flex().h(31).flex_none().pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .child("Tabs")
        .child(h_flex().flex_none().gap(2).items_center()
          .children(this.panelButtons(t))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6)
            .hover((el) => el.bg(t.hover).text_color(t.foreground))
            .tooltip("New space")
            .on_click(() => run("space.new"))
            .child(svg(`${ICONS}/folder-plus.svg`).size(14))))))
      .child(v_flex().id("tab-tree-rows").flex_1().min_h(0).px(collapsed ? 4 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .children(rows))
      .when(Boolean(this.drag && this.pointer), (el) => el.child(this.ghost(t)));
  }
}
