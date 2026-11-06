//! Work on an issue: a line of its own on the Remote (a branch) and a copy of its own here (a worktree, lines.rs),
//! neither of which the person names or manages. Choosing to work on an issue makes both and puts that copy where
//! the repo is seen (/root/<repo> in File, Forge and the Prompt); going back to main puts main's copy there again;
//! a work merged is finished, its copy here given back.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::history::{changes_of_repo, listed, Change};
use crate::repos::lines::{current, line_for, set_current, valid, worktree, MAIN};
use crate::remote::{self, Client, Line, Reply};
use crate::repos::store::Repos;
use serde::Serialize;
use std::fs;

type Result<T> = std::result::Result<T, String>;

/// Work on `issue` ("issue/001.md"): its line is made on the Remote from
/// main's last commit if it is not there yet, its copy is brought here, and
/// the repo shows it. What was shown before is sent first.
pub fn start(repos: &Repos, repo: &str, issue: &str) -> Result<Line> {
    let stem = line_for(issue).ok_or_else(|| crate::tr!("{} is not an issue", "{} は Issue ではありません", issue))?;
    let client = Client::open()?;
    // A merged issue is done: its work is main's now.
    let path = format!("issue/{}", issue.trim_start_matches('/').trim_start_matches("issue/"));
    if changes_of_repo(repo)?.iter().any(|c| c.issue == path && c.state == "merged") {
        return Err(crate::tr!("{}{} is merged already: its work is in main", "{}{} はもう Merge 済みです。その作業は main にあります", repo, crate::repos::issues::number(&path)));
    }
    // What is here goes first, the issue just written above all: the Remote makes the work
    // from its main (bringing the issue along from main's draft), so a work started before
    // the issue reached it would have no issue. One that cannot be sent stops the start.
    remote::sync(repos, repo).map_err(|e| crate::tr!("{} could not be sent first, so its work was not started: {}", "{} を先に送れなかったので、作業は始めていません：{}", repo, e))?;
    let made: Line = serde_json::from_value(client.json("POST", &format!("/v1/repos/{repo}/lines"), Some(serde_json::json!({"issue": issue})))?)
        .map_err(|e| e.to_string())?;
    show(repos, repo, &stem)?;
    Ok(made)
}

/// Show `line` (or main) where the repo is seen, bringing its copy here if it is not.
pub fn switch(repos: &Repos, repo: &str, line: &str) -> Result<()> {
    if !valid(line) { return Err(crate::tr!("{} is not a line of work", "{} は作業の名前になりません", line)); }
    // Away, switching is this device's alone: what the shown copy has not sent stays in it and goes later.
    if remote::connection().is_some() { let _ = remote::sync(repos, repo); }
    show(repos, repo, line)?;
    // Back on main: work handed over that waited for it begins (tasks.rs).
    if line == MAIN { crate::agent::tasks::back_on_main(repo); }
    Ok(())
}

fn show(repos: &Repos, repo: &str, line: &str) -> Result<()> {
    repos.dir(repo)?;
    if line != MAIN {
        let at = worktree(repo, line);
        let fresh = !at.is_dir();
        fs::create_dir_all(&at).map_err(|e| e.to_string())?;
        set_current(repo, line)?;
        if fresh {
            remote::forget_line(repo, line)?;
            if let Err(e) = remote::sync(repos, repo) {
                let _ = set_current(repo, MAIN);
                let _ = fs::remove_dir_all(&at);
                return Err(e);
            }
        }
        return Ok(());
    }
    set_current(repo, MAIN)
}

/// A work whose change was merged is done: what it holds is on the Remote (its line's draft
/// and commits), so the repo shows main again if it showed the work, and its copy here goes.
/// Returns the bytes given back.
pub fn finish(repos: &Repos, repo: &str, line: &str) -> Result<u64> {
    if line == MAIN || !valid(line) { return Ok(0); }
    let at = worktree(repo, line);
    if !at.is_dir() { return Ok(0); }
    if current(repo) == line {
        if remote::connection().is_some() { remote::sync(repos, repo)?; }
        set_current(repo, MAIN)?;
        crate::agent::tasks::back_on_main(repo);
    }
    let size = crate::fs::size::allocated(&at);
    fs::remove_dir_all(&at).map_err(|e| e.to_string())?;
    remote::forget_line(repo, line)?;
    Ok(size)
}

/// Merge, and the work is done: the repo shows main again, and the work's copy here goes.
pub fn merge_and_finish(repos: &Repos, repo: &str, line: &str) -> Result<Change> {
    let c = crate::history::merge(repo, line)?;
    finish(repos, repo, &c.line)?;
    crate::history::remember_merged(repo, std::iter::once(c.issue.clone()));
    Ok(c)
}

/// `s` as it goes in a query string: anything but letters, digits and -._~ as %XX.
fn query_part(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Where each of `names` stands, each its own answer or why not (as `api::answer` says why: its words, and how the
/// Remote refused it when it did). The Remote is asked for all their lines and changes at once (GET /v1/standing): Git
/// asked the two of each repo one after another, each a round trip the core waited on. A Remote without the route is
/// asked repo by repo, as before.
pub fn standings(repos: &Repos, names: &[String]) -> Result<Vec<std::result::Result<Standing, serde_json::Value>>> {
    if names.is_empty() { return Ok(Vec::new()); }
    let client = Client::open()?;
    let query: Vec<String> = names.iter().map(|n| format!("repo={}", query_part(n))).collect();
    let each: Vec<serde_json::Value> = match client.call("GET", &format!("/v1/standing?{}", query.join("&")), None)? {
        Reply::Ok(v) => serde_json::from_value(v).map_err(|e| e.to_string())?,
        Reply::NotFound(_) => return Ok(names.iter().map(|r| {
            let one = || Ok(Standing { work: state(repos, r)?, lines: crate::remote::lines(r)?, changes: changes_of_repo(r)? });
            one().map_err(|e: String| serde_json::json!({"error": e}))
        }).collect()),
        Reply::Conflict(v) => return Err(crate::remote::refused_in(409, &v)),
    };
    Ok(names.iter().map(|name| {
        let v = each.iter().find(|x| x["name"].as_str() == Some(name.as_str()))
            .ok_or_else(|| serde_json::json!({"error": crate::tr!("The Remote did not say where {} stands", "Remote が {} の状態を答えませんでした", name)}))?;
        // Refused for this repo (turned off): as its own routes refuse it, with what the Remote said of it.
        if let Some(status) = v["status"].as_u64() {
            return Err(serde_json::json!({"error": crate::remote::refused_in(status as u16, v), "status": status, "detail": v}));
        }
        let one = || {
            let lines: Vec<crate::remote::Line> = serde_json::from_value(v["lines"].clone()).map_err(|e| e.to_string())?;
            let changes = listed(&client, name, v["changes"].clone())?;
            let work = work_from(repos, name, Some((&lines, &changes)))?;
            Ok(Standing { work, lines, changes })
        };
        one().map_err(|e: String| serde_json::json!({"error": e}))
    }).collect())
}

/// Where a repo stands, for Git's page: the work it shows, every issue's work on the Remote, the changes to its main.
#[derive(Serialize, Debug)]
pub struct Standing {
    pub work: Work,
    pub lines: Vec<crate::remote::Line>,
    pub changes: Vec<Change>,
}

/// `work`, from the repo's lines and changes as the Remote just answered them (`asked`), when they were asked already.
fn work_from(repos: &Repos, repo: &str, asked: Option<(&[crate::remote::Line], &[Change])>) -> Result<Work> {
    // A work merged (here or on another device) is done: back to main, and its copy goes. The changes are asked of
    // the Remote only when there is a copy here: with none, there is nothing to let go of, and the work shown is main
    // (most repos, most of the time), which Forge and Git asked about each time they drew the repo.
    let copies = crate::repos::lines::worktrees(repo);
    let mut listed = asked.map(|(_, changes)| changes.to_vec());
    if !copies.is_empty() {
        let list = match &listed { Some(l) => Ok(l.clone()), None => changes_of_repo(repo) };
        let merged: Vec<&str> = list.iter().flatten().filter(|c| c.state == "merged").map(|c| c.line.as_str()).collect();
        for (line, _) in &copies {
            // A merged work's copy that cannot go now is tried again the next time the issues are read.
            if merged.contains(&line.as_str()) { let _ = finish(repos, repo, line); }
        }
        listed = list.ok();
    }
    let on = repos.line(repo);
    if on == crate::repos::lines::MAIN {
        return Ok(Work { line: on, issue: None, started_by: String::new(), started_at: 0, commits: 0, unpushed: 0, change: None });
    }
    // The work's line as the Remote answered it with the others, or asked of it.
    let l = match asked.and_then(|(lines, _)| lines.iter().find(|x| x.line == on)) {
        Some(l) => l.clone(),
        None => crate::remote::line(repo, &on)?.ok_or_else(|| crate::tr!("The Remote has no such work", "Remote にその作業がありません"))?,
    };
    let (commits, unpushed) = crate::history::progress(repo, &l)?;
    // The list read above, when it was: what was let go of meanwhile was merged, never the work shown.
    let change = match listed { Some(list) => list, None => changes_of_repo(repo)? }.into_iter().find(|c| c.line == on);
    Ok(Work { line: on, issue: Some(l.issue), started_by: l.started_by, started_at: l.started_at, commits, unpushed, change })
}

pub fn state(repos: &Repos, repo: &str) -> Result<Work> {
    work_from(repos, repo, None)
}

/// The work the repo shows now: main, or an issue's, and where it stands.
#[derive(Serialize, Debug, Clone)]
pub struct Work {
    /// "main", or the issue's line ("001").
    pub line: String,
    pub issue: Option<String>,
    /// Who started it and when (ms): how a person tells works apart.
    pub started_by: String,
    pub started_at: u64,
    /// Commits made on it, and how many of them are not pushed yet.
    pub commits: usize,
    pub unpushed: usize,
    /// The change it was handed in as, if it was.
    pub change: Option<Change>,
}


