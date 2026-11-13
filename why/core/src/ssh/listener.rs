//! The listener's record while it runs (`<data>/ssh/listening.json`, as a Prompt records itself), its host key
//! beside it, and the listener told to look again or to stop.

use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use crate::prompt::running::{signal, Signal};
use super::keys::keys;
use super::reach::{destinations, dir, host, repo_names, Scope, scope, Taken};

/// Stop the listener here: asked to end (it closes every session and says so to the Remote), then killed if it
/// has not within a few seconds. What was running, if anything was.
pub fn stop(data: &Path) -> Option<Listening> {
    let l = listening(data)?;
    signal(l.pid, Signal::Term);
    let started = Instant::now();
    while listening(data).is_some() {
        if started.elapsed() > Duration::from_secs(5) {
            if crate::prompt::running::start_ticks(l.pid) == Some(l.start_ticks) { signal(l.pid, Signal::Kill); }
            let _ = std::fs::remove_file(record_file(data));
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(l)
}

/// Have the listener here take the scope kept now (set_scope) at once rather than at its next beat: it binds what
/// that scope asks, lets go of the rest and closes the connections that came in on what it let go. The record as it
/// is then, or None when it did not within a few seconds (or none runs).
pub fn rescope(data: &Path, to: Scope) -> Option<Listening> {
    let l = listening(data)?;
    if l.scope == to { return Some(l); }
    signal(l.pid, Signal::Usr1);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        match listening(data) {
            Some(n) if n.scope == to => return Some(n),
            Some(_) => std::thread::sleep(Duration::from_millis(20)),
            None => return None,
        }
    }
    None
}

/// The listener running here, if one is (a record whose process is gone is let go).
pub fn listening(data: &Path) -> Option<Listening> {
    let path = record_file(data);
    let l: Listening = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    if crate::prompt::running::start_ticks(l.pid) == Some(l.start_ticks) && !crate::prompt::running::zombie(l.pid) { return Some(l); }
    let _ = std::fs::remove_file(&path);
    None
}

/// Record that this process listens.
pub fn record(data: &Path, port: u16, scope: Scope, bound: Vec<IpAddr>, interfaces: Vec<Taken>, fingerprint: String) -> std::io::Result<Recorded> {
    crate::fs::write::private_dir(&dir(data))?;
    let pid = std::process::id();
    let start_ticks = crate::prompt::running::start_ticks(pid).ok_or_else(|| std::io::Error::other(format!("/proc/{pid}/stat")))?;
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let l = Listening { pid, start_ticks, port, started, scope, bound, interfaces, fingerprint };
    let path = record_file(data);
    write_record(&path, &l)?;
    Ok(Recorded(path, l))
}

/// Replaced whole (fs/write.rs), so a reader never sees half of it.
fn write_record(path: &Path, l: &Listening) -> std::io::Result<()> {
    crate::fs::write::replace(path, &serde_json::to_vec(l).map_err(std::io::Error::other)?, crate::fs::write::How::RECORD)
}

/// The record while it is kept; it goes when this is dropped (or the process is gone, at the next read).
pub struct Recorded(PathBuf, Listening);

impl Recorded {
    /// What it listens on now (the scope chosen, or the host's addresses, changed).
    pub fn set_bound(&mut self, scope: Scope, bound: Vec<IpAddr>, interfaces: Vec<Taken>) -> std::io::Result<()> {
        self.1.scope = scope;
        self.1.bound = bound;
        self.1.interfaces = interfaces;
        write_record(&self.0, &self.1)
    }
}

impl Drop for Recorded {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) fn record_file(data: &Path) -> PathBuf {
    dir(data).join("listening.json")
}

/// The host key, made once per device (OpenSSH's private key format, owner-only).
pub fn host_key(data: &Path) -> PathBuf {
    dir(data).join("host_ed25519")
}

pub fn here(data: &Path) -> Here {
    let keys = keys().keys.len();
    match listening(data) {
        Some(l) => Here { on: true, scope: l.scope, port: Some(l.port), bound: l.bound.iter().map(|a| a.to_string()).collect(),
            interfaces: l.interfaces.clone(),
            destinations: l.destinations(), fingerprint: Some(l.fingerprint), keys, started: Some(l.started) },
        None => Here { on: false, scope: scope(data), port: None, bound: Vec::new(), interfaces: Vec::new(), destinations: Vec::new(), fingerprint: None, keys, started: None },
    }
}

/// This device's SSH as why address and the app's card show it, worked out here and never sent: whether it listens,
/// who may connect (the scope chosen, when it is off), where each repo is reached, the host key's fingerprint, and
/// how many keys `.authorized_keys` lets in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Here {
    pub on: bool,
    pub scope: Scope,
    pub port: Option<u16>,
    pub bound: Vec<String>,
    /// The addresses listened on besides loopback, each with its interface (`wlan0`, `tailscale0`).
    pub interfaces: Vec<Taken>,
    pub destinations: Vec<String>,
    pub fingerprint: Option<String>,
    pub keys: usize,
    pub started: Option<u64>,
}

/// The listener running here, recorded while it runs: its process, its port, who may connect and the addresses it
/// listens on for that, its host key's fingerprint. Kept on this device (owner-only), never sent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Listening {
    pub pid: u32,
    #[serde(rename = "startTicks")]
    pub start_ticks: u64,
    pub port: u16,
    /// When it started, in ms since the epoch.
    pub started: u64,
    #[serde(default)]
    pub scope: Scope,
    /// The addresses it listens on now (listen_on: loopback, and with Network the private ones).
    #[serde(default)]
    pub bound: Vec<IpAddr>,
    /// Those besides loopback with the interface each is on (with Network: what `why address` and the card name).
    #[serde(default)]
    pub interfaces: Vec<Taken>,
    pub fingerprint: String,
}

impl Listening {
    /// Where each repo here is reached, worked out on this device as it is asked.
    pub fn destinations(&self) -> Vec<String> {
        destinations(self.port, &repo_names(), host(&self.bound))
    }
}

