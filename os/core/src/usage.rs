//! この端末: what this OS holds on the device, measured where the host
//! measures it, as one list by size, each thing saying what can be done
//! with it:
//!
//!   空ける          it is not needed here: an old root (fetched again from
//!                   the Remote when wanted), a leftover temporary, a repo
//!                   whose copy is exactly what the Remote has
//!   空ける (sent)    a repo with changes the Remote does not have yet: they
//!                   are sent first, then the copy goes
//!   (kept)          and why: the root Prompts run on, a repo holding what
//!                   cannot be sent, Home's settings
//!
//! What a repo's Prompts wrote outside it is listed too, by owner and
//! lifetime (owned.rs): its environment (what its package manager put over
//! the root; freeing it brings the plain root back) and its caches (made
//! again when needed); and inside it, what is derived from its files
//! (node_modules, target, a venv: made again by the tool that made them).
//! None of these is ever the only copy of anything the person made, so all
//! may go; the first two go once their repo is not on this device.
//!
//! A repo that is freed stays on the Remote and comes back when opened.
//!
//! What a Prompt holds stays while it runs, and from the moment it starts
//! being prepared (`.packages`, `.setup`): its repo, the repo's environment,
//! caches and what is derived in it, and the root it runs on, whichever is
//! current now. Each Prompt here records what it holds (prompt.rs) under the
//! same lock (`lock`) a thing is looked at again under just before it goes,
//! and the current root is changed under, so none of these comes between the
//! look and the removal.
//!
//! Every figure says how it is known. `allocated` is what the host's
//! filesystem has set aside (st_blocks), which is what giving room back is
//! about: a sparse or deleted file counts only what it really holds, and a
//! file with several hard links is counted once. Host free space is what
//! the host reports; after freeing, the change in it is observed, not
//! attributed, because other programs write too.
//!
//! A leftover is disposable by proof, not by name: a temporary file this OS
//! itself writes while replacing a file (`.<name>.length3-<pid>-<n>`,
//! `<key>.json.<pid>` in Home) whose writer is gone and which is older than
//! a minute; in the system directory, a root half unpacked by an install
//! that died, and a release bundle or partial download not in use. Nothing
//! in a repo's .git and no file the person made is ever a leftover.

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
struct Leftover {
    path: PathBuf,
    /// An older root (listed as a root, not as a leftover).
    root: bool,
    allocated: u64,
    /// What it is, in a word or two.
    what: String,
}

/// Why a root is on the device.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub enum Held {
    /// Prompts run on it.
    Current,
    /// Kept to go back to if the current one is bad.
    Previous,
    /// Neither: reclaimable.
    Older,
}

#[derive(Serialize, Debug, Clone)]
pub struct SystemUsage {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub allocated: u64,
    pub held: Held,
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

#[cfg(unix)]
fn inode(meta: &fs::Metadata) -> (u64, u64) { use std::os::unix::fs::MetadataExt; (meta.dev(), meta.ino()) }
#[cfg(not(unix))]
fn inode(_: &fs::Metadata) -> (u64, u64) { (0, 0) }

/// Files, logical and allocated bytes under `dir`, not following links; a
/// file with several hard links is counted once.
fn tally(dir: &Path) -> (u64, u64, u64) {
    tally_into(dir, &mut std::collections::HashSet::new())
}

fn tally_into(dir: &Path, seen: &mut std::collections::HashSet<(u64, u64)>) -> (u64, u64, u64) {
    let mut out = (0, 0, 0);
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            let (f, l, a) = tally_into(&e.path(), seen);
            out = (out.0 + f, out.1 + l, out.2 + a + blocks(&meta));
        } else if links(&meta) < 2 || seen.insert(inode(&meta)) {
            out = (out.0 + 1, out.1 + meta.len(), out.2 + blocks(&meta));
        }
    }
    out
}

/// Bytes the host has set aside for everything under `dir`.
pub fn allocated(dir: &Path) -> u64 {
    tally(dir).2 + dir.symlink_metadata().map(|m| blocks(&m)).unwrap_or(0)
}

fn age(meta: &fs::Metadata) -> Duration {
    meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).unwrap_or_default()
}

/// The roots on the device and why each is held: the current one, the
/// newest other one (to go back to), and older ones, which are not.
pub fn system(data: &Path) -> Vec<(SystemUsage, PathBuf)> {
    let dir = crate::root::system_dir(data);
    let current = fs::read_link(dir.join("current")).ok().map(|p| p.to_string_lossy().into_owned());
    let mut others = Vec::new();
    let mut out = Vec::new();
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.len() != 64 || !name.bytes().all(|b| b.is_ascii_hexdigit()) || !e.path().is_dir() { continue; }
        let Ok(about) = fs::read_to_string(e.path().join("installed.json")) else { continue };
        let Ok(mut about) = serde_json::from_str::<crate::root::Installed>(&about) else { continue };
        // When it was last in use is its directory's time: read before anything is written in it.
        let meta = e.path().symlink_metadata().ok();
        // Counted when it was installed; one installed before that is counted now, once, and the count kept,
        // its directory's time put back, so counting does not make it the newest.
        let allocated = match about.allocated {
            Some(n) => n,
            None => {
                let n = tally(&e.path()).2;
                about.allocated = Some(n);
                // Not kept, it is counted again next time.
                if let Ok(text) = serde_json::to_vec(&about) { let _ = crate::atomic::replace(&e.path().join("installed.json"), &text, crate::atomic::How::RECORD); }
                if let Some(t) = meta.as_ref().and_then(|m| m.modified().ok()) { let _ = fs::File::open(e.path()).and_then(|f| f.set_modified(t)); }
                n
            }
        };
        let row = SystemUsage { name: about.name, version: about.version, sha256: about.sha256, allocated, held: Held::Older };
        if current.as_deref() == Some(&name) { out.push((SystemUsage { held: Held::Current, ..row }, e.path())); }
        else { others.push((meta.as_ref().map(age).unwrap_or_default(), row, e.path())); }
    }
    others.sort_by_key(|(a, _, _)| *a);
    for (i, (_, row, path)) in others.into_iter().enumerate() {
        out.push((SystemUsage { held: if i == 0 { Held::Previous } else { Held::Older }, ..row }, path));
    }
    out
}

/// What in the system directory can go: older roots, half-done installs,
/// bundles and downloads not in use.
fn system_leftovers(data: &Path, out: &mut Vec<Leftover>) {
    for (row, path) in system(data) {
        if row.held == Held::Older {
            out.push(Leftover { path, allocated: row.allocated, what: crate::tr!("An old root ({} {})", "古い root（{} {}）", row.name, row.version), root: true });
        }
    }
    let dir = crate::root::system_dir(data);
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        // `.<sha>.length3-<pid>-0`: an install's unpacking, whose installer is gone.
        if meta.is_dir() && name.starts_with('.') {
            if let Some(pid) = temporary_writer(&name, false) {
                if age(&meta) >= AGE && pid != crate::pid() && !running(pid) {
                    out.push(Leftover { allocated: tally(&e.path()).2 + blocks(&meta), path: e.path(), what: crate::tr!("An unpacking that stopped half way", "途中で止まった展開"), root: false });
                }
            }
        }
    }
    // Bundles are let go once installed; one still here is not in use. A
    // partial download is only progress, fetched again when wanted.
    for e in fs::read_dir(dir.join(".bundles")).into_iter().flatten().flatten() {
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if !meta.is_file() || age(&meta) < Duration::from_secs(600) { continue; }
        let partial = e.file_name().to_string_lossy().ends_with(".part");
        out.push(Leftover { path: e.path(), allocated: blocks(&meta), what: if partial { crate::tr!("A release fetched part of the way", "途中まで取ったリリース") } else { crate::tr!("A release not in use", "使っていないリリース") }, root: false });
    }
}

/// Whether a name in a repo is one this OS gives a file while it writes it.
pub fn is_temporary(name: &str) -> bool {
    name.starts_with(".length3-") || temporary_writer(name, false).is_some()
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

/// This OS's own leftover temporaries under `dir` (never inside a repo's
/// .git, and not in the system directory, which has its own rules), for
/// the data directory `data`.
fn leftovers(dir: &Path, data: &Path, out: &mut Vec<Leftover>) {
    let settings = data.join("home");
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if crate::repos::is_git_name(&name) { continue; }
        let path = e.path();
        let Ok(meta) = path.symlink_metadata() else { continue };
        if meta.is_dir() && path == crate::root::system_dir(data) { continue; }
        // A repo's environment and caches are listed as theirs, not walked for leftovers.
        if meta.is_dir() && dir == data && (name == "envs" || name == "caches") { continue; }
        if meta.is_dir() { leftovers(&path, data, out); continue; }
        if !meta.is_file() || links(&meta) != 1 { continue; }
        let Some(pid) = temporary_writer(&name, dir == settings.as_path()) else { continue };
        let old = meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age >= AGE);
        if old && pid != crate::pid() && !running(pid) {
            out.push(Leftover { path, allocated: blocks(&meta), what: crate::tr!("A temporary file left behind", "残った一時ファイル"), root: false });
        }
    }
}

fn host(dir: &Path) -> (u64, u64, Certainty) {
    match crate::system::room(dir) {
        Ok((total, free)) => (total, free, Certainty::Estimated),
        Err(_) => (0, 0, Certainty::Unknown),
    }
}

/// What can be done with a thing this OS holds.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub enum Room {
    /// It can go now.
    Free,
    /// A repo with changes not on the Remote yet: sent, then it goes.
    SyncFree,
    /// It stays, and `why` says why.
    Keep,
}

/// One thing this OS holds on the device.
#[derive(Serialize, Debug, Clone)]
pub struct Item {
    /// "repo:<name>", "root:<sha256>", "path:<path>" or "home".
    pub id: String,
    pub what: String,
    pub detail: String,
    pub allocated: u64,
    pub room: Room,
    pub why: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Space {
    pub host_total: u64,
    pub host_free: u64,
    pub host: Certainty,
    /// All this OS holds here.
    pub allocated: u64,
    /// What can go (空ける, sending first where a repo needs it).
    pub freeable: u64,
    /// Largest first.
    pub items: Vec<Item>,
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

/// One at a time, across the app and l3: a Prompt recording what it holds (prompt.rs), the root made
/// current (root.rs), and a thing looked at again and let go (`free`). What a Prompt took, or the root
/// made current, before the look is seen by it; after, it finds the thing there, or not at all, never going.
pub struct Lock(fs::File);

impl Drop for Lock {
    /// Let go of as soon as it is done with (closing the file would too).
    fn drop(&mut self) { let _ = self.0.unlock(); }
}

pub fn lock(data: &Path) -> std::io::Result<Lock> {
    // Beside the Prompts' records (prompt.rs), which it is about.
    let dir = data.join("prompts");
    crate::boundary::private_dir(&dir)?;
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".lock"))?;
    // The browser's core is one instance at a time, and has no locks to take.
    match f.lock() { Err(e) if e.kind() != std::io::ErrorKind::Unsupported => return Err(e), _ => {} }
    Ok(Lock(f))
}

/// The Prompts recorded here, each its repo, its root, and whether it is still being prepared (prompt.rs).
/// The core built for the web runs none.
fn recorded(data: &Path) -> Vec<(String, Option<String>, bool)> {
    #[cfg(not(target_os = "wasi"))]
    return crate::prompt::running(data).into_iter().map(|r| (r.repo, r.root, r.preparing)).collect();
    #[cfg(target_os = "wasi")]
    { let _ = data; Vec::new() }
}

/// What the Prompts here hold now, so none of it goes under them: the repos they have open (and with each,
/// its environment, caches and what is derived in it) and the roots they run on, each with whether every
/// Prompt holding it is still being prepared.
struct InUse {
    repos: Vec<(String, bool)>,
    roots: Vec<(String, bool)>,
    /// A Prompt whose record does not say its root (an older l3's): any root may be the one, so all stay.
    unsaid: bool,
}

impl InUse {
    /// `open`: repos the host knows a Prompt of its own has open. Every Prompt on a root records itself, and
    /// its record says more (being prepared, the root); a browser's has none, and is running.
    fn now(data: &Path, open: &[String]) -> InUse {
        fn add(all: &mut Vec<(String, bool)>, name: String, preparing: bool) {
            match all.iter_mut().find(|(n, _)| *n == name) {
                Some((_, p)) => *p &= preparing,
                None => all.push((name, preparing)),
            }
        }
        let mut u = InUse { repos: Vec::new(), roots: Vec::new(), unsaid: false };
        for (repo, root, preparing) in recorded(data) {
            add(&mut u.repos, repo, preparing);
            match root {
                Some(root) => add(&mut u.roots, root, preparing),
                None => u.unsaid = true,
            }
        }
        for repo in open {
            if !u.repos.iter().any(|(n, _)| n == repo) { u.repos.push((repo.clone(), false)); }
        }
        u
    }

    /// Why a repo, or what is its, stays: a Prompt has it.
    fn repo(&self, name: &str) -> Option<String> {
        self.repos.iter().find(|(n, _)| n == name).map(|(_, preparing)| if *preparing { preparing_why() }
            else { crate::tr!("A Prompt has it open", "Prompt で開いています") })
    }

    /// Why a root stays: a Prompt runs on it, whichever is current now.
    fn root(&self, sha256: &str) -> Option<String> {
        match self.roots.iter().find(|(n, _)| n == sha256) {
            Some((_, true)) => Some(preparing_why()),
            Some((_, false)) => Some(crate::tr!("A Prompt running uses it", "動いている Prompt が使っています")),
            None => self.unsaid.then(|| crate::tr!("A Prompt running here does not say which root it uses", "動いている Prompt が、どの root を使うか記録していません")),
        }
    }
}

fn preparing_why() -> String {
    crate::tr!("A Prompt being prepared uses it (.packages, .setup)", "用意中の Prompt が使っています（.packages、.setup）")
}

fn repo_item(repos: &crate::repos::Repos, name: &str, connected: bool, in_use: &InUse) -> Option<Item> {
    let dir = repos.dir(name).ok()?;
    let s = crate::remote::status_of(repos, name).ok()?;
    let files = s.unsynced.len() + s.files;
    let (room, why) = if let Some(why) = in_use.repo(name) {
        (Room::Keep, why)
    } else if !connected {
        (Room::Keep, crate::tr!("Sign in to the Remote to free it", "Remote にサインインすると空けられます"))
    } else if let Some((path, what)) = s.unsynced.first() {
        (Room::Keep, crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, what))
    } else if s.changed == 0 && !s.fresh {
        (Room::Free, crate::tr!("The Remote has the same; opening it brings it back", "Remote と同じです。開けばまた来ます"))
    } else {
        (Room::SyncFree, if s.fresh { crate::tr!("Not on the Remote yet; sent, then freed", "まだ Remote にありません。送ってから空けます") } else { if s.changed == 1 { crate::tr!("1 change is sent, then it is freed", "1件の変更を送ってから空けます") } else { crate::tr!("{} changes are sent, then it is freed", "{}件の変更を送ってから空けます", s.changed) } })
    };
    // Every copy of it counts: main's and each issue's being worked on; what is derived in it is its own item.
    let works = crate::work::worktrees(name);
    let derived: u64 = crate::owned::derived_in(&dir).iter().map(|p| allocated(p)).sum();
    let size = allocated(&dir).saturating_sub(derived) + works.iter().map(|(_, p)| allocated(p)).sum::<u64>();
    // One file is one file (1 file, not 1 files); Japanese counts the same either way.
    let files = if files == 1 { crate::tr!("1 file", "1ファイル") } else { crate::tr!("{} files", "{}ファイル", files) };
    let detail = match works.len() {
        0 => crate::tr!("repo · {}", "repo · {}", files),
        1 => crate::tr!("repo · {} · 1 work", "repo · {} · 作業 1", files),
        n => crate::tr!("repo · {} · {} works", "repo · {} · 作業 {}", files, n),
    };
    Some(Item { id: format!("repo:{name}"), what: name.into(), detail, allocated: size, room, why })
}

/// A repo's environment ("env") or caches ("cache"), if it has them here.
fn owned_item(data: &Path, repos_dir: &Path, kind: &str, repo: &str, in_use: &InUse) -> Option<Item> {
    if !crate::repos::valid_name(repo) { return None; }
    let dir = if kind == "env" { crate::owned::env_dir(data, repo) } else { crate::owned::cache_dir(data, repo) };
    if !dir.is_dir() { return None; }
    let (room, why) = if let Some(why) = in_use.repo(repo) {
        (Room::Keep, why)
    } else if !repos_dir.join(repo).is_dir() {
        (Room::Free, crate::tr!("Its repo is not on this device", "その repo はこの端末にありません"))
    } else if kind == "env" {
        (Room::Free, crate::tr!("What its Prompts installed over the root; freed, the plain root is back", "Prompt が root の上に入れたもの。空けると元の root に戻ります"))
    } else {
        (Room::Free, crate::tr!("Made again when needed", "必要になればまた作られます"))
    };
    let detail = if kind == "env" { crate::tr!("environment", "環境") } else { crate::tr!("caches", "キャッシュ") };
    Some(Item { id: format!("{kind}:{repo}"), what: repo.into(), detail, allocated: allocated(&dir), room, why })
}

/// What is derived from a repo's own files, if it has any.
fn derived_item(repos_dir: &Path, repo: &str, in_use: &InUse) -> Option<Item> {
    if !crate::repos::valid_name(repo) { return None; }
    let found = crate::owned::derived_in(&repos_dir.join(repo));
    if found.is_empty() { return None; }
    let mut names: Vec<String> = found.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    names.sort();
    names.dedup();
    let (room, why) = if let Some(why) = in_use.repo(repo) {
        (Room::Keep, why)
    } else {
        (Room::Free, crate::tr!("Made again from its files by the tool that made it", "元のファイルから、作ったツールがまた作ります"))
    };
    Some(Item { id: format!("derived:{repo}"), what: repo.into(), detail: crate::tr!("derived · {}", "派生物 · {}", names.join(", ")),
        allocated: found.iter().map(|p| allocated(p)).sum(), room, why })
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

fn root_item(row: SystemUsage, in_use: &InUse) -> Item {
    // The current one stays whether or not a Prompt runs now (the l3 every Prompt starts on); one a Prompt
    // runs on stays while it does, current or not, so making another current takes nothing from under it.
    let (room, why) = match (row.held, in_use.root(&row.sha256)) {
        (Held::Current, _) => (Room::Keep, crate::tr!("The root Prompts run on", "Prompt が動く root です")),
        (_, Some(why)) => (Room::Keep, why),
        (Held::Previous, None) => (Room::Free, crate::tr!("The root before; going back fetches it again from the Remote", "ひとつ前の root。戻すときは Remote から取り直せます")),
        (Held::Older, None) => (Room::Free, crate::tr!("An old root; the Remote has it", "古い root。Remote から取り直せます")),
    };
    Item { id: format!("root:{}", row.sha256), what: format!("{} {}", row.name, row.version), detail: "root".into(), allocated: row.allocated, room, why }
}

fn leftover_item(l: Leftover) -> Item {
    let name = l.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Item { id: format!("path:{}", l.path.display()), what: l.what, detail: name, allocated: l.allocated, room: Room::Free, why: crate::tr!("Left behind by this OS", "この OS の残り物です") }
}

/// Whether `path` is a leftover now, by the same rules as the scans, looked
/// at alone (freeing one thing does not walk everything again).
fn leftover_at(data: &Path, path: &Path) -> Option<Leftover> {
    let system = crate::root::system_dir(data);
    let dir = path.parent()?;
    if dir == system || dir == system.join(".bundles") {
        let mut found = Vec::new();
        system_leftovers(data, &mut found);
        return found.into_iter().find(|l| l.path == path && !l.root);
    }
    // Under the data directory, never inside a repo's .git or the system directory.
    let rel = path.strip_prefix(data).ok()?;
    // Plain names only: an id from the page with `..` in it must not lead out of the data directory.
    if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) { return None; }
    if rel.components().any(|c| crate::repos::is_git_name(&c.as_os_str().to_string_lossy())) || path.starts_with(&system) { return None; }
    let meta = path.symlink_metadata().ok()?;
    if !meta.is_file() || links(&meta) != 1 { return None; }
    let pid = temporary_writer(&path.file_name()?.to_string_lossy(), dir == data.join("home"))?;
    (age(&meta) >= AGE && pid != crate::pid() && !running(pid))
        .then(|| Leftover { path: path.to_path_buf(), allocated: blocks(&meta), what: crate::tr!("A temporary file left behind", "残った一時ファイル"), root: false })
}

/// One thing by its id, looked at now and alone.
fn item(data: &Path, repos_dir: &Path, id: &str, in_use: &InUse) -> Option<Item> {
    if let Some(name) = id.strip_prefix("repo:") {
        let repos = crate::repos::Repos::new(repos_dir.to_path_buf()).ok()?;
        repo_item(&repos, name, crate::remote::connection().is_some(), in_use)
    } else if let Some(sha) = id.strip_prefix("root:") {
        system(data).into_iter().find(|(r, _)| r.sha256 == sha).map(|(r, _)| root_item(r, in_use))
    } else if let Some(path) = id.strip_prefix("path:") {
        leftover_at(data, Path::new(path)).map(leftover_item)
    } else if let Some(repo) = id.strip_prefix("env:") {
        owned_item(data, repos_dir, "env", repo, in_use)
    } else if let Some(repo) = id.strip_prefix("cache:") {
        owned_item(data, repos_dir, "cache", repo, in_use)
    } else if let Some(repo) = id.strip_prefix("derived:") {
        derived_item(repos_dir, repo, in_use)
    } else if id == "home" {
        Some(Item { id: "home".into(), what: "Home".into(), detail: String::new(), allocated: 0, room: Room::Keep, why: crate::tr!("This device's settings", "この端末の設定です") })
    } else {
        None
    }
}

/// Everything this OS holds under `data` (repos in `repos`), largest first.
/// `open`: repos a Prompt the host knows of has open now (a browser's own);
/// every Prompt on a root, the app's and l3's, is read from its record here.
pub fn space(data: &Path, repos_dir: &Path, open: &[String]) -> Space {
    let (host_total, host_free, host) = host(data);
    let mut items = Vec::new();
    let connected = crate::remote::connection().is_some();
    let in_use = InUse::now(data, open);
    if let Ok(repos) = crate::repos::Repos::new(repos_dir.to_path_buf()) {
        for name in repos.names().unwrap_or_default() {
            items.extend(repo_item(&repos, &name, connected, &in_use));
            items.extend(derived_item(repos_dir, &name, &in_use));
        }
    }
    for (row, _) in system(data) {
        items.push(root_item(row, &in_use));
    }
    for (kind, repo, _) in crate::owned::held(data) {
        items.extend(owned_item(data, repos_dir, kind, &repo, &in_use));
    }
    let mut left = Vec::new();
    leftovers(data, data, &mut left);
    system_leftovers(data, &mut left);
    for l in left.into_iter().filter(|l| !l.root) {
        items.push(leftover_item(l));
    }
    let home = allocated(&data.join("home")) + allocated(&data.join("sync"));
    items.push(Item { id: "home".into(), what: "Home".into(), detail: crate::tr!("settings, TODO, where each repo stands", "設定・TODO・各 repo の状態"), allocated: home, room: Room::Keep, why: crate::tr!("This device's settings", "この端末の設定です") });
    items.sort_by(|a, b| b.allocated.cmp(&a.allocated).then(a.what.cmp(&b.what)));
    Space {
        host_total, host_free, host,
        allocated: items.iter().map(|i| i.allocated).sum(),
        freeable: items.iter().filter(|i| i.room != Room::Keep).map(|i| i.allocated).sum(),
        items,
    }
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
            crate::repos::Repos::new(repos_dir.to_path_buf()).and_then(|r| crate::remote::free(&r, name))
        } else if let Some(sha) = id.strip_prefix("root:") {
            let dir = crate::root::system_dir(data).join(sha);
            let size = allocated(&dir);
            fs::remove_dir_all(&dir).map(|_| size).map_err(|e| e.to_string())
        } else if let Some(repo) = id.strip_prefix("env:") {
            remove_owned(&crate::owned::env_dir(data, repo))
        } else if let Some(repo) = id.strip_prefix("cache:") {
            remove_owned(&crate::owned::cache_dir(data, repo))
        } else if let Some(repo) = id.strip_prefix("derived:") {
            crate::owned::derived_in(&repos_dir.join(repo)).iter().try_fold(0, |n, p| remove_owned(p).map(|k| n + k))
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
    Freed {
        freed, freed_certainty: Certainty::Verified, removed, kept,
        host_free_before: before, host_free_after: after,
        host_change: certainty, reflected_ms: if freed == 0 { Some(0) } else { reflected },
    }
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
    let touched: std::collections::HashMap<String, u64> = crate::repos::Repos::new(repos_dir.to_path_buf()).and_then(|r| r.list())
        .map(|l| l.into_iter().map(|x| (format!("repo:{}", x.name), x.modified)).collect()).unwrap_or_default();
    let ids = room_order(&s.items, &previous, &touched, now, need);
    if ids.is_empty() { return None; }
    Some(free(data, repos_dir, &ids, &[]))
}

/// What `make_room` lets go, in its order, until `need` bytes: of `items`, those that can go now, ranked leftovers and
/// old roots, caches, derived trees, the root before (`previous`), then repos untouched (`touched`, ms) for a week
/// before `now`, the longest untouched first; the largest first within a rank.
fn room_order(items: &[Item], previous: &[String], touched: &std::collections::HashMap<String, u64>, now: u64, need: u64) -> Vec<String> {
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

/// Everything that can go, as ids for `free`.
pub fn all_freeable(s: &Space) -> Vec<String> {
    s.items.iter().filter(|i| i.room != Room::Keep).map(|i| i.id.clone()).collect()
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
        let u = space(&data, &data.join("repos"), &[]);
        let mut found: Vec<PathBuf> = u.items.iter().filter_map(|i| i.id.strip_prefix("path:").map(PathBuf::from)).collect();
        found.sort();
        assert_eq!(found, [setting.clone(), dead.clone()]);
        assert!(u.freeable >= 50_000 / 4096 * 4096, "{}", u.freeable);
        // Without a Remote, a repo stays, and says how it could go.
        let a = u.items.iter().find(|i| i.id == "repo:a").unwrap();
        assert!(a.allocated >= 10_000 && a.room == Room::Keep && a.why.contains("Remote"), "{a:?}");
        // Largest first.
        assert!(u.items.windows(2).all(|w| w[0].allocated >= w[1].allocated));
        let ids: Vec<String> = all_freeable(&u);
        let r = free(&data, &data.join("repos"), &[ids, vec!["repo:a".into()]].concat(), &[]);
        assert_eq!((r.removed.len(), r.freed_certainty), (2, Certainty::Verified));
        assert!(r.kept.iter().any(|(id, _)| id == "repo:a"));
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
        let u = space(&data, &data.join("repos"), &[]);
        let s = u.items.iter().find(|i| i.id == "repo:s").unwrap();
        assert!(s.allocated < 1 << 20, "{s:?}");
        let _ = fs::remove_dir_all(&data);
    }
}

#[cfg(test)]
mod system_tests {
    use super::*;

    fn root_dir(data: &Path, sha: char, version: &str) -> PathBuf {
        let d = crate::root::system_dir(data).join(sha.to_string().repeat(64));
        fs::create_dir_all(d.join("root/bin")).unwrap();
        fs::write(d.join("root/bin/busybox"), vec![b'x'; 20_000]).unwrap();
        // Applets are hard links: the bytes are there once.
        for a in ["sh", "ls", "cat"] { fs::hard_link(d.join("root/bin/busybox"), d.join(format!("root/bin/{a}"))).unwrap(); }
        let about = crate::root::Installed { name: "OS".into(), version: version.into(), sha256: sha.to_string().repeat(64), files: 4, bytes: 20_000, allocated: None, distro: None };
        fs::write(d.join("installed.json"), serde_json::to_string(&about).unwrap()).unwrap();
        d
    }

    #[test]
    fn the_root_in_use_and_the_one_before_are_held_older_ones_go() {
        let data = std::env::temp_dir().join(format!("length3-system-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let old = root_dir(&data, 'a', "0.0.1");
        std::thread::sleep(Duration::from_millis(20));
        let before = root_dir(&data, 'b', "0.0.2");
        std::thread::sleep(Duration::from_millis(20));
        root_dir(&data, 'c', "0.1.0");
        // `before` is newer than `old`: the one to go back to.
        let t = SystemTime::now();
        fs::File::open(&old).unwrap().set_modified(t - Duration::from_secs(7200)).unwrap();
        fs::File::open(&before).unwrap().set_modified(t - Duration::from_secs(3600)).unwrap();
        std::os::unix::fs::symlink("c".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let held: Vec<(String, Held)> = system(&data).into_iter().map(|(s, _)| (s.version, s.held)).collect();
        assert!(held.contains(&("0.1.0".into(), Held::Current)) && held.contains(&("0.0.2".into(), Held::Previous)) && held.contains(&("0.0.1".into(), Held::Older)), "{held:?}");
        let u = space(&data, &data.join("repos"), &[]);
        let room = |v: &str| u.items.iter().find(|i| i.what == format!("OS {v}")).unwrap();
        // The root in use stays; the others can be fetched again, so they can go.
        assert_eq!((room("0.1.0").room, room("0.0.2").room, room("0.0.1").room), (Room::Keep, Room::Free, Room::Free));
        // Four names, one file's worth of blocks.
        assert!(room("0.1.0").allocated < 4 * 20_000, "{}", room("0.1.0").allocated);
        let r = free(&data, &data.join("repos"), &all_freeable(&u), &[]);
        assert_eq!(r.removed.len(), 2);
        assert!(!old.exists() && !before.exists() && crate::root::system_dir(&data).join("c".repeat(64)).exists());
        let _ = fs::remove_dir_all(&data);
    }

    fn room_of(u: &Space, sha: char) -> (Room, String) {
        let i = u.items.iter().find(|i| i.id == format!("root:{}", sha.to_string().repeat(64))).expect("the root is listed");
        (i.room, i.why.clone())
    }

    #[test]
    fn a_root_a_prompt_runs_on_stays_when_another_is_made_current_and_goes_once_it_ends() {
        let data = std::env::temp_dir().join(format!("length3-system-held-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        let l3 = root_dir(&data, 'a', "0.5.0");
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // A web server's Prompt on l3's root (this process stands for it), then Ubuntu made current, as `l3 root use ubuntu` does.
        let mut prompt = crate::prompt::record(&data, "os-web", true, &l3.join("root")).unwrap();
        prompt.ready().unwrap();
        root_dir(&data, 'b', "24.04.5");
        assert!(crate::root::use_held(&data, &"b".repeat(64)).is_some());
        let running = crate::tr!("A Prompt running uses it", "動いている Prompt が使っています");
        let u = space(&data, &repos, &[]);
        assert_eq!(room_of(&u, 'a'), (Room::Keep, running.clone()), "the root the Prompt runs on stays");
        // The current one stays as ever, with no Prompt on it (#46).
        assert_eq!(room_of(&u, 'b').0, Room::Keep);
        assert!(!all_freeable(&u).iter().any(|id| id.starts_with("root:")));
        // Asked for by name, it is looked at again and stays; so with the host's own `open` (the app's) told nothing.
        let r = free(&data, &repos, &[format!("root:{}", "a".repeat(64))], &[]);
        assert!(r.removed.is_empty() && r.kept == [(format!("root:{}", "a".repeat(64)), running)], "{:?}", r.kept);
        assert!(l3.join("root/bin/busybox").is_file(), "its programs are still there to run");
        // The Prompt ends: the root before is one that can go, as it always was.
        drop(prompt);
        let u = space(&data, &repos, &[]);
        assert_eq!(room_of(&u, 'a').0, Room::Free);
        assert_eq!(free(&data, &repos, &all_freeable(&u), &[]).removed, [format!("root:{}", "a".repeat(64))]);
        assert!(!l3.exists() && crate::root::current(&data).is_some_and(|(_, r)| r.version == "24.04.5"));
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_record_older_l3_made_without_its_root_keeps_every_root() {
        let data = std::env::temp_dir().join(format!("length3-system-unsaid-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        root_dir(&data, 'a', "1");
        root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("b".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // This process's own, as an l3 before roots were recorded wrote it.
        let me = std::process::id();
        fs::create_dir_all(data.join("prompts")).unwrap();
        fs::write(data.join(format!("prompts/{me}.json")), format!(r#"{{"repo":"x","pid":{me},"network":false,"started":1,"startTicks":{}}}"#, crate::prompt::start_ticks(me).unwrap())).unwrap();
        let u = space(&data, &data.join("repos"), &[]);
        assert_eq!(room_of(&u, 'a').0, Room::Keep, "{:?}", room_of(&u, 'a'));
        fs::remove_file(data.join(format!("prompts/{me}.json"))).unwrap();
        assert_eq!(room_of(&space(&data, &data.join("repos"), &[]), 'a').0, Room::Free);
        let _ = fs::remove_dir_all(&data);
    }

    /// 空ける looks again under the lock a Prompt records itself under: one that recorded the root while the
    /// free waited keeps it, however the free decided before.
    #[test]
    fn a_prompt_recorded_while_a_free_waits_keeps_its_root() {
        let data = std::env::temp_dir().join(format!("length3-system-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let old = root_dir(&data, 'a', "1");
        root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("b".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let id = format!("root:{}", "a".repeat(64));
        assert!(all_freeable(&space(&data, &data.join("repos"), &[])).contains(&id), "nothing holds it yet");
        // A Prompt starting on it holds the lock (prompt::record), and the free waits for it.
        let still = lock(&data).unwrap();
        let freeing = { let (data, id) = (data.clone(), id.clone()); std::thread::spawn(move || free(&data, &data.join("repos"), &[id], &[])) };
        std::thread::sleep(Duration::from_millis(200));
        let me = std::process::id();
        let r = crate::prompt::Running { repo: "x".into(), pid: me, network: false, root: Some("a".repeat(64)), preparing: true, started: 1, start_ticks: crate::prompt::start_ticks(me).unwrap() };
        fs::write(data.join(format!("prompts/{me}.json")), serde_json::to_vec(&r).unwrap()).unwrap();
        drop(still);
        let r = freeing.join().unwrap();
        assert!(r.removed.is_empty() && r.kept.iter().any(|(k, _)| *k == id), "{:?}", r.kept);
        assert!(old.join("installed.json").is_file());
        let _ = fs::remove_dir_all(&data);
    }

    /// The root made current under the same lock: one freed meanwhile is not made current.
    #[test]
    fn a_root_freed_as_it_is_made_current_is_not_made_current() {
        let data = std::env::temp_dir().join(format!("length3-system-switch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        root_dir(&data, 'a', "1");
        let other = root_dir(&data, 'b', "2");
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        let still = lock(&data).unwrap();
        let switching = { let data = data.clone(); std::thread::spawn(move || crate::root::use_held(&data, &"b".repeat(64)).is_some()) };
        std::thread::sleep(Duration::from_millis(200));
        // Freed while it waited (as `free` removes a root, under the lock).
        fs::remove_dir_all(&other).unwrap();
        drop(still);
        assert!(!switching.join().unwrap());
        assert_eq!(crate::root::current(&data).map(|(_, r)| r.version), Some("1".into()));
        let _ = fs::remove_dir_all(&data);
    }
}

#[cfg(test)]
mod owned_tests {
    use super::*;

    #[test]
    fn a_repos_environment_and_caches_are_listed_as_its_and_go_with_it() {
        use std::os::unix::fs::PermissionsExt;
        let data = std::env::temp_dir().join(format!("length3-owned-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        fs::create_dir_all(repos.join("here")).unwrap();
        // What its package manager put over the root, and the overlay's scratch, which no one may read.
        let env = crate::owned::env_dir(&data, "here");
        fs::create_dir_all(env.join("upper/usr/bin")).unwrap();
        fs::write(env.join("upper/usr/bin/tool"), vec![b'x'; 30_000]).unwrap();
        // A temporary-looking name inside an environment is the environment's, not a leftover.
        fs::write(env.join("upper/usr/bin/.tool.length3-4000000-0"), "x").unwrap();
        fs::create_dir_all(env.join("work/work")).unwrap();
        fs::set_permissions(env.join("work/work"), fs::Permissions::from_mode(0o000)).unwrap();
        // Caches of a repo that is no longer on this device: nothing owns them here.
        let gone = crate::owned::cache_dir(&data, "gone");
        fs::create_dir_all(gone.join("var-cache")).unwrap();
        fs::write(gone.join("var-cache/blob"), vec![b'y'; 20_000]).unwrap();

        // Derived from its own files: node_modules beside package.json, a directory that says it is a cache.
        fs::write(repos.join("here/package.json"), "{}").unwrap();
        fs::create_dir_all(repos.join("here/node_modules/x")).unwrap();
        fs::write(repos.join("here/node_modules/x/index.js"), vec![b'z'; 40_000]).unwrap();
        fs::create_dir_all(repos.join("here/out")).unwrap();
        fs::write(repos.join("here/out/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        // Not proven: a node_modules with no package.json beside it is the person's.
        fs::create_dir_all(repos.join("here/vendor/node_modules")).unwrap();
        fs::write(repos.join("here/vendor/node_modules/keep.js"), "mine").unwrap();
        let tree = crate::remote::local_tree(&repos.join("here"));
        assert_eq!(tree.tree.keys().cloned().collect::<Vec<_>>(), ["package.json", "vendor/node_modules/keep.js"]);
        assert!(crate::owned::within_derived(&repos.join("here"), "node_modules/x/index.js"));
        assert!(!crate::owned::within_derived(&repos.join("here"), "vendor/node_modules/keep.js"));

        let s = space(&data, &repos, &[]);
        let find = |id: &str| s.items.iter().find(|i| i.id == id).cloned();
        let d = find("derived:here").expect("what is derived is listed");
        assert!(d.room == Room::Free && d.allocated >= 40_000 && d.detail.contains("node_modules") && d.detail.contains("out"), "{d:?}");
        assert!(find("repo:here").is_some_and(|r| r.allocated < 40_000), "the repo's size leaves it out");
        let e = find("env:here").expect("the environment is listed");
        assert!(e.room == Room::Free && e.allocated >= 30_000, "{e:?}");
        let c = find("cache:gone").expect("the orphaned caches are listed");
        // In the language spoken (it failed in Japanese).
        assert!(c.room == Room::Free && c.why == crate::tr!("Its repo is not on this device", "その repo はこの端末にありません"), "{c:?}");
        assert!(!s.items.iter().any(|i| i.id.starts_with("path:")), "nothing in an environment is a leftover");
        // Open in a Prompt, it stays.
        assert_eq!(item(&data, &repos, "env:here", &InUse::now(&data, &["here".into()])).unwrap().room, Room::Keep);

        let f = free(&data, &repos, &["env:here".into(), "cache:gone".into(), "derived:here".into()], &[]);
        assert_eq!(f.removed.len(), 3, "{:?}", f.kept);
        assert!(!env.exists() && !gone.exists() && !repos.join("here/node_modules").exists() && !repos.join("here/out").exists());
        assert!(repos.join("here/package.json").is_file() && repos.join("here/vendor/node_modules/keep.js").is_file(), "the repo's own files stay");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn what_a_prompt_being_prepared_holds_stays_and_says_so() {
        let data = std::env::temp_dir().join(format!("length3-owned-prep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let repos = data.join("repos");
        fs::create_dir_all(repos.join("os-starting")).unwrap();
        fs::write(repos.join("os-starting/package.json"), "{}").unwrap();
        fs::create_dir_all(repos.join("os-starting/node_modules/x")).unwrap();
        let root = crate::root::system_dir(&data).join("a".repeat(64));
        fs::create_dir_all(root.join("root/bin")).unwrap();
        fs::write(root.join("installed.json"), format!(r#"{{"name":"Ubuntu","version":"24.04.5 LTS","sha256":"{}","files":0,"bytes":0}}"#, "a".repeat(64))).unwrap();
        std::os::unix::fs::symlink("a".repeat(64), crate::root::system_dir(&data).join("current")).unwrap();
        // apt and .setup writing (this process stands for the l3 preparing it).
        let mut prompt = crate::prompt::record(&data, "os-starting", false, &root.join("root")).unwrap();
        let env = crate::owned::env_over(&data, "os-starting", &root.join("root"));
        fs::create_dir_all(env.join("upper/usr/bin")).unwrap();
        fs::write(env.join("upper/usr/bin/jq"), vec![b'x'; 10_000]).unwrap();
        let cache = crate::owned::cache_dir(&data, "os-starting");
        fs::create_dir_all(cache.join("var-cache/apt")).unwrap();
        fs::write(cache.join("var-cache/apt/pkgcache.bin"), vec![b'y'; 10_000]).unwrap();
        let ids = ["env:os-starting", "cache:os-starting", "derived:os-starting"].map(String::from);
        let why = |s: &Space, id: &str| s.items.iter().find(|i| i.id == id).map(|i| (i.room, i.why.clone()));
        let s = space(&data, &repos, &[]);
        let preparing = crate::tr!("A Prompt being prepared uses it (.packages, .setup)", "用意中の Prompt が使っています（.packages、.setup）");
        for id in ids.iter().chain([&"repo:os-starting".to_string()]) {
            assert_eq!(why(&s, id), Some((Room::Keep, preparing.clone())), "{id}");
        }
        // The app tells its own Prompts as open: their records say more, and are what is said.
        assert_eq!(why(&space(&data, &repos, &["os-starting".into()]), "env:os-starting"), Some((Room::Keep, preparing.clone())));
        // Neither one by one nor all at once: each looked at again, it is still held.
        let f = free(&data, &repos, &[all_freeable(&s), ids.to_vec()].concat(), &[]);
        assert!(f.removed.is_empty(), "{:?}", f.removed);
        assert!(env.join("upper/usr/bin/jq").is_file() && cache.join("var-cache/apt/pkgcache.bin").is_file());
        // Prepared, it holds them as running.
        prompt.ready().unwrap();
        assert_eq!(why(&space(&data, &repos, &[]), "env:os-starting").map(|(r, _)| r), Some(Room::Keep));
        // Its process lost while it was prepared (killed: its record left behind) holds nothing.
        drop(prompt);
        fs::create_dir_all(data.join("prompts")).unwrap();
        fs::write(data.join("prompts/4194304.json"), format!(r#"{{"repo":"os-starting","pid":4194304,"network":false,"root":"{}","preparing":true,"started":1,"startTicks":1}}"#, "a".repeat(64))).unwrap();
        let s = space(&data, &repos, &[]);
        assert!(ids.iter().all(|id| why(&s, id).is_some_and(|(r, _)| r == Room::Free)), "{:?}", s.items);
        assert_eq!(free(&data, &repos, &ids, &[]).removed.len(), 3);
        assert!(!env.exists() && !cache.exists() && repos.join("os-starting/package.json").is_file());
        let _ = fs::remove_dir_all(&data);
    }
}

#[cfg(test)]
mod id_tests {
    use super::*;

    #[test]
    fn an_id_from_the_page_cannot_lead_out_of_the_data_directory() {
        let top = std::env::temp_dir().join(format!("length3-ids-{}", std::process::id()));
        let data = top.join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Named like a temporary file left by a process long gone, but outside.
        let outside = top.join(".x.length3-4194300-0");
        std::fs::write(&outside, b"keep").unwrap();
        std::fs::File::options().write(true).open(&outside).unwrap().set_modified(SystemTime::now() - Duration::from_secs(3 * 86_400)).unwrap();
        let id = format!("path:{}/../.x.length3-4194300-0", data.display());
        assert!(item(&data, &data.join("repos"), &id, &InUse::now(&data, &[])).is_none());
        let _ = std::fs::remove_dir_all(&top);
    }
}

#[cfg(test)]
mod room_tests {
    use super::*;

    #[test]
    fn room_is_made_from_what_comes_back_first_and_never_from_what_only_this_device_has() {
        let item = |id: &str, allocated: u64, room: Room| Item { id: id.into(), what: String::new(), detail: String::new(), allocated, room, why: String::new() };
        let items = [item("repo:old", 500, Room::Free), item("repo:fresh", 900, Room::Free), item("repo:unsent", 900, Room::SyncFree),
            item("env:old", 900, Room::Free), item("cache:a", 10, Room::Free), item("cache:b", 30, Room::Free), item("derived:a", 20, Room::Free),
            item("root:prev", 300, Room::Free), item("root:older", 5, Room::Free), item("path:/x", 1, Room::Free), item("home", 1, Room::Keep)];
        let day = 24 * 60 * 60 * 1000;
        let touched = [("repo:old".to_string(), 0), ("repo:fresh".to_string(), 9 * day)].into_iter().collect();
        let all = room_order(&items, &["root:prev".into()], &touched, 10 * day, u64::MAX);
        assert_eq!(all, ["root:older", "path:/x", "cache:b", "cache:a", "derived:a", "root:prev", "repo:old"]);
        // Only as much as is wanted.
        assert_eq!(room_order(&items, &["root:prev".into()], &touched, 10 * day, 30), ["root:older", "path:/x", "cache:b"]);
    }
}
