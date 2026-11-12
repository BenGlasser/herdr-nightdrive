// Nightdrive's PR review: one pull request, opened from the PR list (nightdrive-prs) in a tab of
// its own, or beside the agent in the list's place (props.beside). See openTab / openBeside in prs.js.
//   props: {url, agent?: the agent's pane, terminal?: its terminal, beside?, view?: "overview" | "files" | "checks"}
// Beside the agent, ◂ PRS brings the list back (CLOSE when it came from the side panel's list)
// and FULL TAB moves it to its own tab; in a tab,
// BESIDE AGENT moves it back next to the agent.
// A header with its checks as a strip (ciLayer in prs.js), then Overview (description,
// conversation, a comment box), Files (each file's diff, read only) and Checks, and a merge bar
// that asks before it merges. Reads through gh's GraphQL; comments, merges and branch deletes go
// through gh's REST calls. Nothing is sent until you press a button.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, props, run, settings, setShared, shared, spaces, theme } from "herdr";
import { DISPLAY } from "./nightdrive.js";
import { parseUrl, repoLabel, gh, graphql, rollup, ciState, ciLayer, ago, AMBER, openBeside, openTab, backToList, closeBeside, agentPaneOf } from "./prs.js";

const TICK_MS = 15000;   // while checks run or GitHub is still working out mergeability
const IDLE_MS = 45000;
const DELETE_KEY = "nightdrive-pr.delete-branch";
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod defaultBranchRef { name }
    pullRequest(number: $number) {
      number title url state isDraft body createdAt updatedAt mergedAt closedAt
      author { login } mergedBy { login } baseRefName headRefName headRefOid isCrossRepository
      additions deletions changedFiles mergeable mergeStateStatus reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl description }
      } } } } } }
      comments(last: 100) { nodes { author { login } body createdAt } }
      reviews(last: 50) { nodes { author { login } state body submittedAt comments { totalCount } } }
    }
  }
}`;
// [GitHub's name, the repo setting that allows it, the button, what the confirmation says]
const METHODS = [["SQUASH", "squashMergeAllowed", "Squash", "Squash and merge"], ["MERGE", "mergeCommitAllowed", "Merge commit", "Merge"], ["REBASE", "rebaseMergeAllowed", "Rebase", "Rebase and merge"]];
const MERGE_STATE = {
  CLEAN: ["Ready to merge", "done"], HAS_HOOKS: ["Ready to merge", "done"],
  UNSTABLE: ["Some checks aren't passing", "blocked"], BLOCKED: ["Blocked by the branch's rules", "blocked"],
  BEHIND: ["Behind its base branch", "ansi3"], DIRTY: ["Conflicts with its base branch", "blocked"],
  DRAFT: ["Draft: mark it ready on GitHub to merge", "muted"], UNKNOWN: ["GitHub is still checking whether it can merge…", "dim"],
};
const REVIEW_TAG = { APPROVED: ["APPROVED", "done"], CHANGES_REQUESTED: ["CHANGES REQUESTED", "blocked"], COMMENTED: ["COMMENTED", "muted"], DISMISSED: ["DISMISSED", "dim"], PENDING: ["PENDING", "dim"] };

// One word per check: success, running, failure, or skipped (neutral, skipped, stale).
function checks(pr) {
  return (rollup(pr)?.contexts?.nodes ?? []).map((c) => c.__typename === "CheckRun"
    ? {
      name: c.name, group: c.checkSuite?.workflowRun?.workflow?.name ?? null, url: c.detailsUrl,
      state: c.status !== "COMPLETED" ? "running" : ["SUCCESS"].includes(c.conclusion) ? "success" : ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(c.conclusion) ? "failure" : "skipped",
      word: (c.status !== "COMPLETED" ? c.status : c.conclusion ?? "").replace(/_/g, " "),
    }
    : {
      name: c.context, group: null, url: c.targetUrl, note: c.description,
      state: c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "running" : c.state === "FAILURE" || c.state === "ERROR" ? "failure" : "skipped",
      word: c.state ?? "",
    });
}

// A unified diff as rows, each numbered on its old and new side.
function diffRows(patch) {
  let a = 0, b = 0;
  return patch.replace(/\n$/, "").split("\n").map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { a = +m[1]; b = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = (line.slice(1) || " ").replace(/\t/g, "    ").slice(0, 4000);
    if (kind === "-") return { kind, a: a++, text };
    if (kind === "+") return { kind, b: b++, text };
    if (kind === "\\") return { kind, text: line.slice(2) };
    return { kind: " ", a: a++, b: b++, text };
  });
}

// GitHub's markdown, minus what a native view can't use: HTML comments (templates' markers).
const clean = (md) => (md ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();

export default class Pr extends View {
  init(p, cx) {
    const given = p ?? props() ?? {};
    this.u = parseUrl(given.url);
    this.agent = given.agent ?? null;
    this.terminal = given.terminal ?? null;
    this.beside = given.beside === true;
    this.list = given.list === true; // it took the PR list's place
    this.view = ["overview", "files", "checks"].includes(given.view) ? given.view : "overview";
    this.width = 900;
    this.files = null;
    this.rows = [];
    this.diffWidth = 0;
    this.last = 0;
    this.comment = TextareaState.new({ placeholder: "Leave a comment", rows: 4 });
    this.comment.on("change", (_e, cx) => {
      const had = Boolean(this.draft?.trim());
      this.draft = this.comment.value();
      if (had !== Boolean(this.draft.trim())) cx.notify();
    });
    this.comment.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.comment.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (!this.u) return;
    this.refresh(cx);
    cx.timer.every(TICK_MS, (cx) => {
      const waiting = ciState(this.pr) === "running" || this.pr?.mergeStateStatus === "UNKNOWN";
      if (Date.now() - this.last >= (waiting ? TICK_MS - 1000 : IDLE_MS)) this.refresh(cx);
    });
  }

  async fetch() {
    const d = await graphql(QUERY, { owner: this.u.owner, name: this.u.name, number: this.u.number });
    const repo = d.repository, pr = repo?.pullRequest;
    if (!pr) throw new Error("GitHub doesn't have this pull request, or you can't see it.");
    // The diff is out of date once the head moves.
    if (this.pr && this.pr.headRefOid !== pr.headRefOid) { this.files = null; this.rows = []; this.picked = null; }
    this.repo = repo;
    this.pr = pr;
    this.last = Date.now();
    const allowed = METHODS.filter(([, flag]) => repo[flag]).map(([m]) => m);
    if (!allowed.includes(this.method)) this.method = allowed.includes(repo.viewerDefaultMergeMethod) ? repo.viewerDefaultMergeMethod : allowed[0];
    if (this.view === "files" && !this.files) await this.fetchFiles();
  }

  refresh(cx) {
    if (this.loading || !this.u) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try { await this.fetch(); this.error = null; }
      catch (e) { this.error = String(e?.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async fetchFiles() {
    const { owner, name, number } = this.u;
    const r = await exec("gh", ["api", `repos/${owner}/${name}/pulls/${number}/files?per_page=100`, "--paginate",
      "--jq", ".[] | {filename, previous_filename, status, additions, deletions, patch}"], { timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^gh: /, ""));
    this.files = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (!this.files.some((f) => f.filename === this.picked)) this.pick(this.files[0]?.filename ?? null);
  }

  pick(path) {
    this.picked = path;
    const f = this.files?.find((x) => x.filename === path);
    this.rows = f?.patch ? diffRows(f.patch) : [];
    this.diffWidth = Math.max(300, ...this.rows.map((r) => r.text.length * 7 + 130));
  }

  show(view, cx) {
    this.view = view;
    if (view === "files" && !this.files && !this.filesLoading) {
      this.filesLoading = true;
      cx.spawn(async (cx) => {
        try { await this.fetchFiles(); this.filesError = null; }
        catch (e) { this.filesError = String(e?.message ?? e); }
        finally { this.filesLoading = false; cx.notify(); }
      });
    }
    cx.notify();
  }

  // Away from beside the agent: the PR list back in its place if it took the list's, else closed.
  back() {
    if (this.list) backToList(this.agent);
    else closeBeside(this.agent);
  }

  // From beside the agent to a tab of its own. Back first (its tab is the one showing), then
  // the new tab, so that's where you land.
  toTab() {
    this.back();
    openTab(this.u.url, this.agent, this.terminal);
  }

  // From its own tab to beside the agent; this tab closes.
  toBeside() {
    const mine = spaces().find((s) => s.active)?.tabs.find((c) => c.active)?.id;
    if (openBeside(this.u.url, this.agent) && mine) run("tab.close", { id: mine });
  }

  browse(url) { if (url) exec("open", [url]).catch(() => {}); }

  // Posts the comment box as a PR comment (the conversation, not a line of the diff).
  post(cx) {
    const body = (this.draft ?? "").trim();
    if (!body || this.busy) return;
    const { owner, name, number } = this.u;
    this.busy = "Posting…";
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await gh(["api", "-X", "POST", `repos/${owner}/${name}/issues/${number}/comments`, "-f", `body=${body}`]);
        this.comment.set_value("");
        this.draft = "";
        this.note = { text: "Comment posted." };
        await this.fetch();
      } catch (e) {
        this.note = { text: `The comment didn't post: ${e?.message ?? e}`, error: true };
      } finally {
        this.busy = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Merges with the head we showed (sha): if the agent pushed since, GitHub refuses (409) and
  // nothing merges. Then deletes the branch when asked and nothing else needs it.
  merge(cx) {
    const pr = this.pr, { owner, name, number } = this.u, method = this.method, del = Boolean(shared(DELETE_KEY));
    if (!pr || this.busy) return;
    this.confirming = false;
    this.busy = "Merging…";
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        await gh(["api", "-X", "PUT", `repos/${owner}/${name}/pulls/${number}/merge`, "-f", `merge_method=${method.toLowerCase()}`, "-f", `sha=${pr.headRefOid}`]);
        this.note = { text: del ? await this.deleteBranch(pr) : `Merged into ${pr.baseRefName}.` };
      } catch (e) {
        this.note = { text: `Not merged: ${e?.message ?? e}`, error: true };
      }
      try { await this.fetch(); } catch {}
      this.busy = null;
      cx.notify();
    });
    cx.notify();
  }

  async deleteBranch(pr) {
    const { owner, name } = this.u, head = pr.headRefName;
    if (pr.isCrossRepository) return `Merged into ${pr.baseRefName}. ${head} is in a fork, so it stays.`;
    if (head === this.repo?.defaultBranchRef?.name) return `Merged into ${pr.baseRefName}. ${head} is the default branch, so it stays.`;
    try {
      const d = await graphql("query($o: String!, $n: String!, $b: String!) { repository(owner: $o, name: $n) { pullRequests(baseRefName: $b, states: OPEN) { totalCount } } }", { o: owner, n: name, b: head });
      const n = d.repository.pullRequests.totalCount;
      // Deleting it would close the PRs based on it.
      if (n) return `Merged into ${pr.baseRefName}. Kept ${head}: ${n} open PR${n > 1 ? "s are" : " is"} based on it.`;
      await gh(["api", "-X", "DELETE", `repos/${owner}/${name}/git/refs/heads/${head.split("/").map(encodeURIComponent).join("/")}`]);
      return `Merged into ${pr.baseRefName} and deleted ${head}.`;
    } catch (e) {
      return `Merged into ${pr.baseRefName}, but ${head} wasn't deleted: ${e?.message ?? e}`;
    }
  }

  // ---- pieces ----
  button(t, id, label, action, { primary = false, enabled = true, icon = null } = {}) {
    return h_flex().id(id).h(28).px(10).gap(6).flex_none().items_center().text_size(10.5).font_bold()
      .when(primary, (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(enabled ? t.muted : t.dim))
      .when(enabled, (e) => e.cursor_pointer().hover((s) => primary ? s.bg(`${t.solid}cc`) : s.bg(t.hover).border_color(t.accent).text_color(t.accent))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .when(Boolean(icon), (e) => e.child(svg(icon).size(12)))
      .child(label);
  }

  scroller(id, content) {
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(id).absolute().inset_0().overflow_y_scroll().child(content))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  tag(t, text, color) {
    return div().flex_none().px(6).py(2).border_1().border_color(color).text_size(9.5).font_bold().text_color(color).child(text);
  }

  header(t) {
    const pr = this.pr, state = pr.state === "OPEN" ? ciState(pr) : null, list = checks(pr), w = this.width - 36;
    const n = (s) => list.filter((c) => c.state === s).length;
    const ci = !list.length ? "NO CHECKS"
      : state === "failure" ? `${n("failure")} FAILING · ${n("success")} PASSED`
      : state === "running" ? `CHECKS RUNNING · ${n("success") + n("failure") + n("skipped")} OF ${list.length} DONE`
      : `CHECKS PASSED · ${n("success")} PASSED${n("skipped") ? ` · ${n("skipped")} SKIPPED` : ""}`;
    const stateTag = pr.state === "MERGED" ? ["MERGED", "#a82fff"] : pr.state === "CLOSED" ? ["CLOSED", t.blocked] : pr.isDraft ? ["DRAFT", t.muted] : ["OPEN", t.done];
    const [mergeText, mergeColor] = pr.state === "MERGED" ? [`Merged ${ago(pr.mergedAt)}${pr.mergedBy ? ` by ${pr.mergedBy.login}` : ""}`, "dim"]
      : pr.state === "CLOSED" ? [`Closed ${ago(pr.closedAt)}`, "dim"] : MERGE_STATE[pr.mergeStateStatus] ?? [pr.mergeStateStatus, "dim"];
    const review = REVIEW_TAG[pr.reviewDecision === "REVIEW_REQUIRED" ? "PENDING" : pr.reviewDecision];
    return v_flex().flex_none().px(18).pt(14).pb(12).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().font_family(DISPLAY).text_size(8).text_color(t.solid).child(repoLabel(this.u.owner, this.u.name).toUpperCase()))
        .child(div().text_size(13).font_bold().text_color(t.accent).child(`#${pr.number}`))
        .child(this.tag(t, ...stateTag))
        .child(div().flex_1())
        .when(this.beside, (e) => e
          .child(this.button(t, "pr-back", this.list ? "◂ PRS" : "CLOSE", () => this.back()))
          .child(this.button(t, "pr-full", "FULL TAB", () => this.toTab())))
        .when(!this.beside && Boolean(agentPaneOf(this.agent)), (e) => e.child(this.button(t, "pr-beside", "BESIDE AGENT", () => this.toBeside(), { icon: "mods/nightdrive-pane/split-right.svg" })))
        .child(this.button(t, "pr-github", "GITHUB", () => this.browse(pr.url), { icon: "mods/nightdrive-chrome/monitor.svg" }))
        .child(this.button(t, "pr-refresh", this.loading ? "…" : "REFRESH", (cx) => this.refresh(cx))))
      .child(div().text_size(18).font_bold().text_color(t.foreground).child(pr.title))
      .child(h_flex().flex_wrap().gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().text_color(t.muted).child(pr.author?.login ?? "ghost"))
        .child("wants to merge")
        .child(div().px(5).py(1).bg(t.raised).text_color(t.foreground).child(pr.headRefName))
        .child("into")
        .child(div().px(5).py(1).bg(t.raised).text_color(t.foreground).child(pr.baseRefName))
        .child(div().text_color(t.ansi2).child(`+${pr.additions}`))
        .child(div().text_color(t.ansi1).child(`−${pr.deletions}`))
        .child(`${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"} · opened ${ago(pr.createdAt)}`))
      // The checks strip: the same row effects as the PR list.
      .child(h_flex().id("pr-checks-strip").relative().w_full().h(30).px(10).gap(10).items_center().border_1().border_color(t.border).cursor_pointer()
        .on_click((_e, cx) => this.show("checks", cx))
        .child(ciLayer(state, w, 30))
        .child(div().text_size(10.5).font_bold().text_color(state === "failure" ? t.blocked : state === "running" ? AMBER : state === "success" ? t.done : t.dim).child(ci))
        .child(div().text_color(t.border).child("/"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t[mergeColor] ?? t.dim).child(mergeText))
        .when(Boolean(review), (e) => e.child(div().mr(state === "failure" ? 84 : 0).child(this.tag(t, review[0], t[review[1]])))));
  }

  tabs(t) {
    const list = checks(this.pr);
    const item = (id, label) => {
      const on = this.view === id;
      return h_flex().id(`view-${id}`).relative().h_full().px(14).items_center().text_size(10.5).font_bold().cursor_pointer()
        .text_color(on ? t.accent : t.muted).when(on, (e) => e.bg(t.raised).child(div().absolute().left(0).right(0).bottom(0).h(2).bg(t.accent)))
        .hover((s) => s.text_color(on ? t.accent : t.foreground)).on_click((_e, cx) => this.show(id, cx)).child(label);
    };
    return h_flex().h(34).flex_none().border_b(1).border_color(t.border)
      .child(item("overview", "OVERVIEW"))
      .child(item("files", `FILES ${this.pr.changedFiles}`))
      .child(item("checks", `CHECKS ${list.length}`));
  }

  markdown(t, id, text) {
    return TextView.markdown(id, text).selectable(true).text_size(13).text_color(t.foreground);
  }

  overview(t) {
    const pr = this.pr;
    const items = [
      ...pr.comments.nodes.map((c) => ({ kind: "comment", who: c.author?.login ?? "ghost", at: c.createdAt, body: clean(c.body) })),
      ...pr.reviews.nodes.filter((r) => r.state !== "PENDING").map((r) => ({ kind: "review", who: r.author?.login ?? "ghost", at: r.submittedAt, body: clean(r.body), state: r.state, inline: r.comments.totalCount })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const body = clean(pr.body);
    const enabled = Boolean(this.draft?.trim()) && !this.busy;
    return v_flex().p(18).gap(14).max_w(980)
      .child(v_flex().p(14).gap(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().text_color(t.solid).child("//")).child(div().font_family(DISPLAY).text_size(8).text_color(t.accent).child("DESCRIPTION")))
        .child(body ? this.markdown(t, "pr-body", body) : div().text_color(t.dim).child("No description.")))
      .child(h_flex().gap(8).items_center().pt(4).child(div().text_color(t.solid).child("//")).child(div().font_family(DISPLAY).text_size(8).text_color(t.accent).child("CONVERSATION"))
        .child(div().text_size(11).text_color(t.dim).child(items.length ? `${items.length}` : "nothing yet")))
      .children(items.map((x, i) => {
        const tag = x.kind === "review" ? REVIEW_TAG[x.state] : null;
        return v_flex().gap(6).p(12).border_1().border_color(t.border).bg(t.background)
          .child(h_flex().gap(8).items_center().text_size(11.5)
            .child(div().font_bold().text_color(t.muted).child(x.who))
            .when(Boolean(tag), (e) => e.child(this.tag(t, tag[0], t[tag[1]])))
            .when(x.kind === "review" && x.inline > 0, (e) => e.child(div().text_color(t.dim).child(`${x.inline} inline comment${x.inline > 1 ? "s" : ""}`)))
            .child(div().flex_1())
            .child(div().text_color(t.dim).child(ago(x.at))))
          .when(Boolean(x.body), (e) => e.child(this.markdown(t, `pr-item-${i}`, x.body)));
      }))
      // The comment box: a comment on the PR's conversation.
      .child(v_flex().gap(8).pt(4)
        .child(div().id("pr-comment").p(8).min_h(96).border_1().border_color(this.typing ? t.accent : t.border).bg(t.surface).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Textarea.new(this.comment).w_full().text_size(13).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child("Posts to the PR's conversation on GitHub. Markdown works."))
          .child(this.button(t, "pr-post", this.busy === "Posting…" ? "POSTING…" : "COMMENT", (cx) => this.post(cx), { primary: true, enabled }))));
  }

  filesView(t) {
    if (this.filesError) return div().p(18).text_color(t.blocked).child(`Couldn't load the files: ${this.filesError}`);
    if (!this.files) return div().p(18).text_color(t.dim).child("Loading the files…");
    const file = this.files.find((f) => f.filename === this.picked);
    const mark = { added: ["A", t.ansi2], removed: ["D", t.ansi1], modified: ["M", AMBER], renamed: ["R", t.accent], copied: ["C", t.accent], changed: ["M", AMBER] };
    const list = v_flex().p(6).children(this.files.map((f) => {
      const parts = f.filename.split("/"), name = parts.pop(), [letter, color] = mark[f.status] ?? ["?", t.dim];
      // Two lines: the file's name, and its folder under it.
      return h_flex().id(`file-${f.filename}`).h(40).flex_none().px(8).gap(8).items_center().cursor_pointer()
        .when(this.picked === f.filename, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.pick(f.filename); cx.notify(); })
        .child(div().w(12).flex_none().text_size(11).font_bold().text_color(color).child(letter))
        .child(v_flex().flex_1().min_w(0)
          .child(div().w_full().truncate().text_size(12.5).text_color(t.foreground).child(name))
          .when(parts.length > 0, (e) => e.child(div().w_full().truncate().text_size(10.5).text_color(t.dim).child(parts.join("/")))))
        .when(f.additions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.additions}`)))
        .when(f.deletions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.deletions}`)));
    }));
    const diff = !file ? div().p(14).text_color(t.dim).child("Pick a file.")
      : !file.patch ? div().p(14).text_color(t.dim).child("GitHub sends no diff for this file (binary, or too big). Open it on GitHub to see it.")
      : div().size_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .child(div().id("pr-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("pr-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((r) => this.diffRow(t, r))).size_full())))
        .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0());
    return h_flex().flex_1().min_h(0)
      .child(div().w(Math.round(Math.min(320, Math.max(190, this.width * 0.36)))).flex_none().h_full().relative().border_r(1).border_color(t.border)
        .child(v_flex().id("pr-files").absolute().inset_0().overflow_y_scroll().child(list))
        .child(Scrollbar.vertical("pr-files").absolute().inset_0()))
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(Boolean(file), (e) => e.child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename))
          .child(div().text_color(t.ansi2).child(`+${file.additions}`)).child(div().text_color(t.ansi1).child(`−${file.deletions}`))))
        .child(div().flex_1().min_h(0).child(diff)));
  }

  diffRow(t, r) {
    if (r.kind === "@") return div().w_full().h(20).flex_none().px(12).flex().items_center().truncate().bg(t.raised).text_color(t.dim).child(r.text);
    if (r.kind === "\\") return div().w_full().h(20).flex_none().px(12).flex().items_center().text_color(t.dim).child(r.text);
    const num = (n) => div().w(46).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(20).flex_none().items_center()
      .when(r.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(num(r.a)).child(num(r.b))
      .child(div().w(16).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
      .child(div().flex_1().min_w(0).truncate().child(r.text));
  }

  checksView(t) {
    const list = checks(this.pr);
    const order = { failure: 0, running: 1, success: 2, skipped: 3 };
    const color = { failure: t.blocked, running: AMBER, success: t.done, skipped: t.dim };
    if (!list.length) return div().p(18).text_color(t.dim).child("No checks ran on the latest commit.");
    return v_flex().p(18).gap(0).max_w(980).children([...list].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name)).map((c, i) =>
      h_flex().id(`check-${i}`).h(34).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
        .when(Boolean(c.url), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.browse(c.url)))
        .child(div().w(110).flex_none().text_size(10.5).font_bold().text_color(color[c.state]).child(c.word.toUpperCase()))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.group ? `${c.group} / ${c.name}` : c.name))
        .when(Boolean(c.note), (e) => e.child(div().max_w(280).truncate().text_size(11).text_color(t.dim).child(c.note)))));
  }

  mergeBar(t) {
    const pr = this.pr, del = Boolean(shared(DELETE_KEY)), label = METHODS.find(([m]) => m === this.method)?.[3] ?? "Merge";
    const blocked = pr.isDraft ? "Drafts can't merge." : pr.mergeable === "CONFLICTING" ? "Resolve the conflicts first." : null;
    if (this.confirming) {
      const state = ciState(pr), warn = [
        state === "failure" && "Checks are failing.",
        state === "running" && "Checks are still running.",
        pr.mergeStateStatus === "BEHIND" && `It's behind ${pr.baseRefName}.`,
        pr.mergeStateStatus === "BLOCKED" && "The branch's rules may refuse it.",
      ].filter(Boolean).join(" ");
      return h_flex().flex_none().px(18).py(10).gap(12).items_center().bg(`${t.solid}14`).border_t(1).border_color(t.solid)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12.5).font_bold().text_color(t.foreground).child(`${label} ${repoLabel(this.u.owner, this.u.name)} #${pr.number} into ${pr.baseRefName}?${del ? ` Then delete ${pr.headRefName}.` : ""}`))
          .when(Boolean(warn), (e) => e.child(div().text_size(11.5).text_color(AMBER).child(warn))))
        .child(this.button(t, "pr-cancel", "CANCEL", (cx) => { this.confirming = false; cx.notify(); }))
        .child(this.button(t, "pr-confirm", "CONFIRM MERGE", (cx) => this.merge(cx), { primary: true }));
    }
    const allowed = METHODS.filter(([, flag]) => this.repo?.[flag]);
    return h_flex().flex_none().px(18).py(10).gap(8).items_center().border_t(1).border_color(t.border)
      .children(allowed.map(([m, , name]) => {
        const on = this.method === m;
        return div().id(`method-${m}`).h(28).px(10).flex().items_center().text_size(10.5).font_bold().cursor_pointer()
          .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.accent : t.muted)
          .hover((s) => s.text_color(t.accent)).on_click((_e, cx) => { this.method = m; cx.notify(); }).child(name.toUpperCase());
      }))
      .child(h_flex().id("pr-delete-branch").ml(8).gap(6).items_center().cursor_pointer().text_size(10.5).font_bold().text_color(del ? t.foreground : t.muted)
        .on_click(() => setShared(DELETE_KEY, !del))
        .child(div().size(12).border_1().border_color(del ? t.accent : t.input).when(del, (e) => e.bg(t.accent)))
        .child("DELETE BRANCH"))
      .child(div().flex_1())
      .when(Boolean(blocked), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(blocked)))
      .child(this.button(t, "pr-merge", this.busy === "Merging…" ? "MERGING…" : "MERGE", (cx) => { this.confirming = true; this.note = null; cx.notify(); }, { primary: true, enabled: !blocked && !this.busy }));
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("pr").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.round(size.width) !== Math.round(this.width)) { this.width = size.width; cx.notify(); } });
    if (!this.u) return root.child(div().p(18).text_color(t.dim).child("No pull request: this tab needs props {url}."));
    if (!this.pr) return root.child(div().p(18).text_color(this.error ? t.blocked : t.dim).child(this.error ? `Couldn't load ${this.u.url}: ${this.error}` : `Loading ${repoLabel(this.u.owner, this.u.name)} #${this.u.number}…`));
    return root
      .child(this.header(t))
      .child(this.tabs(t))
      .child(this.view === "files" ? this.filesView(t) : this.scroller(`pr-${this.view}`, this.view === "checks" ? this.checksView(t) : this.overview(t)))
      .when(Boolean(this.note || this.error), (e) => e.child(div().flex_none().px(18).py(6).border_t(1).border_color(t.border).text_size(11.5)
        .text_color(this.note?.error || (!this.note && this.error) ? t.blocked : t.done).child(this.note?.text ?? `GitHub: ${this.error}`)))
      .when(this.pr.state === "OPEN", (e) => e.child(this.mergeBar(t)));
  }
}
