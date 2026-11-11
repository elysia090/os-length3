//! The tests of home/ (mod.rs).

use super::*;
use super::todo::*;
use super::agree::*;

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
    // Taken for empty, the next `root3 todo add` would write the one new item over every item there.
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

// ---- Home on the Remote, against what the Remote answers (root3/shared/home-sync.json) ----

use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use crate::Result;

fn recorded() -> Vec<Value> {
    let v: Value = serde_json::from_str(include_str!("../../../shared/home-sync.json")).unwrap();
    v["exchanges"].as_array().unwrap().clone()
}

/// The Remote's settings as root3/remote/serve/app.ts keeps them: a value and its version each,
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
    fn forget(&mut self, key: &str) -> Result<()> { self.agreed.remove(key); Ok(()) }
}

#[test]
fn the_remote_here_answers_as_the_service_does() {
    let r = Remote::default();
    for (i, x) in recorded().iter().enumerate() {
        let body = x.get("body");
        // What root3 sends is the shape the Remote was recorded taking.
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
    // As root3/app/remote/sync.test.ts: this device sent [a]; another made it [a, b]; this one made it [a, c].
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
fn a_setting_leaves_this_device_only_as_the_remote_has_it() {
    let r = Remote::default();
    let mut d = Device::default();
    d.values.insert("todo".into(), r#"[{"id":"a"}]"#.into());
    agree_with(&mut d, &r, "todo", Some("a")).unwrap();
    // Changed here and not sent: it is not on the Remote, so it stays, and so does what was agreed.
    d.values.insert("todo".into(), r#"[{"id":"a"},{"id":"b"}]"#.into());
    assert!(!leave(&mut d, "todo").unwrap());
    assert!(d.values.contains_key("todo") && d.agreed.contains_key("todo"));
    // Sent, it goes, the record of it with it (the words of the list are in that too).
    agree_with(&mut d, &r, "todo", Some("a")).unwrap();
    assert!(leave(&mut d, "todo").unwrap());
    assert!(!d.values.contains_key("todo") && !d.agreed.contains_key("todo"));
    // Signed in again, the Remote's comes back whole, and nothing of this device's is sent over it.
    let s = agree_with(&mut d, &r, "todo", Some("a")).unwrap();
    assert_eq!((s.taken, s.sent), (true, false));
    assert_eq!(d.values["todo"], r#"[{"id":"a"},{"id":"b"}]"#);
    // Never agreed (written signed out): not on the Remote, it stays. None here has gone already.
    d.values.insert("profile".into(), r#"{"name":"Ren"}"#.into());
    assert!(!leave(&mut d, "profile").unwrap());
    assert!(leave(&mut d, "dotfiles").unwrap());
}

#[test]
fn two_lists_join_as_the_app_joins_them() {
    assert_eq!(join_todo("", r#"[{"id":"a"},{"id":1}]"#, r#"[{"id":"b"},{"id":"a","x":1},{"id":1.0}]"#), r#"[{"id":"b"},{"id":"a"},{"id":1}]"#);
    // One side not a list, or an item that is null: this device's stands.
    for (here, there) in [("{}", "[]"), ("[]", "{}"), ("[]", "nonsense"), ("[null]", "[]"), ("[]", "[null]")] { assert_eq!(join_todo("[]", here, there), here); }
    // Items without an id are one id (absent) as the app's Set holds them; object ids are never the same.
    assert_eq!(join_todo("", r#"[{}]"#, r#"[{"t":1},{"id":{}}]"#), r#"[{"id":{}},{}]"#);
}

#[test]
fn ids_are_told_apart_as_the_apps_lists_tell_them() {
    // 0 and -0 are one id; a number and its text are two; the last of an id is the one a list holds.
    assert_eq!(join_todo("", r#"[{"id":0}]"#, r#"[{"id":-0.0},{"id":"0"}]"#), r#"[{"id":"0"},{"id":0}]"#);
    let base = r#"[{"id":"a","t":1}]"#;
    assert_eq!(join_todo(base, r#"[{"id":"a","t":1}]"#, r#"[{"id":"a","t":2},{"id":"a","t":3}]"#), r#"[{"id":"a","t":3}]"#);
    // An object as an id is no other's, not even an equal one's.
    assert_eq!(join_todo(r#"[{"id":{}}]"#, r#"[{"id":{}}]"#, r#"[{"id":{}}]"#), r#"[{"id":{}},{"id":{}}]"#);
}

#[test]
fn a_long_list_is_joined_item_by_item() {
    let item = |i: usize, t: &str| format!(r#"{{"id":"{i}","t":"{t}"}}"#);
    let list = |n: usize, f: &dyn Fn(usize) -> String| format!("[{}]", (0..n).map(f).collect::<Vec<_>>().join(","));
    let base = list(5000, &|i| item(i, "x"));
    // Here every tenth changed; there every seventh removed and one added.
    let here = list(5000, &|i| item(i, if i % 10 == 0 { "here" } else { "x" }));
    let there = format!("[{},{}]", (0..5000).filter(|i| i % 7 != 0).map(|i| item(i, "x")).collect::<Vec<_>>().join(","), item(9999, "new"));
    let joined: Vec<serde_json::Value> = serde_json::from_str(&join_todo(&base, &here, &there)).unwrap();
    let ids: Vec<&str> = joined.iter().map(|x| x["id"].as_str().unwrap()).collect();
    // The Remote's new one first; then each kept: changed here, or untouched here and kept there.
    let kept: Vec<String> = (0..5000).filter(|i| i % 10 == 0 || i % 7 != 0).map(|i| i.to_string()).collect();
    assert_eq!(ids[0], "9999");
    assert_eq!(ids[1..], kept.iter().map(String::as_str).collect::<Vec<_>>()[..]);
    assert!(joined.iter().filter(|x| x["t"] == "here").count() == 500);
}
