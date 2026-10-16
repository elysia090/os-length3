//! The account on the Remote, as the Remote page's Sign-in and Devices show
//! it: passkeys, the code that turning a repo off asks for, the providers
//! linked, and each device's session. Adding a passkey, setting the code and
//! turning a repo off need a passkey, so they are the browser's; here they
//! are read, and another device can be removed.

use crate::remote::Client;
use crate::Result;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct Passkey {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Provider {
    #[serde(rename = "providerId")]
    pub provider: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct OffCode {
    pub set: bool,
    #[serde(rename = "setAt", default)]
    pub set_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Device {
    pub token: String,
    #[serde(rename = "userAgent", default)]
    pub user_agent: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    /// This device's own session.
    #[serde(default)]
    pub current: bool,
}

fn get<T: for<'a> Deserialize<'a>>(path: &str) -> Result<T> {
    serde_json::from_value(Client::open()?.json("GET", path, None)?).map_err(|e| e.to_string())
}

pub fn passkeys() -> Result<Vec<Passkey>> { get("/api/auth/passkey/list-user-passkeys") }
pub fn off_code() -> Result<OffCode> { get("/v1/off-code") }

/// The providers this account signs in with (a password is not one).
pub fn providers() -> Result<Vec<Provider>> {
    Ok(get::<Vec<Provider>>("/api/auth/list-accounts")?.into_iter().filter(|p| p.provider != "credential").collect())
}

/// Every session of the account, this device's first, then the most recently used.
pub fn devices() -> Result<Vec<Device>> {
    // The bearer token is the session's token and its signature.
    let mine = crate::remote::connection().map(|c| c.token.split('.').next().unwrap_or_default().to_string()).unwrap_or_default();
    let mut list: Vec<Device> = get("/api/auth/list-sessions")?;
    for d in &mut list { d.current = d.token == mine; }
    list.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| b.updated_at.cmp(&a.updated_at)));
    Ok(list)
}

/// End another device's session; it will have to be approved again.
pub fn end_device(token: &str) -> Result<()> {
    Client::open()?.json("POST", "/api/auth/revoke-session", Some(serde_json::json!({"token": token}))).map(|_| ())
}

/// What a session is, from its user agent, in the app's words.
pub fn device_word(ua: Option<&str>) -> String {
    let u = ua.unwrap_or_default();
    if u.starts_with("l3") || u.to_ascii_lowercase().contains("ureq") { return crate::tr!("l3 / the app", "l3 / アプリ"); }
    let has = |s: &str| u.contains(s);
    let os = if has("iPhone") || has("iPad") { "iOS" } else if has("Android") { "Android" } else if has("Mac OS X") { "macOS" } else if has("Windows") { "Windows" } else if has("Linux") { "Linux" } else { "" };
    let browser = if has("Edg/") { "Edge" } else if has("Chrome/") { "Chrome" } else if has("Firefox/") { "Firefox" } else if has("Safari/") { "Safari" } else { "" };
    let w = [browser, os].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" · ");
    if w.is_empty() { crate::tr!("A device", "端末") } else { w }
}
