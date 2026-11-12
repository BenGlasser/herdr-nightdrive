// What the ClickUp panel shows, from ClickUp's own task JSON (GET /team/{id}/task). No Herdr or
// gpui imports, so it can be tried outside Herdr.

// Board order by status type: ClickUp's "unstarted" (ready, this week, …) sits between open and custom.
const TYPE_RANK = { open: 0, unstarted: 1, custom: 2, done: 3, closed: 4 };
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// One task, trimmed to what a row needs.
export function task(t) {
  const due = t.due_date ? Number(t.due_date) : null;
  return {
    id: t.id,
    ref: t.custom_id || `#${t.id}`,
    name: t.name ?? "",
    url: t.url ?? `https://app.clickup.com/t/${t.id}`,
    status: {
      key: String(t.status?.status ?? "no status").toLowerCase(),
      name: t.status?.status ?? "no status",
      color: /^#[0-9a-f]{6}$/i.test(t.status?.color ?? "") ? t.status.color : null,
      type: t.status?.type ?? "custom",
      order: Number(t.status?.orderindex ?? 999),
    },
    list: t.list?.name ?? "",
    priority: t.priority?.priority ?? null,
    priorityColor: /^#[0-9a-f]{6}$/i.test(t.priority?.color ?? "") ? t.priority.color : null,
    due: Number.isFinite(due) ? due : null,
    updated: Number(t.date_updated ?? 0),
    subtask: Boolean(t.parent),
  };
}

// The statuses the tasks are in, in board order: open first, then unstarted, custom, done and closed,
// each by its position on the board. The same name in several lists counts once.
export function statuses(tasks) {
  const by = new Map();
  for (const t of tasks) {
    const s = t.status, seen = by.get(s.key);
    if (!seen) by.set(s.key, { ...s, count: 1 });
    else { seen.count++; seen.order = Math.min(seen.order, s.order); seen.color ??= s.color; }
  }
  return [...by.values()].sort((a, b) =>
    (TYPE_RANK[a.type] ?? 2) - (TYPE_RANK[b.type] ?? 2) || a.order - b.order || a.name.localeCompare(b.name));
}

// Within a status: most urgent first, then the soonest due, then the most recently changed.
export function sorted(tasks) {
  return [...tasks].sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4)
    || (a.due ?? Infinity) - (b.due ?? Infinity)
    || b.updated - a.updated);
}

// A due date in words, and whether it's late: "today", "tomorrow", "3d late", "Nov 12".
export function due(ms, now = Date.now()) {
  if (ms == null) return null;
  const day = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(ms) - day(now)) / 86400000);
  if (days < 0) return { text: `${-days}d late`, late: true };
  if (days === 0) return { text: "today", late: false, soon: true };
  if (days === 1) return { text: "tomorrow", late: false, soon: true };
  const d = new Date(ms);
  return { text: `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getDate()}`, late: false };
}

// A list's statuses (GET /list/{id}), in board order, shaped like a task's status.
export function listStatuses(list) {
  return (list?.statuses ?? []).map((s) => ({
    key: String(s.status).toLowerCase(), name: s.status, type: s.type ?? "custom", order: Number(s.orderindex ?? 999),
    color: /^#[0-9a-f]{6}$/i.test(s.color ?? "") ? s.color : null,
  })).sort((a, b) => a.order - b.order);
}

// A comment (GET /task/{id}/comment or /comment/{id}/reply), trimmed to what a card needs.
export function comment(c) {
  return {
    id: c.id, who: c.user?.username ?? "someone", color: /^#[0-9a-f]{6}$/i.test(c.user?.color ?? "") ? c.user.color : null,
    at: Number(c.date ?? 0), text: (c.comment_text ?? "").trim(), replies: Number(c.reply_count ?? 0),
  };
}

// Oldest first, like a conversation; ClickUp's own order isn't promised.
export const chronological = (list) => [...list].sort((a, b) => a.at - b.at);

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

// Plain comment text as markdown that keeps its line breaks.
export const lines = (text) => text.replace(/\r/g, "").replace(/\n/g, "  \n");

// The option(s) chosen in a drop-down or labels custom field, by the field's name: [{name, color}],
// [] when it's unset or the task lacks the field. ClickUp gives a drop-down's value as the option's
// orderindex (or, newer, its id), and labels as a list of option ids.
export function picked(t, field) {
  const f = (t?.custom_fields ?? []).find((x) => String(x.name ?? "").toLowerCase() === field.toLowerCase());
  if (!f || f.value == null || f.value === "") return [];
  const options = f.type_config?.options ?? [];
  const one = (v) => options.find((o) => o.id === v)
    ?? (Number.isInteger(Number(v)) ? options.find((o) => Number(o.orderindex) === Number(v)) : undefined);
  return (Array.isArray(f.value) ? f.value : [f.value]).map(one).filter(Boolean)
    .map((o) => ({ name: String(o.name ?? o.label ?? ""), color: /^#[0-9a-f]{6}$/i.test(o.color ?? "") ? o.color : null }))
    .filter((o) => o.name);
}

// The names of a task's drop-down and label fields that have a value, in ClickUp's order.
export function setFields(t) {
  return (t?.custom_fields ?? []).filter((f) => ["drop_down", "labels"].includes(f.type) && picked(t, f.name ?? "").length).map((f) => f.name);
}
