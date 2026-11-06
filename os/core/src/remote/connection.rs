//! This device's session on the Remote: which Remote it is (the default, or $LENGTH3_REMOTE), its bearer (kept in
//! the device's vault; a browser keeps none, its session being a cookie no script reads), and all of it let go on
//! signing out.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::fs;
use crate::Result;
use super::base::sync_dir;

/// The Remote to sign in to: $LENGTH3_REMOTE, else the one this OS ships with.
pub fn default_url() -> String {
    current_url(&std::env::var("LENGTH3_REMOTE").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| DEFAULT_URL.into()))
}

/// A removal whose target is already gone has done its work.
pub(super) fn gone(r: std::io::Result<()>) -> Result<()> {
    match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Forget the Remote here: its session and every base (the repos stay).
pub fn forget_connection() -> Result<()> {
    crate::home::set("remote", "null")?;
    crate::device::vault::remove(crate::device::vault::Secret::Session)?;
    // A base left behind would be taken for what the next Remote agreed (another account's, perhaps),
    // and a file it does not hold would be removed here as if removed there: it must go.
    gone(fs::remove_dir_all(sync_dir()))
}

/// This device's own secrets a file must not carry (secrets.rs): its session's bearer, whole and without its signature.
pub(super) fn own_secrets() -> Vec<String> {
    bearer().ok().flatten().map(|b| vec![b.split('.').next().unwrap_or_default().to_string(), b]).unwrap_or_default()
}

/// What proves this device is its session to the Remote: the bearer kept apart (vault.rs), the session's token
/// signed; why not, when the keyring keeping it did not give it. A browser holds none: its session is the cookie the
/// Remote set, which it sends itself and no script reads (core/worker.ts sends it with the core's requests).
pub(crate) fn bearer() -> Result<Option<String>> {
    #[cfg(not(target_os = "wasi"))]
    { crate::device::vault::get(crate::device::vault::Secret::Session) }
    #[cfg(target_os = "wasi")]
    { Ok(None) }
}

pub fn save_connection(c: &Connection) -> Result<()> {
    crate::home::set("remote", &serde_json::to_string(c).map_err(|e| e.to_string())?)
}

/// The Remote this device is connected to, if it is (Home's `remote` setting). One kept as earlier releases kept it,
/// its bearer beside the rest, is kept as now the first time it is read: the bearer apart (vault.rs), or, in a
/// browser, not at all (its cookie is the session there).
pub fn connection() -> Option<Connection> {
    let text = crate::home::get("remote").ok()??;
    let k: KeptBefore = serde_json::from_str(&text).ok()?;
    let mut c = Connection { url: current_url(&k.url), session: k.session, user: k.user };
    if let Some(token) = k.token.filter(|t| !t.is_empty()) {
        c.session = token.split('.').next().unwrap_or_default().to_string();
        #[cfg(not(target_os = "wasi"))]
        crate::device::vault::set(crate::device::vault::Secret::Session, &token).ok()?;
        save_connection(&c).ok()?;
    }
    (!c.session.is_empty()).then_some(c)
}

/// A Remote's URL as it is used now: the former name of the one this OS ships with is its name today.
pub fn current_url(url: &str) -> String {
    let url = url.trim_end_matches('/');
    if url.eq_ignore_ascii_case(FORMER_URL) { DEFAULT_URL.into() } else { url.into() }
}

/// A connection as earlier releases kept it: the bearer itself in Home's state, beside the rest.
#[derive(Deserialize)]
pub(super) struct KeptBefore {
    pub(super) url: String,
    #[serde(default)]
    pub(super) session: String,
    #[serde(default)]
    pub(super) token: Option<String>,
    #[serde(default)]
    pub(super) user: Option<String>,
}

/// Which session this device is on which Remote. Nothing in it is a secret: what proves the session is kept apart
/// from it (`bearer`), so Home's state, which a page reads, carries none.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Connection {
    pub url: String,
    /// The session's token as the Remote keeps it, unsigned: how this device knows itself among the account's
    /// sessions (account.rs devices). By itself it opens nothing: the Remote takes a token only signed with its
    /// secret, as a bearer and as its cookie alike (service/auth.ts signedToken).
    #[serde(default)]
    pub session: String,
    /// The account the session is (its id on the Remote), when it was told at sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

/// The name the Remote had before (0.4.x signed in by it). The same Worker still answers it, so
/// those releases keep working; a device that kept it is taken to DEFAULT_URL, its session and all.
pub const FORMER_URL: &str = "https://remote.length3.com";

/// The Remote this OS ships with: one name for the app, the Remote, the DNS records people
/// publish (`remote=os.length3.com`) and passkeys.
pub const DEFAULT_URL: &str = "https://os.length3.com";

