//! What a file must not carry to the Remote: a secret. A Prompt started here has the Agent's key in its environment
//! (device/agent_key.rs), and whatever runs there can write it into a file of the repo; the Remote would then keep it, and
//! show it to everyone a repo is shared with. So a file about to be sent is read for one first, as GitHub's push
//! protection reads a push, and one that holds a secret stays on this device, named as what cannot be sent (as a file
//! over 16 MB is): a Commit then says which and why until it is taken out. Only forms nothing else has are looked
//! for, so nothing ordinary is held back: the models' makers' keys (as device/agent_key.rs knows them), Stripe's live keys,
//! GitHub's tokens, and this device's own sign-in, whole.

use crate::device::agent_key;

/// Whether `b` may be part of a key: the letters, digits, `-` and `_` every form here is made of.
fn key_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' || b == b'-' }

/// `run` as it may be shown (its start and its last four), when it is a key of a form known here.
fn known(run: &str) -> Option<String> {
    if agent_key::kind(run).is_some() { return Some(agent_key::shown(run)); }
    let tail = |start: &str| format!("{start}…{}", &run[run.len() - 4..]);
    let all = |r: &str, n: std::ops::RangeInclusive<usize>, ok: fn(u8) -> bool| n.contains(&r.len()) && r.bytes().all(ok);
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    // Stripe's: a live secret key or a restricted one (a test key opens no money).
    for start in ["sk_live_", "rk_live_"] {
        if run.strip_prefix(start).is_some_and(|r| all(r, 24..=247, alnum)) { return Some(tail(start)); }
    }
    // GitHub's: a classic token of each kind, or a fine-grained one.
    for start in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if run.strip_prefix(start).is_some_and(|r| all(r, 36..=36, alnum)) { return Some(tail(start)); }
    }
    if run.strip_prefix("github_pat_").is_some_and(|r| all(r, 82..=82, |b| b.is_ascii_alphanumeric() || b == b'_')) { return Some(tail("github_pat_")); }
    None
}

/// A secret found: a key, as it may be shown (its start and last four, never whole), or this device's own sign-in.
#[derive(Debug, PartialEq)]
pub enum Found { Key(String), Own }

impl Found {
    /// Why the file is not sent, as a person reads it beside the file's name.
    pub fn said(&self) -> String {
        match self {
            Found::Key(k) => crate::tr!("secret {}", "シークレット {}", k),
            Found::Own => crate::tr!("this device's sign-in", "このデバイスのサインイン情報"),
        }
    }
}

/// The first secret `bytes` holds; None when it holds none. `own` is this device's own secrets besides (its session on
/// the Remote), found anywhere in it, and said by what they are, not by any part of them.
pub fn found(bytes: &[u8], own: &[&str]) -> Option<Found> {
    if own.iter().filter(|s| s.len() >= 16).any(|s| bytes.windows(s.len()).any(|w| w == s.as_bytes())) {
        return Some(Found::Own);
    }
    let mut i = 0;
    while i < bytes.len() {
        // Each run of key bytes, read once from its start: a key begins where no key byte comes before it.
        if !key_byte(bytes[i]) { i += 1; continue; }
        let end = bytes[i..].iter().position(|b| !key_byte(*b)).map_or(bytes.len(), |n| i + n);
        if matches!(bytes[i], b's' | b'r' | b'x' | b'g' | b'A' | b'p' | b'f' | b'h') {
            if let Some(shown) = std::str::from_utf8(&bytes[i..end]).ok().and_then(known) { return Some(Found::Key(shown)); }
        }
        i = end;
    }
    None
}

#[cfg(test)]
#[path = "tests/secrets.rs"]
mod tests;
