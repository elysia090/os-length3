//! The tests of run/compute.rs.

use super::*;

#[test]
fn a_budget_says_what_was_gone_past_time_before_space() {
    let b = Budget { wall_ms: Some(1000), cpu_ms: Some(500), memory: Some(100), processes: Some(2) };
    let u = |wall_ms, cpu_ms, peak_memory, peak_processes| Usage { wall_ms, cpu_ms, peak_memory, peak_processes };
    assert_eq!(b.over(&u(10, 10, 10, 1)), None);
    assert_eq!(b.over(&u(2000, 900, 900, 9)), Some(Over::Wall));
    assert_eq!(b.over(&u(10, 900, 900, 9)), Some(Over::Cpu));
    assert_eq!(b.over(&u(10, 10, 900, 9)), Some(Over::Memory));
    assert_eq!(b.over(&u(10, 10, 10, 9)), Some(Over::Processes));
    assert_eq!(Budget::default().over(&u(u64::MAX, u64::MAX, u64::MAX, u64::MAX)), None);
}

#[test]
fn a_spec_is_named_by_what_it_is_and_nothing_of_where() {
    let s = Spec { root: "a".repeat(64), environment: String::new(), repo: "notes".into(), line: "001".into(), argv: vec!["/bin/sh".into()],
        env: vec![("L3_TASK".into(), "x".into())], network: false, budget: Budget::minutes(1) };
    assert_eq!(s.digest(), s.clone().digest());
    assert_ne!(s.digest(), Spec { line: "002".into(), ..s.clone() }.digest());
    assert_eq!(serde_json::from_str::<Spec>(&serde_json::to_string(&s).unwrap()).unwrap(), s);
}

#[test]
fn what_each_repo_used_is_summed_and_its_peak_kept() {
    let r = |repo: &str, at, cpu_ms, peak_memory| Run { spec: String::new(), place: "here".into(), repo: repo.into(), line: "main".into(), what: "tests".into(),
        at, usage: Usage { wall_ms: 10, cpu_ms, peak_memory, peak_processes: 1 }, over: None, code: 0 };
    let all = [r("a", 5, 100, 7), r("b", 5, 300, 1), r("a", 6, 50, 9), r("a", 1, 999, 999)];
    let by = by_repo(&all, 5);
    assert_eq!(by.iter().map(|(n, k, u)| (n.as_str(), *k, u.cpu_ms, u.peak_memory)).collect::<Vec<_>>(), [("b", 1, 300, 1), ("a", 2, 150, 9)]);
}

/// What a namespace used is read from the kernel: CPU spun here shows in this process's own namespace.
#[cfg(target_os = "linux")]
#[test]
fn a_namespaces_cpu_is_every_process_it_ever_had() {
    // This test's own process is in the host's namespace: what it and its reaped children used is counted.
    let ns = crate::device::prompts::pid_ns(std::process::id()).unwrap();
    let before = crate::device::prompts::cpu_ms(ns);
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_millis(120) { std::hint::black_box((0..1000).sum::<u64>()); }
    assert!(crate::device::prompts::cpu_ms(ns) >= before + 50, "the CPU this test spun is counted");
}

/// A run past its wall is stopped, once, and said to have gone past it; one within it is left to end.
#[cfg(target_os = "linux")]
#[test]
fn a_run_past_its_budget_is_stopped_once() {
    use std::process::Command;
    let mut slow = Command::new("sleep").arg("5").spawn().unwrap();
    let pid = slow.id();
    let stops = std::cell::Cell::new(0);
    let started = std::time::Instant::now();
    let child = std::cell::RefCell::new(&mut slow);
    let (u, over) = watch(pid, &Budget { wall_ms: Some(200), ..Budget::default() }, std::time::Duration::from_millis(20),
        || child.borrow_mut().try_wait().ok().flatten().is_some(), || { stops.set(stops.get() + 1); let _ = child.borrow_mut().kill(); });
    assert_eq!((over, stops.get()), (Some(Over::Wall), 1));
    assert!(started.elapsed() < std::time::Duration::from_secs(3) && u.wall_ms >= 200, "{u:?}");
    let mut quick = Command::new("true").spawn().unwrap();
    let qpid = quick.id();
    let quick = std::cell::RefCell::new(&mut quick);
    let (_, over) = watch(qpid, &Budget::minutes(1), std::time::Duration::from_millis(20), || quick.borrow_mut().try_wait().ok().flatten().is_some(), || panic!("stopped"));
    assert_eq!(over, None);
}
