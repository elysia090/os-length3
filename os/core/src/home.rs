//! Home's state as files the person owns: `<data>/home/<key>.json`. The app
//! keeps its profile, TODO and band here (in a browser, in its storage), and
//! l3 reads and writes the same TODO.

use crate::paths::home_dir;
use crate::text::kind_of;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// The state the OS keeps for Home. Anything else is refused.
/// `network`: the repos whose Prompts may reach the network, on this device only (it is never sent).
pub const KEYS: [&str; 8] = ["profile", "todo", "band", "remote", "sync", "lang", "dotfiles", "network"];

fn file(key: &str) -> Result<PathBuf> {
    if !KEYS.contains(&key) {
        return Err(format!("unknown state {key:?}"));
    }
    Ok(home_dir().join(format!("{key}.json")))
}

/// The stored JSON text for `key`, if any.
pub fn get(key: &str) -> Result<Option<String>> {
    match fs::read_to_string(file(key)?) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Store `json` for `key`: it must parse, and it is replaced whole (written
/// beside and renamed), so a reader never sees half of it.
pub fn set(key: &str, json: &str) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("{key}: {e}"))?;
    if json.len() > 1 << 20 {
        // Kept as one value (every dotfile together, every TODO), so what was being added is what makes it too large.
        return Err(crate::tr!("Home's {} would be larger than 1 MiB in all, so nothing was saved; make room in it first", "Home の {} が合わせて 1 MiB を超えるので、保存していません。先に空きを作ってください", key));
    }
    let path = file(key)?;
    // Home's state (profile, TODO) is the person's alone: the directory is
    // private and the file is made afresh, owner-only, before it is renamed in.
    crate::boundary::private_dir(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let _ = fs::remove_file(&temp);
    options.open(&temp).and_then(|mut f| {
        use std::io::Write;
        f.write_all(json.as_bytes())?;
        f.sync_all()
    }).and_then(|_| fs::rename(&temp, &path)).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

/// One TODO item, the same shape the app stores.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Todo {
    pub id: String,
    pub kind: Option<String>,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub done: bool,
    pub repo: Option<String>,
    pub created: u64,
}

pub fn todos() -> Result<Vec<Todo>> {
    let Some(text) = get("todo")? else { return Ok(Vec::new()) };
    // Items the app cannot read are left out, as the app does.
    let raw: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

pub fn save_todos(list: &[Todo]) -> Result<()> {
    set("todo", &serde_json::to_string(list).map_err(|e| e.to_string())?)
}

/// How long an item's first line and its detail may be, in UTF-16 units as the app counts them (src/todo.ts).
pub const TODO_LIMITS: [(&str, usize); 2] = [("title", 200), ("detail", 4000)];

/// A new item from a first line written as "Kind：title" (or plain text);
/// lines after the first are detail, before `detail`.
pub fn todo_from(line: &str, detail: &str, now: u64) -> Option<Todo> {
    let (first, more) = line.split_once('\n').unwrap_or((line, ""));
    let (kind, title) = kind_of(first);
    if title.trim().is_empty() && kind.is_none() {
        return None;
    }
    let detail = [more.trim(), detail.trim_end()].into_iter().filter(|d| !d.is_empty()).collect::<Vec<_>>().join("\n");
    let id = format!("{}-l3", radix36(now));
    Some(Todo { id, kind, title: title.trim().into(), detail, done: false, repo: None, created: now })
}

/// Home's profile, as the app keeps it (src/profile.ts).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub bio: String,
}

/// How long each field of a profile may be, in characters.
pub const PROFILE_LIMITS: [(&str, usize); 3] = [("name", 50), ("handle", 32), ("bio", 160)];

/// A handle: lowercase letters, digits, - and _ (src/profile.ts).
pub fn valid_handle(h: &str) -> bool {
    !h.is_empty() && h.len() <= 32 && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

pub fn profile() -> Profile {
    get("profile").ok().flatten().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Change one field of the profile ("name", "handle" or "bio"), checked as the app checks it.
pub fn set_profile(field: &str, value: &str) -> Result<Profile> {
    let mut p = profile();
    let v = value.trim().to_string();
    let limit = PROFILE_LIMITS.iter().find(|(f, _)| *f == field).map(|(_, n)| *n)
        .ok_or_else(|| crate::tr!("A profile has a name, a handle and a bio", "プロフィールは name、handle、bio です"))?;
    match field {
        "handle" => {
            let h = v.trim_start_matches('@').to_ascii_lowercase();
            if !h.is_empty() && !valid_handle(&h) {
                return Err(crate::tr!("A handle is up to 32 lowercase letters, digits, - and _", "ハンドルは英小文字・数字・- _ の32文字までです"));
            }
            p.handle = h;
        }
        _ if v.chars().count() > limit => {
            return Err(if field == "name" { crate::tr!("A name is up to {} characters", "名前は{}文字までです", limit) } else { crate::tr!("A bio is up to {} characters", "自己紹介は{}文字までです", limit) });
        }
        "name" => p.name = v,
        _ => p.bio = v,
    }
    set("profile", &serde_json::to_string(&p).map_err(|e| e.to_string())?)?;
    Ok(p)
}

/// Forge's band: the repos out on it, in order, only those in `here` (src/band.ts).
/// Never chosen yet, it holds the first repo.
pub fn band(here: &[String]) -> Result<Vec<String>> {
    let Some(text) = get("band")? else { return Ok(here.first().cloned().into_iter().collect()) };
    let stored: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for n in stored.iter().filter_map(|v| v.as_str()) {
        if here.iter().any(|h| h == n) && !out.iter().any(|o| o == n) { out.push(n.to_string()); }
    }
    Ok(out)
}

/// Put `repo` out on the band (`on`), or take it in. Whether the band changed.
pub fn set_band(here: &[String], repo: &str, on: bool) -> Result<bool> {
    let mut b = band(here)?;
    let was = b.iter().any(|n| n == repo);
    if was == on { return Ok(false); }
    if on { b.push(repo.to_string()); } else { b.retain(|n| n != repo); }
    set("band", &serde_json::to_string(&b).map_err(|e| e.to_string())?)?;
    Ok(true)
}

/// Whether `repo`'s Prompts may reach the network (granted in Runtime; `l3 prompt --network` for one Prompt).
pub fn network(repo: &str) -> bool {
    let Ok(Some(text)) = get("network") else { return false };
    serde_json::from_str::<Vec<String>>(&text).is_ok_and(|all| all.iter().any(|r| r == repo))
}

/// A dotfile's name as it may be written into /root: a dot, then letters, digits and . _ - (src/dotfiles.ts).
pub fn dotfile_name(name: &str) -> bool {
    name.len() > 1 && name.len() <= 64 && name.starts_with('.') && name != ".." && !name.contains("..")
        && name.bytes().skip(1).all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// The names the app offers for a new dotfile.
pub const COMMON_DOTFILES: [&str; 8] = [".profile", ".shrc", ".gitconfig", ".nanorc", ".inputrc", ".editorconfig", ".packages", ".setup"];

/// The dotfiles Home keeps (`dotfiles`: a JSON object of name → text), those with a name that may be written.
pub fn dotfiles() -> Vec<(String, String)> {
    let Ok(Some(text)) = get("dotfiles") else { return Vec::new() };
    let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, String>>(&text) else { return Vec::new() };
    map.into_iter().filter(|(n, _)| dotfile_name(n)).collect()
}

/// Replace (or make) a dotfile, or remove it (`None`). Whether it was there before.
pub fn set_dotfile(name: &str, text: Option<&str>) -> Result<bool> {
    if !dotfile_name(name) {
        return Err(crate::tr!("A dotfile is named with a dot first: .profile", "dotfile の名前は . で始めます：.profile"));
    }
    let mut all: std::collections::BTreeMap<String, String> = get("dotfiles")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let was = match text {
        Some(t) => all.insert(name.to_string(), t.to_string()).is_some(),
        None => all.remove(name).is_some(),
    };
    if text.is_none() && !was {
        return Err(crate::tr!("There is no dotfile {}", "dotfile {} はありません", name));
    }
    set("dotfiles", &serde_json::to_string(&all).map_err(|e| e.to_string())?)?;
    Ok(was)
}

fn radix36(mut n: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
        if n == 0 { break; }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_is_its_first_line_then_detail() {
        let t = todo_from("Fix：title", "why", 0).unwrap();
        assert_eq!((t.kind.as_deref(), t.title.as_str(), t.detail.as_str()), (Some("Fix"), "title", "why"));
        // Lines after the first are detail, before the detail given (bug: they stayed in the title).
        let t = todo_from("Fix：title\nsecond\nthird\n", "why", 0).unwrap();
        assert_eq!((t.title.as_str(), t.detail.as_str()), ("title", "second\nthird\nwhy"));
        assert_eq!(todo_from("Fix：title\nmore", "", 0).unwrap().detail, "more");
        assert!(todo_from("\nFix：title", "", 0).is_none());
        assert!(todo_from("Fix：", "", 0).is_some_and(|t| t.kind.as_deref() == Some("Fix") && t.title.is_empty()));
    }
}
