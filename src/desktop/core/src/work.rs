//! Work on an issue, the way the OS keeps it: a line of its own on the
//! Remote (a branch) and a copy of its own here (a worktree), neither of
//! which the person names or manages. Choosing to work on an issue makes
//! both and puts that copy where the repo is seen (/root/<repo> in File,
//! Forge and the Prompt); going back to main puts main's copy there again.
//! A line is named after its issue's file (issue/001.md is 001).
//!
//!   <data>/repos/<repo>               main's copy
//!   <data>/work/<repo>/<line>/        each issue's copy
//!   <data>/sync/<repo>.line           which one the repo shows now

use crate::remote::{self, Client, Reply};
use crate::repos::Repos;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const MAIN: &str = "main";
type Result<T> = std::result::Result<T, String>;

fn line_file(repo: &str) -> PathBuf {
    crate::paths::data_dir().join("sync").join(format!("{repo}.line"))
}

/// The line `repo` shows now ("main" unless work on an issue was chosen).
pub fn current(repo: &str) -> String {
    fs::read_to_string(line_file(repo)).ok().map(|s| s.trim().to_string()).filter(|s| valid(s)).unwrap_or_else(|| MAIN.into())
}

fn set_current(repo: &str, line: &str) -> Result<()> {
    crate::boundary::private_dir(line_file(repo).parent().unwrap()).map_err(|e| e.to_string())?;
    if line == MAIN { let _ = fs::remove_file(line_file(repo)); return Ok(()); }
    fs::write(line_file(repo), line).map_err(|e| e.to_string())
}

pub fn valid(line: &str) -> bool {
    !line.is_empty() && line.len() <= 64 && line.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && line.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn worktree(repo: &str, line: &str) -> PathBuf {
    crate::paths::data_dir().join("work").join(repo).join(line)
}

/// Every issue's copy of `repo` held here.
pub fn worktrees(repo: &str) -> Vec<(String, PathBuf)> {
    let dir = crate::paths::data_dir().join("work").join(repo);
    let mut out: Vec<(String, PathBuf)> = fs::read_dir(&dir).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| valid(n)).collect();
    out.sort();
    out
}

/// The line for an issue file ("issue/001.md" → "001").
pub fn line_for(issue: &str) -> Option<String> {
    let stem = issue.trim_start_matches('/').strip_prefix("issue/")?.strip_suffix(".md")?;
    valid(stem).then(|| stem.to_string())
}

/// A line as the Remote has it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Line {
    pub line: String,
    #[serde(default)]
    pub issue: String,
    pub head: Option<String>,
    pub pushed: Option<String>,
    pub base: Option<String>,
    #[serde(default, rename = "startedBy")]
    pub started_by: String,
    #[serde(default, rename = "startedAt")]
    pub started_at: u64,
    #[serde(default)]
    pub version: i64,
}

pub fn lines(repo: &str) -> Result<Vec<Line>> {
    let v = Client::open()?.json("GET", &format!("/v1/repos/{repo}/lines"), None)?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

pub fn line(repo: &str, line: &str) -> Result<Option<Line>> {
    match Client::open()?.call("GET", &format!("/v1/repos/{repo}?line={line}"), None)? {
        Reply::Ok(v) => Ok(Some(serde_json::from_value(v).map_err(|e| e.to_string())?)),
        _ => Ok(None),
    }
}

/// Work on `issue` ("issue/001.md"): its line is made on the Remote from
/// main's last commit if it is not there yet, its copy is brought here, and
/// the repo shows it. What was shown before is sent first.
pub fn start(repos: &Repos, repo: &str, issue: &str) -> Result<Line> {
    let stem = line_for(issue).ok_or_else(|| crate::tr!("{} is not an issue file (issue/NNN.md)", "{} は Issue のファイル（issue/NNN.md）ではありません", issue))?;
    let client = Client::open()?;
    // A merged issue is done: its work is main's now.
    let path = format!("issue/{}", issue.trim_start_matches('/').trim_start_matches("issue/"));
    if crate::history::changes_of_repo(repo)?.iter().any(|c| c.issue == path && c.state == "merged") {
        return Err(crate::tr!("{}{} is merged already: its work is in main", "{}{} はもう Merge 済みです。その作業は main にあります", repo, crate::issues::number(&path)));
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
    if remote::connection().is_some() { let _ = remote::sync(repos, repo); }
    show(repos, repo, line)
}

fn show(repos: &Repos, repo: &str, line: &str) -> Result<()> {
    repos.dir(repo)?;
    if line != MAIN {
        let at = worktree(repo, line);
        let fresh = !at.is_dir();
        fs::create_dir_all(&at).map_err(|e| e.to_string())?;
        set_current(repo, line)?;
        if fresh {
            remote::forget_line(repo, line);
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
    }
    let size = crate::usage::allocated(&at);
    fs::remove_dir_all(&at).map_err(|e| e.to_string())?;
    remote::forget_line(repo, line);
    Ok(size)
}

/// Where a directory is, as this OS sees it: in which repo, on which line
/// of work, and the folder inside it ("" at its top).
#[derive(Debug, Clone, PartialEq)]
pub struct Here {
    pub repo: String,
    pub line: String,
    pub folder: String,
}

/// Where `cwd` is: in a repo's copy (`<repos>/<repo>/…`), or an issue's copy
/// of one (`<data>/work/<repo>/<line>/…`); else, in a Prompt, its repo
/// (`$LENGTH3_REPO`).
pub fn here(cwd: &std::path::Path) -> Option<Here> {
    let parts = |rel: &std::path::Path| -> Vec<String> { rel.iter().map(|p| p.to_string_lossy().into_owned()).collect() };
    let repos = crate::paths::repos_dir();
    let repos = repos.canonicalize().unwrap_or(repos);
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    if let Ok(rel) = cwd.strip_prefix(&repos) {
        if let [repo, rest @ ..] = parts(rel).as_slice() {
            if crate::repos::valid_name(repo) {
                return Some(Here { repo: repo.clone(), line: current(repo), folder: rest.join("/") });
            }
        }
    }
    let work = crate::paths::data_dir().join("work");
    let work = work.canonicalize().unwrap_or(work);
    if let Ok(rel) = cwd.strip_prefix(&work) {
        if let [repo, line, rest @ ..] = parts(rel).as_slice() {
            if crate::repos::valid_name(repo) && valid(line) {
                return Some(Here { repo: repo.clone(), line: line.clone(), folder: rest.join("/") });
            }
        }
    }
    std::env::var("LENGTH3_REPO").ok().filter(|r| crate::repos::valid_name(r)).map(|repo| Here { repo, line: MAIN.into(), folder: String::new() })
}

/// Point the repo at `line` without bringing anything (freeing walks each copy).
pub(crate) fn show_for_free(repo: &str, line: &str) -> Result<()> {
    set_current(repo, line)
}
