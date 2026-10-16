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
fn zombie(pid: u32) -> bool {
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
}
