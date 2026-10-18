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
// Each `l3 prompt` records itself while it runs (the app's Prompts are
// `l3 prompt REPO` too): `<data>/prompts/<pid>.json`, with its repo,
// whether it has the network, and when its process started, so a pid the
// host has given to another process since is never taken for it. A record
// whose process is gone (it was killed) is let go when the list is read.

/// A Prompt running here: its supervisor's pid (the `l3 prompt` process).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Running {
    pub repo: String,
    pub pid: u32,
    pub network: bool,
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
pub struct Recorded(std::path::PathBuf);

impl Drop for Recorded {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Record that this process runs a Prompt of `repo`.
pub fn record(data: &Path, repo: &str, network: bool) -> std::io::Result<Recorded> {
    record_as(data, std::process::id(), repo, network)
}

fn record_as(data: &Path, pid: u32, repo: &str, network: bool) -> std::io::Result<Recorded> {
    let dir = records(data);
    crate::boundary::private_dir(&dir)?;
    let start_ticks = start_ticks(pid).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("/proc/{pid}/stat")))?;
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let r = Running { repo: repo.into(), pid, network, started, start_ticks };
    let path = dir.join(format!("{pid}.json"));
    fs::write(&path, serde_json::to_vec(&r).map_err(std::io::Error::other)?)?;
    Ok(Recorded(path))
}

/// The Prompts running here, oldest first.
pub fn running(data: &Path) -> Vec<Running> {
    let Ok(dir) = fs::read_dir(records(data)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in dir.flatten() {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "json") { continue; }
        match fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Running>(&b).ok()) {
            Some(r) if start_ticks(r.pid) == Some(r.start_ticks) && !zombie(r.pid) => out.push(r),
            // Its process is gone (or the pid is another's now): nothing runs.
            _ => { let _ = fs::remove_file(&path); }
        }
    }
    out.sort_by_key(|r| (r.started, r.pid));
    out
}

/// What a running Prompt's processes hold now (its pid 1 and all under it).
pub fn held_by(r: &Running) -> Option<Held> {
    init_of(r.pid).and_then(pid_ns).map(held)
}

/// Stop a Prompt as the app does: its supervisor is killed, and with it
/// (PDEATHSIG, then the pid namespace) every process inside; it is called
/// stopped only once the host shows none left.
pub fn stop(data: &Path, r: &Running) -> Stopped {
    let ns = init_of(r.pid).and_then(pid_ns);
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

    #[test]
    fn a_running_prompt_is_listed_while_its_process_runs_and_stopped_with_it() {
        let data = std::env::temp_dir().join(format!("length3-prompts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        // This process stands for one Prompt; a child that waits on its input for another.
        let mine = record(&data, "here", false).unwrap();
        let mut child = std::process::Command::new("cat").stdin(std::process::Stdio::piped()).spawn().unwrap();
        let theirs = record_as(&data, child.id(), "there", true).unwrap();
        // A record left by a process that is gone, and one whose pid another process has now.
        fs::write(records(&data).join("4194304.json"), r#"{"repo":"gone","pid":4194304,"network":false,"started":1,"startTicks":1}"#).unwrap();
        let reused = Running { repo: "reused".into(), pid: std::process::id(), network: false, started: 2, start_ticks: start_ticks(std::process::id()).unwrap() + 1 };
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
}
