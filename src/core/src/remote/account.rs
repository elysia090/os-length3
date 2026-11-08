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
pub struct Device {
    /// The session's secret: kept to end it, never written out (it signs in as the person).
    #[serde(skip_serializing)]
    pub token: String,
    #[serde(rename = "userAgent", default)]
    pub user_agent: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    /// This device's own session.
    #[serde(default)]
    pub current: bool,
}

pub(super) fn get<T: for<'a> Deserialize<'a>>(path: &str) -> Result<T> {
    serde_json::from_value(Client::open()?.json("GET", path, None)?).map_err(|e| e.to_string())
}

pub fn passkeys() -> Result<Vec<Passkey>> { get("/api/auth/passkey/list-user-passkeys") }

/// The providers this account signs in with (a password is not one).
pub fn providers() -> Result<Vec<Provider>> {
    Ok(get::<Vec<Provider>>("/api/auth/list-accounts")?.into_iter().filter(|p| p.provider != "credential").collect())
}

/// Every session of the account, this device's first, then the most recently used.
pub fn devices() -> Result<Vec<Device>> {
    let mine = crate::remote::connection().map(|c| c.session).unwrap_or_default();
    let mut list: Vec<Device> = get("/api/auth/list-sessions")?;
    for d in &mut list { d.current = d.token == mine; }
    list.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| b.updated_at.cmp(&a.updated_at)));
    Ok(list)
}

/// End another device's session; it will have to be approved again.
pub fn end_device(token: &str) -> Result<()> {
    Client::open()?.json("POST", "/api/auth/revoke-session", Some(serde_json::json!({"token": token}))).map(|_| ())
}

// ---- the plan (src/remote/plan/plan.ts): the Remote decides; this only reads it and asks ----

/// What a free account may keep on the Remote, and what it keeps now.
#[derive(Serialize, Deserialize, Debug, Default, Clone, Copy)]
pub struct Allowance { pub repos: u64, pub bytes: u64, #[serde(default)] pub names: u64 }

/// What a tier keeps on the Remote: repos and names here (none: as many as fit), and bytes.
#[derive(Serialize, Deserialize, Debug, Default, Clone, Copy)]
pub struct Keeps { #[serde(default)] pub repos: Option<u64>, pub bytes: u64, #[serde(default)] pub names: Option<u64> }

/// A price as Stripe says it: so much in the currency's smallest unit, every so many intervals.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Price { pub amount: u64, pub currency: String, pub interval: String, #[serde(default = "one")] pub every: u64 }
fn one() -> u64 { 1 }

/// A tier as the Remote says it (free, go, pro, max): what it keeps, whether it is sold there, what it costs.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TierSaid { pub tier: String, pub allowance: Keeps, #[serde(default)] pub sold: bool, #[serde(default)] pub price: Option<Price> }

/// The tiers one pays for, the least first.
pub const TIERS: [&str; 3] = ["go", "pro", "max"];

/// A tier's name as every client says it: Go, Pro, Max (free in the language spoken).
pub fn tier_name(tier: &str) -> String {
    match tier { "go" => "Go".into(), "pro" => "Pro".into(), "max" => "Max".into(), _ => crate::tr!("free", "無料") }
}

/// The account's plan as the Remote says it; `plan` is "free", "paid", or "none" (this Remote has no plan).
#[derive(Serialize, Deserialize, Debug)]
pub struct Plan {
    pub plan: String,
    /// The tier the account is on: free, go, pro or max (a Remote from before there were tiers says none).
    #[serde(default)]
    pub tier: Option<String>,
    /// What that tier keeps.
    #[serde(default)]
    pub allowance: Option<Keeps>,
    /// Free and each tier sold there, the least first.
    #[serde(default)]
    pub tiers: Vec<TierSaid>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub renews: Option<u64>,
    #[serde(default)]
    pub ends: Option<u64>,
    #[serde(rename = "graceUntil", default)]
    pub grace_until: Option<u64>,
    #[serde(default)]
    pub usage: Option<Allowance>,
    #[serde(default)]
    pub free: Option<Allowance>,
    /// Paying is offered on this Remote (it has Stripe's keys).
    #[serde(default)]
    pub buy: bool,
    /// There is a subscription to manage.
    #[serde(default)]
    pub manage: bool,
}

pub fn plan() -> Result<Plan> { get("/v1/plan") }

/// Whether `page` is one the plan may be bought or managed on: Stripe's own (https, on stripe.com), or a
/// page of the Remote `remote` itself (a Remote of one's own may stand in for Stripe, as in development).
pub fn plan_page_ok(remote: &str, page: &str) -> bool {
    // The host as a browser reads it, or none: only letters, digits, dots and dashes (and a port), so nothing in it
    // is read otherwise there (a backslash is a slash to a browser, what is before an @ is no host, %2f is not a dot).
    let host = |u: &str| u.split_once("://").and_then(|(s, r)| {
        let h = r.split(['/', '?', '#']).next().unwrap_or_default().to_ascii_lowercase();
        let (name, port) = h.split_once(':').unwrap_or((&h, ""));
        let plain = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') && port.bytes().all(|b| b.is_ascii_digit());
        plain.then(|| (s.to_string(), h.clone()))
    });
    match (host(page), host(remote)) {
        (Some((s, h)), Some((rs, rh))) => (s == "https" && (h == "stripe.com" || h.ends_with(".stripe.com"))) || (s == rs && h == rh),
        _ => false,
    }
}

/// The page to subscribe to `tier` on (`checkout`; none, the least sold), or to manage the subscription on
/// (`portal`; with a tier, at the step that changes to it), as the Remote makes it for this account: Stripe's,
/// never one this device names.
pub fn plan_page(kind: &str, tier: Option<&str>) -> Result<String> {
    if kind != "checkout" && kind != "portal" { return Err(crate::tr!("No such page of the plan", "プランにそのページはありません")); }
    if let Some(t) = tier { if !TIERS.contains(&t) { return Err(crate::tr!("Invalid tier: choose go, pro, or max", "該当するプランはありません（go、pro、max のいずれかを指定してください）")); } }
    let c = Client::open()?;
    // In the language the OS speaks (Stripe's pages are asked in it, not in the browser's).
    let mut asked = serde_json::json!({"lang": if crate::text::i18n::ja() { "ja" } else { "en" }});
    if let Some(t) = tier { asked["tier"] = serde_json::json!(t); }
    let v = c.json("POST", &format!("/v1/plan/{kind}"), Some(asked))?;
    let url = v["url"].as_str().unwrap_or_default().to_string();
    let remote = crate::remote::connection().map(|c| c.url).unwrap_or_default();
    if !plan_page_ok(&remote, &url) { return Err(crate::tr!("The Remote named a page that is not Stripe's or its own", "Remote が Stripe のものでも自分のものでもないページを示しました")); }
    Ok(url)
}

/// What the app asks the browser to do, where the passkeys are: Remote's Sign-in (a passkey added, a provider
/// linked, the code set), or a repo turned off or discarded.
pub const ASKS: [&str; 3] = ["sign-in", "off", "discard"];

/// The page of the Remote's own app (on the origin it says it has, login.rs app_origin) where `ask` is done in the
/// browser: Remote's Sign-in part, or the card of `repo` asking to turn it off or discard it. Never a page the
/// window names: the ask is one of ASKS, the repo a plain name.
pub fn app_page(ask: &str, repo: Option<&str>) -> Result<String> {
    if !ASKS.contains(&ask) { return Err(crate::tr!("No such ask", "そのような依頼はありません")); }
    let url = crate::remote::connection().map(|c| c.url).unwrap_or_else(crate::remote::default_url);
    let app = crate::remote::app_origin(&url);
    let page = ask_page(app.as_deref().unwrap_or(&url), ask, repo)?;
    if !crate::remote::device_page_ok(&url, app.as_deref(), &page) {
        return Err(crate::tr!("The Remote named a page that is not its own", "Remote が自分のものでないページを示しました"));
    }
    Ok(page)
}

fn ask_page(base: &str, ask: &str, repo: Option<&str>) -> Result<String> {
    let base = base.trim_end_matches('/');
    if ask == "sign-in" { return Ok(format!("{base}/?account=sign-in")); }
    match repo {
        Some(r) if crate::text::names::valid_name(r) => Ok(format!("{base}/?account={ask}&repo={r}")),
        _ => Err(crate::tr!("No such repo", "そのリポジトリはありません")),
    }
}

/// What a session is, from its user agent, in the app's words.
pub fn device_word(ua: Option<&str>) -> String {
    let u = ua.unwrap_or_default();
    if u.starts_with("root3") || u.starts_with("l3") || u.to_ascii_lowercase().contains("ureq") { return crate::tr!("root3 / App", "root3 / アプリ"); }
    let has = |s: &str| u.contains(s);
    let os = if has("iPhone") || has("iPad") { "iOS" } else if has("Android") { "Android" } else if has("Mac OS X") { "macOS" } else if has("Windows") { "Windows" } else if has("Linux") { "Linux" } else { "" };
    let browser = if has("Edg/") { "Edge" } else if has("Chrome/") { "Chrome" } else if has("Firefox/") { "Firefox" } else if has("Safari/") { "Safari" } else { "" };
    let w = [browser, os].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" · ");
    if w.is_empty() { crate::tr!("Device", "デバイス") } else { w }
}

#[cfg(test)]
#[path = "account.test.rs"]
mod tests;
