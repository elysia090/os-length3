//! What a running Prompt holds of the host, read from the host's own /proc:
//! its processes are exactly those in its pid namespace (prompt/launch.rs gives
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

/// CPU the namespace has used, in ms: what each live process used (user and system), and what each one reaped
/// used (its children's, which the kernel adds to it as it waits for them; pid 1 waits for every orphan). So every
/// process that was ever in it is counted once, ended or not.
pub fn cpu_ms(ns: u64) -> u64 {
    let hz = clock_ticks();
    let ticks: u64 = members(ns).iter().filter_map(|p| {
        let t = fs::read_to_string(format!("/proc/{p}/stat")).ok()?;
        // After the command's name (in parentheses, which may hold anything): utime, stime, cutime, cstime are the
        // 12th to 15th fields.
        let f: Vec<u64> = t.rsplit_once(')')?.1.split_whitespace().skip(11).take(4).filter_map(|x| x.parse().ok()).collect();
        (f.len() == 4).then(|| f.iter().sum::<u64>())
    }).sum();
    ticks * 1000 / hz
}

/// Pause (every process in the namespace stopped: all it holds stays, it uses no CPU) or go on. How many were told.
pub fn pause(ns: u64, paused: bool) -> usize {
    let sig = if paused { Signal::Stop } else { Signal::Cont };
    members(ns).into_iter().filter(|&p| signal(p, sig)).count()
}

/// A signal for a process of a Prompt's.
#[derive(Clone, Copy)]
pub enum Signal { Stop, Cont, Kill }

/// `sig` sent to `pid`: whether it was. Where Prompts never run on the root (Windows: they run translated, as in a
/// browser), there is no process of one to send it to.
#[cfg(unix)]
pub fn signal(pid: u32, sig: Signal) -> bool {
    let s = match sig { Signal::Stop => libc::SIGSTOP, Signal::Cont => libc::SIGCONT, Signal::Kill => libc::SIGKILL };
    // SAFETY: kill sends a signal to a pid; no memory is passed.
    unsafe { libc::kill(pid as libc::pid_t, s) == 0 }
}
#[cfg(not(unix))]
pub fn signal(_pid: u32, _sig: Signal) -> bool { false }

/// Clock ticks a second, as /proc/<pid>/stat counts CPU in them.
#[cfg(unix)]
fn clock_ticks() -> u64 {
    // SAFETY: sysconf reads a constant of the system; no memory is passed.
    (unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).max(1) as u64
}
#[cfg(not(unix))]
fn clock_ticks() -> u64 { 100 }

/// The first child of `supervisor` (the Prompt's pid 1), once it exists.
fn init_of(supervisor: u32) -> Option<u32> {
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
// the record is there (storage/).

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
    crate::fs::write::private_dir(&dir)?;
    let start_ticks = start_ticks(pid).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("/proc/{pid}/stat")))?;
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let _still = crate::fs::lock::lock(data)?;
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
    crate::fs::write::replace(path, &serde_json::to_vec(r).map_err(std::io::Error::other)?, crate::fs::write::How::RECORD)
}

/// The Prompts running here, oldest first.
pub fn all(data: &Path) -> Vec<Running> {
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

/// The pid namespace of a running Prompt (its pid 1's).
pub fn ns_of_record(r: &Running) -> Option<u64> {
    ns_of(r.pid)
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
        signal(r.pid, Signal::Kill);
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
#[path = "tests/running.rs"]
mod tests;
