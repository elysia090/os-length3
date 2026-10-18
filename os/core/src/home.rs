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

/// `item` with its first line written again as `line` reads (src/todo.ts `edit`): the same item,
/// its id, whether it is done and when it was made kept. Its detail is the lines after the first
/// and `detail` when either is given; otherwise it stays. None when the first line is empty.
pub fn todo_edited(item: &Todo, line: &str, detail: Option<&str>) -> Option<Todo> {
    let new = todo_from(line, detail.unwrap_or_default(), item.created)?;
    let more = line.split_once('\n').is_some_and(|(_, more)| !more.trim().is_empty());
    let detail = if more || detail.is_some() { new.detail } else { item.detail.clone() };
    Some(Todo { kind: new.kind, title: new.title, detail, ..item.clone() })
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

// ---- kept on the Remote (service/app.ts `/v1/home/:key`) ----
//
// The same protocol and rules as the app's (src/draft.ts `syncHome`), and
// the same record of what was agreed (the `sync` setting's `home`), so the
// app and l3 on one device are one device to the Remote. Each setting is a
// value and its version there; a change is sent from the version it was
// read at. Unchanged here, the Remote's is taken. Changed here and there
// too: two TODO lists are joined, item by item against the list both were
// read from; any other setting is the
// Remote's (it got there first).

/// Home's settings that are the person's, kept on the Remote (src/draft.ts
/// `HOME_KEYS`). The band, the language and the network grant are this device's.
pub const SYNCED: [&str; 3] = ["profile", "todo", "dotfiles"];

/// What was last agreed with the Remote for a setting: its version there, and the value then.
#[derive(Clone, Debug, PartialEq)]
pub struct Agreed {
    pub version: i64,
    pub value: String,
}

/// Where a setting is kept here: its value, and what was last agreed for it.
pub trait HomeHere {
    fn value(&self, key: &str) -> Result<Option<String>>;
    fn set_value(&mut self, key: &str, value: &str) -> Result<()>;
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
#[derive(Debug, Default, Clone, Copy, PartialEq)]
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

/// Two TODO lists as one (src/draft.ts `mergeTodo`), item by item against the
/// list both were read from (`base`; None: nothing agreed yet): an item done,
/// edited or removed on one device is so on both, one added on either is
/// kept, and of an item changed on both, an edit stands over a removal
/// (nothing written is lost) and of two edits this device's. The Remote's
/// order stands; an item new here follows the one it follows here. One side
/// not a list, or an item that is null: this device's stands.
pub fn merge_todo(base: Option<&str>, here: &str, there: &str) -> String {
    use serde_json::Value as V;
    let list = |s: &str| match serde_json::from_str::<V>(s) { Ok(V::Array(a)) => Some(a), _ => None };
    let (Some(h), Some(r)) = (list(here), list(there)) else { return here.to_string() };
    let b = base.and_then(list).unwrap_or_default();
    if h.iter().chain(&r).any(|x| x.is_null()) { return here.to_string(); }
    let id = |x: &V| x.as_object().and_then(|o| o.get("id")).and_then(V::as_str).map(String::from);
    let find = |l: &[V], k: &str| l.iter().find(|x| id(x).as_deref() == Some(k)).cloned();
    let pick = |k: &str| -> Option<V> {
        let (x, y, z) = (find(&b, k), find(&h, k), find(&r, k));
        if y == z { return y; }
        if y == x { return z; }
        if z == x { return y; }
        y.or(z)
    };
    let mut out: Vec<V> = Vec::new();
    for x in &r {
        match id(x) { Some(k) => out.extend(pick(&k)), None => out.push(x.clone()) }
    }
    let mut next = 0;
    for x in &h {
        let k = id(x);
        let at = match &k { Some(k) => out.iter().position(|o| id(o).as_deref() == Some(k.as_str())), None => out.iter().position(|o| o == x) };
        if let Some(i) = at { next = i + 1; continue; }
        // On the Remote and not placed: removed here, as the Remote has it unchanged.
        if k.as_deref().is_some_and(|k| find(&r, k).is_some()) { continue; }
        if let Some(v) = match &k { Some(k) => pick(k), None => Some(x.clone()) } {
            out.insert(next, v);
            next += 1;
        }
    }
    if out == r { return there.to_string(); }
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
/// device changed it meanwhile, the TODO lists are joined against the list
/// both were read from, and any other setting is the Remote's.
pub fn agree_with(here: &mut impl HomeHere, there: &impl HomeThere, key: &str) -> Result<HomeSynced> {
    let mut out = HomeSynced::default();
    for _ in 0..3 {
        let b = here.agreed(key)?;
        let mine = here.value(key)?;
        let (theirs, version) = there.get(key)?;
        let changed = mine.is_some() && mine.as_deref() != b.as_ref().map(|b| b.value.as_str());
        if !changed {
            if let Some(t) = theirs.as_deref().filter(|t| Some(*t) != mine.as_deref()) {
                here.set_value(key, t)?;
                out.taken = true;
            }
            here.agree(key, Agreed { version, value: theirs.or(mine).unwrap_or_default() })?;
            out.version = version;
            return Ok(out);
        }
        let mine = mine.unwrap_or_default();
        let mut value = mine.clone();
        if let Some(t) = theirs.filter(|_| version != b.as_ref().map_or(0, |b| b.version)) {
            if key != "todo" {
                // The Remote's stands, and is what is agreed now (bug: it was taken but never agreed, so it was taken again and again).
                here.set_value(key, &t)?;
                here.agree(key, Agreed { version, value: t })?;
                out.taken = true;
                out.version = version;
                return Ok(out);
            }
            value = merge_todo(b.as_ref().map(|b| b.value.as_str()), &mine, &t);
            if value == t {
                // Nothing here the Remote lacks (all that changed here was done there too): its own is agreed, nothing sent.
                if value != mine {
                    here.set_value(key, &value)?;
                    out.taken = true;
                }
                here.agree(key, Agreed { version, value })?;
                out.version = version;
                return Ok(out);
            }
            if value != mine {
                here.set_value(key, &value)?;
                out.joined = true;
            }
        }
        if let Some(v) = there.put(key, &value, version)? {
            here.agree(key, Agreed { version: v, value })?;
            out.sent = true;
            out.version = v;
            return Ok(out);
        }
        // Another device sent it first: read again.
    }
    Err(crate::tr!("Home's {} kept changing on the Remote", "Home の {} が Remote で変わり続けています", key))
}

/// Home's files here, and what was last agreed for each: the `sync`
/// setting's `home`, as the app keeps it (src/draft.ts), beside its other records.
pub struct Files;

impl HomeHere for Files {
    fn value(&self, key: &str) -> Result<Option<String>> {
        get(key)
    }

    fn set_value(&mut self, key: &str, value: &str) -> Result<()> {
        set(key, value)
    }

    fn agreed(&self, key: &str) -> Result<Option<Agreed>> {
        let Some(text) = get("sync")? else { return Ok(None) };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
        let b = &v["home"][key];
        Ok(b["value"].as_str().map(|value| Agreed { version: b["version"].as_i64().unwrap_or(0), value: value.into() }))
    }

    fn agree(&mut self, key: &str, a: Agreed) -> Result<()> {
        // Not readable: nothing is agreed (as the app reads it), and its other records start afresh.
        let mut v = get("sync")?.and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).filter(|v| v.is_object())
            .unwrap_or_else(|| serde_json::json!({"repos": {}}));
        if !v["home"].is_object() { v["home"] = serde_json::json!({}); }
        v["home"][key] = serde_json::json!({"version": a.version, "value": a.value});
        set("sync", &serde_json::to_string(&v).map_err(|e| e.to_string())?)
    }
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
        fn set_value(&mut self, key: &str, value: &str) -> Result<()> { self.values.insert(key.into(), value.into()); Ok(()) }
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
        let s = agree_with(&mut d, &r, "todo").unwrap();
        assert_eq!((s.sent, s.taken, s.version), (true, false, 1));
        assert_eq!(r.kept.borrow()["todo"], (r#"[{"id":"a"}]"#.to_string(), 1));
        assert!(!waiting(&d, "todo"));
        // Agreed and unchanged: one read, nothing sent.
        r.asked.borrow_mut().clear();
        assert_eq!(agree_with(&mut d, &r, "todo").unwrap(), HomeSynced { version: 1, ..Default::default() });
        assert_eq!(*r.asked.borrow(), ["GET todo"]);
        // Changed on another device, not here: taken.
        r.elsewhere("todo", r#"[{"id":"a"},{"id":"b"}]"#);
        let s = agree_with(&mut d, &r, "todo").unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 2));
        assert_eq!(d.values["todo"], r#"[{"id":"a"},{"id":"b"}]"#);
        // Nothing here and nothing there: nothing is sent, and nothing waits.
        let mut e = Device::default();
        assert_eq!(agree_with(&mut e, &r, "profile").unwrap(), HomeSynced::default());
        assert_eq!(e.agreed["profile"], Agreed { version: 0, value: String::new() });
        assert!(!waiting(&e, "profile") && !e.values.contains_key("profile"));
    }

    #[test]
    fn todo_from_two_devices_is_joined_item_by_item() {
        // As src/draft.test.ts: this device sent [a]; another made it [a, b]; this one made it [a, c].
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("todo".into(), r#"[{"id":"a","title":"here"}]"#.into());
        agree_with(&mut d, &r, "todo").unwrap();
        r.elsewhere("todo", r#"[{"id":"a","title":"here"},{"id":"b","title":"there"}]"#);
        d.values.insert("todo".into(), r#"[{"id":"a","title":"here, changed"},{"id":"c","title":"mine"}]"#.into());
        let s = agree_with(&mut d, &r, "todo").unwrap();
        assert_eq!((s.joined, s.sent, s.version), (true, true, 3));
        // The Remote's order; this device's new item after the one it follows here; a changed here only, so it is this device's.
        let joined = r#"[{"id":"a","title":"here, changed"},{"id":"c","title":"mine"},{"id":"b","title":"there"}]"#;
        assert_eq!((d.values["todo"].as_str(), r.kept.borrow()["todo"].0.as_str()), (joined, joined));
        assert!(!waiting(&d, "todo"));
        // Another device writes between this one's read and its write (it removed a, b and c, and added e):
        // read again, joined again against what both read; d, new here, is kept.
        d.values.insert("todo".into(), format!(r#"{},{{"id":"d"}}]"#, &joined[..joined.len() - 1]));
        *r.before_put.borrow_mut() = Some(("todo".into(), r#"[{"id":"e"}]"#.into()));
        let s = agree_with(&mut d, &r, "todo").unwrap();
        assert_eq!(s.version, 5);
        let ids: Vec<String> = serde_json::from_str::<Vec<Value>>(&d.values["todo"]).unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["d", "e"]);
        assert_eq!(r.kept.borrow()["todo"].0, d.values["todo"]);
    }

    #[test]
    fn a_todo_list_that_holds_nothing_new_takes_the_remotes_and_sends_nothing() {
        // Both read [a, b]; there b was removed; here it was removed too, and a done as there.
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("todo".into(), r#"[{"id":"a"},{"id":"b"}]"#.into());
        agree_with(&mut d, &r, "todo").unwrap();
        r.elsewhere("todo", r#"[{"id":"a","done":true}]"#);
        d.values.insert("todo".into(), r#"[{"done":true,"id":"a"}]"#.into());
        r.asked.borrow_mut().clear();
        let s = agree_with(&mut d, &r, "todo").unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 2));
        assert_eq!(*r.asked.borrow(), ["GET todo"]);
        assert_eq!(d.values["todo"], r#"[{"id":"a","done":true}]"#);
        assert!(!waiting(&d, "todo"));
    }

    #[test]
    fn a_profile_changed_on_both_is_the_remotes_and_agreed_at_once() {
        let r = Remote::default();
        let mut d = Device::default();
        d.values.insert("profile".into(), r#"{"name":"Ren"}"#.into());
        agree_with(&mut d, &r, "profile").unwrap();
        r.elsewhere("profile", r#"{"name":"Ren T."}"#);
        d.values.insert("profile".into(), r#"{"name":"れん"}"#.into());
        r.asked.borrow_mut().clear();
        let s = agree_with(&mut d, &r, "profile").unwrap();
        assert_eq!((s.taken, s.sent, s.version), (true, false, 2));
        assert_eq!(d.values["profile"], r#"{"name":"Ren T."}"#);
        // Agreed then and there (bug: it was taken but never agreed, so every look took it again, three reads each time).
        assert_eq!(*r.asked.borrow(), ["GET profile"]);
        assert!(!waiting(&d, "profile"));
        assert_eq!(d.agreed["profile"], Agreed { version: 2, value: r#"{"name":"Ren T."}"#.into() });
    }

    #[test]
    fn two_lists_join_as_the_app_joins_them() {
        // As src/draft.test.ts: both read [x, y, w]; there y was done and w removed; here z was added.
        let base = r#"[{"id":"x"},{"id":"y"},{"id":"w"}]"#;
        let there = r#"[{"id":"x"},{"id":"y","done":true}]"#;
        let here = r#"[{"id":"x"},{"id":"y"},{"id":"w"},{"id":"z"}]"#;
        assert_eq!(merge_todo(Some(base), here, there), r#"[{"id":"x"},{"done":true,"id":"y"},{"id":"z"}]"#);
        // Nothing agreed yet: every item from both, this device's where both have one, in the Remote's order.
        assert_eq!(merge_todo(None, r#"[{"id":"a","t":1},{"id":"c"}]"#, r#"[{"id":"b"},{"id":"a"}]"#), r#"[{"id":"b"},{"id":"a","t":1},{"id":"c"}]"#);
        // Removed here while edited there, the edit stands; removed there while unchanged here, it goes.
        assert_eq!(merge_todo(Some(r#"[{"id":"a"},{"id":"b"}]"#), "[]", r#"[{"id":"a","t":2},{"id":"b"}]"#), r#"[{"id":"a","t":2}]"#);
        // Nothing new here: the Remote's text itself.
        assert_eq!(merge_todo(Some(base), base, there), there);
        // One side not a list, or an item that is null: this device's stands.
        for (here, there) in [("{}", "[]"), ("[]", "{}"), ("[]", "nonsense"), ("[null]", "[]"), ("[]", "[null]")] { assert_eq!(merge_todo(None, here, there), here); }
    }
}
