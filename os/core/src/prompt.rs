//! What a running Prompt holds of the host, read from the host's own /proc:
//! its processes are exactly those in its pid namespace (launch.rs gives
//! each Prompt one), and what they hold is their proportional share of
//! memory (Pss; resident size where Pss cannot be read). Stopping is only
//! called done once none of them is left, and how long the host took to
//! get their memory back is measured, not assumed.

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

/// The pid namespace a host process is in (the inode of /proc/PID/ns/pid).
pub fn pid_ns(pid: u32) -> Option<u64> {
    let link = fs::read_link(format!("/proc/{pid}/ns/pid")).ok()?;
    let s = link.to_string_lossy();
    s.strip_prefix("pid:[")?.strip_suffix(']')?.parse().ok()
}

/// Whether a process has ended and only waits to be reaped (it holds nothing).
pub(crate) fn zombie(pid: u32) -> bool {
    // The state follows the command name, which is in parentheses and may hold spaces.
    fs::read_to_string(format!("/proc/{pid}/stat")).ok()
        .and_then(|t| t.rsplit_once(')').map(|(_, rest)| rest.trim_start().starts_with('Z')))
        .unwrap_or(false)
}

/// Host pids of every live process in namespace `ns` (an ended one waiting
/// to be reaped holds no memory and runs nothing, so it is not counted).
pub fn members(ns: u64) -> Vec<u32> {
    let Ok(dir) = fs::read_dir("/proc") else { return Vec::new() };
    dir.flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter(|&p| pid_ns(p) == Some(ns) && !zombie(p))
        .collect()
}

fn field_kb(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|l| l.strip_prefix(name)?.trim().strip_suffix("kB")?.trim().parse().ok())
}

/// Bytes a process holds: its Pss, else its resident set.
pub fn holds(pid: u32) -> u64 {
    if let Some(kb) = fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok().as_deref().and_then(|t| field_kb(t, "Pss:")) {
        return kb * 1024;
    }
    fs::read_to_string(format!("/proc/{pid}/status")).ok().as_deref().and_then(|t| field_kb(t, "VmRSS:")).unwrap_or(0) * 1024
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq)]
pub struct Held {
    pub processes: u32,
    pub memory: u64,
}

/// What the namespace's processes hold now.
pub fn held(ns: u64) -> Held {
    let pids = members(ns);
    Held { processes: pids.len() as u32, memory: pids.iter().map(|&p| holds(p)).sum() }
}

/// The first child of `supervisor` (the Prompt's pid 1), once it exists.
pub fn init_of(supervisor: u32) -> Option<u32> {
    let t = fs::read_to_string(format!("/proc/{supervisor}/task/{supervisor}/children")).ok()?;
    t.split_whitespace().next()?.parse().ok()
}

/// The pid namespace of the Prompt `supervisor` runs: its pid 1's, the first process down from it in a
/// namespace of its own. While the Prompt is prepared that is a process further down (launch::set_up runs
/// its own Prompt in a child), and the child between is still in the host's, which is not the Prompt's.
pub fn ns_of(supervisor: u32) -> Option<u64> {
    let host = pid_ns(supervisor)?;
    let mut at = supervisor;
    for _ in 0..2 {
        at = init_of(at)?;
        let ns = pid_ns(at)?;
        if ns != host { return Some(ns); }
    }
    None
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Stopped {
    /// What it held just before.
    pub before: Held,
    /// Processes still there when the wait ended (0 means stopped).
    pub left: u32,
    /// How long until none was left, if that was seen.
    pub ms: Option<u64>,
}

/// Wait (up to `limit`) for namespace `ns` to have no process left.
pub fn wait_empty(ns: u64, before: Held, limit: Duration) -> Stopped {
    let started = Instant::now();
    loop {
        let left = members(ns).len() as u32;
        if left == 0 {
            return Stopped { before, left, ms: Some(started.elapsed().as_millis() as u64) };
        }
        if started.elapsed() >= limit {
            return Stopped { before, left, ms: None };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// ---- the Prompts running on this device ----
//
// Each `l3 prompt` records itself from the moment it starts, through its
// `.packages` and `.setup` (launch::set_up), until it ends (the app's
// Prompts are `l3 prompt REPO` too): `<data>/prompts/<pid>.json`, with its
// repo, the root it runs on, whether it is still being prepared, whether it
// has the network, and when its process started, so a pid the host has
// given to another process since is never taken for it. A record whose
// process is gone (it was killed) is let go when the list is read. What a
// record names the Prompt holds: its repo, with the repo's environment,
// caches and what is derived in it, and its root; none of it is freed while
// the record is there (usage.rs).

/// A Prompt running here: its supervisor's pid (the `l3 prompt` process).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Running {
    pub repo: String,
    pub pid: u32,
    pub network: bool,
    /// The root it runs on, by its digest (its directory in the system directory); none in a record an
    /// older l3 made, which does not say.
    #[serde(default)]
    pub root: Option<String>,
    /// Still being prepared: its `.packages` and `.setup` run before its shell does.
    #[serde(default)]
    pub preparing: bool,
    /// When it started, in ms since the epoch.
    pub started: u64,
    /// The process's start time as the host counts it (/proc/PID/stat), to know it again.
    #[serde(rename = "startTicks")]
    pub start_ticks: u64,
}

fn records(data: &Path) -> std::path::PathBuf {
    data.join("prompts")
}

/// When process `pid` started, in the host's clock ticks since boot.
pub(crate) fn start_ticks(pid: u32) -> Option<u64> {
    let t = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // After the command's name (in parentheses, which may hold anything), the state is field 3; the start time is field 22.
    t.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}

/// This Prompt's record while it is kept; it goes when this is dropped (or the process is killed, at the next read).
pub struct Recorded(std::path::PathBuf, Running);

impl Recorded {
    /// Prepared: from here on its shell runs.
    pub fn ready(&mut self) -> std::io::Result<()> {
        self.1.preparing = false;
        write(&self.0, &self.1)
    }
}

impl Drop for Recorded {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Record that this process starts a Prompt of `repo` on the root whose tree is `root` (launch::Sandbox's),
/// being prepared until it is `ready`. Written under usage::lock, and only while that root is whole: one
/// freed since it was read as current is not run on, and once this is written it is not freed.
pub fn record(data: &Path, repo: &str, network: bool, root: &Path) -> std::io::Result<Recorded> {
    record_as(data, std::process::id(), repo, network, root)
}

fn record_as(data: &Path, pid: u32, repo: &str, network: bool, root: &Path) -> std::io::Result<Recorded> {
    let dir = records(data);
    crate::boundary::private_dir(&dir)?;
    let start_ticks = start_ticks(pid).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("/proc/{pid}/stat")))?;
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let _still = crate::usage::lock(data)?;
    let Some(digest) = root.parent().filter(|d| d.join("installed.json").is_file()).and_then(|d| d.file_name()) else {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound,
            crate::tr!("Its root was freed as it started; start it again", "始めるあいだに root が空けられました。もう一度始めてください")));
    };
    let r = Running { repo: repo.into(), pid, network, root: Some(digest.to_string_lossy().into_owned()), preparing: true, started, start_ticks };
    let path = dir.join(format!("{pid}.json"));
    write(&path, &r)?;
    Ok(Recorded(path, r))
}

fn write(path: &Path, r: &Running) -> std::io::Result<()> {
    // Whole or not at all: `running` lets go of a record it cannot read, so one seen half written was
    // taken for a Prompt that had gone, while it ran (bug: it was written in place).
    crate::atomic::replace(path, &serde_json::to_vec(r).map_err(std::io::Error::other)?, crate::atomic::How::RECORD)
}

/// The Prompts running here, oldest first.
pub fn running(data: &Path) -> Vec<Running> {
    let Ok(dir) = fs::read_dir(records(data)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "json") { continue; }
        let read = match fs::read(&path) {
            Ok(b) => b,
            // Gone since the listing: nothing to let go, and removing by its name could take a record made
            // there since (the test below lost one so).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => Vec::new(),
        };
        match serde_json::from_slice::<Running>(&read) {
            Ok(r) if start_ticks(r.pid) == Some(r.start_ticks) && !zombie(r.pid) => out.push(r),
            // Its process is gone (or the pid is another's now), or it is no record: nothing runs.
            _ => { let _ = fs::remove_file(&path); }
        }
    }
    out.sort_by_key(|r| (r.started, r.pid));
    out
}

/// What a running Prompt's processes hold now (its pid 1 and all under it; while it is prepared, those
/// preparing it).
pub fn held_by(r: &Running) -> Option<Held> {
    ns_of(r.pid).map(held)
}

/// Stop a Prompt as the app does: its supervisor is killed, and with it
/// (PDEATHSIG, then the pid namespace) every process inside; it is called
/// stopped only once the host shows none left.
pub fn stop(data: &Path, r: &Running) -> Stopped {
    let ns = ns_of(r.pid);
    let before = ns.map(held).unwrap_or(Held { processes: 0, memory: 0 });
    // Only the process it was: a pid given to another since is left alone.
    if start_ticks(r.pid) == Some(r.start_ticks) {
        unsafe { libc::kill(r.pid as libc::pid_t, libc::SIGKILL) };
    }
    let _ = fs::remove_file(records(data).join(format!("{}.json", r.pid)));
    match ns {
        Some(ns) => wait_empty(ns, before, Duration::from_secs(3)),
        None => Stopped { before, left: 0, ms: None },
    }
}

/// Where l3 is for the app: beside it (installed together), unless named.
pub fn l3_path(app: &Path) -> std::path::PathBuf {
    std::env::var_os("LENGTH3_L3").map(Into::into).unwrap_or_else(|| app.with_file_name("l3"))
}

#[cfg(test)]
mod tests {
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
        let data = std::env::temp_dir().join(format!("length3-prompts-{}", std::process::id()));
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
        let all = running(&data);
        assert_eq!(all.iter().map(|r| (r.repo.as_str(), r.network)).collect::<Vec<_>>(), [("here", false), ("there", true)]);
        assert!(!records(&data).join("4194304.json").exists() && !records(&data).join("reused.json").exists(), "what is gone is let go");
        // Stopped: its process is killed, and it is not running any more.
        let s = stop(&data, &all[1]);
        assert_eq!(s.left, 0);
        assert!(!child.wait().unwrap().success());
        drop(theirs);
        assert_eq!(running(&data).iter().map(|r| r.repo.as_str()).collect::<Vec<_>>(), ["here"]);
        drop(mine);
        assert!(running(&data).is_empty());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_record_being_written_is_never_taken_for_one_whose_prompt_is_gone() {
        let data = std::env::temp_dir().join(format!("length3-prompts-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Another l3 (or the app) looking at what runs, all the while.
        let looking = {
            let (data, stop) = (data.clone(), stop.clone());
            std::thread::spawn(move || while !stop.load(std::sync::atomic::Ordering::Relaxed) { running(&data); })
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
        let data = std::env::temp_dir().join(format!("length3-prompts-prep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let root = a_root(&data, &"a".repeat(64));
        let mut r = record(&data, "here", false, &root).unwrap();
        let seen = running(&data);
        assert_eq!(seen.iter().map(|r| (r.repo.as_str(), r.root.clone(), r.preparing)).collect::<Vec<_>>(), [("here", Some("a".repeat(64)), true)]);
        r.ready().unwrap();
        assert!(!running(&data)[0].preparing, "prepared, it runs");
        drop(r);
        // Killed while it was prepared (its process gone, its record left): it holds nothing any more.
        fs::write(records(&data).join("4194304.json"), format!(r#"{{"repo":"here","pid":4194304,"network":false,"root":"{}","preparing":true,"started":1,"startTicks":1}}"#, "a".repeat(64))).unwrap();
        assert!(running(&data).is_empty() && !records(&data).join("4194304.json").exists());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_root_freed_before_it_is_recorded_is_not_run_on() {
        let data = std::env::temp_dir().join(format!("length3-prompts-gone-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let root = a_root(&data, "abc");
        // Read as current, then freed before the Prompt recorded it (under the lock, as 空ける does).
        let still = crate::usage::lock(&data).unwrap();
        let starting = { let (data, root) = (data.clone(), root.clone()); std::thread::spawn(move || record(&data, "here", false, &root).map(|_| ())) };
        std::thread::sleep(Duration::from_millis(200));
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
        drop(still);
        let e = starting.join().unwrap().unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::NotFound, "{e}");
        assert!(running(&data).is_empty(), "nothing is recorded for it");
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
            for p in members(ns) { unsafe { libc::kill(p as libc::pid_t, libc::SIGKILL) }; }
        } else {
            eprintln!("skipped: no user namespace here");
            let _ = sup.kill();
        }
        let _ = sup.wait();
    }
}
