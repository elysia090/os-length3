//! Where it listens and whom it lets in: the port (22000 plus the person's user number), the scope (this device, or
//! PCs on the same network: each LAN and VPN address, never a bridge's or a container's), which network a connection
//! came in on, and peers that failed too often held back.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// One address one way: an IPv4 peer that reached a socket taking both comes as ::ffff:a.b.c.d, and is a.b.c.d.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        _ => ip,
    }
}

/// Refused tries by address: an address that was refused too often lately is not heard until they age out.
#[derive(Default)]
pub struct Tries(HashMap<IpAddr, Vec<Instant>>);

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

pub const TRIES_WHILE: Duration = Duration::from_secs(60);

/// How many keys refused an address may offer in a while before it is refused outright for that while.
pub const TRIES: usize = 20;

/// The repos here, by name: the SSH users there are (no repo is walked).
pub fn repo_names() -> Vec<String> {
    crate::repos::store::Repos::open().and_then(|r| r.names()).unwrap_or_default()
}

/// Where each repo is reached, one a line, as OpenSSH takes it: `ssh -p PORT REPO@HOST`.
pub fn destinations(port: u16, repos: &[String], host: Ipv4Addr) -> Vec<String> {
    repos.iter().map(|r| format!("ssh -p {port} {r}@{host}")).collect()
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

/// This host's interface addresses, IPv4 and IPv6, each with its interface's name and its prefix, as the kernel has
/// them now.
pub fn interfaces() -> Vec<Iface> {
    let Ok(all) = nix::ifaddrs::getifaddrs() else { return Vec::new() };
    let ones = |bytes: &[u8]| bytes.iter().map(|b| b.count_ones() as u8).sum::<u8>();
    all.filter_map(|i| {
        let (addr, mask) = (i.address?, i.netmask);
        let (addr, prefix) = if let Some(v4) = addr.as_sockaddr_in() {
            (IpAddr::V4(v4.ip()), mask.as_ref().and_then(|m| m.as_sockaddr_in()).map_or(32, |m| ones(&m.ip().octets())))
        } else {
            let v6 = addr.as_sockaddr_in6()?;
            (IpAddr::V6(v6.ip()), mask.as_ref().and_then(|m| m.as_sockaddr_in6()).map_or(128, |m| ones(&m.ip().octets())))
        };
        Some(Iface { name: i.interface_name, addr, prefix })
    }).collect()
}

/// The output interface (RTA_OIF) of a netlink answer that is a route (RTM_NEWROUTE); None for an error.
#[cfg(target_os = "linux")]
pub(super) fn oif(msg: &[u8]) -> Option<u32> {
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

/// The interface the kernel routes `to` by, from `from` (one of this host's addresses): `ip route get TO from FROM`,
/// asked over netlink, so policy routing (Tailscale's table 52, wg-quick's fwmark rules) counts. None when there is
/// no route, or the kernel could not be asked.
#[cfg(target_os = "linux")]
pub fn route_dev(to: Ipv4Addr, from: Ipv4Addr) -> Option<String> {
    use rustix::net::{netlink, sockopt, AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType};
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
    let fd = rustix::net::socket_with(AddressFamily::NETLINK, SocketType::RAW, SocketFlags::CLOEXEC, None).ok()?; // protocol 0: NETLINK_ROUTE
    let _ = sockopt::set_socket_timeout(&fd, sockopt::Timeout::Recv, Some(Duration::from_secs(1)));
    let sent = rustix::net::sendto(&fd, &req, SendFlags::empty(), &netlink::SocketAddrNetlink::new(0, 0)).ok()?;
    if sent != req.len() { return None; }
    let mut buf = [0u8; 4096];
    let (got, _) = rustix::net::recv(&fd, &mut buf, RecvFlags::empty()).ok()?;
    if got < 16 { return None; }
    // The interface by its index, asked of a socket of the kind such questions are put to.
    let index = oif(&buf[..got])?;
    let inet = rustix::net::socket_with(AddressFamily::INET, SocketType::DGRAM, SocketFlags::CLOEXEC, None).ok()?;
    rustix::net::netdevice::index_to_name(&inet, index).ok()
}

/// Elsewhere (macOS) the kernel is not asked so: a VPN's peer is let in only from inside the subnet it came in on.
#[cfg(not(target_os = "linux"))]
pub fn route_dev(_: Ipv4Addr, _: Ipv4Addr) -> Option<String> { None }

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

/// Whether `peer` is inside the subnet of `local` with `prefix` bits.
pub(super) fn on_link(local: Ipv4Addr, prefix: u8, peer: Ipv4Addr) -> bool {
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix.min(32))) };
    u32::from(local) & mask == u32::from(peer) & mask
}

/// The addresses listened on besides loopback, each with the interface it is on (the first that has it).
pub fn taken(bound: &[IpAddr], interfaces: &[Iface]) -> Vec<Taken> {
    bound.iter().filter(|a| !a.is_loopback())
        .filter_map(|a| interfaces.iter().find(|i| i.addr == *a && listened(i)).map(|i| Taken { addr: *a, interface: i.name.clone() }))
        .collect()
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

/// Whether the same network too listens on this address of this interface: an IPv4 address on a LAN (RFC 1918 or
/// link-local) of any interface but a bridge or a container's, or one in 100.64/10 of a VPN's. Never loopback (it
/// is listened on anyway), never IPv6, never a public address.
pub fn listened(i: &Iface) -> bool {
    let IpAddr::V4(v) = i.addr else { return false };
    if bridge(&i.name) || v.is_loopback() || v.is_unspecified() || v.is_broadcast() { return false; }
    lan_v4(v) || (shared_v4(v) && vpn(&i.name))
}

/// A LAN's address: RFC 1918 (10/8, 172.16/12, 192.168/16) or link-local (169.254/16).
fn lan_v4(v: Ipv4Addr) -> bool {
    v.is_private() || v.is_link_local()
}

/// The shared space 100.64/10 (RFC 6598): carriers' NAT, and the VPNs'.
fn shared_v4(v: Ipv4Addr) -> bool {
    v.octets()[0] == 100 && v.octets()[1] & 0xc0 == 64
}

/// Whether an interface is a VPN's (VPNS).
pub fn vpn(name: &str) -> bool {
    VPNS.iter().any(|p| name.starts_with(p))
}

/// Whether an interface is a bridge, or a container's or VM's (BRIDGES).
pub fn bridge(name: &str) -> bool {
    BRIDGES.iter().any(|p| name.starts_with(p))
}

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

/// An address listened on besides loopback, with the interface it is on (what `root3 address` and the card name).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Taken {
    pub addr: IpAddr,
    pub interface: String,
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

/// Keep the scope chosen, on this device (never sent).
pub fn set_scope(data: &Path, s: Scope) -> std::io::Result<()> {
    crate::fs::write::private_dir(&dir(data))?;
    crate::fs::write::replace(&scope_file(data), serde_json::json!({"scope": s.word()}).to_string().as_bytes(), crate::fs::write::How::PRIVATE)
}

/// The scope chosen on this device last, or this device only when none was.
pub fn scope(data: &Path) -> Scope {
    std::fs::read(scope_file(data)).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["scope"].as_str().and_then(Scope::from_word)).unwrap_or_default()
}

pub(super) fn scope_file(data: &Path) -> PathBuf {
    dir(data).join("scope.json")
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
    /// The word for it: in `root3 address ssh on device|network`, the record and what the Remote hears.
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

/// This person's port: $LENGTH3_SSH_PORT when it names one above 1023 (another is in use, or a test), else theirs.
pub fn port() -> u16 {
    std::env::var("LENGTH3_SSH_PORT").ok().and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 1023)
        .unwrap_or_else(|| port_for(rustix::process::getuid().as_raw()))
}

/// The port of the person with user number `uid` on a host.
pub fn port_for(uid: u32) -> u16 {
    BASE_PORT + (uid % 10_000) as u16
}

/// The first port: a person's is this plus their user number (mod 10000), 22000–31999.
pub const BASE_PORT: u16 = 22000;

/// Where SSH keeps its things on this device.
pub fn dir(data: &Path) -> PathBuf {
    data.join("ssh")
}


