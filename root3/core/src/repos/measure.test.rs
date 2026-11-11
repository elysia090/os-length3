//! The tests of repos/measure.rs.

use super::*;

#[test]
fn a_repo_is_counted_once_its_own_files_apart_from_its_git_links_temporaries_and_what_is_derived() {
    let d = crate::fs::testing::dir("measure");
    fs::create_dir_all(d.join("src")).unwrap();
    fs::create_dir_all(d.join(".git/objects")).unwrap();
    fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
    fs::write(d.join("a.txt"), "0123456789").unwrap();
    fs::write(d.join("src/b.rs"), "fn b(){}").unwrap();
    fs::write(d.join("package.json"), "{}").unwrap();
    fs::write(d.join(".git/objects/x"), vec![1u8; 50_000]).unwrap();
    fs::write(d.join("node_modules/pkg/big.js"), vec![2u8; 1 << 20]).unwrap();
    fs::write(d.join(".a.txt.root3-1-0"), "half").unwrap();
    std::os::unix::fs::symlink("a.txt", d.join("link")).unwrap();
    // A second name for a.txt: a file of the repo's, whose blocks are a.txt's.
    fs::hard_link(d.join("a.txt"), d.join("c.txt")).unwrap();
    let m = measure(&d);
    assert_eq!((m.files, m.bytes), (4, 10 + 8 + 2 + 10), "a.txt, src/b.rs, package.json, c.txt");
    assert_eq!(m.derived, [d.join("node_modules")]);
    assert_eq!(m.temporaries, [d.join(".a.txt.root3-1-0")]);
    // Every block once: the repo's and the derived folder's together are the folder's, counted by fs/size.rs alone.
    assert_eq!(m.allocated + crate::fs::size::allocated(&m.derived[0]), crate::fs::size::allocated(&d));
    let newest = ["a.txt", "src/b.rs", "package.json"].iter()
        .map(|f| millis(&fs::metadata(d.join(f)).unwrap())).max().unwrap();
    assert!(m.modified >= newest);
    assert_eq!(measure(&d.join("nothing")), Measure::default());
    let _ = fs::remove_dir_all(&d);
}
