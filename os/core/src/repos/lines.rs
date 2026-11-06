//! Lines of work as this device keeps them: each issue's work is a line of its own (a branch on the Remote) with a
//! copy of its own here (a worktree), named after its issue's file (issue/001.md is 001). Which line a repo shows is
//! one small file; main shows when there is none.
//!
//!   <data>/repos/<repo>               main's copy
//!   <data>/work/<repo>/<line>/        each issue's copy
//!   <data>/sync/<repo>.line           which one the repo shows now
//!
//! Starting, switching and finishing work (which also speak with the Remote) are history/work.rs's.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::fs;
use std::path::PathBuf;

type Result<T> = std::result::Result<T, String>;

/// Point the repo at `line` without bringing anything (freeing walks each copy).
pub(crate) fn show_for_free(repo: &str, line: &str) -> Result<()> {
    set_current(repo, line)
}

/// Where `cwd` is: in a repo's copy (`<repos>/<repo>/…`), or an issue's copy
/// of one (`<data>/work/<repo>/<line>/…`); else, in a Prompt, its repo
/// (`$LENGTH3_REPO`).
pub fn here(cwd: &std::path::Path) -> Option<Here> {
    let parts = |rel: &std::path::Path| -> Vec<String> { rel.iter().map(|p| p.to_string_lossy().into_owned()).collect() };
    let repos = crate::fs::paths::repos_dir();
    let repos = repos.canonicalize().unwrap_or(repos);
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    if let Ok(rel) = cwd.strip_prefix(&repos) {
        if let [repo, rest @ ..] = parts(rel).as_slice() {
            if crate::text::names::valid_name(repo) {
                return Some(Here { repo: repo.clone(), line: current(repo), folder: rest.join("/") });
            }
        }
    }
    let work = crate::fs::paths::data_dir().join("work");
    let work = work.canonicalize().unwrap_or(work);
    if let Ok(rel) = cwd.strip_prefix(&work) {
        if let [repo, line, rest @ ..] = parts(rel).as_slice() {
            if crate::text::names::valid_name(repo) && valid(line) {
                return Some(Here { repo: repo.clone(), line: line.clone(), folder: rest.join("/") });
            }
        }
    }
    std::env::var("LENGTH3_REPO").ok().filter(|r| crate::text::names::valid_name(r)).map(|repo| Here { repo, line: MAIN.into(), folder: String::new() })
}

/// Where a directory is, as this OS sees it: in which repo, on which line
/// of work, and the folder inside it ("" at its top).
#[derive(Debug, Clone, PartialEq)]
pub struct Here {
    pub repo: String,
    pub line: String,
    pub folder: String,
}

/// The line for an issue file ("issue/001.md" → "001").
pub fn line_for(issue: &str) -> Option<String> {
    let stem = issue.trim_start_matches('/').strip_prefix("issue/")?.strip_suffix(".md")?;
    valid(stem).then(|| stem.to_string())
}

/// Every issue's copy of `repo` held here.
pub fn worktrees(repo: &str) -> Vec<(String, PathBuf)> {
    let dir = crate::fs::paths::data_dir().join("work").join(repo);
    let mut out: Vec<(String, PathBuf)> = fs::read_dir(&dir).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir()).map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(n, _)| valid(n)).collect();
    out.sort();
    out
}

pub fn worktree(repo: &str, line: &str) -> PathBuf {
    crate::fs::paths::data_dir().join("work").join(repo).join(line)
}

pub fn valid(line: &str) -> bool {
    !line.is_empty() && line.len() <= 64 && line.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && line.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub(crate) fn set_current(repo: &str, line: &str) -> Result<()> {
    let file = line_file(repo);
    crate::fs::write::private_dir(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let done = if line == MAIN {
        // Not there is main already; one that stays would keep the repo on the issue's copy.
        fs::remove_file(&file).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
    } else {
        // Whole: a crash part way through left it empty (main) or naming a line with no copy.
        crate::fs::write::replace(&file, line.as_bytes(), crate::fs::write::How::RECORD)
    };
    done.map_err(|e| crate::tr!("{}: {}", "{}：{}", file.display(), e))
}

/// The line `repo` shows now ("main" unless work on an issue was chosen).
pub fn current(repo: &str) -> String {
    fs::read_to_string(line_file(repo)).ok().map(|s| s.trim().to_string()).filter(|s| valid(s)).unwrap_or_else(|| MAIN.into())
}

fn line_file(repo: &str) -> PathBuf {
    crate::fs::paths::data_dir().join("sync").join(format!("{repo}.line"))
}

pub const MAIN: &str = "main";

