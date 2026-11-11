//! The tests of root/ (mod.rs).

use super::*;
use super::held::*;
use super::install::*;
use std::fs;
use std::path::{Path, PathBuf};

fn header(name: &str, kind: u8, size: usize, link: &str) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..107].copy_from_slice(b"0000644");
    h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
    h[156] = kind;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[257..262].copy_from_slice(b"ustar");
    h[148..156].copy_from_slice(b"        ");
    let sum: u64 = h.iter().map(|&b| b as u64).sum();
    h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
    h
}

fn tar(members: &[(&str, u8, &[u8], &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, kind, body, link) in members {
        out.extend(header(name, *kind, body.len(), link));
        out.extend(*body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    out.extend([0u8; 1024]);
    out
}

fn fresh(tag: &str) -> PathBuf {
    let d = crate::fs::testing::dir(&format!("length3-root-{tag}"));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
#[cfg(unix)]
fn the_current_roots_directories_are_listed_and_nothing_through_a_link_or_up() {
    let data = fresh("list");
    let sys = system_dir(&data);
    let root = sys.join("abc").join("root");
    fs::create_dir_all(root.join("usr/bin")).unwrap();
    fs::write(root.join("usr/bin/busybox"), b"#!elf").unwrap();
    symlink("busybox", root.join("usr/bin/sh")).unwrap();
    symlink("usr/bin", root.join("bin")).unwrap();
    fs::write(sys.join("abc/installed.json"), r#"{"name":"root3","version":"1","sha256":"abc","files":1,"bytes":5}"#).unwrap();
    assert!(list(&data, "/").is_err(), "no root current yet");
    symlink("abc", sys.join("current")).unwrap();
    let top = list(&data, "/").unwrap();
    assert_eq!(top.iter().map(|e| (e.name.as_str(), e.kind)).collect::<Vec<_>>(), [("bin", "link"), ("usr", "dir")]);
    assert_eq!(top[0].target.as_deref(), Some("usr/bin"));
    let bin = list(&data, "/usr/bin").unwrap();
    assert_eq!(bin[0], Entry { name: "busybox".into(), kind: "file", path: "/usr/bin/busybox".into(), size: Some(5), target: None });
    assert_eq!(bin[1].kind, "link");
    for no in ["/bin", "/usr/../..", "usr", "/usr/bin/busybox", "/nothing"] { assert!(list(&data, no).is_err(), "{no}"); }
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_root_unpacks_with_its_links() {
    let d = fresh("ok");
    let t = tar(&[("root/", b'5', b"", ""), ("root/bin/", b'5', b"", ""), ("root/bin/busybox", b'0', b"#!elf", ""),
        ("root/bin/sh", b'2', b"", "busybox"), ("root/bin/ash", b'1', b"", "root/bin/busybox")]);
    assert_eq!(unpack(&t[..], &d).unwrap(), (2, 5));
    assert_eq!(fs::read_link(d.join("root/bin/sh")).unwrap(), PathBuf::from("busybox"));
    assert_eq!(fs::read(d.join("root/bin/ash")).unwrap(), b"#!elf");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn nothing_lands_outside_or_through_a_link() {
    for (members, what) in [
        (vec![("../x", b'0', &b"x"[..], "")], "leaves"),
        (vec![("/etc/x", b'0', &b"x"[..], "")], "leaves"),
        (vec![("root/", b'5', &b""[..], ""), ("root/l", b'2', &b""[..], "/etc"), ("root/l/passwd", b'0', &b"x"[..], "")], "through a link"),
        (vec![("root/dev", b'3', &b""[..], "")], "not part of a root"),
        (vec![("root/a", b'0', &b"x"[..], ""), ("root/a", b'0', &b"y"[..], "")], "exists"),
        (vec![("root/", b'5', &b""[..], ""), ("root/l", b'2', &b""[..], "/etc"), ("root/h", b'1', &b""[..], "root/l/passwd")], "through a link"),
    ] {
        let d = fresh("bad");
        let e = unpack(&tar(&members)[..], &d).unwrap_err().to_string();
        assert!(e.contains(what), "{e}");
        assert!(!Path::new("/etc/x").exists());
        let _ = fs::remove_dir_all(&d);
    }
}

#[test]
fn a_distribution_root_goes_in_from_its_tar_gz_and_back_out_by_its_digest() {
    use std::io::Write;
    let d = fresh("distro");
    let t = tar(&[("etc/", b'5', b"", ""), ("etc/apt/", b'5', b"", ""), ("etc/apt/apt.conf.d/", b'5', b"", ""),
        ("./", b'5', b"", ""), ("usr/", b'5', b"", ""), ("usr/bin/", b'5', b"", ""), ("usr/bin/dash", b'0', b"#!elf", ""), ("bin", b'2', b"", "usr/bin"), ("usr/bin/sh", b'2', b"", "dash")]);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&t).unwrap();
    fs::write(d.join("a.tar.gz"), gz.finish().unwrap()).unwrap();
    let ubuntu = distro("ubuntu").unwrap();
    let data = d.join("data");
    // Not Ubuntu's own archive: taken by its pin, it is refused.
    assert!(install_distro(&data, ubuntu, &d.join("a.tar.gz")).unwrap_err().contains("Not a known release"));
    let r = unpack_distro(&data, ubuntu, fs::File::open(d.join("a.tar.gz")).unwrap()).unwrap();
    assert_eq!((r.distro.as_deref(), r.files), (Some("ubuntu"), 1));
    let (tree, about) = current(&data).unwrap();
    assert_eq!(about.sha256, ubuntu.sha256);
    // Ready for a Prompt's one user, and reached through its own /bin link.
    assert!(fs::read_to_string(tree.join("etc/apt/apt.conf.d/00length3")).unwrap().contains("APT::Sandbox::User \"root\""));
    assert!(tree.join("bin/sh").exists());
    // Another made current, then this one again without fetching: it is held.
    fs::remove_file(system_dir(&data).join("current")).unwrap();
    assert!(current(&data).is_none());
    assert_eq!(use_held(&data, ubuntu.sha256).unwrap().version, ubuntu.version);
    assert!(use_held(&data, &"0".repeat(64)).is_none());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_cut_pax_record_is_refused_not_a_crash() {
    let d = fresh("pax");
    let mut t = header("pax", b'x', 3, "");
    t.extend(b"2 x");
    t.resize(1024, 0);
    t.extend([0u8; 1024]);
    assert!(unpack(&t[..], &d).unwrap_err().to_string().contains("pax"));
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn only_a_pinned_release_is_taken() {
    let d = fresh("pin");
    fs::write(d.join("b.tar.zst"), b"not the release").unwrap();
    let e = identify(&d.join("b.tar.zst")).unwrap_err();
    assert!(e.contains("Not a known release") || e.contains("知らないリリース"), "{e}");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_root_comes_from_the_remote_then_the_publishers_then_the_release_channel() {
    let r = &RELEASES[0];
    let ours = format!("{}/v1/os/{}", crate::remote::DEFAULT_URL, r.sha256);
    assert_eq!(sources("http://127.0.0.1:8787/", r), [format!("http://127.0.0.1:8787/v1/os/{}", r.sha256), ours.clone(), github_url(r)]);
    // A device on the publisher's Remote asks it once.
    assert_eq!(sources(crate::remote::DEFAULT_URL, r), [ours, github_url(r)]);
}
