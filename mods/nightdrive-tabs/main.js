import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";
import { statusBlock, rule, togglePrs, prsPane, agentPane, PR_ICON, lamp, lit, dockBlock, dockState, dockRequest } from "./nightdrive.js";
import { arrive, note, everywhere } from "./panels.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    const load = (key) => { try { return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {}; } catch { return {}; } };
    this.panels = load("panels");
    // The Dash, ClickUp, Standup and PostHog, while open: the same in every space (see panels.js).
    this.everywhere = load("panels-everywhere");
  }

  // What's open on the right: the panel on top, the one below (each stack shows
  // one child), and whether the web column shows.
  slots(root) {
    const panel = find(root, "panel"), web = find(root, "web");
    const open = (id) => {
      const stack = find(root, id);
      return panel && !panel.hidden && stack && !stack.hidden ? stack.active ?? stack.children?.[0]?.id ?? null : null;
    };
    return { top: open("panel-top"), bottom: open("panel-bottom"), web: Boolean(web && !web.hidden) };
  }

  // Shows exactly `want`: each stack on its child or hidden, the panel column
  // only while one of them is open, and the web column. Nodes the layout lacks
  // are left alone.
  apply(want) {
    const root = layout(), has = (id) => Boolean(find(root, id));
    // With the panel dock the panels are its own (it shows and folds its column); only the web column is ours.
    if (!dockBlock(root)) {
      for (const [slot, stack] of [["top", "panel-top"], ["bottom", "panel-bottom"]]) {
        if (!has(stack)) continue;
        if (want[slot]) { run("layout.select", { stack, child: want[slot] }); run("layout.show", { id: stack }); }
        else run("layout.hide", { id: stack });
      }
      run(want.top || want.bottom ? "layout.show" : "layout.hide", { id: "panel" });
    }
    if (has("web")) run(want.web ? "layout.show" : "layout.hide", { id: "web" });
  }

  // A space's own panels, kept only where they still fit this layout. Entries
  // from before the split were a single panel id: that panel on top. Panels
  // open in every space aren't a space's own.
  stored(spaceId, root) {
    const s = this.panels[spaceId];
    const v = s && typeof s === "object" ? s : { top: s ?? null, bottom: null, web: false };
    const fits = (stack, id) => Boolean(id) && !everywhere(id) && Boolean(find(find(root, stack), id));
    return {
      top: fits("panel-top", v.top) ? v.top : null,
      bottom: fits("panel-bottom", v.bottom) ? v.bottom : null,
      web: Boolean(v.web) && Boolean(find(root, "web")),
    };
  }

  // The panels open in every space, kept only where they still fit this layout.
  across(root) {
    const a = this.everywhere ?? {};
    const fits = (stack, id) => everywhere(id) && Boolean(find(find(root, stack), id));
    return { top: fits("panel-top", a.top) ? a.top : null, bottom: fits("panel-bottom", a.bottom) ? a.bottom : null };
  }

  // The side panels are remembered per space: switching shows that space's choice
  // (all closed if it never had one) under the panels open everywhere, and
  // opening or closing them records it.
  syncPanel(space, root) {
    if (!space) return;
    const now = this.slots(root), key = JSON.stringify(now);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const want = arrive(this.stored(space.id, root), this.across(root));
        if (JSON.stringify(want) !== key) {
          this.pending = { want: JSON.stringify(want), until: Date.now() + 1000 };
          this.apply(want);
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== key && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    const next = note(now, this.stored(space.id, root), this.across(root));
    if (JSON.stringify(this.panels[space.id]) === JSON.stringify(next.own) && JSON.stringify(this.everywhere) === JSON.stringify(next.all)) return;
    this.panels[space.id] = next.own;
    this.everywhere = next.all;
    try {
      localStorage.setItem("panels", JSON.stringify(this.panels));
      localStorage.setItem("panels-everywhere", JSON.stringify(this.everywhere));
    } catch {}
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).h_full().w(40).flex_none().flex().items_center().justify_center().border_r(1).border_color(t.border).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.accent))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).relative().h_full().px(14).gap(7).items_center().flex_none().text_size(11.5)
        .border_r(1).border_color(t.border).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.accent : t.muted)
        .when(c.active, el => el.font_bold().child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
        .hover(s => s.bg(t.hover).text_color(c.active ? t.accent : t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "nightdrive-menu", kind: "popup", frame: "none", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(lamp(program, 14, lit(c.status)) ?? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14))))
        .child(div().max_w(170).truncate().child((c.zoomed ? `${name} Z` : name).toUpperCase()))
        .when(c.status === "working" || c.status === "blocked" || c.status === "done", el => el.child(statusBlock(t, c.status, 7)))
        // A tab with an agent: its session's pull requests beside it (cyan while open).
        .when(Boolean(agentPane(c.id)), el => {
          const open = Boolean(prsPane(c.id));
          return el.child(div().id(`prs-${c.id}`).text_color(open ? t.accent : t.dim).hover((s) => s.text_color(t.accent))
            .tooltip(open ? "Close pull requests" : "Pull requests")
            .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); togglePrs(c.id); })
            .child(svg(PR_ICON).size(12)));
        })
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/nightdrive-pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(0, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 0;
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // PostHog feeds (mods/posthog). Every panel sits in both stacks: "<id>" on top, "<id>-b" below.
    const posthog = [["posthog-staging", "Staging"], ["posthog-prod", "Prod"]];
    this.syncPanel(space, root);
    const now = this.slots(root);
    const marker = (edge, color) => div().absolute().left(0).right(0).h(2).bg(color).when(edge === "top", el => el.top(0)).when(edge === "bottom", el => el.bottom(0));
    const look = (id, on) => h_flex().id(id).relative().h_full().px(12).gap(6).flex_none().items_center()
      .text_size(10.5).border_l(1).border_color(t.border).bg(on ? t.selected : t.chrome).text_color(on ? t.accent : t.muted)
      .when(on, el => el.font_bold())
      .hover(s => s.bg(t.hover).text_color(on ? t.accent : t.foreground)).on_mouse_down("left", stop);
    // Click opens (or closes) a panel on top, ⌥-click below; cyan marks the top one, magenta the one below.
    // Closing one that's open in every space gives this space its own panel back.
    const panelButton = (id, label, icon, name = label) => {
      const top = now.top === id, below = now.bottom === `${id}-b`;
      return look(`panel-${id}`, top || below)
        .when(top, el => el.child(marker("top", t.accent)))
        .when(below, el => el.child(marker("bottom", t.solid)))
        .tooltip(`${name}: click opens on top, ⌥-click below${everywhere(id) ? ". Stays open in every space" : ""}`)
        .on_click((e) => {
          const root = layout(), want = this.slots(root);
          const slot = e.modifiers?.alt ? "bottom" : "top", child = slot === "top" ? id : `${id}-b`;
          if (want[slot] !== child) want[slot] = child;
          else want[slot] = everywhere(child) && space ? this.stored(space.id, root)[slot] : null;
          this.apply(want);
        }).child(svg(icon).size(14)).child(label.toUpperCase());
    };
    // With the panel dock (mods/nightdrive-dock): a button per panel it holds. Click opens it (or
    // closes it while it shows; one behind another tab comes forward), ⌥-click opens it at the bottom,
    // right-click chooses where. Cyan underline: showing; dim underline: open behind another tab.
    const dock = dockBlock(root), ds = dockState();
    // The dock says which panels it holds once it has run; if it never has, show it once so it starts.
    if (dock && !ds.available?.length && !this.wokeDock) { this.wokeDock = true; dockRequest("wake", null); }
    const dockButton = (p) => {
      const open = ds.open.includes(p.name), showing = ds.shown.includes(p.name);
      return look(`panel-${p.name}`, open)
        .when(showing, el => el.child(marker("top", t.accent)))
        .when(open && !showing, el => el.child(marker("bottom", t.dim)))
        .tooltip(`${p.tip}: click ${showing ? "closes it" : open ? "brings it forward" : "opens it"}, ⌥-click opens it at the bottom, right-click chooses where`)
        .on_click((e) => dockRequest(e.modifiers?.alt ? "open" : "toggle", p.name, e.modifiers?.alt ? "bottom" : null))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "nightdrive-menu", kind: "popup", frame: "none", width: 270, props: { tab: "panel", target: { name: p.name } } });
        })
        .child(svg(p.icon).size(14)).child(p.label.toUpperCase());
    };
    // The web column (terminal-browser in the "web" terminal) toggles on its own.
    const webButton = () => look("panel-web", now.web)
      .when(now.web, el => el.child(marker("top", t.accent)))
      .tooltip("Browser (terminal-browser)")
      .on_click(() => this.apply({ ...this.slots(layout()), web: !this.slots(layout()).web }))
      .child(svg("mods/nightdrive-chrome/monitor.svg").size(14)).child("WEB");
    return v_flex().size_full().min_w(0).bg(t.chrome).child(h_flex().flex_1().min_w(0).pl(lightsPadding).items_center()
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", svg("mods/nightdrive-chrome/plus.svg").size(13), () => openOverlay({ mod: "nightdrive-new-menu", kind: "popup", frame: "none", width: 250, height: 512 })))
      .when(Boolean(dock), el => el.children((ds.available ?? []).filter((p) => !["files", "changes"].includes(p.name) || enabled.includes(p.name)).map(dockButton)))
      .when(!dock && enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/nightdrive-files/file.svg")))
      .when(!dock && enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/nightdrive-changes/changes.svg")))
      // The usage dash (mods/nightdrive-dash), when the layout has it.
      .when(Boolean(find(root, "dash")), el => el.child(panelButton("dash", "Dash", "mods/nightdrive-dash/gauge.svg", "Usage dash")))
      // The focused agent's pull requests (mods/nightdrive-prs), when the layout has them.
      .when(Boolean(find(root, "prs")), el => el.child(panelButton("prs", "PRs", PR_ICON, "Pull requests")))
      // Your ClickUp tasks by status (mods/clickup), when the layout has them.
      .when(Boolean(find(root, "clickup")), el => el.child(panelButton("clickup", "ClickUp", "mods/clickup/tickets.svg", "Your ClickUp tasks")))
      // Your daily standup (mods/standup), when the layout has it.
      .when(Boolean(find(root, "standup")), el => el.child(panelButton("standup", "Standup", "mods/standup/standup.svg", "Your standup")))
      .children(posthog.filter(([id]) => find(root, id)).map(([id, label]) =>
        panelButton(id, label, "mods/posthog/activity.svg", `PostHog ${label.toLowerCase()} events`)))
      .when(Boolean(find(root, "web")), el => el.child(webButton()))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/nightdrive-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/nightdrive-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/nightdrive-tabs/win-close.svg").size(16) : svg("mods/nightdrive-pane/close.svg").size(13), () => run("window.close")))))
      .child(rule(1));
  }
}
