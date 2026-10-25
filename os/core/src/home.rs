//! Home's state as files the person owns: `<data>/home/<key>.json`. The app
//! keeps its profile, TODO and band here (in a browser, in its storage), and
//! l3 reads and writes the same TODO.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

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

/// Let `key` go: there is none of it here.
pub fn remove(key: &str) -> Result<()> {
    match fs::remove_file(file(key)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
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
    // Home's state (profile, TODO, the Remote's session) is the person's alone: the directory is private and
    // the file owner-only.
    crate::boundary::private_dir(path.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::atomic::replace(&path, json.as_bytes(), crate::atomic::How::PRIVATE).map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))?;
    if key == "lang" { crate::i18n::changed(); }
    Ok(())
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
    parse_todos(&text)
}

/// A stored list. Items the app cannot read are left out, as the app does;
/// a list that cannot be read at all is refused, not taken for an empty one,
/// which the next change would be written over.
pub fn parse_todos(text: &str) -> Result<Vec<Todo>> {
    let raw: Vec<serde_json::Value> = serde_json::from_str(text)
        .map_err(|e| crate::tr!("Home's TODO could not be read ({}), so nothing is written over it", "Home の TODO を読めませんでした（{}）。上書きはしません", e))?;
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

pub fn save_todos(list: &[Todo]) -> Result<()> {
    set("todo", &serde_json::to_string(list).map_err(|e| e.to_string())?)
}

/// How long an item's first line and its detail may be, in UTF-16 units as the app counts them (src/home/todo.ts).
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
    // The moment, and a part of its own: two made in one millisecond (a script, two devices) are two items.
    let id = format!("{}-l3{}", radix36(now), radix36(unique() % 36u64.pow(6)));
    Some(Todo { id, kind, title: title.trim().into(), detail, done: false, repo: None, created: now })
}

/// `item` with its first line written again as `line` reads (src/home/todo.ts `edit`): the same item,
/// its id, whether it is done and when it was made kept. Its detail is the lines after the first
/// and `detail` when either is given; otherwise it stays. None when the first line is empty.
pub fn todo_edited(item: &Todo, line: &str, detail: Option<&str>) -> Option<Todo> {
    let new = todo_from(line, detail.unwrap_or_default(), item.created)?;
    let more = line.split_once('\n').is_some_and(|(_, more)| !more.trim().is_empty());
    let detail = if more || detail.is_some() { new.detail } else { item.detail.clone() };
    Some(Todo { kind: new.kind, title: new.title, detail, ..item.clone() })
}

/// Home's profile, as the app keeps it (src/home/profile.ts).
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

/// A handle: lowercase letters, digits, - and _ (src/home/profile.ts).
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

/// Forge's band: the repos out on it, in order, only those in `here` (src/home/band.ts).
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
    networked().iter().any(|r| r == repo)
}

/// The repos whose Prompts may reach the network here, in order.
pub fn networked() -> Vec<String> {
    let Ok(Some(text)) = get("network") else { return Vec::new() };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
}

/// Give `repo`'s Prompts the network here (`on`), or take it; kept sorted, as Runtime keeps it
/// (src/pages/runtime.ts). Whether it changed.
pub fn set_network(repo: &str, on: bool) -> Result<bool> {
    // A file that could not be read is not written over.
    let mut all: Vec<String> = get("network")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if all.iter().any(|r| r == repo) == on { return Ok(false); }
    if on { all.push(repo.to_string()); } else { all.retain(|r| r != repo); }
    all.sort();
    all.dedup();
    set("network", &serde_json::to_string(&all).map_err(|e| e.to_string())?)?;
    Ok(true)
}

/// A dotfile's name as it may be written into /root: a dot, then letters, digits and . _ - (src/home/dotfiles.ts).
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

// ---- kept on the Remote (service/app.ts `/v1/home/:key`) ----
//
// The same protocol and rules as the app's (src/remote/sync.ts `syncHome`), and
// the same record of what was agreed (the `sync` setting's `home`), so the
// app and l3 on one device are one device to the Remote. Each setting is a
// value and its version there; a change is sent from the version it was
// read at. Unchanged here, the Remote's is taken. Changed here and there
// too: two TODO lists are joined against what both last agreed; any other setting is the
// Remote's (it got there first).

/// Home's settings that are the person's, kept on the Remote (src/remote/sync.ts
/// `HOME_KEYS`). The band, the language and the network grant are this device's.
pub const SYNCED: [&str; 3] = ["profile", "todo", "dotfiles"];

/// What was last agreed with the Remote for a setting: its version there, and the value then.
#[derive(Clone, Debug, PartialEq)]
pub struct Agreed {
    pub version: i64,
    pub value: String,
    /// The account it was agreed with (its id); none from before accounts were noted.
    pub who: Option<String>,
}

/// Where a setting is kept here: its value, and what was last agreed for it.
pub trait HomeHere {
    fn value(&self, key: &str) -> Result<Option<String>>;
    /// Set `key`'s value; None: there is none (the Remote never kept one for this account).
    fn set_value(&mut self, key: &str, value: Option<&str>) -> Result<()>;
    fn agreed(&self, key: &str) -> Result<Option<Agreed>>;
    fn agree(&mut self, key: &str, a: Agreed) -> Result<()>;
}

/// The Remote's side of a setting.
pub trait HomeThere {
    /// Its value there (None: never set) and its version (0 then).
    fn get(&self, key: &str) -> Result<(Option<String>, i64)>;
    /// Send `value` as changed from `version`: the version it is now, or None when another came first.
    fn put(&self, key: &str, value: &str, version: i64) -> Result<Option<i64>>;
}

/// What agreeing a setting did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
pub struct HomeSynced {
    /// The version agreed.
    pub version: i64,
    /// This device's value went to the Remote.
    pub sent: bool,
    /// The Remote's value was written here.
    pub taken: bool,
    /// Two TODO lists were joined.
    pub joined: bool,
}

/// What the Remote answers for a setting (`GET /v1/home/:key`): `{value, version}`.
pub fn got(v: &serde_json::Value) -> Result<(Option<String>, i64)> {
    let version = v["version"].as_i64().ok_or_else(|| crate::tr!("The Remote's answer is not a setting", "Remote の答えが設定の形ではありません"))?;
    Ok((v["value"].as_str().map(String::from), version))
}

/// What is sent to change a setting (`PUT /v1/home/:key`).
pub fn put_body(value: &str, version: i64) -> serde_json::Value {
    serde_json::json!({"value": value, "version": version})
}

/// The version a setting is at once the Remote took it (`{version}`).
pub fn put_version(v: &serde_json::Value) -> Result<i64> {
    v["version"].as_i64().ok_or_else(|| crate::tr!("The Remote's answer is not a setting", "Remote の答えが設定の形ではありません"))
}

/// Whether two items' ids are the same as a JavaScript Set sees them (src/remote/sync.ts):
/// absent ones are, as are equal strings, numbers, booleans and nulls; objects never are.
fn same_id(a: Option<&serde_json::Value>, b: Option<&serde_json::Value>) -> bool {
    use serde_json::Value as V;
    match (a, b) {
        (None, None) => true,
        (Some(V::Number(x)), Some(V::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(x @ (V::String(_) | V::Bool(_) | V::Null)), Some(y)) => x == y,
        _ => false,
    }
}

/// Two TODO lists as one, against the one both last agreed (`base`), as
/// src/remote/sync.ts `joinTodo`: an item only one side changed or removed is as
/// that side left it, one both changed is this device's, and every item
/// either side added is kept, the Remote's new ones first. Nothing agreed
/// (or not a list): every item from both, this device's where both have it.
/// One side not a list, or an item that is null: this device's stands.
pub fn join_todo(base: &str, here: &str, there: &str) -> String {
    use serde_json::Value;
    let lists = (serde_json::from_str::<Value>(here), serde_json::from_str::<Value>(there));
    let (Ok(Value::Array(a)), Ok(Value::Array(b))) = lists else { return here.to_string() };
    if a.iter().chain(&b).any(|x| x.is_null()) { return here.to_string(); }
    let was: Vec<Value> = match serde_json::from_str::<Value>(base) { Ok(Value::Array(o)) => o.into_iter().filter(|x| !x.is_null()).collect(), _ => Vec::new() };
    let id = |x: &Value| x.as_object().and_then(|o| o.get("id")).cloned();
    // By id as the app's Map holds them: the last of each.
    let find = |list: &[Value], x: &Value| list.iter().rev().find(|y| same_id(id(y).as_ref(), id(x).as_ref())).cloned();
    let untouched = |x: &Value| find(&was, x).is_some_and(|w| w == *x);
    let mut out: Vec<Value> = b.iter().filter(|x| find(&a, x).is_none() && !untouched(x)).cloned().collect();
    for x in &a {
        if !untouched(x) { out.push(x.clone()); } else if let Some(t) = find(&b, x) { out.push(t); }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| here.to_string())
}

/// Whether a setting here differs from what was last agreed: it waits to be sent.
pub fn waiting(here: &impl HomeHere, key: &str) -> bool {
    match (here.value(key), here.agreed(key)) {
        (Ok(Some(v)), Ok(b)) => b.is_none_or(|b| b.value != v),
        _ => false,
    }
}

/// Agree `key` with the Remote. Unchanged here, the Remote's is taken.
/// Changed here, it is sent from the version it was read at; if another
/// device changed it meanwhile, the TODO lists are joined and any other
/// setting is the Remote's.
///
/// `who` is the account signed in. One agreed with another account (another who signed in on this device)
/// is never sent to this one: changed under that account and not sent, it waits here for it; as that
/// account left it, this account's own takes its place.
pub fn agree_with(here: &mut impl HomeHere, there: &impl HomeThere, key: &str, who: Option<&str>) -> Result<HomeSynced> {
    let mut out = HomeSynced::default();
    let who = who.map(String::from);
    for _ in 0..3 {
        let b = here.agreed(key)?;
        let mine = here.value(key)?;
        let (theirs, version) = there.get(key)?;
        let changed = mine.is_some() && mine.as_deref() != b.as_ref().map(|b| b.value.as_str());
        if let (Some(was), Some(now)) = (b.as_ref().and_then(|b| b.who.as_deref()), who.as_deref()) {
            if was != now {
                if changed { return Ok(out); }
                here.set_value(key, theirs.as_deref())?;
                here.agree(key, Agreed { version, value: theirs.unwrap_or_default(), who })?;
                out.taken = true;
                out.version = version;
                return Ok(out);
            }
        }
        if !changed {
            if let Some(t) = theirs.as_deref().filter(|t| Some(*t) != mine.as_deref()) {
                here.set_value(key, Some(t))?;
                out.taken = true;
            }
            here.agree(key, Agreed { version, value: theirs.or(mine).unwrap_or_default(), who })?;
            out.version = version;
            return Ok(out);
        }
        let mine = mine.unwrap_or_default();
        let mut value = mine.clone();
        if let Some(t) = theirs.filter(|_| version != b.as_ref().map_or(0, |b| b.version)) {
            if key != "todo" {
                // The Remote's stands, and is what is agreed now (bug: it was taken but never agreed, so it was taken again and again).
                here.set_value(key, Some(&t))?;
                here.agree(key, Agreed { version, value: t, who })?;
                out.taken = true;
                out.version = version;
                return Ok(out);
            }
            value = join_todo(&b.as_ref().map_or(String::new(), |b| b.value.clone()), &mine, &t);
            if value != mine {
                here.set_value(key, Some(&value))?;
                out.joined = true;
            }
        }
        if let Some(v) = there.put(key, &value, version)? {
            here.agree(key, Agreed { version: v, value, who })?;
            out.sent = true;
            out.version = v;
            return Ok(out);
        }
        // Another device sent it first: read again.
    }
    Err(crate::tr!("Home's {} kept changing on the Remote", "Home の {} が Remote で変わり続けています", key))
}

/// Home's files here, and what was last agreed for each: the `sync`
/// setting's `home`, as the app keeps it (src/remote/sync.ts), beside its other records.
pub struct Files;

impl HomeHere for Files {
    fn value(&self, key: &str) -> Result<Option<String>> {
        get(key)
    }

    fn set_value(&mut self, key: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => set(key, v),
            None => remove(key),
        }
    }

    fn agreed(&self, key: &str) -> Result<Option<Agreed>> {
        let Some(text) = get("sync")? else { return Ok(None) };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let b = &v["home"][key];
        Ok(b["value"].as_str().map(|value| Agreed { version: b["version"].as_i64().unwrap_or(0), value: value.into(), who: b["who"].as_str().map(String::from) }))
    }

    fn agree(&mut self, key: &str, a: Agreed) -> Result<()> {
        // Not readable: nothing is agreed (as the app reads it), and its other records start afresh.
        let mut v = get("sync")?.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).filter(|v| v.is_object())
            .unwrap_or_else(|| serde_json::json!({"repos": {}}));
        if !v["home"].is_object() { v["home"] = serde_json::json!({}); }
        v["home"][key] = serde_json::json!({"version": a.version, "value": a.value});
        if let Some(who) = a.who { v["home"][key]["who"] = who.into(); }
        set("sync", &serde_json::to_string(&v).map_err(|e| e.to_string())?)
    }
}

/// A number no other call is likely to have: std's random per-process keys, moved on at each call, over the time.
fn unique() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    h.finish()
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

    fn item(id: &str, title: &str) -> String {
        format!(r#"{{"id":"{id}","kind":null,"title":"{title}","detail":"","done":false,"repo":null,"created":1}}"#)
    }

    #[test]
    fn a_list_is_read_without_the_items_the_app_cannot_read() {
        let text = format!("[{},{{\"id\":1}},null,{}]", item("a", "one"), item("b", "two"));
        assert_eq!(parse_todos(&text).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        // An item the app wrote before it had details, or in its own field order, is read all the same.
        let t = parse_todos(r#"[{"created":2,"repo":null,"done":true,"title":"x","kind":"Fix","id":"c"}]"#).unwrap();
        assert_eq!((t[0].kind.as_deref(), t[0].detail.as_str(), t[0].done), (Some("Fix"), "", true));
    }

    #[test]
    fn a_list_that_cannot_be_read_is_refused_not_taken_for_empty() {
        // Taken for empty, the next `l3 todo add` would write the one new item over every item there.
        for text in ["", "not json", "{\"a\":1}", "[1,", "\"[]\""] {
            assert!(parse_todos(text).is_err(), "{text:?}");
        }
        // A character the app cut in half (a lone surrogate, as an older app could write) is one serde
        // cannot read: refused too, not wiped.
        let half = format!("[{}]", item("a", r"x\ud83d"));
        assert!(parse_todos(&half).is_err());
        assert_eq!(parse_todos("[]").unwrap(), Vec::<Todo>::new());
    }

    #[test]
    fn two_items_made_in_the_same_millisecond_have_ids_of_their_own() {
        let (a, b) = (todo_from("a", "", 7).unwrap(), todo_from("b", "", 7).unwrap());
        assert_ne!(a.id, b.id);
        assert!(a.id.starts_with(&radix36(7)), "{}", a.id);
    }

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

    #[test]
    fn an_item_written_again_is_the_same_item() {
        let was = Todo { id: "k-1".into(), kind: Some("Fix".into()), title: "old".into(), detail: "why".into(), done: true, repo: Some("hello".into()), created: 7 };
        // The first line alone: the detail stays.
        let t = todo_edited(&was, "Patch：new", None).unwrap();
        assert_eq!(t, Todo { kind: Some("Patch".into()), title: "new".into(), ..was.clone() });
        // Lines after it, or -m: the detail is those.
        assert_eq!(todo_edited(&was, "Patch：new\nsecond", Some("third")).unwrap().detail, "second\nthird");
        assert_eq!(todo_edited(&was, "plain", Some("")).unwrap(), Todo { kind: None, title: "plain".into(), detail: String::new(), ..was.clone() });
        assert_eq!(todo_edited(&was, "new\n  \n", None).unwrap().detail, "why");
        assert!(todo_edited(&was, "  ", None).is_none());
    }

    // ---- Home on the Remote, against what the Remote answers (shared/home-sync.json) ----

    use serde_json::{json, Value};
    use std::cell::RefCell;
    use std::collections::HashMap;

    fn recorded() -> Vec<Value> {
        let v: Value = serde_json::from_str(include_str!("../../shared/home-sync.json")).unwrap();
        v["exchanges"].as_array().unwrap().clone()
    }

    /// The Remote's settings as service/app.ts keeps them: a value and its version each,
    /// changed only from the version it is at (0: made, if it is not there yet).
    #[derive(Default)]
    struct Remote { kept: RefCell<HashMap<String, (String, i64)>>, asked: RefCell<Vec<String>>, before_put: RefCell<Option<(String, String)>> }

    impl Remote {
        /// One request, answered as the service answers it: (status, body).
        fn answer(&self, method: &str, path: &str, body: Option<&Value>) -> (u16, Value) {
            let key = path.strip_prefix("/v1/home/").unwrap();
            self.asked.borrow_mut().push(format!("{method} {key}"));
            let mut kept = self.kept.borrow_mut();
            let now = |k: &HashMap<String, (String, i64)>| k.get(key).map_or(json!({"value": null, "version": 0}), |(v, n)| json!({"value": v, "version": n}));
            if method == "GET" { return (200, now(&kept)); }
            if !(1..=32).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_lowercase()) { return (404, json!({"error": "Not found"})); }
            let (Some(value), Some(version)) = (body.and_then(|b| b["value"].as_str()), body.and_then(|b| b["version"].as_i64())) else {
                return (400, json!({"error": "a value and its version"}));
            };
            match kept.get(key).map(|k| k.1) {
                None if version == 0 => { kept.insert(key.into(), (value.into(), 1)); (200, json!({"version": 1})) }
                Some(n) if version != 0 && n == version => { kept.insert(key.into(), (value.into(), n + 1)); (200, json!({"version": n + 1})) }
                _ => (409, now(&kept)),
            }
        }

        /// Another device writes `value` from the version there now.
        fn elsewhere(&self, key: &str, value: &str) {
            let version = self.kept.borrow().get(key).map_or(0, |k| k.1);
            assert_eq!(self.answer("PUT", &format!("/v1/home/{key}"), Some(&put_body(value, version))).0, 200);
        }
    }

    impl HomeThere for Remote {
        fn get(&self, key: &str) -> Result<(Option<String>, i64)> {
            got(&self.answer("GET", &format!("/v1/home/{key}"), None).1)
        }
        fn put(&self, key: &str, value: &str, version: i64) -> Result<Option<i64>> {
            // Another device, between this one's read and its write.
            if let Some((k, v)) = self.before_put.borrow_mut().take() { self.elsewhere(&k, &v); }
            match self.answer("PUT", &format!("/v1/home/{key}"), Some(&put_body(value, version))) {
                (200, v) => put_version(&v).map(Some),
                (409, _) => Ok(None),
                (s, v) => Err(format!("{s} {v}")),
            }
        }
    }

    /// Home's files on one device, in memory.
    #[derive(Default)]
    struct Device { values: HashMap<String, String>, agreed: HashMap<String, Agreed> }

    impl HomeHere for Device {
        fn value(&self, key: &str) -> Result<Option<String>> { Ok(self.values.get(key).cloned()) }
        fn set_value(&mut self, key: &str, value: Option<&str>) -> Result<()> {
            match value { Some(v) => self.values.insert(key.into(), v.into()), None => self.values.remove(key) };
            Ok(())
        }
        fn agreed(&self, key: &str) -> Result<Option<Agreed>> { Ok(self.agreed.get(key).cloned()) }
        fn agree(&mut self, key: &str, a: Agreed) -> Result<()> { self.agreed.insert(key.into(), a); Ok(()) }
    }

    #[test]
    fn the_remote_here_answers_as_the_service_does() {
        let r = Remote::default();
        for (i, x) in recorded().iter().enumerate() {
            let body = x.get("body");
            // What l3 sends is the shape the Remote was recorded taking.
            if let (Some(b), Some(v), Some(n)) = (body, body.and_then(|b| b["value"].as_str()), body.and_then(|b| b["version"].as_i64())) {
                assert_eq!(&put_body(v, n), b, "exchange {}", i + 1);
            }
            let (status, answer) = r.answer(x["method"].as_str().unwrap(), x["path"].as_str().unwrap(), body);
            assert_eq!((status, &answer), (x["status"].as_u64().unwrap() as u16, &x["response"]), "exchange {}", i + 1);
            // And what it answers is read as what it says.
            match (x["method"].as_str(), status) {
                (Some("GET"), 200) => assert_eq!(got(&answer).unwrap(), (answer["value"].as_str().map(String::from), answer["version"].as_i64().unwrap())),
                (Some("PUT"), 200) => assert_eq!(put_version(&answer).unwrap(), answer["version"].as_i64().unwrap()),
                (Some("PUT"), 409) => assert!(got(&answer).is_ok()),
                _ => {}
            }
        }
        assert!(got(&json!({"error": "Not found"})).is_err());
    }

    #[test]
    fn a_device_with_only_l3_sends_its_todo_and_takes_the_remotes() {
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("todo".into(), r#"[{"id":"a"}]"#.into());
        assert!(waiting(&d, "todo"));
        let s = agree_with(&mut d, &r, "todo", None).unwrap();
        assert_eq!((s.sent, s.taken, s.version), (true, false, 1));
        assert_eq!(r.kept.borrow()["todo"], (r#"[{"id":"a"}]"#.to_string(), 1));
        assert!(!waiting(&d, "todo"));
        // Agreed and unchanged: one read, nothing sent.
        r.asked.borrow_mut().clear();
        assert_eq!(agree_with(&mut d, &r, "todo", None).unwrap(), HomeSynced { version: 1, ..Default::default() });
        assert_eq!(*r.asked.borrow(), ["GET todo"]);
        // Changed on another device, not here: taken.
        r.elsewhere("todo", r#"[{"id":"a"},{"id":"b"}]"#);
        let s = agree_with(&mut d, &r, "todo", None).unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 2));
        assert_eq!(d.values["todo"], r#"[{"id":"a"},{"id":"b"}]"#);
        // Nothing here and nothing there: nothing is sent, and nothing waits.
        let mut e = Device::default();
        assert_eq!(agree_with(&mut e, &r, "profile", None).unwrap(), HomeSynced::default());
        assert_eq!(e.agreed["profile"], Agreed { version: 0, value: String::new(), who: None });
        assert!(!waiting(&e, "profile") && !e.values.contains_key("profile"));
    }

    #[test]
    fn todo_from_two_devices_is_joined_item_by_item() {
        // As src/remote/sync.test.ts: this device sent [a]; another made it [a, b]; this one made it [a, c].
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("todo".into(), r#"[{"id":"a","title":"here"}]"#.into());
        agree_with(&mut d, &r, "todo", None).unwrap();
        r.elsewhere("todo", r#"[{"id":"a","title":"here"},{"id":"b","title":"there"}]"#);
        d.values.insert("todo".into(), r#"[{"id":"a","title":"here, changed"},{"id":"c","title":"mine"}]"#.into());
        let s = agree_with(&mut d, &r, "todo", None).unwrap();
        assert_eq!((s.joined, s.sent, s.version), (true, true, 3));
        // The Remote's others first, then this device's list; this device's where both have one.
        let joined = r#"[{"id":"b","title":"there"},{"id":"a","title":"here, changed"},{"id":"c","title":"mine"}]"#;
        assert_eq!((d.values["todo"].as_str(), r.kept.borrow()["todo"].0.as_str()), (joined, joined));
        assert!(!waiting(&d, "todo"));
        // Another device writes between this one's read and its write: read again, joined again.
        d.values.insert("todo".into(), format!(r#"{},{{"id":"d"}}]"#, &joined[..joined.len() - 1]));
        *r.before_put.borrow_mut() = Some(("todo".into(), r#"[{"id":"e"}]"#.into()));
        let s = agree_with(&mut d, &r, "todo", None).unwrap();
        assert_eq!(s.version, 5);
        let ids: Vec<String> = serde_json::from_str::<Vec<Value>>(&d.values["todo"]).unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect();
        // The other device's list is [e] alone: what it removed of the list agreed goes here too; d, new here, stays.
        assert_eq!(ids, ["e", "d"]);
        assert_eq!(r.kept.borrow()["todo"].0, d.values["todo"]);
    }

    #[test]
    fn a_profile_changed_on_both_is_the_remotes_and_agreed_at_once() {
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("profile".into(), r#"{"name":"Ren"}"#.into());
        agree_with(&mut d, &r, "profile", None).unwrap();
        r.elsewhere("profile", r#"{"name":"Ren T."}"#);
        d.values.insert("profile".into(), r#"{"name":"れん"}"#.into());
        r.asked.borrow_mut().clear();
        let s = agree_with(&mut d, &r, "profile", None).unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 2));
        assert_eq!(d.values["profile"], r#"{"name":"Ren T."}"#);
        // Agreed then and there (bug: it was taken but never agreed, so every look took it again, three reads each time).
        assert_eq!(*r.asked.borrow(), ["GET profile"]);
        assert!(!waiting(&d, "profile"));
        assert_eq!(d.agreed["profile"], Agreed { version: 2, value: r#"{"name":"Ren T."}"#.into(), who: None });
    }

    #[test]
    fn a_setting_of_another_account_is_never_sent_to_this_one() {
        let r = Remote::default();
        r.elsewhere("profile", r#"{"name":"B"}"#);
        let mut d = Device::default();
        d.agreed.insert("profile".into(), Agreed { version: 4, value: r#"{"name":"A"}"#.into(), who: Some("a".into()) });
        // Changed under A and not sent: it waits here for A, and nothing is asked of B's.
        d.values.insert("profile".into(), r#"{"name":"A2"}"#.into());
        assert_eq!(agree_with(&mut d, &r, "profile", Some("b")).unwrap(), HomeSynced::default());
        assert_eq!(d.values["profile"], r#"{"name":"A2"}"#);
        // As A left it: B's own takes its place, agreed with B.
        d.values.insert("profile".into(), r#"{"name":"A"}"#.into());
        let s = agree_with(&mut d, &r, "profile", Some("b")).unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 1));
        assert_eq!(d.agreed["profile"], Agreed { version: 1, value: r#"{"name":"B"}"#.into(), who: Some("b".into()) });
        // B never kept a TODO: A's goes, rather than becoming B's.
        d.values.insert("todo".into(), "[1]".into());
        d.agreed.insert("todo".into(), Agreed { version: 1, value: "[1]".into(), who: Some("a".into()) });
        agree_with(&mut d, &r, "todo", Some("b")).unwrap();
        assert!(!d.values.contains_key("todo"));
    }

    #[test]
    fn two_lists_join_as_the_app_joins_them() {
        assert_eq!(join_todo("", r#"[{"id":"a"},{"id":1}]"#, r#"[{"id":"b"},{"id":"a","x":1},{"id":1.0}]"#), r#"[{"id":"b"},{"id":"a"},{"id":1}]"#);
        // One side not a list, or an item that is null: this device's stands.
        for (here, there) in [("{}", "[]"), ("[]", "{}"), ("[]", "nonsense"), ("[null]", "[]"), ("[]", "[null]")] { assert_eq!(join_todo("[]", here, there), here); }
        // Items without an id are one id (absent) as the app's Set holds them; object ids are never the same.
        assert_eq!(join_todo("", r#"[{}]"#, r#"[{"t":1},{"id":{}}]"#), r#"[{"id":{}},{}]"#);
    }
}
