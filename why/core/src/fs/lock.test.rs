//! The tests of fs/lock.rs.

use super::*;

#[test]
fn a_lock_is_held_until_dropped_and_made_where_nothing_was() {
    let d = crate::fs::testing::dir("lock");
    let held = lock(&d).unwrap();
    let other = OpenOptions::new().write(true).open(d.join("prompts/.lock")).unwrap();
    assert!(other.try_lock().is_err());
    drop(held);
    assert!(other.try_lock().is_ok());
    let _ = std::fs::remove_dir_all(&d);
}
