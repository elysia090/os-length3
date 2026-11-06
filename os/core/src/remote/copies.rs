//! This device's copies as wholes: freed (sent first, let go once the Remote holds all of it), renamed or deleted,
//! with what is kept of each by its name moved or let go with it; and the repos the Remote holds.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::repos::store::Repos;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use crate::Result;
use super::base::{at, base, forget_base, key_of, lock};
use super::connection::{connection, gone, sync_dir};
use super::http::Client;
use super::local::{held_open, local_tree, local_tree_fresh, Modes, Tree};
use super::sync::{line_there, sync_with};

/// Every copy moved aside put back where it was. None when all went back; else what could not, and where it is.
fn put_back(moved: &[(String, PathBuf, PathBuf)]) -> Option<String> {
    let mut lost = Vec::new();
    for (_, dir, aside) in moved.iter().rev() {
        if let Err(e) = crate::fs::write::rename_new(aside, dir) {
            lost.push(crate::tr!("{} is kept at {} ({})", "{} は {} に残しました（{}）", dir.display(), aside.display(), e));
        }
    }
    (!lost.is_empty()).then(|| lost.join("; "))
}

/// Where a copy is moved to be freed: beside it, under a name no repo, work or temporary has (a dot first,
/// and not this OS's temporary's), so nothing lists it, syncs it or reclaims it as a leftover meanwhile.
fn aside_of(dir: &Path) -> PathBuf {
    let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    dir.with_file_name(format!(".{name}.freeing-{}", crate::pid()))
}

fn free_with(client: &Client, repos: &Repos, repo: &str) -> Result<u64> {
    let shown = repos.line(repo);
    let mut copies: Vec<String> = crate::repos::lines::worktrees(repo).into_iter().map(|(l, _)| l).collect();
    copies.push(crate::repos::lines::MAIN.into());
    // Turned off on the Remote: nothing can be sent to it, so a copy goes
    // only when it holds nothing the Remote lacks (the Remote keeps it 30 days).
    let off = serde_json::from_value::<Vec<RemoteRepo>>(client.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())?
        .into_iter().any(|r| r.name == repo && r.off_at.is_some());
    // Each copy's sync is held until it is gone or back, so no sync here writes it meanwhile.
    let mut held = Vec::new();
    let mut checked: Vec<(String, String, PathBuf, Tree, Modes)> = Vec::new();
    for line in &copies {
        let key = key_of(repo, line);
        held.push(lock(&key)?);
        let dir = copy_dir(repos, repo, line);
        if off {
            let (agreed, modes) = base(&key).map(|b| (b.tree, b.modes)).unwrap_or_default();
            let local = local_tree(&dir);
            let here = &local.tree;
            let changed = here.keys().chain(agreed.keys()).collect::<BTreeSet<_>>().into_iter()
                .filter(|p| here.get(*p) != agreed.get(*p) || local.modes.get(*p) != modes.get(*p)).count();
            if changed > 0 {
                return Err(if changed == 1 {
                    crate::tr!("1 change here is not on the Remote; turn it on to send it first", "ここの変更 1件が Remote にありません。オンにして先に送ってください")
                } else {
                    if changed == 1 { crate::tr!("1 change here is not on the Remote; turn it on to send it first", "ここの変更 1件が Remote にありません。オンにして先に送ってください") } else { crate::tr!("{} changes here are not on the Remote; turn it on to send them first", "ここの変更 {}件が Remote にありません。オンにして先に送ってください", changed) }
                });
            }
            checked.push((key, line.clone(), dir, agreed, modes));
            continue;
        }
        crate::repos::lines::show_for_free(repo, line)?;
        let s = sync_with(client, repos, repo);
        crate::repos::lines::show_for_free(repo, &shown)?;
        let s = s?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(crate::tr!("Something cannot be sent to the Remote ({}: {})", "Remote に送れないものがあります（{}: {}）", path, why));
        }
        if let Some(p) = s.both.first() {
            return Err(crate::tr!("Both changed {}: this device's is kept beside it; check it before freeing", "{} は両方で変わりました。この端末の版を横に置いたので、確かめてから空けてください", p));
        }
        let here = local_tree(&dir);
        let b = base(&key).ok_or_else(|| crate::tr!("Not on the Remote yet", "まだ Remote にありません"))?;
        if here.tree != b.tree || here.modes != b.modes {
            return Err(crate::tr!("Data modified during transfer; please retry", "送信中にデータが変更されました。もう一度お試しください。"));
        }
        checked.push((key, line.clone(), dir, b.tree, b.modes));
    }
    // Moved aside, every copy, before any is let go.
    let mut moved: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for (key, _, dir, _, _) in &checked {
        let aside = aside_of(dir);
        if let Err(e) = crate::fs::write::rename_new(dir, &aside) {
            let why = crate::tr!("{} could not be moved to be freed: {}", "{} を空けるために動かせませんでした：{}", dir.display(), e);
            return Err(put_back(&moved).map_or(why.clone(), |lost| format!("{why}; {lost}")));
        }
        moved.push((key.clone(), dir.clone(), aside));
    }
    let refused = |why: String| -> String { put_back(&moved).map_or(why.clone(), |lost| format!("{why}; {lost}")) };
    // Nothing may hold what was moved: it could write on into it, and that would go with it.
    for (_, dir, aside) in &moved {
        if let Some(who) = held_open(aside) {
            return Err(refused(crate::tr!("{} is open in {}: it could still write there, so it is kept here (close it and free again)",
                "{} は {} が開いています。まだ書けるので、ここに残しました（閉じてからもう一度空けてください）", dir.display(), who)));
        }
    }
    // Read again whole, every byte (no digest kept from before counts): exactly what the Remote holds.
    for ((_, line, _, agreed, modes), (_, _, aside)) in checked.iter().zip(&moved) {
        let now = local_tree_fresh(aside);
        if !now.unsynced.is_empty() || now.tree != *agreed || now.modes != *modes {
            return Err(refused(crate::tr!("It changed while it was being freed; it is kept here and sent next", "空けているあいだに変わりました。ここに残し、次に送ります")));
        }
        if !off {
            let there = match client.json("GET", &at(repo, line, ""), None).and_then(|v| line_there(&client.url, &v, None)) {
                Ok(t) => t,
                Err(e) => return Err(refused(e)),
            };
            if there.draft != now.tree {
                return Err(refused(crate::tr!("The Remote's copy is not complete yet", "Remote の写しがまだ揃っていません")));
            }
            // An execute bit here is let go only when the Remote keeps it too: the last copy that has it is never freed otherwise.
            if there.modes.as_ref().unwrap_or(&Modes::new()) != &now.modes {
                return Err(refused(crate::tr!("The Remote does not keep a file's execute bit yet; it is kept here", "Remote がまだ実行ビットを持っていません。ここに残しました")));
            }
        }
    }
    let mut bytes = 0;
    for (key, _, aside) in &moved {
        bytes += crate::fs::size::allocated(aside);
        fs::remove_dir_all(aside).map_err(|e| e.to_string())?;
        forget_base(key)?;
    }
    drop(held);
    if !off { crate::repos::lines::show_for_free(repo, crate::repos::lines::MAIN)?; }
    Ok(bytes)
}

/// Where a copy of `repo` is: main's in the repos, an issue's among the works.
fn copy_dir(repos: &Repos, repo: &str, line: &str) -> PathBuf {
    if line == crate::repos::lines::MAIN { repos.root().join(repo) } else { crate::repos::lines::worktree(repo, line) }
}

/// `repo` taken from this device whole: its copy, what this device keeps of it by its name, and every record of it
/// with the Remote. What the Remote holds is not touched: a repo there is turned off or discarded there, asked for
/// as the Remote asks. Never while a Prompt has it open.
pub fn delete_repo(repos: &Repos, repo: &str, open: &[String]) -> Result<()> {
    let dir = repos.root().join(repo);
    repos.dir(repo)?;
    if prompted(repo, open) {
        return Err(crate::tr!("A Prompt has {} open; stop it first", "{} は Prompt で開いています。先に止めてください", repo));
    }
    let _held = lock(repo)?;
    // Moved aside in one step first, so nothing lists, opens or syncs it by its name while it goes.
    let aside = dir.with_file_name(format!(".{repo}.deleting-{}", crate::pid()));
    crate::fs::write::rename_new(&dir, &aside).map_err(|e| crate::text::i18n::io_error(repo, &e))?;
    fs::remove_dir_all(&aside).map_err(|e| crate::text::i18n::io_error(repo, &e))?;
    for kept in kept_by_name(repo) { gone(fs::remove_dir_all(kept))?; }
    for record in records_of(repo) { gone(fs::remove_file(record))?; }
    Ok(())
}

/// `repo` named `to` on this device: its copy, and what this device keeps of it by its name (its works' copies, the
/// line it shows, its environment and caches), go to the new name. Only a repo no Remote has agreed is renamed: one on
/// the Remote is known there by its name, and every device keeps it in step by it. Never while a Prompt has it open,
/// and never over a repo of that name, here or (signed in) on the Remote.
pub fn rename_repo(repos: &Repos, repo: &str, to: &str, open: &[String]) -> Result<()> {
    repos.dir(repo)?;
    if !crate::text::names::valid_name(to) {
        return Err(crate::tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", to));
    }
    if to == repo { return Ok(()); }
    if prompted(repo, open) {
        return Err(crate::tr!("A Prompt has {} open; stop it first", "{} は Prompt で開いています。先に止めてください", repo));
    }
    if agreed(repo) {
        return Err(crate::tr!("{} is on the Remote, which knows it by its name: it keeps it", "{} は Remote にあり、Remote はこの名前で知っています。名前はそのままです", repo));
    }
    let there = || crate::tr!("There is a repo {} already", "repo {} はもうあります", to);
    // Signed in, a name the Remote has is that repo's: this one renamed to it would be sent into it.
    if connection().is_some() && remote_repos()?.iter().any(|r| r.name == to) { return Err(there()); }
    let _held = lock(repo)?;
    crate::fs::write::rename_new(&repos.root().join(repo), &repos.root().join(to))
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { there() } else { crate::text::i18n::io_error(repo, &e) })?;
    // What goes with it by name follows it; what cannot (another left under the new name) stays without an owner,
    // as what a repo freed from here leaves, for Runtime to free.
    for (from, into) in kept_by_name(repo).iter().zip(kept_by_name(to)) {
        if from.exists() && !into.exists() { let _ = fs::rename(from, into); }
    }
    let _ = fs::rename(sync_dir().join(format!("{repo}.line")), sync_dir().join(format!("{to}.line")));
    Ok(())
}

/// Whether a Prompt has `repo` open: one its host runs (`open`), or one recorded running here (core/src/prompt/running.rs).
fn prompted(repo: &str, open: &[String]) -> bool {
    #[cfg(not(target_os = "wasi"))]
    if crate::prompt::running::all(crate::fs::paths::data_dir()).iter().any(|r| r.repo == repo) { return true; }
    open.iter().any(|o| o == repo)
}

/// What this device keeps of `repo` by its name besides its copy: its works' copies, its environment and caches.
fn kept_by_name(repo: &str) -> [PathBuf; 3] {
    let data = crate::fs::paths::data_dir();
    [data.join("work").join(repo), crate::prompt::writes::env_dir(data, repo), crate::prompt::writes::cache_dir(data, repo)]
}

/// Whether a Remote agreed `repo` with this device (a base is kept of it, or of the work on one of its issues): it
/// is on the Remote then, which knows an account's repos by their names.
pub fn agreed(repo: &str) -> bool {
    records_of(repo).iter().any(|p| p.extension().is_some_and(|x| x == "json"))
}

/// What this device keeps with the Remote of `repo` by its name: its bases (main's and each line's), and the line
/// it shows.
fn records_of(repo: &str) -> Vec<PathBuf> {
    let Ok(dir) = fs::read_dir(sync_dir()) else { return Vec::new() };
    let (base, line, lines) = (format!("{repo}.json"), format!("{repo}.line"), format!("{repo}@"));
    dir.flatten().map(|e| e.path()).filter(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        name == base || name == line || (name.starts_with(&lines) && name.ends_with(".json"))
    }).collect()
}

/// 空ける for a repo: once the Remote holds exactly what is here, and nothing here
/// cannot go there, the copy here goes; it comes back when the repo is opened.
/// Every copy of the repo goes: main's and each issue's being worked on.
/// Returns the bytes they took.
///
/// What was checked is what goes, up to the moment it goes (bug: a file written after the check and
/// before the delete was deleted, and Free said it was freed). Each copy, checked, is moved aside in one
/// rename, so nothing can open its files by their names any more; then nothing may still hold it (a
/// program with a file or a folder in it open, or there as its current folder, could write on after);
/// then what was moved is read again whole, every byte, and must be what the Remote holds; only then
/// does it go. Anything short of that puts every copy back where it was and Free is refused: late bytes
/// are either on the Remote or here, never freed and nowhere.
pub fn free(repos: &Repos, repo: &str) -> Result<u64> {
    free_with(&Client::open()?, repos, repo)
}

pub fn remote_repos() -> Result<Vec<RemoteRepo>> {
    serde_json::from_value(Client::open()?.json("GET", "/v1/repos", None)?).map_err(|e| e.to_string())
}

/// Bring back a repo that was turned off, at once. Turning one off asks for a passkey, so it is the app's.
pub fn turn_on(repo: &str) -> Result<()> {
    Client::open()?.json("POST", &format!("/v1/repos/{repo}/on"), Some(serde_json::json!({}))).map(|_| ())
}

/// A repo the Remote holds.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RemoteRepo {
    pub name: String,
    pub head: Option<String>,
    pub version: i64,
    pub bytes: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    /// Turned off (ms since the epoch): the Remote keeps it until `until`, answering only that it is off.
    #[serde(rename = "offAt", default)]
    pub off_at: Option<u64>,
    #[serde(default)]
    pub until: Option<u64>,
}

