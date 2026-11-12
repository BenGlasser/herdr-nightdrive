// Which side panels each space shows. No Herdr imports, so it can be tried outside Herdr.
//
// Files, Changes and PRs belong to a space: each space remembers its own. The Dash, ClickUp, Standup and
// PostHog aren't about a space's code, so once opened they stay open in every space, in the slot
// they were opened in, until closed. Switching spaces then shows them over that space's own panel,
// and closing one gives each space its own panel back.

const EVERYWHERE = new Set(["dash", "clickup", "standup", "posthog-staging", "posthog-prod"]);
const SLOTS = ["top", "bottom"];

// Whether a panel id (top, or its "-b" twin below) stays open across spaces.
export const everywhere = (id) => Boolean(id) && EVERYWHERE.has(String(id).replace(/-b$/, ""));

// What a space shows when you switch to it: the panels open everywhere, else its own.
export function arrive(own, all) {
  return { top: all.top ?? own.top ?? null, bottom: all.bottom ?? own.bottom ?? null, web: Boolean(own.web) };
}

// The records after the panels shown in a space changed to `now`: the space's own panels and the
// ones open everywhere. Opening a space-wide panel over this space's own replaces it, as before;
// opening this space's own panel over a space-wide one closes that one everywhere.
export function note(now, own, all) {
  const next = { own: { top: own.top ?? null, bottom: own.bottom ?? null, web: Boolean(now.web) }, all: { top: all.top ?? null, bottom: all.bottom ?? null } };
  for (const slot of SLOTS) {
    const id = now[slot] ?? null;
    if (everywhere(id)) {
      if (next.all[slot] === id) continue;
      // Over this space's own panel (nothing space-wide was there): that panel is replaced.
      if (next.all[slot] === null) next.own[slot] = null;
      next.all[slot] = id;
    } else {
      next.all[slot] = null;
      next.own[slot] = id;
    }
  }
  return next;
}
