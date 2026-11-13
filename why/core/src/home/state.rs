//! Home's settings as files the person owns (`<data>/home/<key>.json`), each replaced whole; the language among them.

use crate::fs::paths::home_dir;
use crate::Result;
use std::fs;
use std::path::PathBuf;

/// Choose the language Home keeps, for the app and why alike.
pub fn set_lang(lang: &str) -> crate::Result<()> {
    if !LANGS.contains(&lang) { return Err(crate::tr!("The OS speaks en or ja", "OS が話すのは en か ja です")); }
    set("lang", &serde_json::to_string(lang).map_err(|e| e.to_string())?)
}

/// The language Home keeps (what the app and why speak unless $WHY_LANG says otherwise).
pub fn lang() -> String {
    get("lang").ok().flatten().and_then(|t| serde_json::from_str::<String>(&t).ok())
        .filter(|l| LANGS.contains(&l.as_str())).unwrap_or_else(|| "en".into())
}

/// The languages the OS speaks.
pub const LANGS: [&str; 2] = ["en", "ja"];

/// Store `json` for `key`: it must parse, and it is replaced whole (written
/// beside and renamed), so a reader never sees half of it.
pub fn set(key: &str, json: &str) -> Result<()> {
    let path = file(key)?;
    if json.len() > 1 << 20 {
        // Kept as one value (every dotfile together, every TODO), so what was being added is what makes it too large.
        return Err(crate::tr!("Home's {} would be larger than 1 MiB in all, so nothing was saved; make room in it first", "Home の {} が合わせて 1 MiB を超えるので、保存していません。先に空きを作ってください", key));
    }
    serde_json::from_str::<serde::de::IgnoredAny>(json).map_err(|e| format!("{key}: {e}"))?;
    // Home's state (profile, TODO, the Remote's session) is the person's alone: the directory is private and
    // the file owner-only.
    crate::fs::write::private_dir(home_dir()).map_err(|e| e.to_string())?;
    crate::fs::write::replace(&path, json.as_bytes(), crate::fs::write::How::PRIVATE).map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))?;
    if key == "lang" { crate::text::i18n::changed(); }
    Ok(())
}

/// Let `key` go: there is none of it here.
pub fn remove(key: &str) -> Result<()> {
    match fs::remove_file(file(key)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The stored JSON text for `key`, if any.
pub fn get(key: &str) -> Result<Option<String>> {
    match fs::read_to_string(file(key)?) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn file(key: &str) -> Result<PathBuf> {
    if !KEYS.contains(&key) {
        return Err(crate::tr!("Home keeps no {:?}", "Home は {:?} を持ちません", key));
    }
    Ok(home_dir().join(format!("{key}.json")))
}

/// The state the OS keeps for Home. Anything else is refused.
/// `network`: the repos whose Prompts may reach the network, on this device only (it is never sent).
/// `trusted`: the dotfiles this device runs, as they were taken here (never sent; see dotfiles_in_effect).
pub const KEYS: [&str; 9] = ["profile", "todo", "band", "remote", "sync", "lang", "dotfiles", "network", "trusted"];

