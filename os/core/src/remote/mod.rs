//! This device and the Remote (service/app.ts), for l3 and the app alike.
//! The canonical copy is the Remote's; a repo here is a copy kept in step
//! with it:
//!
//!   draft   the working tree, sent as a diff after every change, each on
//!           the version it was read at (so nothing sent is overwritten)
//!   cut     Commit: the draft at a version becomes history (history.rs)
//!
//! Taking in is file by file against the last version agreed with the
//! Remote (the base): a file only changed there is written here, one only
//! changed here is sent, and when both changed one, the Remote's (it got
//! there first) keeps the name and this device's is written beside it as
//! "name (<this device>).ext", so neither is lost and the name says whose.
//! Files that cannot travel (links, files over 16 MiB) and a repo's own
//! .git are not sent, and are named; a repo holding them is never freed.
//!
//! A repo on the Remote need not be here: 空ける removes the copy once the
//! Remote holds all of it, and opening the repo brings it back.
//!
//! Here: the session, what was agreed (the base) and syncing, which uses
//!   http    requests to the Remote and how each failed
//!   login   signing a device in and out
//!   local   the copy here as the Remote would hold it
//!   merge   the plan for taking in, and writing it into the copy

mod http;
mod local;
mod login;
mod merge;

pub use self::http::*;
pub use self::local::*;
pub use self::login::*;
pub use self::merge::*;

use crate::repos::{is_git_name, Repos};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub type Tree = BTreeMap<String, Option<String>>;
/// Beside a tree, each file's mode where it has an execute bit: path -> its permission bits (0o755). A path
/// not in it is a plain file. The Remote keeps the same beside each draft and commit (DESIGN.md §6, "A file's mode").
pub type Modes = BTreeMap<String, u32>;
type Result<T> = std::result::Result<T, String>;

/// The modes of `tree`'s files only.
pub(crate) fn modes_for(tree: &Tree, modes: &Modes) -> Modes {
    modes.iter().filter(|(p, _)| matches!(tree.get(*p), Some(Some(_)))).map(|(p, m)| (p.clone(), *m)).collect()
}

pub const BLOB_LIMIT: u64 = 16 << 20;
/// The Remote this OS ships with: one name for the app, the Remote, the DNS records people
/// publish (`remote=os.length3.com`) and passkeys.
pub const DEFAULT_URL: &str = "https://os.length3.com";
/// The name the Remote had before (0.4.x signed in by it). The same Worker still answers it, so
/// those releases keep working; a device that kept it is taken to DEFAULT_URL, its session and all.
pub const FORMER_URL: &str = "https://remote.length3.com";
/// Paths one diff carries at most (the Remote takes 5000).
const CHUNK: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub url: String,
    pub token: String,
    /// The account the session is (its id on the Remote), when it was told at sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

/// A Remote's URL as it is used now: the former name of the one this OS ships with is its name today.
pub fn current_url(url: &str) -> String {
    let url = url.trim_end_matches('/');
    if url.eq_ignore_ascii_case(FORMER_URL) { DEFAULT_URL.into() } else { url.into() }
}

/// The Remote this device is connected to, if it is (Home's `remote` setting).
pub fn connection() -> Option<Connection> {
    let text = crate::home::get("remote").ok()??;
    let c: Connection = serde_json::from_str(&text).ok()?;
    Some(Connection { url: current_url(&c.url), ..c })
}

pub fn save_connection(c: &Connection) -> Result<()> {
    crate::home::set("remote", &serde_json::to_string(c).map_err(|e| e.to_string())?)
}

/// Forget the Remote here: its session and every base (the repos stay).
pub fn forget_connection() -> Result<()> {
    crate::home::set("remote", "null")?;
    // A base left behind would be taken for what the next Remote agreed (another account's, perhaps),
    // and a file it does not hold would be removed here as if removed there: it must go.
    gone(fs::remove_dir_all(sync_dir()))
}

/// A removal whose target is already gone has done its work.
fn gone(r: std::io::Result<()>) -> Result<()> {
    match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The Remote to sign in to: $LENGTH3_REMOTE, else the one this OS ships with.
pub fn default_url() -> String {
    current_url(&std::env::var("LENGTH3_REMOTE").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.into()))
}

// ---- what was last agreed with the Remote ----

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
pub fn forget_line(repo: &str, line: &str) -> Result<()> {
    forget_base(&key_of(repo, line))
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
    // Durable: it is the record of what the Remote agreed, which every later sync goes by.
    crate::atomic::replace(&path, &serde_json::to_vec(b).map_err(|e| e.to_string())?, crate::atomic::How::RECORD)
        .map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))
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

/// Nothing is agreed for `repo` any more; one left behind would be taken for what the Remote has.
fn forget_base(repo: &str) -> Result<()> {
    gone(fs::remove_file(base_file(repo)))
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

pub(crate) fn at_path(repo: &str, line: &str, rest: &str) -> String { at(repo, line, rest) }

pub(crate) fn tree_of(v: &serde_json::Value) -> Tree {
    v.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from))).collect()).unwrap_or_default()
}

/// A line of a repo as the Remote holds it (`GET /v1/repos/:name`).
#[derive(Debug, PartialEq)]
struct LineThere {
    version: i64,
    draft: Tree,
    head: Option<String>,
    /// Its files' modes; None from a Remote that keeps none yet (one before modes were).
    modes: Option<Modes>,
}

/// What the Remote said of a line, when it said it as a Remote does: a version, a draft each of whose
/// entries is a digest or a folder (null), and a head or none. Anything else is refused, never taken for
/// a line with no files (bug: a network's sign-in page was read as version 0 with nothing in it, and
/// every file here unchanged since the last agreement was removed).
fn line_there(url: &str, v: &serde_json::Value) -> Result<LineThere> {
    let version = v["version"].as_i64().filter(|n| *n >= 0);
    let draft = v["draft"].as_object().filter(|d| d.values().all(|x| x.is_string() || x.is_null()));
    let head = match &v["head"] { serde_json::Value::Null => Some(None), serde_json::Value::String(h) => Some(Some(h.clone())), _ => None };
    // Modes, when it keeps them: each a file's permission bits.
    let modes = match &v["modes"] {
        serde_json::Value::Null => Some(None),
        serde_json::Value::Object(o) => o.iter().map(|(p, m)| m.as_u64().filter(|m| *m <= 0o777).map(|m| (p.clone(), m as u32))).collect::<Option<Modes>>().map(Some),
        _ => None,
    };
    match (version, draft, head, modes) {
        (Some(version), Some(_), Some(head), Some(modes)) => {
            let draft = tree_of(&v["draft"]);
            let modes = modes.map(|m| modes_for(&draft, &m));
            Ok(LineThere { version, draft, head, modes })
        }
        _ => Err(odd(url)),
    }
}

// ---- syncing ----

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Synced {
    pub version: i64,
    /// Paths sent, and paths written here from the Remote.
    pub sent: usize,
    pub taken: usize,
    /// Changed on both sides: the Remote's kept at its name, this device's beside it.
    pub both: Vec<String>,
    pub unsynced: Vec<(String, String)>,
    /// Every path this copy changed by taking in (a file written or removed, a folder made, a copy kept
    /// beside), so a page tells each to what shows it, rather than reading the whole repo again.
    #[serde(default)]
    pub paths: Vec<String>,
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
    let mut out = Synced::default();
    let who = account_id();
    let mut first: Option<Tree> = None;
    for _ in 0..12 {
        let agreed = base(&key);
        // Agreed with another account (another person signed in on this device): this copy is theirs, and is
        // neither sent to this account nor joined with its repo of the same name.
        if let (Some(was), Some(now)) = (agreed.as_ref().and_then(|b| b.who.as_deref()), who.as_deref()) {
            if was != now {
                return Err(failed(Failure::Status(403), crate::tr!("This copy was kept in step by another account; sign in as it to keep it in step",
                    "この写しは別のアカウントで同期していました。そのアカウントでサインインすると同期します")));
            }
        }
        let draft = draft_path(repo, &line, agreed.is_some());
        let base = agreed.unwrap_or_default();
        let here = local_tree(&dir);
        first.get_or_insert_with(|| here.tree.clone());
        out.unsynced = here.unsynced.clone();
        // Before sending, see whether the Remote moved.
        let there = there_of(&client.url, client.call("GET", &path, None)?, base.version)?;
        let remote_version = there.as_ref().map_or(0, |l| l.version);
        // Whether the Remote keeps modes: one that has the line says; one that has not, is taken to (what is sent says them).
        let kept = there.as_ref().is_none_or(|l| l.modes.is_some());
        if !kept {
            // Said, never let go of: an execute bit only here is not on the Remote, so this copy is not the last to free.
            for p in here.modes.keys() { out.unsynced.push((p.clone(), crate::tr!("its execute bit (this Remote keeps no modes yet)", "実行ビット（この Remote はまだモードを持ちません）"))); }
        }
        if remote_version != base.version {
            let (tree, head, modes) = there.map_or((Tree::new(), None, None), |l| (l.draft, l.head, l.modes));
            let p = plan(&base.tree, &here.tree, &tree);
            out.both.extend(apply(client, &dir, &here.tree, &p, modes.as_ref())?);
            // A mode changed there only (the file's bytes as they were) is taken too; one changed here stays and is sent.
            if let Some(m) = &modes { take_modes(&dir, &base.modes, &here.modes, m, &tree, &p); }
            out.taken += p.take.len();
            set_base(&key, &Base { version: remote_version, tree, head, moded: modes.is_some(), modes: modes.unwrap_or(base.modes), who: who.clone() })?;
            continue;
        }
        // The Remote can commit without touching the draft (a work's first start commits main
        // as it stands): its head is then newer than the one kept, though the version is not.
        let mut base = base;
        let said = there.as_ref().map(|l| (l.head.clone(), l.modes.is_some()));
        if let Some((head, moded)) = said.filter(|(h, m)| *h != base.head || *m != base.moded) {
            (base.head, base.moded) = (head, moded);
            set_base(&key, &base)?;
        }
        let moded = |p: &String| kept && here.modes.get(p) != base.modes.get(p);
        let mut set: Vec<(&String, &Option<String>)> = here.tree.iter().filter(|(p, v)| base.tree.get(*p) != Some(*v) || moded(p)).collect();
        let mut remove: Vec<&String> = base.tree.keys().filter(|p| !here.tree.contains_key(*p)).collect();
        if set.is_empty() && remove.is_empty() {
            out.version = base.version;
            if let Some(was) = first.as_ref().filter(|_| out.taken > 0 || !out.both.is_empty()) {
                out.paths = was.keys().chain(here.tree.keys()).filter(|p| was.get(*p) != here.tree.get(*p)).cloned().collect();
                out.paths.sort();
                out.paths.dedup();
            }
            // An agreement from before accounts were noted is this account's from now on.
            if who.is_some() && base.version > 0 && base.who != who {
                base.who = who.clone();
                set_base(&key, &base)?;
            }
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
        let mut body = serde_json::json!({
            "version": base.version,
            "set": set.iter().map(|(p, v)| ((*p).clone(), serde_json::json!(v))).collect::<serde_json::Map<_, _>>(),
            "remove": remove,
        });
        // Each file set with an execute bit, its mode; a file set without one is a plain file there too.
        if kept { body["modes"] = serde_json::json!(set.iter().filter_map(|(p, _)| here.modes.get(*p).map(|m| ((*p).clone(), *m))).collect::<Modes>()); }
        // A conflict (someone else moved it, or a blob went missing) goes round again.
        if let Reply::Ok(v) = client.call("PATCH", &draft, Some(body))? {
            // Without the version it is at now, nothing is agreed: the next round reads the line again.
            let version = v["version"].as_i64().ok_or_else(|| odd(&client.url))?;
            let mut tree = base.tree.clone();
            for p in &remove {
                tree.remove(*p);
                let under = format!("{p}/");
                tree.retain(|q, _| !q.starts_with(&under));
            }
            for (p, v) in &set { tree.insert((*p).clone(), (*v).clone()); }
            let mut modes = base.modes.clone();
            if kept { for (p, _) in &set { match here.modes.get(*p) { Some(m) => { modes.insert((*p).clone(), *m); } None => { modes.remove(*p); } } } }
            let modes = modes_for(&tree, &modes);
            out.sent += set.len() + remove.len();
            out.version = version;
            set_base(&key, &Base { version, tree, head: base.head, modes, moded: base.moded || kept, who: who.clone() })?;
        }
    }
    // Still moving after every round: not in step, and said so, rather than taken for it.
    Err(crate::tr!("The Remote kept moving; it is tried again", "Remote の側が動き続けています。あとでもう一度送ります"))
}

/// Where a line's diff is sent. A copy never in step with the Remote makes it
/// anew, even under a name the Remote remembers as discarded (src/remote/sync.ts);
/// one that was in step cannot bring back what was discarded by sending itself.
fn draft_path(repo: &str, line: &str, agreed: bool) -> String {
    let p = at(repo, line, "/draft");
    if agreed || line != crate::work::MAIN { p } else { format!("{p}?anew=1") }
}

/// What the Remote has of a line, for a copy that last agreed `agreed` with it,
/// taken only as a Remote says it (line_there). Not there, it has nothing of the
/// line, unless the copy was in step before (discarded there, or another
/// account's): then nothing here is taken for removed, and why is said
/// (src/remote/sync.ts does the same).
fn there_of(url: &str, reply: Reply, agreed: i64) -> Result<Option<LineThere>> {
    match reply {
        Reply::Ok(v) => Ok(Some(line_there(url, &v)?)),
        Reply::NotFound(v) if agreed > 0 => Err(failed(Failure::Status(404), if v["gone"].is_null() {
            crate::tr!("The Remote does not have this repo; the copy here is kept", "Remote にこの repo がありません。ここの写しは残してあります")
        } else {
            crate::tr!("This repo was discarded on the Remote; the copy here is kept", "この repo は Remote で破棄されました。ここの写しは残してあります")
        })),
        Reply::NotFound(_) => Ok(None),
        Reply::Conflict(_) => Err(odd(url)),
    }
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
    /// Turned off (ms since the epoch): the Remote keeps it until `until`, answering only that it is off.
    #[serde(rename = "offAt", default)]
    pub off_at: Option<u64>,
    #[serde(default)]
    pub until: Option<u64>,
}

/// Bring back a repo that was turned off, at once. Turning one off asks for a passkey, so it is the app's.
pub fn turn_on(repo: &str) -> Result<()> {
    Client::open()?.json("POST", &format!("/v1/repos/{repo}/on"), Some(serde_json::json!({}))).map(|_| ())
}

pub fn remote_repos() -> Result<Vec<RemoteRepo>> {
    serde_json::from_value(Client::open()?.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())
}

// ---- Home's settings (home.rs says how they are agreed) ----

impl crate::home::HomeThere for Client {
    fn get(&self, key: &str) -> Result<(Option<String>, i64)> {
        crate::home::got(&self.json("GET", &format!("/v1/home/{key}"), None)?)
    }

    fn put(&self, key: &str, value: &str, version: i64) -> Result<Option<i64>> {
        match self.call("PUT", &format!("/v1/home/{key}"), Some(crate::home::put_body(value, version)))? {
            Reply::Ok(v) => crate::home::put_version(&v).map(Some),
            Reply::Conflict(_) => Ok(None),
            Reply::NotFound(_) => Err(failed(Failure::Status(404), crate::tr!("The Remote does not keep {}", "Remote は {} を持ちません", key))),
        }
    }
}

/// The account this device is signed in as. A session kept without it noted (a browser's sign-in): the
/// Remote is asked whose it is, once, and it is noted.
fn account_id() -> Option<String> {
    connection().and_then(|c| c.user.clone().or_else(|| {
        let who = login::whose(&c.url, &c.token)?;
        let _ = save_connection(&Connection { user: Some(who.clone()), ..c });
        Some(who)
    }))
}

/// Agree one of Home's settings (home::SYNCED) with the Remote: what changed
/// here is sent, what changed there is taken in, one device at a time.
pub fn sync_home(key: &str) -> Result<crate::home::HomeSynced> {
    if !crate::home::SYNCED.contains(&key) {
        return Err(crate::tr!("{} is this device's own; it is not kept on the Remote", "{} はこの端末のもので、Remote には置きません", key));
    }
    let client = Client::open()?;
    let who = account_id();
    // Not a repo's name (no repo is called with a ~), so its own lock.
    let _held = lock("~home")?;
    // What this device ran is kept as what it trusts before the Remote's dotfiles come in (home.rs keep_trust).
    if key == "dotfiles" { crate::home::keep_trust()?; }
    crate::home::agree_with(&mut crate::home::Files, &client, key, who.as_deref())
}

/// One of Home's settings taken off this device, when it is what the Remote has (home.rs leave): whether it went.
pub fn leave_home(key: &str) -> Result<bool> {
    if !crate::home::SYNCED.contains(&key) {
        return Err(crate::tr!("{} is this device's own; it is not kept on the Remote", "{} はこの端末のもので、Remote には置きません", key));
    }
    let _held = lock("~home")?;
    crate::home::leave(&mut crate::home::Files, key)
}

/// Whether a setting here waits to be sent (it differs from what was last agreed); no request is made.
pub fn home_waiting(key: &str) -> bool {
    crate::home::SYNCED.contains(&key) && crate::home::waiting(&crate::home::Files, key)
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
    if let Reply::NotFound(_) = client.call("GET", &format!("/v1/repos/{repo}"), None)? {
        return Err(failed(Failure::Status(404), crate::tr!("The Remote has no repo {}", "Remote に repo {} はありません", repo)));
    }
    // It comes as main; the work on its issues comes when chosen.
    forget_base(repo)?;
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
    /// Files in the copy here (what is sent of it).
    pub files: usize,
    pub unsynced: Vec<(String, String)>,
    pub bytes: u64,
    pub head: Option<String>,
    pub version: i64,
}

pub fn status_of(repos: &Repos, name: &str) -> Result<Status> {
    let mut here = local_tree(&repos.dir(name)?);
    let b = base(&key(repos, name).0);
    // A mode is a change only where the Remote keeps modes; where it said it keeps none, an execute bit cannot be sent.
    let moded = b.as_ref().is_none_or(|b| b.moded);
    let changed = match &b {
        Some(b) => here.tree.iter().filter(|(p, v)| b.tree.get(*p) != Some(*v) || (moded && here.modes.get(*p) != b.modes.get(*p))).count() + b.tree.keys().filter(|p| !here.tree.contains_key(*p)).count(),
        None => here.tree.len(),
    };
    if !moded { for p in here.modes.keys() { here.unsynced.push((p.clone(), crate::tr!("its execute bit (this Remote keeps no modes yet)", "実行ビット（この Remote はまだモードを持ちません）"))); } }
    Ok(Status {
        name: name.into(), changed, fresh: b.is_none(), files: here.tree.values().filter(|v| v.is_some()).count(), unsynced: here.unsynced, bytes: here.bytes,
        head: b.as_ref().and_then(|b| b.head.clone()), version: b.map_or(0, |b| b.version),
    })
}

pub fn status(repos: &Repos) -> Result<Vec<Status>> {
    repos.list()?.into_iter().map(|s| status_of(repos, &s.name)).collect()
}

/// 空ける for a repo: once the Remote holds exactly what is here, and nothing here
/// cannot go there, the copy here goes; it comes back when the repo is opened.
/// Every copy of the repo goes: main's and each issue's being worked on.
/// Returns the bytes they took.
///
/// What was checked is what goes, up to the moment it goes (bug: a file written after the check and
/// before the delete was deleted, and Free said it was freed). Each copy, checked, is moved aside in one
/// rename, so nothing can open its files by their names any more; then nothing may still hold it (a
/// program with a file or a folder in it open, or there as its current folder, could write on after);
/// then what was moved is read again whole, every byte, and must be what the Remote holds; only then
/// does it go. Anything short of that puts every copy back where it was and Free is refused: late bytes
/// are either on the Remote or here, never freed and nowhere.
pub fn free(repos: &Repos, repo: &str) -> Result<u64> {
    free_with(&Client::open()?, repos, repo)
}

// ---- a repo renamed, or taken from this device whole ----

/// What this device keeps with the Remote of `repo` by its name: its bases (main's and each line's), and the line
/// it shows.
fn records_of(repo: &str) -> Vec<PathBuf> {
    let Ok(dir) = fs::read_dir(sync_dir()) else { return Vec::new() };
    let (base, line, lines) = (format!("{repo}.json"), format!("{repo}.line"), format!("{repo}@"));
    dir.flatten().map(|e| e.path()).filter(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        name == base || name == line || (name.starts_with(&lines) && name.ends_with(".json"))
    }).collect()
}

/// Whether a Remote agreed `repo` with this device (a base is kept of it, or of the work on one of its issues): it
/// is on the Remote then, which knows an account's repos by their names.
pub fn agreed(repo: &str) -> bool {
    records_of(repo).iter().any(|p| p.extension().is_some_and(|x| x == "json"))
}

/// What this device keeps of `repo` by its name besides its copy: its works' copies, its environment and caches.
fn kept_by_name(repo: &str) -> [PathBuf; 3] {
    let data = crate::paths::data_dir();
    [data.join("work").join(repo), crate::owned::env_dir(&data, repo), crate::owned::cache_dir(&data, repo)]
}

/// Whether a Prompt has `repo` open: one its host runs (`open`), or one recorded running here (core/src/prompt.rs).
fn prompted(repo: &str, open: &[String]) -> bool {
    #[cfg(not(target_os = "wasi"))]
    if crate::prompt::running(&crate::paths::data_dir()).iter().any(|r| r.repo == repo) { return true; }
    open.iter().any(|o| o == repo)
}

/// `repo` named `to` on this device: its copy, and what this device keeps of it by its name (its works' copies, the
/// line it shows, its environment and caches), go to the new name. Only a repo no Remote has agreed is renamed: one on
/// the Remote is known there by its name, and every device keeps it in step by it. Never while a Prompt has it open,
/// and never over a repo of that name, here or (signed in) on the Remote.
pub fn rename_repo(repos: &Repos, repo: &str, to: &str, open: &[String]) -> Result<()> {
    repos.dir(repo)?;
    if !crate::repos::valid_name(to) {
        return Err(crate::tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", to));
    }
    if to == repo { return Ok(()); }
    if prompted(repo, open) {
        return Err(crate::tr!("A Prompt has {} open; stop it first", "{} は Prompt で開いています。先に止めてください", repo));
    }
    if agreed(repo) {
        return Err(crate::tr!("{} is on the Remote, which knows it by its name: it keeps it", "{} は Remote にあり、Remote はこの名前で知っています。名前はそのままです", repo));
    }
    let there = || crate::tr!("There is a repo {} already", "repo {} はもうあります", to);
    // Signed in, a name the Remote has is that repo's: this one renamed to it would be sent into it.
    if connection().is_some() && remote_repos()?.iter().any(|r| r.name == to) { return Err(there()); }
    let _held = lock(repo)?;
    crate::atomic::rename_new(&repos.root().join(repo), &repos.root().join(to))
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { there() } else { crate::repos::io_error(repo, &e) })?;
    // What goes with it by name follows it; what cannot (another left under the new name) stays without an owner,
    // as what a repo freed from here leaves, for Runtime to free.
    for (from, into) in kept_by_name(repo).iter().zip(kept_by_name(to)) {
        if from.exists() && !into.exists() { let _ = fs::rename(from, into); }
    }
    let _ = fs::rename(sync_dir().join(format!("{repo}.line")), sync_dir().join(format!("{to}.line")));
    Ok(())
}

/// `repo` taken from this device whole: its copy, what this device keeps of it by its name, and every record of it
/// with the Remote. What the Remote holds is not touched: a repo there is turned off or discarded there, asked for
/// as the Remote asks. Never while a Prompt has it open.
pub fn delete_repo(repos: &Repos, repo: &str, open: &[String]) -> Result<()> {
    let dir = repos.root().join(repo);
    repos.dir(repo)?;
    if prompted(repo, open) {
        return Err(crate::tr!("A Prompt has {} open; stop it first", "{} は Prompt で開いています。先に止めてください", repo));
    }
    let _held = lock(repo)?;
    // Moved aside in one step first, so nothing lists, opens or syncs it by its name while it goes.
    let aside = dir.with_file_name(format!(".{repo}.deleting-{}", crate::pid()));
    crate::atomic::rename_new(&dir, &aside).map_err(|e| crate::repos::io_error(repo, &e))?;
    fs::remove_dir_all(&aside).map_err(|e| crate::repos::io_error(repo, &e))?;
    for kept in kept_by_name(repo) { gone(fs::remove_dir_all(kept))?; }
    for record in records_of(repo) { gone(fs::remove_file(record))?; }
    Ok(())
}

/// Where a copy of `repo` is: main's in the repos, an issue's among the works.
fn copy_dir(repos: &Repos, repo: &str, line: &str) -> PathBuf {
    if line == crate::work::MAIN { repos.root().join(repo) } else { crate::work::worktree(repo, line) }
}

fn free_with(client: &Client, repos: &Repos, repo: &str) -> Result<u64> {
    let shown = repos.line(repo);
    let mut copies: Vec<String> = crate::work::worktrees(repo).into_iter().map(|(l, _)| l).collect();
    copies.push(crate::work::MAIN.into());
    // Turned off on the Remote: nothing can be sent to it, so a copy goes
    // only when it holds nothing the Remote lacks (the Remote keeps it 30 days).
    let off = serde_json::from_value::<Vec<RemoteRepo>>(client.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())?
        .into_iter().any(|r| r.name == repo && r.off_at.is_some());
    // Each copy's sync is held until it is gone or back, so no sync here writes it meanwhile.
    let mut held = Vec::new();
    let mut checked: Vec<(String, String, PathBuf, Tree, Modes)> = Vec::new();
    for line in &copies {
        let key = key_of(repo, line);
        held.push(lock(&key)?);
        let dir = copy_dir(repos, repo, line);
        if off {
            let (agreed, modes) = base(&key).map(|b| (b.tree, b.modes)).unwrap_or_default();
            let local = local_tree(&dir);
            let here = &local.tree;
            let changed = here.keys().chain(agreed.keys()).collect::<BTreeSet<_>>().into_iter()
                .filter(|p| here.get(*p) != agreed.get(*p) || local.modes.get(*p) != modes.get(*p)).count();
            if changed > 0 {
                return Err(if changed == 1 {
                    crate::tr!("1 change here is not on the Remote; turn it on to send it first", "ここの変更 1件が Remote にありません。オンにして先に送ってください")
                } else {
                    if changed == 1 { crate::tr!("1 change here is not on the Remote; turn it on to send it first", "ここの変更 1件が Remote にありません。オンにして先に送ってください") } else { crate::tr!("{} changes here are not on the Remote; turn it on to send them first", "ここの変更 {}件が Remote にありません。オンにして先に送ってください", changed) }
                });
            }
            checked.push((key, line.clone(), dir, agreed, modes));
            continue;
        }
        crate::work::show_for_free(repo, line)?;
        let s = sync_with(client, repos, repo);
        crate::work::show_for_free(repo, &shown)?;
        let s = s?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, why));
        }
        if let Some(p) = s.both.first() {
            return Err(crate::tr!("Both changed {}: this device's is kept beside it; check it before freeing", "{} は両方で変わりました。この端末の版を横に置いたので、確かめてから空けてください", p));
        }
        let here = local_tree(&dir);
        let b = base(&key).ok_or_else(|| crate::tr!("Not on the Remote yet", "まだ Remote にありません"))?;
        if here.tree != b.tree || here.modes != b.modes {
            return Err(crate::tr!("It changed while it was being sent; try again", "送っているあいだに変わりました。もう一度どうぞ"));
        }
        checked.push((key, line.clone(), dir, b.tree, b.modes));
    }
    // Moved aside, every copy, before any is let go.
    let mut moved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for (key, _, dir, _, _) in &checked {
        let aside = aside_of(dir);
        if let Err(e) = crate::atomic::rename_new(dir, &aside) {
            let why = crate::tr!("{} could not be moved to be freed: {}", "{} を空けるために動かせませんでした：{}", dir.display(), e);
            return Err(put_back(&moved).map_or(why.clone(), |lost| format!("{why}; {lost}")));
        }
        moved.push((key.clone(), dir.clone(), aside));
    }
    let refused = |why: String| -> String { put_back(&moved).map_or(why.clone(), |lost| format!("{why}; {lost}")) };
    // Nothing may hold what was moved: it could write on into it, and that would go with it.
    for (_, dir, aside) in &moved {
        if let Some(who) = held_open(aside) {
            return Err(refused(crate::tr!("{} is open in {}: it could still write there, so it is kept here (close it and free again)",
                "{} は {} が開いています。まだ書けるので、ここに残しました（閉じてからもう一度空けてください）", dir.display(), who)));
        }
    }
    // Read again whole, every byte (no digest kept from before counts): exactly what the Remote holds.
    for ((_, line, _, agreed, modes), (_, _, aside)) in checked.iter().zip(&moved) {
        let now = local_tree_fresh(aside);
        if !now.unsynced.is_empty() || now.tree != *agreed || now.modes != *modes {
            return Err(refused(crate::tr!("It changed while it was being freed; it is kept here and sent next", "空けているあいだに変わりました。ここに残し、次に送ります")));
        }
        if !off {
            let there = match client.json("GET", &at(repo, line, ""), None).and_then(|v| line_there(&client.url, &v)) {
                Ok(t) => t,
                Err(e) => return Err(refused(e)),
            };
            if there.draft != now.tree {
                return Err(refused(crate::tr!("The Remote's copy is not complete yet", "Remote の写しがまだ揃っていません")));
            }
            // An execute bit here is let go only when the Remote keeps it too: the last copy that has it is never freed otherwise.
            if there.modes.as_ref().unwrap_or(&Modes::new()) != &now.modes {
                return Err(refused(crate::tr!("The Remote does not keep a file's execute bit yet; it is kept here", "Remote がまだ実行ビットを持っていません。ここに残しました")));
            }
        }
    }
    let mut bytes = 0;
    for (key, _, aside) in &moved {
        bytes += crate::usage::allocated(aside);
        fs::remove_dir_all(aside).map_err(|e| e.to_string())?;
        forget_base(key)?;
    }
    drop(held);
    if !off { crate::work::show_for_free(repo, crate::work::MAIN)?; }
    Ok(bytes)
}

/// Where a copy is moved to be freed: beside it, under a name no repo, work or temporary has (a dot first,
/// and not this OS's temporary's), so nothing lists it, syncs it or reclaims it as a leftover meanwhile.
fn aside_of(dir: &Path) -> PathBuf {
    let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    dir.with_file_name(format!(".{name}.freeing-{}", crate::pid()))
}

/// Every copy moved aside put back where it was. None when all went back; else what could not, and where it is.
fn put_back(moved: &[(String, PathBuf, PathBuf)]) -> Option<String> {
    let mut lost = Vec::new();
    for (_, dir, aside) in moved.iter().rev() {
        if let Err(e) = crate::atomic::rename_new(aside, dir) {
            lost.push(crate::tr!("{} is kept at {} ({})", "{} は {} に残しました（{}）", dir.display(), aside.display(), e));
        }
    }
    (!lost.is_empty()).then(|| lost.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_that_holds_no_files_says_the_work_stays_here() {
        let said = |code: u16, body: &str| http::refused(code, body.as_bytes());
        let no_files = said(503, r#"{"error":"The Remote cannot hold files just now","files":false}"#);
        assert!(no_files == "The Remote cannot hold files just now; your work stays on this device"
            || no_files == "Remote はいまファイルを置けません。作業はこの端末に残ります", "{no_files}");
        // Any other 503 (its database out of reach) is said as the Remote says it.
        assert!(said(503, r#"{"error":"The Remote does not reach its database"}"#).contains("The Remote does not reach its database"));
    }

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
    fn only_a_line_as_the_remote_answers_it_is_taken() {
        let url = "https://os.length3.com";
        let ok = serde_json::json!({"version": 3, "draft": {"a.txt": "ab", "dir": null}, "head": "c1", "updatedAt": 1});
        assert_eq!(line_there(url, &ok).unwrap(), LineThere { version: 3, draft: t(&[("a.txt", Some("ab")), ("dir", None)]), head: Some("c1".into()), modes: None });
        // A Remote that keeps modes says them; only its files' are taken, and only as permission bits.
        let moded = serde_json::json!({"version": 3, "draft": {"run.sh": "ab", "dir": null}, "head": null, "modes": {"run.sh": 493, "dir": 493, "gone": 493}});
        assert_eq!(line_there(url, &moded).unwrap().modes, Some(Modes::from([("run.sh".to_string(), 0o755)])));
        for odd in [serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": []}), serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": {"a": "755"}}),
            serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": {"a": 0o4755}})] {
            assert!(line_there(url, &odd).is_err(), "{odd}");
        }
        assert_eq!(line_there(url, &serde_json::json!({"version": 0, "draft": {}, "head": null})).unwrap().head, None);
        for odd in [serde_json::Value::Null, serde_json::json!({}), serde_json::json!({"version": "3", "draft": {}, "head": null}),
            serde_json::json!({"version": 3, "draft": null, "head": null}), serde_json::json!({"version": 3, "draft": {"a": 1}, "head": null}),
            serde_json::json!({"version": -1, "draft": {}, "head": null}), serde_json::json!({"version": 3, "draft": {}, "head": 7})] {
            assert!(line_there(url, &odd).is_err(), "{odd}");
        }
    }

    #[test]
    fn what_a_remote_says_of_its_code_never_makes_the_wait_overflow_or_last_for_ever() {
        let code = |interval: u64, expires_in: u64| DeviceCode { device_code: "d".into(), user_code: "U".into(), verification_uri: String::new(),
            verification_uri_complete: String::new(), interval, expires_in };
        assert_eq!(polling(&code(5, 900)), (Duration::from_secs(900), Duration::from_secs(5)));
        assert_eq!(polling(&code(0, 0)), (Duration::from_secs(60), Duration::from_secs(1)));
        let (wait, step) = polling(&code(u64::MAX, u64::MAX));
        assert_eq!((wait, step), (Duration::from_secs(1800), Duration::from_secs(60)));
        // What panicked before: a deadline that far out.
        assert!(std::time::Instant::now().checked_add(Duration::from_secs(u64::MAX)).is_none());
        let _ = std::time::Instant::now() + wait;
    }

    #[test]
    fn a_session_is_another_on_another_remote_or_for_another_account() {
        let was = |user: Option<&str>| Connection { url: DEFAULT_URL.into(), token: "t".into(), user: user.map(String::from) };
        assert!(!another(&was(Some("u1")), DEFAULT_URL, Some("u1")));
        assert!(another(&was(Some("u1")), DEFAULT_URL, Some("u2")));
        assert!(another(&was(Some("u1")), "http://127.0.0.1:8787", Some("u1")));
        assert!(another(&was(None), "http://127.0.0.1:8787", None));
        // Whose either is cannot be told: the same account.
        assert!(!another(&was(None), DEFAULT_URL, Some("u2")));
        assert!(!another(&was(Some("u1")), DEFAULT_URL, None));
        // A session kept without an account reads as before; one with it keeps it.
        let old: Connection = serde_json::from_str(r#"{"url":"https://os.length3.com","token":"t"}"#).unwrap();
        assert_eq!(old.user, None);
        assert_eq!(serde_json::to_string(&was(None)).unwrap(), r#"{"url":"https://os.length3.com","token":"t"}"#);
    }

    #[test]
    fn a_copy_in_step_is_not_taken_apart_by_a_remote_without_it() {
        let url = "https://os.length3.com";
        // Never in step: the Remote's empty, and all here is new.
        assert_eq!(there_of(url, Reply::NotFound(Default::default()), 0), Ok(None));
        // In step before: not taken for removed there, and said.
        assert!(there_of(url, Reply::NotFound(serde_json::json!({"gone": 1})), 3).is_err_and(|e| e.contains("discarded") || e.contains("破棄")));
        assert!(there_of(url, Reply::NotFound(Default::default()), 3).is_err_and(|e| e.contains("does not have this repo") || e.contains("この repo がありません")));
        let line = serde_json::json!({"version": 3, "draft": {}, "head": null});
        assert_eq!(there_of(url, Reply::Ok(line), 3), Ok(Some(LineThere { version: 3, draft: Tree::new(), head: None, modes: None })));
    }

    #[test]
    fn a_copy_never_in_step_is_sent_as_a_new_repo() {
        assert!(draft_path("notes", crate::work::MAIN, false).ends_with("/draft?anew=1"));
        assert!(draft_path("notes", crate::work::MAIN, true).ends_with("/draft"));
        assert_eq!(draft_path("notes", "001", false), "/v1/repos/notes/draft?line=001");
    }

    #[test]
    fn the_other_devices_version_goes_beside_it() {
        assert_eq!(beside("README.md"), "README (other device).md");
        assert_eq!(beside("src/main.c"), "src/main (other device).c");
        assert_eq!(beside("Makefile"), "Makefile (other device)");
        assert_eq!(beside(".env"), ".env (other device)");
        assert_eq!(beside_as("docs/plan.md", "ren-laptop", 1), "docs/plan (ren-laptop).md");
        assert_eq!(beside_as("Makefile", "ren-laptop", 2), "Makefile (ren-laptop 2)");
        assert_eq!(tag_of("ren's laptop/../x"), "ren s laptop .. x");
        assert_eq!(tag_of(""), "this device");
    }

    #[test]
    fn a_link_planted_where_a_file_is_written_is_not_written_through() {
        let d = std::env::temp_dir().join(format!("length3-plant-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("repo")).unwrap();
        let outside = d.join("outside.txt");
        fs::write(&outside, "the person's own file").unwrap();
        let pid = std::process::id();
        // Where the writer used to put its temporary, and where it puts it now.
        std::os::unix::fs::symlink(&outside, d.join(format!("repo/.length3-{pid}-a.txt"))).unwrap();
        for n in 0..8 { std::os::unix::fs::symlink(&outside, d.join(format!("repo/.a.txt.length3-{pid}-{n}"))).unwrap(); }
        write_file(&d.join("repo/a.txt"), b"from the Remote").unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own file");
        assert_eq!(fs::read_to_string(d.join("repo/a.txt")).unwrap(), "from the Remote");
        // A link at the file's own name is refused, not followed.
        std::os::unix::fs::symlink(&outside, d.join("repo/b.txt")).unwrap();
        assert!(write_file(&d.join("repo/b.txt"), b"x").is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own file");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_remote_is_named_by_an_http_url() {
        for ok in ["http://127.0.0.1:8787", "https://os.length3.com", "https://r.example/x"] { assert!(valid_url(ok), "{ok}"); }
        for bad in ["nonsense", "ftp://x", "https://", "http:// x", "os.length3.com"] { assert!(!valid_url(bad), "{bad}"); }
    }

    #[test]
    fn the_remote_this_os_ships_with_is_os_length3_com_and_its_former_name_is_taken_to_it() {
        assert_eq!(DEFAULT_URL, "https://os.length3.com");
        assert!(valid_url(DEFAULT_URL));
        // A device that signed in by the former name (0.4.x) goes on with the same session on the one name.
        for former in ["https://remote.length3.com", "https://remote.length3.com/", "https://Remote.Length3.com"] { assert_eq!(current_url(former), DEFAULT_URL, "{former}"); }
        // Anything else is left as it is: another Remote, a path under the former name, plain http.
        for other in ["https://os.length3.com", "http://127.0.0.1:8787", "https://r.example/x", "https://remote.length3.com/x", "http://remote.length3.com"] {
            assert_eq!(current_url(other), other.trim_end_matches('/'), "{other}");
        }
    }

    #[test]
    fn a_device_is_approved_on_the_remote_or_the_app_it_names_and_nowhere_else() {
        // As the production Remote answers: the app on the one name the device reaches it by.
        let page = "https://os.length3.com/?device=&user_code=ABCD1234";
        assert!(device_page_ok(DEFAULT_URL, Some(DEFAULT_URL), page));
        assert!(device_page_ok(DEFAULT_URL, None, page));
        // A Remote that keeps its app on another name (as the former name did), only on that app's origin.
        let (remote, app) = ("https://remote.length3.com", Some("https://os.length3.com"));
        assert!(device_page_ok(remote, app, page));
        assert!(device_page_ok(remote, None, "https://remote.length3.com/?device=&user_code=X"));
        assert!(!device_page_ok(remote, None, page));
        assert!(!device_page_ok(DEFAULT_URL, Some(DEFAULT_URL), "https://remote.length3.com/?device=&user_code=X"));
        for bad in ["https://os.length3.com.evil.example/?device", "https://os.length3.com@evil.example/?device", "https://evil.example/?device",
            "http://os.length3.com/?device", "file:///etc/passwd", "javascript:alert(1)"] {
            assert!(!device_page_ok(remote, app, bad), "{bad}");
        }
        // What it names must be a bare origin over https; http only beside a Remote on http.
        // A browser reads a backslash as a slash and what is before an @ as no host: neither is an origin to name
        // (account.rs app_page asks the same of the page it opens).
        for bad in ["https://os.length3.com\\@evil.example/?account=off", "https://os.length3.com\\.evil.example/?device"] {
            assert!(!device_page_ok(remote, app, bad), "{bad}");
        }
        for bad_app in ["http://os.length3.com", "https://os.length3.com/x", "file://os.length3.com", "javascript:x", "",
            "https://evil.example\\@os.length3.com", "https://evil.example@os.length3.com"] {
            assert!(!device_page_ok(remote, Some(bad_app), &format!("{bad_app}/?device")), "{bad_app}");
        }
        assert!(device_page_ok("http://127.0.0.1:8790", Some("http://localhost:1420"), "http://localhost:1420/?device=&user_code=X"));
        // The Remote a page is checked against is one by its own URL too: the device's connection is set by whoever
        // signed in (remote_connect takes what the window says), and app_page builds its page on it, so a "Remote"
        // that is a file, a script or nothing would vouch for a page under itself that the opener hands the desktop.
        for (bad_remote, page) in [("file:///home/me/x", "file:///home/me/x/?account=off&repo=a"), ("javascript:alert(1)//", "javascript:alert(1)///?account=sign-in"),
            ("", "/?account=sign-in"), ("https://evil.example\\@os.length3.com", "https://evil.example\\@os.length3.com/?account=off&repo=a")] {
            assert!(!device_page_ok(bad_remote, None, page), "{bad_remote}");
        }
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
