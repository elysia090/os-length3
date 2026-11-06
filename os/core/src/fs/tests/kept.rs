//! The tests of fs/kept.rs.

use super::*;
use std::cell::Cell;

#[test]
fn a_figure_is_measured_once_until_asked_fresh_or_forgotten() {
    let kept: Kept<u64> = Kept::new();
    let walks = &Cell::new(0);
    let measure = |n: u64| move || { walks.set(walks.get() + 1); n };
    let at = Path::new("/a/repo");
    assert_eq!(kept.of(at, false, measure(1)), (1, false));
    // Asked again, the kept figure, however the folder has changed since.
    assert_eq!(kept.of(at, false, measure(2)), (1, true));
    assert_eq!(walks.get(), 1);
    // Fresh: measured now, and kept so.
    assert_eq!(kept.of(at, true, measure(3)), (3, false));
    assert_eq!(kept.of(at, false, measure(4)), (3, true));
    // Another folder is its own; forgotten, each is measured again.
    assert_eq!(kept.of(Path::new("/b"), false, measure(5)), (5, false));
    kept.forget();
    assert_eq!(kept.of(at, false, measure(6)), (6, false));
    assert_eq!(walks.get(), 4);
}
