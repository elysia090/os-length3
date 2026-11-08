//! The tests of compute/image.rs.

use super::*;

#[test]
fn a_disk_holds_the_folder_it_was_made_from_and_takes_on_the_host_only_what_it_holds() {
    if Command::new("mkfs.ext4").arg("-V").output().is_err() { eprintln!("skipped: no e2fsprogs here"); return; }
    let dir = crate::fs::testing::dir("l3-disk");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("given/notes")).unwrap();
    std::fs::write(dir.join("given/notes/README.md"), "notes\n").unwrap();
    let out = dir.join("out/run.ext4");
    run_disk(&dir.join("given"), &out, 256 << 20).unwrap();
    assert_eq!(read_file(&out, "/notes/README.md").unwrap(), b"notes\n");
    let m = std::fs::metadata(&out).unwrap();
    use std::os::unix::fs::MetadataExt;
    assert!(m.len() >= 256 << 20 && m.blocks() * 512 < m.len() / 4, "sparse: {} of {}", m.blocks() * 512, m.len());
    // The root's disk is made once: asked again, the same file.
    let root = root_disk(&dir, &"a".repeat(64), &dir.join("given")).unwrap();
    let made = std::fs::metadata(&root).unwrap().modified().unwrap();
    assert_eq!(std::fs::metadata(root_disk(&dir, &"a".repeat(64), &dir.join("given")).unwrap()).unwrap().modified().unwrap(), made);
    let _ = std::fs::remove_dir_all(&dir);
}
