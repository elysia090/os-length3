//! The account on the Remote, as the Remote page's Sign-in and Devices show
//! it: passkeys, the code that turning a repo off asks for, the providers
//! linked, and each device's session. Adding a passkey, setting the code and
//! turning a repo off need a passkey, so they are the browser's; here they
//! are read, and another device can be removed.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

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

// ---- the plan (service/plan.ts): the Remote decides; this only reads it and asks ----

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
    let host = |u: &str| u.split_once("://").map(|(s, r)| (s.to_string(), r.split(['/', '?', '#']).next().unwrap_or_default().to_ascii_lowercase()));
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
    if let Some(t) = tier { if !TIERS.contains(&t) { return Err(crate::tr!("No such tier: go, pro or max", "そのプランはありません。go・pro・max のどれかです")); } }
    let c = Client::open()?;
    let v = c.json("POST", &format!("/v1/plan/{kind}"), Some(tier.map_or(serde_json::json!({}), |t| serde_json::json!({"tier": t}))))?;
    let url = v["url"].as_str().unwrap_or_default().to_string();
    let remote = crate::remote::connection().map(|c| c.url).unwrap_or_default();
    if !plan_page_ok(&remote, &url) { return Err(crate::tr!("The Remote named a page that is not Stripe's or its own", "Remote が Stripe のものでも自分のものでもないページを示しました")); }
    Ok(url)
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

#[cfg(test)]
mod tests {
    #[test]
    fn the_plan_is_bought_only_on_stripes_pages_or_the_remotes_own() {
        let r = "https://os.length3.com";
        for ok in ["https://checkout.stripe.com/c/pay/cs_1", "https://billing.stripe.com/p/session/x", "https://os.length3.com/dev-billing/checkout?x"] { assert!(super::plan_page_ok(r, ok), "{ok}"); }
        for no in ["http://checkout.stripe.com/c", "https://stripe.com.evil.example/", "https://evilstripe.com/", "https://os.length3.com.evil/", "javascript:alert(1)", ""] { assert!(!super::plan_page_ok(r, no), "{no}"); }
        assert!(super::plan_page_ok("http://127.0.0.1:8950", "http://127.0.0.1:8950/dev-billing/portal?c=1"));
        assert!(!super::plan_page_ok("http://127.0.0.1:8950", "http://127.0.0.1:8951/dev-billing/portal"));
    }

    #[test]
    fn a_plan_reads_as_the_remote_says_it() {
        let p: super::Plan = serde_json::from_str(r#"{"plan":"free","status":null,"usage":{"repos":2,"bytes":25000000,"names":1},"free":{"repos":3,"bytes":100000000,"names":1},"buy":true,"manage":false}"#).unwrap();
        assert_eq!((p.plan.as_str(), p.usage.unwrap().repos, p.free.unwrap().bytes, p.buy), ("free", 2, 100_000_000, true));
        let none: super::Plan = serde_json::from_str(r#"{"plan":"none"}"#).unwrap();
        assert!(none.usage.is_none() && !none.buy);
        // A tier: what it keeps (as many repos as fit: none said), and the tiers beside it with their prices.
        let pro: super::Plan = serde_json::from_str(r#"{"plan":"paid","tier":"pro","allowance":{"repos":null,"bytes":256000000000,"names":10},
            "tiers":[{"tier":"free","allowance":{"repos":3,"bytes":100000000,"names":1}},{"tier":"pro","allowance":{"repos":null,"bytes":256000000000,"names":10},"sold":true,
            "price":{"amount":1400,"currency":"usd","interval":"month","every":1}}],"buy":true,"manage":true}"#).unwrap();
        let a = pro.allowance.unwrap();
        assert_eq!((pro.tier.as_deref(), a.repos, a.bytes, a.names, pro.tiers.len(), pro.tiers[1].price.as_ref().map(|p| p.amount)),
            (Some("pro"), None, 256_000_000_000, Some(10), 2, Some(1400)));
        assert_eq!(super::tier_name("max"), "Max");
    }

    #[test]
    fn a_devices_token_is_never_written_out() {
        let d: super::Device = serde_json::from_str(r#"{"token":"secret","userAgent":"l3","updatedAt":"2026-10-17"}"#).unwrap();
        assert_eq!(d.token, "secret");
        let out = serde_json::to_string(&d).unwrap();
        assert!(!out.contains("secret") && !out.contains("token"), "{out}");
    }
}
