//! Home's settings agreed with the Remote (root3/remote/serve/app.ts `/v1/home/:key`): each read and written on a version, two
//! changes to one joined, and what this device took kept apart from what is still to send.

use crate::Result;
use serde::Serialize;
use super::state::{get, remove, set};
use super::todo::join_todo;

/// Home's files here, and what was last agreed for each: the `sync`
/// setting's `home`, beside the other records of what was agreed (root3/app/remote/settings.ts reads it).
pub struct Files;

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

/// Whether a setting here differs from what was last agreed: it waits to be sent.
pub fn waiting(here: &impl HomeHere, key: &str) -> bool {
    match (here.value(key), here.agreed(key)) {
        (Ok(Some(v)), Ok(b)) => b.is_none_or(|b| b.value != v),
        _ => false,
    }
}

/// The version a setting is at once the Remote took it (`{version}`).
pub fn put_version(v: &serde_json::Value) -> Result<i64> {
    v["version"].as_i64().ok_or_else(|| crate::tr!("The Remote's answer is not a setting", "Remote の答えが設定の形ではありません"))
}

/// What is sent to change a setting (`PUT /v1/home/:key`).
pub fn put_body(value: &str, version: i64) -> serde_json::Value {
    serde_json::json!({"value": value, "version": version})
}

/// What the Remote answers for a setting (`GET /v1/home/:key`): `{value, version}`.
pub fn got(v: &serde_json::Value) -> Result<(Option<String>, i64)> {
    let version = v["version"].as_i64().ok_or_else(|| crate::tr!("The Remote's answer is not a setting", "Remote の答えが設定の形ではありません"))?;
    Ok((v["value"].as_str().map(String::from), version))
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

/// The Remote's side of a setting.
pub trait HomeThere {
    /// Its value there (None: never set) and its version (0 then).
    fn get(&self, key: &str) -> Result<(Option<String>, i64)>;
    /// Send `value` as changed from `version`: the version it is now, or None when another came first.
    fn put(&self, key: &str, value: &str, version: i64) -> Result<Option<i64>>;
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

/// What was last agreed with the Remote for a setting: its version there, and the value then.
#[derive(Clone, Debug, PartialEq)]
pub struct Agreed {
    pub version: i64,
    pub value: String,
    /// The account it was agreed with (its id); none from before accounts were noted.
    pub who: Option<String>,
}

/// Home's settings that are the person's, kept on the Remote (root3/app/remote/settings.ts `HOME_KEYS`). The band, the
/// language and the network grant are this device's.
pub const SYNCED: [&str; 3] = ["profile", "todo", "dotfiles"];

