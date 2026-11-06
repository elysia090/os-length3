//! Home's settings agreed with the Remote (home/agree.rs says how): the Remote's side of the agreement, kept per
//! account.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use super::base::lock;
use super::http::{Client, failed, Failure, Reply};
use super::login::account_id;

/// Whether a setting here waits to be sent (it differs from what was last agreed); no request is made.
pub fn home_waiting(key: &str) -> bool {
    crate::home::SYNCED.contains(&key) && crate::home::waiting(&crate::home::Files, key)
}

/// One of Home's settings taken off this device, when it is what the Remote has (home/agree.rs leave): whether it went.
pub fn leave_home(key: &str) -> Result<bool> {
    if !crate::home::SYNCED.contains(&key) {
        return Err(crate::tr!("{} is this device's own; it is not kept on the Remote", "{} はこの端末のもので、Remote には置きません", key));
    }
    let _held = lock("~home")?;
    crate::home::leave(&mut crate::home::Files, key)
}

/// Agree one of Home's settings (home::SYNCED) with the Remote: what changed
/// here is sent, what changed there is taken in, one device at a time.
pub fn sync_home(key: &str) -> Result<crate::home::HomeSynced> {
    if !crate::home::SYNCED.contains(&key) {
        return Err(crate::tr!("{} is this device's own; it is not kept on the Remote", "{} はこの端末のもので、Remote には置きません", key));
    }
    let client = Client::open()?;
    let who = account_id();
    // Not a repo's name (no repo is called with a ~), so its own lock.
    let _held = lock("~home")?;
    // What this device ran is kept as what it trusts before the Remote's dotfiles come in (home/dotfiles.rs keep_trust).
    if key == "dotfiles" { crate::home::keep_trust()?; }
    crate::home::agree_with(&mut crate::home::Files, &client, key, who.as_deref())
}

impl crate::home::HomeThere for Client {
    fn get(&self, key: &str) -> Result<(Option<String>, i64)> {
        crate::home::got(&self.json("GET", &format!("/v1/home/{key}"), None)?)
    }

    fn put(&self, key: &str, value: &str, version: i64) -> Result<Option<i64>> {
        match self.call("PUT", &format!("/v1/home/{key}"), Some(crate::home::put_body(value, version)))? {
            Reply::Ok(v) => crate::home::put_version(&v).map(Some),
            Reply::Conflict(_) => Ok(None),
            Reply::NotFound(_) => Err(failed(Failure::Status(404), crate::tr!("The Remote does not keep {}", "Remote は {} を持ちません", key))),
        }
    }
}

