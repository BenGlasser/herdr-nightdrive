// Nightdrive's PR list: the pull requests an agent's session opened. Two ways to show it:
// - a pane beside one agent, from the agent's pane header, tab or right-click menu:
//     pane.split {direction: "right", pane, mod: "nightdrive-prs", props: {terminal, agent: pane}}
// - a side panel (the tab bar's PRS button), a layout block with props {block: "<its id>"}:
//   it lists the focused agent's session (else the shown tab's first agent), so it follows you.
// props: terminal, agent (its pane), block, urls (more PR links to always list).
// It finds PRs in the session's Claude Code transcript (its "pr-link" records, and its
// sub-agents'), then adds PRs that share their ticket id (APP-1234) with the same owners, and
// links pasted below. Each row is its own check indicator (ciLayer in prs.js). Clicking a row
// opens the review (nightdrive-pr) beside the agent; ⌥-click (or the row's tab icon) opens it in
// a tab of its own.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { agents, exec, focused, home, layout, panes, props, readTextFile, shared, spaces, terminals, theme } from "herdr";
import { DISPLAY, agentPane as tabAgent } from "./nightdrive.js";
import { parseUrl, repoLabel, tickets, graphql, ciState, ciLayer, openTab, openBeside } from "./prs.js";

const TICK_MS = 15000;   // looks at the transcript; GitHub too while checks run
const IDLE_MS = 60000;   // GitHub otherwise
const ROW = 36;
const LOCAL = /^[A-Za-z0-9_-]+$/;
const FIELDS = `number title url state isDraft headRefName updatedAt
  repository { name owner { login __typename } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const isAgent = (p) => Boolean(p?.terminal && (p.program?.agent || p.app));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Per session (its terminal): seen, every PR its transcripts ever named, so they stay after
// /clear or a new session; extra, pasted links; hidden, rows you closed.
function stored(terminal) {
  try {
    const s = JSON.parse(localStorage.getItem(`prs:${terminal}`) ?? "{}");
    return { seen: s.seen ?? [], extra: s.extra ?? [], hidden: s.hidden ?? [] };
  } catch { return { seen: [], extra: [], hidden: [] }; }
}

export default class Prs extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.fixed = given.terminal ? { terminal: given.terminal, pane: given.agent ?? null } : null;
    this.block = given.block ?? null;
    // In the panel dock (mods/nightdrive-dock) it shows when the dock says so, not by its own block.
    this.inDock = Boolean(given.dock);
    this.given = (given.urls ?? []).map(parseUrl).filter(Boolean).map((u) => u.url);
    this.width = 420;
    this.input = InputState.new({ placeholder: "Paste a PR link" });
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.retarget();
    this.tick(cx, true);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  get terminal() { return this.current?.terminal ?? null; }
  get agentPane() { return this.current?.pane ?? null; }

  // Whose session: the pane's own agent; or, for the panel, the focused agent, else the shown
  // tab's first agent, else the one it listed last (so clicking into a shell keeps the list).
  target() {
    if (this.fixed) return this.fixed;
    const f = focused(), fp = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    const p = isAgent(fp) ? fp : f?.tab ? tabAgent(f.tab) : null;
    return p ? { terminal: p.terminal, pane: p.pane } : this.current ?? { terminal: null, pane: null };
  }

  // Moves to the target's session when it changed (true then).
  retarget() {
    const next = this.target();
    const changed = !this.current || next.terminal !== this.current.terminal;
    this.current = next;
    if (changed) {
      this.store = stored(next.terminal);
      this.prs = {};
      this.loaded = false;
      this.last = 0;
      this.error = null;
      this.transcripts = undefined;
    }
    return changed;
  }

  save() { localStorage.setItem(`prs:${this.terminal}`, JSON.stringify(this.store)); }

  // The panel: shown when nothing above its block is hidden and each stack shows its branch.
  // The pane: when the agent's tab is the one showing.
  visible() {
    if (this.inDock) return (shared("dock")?.shown ?? []).includes(this.block);
    if (this.block) {
      const root = layout(), id = this.block;
      if (!find(root, id)) return true;
      const shown = (node) => {
        if (!node || node.hidden) return false;
        if (node.id === id) return true;
        const kids = node.children ?? [];
        if (node.type === "stack") return shown(kids.find((c) => c.id === node.active) ?? kids[0]);
        return kids.some(shown);
      };
      return shown(root);
    }
    const tab = panes().find((x) => x.pane === this.agentPane)?.tab;
    if (!tab) return true;
    return Boolean(spaces().find((s) => s.active)?.tabs.some((x) => x.id === tab && x.active));
  }

  // The agent's terminal and every sub-agent under it (hc run's parent): this machine's only.
  session(term) {
    const all = terminals(), out = new Set(term ? [term] : []);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of all) if (x.parent && out.has(x.parent) && !out.has(x.address)) { out.add(x.address); grew = true; }
    }
    return [...out].filter((a) => LOCAL.test(a));
  }

  // PR links from the session's transcripts: Claude Code writes a "pr-link" record for each PR
  // the session opens or links. The transcript's path is in the status line file.
  async discover(term) {
    const found = new Set();
    let transcripts = 0;
    for (const t of this.session(term)) {
      const text = await readTextFile(`${home()}/.claude/state/statusline/${t}.json`).catch(() => null);
      let path = null;
      try { path = JSON.parse(text ?? "null")?.status?.transcript_path ?? null; } catch {}
      if (!path) continue;
      transcripts++;
      // Exit 2 just means there's no subagents folder; what grep found still counts.
      const r = await exec("grep", ["-rhoE", '"type":"pr-link"[^}]*', path, `${path.replace(/\.jsonl$/, "")}/subagents`]).catch(() => null);
      for (const m of (r?.stdout ?? "").matchAll(/"prUrl":"([^"]+)"/g)) {
        const u = parseUrl(m[1]);
        if (u) found.add(u.url);
      }
    }
    return { found, transcripts };
  }

  tick(cx, force = false) {
    if (this.busy || (!force && !this.visible())) return;
    const term = this.terminal, store = this.store;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const { found, transcripts } = await this.discover(term);
        if (this.terminal !== term) return;
        this.transcripts = transcripts;
        const fresh = [...found].filter((u) => !store.seen.includes(u));
        if (fresh.length) { store.seen.push(...fresh); this.save(); }
        const running = Object.values(this.prs).some((p) => p.state === "OPEN" && ciState(p) === "running");
        if (force || fresh.length || Date.now() - this.last >= (running ? TICK_MS - 1000 : IDLE_MS)) {
          const next = await this.fetch(store, this.prs);
          if (this.terminal !== term) return;
          this.prs = next;
          this.last = Date.now();
        }
        this.error = null;
      } catch (e) {
        if (this.terminal === term) this.error = String(e?.message ?? e);
      } finally {
        if (this.terminal === term) this.loaded = true;
        this.busy = false;
        // The panel moved to another session while this one was loading: load that one now.
        if (this.terminal !== term) this.tick(cx, true);
        cx.notify();
      }
    });
  }

  // One GraphQL query: every known PR, plus a search per ticket id for the PRs that share it.
  // Tickets come from the PRs themselves, so the first time a new one turns up, a second round
  // searches for it.
  async fetch(store, prev) {
    const hidden = new Set(store.hidden);
    const list = [...new Set([...store.seen, ...store.extra, ...this.given])].filter((u) => !hidden.has(u)).map(parseUrl).filter(Boolean);
    let known = prev, next = {};
    for (let round = 0; round < 2; round++) {
      const searches = new Map();
      for (const p of Object.values(known)) {
        const o = p.repository?.owner, qual = o ? `${o.__typename === "Organization" ? "org" : "user"}:${o.login}` : null;
        if (qual) for (const id of tickets(p)) searches.set(`${qual} ${id}`, { qual, id });
      }
      const s = [...searches.values()];
      if (!list.length && !s.length) return {};
      const query = "query {\n"
        + list.map((u, i) => `p${i}: repository(owner: ${JSON.stringify(u.owner)}, name: ${JSON.stringify(u.name)}) { pullRequest(number: ${u.number}) { ${FIELDS} } }`).join("\n")
        + "\n" + s.map((x, i) => `s${i}: search(query: ${JSON.stringify(`${x.qual} is:pr ${x.id}`)}, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${FIELDS} } } }`).join("\n")
        + "\n}";
      const d = await graphql(query);
      next = {};
      list.forEach((u, i) => { const p = d[`p${i}`]?.pullRequest; if (p) next[u.url] = p; });
      s.forEach((x, i) => {
        for (const p of d[`s${i}`]?.nodes ?? []) {
          const u = parseUrl(p?.url)?.url;
          // The id in its title or branch, not just somewhere in its description.
          if (u && !hidden.has(u) && !next[u] && tickets(p).includes(x.id)) next[u] = { ...p, sibling: true };
        }
      });
      const before = new Set(Object.values(known).flatMap(tickets));
      known = next;
      if (Object.values(next).flatMap(tickets).every((id) => before.has(id))) break;
    }
    return next;
  }

  add(cx) {
    const u = parseUrl(this.input.value());
    if (!u) { this.note = "That isn't a GitHub pull request link."; cx.notify(); return; }
    this.note = null;
    this.input.set_value("");
    this.store.hidden = this.store.hidden.filter((x) => x !== u.url);
    if (!this.store.extra.includes(u.url)) this.store.extra.push(u.url);
    this.save();
    this.tick(cx, true);
  }

  hide(url, cx) {
    if (!this.store.hidden.includes(url)) this.store.hidden.push(url);
    this.store.extra = this.store.extra.filter((x) => x !== url);
    this.save();
    delete this.prs[url];
    cx.notify();
  }

  // The review beside the agent (in this list's place when this is the pane), else in a tab.
  beside(p) { if (!openBeside(p.url, this.agentPane)) this.open(p); }

  // The review in a tab of its own, in the agent's space (shown again if it's open).
  open(p) { openTab(p.url, this.agentPane, this.terminal); }

  rowButton(t, id, icon, tip, action) {
    return div().id(id).flex_none().p(3).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.accent)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(svg(icon).size(13));
  }

  row(t, p) {
    const u = parseUrl(p.url), state = p.state === "OPEN" ? ciState(p) : null, done = p.state !== "OPEN";
    const tag = p.state === "MERGED" ? ["MERGED", "#a82fff"] : p.state === "CLOSED" ? ["CLOSED", t.dim] : p.isDraft ? ["DRAFT", t.muted] : null;
    const hovered = this.hovered === u.url;
    return h_flex().id(`pr-${u.url}`).relative().w_full().h(ROW).flex_none().pl(12).pr(state === "failure" ? 96 : 12).gap(10).items_center()
      .border_b(1).border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { this.hovered = on ? u.url : this.hovered === u.url ? null : this.hovered; cx.notify(); })
      .tooltip("Click: review beside the agent · ⌥-click: in a tab of its own")
      .on_click((e) => (e.modifiers?.alt ? this.open(p) : this.beside(p)))
      .child(ciLayer(state, this.width, ROW))
      .child(div().w(54).flex_none().text_size(12).font_bold().text_color(done ? t.dim : t.accent).child(`#${p.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(done ? t.muted : t.foreground).child(p.title))
      .when(Boolean(tag), (e) => e.child(div().flex_none().px(5).py(1).border_1().border_color(tag[1]).text_size(9.5).font_bold().text_color(tag[1]).child(tag[0])))
      .when(hovered, (e) => e
        .child(this.rowButton(t, `tab-${u.url}`, "mods/nightdrive-pane/zoom.svg", "Review in a tab of its own", () => this.open(p)))
        .child(this.rowButton(t, `hide-${u.url}`, "mods/nightdrive-pane/close.svg", "Hide from this list", (cx) => this.hide(u.url, cx))))
      .child(div().flex_none().max_w(130).truncate().text_size(10.5).font_bold().text_color(t.dim).child(repoLabel(u.owner, u.name).toUpperCase()));
  }

  render(cx) {
    const t = theme();
    // The panel follows the focused agent; render runs whenever focus changes.
    if (!this.fixed && this.retarget()) this.tick(cx, true);
    const shown = this.visible();
    if (shown && !this.wasShown) this.tick(cx, true); // catch up as soon as it's shown
    this.wasShown = shown;

    // Grouped by ticket (the newest group first); open PRs first within one, then the newest.
    const all = Object.values(this.prs);
    const groups = new Map();
    for (const p of all) {
      const id = tickets(p)[0] ?? "";
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    }
    const newest = (list) => Math.max(...list.map((p) => Date.parse(p.updatedAt) || 0));
    const order = [...groups.entries()].sort((a, b) => (a[0] === "") - (b[0] === "") || newest(b[1]) - newest(a[1]));
    const headed = order.some(([id]) => id);
    const rows = [];
    for (const [id, list] of order) {
      list.sort((a, b) => (a.state !== "OPEN") - (b.state !== "OPEN") || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      if (headed) rows.push(h_flex().id(`group-${id || "other"}`).h(28).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().font_family(DISPLAY).text_size(7.5).text_color(id ? t.solid : t.dim).child(id || "OTHER"))
        .child(div().text_size(10.5).text_color(t.dim).child(`${list.length}`)));
      for (const p of list) rows.push(this.row(t, p));
    }

    const open = all.filter((p) => p.state === "OPEN");
    const count = (s) => open.filter((p) => ciState(p) === s).length;
    const summary = !this.loaded ? "Looking…" : !all.length ? "No pull requests" : [
      `${open.length} OPEN`,
      count("failure") && `${count("failure")} FAILING`,
      count("running") && `${count("running")} RUNNING`,
    ].filter(Boolean).join(" · ");
    const empty = !this.terminal ? (this.block ? "Focus an agent to list its session's pull requests." : "Open this from an agent's pane header to list its session's pull requests.")
      : !this.loaded ? "Looking for this session's pull requests…"
      : this.transcripts === 0 ? "No Claude Code transcript for this terminal yet. Paste a PR link below to list it."
      : "No pull requests yet. The ones this session opens show up here, with others on the same ticket.";
    const who = agents().find((a) => a.address === this.terminal);

    return v_flex().id("prs").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .when(Boolean(this.block), (e) => e.border_1().border_color(t.border))
      .on_size_change((size, cx) => { if (Math.round(size.width) !== Math.round(this.width)) { this.width = size.width; cx.notify(); } })
      // The panel's own title, like Files, Changes and Dash; a pane has the pane header instead.
      .when(Boolean(this.block), (e) => e.child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_color(t.solid).child("//")).child(div().font_family(DISPLAY).text_size(8).text_color(t.accent).child("PRS"))
        .child(div().flex_1())
        .child(div().max_w(220).truncate().text_size(12).text_color(t.dim).child(who ? `${who.space_name} · ${who.tab_name}` : ""))))
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).font_bold().text_color(t.muted).child(summary))
        .child(div().id("prs-refresh").p(3).text_color(this.busy ? t.accent : t.dim).hover((s) => s.text_color(t.accent)).tooltip("Refresh")
          .on_click((_e, cx) => { this.last = 0; this.tick(cx, true); cx.notify(); }).child(svg("mods/nightdrive-chrome/clock.svg").size(13))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().children(rows)
          .when(!rows.length, (e) => e.child(div().p(14).text_size(12.5).text_color(t.muted).child(empty))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()))
      .when(Boolean(this.error || this.note), (e) => e.child(div().px(12).py(6).flex_none().text_size(11).text_color(t.blocked).child(this.note || `GitHub: ${this.error}`)))
      .child(h_flex().flex_none().p(8).gap(8).border_t(1).border_color(t.border)
        .child(div().id("prs-paste").flex_1().min_w(0).h(30).px(10).flex().items_center().border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))));
  }
}
