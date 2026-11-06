//! The tests of device/desktop.rs.

use super::*;

#[test]
fn one_app_holds_the_device_and_answers_what_it_is_asked() {
    let data = crate::testing::dir("length3-desktop");
    let _ = std::fs::remove_dir_all(&data);
    // None open: nothing answers, and the first to start holds the device.
    assert_eq!(ask(&data, "here"), None);
    // A socket left by an app that ended is taken over.
    crate::disk::write::private_dir(&dir(&data)).unwrap();
    std::fs::write(socket(&data), "").unwrap();
    let held = hold(&data).unwrap().expect("the first app holds it");
    // A second, while the first runs, does not: it shows the first instead.
    assert!(hold(&data).unwrap().is_none());
    std::thread::spawn(move || held.serve(|w| if w == "here" { "here".into() } else { format!("asked {w}") }));
    assert_eq!(ask(&data, "here").as_deref(), Some("here"));
    assert_eq!(ask(&data, "show").as_deref(), Some("asked show"));
    // Only the person reaches it: its folder is theirs alone.
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir(&data)).unwrap().permissions().mode() & 0o777, 0o700);
    let _ = std::fs::remove_dir_all(&data);
}
