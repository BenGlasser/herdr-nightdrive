// The Nightdrive sidebar's brand bar and footer. Also home of the look's shared
// parts: nightdrive.js (copied into each nightdrive mod), the icon set, the emblem and fonts/.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";
import { DISPLAY, rule } from "./nightdrive.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().border_1().border_color(t.chrome).text_color(t.muted)
      .hover(s => s.bg(t.hover).border_color(t.accent).text_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center()
        .border_l(2).border_color(t.chrome)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).border_color(t.solid).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/nightdrive-chrome/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label.toUpperCase()));
      const ready = div().size(6).bg(t.accent);
      return v_flex().size_full().bg(t.chrome).text_size(11)
        .child(rule(1))
        .child(v_flex().flex_1().px(8).pt(6).pb(8).gap(2).when(collapsed, el => el.px(0).items_center())
          .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
            .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
          .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "nightdrive-machine-add" }))));
    }
    // The brand block's props: mark (an image path under the home folder, drawn in a
    // 27x21 box) and name. Without them, the sun and NIGHTDRIVE. Names over 8 letters
    // drop to the font's native 8px so the buttons still fit beside the traffic lights.
    const p = props() ?? {};
    const name = p.name ?? "NIGHTDRIVE";
    const brand = h_flex().flex_1().gap(9).items_center()
      .child(image(p.mark ?? "mods/nightdrive-chrome/mark.svg").w(27).h(21).flex_none())
      .child(div().font_family(DISPLAY).text_size(name.length > 8 ? 8 : 10).text_color(t.foreground).child(name));
    return v_flex().size_full().bg(t.chrome)
      .child(h_flex().flex_1().pl(collapsed ? 6 : 14).pr(10).gap(4).items_center()
        .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
        .when(!collapsed, el => el.child(brand))
        .when(!collapsed, el => el.child(this.button("search", svg("mods/nightdrive-chrome/search.svg").size(15), () => run("mod.open", { name: "nightdrive-picker" }))))
        // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
        .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/nightdrive-chrome/sidebar.svg").size(15), toggleSidebar))))
      .child(rule(1));
  }
}
