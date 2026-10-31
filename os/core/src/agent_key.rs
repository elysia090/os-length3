//! The Agent's key: the one API key a person gives this device for the box's Agent, whoever made the model it opens.
//! It is kept on this device alone and private to the person (0600), apart from the dotfiles: never sent to the Remote,
//! never written into a repo or a dotfile, and said whole only to the page that asks the model with it and to the
//! Prompts started here, in whose environment it is under the name its maker's own tools read it by
//! (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), so those tools work there too. What it is a key for is read from how it
//! starts; nobody is asked to say.

use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Whether every byte of `s` is one `ok` takes, and there are `n` of them (`lo..=hi`).
fn made_of(s: &str, lo: usize, hi: usize, ok: impl Fn(u8) -> bool) -> bool { (lo..=hi).contains(&s.len()) && s.bytes().all(ok) }
fn alnum(b: u8) -> bool { b.is_ascii_alphanumeric() }
fn word(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' || b == b'-' }

/// What a key is for, read from its form alone: the start it is shown by, and the variable its maker's own tools read it
/// from. The forms are those the secret scanners go by (gitleaks' and TruffleHog's rules, 2026): a model's maker's
/// keys only, never an admin key (Anthropic's `sk-ant-admin01-`, OpenAI's `sk-admin-`), which opens no model. Keys of
/// no form of their own (Mistral's, Cohere's: letters and digits, nothing more) cannot be told apart, so are not taken.
pub fn kind(key: &str) -> Option<(&'static str, &'static str)> {
    let after = |start: &str| key.strip_prefix(start);
    if let Some(r) = after("sk-ant-api03-") {
        return (r.len() == 95 && r.ends_with("AA") && r.bytes().all(word)).then_some(("sk-ant-", "ANTHROPIC_API_KEY"));
    }
    if let Some(r) = after("sk-or-v1-") { return made_of(r, 64, 64, |b| b.is_ascii_hexdigit()).then_some(("sk-or-", "OPENROUTER_API_KEY")); }
    // OpenAI's: a project's or a service account's, or the older kind; each has `T3BlbkFJ` ("OpenAI") inside it.
    for start in ["sk-proj-", "sk-svcacct-"] {
        if let Some(r) = after(start) { return (r.contains("T3BlbkFJ") && r.bytes().all(word)).then_some((start, "OPENAI_API_KEY")); }
    }
    if key.starts_with("sk-admin-") || key.starts_with("sk-ant-") { return None; }
    if let Some(r) = after("sk-") {
        if made_of(r, 32, 32, |b| b.is_ascii_lowercase() || b.is_ascii_digit()) { return Some(("sk-", "DEEPSEEK_API_KEY")); }
        return (r.len() == 48 && r.bytes().all(alnum) && &r[20..28] == "T3BlbkFJ").then_some(("sk-", "OPENAI_API_KEY"));
    }
    if let Some(r) = after("xai-") { return made_of(r, 80, 80, |b| alnum(b) || b == b'_').then_some(("xai-", "XAI_API_KEY")); }
    if let Some(r) = after("gsk_") { return made_of(r, 52, 52, alnum).then_some(("gsk_", "GROQ_API_KEY")); }
    if let Some(r) = after("AIza") { return made_of(r, 35, 35, word).then_some(("AIza", "GEMINI_API_KEY")); }
    if let Some(r) = after("pplx-") { return made_of(r, 48, 48, alnum).then_some(("pplx-", "PERPLEXITY_API_KEY")); }
    if let Some(r) = after("fw_") { return made_of(r, 20, 40, alnum).then_some(("fw_", "FIREWORKS_API_KEY")); }
    if let Some(r) = after("hf_") { return made_of(r, 34, 34, |b| b.is_ascii_alphabetic()).then_some(("hf_", "HF_TOKEN")); }
    None
}

/// What is kept: the key, and the model it was found to open (the newest that answers, chosen when it was given).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Kept {
    pub key: String,
    #[serde(default)]
    pub model: String,
}

/// What a Prompt started here is told besides: the key under its maker's variable; nothing without one.
pub fn env() -> Vec<(String, String)> {
    kept().and_then(|k| kind(&k.key).map(|(_, var)| vec![(var.to_string(), k.key)])).unwrap_or_default()
}

fn file() -> PathBuf { crate::paths::data_dir().join("agent-key") }

/// The key as given, if one is kept here.
pub fn kept() -> Option<Kept> { kept_in(&file()) }

fn kept_in(path: &Path) -> Option<Kept> {
    let k: Kept = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    kind(&k.key).map(|_| k)
}

/// Keep `key` (and the model it opens) here from now on, in place of any kept before; None takes it away.
pub fn set(key: Option<(&str, &str)>) -> Result<()> { set_in(&file(), key) }

fn set_in(path: &Path, key: Option<(&str, &str)>) -> Result<()> {
    let Some((key, model)) = key else {
        return match std::fs::remove_file(path) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) };
    };
    let key = key.trim();
    if kind(key).is_none() {
        return Err(crate::tr!("This is not an API key this OS knows", "この OS が知っている API キーではありません"));
    }
    if let Some(dir) = path.parent() { crate::boundary::private_dir(dir).map_err(|e| e.to_string())?; }
    let bytes = serde_json::to_vec(&Kept { key: key.into(), model: model.trim().into() }).map_err(|e| e.to_string())?;
    crate::atomic::replace(path, &bytes, crate::atomic::How::PRIVATE).map_err(|e| e.to_string())
}

/// The key as it may be shown: its kind's start and its last four, never more of it (`sk-ant-…a9f2`).
pub fn shown(key: &str) -> String {
    let start = kind(key).map_or("", |(s, _)| s);
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{start}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn place(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("l3-agent-key-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d.join("agent-key")
    }

    /// A key of the form `start` + `body`, its body `n` of `c` (with `mid` at `at`, when given).
    fn key(start: &str, n: usize, c: char, mid: Option<(usize, &str)>) -> String {
        let mut b: String = std::iter::repeat_n(c, n).collect();
        if let Some((at, m)) = mid { b.replace_range(at..at + m.len(), m); }
        format!("{start}{b}")
    }

    #[test]
    fn a_key_is_known_by_its_whole_form_and_an_admin_key_or_one_of_no_form_is_not() {
        let var = |k: &str| kind(k).map(|k| k.1);
        assert_eq!(var(&format!("{}AA", key("sk-ant-api03-", 93, 'x', None))), Some("ANTHROPIC_API_KEY"));
        assert_eq!(var(&key("sk-ant-api03-", 95, 'x', None)), None, "no AA at its end");
        assert_eq!(var(&format!("{}AA", key("sk-ant-admin01-", 93, 'x', None))), None, "an admin key opens no model");
        assert_eq!(var(&key("sk-proj-", 140, 'a', Some((74, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
        assert_eq!(var(&key("sk-svcacct-", 124, 'a', Some((58, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
        assert_eq!(var(&key("sk-", 48, 'a', Some((20, "T3BlbkFJ")))), Some("OPENAI_API_KEY"));
        assert_eq!(var(&key("sk-admin-", 140, 'a', Some((74, "T3BlbkFJ")))), None);
        assert_eq!(var(&key("sk-", 32, '7', None)), Some("DEEPSEEK_API_KEY"));
        assert_eq!(var(&key("sk-or-v1-", 64, 'f', None)), Some("OPENROUTER_API_KEY"));
        assert_eq!(var(&key("xai-", 80, 'Q', None)), Some("XAI_API_KEY"));
        assert_eq!(var(&key("gsk_", 52, 'Q', None)), Some("GROQ_API_KEY"));
        assert_eq!(var(&key("AIzaSy", 33, 'Q', None)), Some("GEMINI_API_KEY"));
        assert_eq!(var(&key("pplx-", 48, 'Q', None)), Some("PERPLEXITY_API_KEY"));
        assert_eq!(var(&key("fw_", 24, 'Q', None)), Some("FIREWORKS_API_KEY"));
        assert_eq!(var(&key("hf_", 34, 'Q', None)), Some("HF_TOKEN"));
        // Mistral's and Cohere's: letters and digits alone, nothing to tell them by.
        assert_eq!(var(&"a".repeat(32)), None);
        assert_eq!(var(&"a".repeat(40)), None);
        assert_eq!(var(&key("gsk_", 51, 'Q', None)), None, "one short");
    }

    #[test]
    fn kept_private_shown_by_its_start_and_last_four_and_taken_away() {
        let f = place("keep");
        let given = format!("{}a9AA", key("sk-ant-api03-", 91, 'x', None));
        set_in(&f, Some((&format!(" {given} "), "m"))).unwrap();
        let k = kept_in(&f).unwrap();
        assert_eq!(k, Kept { key: given.clone(), model: "m".into() });
        assert_eq!(shown(&k.key), "sk-ant-…a9AA");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        set_in(&f, None).unwrap();
        assert_eq!(kept_in(&f), None);
        set_in(&f, None).unwrap();
    }

    #[test]
    fn what_is_no_known_key_is_refused_and_nothing_is_kept() {
        let f = place("refuse");
        for bad in ["", "sk-ant", "password1234567890", "sk-ant-api03- with spaces in it", &format!("sk-ant-api03-{}", "x".repeat(600))] {
            assert!(set_in(&f, Some((bad, ""))).is_err(), "{bad:?}");
        }
        assert_eq!(kept_in(&f), None);
    }
}
