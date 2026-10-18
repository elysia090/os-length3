//! SSH into a repo's Prompt from any OpenSSH client. The listener is l3's
//! (cli/src/ssh.rs, `l3 address ssh serve`, started by turning SSH on); what
//! the app and l3 share of it is here:
//!
//!   keys       the Runtime dotfile `.authorized_keys`, one OpenSSH public
//!              key a line (Home keeps dotfiles on the Remote, so a key added
//!              on one device is taken on every one)
//!   port       one a person on a host: 22000 plus their user number, the
//!              same every time (whatever repos there are) and never another
//!              person's on the same host; each repo is reached at it by its
//!              name as the SSH user (`ssh -p 22000 notes@127.0.0.1`)
//!   scope      who may connect, chosen when it is turned on and kept on this
//!              device alone (`<data>/ssh/scope.json`): this device only
//!              (the default: 127.0.0.1 and ::1, so no other PC finds the
//!              port open at all), or PCs on the same network too (each
//!              private or VPN address of the host besides, one by one; never
//!              0.0.0.0, never a public address), looked at again every few
//!              seconds so an address that goes or changes is let go
//!   record     `<data>/ssh/listening.json` while the listener runs, as a
//!              running Prompt records itself (prompt.rs), so l3 and the app
//!              see it and stop it; the host key beside it, made once
//!   Remote     only that a device listens, and to whom (its scope word),
//!              per device (service/ssh.ts): no address, port or repo name
//!              leaves the device. The listener says so when it starts and
//!              asks every few seconds whether it still should (off from any
//!              page stops it); where it is reached is worked out and shown
//!              on the device alone (`l3 address`, the app's Runtime)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The dotfile the keys are in.
pub const KEYS: &str = ".authorized_keys";

/// The kinds of key taken: what the listener can check a signature of. RSA is not among them (an Ed25519 key is
/// what `ssh-keygen` makes by default, and every OpenSSH of the last ten years can).
pub const KINDS: [&str; 4] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

/// One key from `.authorized_keys`: its kind, its public blob (as the SSH wire has it), and what it says of itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Key {
    pub kind: String,
    pub blob: Vec<u8>,
    pub comment: String,
}

impl Key {
    /// Its fingerprint as `ssh-keygen -l` writes it.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.blob)
    }
}

/// What a key file holds: the keys taken, and each line left out (its number from 1, and why).
#[derive(Debug, Default, PartialEq)]
pub struct Keys {
    pub keys: Vec<Key>,
    pub skipped: Vec<(usize, String)>,
}

/// Read an authorized_keys text: `kind base64 [comment]` a line; blank lines and `#` lines are nothing. A line
/// with options before its key (`from=…`, `command=…`, `restrict`) is left out, not taken without them: the
/// listener does not honour them, and a key meant to be held to them must not reach a shell unheld.
pub fn parse_keys(text: &str) -> Keys {
    let mut out = Keys::default();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let mut words = line.split_whitespace();
        let kind = words.next().unwrap_or_default();
        let why = if kind == "ssh-rsa" || kind.starts_with("rsa-sha2") {
            crate::tr!("an RSA key is not taken; make an Ed25519 one (ssh-keygen -t ed25519)", "RSA の鍵は使えません。Ed25519 の鍵を作ってください（ssh-keygen -t ed25519）")
        } else if !KINDS.contains(&kind) {
            if words.clone().any(|w| KINDS.contains(&w)) || kind.contains('=') || kind.contains(',') {
                crate::tr!("options before a key are not honoured, so the line is left out", "鍵の前のオプションは守れないので、この行は使いません")
            } else {
                crate::tr!("not a public key of a kind taken here ({})", "ここで使える種類の公開鍵ではありません（{}）", KINDS.join(", "))
            }
        } else {
            match words.next().and_then(base64_decode) {
                Some(blob) if blob_kind(&blob) == Some(kind) => {
                    out.keys.push(Key { kind: kind.into(), blob, comment: words.collect::<Vec<_>>().join(" ") });
                    continue;
                }
                _ => crate::tr!("its key is not a {} key", "鍵が {} の鍵になっていません", kind),
            }
        };
        out.skipped.push((i + 1, why));
    }
    out
}

/// The keys in Home's `.authorized_keys` (as Home has it now; taking in the Remote's is the caller's).
pub fn keys() -> Keys {
    crate::home::dotfiles().into_iter().find(|(n, _)| n == KEYS).map(|(_, t)| parse_keys(&t)).unwrap_or_default()
}

/// The kind a key blob names first (a string: a 4-byte length, then its bytes).
fn blob_kind(blob: &[u8]) -> Option<&str> {
    let n = u32::from_be_bytes(blob.get(..4)?.try_into().ok()?) as usize;
    std::str::from_utf8(blob.get(4..4 + n)?).ok()
}

/// A key's fingerprint as OpenSSH writes it: SHA256: and the digest in base64 without padding.
pub fn fingerprint(blob: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("SHA256:{}", base64_encode(&Sha256::digest(blob)).trim_end_matches('='))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            s.push(if k <= c.len() { B64[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

/// Standard base64, padded or not; None when it is not that.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for b in s.bytes() {
        acc = acc << 6 | B64.iter().position(|&x| x == b)? as u32;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); }
    }
    // What is left over is padding's zero bits; a lone character is not base64.
    (bits < 6 && acc & ((1 << bits) - 1) == 0).then_some(out)
}

// ---- where it listens ----

/// The first port: a person's is this plus their user number (mod 10000), 22000–31999.
pub const BASE_PORT: u16 = 22000;

/// The port of the person with user number `uid` on a host.
pub fn port_for(uid: u32) -> u16 {
    BASE_PORT + (uid % 10_000) as u16
}

/// This person's port: $LENGTH3_SSH_PORT when it names one above 1023 (another is in use, or a test), else theirs.
pub fn port() -> u16 {
    std::env::var("LENGTH3_SSH_PORT").ok().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 1023)
        .unwrap_or_else(|| port_for(unsafe { libc::getuid() }))
}

/// Who may connect: from this device only (the default), or from PCs on the same network too. Chosen when SSH is
/// turned on and kept on this device alone; the Remote hears only this word, never an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// 127.0.0.1 and ::1 only: another PC finds the port closed, with no handshake and no banner.
    #[default]
    Device,
    /// Each private or VPN address of the host besides, one by one: never 0.0.0.0, never a public address.
    Network,
}

impl Scope {
    /// The word for it: in `l3 address ssh on device|network`, the record and what the Remote hears.
    pub fn word(self) -> &'static str {
        match self { Scope::Device => "device", Scope::Network => "network" }
    }

    pub fn from_word(w: &str) -> Option<Scope> {
        match w { "device" => Some(Scope::Device), "network" => Some(Scope::Network), _ => None }
    }

    /// Who may connect, said plainly.
    pub fn said(self) -> String {
        match self {
            Scope::Device => crate::tr!("from this device only", "この端末からだけ"),
            Scope::Network => crate::tr!("from PCs on the same network too", "同じネットワークの PC からも"),
        }
    }
}

fn scope_file(data: &Path) -> PathBuf {
    dir(data).join("scope.json")
}

/// The scope chosen on this device last, or this device only when none was.
pub fn scope(data: &Path) -> Scope {
    std::fs::read(scope_file(data)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["scope"].as_str().and_then(Scope::from_word)).unwrap_or_default()
}

/// Keep the scope chosen, on this device (never sent).
pub fn set_scope(data: &Path, s: Scope) -> std::io::Result<()> {
    crate::boundary::private_dir(&dir(data))?;
    let path = scope_file(data);
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&temp, serde_json::json!({"scope": s.word()}).to_string())?;
    std::fs::rename(&temp, path)
}

/// Whether an IPv4 address is on a private network: a LAN (10/8, 172.16/12, 192.168/16), a VPN's shared space
/// (100.64/10, Tailscale's) or link-local (169.254/16).
fn private_v4(v: Ipv4Addr) -> bool {
    v.is_private() || v.is_link_local() || (v.octets()[0] == 100 && v.octets()[1] & 0xc0 == 64)
}

/// Whether a connection that came in on this address of the host is taken: loopback or a private network. What
/// the listener binds is that already; this is said again of each connection, in case.
pub fn reachable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_loopback() || private_v4(v),
        // An IPv4 connection to a socket that takes both comes as ::ffff:a.b.c.d.
        IpAddr::V6(v) => v.to_ipv4_mapped().is_some_and(|m| reachable(IpAddr::V4(m))) || v.is_loopback(),
    }
}

/// Where the listener listens, for `scope`, given the host's interface addresses: 127.0.0.1 and ::1 always; with
/// Network, each private or VPN IPv4 address of the host besides, the LAN's before a VPN's and link-local. Never the
/// unspecified address (every interface), never a public one, and no IPv6 but loopback.
pub fn listen_on(scope: Scope, interfaces: &[IpAddr]) -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    if scope == Scope::Network {
        let mut lan: Vec<Ipv4Addr> = interfaces.iter().filter_map(|a| match a { IpAddr::V4(v) => Some(*v), _ => None })
            .filter(|v| private_v4(*v) && !v.is_loopback() && !v.is_unspecified() && !v.is_broadcast()).collect();
        lan.sort_by_key(|a| (a.is_link_local(), a.octets()[0] == 100, *a));
        lan.dedup();
        out.extend(lan.into_iter().map(IpAddr::V4));
    }
    out.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    out.push(IpAddr::V6(Ipv6Addr::LOCALHOST));
    out
}

/// This host's interface addresses, IPv4 and IPv6, as the kernel has them now.
pub fn interfaces() -> Vec<IpAddr> {
    let mut out = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 { return out; }
    let mut at = list;
    while !at.is_null() {
        let i = unsafe { &*at };
        if !i.ifa_addr.is_null() {
            match unsafe { (*i.ifa_addr).sa_family } as i32 {
                libc::AF_INET => {
                    let sin = unsafe { &*(i.ifa_addr as *const libc::sockaddr_in) };
                    out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))));
                }
                libc::AF_INET6 => {
                    let sin6 = unsafe { &*(i.ifa_addr as *const libc::sockaddr_in6) };
                    out.push(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)));
                }
                _ => {}
            }
        }
        at = i.ifa_next;
    }
    unsafe { libc::freeifaddrs(list) };
    out
}

/// The address a destination names, of those listened on: the one the host's traffic leaves by when it is one
/// of them, else the first private one, else 127.0.0.1.
pub fn host(bound: &[IpAddr]) -> Ipv4Addr {
    let v4: Vec<Ipv4Addr> = bound.iter().filter_map(|a| match a { IpAddr::V4(v) if !v.is_loopback() => Some(*v), _ => None }).collect();
    if v4.is_empty() { return Ipv4Addr::LOCALHOST; }
    // Which way out the host would send to the world (a UDP socket's connect sends nothing).
    let out = std::net::UdpSocket::bind("0.0.0.0:0").and_then(|s| { s.connect("192.0.2.1:9")?; s.local_addr() }).ok()
        .and_then(|a| match a.ip() { IpAddr::V4(v) => Some(v), _ => None });
    out.filter(|o| v4.contains(o)).unwrap_or(v4[0])
}

/// Where each repo is reached, one a line, as OpenSSH takes it: `ssh -p PORT REPO@HOST`.
pub fn destinations(port: u16, repos: &[String], host: Ipv4Addr) -> Vec<String> {
    repos.iter().map(|r| format!("ssh -p {port} {r}@{host}")).collect()
}

/// The repos here, by name: the SSH users there are.
pub fn repo_names() -> Vec<String> {
    crate::repos::Repos::open().and_then(|r| r.list()).map(|l| l.into_iter().map(|s| s.name).collect()).unwrap_or_default()
}

// ---- failed tries ----

/// How many keys refused an address may offer in a while before it is refused outright for that while.
pub const TRIES: usize = 20;
pub const TRIES_WHILE: Duration = Duration::from_secs(60);

/// Refused tries by address: an address that was refused too often lately is not heard until they age out.
#[derive(Default)]
pub struct Tries(HashMap<IpAddr, Vec<Instant>>);

impl Tries {
    /// Whether `ip` is held off now.
    pub fn held(&mut self, ip: IpAddr, now: Instant) -> bool {
        let Some(v) = self.0.get_mut(&ip) else { return false };
        v.retain(|t| now.duration_since(*t) < TRIES_WHILE);
        if v.is_empty() { self.0.remove(&ip); return false; }
        v.len() >= TRIES
    }
    pub fn failed(&mut self, ip: IpAddr, now: Instant) {
        let v = self.0.entry(ip).or_default();
        v.push(now);
        // Kept no longer than it counts.
        if v.len() > TRIES { v.remove(0); }
    }
}

// ---- the listener's record ----

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
    pub fingerprint: String,
}

impl Listening {
    /// Where each repo here is reached, worked out on this device as it is asked.
    pub fn destinations(&self) -> Vec<String> {
        destinations(self.port, &repo_names(), host(&self.bound))
    }
}

/// This device's SSH as l3 address and the app's card show it, worked out here and never sent: whether it listens,
/// who may connect (the scope chosen, when it is off), where each repo is reached, the host key's fingerprint, and
/// how many keys `.authorized_keys` lets in.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Here {
    pub on: bool,
    pub scope: Scope,
    pub port: Option<u16>,
    pub bound: Vec<String>,
    pub destinations: Vec<String>,
    pub fingerprint: Option<String>,
    pub keys: usize,
    pub started: Option<u64>,
}

pub fn here(data: &Path) -> Here {
    let keys = keys().keys.len();
    match listening(data) {
        Some(l) => Here { on: true, scope: l.scope, port: Some(l.port), bound: l.bound.iter().map(|a| a.to_string()).collect(),
            destinations: l.destinations(), fingerprint: Some(l.fingerprint), keys, started: Some(l.started) },
        None => Here { on: false, scope: scope(data), port: None, bound: Vec::new(), destinations: Vec::new(), fingerprint: None, keys, started: None },
    }
}

/// Where SSH keeps its things on this device.
pub fn dir(data: &Path) -> PathBuf {
    data.join("ssh")
}

/// The host key, made once per device (OpenSSH's private key format, owner-only).
pub fn host_key(data: &Path) -> PathBuf {
    dir(data).join("host_ed25519")
}

fn record_file(data: &Path) -> PathBuf {
    dir(data).join("listening.json")
}

/// The record while it is kept; it goes when this is dropped (or the process is gone, at the next read).
pub struct Recorded(PathBuf, Listening);

impl Recorded {
    /// What it listens on now (the scope chosen, or the host's addresses, changed).
    pub fn set_bound(&mut self, scope: Scope, bound: Vec<IpAddr>) -> std::io::Result<()> {
        self.1.scope = scope;
        self.1.bound = bound;
        write_record(&self.0, &self.1)
    }
}

impl Drop for Recorded {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Written beside and renamed in, so a reader never sees half of it.
fn write_record(path: &Path, l: &Listening) -> std::io::Result<()> {
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec(l).map_err(std::io::Error::other)?)?;
    std::fs::rename(&temp, path)
}

/// Record that this process listens.
pub fn record(data: &Path, port: u16, scope: Scope, bound: Vec<IpAddr>, fingerprint: String) -> std::io::Result<Recorded> {
    crate::boundary::private_dir(&dir(data))?;
    let pid = std::process::id();
    let start_ticks = crate::prompt::start_ticks(pid).ok_or_else(|| std::io::Error::other(format!("/proc/{pid}/stat")))?;
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let l = Listening { pid, start_ticks, port, started, scope, bound, fingerprint };
    let path = record_file(data);
    write_record(&path, &l)?;
    Ok(Recorded(path, l))
}

/// The listener running here, if one is (a record whose process is gone is let go).
pub fn listening(data: &Path) -> Option<Listening> {
    let path = record_file(data);
    let l: Listening = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    if crate::prompt::start_ticks(l.pid) == Some(l.start_ticks) && !crate::prompt::zombie(l.pid) { return Some(l); }
    let _ = std::fs::remove_file(&path);
    None
}

/// Have the listener here take the scope kept now (set_scope) at once rather than at its next beat: it binds what
/// that scope asks, lets go of the rest and closes the connections that came in on what it let go. The record as it
/// is then, or None when it did not within a few seconds (or none runs).
pub fn rescope(data: &Path, to: Scope) -> Option<Listening> {
    let l = listening(data)?;
    if l.scope == to { return Some(l); }
    unsafe { libc::kill(l.pid as libc::pid_t, libc::SIGUSR1) };
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

/// Stop the listener here: asked to end (it closes every session and says so to the Remote), then killed if it
/// has not within a few seconds. What was running, if anything was.
pub fn stop(data: &Path) -> Option<Listening> {
    let l = listening(data)?;
    unsafe { libc::kill(l.pid as libc::pid_t, libc::SIGTERM) };
    let started = Instant::now();
    while listening(data).is_some() {
        if started.elapsed() > Duration::from_secs(5) {
            if crate::prompt::start_ticks(l.pid) == Some(l.start_ticks) { unsafe { libc::kill(l.pid as libc::pid_t, libc::SIGKILL) }; }
            let _ = std::fs::remove_file(record_file(data));
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(l)
}

// ---- the Remote (service/ssh.ts) ----
//
// What it hears is that this device listens, and the scope word: no address,
// no port, no repo name. Pages of the account show "<device> listens for SSH"
// with its off switch, and nothing of where.

use crate::remote::{Client, Failure};

/// Tell the Remote this device listens, to whom (the scope's word, nothing more).
pub fn announce(scope: Scope) -> crate::Result<()> {
    Client::open()?.json("PUT", "/v1/ssh/this", Some(serde_json::json!({"scope": scope.word()}))).map(|_| ())
}

/// Tell the Remote this device stopped.
pub fn withdraw() -> crate::Result<()> {
    Client::open()?.json("DELETE", "/v1/ssh/this", None).map(|_| ())
}

/// What the Remote said when the listener asked whether it still should.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Heard {
    /// Still on.
    On,
    /// Turned off elsewhere (a page's switch, another l3).
    Off,
    /// This device is signed out (here, or from another device).
    SignedOut,
    /// No answer, or not one to go by.
    Unreachable,
}

/// Ask the Remote whether this device's SSH is still on (and say to whom it listens now).
pub fn beat(scope: Scope) -> Heard {
    let Some(_) = crate::remote::connection() else { return Heard::SignedOut };
    let asked = Client::open().and_then(|c| c.json("POST", "/v1/ssh/this/beat", Some(serde_json::json!({"scope": scope.word()}))));
    match asked {
        Ok(v) if v["on"] == serde_json::json!(true) => Heard::On,
        Ok(v) if v["on"] == serde_json::json!(false) => Heard::Off,
        Ok(_) => Heard::Unreachable,
        Err(_) => heard_failure(crate::remote::last_failure().map(|(f, _)| f)),
    }
}

fn heard_failure(f: Option<Failure>) -> Heard {
    match f {
        Some(Failure::NotConnected | Failure::Unknown) => Heard::SignedOut,
        _ => Heard::Unreachable,
    }
}

/// Whether the listener goes on after hearing `h`. Out of reach it goes on: SSH on a LAN needs no Internet, and
/// an off said meanwhile is heard the moment the Remote answers again.
pub fn goes_on(h: Heard) -> bool {
    matches!(h, Heard::On | Heard::Unreachable)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real Ed25519 public key (from ssh-keygen; its private half was never kept).
    const ED: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJyDkovadQYieQGc+7m7KbrvkEYluozpLzNrNbQJeW2a ren@laptop";

    #[test]
    fn a_key_file_takes_each_key_and_says_why_it_left_a_line_out() {
        let text = format!("# my keys\n\n{ED}\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ ren@old\ncommand=\"ls\" {ED}\nssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ wrong-kind\nssh-ed25519 !!!\nhello\n  {ED}  \n");
        let k = parse_keys(&text);
        assert_eq!(k.keys.len(), 2, "{k:?}");
        assert_eq!(k.keys[0].kind, "ssh-ed25519");
        assert_eq!(k.keys[0].comment, "ren@laptop");
        assert_eq!(k.keys[0].blob.len(), 51);
        assert_eq!(k.skipped.iter().map(|(n, _)| *n).collect::<Vec<_>>(), [4, 5, 6, 7, 8]);
        assert!(k.skipped[0].1.contains("RSA") || k.skipped[0].1.contains("RSA の"), "{:?}", k.skipped);
        assert!(k.skipped[1].1.contains("option") || k.skipped[1].1.contains("オプション"), "{:?}", k.skipped);
        // The same fingerprint ssh-keygen -lf gives for it.
        assert_eq!(k.keys[0].fingerprint(), "SHA256:2f0IlarsFE7hyjXbCb3n5/3hTBhGOa+knVYOPY6h2YA");
        assert_eq!(parse_keys(""), Keys::default());
    }

    #[test]
    fn base64_is_read_and_written_as_openssh_does() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let e = base64_encode(s.as_bytes());
            assert_eq!(base64_decode(&e).as_deref(), Some(s.as_bytes()), "{e}");
            assert_eq!(base64_decode(e.trim_end_matches('=')).as_deref(), Some(s.as_bytes()));
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_decode("Zm9=Zg"), None);
        assert_eq!(base64_decode("Z"), None);
    }

    #[test]
    fn each_person_on_a_host_has_one_port_the_same_every_time() {
        assert_eq!(port_for(0), 22000);
        assert_eq!(port_for(1000), 23000);
        assert_eq!(port_for(501), 22501);
        assert_eq!(port_for(10_000), 22000);
        // Two people on one host never meet (below ten thousand users), and none is privileged or out of range.
        let all: std::collections::HashSet<u16> = (0..10_000).map(port_for).collect();
        assert_eq!(all.len(), 10_000);
        assert!(all.iter().all(|p| (22000..32000).contains(p)));
        assert_eq!(destinations(23000, &["notes".into(), "trip".into()], Ipv4Addr::new(192, 168, 1, 5)),
            ["ssh -p 23000 notes@192.168.1.5", "ssh -p 23000 trip@192.168.1.5"]);
    }

    #[test]
    fn a_connection_is_taken_on_loopback_and_private_networks_only() {
        for ok in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "100.64.0.1", "100.127.255.1", "169.254.1.1", "::1", "::ffff:192.168.1.5"] {
            assert!(reachable(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "203.0.113.9", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!reachable(no.parse().unwrap()), "{no}");
        }
    }

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|a| a.parse().unwrap()).collect()
    }

    #[test]
    fn this_device_only_listens_on_loopback_alone_whatever_the_host_has() {
        let have = ips(&["127.0.0.1", "192.168.1.5", "10.0.0.7", "100.101.102.103", "203.0.113.9", "8.8.8.8", "::1", "fe80::1", "2001:db8::5", "fd00::1"]);
        assert_eq!(listen_on(Scope::Device, &have), ips(&["127.0.0.1", "::1"]));
        assert_eq!(listen_on(Scope::Device, &[]), ips(&["127.0.0.1", "::1"]));
    }

    #[test]
    fn the_same_network_listens_on_each_private_address_and_never_a_public_one_or_every_interface() {
        // A laptop on Wi-Fi with Tailscale, a docker bridge, a link-local, and a public address on another interface.
        let have = ips(&["127.0.0.1", "127.0.1.1", "203.0.113.9", "192.168.1.5", "100.101.102.103", "172.17.0.1", "169.254.3.4", "10.0.0.7",
            "0.0.0.0", "255.255.255.255", "100.128.0.1", "172.32.0.1", "8.8.8.8", "::1", "fe80::1", "2001:db8::5", "fd00::1", "::", "::ffff:192.168.1.9"]);
        let on = listen_on(Scope::Network, &have);
        assert_eq!(on, ips(&["10.0.0.7", "172.17.0.1", "192.168.1.5", "100.101.102.103", "169.254.3.4", "127.0.0.1", "::1"]));
        for a in &on { assert!(reachable(*a) && !a.is_unspecified(), "{a}"); }
        for never in ["203.0.113.9", "8.8.8.8", "100.128.0.1", "172.32.0.1", "0.0.0.0", "255.255.255.255", "2001:db8::5", "::", "fe80::1", "fd00::1"] {
            assert!(!on.contains(&never.parse().unwrap()), "{never}");
        }
        // A host with only a public address (a server on the Internet): loopback alone, as this device only.
        assert_eq!(listen_on(Scope::Network, &ips(&["127.0.0.1", "198.51.100.20", "2001:db8::1"])), ips(&["127.0.0.1", "::1"]));
        // The same address twice (two interfaces) is listened on once.
        assert_eq!(listen_on(Scope::Network, &ips(&["192.168.1.5", "192.168.1.5"])), ips(&["192.168.1.5", "127.0.0.1", "::1"]));
        // The address a destination names is one listened on, never a public one, and 127.0.0.1 when only loopback is.
        assert_eq!(host(&ips(&["127.0.0.1", "::1"])), Ipv4Addr::LOCALHOST);
        assert!(on.contains(&IpAddr::V4(host(&on))));
    }

    #[test]
    fn the_scope_is_kept_on_this_device_and_this_device_only_until_one_is_chosen() {
        let data = std::env::temp_dir().join(format!("length3-ssh-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        assert_eq!(scope(&data), Scope::Device);
        set_scope(&data, Scope::Network).unwrap();
        assert_eq!(scope(&data), Scope::Network);
        set_scope(&data, Scope::Device).unwrap();
        assert_eq!(scope(&data), Scope::Device);
        std::fs::write(scope_file(&data), "{\"scope\":\"everyone\"}").unwrap();
        assert_eq!(scope(&data), Scope::Device);
        assert_eq!((Scope::from_word("network"), Scope::from_word("0.0.0.0")), (Some(Scope::Network), None));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn an_address_refused_too_often_is_held_off_for_a_while() {
        let mut t = Tries::default();
        let (a, b) = ("192.168.1.9".parse().unwrap(), "192.168.1.10".parse().unwrap());
        let now = Instant::now();
        for _ in 0..TRIES - 1 { t.failed(a, now); }
        assert!(!t.held(a, now));
        t.failed(a, now);
        assert!(t.held(a, now) && !t.held(b, now));
        assert!(t.held(a, now + TRIES_WHILE - Duration::from_secs(1)));
        assert!(!t.held(a, now + TRIES_WHILE));
    }

    #[test]
    fn the_listener_stops_when_turned_off_or_signed_out_and_not_when_the_remote_is_away() {
        assert!(goes_on(Heard::On));
        assert!(goes_on(Heard::Unreachable));
        assert!(!goes_on(Heard::Off));
        assert!(!goes_on(Heard::SignedOut));
        // A 401 (signed out from another device) and no connection here are both signed out; anything else is out of reach.
        assert_eq!(heard_failure(Some(Failure::Unknown)), Heard::SignedOut);
        assert_eq!(heard_failure(Some(Failure::NotConnected)), Heard::SignedOut);
        assert_eq!(heard_failure(Some(Failure::Unreachable)), Heard::Unreachable);
        assert_eq!(heard_failure(Some(Failure::Status(500))), Heard::Unreachable);
        assert_eq!(heard_failure(None), Heard::Unreachable);
    }

    #[test]
    fn the_listener_is_known_while_its_process_runs_and_stopped_with_it() {
        let data = std::env::temp_dir().join(format!("length3-ssh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        assert_eq!(listening(&data), None);
        let mut kept = record(&data, 22000, Scope::Device, ips(&["127.0.0.1", "::1"]), "SHA256:x".into()).unwrap();
        let l = listening(&data).expect("recorded");
        assert_eq!((l.pid, l.port, l.scope, l.bound.len()), (std::process::id(), 22000, Scope::Device, 2));
        assert!(l.destinations().iter().all(|d| d.starts_with("ssh -p 22000 ") && d.ends_with("@127.0.0.1")), "{:?}", l.destinations());
        kept.set_bound(Scope::Network, ips(&["192.168.1.5", "127.0.0.1", "::1"])).unwrap();
        assert_eq!(listening(&data).map(|l| (l.scope, l.bound.len())), Some((Scope::Network, 3)));
        drop(kept);
        assert_eq!(listening(&data), None);
        // One whose process is gone is let go when read.
        std::fs::write(record_file(&data), r#"{"pid":4194304,"startTicks":1,"port":22000,"started":1,"scope":"device","bound":["127.0.0.1"],"fingerprint":""}"#).unwrap();
        assert_eq!(listening(&data), None);
        assert!(!record_file(&data).exists());
        let _ = std::fs::remove_dir_all(&data);
    }
}
