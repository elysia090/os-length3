//! The tests of fs/size.rs.

use super::*;

#[test]
fn a_folder_takes_its_files_blocks_each_file_once_and_no_links_followed() {
    let d = crate::fs::testing::dir("size");
    fs::create_dir_all(d.join("a/b")).unwrap();
    fs::write(d.join("a/b/one"), vec![1u8; 10_000]).unwrap();
    let one = blocks(&fs::symlink_metadata(d.join("a/b/one")).unwrap());
    let empty = allocated(&d.join("a/b")) - one;
    // A second name for the same file adds nothing; a link to a big file elsewhere adds only itself.
    fs::hard_link(d.join("a/b/one"), d.join("a/two")).unwrap();
    let elsewhere = crate::fs::testing::dir("size-elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("big"), vec![2u8; 1 << 20]).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("big"), d.join("a/big")).unwrap();
    let link = blocks(&fs::symlink_metadata(d.join("a/big")).unwrap());
    assert!(one >= 10_000 && link < 1 << 20);
    assert_eq!(allocated(&d.join("a")), 2 * empty + one + link);
    assert_eq!(allocated(&d.join("a/b/one")), one);
    assert_eq!(allocated(&d.join("nothing")), 0);
    let _ = fs::remove_dir_all(&d);
    let _ = fs::remove_dir_all(&elsewhere);
}

#[test]
fn room_is_the_filesystems_and_never_more_free_than_there_is() {
    let d = crate::fs::testing::dir("room");
    let (total, free) = room(&d).unwrap();
    assert!(total > 0 && free <= total);
    let _ = fs::remove_dir_all(&d);
}
