//! The tests of why's part of a root: which it takes, from where, made ready for a Prompt, said in its words. What
//! a root is on a device is ricebox's, and tested there (module/ricebox/src).
use super::*;
use std::fs;
use std::io::Write;

fn fresh(tag: &str) -> PathBuf {
    let d = crate::fs::testing::dir(&format!("why-root-{tag}"));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn header(name: &str, kind: u8, size: usize, link: &str) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..108].copy_from_slice(b"0000755\0");
    h[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    h[156] = kind;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[148..156].copy_from_slice(b"        ");
    let sum: u64 = h.iter().map(|&b| b as u64).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    h
}

fn tar(members: &[(&str, u8, &[u8], &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, kind, body, link) in members {
        out.extend(header(name, *kind, body.len(), link));
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    out.extend(vec![0u8; 1024]);
    out
}

#[test]
#[cfg(target_os = "linux")]
fn a_distribution_root_is_taken_only_at_its_pin_made_ready_for_a_prompt_and_held() {
    let d = fresh("distro");
    let t = tar(&[("etc/", b'5', b"", ""), ("etc/apt/", b'5', b"", ""), ("etc/apt/apt.conf.d/", b'5', b"", ""),
        ("./", b'5', b"", ""), ("usr/", b'5', b"", ""), ("usr/bin/", b'5', b"", ""), ("usr/bin/dash", b'0', b"#!elf", ""), ("bin", b'2', b"", "usr/bin"), ("usr/bin/sh", b'2', b"", "dash")]);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&t).unwrap();
    let archive = gz.finish().unwrap();
    fs::write(d.join("a.tar.gz"), &archive).unwrap();
    let data = d.join("data");
    // Not Ubuntu's own archive: taken by Ubuntu's pin, it is refused, and nothing of it is left.
    let e = install_distro(&data, distro("ubuntu").unwrap(), &d.join("a.tar.gz")).unwrap_err();
    assert!(e.contains("Not a known release") || e.contains("知らないリリース"), "{e}");
    assert!(held(&data).is_empty() && current(&data).is_none());
    // Pinned as what it is, it goes in, is made current, and is ready for a Prompt's one user.
    let (sha, n) = ricebox::digest_of(&archive[..]).unwrap();
    let pinned = Distro { id: "ubuntu", name: "Ubuntu", version: "0", url: "", sha256: Box::leak(sha.clone().into_boxed_str()), bytes: n };
    let r = install_distro(&data, &pinned, &d.join("a.tar.gz")).unwrap();
    assert_eq!((r.distro.as_deref(), r.files), (Some("ubuntu"), 1));
    let (tree, about) = current(&data).unwrap();
    assert_eq!(about.sha256, sha);
    assert!(fs::read_to_string(tree.join("etc/apt/apt.conf.d/00why")).unwrap().contains("APT::Sandbox::User \"root\""));
    assert!(tree.join("bin/sh").exists());
    assert_eq!(list(&data, "/usr/bin").unwrap().iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["dash", "sh"]);
    for no in ["usr", "/usr/../.."] { let e = list(&data, no).unwrap_err(); assert!(e.contains("Not a path from /") || e.contains("/ からのパス"), "{no}: {e}"); }
    let e = list(&data, "/bin").unwrap_err();
    assert!(e.contains("Not a directory of the root") || e.contains("root のディレクトリ"), "{e}");
    // Another made current, then this one again without fetching: it is held.
    fs::remove_file(system_dir(&data).join("current")).unwrap();
    assert!(current(&data).is_none());
    assert_eq!(use_held(&data, &sha).unwrap().version, "0");
    assert!(use_held(&data, &"0".repeat(64)).is_none());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn only_a_pinned_release_is_taken() {
    let d = fresh("pin");
    fs::write(d.join("b.tar.zst"), b"not the release").unwrap();
    for e in [identify(&d.join("b.tar.zst")).unwrap_err(), install(&d.join("data"), &d.join("b.tar.zst")).unwrap_err()] {
        assert!(e.contains("Not a known release") || e.contains("知らないリリース"), "{e}");
    }
    assert!(!system_dir(&d.join("data")).exists());
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
