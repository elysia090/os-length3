//! The Agent's key: the one API key a person gives this device for the box's Agent, whoever made the model it opens.
//! It is kept on this device alone, in its keyring (vault.rs), apart from the dotfiles: never sent to the Remote,
//! never written into a repo or a dotfile, and said whole only to the page that asks the model with it and to the
//! Prompts started here, in whose environment it is under the name its maker's own tools read it by
//! (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), so those tools work there too. What it is a key for is read from how it
//! starts; nobody is asked to say.

use crate::Result;
use serde::{Deserialize, Serialize};
use crate::device::vault::Secret;
use std::path::PathBuf;

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

/// The variables a key is read from (kind), by its maker's own tools.
const VARIABLES: [&str; 10] = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY",
    "GROQ_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "FIREWORKS_API_KEY", "HF_TOKEN"];

/// The key as a browser keeps it when a passkey sealed it (src/home/seal.ts): opened by the page alone, with the
/// passkey, once a session; beside it, what is known of it without opening it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sealed {
    /// The key sealed, as the page made it (the passkey's id, the salt it was asked with, the nonce, what was sealed).
    pub sealed: serde_json::Value,
    pub shown: String,
    pub variable: String,
    #[serde(default)]
    pub model: String,
}

/// What is kept: the key as given, or sealed by a passkey (a browser's).
#[derive(Clone, Debug, PartialEq)]
pub enum Held {
    Given(Kept),
    Sealed(Sealed),
}

/// What a Prompt started here is told besides: the key under its maker's variable; nothing without one.
pub fn env() -> Vec<(String, String)> {
    kept().and_then(|k| kind(&k.key).map(|(_, var)| vec![(var.to_string(), k.key)])).unwrap_or_default()
}

/// Where earlier releases kept it: a file of its own beside Home's state.
fn before() -> PathBuf { crate::paths::data_dir().join("agent-key") }

/// What is kept here, if anything (vault.rs: the OS's keyring, or a file only this account reads). One kept where
/// earlier releases kept it is moved there the first time it is read.
pub fn held() -> Option<Held> {
    let text = match crate::device::vault::get(Secret::AgentKey).ok().flatten() {
        Some(t) => t,
        None => {
            let t = std::fs::read_to_string(before()).ok()?;
            if crate::device::vault::set(Secret::AgentKey, &t).is_ok() { let _ = std::fs::remove_file(before()); }
            t
        }
    };
    read(&text)
}

/// The key as given, if one is kept here as it was given.
pub fn kept() -> Option<Kept> {
    match held()? { Held::Given(k) => Some(k), Held::Sealed(_) => None }
}

/// What is kept, read: a key of a form known here and its model, or one sealed as `seal` takes it.
fn read(text: &str) -> Option<Held> {
    if let Ok(k) = serde_json::from_str::<Kept>(text) { return kind(&k.key).map(|_| Held::Given(k)); }
    let s: Sealed = serde_json::from_str(text).ok()?;
    sealed_well(&s).then_some(Held::Sealed(s))
}

/// Whether `s` is a sealed key as a page makes one: its variable a maker's, how it is shown a key's start and last
/// four, and what is sealed its four fields of base64url, no larger than a key sealed is.
fn sealed_well(s: &Sealed) -> bool {
    let b64 = |v: &serde_json::Value| v.as_str().is_some_and(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    VARIABLES.contains(&s.variable.as_str()) && (5..=24).contains(&s.shown.chars().count()) && s.shown.contains('…')
        && s.sealed.as_object().is_some_and(|o| o.len() == 5 && o.get("v") == Some(&serde_json::json!(1))
            && ["credential", "salt", "iv", "data"].iter().all(|k| o.get(*k).is_some_and(b64)))
        && s.sealed.to_string().len() <= 4096
}

/// Keep the key sealed, in place of any kept before (a browser's, where a passkey sealed it: src/home/seal.ts).
pub fn seal(s: &Sealed) -> Result<()> {
    if !sealed_well(s) { return Err(crate::tr!("This is not a sealed key this OS knows", "この OS が知っている封をしたキーではありません")); }
    crate::device::vault::set(Secret::AgentKey, &serde_json::to_string(s).map_err(|e| e.to_string())?)
}

/// Keep `key` (and the model it opens) here from now on, in place of any kept before; None takes it away.
pub fn set(key: Option<(&str, &str)>) -> Result<()> {
    match key {
        Some((key, model)) => crate::device::vault::set(Secret::AgentKey, &written(key, model)?),
        None => {
            let _ = std::fs::remove_file(before());
            crate::device::vault::remove(Secret::AgentKey)
        }
    }
}

/// What is kept for `key` and `model`: refused when it is no key this OS knows.
fn written(key: &str, model: &str) -> Result<String> {
    let key = key.trim();
    if kind(key).is_none() {
        return Err(crate::tr!("This is not an API key this OS knows", "この OS が知っている API キーではありません"));
    }
    serde_json::to_string(&Kept { key: key.into(), model: model.trim().into() }).map_err(|e| e.to_string())
}

/// The key as it may be shown: its kind's start and its last four, never more of it (`sk-ant-…a9f2`).
pub fn shown(key: &str) -> String {
    let start = kind(key).map_or("", |(s, _)| s);
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{start}…{tail}")
}

#[cfg(test)]
#[path = "tests/agent_key.rs"]
mod tests;
