//! l3's Git, as the app's Git page: the issues not merged yet, oldest first,
//! each as its box (number, name, where it lives, where it stands) and the
//! one command that does what comes next; `l3 issue REPO#N` is one box in
//! full with its Diff, Review and Reply. An issue is named as File shows it
//! (`books/issue/001.md`, `/root/books/001.md`) or by its number (`books#1`).

use super::{ago, json, out, Args};
use length3_core::{history, issues::Issue, remote, repos::Repos, text, tr, work};

/// issue/001.md is #1; a name that is not a number is itself.
pub fn number(file: &str) -> String {
    let stem = file.trim_end_matches(".md");
    if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) { format!("#{}", stem.trim_start_matches('0').max("0")) } else { stem.to_string() }
}

/// `books#1`, `books/issue/001.md`, `/root/books/001.md` → ("books", "001.md").
pub fn issue_ref(r: &Repos, target: &str) -> Result<(String, String), String> {
    let t = target.trim_start_matches("/root/").trim_start_matches('/');
    if let Some((repo, n)) = t.split_once('#') {
        let want = n.trim_start_matches('0');
        let list = r.issues(repo)?.ok_or_else(|| tr!("{} has no issue/", "{} に issue/ がありません", repo))?;
        return list.into_iter().find(|i| i.file.trim_end_matches(".md").trim_start_matches('0') == want)
            .map(|i| (repo.to_string(), i.file))
            .ok_or_else(|| tr!("{} has no issue #{}", "{} に Issue #{} はありません", repo, want));
    }
    let (repo, rel) = super::split(t);
    let file = rel.trim_start_matches("issue/").to_string();
    if file.is_empty() { return Err(tr!("Name an issue: {}#1 or {}/issue/001.md", "Issue を指定してください: {}#1 か {}/issue/001.md", repo, repo)); }
    Ok((repo, file))
}

/// Where a repo stands, read once for every issue of it.
pub struct Stand {
    pub work: Option<history::Work>,
    pub lines: Vec<work::Line>,
    pub changes: Vec<history::Change>,
    pub uncommitted: usize,
}

pub fn stand(r: &Repos, repo: &str) -> Stand {
    if remote::connection().is_none() { return Stand { work: None, lines: Vec::new(), changes: Vec::new(), uncommitted: 0 }; }
    let w = history::work(r, repo).ok();
    let here = w.as_ref().is_some_and(|w| w.line != work::MAIN);
    let uncommitted = if here { history::changes(r, repo).map(|c| c.files).unwrap_or(0) } else { 0 };
    Stand { work: w, lines: work::lines(repo).unwrap_or_default(), changes: history::changes_of_repo(repo).unwrap_or_default(), uncommitted }
}

fn change_of<'a>(s: &'a Stand, i: &Issue) -> Option<&'a history::Change> {
    let path = format!("issue/{}", i.file);
    s.changes.iter().find(|c| c.issue == path)
}
fn here(s: &Stand, i: &Issue) -> bool {
    let path = format!("issue/{}", i.file);
    s.work.as_ref().is_some_and(|w| w.line != work::MAIN && w.issue.as_deref() == Some(path.as_str()))
}
pub fn unmerged(s: &Stand, i: &Issue) -> bool { change_of(s, i).is_none_or(|c| c.state != "merged") }

pub fn state_word(s: &str) -> String {
    match s {
        "open" => tr!("undecided", "未決"),
        "merged" => tr!("merged", "Merge 済み"),
        "rejected" => tr!("rejected", "Reject"),
        "reset" => tr!("taken back", "取り下げ"),
        other => other.to_string(),
    }
}
pub fn files(n: usize) -> String { if n == 1 { tr!("1 file", "1 ファイル") } else { tr!("{} files", "{} ファイル", n) } }
fn commits(n: usize) -> String { if n == 1 { tr!("1 commit", "コミット 1") } else { tr!("{} commits", "コミット {}", n) } }

/// Who started it and when, quietly, as the card's foot says; a decided change says how it ended.
fn standing(s: &Stand, i: &Issue) -> String {
    // A Prompt cannot see the Remote, so it says nothing of where the work stands.
    if super::in_prompt() { return String::new(); }
    let path = format!("issue/{}", i.file);
    if let (true, Some(w)) = (here(s, i), s.work.as_ref()) {
        return tr!("{} · started {}", "{} · 開始 {}", if w.started_by.is_empty() { "—" } else { &w.started_by }, ago(w.started_at));
    }
    if let Some(c) = change_of(s, i).filter(|c| c.state != "open") { return tr!("change · version {} · {}", "Change · 第 {} 版 · {}", c.version, state_word(&c.state)); }
    if change_of(s, i).is_some() { return String::new(); }
    match s.lines.iter().find(|l| l.issue == path) {
        Some(l) => tr!("{} · started {}", "{} · 開始 {}", if l.started_by.is_empty() { "—" } else { &l.started_by }, ago(l.started_at)),
        None => tr!("not started", "未着手"),
    }
}

/// What can be done next, the one to do first: as the box's buttons.
fn next(s: &Stand, i: &Issue) -> Vec<String> {
    let me = format!("{}{}", i.repo, number(&i.file));
    // A Prompt has no Remote: the work is done from the app's Git page.
    if super::in_prompt() { return vec![tr!("the app's Git page", "アプリの Git")]; }
    if remote::connection().is_none() { return vec!["l3 login".into()]; }
    let mut out = Vec::new();
    let change = change_of(s, i);
    let open = change.is_some_and(|c| c.state == "open");
    if !here(s, i) {
        out.push(format!("l3 start {me}"));
    } else if let Some(w) = &s.work {
        if s.uncommitted > 0 { out.push(format!("l3 commit {} {}", i.repo, tr!("[-m note]", "[-m メモ]"))); }
        else if w.unpushed > 0 { out.push(format!("l3 push {}", i.repo)); }
        else if w.commits > 0 && !open && change.is_none_or(|c| c.state != "merged") { out.push(format!("l3 push {}", i.repo)); }
    }
    // An undecided change, in the app's order: its Review (approve, or a comment more), then
    // Merge once this version is approved; Reject and Reset (taking it back) last.
    if let Some(c) = change.filter(|_| open) {
        let review = format!("l3 review {me} approve {}", tr!("[-m note]", "[-m メモ]"));
        let merge = format!("l3 merge {me}");
        if c.reviews.iter().any(|r| r.version == c.version && r.verdict == "approve") { out.push(merge); out.push(review); }
        else { out.push(review); out.push(merge); }
        out.push(format!("l3 reply {me} \"…\""));
        out.push(format!("l3 reject {me}"));
        if here(s, i) { out.push(format!("l3 reset {}", i.repo)); }
    }
    if here(s, i) { out.push(format!("l3 main {}", i.repo)); }
    out
}

/// The box as the app's card shows it: the title; once worked on here (or
/// received), Commit and Push with a check once done and what each is about;
/// at the foot, where it lives and who started it; then what comes next.
fn print_box(s: &Stand, i: &Issue, full: bool) {
    out(format!("{} {}", number(&i.file), text::named(i.kind.as_deref(), &i.title)));
    if full && !i.detail.is_empty() { for l in i.detail.lines() { out(format!("    {l}")); } }
    let done = |yes: bool| if yes { "✓" } else { " " };
    let change = change_of(s, i);
    let version = |c: &history::Change| tr!("change · version {} · {}", "Change · 第 {} 版 · {}", c.version, state_word(&c.state));
    if !super::in_prompt() {
        if let (true, Some(w)) = (here(s, i), s.work.as_ref()) {
            let committed = s.uncommitted == 0 && w.commits > 0;
            let pushed = w.commits > 0 && w.unpushed == 0 && change.is_some_and(|c| c.state == "open" || c.state == "merged");
            let what = if s.uncommitted > 0 { tr!("{} not committed", "未 Commit {}", files(s.uncommitted)) } else { String::new() };
            out(format!("    {} Commit  {what}", done(committed)).trim_end());
            let push = if pushed { change.map(version).unwrap_or_default() } else if w.unpushed > 0 { tr!("{} to push", "Push 待ち {}", commits(w.unpushed)) } else { String::new() };
            out(format!("    {} Push    {push}", done(pushed)).trim_end());
        } else if let Some(c) = change.filter(|c| c.state == "open") {
            out(format!("    ✓ Commit  {}", if c.submitted_by.is_empty() { "—" } else { &c.submitted_by }));
            out(format!("    ✓ Push    {}", version(c)));
        }
    }
    let st = standing(s, i);
    out(format!("    {} · issue/{}{}", i.repo, i.file, if st.is_empty() { String::new() } else { format!(" · {st}") }));
    let n = next(s, i);
    if let Some((first, rest)) = n.split_first() {
        out(tr!("    next: {}", "    次: {}", first));
        if full && !rest.is_empty() { out(tr!("    also: {}", "    ほか: {}", rest.join(" · "))); }
    }
}

/// `l3 git [REPO]`: every issue not merged yet, oldest first, as boxes.
pub fn page(a: &Args, only: Option<&str>) -> Result<(), String> {
    let r = Repos::open()?;
    let names: Vec<String> = match only { Some(x) => vec![x.to_string()], None => r.list()?.into_iter().map(|s| s.name).collect() };
    let mut shown = Vec::new();
    let mut merged = Vec::new();
    let mut missing = Vec::new();
    for n in &names {
        let Some(mut list) = r.issues(n)? else { missing.push(n.clone()); continue };
        list.sort_by(|a, b| a.file.cmp(&b.file));
        let s = if super::in_prompt() { Stand { work: None, lines: Vec::new(), changes: Vec::new(), uncommitted: 0 } } else { stand(&r, n) };
        let done = list.iter().filter(|i| !unmerged(&s, i)).count();
        if done > 0 { merged.push((n.clone(), done)); }
        shown.push((s, list));
    }
    if a.json {
        return json(shown.iter().flat_map(|(s, l)| l.iter().filter(|i| unmerged(s, i)).map(|i| serde_json::json!({
            "issue": i, "number": number(&i.file), "standing": standing(s, i), "next": next(s, i)}))).collect::<Vec<_>>());
    }
    let mut any = false;
    for (s, list) in &shown {
        for i in list.iter().filter(|i| unmerged(s, i)) { if any { out(""); } print_box(s, i, false); any = true; }
    }
    if !any { out(if merged.is_empty() { tr!("No issues yet (write one with l3 issue new REPO \"Fix：title\")", "Issue はまだありません（l3 issue new REPO \"Fix：件名\" で書けます）") } else { tr!("Every issue is merged", "すべての Issue が Merge 済みです") }); }
    for (n, k) in &merged { out(""); out(tr!("{0} merged in {1} (l3 log {1})", "{1} で Merge 済み {0}（l3 log {1}）", k, n)); }
    if !missing.is_empty() { out(tr!("repos without issue/: {}", "issue/ がない repo: {}", missing.join(", "))); }
    Ok(())
}

/// `l3 issue REPO#N`: one box in full, then its Diff, Review and Reply.
pub fn one(a: &Args, target: &str) -> Result<(), String> {
    let r = Repos::open()?;
    let (repo, file) = issue_ref(&r, target)?;
    let c = r.read(&repo, &format!("issue/{file}"), 256 * 1024)?;
    let i = length3_core::issues::parse(&repo, &file, &c.text.ok_or_else(|| tr!("It is binary", "バイナリです"))?);
    if a.json { return json(&i); }
    if super::in_prompt() {
        out(format!("{} {}    {} · issue/{}", number(&i.file), text::named(i.kind.as_deref(), &i.title), i.repo, i.file));
        if !i.detail.is_empty() { out(""); out(&i.detail); }
        return Ok(());
    }
    let s = stand(&r, &repo);
    print_box(&s, &i, true);
    // What is not committed, while it is worked on here (beside Commit in the app).
    if here(&s, &i) && s.uncommitted > 0 {
        out("");
        out(tr!("Not committed  {}  (l3 diff {} shows the lines)", "未 Commit  {}  （行は l3 diff {}）", files(s.uncommitted), repo));
        let ch = history::changes(&r, &repo)?;
        for f in &ch.folders {
            for x in &f.files { out(format!("    {}  {}", word(x.status), x.path) + &counts(x.binary, x.added as usize, x.removed as usize)); }
        }
    }
    // The Review, once there is a change: its diff, what was said, the approvals; then Merge.
    if let Some(c) = change_of(&s, &i).filter(|c| c.state != "reset") {
        let me = format!("{}{}", i.repo, number(&i.file));
        out("");
        out(tr!("Review  {}  (l3 diff {} shows the lines)", "Review  {}  （行は l3 diff {}）", files(c.files), me));
        for f in history::change_diff(&repo, &c.id, 100_000).unwrap_or_default() {
            let add = f.lines.iter().filter(|l| l.kind == "add").count();
            let del = f.lines.iter().filter(|l| l.kind == "del").count();
            out(format!("    {}  {}", word(f.status), f.path) + &counts(f.binary, add, del));
        }
        // What was said, in order; an approval without words is the check below, not a line here.
        for rv in c.reviews.iter().rev().filter(|r| !(r.verdict == "approve" && r.note.is_empty())) {
            let of = if rv.version != c.version { tr!(" (version {}, older)", "（第 {} 版、古い版）", rv.version) } else { String::new() };
            let asked = if rv.verdict == "changes" { tr!(" asked for changes", " 変更を依頼") } else { String::new() };
            out(format!("    {} · {}{asked}{of}: {}", rv.by, ago(rv.time), rv.note));
        }
        let approvals: Vec<&str> = c.reviews.iter().filter(|r| r.version == c.version && r.verdict == "approve").map(|r| r.by.as_str()).collect();
        if c.state == "open" {
            out(if approvals.is_empty() { tr!("    ○ Approve  (l3 review {} approve)", "    ○ 承認  （l3 review {} approve）", me) } else { tr!("    ✓ Approved", "    ✓ 承認済み") });
            out("");
            out(if approvals.is_empty() { tr!("Merge  not approved yet · Reject: l3 reject {}", "Merge  まだ承認されていません · Reject: l3 reject {}", me) }
                else { tr!("Merge  approved by {} (l3 merge {}) · Reject: l3 reject {}", "Merge  {} が承認（l3 merge {}） · Reject: l3 reject {}", approvals.join(", "), me, me) });
        }
    }
    Ok(())
}

/// `l3 diff REPO` (what is not committed) or `l3 diff REPO#N` (its change as handed in): each
/// file with what was added and removed, and its lines, each with which line it is, as the app shows them.
pub fn diff(target: &str) -> Result<(), String> {
    let r = Repos::open()?;
    let files = if target.contains('#') {
        let (repo, file) = issue_ref(&r, target)?;
        let s = stand(&r, &repo);
        let path = format!("issue/{file}");
        let i = s.changes.iter().find(|c| c.issue == path);
        match i {
            Some(c) => history::change_diff(&repo, &c.id, 100_000)?,
            None => return Err(tr!("{} has no change yet (l3 push {} hands it in)", "{} にはまだ Change がありません（l3 push {} で渡します）", target, repo)),
        }
    } else {
        history::diff(&r, target.trim_start_matches("/root/"), 100_000)?
    };
    if files.is_empty() { out(tr!("No changes", "変更はありません")); }
    for f in &files {
        let add = f.lines.iter().filter(|l| l.kind == "add").count();
        let del = f.lines.iter().filter(|l| l.kind == "del").count();
        out(format!("{}  {}", f.path, counts(f.binary, add, del).trim_start()));
        for l in f.lines.iter().enumerate().filter(|(k, l)| !(*k == 0 && l.kind == "hunk")).map(|(_, l)| l) {
            let mark = match l.kind { "add" => '+', "del" => '-', "hunk" => '…', _ => ' ' };
            let at = l.at.map(|n| n.to_string()).unwrap_or_default();
            out(if l.kind == "hunk" { format!("  {:>5}  …", "") } else { format!("  {at:>5} {mark} {}", l.text) });
        }
        if f.more > 0 { out(tr!("  {} more lines", "  ほか {} 行", f.more)); }
        out("");
    }
    Ok(())
}

fn word(status: &str) -> String {
    match status { "added" => tr!("added", "追加"), "removed" => tr!("removed", "削除"), _ => tr!("changed", "変更") }
}
fn counts(binary: bool, added: usize, removed: usize) -> String {
    if binary { tr!("  (binary)", "  （バイナリ）") } else { format!("  +{added} −{removed}") }
}

/// The line of an issue, for the commands that act on its change.
pub fn line_of(r: &Repos, target: &str) -> Result<(String, String), String> {
    let (repo, file) = issue_ref(r, target)?;
    Ok((repo, file.trim_end_matches(".md").to_string()))
}
