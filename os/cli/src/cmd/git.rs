//! Git, as the app's Git page: the issues not merged yet, oldest first,
//! each as its box (number, name, where it lives, where it stands) and the
//! one command that does what comes next; `l3 issue REPO#N` is one box in
//! full with its Diff, Review and Reply. Then the steps: start, commit, push
//! (and reset), review, reply, merge, reject; diff and log to look.

use super::Ctx;
use crate::args::Call;
use crate::out::{self, ago, commits, files, issues, Error, Reply, Result};
use crate::spec::{Fact, On};
use crate::target::{self, IssueRef};
use length3_core::history::{self, state_word, Change, Work};
use length3_core::issues::{number, Issue};
use length3_core::{i18n::ja, text, tr, work};
use serde_json::{json, Value};

/// Where a repo stands, read once for all its issues. `known`: read from
/// the Remote just now; otherwise only the merges seen before are known.
struct Stand {
    known: bool,
    work: Option<Work>,
    lines: Vec<work::Line>,
    changes: Vec<Change>,
    merged: Vec<String>,
    uncommitted: usize,
}

fn stand(ctx: &Ctx, r: &length3_core::repos::Repos, repo: &str) -> Stand {
    let merged = history::merged_seen(repo);
    let empty = |known, merged| Stand { known, work: None, lines: Vec::new(), changes: Vec::new(), merged, uncommitted: 0 };
    // On no Remote there is no work to know of; one out of reach knows only the merges seen before.
    if !ctx.connected() { return empty(true, merged); }
    let Ok(changes) = history::changes_of_repo(repo) else { return empty(false, merged) };
    let w = history::work(r, repo).ok();
    let uncommitted = if w.as_ref().is_some_and(|w| w.line != work::MAIN) { history::changes(r, repo).map(|c| c.files).unwrap_or(0) } else { 0 };
    Stand { known: true, work: w, lines: work::lines(repo).unwrap_or_default(), merged: history::merged_seen(repo), changes, uncommitted }
}

fn path_of(i: &Issue) -> String { format!("issue/{}", i.file) }
fn first_line(i: &Issue) -> String { text::named(i.kind.as_deref(), &i.title) }
/// How a command names it: w1#3, or (no number yet) its first line.
fn me(i: &Issue) -> String { target::called(&i.repo, &i.file, &first_line(i)) }
/// "#3 Fix：title"; one without a number yet, its words alone.
fn heading(i: &Issue) -> String { i.n.map_or_else(|| first_line(i), |n| format!("#{n} {}", first_line(i))) }
/// A line of work as a person calls it: the number of its issue (#3), else its own name.
pub fn line_called(line: &str) -> String {
    let n = number(&format!("{line}.md"));
    if n.is_empty() { format!("\"{line}\"") } else { n }
}

/// Give the repo's issues without a number one (issues::numbering), as the
/// app does when it draws Git: only with the Remote known just now, on main's
/// copy, where issues are, whatever work the repo shows; one a work or a change
/// refers to keeps its name. Renamed, they are committed on main by themselves,
/// as every issue's file is. What was renamed, (old, new).
fn number_loose(ctx: &Ctx, r: &length3_core::repos::Repos, repo: &str, s: &Stand) -> Vec<(String, String)> {
    if ctx.prompt || !ctx.connected() || !s.known { return Vec::new(); }
    let in_use: Vec<String> = s.lines.iter().map(|l| l.issue.clone()).chain(s.changes.iter().map(|c| c.issue.clone())).collect();
    let done = r.on_main().number_issues(repo, &in_use).unwrap_or_default();
    if !done.is_empty() { let _ = history::settle_issues(r, repo); }
    done
}

impl Stand {
    fn change(&self, i: &Issue) -> Option<&Change> { self.changes.iter().find(|c| c.issue == path_of(i)) }
    /// Being worked on here, now.
    fn here(&self, i: &Issue) -> bool {
        self.work.as_ref().is_some_and(|w| w.line != work::MAIN && w.issue.as_deref() == Some(path_of(i).as_str()))
    }
    fn merged(&self, i: &Issue) -> bool {
        self.change(i).is_some_and(|c| c.state == "merged") || self.merged.contains(&path_of(i))
    }
    /// Still to do: neither merged nor closed (as the app's Git lays them out).
    fn open(&self, i: &Issue) -> bool { !self.merged(i) && i.closed.is_none() }
    /// Where it stands, as one word for data.
    fn state(&self, i: &Issue) -> &'static str {
        if self.merged(i) { return "merged"; }
        if i.closed.is_some() { return "closed"; }
        if !self.known { return "unknown"; }
        if self.here(i) { return "working"; }
        match self.change(i).map(|c| c.state.as_str()) {
            Some("open") => "undecided",
            Some("rejected") => "rejected",
            Some("reset") => "takenBack",
            _ if self.lines.iter().any(|l| l.issue == path_of(i)) => "started",
            _ => "notStarted",
        }
    }
}

/// Who started it and when, as the card's foot says; a decided change says how it ended.
fn standing(ctx: &Ctx, s: &Stand, i: &Issue) -> String {
    if ctx.prompt { return String::new(); }
    if s.merged(i) { return state_word("merged"); }
    if let Some(c) = &i.closed { return tr!("closed {}", "閉じた：{}", c); }
    if !s.known { return tr!("not known offline", "オフラインでは不明"); }
    let who = |by: &str, at: u64| tr!("{} · started {}", "{} · 開始 {}", if by.is_empty() { "—" } else { by }, ago(at));
    if let (true, Some(w)) = (s.here(i), s.work.as_ref()) { return who(&w.started_by, w.started_at); }
    if let Some(c) = s.change(i).filter(|c| c.state != "open") { return tr!("change · version {} · {}", "Change · 第{}版 · {}", c.version, state_word(&c.state)); }
    if s.change(i).is_some() { return String::new(); }
    match s.lines.iter().find(|l| l.issue == path_of(i)) {
        Some(l) => who(&l.started_by, l.started_at),
        None => tr!("not started", "未着手"),
    }
}

/// Where an issue stands, as what can be done with it: what its card's
/// next line is written from, and what the menu offers on it (spec.rs).
fn facts(ctx: &Ctx, s: &Stand, i: &Issue) -> Vec<Fact> {
    // Merged, it is done with: read only (no Close offered that the command would then refuse).
    if s.merged(i) { return vec![Fact::Merged]; }
    // Reopening is the file's own change: it needs no Remote.
    if i.closed.is_some() { return vec![Fact::Closed]; }
    if !ctx.connected() || !s.known { return Vec::new(); }
    let mut f = Vec::new();
    let change = s.change(i);
    let open = change.is_some_and(|c| c.state == "open");
    if !s.here(i) {
        f.push(Fact::CanStart);
    } else if let Some(w) = &s.work {
        f.push(Fact::WorkedHere);
        if s.uncommitted > 0 { f.push(Fact::CanCommit); }
        else if w.unpushed > 0 || (w.commits > 0 && !open) { f.push(Fact::CanPush); }
    }
    if let Some(c) = change.filter(|_| open) {
        f.push(Fact::Undecided);
        if !approvers(c).is_empty() { f.push(Fact::Approved); }
    }
    f
}

/// What can be done next, the one to do first first: as the box's buttons. Each is a line that runs as
/// it is pasted (bug: `[-m note]` came with it, and the shell took the brackets).
fn next(ctx: &Ctx, s: &Stand, i: &Issue) -> Vec<String> {
    if ctx.prompt { return vec![tr!("the app's Git page", "アプリの Git")]; }
    if s.merged(i) { return Vec::new(); }
    let m = me(i);
    let f = facts(ctx, s, i);
    let has = |x: Fact| f.contains(&x);
    if has(Fact::Closed) { return vec![format!("l3 issue reopen {m}")]; }
    if !ctx.connected() { return vec!["l3 login".into()]; }
    let mut out = Vec::new();
    if has(Fact::CanStart) { out.push(format!("l3 start {m}")); }
    if has(Fact::CanCommit) { out.push(format!("l3 commit {}", i.repo)); }
    if has(Fact::CanPush) { out.push(format!("l3 push {}", i.repo)); }
    // An undecided change, in the app's order: its Review (approve, or a comment more), then
    // Merge once this version is approved; Reject and Reset (taking it back) last.
    if has(Fact::Undecided) {
        let review = format!("l3 review {m} approve");
        let merge = format!("l3 merge {m}");
        if has(Fact::Approved) { out.push(merge); out.push(review); } else { out.push(review); out.push(merge); }
        out.push(format!("l3 reply {m} {}", crate::spec::placeholder("\"text\"")));
        out.push(format!("l3 reject {m}"));
        if has(Fact::WorkedHere) { out.push(format!("l3 reset {}", i.repo)); }
    }
    if has(Fact::WorkedHere) { out.push(format!("l3 main {}", i.repo)); }
    out
}

/// Whether all that is left to do on the issue here is to leave it: started, nothing changed or to push yet.
/// Its card says so as the way back, not as what comes next (the menu weighs Back to main last too).
fn only_leaving(ctx: &Ctx, s: &Stand, i: &Issue) -> bool {
    let f = facts(ctx, s, i);
    f.contains(&Fact::WorkedHere) && ![Fact::CanCommit, Fact::CanPush, Fact::Undecided].iter().any(|x| f.contains(x))
}

/// What can be done with the issue, each deed once: the menu's own (spec.rs), pressed on it here and now, the
/// button's word beside the line that does it, what it is for first and what leaves it last. Open is left
/// out: it is what is being read. `on_work`: the repo shows a work's copy, not main.
fn deeds(ctx: &Ctx, s: &Stand, i: &Issue, on_work: bool) -> Vec<(&'static str, String)> {
    let mut f = facts(ctx, s, i);
    if on_work { f.push(Fact::OnWork); }
    let thing = subject(ctx, s, i, f.clone());
    crate::menu::offered_here(ctx, crate::spec::Group::Git, On::Issue, &f).into_iter()
        .filter(|o| !(o.command.name == "issue" && o.form.verb.is_none()))
        .map(|o| (o.label(), crate::menu::deed_line(o, &thing))).collect()
}

/// The issue as a thing a deed is pressed on: its card's head and foot, and its facts.
fn subject(ctx: &Ctx, s: &Stand, i: &Issue, facts: Vec<Fact>) -> crate::menu::Subject {
    let st = standing(ctx, s, i);
    crate::menu::Subject { on: On::Issue, word: me(i), repo: Some(i.repo.clone()), label: heading(i),
        detail: if st.is_empty() { i.repo.clone() } else { format!("{} · {st}", i.repo) }, facts }
}

/// The issue as a thing on the page, for the menu: its card's head and foot, and its facts.
fn seen(ctx: &Ctx, r: &length3_core::repos::Repos, s: &Stand, i: &Issue) {
    crate::menu::see(|| {
        let mut f = facts(ctx, s, i);
        if r.line(&i.repo) != work::MAIN { f.push(Fact::OnWork); }
        subject(ctx, s, i, f)
    });
}

/// Who approved the current version, each once.
fn approvers(c: &Change) -> Vec<String> {
    let mut by: Vec<String> = Vec::new();
    for r in c.reviews.iter().filter(|r| r.version == c.version && r.verdict == "approve") {
        if !by.contains(&r.by) { by.push(r.by.clone()); }
    }
    by
}

fn version(c: &Change) -> String {
    tr!("change · version {} · {}", "Change · 第{}版 · {}", c.version, state_word(&c.state))
}

/// The box as the app's card shows it: the title; once worked on here (or
/// handed in), Commit and Push, ✓ once done and ○ until then, and what each
/// is about; at the foot, where it lives and who started it; then, on the Git
/// page, what comes next (in full, the deeds follow the Review: issue_show).
fn card(ctx: &Ctx, s: &Stand, i: &Issue, full: bool) -> Vec<String> {
    let mut t = vec![heading(i)];
    if full && !i.detail.is_empty() { for l in i.detail.lines() { t.push(format!("    {l}")); } }
    // ○ as the TODO and the Approve line mark what is not done yet (bug: a blank, and two loose words).
    let done = |yes: bool| if yes { "✓" } else { "○" };
    let change = s.change(i);
    if !ctx.prompt && s.open(i) {
        if let (true, Some(w)) = (s.here(i), s.work.as_ref()) {
            let committed = s.uncommitted == 0 && w.commits > 0;
            let pushed = w.commits > 0 && w.unpushed == 0 && change.is_some_and(|c| c.state == "open");
            // As the app's card: what is not committed; before the first commit, where the work is done.
            let what = if s.uncommitted > 0 { tr!("{} not committed", "未 Commit {}", files(s.uncommitted)) }
                else if w.commits == 0 { tr!("edit in {} (l3 prompt {0}, or l3 file write); what changes shows here", "{} で編集すると（l3 prompt {0} か l3 file write）、ここに出ます", i.repo) }
                else { String::new() };
            t.push(format!("    {} Commit  {what}", done(committed)).trim_end().to_string());
            let push = if pushed { change.map(version).unwrap_or_default() }
                else if w.unpushed > 0 { if ja() { format!("Push するコミット {}", w.unpushed) } else { format!("{} to push", commits(w.unpushed)) } }
                else { String::new() };
            t.push(format!("    {} Push    {push}", done(pushed)).trim_end().to_string());
        } else if let Some(c) = change.filter(|c| c.state == "open") {
            t.push(format!("    ✓ Commit  {}", if c.submitted_by.is_empty() { "—" } else { &c.submitted_by }));
            t.push(format!("    ✓ Push    {}", version(c)));
        }
    }
    let st = standing(ctx, s, i);
    t.push(format!("    {}{}", i.repo, if st.is_empty() { String::new() } else { format!(" · {st}") }));
    if !full {
        if let Some(first) = next(ctx, s, i).first() {
            t.push(if only_leaving(ctx, s, i) { tr!("    back: {}", "    戻る：{}", first) } else { tr!("    next: {}", "    次：{}", first) });
        }
    }
    t
}

/// The deeds under a card opened in full: a heading, then each deed's word, aligned, and the line that does it.
fn deed_block(list: &[(&str, String)]) -> Vec<String> {
    if list.is_empty() { return Vec::new(); }
    let cols = list.iter().map(|(w, _)| crate::help::width(w)).max().unwrap_or(0);
    let mut t = vec![String::new(), tr!("Next", "次")];
    for (w, line) in list { t.push(format!("    {}  {line}", crate::help::pad(w, cols))); }
    t
}

fn issue_json(ctx: &Ctx, s: &Stand, i: &Issue) -> Value {
    let c = s.change(i);
    let w = s.work.as_ref().filter(|_| s.here(i));
    json!({"repo": i.repo, "n": i.n, "file": i.file, "kind": i.kind, "title": i.title, "detail": i.detail,
        "state": s.state(i), "version": c.map(|c| c.version), "approvedBy": c.map(approvers).unwrap_or_default(),
        "startedBy": w.map(|w| w.started_by.clone()).or_else(|| s.lines.iter().find(|l| l.issue == path_of(i)).map(|l| l.started_by.clone())),
        "commits": w.map(|w| w.commits), "unpushed": w.map(|w| w.unpushed), "uncommitted": w.map(|_| s.uncommitted),
        "next": next(ctx, s, i)})
}

/// `l3 git [REPO]`: every issue not merged yet, oldest first, as boxes.
pub fn page(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let r = ctx.repos()?;
    // The repo named, or the one you are in; else every repo here.
    let names: Vec<String> = if call.word(0).is_some() || ctx.here.is_some() { vec![target::repo(ctx, call, 0)?] } else { r.list()?.into_iter().map(|s| s.name).collect() };
    let (mut boxes, mut data, mut merged, mut closed) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut offline = false;
    for n in &names {
        let s = stand(ctx, &r, n);
        // Issues are main's, whatever work the repo shows.
        let mut list = r.on_main().issues(n)?;
        if list.iter().any(|i| i.n.is_none()) && !number_loose(ctx, &r, n, &s).is_empty() { list = r.on_main().issues(n)?; }
        length3_core::issues::sort_oldest_first(&mut list);
        offline |= ctx.connected() && !s.known;
        let done = list.iter().filter(|i| s.merged(i)).count();
        if done > 0 { merged.push((n.clone(), done)); }
        let shut: Vec<String> = list.iter().filter(|i| !s.merged(i) && i.closed.is_some()).map(me).collect();
        if !shut.is_empty() { closed.push((n.clone(), shut)); }
        for i in list.iter().filter(|i| s.open(i)) {
            seen(ctx, &r, &s, i);
            boxes.push(card(ctx, &s, i, false).join("\n"));
            data.push(issue_json(ctx, &s, i));
        }
    }
    let mut t = boxes.join("\n\n");
    if boxes.is_empty() {
        t = if !merged.is_empty() || !closed.is_empty() { tr!("No open issues", "開いている Issue はありません") }
            else { tr!("No issues yet (l3 issue new [REPO] \"Fix：title\")", "Issue はまだありません（l3 issue new [REPO] \"Fix：件名\" で書けます）") };
    }
    for (n, k) in &merged { t += &format!("\n\n{}", tr!("{0} merged in {1} (l3 log {1})", "{1} で Merge 済み：{0}（l3 log {1}）", issues(*k), n)); }
    for (n, list) in &closed { t += &format!("\n\n{}", tr!("{0} closed in {1}: {2} (l3 issue reopen REPO#N)", "{1} で閉じた：{0}（{2}。もう一度開くには l3 issue reopen REPO#N）", issues(list.len()), n, list.join(" "))); }
    if offline { t += &format!("\n\n{}", tr!("The Remote could not be reached: where each issue stands is not known (merges seen before are)", "Remote に届きませんでした。各 Issue の状態は不明です（前に見た Merge はわかります）")); }
    Ok(Reply::data(t, json!({"issues": data, "merged": merged.iter().map(|(r, n)| json!({"repo": r, "count": n})).collect::<Vec<_>>(),
        "closed": closed.iter().map(|(r, l)| json!({"repo": r, "issues": l})).collect::<Vec<_>>(), "known": !offline})))
}

fn read_issue(ctx: &Ctx, at: &IssueRef) -> Result<Issue> {
    let c = ctx.repos()?.on_main().read(&at.repo, &at.path(), 256 * 1024)?;
    Ok(length3_core::issues::parse(&at.repo, &at.file, &c.text.ok_or_else(|| Error::Refused(tr!("{} is binary", "{} はバイナリです", at.name())))?))
}

/// `l3 issue REPO#N`: one box in full, then its Diff, Review and Reply.
pub fn issue_show(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let r = ctx.repos()?;
    let i = read_issue(ctx, &at)?;
    if ctx.prompt {
        let mut t = format!("{}    {}", heading(&i), i.repo);
        if !i.detail.is_empty() { t += &format!("\n\n{}", i.detail); }
        return Ok(Reply::data(t, json!({"issue": i})));
    }
    let s = stand(ctx, &r, &at.repo);
    seen(ctx, &r, &s, &i);
    let mut t = card(ctx, &s, &i, true);
    let mut uncommitted = Vec::new();
    // What is not committed, while it is worked on here (beside Commit in the app).
    if s.here(&i) && s.uncommitted > 0 {
        t.push(String::new());
        t.push(tr!("Not committed  {}", "未 Commit  {}", files(s.uncommitted)));
        for f in history::changes(&r, &at.repo)?.folders.iter().flat_map(|f| f.files.iter()) {
            t.push(format!("    {}  {}{}", word(f.status), f.path, counts(f.binary, f.added as usize, f.removed as usize)));
            uncommitted.push(json!({"path": f.path, "status": f.status, "added": f.added, "removed": f.removed, "binary": f.binary}));
        }
    }
    // The Review, once there is a change: its diff, what was said, the approvals. What can be done with
    // it is said once, in the deeds under it (bug: each command was said there, again here, and again under it).
    let change = s.change(&i).filter(|c| c.state != "reset");
    if let Some(c) = change {
        t.push(String::new());
        t.push(tr!("Review  {}", "Review  {}", files(c.files)));
        for f in history::change_diff(&at.repo, &c.id, 100_000).unwrap_or_default() {
            let (add, del) = (f.lines.iter().filter(|l| l.kind == "add").count(), f.lines.iter().filter(|l| l.kind == "del").count());
            t.push(format!("    {}  {}{}", word(f.status), f.path, counts(f.binary, add, del)));
        }
        // What was said, in order; an approval without words is the check below, not a line here.
        for rv in c.reviews.iter().rev().filter(|r| !(r.verdict == "approve" && r.note.is_empty())) {
            let of = if rv.version != c.version { tr!(" (version {}, older)", "（第{}版、古い版）", rv.version) } else { String::new() };
            let asked = match rv.verdict.as_str() { "changes" => tr!(" asked for changes", " 変更を依頼"), "approve" => tr!(" approved", " 承認"), _ => String::new() };
            t.push(format!("    {} · {}{asked}{of}{}{}", rv.by, ago(rv.time), tr!(": ", "："), rv.note));
        }
        let by = approvers(c);
        if c.state == "open" {
            t.push(if by.is_empty() { tr!("    ○ Approve", "    ○ 承認") } else { tr!("    ✓ Approved by {}", "    ✓ 承認：{}", by.join(", ")) });
        } else if c.state == "rejected" && !c.note.is_empty() {
            t.push(tr!("    rejected: {}", "    Reject の理由：{}", c.note));
        }
    }
    let list = deeds_here(ctx, &r, &s, &i);
    t.extend(deed_block(&list));
    if !list.is_empty() { crate::menu::deeds_said(); }
    let deeds: Vec<Value> = list.iter().map(|(w, line)| json!({"label": w, "command": line})).collect();
    Ok(Reply::data(t.join("\n"), json!({"issue": issue_json(ctx, &s, &i), "uncommitted": uncommitted, "change": change, "deeds": deeds})))
}

/// The issue's deeds, and Sign in first while this device is on no Remote (where it stands is not known
/// without one, and nothing but closing it can be done).
fn deeds_here(ctx: &Ctx, r: &length3_core::repos::Repos, s: &Stand, i: &Issue) -> Vec<(&'static str, String)> {
    if s.merged(i) { return Vec::new(); }
    let mut list = deeds(ctx, s, i, r.line(&i.repo) != work::MAIN);
    if !ctx.connected() && i.closed.is_none() {
        let sign_in = crate::menu::offered_here(ctx, crate::spec::Group::Git, On::Page, &[]).into_iter().find(|o| o.command.name == "login");
        if let Some(o) = sign_in { list.insert(0, (o.label(), "l3 login".to_string())); }
    }
    list
}

/// Words given for a line (an issue's, a commit's): the first line names it,
/// the lines after it are its detail, before -m's (as an issue's file is read back).
fn split_line<'a>(given: &'a str, note: &str) -> (&'a str, String) {
    let (first, more) = given.split_once('\n').unwrap_or((given, ""));
    (first, [more.trim(), note.trim()].into_iter().filter(|d| !d.is_empty()).collect::<Vec<_>>().join("\n"))
}

pub fn issue_new(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let (first, detail) = split_line(call.word(1).unwrap_or_default(), call.note());
    let (kind, title) = text::kind_of(first);
    if title.trim().is_empty() { return Err(Error::Usage(tr!("An issue needs a title: l3 issue new [REPO] \"Fix：title\"", "Issue には件名がいります：l3 issue new [REPO] \"Fix：件名\""))); }
    // On main, whatever work the repo shows, and committed there by itself at once (signed out, once signed in).
    let r = ctx.repos()?;
    let file = r.on_main().add_issue(&repo, kind.as_deref(), &title, &detail)?;
    // Committed signed in; offered to the agent either way (core tasks.rs). Never from a Prompt: the app's to do.
    let committed = !ctx.prompt && history::commit_issue(&r, &repo, &file, "new").unwrap_or(false);
    Ok(Reply::done(tr!("Wrote {}{} {}", "{}{} {} を書きました", repo, number(&file), text::named(kind.as_deref(), title.trim())),
        json!({"repo": repo, "file": file, "number": number(&file), "kind": kind, "title": title.trim(), "committed": committed})))
}

/// `l3 issue close REPO#N`: one that will not be done. Its file says so on its
/// last line ("Closed：2031-10-17 sora"), so the app, l3 and a Prompt agree;
/// it leaves the issues as a merged one does, and `l3 issue reopen` brings it back.
pub fn issue_close(ctx: &Ctx, call: &Call) -> Result<Reply> { set_closed(ctx, call, true) }
pub fn issue_reopen(ctx: &Ctx, call: &Call) -> Result<Reply> { set_closed(ctx, call, false) }

fn set_closed(ctx: &Ctx, call: &Call, close: bool) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let r = ctx.repos()?;
    // The issue is main's, whatever work the repo shows: closed or reopened there, and committed there by itself.
    let main = r.on_main();
    let text = main.read(&at.repo, &at.path(), 256 * 1024)?.text.ok_or_else(|| Error::Refused(tr!("{} is binary", "{} はバイナリです", at.name())))?;
    let i = length3_core::issues::parse(&at.repo, &at.file, &text);
    let s = stand(ctx, &r, &at.repo);
    if s.merged(&i) { return Err(Error::Refused(tr!("{} is merged already", "{} はもう Merge 済みです", at.name()))); }
    // Undecided, it is main's to take or not first, as the app's card offers no Close then.
    if close && s.change(&i).is_some_and(|c| c.state == "open") {
        return Err(Error::Refused(tr!("{0} has an undecided change; decide it first (l3 reject {0})", "{0} には未決の Change があります。先に決めてください（l3 reject {0}）", at.name())));
    }
    let data = |changed: bool| json!({"repo": at.repo, "n": length3_core::issues::number_of(&at.file), "file": at.file, "closed": close, "changed": changed});
    if close == i.closed.is_some() {
        let said = if close { tr!("{} is closed already", "{} はもう閉じています", at.name()) } else { tr!("{} is open", "{} は開いています", at.name()) };
        return Ok(Reply::done(said, data(false)));
    }
    let new = if close {
        let who = if ctx.connected() { length3_core::remote::account().ok().flatten().map(|a| a.name).unwrap_or_default() } else { String::new() };
        length3_core::issues::close_text(&text, format!("{} {who}", out::day(out::now_ms())).trim())
    } else { length3_core::issues::reopen_text(&text) };
    main.write(&at.repo, &at.path(), &new, 256 * 1024)?;
    if !ctx.prompt { let _ = history::commit_issue(&r, &at.repo, &at.file, if close { "close" } else { "reopen" }); }
    Ok(Reply::done(if close { tr!("Closed {0}; it will not be done (back with: l3 issue reopen {0})", "{0} を閉じました。やらないものです（戻すには l3 issue reopen {0}）", at.name()) }
        else { tr!("Reopened {}", "{} をもう一度開きました", at.name()) }, data(true)))
}

pub fn start(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let mut at = target::issue(ctx, call, 0)?;
    let r = ctx.repos()?;
    if read_issue(ctx, &at).is_ok_and(|i| i.closed.is_some()) {
        return Err(Error::Refused(tr!("{0} is closed; open it again first (l3 issue reopen {0})", "{0} は閉じています。先にもう一度開いてください（l3 issue reopen {0}）", at.name())));
    }
    // One without a number takes its number first, so its work is named by it (as Git would have done).
    if length3_core::issues::number_of(&at.file).is_none() {
        let s = stand(ctx, &r, &at.repo);
        if let Some((_, new)) = number_loose(ctx, &r, &at.repo, &s).into_iter().find(|(old, _)| *old == at.file) { at.file = new; }
    }
    let l = work::start(&r, &at.repo, &at.path())?;
    // Then the way on, and the way back (bug: only the way back was said, and the card's next was leaving).
    Ok(Reply::done(tr!("Working on {0} — {1} shows its copy now\n  edit in it (l3 prompt {1}, or l3 file write), then l3 commit {1} · back to main: l3 main {1}",
        "{0} を始めました。{1} はその写しを見せています\n  中で編集して（l3 prompt {1} か l3 file write）、l3 commit {1} · main に戻るには l3 main {1}", at.shown(), at.repo),
        json!({"repo": at.repo, "n": length3_core::issues::number_of(&at.file), "title": at.title, "file": at.file, "line": l})))
}

pub fn main(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let r = ctx.repos()?;
    let was = r.line(&repo);
    if was == work::MAIN { return Ok(Reply::done(tr!("{} shows main already", "{} はもう main を見せています", repo), json!({"repo": repo, "line": work::MAIN, "changed": false}))); }
    work::switch(&r, &repo, work::MAIN)?;
    let called = line_called(&was);
    let again = if called.starts_with('#') { format!("l3 start {repo}{called}") } else { format!("l3 start {called}") };
    Ok(Reply::done(tr!("{} shows main now (the work on {} waits: {})", "{} は main を見せています（{} の作業はそのまま：{}）", repo, called, again),
        json!({"repo": repo, "line": work::MAIN, "was": was, "changed": true})))
}

pub fn commit(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let r = ctx.repos()?;
    let title = call.word(1).unwrap_or_default().trim().to_string();
    let on = r.line(&repo);
    // Work on an issue commits under its name, as the app does; words given go in as its note.
    let folded = on != work::MAIN && !title.is_empty();
    let (line, note) = if folded {
        (String::new(), if call.note().is_empty() { title.clone() } else { format!("{title}\n\n{}", call.note()) })
    } else {
        // Named by its first line, as an issue is (bug: all of it went to the Remote as the title, which keeps one as given).
        let (first, note) = split_line(&title, call.note());
        (first.trim().to_string(), note)
    };
    if on == work::MAIN && text::kind_of(&line).1.trim().is_empty() {
        return Err(Error::Usage(tr!("On main a commit needs its subject, Kind：subject: l3 commit [REPO] \"Fix：title\" (on an issue it is named after the issue, and words given are its note: l3 start REPO#N)", "main では Commit の件名（種別：件名）が要ります：l3 commit [REPO] \"Fix：件名\"（Issue の作業では Issue の名前で、書いた言葉はメモに：l3 start REPO#N）")));
    }
    // Nothing changed: said of the repo it looked at (bug: "Nothing to commit", and no more).
    let nothing = tr!("Nothing to commit", "まだ Commit していない変更がありません");
    let c = history::cut(&r, &repo, None, &line, &note).map_err(|e| if e == nothing {
        Error::Refused(tr!("Nothing to commit in {}: nothing changed since the last commit", "{} には Commit するものがありません。前の Commit から何も変わっていません", repo))
    } else { Error::from(e) })?;
    let mut text = tr!("Committed {}  {} ({}{})", "Commit しました {}  {}（{}{}）", out::short(&c.id), history::line(&c), files(c.files), out::added_removed(c.added, c.removed));
    if folded { text += &tr!("\n  named after its issue; \"{}\" is its note", "\n  Issue の名前で Commit し、「{}」はメモにしました", title); }
    if let Some(v) = c.handed { text += &tr!("\n  handed to main as version {}", "\n  main に渡しました（第{}版）", v); }
    Ok(Reply::done(text, json!({"commit": c, "titleAsNote": folded})))
}

pub fn push(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let h = history::hand_in(&ctx.repos()?, &repo, call.note())?;
    let name = named_change(&h.change);
    let text = match &h.pushed {
        Some(head) => tr!("Pushed {}; handed {} to main as version {}", "{} を Push し、{} を main に渡しました（第{}版）", out::short(head), name, h.change.version),
        None if h.same() => tr!("Nothing new to push: version {} of {} is with main already", "Push する新しいものはありません。{1} の第{0}版はもう main にあります", h.change.version, name),
        None => tr!("Handed {} to main as version {}", "{} を main に渡しました（第{}版）", name, h.change.version),
    };
    Ok(Reply::done(text, json!({"pushed": h.pushed, "same": h.same(), "change": h.change})))
}

fn named_change(c: &Change) -> String {
    text::named(Some(c.kind.as_str()).filter(|k| !k.is_empty()), &c.title)
}

pub fn reset(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let c = history::reset(&ctx.repos()?, &repo)?;
    Ok(Reply::done(tr!("Took back {} (version {})", "{} を取り下げました（第{}版）", named_change(&c), c.version), json!({"change": c})))
}

/// The change handed in for an issue, or why there is none.
fn change_for(at: &IssueRef) -> Result<Change> {
    history::changes_of_repo(&at.repo)?.into_iter().find(|c| c.issue == at.path())
        .ok_or_else(|| Error::NotFound(tr!("{} has no change yet (l3 push {} hands it in, from its work)", "{} にはまだ Change がありません（作業から l3 push {} で渡します）", at.name(), at.repo)))
}

/// The issue's change, still to be decided: one decided already is said as the issue it is, and what then
/// (bug: "The change is merged already", of no change named).
fn undecided(at: &IssueRef) -> Result<Change> {
    let c = change_for(at)?;
    match c.state.as_str() {
        "open" => Ok(c),
        "merged" => Err(Error::Refused(tr!("{} is merged already (l3 log {} shows it)", "{} はもう Merge 済みです（l3 log {} で見られます）", at.name(), at.repo))),
        "rejected" => Err(Error::Refused(tr!("{}'s change was rejected; its next version is handed in from its work: l3 push {}", "{} の Change は Reject 済みです。次の版は作業から l3 push {} で渡します", at.name(), at.repo))),
        _ => Err(Error::Refused(tr!("{}'s change was taken back; its next version is handed in from its work: l3 push {}", "{} の Change は取り下げ済みです。次の版は作業から l3 push {} で渡します", at.name(), at.repo))),
    }
}

pub fn diff(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let files = if call.form.args.first() == Some(&crate::spec::Arg::Issue) {
        let at = target::issue(ctx, call, 0)?;
        let c = change_for(&at)?;
        history::change_diff(&at.repo, &c.id, 100_000)?
    } else {
        let repo = target::repo(ctx, call, 0)?;
        history::diff(&ctx.repos()?, &repo, 100_000)?
    };
    let mut t = Vec::new();
    if files.is_empty() { t.push(tr!("No changes", "変更はありません")); }
    for f in &files {
        let (add, del) = (f.lines.iter().filter(|l| l.kind == "add").count(), f.lines.iter().filter(|l| l.kind == "del").count());
        t.push(format!("{}  {}", f.path, counts(f.binary, add, del).trim_start()));
        for l in f.lines.iter().enumerate().filter(|(k, l)| !(*k == 0 && l.kind == "hunk")).map(|(_, l)| l) {
            let mark = match l.kind { "add" => '+', "del" => '-', _ => ' ' };
            let at = l.at.map(|n| n.to_string()).unwrap_or_default();
            t.push(if l.kind == "hunk" { format!("  {:>5}  …", "") } else { format!("  {at:>5} {mark} {}", l.text) });
        }
        if f.more > 0 { t.push(format!("  {}", out::lines_more(f.more))); }
        t.push(String::new());
    }
    Ok(Reply::data(t.join("\n"), json!(files)))
}

pub fn log(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let list = history::log(&ctx.repos()?, &repo, 50)?;
    let mut t = Vec::new();
    if list.is_empty() { t.push(tr!("No commits yet", "コミットはまだありません")); }
    // Two lines a commit, as the app's list has it: its line, then the facts quieter under it. The folders it
    // touched are in --json (bug: a third line, where the repo's own top read as a folder named after it).
    for c in &list {
        t.push(history::line(c));
        let issue = c.issue.as_deref().map(number).filter(|n| !n.is_empty()).map(|n| format!(" · {n}")).unwrap_or_default();
        let merged = if c.merged.is_some() { tr!(" · merge", " · Merge") } else { String::new() };
        t.push(format!("    {} · {} · {}{}{issue}{merged}", out::short(&c.id), ago(c.time), files(c.files), out::added_removed(c.added, c.removed)));
    }
    Ok(Reply::data(t.join("\n"), json!(list)))
}

pub fn review(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let verdict = call.word(1).unwrap_or_default();
    change_for(&at)?;
    let c = history::review(&at.repo, &at.line(), verdict, call.note(), &[])?;
    let name = named_change(&c);
    let text = if verdict == "approve" { tr!("Approved version {} of {}", "{1} の第{0}版を承認しました", c.version, name) } else { tr!("Asked for changes to version {} of {}", "{1} の第{0}版に直しを頼みました", c.version, name) };
    Ok(Reply::done(text, json!({"verdict": verdict, "change": c})))
}

pub fn reply(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let words = call.word(1).unwrap_or_default();
    if words.trim().is_empty() { return Err(Error::Usage(tr!("A reply needs words: l3 reply REPO#N \"text\"", "返信には本文がいります：l3 reply REPO#N \"本文\""))); }
    change_for(&at)?;
    let c = history::review(&at.repo, &at.line(), "comment", words, &[])?;
    Ok(Reply::done(tr!("Replied under {} (version {})", "{} に返信しました（第{}版）", named_change(&c), c.version), json!({"change": c})))
}

pub fn merge(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    undecided(&at)?;
    let c = history::merge_and_finish(&ctx.repos()?, &at.repo, &at.line())?;
    Ok(Reply::done(tr!("Merged {} into main (version {})", "{} を main に Merge しました（第{}版）", named_change(&c), c.version), json!({"change": c})))
}

pub fn reject(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    undecided(&at)?;
    let c = history::reject(&at.repo, &at.line(), call.note())?;
    let why = if call.note().trim().is_empty() { String::new() } else { tr!(": {}", "：{}", call.note().trim()) };
    Ok(Reply::done(tr!("Rejected {} (its issue stays open){}", "{} を Reject しました（Issue は開いたままです）{}", named_change(&c), why), json!({"change": c})))
}

fn word(status: &str) -> String {
    match status { "added" => tr!("added", "追加"), "removed" => tr!("removed", "削除"), _ => tr!("changed", "変更") }
}

fn counts(binary: bool, added: usize, removed: usize) -> String {
    if binary { tr!("  (binary)", "  （バイナリ）") } else { format!("  +{added} −{removed}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use length3_core::issues::parse;

    #[test]
    fn a_line_is_named_by_its_first_line_and_the_rest_is_its_note() {
        // `l3 commit "Fix：a\nwhy"`: the Remote takes a title as it is given, so the newline must not reach it.
        assert_eq!(split_line("Fix：a\nwhy\nmore\n", "-m's"), ("Fix：a", "why\nmore\n-m's".to_string()));
        assert_eq!(split_line("Fix：a", ""), ("Fix：a", String::new()));
        assert_eq!(split_line("Fix：a\n\n", " note "), ("Fix：a", "note".to_string()));
    }

    /// Where a repo stands, known just now: #1 merged, nothing else started.
    fn stand() -> Stand {
        Stand { known: true, work: None, lines: Vec::new(), changes: Vec::new(), merged: vec!["issue/001.md".into()], uncommitted: 0 }
    }

    #[test]
    fn a_closed_issue_leaves_the_issues_as_a_merged_one_does_and_says_how_it_comes_back() {
        let (ctx, s) = (Ctx::test(None, Vec::new()), stand());
        let closed = parse("r", "002.md", "Fix：x\n\nClosed：2031-10-07 sora\n");
        let open = parse("r", "003.md", "Fix：y\n");
        let merged_and_closed = parse("r", "001.md", "Fix：z\n\nClosed：2031-10-07 sora\n");
        assert!(!s.open(&closed) && s.open(&open) && !s.open(&merged_and_closed));
        assert_eq!([s.state(&closed), s.state(&open), s.state(&merged_and_closed)], ["closed", "notStarted", "merged"]);
        assert_eq!(next(&ctx, &s, &closed), ["l3 issue reopen r#2"]);
        assert_eq!(next(&ctx, &s, &merged_and_closed), Vec::<String>::new());
        assert!(standing(&ctx, &s, &closed).ends_with("2031-10-07 sora"));
    }

    /// The work on issue 001 here: so many commits, so many not pushed, so many files not committed.
    fn working(commits: usize, unpushed: usize, uncommitted: usize, change: Option<Change>) -> Stand {
        let work = Work { line: "001".into(), issue: Some("issue/001.md".into()), started_by: "sora".into(), started_at: 0, commits, unpushed, change: None };
        Stand { known: true, work: Some(work), lines: Vec::new(), changes: change.into_iter().collect(), merged: Vec::new(), uncommitted }
    }

    /// Issue 001's change, open or decided, approved by sora or not.
    fn change(state: &str, approved: bool) -> Change {
        let reviews = if approved { serde_json::json!([{"version": 1, "verdict": "approve", "by": "sora", "time": 0}]) } else { serde_json::json!([]) };
        serde_json::from_value(serde_json::json!({"id": "c1", "repo": "r", "line": "001", "issue": "issue/001.md", "kind": "Fix", "title": "x",
            "version": 1, "base": null, "head": "h", "state": state, "reviews": reviews})).expect("a change")
    }

    #[test]
    fn the_cards_next_line_and_the_menus_deeds_are_read_from_the_same_facts() {
        use crate::menu::{offered, Env};
        use crate::spec::{Group, Weight};
        let ctx = Ctx::test(None, Vec::new()).online();
        let i = parse("r", "001.md", "Fix：x\n");
        let not_here = stand_with_nothing();
        let handed_in = Stand { changes: vec![change("open", true)], ..stand_with_nothing() };
        let cases = [("not started", not_here), ("just started", working(0, 0, 0, None)), ("changed", working(0, 0, 2, None)),
            ("committed", working(1, 1, 0, None)), ("handed in", working(1, 0, 0, Some(change("open", false)))),
            ("approved", working(1, 0, 0, Some(change("open", true)))), ("handed in elsewhere", handed_in)];
        for (what, s) in cases {
            let said = next(&ctx, &s, &i);
            let mut facts = facts(&ctx, &s, &i);
            facts.push(Fact::SignedIn);
            let offers = offered(Group::Git, On::Issue, &facts, Env { prompt: false, connected: true });
            let commands: Vec<&str> = offers.iter().map(|o| o.command.name).collect();
            // Each command the card names next is a deed the menu offers on the issue…
            for n in &said { assert!(commands.contains(&n.split(' ').nth(1).unwrap()), "{what}: {n} not in {commands:?}"); }
            // …and the first thing the card says to do is the menu's first deed.
            if let Some(first) = offers.first().filter(|o| o.deed.weight == Weight::Own) {
                assert_eq!(Some(first.command.name), said.first().and_then(|n| n.split(' ').nth(1)), "{what}");
            }
        }
    }

    #[test]
    fn the_card_marks_each_step_says_where_to_edit_and_calls_leaving_leaving() {
        let ctx = Ctx::test(None, Vec::new()).online();
        let i = parse("r", "001.md", "Fix：x\n");
        // Just started: ○ for each step (bug: a blank), where the work is done, and the way back said as such.
        let just = card(&ctx, &working(0, 0, 0, None), &i, false);
        assert!(just[1].starts_with("    ○ Commit  ") && just[1].contains("l3 prompt r"), "{just:?}");
        assert_eq!(just[2], "    ○ Push");
        assert_eq!(just.last(), Some(&tr!("    back: l3 main r", "    戻る：l3 main r")));
        let changed = card(&ctx, &working(0, 0, 2, None), &i, false);
        assert_eq!(changed[1], tr!("    ○ Commit  2 files not committed", "    ○ Commit  未 Commit 2ファイル"));
        assert_eq!(changed.last(), Some(&tr!("    next: l3 commit r", "    次：l3 commit r")));
        let committed = card(&ctx, &working(1, 1, 0, None), &i, false);
        assert_eq!(committed[1..3], ["    ✓ Commit".to_string(), tr!("    ○ Push    1 commit to push", "    ○ Push    Push するコミット 1")]);
        // What comes next runs as it is pasted (bug: `[-m note]` came along, brackets and all).
        for s in [working(0, 0, 2, None), working(1, 0, 0, Some(change("open", false))), stand_with_nothing()] {
            for n in next(&ctx, &s, &i) { assert!(!n.contains('[') && !n.contains('…'), "{n}"); }
        }
    }

    #[test]
    fn an_issue_in_full_says_each_deed_once_as_the_menu_offers_it() {
        let ctx = Ctx::test(None, Vec::new()).online();
        let i = parse("r", "001.md", "Fix：x\n");
        let lines = |s: &Stand, on_work| deeds(&ctx, s, &i, on_work).into_iter().map(|(_, l)| l).collect::<Vec<_>>();
        // Handed in from here: what it is for first, then the rest, what leaves it last; Open is what is being read.
        assert_eq!(lines(&working(1, 0, 0, Some(change("open", false))), true),
            ["l3 review r#1 approve", "l3 merge r#1", "l3 diff r#1", "l3 review r#1 changes", &format!("l3 reply r#1 {}", crate::spec::placeholder("\"text\"")), "l3 main r", "l3 reset r", "l3 reject r#1"]);
        assert_eq!(lines(&working(0, 0, 2, None), true), ["l3 commit r", "l3 diff r", "l3 main r"]);
        assert_eq!(lines(&stand_with_nothing(), false), ["l3 start r#1", "l3 issue close r#1"]);
        // Its words are the menu's buttons, aligned in one column under a heading.
        let block = deed_block(&deeds(&ctx, &stand_with_nothing(), &i, false));
        assert_eq!(block[1], tr!("Next", "次"));
        let at: std::collections::HashSet<usize> = block[2..].iter().map(|l| crate::help::width(&l[..l.find("l3 ").unwrap()])).collect();
        assert_eq!(at.len(), 1, "{block:?}");
    }

    #[test]
    fn a_merged_issue_is_offered_nothing_to_do_but_to_be_read() {
        use crate::menu::{offered, Env};
        use crate::spec::Group;
        let ctx = Ctx::test(None, Vec::new()).online();
        let i = parse("r", "001.md", "Fix：x\n");
        let s = Stand { changes: vec![change("merged", true)], ..stand_with_nothing() };
        let mut f = facts(&ctx, &s, &i);
        f.push(Fact::SignedIn);
        let offers = offered(Group::Git, On::Issue, &f, Env { prompt: false, connected: true });
        let labels: Vec<&str> = offers.iter().map(|o| o.label()).collect();
        assert!(!labels.contains(&"Close"), "{labels:?}");
        assert!(next(&ctx, &s, &i).is_empty());
    }

    fn stand_with_nothing() -> Stand {
        Stand { known: true, work: None, lines: Vec::new(), changes: Vec::new(), merged: Vec::new(), uncommitted: 0 }
    }
}
