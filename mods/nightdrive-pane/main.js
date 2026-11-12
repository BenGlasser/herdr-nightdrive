// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "nightdrive-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.
// When the ClickUp panel (mods/clickup) is in the layout or its panel dock: on a terminal pane with a
// ticket number (APP-1234, with a prefix ClickUp has seen) in its branch, folder, title, tab or space,
// or on an agent's pane, a ClickUp button opens that panel with the ticket.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, spaces, setShared, shared } from "herdr";
import { statusBlock, needsYou, togglePrs, prsPane, PR_ICON, lamp, lit, dockBlock, dockState, dockRequest } from "./nightdrive.js";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const MOD_NAMES = { "nightdrive-prs": "Pull requests", "nightdrive-pr": "Pull request" };
const CLICKUP_ICON = "mods/clickup/tickets.svg";
const CLICKUP_BLOCK = "clickup-b"; // the ClickUp panel in a layout's bottom stack (one without the panel dock)
// A ticket number in text: one of the prefixes the ClickUp panel has seen in your tasks (shared
// "clickup.prefixes", like APP in APP-1234). Until it has read them, nothing counts as a ticket.
function ticketPattern() {
  const prefixes = (shared("clickup.prefixes") ?? []).filter((x) => /^[A-Za-z]+$/.test(x));
  return prefixes.length ? new RegExp(`(?:^|[^a-z0-9])(${prefixes.join("|")})-(\\d+)(?!\\d)`, "i") : null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The ticket a pane is working on: the first number in its branch, folder, title, tab or space name,
// the pane's own first (a worktree's folder and branch name their ticket), then where it sits.
function ticketOf(p) {
  const space = spaces().find((s) => (s.tabs ?? []).some((tb) => tb.id === p.tab));
  const tab = space?.tabs.find((tb) => tb.id === p.tab);
  const pattern = ticketPattern();
  if (!pattern) return null;
  for (const text of [p.branch, p.cwd, p.title, tab?.named ? tab.name : null, space?.name]) {
    const m = pattern.exec(text ?? "");
    if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return null;
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.accent))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/nightdrive-pane/${icon}.svg`).size(14));
  }

  // On an agent's pane, always shown: its session's pull requests (mods/nightdrive-prs) in a
  // pane beside it, or closes that pane when this tab already has one.
  prButton(t, p) {
    const open = prsPane(p.tab);
    return div()
      .id(`ph-pr-${p.pane}`)
      .p(3)
      .text_color(open ? t.accent : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.accent))
      .tooltip(open ? "Close pull requests" : "Pull requests")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        togglePrs(p.tab, p);
      })
      .child(svg(PR_ICON).size(14));
  }

  // ClickUp below, with this pane's ticket open when it has one (the panel answers shared
  // "clickup.open"); without one, the panel shows as it was. With the panel dock, ClickUp opens
  // where it was last in the dock (the bottom, the first time).
  clickupButton(t, p, ticket) {
    const dock = dockBlock();
    const stack = find(layout(), "panel-bottom"), panel = find(layout(), "panel");
    const open = dock ? dockState().shown.includes("clickup")
      : Boolean(panel && !panel.hidden && stack && !stack.hidden && (stack.active ?? stack.children?.[0]?.id) === CLICKUP_BLOCK);
    return div()
      .id(`ph-cu-${p.pane}`)
      .p(3)
      .text_color(open ? t.accent : ticket ? t.muted : t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.accent))
      .tooltip(ticket ? `${ticket} in ClickUp${dock ? "" : ", below"}` : `ClickUp${dock ? "" : ", below"} (no ticket number in this pane's branch, folder, title, tab or space)`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (ticket) setShared("clickup.open", { ref: ticket, block: dock ? "clickup" : CLICKUP_BLOCK, at: Date.now() });
        if (dock) { dockRequest("open", "clickup", dockState().where?.clickup ?? "bottom"); return; }
        run("layout.select", { stack: "panel-bottom", child: CLICKUP_BLOCK });
        run("layout.show", { id: "panel-bottom" });
        run("layout.show", { id: "panel" });
      })
      .child(svg(CLICKUP_ICON).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // A mod pane's title is its folder name, so the PR mods get a name people read.
    const name = p.mod ? MOD_NAMES[p.mod] ?? p.mod.replace(/^nightdrive-/, "").replace(/-/g, " ")
      : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = lamp(p.program, 14, lit(p.status)) ?? icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const ticket = p.terminal ? ticketOf(p) : null;
    // Focused: cyan tick, name and underline; otherwise a magenta tick.
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pr(10)
      .gap(8)
      .items_center()
      .bg(p.focused ? t.raised : t.background)
      .border_b(1)
      .border_color(p.focused ? t.accent : t.border)
      .text_size(11.5)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .child(div().w(3).h_full().flex_none().bg(p.focused ? t.accent : t.solid))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_bold().text_color(p.focused ? t.accent : t.foreground).child(name.toUpperCase()))
      .child(div().flex_none().text_color(t.solid).child("//"))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working" || st === "done", el => el.child(statusBlock(t, st, 8)))
      .when(st === "blocked", el => el.child(needsYou(t)))
      .when(Boolean(p.terminal && (p.program?.agent || p.app)), el => el.child(this.prButton(t, p)))
      .when(Boolean(p.terminal && (find(layout(), CLICKUP_BLOCK) || dockState().available?.some((x) => x.name === "clickup")) && (ticket || p.program?.agent || p.app)), el => el.child(this.clickupButton(t, p, ticket)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
