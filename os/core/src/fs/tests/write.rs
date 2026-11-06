//! The tests of disk/write.rs.

use super::*;

fn scratch(tag: &str) -> PathBuf {
    let d = crate::fs::testing::dir(&format!("length3-atomic-{tag}"));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_file_is_replaced_whole_and_nothing_is_left_beside_it() {
    let d = scratch("whole");
    let at = d.join("state.json");
    replace(&at, b"{\"a\":1}", How::RECORD).unwrap();
    replace(&at, b"{\"a\":2}", How::CACHE).unwrap();
    assert_eq!(fs::read(&at).unwrap(), b"{\"a\":2}");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    // Into a folder that is not there: an error, and nothing made.
    assert!(replace(&d.join("missing/x"), b"x", How::RECORD).is_err());
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_file_made_once_is_never_replaced() {
    let d = scratch("create");
    let at = d.join("host_key");
    create(&at, b"first", How::PRIVATE).unwrap();
    assert_eq!(create(&at, b"second", How::PRIVATE).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&at).unwrap(), b"first");
    assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_directory_goes_into_place_whole_and_never_over_another() {
    let d = scratch("rename-new");
    fs::create_dir_all(d.join("aside/sub")).unwrap();
    fs::create_dir(d.join("taken")).unwrap();
    assert_eq!(rename_new(&d.join("aside"), &d.join("taken")).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    assert!(d.join("aside/sub").is_dir() && fs::read_dir(d.join("taken")).unwrap().count() == 0);
    rename_new(&d.join("aside"), &d.join("free")).unwrap();
    assert!(d.join("free/sub").is_dir() && !d.join("aside").exists());
    let _ = fs::remove_dir_all(&d);
}

#[cfg(unix)]
#[test]
fn a_private_file_is_the_owners_alone_whatever_it_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let d = scratch("private");
    let at = d.join("remote.json");
    fs::write(&at, "old").unwrap();
    fs::set_permissions(&at, fs::Permissions::from_mode(0o644)).unwrap();
    replace(&at, b"token", How::PRIVATE).unwrap();
    assert_eq!(fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o600);
    let _ = fs::remove_dir_all(&d);
}

#[cfg(unix)]
#[test]
fn a_link_planted_at_the_temporarys_name_is_not_written_through() {
    let d = scratch("planted");
    let outside = d.join("outside");
    fs::write(&outside, "the person's own").unwrap();
    let pid = std::process::id();
    for n in 0..8 { std::os::unix::fs::symlink(&outside, d.join(format!(".a.length3-{pid}-{n}"))).unwrap(); }
    replace(&d.join("a"), b"new", How::RECORD).unwrap();
    assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own");
    assert_eq!(fs::read_to_string(d.join("a")).unwrap(), "new");
    let _ = fs::remove_dir_all(&d);
}
