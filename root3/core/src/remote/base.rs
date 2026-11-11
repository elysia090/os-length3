//! What was last agreed with the Remote, per repo and line (the base): the version read, its tree and the head;
//! the lock one repo's sync holds; and where these are kept (`<data>/sync/`).

use crate::repos::store::Repos;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use crate::Result;
use super::connection::{gone, sync_dir};
use super::local::{Modes, Tree};

pub(crate) fn tree_of(v: &serde_json::Value) -> Tree {
    v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from))).collect()).unwrap_or_default()
}

pub(crate) fn at_path(repo: &str, line: &str, rest: &str) -> String { at(repo, line, rest) }

pub(super) fn lock(repo: &str) -> Result<Lock> {
    crate::fs::write::private_dir(&sync_dir()).map_err(|e| e.to_string())?;
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(sync_dir().join(format!("{repo}.lock"))).map_err(|e| e.to_string())?;
    // The browser's core is one instance at a time, and has no locks to take.
    match f.lock() { Err(e) if e.kind() != std::io::ErrorKind::Unsupported => return Err(e.to_string()), _ => {} }
    Ok(Lock(f))
}

/// One sync of a repo at a time, across the app and root3 alike.
pub(super) struct Lock(fs::File);

impl Drop for Lock {
    /// Let go of as soon as it is done with (closing the file would too).
    fn drop(&mut self) { let _ = self.0.unlock(); }
}

/// Nothing is agreed for `repo` any more; one left behind would be taken for what the Remote has.
pub(super) fn forget_base(repo: &str) -> Result<()> {
    gone(fs::remove_file(base_file(repo)))
}

/// A refused cut says where the Remote's head is.
pub(crate) fn set_head_from(key: &str, v: &serde_json::Value) -> Result<()> {
    let repo = key;
    let b = base(repo).unwrap_or_default();
    set_base(repo, &Base { head: v["head"].as_str().map(String::from), ..b })
}

/// A cut was made at the base's version: it is the head now.
pub(crate) fn set_head(key: &str, id: &str) -> Result<()> {
    let repo = key;
    let b = base(repo).unwrap_or_default();
    set_base(repo, &Base { head: Some(id.into()), ..b })
}

pub(super) fn set_base(repo: &str, b: &Base) -> Result<()> {
    crate::fs::write::private_dir(&sync_dir()).map_err(|e| e.to_string())?;
    let path = base_file(repo);
    // Durable: it is the record of what the Remote agreed, which every later sync goes by.
    crate::fs::write::replace(&path, &serde_json::to_vec(b).map_err(|e| e.to_string())?, crate::fs::write::How::RECORD)
        .map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))
}

pub fn base(repo: &str) -> Option<Base> {
    serde_json::from_slice(&fs::read(base_file(repo)).ok()?).ok()
}

fn base_file(repo: &str) -> PathBuf {
    sync_dir().join(format!("{repo}.json"))
}

/// An issue's work was brought here afresh: nothing is agreed for it yet.
pub fn forget_line(repo: &str, line: &str) -> Result<()> {
    forget_base(&key_of(repo, line))
}

/// The Remote's address of a line: the repo, and the line when not main.
pub(super) fn at(repo: &str, line: &str, rest: &str) -> String {
    let q = if line == crate::repos::lines::MAIN { String::new() } else { format!("?line={line}") };
    format!("/v1/repos/{repo}{rest}{q}")
}

pub fn key_of(repo: &str, line: &str) -> String {
    if line == crate::repos::lines::MAIN { repo.to_string() } else { format!("{repo}@{line}") }
}

/// The key of the line `repo` shows now, and that line.
pub fn key(repos: &Repos, repo: &str) -> (String, String) {
    let line = repos.line(repo);
    (key_of(repo, &line), line)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Base {
    pub version: i64,
    pub tree: Tree,
    pub head: Option<String>,
    /// The modes agreed with the tree; none kept before modes were (an old base reads as none).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modes: Modes,
    /// Whether the Remote said it keeps modes when this was agreed (one before modes were keeps none).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moded: bool,
    /// The account it was agreed with (its id); none from before accounts were noted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
}

