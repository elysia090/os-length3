//! History in the issues' terms. The draft (remote.rs) is always on the
//! Remote; history is made only by 区切る: the draft at a version becomes a
//! cut, named like an issue ("Fix：件名") and tied to its file when made
//! under one. What is not yet cut is the draft against the last cut, shown
//! by the folder it is in, so a reader enters from the area they look after.
//! The same on every host: the app, l3, and the browser (src/history.ts).

use crate::linediff::{self, Kind};
use crate::remote::{self, Client, Reply, Tree};
use crate::repos::Repos;
use crate::text::{kind_of, named};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// "added", "modified" or "removed".
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
    /// Whether this device is on a Remote (without one nothing can be cut).
    pub connected: bool,
    pub folders: Vec<Folder>,
    pub files: usize,
    pub added: u64,
    pub removed: u64,
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
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DiffLine {
    /// "hunk" (where), "add", "del" or "same".
    pub kind: &'static str,
    pub text: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileDiff {
    pub path: String,
    pub status: &'static str,
    pub binary: bool,
    pub lines: Vec<DiffLine>,
    /// Lines left out past the limit.
    pub more: usize,
}

/// Texts compared line by line at most this large; past it, by name only.
const TEXT_LIMIT: usize = 1 << 20;

fn folder_of(path: &str) -> String {
    path.rfind('/').map_or(String::new(), |at| path[..at].to_string())
}

// ---- the last cut's tree, and blobs read from the Remote ----

#[derive(Serialize, Deserialize, Default)]
struct Head { id: Option<String>, tree: Tree }

fn head_file(repo: &str) -> std::path::PathBuf {
    crate::paths::data_dir().join("sync").join(format!("{repo}.head.json"))
}

/// The tree of the cut the draft is on (empty before the first).
fn head_tree(client: &Client, repo: &str, head: Option<&str>) -> Result<Tree> {
    let Some(id) = head else { return Ok(Tree::new()) };
    let kept: Head = fs::read(head_file(repo)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if kept.id.as_deref() == Some(id) {
        return Ok(kept.tree);
    }
    let tree = match client.call("GET", &format!("/v1/repos/{repo}/cuts/{id}"), None)? {
        Reply::Ok(v) => remote::tree_of(&v["tree"]),
        _ => return Err("Remote に区切りがありません".into()),
    };
    if let Ok(b) = serde_json::to_vec(&Head { id: Some(id.into()), tree: tree.clone() }) {
        let _ = fs::write(head_file(repo), b);
    }
    Ok(tree)
}

fn blobs() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static B: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

fn blob(client: &Client, sha: &str) -> Result<Vec<u8>> {
    if let Some(b) = blobs().lock().map_err(|e| e.to_string())?.get(sha) {
        return Ok(b.clone());
    }
    let b = client.blob(sha)?;
    if b.len() <= TEXT_LIMIT {
        blobs().lock().map_err(|e| e.to_string())?.insert(sha.into(), b.clone());
    }
    Ok(b)
}

fn text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > TEXT_LIMIT || bytes.contains(&0) { None } else { String::from_utf8(bytes.to_vec()).ok() }
}

/// One file's before and after: (status, before text, after text, binary).
struct Pair { path: String, status: &'static str, before: Option<String>, after: Option<String>, binary: bool }

fn pairs(client: Option<&Client>, repos: &Repos, repo: &str, then: &Tree, now: &Tree) -> Result<Vec<Pair>> {
    let dir = repos.dir(repo)?;
    let mut out = Vec::new();
    let paths: std::collections::BTreeSet<&String> = then.keys().chain(now.keys()).collect();
    for path in paths {
        let (was, is) = (then.get(path), now.get(path));
        if was == is { continue; }
        // Folders count through their files.
        if matches!(was, Some(None) | None) && matches!(is, Some(None) | None) { continue; }
        let status = match (was, is) { (Some(Some(_)), Some(Some(_))) => "modified", (_, Some(Some(_))) => "added", _ => "removed" };
        let before = match (client, was) {
            (Some(c), Some(Some(sha))) => Some(blob(c, sha)?),
            _ => None,
        };
        let after = match is { Some(Some(_)) => fs::read(dir.join(path)).ok(), _ => None };
        let binary = before.as_deref().is_some_and(|b| text(b).is_none()) || after.as_deref().is_some_and(|b| text(b).is_none());
        out.push(Pair {
            path: path.clone(), status, binary,
            before: before.as_deref().and_then(text), after: after.as_deref().and_then(text),
        });
    }
    Ok(out)
}

/// The draft here and the last cut, as the Remote has them.
fn draft_and_head(repos: &Repos, repo: &str) -> Result<(Option<Client>, Tree, Tree)> {
    let now = remote::local_tree(&repos.dir(repo)?).tree;
    let Ok(client) = Client::open() else { return Ok((None, Tree::new(), now)) };
    let head = remote::base(repo).and_then(|b| b.head);
    let then = head_tree(&client, repo, head.as_deref())?;
    Ok((Some(client), then, now))
}

fn group(files: Vec<FileChange>, connected: bool) -> Changes {
    let mut by: BTreeMap<String, Folder> = BTreeMap::new();
    for c in files {
        let key = folder_of(&c.path);
        let f = by.entry(key.clone()).or_insert(Folder { folder: key, files: vec![], added: 0, removed: 0 });
        f.added += c.added;
        f.removed += c.removed;
        f.files.push(c);
    }
    let folders: Vec<Folder> = by.into_values().collect();
    let files = folders.iter().map(|f| f.files.len()).sum();
    let (added, removed) = folders.iter().fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
    Changes { connected, folders, files, added, removed }
}

fn changes_of(client: Option<&Client>, repos: &Repos, repo: &str, then: &Tree, now: &Tree) -> Result<Changes> {
    let files = pairs(client, repos, repo, then, now)?.into_iter().map(|p| {
        let (added, removed) = if p.binary { (0, 0) } else {
            linediff::counts(&linediff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or("")))
        };
        FileChange { path: p.path, status: p.status, added, removed, binary: p.binary }
    }).collect();
    Ok(group(files, client.is_some()))
}

/// What is not yet cut, folder by folder.
pub fn changes(repos: &Repos, repo: &str) -> Result<Changes> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    changes_of(client.as_ref(), repos, repo, &then, &now)
}

/// The same, line by line, at most `limit` lines in all.
pub fn diff(repos: &Repos, repo: &str, limit: usize) -> Result<Vec<FileDiff>> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    let mut left = limit;
    let mut out = Vec::new();
    for p in pairs(client.as_ref(), repos, repo, &then, &now)? {
        let mut lines = Vec::new();
        if !p.binary {
            let ops = linediff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or(""));
            // Three lines either side of a change, as git shows them.
            let keep: Vec<bool> = (0..ops.len()).map(|i| ops[i.saturating_sub(3)..(i + 4).min(ops.len())].iter().any(|(k, _)| *k != Kind::Same)).collect();
            for (i, (k, t)) in ops.iter().enumerate() {
                if !keep[i] { continue; }
                if i > 0 && !keep[i - 1] { lines.push(DiffLine { kind: "hunk", text: "…".into() }); }
                lines.push(DiffLine { kind: match k { Kind::Add => "add", Kind::Del => "del", Kind::Same => "same" }, text: t.to_string() });
            }
        }
        let keep = lines.len().min(left);
        let more = lines.len() - keep;
        lines.truncate(keep);
        left -= keep;
        out.push(FileDiff { path: p.path, status: p.status, binary: p.binary, lines, more });
    }
    Ok(out)
}

/// The words a cut goes by: an issue's first line (and its file), or the line given.
fn words(repos: &Repos, repo: &str, issue: Option<&str>, line: &str) -> Result<(Option<String>, String, String)> {
    match issue {
        Some(file) => {
            let file = file.trim_start_matches("issue/");
            let text = repos.read(repo, &format!("issue/{file}"), 256 * 1024)?.text.ok_or("Issue がバイナリです")?;
            let i = crate::issues::parse(repo, file, &text);
            Ok((i.kind, i.title, format!("issue/{file}")))
        }
        None => {
            let (kind, title) = kind_of(line);
            Ok((kind, title, String::new()))
        }
    }
}

/// 区切る: bring the draft into step with the Remote, then make it a cut,
/// under `issue` (its file in issue/) and named after it, or named by `line`.
pub fn cut(repos: &Repos, repo: &str, issue: Option<&str>, line: &str, note: &str) -> Result<Cut> {
    let (kind, title, issue) = words(repos, repo, issue, line)?;
    if title.trim().is_empty() {
        return Err("区切るには件名がいります（例: Fix：件名）".into());
    }
    let client = Client::open().map_err(|_| "区切りは Remote に残ります。先につないでください（l3 login）".to_string())?;
    for _ in 0..4 {
        let s = remote::sync(repos, repo)?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(format!("Remote に送れないものがあります（{path}: {why}）。送れるようにしてから区切ってください"));
        }
        let b = remote::base(repo).unwrap_or_default();
        let then = head_tree(&client, repo, b.head.as_deref())?;
        let c = changes_of(Some(&client), repos, repo, &then, &b.tree)?;
        if c.files == 0 {
            return Err("まだ区切っていない変更がありません".into());
        }
        let body = serde_json::json!({
            "version": s.version, "parent": b.head, "kind": kind.clone().unwrap_or_default(), "title": title.trim(),
            "issue": issue, "note": note.trim(), "added": c.added, "removed": c.removed,
        });
        match client.call("POST", &format!("/v1/repos/{repo}/cuts"), Some(body))? {
            Reply::Ok(v) => {
                let id = v["id"].as_str().unwrap_or_default().to_string();
                let _ = remote::set_head(repo, &id);
                return Ok(Cut {
                    id, issue: (!issue.is_empty()).then_some(issue), kind, title: title.trim().into(), note: note.trim().into(),
                    time: v["time"].as_u64().unwrap_or(0), folders: c.folders.iter().map(|f| f.folder.clone()).collect(),
                    files: c.files, added: c.added, removed: c.removed,
                });
            }
            // Another device moved the draft or cut first: in step again, and once more.
            Reply::Conflict(v) => { let _ = remote::set_head_from(repo, &v); }
            Reply::NotFound => return Err("Remote にこの repo がありません".into()),
        }
    }
    Err("Remote が動き続けていて区切れませんでした".into())
}

/// The cuts so far, newest first.
pub fn log(repo: &str, n: usize) -> Result<Vec<Cut>> {
    let Ok(client) = Client::open() else { return Ok(Vec::new()) };
    let v = match client.call("GET", &format!("/v1/repos/{repo}/log?limit={n}"), None)? {
        Reply::Ok(v) => v,
        _ => return Ok(Vec::new()),
    };
    let list = v.as_array().cloned().unwrap_or_default();
    let trees: HashMap<String, Tree> = list.iter().filter_map(|c| Some((c["id"].as_str()?.to_string(), remote::tree_of(&c["tree"])))).collect();
    Ok(list.iter().map(|c| {
        let tree = remote::tree_of(&c["tree"]);
        let parent = c["parent"].as_str().and_then(|p| trees.get(p)).cloned().unwrap_or_default();
        let changed: Vec<&String> = tree.keys().chain(parent.keys()).filter(|p| tree.get(*p) != parent.get(*p))
            .filter(|p| matches!(tree.get(*p), Some(Some(_))) || matches!(parent.get(*p), Some(Some(_)))).collect();
        let mut folders: Vec<String> = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for p in &changed { if seen.insert((*p).clone()) { let f = folder_of(p); if !folders.contains(&f) { folders.push(f); } } }
        let s = |k: &str| c[k].as_str().unwrap_or_default().to_string();
        Cut {
            id: s("id"), issue: Some(s("issue")).filter(|i| !i.is_empty()), kind: Some(s("kind")).filter(|k| !k.is_empty()),
            title: s("title"), note: s("note"), time: c["time"].as_u64().unwrap_or(0), folders, files: seen.len(),
            added: c["added"].as_u64().unwrap_or(0), removed: c["removed"].as_u64().unwrap_or(0),
        }
    }).collect())
}

/// "Fix：件名" for a cut.
pub fn line(c: &Cut) -> String {
    named(c.kind.as_deref(), &c.title)
}
