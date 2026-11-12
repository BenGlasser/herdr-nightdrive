// Nightdrive's dash: Claude Code's usage as a car's instrument cluster, in a side panel.
// It reads the status-line JSON that ~/.claude/state/statusline/<terminal>.json holds (the same
// files the status bar reads), for the focused terminal, else the newest Claude Code session.
// props: { block?: "<this block's id in the layout>" }, so it can pause while hidden.
import { View, div, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, home, layout, props, readTextFile, shared, theme } from "herdr";
import { DISPLAY } from "./nightdrive.js";

const DIR = () => `${home()}/.claude/state/statusline`;
const POLL_MS = 10000;
const REDLINE = 0.85;
const EFFORT = [["low", "L"], ["medium", "M"], ["high", "H"], ["xhigh", "XH"], ["max", "MAX"]];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ---- formatting ----
const pad = (n) => String(n).padStart(2, "0");
const clock = (sec) => { const d = new Date(sec * 1000), h = d.getHours(); return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`; };
const left = (sec) => {
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}D ${Math.floor((m % 1440) / 60)}H` : m >= 60 ? `${Math.floor(m / 60)}H ${pad(m % 60)}M` : `${m}M`;
};
const day = (sec) => ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][new Date(sec * 1000).getDay()];
const tokens = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`;
const span = (ms) => { const m = Math.floor(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}H ${pad(m % 60)}M` : `${m}M`; };
const ttlSeconds = (ttl) => { const m = /^(\d+)([smh])$/.exec(ttl ?? ""); return m ? +m[1] * { s: 1, m: 60, h: 3600 }[m[2]] : 300; };
const clamp = (v) => Math.max(0, Math.min(1, v));
const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// A list cut into lines of `n`.
const chunk = (list, n) => list.reduce((out, x, i) => (i % n ? out[out.length - 1].push(x) : out.push([x]), out), []);

// ---- geometry: angles in degrees, clockwise from 3 o'clock (screen y points down) ----
const rad = (deg) => (deg * Math.PI) / 180;
const at = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
const paint = (path, color) => globalThis.window.paint_path(path, color).absolute().top(0).left(0).size_full();

function arc(cx, cy, r, from, to, width) {
  const [x0, y0] = at(cx, cy, r, from), [x1, y1] = at(cx, cy, r, to);
  return PathBuilder.stroke(width).move_to(x0, y0).arc_to(r, r, 0, to - from > 180, true, x1, y1).build();
}
function circle(cx, cy, r, width) {
  const b = width ? PathBuilder.stroke(width) : PathBuilder.fill();
  return b.move_to(cx + r, cy).arc_to(r, r, 0, false, true, cx - r, cy).arc_to(r, r, 0, false, true, cx + r, cy).close().build();
}
function ticks(cx, cy, r0, r1, angles, width) {
  const b = PathBuilder.stroke(width);
  for (const a of angles) { const [x0, y0] = at(cx, cy, r0, a), [x1, y1] = at(cx, cy, r1, a); b.move_to(x0, y0).line_to(x1, y1); }
  return b.build();
}
function line(cx, cy, r, deg, width) {
  const [x, y] = at(cx, cy, r, deg);
  return PathBuilder.stroke(width).move_to(cx, cy).line_to(x, y).build();
}
// A label centred on a point.
const label = (x, y, w, h, el) => div().absolute().left(x - w / 2).top(y - h / 2).w(w).h(h).flex().items_center().justify_center().child(el);
const pix = (size, color, text) => div().font_family(DISPLAY).text_size(size).text_color(color).child(text);

export default class Dash extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.block = given.block ?? "dash";
    // In the panel dock (mods/nightdrive-dock) it shows when the dock says so, not by its own block.
    this.inDock = Boolean(given.dock);
    this.files = {};
    this.width = 368;
    this.poll(cx);
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
  }

  // Polls only while its block shows: nothing above it hidden, each stack above showing its branch.
  visible() {
    if (this.inDock) return (shared("dock")?.shown ?? []).includes(this.block);
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

  poll(cx) {
    if (this.polling || !this.visible()) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const want = new Set(agents().filter((a) => a.app === "claude-code").map((a) => a.address));
        const f = focused()?.terminal;
        if (f) want.add(f);
        const next = {};
        for (const t of want) {
          if (!/^[A-Za-z0-9_-]+$/.test(t)) continue; // this machine's terminals only
          const text = await readTextFile(`${DIR()}/${t}.json`).catch(() => null);
          if (text) try { next[t] = JSON.parse(text); } catch {}
        }
        const before = this.key();
        this.files = next;
        if (this.key() !== before) cx.notify();
      } finally {
        this.polling = false;
      }
    });
  }

  // The session shown, and the account's windows from whichever session reported last.
  data() {
    const all = Object.values(this.files).filter((f) => f?.status);
    const newest = (list) => list.reduce((a, b) => (!a || b.written_at > a.written_at ? b : a), null);
    const session = this.files[focused()?.terminal ?? ""] ?? newest(all.filter((f) => f.terminal in this.files));
    const limits = newest(all.filter((f) => f.status.rate_limits?.five_hour))?.status.rate_limits ?? null;
    return { s: session?.status ?? null, terminal: session?.terminal ?? null, limits };
  }

  // What the dash shows, rounded to what it can show, so a poll redraws only on a visible change.
  key() {
    const { s, limits } = this.data();
    const pc = s?.prompt_cache;
    return JSON.stringify([s?.session_id, s?.cost, s?.context_window?.used_percentage, s?.effort, s?.model?.display_name,
      s?.fast_mode, s?.thinking?.enabled, pc?.warm, pc?.hit_ratio, pc ? Math.round((pc.expires_at - Date.now() / 1000) / 60) : null,
      limits, Math.floor(Date.now() / 60000)]);
  }

  // A round dial: a 270° sweep from bottom-left, with a redline zone and a digital readout.
  dial(t, size, value, name, readout, sub) {
    const cx = size / 2, cy = size / 2, r = size / 2 - 12, v = value == null ? 0 : clamp(value);
    // Below 160px the ticks, hub and readout shrink with the face, and the numbers go once they'd crowd the hub.
    const k = Math.min(1, size / 160);
    const A0 = 135, SW = 270, a = (x) => A0 + SW * x;
    const tone = value == null ? t.dim : v >= REDLINE ? t.blocked : v >= 0.6 ? t.ansi3 : t.accent;
    const majors = [...Array(11).keys()].map((i) => i / 10), minors = [...Array(10).keys()].map((i) => i / 10 + 0.05);
    const glow = Background.linear_gradient(90, t.accent, t.solid);
    const el = div().relative().w(size).h(size + 14).flex_none()
      .child(paint(circle(cx, cy, r + 8), "#05030a"))
      .child(paint(circle(cx, cy, r + 8, 1), t.border))
      .child(paint(arc(cx, cy, r, a(0), a(1), 5), t.raised))
      .child(paint(arc(cx, cy, r, a(REDLINE), a(1), 5), "#ff2a6d55"))
      .when(v > 0.004, (e) => e.child(paint(arc(cx, cy, r, a(0), a(v), 5), glow)))
      .child(paint(ticks(cx, cy, r - 9 * k, r - 18 * k, majors.filter((x) => x < REDLINE).map(a), 2), t.muted))
      .child(paint(ticks(cx, cy, r - 9 * k, r - 18 * k, majors.filter((x) => x >= REDLINE).map(a), 2), t.blocked))
      .child(paint(ticks(cx, cy, r - 9 * k, r - 13 * k, minors.map(a), 1), t.dim))
      .children(majors.filter((_, i) => size >= 130 && (size >= 190 || i % 2 === 0)).map((x) => {
        const [lx, ly] = at(cx, cy, r - 29, a(x));
        return label(lx, ly, 22, 10, pix(8, x >= REDLINE ? t.blocked : t.muted, String(Math.round(x * 10))));
      }))
      .child(label(cx, cy - r * 0.36, 60, 10, pix(8, t.solid, name)))
      .child(paint(line(cx, cy, r - 10 * k, a(v), 7 * k), "#ff2bd633"))
      .child(paint(line(cx, cy, r - 10 * k, a(v), 2.5), t.solid))
      .child(paint(circle(cx, cy, Math.max(4, 7 * k)), t.raised))
      .child(paint(circle(cx, cy, Math.max(4, 7 * k), 1.5), t.accent))
      // The readout sits low, between the sweep's ends; the reset time goes under the face.
      .child(label(cx, cy + r * 0.78, size >= 160 ? size - 40 : size * 0.8, 18, pix(size >= 140 ? 16 : size >= 105 ? 12 : 9, tone, readout)))
      // Small dials keep only the countdown ("2H 17M"), so neighbours' reset times don't run together.
      .child(label(cx, size + 5, size, 14, div().text_size(size >= 120 ? 10 : 9).text_color(t.muted)
        .child(size >= 120 ? sub : String(sub ?? "").split(" · ").pop())));
    return el;
  }

  // A half gauge (fuel, temperature): 180° across the top, end letters, a needle and a readout.
  meter(t, w, value, name, lo, hi, readout, sub, warnLow) {
    const h = w * 0.62 + 14, cx = w / 2, cy = h - 36, r = Math.min(w / 2 - 14, cy - 8), v = value == null ? 0 : clamp(value);
    const k = Math.min(1, w / 160); // ticks and hub shrink with the face below 160px
    const a = (x) => 180 + 180 * x;
    const tone = value == null ? t.dim : warnLow && v < 0.2 ? t.blocked : t.accent;
    return div().relative().w(w).h(h).flex_none()
      .child(paint(arc(cx, cy, r, a(0), a(1), 4), t.raised))
      .when(warnLow, (e) => e.child(paint(arc(cx, cy, r, a(0), a(0.2), 4), "#ff2a6d55")))
      .when(v > 0.004, (e) => e.child(paint(arc(cx, cy, r, a(0), a(v), 4), Background.linear_gradient(90, t.accent, t.solid))))
      .child(paint(ticks(cx, cy, r - 7 * k, r - 14 * k, [0, 0.25, 0.5, 0.75, 1].map(a), 2), t.muted))
      // The end letters sit where the readout runs on a small meter: they go below 120px.
      .when(w >= 120, (e) => e
        .child(label(...at(cx, cy, r + 2, a(0)), 16, 10, pix(8, warnLow ? t.blocked : t.accent, lo)).mt(16))
        .child(label(...at(cx, cy, r + 2, a(1)), 16, 10, pix(8, hi === "H" ? t.solid : t.muted, hi)).mt(16)))
      .child(label(cx, cy - r * 0.42, 70, 10, pix(8, t.solid, name)))
      .child(paint(line(cx, cy, r - 6 * k, a(v), 6 * k), "#ff2bd633"))
      .child(paint(line(cx, cy, r - 6 * k, a(v), 2), t.solid))
      .child(paint(circle(cx, cy, Math.max(3.5, 5 * k)), t.raised))
      .child(paint(circle(cx, cy, Math.max(3.5, 5 * k), 1.5), t.accent))
      .child(label(cx, cy + 14, w >= 120 ? w - 40 : w, 12, div().text_size(w >= 120 ? 11 : 9.5).font_bold().text_color(tone).child(readout)))
      .child(label(cx, cy + 28, w >= 120 ? w - 40 : w, 12, div().text_size(w >= 120 ? 10 : 9).text_color(t.dim).child(sub)));
  }

  // A row of dash warning lamps: lit in their color, unlit as dark outlines. They stay still.
  lamps(t, list) {
    return h_flex().flex_wrap().gap(6).children(list.map(([text, lit, color]) =>
      div().h(20).px(6).flex().items_center().border_1().text_size(9.5).font_bold()
        .border_color(lit ? color : t.border).text_color(lit ? color : t.unknown).when(lit, (e) => e.bg(`${color}26`))
        .child(text)));
  }

  render(cx) {
    const t = theme();
    if (this.visible() && !this.wasShown) this.poll(cx); // catch up as soon as it's opened
    this.wasShown = this.visible();
    const { s, terminal, limits } = this.data();
    // The four gauges reflow with the panel's width: one line of four once each gets GAUGE px,
    // two by two below that, and one under another when two side by side would be smaller. In one
    // column they shrink with the panel, down to half of GAUGE.
    const W = this.width, gap = 10, GAUGE = 160;
    const cols = W >= 4 * GAUGE + 5 * gap ? 4 : W >= 2 * GAUGE + 3 * gap ? 2 : 1;
    const fit = Math.max(GAUGE / 2, Math.floor((W - gap * (cols + 1)) / cols));
    const big = Math.min(240, fit), small = Math.min(220, fit);
    // Under 220px the odometer, trip meter and gear stack instead of running past the edge.
    const narrow = W < 220;
    const five = limits?.five_hour, week = limits?.seven_day;
    const pct = (w) => (w && w.resets_at * 1000 > Date.now() ? w.used_percentage / 100 : w ? 0 : null);
    const ctx = s?.context_window, pc = s?.prompt_cache;
    const usedTokens = ctx ? Math.round((ctx.context_window_size * (ctx.used_percentage ?? 0)) / 100) : 0;
    const cacheLeft = pc?.warm ? clamp((pc.expires_at - Date.now() / 1000) / ttlSeconds(pc.ttl)) : pc ? 0 : null;
    const blocked = agents().filter((a) => a.status === "blocked").length;
    const cost = s?.cost?.total_cost_usd;
    const odo = typeof cost === "number" ? cost.toFixed(2).padStart(7, "0") : "----.--";
    const effort = s?.effort?.level;

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().text_color(t.solid).child("//")).child(pix(8, t.accent, "DASH"))
      .child(div().flex_1())
      .child(div().max_w(180).truncate().text_size(12).text_color(t.dim).child(s ? (s.session_name || terminal || "") : ""));

    if (!s && !limits) {
      return v_flex().id(this.block).size_full().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
        .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
        .child(header)
        .child(div().p(14).text_size(12.5).text_color(t.muted).child(
          "No Claude Code status yet. The dash reads ~/.claude/state/statusline/<terminal>.json, which a Claude Code status line writes for each Herdr terminal."));
    }

    const odometer = h_flex().gap(2).children([...odo].map((ch, i) => ch === "."
      ? div().w(6).h(26).flex().items_end().justify_center().text_color(t.solid).child(".")
      : div().w(17).h(26).flex().items_center().justify_center().bg("#000000").border_1().border_color(t.border)
        .text_size(14).font_bold().text_color(i >= odo.length - 2 ? t.solid : t.foreground).child(ch)));

    const readout = (k, v, color) => (narrow ? v_flex().gap(1) : h_flex().gap(6).items_center())
      .child(div().text_size(9.5).text_color(t.dim).child(k)).child(div().text_size(11).font_bold().text_color(color ?? t.foreground).child(v));

    const gauges = [
      this.dial(t, big, pct(five), "5H", five ? `${Math.round(pct(five) * 100)}%` : "--",
        five ? (five.resets_at * 1000 > Date.now() ? `${clock(five.resets_at)} · ${left(five.resets_at)}` : "WINDOW RESET") : "NO DATA"),
      this.dial(t, big, pct(week), "7D", week ? `${Math.round(pct(week) * 100)}%` : "--",
        week ? (week.resets_at * 1000 > Date.now() ? `${day(week.resets_at)} ${clock(week.resets_at)} · ${left(week.resets_at)}` : "WINDOW RESET") : "NO DATA"),
      this.meter(t, small, ctx ? (ctx.remaining_percentage ?? 0) / 100 : null, "CTX", "E", "F",
        ctx ? `${ctx.remaining_percentage ?? 0}% LEFT` : "--", ctx ? `${tokens(usedTokens)} / ${tokens(ctx.context_window_size)}` : "", true),
      this.meter(t, small, cacheLeft, "CACHE", "C", "H",
        !pc ? "--" : pc.warm ? `WARM ${left(pc.expires_at)}` : "COLD", pc ? `HIT ${Math.round((pc.hit_ratio ?? 0) * 100)}%` : "", false),
    ];

    const gear = h_flex().flex_wrap().gap(3).items_center().children(EFFORT.map(([id, short]) =>
      div().h(22).px(6).flex().items_center().justify_center().text_size(10.5).font_bold()
        .when(id === effort, (e) => e.bg(t.accent).text_color(t.accent_foreground))
        .when(id !== effort, (e) => e.border_1().border_color(t.border).text_color(t.unknown))
        .child(short)));

    return v_flex().id(this.block).size_full().min_h(0).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(header)
      .child(v_flex().id("dash-body").flex_1().min_h(0).overflow_y_scrollbar().py(12).gap(12)
        // The gauges, `cols` to a line: speedo and tach (the 5-hour and 7-day windows), then fuel
        // and temperature (context left, and how long the prompt cache stays warm).
        .children(chunk(gauges, cols).map((line) => h_flex().px(gap).gap(gap).justify_center().items_center().children(line)))
        // Odometer and trip meter.
        .child(v_flex().mx(gap).p(10).gap(8).bg(t.surface).border_1().border_color(t.border)
          .child(narrow
            ? v_flex().gap(4).child(pix(8, t.dim, "ODO"))
              .child(div().text_size(13).font_bold().text_color(t.foreground).child(typeof cost === "number" ? `$${cost.toFixed(2)}` : "--"))
            : h_flex().gap(10).items_center().child(div().w(34).child(pix(8, t.dim, "ODO"))).child(div().text_color(t.dim).child("$")).child(odometer))
          .child(h_flex().flex_wrap().gap(narrow ? 10 : 14).items_center()
            .child(div().w(34).child(pix(8, t.dim, "TRIP")))
            .child(readout("LINES", s ? `+${commas(s.cost?.total_lines_added ?? 0)}` : "--", t.ansi2))
            .child(readout("", s ? `−${commas(s.cost?.total_lines_removed ?? 0)}` : "", t.ansi1))
            .child(readout("TIME", s ? span(s.cost?.total_duration_ms ?? 0) : "--"))
            .child(readout("API", s ? span(s.cost?.total_api_duration_ms ?? 0) : "--"))))
        // Gear: the effort level, with the model as the drive mode.
        .child(h_flex().mx(gap).flex_wrap().gap(10).items_center()
          .child(pix(8, t.dim, "GEAR")).child(gear).child(div().flex_1())
          .child(div().max_w(150).truncate().text_size(11).font_bold().text_color(t.muted).child((s?.model?.display_name ?? "").toUpperCase())))
        // Warning lamps.
        .child(div().mx(gap).child(this.lamps(t, [
          ["5H", (pct(five) ?? 0) >= REDLINE, t.blocked],
          ["7D", (pct(week) ?? 0) >= REDLINE, t.blocked],
          ["LOW CTX", Boolean(ctx) && (ctx.remaining_percentage ?? 100) < 20, t.blocked],
          ["COLD CACHE", Boolean(pc) && !pc.warm, t.accent],
          ["FAST", Boolean(s?.fast_mode), t.done],
          ["THINK", Boolean(s?.thinking?.enabled), t.solid],
          [blocked ? `NEEDS YOU ${blocked}` : "NEEDS YOU", blocked > 0, t.blocked],
        ]))));
  }
}
