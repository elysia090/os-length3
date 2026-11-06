//! The tests of /ssh.rs.

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

fn ips(list: &[&str]) -> Vec<IpAddr> {
    list.iter().map(|a| a.parse().unwrap()).collect()
}

/// A fake interface list: `name addr/prefix` each.
fn ifs(list: &[&str]) -> Vec<Iface> {
    list.iter().map(|l| {
        let (name, at) = l.split_once(' ').unwrap();
        let (addr, prefix) = at.split_once('/').unwrap();
        Iface::new(name, addr.parse().unwrap(), prefix.parse().unwrap())
    }).collect()
}

/// A laptop on Wi-Fi with Tailscale, Docker, libvirt and a carrier's shared address on its wired port.
fn laptop() -> Vec<Iface> {
    ifs(&["lo 127.0.0.1/8", "lo ::1/128", "wlan0 192.168.1.5/24", "wlan0 fe80::1/64", "wlan0 2001:db8::5/64", "eth0 100.70.3.4/10",
        "tailscale0 100.101.102.103/32", "tailscale0 fd7a:115c:a1e0::1/128", "docker0 172.17.0.1/16", "br-3f2a1b 172.18.0.1/16",
        "virbr0 192.168.122.1/24", "eth1 169.254.3.4/16", "eth2 10.0.0.7/8", "wwan0 203.0.113.9/24"])
}

#[test]
fn this_device_only_listens_on_loopback_alone_whatever_the_host_has() {
    assert_eq!(listen_on(Scope::Device, &laptop()), ips(&["127.0.0.1", "::1"]));
    assert_eq!(listen_on(Scope::Device, &[]), ips(&["127.0.0.1", "::1"]));
}

#[test]
fn the_same_network_listens_on_each_lan_address_and_a_vpns_shared_one_never_a_public_one_or_every_interface() {
    let on = listen_on(Scope::Network, &laptop());
    assert_eq!(on, ips(&["10.0.0.7", "192.168.1.5", "100.101.102.103", "169.254.3.4", "127.0.0.1", "::1"]));
    assert_eq!(taken(&on, &laptop()), [("10.0.0.7", "eth2"), ("192.168.1.5", "wlan0"), ("100.101.102.103", "tailscale0"), ("169.254.3.4", "eth1")]
        .map(|(a, i)| Taken { addr: a.parse().unwrap(), interface: i.into() }));
    for never in ["203.0.113.9", "100.70.3.4", "172.17.0.1", "172.18.0.1", "192.168.122.1", "0.0.0.0", "2001:db8::5", "fe80::1", "fd7a:115c:a1e0::1"] {
        assert!(!on.contains(&never.parse().unwrap()), "{never}");
    }
    // Never the unspecified or broadcast address, a public one, or loopback twice (127.0.1.1 is Debian's hostname line).
    let odd = ifs(&["eth0 0.0.0.0/0", "eth0 255.255.255.255/32", "eth0 8.8.8.8/24", "eth0 172.32.0.1/16", "eth0 100.128.0.1/10", "lo 127.0.1.1/8"]);
    assert_eq!(listen_on(Scope::Network, &odd), ips(&["127.0.0.1", "::1"]));
    // A host with only a public address (a server on the Internet): loopback alone, as this device only.
    assert_eq!(listen_on(Scope::Network, &ifs(&["eth0 198.51.100.20/24", "eth0 2001:db8::1/64"])), ips(&["127.0.0.1", "::1"]));
    // The same address on two interfaces is listened on once.
    assert_eq!(listen_on(Scope::Network, &ifs(&["eth0 192.168.1.5/24", "wlan0 192.168.1.5/24"])), ips(&["192.168.1.5", "127.0.0.1", "::1"]));
    // The address a destination names is one listened on, and 127.0.0.1 when only loopback is.
    assert_eq!(host(&ips(&["127.0.0.1", "::1"])), Ipv4Addr::LOCALHOST);
    assert!(on.contains(&IpAddr::V4(host(&on))));
}

#[test]
fn a_bridge_or_a_containers_interface_is_never_listened_on_whatever_its_address() {
    for name in ["docker0", "br-3f2a1b9c0d1e", "virbr0", "veth1a2b3c4", "ve-mybox", "vb-mybox", "lxcbr0", "lxdbr0", "incusbr0", "cni0", "flannel.1",
        "cali1234abcd", "cilium_host", "podman0", "vmnet8", "vboxnet0"] {
        assert!(bridge(name), "{name}");
        for addr in ["192.168.5.1/24", "10.88.0.1/16", "172.17.0.1/16", "169.254.1.1/16", "100.100.1.1/10"] {
            let list = ifs(&[&format!("{name} {addr}")]);
            assert_eq!(listen_on(Scope::Network, &list), ips(&["127.0.0.1", "::1"]), "{name} {addr}");
        }
    }
    // Every prefix of BRIDGES is in the list above.
    for p in BRIDGES { assert!(["docker0", "br-", "virbr0", "veth0", "ve-x", "vb-x", "lxcbr0", "lxdbr0", "incusbr0", "cni0", "flannel.1", "cali0", "cilium_host", "podman0", "vmnet1", "vboxnet0"].iter().any(|n| n.starts_with(p)), "{p}"); }
    // Ordinary names are not bridges.
    for name in ["eth0", "wlan0", "enp3s0", "wlp2s0", "eno1", "bond0", "tailscale0", "wg0", "usb0"] { assert!(!bridge(name), "{name}"); }
}

#[test]
fn the_shared_space_is_listened_on_only_on_a_vpns_interface() {
    // 100.64/10 on eth0 is a carrier's shared NAT: its other customers are there.
    assert_eq!(listen_on(Scope::Network, &ifs(&["eth0 100.70.3.4/10"])), ips(&["127.0.0.1", "::1"]));
    assert_eq!(listen_on(Scope::Network, &ifs(&["wlan0 100.64.0.1/10", "tun0 100.65.0.2/16", "ppp0 100.127.255.254/32"])), ips(&["127.0.0.1", "::1"]));
    // On a VPN's interface it is the VPN's.
    for name in ["tailscale0", "wg0", "wg0-mullvad", "zt3jnwghuq", "nebula1", "wt0", "CloudflareWARP"] {
        assert!(vpn(name), "{name}");
        assert_eq!(listen_on(Scope::Network, &ifs(&[&format!("{name} 100.101.102.103/32")])), ips(&["100.101.102.103", "127.0.0.1", "::1"]), "{name}");
    }
    for name in ["eth0", "tun0", "ppp0", "docker0"] { assert!(!vpn(name), "{name}"); }
    // A VPN's own private addresses (WireGuard's 10.0.0.2/24, ZeroTier's) are a LAN's: listened on, as on any interface.
    assert_eq!(listen_on(Scope::Network, &ifs(&["wg0 10.8.0.2/24", "zt3jnwghuq 10.147.17.5/24"])), ips(&["10.8.0.2", "10.147.17.5", "127.0.0.1", "::1"]));
    // A LAN address and link-local on an ordinary interface stay.
    assert_eq!(listen_on(Scope::Network, &ifs(&["enp3s0 172.16.4.2/12"])), ips(&["172.16.4.2", "127.0.0.1", "::1"]));
    assert_eq!(listen_on(Scope::Network, &ifs(&["usb0 169.254.7.8/16"])), ips(&["169.254.7.8", "127.0.0.1", "::1"]));
}

#[test]
fn no_ipv6_address_but_loopback_is_ever_listened_on() {
    // Deliberate for now: whatever IPv6 the host has, on whatever interface, in either scope.
    let v6 = ifs(&["lo ::1/128", "wlan0 fe80::1/64", "wlan0 2001:db8::5/64", "wlan0 fd00::7/64", "tailscale0 fd7a:115c:a1e0::1/128", "wg0 fd42::2/64",
        "eth0 ::ffff:192.168.1.9/128", "eth0 ::/0", "eth0 64:ff9b::c000:201/96"]);
    for scope in [Scope::Device, Scope::Network] {
        for list in [v6.clone(), [laptop(), v6.clone()].concat()] {
            let on = listen_on(scope, &list);
            assert_eq!(on.iter().filter(|a| a.is_ipv6()).collect::<Vec<_>>(), [&IpAddr::V6(Ipv6Addr::LOCALHOST)], "{scope:?} {on:?}");
        }
    }
    assert!(v6.iter().all(|i| !listened(i)));
}

/// The kernel's routes, as `ip route get` answers them for the laptop above: the tailnet by tailscale0, the LAN
/// by wlan0, everything else by wwan0.
fn routes(to: Ipv4Addr, _from: Ipv4Addr) -> Option<String> {
    let o = to.octets();
    Some(if o[0] == 100 && o[1] == 88 { "tailscale0" } else if o[..3] == [192, 168, 1] { "wlan0" } else { "wwan0" }.into())
}

#[test]
fn a_connection_is_taken_from_the_network_of_the_address_it_came_in_on_and_from_the_device_itself() {
    let have = laptop();
    let ip = |a: &str| a.parse::<IpAddr>().unwrap();
    let ok = |local: &str, peer: &str| admit(ip(local), ip(peer), &have, routes);
    // Loopback, and the device itself at its own addresses (its ssh to its LAN address comes from it).
    assert!(ok("127.0.0.1", "127.0.0.1") && ok("::1", "::1"));
    assert!(ok("192.168.1.5", "192.168.1.5") && ok("192.168.1.5", "10.0.0.7") && ok("::ffff:192.168.1.5", "::ffff:192.168.1.5"));
    // A LAN peer, inside the subnet of the address it came in on; link-local likewise.
    assert!(ok("192.168.1.5", "192.168.1.9") && ok("10.0.0.7", "10.200.3.4") && ok("169.254.3.4", "169.254.200.1"));
    // The weak host model: a sender on another segment that routed to the LAN address through this host.
    assert!(!ok("192.168.1.5", "203.0.113.50"), "the Internet, at the LAN address");
    assert!(!ok("192.168.1.5", "10.9.9.9"), "another private network, at the LAN address");
    assert!(!ok("192.168.1.5", "192.168.2.9"), "the next subnet");
    assert!(!ok("192.168.1.5", "100.70.9.9"), "the carrier's shared space, at the LAN address");
    assert!(!ok("10.0.0.7", "11.0.0.1"));
    // Tailscale: its own address is a /32; a peer is taken when routed by tailscale0, and only then.
    assert!(ok("100.101.102.103", "100.88.1.2"), "a tailnet peer");
    assert!(!ok("100.101.102.103", "100.70.9.9"), "the carrier's shared space, routed by wwan0, at the Tailscale address");
    assert!(!ok("100.101.102.103", "203.0.113.50"), "the Internet, at the Tailscale address");
    assert!(!admit(ip("100.101.102.103"), ip("8.8.8.8"), &have, |_, _| Some("tailscale0".into())), "a public peer, even routed by the VPN (an exit node)");
    assert!(!admit(ip("100.101.102.103"), ip("100.88.1.2"), &have, |_, _| None), "no route: not taken");
    // On an address not listened on (a bridge's, a carrier's shared one, a public one), nothing is, but the device.
    assert!(!ok("172.17.0.1", "172.17.0.2") && !ok("100.70.3.4", "100.70.0.1") && !ok("203.0.113.9", "203.0.113.50"));
    assert!(ok("172.17.0.1", "172.17.0.1"));
    // IPv6 peers on an IPv4 address, or an IPv6 local address besides ::1: never.
    assert!(!ok("192.168.1.5", "2001:db8::9") && !ok("2001:db8::5", "2001:db8::9"));
}

#[test]
fn the_subnet_is_the_prefix_of_the_address_it_came_in_on() {
    let v = |a: &str| a.parse::<Ipv4Addr>().unwrap();
    assert!(on_link(v("192.168.1.5"), 24, v("192.168.1.255")) && !on_link(v("192.168.1.5"), 24, v("192.168.0.1")));
    assert!(on_link(v("172.16.4.2"), 12, v("172.31.0.1")) && !on_link(v("172.16.4.2"), 12, v("172.32.0.1")));
    assert!(on_link(v("100.101.102.103"), 32, v("100.101.102.103")) && !on_link(v("100.101.102.103"), 32, v("100.101.102.104")));
    assert!(on_link(v("10.0.0.1"), 0, v("1.2.3.4")));
}

#[cfg(target_os = "linux")]
#[test]
fn the_kernel_is_asked_the_way_to_an_address() {
    // Loopback is always there, so this holds on any Linux; an address that is nowhere has no way to it from 127.0.0.1.
    assert_eq!(route_dev(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST).as_deref(), Some("lo"));
    assert_eq!(route_dev(Ipv4Addr::new(127, 0, 0, 2), Ipv4Addr::LOCALHOST).as_deref(), Some("lo"));
    assert_eq!(oif(&[0u8; 16]), None);
    // Each address getifaddrs gives has its interface's name.
    let have = interfaces();
    assert!(have.iter().any(|i| i.name == "lo" && i.addr == IpAddr::V4(Ipv4Addr::LOCALHOST) && i.prefix == 8), "{have:?}");
}

#[test]
fn the_scope_is_kept_on_this_device_and_this_device_only_until_one_is_chosen() {
    let data = crate::fs::testing::dir("length3-ssh-scope");
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
    // An IPv4 peer is one peer however its address came: ::ffff:a.b.c.d counts as a.b.c.d.
    let (v4, mapped): (IpAddr, IpAddr) = ("192.168.1.11".parse().unwrap(), "::ffff:192.168.1.11".parse().unwrap());
    for i in 0..TRIES { t.failed(if i % 2 == 0 { v4 } else { mapped }, now); }
    assert!(t.held(v4, now) && t.held(mapped, now));
}

#[test]
fn the_listener_is_known_while_its_process_runs_and_stopped_with_it() {
    let data = crate::fs::testing::dir("length3-ssh");
    let _ = std::fs::remove_dir_all(&data);
    assert_eq!(listening(&data), None);
    let mut kept = record(&data, 22000, Scope::Device, ips(&["127.0.0.1", "::1"]), Vec::new(), "SHA256:x".into()).unwrap();
    let l = listening(&data).expect("recorded");
    assert_eq!((l.pid, l.port, l.scope, l.bound.len()), (std::process::id(), 22000, Scope::Device, 2));
    assert!(l.destinations().iter().all(|d| d.starts_with("ssh -p 22000 ") && d.ends_with("@127.0.0.1")), "{:?}", l.destinations());
    let bound = ips(&["192.168.1.5", "127.0.0.1", "::1"]);
    kept.set_bound(Scope::Network, bound.clone(), taken(&bound, &laptop())).unwrap();
    assert_eq!(listening(&data).map(|l| (l.scope, l.bound.len())), Some((Scope::Network, 3)));
    assert_eq!(here(&data).interfaces, [Taken { addr: "192.168.1.5".parse().unwrap(), interface: "wlan0".into() }]);
    drop(kept);
    assert_eq!(listening(&data), None);
    // One whose process is gone is let go when read.
    std::fs::write(record_file(&data), r#"{"pid":4194304,"startTicks":1,"port":22000,"started":1,"scope":"device","bound":["127.0.0.1"],"fingerprint":""}"#).unwrap();
    assert_eq!(listening(&data), None);
    assert!(!record_file(&data).exists());
    let _ = std::fs::remove_dir_all(&data);
}
