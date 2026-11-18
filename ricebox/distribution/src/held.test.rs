use super::*;
use crate::unpack::tests::{fresh, tar};
use std::io::Write;
use std::os::unix::fs::symlink;

fn sha(bytes: &[u8]) -> String {
    crate::digest_of(bytes).unwrap().0
}

#[test]
fn the_roots_directories_are_listed_and_nothing_through_a_link_or_up() {
    let sys = fresh("list");
    let root = sys.join("abc").join("root");
    fs::create_dir_all(root.join("usr/bin")).unwrap();
    fs::write(root.join("usr/bin/busybox"), b"#!elf").unwrap();
    symlink("busybox", root.join("usr/bin/sh")).unwrap();
    symlink("usr/bin", root.join("bin")).unwrap();
    fs::write(sys.join("abc/installed.json"), r#"{"name":"ricebox","version":"1","sha256":"abc","files":1,"bytes":5}"#).unwrap();
    assert!(matches!(list(&sys, "/"), Err(Error::NotHeld)), "no root in use yet");
    assert_eq!(point_current(&sys, "abc").unwrap().version, "1");
    let top = list(&sys, "/").unwrap();
    assert_eq!(top.iter().map(|e| (e.name.as_str(), e.kind)).collect::<Vec<_>>(), [("bin", "link"), ("usr", "dir")]);
    assert_eq!(top[0].target.as_deref(), Some("usr/bin"));
    let bin = list(&sys, "/usr/bin").unwrap();
    assert_eq!(bin[0], Entry { name: "busybox".into(), kind: "file", path: "/usr/bin/busybox".into(), size: Some(5), target: None });
    assert_eq!(bin[1].kind, "link");
    for no in ["/bin", "/usr/../..", "usr", "/usr/bin/busybox", "/nothing"] { assert!(matches!(list(&sys, no), Err(Error::NotADirectory(_))), "{no}"); }
    let _ = fs::remove_dir_all(&sys);
}

/// A release's bundle: zstd frames of a tar whose tree is root/, its record beside it.
fn release() -> Vec<u8> {
    let t = tar(&[("root/", b'5', b"", "", 0o755), ("root/usr/", b'5', b"", "", 0o755), ("root/usr/bin/", b'5', b"", "", 0o755),
        ("root/usr/bin/busybox", b'0', b"#!elf", "", 0o755), ("root/usr/bin/sh", b'1', b"", "root/usr/bin/busybox", 0o755),
        ("root/bin", b'2', b"", "usr/bin", 0o777), ("manifest", b'0', b"m 1\n", "", 0o644)]);
    // (two frames, as a release is written a part at a time)
    let (a, b) = t.split_at(1024);
    [ruzstd::encoding::compress_to_vec(a, ruzstd::encoding::CompressionLevel::Fastest), ruzstd::encoding::compress_to_vec(b, ruzstd::encoding::CompressionLevel::Fastest)].concat()
}

#[test]
fn a_release_is_put_in_place_whole_by_its_digest_and_held() {
    let sys = fresh("put");
    let bundle = release();
    let pin = sha(&bundle);
    let said = About { name: "ricebox", version: "9.9.9", distro: None };
    let what = put(&sys, &bundle[..], Pin { sha256: &pin, bytes: bundle.len() as u64 }, Form::Release, said, |_| Ok(())).unwrap();
    assert_eq!((what.files, what.bytes, what.version.as_str(), what.sha256.as_str()), (3, 9, "9.9.9", pin.as_str()));
    assert!(what.allocated.is_some_and(|n| n > 0));
    assert_eq!(fs::read(sys.join(&pin).join("root/bin/sh")).unwrap(), b"#!elf");
    assert_eq!(fs::read(sys.join(&pin).join("manifest")).unwrap(), b"m 1\n");
    // Put in place, it is held and not yet the one in use; made so, it is; held already, it is not unpacked again.
    assert_eq!(held(&sys), [(what.clone(), false)]);
    assert!(current(&sys).is_none());
    assert_eq!(point_current(&sys, &pin).unwrap(), what);
    assert_eq!(current(&sys).unwrap(), (sys.join(&pin).join("root"), what.clone()));
    assert_eq!(held(&sys), [(what.clone(), true)]);
    assert_eq!(put(&sys, &b"anything"[..], Pin { sha256: &pin, bytes: 0 }, Form::Release, said, |_| Ok(())).unwrap(), what);
    assert!(matches!(point_current(&sys, &"0".repeat(64)), Err(Error::NotHeld)));
    let _ = fs::remove_dir_all(&sys);
}

#[test]
fn a_bundle_that_is_not_what_its_pin_says_or_holds_no_root_leaves_nothing() {
    let sys = fresh("refused");
    let bundle = release();
    let left = |sys: &Path| fs::read_dir(sys).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default();
    let said = About { name: "ricebox", version: "1", distro: None };
    // Another digest, another length, bytes after its archive: each is what the whole file is, and not the pin.
    let other = "0".repeat(64);
    assert!(matches!(put(&sys, &bundle[..], Pin { sha256: &other, bytes: bundle.len() as u64 }, Form::Release, said, |_| Ok(())), Err(Error::NotPinned { .. })));
    assert!(matches!(put(&sys, &bundle[..], Pin { sha256: &sha(&bundle), bytes: 1 }, Form::Release, said, |_| Ok(())), Err(Error::NotPinned { .. })));
    let more = [&bundle[..], b"more"].concat();
    assert!(matches!(put(&sys, &more[..], Pin { sha256: &sha(&bundle), bytes: bundle.len() as u64 }, Form::Release, said, |_| Ok(())), Err(Error::NotPinned { .. })));
    // Not an archive at all; an archive with no /bin/sh.
    assert!(matches!(put(&sys, &b"not the release"[..], Pin { sha256: &sha(b"not the release"), bytes: 15 }, Form::Release, said, |_| Ok(())), Err(Error::Unpack(_))));
    let empty = ruzstd::encoding::compress_to_vec(&tar(&[("root/", b'5', b"", "", 0o755)])[..], ruzstd::encoding::CompressionLevel::Fastest);
    assert!(matches!(put(&sys, &empty[..], Pin { sha256: &sha(&empty), bytes: empty.len() as u64 }, Form::Release, said, |_| Ok(())), Err(Error::NoShell)));
    assert_eq!(left(&sys), Vec::<String>::new());
    let _ = fs::remove_dir_all(&sys);
}

#[test]
fn another_distributions_root_goes_in_from_its_tar_gz_made_ready_by_whoever_puts_it() {
    let sys = fresh("distro");
    let t = tar(&[("etc/", b'5', b"", "", 0o755), ("./", b'5', b"", "", 0o755), ("usr/", b'5', b"", "", 0o755), ("usr/bin/", b'5', b"", "", 0o755),
        ("usr/bin/dash", b'0', b"#!elf", "", 0o755), ("bin", b'2', b"", "usr/bin", 0o777), ("usr/bin/sh", b'2', b"", "dash", 0o777)]);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&t).unwrap();
    let archive = gz.finish().unwrap();
    let pin = sha(&archive);
    let what = put(&sys, &archive[..], Pin { sha256: &pin, bytes: archive.len() as u64 }, Form::TarGz, About { name: "Ubuntu", version: "26.04", distro: Some("ubuntu") },
        |tree| fs::write(tree.join("etc/ready"), "yes")).unwrap();
    assert_eq!((what.distro.as_deref(), what.files), (Some("ubuntu"), 1));
    let tree = sys.join(&pin).join("root");
    assert_eq!(fs::read_to_string(tree.join("etc/ready")).unwrap(), "yes");
    assert!(tree.join("bin/sh").exists(), "reached through its own /bin link");
    let _ = fs::remove_dir_all(&sys);
}
