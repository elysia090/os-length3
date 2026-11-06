//! The tests of device/prompts.rs.

use super::*;

#[test]
fn this_process_is_counted_in_its_own_namespace() {
    let me = std::process::id();
    let ns = pid_ns(me).expect("a pid namespace");
    assert!(members(ns).contains(&me));
    let h = held(ns);
    assert!(h.processes >= 1 && h.memory > 0, "{h:?}");
    assert!(holds(me) > 0);
}

/// A root held in `data` (only what says it is whole), and its tree, as a Prompt is given it.
fn a_root(data: &Path, sha: &str) -> std::path::PathBuf {
    let dir = crate::root::system_dir(data).join(sha);
    fs::create_dir_all(dir.join("root/bin")).unwrap();
    fs::write(dir.join("installed.json"), format!(r#"{{"name":"OS","version":"1","sha256":"{sha}","files":0,"bytes":0}}"#)).unwrap();
    dir.join("root")
}

#[test]
fn a_running_prompt_is_listed_while_its_process_runs_and_stopped_with_it() {
    let data = crate::fs::testing::dir("length3-prompts");
    let _ = fs::remove_dir_all(&data);
    let root = a_root(&data, "abc");
    // This process stands for one Prompt; a child that waits on its input for another.
    let mine = record(&data, "here", false, &root).unwrap();
    let mut child = std::process::Command::new("cat").stdin(std::process::Stdio::piped()).spawn().unwrap();
    let theirs = record_as(&data, child.id(), "there", true, &root).unwrap();
    // A record left by a process that is gone (an older l3's, which said no root), and one whose pid another process has now.
    fs::write(records(&data).join("4194304.json"), r#"{"repo":"gone","pid":4194304,"network":false,"started":1,"startTicks":1}"#).unwrap();
    let reused = Running { repo: "reused".into(), pid: std::process::id(), network: false, root: None, preparing: false, started: 2, start_ticks: start_ticks(std::process::id()).unwrap() + 1 };
    fs::write(records(&data).join("reused.json"), serde_json::to_vec(&reused).unwrap()).unwrap();
    let held = all(&data);
    assert_eq!(held.iter().map(|r| (r.repo.as_str(), r.network)).collect::<Vec<_>>(), [("here", false), ("there", true)]);
    assert!(!records(&data).join("4194304.json").exists() && !records(&data).join("reused.json").exists(), "what is gone is let go");
    // Stopped: its process is killed, and it is not running any more.
    let s = stop(&data, &held[1]);
    assert_eq!(s.left, 0);
    assert!(!child.wait().unwrap().success());
    drop(theirs);
    assert_eq!(all(&data).iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(), ["here"]);
    drop(mine);
    assert!(all(&data).is_empty());
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_record_being_written_is_never_taken_for_one_whose_prompt_is_gone() {
    let data = crate::fs::testing::dir("length3-prompts-race");
    let _ = fs::remove_dir_all(&data);
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Another l3 (or the app) looking at what runs, all the while.
    let looking = {
        let (data, stop) = (data.clone(), stop.clone());
        std::thread::spawn(move || while !stop.load(std::sync::atomic::Ordering::Relaxed) { all(&data); })
    };
    let root = a_root(&data, "abc");
    let mut lost = 0;
    for _ in 0..200 {
        let mut kept = record(&data, "here", false, &root).unwrap();
        if !kept.0.exists() { lost += 1; }
        // Prepared: written again, whole, while it is looked at.
        kept.ready().unwrap();
        if !kept.0.exists() { lost += 1; }
        drop(kept);
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    looking.join().unwrap();
    assert_eq!(lost, 0, "records let go while their Prompt ran");
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_prompt_is_recorded_from_its_preparing_with_the_root_it_runs_on() {
    let data = crate::fs::testing::dir("length3-prompts-prep");
    let _ = fs::remove_dir_all(&data);
    let root = a_root(&data, &"a".repeat(64));
    let mut r = record(&data, "here", false, &root).unwrap();
    let seen = all(&data);
    assert_eq!(seen.iter().map(|r| (r.repo.as_str(), r.root.clone(), r.preparing)).collect::<Vec<_>>(), [("here", Some("a".repeat(64)), true)]);
    r.ready().unwrap();
    assert!(!all(&data)[0].preparing, "prepared, it runs");
    drop(r);
    // Killed while it was prepared (its process gone, its record left): it holds nothing any more.
    fs::write(records(&data).join("4194304.json"), format!(r#"{{"repo":"here","pid":4194304,"network":false,"root":"{}","preparing":true,"started":1,"startTicks":1}}"#, "a".repeat(64))).unwrap();
    assert!(all(&data).is_empty() && !records(&data).join("4194304.json").exists());
    let _ = fs::remove_dir_all(&data);
}

#[test]
fn a_root_freed_before_it_is_recorded_is_not_run_on() {
    let data = crate::fs::testing::dir("length3-prompts-gone");
    let _ = fs::remove_dir_all(&data);
    let root = a_root(&data, "abc");
    // Read as current, then freed before the Prompt recorded it (under the lock, as 空ける does).
    let still = crate::fs::size::lock(&data).unwrap();
    let starting = { let (data, root) = (data.clone(), root.clone()); std::thread::spawn(move || record(&data, "here", false, &root).map(|_| ())) };
    std::thread::sleep(Duration::from_millis(200));
    fs::remove_dir_all(root.parent().unwrap()).unwrap();
    drop(still);
    let e = starting.join().unwrap().unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::NotFound, "{e}");
    assert!(all(&data).is_empty(), "nothing is recorded for it");
    let _ = fs::remove_dir_all(&data);
}

/// While a Prompt is prepared, its supervisor's child is still the host's (launch::set_up runs a Prompt
/// of its own in it): its namespace is the one under that, never the host's.
#[test]
fn a_prompt_being_prepared_is_measured_in_its_own_namespace() {
    // A shell (the supervisor) that keeps a child, which makes a namespace and a pid 1 in it, as launch does.
    let Ok(mut sup) = std::process::Command::new("sh").args(["-c", "unshare -Urpf sleep 30; true"]).stderr(std::process::Stdio::null()).spawn() else { return };
    let me = pid_ns(std::process::id()).unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    let ns = loop {
        if let Some(ns) = ns_of(sup.id()) { break Some(ns); }
        // This host lends no user namespace: there is nothing under it to find.
        if sup.try_wait().unwrap().is_some() || Instant::now() > end { break None; }
        std::thread::sleep(Duration::from_millis(20));
    };
    if let Some(ns) = ns {
        assert_ne!(ns, me, "the host's namespace is not the Prompt's");
        assert_eq!(held(ns).processes, 1, "its pid 1 alone");
        let r = Running { repo: "here".into(), pid: sup.id(), network: false, root: None, preparing: true, started: 0, start_ticks: start_ticks(sup.id()).unwrap() };
        assert_eq!(held_by(&r).map(|h| h.processes), Some(1));
        // Its pid 1 ended, the child between ends with it, then the shell.
        for p in members(ns) { signal(p, Signal::Kill); }
    } else {
        eprintln!("skipped: no user namespace here");
        let _ = sup.kill();
    }
    let _ = sup.wait();
}
