import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, focused, home, readTextFile } from "herdr";
import { DISPLAY, statusBlock, rule, flash } from "./nightdrive.js";

// Claude Code's status-line JSON per Herdr terminal, saved there by
// ~/.claude/statusline-context.py as ~/.claude/state/statusline/<terminal>.json.
const STATUS_DIR = () => `${home()}/.claude/state/statusline`;
const pad = (n) => String(n).padStart(2, "0");
function clock(sec) {
  const d = new Date(sec * 1000), h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
function timeLeft(sec) {
  const m = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}H ${pad(m % 60)}M` : `${m}M`;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.sessions = {}; // terminal -> { written_at, status }
    this.poll(cx);
    cx.timer.every(10000, (cx) => this.poll(cx));
  }

  // Re-reads the status files of this machine's Claude sessions and the focused
  // terminal's; redraws only when what the bar shows has changed.
  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const want = new Set(agents().filter((a) => a.app === "claude-code").map((a) => a.address));
        const f = focused()?.terminal;
        if (f) want.add(f);
        const next = {};
        for (const t of want) {
          if (!/^[A-Za-z0-9_-]+$/.test(t)) continue; // local terminals only, not machine/t7
          const text = await readTextFile(`${STATUS_DIR()}/${t}.json`).catch(() => null);
          if (text) try { next[t] = JSON.parse(text); } catch {}
        }
        const before = JSON.stringify(this.usage());
        this.sessions = next;
        if (JSON.stringify(this.usage()) !== before) cx.notify();
      } finally {
        this.polling = false;
      }
    });
  }

  // The focused session's cost, and the account's 5-hour window from whichever
  // session reported it last (it's one account, so any session's report will do).
  usage() {
    const mine = this.sessions[focused()?.terminal ?? ""]?.status;
    let five = null, at = -1;
    for (const s of Object.values(this.sessions)) {
      const w = s?.status?.rate_limits?.five_hour;
      if (w?.resets_at && s.written_at > at) { five = w; at = s.written_at; }
    }
    const cost = mine?.cost?.total_cost_usd;
    return { cost: typeof cost === "number" ? cost : null, five, minute: Math.floor(Date.now() / 60000) };
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const count = (st) => list.filter(a => a.status === st).length;
    const working = count("working"), needs = count("blocked");
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/nightdrive-chrome/${icon}.svg`).size(12).text_color(t.solid)).child(text.toUpperCase());
    const sep = () => div().text_color(t.border).child("/");
    const u = this.usage();
    // The 5-hour usage window: share used, and when it resets (with time left).
    const fiveHour = (w) => {
      const over = w.resets_at * 1000 <= Date.now();
      const pct = Math.round(w.used_percentage ?? 0);
      const tone = pct >= 85 ? t.blocked : pct >= 60 ? t.ansi3 : t.accent;
      return h_flex().gap(6).items_center()
        .child(div().text_color(t.dim).child("5H"))
        .when(over, el => el.child(div().text_color(t.dim).child("WINDOW RESET")))
        .when(!over, el => el
          .child(div().font_bold().text_color(tone).child(`${pct}%`))
          .child(div().text_color(t.dim).child("RESETS"))
          .child(div().text_color(t.foreground).child(clock(w.resets_at)))
          .child(div().text_color(t.dim).child(`(${timeLeft(w.resets_at)})`)));
    };
    return v_flex().size_full().bg(t.chrome)
      .child(rule(1))
      .child(h_flex().flex_1().pr(14).gap(12).items_center().text_size(10.5).text_color(t.muted)
        .child(h_flex().h_full().px(8).items_center().bg(t.solid).text_color("#000000").font_family(DISPLAY).text_size(7.5).child("SYS"))
        .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
        .when(Boolean(space?.branch), el => el.child(sep()).child(label("branch", space.branch)))
        .child(sep())
        .child(h_flex().gap(6).items_center().child(div().size(6).bg(t.dim)).child(`${list.length} AGENTS`))
        .when(working > 0, el => el.child(h_flex().gap(6).items_center().text_color(t.working).child(statusBlock(t, "working", 6, true)).child(`${working} WORKING`)))
        .when(needs > 0, el => el.child(h_flex().gap(6).items_center().text_color(t.blocked).child(flash(statusBlock(t, "blocked", 6))).child(`${needs} NEED${needs === 1 ? "S" : ""} YOU`)))
        .child(div().flex_1())
        .when(u.cost !== null, el => el.child(h_flex().gap(6).items_center()
          .child(div().text_color(t.dim).child("SESSION"))
          .child(div().font_bold().text_color(t.ansi3).child(`$${u.cost.toFixed(2)}`))))
        .when(Boolean(u.five), el => el.child(sep()).child(fiveHour(u.five)))
        .when(u.cost !== null || Boolean(u.five), el => el.child(sep()))
        .child(div().id("palette").text_color(t.dim).hover(s => s.text_color(t.accent)).on_click(() => run("app.palette")).child(this.hint(t).toUpperCase())));
  }
}
