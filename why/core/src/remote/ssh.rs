//! Whether this device listens for SSH, as the Remote is told it (why/remote/repos/ssh.ts): that it listens, and the scope's
//! word, never an address, a port or a repo name. Pages of the account show "<device> listens for SSH" with its
//! off switch, and nothing of where. The listener itself is ssh/'s (and why's: why/cli/src/cmd/ssh.rs).

use super::{Client, Failure};
use crate::ssh::Scope;

/// Whether the listener goes on after hearing `h`. Out of reach it goes on: SSH on a LAN needs no Internet, and
/// an off said meanwhile is heard the moment the Remote answers again.
pub fn goes_on(h: Heard) -> bool {
    matches!(h, Heard::On | Heard::Unreachable)
}

fn heard_failure(f: Option<Failure>) -> Heard {
    match f {
        Some(Failure::NotConnected | Failure::Unknown) => Heard::SignedOut,
        _ => Heard::Unreachable,
    }
}

/// Ask the Remote whether this device's SSH is still on (and say to whom it listens now).
pub fn beat(scope: Scope) -> Heard {
    let Some(_) = crate::remote::connection() else { return Heard::SignedOut };
    let tag = TAG.lock().map(|t| t.clone()).unwrap_or_default();
    let said = if tag.is_empty() { serde_json::json!({"scope": scope.word()}) } else { serde_json::json!({"scope": scope.word(), "tag": tag}) };
    let asked = Client::open().and_then(|c| c.json("POST", "/v1/ssh/this/beat", Some(said)));
    // Whatever it said, the next beat carries its tag, or none (a Remote without the mark gives none).
    if let Ok(mut t) = TAG.lock() { *t = asked.as_ref().ok().and_then(|v| v["tag"].as_str()).unwrap_or_default().to_string(); }
    match asked {
        Ok(v) if v["on"] == serde_json::json!(true) => Heard::On,
        Ok(v) if v["on"] == serde_json::json!(false) => Heard::Off,
        Ok(_) => Heard::Unreachable,
        Err(_) => heard_failure(crate::remote::last_failure().map(|(f, _)| f)),
    }
}

/// The tag the Remote's last answer to a beat carried (why/remote/serve/mark.ts), sent with the next: while nothing was
/// written on the Remote since, it answers on without asking its database, which sleeps. Before, each beat was a
/// session looked up and a row written: a device listening kept the database awake around the clock.
static TAG: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// What the Remote said when the listener asked whether it still should.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Heard {
    /// Still on.
    On,
    /// Turned off elsewhere (a page's switch, another why).
    Off,
    /// This device is signed out (here, or from another device).
    SignedOut,
    /// No answer, or not one to go by.
    Unreachable,
}

/// Tell the Remote this device stopped.
pub fn withdraw() -> crate::Result<()> {
    Client::open()?.json("DELETE", "/v1/ssh/this", None).map(|_| ())
}

/// Tell the Remote this device listens, to whom (the scope's word, nothing more).
pub fn announce(scope: Scope) -> crate::Result<()> {
    Client::open()?.json("PUT", "/v1/ssh/this", Some(serde_json::json!({"scope": scope.word()}))).map(|_| ())
}

#[cfg(test)]
#[path = "ssh.test.rs"]
mod tests;
