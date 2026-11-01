//! What a file must not carry to the Remote: a secret. A Prompt started here has the Agent's key in its environment
//! (agent_key.rs), and whatever runs there can write it into a file of the repo; the Remote would then keep it, and
//! show it to everyone a repo is shared with. So a file about to be sent is read for one first, as GitHub's push
//! protection reads a push, and one that holds a secret stays on this device, named as what cannot be sent (as a file
//! over 16 MB is): a Commit then says which and why until it is taken out. Only forms nothing else has are looked
//! for, so nothing ordinary is held back: the models' makers' keys (as agent_key.rs knows them), Stripe's live keys,
//! GitHub's tokens, and this device's own sign-in, whole.

use crate::agent_key;

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
mod tests {
    use super::*;

    fn anthropic(tail: &str) -> String { format!("sk-ant-api03-{}{tail}AA", "x".repeat(93 - tail.len())) }

    #[test]
    fn a_key_in_a_file_is_found_wherever_it_stands_and_shown_by_its_start_and_last_four() {
        let key = anthropic("a9");
        for text in [format!("ANTHROPIC_API_KEY={key}\n"), format!("{{\"key\": \"{key}\"}}"), key.clone(), format!("export K='{key}'")] {
            assert_eq!(found(text.as_bytes(), &[]), Some(Found::Key("sk-ant-…a9AA".into())), "{text}");
        }
        let gh = format!("token = ghp_{}", "A1".repeat(18));
        assert_eq!(found(gh.as_bytes(), &[]), Some(Found::Key("ghp_…A1A1".into())));
        let stripe = format!("STRIPE={}", format_args!("sk_live_{}", "z9".repeat(14)));
        assert_eq!(found(stripe.as_bytes(), &[]), Some(Found::Key("sk_live_…z9z9".into())));
        // Bytes that are not text around it, too.
        let mut bin = vec![0u8, 159, 146, 150, b' '];
        bin.extend_from_slice(key.as_bytes());
        assert!(found(&bin, &[]).is_some());
    }

    #[test]
    fn nothing_ordinary_is_taken_for_one() {
        let key = anthropic("a9");
        for text in [
            "sk-ant-api03-xxxx (a placeholder in a README)".to_string(),
            "let sk_test = 1; // sk_test_ keys open no money".to_string(),
            format!("sk_test_{}", "z9".repeat(14)),
            "ghp_short".to_string(),
            "hf_ is how its tokens start; AIza is how Google's do".to_string(),
            // Part of a longer word: not a key that begins there.
            format!("prefix{key}"),
            "the session token is token.signature".to_string(),
        ] {
            assert_eq!(found(text.as_bytes(), &[]), None, "{text}");
        }
    }

    #[test]
    fn this_devices_own_sign_in_is_found_whole_and_never_shown() {
        let session = "Zq3sR8vN1kLm0pXy.abcDEF123ghiJKL456mno";
        let said = found(format!("leaked: {session}\n").as_bytes(), &[session]).unwrap();
        assert_eq!(said, Found::Own);
        assert!(!said.said().contains("Zq3s") && !said.said().contains("mno"));
        // Too short to be told from ordinary words: not looked for.
        assert_eq!(found(b"abc", &["abc"]), None);
    }
}
