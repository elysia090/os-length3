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
pub const KEYS: [&str; 6] = ["profile", "todo", "band", "remote", "sync", "lang"];

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
        return Err(format!("{key} is larger than 1 MiB"));
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

/// A new item from a first line written as "Kind：title" (or plain text).
pub fn todo_from(line: &str, detail: &str, now: u64) -> Option<Todo> {
    let (kind, title) = kind_of(line);
    if title.trim().is_empty() && kind.is_none() {
        return None;
    }
    let id = format!("{}-l3", radix36(now));
    Some(Todo { id, kind, title: title.trim().into(), detail: detail.trim_end().into(), done: false, repo: None, created: now })
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
