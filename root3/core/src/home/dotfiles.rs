//! The dotfiles every Prompt starts with, kept on the Remote, and of them what this device runs: only what it took
//! here, so a dotfile written elsewhere runs once taken.

use crate::Result;
use super::state::{get, set};

/// Replace (or make) a dotfile, or remove it (`None`): written here, it runs here at once. Whether it was there before.
pub fn set_dotfile(name: &str, text: Option<&str>) -> Result<bool> {
    if !dotfile_name(name) {
        return Err(crate::tr!("Dotfiles must begin with a dot (e.g. .profile)", "dotfile の名前は「.」から始めてください（例：.profile）"));
    }
    keep_trust()?;
    let mut all: Dotfiles = get("dotfiles")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let was = match text {
        Some(t) => all.insert(name.to_string(), t.to_string()).is_some(),
        None => all.remove(name).is_some(),
    };
    if text.is_none() && !was {
        return Err(crate::tr!("There is no dotfile {}", "dotfile {} はありません", name));
    }
    set("dotfiles", &serde_json::to_string(&all).map_err(|e| e.to_string())?)?;
    let mut trusted = dotfile_map("trusted")?.unwrap_or_default();
    match text {
        Some(t) => { trusted.insert(name.to_string(), t.to_string()); }
        None => { trusted.remove(name); }
    }
    set("trusted", &serde_json::to_string(&trusted).map_err(|e| e.to_string())?)?;
    Ok(was)
}

/// Take `names` (every one waiting, when none is named) as they are kept now: from here on they run on this
/// device. The names taken.
pub fn take_dotfiles(names: &[String]) -> Result<Vec<String>> {
    keep_trust()?;
    let kept = dotfile_map("dotfiles")?.unwrap_or_default();
    let mut trusted = dotfile_map("trusted")?.unwrap_or_default();
    let waiting: Vec<String> = kept.iter().filter(|(n, t)| trusted.get(*n) != Some(*t)).map(|(n, _)| n.clone()).collect();
    if let Some(n) = names.iter().find(|n| !kept.contains_key(*n)) {
        return Err(crate::tr!("There is no dotfile {}", "dotfile {} はありません", n));
    }
    let taking: Vec<String> = if names.is_empty() { waiting } else { names.iter().filter(|n| waiting.contains(n)).cloned().collect() };
    for n in &taking { trusted.insert(n.clone(), kept[n].clone()); }
    trusted.retain(|n, _| kept.contains_key(n));
    set("trusted", &serde_json::to_string(&trusted).map_err(|e| e.to_string())?)?;
    Ok(taking)
}

/// The dotfiles changed or added elsewhere and not taken here: kept, and nothing of them runs here yet.
pub fn dotfiles_waiting() -> Vec<String> {
    let read = || -> Result<Vec<String>> {
        keep_trust()?;
        let trusted = dotfile_map("trusted")?.unwrap_or_default();
        Ok(dotfile_map("dotfiles")?.unwrap_or_default().into_iter().filter(|(n, t)| trusted.get(n) != Some(t)).map(|(n, _)| n).collect())
    };
    read().unwrap_or_default()
}

/// The dotfiles this device runs: each as it was taken here, of those still kept. Nothing, when they cannot be read.
pub fn dotfiles_in_effect() -> Vec<(String, String)> {
    let read = || -> Result<Vec<(String, String)>> {
        keep_trust()?;
        let kept = dotfile_map("dotfiles")?.unwrap_or_default();
        Ok(dotfile_map("trusted")?.unwrap_or_default().into_iter().filter(|(n, _)| kept.contains_key(n)).collect())
    };
    read().unwrap_or_default()
}

/// Before anything of the dotfiles is read for running or the Remote's are taken in: what this device ran until
/// now (from a version with no `trusted`) is what it trusts; a device new to them trusts none.
pub fn keep_trust() -> Result<()> {
    if get("trusted")?.is_none() {
        let ran = dotfile_map("dotfiles")?.unwrap_or_default();
        set("trusted", &serde_json::to_string(&ran).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

/// The dotfiles Home keeps (`dotfiles`: a JSON object of name → text), as the Remote has them: what is listed and
/// edited. What runs on this device is dotfiles_in_effect.
pub fn dotfiles() -> Vec<(String, String)> {
    dotfile_map("dotfiles").ok().flatten().unwrap_or_default().into_iter().collect()
}

/// A map of dotfiles kept under `key`, those with a name that may be written; None when there is none.
fn dotfile_map(key: &str) -> Result<Option<Dotfiles>> {
    let Some(text) = get(key)? else { return Ok(None) };
    let map: Dotfiles = serde_json::from_str(&text).unwrap_or_default();
    Ok(Some(map.into_iter().filter(|(n, _)| dotfile_name(n)).collect()))
}

type Dotfiles = std::collections::BTreeMap<String, String>;

/// The names the app offers for a new dotfile.
pub const COMMON_DOTFILES: [&str; 8] = [".profile", ".shrc", ".gitconfig", ".nanorc", ".inputrc", ".editorconfig", ".packages", ".setup"];

/// A dotfile's name as it may be written into /root: a dot, then letters, digits and . _ - (root3/app/home/dotfiles.ts).
pub fn dotfile_name(name: &str) -> bool {
    name.len() > 1 && name.len() <= 64 && name.starts_with('.') && name != ".." && !name.contains("..")
        && name.bytes().skip(1).all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

