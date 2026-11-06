//! Home's state as files the person owns: `<data>/home/<key>.json`. The app
//! keeps its profile, TODO and band here (in a browser, in its storage), and
//! l3 reads and writes the same TODO.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::paths::home_dir;
use crate::words::title::kind_of;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// The state the OS keeps for Home. Anything else is refused.
/// `network`: the repos whose Prompts may reach the network, on this device only (it is never sent).
/// `trusted`: the dotfiles this device runs, as they were taken here (never sent; see dotfiles_in_effect).
pub const KEYS: [&str; 9] = ["profile", "todo", "band", "remote", "sync", "lang", "dotfiles", "network", "trusted"];

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
    crate::disk::write::private_dir(path.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::disk::write::replace(&path, json.as_bytes(), crate::disk::write::How::PRIVATE).map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))?;
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
pub const PROFILE_LIMITS: [(&str, usize); 3] = [("name", 50), ("handle", 31), ("bio", 160)];

/// A handle is a username: 2–31 lowercase letters, digits, . - and _, from a letter or digit (src/home/profile.ts).
pub fn valid_handle(h: &str) -> bool {
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (2..=31).contains(&h.len()) && h.bytes().next().is_some_and(word) && h.bytes().all(|b| word(b) || b"._-".contains(&b))
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
                return Err(crate::tr!("Handle must be 2–31 lowercase letters, digits, or . - _", "ハンドル名は英小文字・数字・. - _ の2〜31文字で入力してください"));
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
/// (src/pages/runtime/prompts.ts). Whether it changed.
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

type Dotfiles = std::collections::BTreeMap<String, String>;

/// A map of dotfiles kept under `key`, those with a name that may be written; None when there is none.
fn dotfile_map(key: &str) -> Result<Option<Dotfiles>> {
    let Some(text) = get(key)? else { return Ok(None) };
    let map: Dotfiles = serde_json::from_str(&text).unwrap_or_default();
    Ok(Some(map.into_iter().filter(|(n, _)| dotfile_name(n)).collect()))
}

/// The dotfiles Home keeps (`dotfiles`: a JSON object of name → text), as the Remote has them: what is listed and
/// edited. What runs on this device is dotfiles_in_effect.
pub fn dotfiles() -> Vec<(String, String)> {
    dotfile_map("dotfiles").ok().flatten().unwrap_or_default().into_iter().collect()
}

// ---- what of the dotfiles this device runs ----
//
// The dotfiles are kept on the Remote and taken in on every device, and what they hold runs: `.setup` with the
// network as a Prompt is prepared, `.profile` and the like in every shell, `.gitconfig` in git, and the keys in
// `.authorized_keys` are let in over SSH. So what came from elsewhere (another of the person's devices, or anyone
// able to write to the Remote as them: a Remote broken into, a device's session taken) runs nowhere until the person
// at this device has taken it here; what is written here is taken here at once. `trusted` (this device's, never
// sent) holds each dotfile as it was taken here, and a Prompt, a shell and the SSH listener read those, never the
// Remote's. One taken away elsewhere goes here too: going runs nothing.

/// Before anything of the dotfiles is read for running or the Remote's are taken in: what this device ran until
/// now (from a version with no `trusted`) is what it trusts; a device new to them trusts none.
pub fn keep_trust() -> Result<()> {
    if get("trusted")?.is_none() {
        let ran = dotfile_map("dotfiles")?.unwrap_or_default();
        set("trusted", &serde_json::to_string(&ran).map_err(|e| e.to_string())?)?;
    }
    Ok(())
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

/// The dotfiles changed or added elsewhere and not taken here: kept, and nothing of them runs here yet.
pub fn dotfiles_waiting() -> Vec<String> {
    let read = || -> Result<Vec<String>> {
        keep_trust()?;
        let trusted = dotfile_map("trusted")?.unwrap_or_default();
        Ok(dotfile_map("dotfiles")?.unwrap_or_default().into_iter().filter(|(n, t)| trusted.get(n) != Some(t)).map(|(n, _)| n).collect())
    };
    read().unwrap_or_default()
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
    /// Nothing agreed for `key` any more: the record of it (and the value it holds) goes.
    fn forget(&mut self, key: &str) -> Result<()>;
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

/// Take `key` off this device when it is what was last agreed with the Remote, which keeps it: its value and the
/// record of it go, so the next agreement takes the Remote's whole, as on a device new to it. One changed here
/// since (not sent yet), or never agreed, is not on the Remote: it stays, and false says so. None here has gone.
pub fn leave(here: &mut impl HomeHere, key: &str) -> Result<bool> {
    if let Some(mine) = here.value(key)? {
        if here.agreed(key)?.is_none_or(|b| b.value != mine) {
            return Ok(false);
        }
        here.set_value(key, None)?;
    }
    here.forget(key)?;
    Ok(true)
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

    fn forget(&mut self, key: &str) -> Result<()> {
        let Some(mut v) = get("sync")?.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { return Ok(()) };
        let Some(home) = v["home"].as_object_mut().filter(|h| h.contains_key(key)) else { return Ok(()) };
        home.remove(key);
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

/// Choose the language Home keeps, for the app and l3 alike.
pub fn set_lang(lang: &str) -> crate::Result<()> {
    if !LANGS.contains(&lang) { return Err(crate::tr!("The OS speaks en or ja", "OS が話すのは en か ja です")); }
    set("lang", &serde_json::to_string(lang).map_err(|e| e.to_string())?)
}

/// The language Home keeps (what the app and l3 speak unless $LENGTH3_LANG says otherwise).
pub fn lang() -> String {
    get("lang").ok().flatten().and_then(|t| serde_json::from_str::<String>(&t).ok())
        .filter(|l| LANGS.contains(&l.as_str())).unwrap_or_else(|| "en".into())
}

/// The languages the OS speaks.
pub const LANGS: [&str; 2] = ["en", "ja"];

#[cfg(test)]
#[path = "tests/home.rs"]
mod tests;
