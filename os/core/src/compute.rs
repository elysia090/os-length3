//! Compute, in time and in space: what a run is wherever it runs (Spec), what it may use (Budget), what it used
//! (Usage, read from the kernel, never assumed), and every run's account (the ledger).
//!
//! A Spec names what a run is made of, never where it is: the root by its sha256 (root.rs pins it), the
//! environment by the key of what set it up (launch.rs environment_key), the repo by its name and line, and what
//! runs, with what it is told, the network it may have, and its budget. This device builds the run from it
//! (`l3 agent inside`), and a place elsewhere that can fetch by digest (another device, a machine in the cloud)
//! is given the same Spec and builds the same run: nothing in it says this machine. What it may use is checked
//! where it runs, not where it was asked for: the network only as the repo was given it there.
//!
//! Time is counted as the kernel counts it: CPU in ms of every process ever in the run's namespace (prompt.rs
//! cpu_ms), wall time from its start; space as what its processes hold (their proportional share of memory) and
//! how many there are. A run is watched every quarter second; past its budget it is stopped, and what it went
//! past is said. A run paused keeps all it holds and uses no CPU until it goes on (prompt.rs pause).

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What a run may use. None: no bound of that kind.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Budget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<u64>,
    /// Bytes its processes may hold at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processes: Option<u64>,
}

/// What a run used: its wall and CPU time, and the most it held at once.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage { pub wall_ms: u64, pub cpu_ms: u64, pub peak_memory: u64, pub peak_processes: u64 }

/// What of its budget a run went past.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Over { Wall, Cpu, Memory, Processes }

impl Budget {
    /// What of it `u` went past, if anything: time before space (the wall, then the CPU, then memory, then processes).
    pub fn over(&self, u: &Usage) -> Option<Over> {
        let past = |bound: Option<u64>, used: u64| bound.is_some_and(|b| used > b);
        if past(self.wall_ms, u.wall_ms) { Some(Over::Wall) }
        else if past(self.cpu_ms, u.cpu_ms) { Some(Over::Cpu) }
        else if past(self.memory, u.peak_memory) { Some(Over::Memory) }
        else if past(self.processes, u.peak_processes) { Some(Over::Processes) }
        else { None }
    }

    /// A budget of `minutes` of wall time, half this device's memory, and 4096 processes.
    pub fn minutes(minutes: u64) -> Budget {
        let total = std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| t.lines()
            .find_map(|l| l.strip_prefix("MemTotal:")?.trim().strip_suffix("kB")?.trim().parse::<u64>().ok())).map(|kb| kb * 1024);
        Budget { wall_ms: Some(minutes * 60_000), cpu_ms: None, memory: total.map(|t| t / 2), processes: Some(4096) }
    }
}

impl Over {
    /// What it went past, in the person's words.
    pub fn said(self, b: &Budget) -> String {
        let mb = |n: Option<u64>| n.unwrap_or(0) / (1 << 20);
        match self {
            Over::Wall => crate::tr!("It ran past its {} minutes and was stopped", "{} 分を過ぎたので止めました", b.wall_ms.unwrap_or(0) / 60_000),
            Over::Cpu => crate::tr!("It used more than its {} s of CPU and was stopped", "CPU を {} 秒より多く使ったので止めました", b.cpu_ms.unwrap_or(0) / 1000),
            Over::Memory => crate::tr!("It held more than {} MB of memory and was stopped", "メモリを {} MB より多く使ったので止めました", mb(b.memory)),
            Over::Processes => crate::tr!("It ran more than {} processes and was stopped", "プロセスが {} を超えたので止めました", b.processes.unwrap_or(0)),
        }
    }
}

/// What a run is, wherever it runs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Spec {
    /// The root it runs on, by its sha256.
    pub root: String,
    /// The environment over the root, by the key of what set it up (empty: the plain root).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub environment: String,
    pub repo: String,
    /// The repo's line it runs on: main, or an issue's.
    pub line: String,
    pub argv: Vec<String>,
    /// What it is told, in its environment.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
    /// Whether it asks for the network (given only where the repo has it).
    pub network: bool,
    pub budget: Budget,
}

impl Spec {
    /// What it is, as one name: the sha256 of its JSON (the same run is the same name anywhere).
    pub fn digest(&self) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(serde_json::to_vec(self).unwrap_or_default()).iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Watch the run `supervisor` supervises until `ended()` says it is over, sampling it every `every`: its CPU and
/// what it holds, the most of each kept. Past `budget`, `stop()` is called, once, and what it went past is kept.
#[cfg(target_os = "linux")]
pub fn watch(supervisor: u32, budget: &Budget, every: std::time::Duration, ended: impl Fn() -> bool, stop: impl FnOnce()) -> (Usage, Option<Over>) {
    let started = std::time::Instant::now();
    let (mut u, mut over, mut stop, mut ns) = (Usage::default(), None, Some(stop), None);
    while !ended() {
        // Its namespace once it has one (its pid 1 is made a moment after it starts).
        if ns.is_none() { ns = crate::prompt::ns_of(supervisor); }
        if let Some(ns) = ns {
            let held = crate::prompt::held(ns);
            u.cpu_ms = u.cpu_ms.max(crate::prompt::cpu_ms(ns));
            u.peak_memory = u.peak_memory.max(held.memory);
            u.peak_processes = u.peak_processes.max(held.processes as u64);
        }
        u.wall_ms = started.elapsed().as_millis() as u64;
        if over.is_none() {
            over = budget.over(&u);
            if over.is_some() { if let Some(s) = stop.take() { s(); } }
        }
        std::thread::sleep(every);
    }
    u.wall_ms = started.elapsed().as_millis() as u64;
    (u, over)
}

/// One run's account.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Run {
    /// Its Spec's digest.
    pub spec: String,
    /// Where it ran: "here" (this device), or the place that ran it.
    pub place: String,
    pub repo: String,
    pub line: String,
    /// What it was, in a word (tests, take, review, a command).
    pub what: String,
    /// When it began, in ms.
    pub at: u64,
    pub usage: Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over: Option<Over>,
    pub code: i32,
}

/// The ledger's size past which it keeps only its latest half.
const LEDGER: u64 = 1024 * 1024;

fn ledger() -> PathBuf { crate::paths::data_dir().join("compute").join("runs.jsonl") }

/// Keep `r` at the ledger's end (this device's alone, never sent).
pub fn record(r: &Run) -> Result<()> {
    crate::agents::append_line(&ledger(), &serde_json::to_string(r).map_err(|e| e.to_string())?, LEDGER)
}

/// Every run the ledger holds, oldest first.
pub fn runs() -> Vec<Run> {
    std::fs::read_to_string(ledger()).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// What each repo used of the runs since `since` (ms), the most CPU first: its runs, and their time and peak.
pub fn by_repo(runs: &[Run], since: u64) -> Vec<(String, u64, Usage)> {
    let mut out: Vec<(String, u64, Usage)> = Vec::new();
    for r in runs.iter().filter(|r| r.at >= since) {
        let at = match out.iter().position(|(n, _, _)| *n == r.repo) { Some(i) => i, None => { out.push((r.repo.clone(), 0, Usage::default())); out.len() - 1 } };
        let (_, n, u) = &mut out[at];
        *n += 1;
        u.wall_ms += r.usage.wall_ms;
        u.cpu_ms += r.usage.cpu_ms;
        u.peak_memory = u.peak_memory.max(r.usage.peak_memory);
        u.peak_processes = u.peak_processes.max(r.usage.peak_processes);
    }
    out.sort_by(|a, b| b.2.cpu_ms.cmp(&a.2.cpu_ms).then(a.0.cmp(&b.0)));
    out
}

#[cfg(test)]
mod tests {
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
        let ns = crate::prompt::pid_ns(std::process::id()).unwrap();
        let before = crate::prompt::cpu_ms(ns);
        let started = std::time::Instant::now();
        while started.elapsed() < std::time::Duration::from_millis(120) { std::hint::black_box((0..1000).sum::<u64>()); }
        assert!(crate::prompt::cpu_ms(ns) >= before + 50, "the CPU this test spun is counted");
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
}
