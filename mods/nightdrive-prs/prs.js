// Shared by nightdrive-prs (the PR list) and nightdrive-pr (the review tab). Mods can't import
// across folders, so nightdrive-pr has a copy: change this one and copy it over.
import { div, PathBuilder, Background } from "gpui-kit";
import { agents, exec, panes, run, spaces } from "herdr";
import { DISPLAY } from "./nightdrive.js";

// Running checks' color: between the theme's yellow (#ffe14d) and orange.
export const AMBER = "#ffb02e";
const RED = "#ff2a6d", GREEN = "#05ffa1";

// Owner, repo, number and the canonical link, from any PR link; null if it isn't one.
export function parseUrl(url) {
  const m = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(url ?? "");
  return m ? { owner: m[1], name: m[2], number: +m[3], url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null;
}

// The repo without its owner's prefix (acme/acme-api: api), else its whole name.
export function repoLabel(owner, name) {
  let i = 0;
  while (i < owner.length && i < name.length && owner[i].toLowerCase() === name[i].toLowerCase()) i++;
  return i >= 4 && /[-_]/.test(name[i] ?? "") && name.length > i + 1 ? name.slice(i + 1) : name;
}

// Ticket ids a PR names: at the start of its title ("APP-4144: …") or of its branch
// ("app-4144-delegate-…", "feat/app-4144-…"). Only there, so UTF-8 or SHA-256 in a title don't count.
export function tickets(pr) {
  const out = new Set();
  const title = /^\W*([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(pr?.title ?? "");
  if (title) out.add(title[1]);
  const branch = /(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=[-_/]|$)/.exec(pr?.headRefName ?? "");
  if (branch) out.add(branch[1].toUpperCase());
  return [...out];
}

// gh's output as JSON (null when empty), or an Error with gh's own message.
export async function gh(args) {
  const r = await exec("gh", args, { timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^gh: /, "") || `gh exited with ${r.code}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

// A GraphQL query through gh. Partial data counts: a PR that's gone comes back null, with an
// error beside it, and the rest still shows.
export async function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await exec("gh", args, { timeout: 60000 });
  let d = null;
  try { d = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch {}
  if (d?.data) return d.data;
  throw new Error(d?.errors?.[0]?.message ?? ((r.stderr || "").trim().replace(/^gh: /, "") || `gh exited with ${r.code}`));
}

// The head commit's checks (statusCheckRollup), as one word: success, running, failure, or null.
export const rollup = (pr) => pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
export function ciState(pr) {
  const s = rollup(pr)?.state;
  return s === "SUCCESS" ? "success" : s === "PENDING" || s === "EXPECTED" ? "running" : s === "FAILURE" || s === "ERROR" ? "failure" : null;
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

// ---- where a review shows ----
// Beside the agent: a pane in the agent's tab, in place of the PR list. An agent's tab holds one
// PR area, the list or a review, so a mod finds its own pane by its mod name in that tab.
// Or in a tab of its own in the agent's space, named like "API #1434".
export const tabName = (u) => `${repoLabel(u.owner, u.name)} #${u.number}`;
export const reviewPane = (tabId) => panes().find((p) => p.tab === tabId && p.mod === "nightdrive-pr") ?? null;
export const listPane = (tabId) => panes().find((p) => p.tab === tabId && p.mod === "nightdrive-prs") ?? null;
export const agentPaneOf = (pane) => (pane ? panes().find((p) => p.pane === pane && p.terminal) ?? null : null);

function showTab(tabId) {
  const space = spaces().find((s) => s.tabs.some((c) => c.id === tabId));
  if (space && !space.active) run("space.select", { id: space.id });
  if (space && !space.tabs.find((c) => c.id === tabId)?.active) run("tab.select", { id: tabId });
}

// Puts `mod` beside the agent in place of its PR area (the list or a review). The old pane
// closes first and then the agent's pane splits, so the new one gets half the agent's room again.
// (Splitting the old pane and then closing it hands its room to the agent instead.) A mod may
// call this on its own pane: the menu closes itself the same way before it runs a command.
function placeBeside(a, mod, props) {
  const old = reviewPane(a.tab) ?? listPane(a.tab);
  showTab(a.tab);
  if (old) run("pane.close", { pane: old.pane });
  run("pane.split", { direction: "right", pane: a.pane, mod, props });
}

// The review beside the agent (`agent`: its pane id). False if the agent's pane is gone.
// `list` tells the review it took the PR list's place, so going back brings the list back;
// opened from the side panel's list, there was none, and going back just closes it.
export function openBeside(url, agent) {
  const a = agentPaneOf(agent), u = parseUrl(url);
  if (!a || !u) return false;
  const list = Boolean(listPane(a.tab));
  placeBeside(a, "nightdrive-pr", { url: u.url, agent: a.pane, terminal: a.terminal, beside: true, list });
  return true;
}

// Closes the review beside the agent.
export function closeBeside(agent) {
  const a = agentPaneOf(agent), review = a && reviewPane(a.tab);
  if (review) run("pane.close", { pane: review.pane });
}

// The PR list back beside the agent, in place of a review.
export function backToList(agent) {
  const a = agentPaneOf(agent);
  if (a) placeBeside(a, "nightdrive-prs", { terminal: a.terminal, agent: a.pane });
}

// The PR's own tab in the agent's space; shown again if it's already open.
export function openTab(url, agent, terminal) {
  const u = parseUrl(url);
  if (!u) return;
  const name = tabName(u), a = agentPaneOf(agent);
  const spaceId = agents().find((x) => x.address === (a?.terminal ?? terminal))?.space;
  const space = spaces().find((s) => s.id === spaceId) ?? spaces().find((s) => s.tabs.some((c) => c.id === a?.tab)) ?? spaces().find((s) => s.active);
  const open = space?.tabs.find((c) => c.name === name && panes().some((p) => p.tab === c.id && p.mod === "nightdrive-pr"));
  if (space && !space.active) run("space.select", { id: space.id });
  if (open) run("tab.select", { id: open.id });
  else run("tab.new", { space: space?.id, name, mod: "nightdrive-pr", props: { url: u.url, agent: a?.pane ?? agent ?? null, terminal: a?.terminal ?? terminal ?? null } });
}

const paint = (path, fill) => globalThis.window.paint_path(path, fill).absolute().top(0).left(0).size_full();
const rect = (w, h) => PathBuilder.fill().move_to(0, 0).line_to(w, 0).line_to(w, h).line_to(0, h).close().build();

// A row (or strip) that is its own check indicator, laid under its content. w and h: its size in px.
// Every .loop runs off one clock shared by the whole window, whenever its element first showed,
// and takes no start delay: equal loops always move in step.
// success: a soft green glow, slowly brightening and fading.
// running: a faint amber wash with a brighter amber beam sweeping back and forth.
// failure: red hatching that blinks, with FAILURE at the right (leave the row ~90px of right padding).
//   Every failure blinks together, on purpose: in step, they read as one alarm.
// All motion is native (.loop), so nothing redraws the window.
export function ciLayer(state, w, h) {
  if (!state || !(w > 0)) return div();
  const layer = div().absolute().top(0).left(0).w(w).h(h).overflow_hidden();
  if (state === "success") {
    return layer.child(div().absolute().top(0).left(0).w(w).h(h).bg(`${GREEN}24`).border_1().border_color(`${GREEN}38`)
      .loop("opacity", { from: 0.2, to: 1, period: 3600 }));
  }
  if (state === "running") {
    const beam = Math.max(72, Math.round(w * 0.3)), half = beam / 2, end = Math.max(0, w - beam);
    return layer.child(div().absolute().top(0).left(0).w(w).h(h).bg(`${AMBER}12`))
      .child(div().absolute().top(0).left(0).w(beam).h(h)
        .child(div().absolute().top(0).left(0).w(half).h(h).child(paint(rect(half, h), Background.linear_gradient(90, `${AMBER}00`, `${AMBER}70`))))
        .child(div().absolute().top(0).left(half).w(half).h(h).child(paint(rect(half, h), Background.linear_gradient(90, `${AMBER}70`, `${AMBER}00`))))
        .loop("left", { from: 0, to: end, period: 2600 }));
  }
  return layer.child(div().absolute().top(0).left(0).w(w).h(h).bg(`${RED}12`))
    .child(div().absolute().top(0).left(0).w(w).h(h)
      .child(paint(rect(w, h), Background.pattern_slash(`${RED}5c`, 3, 10)))
      .child(div().absolute().top(0).right(8).h(h).flex().items_center()
        .child(div().px(6).py(3).bg("#05030acc").border_1().border_color(RED).font_family(DISPLAY).text_size(7.5).text_color(RED).child("FAILURE")))
      .loop("opacity", { from: 0.15, to: 1, period: 700, easing: "linear" }));
}
