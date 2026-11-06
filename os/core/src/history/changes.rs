//! What is not committed yet, and how a file differs: the draft against the head, file by file and line by
//! line, the head's files read from the Remote once and kept.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::text::diff::{self, Kind};
use crate::remote::{self, Client, Reply, Tree};
use crate::repos::store::Repos;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::sync::{Mutex, OnceLock};

pub(super) fn diff_of(pairs: Vec<Pair>, limit: usize) -> Result<Vec<FileDiff>> {
    let mut left = limit;
    let mut out = Vec::new();
    for p in pairs {
        let mut lines = Vec::new();
        if !p.binary {
            let ops = diff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or(""));
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

/// The same, line by line, at most `limit` lines in all.
pub fn diff(repos: &Repos, repo: &str, limit: usize) -> Result<Vec<FileDiff>> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    diff_of(pairs(client.as_ref(), After::Here(repos.dir(repo)?), &then, &now)?, limit)
}

/// How many files are not committed yet: as many as `changes` lists, none of them read (what is said beside diff).
pub fn changed(repos: &Repos, repo: &str) -> Result<usize> {
    let (_, then, now) = draft_and_head(repos, repo)?;
    Ok(differing(&then, &now).count())
}

/// What is not committed yet, folder by folder.
pub fn changes(repos: &Repos, repo: &str) -> Result<Changes> {
    let (client, then, now) = draft_and_head(repos, repo)?;
    changes_of(client.as_ref(), After::Here(repos.dir(repo)?), &then, &now)
}

pub(super) fn changes_of(client: Option<&Client>, after: After, then: &Tree, now: &Tree) -> Result<Changes> {
    let files = pairs(client, after, then, now)?.into_iter().map(|p| {
        let (added, removed) = if p.binary { (0, 0) } else {
            diff::counts(&diff::ops(p.before.as_deref().unwrap_or(""), p.after.as_deref().unwrap_or("")))
        };
        FileChange { path: p.path, status: p.status, added, removed, binary: p.binary }
    }).collect();
    Ok(group(files, client.is_some()))
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

/// The draft here and the work's last commit, as the Remote has them.
fn draft_and_head(repos: &Repos, repo: &str) -> Result<(Option<Client>, Tree, Tree)> {
    let now = remote::local_tree(&repos.dir(repo)?).tree;
    let Ok(client) = Client::open() else { return Ok((None, Tree::new(), now)) };
    let (key, _) = remote::key(repos, repo);
    let head = remote::base(&key).and_then(|b| b.head);
    let then = head_tree(&client, repo, &key, head.as_deref())?;
    Ok((Some(client), then, now))
}

pub(super) fn pairs(client: Option<&Client>, after_from: After, then: &Tree, now: &Tree) -> Result<Vec<Pair>> {
    let mut out = Vec::new();
    let paths: Vec<&String> = differing(then, now).collect();
    if let Some(c) = client {
        let remote_after = matches!(after_from, After::Remote(_));
        let mut need: Vec<&String> = Vec::new();
        for p in &paths {
            if let Some(Some(sha)) = then.get(*p) { need.push(sha); }
            if let (true, Some(Some(sha))) = (remote_after, now.get(*p)) { need.push(sha); }
        }
        prefetch(c, need);
    }
    for path in paths {
        let (was, is) = (then.get(path), now.get(path));
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

/// The paths whose files differ from `then` to `now`, in order. Folders count through their files: one made or gone
/// alone is no change.
fn differing<'a>(then: &'a Tree, now: &'a Tree) -> impl Iterator<Item = &'a String> {
    let paths: std::collections::BTreeSet<&String> = then.keys().chain(now.keys()).collect();
    paths.into_iter().filter(|p| {
        let (was, is) = (then.get(*p), now.get(*p));
        was != is && !(matches!(was, Some(None) | None) && matches!(is, Some(None) | None))
    })
}

/// Where the newer side's bytes are: the files here, or the Remote's blobs.
pub(super) enum After<'a> { Here(std::path::PathBuf), Remote(&'a Client) }

/// One file's before and after: (status, before text, after text, binary).
pub(super) struct Pair { path: String, status: &'static str, before: Option<String>, after: Option<String>, binary: bool }

pub(super) fn text(bytes: &[u8]) -> Option<String> {
    if bytes.len() > TEXT_LIMIT || bytes.contains(&0) { None } else { String::from_utf8(bytes.to_vec()).ok() }
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
            if crate::fs::hash::sha256(&bytes) == *sha && bytes.len() <= TEXT_LIMIT { cache.insert(sha.clone(), bytes); }
        }
    }
}

pub(super) fn blob(client: &Client, sha: &str) -> Result<Vec<u8>> {
    if let Some(b) = blobs().lock().map_err(|e| e.to_string())?.get(sha) {
        return Ok(b.clone());
    }
    let b = client.blob(sha)?;
    if b.len() <= TEXT_LIMIT {
        blobs().lock().map_err(|e| e.to_string())?.insert(sha.into(), b.clone());
    }
    Ok(b)
}

fn blobs() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static B: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tree_at(client: &Client, repo: &str, id: &str) -> Result<Tree> {
    match client.call("GET", &format!("/v1/repos/{repo}/cuts/{id}"), None)? {
        Reply::Ok(v) => Ok(remote::tree_of(&v["tree"])),
        _ => Err(crate::tr!("The Remote has no such commit", "Remote にそのコミットがありません")),
    }
}

/// Two commits' trees as far as they differ (each path whose value differs, as each has it): compared by the Remote,
/// or, from one from before, both read whole.
pub(super) fn differ(client: &Client, repo: &str, from: Option<&str>, to: &str) -> Result<(Tree, Tree)> {
    if let Some(d) = compare(client, repo, from, to)? { return Ok(d); }
    Ok((from.map_or_else(|| Ok(Tree::new()), |b| tree_at(client, repo, b))?, tree_at(client, repo, to)?))
}

/// What changed between two commits (`from` none: from nothing), as each has it: only the paths that differ, the
/// Remote comparing them where it keeps them. None from a Remote from before (it has no such route).
fn compare(client: &Client, repo: &str, from: Option<&str>, to: &str) -> Result<Option<(Tree, Tree)>> {
    match client.call("GET", &format!("/v1/repos/{repo}/compare?from={}&to={to}", from.unwrap_or_default()), None)? {
        Reply::Ok(v) if v["was"].is_object() && v["now"].is_object() => Ok(Some((remote::tree_of(&v["was"]), remote::tree_of(&v["now"])))),
        _ => Ok(None),
    }
}

/// The tree of a commit (empty before the first), kept for the line `key` it was last asked for. One kept for an
/// earlier commit is brought to this one by what changed between them (the Remote compares them), not read again whole.
pub(super) fn head_tree(client: &Client, repo: &str, key: &str, head: Option<&str>) -> Result<Tree> {
    let Some(id) = head else { return Ok(Tree::new()) };
    let kept: Head = fs::read(head_file(key)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if kept.id.as_deref() == Some(id) {
        return Ok(kept.tree);
    }
    let tree = match kept.id.as_deref().map(|was| compare(client, repo, Some(was), id)) {
        Some(Ok(Some((was, now)))) => {
            let mut tree = kept.tree;
            for p in was.keys() { tree.remove(p); }
            tree.extend(now);
            tree
        }
        _ => tree_at(client, repo, id)?,
    };
    // Kept to spare the next read; not kept, the next read asks again.
    if let Ok(b) = serde_json::to_vec(&Head { id: Some(id.into()), tree: tree.clone() }) {
        let _ = crate::fs::write::replace(&head_file(key), &b, crate::fs::write::How::CACHE);
    }
    Ok(tree)
}

fn head_file(key: &str) -> std::path::PathBuf {
    crate::fs::paths::data_dir().join("sync").join(format!("{key}.head.json"))
}

#[derive(Serialize, Deserialize, Default)]
struct Head { id: Option<String>, tree: Tree }

fn folder_of(path: &str) -> String {
    path.rfind('/').map_or(String::new(), |at| path[..at].to_string())
}

/// Texts compared line by line at most this large; past it, by name only.
const TEXT_LIMIT: usize = 1 << 20;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileDiff {
    pub path: String,
    pub status: &'static str,
    pub binary: bool,
    pub lines: Vec<DiffLine>,
    /// Lines left out past the limit.
    pub more: usize,
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
pub struct Changes {
    /// Whether this device is on a Remote (without one nothing can be cut).
    pub connected: bool,
    pub folders: Vec<Folder>,
    pub files: usize,
    pub added: u64,
    pub removed: u64,
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
pub struct FileChange {
    pub path: String,
    /// "added", "modified" or "removed".
    pub status: &'static str,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
}

/// The folders a change touches (each once, in order) and how many files.
pub(super) fn places(then: &Tree, now: &Tree) -> (Vec<String>, usize) {
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


