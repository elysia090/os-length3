//! Signing a device in (the device code a person approves in a browser),
//! who it is signed in as, and signing it out.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use super::*;

/// Keep a session just approved. What was agreed with another Remote, or
/// with another account as far as can be told, goes first: kept, it would be
/// taken for what this one agreed, and every file it holds that this one
/// does not (all of them, for an account that has never seen the repo) would
/// be removed here as if removed there (bug: signing in elsewhere without
/// signing out emptied each repo of what was unchanged).
pub(super) fn connect(url: &str, token: String) -> Result<()> {
    let url = current_url(url);
    let user = whose(&url, &token);
    if let Some(was) = connection().filter(|was| another(was, &url, user.as_deref())) {
        if was.url != url {
            gone(fs::remove_dir_all(sync_dir()))?;
        } else {
            // Another account on the same Remote: each copy stays the account's it was agreed with, and is not
            // sent to this one (sync refuses it), rather than joined into this account's repo of the same name.
            stamp(was.user.as_deref())?;
        }
    }
    save_connection(&Connection { url, token, user })
}

/// Note `who` on every agreement that does not say whose it is yet.
fn stamp(who: Option<&str>) -> Result<()> {
    let Some(who) = who else { return gone(fs::remove_dir_all(sync_dir())) };
    let Ok(dir) = fs::read_dir(sync_dir()) else { return Ok(()) };
    for e in dir.flatten() {
        let Some(key) = e.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(String::from) else { continue };
        if let Some(b) = base(&key).filter(|b| b.who.is_none()) {
            set_base(&key, &Base { who: Some(who.into()), ..b })?;
        }
    }
    Ok(())
}

/// Whether a session at `url` for `user` is another than `was`: another Remote, or another account on it.
/// Whose `was` is cannot always be told (a session kept before accounts were noted): the same, then.
pub(super) fn another(was: &Connection, url: &str, user: Option<&str>) -> bool {
    was.url != url || matches!((was.user.as_deref(), user), (Some(a), Some(b)) if a != b)
}

/// The account a session is, as the Remote at `url` says; None when it does not say.
pub(super) fn whose(url: &str, token: &str) -> Option<String> {
    let Got::Ok(r) = request("GET", &format!("{url}/api/auth/get-session"), Some(token), Body::None) else { return None };
    let v = answer(url, r).ok()?;
    v["user"]["id"].as_str().filter(|id| !id.is_empty()).map(String::from)
}



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
    match request("POST", &format!("{url}/api/auth/device/code"), None, Body::Json(serde_json::json!({"client_id": client}))) {
        Got::Ok(r) => serde_json::from_value(answer(url, r)?).map_err(|_| odd(url)),
        Got::Status(code, r) => Err(refused(code, r)),
        Got::Unreachable(e) => Err(e),
    }
}

/// The origin of the web app the Remote `url` says it approves devices on (GET /v1/about, `app`), if it says one.
pub fn app_origin(url: &str) -> Option<String> {
    let Got::Ok(r) = request("GET", &format!("{url}/v1/about"), None, Body::None) else { return None };
    let v = answer(url, r).ok()?;
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

/// What one poll for a device's code heard.
#[derive(Debug, PartialEq)]
pub(super) enum Polled {
    Approved(String),
    Waiting,
    /// Asked too often: wait longer between asks from now on (RFC 8628 §3.5).
    SlowDown,
}

/// Poll once.
pub(super) fn device_poll(url: &str, client: &str, code: &DeviceCode) -> Result<Polled> {
    let r = request("POST", &format!("{url}/api/auth/device/token"), None, Body::Json(serde_json::json!({
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": code.device_code, "client_id": client,
    })));
    match r {
        Got::Ok(r) => {
            let v = answer(url, r)?;
            Ok(v["access_token"].as_str().filter(|t| !t.is_empty()).map_or(Polled::Waiting, |t| Polled::Approved(t.into())))
        }
        Got::Status(429, _) => Ok(Polled::SlowDown),
        Got::Status(code, r) => {
            let v = refusal(r);
            match v.get("error").and_then(|e| e.as_str()) {
                Some("authorization_pending") => Ok(Polled::Waiting),
                Some("slow_down") => Ok(Polled::SlowDown),
                Some("access_denied") => Err(crate::tr!("It was declined in the browser", "ブラウザで断られました")),
                Some("expired_token") => Err(expired()),
                other => {
                    let said = other.or(v["error_description"].as_str()).or(v["message"].as_str()).map_or_else(|| code.to_string(), String::from);
                    Err(failed(Failure::Status(code), crate::tr!("Could not sign in ({})", "サインインできませんでした（{}）", said)))
                }
            }
        }
        Got::Unreachable(e) => Err(e),
    }
}

pub(super) fn expired() -> String {
    crate::tr!("The code expired before it was approved", "承認される前にコードの期限が切れました")
}

/// How long to wait for approval, and between asks, from what the Remote said: held to a minute to half
/// an hour, and to 1 to 60 seconds (bug: an expires_in near u64::MAX, from a Remote or from the page that
/// hands the code back to the app, overflowed the deadline and l3 panicked; an interval as large waited
/// for ever).
pub(super) fn polling(code: &DeviceCode) -> (Duration, Duration) {
    (Duration::from_secs(code.expires_in.clamp(60, 1800)), Duration::from_secs(code.interval.clamp(1, 60)))
}

/// Wait for a code to be approved, then keep the session here.
pub fn device_finish(url: &str, client: &str, code: &DeviceCode) -> Result<()> {
    let (wait, mut step) = polling(code);
    let deadline = std::time::Instant::now() + wait;
    loop {
        std::thread::sleep(step);
        match device_poll(url, client, code)? {
            Polled::Approved(token) => return connect(url, token),
            Polled::SlowDown => step = (step + Duration::from_secs(5)).min(Duration::from_secs(60)),
            Polled::Waiting => {}
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
    for name in repos.names()? {
        // Main's copy and each issue's, each in step before any record of them goes.
        let shown = repos.line(&name);
        let mut lines: Vec<String> = crate::work::worktrees(&name).into_iter().map(|(l, _)| l).collect();
        lines.push(crate::work::MAIN.into());
        for line in lines {
            let r = lock(&key_of(&name, &line)).and_then(|_held| {
                // Not shown, it would not be the copy sent; and the repo is shown again as it was, whatever sending did.
                crate::work::show_for_free(&name, &line)?;
                let r = sync_with(&c, repos, &name);
                crate::work::show_for_free(&name, &shown).and(r)
            });
            if let Err(e) = r {
                let what = if line == crate::work::MAIN { name.clone() } else { format!("{name}@{line}") };
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
