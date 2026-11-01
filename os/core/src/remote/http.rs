//! Talking to the Remote over HTTP: one client carrying this device's
//! session, what kind of failure the last request was (l3 says each with
//! its own exit code), and answers taken only as a Remote gives them.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use super::*;
use crate::net::{send, Sent};

pub(crate) struct Client {
    pub(super) url: String,
    token: String,
}

/// What a request's body is.
pub(super) enum Body<'a> {
    None,
    Json(serde_json::Value),
    Bytes(&'a [u8]),
}

/// What one request to a Remote came to: an answer it gave (under 400), a refusal (its status, and what it
/// said), or no answer at all (said, and kept as the last failure).
pub(super) enum Got {
    Ok(Box<dyn Read + Send>),
    Status(u16, Box<dyn Read + Send>),
    Unreachable(String),
}

/// One request to the Remote: `method` to `url`, carrying `token` when there is one.
pub(super) fn request(method: &str, url: &str, token: Option<&str>, body: Body) -> Got {
    let auth = token.map(|t| format!("Bearer {t}"));
    let mut headers: Vec<(&str, &str)> = auth.as_deref().map(|a| vec![("Authorization", a)]).unwrap_or_default();
    let json = match &body { Body::Json(v) => Some(v.to_string()), _ => None };
    let bytes = match (&body, &json) {
        (Body::Json(_), Some(j)) => { headers.push(("Content-Type", "application/json")); Some(j.as_bytes()) }
        (Body::Bytes(b), _) => { headers.push(("Content-Type", "application/octet-stream")); Some(*b) }
        _ => None,
    };
    match send(method, url, &headers, bytes, Duration::from_secs(60)) {
        Sent::Answer { status, body } if status < 400 => Got::Ok(body),
        Sent::Answer { status, body } => Got::Status(status, body),
        Sent::Unreachable { host, why } => Got::Unreachable(unreachable(&host, &why)),
    }
}

pub(crate) enum Reply {
    Ok(serde_json::Value),
    Conflict(serde_json::Value),
    /// Not there; what the Remote said of it (a repo discarded for good says `gone`).
    NotFound(serde_json::Value),
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

/// The last failure: its kind, its words, and what the Remote said with it (a plan's rule, say).
type Last = Option<(Failure, String, serde_json::Value)>;

pub(super) fn failures() -> &'static Mutex<Last> {
    static F: OnceLock<Mutex<Last>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(None))
}

/// Keep `message` as the last failure of kind `f`, and give it back.
pub(super) fn failed(f: Failure, message: String) -> String {
    failed_with(f, message, serde_json::Value::Null)
}

fn failed_with(f: Failure, message: String, detail: serde_json::Value) -> String {
    if let Ok(mut last) = failures().lock() { *last = Some((f, message.clone(), detail)); }
    message
}

/// The last failure talking to the Remote in this process, and what it said.
pub fn last_failure() -> Option<(Failure, String)> {
    failures().lock().ok().and_then(|f| f.as_ref().map(|(f, m, _)| (*f, m.clone())))
}

/// What the Remote said with the last failure (its refusal's body), Null when nothing.
pub fn last_detail() -> serde_json::Value {
    failures().lock().ok().and_then(|f| f.as_ref().map(|(_, _, d)| d.clone())).unwrap_or_default()
}

/// Forget the last failure: what follows is told by its own.
pub fn forget_failure() {
    if let Ok(mut last) = failures().lock() { *last = None; }
}

pub(super) fn unknown() -> String {
    failed(Failure::Unknown, crate::tr!("The Remote no longer knows this device. Sign in again (l3 login)", "Remote がこの端末を覚えていません。もう一度サインインしてください（l3 login）"))
}

/// Not reached: `host` (and port), and why (net::send's words).
pub(super) fn unreachable(host: &str, why: &str) -> String {
    let at = if host.is_empty() { String::new() } else { format!(" {host}") };
    failed(Failure::Unreachable, crate::tr!("The Remote{} cannot be reached ({})", "Remote{} に届きません（{}）", at, why))
}

/// What the Remote said when it refused: its `error`, in its words.
pub(super) fn refused(code: u16, r: impl Read) -> String {
    let v = refusal(r);
    let said = v["error"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
    let message = match (code, said.as_str()) {
        (401, _) => return unknown(),
        // A Remote with no place for files (service/bucket.ts): nothing was agreed, so what is here stays and is sent later.
        (503, _) if v["files"] == serde_json::Value::Bool(false) => crate::tr!("Remote cannot accept files right now; changes stay on this device", "Remote に現在保存できません。作業内容はローカルデバイスに保持されます"),
        (429, _) => crate::tr!("The Remote is asked too often just now; try again in a minute", "いま Remote への問い合わせが多すぎます。少し待ってからどうぞ"),
        // Discarded for good (service/app.ts `gone`): nothing brings it back, and saying "turn it on" sent
        // people to a command that could only fail.
        (410, _) if !v["gone"].is_null() => crate::tr!("This repo was discarded on the Remote, and a copy that was in step with it does not bring it back; what changed here since stays on this device (to keep it on the Remote, make a new repo and move it there)",
            "この repo は Remote で破棄されました。同期していた写しからは戻りません。そのあとここで変えたものはこの端末に残ります（Remote に置くなら、新しい repo を作って移してください）"),
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
    failed_with(Failure::Status(code), message, v)
}

/// What the Remote said refusing one thing of several it answered at once (a repo of those asked where they stand),
/// in the words `refused` has for the same refusal on its own.
pub(crate) fn refused_in(code: u16, v: &serde_json::Value) -> String {
    refused(code, v.to_string().as_bytes())
}

/// The most of one answer read as JSON. The largest a Remote gives is a log: 50 commits with a tree each
/// (a tree is at most 8 MiB, service/app.ts LIMIT.tree); what goes past this is not an answer but a stream
/// that would be held in memory until there is none left.
pub(super) const ANSWER_LIMIT: u64 = 256 << 20;
/// The most of a refusal read: its words, a few fields.
pub(super) const REFUSAL_LIMIT: u64 = 64 << 10;

/// The JSON a Remote answered with; an empty answer (204) is null. One that is not JSON, or larger than
/// any answer is, is no answer to go by: what is in the way (a network's sign-in page, a proxy's) is not the Remote.
pub(super) fn answer(url: &str, r: impl Read) -> Result<serde_json::Value> {
    let text = body(r, ANSWER_LIMIT).map_err(|e| failed(Failure::Unreachable, crate::tr!("The Remote's answer broke off ({})", "Remote の答えが途中で切れました（{}）", e)))?;
    let Some(text) = text else { return Err(odd(url)) };
    if text.trim().is_empty() { return Ok(serde_json::Value::Null); }
    serde_json::from_str(&text).map_err(|_| odd(url))
}

/// A body read whole, as text, if it is at most `limit` bytes; None if it is larger (or not text).
pub(super) fn body(r: impl Read, limit: u64) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    r.take(limit + 1).read_to_end(&mut bytes)?;
    Ok(if bytes.len() as u64 > limit { None } else { String::from_utf8(bytes).ok() })
}

/// What a refusal says, as JSON (null when it says nothing readable).
pub(super) fn refusal(r: impl Read) -> serde_json::Value {
    body(r, REFUSAL_LIMIT).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// The Remote at `url` answered, but not as a Remote does: as if it were out of reach.
pub(super) fn odd(url: &str) -> String {
    failed(Failure::Unreachable, crate::tr!("{} did not answer as a Remote does (is a network's sign-in page in the way?)", "{} は Remote の答え方をしませんでした（ネットワークのサインイン画面が間に入っていませんか）", url))
}

impl Client {
    pub(crate) fn open() -> Result<Client> {
        let c = connection().ok_or_else(|| failed(Failure::NotConnected, crate::tr!("This device is not signed in to a Remote (l3 login)", "この端末は Remote にサインインしていません（l3 login）")))?;
        Ok(Client { url: c.url, token: c.token })
    }

    fn to(&self, method: &str, path: &str, body: Body) -> Got {
        request(method, &format!("{}{path}", self.url), Some(&self.token), body)
    }

    pub(crate) fn call(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<Reply> {
        match self.to(method, path, body.map_or(Body::None, Body::Json)) {
            Got::Ok(r) => Ok(Reply::Ok(answer(&self.url, r)?)),
            Got::Status(409, r) => Ok(Reply::Conflict(refusal(r))),
            Got::Status(404, r) => Ok(Reply::NotFound(refusal(r))),
            Got::Status(code, r) => Err(refused(code, r)),
            Got::Unreachable(e) => Err(e),
        }
    }

    pub(crate) fn json(&self, method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value> {
        match self.call(method, path, body)? {
            Reply::Ok(v) => Ok(v),
            Reply::Conflict(v) => Err(failed(Failure::Status(409), match v["error"].as_str() {
                Some(e) => crate::tr!("The Remote holds something else here: {}", "Remote と食い違いました：{}", e),
                None => crate::tr!("The Remote holds something else here", "Remote と食い違いました"),
            })),
            Reply::NotFound(_) => Err(failed(Failure::Status(404), crate::tr!("The Remote does not have it", "Remote にありません"))),
        }
    }

    /// A text the Remote answers with (a board taken home as markdown).
    pub(crate) fn text(&self, path: &str) -> Result<String> {
        match self.to("GET", path, Body::None) {
            Got::Ok(mut r) => { let mut s = String::new(); r.read_to_string(&mut s).map_err(|e| e.to_string())?; Ok(s) }
            Got::Status(404, _) => Err(failed(Failure::Status(404), crate::tr!("The Remote does not have it", "Remote にありません"))),
            Got::Status(code, r) => Err(refused(code, r)),
            Got::Unreachable(e) => Err(e),
        }
    }

    pub(super) fn put_blob(&self, sha: &str, bytes: &[u8]) -> Result<()> {
        match self.to("PUT", &format!("/v1/blobs/{sha}"), Body::Bytes(bytes)) {
            Got::Ok(_) => Ok(()),
            Got::Status(code, r) => Err(refused(code, r)),
            Got::Unreachable(e) => Err(e),
        }
    }

    pub(crate) fn blob(&self, sha: &str) -> Result<Vec<u8>> {
        let r = match self.to("GET", &format!("/v1/blobs/{sha}"), Body::None) {
            Got::Ok(r) => r,
            Got::Status(code, r) => return Err(refused(code, r)),
            Got::Unreachable(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        r.take(BLOB_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
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
