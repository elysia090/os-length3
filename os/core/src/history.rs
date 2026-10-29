//! History in the issues' terms (issue #17). An issue is the unit of work;
//! its branch and worktree are the OS's to keep (work.rs). The operations
//! a person does are few, and are the same from the app, l3 and a browser
//! (src/repos/history.ts):
//!
//!   Commit         what is not committed becomes history on the work's line,
//!                  named after its issue ("Fix：件名")
//!   Push           the line's commits are handed to the Remote as its state
//!   Change         what was pushed goes to main as a change; again after more
//!                  commits, as its next version; Reset takes it back
//!   Review         of one version of a change: approve, ask for changes, comment
//!   Merge, Reject  the receiver's: main takes the change, or does not
//!
//! What is not committed is the draft against the line's last commit, shown
//! by the folder it is in, so a reader enters from the area they look after.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

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
    /// For a merge: the line's commit main took.
    pub merged: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DiffLine {
    /// "hunk" (where), "add", "del" or "same".
    pub kind: &'static str,
    pub text: String,
    /// Which line it is: in the new text for "add" and "same", in the old for "del".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<usize>,
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

fn head_file(key: &str) -> std::path::PathBuf {
    crate::paths::data_dir().join("sync").join(format!("{key}.head.json"))
}

/// The tree of a commit (empty before the first), kept for the line `key` it was last asked for.
fn head_tree(client: &Client, repo: &str, key: &str, head: Option<&str>) -> Result<Tree> {
    let Some(id) = head else { return Ok(Tree::new()) };
    let kept: Head = fs::read(head_file(key)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if kept.id.as_deref() == Some(id) {
        return Ok(kept.tree);
    }
    let tree = tree_at(client, repo, id)?;
    // Kept to spare the next read; not kept, the next read asks again.
    if let Ok(b) = serde_json::to_vec(&Head { id: Some(id.into()), tree: tree.clone() }) {
        let _ = crate::atomic::replace(&head_file(key), &b, crate::atomic::How::CACHE);
    }
    Ok(tree)
}

fn tree_at(client: &Client, repo: &str, id: &str) -> Result<Tree> {
    match client.call("GET", &format!("/v1/repos/{repo}/cuts/{id}"), None)? {
        Reply::Ok(v) => Ok(remote::tree_of(&v["tree"])),
        _ => Err(crate::tr!("The Remote has no such commit", "Remote にそのコミットがありません")),
    }
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

/// Bring the blobs named here at once (POST /v1/blobs/read), so a diff of many files is one wait, not one each.
/// What the Remote does not answer in it (too much for one answer, or a Remote without the route) is read
/// one by one, later, as before.
fn prefetch(client: &Client, shas: Vec<&String>) {
    use base64::Engine;
    let Ok(cache) = blobs().lock() else { return };
    let mut wanted: Vec<&String> = shas.into_iter().filter(|s| !cache.contains_key(*s)).collect();
    wanted.sort();
    wanted.dedup();
    if wanted.len() < 2 { return; }
    drop(cache);
    for chunk in wanted.chunks(64) {
        let Ok(v) = client.json("POST", "/v1/blobs/read", Some(serde_json::json!(chunk))) else { return };
        let Ok(mut cache) = blobs().lock() else { return };
        for (sha, b64) in v.as_object().into_iter().flatten() {
            let Some(bytes) = b64.as_str().and_then(|t| base64::engine::general_purpose::STANDARD.decode(t).ok()) else { continue };
            // Only what its name says: a digest is the file's own proof.
            if remote::sha256(&bytes) == *sha && bytes.len() <= TEXT_LIMIT { cache.insert(sha.clone(), bytes); }
        }
    }
}

fn text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > TEXT_LIMIT || bytes.contains(&0) { None } else { String::from_utf8(bytes.to_vec()).ok() }
}

/// One file's before and after: (status, before text, after text, binary).
struct Pair { path: String, status: &'static str, before: Option<String>, after: Option<String>, binary: bool }

/// Where the newer side's bytes are: the files here, or the Remote's blobs.
enum After<'a> { Here(std::path::PathBuf), Remote(&'a Client) }

fn pairs(client: Option<&Client>, after_from: After, then: &Tree, now: &Tree) -> Result<Vec<Pair>> {
    let mut out = Vec::new();
    let paths: std::collections::BTreeSet<&String> = then.keys().chain(now.keys()).collect();
    if let Some(c) = client {
        let remote_after = matches!(after_from, After::Remote(_));
        let mut need: Vec<&String> = Vec::new();
        for p in paths.iter().filter(|p| then.get(**p) != now.get(**p)) {
            if let Some(Some(sha)) = then.get(*p) { need.push(sha); }
            if let (true, Some(Some(sha))) = (remote_after, now.get(*p)) { need.push(sha); }
        }
        prefetch(c, need);
    }
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
        let after = match (is, &after_from) {
            (Some(Some(_)), After::Here(dir)) => fs::read(dir.join(path)).ok(),
            (Some(Some(sha)), After::Remote(c)) => Some(blob(c, sha)?),
            _ => None,
        };
        let binary = before.as_deref().is_some_and(|b| text(b).is_none()) || after.as_deref().is_some_and(|b| text(b).is_none());
        out.push(Pair {
            path: path.clone(), status, binary,
            before: before.as_deref().and_then(text), after: after.as_deref().and_then(text),
        });
    }
    Ok(out)
}

/// The draft here and the work's last commit, as the Remote has them.
fn draft_and_head(repos: &Repos, repo: &str) -> Result<(Option<Client>, Tree, Tree)> {
    let now = remote::local_tree(&repos.dir(repo)?).tree;
    let Ok(client) = Client::open() else { return Ok((None, Tree::new(), now)) };
    let (key, _) = remote::key(repos, repo);
    let head = remote::base(&key).and_then(|b| b.head);
    let then = head_tree(&client, repo, &key, head.as_deref())?;
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

fn changes_of(client: Option<&Client>, after: After, then: &Tree, now: &Tree) -> Result<Changes> {
    let files = pairs(client, after, then, now)?.into_iter().map(|p| {
        let (added, removed) = if p.binary { (0, 0) } else {
            linediff::counts(&linediff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or("")))
        };
        FileChange { path: p.path, status: p.status, added, removed, binary: p.binary }
    }).collect();
    Ok(group(files, client.is_some()))
}

/// What is not committed yet, folder by folder.
pub fn changes(repos: &Repos, repo: &str) -> Result<Changes> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    changes_of(client.as_ref(), After::Here(repos.dir(repo)?), &then, &now)
}

/// The same, line by line, at most `limit` lines in all.
pub fn diff(repos: &Repos, repo: &str, limit: usize) -> Result<Vec<FileDiff>> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    diff_of(pairs(client.as_ref(), After::Here(repos.dir(repo)?), &then, &now)?, limit)
}

/// A file as it was at the last commit of what the repo shows, to put it
/// back: its text, or none when it was not there (it was added since).
pub fn at_head(repos: &Repos, repo: &str, path: &str) -> Result<Option<String>> {
    let (client, then, _) = draft_and_head(repos, repo)?;
    // Without the Remote, the last commit is not known here: nothing is put back on a guess.
    let client = client.ok_or_else(|| crate::tr!("The last commit is kept on the Remote. Connect first (l3 login)", "最後のコミットは Remote にあります。先につないでください（l3 login）"))?;
    match then.get(path) {
        Some(Some(sha)) => text(&blob(&client, sha)?).map(Some)
            .ok_or_else(|| crate::tr!("{} is binary; it cannot be put back here", "{} はバイナリなので、ここでは戻せません", path)),
        _ => Ok(None),
    }
}

fn diff_of(pairs: Vec<Pair>, limit: usize) -> Result<Vec<FileDiff>> {
    let mut left = limit;
    let mut out = Vec::new();
    for p in pairs {
        let mut lines = Vec::new();
        if !p.binary {
            let ops = linediff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or(""));
            // Three lines either side of a change, as git shows them.
            let keep: Vec<bool> = (0..ops.len()).map(|i| ops[i.saturating_sub(3)..(i + 4).min(ops.len())].iter().any(|(k, _)| *k != Kind::Same)).collect();
            // Line numbers in the old and the new text, counted as the lines go by.
            let (mut old, mut new) = (0usize, 0usize);
            for (i, (k, t)) in ops.iter().enumerate() {
                let at = match k { Kind::Del => { old += 1; old } Kind::Add => { new += 1; new } Kind::Same => { old += 1; new += 1; new } };
                if !keep[i] { continue; }
                if i > 0 && !keep[i - 1] { lines.push(DiffLine { kind: "hunk", text: "…".into(), at: None }); }
                lines.push(DiffLine { kind: match k { Kind::Add => "add", Kind::Del => "del", Kind::Same => "same" }, text: t.to_string(), at: Some(at) });
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

/// The words a commit goes by: an issue's first line (and its file), or the line given.
fn words(repos: &Repos, repo: &str, issue: Option<&str>, line: &str) -> Result<(Option<String>, String, String)> {
    // Work on an issue commits under it, whatever else is said.
    let on = repos.line(repo);
    let issue = issue.map(String::from).or_else(|| (on != crate::work::MAIN).then(|| format!("issue/{on}.md")));
    match issue {
        Some(file) => {
            let file = file.trim_start_matches("issue/").to_string();
            let text = repos.read(repo, &format!("issue/{file}"), 256 * 1024)?.text.ok_or_else(|| crate::tr!("The issue is not text", "Issue がバイナリです"))?;
            let i = crate::issues::parse(repo, &file, &text);
            Ok((i.kind, i.title, format!("issue/{file}")))
        }
        None => {
            let (kind, title) = kind_of(line);
            Ok((kind, title, String::new()))
        }
    }
}

/// Commit: bring the draft into step with the Remote, then make it history
/// on the line the repo shows, under `issue` (its file in issue/) and named
/// after it, or named by `line`. Work on an issue commits under that issue.
pub fn cut(repos: &Repos, repo: &str, issue: Option<&str>, line: &str, note: &str) -> Result<Cut> {
    let (kind, title, issue) = words(repos, repo, issue, line)?;
    if title.trim().is_empty() {
        return Err(crate::tr!("A commit needs a title (for example Fix：title)", "Commit するには件名がいります（たとえば Fix：件名）"));
    }
    let client = Client::open().map_err(|_| crate::tr!("Commits are kept on the Remote. Sign in to it first (l3 login)", "コミットは Remote に残ります。先に Remote にサインインしてください（l3 login）"))?;
    let (key, on) = remote::key(repos, repo);
    for _ in 0..4 {
        let s = remote::sync(repos, repo)?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(crate::tr!("Something cannot be sent to the Remote ({}: {}); make it sendable, then commit", "Remote に送れないものがあります（{}: {}）。送れるようにしてから Commit してください", path, why));
        }
        let b = remote::base(&key).unwrap_or_default();
        let then = head_tree(&client, repo, &key, b.head.as_deref())?;
        let c = changes_of(Some(&client), After::Here(repos.dir(repo)?), &then, &b.tree)?;
        if c.files == 0 {
            return Err(crate::tr!("Nothing to commit", "まだ Commit していない変更がありません"));
        }
        let body = serde_json::json!({
            "version": s.version, "parent": b.head, "kind": kind.clone().unwrap_or_default(), "title": title.trim(),
            "issue": issue, "note": note.trim(), "added": c.added, "removed": c.removed,
        });
        match client.call("POST", &remote::at_path(repo, &on, "/cuts"), Some(body))? {
            Reply::Ok(v) => {
                let id = v["id"].as_str().unwrap_or_default().to_string();
                // Not kept here: the next sync takes the Remote's head again, which is this commit.
                let _ = remote::set_head(&key, &id);
                return Ok(Cut {
                    id, issue: (!issue.is_empty()).then_some(issue), kind, title: title.trim().into(), note: note.trim().into(),
                    time: v["time"].as_u64().unwrap_or(0), folders: c.folders.iter().map(|f| f.folder.clone()).collect(),
                    files: c.files, added: c.added, removed: c.removed, merged: None,
                });
            }
            // Another device moved the draft or committed first: in step again, and once more.
            // The Remote's head is taken in to try again from; not kept, the next sync takes it.
            Reply::Conflict(v) => { let _ = remote::set_head_from(&key, &v); }
            Reply::NotFound(_) => return Err(crate::tr!("The Remote does not have this repo", "Remote にこの repo がありません")),
        }
    }
    Err(crate::tr!("The Remote kept moving; could not commit", "Remote が動き続けていて Commit できませんでした"))
}

/// The commits of the line `repo` shows (or of `line`), newest first.
pub fn log(repos: &Repos, repo: &str, n: usize) -> Result<Vec<Cut>> {
    log_of(repo, &repos.line(repo), n)
}

pub fn log_of(repo: &str, line: &str, n: usize) -> Result<Vec<Cut>> {
    let Ok(client) = Client::open() else { return Ok(Vec::new()) };
    // What each commit changed, as the Remote counted it, without its tree; a Remote that does not count
    // it yet sends the trees, and they are compared here.
    let v = match client.call("GET", &format!("{}{}limit={n}&summary=1", remote::at_path(repo, line, "/log"), if line == crate::work::MAIN { "?" } else { "&" }), None)? {
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
            merged: c["merged"].as_str().map(String::from),
        }
    }).collect())
}

/// The folders a change touches (each once, in order) and how many files.
fn places(then: &Tree, now: &Tree) -> (Vec<String>, usize) {
    let mut folders: Vec<String> = Vec::new();
    let mut files = 0;
    let paths: std::collections::BTreeSet<&String> = then.keys().chain(now.keys()).collect();
    for p in paths {
        if then.get(p) == now.get(p) || !(matches!(now.get(p), Some(Some(_))) || matches!(then.get(p), Some(Some(_)))) { continue; }
        files += 1;
        let f = folder_of(p);
        if !folders.contains(&f) { folders.push(f); }
    }
    (folders, files)
}

/// "Fix：件名" for a commit.
pub fn line(c: &Cut) -> String {
    named(c.kind.as_deref(), &c.title)
}

// ---- the work on an issue, and what it hands to main ----

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

pub fn work(repos: &Repos, repo: &str) -> Result<Work> {
    // A work merged (here or on another device) is done: back to main, and its copy goes. The changes are asked of
    // the Remote only when there is a copy here: with none, there is nothing to let go of, and the work shown is main
    // (most repos, most of the time), which Forge and Git asked about each time they drew the repo.
    let copies = crate::work::worktrees(repo);
    let mut listed = None;
    if !copies.is_empty() {
        let list = changes_of_repo(repo);
        let merged: Vec<&str> = list.iter().flatten().filter(|c| c.state == "merged").map(|c| c.line.as_str()).collect();
        for (line, _) in &copies {
            // A merged work's copy that cannot go now is tried again the next time the issues are read.
            if merged.contains(&line.as_str()) { let _ = crate::work::finish(repos, repo, line); }
        }
        listed = list.ok();
    }
    let on = repos.line(repo);
    if on == crate::work::MAIN {
        return Ok(Work { line: on, issue: None, started_by: String::new(), started_at: 0, commits: 0, unpushed: 0, change: None });
    }
    let l = crate::work::line(repo, &on)?.ok_or_else(|| crate::tr!("The Remote has no such work", "Remote にその作業がありません"))?;
    let log = log_of(repo, &on, 200)?;
    let mine: Vec<&Cut> = log.iter().take_while(|c| Some(&c.id) != l.base.as_ref()).collect();
    let unpushed = mine.iter().take_while(|c| Some(&c.id) != l.pushed.as_ref()).count();
    // The list read above, when it was: what was let go of meanwhile was merged, never the work shown.
    let change = match listed { Some(list) => list, None => changes_of_repo(repo)? }.into_iter().find(|c| c.line == on);
    Ok(Work { line: on, issue: Some(l.issue), started_by: l.started_by, started_at: l.started_at, commits: mine.len(),
        unpushed: if l.pushed == l.base && !mine.is_empty() { mine.len() } else { unpushed }, change })
}

/// Push: the work's commits become the line's state on the Remote.
pub fn push(repos: &Repos, repo: &str) -> Result<String> {
    let on = repos.line(repo);
    if on == crate::work::MAIN {
        return Err(crate::tr!("main is pushed by merging changes into it; work on an issue to push", "main には Change を Merge して入れます。Issue の作業で Push してください"));
    }
    // Nothing new is no push: an empty answer says so.
    let w = work(repos, repo)?;
    if w.commits == 0 { return Err(crate::tr!("Nothing committed since the work began", "作業を始めてから何も Commit していません")); }
    if w.unpushed == 0 { return Ok(String::new()); }
    let client = Client::open()?;
    let (key, _) = remote::key(repos, repo);
    let head = remote::base(&key).and_then(|b| b.head).ok_or_else(|| crate::tr!("Nothing committed yet", "まだ何も Commit していません"))?;
    let v = client.json("POST", &format!("/v1/repos/{repo}/lines/{on}/push"), Some(serde_json::json!({"head": head})))?;
    Ok(v["pushed"].as_str().unwrap_or_default().to_string())
}

/// A change handed to main.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Change {
    pub id: String,
    pub repo: String,
    pub line: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub kind: String,
    pub title: String,
    pub version: i64,
    pub base: Option<String>,
    pub head: String,
    /// "open", "merged", "rejected" or "reset".
    pub state: String,
    #[serde(default)]
    pub note: String,
    #[serde(default, rename = "submittedBy")]
    pub submitted_by: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(default)]
    pub reviews: Vec<Review>,
    /// The folders it touches and how many files, filled in here.
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub files: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Review {
    pub version: i64,
    /// "approve", "changes" or "comment".
    pub verdict: String,
    #[serde(default)]
    pub note: String,
    /// Lines marked in the version's diff, "path:index".
    #[serde(default)]
    pub marks: Vec<String>,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub time: u64,
}

/// The changes handed to `repo`'s main, newest first, each with where it reaches.
pub fn changes_of_repo(repo: &str) -> Result<Vec<Change>> {
    let client = Client::open()?;
    let mut list: Vec<Change> = serde_json::from_value(client.json("GET", &format!("/v1/repos/{repo}/changes"), None)?).map_err(|e| e.to_string())?;
    for c in &mut list { place(&client, repo, c)?; }
    remember_merged(repo, list.iter().filter(|c| c.state == "merged").map(|c| c.issue.clone()));
    Ok(list)
}

/// Where a change from one commit to another reaches, as `place` found it. A commit's id is made from all it is (the
/// Remote's cutId: its tree among it), so what two commits come to never changes: a change listed again (each time
/// Git is drawn, and Forge while a work is shown) asks the Remote for neither of its trees again.
type Reach = (Vec<String>, usize);
fn reaches() -> &'static Mutex<HashMap<(String, Option<String>, String), Reach>> {
    static R: OnceLock<Mutex<HashMap<(String, Option<String>, String), Reach>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fill in where `c` reaches: the folders it touches and how many files (the Remote says only its commits).
fn place(client: &Client, repo: &str, c: &mut Change) -> Result<()> {
    let key = (repo.to_string(), c.base.clone(), c.head.clone());
    let known = reaches().lock().map_err(|e| e.to_string())?.get(&key).cloned();
    let reach = match known {
        Some(r) => r,
        None => {
            let then = c.base.as_deref().map_or_else(|| Ok(Tree::new()), |b| tree_at(client, repo, b))?;
            let now = tree_at(client, repo, &c.head)?;
            let r = places(&then, &now);
            reaches().lock().map_err(|e| e.to_string())?.insert(key, r.clone());
            r
        }
    };
    (c.folders, c.files) = reach;
    Ok(())
}

/// A change as the Remote answered it, with where it reaches.
fn placed(repo: &str, v: serde_json::Value) -> Result<Change> {
    let mut c: Change = serde_json::from_value(v).map_err(|e| e.to_string())?;
    place(&Client::open()?, repo, &mut c)?;
    Ok(c)
}

/// The issues of `repo` seen merged ("issue/001.md"), kept here so a page
/// read offline still knows them: a merge is never undone.
fn merged_file(repo: &str) -> std::path::PathBuf {
    crate::paths::data_dir().join("sync").join(format!("{repo}.merged.json"))
}

pub fn merged_seen(repo: &str) -> Vec<String> {
    fs::read(merged_file(repo)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn remember_merged(repo: &str, issues: impl Iterator<Item = String>) {
    let mut all = merged_seen(repo);
    let before = all.len();
    for i in issues.filter(|i| !i.is_empty()) { if !all.contains(&i) { all.push(i); } }
    if all.len() == before { return; }
    all.sort();
    // What this device saw merged, to hide it while away; not kept, it is seen again once the Remote answers.
    if crate::boundary::private_dir(&crate::paths::data_dir().join("sync")).is_ok() {
        if let Ok(b) = serde_json::to_vec(&all) { let _ = crate::atomic::replace(&merged_file(repo), &b, crate::atomic::How::CACHE); }
    }
}

/// Change: what the work pushed goes to main (again: a new version).
pub fn submit(repos: &Repos, repo: &str, note: &str) -> Result<Change> {
    let on = repos.line(repo);
    if on == crate::work::MAIN {
        return Err(crate::tr!("A change comes from an issue's work (l3 start REPO#N)", "Change は Issue の作業から渡します（l3 start REPO#N）"));
    }
    let (kind, title, _) = words(repos, repo, None, "")?;
    let client = Client::open()?;
    let v = client.call("POST", &format!("/v1/repos/{repo}/changes"), Some(serde_json::json!({
        "line": on, "kind": kind.unwrap_or_default(), "title": title.trim(), "note": note.trim()})))?;
    match v {
        Reply::Ok(v) => placed(repo, v),
        Reply::Conflict(v) if v["error"] == "Push first: the change is what was pushed" => Err(crate::tr!("Push first: the change is what was pushed", "先に Push してください。Change は Push したものです")),
        Reply::Conflict(v) if v["error"] == "This change is merged already" => Err(crate::tr!("Its change is merged already", "この作業の Change はもう Merge 済みです")),
        Reply::Conflict(_) => Err(crate::tr!("Nothing committed since the work began", "作業を始めてから何も Commit していません")),
        Reply::NotFound(_) => Err(crate::tr!("The Remote has no such work", "Remote にその作業がありません")),
    }
}

/// What handing the work in did: the commit pushed (none when nothing was
/// new), the change as main now has it, and as it was before (if it was).
#[derive(Serialize, Debug, Clone)]
pub struct HandIn {
    pub pushed: Option<String>,
    pub change: Change,
    pub before: Option<Change>,
}

impl HandIn {
    /// Nothing new was handed in: main already had this very version.
    pub fn same(&self) -> bool {
        self.pushed.is_none() && self.before.as_ref().is_some_and(|b| b.state == "open" && b.version == self.change.version)
    }
}

/// Push, then Change, as the app's Push button does: what is pushed goes to main as its next version.
pub fn hand_in(repos: &Repos, repo: &str, note: &str) -> Result<HandIn> {
    let on = repos.line(repo);
    let before = if on == crate::work::MAIN { None } else { changes_of_repo(repo)?.into_iter().find(|c| c.line == on) };
    let head = push(repos, repo)?;
    let change = submit(repos, repo, note)?;
    Ok(HandIn { pushed: (!head.is_empty()).then_some(head), change, before })
}

/// Merge, and the work is done: the repo shows main again, and the work's copy here goes.
pub fn merge_and_finish(repos: &Repos, repo: &str, line: &str) -> Result<Change> {
    let c = merge(repo, line)?;
    crate::work::finish(repos, repo, &c.line)?;
    remember_merged(repo, std::iter::once(c.issue.clone()));
    Ok(c)
}

/// A change's state in the OS's words.
pub fn state_word(state: &str) -> String {
    match state {
        "open" => crate::tr!("undecided", "未決"),
        "merged" => crate::tr!("merged", "Merge 済み"),
        "rejected" => crate::tr!("rejected", "Reject 済み"),
        "reset" => crate::tr!("taken back", "取り下げ済み"),
        other => other.to_string(),
    }
}

fn change_call(repo: &str, id: &str, verb: &str, body: serde_json::Value) -> Result<serde_json::Value> {
    match Client::open()?.call("POST", &format!("/v1/repos/{repo}/changes/{id}/{verb}"), Some(body))? {
        Reply::Ok(v) => Ok(v),
        Reply::Conflict(v) if v["conflicts"].is_array() => Err(crate::tr!("Both changed these files; resolve them in the work, push and change again: {}", "両方で変わったファイルがあります。作業の側で直して Push し、もう一度 Change してください：{}",
            v["conflicts"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect::<Vec<_>>().join(", "))),
        Reply::Conflict(v) if v["version"].is_number() => Err(crate::tr!("The change has a newer version ({}); look at it first", "Change に新しい版があります（第{}版）。先にそれを見てください", v["version"])),
        Reply::Conflict(v) => {
            // A Latin word stands a space apart from the Japanese before it (bug: もうMerge 済み).
            let state = state_word(v["state"].as_str().unwrap_or("?"));
            let apart = if state.starts_with(|c: char| c.is_ascii_alphabetic()) { " " } else { "" };
            Err(if crate::i18n::ja() { format!("この Change はもう{apart}{state}です") } else { format!("The change is {state} already") })
        }
        Reply::NotFound(_) => Err(crate::tr!("No such change", "その Change はありません")),
    }
}

fn find(repo: &str, id: &str) -> Result<Change> {
    changes_of_repo(repo)?.into_iter().find(|c| c.id == id || c.id.starts_with(id) || c.line == id)
        .ok_or_else(|| {
            // Named as a person calls it: the work on issue 002 is notes#2 (bug: "handed in for 002").
            let n = crate::issues::number(&format!("{id}.md"));
            let called = if n.is_empty() { id.to_string() } else { format!("{repo}{n}") };
            crate::tr!("{} has no change yet: its work is pushed first", "{} にはまだ Change がありません。先に作業を Push します", called)
        })
}

/// Review the change's current version.
pub fn review(repo: &str, id: &str, verdict: &str, note: &str, marks: &[String]) -> Result<Change> {
    let c = find(repo, id)?;
    if !["approve", "changes", "comment"].contains(&verdict) {
        return Err(crate::tr!("A review is approve, changes or comment", "レビューは approve、changes、comment のどれかです"));
    }
    // Approving a version one handed in oneself is allowed, as in the app and on the Remote:
    // every repo is one account's today, so its Review is the owner's own check before Merge.
    // A repo with more than one member is when this tightens (another member approves).
    placed(repo, change_call(repo, &c.id, "reviews", serde_json::json!({"version": c.version, "verdict": verdict, "note": note, "marks": marks}))?)
}

/// Merge: main takes the change's current version.
pub fn merge(repo: &str, id: &str) -> Result<Change> {
    let c = find(repo, id)?;
    placed(repo, change_call(repo, &c.id, "merge", serde_json::json!({"version": c.version}))?)
}

/// Reject: main does not take it (the receiver's decision; the issue stays open).
pub fn reject(repo: &str, id: &str, note: &str) -> Result<Change> {
    let c = find(repo, id)?;
    placed(repo, change_call(repo, &c.id, "reject", serde_json::json!({"note": note}))?)
}

/// Reset: take back the change the work handed in (its author's decision).
pub fn reset(repos: &Repos, repo: &str) -> Result<Change> {
    let on = repos.line(repo);
    if on == crate::work::MAIN {
        return Err(crate::tr!("{} shows main: reset takes back the change of the issue being worked on (l3 start REPO#N first)", "{} は main を見せています。reset は作業中の Issue の Change を取り下げます（先に l3 start REPO#N）", repo));
    }
    let c = find(repo, &on)?;
    placed(repo, change_call(repo, &c.id, "reset", serde_json::json!({}))?)
}

/// A change's diff against where it began, line by line.
pub fn change_diff(repo: &str, id: &str, limit: usize) -> Result<Vec<FileDiff>> {
    let c = find(repo, id)?;
    let client = Client::open()?;
    let then = c.base.as_deref().map_or_else(|| Ok(Tree::new()), |b| tree_at(&client, repo, b))?;
    let now = tree_at(&client, repo, &c.head)?;
    diff_of(pairs(Some(&client), After::Remote(&client), &then, &now)?, limit)
}
