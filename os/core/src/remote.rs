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
//! "name (<this device>).ext", so neither is lost and the name says whose. Files that cannot travel (links, files over 16 MiB) and a repo's
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

// ---- HTTP ----

fn agent(url: &str) -> ureq::Agent {
    crate::net::agent(url, Duration::from_secs(60))
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

/// Why the last request to the Remote failed, for a caller that says it in
/// its own way (l3's exit codes). Errors stay text; this is what kind of text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// This device is on no Remote.
    NotConnected,
    /// The Remote does not know this device's session any more (401).
    Unknown,
    /// No answer: the network, or the Remote is down.
    Unreachable,
    /// It answered with this status (404 included).
    Status(u16),
}

fn failures() -> &'static Mutex<Option<(Failure, String)>> {
    static F: OnceLock<Mutex<Option<(Failure, String)>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(None))
}

/// Keep `message` as the last failure of kind `f`, and give it back.
fn failed(f: Failure, message: String) -> String {
    if let Ok(mut last) = failures().lock() { *last = Some((f, message.clone())); }
    message
}

/// The last failure talking to the Remote in this process, and what it said.
pub fn last_failure() -> Option<(Failure, String)> {
    failures().lock().ok().and_then(|f| f.clone())
}

fn unknown() -> String {
    failed(Failure::Unknown, crate::tr!("The Remote no longer knows this device. Sign in again (l3 login)", "Remote がこの端末を覚えていません。もう一度サインインしてください（l3 login）"))
}

fn unreachable(e: ureq::Error) -> String {
    let (url, why) = match &e {
        ureq::Error::Transport(t) => (t.url().map(|u| u.host_str().unwrap_or_default().to_string() + &u.port().map(|p| format!(":{p}")).unwrap_or_default()).unwrap_or_default(), match t.kind() {
            ureq::ErrorKind::Dns => crate::tr!("its name is not found", "名前が見つかりません"),
            ureq::ErrorKind::ConnectionFailed => crate::tr!("no connection", "接続できません"),
            ureq::ErrorKind::TooManyRedirects => crate::tr!("too many redirects", "リダイレクトが多すぎます"),
            ureq::ErrorKind::Io => crate::tr!("the connection broke or timed out", "接続が切れたか、時間切れです"),
            ureq::ErrorKind::ProxyConnect | ureq::ErrorKind::ProxyUnauthorized | ureq::ErrorKind::InvalidProxyUrl => crate::tr!("the proxy refused", "プロキシが通しません"),
            ureq::ErrorKind::InvalidUrl | ureq::ErrorKind::UnknownScheme => crate::tr!("not an address", "アドレスではありません"),
            k => k.to_string(),
        }),
        other => (String::new(), other.to_string()),
    };
    let at = if url.is_empty() { String::new() } else { format!(" {url}") };
    failed(Failure::Unreachable, crate::tr!("The Remote{} cannot be reached ({})", "Remote{} に届きません（{}）", at, why))
}

/// What the Remote said when it refused: its `error`, in its words.
fn refused(code: u16, r: ureq::Response) -> String {
    let v: serde_json::Value = r.into_json().unwrap_or_default();
    let said = v["error"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
    let message = match (code, said.as_str()) {
        (401, _) => return unknown(),
        // A Remote with no place for files (service/bucket.ts): nothing was agreed, so what is here stays and is sent later.
        (503, _) if v["files"] == serde_json::Value::Bool(false) => crate::tr!("The Remote cannot hold files just now; your work stays on this device",
            "Remote はいまファイルを置けません。作業はこの端末に残ります"),
        (429, _) => crate::tr!("The Remote is asked too often just now; try again in a minute", "いま Remote への問い合わせが多すぎます。少し待ってからどうぞ"),
        // Turned off: the Remote keeps it for a while, answering only that.
        (410, _) => crate::tr!("It is turned off on the Remote (l3 remote on brings it back)", "Remote でオフになっています（l3 remote on で戻せます）"),
        // The plan's (service/plan.ts): what is paid, and what happens to the work (it stays here).
        (402, _) => match v["rule"].as_str().unwrap_or_default() {
            "repos" => crate::tr!("The free plan keeps no more repos on the Remote: this one stays on this device and waits (l3 remote plan)", "無料プランでは、これ以上の repo を Remote に置けません。この repo はこの端末に残り、待ちます（l3 remote plan）"),
            "bytes" => crate::tr!("The free plan keeps no more on the Remote: the change stays on this device and waits (l3 remote plan)", "無料プランでは、これ以上を Remote に置けません。変更はこの端末に残り、待ちます（l3 remote plan）"),
            "server" => crate::tr!("Making a server is part of the paid plan (l3 remote plan)", "サーバーを作るのは有料プランです（l3 remote plan）"),
            "domain" => crate::tr!("A name on your own domain is part of the paid plan (l3 remote plan)", "自分のドメインの名前は有料プランです（l3 remote plan）"),
            "names" => crate::tr!("More names on this Remote are part of the paid plan (l3 remote plan)", "この Remote で2つ目からの名前は有料プランです（l3 remote plan）"),
            _ => crate::tr!("That is part of the paid plan (l3 remote plan)", "それは有料プランです（l3 remote plan）"),
        },
        (507, _) => crate::tr!("The Remote is full: {} of {} used", "Remote がいっぱいです：{} のうち {} を使用", v["used"], v["quota"]),
        (413, _) => crate::tr!("Too large for the Remote ({})", "Remote には大きすぎます（{}）", said),
        (_, "") => crate::tr!("The Remote refused it ({})", "Remote が受け付けませんでした（{}）", code),
        _ => crate::tr!("The Remote refused it ({}): {}", "Remote が受け付けませんでした（{}）：{}", code, said),
    };
    failed(Failure::Status(code), message)
}

impl Client {
    pub(crate) fn open() -> Result<Client> {
        let c = connection().ok_or_else(|| failed(Failure::NotConnected, crate::tr!("This device is not signed in to a Remote (l3 login)", "この端末は Remote にサインインしていません（l3 login）")))?;
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
            Err(ureq::Error::Status(code, r)) => Err(refused(code, r)),
            Err(e) => Err(unreachable(e)),
        }
    }

    pub(crate) fn json(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value> {
        match self.call(method, path, body)? {
            Reply::Ok(v) => Ok(v),
            Reply::Conflict(v) => Err(failed(Failure::Status(409), match v["error"].as_str() {
                Some(e) => crate::tr!("The Remote holds something else here: {}", "Remote と食い違いました：{}", e),
                None => crate::tr!("The Remote holds something else here", "Remote と食い違いました"),
            })),
            Reply::NotFound => Err(failed(Failure::Status(404), crate::tr!("The Remote does not have it", "Remote にありません"))),
        }
    }

    /// A text the Remote answers with (a board taken home as markdown).
    pub(crate) fn text(&self, path: &str) -> Result<String> {
        match self.agent.get(&format!("{}{path}", self.url)).set("Authorization", &self.auth()).call() {
            Ok(r) => r.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(404, _)) => Err(failed(Failure::Status(404), crate::tr!("The Remote does not have it", "Remote にありません"))),
            Err(ureq::Error::Status(code, r)) => Err(refused(code, r)),
            Err(e) => Err(unreachable(e)),
        }
    }

    fn put_blob(&self, sha: &str, bytes: &[u8]) -> Result<()> {
        match self.agent.put(&format!("{}/v1/blobs/{sha}", self.url))
            .set("Authorization", &self.auth())
            .set("Content-Type", "application/octet-stream")
            .send_bytes(bytes)
        {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(code, r)) => Err(refused(code, r)),
            Err(e) => Err(unreachable(e)),
        }
    }

    pub(crate) fn blob(&self, sha: &str) -> Result<Vec<u8>> {
        let r = match self.agent.get(&format!("{}/v1/blobs/{sha}", self.url)).set("Authorization", &self.auth()).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => return Err(refused(code, r)),
            Err(e) => return Err(unreachable(e)),
        };
        let mut bytes = Vec::new();
        r.into_reader().take(BLOB_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        // Trusted only as far as it is what its name says.
        if sha256(&bytes) != sha {
            return Err(crate::tr!("What the Remote sent is not what its name says ({})", "Remote から届いたものが名前と合いません（{}）", &sha[..12.min(sha.len())]));
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
    match agent(url).post(&format!("{url}/api/auth/device/code")).send_json(serde_json::json!({"client_id": client})) {
        Ok(r) => r.into_json().map_err(|_| crate::tr!("{} did not answer as a Remote does", "{} は Remote の答え方をしませんでした", url)),
        Err(ureq::Error::Status(code, r)) => Err(refused(code, r)),
        Err(e) => Err(unreachable(e)),
    }
}

/// The origin of the web app the Remote `url` says it approves devices on (GET /v1/about, `app`), if it says one.
pub fn app_origin(url: &str) -> Option<String> {
    let v: serde_json::Value = agent(url).get(&format!("{url}/v1/about")).call().ok()?.into_json().ok()?;
    v.get("app")?.as_str().map(String::from)
}

/// Whether a device's code may be approved on `page`, the page the Remote `url` named: a page of
/// that Remote itself, or of the app's origin it says it has (`app`, app_origin), which is a bare
/// origin over https (http only for a Remote itself on http, as in development). The one this OS
/// ships with is both on os.length3.com; one elsewhere may keep its app on another name. Any other
/// site, or scheme, is not a page it stands behind.
pub fn device_page_ok(url: &str, app: Option<&str>, page: &str) -> bool {
    let url = url.trim_end_matches('/');
    if page.starts_with(&format!("{url}/")) { return true; }
    let Some(app) = app.map(|a| a.trim_end_matches('/')) else { return false };
    let bare = valid_url(app) && app.split_once("://").is_some_and(|(_, host)| !host.contains('/'));
    let over = app.starts_with("https://") || (app.starts_with("http://") && url.starts_with("http://"));
    bare && over && page.starts_with(&format!("{app}/"))
}

/// Whether `url` can name a Remote: http(s)://host[:port][/path], nothing else.
pub fn valid_url(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else { return false };
    let host = rest.split('/').next().unwrap_or_default();
    matches!(scheme, "http" | "https") && !host.is_empty()
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
        && !rest.contains(char::is_whitespace)
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
        // Asked too often: wait, as for slow_down.
        Err(ureq::Error::Status(429, _)) => Ok(None),
        Err(ureq::Error::Status(code, r)) => {
            let v: serde_json::Value = r.into_json().unwrap_or_default();
            match v.get("error").and_then(|e| e.as_str()) {
                Some("authorization_pending") | Some("slow_down") => Ok(None),
                Some("access_denied") => Err(crate::tr!("It was declined in the browser", "ブラウザで断られました")),
                Some("expired_token") => Err(expired()),
                other => {
                    let said = other.or(v["error_description"].as_str()).or(v["message"].as_str()).map_or_else(|| code.to_string(), String::from);
                    Err(failed(Failure::Status(code), crate::tr!("Could not sign in ({})", "サインインできませんでした（{}）", said)))
                }
            }
        }
        Err(e) => Err(unreachable(e)),
    }
}

fn expired() -> String {
    crate::tr!("The code expired before it was approved", "承認される前にコードの期限が切れました")
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
            return Err(expired());
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
        return Err(unknown());
    }
    Ok(Some(Account {
        url: c.url,
        user: v["user"]["id"].as_str().unwrap_or_default().into(),
        name: v["user"]["name"].as_str().unwrap_or_default().into(),
    }))
}

/// End this device's session on the Remote, then forget it here. Every repo
/// is sent first: forgetting what was agreed with a change still unsent
/// (a file removed here, say) would undo it at the next sign-in, when the
/// Remote's copy comes back as new. So a repo that cannot be sent stops it.
pub fn logout(repos: &Repos) -> Result<()> {
    let Ok(c) = Client::open() else { return forget_connection() };
    for s in repos.list()? {
        // Main's copy and each issue's, each in step before any record of them goes.
        let shown = repos.line(&s.name);
        let mut lines: Vec<String> = crate::work::worktrees(&s.name).into_iter().map(|(l, _)| l).collect();
        lines.push(crate::work::MAIN.into());
        for line in lines {
            let r = lock(&key_of(&s.name, &line)).and_then(|_held| {
                // Not shown, it would not be the copy sent; and the repo is shown again as it was, whatever sending did.
                crate::work::show_for_free(&s.name, &line)?;
                let r = sync_with(&c, repos, &s.name);
                crate::work::show_for_free(&s.name, &shown).and(r)
            });
            if let Err(e) = r {
                let what = if line == crate::work::MAIN { s.name.clone() } else { format!("{}@{line}", s.name) };
                return Err(crate::tr!("{} could not be sent first ({}); this device stays on the Remote so nothing is lost. Once it is sent, sign out again",
                    "{} を先に送れませんでした（{}）。何も失わないよう、この端末は Remote につないだままです。送れたら、もう一度外してください", what, e));
            }
        }
    }
    // SSH stops with the device's session: no one reaches its Prompts once it is signed out.
    #[cfg(unix)]
    let _ = crate::ssh::stop(&crate::paths::data_dir());
    // Everything is sent: signed out here whatever the Remote answers (its session ends there by itself).
    let _ = c.call("POST", "/api/auth/sign-out", Some(serde_json::json!({})));
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
    /// Every file digested, for the stamps kept (stamps_save).
    read: Vec<PathBuf>,
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
    let kept = stamps_file(dir);
    if let Some(f) = &kept { stamps_load(f); }
    let mut out = Local::default();
    walk(dir, "", &mut out);
    if let Some(f) = &kept { stamps_save(f, &out.read); }
    out
}

/// Where the digests of a repo copy are kept between runs, as git keeps its
/// index: by each file's size, time and inode, so l3 (a new process each
/// time) reads again only what changed instead of every byte of every repo.
/// They are what sync last read, so they are kept with sync's other records.
/// Only copies this OS holds are kept for.
fn stamps_file(dir: &Path) -> Option<PathBuf> {
    let (data, repos) = (crate::paths::data_dir(), crate::paths::repos_dir());
    if !(dir.starts_with(&data) || dir.starts_with(&repos)) { return None; }
    // Where they were kept before (cache/digests): nothing reads it now.
    let old = data.join("cache");
    if old.join("digests").is_dir() { let _ = fs::remove_dir_all(old.join("digests")); let _ = fs::remove_dir(&old); }
    Some(sync_dir().join("digests").join(&sha256(dir.to_string_lossy().as_bytes())[..16]))
}

/// Take in kept digests. A file changed within the same moment the stamps
/// were written may look unchanged (a coarse clock), so, as git does with a
/// racily clean index, those are read again.
fn stamps_load(file: &Path) {
    let Ok(text) = fs::read_to_string(file) else { return };
    let mut lines = text.lines();
    let Some(written) = lines.next().and_then(|l| l.parse::<i128>().ok()) else { return };
    let Ok(mut map) = seen().lock() else { return };
    for line in lines {
        let mut w = line.splitn(5, ' ');
        let (Some(len), Some(t), Some(ino), Some(sha), Some(path)) = (w.next(), w.next(), w.next(), w.next(), w.next()) else { continue };
        let (Ok(len), Ok(t), Ok(ino)) = (len.parse::<u64>(), t.parse::<i128>(), ino.parse::<u64>()) else { continue };
        if t >= written - 2_000_000_000 { continue; }
        map.entry(PathBuf::from(path)).or_insert(((len, t, ino), sha.to_string()));
    }
}

/// Keep the digests of the files just read: exactly these, so what is gone is forgotten.
fn stamps_save(file: &Path, read: &[PathBuf]) {
    let Ok(map) = seen().lock() else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i128);
    let mut text = format!("{now}\n");
    for p in read {
        let Some(((len, t, ino), sha)) = map.get(p) else { continue };
        let path = p.to_string_lossy();
        if path.contains('\n') { continue; }
        text.push_str(&format!("{len} {t} {ino} {sha} {path}\n"));
    }
    drop(map);
    let Some(dir) = file.parent() else { return };
    if fs::create_dir_all(dir).is_err() { return; }
    let aside = dir.join(format!(".{}.length3-{}-0", file.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    if fs::write(&aside, text).is_ok() { let _ = fs::rename(&aside, file); }
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
            out.unsynced.push((rel, crate::tr!("git history", "git の履歴")));
            continue;
        }
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.file_type().is_symlink() {
            out.unsynced.push((rel, crate::tr!("a link", "リンク")));
        } else if meta.is_dir() {
            // Made from the repo's own files (owned.rs): not the repo's to send, nor what keeps it here.
            if crate::owned::derived(dir, &name, &e.path()) { continue; }
            walk(&e.path(), &rel, out);
        } else if meta.is_file() {
            if meta.len() > BLOB_LIMIT {
                out.unsynced.push((rel, crate::tr!("a file over 16 MB", "16 MB を超えるファイル")));
                continue;
            }
            let Some(sha) = digest(&e.path(), &meta) else { out.unsynced.push((rel, crate::tr!("a file that cannot be read", "読めないファイル"))); continue };
            out.bytes += meta.len();
            out.read.push(e.path());
            out.files.insert(sha.clone(), e.path());
            out.tree.insert(rel, Some(sha));
        } else {
            out.unsynced.push((rel, crate::tr!("a special file", "特殊なファイル")));
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

// ---- merging ----

/// What taking in a remote tree means here.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Paths to make what the Remote has (None: remove; Some(None): a folder).
    pub take: Vec<(String, Option<Option<String>>)>,
    /// Changed on both sides differently: theirs (the Remote's) takes the name, this device's goes beside it.
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

/// "dir/name (other device).ext" beside `path`: the Remote's, where something here is in its way.
pub fn beside(path: &str) -> String {
    beside_as(path, "other device", 1)
}

/// "dir/name (who).ext" beside `path`; the n'th such is "(who n)".
pub fn beside_as(path: &str, who: &str, n: u32) -> String {
    let (dir, file) = path.rsplit_once('/').map_or(("", path), |(d, f)| (d, f));
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let name = if n > 1 { format!("{stem} ({who} {n}){ext}") } else { format!("{stem} ({who}){ext}") };
    if dir.is_empty() { name } else { format!("{dir}/{name}") }
}

/// This machine as a file's name can carry it: its host name, its letters, digits and . _ - alone.
pub fn device_tag() -> String {
    let mut buf = [0u8; 256];
    let got = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    let raw = if got { String::from_utf8_lossy(&buf[..buf.iter().position(|&b| b == 0).unwrap_or(buf.len())]).into_owned() } else { String::new() };
    tag_of(&raw)
}

fn tag_of(raw: &str) -> String {
    let words: String = raw.chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { ' ' }).collect();
    let tag = words.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect::<String>();
    if tag.is_empty() { "this device".into() } else { tag }
}

/// A path inside `dir`, its folders made, refusing any part that is .git or a link.
fn place(dir: &Path, rel: &str) -> Result<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || is_git_name(p)) {
        return Err(crate::tr!("{}: cannot be written here", "{}：ここには書けません", rel));
    }
    let mut at = dir.to_path_buf();
    for p in &parts[..parts.len() - 1] {
        at.push(p);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(crate::tr!("{}: a part of the way is not a folder", "{}：途中がフォルダーではありません", rel)),
            Err(_) => fs::create_dir(&at).map_err(|e| crate::tr!("{}: {}", "{}：{}", at.display(), e))?,
        }
    }
    Ok(at.join(parts[parts.len() - 1]))
}

/// Write `bytes` to `path` whole: into a new file beside it, then renamed
/// over it. The new file is made afresh (O_EXCL), never opened through what
/// is already there: a program in a Prompt can plant a link at any name in
/// the repo, and writing through it would reach any file the person can
/// write. Its name is this OS's temporary (usage.rs), so the walk skips it
/// and a leftover is reclaimed.
fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) {
        return Err(crate::tr!("{}: something that is not a file is there", "{}：ファイルではないものがあります", path.display()));
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let (tmp, mut f) = (0..64).find_map(|_| {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = path.with_file_name(format!(".{name}.length3-{}-{n}", std::process::id()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => Some(Ok((tmp, f))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(e) => Some(Err(crate::tr!("{}: {}", "{}：{}", tmp.display(), e))),
        }
    }).unwrap_or_else(|| Err(crate::tr!("{}: no free name beside it to write through", "{}：書くための名前が横に空いていません", path.display())))?;
    let done = f.write_all(bytes).and_then(|_| f.sync_all()).and_then(|_| fs::rename(&tmp, path));
    done.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        crate::tr!("{}: {}", "{}：{}", path.display(), e)
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
    let unwritable = |path: &str| crate::tr!("{}: could not be written", "{}：書けませんでした", path);
    let put_beside = |path: &str, bytes: &[u8]| -> Result<()> {
        let at = place(dir, &beside(path)).map_err(|_| unwritable(path))?;
        write_file(&at, bytes)
    };
    for (path, what) in &p.take {
        // What a derived directory holds here is made here; the Remote's word on it is not taken.
        if crate::owned::within_derived(dir, path) { continue; }
        let Ok(at) = place(dir, path) else {
            if let Some(Some(sha)) = what {
                let bytes = client.blob(sha)?;
                let top = path.split('/').next().unwrap_or(path);
                let moved = format!("{}{}", beside(top), &path[top.len()..]);
                write_file(&place(dir, &moved).map_err(|_| unwritable(path))?, &bytes)?;
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
        let Some(sha) = theirs else { continue };
        let bytes = client.blob(sha)?;
        // The Remote's keeps the name (it got there first); this device's is kept beside it first, under
        // this device's name, so neither is lost if writing the other fails, and the name says whose it is everywhere.
        let at = place(dir, path).map_err(|_| unwritable(path))?;
        match fs::read(&at) {
            Ok(mine) => {
                let who = device_tag();
                let mut n = 1;
                let mut keep = place(dir, &beside_as(path, &who, n)).map_err(|_| unwritable(path))?;
                while fs::symlink_metadata(&keep).is_ok() {
                    n += 1;
                    keep = place(dir, &beside_as(path, &who, n)).map_err(|_| unwritable(path))?;
                }
                write_file(&keep, &mine)?;
                write_file(&at, &bytes)?;
            }
            // Not a file here any more: the Remote's goes beside what is in its way.
            Err(_) => put_beside(path, &bytes)?,
        }
        aside.push(path.clone());
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
    /// Changed on both sides: the Remote's kept at its name, this device's beside it.
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
        // The Remote can commit without touching the draft (a work's first start commits main
        // as it stands): its head is then newer than the one kept, though the version is not.
        let mut base = base;
        let head = there.as_ref().map(|v| v["head"].as_str().map(String::from));
        if let Some(head) = head.filter(|h| *h != base.head) {
            base.head = head;
            set_base(&key, &base)?;
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
            Reply::NotFound => Err(failed(Failure::Status(404), crate::tr!("The Remote does not keep {}", "Remote は {} を持ちません", key))),
        }
    }
}

/// Agree one of Home's settings (home::SYNCED) with the Remote: what changed
/// here is sent, what changed there is taken in, one device at a time.
pub fn sync_home(key: &str) -> Result<crate::home::HomeSynced> {
    if !crate::home::SYNCED.contains(&key) {
        return Err(crate::tr!("{} is this device's own; it is not kept on the Remote", "{} はこの端末のもので、Remote には置きません", key));
    }
    let client = Client::open()?;
    // Not a repo's name (no repo is called with a ~), so its own lock.
    let _held = lock("~home")?;
    crate::home::agree_with(&mut crate::home::Files, &client, key)
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
    if let Reply::NotFound = client.call("GET", &format!("/v1/repos/{repo}"), None)? {
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

/// 空ける for a repo: once the Remote holds exactly what is here, and nothing here
/// cannot go there, the copy here goes; it comes back when the repo is opened.
/// Every copy of the repo goes: main's and each issue's being worked on.
/// Returns the bytes they took.
pub fn free(repos: &Repos, repo: &str) -> Result<u64> {
    let client = Client::open()?;
    let shown = repos.line(repo);
    let mut copies: Vec<String> = crate::work::worktrees(repo).into_iter().map(|(l, _)| l).collect();
    copies.push(crate::work::MAIN.into());
    // Turned off on the Remote: nothing can be sent to it, so a copy goes
    // only when it holds nothing the Remote lacks (the Remote keeps it 30 days).
    let off = serde_json::from_value::<Vec<RemoteRepo>>(client.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())?
        .into_iter().any(|r| r.name == repo && r.off_at.is_some());
    if off {
        return free_off(repos, repo, &copies);
    }
    // Each copy is brought into step and checked, all before any goes.
    let mut gone = Vec::new();
    for line in &copies {
        let key = key_of(repo, line);
        let _held = lock(&key)?;
        let dir = if line == crate::work::MAIN { repos.root().join(repo) } else { crate::work::worktree(repo, line) };
        crate::work::show_for_free(repo, line)?;
        let s = sync_with(&client, repos, repo);
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
        if here.tree != b.tree {
            return Err(crate::tr!("It changed while it was being sent; try again", "送っているあいだに変わりました。もう一度どうぞ"));
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
        forget_base(&key)?;
    }
    crate::work::show_for_free(repo, crate::work::MAIN)?;
    Ok(bytes)
}

/// Free the copies of a repo that is off: each must be as it was agreed, since none can be sent now.
fn free_off(repos: &Repos, repo: &str, copies: &[String]) -> Result<u64> {
    let mut gone = Vec::new();
    for line in copies {
        let key = key_of(repo, line);
        let dir = if line == crate::work::MAIN { repos.root().join(repo) } else { crate::work::worktree(repo, line) };
        let agreed = base(&key).map(|b| b.tree).unwrap_or_default();
        let here = local_tree(&dir).tree;
        let changed = here.keys().chain(agreed.keys()).collect::<std::collections::BTreeSet<_>>().into_iter().filter(|p| here.get(*p) != agreed.get(*p)).count();
        if changed > 0 {
            return Err(if changed == 1 {
                crate::tr!("1 change here is not on the Remote; turn it on to send it first", "ここの変更 1件が Remote にありません。オンにして先に送ってください")
            } else {
                crate::tr!("{} changes here are not on the Remote; turn it on to send them first", "ここの変更 {}件が Remote にありません。オンにして先に送ってください", changed)
            });
        }
        gone.push((key, dir));
    }
    let mut bytes = 0;
    for (key, dir) in gone {
        bytes += crate::usage::allocated(&dir);
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        forget_base(&key)?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_that_holds_no_files_says_the_work_stays_here() {
        let said = |code: u16, body: &str| refused(code, ureq::Response::new(code, "", body).unwrap());
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
        for bad_app in ["http://os.length3.com", "https://os.length3.com/x", "file://os.length3.com", "javascript:x", ""] {
            assert!(!device_page_ok(remote, Some(bad_app), &format!("{bad_app}/?device")), "{bad_app}");
        }
        assert!(device_page_ok("http://127.0.0.1:8790", Some("http://localhost:1420"), "http://localhost:1420/?device=&user_code=X"));
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
