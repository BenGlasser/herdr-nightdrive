// Shared parts of the Nightdrive (cyberpunk/synthwave) look, imported by every nightdrive-* mod.
// Colors come from themes/nightdrive.json through theme().
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, panes, run, setShared, shared, spaces } from "herdr";

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

// The pull requests list (mods/nightdrive-prs), opened beside an agent from its pane header, the
// tab bar, or a right-click menu. A tab has at most one; the same control closes it.
export const PR_ICON = "mods/nightdrive-pane/pull-request.svg";
// The list, or a review opened beside the agent in its place (mods/nightdrive-pr).
export const prsPane = (tabId) => panes().find((p) => p.tab === tabId && (p.mod === "nightdrive-prs" || p.mod === "nightdrive-pr")) ?? null;
// A tab's first agent pane (a terminal whose program reports a status).
export const agentPane = (tabId) => panes().find((p) => p.tab === tabId && p.terminal && (p.program?.agent || p.app)) ?? null;
// Opens the list beside `pane` (default: the tab's first agent), showing that tab; or closes it.
export function togglePrs(tabId, pane = agentPane(tabId)) {
  const open = prsPane(tabId);
  if (open) { run("pane.close", { pane: open.pane }); return; }
  if (!pane?.terminal) return;
  const space = spaces().find((s) => s.tabs.some((c) => c.id === tabId));
  if (space && !space.active) run("space.select", { id: space.id });
  if (space && !space.tabs.find((c) => c.id === tabId)?.active) run("tab.select", { id: tabId });
  run("pane.split", { direction: "right", pane: pane.pane, mod: "nightdrive-prs", props: { terminal: pane.terminal, agent: pane.pane } });
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

// An agent's icon as a dash warning lamp: its mark as an outline (lamps/<icon>.svg, made from the
// app's icons) in the platform's own lamp color, lit with a glow while the agent is working or needs
// you, and unlit (dim, no glow) while it's idle. Null for programs without a lamp: draw their icon.
export const LAMP = {
  claude: "#ff8a3d", codex: "#e8eeff", gemini: "#4da3ff", cursor: "#e8e8f0", opencode: "#f0f0f0", amp: "#ff4d3f",
  copilot: "#c08cff", agent: "#00f0ff", kiro: "#a066ff", grok: "#f0f0f0", kimi: "#3d9bff", crush: "#ff6daa", pi: "#f0f0f0",
  "command-code": "#ffd84d", qoder: "#2fe07a", antigravity: "#4da3ff", mastracode: "#f0f0f0", muse: "#2f8cff",
  "prime-agent": "#05ffa1", ollama: "#f0f0f0",
};
export const lit = (status) => status === "working" || status === "blocked" || status === "done";
export function lamp(program, size, on = true) {
  const key = /([^/]+)\.svg$/.exec(program?.icon ?? "")?.[1];
  const color = key ? LAMP[key] : null;
  if (!color) return null;
  // The lamp files are padded by 14% a side for the glow, so they're drawn that much bigger and
  // pulled back by it: the mark itself keeps the icon's size and place.
  const big = size * 1.28, d = size * 0.14, base = `mods/nightdrive-chrome/lamps/${key}`;
  const layer = (suffix, c) => div().absolute().left(-d).top(-d).size(big).child(svg(`${base}${suffix}.svg`).size(big).text_color(c));
  return div().relative().size(size).flex_none()
    .when(on, (el) => el.child(layer("-halo", `${color}29`)).child(layer("-glow", `${color}52`)))
    .child(layer("", on ? color : `${color}6b`));
}

// ---- the panel dock (mods/nightdrive-dock) -----------------------------------------------------
// When a layout holds the dock, the side panels live in it: tabs you drag to split, stack or dock
// them. Mods ask it to open or close a panel through shared "dock.request", and read what it shows
// from shared "dock": { open, shown, where, available } (panel names; where: name → region).
export const DOCK_MOD = "nightdrive-dock";
const findIn = (node, test, path = []) => {
  if (!node) return null;
  if (test(node)) return [...path, node];
  for (const c of node.children ?? []) { const hit = findIn(c, test, [...path, node]); if (hit) return hit; }
  return null;
};
// The dock's block in the layout, or null when this layout has none.
export const dockBlock = (root = layout()) => findIn(root, (n) => n.content?.mod === DOCK_MOD)?.pop() ?? null;
export const dockState = () => shared("dock") ?? { open: [], shown: [], where: {}, available: [] };
// op: "open" (show it: where it was last, or `where`), "close", or "toggle" (close it if it's
// showing, else open it). where: "left" | "center" | "right" | "bottom".
export function dockRequest(op, name, where = null) {
  const path = findIn(layout(), (n) => n.content?.mod === DOCK_MOD);
  if (!path) return false;
  // The dock reads requests as it draws, so everything around it shows first.
  if (op !== "close") for (const n of path) if (n.hidden && n.id) run("layout.show", { id: n.id });
  setShared("dock.request", { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, op, name, where, at: Date.now() });
  return true;
}
