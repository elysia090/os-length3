//! Git in the issues' terms, not git's. An issue is the unit; under it, the
//! person cuts (区切る) their work into history: one commit named after the
//! issue ("Fix：件名") and tied to its file by an `Issue:` trailer. Changes not
//! yet cut are shown by the folder they are in, so a reader enters from the
//! area they look after. Handing a cut out (提出), Merge/Reject by whoever
//! receives it, and Close (issues only) come with a Remote. Branches and
//! worktrees stay inside; anything finer is the git command itself.

use crate::text::{kind_of, named};
use crate::Result;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

/// Git's empty tree, to diff against before the first commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// "added", "modified", "removed" or "renamed".
    pub status: &'static str,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Folder {
    /// Repo-relative folder ("src", "src/net"); "" is the repo's own top.
    pub folder: String,
    pub files: Vec<FileChange>,
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Changes {
    /// False when the repo has no .git.
    pub git: bool,
    pub folders: Vec<Folder>,
    pub files: usize,
    pub added: u64,
    pub removed: u64,
}

/// A cut: one commit, named like an issue.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Commit {
    pub id: String,
    /// The issue it was cut under ("issue/001.md"), if any.
    pub issue: Option<String>,
    pub kind: Option<String>,
    pub title: String,
    pub author: String,
    /// Milliseconds since the epoch.
    pub time: u64,
    pub folders: Vec<String>,
    pub files: usize,
    pub added: u64,
    pub removed: u64,
}

/// git without the host's global or system configuration, never prompting.
fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C")
        .output().map_err(|e| format!("git を起動できませんでした: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn has_head(dir: &Path) -> bool {
    git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

fn folder_of(path: &str) -> String {
    path.rfind('/').map_or(String::new(), |at| path[..at].to_string())
}

/// What is not yet definite, folder by folder.
pub fn changes(dir: &Path) -> Result<Changes> {
    if !dir.join(".git").is_dir() {
        return Ok(Changes { git: false, folders: vec![], files: 0, added: 0, removed: 0 });
    }
    let status = git(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut files: BTreeMap<String, FileChange> = BTreeMap::new();
    let mut parts = status.split('\0').filter(|p| !p.is_empty());
    while let Some(entry) = parts.next() {
        if entry.len() < 4 { continue; }
        let (xy, path) = (&entry[..2], &entry[3..]);
        let status = if xy.contains('R') { parts.next(); "renamed" }
            else if xy == "??" || xy.contains('A') { "added" }
            else if xy.contains('D') { "removed" }
            else { "modified" };
        files.insert(path.to_string(), FileChange { path: path.to_string(), status, added: 0, removed: 0, binary: false });
    }
    // Lines added and removed, against the last commit (or nothing yet). A
    // file git does not track yet is counted from the file itself; reading
    // changes never touches the index.
    let base = if has_head(dir) { "HEAD" } else { EMPTY_TREE };
    if let Ok(numstat) = git(dir, &["diff", "--numstat", base]) {
        for line in numstat.lines() {
            let mut f = line.splitn(3, '\t');
            let (a, r, path) = (f.next().unwrap_or(""), f.next().unwrap_or(""), f.next().unwrap_or(""));
            let path = path.rsplit(" => ").next().unwrap_or(path).trim_end_matches('}');
            if let Some(c) = files.get_mut(path) {
                c.binary = a == "-";
                c.added = a.parse().unwrap_or(0);
                c.removed = r.parse().unwrap_or(0);
            }
        }
    }
    for (path, c) in files.iter_mut().filter(|(_, c)| c.status == "added" && c.added == 0 && !c.binary) {
        if let Ok(bytes) = std::fs::read(dir.join(path)) {
            c.binary = bytes.contains(&0);
            if !c.binary {
                c.added = bytes.iter().filter(|b| **b == b'\n').count() as u64 + u64::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
            }
        }
    }
    let mut by: BTreeMap<String, Folder> = BTreeMap::new();
    for c in files.into_values() {
        let key = folder_of(&c.path);
        let f = by.entry(key.clone()).or_insert(Folder { folder: key, files: vec![], added: 0, removed: 0 });
        f.added += c.added;
        f.removed += c.removed;
        f.files.push(c);
    }
    let folders: Vec<Folder> = by.into_values().collect();
    let count = folders.iter().map(|f| f.files.len()).sum();
    let (added, removed) = folders.iter().fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
    Ok(Changes { git: true, folders, files: count, added, removed })
}

/// Cut everything not yet cut into one commit named `line` ("Kind：件名"),
/// tied to `issue` ("issue/001.md") when given. `who` is (name, email).
pub fn commit(dir: &Path, line: &str, detail: &str, issue: Option<&str>, who: (&str, &str)) -> Result<Commit> {
    let (kind, title) = kind_of(line);
    if title.trim().is_empty() {
        return Err("区切るには件名がいります（例: Fix：件名）".into());
    }
    if changes(dir)?.files == 0 {
        return Err("まだ区切っていない変更がありません".into());
    }
    let head = named(kind.as_deref(), &title);
    let mut message = if detail.trim().is_empty() { head } else { format!("{head}\n\n{}", detail.trim()) };
    if let Some(i) = issue {
        message = format!("{message}\n\nIssue: {i}");
    }
    git(dir, &["add", "-A"])?;
    let name = format!("user.name={}", who.0);
    let email = format!("user.email={}", who.1);
    git(dir, &["-c", &name, "-c", &email, "commit", "-q", "-m", &message])?;
    log(dir, 1)?.into_iter().next().ok_or_else(|| "区切れませんでした".into())
}

/// Cut under an issue: the commit takes the issue's name and points at its file.
pub fn cut_under(dir: &Path, issue: &crate::issues::Issue, note: &str, who: (&str, &str)) -> Result<Commit> {
    let line = named(issue.kind.as_deref(), &issue.title);
    commit(dir, &line, note, Some(&format!("issue/{}", issue.file)), who)
}

/// The cuts so far, newest first.
pub fn log(dir: &Path, n: usize) -> Result<Vec<Commit>> {
    if !dir.join(".git").is_dir() || !has_head(dir) {
        return Ok(Vec::new());
    }
    let count = format!("-n{n}");
    let text = git(dir, &["log", &count, "--format=%x1e%h%x1f%an%x1f%at%x1f%s%x1f%(trailers:key=Issue,valueonly,separator=%x2c)", "--numstat"])?;
    let mut out = Vec::new();
    for record in text.split('\u{1e}').filter(|r| !r.trim().is_empty()) {
        let mut lines = record.lines();
        let head: Vec<&str> = lines.next().unwrap_or("").split('\u{1f}').collect();
        if head.len() < 4 { continue; }
        let (kind, title) = kind_of(head[3]);
        let issue = head.get(4).map(|v| v.trim()).filter(|v| !v.is_empty()).map(|v| v.split(',').next().unwrap().trim().to_string());
        let (mut files, mut added, mut removed) = (0, 0, 0);
        let mut folders: Vec<String> = Vec::new();
        for l in lines.filter(|l| !l.trim().is_empty()) {
            let mut f = l.splitn(3, '\t');
            added += f.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            removed += f.next().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
            let folder = folder_of(f.next().unwrap_or(""));
            if !folders.contains(&folder) { folders.push(folder); }
            files += 1;
        }
        out.push(Commit { id: head[0].into(), issue, kind, title, author: head[1].into(),
            time: head[2].parse::<u64>().unwrap_or(0) * 1000, folders, files, added, removed });
    }
    Ok(out)
}

/// Who makes changes definite: the Home profile's name and handle.
pub fn author() -> (String, String) {
    let p: serde_json::Value = crate::home::get("profile").ok().flatten()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let handle = p["handle"].as_str().filter(|h| !h.is_empty()).unwrap_or("me").to_string();
    let name = p["name"].as_str().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| handle.clone());
    (name, format!("{handle}@localhost"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::Repos;

    #[test]
    fn changes_are_grouped_by_folder_made_definite_and_listed() {
        let root = std::env::temp_dir().join(format!("length3-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let r = Repos::new(root.clone()).unwrap();
        r.create("a", "c").unwrap();
        let dir = root.join("a");
        if !dir.join(".git").is_dir() { return; } // no git on this host
        let c = changes(&dir).unwrap();
        assert!(c.git && c.files == 3, "{c:?}");
        assert_eq!(c.folders.iter().map(|f| f.folder.as_str()).collect::<Vec<_>>(), ["", "src"]);
        assert_eq!(c.folders[1].files[0].status, "added");
        assert!(c.added > 0);
        assert!(commit(&dir, "  ", "", None, ("n", "n@localhost")).is_err());
        let first = commit(&dir, "Patch：はじめの形", "テンプレートから", None, ("Ren", "ren@localhost")).unwrap();
        assert_eq!((first.kind.as_deref(), first.title.as_str(), first.files), (Some("Patch"), "はじめの形", 3));
        assert_eq!(changes(&dir).unwrap().files, 0);
        assert!(commit(&dir, "Fix：何もない", "", None, ("n", "n@localhost")).is_err());
        std::fs::write(dir.join("src/main.c"), "int main(void) { return 1; }\n").unwrap();
        let c = changes(&dir).unwrap();
        assert_eq!((c.files, c.folders[0].folder.as_str(), c.folders[0].files[0].status), (1, "src", "modified"));
        commit(&dir, "Fix：終了コード", "", Some("issue/001.md"), ("Ren", "ren@localhost")).unwrap();
        let log = log(&dir, 10).unwrap();
        assert_eq!(log.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["終了コード", "はじめの形"]);
        assert_eq!((log[0].issue.as_deref(), log[1].issue.as_deref()), (Some("issue/001.md"), None));
        assert_eq!(log[0].folders, ["src"]);
        assert_eq!(log[0].author, "Ren");
    }
}
