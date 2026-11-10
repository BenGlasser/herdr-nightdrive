// COPY of mods/nightdrive-chrome/nightdrive.js (Herdr mods can't import across folders).
// Edit that file, then copy it over this one.
// Shared parts of the Nightdrive (cyberpunk/synthwave) look, imported by every nightdrive-* mod.
// Colors come from themes/nightdrive.json through theme().
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

// Display face for section titles; bundled in ./fonts (SIL OFL).
export const DISPLAY = "Press Start 2P";

// Space avatar fills by stored color name: one vivid neon per hue.
export const MARK = { ansi6: "#00f0ff", ansi3: "#ffe14d", ansi4: "#4d7cff", ansi5: "#ff2bd6", ansi2: "#05ffa1", ansi1: "#ff2a6d" };

// Needs you, in the sidebar only: a fast hard flash, so it reads apart from
// working's slow pulse. Like the pulse it runs natively and only while drawn.
export const flash = (el) => el.loop("opacity", { from: 0.12, to: 1, period: 420, easing: "linear" });

// An agent's state as a square: solid for working, blocked and done, hollow for
// idle. animated (the sidebar's agents list only): working pulses in intensity.
export function statusBlock(t, status, size = 8, animated = false) {
  const color = t[status] ?? t.dim;
  if (status === "idle") return div().size(size).flex_none().border_1().border_color(color);
  const block = div().size(size).flex_none().bg(color);
  return animated && status === "working" ? block.loop("opacity", { from: 0.18, to: 1, period: 1100 }) : block;
}

// "Needs you" (blocked), as a hard-edged tag; compact: just "!". flashing: the
// sidebar's agents list passes true.
export function needsYou(t, compact = false, flashing = false) {
  const tag = div().flex_none().h(18).px(compact ? 0 : 6).when(compact, (el) => el.w(16).justify_center())
    .flex().items_center().bg(t.blocked).text_color("#000000").text_size(10).font_bold()
    .child(compact ? "!" : "NEEDS YOU");
  return flashing ? flash(tag) : tag;
}

// A synthwave rule: hot magenta through violet into cyan, as flat segments
// (.bg() takes only flat colors, and images keep their aspect ratio).
const RULE = ["#ff2bd6", "#f82bda", "#f12add", "#ea2ae1", "#e429e4", "#dd29e8", "#d628eb", "#cf28ef", "#c828f3", "#c127f6", "#ba27fa", "#b326fd", "#a82fff", "#9940ff", "#8a52ff", "#7a63ff", "#6b75ff", "#5c87ff", "#4d98ff", "#3daaff", "#2ebbff", "#1fcdff", "#0fdeff", "#00f0ff"];
export function rule(height = 1) {
  return h_flex().w_full().h(height).flex_none().children(RULE.map((c) => div().flex_1().h_full().bg(c)));
}

// Section title: small pixel type, wide and uppercase.
export function title(t, text, color) {
  return div().font_family(DISPLAY).text_size(8).text_color(color ?? t.solid).child(text.toUpperCase());
}

// A cut corner: a square of the surrounding color laid over one corner of a
// box with `.relative()`, so the box reads as chamfered.
export function notch(color, size = 5, corner = "tr") {
  const n = div().absolute().size(size).bg(color);
  return corner === "tr" ? n.top(0).right(0) : corner === "bl" ? n.bottom(0).left(0) : corner === "tl" ? n.top(0).left(0) : n.bottom(0).right(0);
}

// An overlay's frame, drawn by the mod itself (opened with frame: "none"):
// a cyan border with magenta L-brackets at top-left and bottom-right, like a
// targeting reticle. Spread onto the overlay's root, which must be .relative().
export function reticle(t, size = 12) {
  const c = t.solid;
  return [
    div().absolute().top(0).left(0).w(size).h(2).bg(c),
    div().absolute().top(0).left(0).w(2).h(size).bg(c),
    div().absolute().bottom(0).right(0).w(size).h(2).bg(c),
    div().absolute().bottom(0).right(0).w(2).h(size).bg(c),
  ];
}
