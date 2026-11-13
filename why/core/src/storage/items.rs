//! What this OS holds on the device, as one list by size: each repo, root, environment, cache and leftover,
//! measured where the host measures it, and what can be done with it (go now, sent first, or stays and why).

use serde::Serialize;
use std::fs;
use crate::fs::write::temporary_writer;
use crate::fs::size::{allocated, blocks, links};
use crate::fs::kept::Kept;
use crate::repos::measure::{measured, Measure};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Everything that can go, as ids for `free`.
pub fn all_freeable(s: &Space) -> Vec<String> {
    s.items.iter().filter(|i| i.room != Room::Keep).map(|i| i.id.clone()).collect()
}

/// Everything this OS holds under `data` (repos in `repos`), largest first: each folder's size as last measured
/// in this process (fs/kept.rs), or with `fresh` measured now.
/// `open`: repos a Prompt the host knows of has open now (a browser's own);
/// every Prompt on a root, the app's and why's, is read from its record here.
pub fn space(data: &Path, repos_dir: &Path, open: &[String], fresh: bool) -> Space {
    let (host_total, host_free, host) = host(data);
    let mut items = Vec::new();
    let connected = crate::remote::connection().is_some();
    let in_use = InUse::now(data, open);
    let mut left = Vec::new();
    let mut kept = false;
    // What was walked as a repo's copies is not walked again for leftovers.
    let mut walked = vec![repos_dir.to_path_buf()];
    if let Ok(repos) = crate::repos::store::Repos::new(repos_dir.to_path_buf()) {
        for name in repos.names().unwrap_or_default() {
            let Ok(dir) = repos.dir(&name) else { continue };
            let c = copies(&dir, &name, fresh, &mut left);
            kept |= c.kept;
            walked.push(crate::fs::paths::data_dir().join("work").join(&name));
            items.extend(repo_item(&repos, &name, &c, connected, &in_use));
            items.extend(derived_item(&name, &c.derived, &in_use));
        }
    }
    for (row, _) in system(data) {
        items.push(root_item(row, &in_use));
    }
    for (kind, repo, _) in crate::prompt::writes::held(data) {
        items.extend(owned_item(data, repos_dir, kind, &repo, fresh, &in_use, &mut kept));
    }
    leftovers(data, data, &walked, &mut left);
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
        kept,
        items,
    }
}

/// One thing by its id, looked at now and alone.
pub(super) fn item(data: &Path, repos_dir: &Path, id: &str, in_use: &InUse) -> Option<Item> {
    if let Some(name) = id.strip_prefix("repo:") {
        let repos = crate::repos::store::Repos::new(repos_dir.to_path_buf()).ok()?;
        repo_item(&repos, name, &copies(&repos.dir(name).ok()?, name, true, &mut Vec::new()), crate::remote::connection().is_some(), in_use)
    } else if let Some(sha) = id.strip_prefix("root:") {
        system(data).into_iter().find(|(r, _)| r.sha256 == sha).map(|(r, _)| root_item(r, in_use))
    } else if let Some(path) = id.strip_prefix("path:") {
        leftover_at(data, repos_dir, Path::new(path)).map(leftover_item)
    } else if let Some(repo) = id.strip_prefix("env:") {
        owned_item(data, repos_dir, "env", repo, true, in_use, &mut false)
    } else if let Some(repo) = id.strip_prefix("cache:") {
        owned_item(data, repos_dir, "cache", repo, true, in_use, &mut false)
    } else if let Some(repo) = id.strip_prefix("derived:") {
        if !crate::text::names::valid_name(repo) { return None; }
        derived_item(repo, &copies(&repos_dir.join(repo), repo, true, &mut Vec::new()).derived, in_use)
    } else if id == "home" {
        Some(Item { id: "home".into(), what: "Home".into(), detail: String::new(), allocated: 0, room: Room::Keep, why: crate::tr!("This device's settings", "この端末の設定です") })
    } else {
        None
    }
}

/// Whether `path` is a leftover now, by the same rules as the scans, looked
/// at alone (freeing one thing does not walk everything again).
fn leftover_at(data: &Path, repos_dir: &Path, path: &Path) -> Option<Leftover> {
    let system = crate::root::system_dir(data);
    let dir = path.parent()?;
    if dir == system || dir == system.join(".bundles") {
        let mut found = Vec::new();
        system_leftovers(data, &mut found);
        return found.into_iter().find(|l| l.path == path && !l.root);
    }
    // Under the data directory or the repos', never inside a repo's .git or the system directory.
    let rel = path.strip_prefix(data).or_else(|_| path.strip_prefix(repos_dir)).ok()?;
    // Plain names only: an id from the page with `..` in it must not lead out of the data directory.
    if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) { return None; }
    if rel.components().any(|c| crate::text::names::is_git_name(&c.as_os_str().to_string_lossy())) || path.starts_with(&system) { return None; }
    left_behind(path, &path.symlink_metadata().ok()?, dir == data.join("home"))
}

/// The temporary `path` (`meta` its own, not a link's), if this OS left it behind: named as it names a file while it
/// writes it (a setting's form only in the settings directory), one name of it alone, a minute old, its writer gone.
fn left_behind(path: &Path, meta: &fs::Metadata, in_settings: bool) -> Option<Leftover> {
    if !meta.is_file() || links(meta) != 1 { return None; }
    let pid = temporary_writer(&path.file_name()?.to_string_lossy(), in_settings)?;
    (age(meta) >= AGE && pid != crate::pid() && !running(pid))
        .then(|| Leftover { path: path.to_path_buf(), allocated: blocks(meta), what: crate::tr!("A temporary file left behind", "残った一時ファイル"), root: false })
}

/// A repo's copies here, each walked once (measure.rs): the repo itself, and each work on it.
struct Copies {
    /// The blocks of the repo but what is derived in it, and of each work whole.
    allocated: u64,
    works: usize,
    /// What is derived in the repo, each folder's blocks counted once.
    derived: Vec<(PathBuf, u64)>,
    /// Some of it as last measured, not now.
    kept: bool,
}

/// The blocks of a folder walked whole (what is derived, an environment, caches), as last measured (fs/kept.rs).
static ALLOCATED: Kept<u64> = Kept::new();

/// `dir`'s blocks as last measured in this process (and true: so they may be older than now), or with `fresh`
/// measured now.
fn allocated_of(dir: &Path, fresh: bool) -> (u64, bool) {
    ALLOCATED.of(dir, fresh, || allocated(dir))
}

/// Nothing measured is kept: what was just taken away is measured again when next asked.
pub(super) fn forget() {
    ALLOCATED.forget();
    crate::repos::measure::forget();
}

/// The repo `name` at `dir`, its works measured with it (`fresh`: now, not as last measured); what this OS left
/// behind in them goes to `left`.
fn copies(dir: &Path, name: &str, fresh: bool, left: &mut Vec<Leftover>) -> Copies {
    let (repo, mut kept) = measured(dir, fresh);
    let works: Vec<Measure> = crate::repos::lines::worktrees(name).iter().map(|(_, p)| { let (w, k) = measured(p, fresh); kept |= k; w }).collect();
    for t in repo.temporaries.iter().chain(works.iter().flat_map(|w| &w.temporaries)) {
        if let Some(l) = t.symlink_metadata().ok().and_then(|m| left_behind(t, &m, false)) { left.push(l); }
    }
    let mut of = |d: &PathBuf| { let (n, k) = allocated_of(d, fresh); kept |= k; n };
    let whole: u64 = works.iter().map(|m| m.allocated + m.derived.iter().map(&mut of).sum::<u64>()).sum();
    let derived = repo.derived.iter().map(|d| (d.clone(), of(d))).collect();
    Copies { allocated: repo.allocated + whole, works: works.len(), derived, kept }
}

fn leftover_item(l: Leftover) -> Item {
    let name = l.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Item { id: format!("path:{}", l.path.display()), what: l.what, detail: name, allocated: l.allocated, room: Room::Free, why: crate::tr!("Left behind by this OS", "この OS の残り物です") }
}

fn root_item(row: SystemUsage, in_use: &InUse) -> Item {
    // The current one stays whether or not a Prompt runs now (the why every Prompt starts on); one a Prompt
    // runs on stays while it does, current or not, so making another current takes nothing from under it.
    let (room, why) = match (row.held, in_use.root(&row.sha256)) {
        (Held::Current, _) => (Room::Keep, crate::tr!("The root Prompts run on", "Prompt が動く root です")),
        (_, Some(why)) => (Room::Keep, why),
        (Held::Previous, None) => (Room::Free, crate::tr!("The root before; going back fetches it again from the Remote", "ひとつ前の root。戻すときは Remote から取り直せます")),
        (Held::Older, None) => (Room::Free, crate::tr!("An old root; the Remote has it", "古い root。Remote から取り直せます")),
    };
    Item { id: format!("root:{}", row.sha256), what: format!("{} {}", row.name, row.version), detail: "root".into(), allocated: row.allocated, room, why }
}

/// What is derived from a repo's own files, if it has any, each folder with its blocks.
fn derived_item(repo: &str, derived: &[(PathBuf, u64)], in_use: &InUse) -> Option<Item> {
    if derived.is_empty() { return None; }
    let mut names: Vec<String> = derived.iter().filter_map(|(p, _)| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    names.sort();
    names.dedup();
    let (room, why) = if let Some(why) = in_use.repo(repo) {
        (Room::Keep, why)
    } else {
        (Room::Free, crate::tr!("Made again from its files by the tool that made it", "元のファイルから、作ったツールがまた作ります"))
    };
    Some(Item { id: format!("derived:{repo}"), what: repo.into(), detail: crate::tr!("derived · {}", "派生物 · {}", names.join(", ")),
        allocated: derived.iter().map(|(_, n)| n).sum(), room, why })
}

/// A repo's environment ("env") or caches ("cache"), if it has them here.
fn owned_item(data: &Path, repos_dir: &Path, kind: &str, repo: &str, fresh: bool, in_use: &InUse, kept: &mut bool) -> Option<Item> {
    if !crate::text::names::valid_name(repo) { return None; }
    let dir = if kind == "env" { crate::prompt::writes::env_dir(data, repo) } else { crate::prompt::writes::cache_dir(data, repo) };
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
    let (allocated, was) = allocated_of(&dir, fresh);
    *kept |= was;
    Some(Item { id: format!("{kind}:{repo}"), what: repo.into(), detail, allocated, room, why })
}

fn repo_item(repos: &crate::repos::store::Repos, name: &str, copies: &Copies, connected: bool, in_use: &InUse) -> Option<Item> {
    let s = crate::remote::status_of(repos, name).ok()?;
    let files = s.unsynced.len() + s.files;
    let (room, why) = if let Some(why) = in_use.repo(name) {
        (Room::Keep, why)
    } else if !connected {
        (Room::Keep, crate::tr!("Sign in to Remote to delete", "Remote にサインインすると解放できます"))
    } else if let Some((path, what)) = s.unsynced.first() {
        (Room::Keep, crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, what))
    } else if s.changed == 0 && !s.fresh {
        (Room::Free, crate::tr!("Identical copy on Remote; opening restores it", "Remote に同じデータが存在します。開くことでいつでも復元できます。"))
    } else {
        (Room::SyncFree, if s.fresh { crate::tr!("Not on the Remote yet; sent, then freed", "まだ Remote にありません。送ってから空けます") } else { if s.changed == 1 { crate::tr!("1 change is sent, then it is freed", "1件の変更を送ってから空けます") } else { crate::tr!("{} changes are sent, then it is freed", "{}件の変更を送ってから空けます", s.changed) } })
    };
    // Every copy of it counts: main's and each issue's being worked on; what is derived in it is its own item.
    let size = copies.allocated;
    // One file is one file (1 file, not 1 files); Japanese counts the same either way.
    let files = if files == 1 { crate::tr!("1 file", "1ファイル") } else { crate::tr!("{} files", "{}ファイル", files) };
    let detail = match copies.works {
        0 => crate::tr!("repo · {}", "repo · {}", files),
        1 => crate::tr!("repo · {} · 1 work", "repo · {} · 作業 1", files),
        n => crate::tr!("repo · {} · {} works", "repo · {} · 作業 {}", files, n),
    };
    Some(Item { id: format!("repo:{name}"), what: name.into(), detail, allocated: size, room, why })
}

fn preparing_why() -> String {
    crate::tr!("A Prompt being prepared uses it (.packages, .setup)", "用意中の Prompt が使っています（.packages、.setup）")
}

/// What the Prompts here hold now, so none of it goes under them: the repos they have open (and with each,
/// its environment, caches and what is derived in it) and the roots they run on, each with whether every
/// Prompt holding it is still being prepared.
pub(super) struct InUse {
    repos: Vec<(String, bool)>,
    roots: Vec<(String, bool)>,
    /// A Prompt whose record does not say its root (an older why's): any root may be the one, so all stay.
    unsaid: bool,
}

impl InUse {
    /// `open`: repos the host knows a Prompt of its own has open. Every Prompt on a root records itself, and
    /// its record says more (being prepared, the root); a browser's has none, and is running.
    pub(super) fn now(data: &Path, open: &[String]) -> InUse {
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
            else { crate::tr!("Locked by an active Prompt", "Prompt で使用中") })
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

/// The Prompts recorded here, each its repo, its root, and whether it is still being prepared (prompt/running.rs).
/// The core built for the web runs none.
fn recorded(data: &Path) -> Vec<(String, Option<String>, bool)> {
    #[cfg(not(target_os = "wasi"))]
    return crate::prompt::running::all(data).into_iter().map(|r| (r.repo, r.root, r.preparing)).collect();
    #[cfg(target_os = "wasi")]
    { let _ = data; Vec::new() }
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
    /// Some figure as last measured in this process, so possibly older than now: the page asks for it measured afresh.
    pub kept: bool,
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

pub(super) fn host(dir: &Path) -> (u64, u64, Certainty) {
    match crate::fs::size::room(dir) {
        Ok((total, free)) => (total, free, Certainty::Estimated),
        Err(_) => (0, 0, Certainty::Unknown),
    }
}

/// This OS's own leftover temporaries under `dir` (never inside a repo's .git, and not in the system directory, which
/// has its own rules, nor in what was `walked` as a repo's copies), for the data directory `data`.
fn leftovers(dir: &Path, data: &Path, walked: &[PathBuf], out: &mut Vec<Leftover>) {
    let settings = data.join("home");
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if crate::text::names::is_git_name(&name) { continue; }
        let path = e.path();
        // Asked of the directory already open (fstatat), links not followed.
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            // A repo's environment and caches are listed as theirs, not walked for leftovers.
            let theirs = dir == data && (name == "envs" || name == "caches");
            if !theirs && path != crate::root::system_dir(data) && !walked.contains(&path) { leftovers(&path, data, walked, out); }
            continue;
        }
        out.extend(left_behind(&path, &meta, dir == settings.as_path()));
    }
}

/// Whether the writer `pid` is there; where that cannot be asked (not unix), it may be, so what it wrote stays.
#[cfg(unix)]
fn running(pid: u32) -> bool {
    crate::prompt::running::alive(pid)
}
#[cfg(not(unix))]
fn running(_: u32) -> bool { true }

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
        // `.<sha>.why-<pid>-0`: an install's unpacking, whose installer is gone.
        if meta.is_dir() && name.starts_with('.') {
            if let Some(pid) = temporary_writer(&name, false) {
                if age(&meta) >= AGE && pid != crate::pid() && !running(pid) {
                    out.push(Leftover { allocated: allocated(&e.path()), path: e.path(), what: crate::tr!("An unpacking that stopped half way", "途中で止まった展開"), root: false });
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
                let n = allocated(&e.path());
                about.allocated = Some(n);
                // Not kept, it is counted again next time.
                if let Ok(text) = serde_json::to_vec(&about) { let _ = crate::fs::write::replace(&e.path().join("installed.json"), &text, crate::fs::write::How::RECORD); }
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

fn age(meta: &fs::Metadata) -> Duration {
    meta.modified().ok().and_then(|t| SystemTime::now().duration_since(t).ok()).unwrap_or_default()
}

const AGE: Duration = Duration::from_secs(60);

#[derive(Serialize, Debug, Clone)]
pub struct SystemUsage {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub allocated: u64,
    pub held: Held,
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
struct Leftover {
    path: PathBuf,
    /// An older root (listed as a root, not as a leftover).
    root: bool,
    allocated: u64,
    /// What it is, in a word or two.
    what: String,
}

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

