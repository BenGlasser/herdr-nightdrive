// Nightdrive dock: the side panels in one area you arrange by dragging their tabs. Drop a tab on
// another panel's edge to split there, on a tab strip to stack it as a tab, or near the area's left,
// right or bottom edge to dock it there. Dividers resize, and the arrangement is kept.
//
// The panels are the Files, Changes, Dash, PRs, ClickUp, Standup and PostHog mods. Herdr won't load
// code from another mod's folder, so sync.sh copies theirs into panels/: run it after changing one.
// Each panel is built with props { block: its name, dock: true } (plus its own) and asks shared
// "dock".shown whether it's showing, so it polls only then.
//
// props (all optional):
//   panels: which panels it offers, in order. Each is a kind ("files", "changes", "dash", "prs",
//     "clickup", "standup", "posthog") or { name, kind?, label?, tip?, props? } for one with props
//     of its own, or two of one kind ({ name: "posthog-prod", kind: "posthog", props: { project: 1 } }).
//     Default: one of each kind.
//   bar: false when something else opens its panels (Nightdrive's tab bar). Otherwise it has a bar
//     with + to add and place panels, which makes it work in any layout.
//
// It talks to the rest through shared state: it acts on "dock.request" ({ id, op, name, where }),
// which the tab bar, the + menu and the pane header send (dockRequest in nightdrive.js), and it
// publishes "dock": { open, shown, where, available }. Without a bar, nothing open hides its column.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, DockArea, dock_area, dock_content } from "gpui-base";
import { closeOverlay, layout, openOverlay, props, run, setShared, shared, theme } from "herdr";
import { PR_ICON, dockRequest } from "./nightdrive.js";
import Files from "./panels/nightdrive-files/main.js";
import Changes from "./panels/nightdrive-changes/main.js";
import Dash from "./panels/nightdrive-dash/main.js";
import Prs from "./panels/nightdrive-prs/main.js";
import ClickUp from "./panels/clickup/main.js";
import Standup from "./panels/standup/main.js";
import PostHog from "./panels/posthog/main.js";

// The kinds of panel the dock can hold. `tip`: a button's name for it.
const KINDS = {
  files: { label: "Files", icon: "mods/nightdrive-files/file.svg", tip: "Files", Class: Files },
  changes: { label: "Changes", icon: "mods/nightdrive-changes/changes.svg", tip: "Changes", Class: Changes },
  dash: { label: "Dash", icon: "mods/nightdrive-dash/gauge.svg", tip: "Usage dash", Class: Dash },
  prs: { label: "PRs", icon: PR_ICON, tip: "Pull requests", Class: Prs },
  clickup: { label: "ClickUp", icon: "mods/clickup/tickets.svg", tip: "Your ClickUp tasks", Class: ClickUp },
  standup: { label: "Standup", icon: "mods/standup/standup.svg", tip: "Your standup", Class: Standup },
  posthog: { label: "PostHog", icon: "mods/posthog/activity.svg", tip: "PostHog events", Class: PostHog },
};
const DEFAULT_PANELS = Object.keys(KINDS);
const ICON = (name) => `mods/nightdrive-dock/${name}.svg`;
const REGION_ICON = { left: "panel-left", center: "square", right: "panel-right", bottom: "panel-bottom" };
const REGION_NAME = { left: "On the left", center: "In the middle", right: "On the right", bottom: "At the bottom" };

// The panels the props ask for, each { name, label, icon, tip, Class, props }.
function panelsFrom(list) {
  return (Array.isArray(list) && list.length ? list : DEFAULT_PANELS).map((entry) => {
    const o = typeof entry === "string" ? { name: entry } : entry ?? {};
    const kind = KINDS[o.kind ?? o.name];
    if (!kind || !o.name) return null;
    return { name: String(o.name), label: o.label ?? kind.label, icon: o.icon ?? kind.icon, tip: o.tip ?? kind.tip, Class: kind.Class, props: o.props ?? {} };
  }).filter(Boolean);
}

// A saved layout names each panel "shell:<application>/<name>", and <application> carries the
// dock's props: after a props edit the saved names are renamed to today's, so the panels come back.
function rename(node, prefix) {
  if (Array.isArray(node)) return node.map((x) => rename(x, prefix));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === "panel_name" && typeof v === "string" ? prefix + short(v) : rename(v, prefix);
  return out;
}
const REGIONS = ["left", "center", "right", "bottom"];
const SIZE = { left: 360, right: 360, bottom: 300 };

// A panel's own name from the dock's namespaced one ("shell:<application>/<name>").
const short = (name) => String(name).split("/").pop();

// The panel's class, built with its props even when a saved layout rebuilds it (no props then).
const panelClass = (p) => class extends p.Class {
  init(given, cx) { return super.init({ ...(p.props ?? {}), block: p.name, dock: true, ...(given ?? {}) }, cx); }
};

function path(node, test, trail = []) {
  if (!node) return null;
  if (test(node)) return [...trail, node];
  for (const c of node.children ?? []) { const hit = path(c, test, [...trail, node]); if (hit) return hit; }
  return null;
}

export default class Dock extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    // The + menu: a popup of this mod, listing the panels the dock published.
    if (given.menu) { this.menu = given.menu; return; }
    this.block = given.block ?? "dock";
    this.bar = given.bar !== false;
    this.panels = panelsFrom(given.panels);
    this.byName = Object.fromEntries(this.panels.map((x) => [x.name, x]));
    this.classes = {};
    let prefix = null;
    for (const panel of this.panels) {
      this.classes[panel.name] = panelClass(panel);
      const ns = DockArea.register_panel(panel.name, this.classes[panel.name]);
      prefix ??= ns.slice(0, ns.lastIndexOf("/") + 1);
    }
    // The arrangement is kept in shared state under the block's id: a mod copy's own storage
    // starts empty whenever its props change. (Earlier builds kept it there; it's read once.)
    this.key = `dock.layout:${this.block}`;
    const kept = shared(this.key) ?? {};
    let saved = kept.layout ?? null, where = kept.where ?? null;
    try { saved ??= JSON.parse(localStorage.getItem("layout") ?? "null"); where ??= JSON.parse(localStorage.getItem("where") ?? "null"); } catch {}
    this.where = where ?? {};
    this.area = DockArea.new("nightdrive-dock");
    if (saved) { this.area.load(prefix ? rename(saved, prefix) : saved); this.dirty = true; }
    // Every drag and resize is an edit: keep the layout on a timer, publish what's open at once.
    this.area.on("layout_changed", (cx) => { this.dirty = true; this.recenter(cx); this.publish(); });
    cx.timer.every(800, () => {
      if (!this.dirty) return;
      this.dirty = false;
      setShared(this.key, { layout: this.area.dump(), where: { ...this.where } });
    });
    this.handled = shared("dock.request")?.id ?? null;
    cx.timer.after(50, () => this.publish());
  }

  // Where the dock sits in the layout: the path from the root to its block.
  trail(root = layout()) { return path(root, (n) => n.id === this.block); }

  // Whether the dock itself is on screen: nothing above it hidden, each stack on its branch.
  onScreen() {
    const trail = this.trail();
    if (!trail) return true;
    return trail.every((n, i) => !n.hidden && (n.type !== "stack" || i === trail.length - 1
      || (n.active ?? n.children?.[0]?.id) === trail[i + 1].id));
  }

  // The middle is the area the side regions sit around: once its last panel goes, the panels left
  // in the side regions move into it rather than leaving it an empty gap.
  recenter(cx) {
    const panels = this.area.panels();
    if (!panels.length || panels.some((x) => x.placement === "center")) return;
    for (const x of panels) {
      const name = short(x.name);
      if (!this.classes[name]) continue;
      this.area.remove_panel(x.id);
      this.area.add_panel(cx.new(this.classes[name]), { name, placement: "center" });
    }
  }

  // Tells everyone what's open and what shows, and folds the dock's column away when it's empty.
  publish() {
    const panels = this.area.panels();
    const open = [], shown = [];
    const screen = this.onScreen();
    for (const x of panels) {
      const name = short(x.name);
      open.push(name);
      if (screen && x.active && x.visible) shown.push(name);
      if (REGIONS.includes(x.placement)) this.where[name] = x.placement;
    }
    // A side region whose last panel was dragged out goes, rather than staying as an empty strip.
    for (const region of ["left", "right", "bottom"]) {
      if (this.area.has_dock(region) && !panels.some((x) => x.placement === region)) this.area.remove_dock(region);
    }
    const state = { open, shown, where: { ...this.where }, available: this.panels.map(({ name, label, icon, tip }) => ({ name, label, icon, tip })) };
    if (JSON.stringify(state) !== JSON.stringify(shared("dock"))) setShared("dock", state);
    // Without a bar the tab bar opens panels, so an empty dock can fold away; with one it stays.
    if (!open.length && screen && !this.bar) this.fold();
  }

  // Hides the column the dock sits in (or the dock's own block, if it shares that column).
  fold() {
    const trail = this.trail();
    if (!trail) return;
    const parent = trail[trail.length - 2], self = trail[trail.length - 1];
    const target = parent && (parent.children ?? []).length === 1 && parent.id ? parent : self;
    run("layout.hide", { id: target.id });
  }

  // A request from the tab bar, its menu or a pane header (dockRequest in nightdrive.js).
  //   open: shows the panel (in `where`, else where it was last, else the middle); one that's
  //     already open but behind another tab, or in another region, is taken out and put back there.
  //   close: takes it out. toggle: close if it's showing, else open.
  handle(req, cx) {
    const name = req.name, Class = this.classes[name];
    if (!Class) return;
    const have = this.area.panels().find((x) => short(x.name) === name);
    const showing = Boolean(have && have.active && have.visible);
    if (req.op === "close" || (req.op === "toggle" && showing && !req.where)) {
      if (have) this.area.remove_panel(have.id);
      return;
    }
    let where = REGIONS.includes(req.where) ? req.where : have?.placement ?? this.where[name] ?? "center";
    // Nothing in the middle to sit beside: it goes in the middle.
    if (where !== "center" && !this.area.panels().some((x) => x.placement === "center" && x.id !== have?.id)) where = "center";
    if (have && showing && have.placement === where) return;
    if (have) this.area.remove_panel(have.id);
    this.area.add_panel(cx.new(Class), { name, placement: where, size: SIZE[where] });
    this.where[name] = where;
  }

  // ---- chrome: base draws none, so these are the dock's look ----
  tabStrip(t, group) {
    const tabs = group.tabs.filter((x) => x.visible);
    return h_flex().h(28).flex_none().w_full().bg(t.chrome).border_b(1).border_color(t.border)
      .children(tabs.map((tab) => {
        const p = this.byName[short(tab.name)];
        const on = tab.active;
        // No × here: Herdr's dock makes its groups unclosable, so close_panel does nothing. A panel
        // closes from its tab bar button (click while it shows) or that button's right-click menu.
        return h_flex().id(`dt-${group.node}-${tab.index}`).relative().h_full().px(10).gap(6).flex_none().items_center()
          .text_size(10.5).border_r(1).border_color(t.border).bg(on ? t.raised : t.chrome).text_color(on ? t.accent : t.muted)
          .when(on, (el) => el.font_bold().child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
          .hover((s) => s.text_color(on ? t.accent : t.foreground))
          .select_tab(group, tab.index).drag_tab(group, tab.index).drop_tab(group, tab.index)
          .when(Boolean(p?.icon), (el) => el.child(svg(p.icon).size(13)))
          .child((p?.label ?? short(tab.name)).toUpperCase());
      }))
      // Past the last tab: dropping there adds the dragged panel to this group's end.
      .child(div().id(`dt-end-${group.node}`).flex_1().h_full().drop_tab(group));
  }

  // A dock (left, right or bottom): its panels, and an edge to drag its size by.
  region(t, dock) {
    const edge = div().id(`dr-${dock.placement}`).flex_none().bg(t.border).hover((s) => s.bg(t.accent)).resize_dock(dock);
    if (dock.placement === "left") return h_flex().size_full().child(div().flex_1().min_w(0).h_full().child(dock_content().size_full())).child(edge.w(3).h_full().cursor_col_resize());
    if (dock.placement === "right") return h_flex().size_full().child(edge.w(3).h_full().cursor_col_resize()).child(div().flex_1().min_w(0).h_full().child(dock_content().size_full()));
    return v_flex().size_full().child(edge.h(3).w_full().cursor_row_resize()).child(div().flex_1().min_h(0).w_full().child(dock_content().size_full()));
  }

  // ---- the + bar and its menu ----
  // The bar: + opens the menu below it. With nothing open, the dock says how to start.
  topBar(t) {
    return h_flex().h(28).flex_none().px(8).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("dock-add").h(22).px(8).gap(5).items_center().cursor_pointer().border_1().border_color(t.border)
        .text_size(10.5).font_bold().text_color(t.muted).hover((s) => s.border_color(t.accent).text_color(t.accent))
        .tooltip("Add a panel, or move or close one")
        .on_click((e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "nightdrive-dock", kind: "popup", frame: "none", width: 300, props: { menu: true } });
        })
        .child(svg(ICON("plus")).size(12)).child("PANEL"))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child("Drag a tab to move it"));
  }

  // The menu: each panel the dock offers, ✓ when open; a region opens it (or moves it) there.
  menuView(t) {
    const ds = shared("dock") ?? {}, open = ds.open ?? [], where = ds.where ?? {};
    const go = (op, name, region, cx) => { closeOverlay(props()?.overlay); dockRequest(op, name, region); };
    return v_flex().id("dock-menu").w_full().p(6).gap(2).bg(t.popover).border_1().border_color(t.accent).text_size(12.5).text_color(t.foreground)
      .when(!(ds.available ?? []).length, (e) => e.child(div().p(8).text_color(t.dim).child("The dock hasn't started yet.")))
      .children((ds.available ?? []).map((x) => {
        const isOpen = open.includes(x.name);
        return h_flex().id(`dm-${x.name}`).h(30).px(6).gap(6).items_center().hover((s) => s.bg(t.hover))
          .child(h_flex().id(`dm-open-${x.name}`).flex_1().min_w(0).h_full().gap(8).items_center().cursor_pointer()
            .tooltip(isOpen ? `Close ${x.label}` : `Open ${x.label}`)
            .on_click((_e, cx) => go(isOpen ? "close" : "open", x.name, null, cx))
            .child(div().w(12).flex_none().text_color(t.accent).child(isOpen ? "✓" : ""))
            .child(svg(x.icon).size(13).flex_none().text_color(isOpen ? t.accent : t.muted))
            .child(div().flex_1().min_w(0).truncate().child(x.tip ?? x.label)))
          .children(["left", "center", "right", "bottom"].map((r) => div().id(`dm-${x.name}-${r}`).p(3).cursor_pointer()
            .text_color(isOpen && where[x.name] === r ? t.accent : t.dim).hover((s) => s.text_color(t.foreground))
            .tooltip(`${REGION_NAME[r]}`).on_click((_e, cx) => go("open", x.name, r, cx)).child(svg(ICON(REGION_ICON[r])).size(13))));
      }));
  }

  render(cx) {
    const t = theme();
    if (this.menu) return this.menuView(t);
    const req = shared("dock.request");
    if (req && req.id !== this.handled) {
      this.handled = req.id;
      // Views can't be built while drawing: a timer runs it right after, as its own step.
      if (Date.now() - (req.at ?? 0) < 10000) cx.timer.after(1, (cx) => this.handle(req, cx));
    }
    // The dock coming back on screen (or going) changes what shows.
    const screen = this.onScreen();
    if (screen !== this.wasOnScreen) { this.wasOnScreen = screen; cx.timer.after(1, () => this.publish()); }
    const empty = this.bar && !(shared("dock")?.open ?? []).length;
    return v_flex().id(this.block).size_full().min_h(0).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .when(this.bar, (e) => e.child(this.topBar(t)))
      .when(empty, (e) => e.child(div().p(14).text_size(12).text_color(t.dim).child("No panels yet. + PANEL adds one; drag its tab to move it, next to or onto another.")))
      .child(dock_area(this.area).flex_1().min_h(0).w_full()
        .tab_bar((group) => this.tabStrip(t, group))
        .empty_group(() => div().size_full().flex().items_center().justify_center().text_size(11).text_color(t.dim).child("Drop a panel here"))
        .drop_indicator((drop) => div().absolute().left(drop.to.x).top(drop.to.y).w(drop.to.width).h(drop.to.height)
          .bg(`${t.accent}26`).border_1().border_color(t.accent))
        .dock((dock) => this.region(t, dock)));
  }
}
