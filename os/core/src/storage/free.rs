//! 空ける: what can go, looked at again just before it goes; room made by itself when the device is short, in an
//! order that never takes what only this device has; and room made for what comes (a repo brought, a root fetched).

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use serde::Serialize;
use std::fs;
use crate::fs::size::{allocated, blocks, links};
use crate::fs::lock::lock;
use std::path::Path;
use std::time::{Duration, Instant};
use super::items::{Certainty, Held, host, InUse, Item, item, Room, space, system};

/// Another distribution's root fetched and installed (root/fetch.rs fetch_distro), room made for it first.
#[cfg(not(target_os = "wasi"))]
pub fn fetch_distro(data: &Path, remote: &str, d: &crate::root::Distro, progress: impl FnMut(crate::device::download::Progress)) -> Result<crate::root::Installed, String> {
    crate::root::fetch_distro(data, remote, d, |want| { make_room(data, &crate::fs::paths::repos_dir(), want); }, progress)
}

/// The newest pinned root fetched and installed (root/fetch.rs fetch_and_install), room made for it first.
#[cfg(not(target_os = "wasi"))]
pub fn fetch_root(data: &Path, remote: &str, progress: impl FnMut(crate::device::download::Progress)) -> Result<crate::root::Installed, String> {
    crate::root::fetch_and_install(data, remote, |want| { make_room(data, &crate::fs::paths::repos_dir(), want); }, progress)
}

/// A repo brought here from the Remote (compute/vm.rs fetch), room made for it first if the device is short.
pub fn bring_repo(repos: &crate::repos::store::Repos, repo: &str) -> Result<crate::remote::Synced, String> {
    crate::remote::fetch(repos, repo, || { make_room(&crate::fs::paths::data_dir(), &crate::fs::paths::repos_dir(), 0); })
}

fn remove_leftover(data: &Path, path: &Path) -> Result<u64, String> {
    match path.symlink_metadata() {
        Ok(m) if m.is_file() && links(&m) == 1 => fs::remove_file(path).map(|_| blocks(&m)).map_err(|e| e.to_string()),
        // Directories are only ever the system's own (an unpacking).
        Ok(m) if m.is_dir() && path.starts_with(crate::root::system_dir(data)) => {
            let size = allocated(path);
            fs::remove_dir_all(path).map(|_| size).map_err(|e| e.to_string())
        }
        Ok(_) => Err(crate::tr!("It is not a temporary file any more", "もう一時ファイルではありません")),
        Err(_) => Ok(0),
    }
}

/// What `make_room` lets go, in its order, until `need` bytes: of `items`, those that can go now, ranked leftovers and
/// old roots, caches, derived trees, the root before (`previous`), then repos untouched (`touched`, ms) for a week
/// before `now`, the longest untouched first; the largest first within a rank.
pub(super) fn room_order(items: &[Item], previous: &[String], touched: &std::collections::HashMap<String, u64>, now: u64, need: u64) -> Vec<String> {
    const WEEK: u64 = 7 * 24 * 60 * 60 * 1000;
    let mut ranked: Vec<(u8, u64, &Item)> = items.iter().filter(|i| i.room == Room::Free).filter_map(|i| {
        let rank = match i.id.split_once(':').map_or("", |(k, _)| k) {
            "path" => 0,
            "root" if previous.contains(&i.id) => 3,
            "root" => 0,
            "cache" => 1,
            "derived" => 2,
            "repo" => { let at = *touched.get(&i.id)?; if now.saturating_sub(at) < WEEK { return None; } return Some((4, at, i)); }
            _ => return None,
        };
        Some((rank, u64::MAX - i.allocated, i))
    }).collect();
    ranked.sort_by_key(|(rank, order, _)| (*rank, *order));
    let (mut ids, mut gets) = (Vec::new(), 0u64);
    for (_, _, i) in ranked {
        if gets >= need { break; }
        ids.push(i.id.clone());
        gets += i.allocated;
    }
    ids
}

/// Room wanted on this device: `want` bytes more (a root, a repo brought here, a Prompt prepared) and a reserve
/// besides (a twentieth of the disk, between 512 MB and 4 GB; `LENGTH3_RESERVE` says another, in bytes). While the host has that, nothing happens. Short of
/// it, what is made again or kept elsewhere goes by itself until there is enough, in this order: this OS's own
/// leftovers and old roots, the caches, what is derived in repos (made again by the tools that made it), the root
/// before the current one, then copies of repos in step with the Remote and untouched for a week, the oldest first
/// (opened, each comes back). Never what only this device has: work not sent, an environment (what its Prompts
/// installed), what a Prompt holds now. What went, as `free` says it; None when nothing had to.
pub fn make_room(data: &Path, repos_dir: &Path, want: u64) -> Option<Freed> {
    let (total, free_now, certainty) = host(data);
    if certainty == Certainty::Unknown || total == 0 { return None; }
    let reserve = std::env::var("LENGTH3_RESERVE").ok().and_then(|v| v.parse().ok()).unwrap_or((total / 20).clamp(512 << 20, 4 << 30));
    let need = (want + reserve).checked_sub(free_now).filter(|n| *n > 0)?;
    let s = space(data, repos_dir, &[]);
    let previous: Vec<String> = system(data).into_iter().filter(|(r, _)| r.held == Held::Previous).map(|(r, _)| format!("root:{}", r.sha256)).collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let touched: std::collections::HashMap<String, u64> = crate::repos::store::Repos::new(repos_dir.to_path_buf()).and_then(|r| r.list())
        .map(|l| l.into_iter().map(|x| (format!("repo:{}", x.name), x.modified)).collect()).unwrap_or_default();
    let ids = room_order(&s.items, &previous, &touched, now, need);
    if ids.is_empty() { return None; }
    Some(free(data, repos_dir, &ids, &[]))
}

/// Free these ids, each looked at again (alone: nothing else is walked)
/// just before it goes, under `lock`; then say what the host shows for it.
pub fn free(data: &Path, repos_dir: &Path, ids: &[String], open: &[String]) -> Freed {
    let (_, before, certainty) = host(data);
    let (mut freed, mut removed, mut kept) = (0, Vec::new(), Vec::new());
    for id in ids {
        // Held from the look to the removal: a Prompt starting, or a root made current, meanwhile waits.
        let still = match lock(data) {
            Ok(l) => l,
            Err(e) => { kept.push((id.clone(), e.to_string())); continue; }
        };
        let Some(item) = item(data, repos_dir, id, &InUse::now(data, open)) else {
            kept.push((id.clone(), crate::tr!("It is gone already", "もうありません")));
            continue;
        };
        if item.room == Room::Keep {
            kept.push((id.clone(), item.why.clone()));
            continue;
        }
        let gone: Result<u64, String> = if let Some(name) = id.strip_prefix("repo:") {
            // Sending it first can take long, and no Prompt waits on that to start: a repo one opens meanwhile
            // is kept by the free's own look at what holds the copy, just before it goes (remote::free).
            drop(still);
            crate::repos::store::Repos::new(repos_dir.to_path_buf()).and_then(|r| crate::remote::free(&r, name))
        } else if let Some(sha) = id.strip_prefix("root:") {
            let dir = crate::root::system_dir(data).join(sha);
            let size = allocated(&dir);
            fs::remove_dir_all(&dir).map(|_| size).map_err(|e| e.to_string())
        } else if let Some(repo) = id.strip_prefix("env:") {
            remove_owned(&crate::prompt::writes::env_dir(data, repo))
        } else if let Some(repo) = id.strip_prefix("cache:") {
            remove_owned(&crate::prompt::writes::cache_dir(data, repo))
        } else if let Some(repo) = id.strip_prefix("derived:") {
            crate::prompt::writes::derived_in(&repos_dir.join(repo)).iter().try_fold(0, |n, p| remove_owned(p).map(|k| n + k))
        } else if let Some(path) = id.strip_prefix("path:") {
            remove_leftover(data, Path::new(path))
        } else {
            Err(crate::tr!("This cannot be freed", "空けられません"))
        };
        match gone {
            Ok(n) => { freed += n; removed.push(id.clone()); }
            Err(e) => kept.push((id.clone(), e)),
        }
    }
    let started = Instant::now();
    let mut after = before;
    let mut reflected = None;
    // A host that cannot say how much room it has (no adapter for it: the browser's core) is not waited on.
    if certainty != Certainty::Unknown {
        loop {
            after = host(data).1;
            if freed == 0 || after >= before.saturating_add(freed) {
                reflected = Some(started.elapsed().as_millis() as u64);
                break;
            }
            if started.elapsed() >= WAIT { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Freed {
        freed, freed_certainty: Certainty::Verified, removed, kept,
        host_free_before: before, host_free_after: after,
        host_change: certainty, reflected_ms: if freed == 0 { Some(0) } else { reflected },
    }
}

/// Remove a repo's environment or caches: the overlay leaves a scratch directory no one may read, so
/// every directory is made the owner's own first.
fn remove_owned(dir: &Path) -> Result<u64, String> {
    fn open_up(dir: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) { open_up(&e.path()); }
        }
    }
    let size = allocated(dir);
    open_up(dir);
    fs::remove_dir_all(dir).map(|_| size).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, Clone)]
pub struct Freed {
    /// Allocated bytes of what went, counted just before it went.
    pub freed: u64,
    pub freed_certainty: Certainty,
    /// The ids that went.
    pub removed: Vec<String>,
    /// What stayed, and why.
    pub kept: Vec<(String, String)>,
    pub host_free_before: u64,
    pub host_free_after: u64,
    pub host_change: Certainty,
    /// How long the host took to show at least the freed room (None: not
    /// seen within the wait).
    pub reflected_ms: Option<u64>,
}

const WAIT: Duration = Duration::from_secs(2);

