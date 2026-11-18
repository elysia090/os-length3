use super::*;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;

pub(crate) fn header(name: &str, kind: u8, size: usize, link: &str, mode: u32) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..108].copy_from_slice(format!("{mode:07o}\0").as_bytes());
    h[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    h[156] = kind;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[148..156].copy_from_slice(b"        ");
    let sum: u64 = h.iter().map(|&b| b as u64).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    h
}

/// A tar of `members`: (name, kind, content, link, mode).
pub(crate) fn tar(members: &[(&str, u8, &[u8], &str, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, kind, body, link, mode) in members {
        out.extend(header(name, *kind, body.len(), link, *mode));
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    out.extend(vec![0u8; 1024]);
    out
}

pub(crate) fn fresh(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ricebox-test-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_root_unpacks_with_its_links_and_modes() {
    let top = fresh("unpack");
    let t = tar(&[("root/", b'5', b"", "", 0o755), ("root/usr/", b'5', b"", "", 0o755), ("root/usr/bin/", b'5', b"", "", 0o755),
        ("root/usr/bin/busybox", b'0', b"elf", "", 0o755), ("root/usr/bin/sh", b'1', b"", "root/usr/bin/busybox", 0o755),
        ("root/bin", b'2', b"", "usr/bin", 0o777), ("root/etc/", b'5', b"", "", 0o755), ("root/etc/shadow", b'0', b"x", "", 0o4600),
        ("root/tmp/", b'5', b"", "", 0o1777), ("manifest", b'0', b"m", "", 0o644)]);
    let u = unpack(&t[..], &top).unwrap();
    assert_eq!((u.files, u.bytes), (4, 5));
    assert_eq!(fs::read(top.join("root/bin/sh")).unwrap(), b"elf");
    assert_eq!(fs::read_link(top.join("root/bin")).unwrap(), Path::new("usr/bin"));
    let (a, b) = (fs::metadata(top.join("root/usr/bin/busybox")).unwrap(), fs::metadata(top.join("root/usr/bin/sh")).unwrap());
    assert_eq!((a.ino(), a.nlink(), a.permissions().mode() & 0o7777), (b.ino(), 2, 0o755));
    // No set-id bit comes from an archive; a directory's own bits do.
    assert_eq!(fs::metadata(top.join("root/etc/shadow")).unwrap().permissions().mode() & 0o7777, 0o600);
    assert_eq!(fs::metadata(top.join("root/tmp")).unwrap().permissions().mode() & 0o7777, 0o1777);
    let _ = fs::remove_dir_all(&top);
}

#[test]
fn nothing_lands_outside_or_through_a_link() {
    for (tag, members, said) in [
        ("up", vec![("../x", b'0', &b"x"[..], "", 0o644)], "leaves the tree"),
        ("up-inside", vec![("a/../../x", b'0', &b"x"[..], "", 0o644)], "leaves the tree"),
        // A link made earlier in the archive leads nothing through it: not a file, not a directory, not another name.
        ("through", vec![("out", b'2', &b""[..], "/tmp", 0o777), ("out/x", b'0', &b"x"[..], "", 0o644)], "out"),
        ("through-dir", vec![("out", b'2', &b""[..], "/tmp", 0o777), ("out/d/", b'5', &b""[..], "", 0o755)], "out"),
        ("over", vec![("f", b'2', &b""[..], "/etc/passwd", 0o777), ("f", b'0', &b"x"[..], "", 0o644)], "f"),
        ("hard", vec![("l", b'2', &b""[..], "/etc/passwd", 0o777), ("h", b'1', &b""[..], "l", 0o644)], "not a file"),
        ("hard-through", vec![("l", b'2', &b""[..], "/etc", 0o777), ("h", b'1', &b""[..], "l/passwd", 0o644)], "l"),
        ("device", vec![("null", b'3', &b""[..], "", 0o666)], "not part of a root"),
    ] {
        let top = fresh(tag);
        let before: Vec<_> = fs::read_dir(std::env::temp_dir()).unwrap().flatten().map(|e| e.file_name()).collect();
        let e = unpack(&tar(&members)[..], &top).expect_err(tag);
        assert!(e.to_string().contains(said), "{tag}: {e}");
        assert!(!top.parent().unwrap().join("x").exists(), "{tag}");
        let after: Vec<_> = fs::read_dir(std::env::temp_dir()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(after.iter().all(|n| before.contains(n) || n.to_string_lossy().starts_with("ricebox-test-")), "{tag}: something was made outside");
        let _ = fs::remove_dir_all(&top);
    }
}

#[test]
fn a_cut_pax_record_is_refused_not_a_crash() {
    let top = fresh("pax");
    for body in [&b"2 x"[..], b"99 path=x\n", b"x path=y\n", b"12 size=100\n"] {
        let t = tar(&[("pax", b'x', body, "", 0o644), ("f", b'0', b"x", "", 0o644)]);
        assert!(unpack(&t[..], &top).is_err(), "{:?}", String::from_utf8_lossy(body));
    }
    let _ = fs::remove_dir_all(&top);
}

/// The bound, held: a file is three calls (made, written, closed), a directory or a link one, a directory come into
/// one more with one to let the one before go; nothing is asked of the host besides (the top opened and let go,
/// the umask read aside). Counted over a tree laid out as a release's is: each directory's entries together.
#[test]
fn a_file_is_three_calls_a_directory_or_a_link_one() {
    let top = fresh("bound");
    let big = vec![7u8; 100_000];
    let mut members: Vec<(String, u8, Vec<u8>, String, u32)> = vec![("root/".into(), b'5', vec![], String::new(), 0o755)];
    for d in ["usr", "usr/bin", "usr/lib", "etc"] {
        members.push((format!("root/{d}/"), b'5', vec![], String::new(), 0o755));
        for k in 0..20 { members.push((format!("root/{d}/f{k}"), b'0', if k == 0 { big.clone() } else { format!("{d}{k}").into_bytes() }, String::new(), if k % 2 == 0 { 0o755 } else { 0o644 })); }
    }
    members.push(("root/bin".into(), b'2', vec![], "usr/bin".into(), 0o777));
    let borrowed: Vec<(&str, u8, &[u8], &str, u32)> = members.iter().map(|(n, k, b, l, m)| (n.as_str(), *k, &b[..], l.as_str(), *m)).collect();
    let u = unpack(&tar(&borrowed)[..], &top).unwrap();
    let (files, dirs, links) = (80u64, 5u64, 1u64);
    // The directories come into, each once as its entries are together: root (twice: for usr and etc, and again
    // for bin after etc), root/usr (for bin and lib), root/usr/bin, root/usr/lib, root/etc. The top itself is held
    // from the start. Each is one call to come into and one to let go.
    let mut came = 0u64;
    let mut at = String::new();
    for (name, ..) in &members {
        let rel = name.trim_end_matches('/');
        let parent = rel.rsplit_once('/').map_or("", |(p, _)| p);
        if parent != at { if !parent.is_empty() { came += 1; } at = parent.to_string(); }
    }
    assert_eq!(u.files, files);
    assert_eq!(u.calls, 3 * files + dirs + links + 2 * came + 2, "calls: {} for {files} files, {dirs} directories, {links} link, {came} directories come into", u.calls);
    let _ = fs::remove_dir_all(&top);
}
