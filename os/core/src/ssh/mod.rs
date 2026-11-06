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
//!              port open at all), or PCs on the same network too (each LAN
//!              address of the host besides, and a VPN interface's 100.64/10
//!              one, one by one; never 0.0.0.0, a public address, a carrier's
//!              shared one, a bridge's or a container's, nor IPv6 but ::1),
//!              looked at again every few seconds so an address that goes or
//!              changes is let go; a connection is taken only from the
//!              network of the address it came in on (admit), or from the
//!              device itself
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

/// The keys in Home's `.authorized_keys` as this device took it (home.rs dotfiles_in_effect): a key the Remote's
/// copy holds and the person at this device never took is let in nowhere.
pub fn keys() -> Keys {
    crate::home::dotfiles_in_effect().into_iter().find(|(n, _)| n == KEYS).map(|(_, t)| parse_keys(&t)).unwrap_or_default()
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
    /// Each LAN address of the host besides, and a VPN interface's 100.64/10 one, one by one (listen_on): never
    /// 0.0.0.0, a public address, a bridge's or a container's.
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
    crate::fs::write::private_dir(&dir(data))?;
    crate::fs::write::replace(&scope_file(data), serde_json::json!({"scope": s.word()}).to_string().as_bytes(), crate::fs::write::How::PRIVATE)
}

/// One address of one interface of this host, as `getifaddrs` has it: the interface's name, the address and its
/// prefix length (from the netmask; 32 for a point-to-point address such as Tailscale's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Iface {
    pub name: String,
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Iface {
    pub fn new(name: &str, addr: IpAddr, prefix: u8) -> Iface {
        Iface { name: name.into(), addr, prefix }
    }
}

/// An address listened on besides loopback, with the interface it is on (what `l3 address` and the card name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Taken {
    pub addr: IpAddr,
    pub interface: String,
}

/// Bridges and container or VM interfaces: never listened on, whatever their address. What is behind them is
/// containers and VMs on this host (code that may not be the person's, and never "the same network" they mean),
/// and their addresses are ones a tool gave this host, not a network it joined. Names as each tool makes them:
///   docker    Docker's default bridge, docker0 (Docker docs, "Bridge network driver")
///   br-       a network made with `docker network create`: br-<its id>
///   virbr     libvirt's NAT network, virbr0 (libvirt wiki, "Networking")
///   veth      the host's end of a container's veth pair (Docker, Podman, LXC, Kubernetes CNIs)
///   ve- vb-   systemd-nspawn's container links (systemd's 80-container-ve.network; --network-bridge)
///   lxcbr     LXC's default bridge, lxcbr0
///   lxdbr     LXD's default bridge, lxdbr0
///   incusbr   Incus (LXD's fork), incusbr0
///   cni       the CNI bridge plugin's default, cni0 (Kubernetes, containerd, Podman 3)
///   flannel   flannel's overlay, flannel.1 (Kubernetes)
///   cali      Calico's interface per pod, cali<hash> (Kubernetes)
///   cilium_   Cilium's host interfaces, cilium_host and cilium_net (Kubernetes)
///   podman    Podman's (netavark's) default bridge, podman0
///   vmnet     VMware's host-only and NAT networks, vmnet1 and vmnet8
///   vboxnet   VirtualBox's host-only networks, vboxnet0
pub const BRIDGES: [&str; 16] = ["docker", "br-", "virbr", "veth", "ve-", "vb-", "lxcbr", "lxdbr", "incusbr", "cni", "flannel", "cali", "cilium_", "podman", "vmnet", "vboxnet"];

/// VPN interfaces, by the names their clients give them: on these alone an address in the shared space 100.64/10
/// is the VPN's. Anywhere else 100.64/10 is a carrier's shared NAT space (RFC 6598), where the carrier's other
/// customers could reach the port, so it is never listened on there.
///   tailscale       Tailscale's tailscale0 (tailscaled's --tun default); Headscale is a Tailscale control
///                   server, so its clients have the same tailscale0
///   wg              WireGuard by wg-quick, named after its config file (wg0 by convention; Mullvad's wg0-mullvad)
///   zt              ZeroTier's zt<8 characters> (ZeroTier docs, "Interface names")
///   nebula          Nebula's tun.dev, nebula1 in its example config
///   wt              NetBird's wt0 (`netbird up --interface-name`'s default; its peers are in 100.64/10)
///   CloudflareWARP  the Cloudflare One (WARP) client's interface on Linux (Cloudflare docs, "WARP architecture"),
///                   whose device IPs are 100.96/12 (Cloudflare docs, "Device IPs")
/// Only root makes an interface, so a name is the host's administrator's word. A generic tun* (OpenVPN, say) is
/// not taken to be one: its private addresses are listened on as a LAN's are, a 100.64/10 one is not.
pub const VPNS: [&str; 6] = ["tailscale", "wg", "zt", "nebula", "wt", "CloudflareWARP"];

/// Whether an interface is a bridge, or a container's or VM's (BRIDGES).
pub fn bridge(name: &str) -> bool {
    BRIDGES.iter().any(|p| name.starts_with(p))
}

/// Whether an interface is a VPN's (VPNS).
pub fn vpn(name: &str) -> bool {
    VPNS.iter().any(|p| name.starts_with(p))
}

/// The shared space 100.64/10 (RFC 6598): carriers' NAT, and the VPNs'.
fn shared_v4(v: Ipv4Addr) -> bool {
    v.octets()[0] == 100 && v.octets()[1] & 0xc0 == 64
}

/// A LAN's address: RFC 1918 (10/8, 172.16/12, 192.168/16) or link-local (169.254/16).
fn lan_v4(v: Ipv4Addr) -> bool {
    v.is_private() || v.is_link_local()
}

/// Whether the same network too listens on this address of this interface: an IPv4 address on a LAN (RFC 1918 or
/// link-local) of any interface but a bridge or a container's, or one in 100.64/10 of a VPN's. Never loopback (it
/// is listened on anyway), never IPv6, never a public address.
pub fn listened(i: &Iface) -> bool {
    let IpAddr::V4(v) = i.addr else { return false };
    if bridge(&i.name) || v.is_loopback() || v.is_unspecified() || v.is_broadcast() { return false; }
    lan_v4(v) || (shared_v4(v) && vpn(&i.name))
}

/// Where the listener listens, for `scope`, given the host's interfaces: 127.0.0.1 and ::1 always; with Network,
/// each address `listened` takes besides, the LAN's before a VPN's and link-local. Never the unspecified address
/// (every interface), never a public one, never a bridge's, and no IPv6 but ::1, deliberately for now: a global IPv6
/// address is reached from the Internet unless a firewall says otherwise, and a LAN's is not told apart from it yet.
pub fn listen_on(scope: Scope, interfaces: &[Iface]) -> Vec<IpAddr> {
    let mut out: Vec<IpAddr> = Vec::new();
    if scope == Scope::Network {
        let mut lan: Vec<Ipv4Addr> = interfaces.iter().filter(|i| listened(i))
            .filter_map(|i| match i.addr { IpAddr::V4(v) => Some(v), _ => None }).collect();
        lan.sort_by_key(|a| (a.is_link_local(), shared_v4(*a), *a));
        lan.dedup();
        out.extend(lan.into_iter().map(IpAddr::V4));
    }
    out.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    out.push(IpAddr::V6(Ipv6Addr::LOCALHOST));
    out
}

/// The addresses listened on besides loopback, each with the interface it is on (the first that has it).
pub fn taken(bound: &[IpAddr], interfaces: &[Iface]) -> Vec<Taken> {
    bound.iter().filter(|a| !a.is_loopback())
        .filter_map(|a| interfaces.iter().find(|i| i.addr == *a && listened(i)).map(|i| Taken { addr: *a, interface: i.name.clone() }))
        .collect()
}

/// Whether `peer` is inside the subnet of `local` with `prefix` bits.
fn on_link(local: Ipv4Addr, prefix: u8, peer: Ipv4Addr) -> bool {
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix.min(32))) };
    u32::from(local) & mask == u32::from(peer) & mask
}

/// Whether a connection from `peer` that came in on `local` is taken, given the host's interfaces now and, for a
/// VPN, the interface the kernel routes `peer` by (`route_dev`: ip route get's answer). Linux takes a packet for any
/// of its addresses on any interface (the weak host model), so a socket on the LAN address alone does not keep out
/// a sender on another segment who routes to that address through this host; this does. Taken:
///   - on loopback (127.0.0.1, ::1), and from any of the host's own addresses: the device itself (its `ssh` to its
///     own LAN address comes from that address, over lo; a sender elsewhere cannot use one, as the kernel drops a
///     packet from outside whose source is one of its own);
///   - from inside the subnet of the address it came in on (an address `listened` takes, of that interface);
///   - on a VPN's interface, also from an address that is not public and that the kernel routes by that same
///     interface: Tailscale's own address is a /32 and its peers are routed by tailscale0 (in its table 52, so the
///     kernel is asked, not /proc/net/route). The handshake's answer went that way too.
///
/// Anything else is closed before a byte is said, the banner included.
pub fn admit(local: IpAddr, peer: IpAddr, interfaces: &[Iface], route_dev: impl Fn(Ipv4Addr, Ipv4Addr) -> Option<String>) -> bool {
    let (local, peer) = (canonical(local), canonical(peer));
    if local.is_loopback() { return true; }
    if peer.is_loopback() || interfaces.iter().any(|i| i.addr == peer) { return true; }
    let (IpAddr::V4(l), IpAddr::V4(p)) = (local, peer) else { return false };
    let Some(on) = interfaces.iter().find(|i| i.addr == local && listened(i)) else { return false };
    if on_link(l, on.prefix, p) { return true; }
    vpn(&on.name) && (lan_v4(p) || shared_v4(p)) && route_dev(p, l).as_deref() == Some(on.name.as_str())
}

/// The interface the kernel routes `to` by, from `from` (one of this host's addresses): `ip route get TO from FROM`,
/// asked over netlink, so policy routing (Tailscale's table 52, wg-quick's fwmark rules) counts. None when there is
/// no route, or the kernel could not be asked.
#[cfg(target_os = "linux")]
pub fn route_dev(to: Ipv4Addr, from: Ipv4Addr) -> Option<String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // nlmsghdr (16) + rtmsg (12) + RTA_DST (8) + RTA_SRC (8).
    let mut req = [0u8; 44];
    req[0..4].copy_from_slice(&44u32.to_ne_bytes());
    req[4..6].copy_from_slice(&libc::RTM_GETROUTE.to_ne_bytes());
    req[6..8].copy_from_slice(&(libc::NLM_F_REQUEST as u16).to_ne_bytes());
    req[8..12].copy_from_slice(&1u32.to_ne_bytes());
    req[16] = libc::AF_INET as u8; // rtm_family
    req[17] = 32; // rtm_dst_len
    req[18] = 32; // rtm_src_len
    for (at, kind, a) in [(28, libc::RTA_DST, to), (36, libc::RTA_SRC, from)] {
        req[at..at + 2].copy_from_slice(&8u16.to_ne_bytes());
        req[at + 2..at + 4].copy_from_slice(&kind.to_ne_bytes());
        req[at + 4..at + 8].copy_from_slice(&a.octets());
    }
    let fd = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC, libc::NETLINK_ROUTE) };
    if fd < 0 { return None; }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let tv = libc::timeval { tv_sec: 1, tv_usec: 0 };
    unsafe { libc::setsockopt(fd.as_raw_fd(), libc::SOL_SOCKET, libc::SO_RCVTIMEO, &tv as *const _ as *const libc::c_void, std::mem::size_of::<libc::timeval>() as u32) };
    let mut kernel: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    kernel.nl_family = libc::AF_NETLINK as u16;
    let sent = unsafe { libc::sendto(fd.as_raw_fd(), req.as_ptr() as *const libc::c_void, req.len(), 0, &kernel as *const _ as *const libc::sockaddr, std::mem::size_of::<libc::sockaddr_nl>() as u32) };
    if sent != req.len() as isize { return None; }
    let mut buf = [0u8; 4096];
    let n = unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
    if n < 16 { return None; }
    oif(&buf[..n as usize]).and_then(if_name)
}

/// Elsewhere (macOS) the kernel is not asked so: a VPN's peer is let in only from inside the subnet it came in on.
#[cfg(not(target_os = "linux"))]
pub fn route_dev(_: Ipv4Addr, _: Ipv4Addr) -> Option<String> { None }

/// The output interface (RTA_OIF) of a netlink answer that is a route (RTM_NEWROUTE); None for an error.
#[cfg(target_os = "linux")]
fn oif(msg: &[u8]) -> Option<u32> {
    let u16_at = |at: usize| msg.get(at..at + 2).map(|b| u16::from_ne_bytes([b[0], b[1]]));
    let len = u32::from_ne_bytes(msg.get(0..4)?.try_into().ok()?) as usize;
    if u16_at(4)? != libc::RTM_NEWROUTE || len > msg.len() { return None; }
    let mut at = 16 + 12;
    while at + 4 <= len {
        let (alen, kind) = (u16_at(at)? as usize, u16_at(at + 2)?);
        if alen < 4 { return None; }
        if kind == libc::RTA_OIF && alen >= 8 { return Some(u32::from_ne_bytes(msg.get(at + 4..at + 8)?.try_into().ok()?)); }
        at += (alen + 3) & !3;
    }
    None
}

#[cfg(target_os = "linux")]
fn if_name(index: u32) -> Option<String> {
    let mut name = [0 as libc::c_char; libc::IF_NAMESIZE];
    if unsafe { libc::if_indextoname(index, name.as_mut_ptr()) }.is_null() { return None; }
    unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }.to_str().ok().map(String::from)
}

/// This host's interface addresses, IPv4 and IPv6, each with its interface's name and its prefix, as the kernel has
/// them now.
pub fn interfaces() -> Vec<Iface> {
    let mut out = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 { return out; }
    let mut at = list;
    while !at.is_null() {
        let i = unsafe { &*at };
        at = i.ifa_next;
        if i.ifa_addr.is_null() || i.ifa_name.is_null() { continue; }
        let name = unsafe { std::ffi::CStr::from_ptr(i.ifa_name) }.to_string_lossy().into_owned();
        let mask = i.ifa_netmask;
        match unsafe { (*i.ifa_addr).sa_family } as i32 {
            libc::AF_INET => {
                let sin = unsafe { &*(i.ifa_addr as *const libc::sockaddr_in) };
                let prefix = if mask.is_null() { 32 } else { unsafe { &*(mask as *const libc::sockaddr_in) }.sin_addr.s_addr.count_ones() as u8 };
                out.push(Iface { name, addr: IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr))), prefix });
            }
            libc::AF_INET6 => {
                let sin6 = unsafe { &*(i.ifa_addr as *const libc::sockaddr_in6) };
                let prefix = if mask.is_null() { 128 } else { unsafe { &*(mask as *const libc::sockaddr_in6) }.sin6_addr.s6_addr.iter().map(|b| b.count_ones() as u8).sum() };
                out.push(Iface { name, addr: IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)), prefix });
            }
            _ => {}
        }
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

/// The repos here, by name: the SSH users there are (no repo is walked).
pub fn repo_names() -> Vec<String> {
    crate::repos::store::Repos::open().and_then(|r| r.names()).unwrap_or_default()
}

// ---- failed tries ----

/// How many keys refused an address may offer in a while before it is refused outright for that while.
pub const TRIES: usize = 20;
pub const TRIES_WHILE: Duration = Duration::from_secs(60);

/// Refused tries by address: an address that was refused too often lately is not heard until they age out.
#[derive(Default)]
pub struct Tries(HashMap<IpAddr, Vec<Instant>>);

/// One address one way: an IPv4 peer that reached a socket taking both comes as ::ffff:a.b.c.d, and is a.b.c.d.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        _ => ip,
    }
}

impl Tries {
    /// Whether `ip` is held off now.
    pub fn held(&mut self, ip: IpAddr, now: Instant) -> bool {
        let ip = canonical(ip);
        let Some(v) = self.0.get_mut(&ip) else { return false };
        v.retain(|t| now.duration_since(*t) < TRIES_WHILE);
        if v.is_empty() { self.0.remove(&ip); return false; }
        v.len() >= TRIES
    }
    pub fn failed(&mut self, ip: IpAddr, now: Instant) {
        let v = self.0.entry(canonical(ip)).or_default();
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
    /// Those besides loopback with the interface each is on (with Network: what `l3 address` and the card name).
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

/// This device's SSH as l3 address and the app's card show it, worked out here and never sent: whether it listens,
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

pub fn here(data: &Path) -> Here {
    let keys = keys().keys.len();
    match listening(data) {
        Some(l) => Here { on: true, scope: l.scope, port: Some(l.port), bound: l.bound.iter().map(|a| a.to_string()).collect(),
            interfaces: l.interfaces.clone(),
            destinations: l.destinations(), fingerprint: Some(l.fingerprint), keys, started: Some(l.started) },
        None => Here { on: false, scope: scope(data), port: None, bound: Vec::new(), interfaces: Vec::new(), destinations: Vec::new(), fingerprint: None, keys, started: None },
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

/// Replaced whole (atomic.rs), so a reader never sees half of it.
fn write_record(path: &Path, l: &Listening) -> std::io::Result<()> {
    crate::fs::write::replace(path, &serde_json::to_vec(l).map_err(std::io::Error::other)?, crate::fs::write::How::RECORD)
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

/// The listener running here, if one is (a record whose process is gone is let go).
pub fn listening(data: &Path) -> Option<Listening> {
    let path = record_file(data);
    let l: Listening = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    if crate::prompt::running::start_ticks(l.pid) == Some(l.start_ticks) && !crate::prompt::running::zombie(l.pid) { return Some(l); }
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
            if crate::prompt::running::start_ticks(l.pid) == Some(l.start_ticks) { unsafe { libc::kill(l.pid as libc::pid_t, libc::SIGKILL) }; }
            let _ = std::fs::remove_file(record_file(data));
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(l)
}

#[cfg(test)]
#[path = "tests/ssh.rs"]
mod tests;
