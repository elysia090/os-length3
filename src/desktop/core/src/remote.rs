//! This device and the Remote (service/app.ts), for l3 and the app alike.
//! The canonical copy is the Remote's; a repo here is a copy kept in step
//! with it:
//!
//!   draft   the working tree, sent as a diff after every change, each on
//!           the version it was read at (so nothing sent is overwritten)
//!   cut     区切る: the draft at a version becomes history (history.rs)
//!
//! Taking in is file by file against the last version agreed with the
//! Remote (the base): a file only changed there is written here, one only
//! changed here is sent, and when both changed one, this device's stays and
//! the other is written beside it as "name (別の端末).ext", so neither is
//! lost. Files that cannot travel (links, files over 16 MiB) and a repo's
//! own .git are not sent, and are named; a repo holding them is never freed.
//!
//! A repo on the Remote need not be here: 空ける removes the copy once the
//! Remote holds all of it, and opening the repo brings it back.

use crate::repos::{is_git_name, Repos};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub type Tree = BTreeMap<String, Option<String>>;
type Result<T> = std::result::Result<T, String>;

pub const BLOB_LIMIT: u64 = 16 << 20;
pub const DEFAULT_URL: &str = "https://remote.length3.com";
/// Paths one diff carries at most (the Remote takes 5000).
const CHUNK: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub url: String,
    pub token: String,
}

/// The Remote this device is connected to, if it is (Home's `remote` setting).
pub fn connection() -> Option<Connection> {
    let text = crate::home::get("remote").ok()??;
    serde_json::from_str(&text).ok()
}

pub fn save_connection(c: &Connection) -> Result<()> {
    crate::home::set("remote", &serde_json::to_string(c).map_err(|e| e.to_string())?)
}

/// Forget the Remote here: its session and every base (the repos stay).
pub fn forget_connection() -> Result<()> {
    crate::home::set("remote", "null")?;
    let _ = fs::remove_dir_all(sync_dir());
    Ok(())
}

/// The Remote to sign in to: $LENGTH3_REMOTE, else the one this OS ships with.
pub fn default_url() -> String {
    std::env::var("LENGTH3_REMOTE").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.into()).trim_end_matches('/').into()
}

// ---- HTTP ----

fn agent(url: &str) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(60));
    let local = url.split("://").nth(1).is_some_and(|h| h.starts_with("127.") || h.starts_with("localhost") || h.starts_with("[::1]"));
    let proxy = ["HTTPS_PROXY", "https_proxy"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()));
    if let (false, Some(p)) = (local, proxy) {
        if let Ok(p) = ureq::Proxy::new(p) {
            b = b.proxy(p);
        }
    }
    b.build()
}

pub(crate) struct Client {
    agent: ureq::Agent,
    url: String,
    token: String,
}

pub(crate) enum Reply {
    Ok(serde_json::Value),
    Conflict(serde_json::Value),
    NotFound,
}

const UNKNOWN: &str = "Remote がこの端末を知りません（l3 login でつなぎ直せます）";

impl Client {
    pub(crate) fn open() -> Result<Client> {
        let c = connection().ok_or("Remote につながっていません（l3 login）")?;
        Ok(Client { agent: agent(&c.url), url: c.url, token: c.token })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub(crate) fn call(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<Reply> {
        let req = self.agent.request(method, &format!("{}{path}", self.url)).set("Authorization", &self.auth());
        let r = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match r {
            Ok(r) => Ok(Reply::Ok(r.into_json().unwrap_or(serde_json::Value::Null))),
            Err(ureq::Error::Status(409, r)) => Ok(Reply::Conflict(r.into_json().unwrap_or_default())),
            Err(ureq::Error::Status(404, _)) => Ok(Reply::NotFound),
            Err(ureq::Error::Status(401, _)) => Err(UNKNOWN.into()),
            Err(ureq::Error::Status(code, _)) => Err(format!("Remote: {code}")),
            Err(e) => Err(format!("Remote に届きません: {e}")),
        }
    }

    pub(crate) fn json(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value> {
        match self.call(method, path, body)? {
            Reply::Ok(v) => Ok(v),
            Reply::Conflict(_) => Err("Remote と食い違いました".into()),
            Reply::NotFound => Err("Remote にありません".into()),
        }
    }

    fn put_blob(&self, sha: &str, bytes: &[u8]) -> Result<()> {
        self.agent.put(&format!("{}/v1/blobs/{sha}", self.url))
            .set("Authorization", &self.auth())
            .set("Content-Type", "application/octet-stream")
            .send_bytes(bytes)
            .map(|_| ())
            .map_err(|e| format!("Remote が受け取りませんでした: {e}"))
    }

    pub(crate) fn blob(&self, sha: &str) -> Result<Vec<u8>> {
        let r = self.agent.get(&format!("{}/v1/blobs/{sha}", self.url))
            .set("Authorization", &self.auth()).call()
            .map_err(|e| format!("Remote から読めません: {e}"))?;
        let mut bytes = Vec::new();
        r.into_reader().take(BLOB_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        // Trusted only as far as it is what its name says.
        if sha256(&bytes) != sha {
            return Err("Remote から届いたものが名前と合いません".into());
        }
        Ok(bytes)
    }
}

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ---- signing in from a device ----

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Ask for a code to approve in a browser; `client` is "l3" or "length3-app".
pub fn device_start(url: &str, client: &str) -> Result<DeviceCode> {
    agent(url).post(&format!("{url}/api/auth/device/code")).send_json(serde_json::json!({"client_id": client}))
        .map_err(|e| format!("Remote に届きません: {e}"))?
        .into_json().map_err(|e| e.to_string())
}

/// Poll once: Some(token) when approved, None while waiting.
pub fn device_poll(url: &str, client: &str, code: &DeviceCode) -> Result<Option<String>> {
    let r = agent(url).post(&format!("{url}/api/auth/device/token")).send_json(serde_json::json!({
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": code.device_code, "client_id": client,
    }));
    match r {
        Ok(r) => {
            let v: serde_json::Value = r.into_json().map_err(|e| e.to_string())?;
            Ok(v.get("access_token").and_then(|t| t.as_str()).map(String::from))
        }
        Err(ureq::Error::Status(_, r)) => {
            let v: serde_json::Value = r.into_json().unwrap_or_default();
            match v.get("error").and_then(|e| e.as_str()) {
                Some("authorization_pending") | Some("slow_down") => Ok(None),
                Some("access_denied") => Err("ブラウザで断られました".into()),
                Some("expired_token") => Err("コードの期限が切れました".into()),
                other => Err(format!("つなげませんでした（{}）", other.unwrap_or("?"))),
            }
        }
        Err(e) => Err(format!("Remote に届きません: {e}")),
    }
}

/// Wait for a code to be approved, then keep the session here.
pub fn device_finish(url: &str, client: &str, code: &DeviceCode) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(code.expires_in.max(60));
    let step = Duration::from_secs(code.interval.max(1));
    loop {
        std::thread::sleep(step);
        if let Some(token) = device_poll(url, client, code)? {
            return save_connection(&Connection { url: url.trim_end_matches('/').into(), token });
        }
        if std::time::Instant::now() > deadline {
            return Err("コードの期限が切れました".into());
        }
    }
}

/// Who this device is signed in as.
#[derive(Serialize, Debug, Clone)]
pub struct Account {
    pub url: String,
    pub user: String,
    pub name: String,
}

pub fn account() -> Result<Option<Account>> {
    let Some(c) = connection() else { return Ok(None) };
    let v = Client::open()?.json("GET", "/api/auth/get-session", None)?;
    if v.is_null() {
        return Err(UNKNOWN.into());
    }
    Ok(Some(Account {
        url: c.url,
        user: v["user"]["id"].as_str().unwrap_or_default().into(),
        name: v["user"]["name"].as_str().unwrap_or_default().into(),
    }))
}

/// End this device's session on the Remote, then forget it here.
pub fn logout() -> Result<()> {
    if let Ok(c) = Client::open() {
        let _ = c.call("POST", "/api/auth/sign-out", Some(serde_json::json!({})));
    }
    forget_connection()
}

// ---- the tree here ----

#[derive(Debug, Default)]
pub struct Local {
    pub tree: Tree,
    /// sha -> where its bytes are (one place is enough).
    files: BTreeMap<String, PathBuf>,
    /// Paths that are not sent, and why.
    pub unsynced: Vec<(String, String)>,
    pub bytes: u64,
}

/// What a file's digest was when it was last read, by what it looked like then.
type Seen = HashMap<PathBuf, ((u64, i128, u64), String)>;
fn seen() -> &'static Mutex<Seen> {
    static S: OnceLock<Mutex<Seen>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stamp(m: &fs::Metadata) -> (u64, i128, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (m.len(), m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, m.ino())
    }
    #[cfg(not(unix))]
    {
        let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128);
        (m.len(), t, 0)
    }
}

/// A file's digest, read again only when its size, time or inode moved.
fn digest(path: &Path, meta: &fs::Metadata) -> Option<String> {
    let s = stamp(meta);
    if let Some((was, sha)) = seen().lock().ok()?.get(path) {
        if *was == s {
            return Some(sha.clone());
        }
    }
    let sha = sha256(&fs::read(path).ok()?);
    seen().lock().ok()?.insert(path.to_path_buf(), (s, sha.clone()));
    Some(sha)
}

/// The repo directory as the Remote would hold it (its .git aside).
pub fn local_tree(dir: &Path) -> Local {
    let mut out = Local::default();
    walk(dir, "", &mut out);
    out
}

fn walk(dir: &Path, prefix: &str, out: &mut Local) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut empty = true;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // A file this OS is writing is not the repo's yet.
        if crate::usage::is_temporary(&name) {
            continue;
        }
        empty = false;
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if is_git_name(&name) {
            out.unsynced.push((rel, "git の履歴".into()));
            continue;
        }
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.file_type().is_symlink() {
            out.unsynced.push((rel, "リンク".into()));
        } else if meta.is_dir() {
            walk(&e.path(), &rel, out);
        } else if meta.is_file() {
            if meta.len() > BLOB_LIMIT {
                out.unsynced.push((rel, "16 MB を超えるファイル".into()));
                continue;
            }
            let Some(sha) = digest(&e.path(), &meta) else { out.unsynced.push((rel, "読めないファイル".into())); continue };
            out.bytes += meta.len();
            out.files.insert(sha.clone(), e.path());
            out.tree.insert(rel, Some(sha));
        } else {
            out.unsynced.push((rel, "特殊なファイル".into()));
        }
    }
    if empty && !prefix.is_empty() {
        out.tree.insert(prefix.to_string(), None);
    }
}

// ---- what was last agreed with the Remote ----

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Base {
    pub version: i64,
    pub tree: Tree,
    pub head: Option<String>,
}

/// Bases are kept one file per line: `<data>/sync/<repo>.json` for main,
/// `<data>/sync/<repo>@<line>.json` for an issue's work. A key names one.
fn sync_dir() -> PathBuf {
    crate::paths::data_dir().join("sync")
}

/// The key of the line `repo` shows now, and that line.
pub fn key(repos: &Repos, repo: &str) -> (String, String) {
    let line = repos.line(repo);
    (key_of(repo, &line), line)
}

pub fn key_of(repo: &str, line: &str) -> String {
    if line == crate::work::MAIN { repo.to_string() } else { format!("{repo}@{line}") }
}

/// The Remote's address of a line: the repo, and the line when not main.
fn at(repo: &str, line: &str, rest: &str) -> String {
    let q = if line == crate::work::MAIN { String::new() } else { format!("?line={line}") };
    format!("/v1/repos/{repo}{rest}{q}")
}

/// An issue's work was brought here afresh: nothing is agreed for it yet.
pub fn forget_line(repo: &str, line: &str) {
    forget_base(&key_of(repo, line));
}

fn base_file(repo: &str) -> PathBuf {
    sync_dir().join(format!("{repo}.json"))
}

pub fn base(repo: &str) -> Option<Base> {
    serde_json::from_slice(&fs::read(base_file(repo)).ok()?).ok()
}

fn set_base(repo: &str, b: &Base) -> Result<()> {
    crate::boundary::private_dir(&sync_dir()).map_err(|e| e.to_string())?;
    let path = base_file(repo);
    let tmp = sync_dir().join(format!(".{repo}.json.length3-{}-0", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(b).map_err(|e| e.to_string())?).and_then(|_| fs::rename(&tmp, &path)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// A cut was made at the base's version: it is the head now.
pub(crate) fn set_head(key: &str, id: &str) -> Result<()> {
    let repo = key;
    let b = base(repo).unwrap_or_default();
    set_base(repo, &Base { head: Some(id.into()), ..b })
}

/// A refused cut says where the Remote's head is.
pub(crate) fn set_head_from(key: &str, v: &serde_json::Value) -> Result<()> {
    let repo = key;
    let b = base(repo).unwrap_or_default();
    set_base(repo, &Base { head: v["head"].as_str().map(String::from), ..b })
}

fn forget_base(repo: &str) {
    let _ = fs::remove_file(base_file(repo));
}

/// One sync of a repo at a time, across the app and l3 alike.
struct Lock(#[allow(dead_code)] fs::File);

fn lock(repo: &str) -> Result<Lock> {
    crate::boundary::private_dir(&sync_dir()).map_err(|e| e.to_string())?;
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(sync_dir().join(format!("{repo}.lock"))).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: flock on a descriptor this function owns.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(Lock(f))
}

// ---- merging ----

/// What taking in a remote tree means here.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Paths to make what the Remote has (None: remove; Some(None): a folder).
    pub take: Vec<(String, Option<Option<String>>)>,
    /// Changed on both sides differently: this device's stays, theirs goes beside it.
    pub both: Vec<(String, Option<String>)>,
}

pub fn plan(base: &Tree, here: &Tree, there: &Tree) -> Plan {
    let mut p = Plan::default();
    let paths: BTreeSet<&String> = base.keys().chain(here.keys()).chain(there.keys()).collect();
    for path in paths {
        let (b, l, r) = (base.get(path), here.get(path), there.get(path));
        if l == r || r == b {
            continue;
        }
        if l == b || (l.is_none() && r.is_some()) {
            // Only changed there; or removed here and changed there, where the change wins.
            p.take.push((path.clone(), r.cloned()));
        } else if let Some(Some(theirs)) = r {
            p.both.push((path.clone(), Some(theirs.clone())));
        }
        // Removed there but changed here: this device's stays, and is sent.
    }
    p
}

/// "dir/name (別の端末).ext" beside `path`.
pub fn beside(path: &str) -> String {
    let (dir, file) = path.rsplit_once('/').map_or(("", path), |(d, f)| (d, f));
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let name = format!("{stem} (別の端末){ext}");
    if dir.is_empty() { name } else { format!("{dir}/{name}") }
}

/// A path inside `dir`, its folders made, refusing any part that is .git or a link.
fn place(dir: &Path, rel: &str) -> Result<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || is_git_name(p)) {
        return Err(format!("{rel}: ここには書けません"));
    }
    let mut at = dir.to_path_buf();
    for p in &parts[..parts.len() - 1] {
        at.push(p);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(format!("{rel}: 途中がフォルダーではありません")),
            Err(_) => fs::create_dir(&at).map_err(|e| e.to_string())?,
        }
    }
    Ok(at.join(parts[parts.len() - 1]))
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) {
        return Err(format!("{}: ファイルではないものがあります", path.display()));
    }
    let tmp = path.with_file_name(format!(".length3-{}-{}", std::process::id(), path.file_name().unwrap().to_string_lossy()));
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Whether what is at `at` is still what the tree read said (None: nothing).
fn still(at: &Path, expect: Option<&Option<String>>) -> bool {
    match (fs::symlink_metadata(at), expect) {
        (Err(_), None) => true,
        (Ok(m), Some(None)) => m.is_dir(),
        (Ok(m), Some(Some(sha))) if m.is_file() => digest(at, &m).as_ref() == Some(sha),
        _ => false,
    }
}

/// Write the Remote's side of `p` here. A file that cannot be written where
/// it is (a folder in its place, or a file where its folder would be) goes
/// beside; a path that changed here while this ran is left for the next round.
fn apply(client: &Client, dir: &Path, here: &Tree, p: &Plan) -> Result<Vec<String>> {
    let mut aside = Vec::new();
    let put_beside = |path: &str, bytes: &[u8]| -> Result<()> {
        let at = place(dir, &beside(path)).map_err(|_| format!("{path}: 書けませんでした"))?;
        write_file(&at, bytes)
    };
    for (path, what) in &p.take {
        let Ok(at) = place(dir, path) else {
            if let Some(Some(sha)) = what {
                let bytes = client.blob(sha)?;
                let top = path.split('/').next().unwrap_or(path);
                let moved = format!("{}{}", beside(top), &path[top.len()..]);
                write_file(&place(dir, &moved).map_err(|_| format!("{path}: 書けませんでした"))?, &bytes)?;
                aside.push(path.clone());
            }
            continue;
        };
        if here.contains_key(path) && !still(&at, here.get(path)) {
            continue;
        }
        match what {
            None => {
                if let Ok(m) = fs::symlink_metadata(&at) {
                    if m.is_dir() { fs::remove_dir_all(&at) } else { fs::remove_file(&at) }.map_err(|e| e.to_string())?;
                }
            }
            Some(None) => {
                if fs::symlink_metadata(&at).is_err() {
                    fs::create_dir(&at).map_err(|e| e.to_string())?;
                }
            }
            Some(Some(sha)) => {
                let bytes = client.blob(sha)?;
                if write_file(&at, &bytes).is_err() {
                    put_beside(path, &bytes)?;
                    aside.push(path.clone());
                }
            }
        }
    }
    for (path, theirs) in &p.both {
        if let Some(sha) = theirs {
            put_beside(path, &client.blob(sha)?)?;
            aside.push(path.clone());
        }
    }
    Ok(aside)
}

pub(crate) fn at_path(repo: &str, line: &str, rest: &str) -> String { at(repo, line, rest) }

pub(crate) fn tree_of(v: &serde_json::Value) -> Tree {
    v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from))).collect()).unwrap_or_default()
}

// ---- syncing ----

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Synced {
    pub version: i64,
    /// Paths sent, and paths written here from the Remote.
    pub sent: usize,
    pub taken: usize,
    /// Changed on both sides: this device's kept, the other's beside it.
    pub both: Vec<String>,
    pub unsynced: Vec<(String, String)>,
}

/// Bring `repo` and the Remote into step: send what changed here, take in
/// what changed there, until both hold the same draft.
pub fn sync(repos: &Repos, repo: &str) -> Result<Synced> {
    let client = Client::open()?;
    let (key, _) = key(repos, repo);
    let _held = lock(&key)?;
    sync_with(&client, repos, repo)
}

fn sync_with(client: &Client, repos: &Repos, repo: &str) -> Result<Synced> {
    let dir = repos.dir(repo)?;
    let (key, line) = key(repos, repo);
    let path = at(repo, &line, "");
    let draft = at(repo, &line, "/draft");
    let mut out = Synced::default();
    for _ in 0..12 {
        let base = base(&key).unwrap_or_default();
        let here = local_tree(&dir);
        out.unsynced = here.unsynced.clone();
        // Before sending, see whether the Remote moved.
        let there = match client.call("GET", &path, None)? {
            Reply::Ok(v) => Some(v),
            _ => None,
        };
        let remote_version = there.as_ref().and_then(|v| v["version"].as_i64()).unwrap_or(0);
        if remote_version != base.version {
            let v = there.unwrap_or_default();
            let tree = tree_of(&v["draft"]);
            let p = plan(&base.tree, &here.tree, &tree);
            out.both.extend(apply(client, &dir, &here.tree, &p)?);
            out.taken += p.take.len();
            set_base(&key, &Base { version: remote_version, tree, head: v["head"].as_str().map(String::from) })?;
            continue;
        }
        let mut set: Vec<(&String, &Option<String>)> = here.tree.iter().filter(|(p, v)| base.tree.get(*p) != Some(*v)).collect();
        let mut remove: Vec<&String> = base.tree.keys().filter(|p| !here.tree.contains_key(*p)).collect();
        if set.is_empty() && remove.is_empty() {
            out.version = base.version;
            return Ok(out);
        }
        // At most CHUNK paths a diff; what is left goes in the next round.
        set.truncate(CHUNK);
        remove.truncate(CHUNK);
        // Contents the Remote lacks go first.
        let shas: Vec<&str> = set.iter().filter_map(|(_, v)| v.as_deref()).collect();
        if !shas.is_empty() {
            let missing = client.json("POST", "/v1/blobs/missing", Some(serde_json::json!(shas)))?;
            let mut moved = false;
            for sha in missing.as_array().into_iter().flatten().filter_map(|s| s.as_str()) {
                let from = here.files.get(sha).ok_or_else(|| crate::tr!("A file changed meanwhile", "ファイルが途中で変わりました"))?;
                let bytes = fs::read(from).map_err(|e| e.to_string())?;
                // Changed since it was read: read the tree again.
                if sha256(&bytes) != sha { moved = true; break; }
                client.put_blob(sha, &bytes)?;
            }
            if moved { continue; }
        }
        let body = serde_json::json!({
            "version": base.version,
            "set": set.iter().map(|(p, v)| ((*p).clone(), serde_json::json!(v))).collect::<serde_json::Map<_, _>>(),
            "remove": remove,
        });
        // A conflict (someone else moved it, or a blob went missing) goes round again.
        if let Reply::Ok(v) = client.call("PATCH", &draft, Some(body))? {
            let version = v["version"].as_i64().unwrap_or(base.version + 1);
            let mut tree = base.tree.clone();
            for p in &remove {
                tree.remove(*p);
                let under = format!("{p}/");
                tree.retain(|q, _| !q.starts_with(&under));
            }
            for (p, v) in &set { tree.insert((*p).clone(), (*v).clone()); }
            out.sent += set.len() + remove.len();
            out.version = version;
            set_base(&key, &Base { version, tree, head: base.head })?;
        }
    }
    Ok(out)
}

/// A repo the Remote holds.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RemoteRepo {
    pub name: String,
    pub head: Option<String>,
    pub version: i64,
    pub bytes: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub fn remote_repos() -> Result<Vec<RemoteRepo>> {
    serde_json::from_value(Client::open()?.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())
}

/// Every repo here brought into step; repos only on the Remote stay there
/// until they are opened. Each repo's outcome is its own.
pub fn sync_all(repos: &Repos) -> Result<Vec<(String, Result<Synced>)>> {
    let client = Client::open()?;
    let mut out = Vec::new();
    for s in repos.list()? {
        let r = lock(&key(repos, &s.name).0).and_then(|_held| sync_with(&client, repos, &s.name));
        out.push((s.name, r));
    }
    Ok(out)
}

/// Bring a repo that is only on the Remote here (opening it does this).
pub fn fetch(repos: &Repos, repo: &str) -> Result<Synced> {
    if repos.dir(repo).is_ok() {
        return sync(repos, repo);
    }
    if !crate::repos::valid_name(repo) {
        return Err(crate::tr!("{} is not a repo name", "{} は repo の名前になりません", repo));
    }
    let client = Client::open()?;
    let _held = lock(repo)?;
    if let Reply::NotFound = client.call("GET", &format!("/v1/repos/{repo}"), None)? {
        return Err(crate::tr!("The Remote has no repo {}", "Remote に {} はありません", repo));
    }
    // It comes as main; the work on its issues comes when chosen.
    forget_base(repo);
    let _ = fs::remove_file(crate::paths::data_dir().join("sync").join(format!("{repo}.line")));
    fs::create_dir_all(repos.root().join(repo)).map_err(|e| e.to_string())?;
    sync_with(&client, repos, repo)
}

/// Where a repo here stands, from what is here alone (no network).
#[derive(Serialize, Debug, Clone)]
pub struct Status {
    pub name: String,
    /// Paths changed here since the last agreement (0: in step).
    pub changed: usize,
    /// Never agreed with the Remote.
    pub fresh: bool,
    pub unsynced: Vec<(String, String)>,
    pub bytes: u64,
    pub head: Option<String>,
    pub version: i64,
}

pub fn status_of(repos: &Repos, name: &str) -> Result<Status> {
    let here = local_tree(&repos.dir(name)?);
    let b = base(&key(repos, name).0);
    let changed = match &b {
        Some(b) => here.tree.iter().filter(|(p, v)| b.tree.get(*p) != Some(*v)).count() + b.tree.keys().filter(|p| !here.tree.contains_key(*p)).count(),
        None => here.tree.len(),
    };
    Ok(Status {
        name: name.into(), changed, fresh: b.is_none(), unsynced: here.unsynced, bytes: here.bytes,
        head: b.as_ref().and_then(|b| b.head.clone()), version: b.map_or(0, |b| b.version),
    })
}

pub fn status(repos: &Repos) -> Result<Vec<Status>> {
    repos.list()?.into_iter().map(|s| status_of(repos, &s.name)).collect()
}

/// 同期して空ける: once the Remote holds exactly what is here, and nothing here
/// cannot go there, the copy here goes; it comes back when the repo is opened.
/// Every copy of the repo goes: main's and each issue's being worked on.
/// Returns the bytes they took.
pub fn free(repos: &Repos, repo: &str) -> Result<u64> {
    let client = Client::open()?;
    let shown = repos.line(repo);
    let mut copies: Vec<String> = crate::work::worktrees(repo).into_iter().map(|(l, _)| l).collect();
    copies.push(crate::work::MAIN.into());
    // Each copy is brought into step and checked, all before any goes.
    let mut gone = Vec::new();
    for line in &copies {
        let key = key_of(repo, line);
        let _held = lock(&key)?;
        let dir = if line == crate::work::MAIN { repos.root().join(repo) } else { crate::work::worktree(repo, line) };
        let _ = crate::work::show_for_free(repo, line);
        let s = sync_with(&client, repos, repo);
        let _ = crate::work::show_for_free(repo, &shown);
        let s = s?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, why));
        }
        if let Some(p) = s.both.first() {
            return Err(crate::tr!("Another device's change was put beside yours; check it before freeing ({})", "別の端末の変更を横に置きました。確かめてから空けてください（{}）", p));
        }
        let here = local_tree(&dir);
        let b = base(&key).ok_or_else(|| crate::tr!("Not synced yet", "まだ同期していません"))?;
        if here.tree != b.tree {
            return Err(crate::tr!("It changed while syncing; try again", "同期のあいだに変わりました。もう一度どうぞ"));
        }
        // Asked once more: the Remote's draft must be this very tree.
        let there = client.json("GET", &at(repo, line, ""), None)?;
        if tree_of(&there["draft"]) != here.tree {
            return Err(crate::tr!("The Remote's copy is not complete yet", "Remote の写しがまだ揃っていません"));
        }
        gone.push((key, dir));
    }
    let mut bytes = 0;
    for (key, dir) in gone {
        bytes += crate::usage::allocated(&dir);
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        forget_base(&key);
    }
    let _ = crate::work::show_for_free(repo, crate::work::MAIN);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(pairs: &[(&str, Option<&str>)]) -> Tree {
        pairs.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect()
    }

    #[test]
    fn only_their_changes_are_taken_and_a_file_changed_on_both_keeps_both() {
        let base = t(&[("a", Some("1")), ("b", Some("1")), ("c", Some("1")), ("gone", Some("1")), ("edited", Some("1"))]);
        let here = t(&[("a", Some("2")), ("b", Some("1")), ("c", Some("x")), ("gone", Some("1")), ("new", Some("n"))]);
        let there = t(&[("a", Some("1")), ("b", Some("3")), ("c", Some("y")), ("dir", None), ("edited", Some("2"))]);
        let p = plan(&base, &here, &there);
        // Removed here but changed there: the change comes back.
        assert_eq!(p.take, vec![("b".into(), Some(Some("3".into()))), ("dir".into(), Some(None)), ("edited".into(), Some(Some("2".into()))), ("gone".into(), None)]);
        assert_eq!(p.both, vec![("c".into(), Some("y".into()))]);
    }

    #[test]
    fn the_other_devices_version_goes_beside_it() {
        assert_eq!(beside("README.md"), "README (別の端末).md");
        assert_eq!(beside("src/main.c"), "src/main (別の端末).c");
        assert_eq!(beside("Makefile"), "Makefile (別の端末)");
        assert_eq!(beside(".env"), ".env (別の端末)");
    }

    #[test]
    fn the_tree_leaves_out_git_and_links_and_says_so() {
        let d = std::env::temp_dir().join(format!("length3-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::create_dir_all(d.join("empty")).unwrap();
        fs::create_dir_all(d.join("src")).unwrap();
        fs::write(d.join("src/a.bin"), [0u8, 159, 146, 150]).unwrap();
        fs::write(d.join(".length3-1-x"), "half written").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", d.join("link")).unwrap();
        let l = local_tree(&d);
        assert_eq!(l.tree.keys().cloned().collect::<Vec<_>>(), ["empty", "src/a.bin"]);
        assert_eq!(l.tree["empty"], None);
        let why: Vec<&str> = l.unsynced.iter().map(|(p, _)| p.as_str()).collect();
        assert!(why.contains(&".git") && why.contains(&"link"), "{why:?}");
        assert!(place(&d, "../x").is_err() && place(&d, ".git/config").is_err() && place(&d, "link/x").is_err());
        // A file rewritten in place is read again.
        let before = l.tree["src/a.bin"].clone();
        fs::write(d.join("src/a.bin"), "changed").unwrap();
        assert_ne!(local_tree(&d).tree["src/a.bin"], before);
        let _ = fs::remove_dir_all(&d);
    }
}
