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
                let aside = e.path().join(format!(".installed.json.length3-{}-0", std::process::id()));
                if fs::write(&aside, serde_json::to_string(&about).unwrap_or_default()).is_ok() { let _ = fs::rename(&aside, e.path().join("installed.json")); }
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
                if age(&meta) >= AGE && pid != std::process::id() && !running(pid) {
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
        if old && pid != std::process::id() && !running(pid) {
            out.push(Leftover { path, allocated: blocks(&meta), what: crate::tr!("A temporary file left behind", "残った一時ファイル"), root: false });
        }
    }
}

fn host(dir: &Path) -> (u64, u64, Certainty) {
    match crate::system::capacity(dir) {
        Ok(c) => (c.total, c.free, Certainty::Estimated),
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

fn repo_item(repos: &crate::repos::Repos, name: &str, connected: bool, open: &[String]) -> Option<Item> {
    let dir = repos.dir(name).ok()?;
    let s = crate::remote::status_of(repos, name).ok()?;
    let files = s.unsynced.len() + crate::remote::local_tree(&dir).tree.values().filter(|v| v.is_some()).count();
    let (room, why) = if open.iter().any(|o| o == name) {
        (Room::Keep, crate::tr!("A Prompt has it open", "Prompt で開いています"))
    } else if !connected {
        (Room::Keep, crate::tr!("Connect to the Remote to free it", "Remote につなぐと空けられます"))
    } else if let Some((path, what)) = s.unsynced.first() {
        (Room::Keep, crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, what))
    } else if s.changed == 0 && !s.fresh {
        (Room::Free, crate::tr!("The Remote has the same; opening it brings it back", "Remote と同じです。開けばまた来ます"))
    } else {
        (Room::SyncFree, if s.fresh { crate::tr!("Not on the Remote yet; sent, then freed", "まだ Remote にありません。送ってから空けます") } else { crate::tr!("{} changes are sent, then it is freed", "{}件の変更を送ってから空けます", s.changed) })
    };
    // Every copy of it counts: main's and each issue's being worked on; what is derived in it is its own item.
    let works = crate::work::worktrees(name);
    let derived: u64 = crate::owned::derived_in(&dir).iter().map(|p| allocated(p)).sum();
    let size = allocated(&dir).saturating_sub(derived) + works.iter().map(|(_, p)| allocated(p)).sum::<u64>();
    let detail = match works.len() {
        0 => crate::tr!("repo · {} files", "repo · {}ファイル", files),
        1 => crate::tr!("repo · {} files · 1 work", "repo · {}ファイル · 作業 1", files),
        n => crate::tr!("repo · {} files · {} works", "repo · {}ファイル · 作業 {}", files, n),
    };
    Some(Item { id: format!("repo:{name}"), what: name.into(), detail, allocated: size, room, why })
}

/// A repo's environment ("env") or caches ("cache"), if it has them here.
fn owned_item(data: &Path, repos_dir: &Path, kind: &str, repo: &str, open: &[String]) -> Option<Item> {
    if !crate::repos::valid_name(repo) { return None; }
    let dir = if kind == "env" { crate::owned::env_dir(data, repo) } else { crate::owned::cache_dir(data, repo) };
    if !dir.is_dir() { return None; }
    let (room, why) = if open.iter().any(|o| o == repo) {
        (Room::Keep, crate::tr!("A Prompt has it open", "Prompt で開いています"))
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
fn derived_item(repos_dir: &Path, repo: &str, open: &[String]) -> Option<Item> {
    if !crate::repos::valid_name(repo) { return None; }
    let found = crate::owned::derived_in(&repos_dir.join(repo));
    if found.is_empty() { return None; }
    let mut names: Vec<String> = found.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    names.sort();
    names.dedup();
    let (room, why) = if open.iter().any(|o| o == repo) {
        (Room::Keep, crate::tr!("A Prompt has it open", "Prompt で開いています"))
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
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) { open_up(&e.path()); }
        }
    }
    let size = allocated(dir);
    open_up(dir);
    fs::remove_dir_all(dir).map(|_| size).map_err(|e| e.to_string())
}

fn root_item(row: SystemUsage) -> Item {
    let (room, why) = match row.held {
        Held::Current => (Room::Keep, crate::tr!("The root Prompts run on", "Prompt が動く root です")),
        Held::Previous => (Room::Free, crate::tr!("The root before; going back fetches it again from the Remote", "ひとつ前の root。戻すときは Remote から取り直せます")),
        Held::Older => (Room::Free, crate::tr!("An old root; the Remote has it", "古い root。Remote から取り直せます")),
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
    if rel.components().any(|c| crate::repos::is_git_name(&c.as_os_str().to_string_lossy())) || path.starts_with(&system) { return None; }
    let meta = path.symlink_metadata().ok()?;
    if !meta.is_file() || links(&meta) != 1 { return None; }
    let pid = temporary_writer(&path.file_name()?.to_string_lossy(), dir == data.join("home"))?;
    (age(&meta) >= AGE && pid != std::process::id() && !running(pid))
        .then(|| Leftover { path: path.to_path_buf(), allocated: blocks(&meta), what: crate::tr!("A temporary file left behind", "残った一時ファイル"), root: false })
}

/// One thing by its id, looked at now and alone.
fn item(data: &Path, repos_dir: &Path, id: &str, open: &[String]) -> Option<Item> {
    if let Some(name) = id.strip_prefix("repo:") {
        let repos = crate::repos::Repos::new(repos_dir.to_path_buf()).ok()?;
        repo_item(&repos, name, crate::remote::connection().is_some(), open)
    } else if let Some(sha) = id.strip_prefix("root:") {
        system(data).into_iter().find(|(r, _)| r.sha256 == sha).map(|(r, _)| root_item(r))
    } else if let Some(path) = id.strip_prefix("path:") {
        leftover_at(data, Path::new(path)).map(leftover_item)
    } else if let Some(repo) = id.strip_prefix("env:") {
        owned_item(data, repos_dir, "env", repo, open)
    } else if let Some(repo) = id.strip_prefix("cache:") {
        owned_item(data, repos_dir, "cache", repo, open)
    } else if let Some(repo) = id.strip_prefix("derived:") {
        derived_item(repos_dir, repo, open)
    } else if id == "home" {
        Some(Item { id: "home".into(), what: "Home".into(), detail: String::new(), allocated: 0, room: Room::Keep, why: crate::tr!("This device's settings", "この端末の設定です") })
    } else {
        None
    }
}

/// Everything this OS holds under `data` (repos in `repos`), largest first.
/// `open`: repos a Prompt has open now.
pub fn space(data: &Path, repos_dir: &Path, open: &[String]) -> Space {
    let (host_total, host_free, host) = host(data);
    let mut items = Vec::new();
    let connected = crate::remote::connection().is_some();
    if let Ok(repos) = crate::repos::Repos::new(repos_dir.to_path_buf()) {
        for s in repos.list().unwrap_or_default() {
            items.extend(repo_item(&repos, &s.name, connected, open));
            items.extend(derived_item(repos_dir, &s.name, open));
        }
    }
    for (row, _) in system(data) {
        items.push(root_item(row));
    }
    for (kind, repo, _) in crate::owned::held(data) {
        items.extend(owned_item(data, repos_dir, kind, &repo, open));
    }
    let mut left = Vec::new();
    leftovers(data, data, &mut left);
    system_leftovers(data, &mut left);
    for l in left.into_iter().filter(|l| !l.root) {
        items.push(leftover_item(l));
    }
    let home = allocated(&data.join("home")) + allocated(&data.join("sync"));
    items.push(Item { id: "home".into(), what: "Home".into(), detail: crate::tr!("settings, TODO, what was agreed with the Remote", "設定・TODO・同期の記録"), allocated: home, room: Room::Keep, why: crate::tr!("This device's settings", "この端末の設定です") });
    items.sort_by(|a, b| b.allocated.cmp(&a.allocated).then(a.what.cmp(&b.what)));
    Space {
        host_total, host_free, host,
        allocated: items.iter().map(|i| i.allocated).sum(),
        freeable: items.iter().filter(|i| i.room != Room::Keep).map(|i| i.allocated).sum(),
        items,
    }
}

/// Free these ids, each looked at again (alone: nothing else is walked)
/// just before it goes; then say what the host shows for it.
pub fn free(data: &Path, repos_dir: &Path, ids: &[String], open: &[String]) -> Freed {
    let (_, before, certainty) = host(data);
    let (mut freed, mut removed, mut kept) = (0, Vec::new(), Vec::new());
    for id in ids {
        let Some(item) = item(data, repos_dir, id, open) else {
            kept.push((id.clone(), crate::tr!("It is gone already", "もうありません")));
            continue;
        };
        if item.room == Room::Keep {
            kept.push((id.clone(), item.why.clone()));
            continue;
        }
        let gone: Result<u64, String> = if let Some(name) = id.strip_prefix("repo:") {
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
        let about = crate::root::Installed { name: "OS".into(), version: version.into(), sha256: sha.to_string().repeat(64), files: 4, bytes: 20_000, allocated: None };
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
        assert!(c.room == Room::Free && c.why.contains("not on this device"), "{c:?}");
        assert!(!s.items.iter().any(|i| i.id.starts_with("path:")), "nothing in an environment is a leftover");
        // Open in a Prompt, it stays.
        assert_eq!(item(&data, &repos, "env:here", &["here".into()]).unwrap().room, Room::Keep);

        let f = free(&data, &repos, &["env:here".into(), "cache:gone".into(), "derived:here".into()], &[]);
        assert_eq!(f.removed.len(), 3, "{:?}", f.kept);
        assert!(!env.exists() && !gone.exists() && !repos.join("here/node_modules").exists() && !repos.join("here/out").exists());
        assert!(repos.join("here/package.json").is_file() && repos.join("here/vendor/node_modules/keep.js").is_file(), "the repo's own files stay");
        let _ = fs::remove_dir_all(&data);
    }
}
