//! What this OS holds on the device, measured where the host measures it,
//! and what can be given back.
//!
//! Every figure says how it is known. `logical` is the bytes files claim;
//! `allocated` is what the host's filesystem has set aside for them
//! (st_blocks), which is what returning room is about: a sparse or deleted
//! file counts only what it really holds. Host free space is what the host
//! reports for the filesystem; after a reclaim the change in it is observed,
//! not attributed, because other programs write too.
//!
//! Reclaimable means disposable by proof, not by name: today the only such
//! thing is a temporary file this OS itself writes while replacing a file
//! (`.<name>.length3-<pid>-<n>` beside it, `<key>.json.<pid>` in Home), left
//! behind when the writer died before renaming it in. It is reclaimable when
//! its writer is no longer running and it is older than a minute. Nothing in
//! a repo's .git, no file the person made, and nothing shared through a hard
//! link is ever counted or removed.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// How a figure is known.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub enum Certainty {
    /// Counted from the filesystem's own records for exactly these files.
    Verified,
    /// Observed on the host, which other programs also change.
    Estimated,
    /// This host gives no way to know.
    Unknown,
}

#[derive(Serialize, Debug, Clone)]
pub struct RepoUsage {
    pub name: String,
    pub files: u64,
    pub logical: u64,
    pub allocated: u64,
    /// Of `allocated`, what its history (.git) holds.
    pub history: u64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Leftover {
    pub path: PathBuf,
    pub allocated: u64,
}

#[derive(Serialize, Debug, Clone)]
pub struct Usage {
    pub host_total: u64,
    pub host_free: u64,
    pub host: Certainty,
    pub repos: Vec<RepoUsage>,
    /// Home's state (profile, TODO, the band).
    pub home: u64,
    pub allocated: u64,
    pub reclaimable: u64,
    pub leftovers: Vec<Leftover>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Reclaim {
    /// Allocated bytes of what was removed, counted before removal.
    pub freed: u64,
    pub freed_certainty: Certainty,
    pub removed: usize,
    /// What could not be removed, and why.
    pub kept: Vec<(PathBuf, String)>,
    pub host_free_before: u64,
    pub host_free_after: u64,
    pub host_change: Certainty,
    /// How long the host took to show at least the freed room (None: not seen
    /// within the wait).
    pub reflected_ms: Option<u64>,
}

const AGE: Duration = Duration::from_secs(60);
const WAIT: Duration = Duration::from_secs(2);

#[cfg(unix)]
fn blocks(meta: &fs::Metadata) -> u64 { use std::os::unix::fs::MetadataExt; meta.blocks() * 512 }
#[cfg(not(unix))]
fn blocks(meta: &fs::Metadata) -> u64 { meta.len() }

#[cfg(unix)]
fn links(meta: &fs::Metadata) -> u64 { use std::os::unix::fs::MetadataExt; meta.nlink() }
#[cfg(not(unix))]
fn links(_: &fs::Metadata) -> u64 { 1 }

/// Files, logical and allocated bytes under `dir`, not following links.
fn tally(dir: &Path) -> (u64, u64, u64) {
    let mut out = (0, 0, 0);
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            let (f, l, a) = tally(&e.path());
            out = (out.0 + f, out.1 + l, out.2 + a + blocks(&meta));
        } else {
            out = (out.0 + 1, out.1 + meta.len(), out.2 + blocks(&meta));
        }
    }
    out
}

/// The pid in a name this OS gives its temporary files, if it is one. A
/// setting's temporary (`<key>.json.<pid>`) is only one in the settings
/// directory: in a repo, a name like that is a person's own file.
fn temporary_writer(name: &str, in_settings: bool) -> Option<u32> {
    if let Some(rest) = name.strip_prefix('.') {
        if let Some((_, writer)) = rest.rsplit_once(".length3-") {
            return writer.split('-').next()?.parse().ok();
        }
    }
    let (stem, pid) = name.rsplit_once('.')?;
    if in_settings && stem.ends_with(".json") { pid.parse().ok() } else { None }
}

#[cfg(unix)]
fn running(pid: u32) -> bool {
    // Signal 0 checks existence; EPERM means it exists but is not ours.
    pid as libc::pid_t > 0 && (unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}
#[cfg(not(unix))]
fn running(_: u32) -> bool { true }

/// This OS's own leftovers under `dir` (never inside a repo's .git);
/// `settings` is the settings directory.
fn leftovers(dir: &Path, settings: &Path, out: &mut Vec<Leftover>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if crate::repos::is_git_name(&name) { continue; }
        let path = e.path();
        let Ok(meta) = path.symlink_metadata() else { continue };
        if meta.is_dir() { leftovers(&path, settings, out); continue; }
        if !meta.is_file() || links(&meta) != 1 { continue; }
        let Some(pid) = temporary_writer(&name, dir == settings) else { continue };
        let old = meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age >= AGE);
        if old && pid != std::process::id() && !running(pid) {
            out.push(Leftover { path, allocated: blocks(&meta) });
        }
    }
}

fn host(dir: &Path) -> (u64, u64, Certainty) {
    match crate::system::capacity(dir) {
        Ok(c) => (c.total, c.free, Certainty::Estimated),
        Err(_) => (0, 0, Certainty::Unknown),
    }
}

/// What this OS holds under `data` (repos in `repos`), and what is reclaimable.
pub fn usage(data: &Path, repos: &Path) -> Usage {
    let (host_total, host_free, host) = host(data);
    let mut list = Vec::new();
    if let Ok(entries) = fs::read_dir(repos) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !crate::repos::valid_name(&name) || !e.path().is_dir() { continue; }
            let (files, logical, allocated) = tally(&e.path());
            let history = tally(&e.path().join(".git")).2;
            list.push(RepoUsage { name, files, logical, allocated, history });
        }
    }
    list.sort_by(|a, b| b.allocated.cmp(&a.allocated).then(a.name.cmp(&b.name)));
    let home = tally(&data.join("home")).2;
    let mut left = Vec::new();
    leftovers(data, &data.join("home"), &mut left);
    let reclaimable = left.iter().map(|l| l.allocated).sum();
    Usage {
        host_total, host_free, host,
        allocated: list.iter().map(|r| r.allocated).sum::<u64>() + home,
        repos: list, home, reclaimable, leftovers: left,
    }
}

/// Give back what is reclaimable now, and say what the host shows for it.
pub fn reclaim(data: &Path) -> Reclaim {
    let mut found = Vec::new();
    leftovers(data, &data.join("home"), &mut found);
    let (_, before, certainty) = host(data);
    let mut freed = 0;
    let mut removed = 0;
    let mut kept = Vec::new();
    for l in found {
        // Looked at again just before: it may have been renamed in or reused.
        match l.path.symlink_metadata() {
            Ok(m) if m.is_file() && links(&m) == 1 => match fs::remove_file(&l.path) {
                Ok(()) => { freed += blocks(&m); removed += 1; }
                Err(e) => kept.push((l.path, e.to_string())),
            },
            Ok(_) => kept.push((l.path, "もう一時ファイルではありません".into())),
            Err(_) => {}
        }
    }
    let started = Instant::now();
    let mut after;
    let mut reflected = None;
    loop {
        after = host(data).1;
        if freed == 0 || after >= before.saturating_add(freed) {
            reflected = Some(started.elapsed().as_millis() as u64);
            break;
        }
        if started.elapsed() >= WAIT { break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    Reclaim {
        freed, freed_certainty: Certainty::Verified, removed, kept,
        host_free_before: before, host_free_after: after,
        host_change: certainty, reflected_ms: if freed == 0 { Some(0) } else { reflected },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_oss_dead_old_temporaries_are_reclaimed() {
        let data = std::env::temp_dir().join(format!("length3-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let repo = data.join("repos/a");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::write(repo.join("main.c"), vec![b'x'; 10_000]).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        // A leftover of a writer that died (pid 1 is never this OS's writer:
        // it runs, so pick a pid that cannot exist).
        let dead = repo.join(".main.c.length3-4000000-0");
        fs::write(&dead, vec![b'y'; 50_000]).unwrap();
        // Same name, but its writer is alive: this process.
        let live = repo.join(format!(".x.length3-{}", std::process::id()));
        fs::write(&live, "z").unwrap();
        // Looks like one, but lives in .git: never touched.
        let in_git = repo.join(".git/.HEAD.length3-4000000");
        fs::write(&in_git, "q").unwrap();
        // A person's own file with a similar name.
        let mine = repo.join("notes.length3-draft");
        fs::write(&mine, "mine").unwrap();
        // Named like a setting's temporary, but in a repo: a person's file.
        let dated = repo.join("data.json.2024");
        fs::write(&dated, "{}").unwrap();
        // A setting's temporary whose writer died.
        fs::create_dir_all(data.join("home")).unwrap();
        let setting = data.join("home/ui.json.4000000");
        fs::write(&setting, "{").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        for p in [&dead, &live, &in_git, &mine, &dated, &setting] {
            fs::File::options().write(true).open(p).unwrap().set_modified(old).unwrap();
        }
        let u = usage(&data, &data.join("repos"));
        let mut found = u.leftovers.iter().map(|l| l.path.clone()).collect::<Vec<_>>();
        found.sort();
        assert_eq!(found, [setting.clone(), dead.clone()]);
        assert!(u.reclaimable >= 50_000 / 4096 * 4096, "{}", u.reclaimable);
        let a = &u.repos[0];
        assert!(a.allocated >= a.history && a.logical >= 10_000 && a.files >= 3, "{a:?}");
        let r = reclaim(&data);
        assert_eq!((r.removed, r.freed_certainty), (2, Certainty::Verified));
        assert!(!dead.exists() && !setting.exists());
        assert!(live.exists() && in_git.exists() && mine.exists() && dated.exists());
        // The host's free space is shared with every other writer, so it is
        // only an observation: labelled so, never asserted.
        assert_eq!(r.host_change, Certainty::Estimated);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_sparse_file_counts_what_it_holds() {
        let data = std::env::temp_dir().join(format!("length3-sparse-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let repo = data.join("repos/s");
        fs::create_dir_all(&repo).unwrap();
        let f = fs::File::create(repo.join("big")).unwrap();
        f.set_len(1 << 30).unwrap(); // 1 GiB logical, nothing written
        let u = usage(&data, &data.join("repos"));
        assert!(u.repos[0].logical >= 1 << 30);
        assert!(u.repos[0].allocated < 1 << 20, "{:?}", u.repos[0]);
        let _ = fs::remove_dir_all(&data);
    }
}
