//! A line's history: its commits, newest first, each said in one line; and how many of a work's commits are its
//! own and how many of those are not pushed yet.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::remote::{self, Client, Reply, Tree};
use crate::repos::store::Repos;
use crate::Result;
use crate::text::title::named;
use serde::Serialize;
use std::collections::HashMap;
use super::changes::places;

/// "Fix：件名" for a commit.
pub fn line(c: &Cut) -> String {
    named(c.kind.as_deref(), &c.title)
}

pub fn log_of(repo: &str, line: &str, n: usize) -> Result<Vec<Cut>> {
    let Ok(client) = Client::open() else { return Ok(Vec::new()) };
    // What each commit changed, as the Remote counted it, without its tree; a Remote that does not count
    // it yet sends the trees, and they are compared here.
    let v = match client.call("GET", &format!("{}{}limit={n}&summary=1", remote::at_path(repo, line, "/log"), if line == crate::repos::lines::MAIN { "?" } else { "&" }), None)? {
        Reply::Ok(v) => v,
        _ => return Ok(Vec::new()),
    };
    let list = v.as_array().cloned().unwrap_or_default();
    let trees: HashMap<String, Tree> = list.iter().filter_map(|c| Some((c["id"].as_str()?.to_string(), remote::tree_of(&c["tree"])))).collect();
    Ok(list.iter().map(|c| {
        let counted = c["files"].as_u64().zip(c["folders"].as_array())
            .map(|(n, f)| (f.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>(), n as usize));
        let (folders, files) = counted.unwrap_or_else(|| {
            let tree = remote::tree_of(&c["tree"]);
            let parent = c["parent"].as_str().and_then(|p| trees.get(p)).cloned().unwrap_or_default();
            places(&parent, &tree)
        });
        let s = |k: &str| c[k].as_str().unwrap_or_default().to_string();
        Cut {
            id: s("id"), issue: Some(s("issue")).filter(|i| !i.is_empty()), kind: Some(s("kind")).filter(|k| !k.is_empty()),
            title: s("title"), note: s("note"), time: c["time"].as_u64().unwrap_or(0), folders, files,
            added: c["added"].as_u64().unwrap_or(0), removed: c["removed"].as_u64().unwrap_or(0),
            merged: c["merged"].as_str().map(String::from), handed: None,
        }
    }).collect())
}

/// The commits of the line `repo` shows (or of `line`), newest first.
pub fn log(repos: &Repos, repo: &str, n: usize) -> Result<Vec<Cut>> {
    log_of(repo, &repos.line(repo), n)
}

/// A cut, as a page shows it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Cut {
    pub id: String,
    /// The issue it was cut under ("issue/001.md"), if any.
    pub issue: Option<String>,
    pub kind: Option<String>,
    pub title: String,
    pub note: String,
    /// Milliseconds since the epoch.
    pub time: u64,
    pub folders: Vec<String>,
    pub files: usize,
    pub added: u64,
    pub removed: u64,
    /// For a merge: the line's commit main took.
    pub merged: Option<String>,
    /// On an issue's work: the version of its change it was handed in as, by itself (none when that did not go:
    /// the next commit hands it in).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handed: Option<i64>,
}

/// How many commits the work on line `l` has made since it began, and how many of them are not pushed yet.
pub(crate) fn progress(repo: &str, l: &remote::Line) -> Result<(usize, usize)> {
    let log = log_of(repo, &l.line, 200)?;
    let mine: Vec<&Cut> = log.iter().take_while(|c| Some(&c.id) != l.base.as_ref()).collect();
    let unpushed = mine.iter().take_while(|c| Some(&c.id) != l.pushed.as_ref()).count();
    Ok((mine.len(), if l.pushed == l.base && !mine.is_empty() { mine.len() } else { unpushed }))
}


