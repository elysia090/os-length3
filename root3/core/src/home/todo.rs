//! Home's TODO: its items, each a first line (a kind and a title) and a detail, and two lists joined as they were
//! written on two devices.

use crate::text::title::kind_of;
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use super::state::{get, set};

/// Two TODO lists as one, against the one both last agreed (`base`): an item only one side changed or removed is as
/// that side left it, one both changed is this device's, and every item either side added is kept, the Remote's new
/// ones first. Nothing agreed (or not a list): every item from both, this device's where both have it. One side not
/// a list, or an item that is null: this device's stands.
pub fn join_todo(base: &str, here: &str, there: &str) -> String {
    let lists = (serde_json::from_str::<Value>(here), serde_json::from_str::<Value>(there));
    let (Ok(Value::Array(a)), Ok(Value::Array(b))) = lists else { return here.to_string() };
    if a.iter().chain(&b).any(Value::is_null) { return here.to_string(); }
    let was: Vec<Value> = match serde_json::from_str::<Value>(base) { Ok(Value::Array(o)) => o.into_iter().filter(|x| !x.is_null()).collect(), _ => Vec::new() };
    // Each list by id, once: an item is looked up, not searched for, and nothing is copied until the list is written.
    let (was_by, a_by, b_by) = (by_id(&was), by_id(&a), by_id(&b));
    let untouched = |x: &Value| find(&was_by, x).is_some_and(|w| w == x);
    let mut out: Vec<&Value> = b.iter().filter(|x| find(&a_by, x).is_none() && !untouched(x)).collect();
    for x in &a {
        if !untouched(x) { out.push(x); } else if let Some(t) = find(&b_by, x) { out.push(t); }
    }
    serde_json::to_string(&out).unwrap_or_else(|_| here.to_string())
}

/// An item's id, told from another's as the app's lists always have (a JavaScript Map's keys): every item without one
/// shares one, and equal strings, numbers (0 and -0 alike), booleans and nulls are one; an object or a list is
/// no other's, so it has none here.
#[derive(PartialEq, Eq, Hash)]
enum Id<'a> { Absent, Null, Bool(bool), Number(u64), Text(&'a str) }

fn id_of(x: &Value) -> Option<Id<'_>> {
    match x.as_object().and_then(|o| o.get("id")) {
        None => Some(Id::Absent),
        Some(Value::Null) => Some(Id::Null),
        Some(Value::Bool(b)) => Some(Id::Bool(*b)),
        Some(Value::Number(n)) => n.as_f64().map(|f| Id::Number((f + 0.0).to_bits())),
        Some(Value::String(s)) => Some(Id::Text(s)),
        Some(_) => None,
    }
}

/// A list's items by id: the last of each, as a Map built from it holds them.
fn by_id(list: &[Value]) -> HashMap<Id<'_>, &Value> {
    list.iter().filter_map(|x| Some((id_of(x)?, x))).collect()
}

/// The item of `by` with `x`'s id.
fn find<'v>(by: &HashMap<Id<'_>, &'v Value>, x: &Value) -> Option<&'v Value> {
    by.get(&id_of(x)?).copied()
}

/// `item` with its first line written again as `line` reads (root3/app/home/todo.ts `edit`): the same item,
/// its id, whether it is done and when it was made kept. Its detail is the lines after the first
/// and `detail` when either is given; otherwise it stays. None when the first line is empty.
pub fn todo_edited(item: &Todo, line: &str, detail: Option<&str>) -> Option<Todo> {
    let new = todo_from(line, detail.unwrap_or_default(), item.created)?;
    let more = line.split_once('\n').is_some_and(|(_, more)| !more.trim().is_empty());
    let detail = if more || detail.is_some() { new.detail } else { item.detail.clone() };
    Some(Todo { kind: new.kind, title: new.title, detail, ..item.clone() })
}

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
    let id = format!("{}-root3{}", radix36(now), radix36(unique() % 36u64.pow(6)));
    Some(Todo { id, kind, title: title.trim().into(), detail, done: false, repo: None, created: now })
}

/// How long an item's first line and its detail may be, in UTF-16 units as the app counts them (root3/app/home/todo.ts).
pub const TODO_LIMITS: [(&str, usize); 2] = [("title", 200), ("detail", 4000)];

pub fn save_todos(list: &[Todo]) -> Result<()> {
    set("todo", &serde_json::to_string(list).map_err(|e| e.to_string())?)
}

/// A stored list. Items the app cannot read are left out, as the app does;
/// a list that cannot be read at all is refused, not taken for an empty one,
/// which the next change would be written over.
pub fn parse_todos(text: &str) -> Result<Vec<Todo>> {
    let raw: Vec<serde_json::Value> = serde_json::from_str(text)
        .map_err(|e| crate::tr!("Home's TODO could not be read ({}), so nothing is written over it", "Home の TODO を読めませんでした（{}）。上書きはしません", e))?;
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

pub fn todos() -> Result<Vec<Todo>> {
    let Some(text) = get("todo")? else { return Ok(Vec::new()) };
    parse_todos(&text)
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

/// `n` in base 36, as JavaScript's `toString(36)` writes it.
pub(super) fn radix36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
        if n == 0 { break; }
    }
    digits.iter().rev().map(|&d| char::from(d)).collect()
}

/// A number no other call is likely to have: std's random per-process keys, moved on at each call, over the time.
pub(super) fn unique() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    h.finish()
}
