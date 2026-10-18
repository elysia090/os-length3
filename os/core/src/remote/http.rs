//! Talking to the Remote over HTTP: one client carrying this device's
//! session, what kind of failure the last request was (l3 says each with
//! its own exit code), and answers taken only as a Remote gives them.

use super::*;

pub(super) fn agent(url: &str) -> ureq::Agent {
    crate::net::agent(url, Duration::from_secs(60))
}

pub(crate) struct Client {
    agent: ureq::Agent,
    pub(super) url: String,
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

pub(super) fn failures() -> &'static Mutex<Option<(Failure, String)>> {
    static F: OnceLock<Mutex<Option<(Failure, String)>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(None))
}

/// Keep `message` as the last failure of kind `f`, and give it back.
pub(super) fn failed(f: Failure, message: String) -> String {
    if let Ok(mut last) = failures().lock() { *last = Some((f, message.clone())); }
    message
}

/// The last failure talking to the Remote in this process, and what it said.
pub fn last_failure() -> Option<(Failure, String)> {
    failures().lock().ok().and_then(|f| f.clone())
}

pub(super) fn unknown() -> String {
    failed(Failure::Unknown, crate::tr!("The Remote no longer knows this device. Sign in again (l3 login)", "Remote がこの端末を覚えていません。もう一度サインインしてください（l3 login）"))
}

pub(super) fn unreachable(e: ureq::Error) -> String {
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
pub(super) fn refused(code: u16, r: ureq::Response) -> String {
    let v = refusal(r);
    let said = v["error"].as_str().or(v["message"].as_str()).unwrap_or_default().to_string();
    let message = match (code, said.as_str()) {
        (401, _) => return unknown(),
        // A Remote with no place for files (service/bucket.ts): nothing was agreed, so what is here stays and is sent later.
        (503, _) if v["files"] == serde_json::Value::Bool(false) => crate::tr!("The Remote cannot hold files just now; your work stays on this device",
            "Remote はいまファイルを置けません。作業はこの端末に残ります"),
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
    failed(Failure::Status(code), message)
}

/// The most of one answer read as JSON. The largest a Remote gives is a log: 50 commits with a tree each
/// (a tree is at most 8 MiB, service/app.ts LIMIT.tree); what goes past this is not an answer but a stream
/// that would be held in memory until there is none left (ureq's into_json reads without end).
pub(super) const ANSWER_LIMIT: u64 = 256 << 20;
/// The most of a refusal read: its words, a few fields.
pub(super) const REFUSAL_LIMIT: u64 = 64 << 10;

/// The JSON a Remote answered with; an empty answer (204) is null. One that is not JSON, or larger than
/// any answer is, is no answer to go by: what is in the way (a network's sign-in page, a proxy's) is not the Remote.
pub(super) fn answer(url: &str, r: ureq::Response) -> Result<serde_json::Value> {
    let text = body(r, ANSWER_LIMIT).map_err(|e| failed(Failure::Unreachable, crate::tr!("The Remote's answer broke off ({})", "Remote の答えが途中で切れました（{}）", e)))?;
    let Some(text) = text else { return Err(odd(url)) };
    if text.trim().is_empty() { return Ok(serde_json::Value::Null); }
    serde_json::from_str(&text).map_err(|_| odd(url))
}

/// A body read whole, as text, if it is at most `limit` bytes; None if it is larger (or not text).
pub(super) fn body(r: ureq::Response, limit: u64) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    r.into_reader().take(limit + 1).read_to_end(&mut bytes)?;
    Ok(if bytes.len() as u64 > limit { None } else { String::from_utf8(bytes).ok() })
}

/// What a refusal says, as JSON (null when it says nothing readable).
pub(super) fn refusal(r: ureq::Response) -> serde_json::Value {
    body(r, REFUSAL_LIMIT).ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// The Remote at `url` answered, but not as a Remote does: as if it were out of reach.
pub(super) fn odd(url: &str) -> String {
    failed(Failure::Unreachable, crate::tr!("{} did not answer as a Remote does (is a network's sign-in page in the way?)", "{} は Remote の答え方をしませんでした（ネットワークのサインイン画面が間に入っていませんか）", url))
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
            Ok(r) => Ok(Reply::Ok(answer(&self.url, r)?)),
            Err(ureq::Error::Status(409, r)) => Ok(Reply::Conflict(refusal(r))),
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

    pub(super) fn put_blob(&self, sha: &str, bytes: &[u8]) -> Result<()> {
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
