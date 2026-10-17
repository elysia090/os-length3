//! Git, as the app's Git page: the issues not merged yet, oldest first,
//! each as its box (number, name, where it lives, where it stands) and the
//! one command that does what comes next; `l3 issue REPO#N` is one box in
//! full with its Diff, Review and Reply. Then the steps: start, commit, push
//! (and reset), review, reply, merge, reject; diff and log to look.

use super::Ctx;
use crate::args::Call;
use crate::out::{self, ago, commits, files, issues, Error, Reply, Result};
use crate::target::{self, IssueRef};
use length3_core::history::{self, state_word, Change, Work};
use length3_core::issues::{number, Issue};
use length3_core::{text, tr, work};
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
fn me(i: &Issue) -> String { format!("{}{}", i.repo, number(&i.file)) }

impl Stand {
    fn change(&self, i: &Issue) -> Option<&Change> { self.changes.iter().find(|c| c.issue == path_of(i)) }
    /// Being worked on here, now.
    fn here(&self, i: &Issue) -> bool {
        self.work.as_ref().is_some_and(|w| w.line != work::MAIN && w.issue.as_deref() == Some(path_of(i).as_str()))
    }
    fn merged(&self, i: &Issue) -> bool {
        self.change(i).is_some_and(|c| c.state == "merged") || self.merged.contains(&path_of(i))
    }
    /// Where it stands, as one word for data.
    fn state(&self, i: &Issue) -> &'static str {
        if self.merged(i) { return "merged"; }
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

/// What can be done next, the one to do first first: as the box's buttons.
fn next(ctx: &Ctx, s: &Stand, i: &Issue) -> Vec<String> {
    if ctx.prompt { return vec![tr!("the app's Git page", "アプリの Git")]; }
    if !ctx.connected() { return vec!["l3 login".into()]; }
    if s.merged(i) || !s.known { return Vec::new(); }
    let m = me(i);
    let mut out = Vec::new();
    let change = s.change(i);
    let open = change.is_some_and(|c| c.state == "open");
    if !s.here(i) {
        out.push(format!("l3 start {m}"));
    } else if let Some(w) = &s.work {
        if s.uncommitted > 0 { out.push(format!("l3 commit {} [-m note]", i.repo)); }
        else if w.unpushed > 0 || (w.commits > 0 && !open) { out.push(format!("l3 push {}", i.repo)); }
    }
    // An undecided change, in the app's order: its Review (approve, or a comment more), then
    // Merge once this version is approved; Reject and Reset (taking it back) last.
    if let Some(c) = change.filter(|_| open) {
        let review = format!("l3 review {m} approve [-m note]");
        let merge = format!("l3 merge {m}");
        if approvers(c).is_empty() { out.push(review); out.push(merge); } else { out.push(merge); out.push(review); }
        out.push(format!("l3 reply {m} \"…\""));
        out.push(format!("l3 reject {m}"));
        if s.here(i) { out.push(format!("l3 reset {}", i.repo)); }
    }
    if s.here(i) { out.push(format!("l3 main {}", i.repo)); }
    out
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
/// handed in), Commit and Push with a check once done and what each is about;
/// at the foot, where it lives and who started it; then what comes next.
fn card(ctx: &Ctx, s: &Stand, i: &Issue, full: bool) -> Vec<String> {
    let mut t = vec![format!("{} {}", number(&i.file), text::named(i.kind.as_deref(), &i.title))];
    if full && !i.detail.is_empty() { for l in i.detail.lines() { t.push(format!("    {l}")); } }
    let done = |yes: bool| if yes { "✓" } else { " " };
    let change = s.change(i);
    if !ctx.prompt && !s.merged(i) {
        if let (true, Some(w)) = (s.here(i), s.work.as_ref()) {
            let committed = s.uncommitted == 0 && w.commits > 0;
            let pushed = w.commits > 0 && w.unpushed == 0 && change.is_some_and(|c| c.state == "open");
            let what = if s.uncommitted > 0 { tr!("{} not committed", "未 Commit：{}", files(s.uncommitted)) } else { String::new() };
            t.push(format!("    {} Commit  {what}", done(committed)).trim_end().to_string());
            let push = if pushed { change.map(version).unwrap_or_default() } else if w.unpushed > 0 { tr!("{} to push", "Push 待ち：{}", commits(w.unpushed)) } else { String::new() };
            t.push(format!("    {} Push    {push}", done(pushed)).trim_end().to_string());
        } else if let Some(c) = change.filter(|c| c.state == "open") {
            t.push(format!("    ✓ Commit  {}", if c.submitted_by.is_empty() { "—" } else { &c.submitted_by }));
            t.push(format!("    ✓ Push    {}", version(c)));
        }
    }
    let st = standing(ctx, s, i);
    t.push(format!("    {} · issue/{}{}", i.repo, i.file, if st.is_empty() { String::new() } else { format!(" · {st}") }));
    let n = next(ctx, s, i);
    if let Some((first, rest)) = n.split_first() {
        t.push(tr!("    next: {}", "    次：{}", first));
        if full && !rest.is_empty() { t.push(tr!("    also: {}", "    ほか：{}", rest.join(" · "))); }
    }
    t
}

fn issue_json(ctx: &Ctx, s: &Stand, i: &Issue) -> Value {
    let c = s.change(i);
    let w = s.work.as_ref().filter(|_| s.here(i));
    json!({"repo": i.repo, "number": number(&i.file), "file": i.file, "kind": i.kind, "title": i.title, "detail": i.detail,
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
    let (mut boxes, mut data, mut merged, mut missing) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut offline = false;
    for n in &names {
        let Some(mut list) = r.issues(n)? else { missing.push(n.clone()); continue };
        list.sort_by(|a, b| a.file.cmp(&b.file));
        let s = stand(ctx, &r, n);
        offline |= ctx.connected() && !s.known;
        let done = list.iter().filter(|i| s.merged(i)).count();
        if done > 0 { merged.push((n.clone(), done)); }
        for i in list.iter().filter(|i| !s.merged(i)) {
            boxes.push(card(ctx, &s, i, false).join("\n"));
            data.push(issue_json(ctx, &s, i));
        }
    }
    let mut t = boxes.join("\n\n");
    if boxes.is_empty() { t = if merged.is_empty() { tr!("No issues yet (l3 issue new REPO \"Fix：title\")", "Issue はまだありません（l3 issue new REPO \"Fix：件名\" で書けます）") } else { tr!("Every issue is merged", "すべての Issue が Merge 済みです") }; }
    for (n, k) in &merged { t += &format!("\n\n{}", tr!("{0} merged in {1} (l3 log {1})", "{1} で Merge 済み：{0}（l3 log {1}）", issues(*k), n)); }
    if !missing.is_empty() { t += &format!("\n\n{}", tr!("repos without issue/: {}", "issue/ がない repo：{}", missing.join(", "))); }
    if offline { t += &format!("\n\n{}", tr!("The Remote could not be reached: where each issue stands is not known (merges seen before are)", "Remote に届きませんでした。各 Issue の状態は不明です（前に見た Merge はわかります）")); }
    Ok(Reply::data(t, json!({"issues": data, "merged": merged.iter().map(|(r, n)| json!({"repo": r, "count": n})).collect::<Vec<_>>(), "withoutIssues": missing, "known": !offline})))
}

fn read_issue(ctx: &Ctx, at: &IssueRef) -> Result<Issue> {
    let c = ctx.repos()?.read(&at.repo, &at.path(), 256 * 1024)?;
    Ok(length3_core::issues::parse(&at.repo, &at.file, &c.text.ok_or_else(|| Error::Refused(tr!("{} is binary", "{} はバイナリです", at.name())))?))
}

/// `l3 issue REPO#N`: one box in full, then its Diff, Review and Reply.
pub fn issue_show(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let r = ctx.repos()?;
    let i = read_issue(ctx, &at)?;
    if ctx.prompt {
        let mut t = format!("{} {}    {} · issue/{}", number(&i.file), text::named(i.kind.as_deref(), &i.title), i.repo, i.file);
        if !i.detail.is_empty() { t += &format!("\n\n{}", i.detail); }
        return Ok(Reply::data(t, json!({"issue": i})));
    }
    let s = stand(ctx, &r, &at.repo);
    let mut t = card(ctx, &s, &i, true);
    let mut uncommitted = Vec::new();
    // What is not committed, while it is worked on here (beside Commit in the app).
    if s.here(&i) && s.uncommitted > 0 {
        t.push(String::new());
        t.push(tr!("Not committed  {}  (l3 diff {} shows the lines)", "未 Commit：{}（行は l3 diff {}）", files(s.uncommitted), at.repo));
        for f in history::changes(&r, &at.repo)?.folders.iter().flat_map(|f| f.files.iter()) {
            t.push(format!("    {}  {}{}", word(f.status), f.path, counts(f.binary, f.added as usize, f.removed as usize)));
            uncommitted.push(json!({"path": f.path, "status": f.status, "added": f.added, "removed": f.removed, "binary": f.binary}));
        }
    }
    // The Review, once there is a change: its diff, what was said, the approvals; then Merge.
    let change = s.change(&i).filter(|c| c.state != "reset");
    if let Some(c) = change {
        let m = at.name();
        t.push(String::new());
        t.push(tr!("Review  {}  (l3 diff {} shows the lines)", "Review：{}（行は l3 diff {}）", files(c.files), m));
        for f in history::change_diff(&at.repo, &c.id, 100_000).unwrap_or_default() {
            let (add, del) = (f.lines.iter().filter(|l| l.kind == "add").count(), f.lines.iter().filter(|l| l.kind == "del").count());
            t.push(format!("    {}  {}{}", word(f.status), f.path, counts(f.binary, add, del)));
        }
        // What was said, in order; an approval without words is the check below, not a line here.
        for rv in c.reviews.iter().rev().filter(|r| !(r.verdict == "approve" && r.note.is_empty())) {
            let of = if rv.version != c.version { tr!(" (version {}, older)", "（第{}版、古い版）", rv.version) } else { String::new() };
            let asked = match rv.verdict.as_str() { "changes" => tr!(" asked for changes", " 変更を依頼"), "approve" => tr!(" approved", " 承認"), _ => String::new() };
            t.push(format!("    {} · {}{asked}{of}: {}", rv.by, ago(rv.time), rv.note));
        }
        let by = approvers(c);
        if c.state == "open" {
            t.push(if by.is_empty() { tr!("    ○ Approve  (l3 review {} approve)", "    ○ 承認（l3 review {} approve）", m) } else { tr!("    ✓ Approved by {}", "    ✓ 承認：{}", by.join(", ")) });
            t.push(String::new());
            t.push(if by.is_empty() { tr!("Merge  not approved yet (l3 merge {} takes it anyway) · Reject: l3 reject {}", "Merge：まだ承認されていません（l3 merge {} でも取り込めます） · Reject：l3 reject {}", m, m) }
                else { tr!("Merge  l3 merge {} · Reject: l3 reject {}", "Merge：l3 merge {} · Reject：l3 reject {}", m, m) });
        } else if c.state == "rejected" && !c.note.is_empty() {
            t.push(tr!("    rejected: {}", "    Reject の理由：{}", c.note));
        }
    }
    Ok(Reply::data(t.join("\n"), json!({"issue": issue_json(ctx, &s, &i), "uncommitted": uncommitted, "change": change})))
}

pub fn issue_new(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let (kind, title) = text::kind_of(call.word(1).unwrap_or_default());
    if title.trim().is_empty() { return Err(Error::Usage(tr!("An issue needs a title: l3 issue new [REPO] \"Fix：title\"", "Issue には件名がいります：l3 issue new [REPO] \"Fix：件名\""))); }
    let file = ctx.repos()?.add_issue(&repo, kind.as_deref(), &title, call.note())?;
    Ok(Reply::done(tr!("Wrote {}/issue/{} ({}{})", "{}/issue/{} に書きました（{}{}）", repo, file, repo, number(&file)),
        json!({"repo": repo, "file": file, "number": number(&file), "kind": kind, "title": title.trim()})))
}

pub fn start(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    let l = work::start(&ctx.repos()?, &at.repo, &at.path())?;
    Ok(Reply::done(tr!("Working on {} — {} shows its copy now (back with: l3 main {})", "{} を始めました。{} はその写しを見せています（戻るには l3 main {}）", at.name(), at.repo, at.repo), json!({"issue": at.path(), "line": l})))
}

pub fn main(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let r = ctx.repos()?;
    let was = r.line(&repo);
    if was == work::MAIN { return Ok(Reply::done(tr!("{} shows main already", "{} はもう main を見せています", repo), json!({"repo": repo, "line": work::MAIN, "changed": false}))); }
    work::switch(&r, &repo, work::MAIN)?;
    Ok(Reply::done(tr!("{} shows main now (the work on issue/{}.md waits: l3 start {}{})", "{} は main を見せています（issue/{}.md の作業はそのまま：l3 start {}{}）", repo, was, repo, number(&was)),
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
    } else { (title.clone(), call.note().to_string()) };
    if on == work::MAIN && text::kind_of(&line).1.trim().is_empty() {
        return Err(Error::Usage(tr!("On main a commit is named by its line: l3 commit [REPO] \"Fix：title\" (on an issue, after it: l3 start REPO#N)", "main では行の名前で Commit します：l3 commit [REPO] \"Fix：件名\"（Issue の作業ならその名前で：l3 start REPO#N）")));
    }
    let c = history::cut(&r, &repo, None, &line, &note)?;
    let mut text = tr!("Committed {}  {} ({}{})", "Commit しました {}  {}（{}{}）", out::short(&c.id), history::line(&c), files(c.files), out::added_removed(c.added, c.removed));
    if folded { text += &tr!("\n  named after its issue; \"{}\" is its note", "\n  Issue の名前で Commit し、「{}」はメモにしました", title); }
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
    for c in &list {
        t.push(history::line(c));
        let issue = c.issue.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
        let merged = if c.merged.is_some() { tr!(" · merge", " · Merge") } else { String::new() };
        t.push(format!("    {} · {} · {}{}{issue}{merged}", out::short(&c.id), ago(c.time), files(c.files), out::added_removed(c.added, c.removed)));
        let places: Vec<String> = c.folders.iter().map(|f| if f.is_empty() { format!("{repo}/") } else { format!("{f}/") }).collect();
        if !places.is_empty() { t.push(format!("    {}", places.join(" "))); }
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
    change_for(&at)?;
    let c = history::merge_and_finish(&ctx.repos()?, &at.repo, &at.line())?;
    Ok(Reply::done(tr!("Merged {} into main (version {})", "{} を main に Merge しました（第{}版）", named_change(&c), c.version), json!({"change": c})))
}

pub fn reject(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let at = target::issue(ctx, call, 0)?;
    change_for(&at)?;
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
