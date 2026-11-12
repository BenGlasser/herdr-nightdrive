// Nightdrive's ClickUp panel: the tasks assigned to you, grouped by status, with a toggle per
// status across the top. Clicking a task opens it here: its description, comments (and their
// replies), a comment box, and its list's statuses to move it (after you confirm).
//   As a side panel (the tab bar's CLICKUP button), props {block, team?}:
//     block: its id in the layout, so it reads only while it shows
//     team: the workspace's id or name (default: your first workspace)
//   As a tab with one task (the task's FULL TAB, or ⌥-click), props {task: its id, ref}.
// A task's AI (in its header) and START (in its header, and on its row while hovered; only once
// a START command is set) go to the task's space if it has one. Otherwise they open one named after
// it with an agent in it: AI has it read the task first and wait; START sends it the START command.
// Settings (⚙, shared "clickup.settings"): where new spaces open, the agent, the START command and
// which custom fields show as chips. A layout can seed them through props {folder, agent, start, fields}.
// Works in any layout; in a Nightdrive one it takes Nightdrive's titles (look.js).
// Reads and writes with a ClickUp personal API token kept in the system keychain (service
// "clickup-feed", account "api.clickup.com"); paste it into the panel once. It changes only what
// you ask: a comment you post, or a status you confirm. It never creates or deletes a task.
// It tells other mods the task-number prefixes it has seen (shared "clickup.prefixes", like ["APP"]).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView, TextareaState, Textarea } from "gpui-base";
import { closeOverlay, exec, hc, home, layout, openOverlay, panes, props, run, setShared, shared, spaces, theme, window } from "herdr";
import { face, title, reticle } from "./look.js";
import { task, statuses, sorted, due, listStatuses, comment, chronological, ago, lines, picked, setFields } from "./tickets.js";

const API = "https://api.clickup.com/api/v2";
const SERVICE = "clickup-feed", ACCOUNT = "api.clickup.com";
const TICK_MS = 30000;      // checks whether a read is due
const REFRESH_MS = 180000;  // reads ClickUp this often while it shows
const MAX_PAGES = 10;       // 100 tasks a page
const PAGE_COMMENTS = 25;   // ClickUp sends the latest 25
const ICON = "mods/clickup/tickets.svg";
const START_ICON = "mods/clickup/start.svg";
const AI_ICON = "mods/clickup/ai.svg";
const TAB_ICON = "mods/clickup/zoom.svg";
const CLOCK_ICON = "mods/clickup/clock.svg";
const GEAR_ICON = "mods/clickup/settings.svg";
const WIDE = 470; // narrower than this, the task header's buttons show only their icons
const CUSTOM_ID = /^[a-z]+-\d+$/i; // a task's number (APP-1234), as opposed to ClickUp's own id
const ASK_MS = 30000; // a pane's request to open a task counts for this long
const SETTINGS = "clickup.settings";
const SETTING_KEYS = ["folder", "agent", "start", "fields"];
const AMBER = "#ffb02e";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The token, in the system keychain: macOS Keychain (security) or the Secret Service on Linux (secret-tool).
const platform = () => window()?.platform ?? "macos";
async function readKey() {
  const os = platform();
  const r = os === "macos" ? await exec("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { timeout: 8000 }).catch(() => null)
    : os === "linux" ? await exec("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { timeout: 8000 }).catch(() => null) : null;
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
async function writeKey(key) {
  const os = platform();
  const r = os === "macos" ? await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", key], { timeout: 8000 })
    : os === "linux" ? await exec("sh", ["-c", `printf %s "$1" | secret-tool store --label="ClickUp token" service ${SERVICE} account ${ACCOUNT}`, "sh", key], { timeout: 8000 })
    : { code: 1, stderr: "keeping the token isn't supported on this system yet" };
  if (r.code !== 0) throw new Error((r.stderr || "couldn't keep the token").trim());
}
const keychain = () => (platform() === "macos" ? "macOS Keychain" : "keychain");
function browse(url) {
  if (!url) return;
  const os = platform();
  const [cmd, args] = os === "macos" ? ["open", [url]] : os === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  exec(cmd, args).catch(() => {});
}
const tilde = (path) => { const h = home(); return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path; };

// ClickUp's REST API: JSON in and out, or an Error carrying the HTTP status.
async function call(key, path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { Authorization: key, "Content-Type": "application/json" } : { Authorization: key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 160);
    try { msg = JSON.parse(text).err ?? msg; } catch {}
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const section = (t, label, extra) => h_flex().gap(8).items_center().pt(4)
  .children(title(t, label))
  .when(extra != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(extra))));

export default class ClickUp extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    // As the space picker (START or AI on a task open in several spaces): nothing else loads.
    if (given.choose) {
      this.choosing = given.choose;
      this.opened = {};
      this.loadOpened(cx);
      return;
    }
    this.block = given.block ?? "clickup";
    // In the panel dock (mods/nightdrive-dock) it shows when the dock says so, not by its own block.
    this.inDock = Boolean(given.dock);
    this.teamWanted = given.team == null ? null : String(given.team);
    this.tabTask = given.task ? { id: String(given.task), ref: given.ref ?? null } : null;
    this.tasks = [];
    this.last = 0;
    this.lists = {};
    // Kept in shared state, so every copy (a panel, the dock's, a task's tab) agrees and props edits
    // don't lose them; earlier builds kept them in this copy's own storage, read once.
    const old = (key, empty) => { try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? empty; } catch { return empty; } };
    this.hidden = new Set(shared("clickup.hidden") ?? old("hidden", []));
    // Task (APP-1234) -> the space opened for it here, by id, so renaming the space keeps it.
    this.taskSpaces = shared("clickup.task-spaces") ?? old("task-spaces", {});
    this.keyInput = InputState.new({ placeholder: "pk_…" });
    this.keyInput.set_masked(true);
    this.keyInput.on("submit", (_e, cx) => this.saveKey(cx));
    // Settings: a layout's props seed them once; after that they're the ⚙ view's.
    const seed = Object.fromEntries(SETTING_KEYS.filter((k) => given[k] != null).map((k) => [k, String(given[k])]));
    if (Object.keys(seed).length && !shared(SETTINGS)) setShared(SETTINGS, seed);
    this.inputs = {};
    const hints = { folder: "blank: the folder of the space that's showing", agent: "claude", start: "/my-plugin:start-task {id}", fields: "Team, Area" };
    for (const k of SETTING_KEYS) {
      const state = InputState.new({ placeholder: hints[k], value: this.settings()[k] === "claude" && k === "agent" ? "" : this.settings()[k] });
      const keep = () => setShared(SETTINGS, { ...(shared(SETTINGS) ?? {}), [k]: state.value().trim() });
      state.on("blur", keep);
      state.on("submit", keep);
      this.inputs[k] = state;
    }
    this.composer = TextareaState.new({ placeholder: "Leave a comment", rows: 3 });
    this.composer.on("change", (_e, cx) => {
      const had = Boolean(this.draft?.trim());
      this.draft = this.composer.value();
      if (had !== Boolean(this.draft.trim())) cx.notify();
    });
    this.composer.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.composer.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (this.tabTask) this.openTask(this.tabTask.id, cx);
    else {
      this.tick(cx, true);
      cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    }
  }

  // Shown when nothing above its block is hidden and each stack shows its branch.
  visible() {
    if (this.inDock) return (shared("dock")?.shown ?? []).includes(this.block);
    const root = layout(), id = this.block;
    if (this.tabTask || !find(root, id)) return true;
    const shown = (node) => {
      if (!node || node.hidden) return false;
      if (node.id === id) return true;
      const kids = node.children ?? [];
      if (node.type === "stack") return shown(kids.find((c) => c.id === node.active) ?? kids[0]);
      return kids.some(shown);
    };
    return shown(root);
  }

  // ---- settings ----
  settings() {
    const s = shared(SETTINGS) ?? {};
    return { folder: s.folder ?? "", agent: s.agent || "claude", start: s.start ?? "", fields: s.fields ?? "" };
  }

  // Where a new task space opens: the folder in settings (~ is home), else the showing space's.
  spaceFolder() {
    const f = this.settings().folder.trim();
    if (f) return f === "~" ? home() : f.startsWith("~/") ? `${home()}${f.slice(1)}` : f;
    const sp = spaces().find((s) => s.active);
    return panes().find((p) => (sp?.tabs ?? []).some((tb) => tb.id === p.tab) && p.cwd)?.cwd ?? sp?.folder ?? home();
  }

  folderLabel() { const f = this.settings().folder.trim(); return f ? tilde(f) : "the showing space's folder"; }

  // What START sends for a task: the command with {id}, {url} and {name} filled in (with none of
  // them, the task's number goes at the end); null while no START command is set.
  startCommand(ref, name, url) {
    const tpl = this.settings().start.trim(), key = String(ref ?? "").replace(/^#/, "");
    if (!tpl) return null;
    if (!/\{(id|url|name)\}/.test(tpl)) return `${tpl} ${key}`;
    return tpl.replace(/\{id\}/g, key).replace(/\{url\}/g, url ?? "").replace(/\{name\}/g, name ?? "");
  }

  // ---- the list ----
  tick(cx, force = false) {
    if (this.tabTask || this.busy || !this.visible()) return;
    if (!force && Date.now() - this.last < REFRESH_MS) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.key ??= await readKey();
        if (!this.key) return;
        await this.read();
        this.error = null;
      } catch (e) {
        await this.fail(e);
      } finally {
        this.loaded = true;
        this.busy = false;
        cx.notify();
      }
    });
  }

  // ClickUp answers 401 for a token it turns down, but also for a task the token can't see
  // ("Team not authorized"). Only when it won't even say who you are is a new token needed.
  async badToken() {
    try { await call(this.key, "/user"); return false; } catch (e) { return e?.status === 401; }
  }

  async fail(e) {
    if (e?.status === 401 && this.key && await this.badToken()) {
      this.key = null;
      this.keyNote = "ClickUp turned down the saved token. Paste a new one.";
      return true;
    }
    this.error = String(e?.message ?? e);
    return false;
  }

  // The workspace: the one asked for in props, else your first.
  async workspace() {
    if (!this.team) {
      const teams = (await call(this.key, "/team")).teams ?? [];
      const want = this.teamWanted?.toLowerCase();
      this.team = teams.find((x) => want && (String(x.id) === want || x.name?.toLowerCase() === want)) ?? teams[0] ?? null;
      if (!this.team) throw new Error("This token can't see any ClickUp workspace.");
    }
    return this.team;
  }

  // You, your workspace, then every task assigned to you there that isn't closed (subtasks too).
  async read() {
    this.me ??= (await call(this.key, "/user")).user;
    await this.workspace();
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `page=${page}&assignees%5B%5D=${encodeURIComponent(this.me.id)}&subtasks=true&include_closed=false&order_by=updated`;
      const d = await call(this.key, `/team/${this.team.id}/task?${q}`);
      const got = d.tasks ?? [];
      all.push(...got.map(task));
      if (d.last_page === true || got.length < 100) break;
    }
    this.tasks = all;
    this.limited = all.length >= MAX_PAGES * 100;
    // The task-number prefixes in use (APP in APP-1234), for mods that spot tickets in text.
    const prefixes = [...new Set(all.map((x) => /^([A-Za-z]+)-\d+$/.exec(x.ref ?? "")?.[1]?.toUpperCase()).filter(Boolean))].sort();
    if (JSON.stringify(prefixes) !== JSON.stringify(shared("clickup.prefixes") ?? [])) setShared("clickup.prefixes", prefixes);
    this.last = Date.now();
  }

  saveKey(cx) {
    const key = this.keyInput.value().trim();
    if (this.saving) return;
    if (!/^pk_[A-Za-z0-9_]+$/.test(key)) { this.keyNote = "ClickUp personal tokens start with pk_."; cx.notify(); return; }
    this.saving = true;
    this.keyNote = null;
    cx.spawn(async (cx) => {
      try {
        this.me = (await call(key, "/user")).user;
        await writeKey(key);
        this.key = key;
        this.keyInput.set_value("");
        this.saving = false;
        if (this.openId) this.loadTask(cx); else this.tick(cx, true);
      } catch (e) {
        this.keyNote = e.status ? `ClickUp turned that token down (HTTP ${e.status}).` : `Couldn't save the token: ${e.message ?? e}`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  toggle(key, cx) {
    if (this.hidden.has(key)) this.hidden.delete(key);
    else this.hidden.add(key);
    setShared("clickup.hidden", [...this.hidden]);
    cx.notify();
  }

  showAll(cx) {
    this.hidden.clear();
    setShared("clickup.hidden", []);
    cx.notify();
  }

  browse(url) { browse(url); }

  // ---- one task ----
  openTask(id, cx) {
    this.openId = id;
    this.detail = null;
    this.detailError = null;
    this.picking = false;
    this.pending = null;
    this.note = null;
    this.composer.set_value("");
    this.draft = "";
    this.loadTask(cx);
    cx.notify();
  }

  back(cx) {
    this.openId = null;
    this.detail = null;
    this.tick(cx);
    cx.notify();
  }

  // A new space for a task, named after it, in spaceFolder() on this computer, with the agent in it
  // (given `task` as its first message, if any). It becomes the task's space once it shows up. A
  // second click on the same task within a few seconds is a double click.
  openSpace(ref, name, task) {
    const key = String(ref ?? "").replace(/^#/, "");
    if (!key || (this.started?.key === key && Date.now() - this.started.at < 4000)) return;
    this.started = { key, at: Date.now() };
    const tab = name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name;
    this.awaiting = { key, ref, before: new Set(spaces().map((s) => s.id)), until: Date.now() + 10000 };
    const argv = this.settings().agent.trim().split(/\s+/).filter(Boolean);
    run("space.new", { name: ref, folder: this.spaceFolder(), tab: tab || ref, argv: argv.length ? argv : ["claude"], ...(task ? { task } : {}), machine: "" });
    this.remember();
  }

  // Ties the space just opened for a task to it: the new space with the task's name.
  remember() {
    const a = this.awaiting;
    if (!a) return;
    const made = spaces().find((s) => !a.before.has(s.id) && s.name === a.ref);
    if (made) {
      this.taskSpaces[a.key] = { id: made.id, at: Date.now() };
      setShared("clickup.task-spaces", { ...(shared("clickup.task-spaces") ?? {}), [a.key]: this.taskSpaces[a.key] });
    }
    if (made || Date.now() > a.until) this.awaiting = null;
  }

  // The spaces working on a task, in sidebar order: the one opened for it here (by id, so a rename
  // keeps it) and any with its number anywhere in their name ("APP-1234", "fix app-1234 api"), which
  // covers the ones you open and name yourself. Entries saved before times were kept are plain ids.
  taskSpaces_(ref) {
    const key = String(ref ?? "").replace(/^#/, "");
    if (!key) return [];
    const kept = (shared("clickup.task-spaces") ?? this.taskSpaces)[key], keptId = typeof kept === "string" ? kept : kept?.id;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`(^|[^\\w-])#?${escaped}(?![\\w-])`, "i");
    return spaces().filter((s) => s.id === keptId || named.test(s.name));
  }

  // To a task's space: the one there is, a choice when there are several, else `open()` makes one.
  // Going to a space only shows it: nothing is started or typed there, whoever opened it.
  goToTask(ref, open) {
    const found = this.taskSpaces_(ref);
    if (found.length === 1) run("space.select", { id: found[0].id });
    else if (found.length > 1) {
      const key = String(ref ?? "").replace(/^#/, ""), kept = (shared("clickup.task-spaces") ?? this.taskSpaces)[key];
      openOverlay({ mod: "clickup", kind: "dialog", frame: "none", width: 460, height: Math.min(440, 90 + 46 * found.length),
        props: { choose: { ref, ids: found.map((s) => s.id), keptId: typeof kept === "string" ? kept : kept?.id ?? null, keptAt: kept?.at ?? null } } });
    } else open();
  }

  // START: the task's space (see goToTask), else a new space whose agent gets the START command.
  // The task's id there is its custom id (APP-1234), else ClickUp's own.
  startTask(ref, name, url) {
    const command = this.startCommand(ref, name, url);
    if (command) this.goToTask(ref, () => this.openSpace(ref, name, command));
  }

  // AI: the task's space (see goToTask), else a new space with Claude Code in it, which first reads
  // the task through ClickUp (all of it, current, with its comments) and then waits: context, not work.
  ai(ref, name, url) {
    const key = String(ref ?? "").replace(/^#/, "");
    this.goToTask(ref, () => this.openSpace(ref, name, `Read ClickUp task ${key}${url ? ` (${url})` : ""}: its description, comments and custom fields, `
      + "so you have its context. Then give me a short summary of what it asks for and wait for my instructions. Don't start any work yet."));
  }

  // What START or AI will do for a task, for their tooltips; `make` is what a new space would run.
  goTip(ref, make) {
    const key = String(ref ?? "").replace(/^#/, ""), found = this.taskSpaces_(ref);
    return found.length > 1 ? `${key} is open in ${found.length} spaces: pick one`
      : found.length === 1 ? `Go to the space for ${key}: ${found[0].name}` : make(key);
  }

  startTip(ref, name, url) {
    return this.goTip(ref, () => `New space in ${this.folderLabel()} running ${this.startCommand(ref, name, url)}`);
  }

  // A pane's ClickUp button asks this panel to open a task: shared "clickup.open" {ref, block, at}.
  // Only the copy in that block answers, once per ask, and only to a recent one, so an old ask doesn't
  // reopen a task when the panel next starts.
  answer(cx) {
    const ask = shared("clickup.open");
    if (!ask || ask.block !== this.block || this.tabTask || !ask.ref) return;
    if (ask.at <= (this.answered ?? 0) || Date.now() - ask.at > ASK_MS) return;
    this.answered = ask.at;
    const ref = String(ask.ref);
    const known = this.tasks.find((x) => x.ref.toLowerCase() === ref.toLowerCase());
    this.openTask(known?.id ?? ref.toUpperCase(), cx);
  }

  // ---- the space picker (a dialog: props {choose: {ref, ids, keptId, keptAt}}) ----
  // When each space was opened: its oldest terminal's start, from herdr-core (`hc get`), or when
  // this panel opened it, whichever is earlier.
  loadOpened(cx) {
    const c = this.choosing;
    cx.spawn(async (cx) => {
      for (const id of c.ids) {
        const s = spaces().find((x) => x.id === id);
        const tabs = new Set((s?.tabs ?? []).map((tb) => tb.id));
        let at = id === c.keptId && c.keptAt ? c.keptAt : Infinity;
        for (const p of panes().filter((p) => tabs.has(p.tab) && p.terminal)) {
          try {
            const r = await hc(["get", p.terminal, "--json"]);
            const ms = r.code === 0 ? Number(JSON.parse(r.stdout).created_ms) : NaN;
            if (Number.isFinite(ms) && ms > 0) at = Math.min(at, ms);
          } catch {}
        }
        this.opened[id] = Number.isFinite(at) ? at : null;
        cx.notify();
      }
    });
  }

  pick(id) {
    closeOverlay(props()?.overlay);
    if (spaces().some((s) => s.id === id)) run("space.select", { id }); // only shows it
  }

  chooser(t) {
    const c = this.choosing, key = String(c.ref ?? "").replace(/^#/, "");
    const list = c.ids.map((id) => spaces().find((s) => s.id === id)).filter(Boolean);
    const row = (s) => h_flex().id(`cu-pick-${s.id}`).h(40).flex_none().px(10).gap(10).items_center().cursor_pointer()
      .border_1().border_color(t.border).hover((x) => x.bg(t.hover).border_color(t.accent))
      .on_click(() => this.pick(s.id))
      .child(h_flex().size(18).flex_none().items_center().justify_center().border_1().border_color(t.accent)
        .text_size(10.5).font_bold().text_color(t.accent).child([...s.name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(s.active ? t.accent : t.foreground).child(s.name))
      .when(s.active, (e) => e.child(div().flex_none().text_size(10).font_bold().text_color(t.dim).child("SHOWING")))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(
        s.id in this.opened ? (this.opened[s.id] ? `opened ${ago(this.opened[s.id])}` : "opened —") : "…"));
    return v_flex().id("cu-chooser").size_full().p(16).gap(10).bg(t.popover).relative().border_1().border_color(t.accent)
      .children(reticle(t)).text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .children(title(t, key))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child("Esc to cancel")))
      .child(div().text_size(13).font_semibold().child(`${key} is open in ${list.length} spaces. Which one?`))
      .child(div().relative().flex_1().min_h(0).child(v_flex().id("cu-pick-list").absolute().inset_0().overflow_y_scroll().gap(6)
        .children(list.map(row))
        .when(list.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child("Those spaces have closed.")))));
  }

  // The task in a tab of its own, in the space that's showing; the panel goes back to the list.
  fullTab(cx) {
    const t = this.detail?.t, ref = t?.custom_id || (t ? `#${t.id}` : "Task");
    run("tab.new", { space: spaces().find((s) => s.active)?.id, name: ref, mod: "clickup", props: { task: this.openId, ref } });
    this.back(cx);
  }

  // The task (its description as markdown), its list's statuses, and its latest comments.
  loadTask(cx) {
    const id = this.openId;
    if (!id || this.detailBusy) return;
    this.detailBusy = true;
    cx.spawn(async (cx) => {
      try {
        this.key ??= await readKey();
        if (!this.key) { this.loaded = true; return; }
        // A task's number (APP-1234, from a pane's ClickUp button) is looked up in the workspace; from
        // then on the task goes by ClickUp's own id.
        const custom = CUSTOM_ID.test(id) ? `&custom_task_ids=true&team_id=${(await this.workspace()).id}` : "";
        const t = await call(this.key, `/task/${encodeURIComponent(id)}?include_markdown_description=true${custom}`);
        if (this.openId !== id) return;
        this.openId = t.id;
        const listId = t.list?.id;
        if (listId && !this.lists[listId]) this.lists[listId] = listStatuses(await call(this.key, `/list/${listId}`));
        const c = (await call(this.key, `/task/${encodeURIComponent(t.id)}/comment`)).comments ?? [];
        if (this.openId !== t.id) return;
        const replies = this.detail?.t.id === t.id ? this.detail.replies : {};
        this.detail = { t, statuses: this.lists[listId] ?? [], comments: chronological(c.map(comment)), more: c.length >= PAGE_COMMENTS, replies };
        this.detailError = null;
      } catch (e) {
        const gone = e?.status === 401 && this.key && await this.badToken();
        if (gone) { this.key = null; this.keyNote = "ClickUp turned down the saved token. Paste a new one."; }
        else if (this.openId === id) this.detailError = e?.status === 401 || e?.status === 404 ? `${id} isn't a task this token can see (${e.message})` : String(e?.message ?? e);
      } finally {
        this.loaded = true;
        this.detailBusy = false;
        cx.notify();
      }
    });
  }

  // A comment's thread, opened (and closed) from its "replies" link.
  toggleReplies(c, cx) {
    const d = this.detail;
    if (!d) return;
    if (d.replies[c.id]) { delete d.replies[c.id]; cx.notify(); return; }
    d.replies[c.id] = "loading";
    cx.spawn(async (cx) => {
      try {
        const r = (await call(this.key, `/comment/${encodeURIComponent(c.id)}/reply`)).comments ?? [];
        if (this.detail === d) d.replies[c.id] = chronological(r.map(comment));
      } catch (e) {
        if (this.detail === d) d.replies[c.id] = { error: String(e?.message ?? e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  // Posts the comment box to the task.
  post(cx) {
    const text = (this.draft ?? "").trim(), id = this.openId;
    if (!text || !id || this.posting) return;
    this.posting = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await call(this.key, `/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: { comment_text: text, notify_all: false } });
        if (this.openId === id) {
          this.composer.set_value("");
          this.draft = "";
          this.note = { text: "Comment posted." };
          this.loadTask(cx);
        }
      } catch (e) {
        if (this.openId === id) this.note = { text: `The comment didn't post: ${e?.message ?? e}`, error: true };
      } finally {
        this.posting = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Moves the task to the confirmed status, then shows ClickUp's answer here and in the list.
  move(cx) {
    const s = this.pending, id = this.openId;
    if (!s || !id || this.moving) return;
    this.moving = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const t = await call(this.key, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: { status: s.name } });
        if (this.detail && this.openId === id && t?.status) this.detail.t.status = t.status;
        const row = this.tasks.find((x) => x.id === id);
        if (row && t) Object.assign(row, task(t));
        this.note = { text: `Moved to ${s.name}.` };
        this.pending = null;
        this.picking = false;
        this.last = 0;
      } catch (e) {
        this.note = { text: `It didn't move: ${e?.message ?? e}`, error: true };
      } finally {
        this.moving = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // ---- pieces ----
  button(t, id, label, action, { primary = false, enabled = true, icon = null, tip = null, lit = false } = {}) {
    return h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().text_size(10).font_bold()
      .when(primary, (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!primary, (e) => e.border_1().border_color(lit ? t.accent : t.border).text_color(lit ? t.accent : enabled ? t.muted : t.dim))
      .when(enabled, (e) => e.cursor_pointer().hover((s) => primary ? s.bg(`${t.solid}cc`) : s.bg(t.hover).border_color(t.accent).text_color(t.accent))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(Boolean(icon), (e) => e.child(svg(icon).size(12)))
      .when(Boolean(label), (e) => e.child(label));
  }

  statusChip(t, s, { on = true, id, action = null, caret = false } = {}) {
    const c = s.color ?? t.muted;
    return h_flex().id(id).h(24).px(8).gap(6).flex_none().items_center().text_size(10).font_bold()
      .border_1().border_color(on ? c : t.border).when(on, (e) => e.bg(`${c}1f`)).text_color(on ? c : t.dim)
      .when(Boolean(action), (e) => e.cursor_pointer().hover((x) => x.border_color(c)).on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .child(div().size(6).flex_none().when(on, (e) => e.bg(c)).when(!on, (e) => e.border_1().border_color(t.dim)))
      .child(s.name.toUpperCase())
      .when(caret, (e) => e.child(div().text_color(t.dim).child(this.picking ? "▴" : "▾")));
  }

  // A status toggle for the list: on, in the status's own color; off, a dim outline.
  chip(t, s) {
    const on = !this.hidden.has(s.key);
    return this.statusChip(t, s, { on, id: `st-${s.key}`, action: (cx) => this.toggle(s.key, cx) })
      .tooltip(on ? `Hide ${s.name}` : `Show ${s.name}`)
      .child(div().text_color(on ? t.foreground : t.dim).child(String(s.count)));
  }

  row(t, x) {
    const d = due(x.due), flag = x.priority && x.priority !== "normal" ? x.priority : null;
    const flagColor = x.priority === "urgent" ? t.blocked : x.priority === "high" ? AMBER : t.dim;
    return v_flex().id(`task-${x.id}`).relative().h(46).flex_none().px(12).justify_center().gap(3).cursor_pointer()
      .border_b(1).border_color(t.border).hover((s) => s.bg(t.hover))
      .tooltip("Click: open here · ⌥-click: in a tab of its own")
      .on_hover((on, cx) => { this.hoveredRow = on ? x.id : this.hoveredRow === x.id ? null : this.hoveredRow; cx.notify(); })
      .on_click((e, cx) => {
        if (e.modifiers?.alt) run("tab.new", { space: spaces().find((s) => s.active)?.id, name: x.ref, mod: "clickup", props: { task: x.id, ref: x.ref } });
        else this.openTask(x.id, cx);
      })
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_size(11.5).font_bold().text_color(t.accent).child(x.ref))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(x.name)))
      .child(h_flex().gap(8).items_center().text_size(10.5)
        .when(x.subtask, (e) => e.child(div().flex_none().text_color(t.dim).child("SUBTASK")))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.list))
        .when(Boolean(flag), (e) => e.child(div().flex_none().font_bold().text_color(flagColor).child(flag.toUpperCase())))
        .when(Boolean(d), (e) => e.child(div().flex_none().font_bold().text_color(d.late ? t.blocked : d.soon ? AMBER : t.muted).child(d.text))))
      // Start the task, over the row's right end while it's hovered.
      .when(this.hoveredRow === x.id && Boolean(this.settings().start.trim()), (e) => e.child(h_flex().absolute().top(0).bottom(1).right(0).pl(10).pr(8).items_center().bg(t.hover).child(
        h_flex().id(`start-${x.id}`).h(26).px(8).gap(5).items_center().border_1().border_color(t.border)
          .text_size(10).font_bold().text_color(t.muted)
          .hover((s) => s.bg(t.raised).border_color(t.accent).text_color(t.accent))
          .tooltip(this.startTip(x.ref, x.name, x.url))
          .on_click((_e, cx) => { cx.stop_propagation(); this.startTask(x.ref, x.name, x.url); })
          .child(svg(START_ICON).size(11)).child("START"))));
  }

  keyForm(t) {
    return v_flex().p(14).gap(10).text_size(12.5).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child("Connect ClickUp"))
      .child(div().child("This panel lists the tasks assigned to you with a ClickUp personal API token. In ClickUp, open your avatar → Settings → Apps, generate an API token (it starts with pk_), and paste it here. It's checked with ClickUp, then kept in your ${keychain()}. It changes a task only when you post a comment or confirm a new status."))
      .child(div().id("cu-token-page").text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => this.browse("https://app.clickup.com/settings/apps")).child("Open ClickUp's Apps settings ↗"))
      .child(h_flex().gap(8)
        .child(div().id("cu-key").flex_1().min_w(0).h(32).px(10).flex().items_center().border_1().border_color(t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.keyInput).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("cu-save").h(32).px(14).flex().items_center().bg(t.solid).text_color(t.solid_foreground)
          .cursor_pointer().on_click((_e, cx) => this.saveKey(cx)).child(this.saving ? "Checking…" : "Save")))
      .when(Boolean(this.keyNote), (el) => el.child(div().text_color(t.ansi1).child(this.keyNote)));
  }

  gear(t) {
    return div().id("cu-gear").p(3).text_color(t.dim).hover((s) => s.text_color(t.accent)).tooltip("Settings")
      .on_click((_e, cx) => { cx.stop_propagation(); this.settingsOpen = true; cx.notify(); }).child(svg(GEAR_ICON).size(13));
  }

  scroller(id, content) {
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().child(content))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  commentCard(t, c, nested = false) {
    const thread = this.detail?.replies[c.id];
    return v_flex().gap(6).p(10).border_1().border_color(t.border).bg(nested ? t.surface : t.background).when(nested, (e) => e.ml(14))
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().font_bold().text_color(c.color ?? t.muted).child(c.who))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(ago(c.at))))
      .child(c.text ? TextView.markdown(`cu-cm-${c.id}`, lines(c.text)).selectable(true).text_size(12.5).text_color(t.foreground) : div().text_color(t.dim).child("(no text)"))
      .when(!nested && c.replies > 0, (e) => e.child(div().id(`cu-rep-${c.id}`).text_size(11).font_bold().text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggleReplies(c, cx))
        .child(thread ? "Hide replies" : `${c.replies} repl${c.replies === 1 ? "y" : "ies"} ▸`)))
      .when(thread === "loading", (e) => e.child(div().text_size(11).text_color(t.dim).child("Loading replies…")))
      .when(Boolean(thread?.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`Couldn't load the replies: ${thread.error}`)))
      .when(Array.isArray(thread), (e) => e.children(thread.map((r) => this.commentCard(t, r, true))));
  }

  detailView(t) {
    const d = this.detail, x = d?.t;
    const ref = x?.custom_id || (x ? `#${x.id}` : this.tabTask?.ref ?? (CUSTOM_ID.test(this.openId ?? "") ? this.openId : "TASK"));
    const key = ref.replace(/^#/, ""), open = x ? this.taskSpaces_(ref).length : 0, wide = (this.width ?? WIDE) >= WIDE;
    const header = h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .when(!this.tabTask, (e) => e.child(this.button(t, "cu-back", "◂", (cx) => this.back(cx), { tip: "Back to your tasks" })))
      .child(h_flex().pl(4).gap(6).items_center().children(title(t, ref)))
      .child(div().flex_1())
      .when(Boolean(x), (e) => e.child(this.button(t, "cu-ai", wide ? "AI" : "", () => this.ai(ref, x.name ?? "", x.url), { icon: AI_ICON, lit: open > 0,
        tip: this.goTip(ref, () => `${this.settings().agent} in a new space in ${this.folderLabel()}, reading ${key} first`) })))
      .when(Boolean(x) && Boolean(this.settings().start.trim()), (e) => e.child(this.button(t, "cu-start", wide ? "START" : "", () => this.startTask(ref, x.name ?? "", x.url),
        { primary: true, icon: START_ICON, tip: this.startTip(ref, x.name ?? "", x.url) })))
      .when(!this.tabTask && Boolean(x), (e) => e.child(this.button(t, "cu-full", wide ? "FULL TAB" : "", (cx) => this.fullTab(cx), { icon: wide ? null : TAB_ICON, tip: "Open in a tab of its own" })))
      .when(Boolean(x), (e) => e.child(this.button(t, "cu-web", "↗", () => this.browse(x.url), { tip: "Open in ClickUp" })))
      .child(this.button(t, "cu-reload", this.detailBusy ? "…" : "", (cx) => this.loadTask(cx), { icon: CLOCK_ICON, tip: "Refresh" }));
    if (!d) return v_flex().size_full().min_h(0).child(header)
      .child(div().p(14).text_size(12.5).text_color(this.detailError ? t.ansi1 : t.muted).child(this.detailError ? `ClickUp: ${this.detailError}` : "Opening the task…"));

    const current = listStatuses({ statuses: [x.status] })[0] ?? { key: "?", name: "?", color: null };
    const dd = due(x.due_date ? Number(x.due_date) : null);
    const who = (x.assignees ?? []).map((a) => a.username).filter(Boolean);
    const p = x.priority?.priority, PRI = { urgent: t.blocked, high: AMBER, normal: t.accent, low: t.muted };
    const priority = p ? { name: p, color: /^#[0-9a-f]{6}$/i.test(x.priority.color ?? "") ? x.priority.color : PRI[p] ?? t.muted } : null;
    const named = this.settings().fields.split(",").map((f) => f.trim()).filter(Boolean);
    const fieldNames = named.length ? named : setFields(x);
    const field = (label, list) => h_flex().gap(8).items_center()
      .child(div().text_size(10.5).font_bold().text_color(t.dim).child(label)).children(list);
    const chips = (id, list) => list.length
      ? list.map((o, i) => this.statusChip(t, o, { id: `${id}-${i}` }))
      : [this.statusChip(t, { name: "not set" }, { id: `${id}-none`, on: false })];
    const body = v_flex().p(14).gap(12)
      .child(div().text_size(16).font_bold().text_color(t.foreground).child(x.name))
      .child(h_flex().flex_wrap().gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().text_color(t.muted).child(x.list?.name ?? ""))
        .when(Boolean(dd), (e) => e.child(div().font_bold().text_color(dd.late ? t.blocked : dd.soon ? AMBER : t.muted).child(`DUE ${dd.text.toUpperCase()}`)))
        .when(who.length > 0, (e) => e.child(div().child(who.join(", "))))
        .when(Boolean(x.creator?.username), (e) => e.child(div().child(`opened by ${x.creator.username} ${ago(Number(x.date_created ?? 0))}`))))
      // Status, priority and custom fields, as chips in their ClickUp colors (an unset one as a dim
      // outline): the fields named in settings, else every drop-down or label field that's set.
      // The status opens a picker of the list's statuses; a pick asks first.
      .child(h_flex().flex_wrap().gap(10).items_center()
        .child(field("STATUS", [this.statusChip(t, current, { id: "cu-status", caret: d.statuses.length > 0, action: d.statuses.length ? (cx) => { this.picking = !this.picking; this.pending = null; cx.notify(); } : null })]))
        .child(field("PRIORITY", chips("cu-pri", priority ? [priority] : [])))
        .children(fieldNames.map((n, i) => field(n.toUpperCase(), chips(`cu-f${i}`, picked(x, n))))))
      .when(this.picking && !this.pending, (e) => e.child(h_flex().flex_wrap().gap(6)
        .children(d.statuses.filter((s) => s.key !== current.key).map((s) => this.statusChip(t, s, { id: `cu-to-${s.key}`, action: (cx) => { this.pending = s; cx.notify(); } })))))
      .when(Boolean(this.pending), (e) => e.child(v_flex().gap(8).p(10).bg(`${t.solid}14`).border_1().border_color(t.solid)
        .child(div().text_size(12.5).font_bold().text_color(t.foreground).child(`Move ${ref} from ${current.name} to ${this.pending.name}?`))
        .child(div().text_size(11).text_color(t.dim).child("ClickUp may notify the people on this task."))
        .child(h_flex().gap(8).justify_end()
          .child(this.button(t, "cu-move-cancel", "CANCEL", (cx) => { this.pending = null; cx.notify(); }))
          .child(this.button(t, "cu-move", this.moving ? "MOVING…" : "MOVE", (cx) => this.move(cx), { primary: true, enabled: !this.moving })))))
      .child(section(t, "DESCRIPTION"))
      .child((x.markdown_description || x.text_content || "").trim()
        ? TextView.markdown(`cu-desc-${x.id}`, (x.markdown_description || lines(x.text_content)).trim()).selectable(true).text_size(13).text_color(t.foreground)
        : div().text_size(12.5).text_color(t.dim).child("No description."))
      .child(section(t, "COMMENTS", d.comments.length ? d.comments.length : "none yet"))
      .when(d.more, (e) => e.child(div().text_size(11).text_color(t.dim).child(`The latest ${PAGE_COMMENTS}. Older ones are on ClickUp.`)))
      .children(d.comments.map((c) => this.commentCard(t, c)));

    const canPost = Boolean(this.draft?.trim()) && !this.posting;
    return v_flex().size_full().min_h(0)
      .child(header)
      .child(this.scroller(`cu-task-${x.id}`, body))
      .when(Boolean(this.note || this.detailError), (e) => e.child(div().px(12).py(6).flex_none().border_t(1).border_color(t.border).text_size(11)
        .text_color(this.note?.error || (!this.note && this.detailError) ? t.ansi1 : t.ansi2).child(this.note?.text ?? `ClickUp: ${this.detailError}`)))
      // The comment box stays at the bottom, like a chat.
      .child(v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("cu-composer").p(8).min_h(70).border_1().border_color(this.typing ? t.accent : t.border).bg(t.surface).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.composer).w_full().text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child(`Posts to ${ref} on ClickUp.`))
          .child(this.button(t, "cu-post", this.posting ? "POSTING…" : "COMMENT", (cx) => this.post(cx), { primary: true, enabled: canPost }))));
  }

  // ⚙: where new task spaces open, the agent, the START command and the fields shown as chips.
  settingsView(t) {
    const s = this.settings();
    const field = (k, label, note) => v_flex().gap(6)
      .child(div().text_size(11).font_bold().text_color(t.accent).child(label))
      .child(div().id(`cu-set-${k}`).h(30).px(8).flex().items_center().border_1().border_color(t.input).bg(t.background)
        .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.inputs[k]).w_full().text_size(12).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.dim).child(note));
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(GEAR_ICON).size(14).text_color(t.muted)).children(title(t, "CLICKUP SETTINGS"))
      .child(div().flex_1())
      .child(this.button(t, "cu-set-done", "DONE", (cx) => { this.settingsOpen = false; cx.notify(); }, { primary: true }));
    const body = v_flex().p(14).gap(16)
      .child(div().text_size(12).text_color(t.muted).child("AI and START open a space for a task, named after it, with an agent in it. AI has the agent read the task and wait; START sends it a command of yours. A task with a space already goes to that space and sends nothing."))
      .child(field("folder", "NEW SPACES OPEN IN", `A folder (~ is your home). Blank: the folder of the space that's showing. Now: ${this.folderLabel()}.`))
      .child(field("agent", "AGENT", "The program to start in them, with any arguments. Blank: claude."))
      .child(field("start", "START SENDS", s.start.trim()
        ? "{id} is the task's number, {url} its link, {name} its name; with none of them, the number goes at the end."
        : "Blank: no START button. For example a slash command, \"/my-plugin:start-task {id}\"."))
      .child(field("fields", "FIELDS SHOWN", "Custom fields shown as chips on a task, by name, comma-separated. Blank: every drop-down or label field that's set."));
    return v_flex().size_full().min_h(0).child(header).child(this.scroller("cu-settings", body));
  }

  render(cx) {
    const t = theme();
    if (this.choosing) return this.chooser(t);
    this.remember(); // render runs when spaces change: a space just opened for a task shows up here
    this.answer(cx); // and when shared state does: a pane asking for a task
    if (!this.tabTask) {
      const shown = this.visible();
      if (shown && !this.wasShown) this.tick(cx, true); // catch up as soon as it's opened
      this.wasShown = shown;
    }

    const root = v_flex().id(this.tabTask ? `cu-tab-${this.tabTask.id}` : this.block).size_full().min_h(0).overflow_hidden().bg(t.background)
      .when(!this.tabTask, (e) => e.border_1().border_color(t.border)).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs((this.width ?? 0) - size.width) >= 1) { this.width = size.width; cx.notify(); } });
    if (this.settingsOpen) return root.child(this.settingsView(t));
    if (this.loaded && !this.key) {
      return root.child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON).size(14).text_color(t.muted))
        .children(title(t, "CLICKUP")).child(div().flex_1()).child(this.gear(t)))
        .child(this.keyForm(t));
    }
    if (this.openId) return root.child(this.detailView(t));

    const list = statuses(this.tasks);
    const showing = list.filter((s) => !this.hidden.has(s.key));
    const count = showing.reduce((n, s) => n + s.count, 0);
    const state = !this.loaded ? ["Connecting", t.dim] : this.error ? ["Error", t.ansi1] : ["Live", t.ansi2];

    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(ICON).size(14).text_color(t.muted))
      .children(title(t, "CLICKUP"))
      .child(div().flex_1())
      .when(Boolean(this.key && this.loaded), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${count} of ${this.tasks.length}`)))
      .child(div().size(6).bg(state[1])).child(div().text_size(10.5).text_color(t.dim).child(state[0]))
      .when(Boolean(this.key), (e) => e.child(div().id("cu-refresh").p(3).text_color(this.busy ? t.accent : t.dim).hover((s) => s.text_color(t.accent))
        .tooltip("Refresh").on_click((_e, cx) => this.tick(cx, true)).child(svg(CLOCK_ICON).size(13))))
      .child(this.gear(t));

    // The toggles: every status your tasks are in, in board order, plus ALL.
    const toggles = h_flex().flex_none().flex_wrap().gap(6).px(12).py(10).border_b(1).border_color(t.border)
      .child(h_flex().id("st-all").h(24).px(8).flex_none().items_center().cursor_pointer().text_size(10).font_bold()
        .border_1().border_color(this.hidden.size ? t.border : t.accent).text_color(this.hidden.size ? t.muted : t.accent)
        .hover((x) => x.border_color(t.accent)).tooltip("Show every status").on_click((_e, cx) => this.showAll(cx)).child("ALL"))
      .children(list.map((s) => this.chip(t, s)));

    const rows = [];
    for (const s of showing) {
      const c = s.color ?? t.muted;
      rows.push(h_flex().id(`group-${s.key}`).h(28).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().size(7).flex_none().bg(c))
        .child(face(t, s.name.toUpperCase(), c, 7.5))
        .child(div().text_size(10.5).text_color(t.dim).child(String(s.count))));
      for (const x of sorted(this.tasks.filter((x) => x.status.key === s.key))) rows.push(this.row(t, x));
    }
    const empty = !this.loaded ? "Reading your ClickUp tasks…"
      : this.error && !this.tasks.length ? `ClickUp: ${this.error}`
      : !this.tasks.length ? "Nothing is assigned to you."
      : "Every status is turned off. Turn one on above, or press ALL.";

    return root
      .child(header)
      .when(this.tasks.length > 0, (e) => e.child(toggles))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${this.block}-list`).absolute().inset_0().overflow_y_scroll().children(rows)
          .when(!rows.length, (e) => e.child(div().p(14).text_size(12.5).text_color(t.muted).child(empty))))
        .child(Scrollbar.vertical(`${this.block}-list`).absolute().inset_0()))
      .when(Boolean(this.error && this.tasks.length), (e) => e.child(div().px(12).py(6).flex_none().text_size(11).text_color(t.ansi1).child(`ClickUp: ${this.error}`)))
      .when(Boolean(this.limited), (e) => e.child(div().px(12).py(6).flex_none().text_size(11).text_color(t.dim).child(`Showing the first ${MAX_PAGES * 100} tasks.`)));
  }
}
