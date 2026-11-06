//! A copy kept in step with the Remote: the draft sent as a diff on the version it was read at, what changed there
//! taken in file by file against the base (merge.rs), a repo brought here whole, and where each copy stands.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::repos::store::Repos;
use crate::fs::hash::sha256;
use std::fs;
use crate::Result;

use serde::Serialize;
use super::base::{at, Base, base, forget_base, key, key_of, lock, set_base, tree_of};
use super::connection::{forget_connection, own_secrets};
use super::http::{Client, failed, Failure, odd, Reply};
use super::local::{local_tree, Modes, modes_for, secrets_held, Tree};
use super::login::account_id;
use super::merge::{apply, plan, take_modes};

pub fn status(repos: &Repos) -> Result<Vec<Status>> {
    repos.names()?.iter().map(|name| status_of(repos, name)).collect()
}

pub fn status_of(repos: &Repos, name: &str) -> Result<Status> {
    let mut here = local_tree(&repos.dir(name)?);
    let b = base(&key(repos, name).0);
    // A mode is a change only where the Remote keeps modes; where it said it keeps none, an execute bit cannot be sent.
    let moded = b.as_ref().is_none_or(|b| b.moded);
    // What holds a secret is not a change to send: it stays here, said as unsent (as sync says it).
    let held = secrets_held(&here, b.as_ref().map_or(&Tree::new(), |b| &b.tree), &own_secrets());
    let unsent = |p: &String| held.iter().any(|(h, _)| h == p);
    let changed = match &b {
        Some(b) => here.tree.iter().filter(|(p, v)| !unsent(p) && (b.tree.get(*p) != Some(*v) || (moded && here.modes.get(*p) != b.modes.get(*p)))).count() + b.tree.keys().filter(|p| !here.tree.contains_key(*p)).count(),
        None => here.tree.keys().filter(|p| !unsent(p)).count(),
    };
    here.unsynced.extend(held);
    if !moded { for p in here.modes.keys() { here.unsynced.push((p.clone(), crate::tr!("its execute bit (this Remote keeps no modes yet)", "実行ビット（この Remote はまだモードを持ちません）"))); } }
    Ok(Status {
        name: name.into(), changed, fresh: b.is_none(), files: here.tree.values().filter(|v| v.is_some()).count(), unsynced: here.unsynced, bytes: here.bytes,
        head: b.as_ref().and_then(|b| b.head.clone()), version: b.map_or(0, |b| b.version),
    })
}

/// Where a repo here stands, from what is here alone (no network).
#[derive(Serialize, Debug, Clone)]
pub struct Status {
    pub name: String,
    /// Paths changed here since the last agreement (0: in step).
    pub changed: usize,
    /// Never agreed with the Remote.
    pub fresh: bool,
    /// Files in the copy here (what is sent of it).
    pub files: usize,
    pub unsynced: Vec<(String, String)>,
    pub bytes: u64,
    pub head: Option<String>,
    pub version: i64,
}

/// Bring a repo that is only on the Remote here (opening it does this).
/// `room` is asked for room before the repo comes (storage/free.rs bring_repo).
pub fn fetch(repos: &Repos, repo: &str, room: impl FnOnce()) -> Result<Synced> {
    if repos.dir(repo).is_ok() {
        return sync(repos, repo);
    }
    if !crate::text::names::valid_name(repo) {
        return Err(crate::tr!("{} is not a repo name", "{} は repo の名前になりません", repo));
    }
    let client = Client::open()?;
    // Brought here: room made for it first if the device is short.
    room();
    let _held = lock(repo)?;
    if let Reply::NotFound(_) = client.call("GET", &format!("/v1/repos/{repo}"), None)? {
        return Err(failed(Failure::Status(404), crate::tr!("The Remote has no repo {}", "Remote に repo {} はありません", repo)));
    }
    // It comes as main; the work on its issues comes when chosen.
    forget_base(repo)?;
    let _ = fs::remove_file(crate::fs::paths::data_dir().join("sync").join(format!("{repo}.line")));
    fs::create_dir_all(repos.root().join(repo)).map_err(|e| e.to_string())?;
    sync_with(&client, repos, repo)
}

/// Every repo here brought into step; repos only on the Remote stay there
/// until they are opened. Each repo's outcome is its own.
pub fn sync_all(repos: &Repos) -> Result<Vec<(String, Result<Synced>)>> {
    let client = Client::open()?;
    let mut out = Vec::new();
    for s in repos.list()? {
        let r = lock(&key(repos, &s.name).0).and_then(|_held| sync_with(&client, repos, &s.name));
        out.push((s.name, r));
    }
    Ok(out)
}

/// What the Remote has of a line, for a copy that last agreed `agreed` with it,
/// taken only as a Remote says it (line_there). Not there, it has nothing of the
/// line, unless the copy was in step before (discarded there, or another
/// account's): then nothing here is taken for removed, and why is said
/// (src/remote/sync.ts does the same).
pub(super) fn there_of(url: &str, reply: Reply, agreed: i64, tree: Option<&Tree>) -> Result<Option<LineThere>> {
    match reply {
        Reply::Ok(v) => Ok(Some(line_there(url, &v, tree)?)),
        Reply::NotFound(v) if agreed > 0 => Err(failed(Failure::Status(404), if v["gone"].is_null() {
            crate::tr!("Repo not found on Remote; local copy preserved", "Remote 上にこの repo が見つかりません。ローカルのコピーは保持されています")
        } else {
            crate::tr!("Repo deleted on Remote; local copy preserved", "この repo は Remote 上で破棄されました。ローカルのコピーは保持されています")
        })),
        Reply::NotFound(_) => Ok(None),
        Reply::Conflict(_) => Err(odd(url)),
    }
}

/// Where a line's diff is sent. A copy never in step with the Remote makes it
/// anew, even under a name the Remote remembers as discarded (src/remote/sync.ts);
/// one that was in step cannot bring back what was discarded by sending itself.
pub(super) fn draft_path(repo: &str, line: &str, agreed: bool) -> String {
    let p = at(repo, line, "/draft");
    if agreed || line != crate::repos::lines::MAIN { p } else { format!("{p}?anew=1") }
}

pub(super) fn sync_with(client: &Client, repos: &Repos, repo: &str) -> Result<Synced> {
    let dir = repos.dir(repo)?;
    let (key, line) = key(repos, repo);
    let path = at(repo, &line, "");
    let mut out = Synced::default();
    let who = account_id();
    let mut first: Option<Tree> = None;
    for _ in 0..12 {
        let agreed = base(&key);
        // Agreed with another account (another person signed in on this device): this copy is theirs, and is
        // neither sent to this account nor joined with its repo of the same name.
        if let (Some(was), Some(now)) = (agreed.as_ref().and_then(|b| b.who.as_deref()), who.as_deref()) {
            if was != now {
                return Err(failed(Failure::Status(403), crate::tr!("This copy was synced by another account; sign in to resume sync", "このコピーは別のアカウントで同期されていました。同期を再開するには該当アカウントでサインインしてください")));
            }
        }
        let draft = draft_path(repo, &line, agreed.is_some());
        let base = agreed.unwrap_or_default();
        let here = local_tree(&dir);
        first.get_or_insert_with(|| here.tree.clone());
        out.unsynced = here.unsynced.clone();
        // Before sending, see whether the Remote moved: asked from the version agreed, it says only what changed since
        // (nothing, when nothing did), not the draft whole each time.
        let looked = if base.version > 0 { format!("{path}{}since={}", if path.contains('?') { '&' } else { '?' }, base.version) } else { path.clone() };
        let there = there_of(&client.url, client.call("GET", &looked, None)?, base.version, Some(&base.tree))?;
        let remote_version = there.as_ref().map_or(0, |l| l.version);
        // Whether the Remote keeps modes: one that has the line says; one that has not, is taken to (what is sent says them).
        let kept = there.as_ref().is_none_or(|l| l.modes.is_some());
        if !kept {
            // Said, never let go of: an execute bit only here is not on the Remote, so this copy is not the last to free.
            for p in here.modes.keys() { out.unsynced.push((p.clone(), crate::tr!("its execute bit (this Remote keeps no modes yet)", "実行ビット（この Remote はまだモードを持ちません）"))); }
        }
        if remote_version != base.version {
            let (tree, head, modes) = there.map_or((Tree::new(), None, None), |l| (l.draft, l.head, l.modes));
            let p = plan(&base.tree, &here.tree, &tree);
            out.both.extend(apply(client, &dir, &here.tree, &p, modes.as_ref())?);
            // A mode changed there only (the file's bytes as they were) is taken too; one changed here stays and is sent.
            if let Some(m) = &modes { take_modes(&dir, &base.modes, &here.modes, m, &tree, &p); }
            out.taken += p.take.len();
            set_base(&key, &Base { version: remote_version, tree, head, moded: modes.is_some(), modes: modes.unwrap_or(base.modes), who: who.clone() })?;
            continue;
        }
        // The Remote can commit without touching the draft (a work's first start commits main
        // as it stands): its head is then newer than the one kept, though the version is not.
        let mut base = base;
        let said = there.as_ref().map(|l| (l.head.clone(), l.modes.is_some()));
        if let Some((head, moded)) = said.filter(|(h, m)| *h != base.head || *m != base.moded) {
            (base.head, base.moded) = (head, moded);
            set_base(&key, &base)?;
        }
        let moded = |p: &String| kept && here.modes.get(p) != base.modes.get(p);
        let mut set: Vec<(&String, &Option<String>)> = here.tree.iter().filter(|(p, v)| base.tree.get(*p) != Some(*v) || moded(p)).collect();
        let mut remove: Vec<&String> = base.tree.keys().filter(|p| !here.tree.contains_key(*p)).collect();
        // A file holding a secret is not sent (device/secrets.rs): it stays here as it is, named as what cannot be sent, and
        // the Remote keeps the version it had (nothing of it is removed there).
        let held = secrets_held(&here, &base.tree, &own_secrets());
        set.retain(|(p, _)| !held.iter().any(|(h, _)| h == *p));
        out.unsynced.extend(held);
        if set.is_empty() && remove.is_empty() {
            out.version = base.version;
            if let Some(was) = first.as_ref().filter(|_| out.taken > 0 || !out.both.is_empty()) {
                out.paths = was.keys().chain(here.tree.keys()).filter(|p| was.get(*p) != here.tree.get(*p)).cloned().collect();
                out.paths.sort();
                out.paths.dedup();
            }
            // An agreement from before accounts were noted is this account's from now on.
            if who.is_some() && base.version > 0 && base.who != who {
                base.who = who.clone();
                set_base(&key, &base)?;
            }
            return Ok(out);
        }
        // At most CHUNK paths a diff; what is left goes in the next round.
        set.truncate(CHUNK);
        remove.truncate(CHUNK);
        // Contents the Remote lacks go first.
        let shas: Vec<&str> = set.iter().filter_map(|(_, v)| v.as_deref()).collect();
        if !shas.is_empty() {
            let missing = client.json("POST", "/v1/blobs/missing", Some(serde_json::json!(shas)))?;
            let mut moved = false;
            for sha in missing.as_array().into_iter().flatten().filter_map(|s| s.as_str()) {
                let from = here.files.get(sha).ok_or_else(|| crate::tr!("A file changed meanwhile", "ファイルが途中で変わりました"))?;
                let bytes = fs::read(from).map_err(|e| e.to_string())?;
                // Changed since it was read: read the tree again.
                if sha256(&bytes) != sha { moved = true; break; }
                client.put_blob(sha, &bytes)?;
            }
            if moved { continue; }
        }
        let mut body = serde_json::json!({
            "version": base.version,
            "set": set.iter().map(|(p, v)| ((*p).clone(), serde_json::json!(v))).collect::<serde_json::Map<_, _>>(),
            "remove": remove,
        });
        // Each file set with an execute bit, its mode; a file set without one is a plain file there too.
        if kept { body["modes"] = serde_json::json!(set.iter().filter_map(|(p, _)| here.modes.get(*p).map(|m| ((*p).clone(), *m))).collect::<Modes>()); }
        // A conflict (someone else moved it, or a blob went missing) goes round again.
        if let Reply::Ok(v) = client.call("PATCH", &draft, Some(body))? {
            // Without the version it is at now, nothing is agreed: the next round reads the line again.
            let version = v["version"].as_i64().ok_or_else(|| odd(&client.url))?;
            let mut tree = base.tree.clone();
            for p in &remove {
                tree.remove(*p);
                let under = format!("{p}/");
                tree.retain(|q, _| !q.starts_with(&under));
            }
            for (p, v) in &set { tree.insert((*p).clone(), (*v).clone()); }
            let mut modes = base.modes.clone();
            if kept { for (p, _) in &set { match here.modes.get(*p) { Some(m) => { modes.insert((*p).clone(), *m); } None => { modes.remove(*p); } } } }
            let modes = modes_for(&tree, &modes);
            out.sent += set.len() + remove.len();
            out.version = version;
            set_base(&key, &Base { version, tree, head: base.head, modes, moded: base.moded || kept, who: who.clone() })?;
        }
    }
    // Still moving after every round: not in step, and said so, rather than taken for it.
    Err(crate::tr!("Remote modified concurrently; retrying", "Remote 側で変更が続いているため、後ほど再試行します"))
}

/// Bring `repo` and the Remote into step: send what changed here, take in
/// what changed there, until both hold the same draft.
pub fn sync(repos: &Repos, repo: &str) -> Result<Synced> {
    let client = Client::open()?;
    let (key, _) = key(repos, repo);
    let _held = lock(&key)?;
    sync_with(&client, repos, repo)
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Synced {
    pub version: i64,
    /// Paths sent, and paths written here from the Remote.
    pub sent: usize,
    pub taken: usize,
    /// Changed on both sides: the Remote's kept at its name, this device's beside it.
    pub both: Vec<String>,
    pub unsynced: Vec<(String, String)>,
    /// Every path this copy changed by taking in (a file written or removed, a folder made, a copy kept
    /// beside), so a page tells each to what shows it, rather than reading the whole repo again.
    #[serde(default)]
    pub paths: Vec<String>,
}

/// `agreed` with each change laid on in turn, as the Remote laid each save on its draft (repos.ts applyDiff): each path
/// taken away goes with everything under it, then each path set is written. None when one is not a change the Remote
/// says.
pub(super) fn changed(agreed: &Tree, changes: &[serde_json::Value]) -> Option<Tree> {
    let mut tree = agreed.clone();
    for c in changes {
        let set = c["set"].as_object().filter(|s| s.values().all(|x| x.is_string() || x.is_null()))?;
        for p in c["remove"].as_array()? {
            let p = p.as_str()?;
            tree.remove(p);
            let under = format!("{p}/");
            let gone: Vec<String> = tree.range(under.clone()..).take_while(|(k, _)| k.starts_with(&under)).map(|(k, _)| k.clone()).collect();
            for k in gone { tree.remove(&k); }
        }
        for (p, x) in set { tree.insert(p.clone(), x.as_str().map(String::from)); }
    }
    Some(tree)
}

/// What the Remote said of a line, when it said it as a Remote does: a version, a draft each of whose
/// entries is a digest or a folder (null), and a head or none. Anything else is refused, never taken for
/// a line with no files (bug: a network's sign-in page was read as version 0 with nothing in it, and
/// every file here unchanged since the last agreement was removed). Asked from the version agreed
/// (?since=), the Remote may say only what each save after it changed (`changes`): laid on `agreed`, the
/// draft at that version, in turn, they are the draft.
pub(super) fn line_there(url: &str, v: &serde_json::Value, agreed: Option<&Tree>) -> Result<LineThere> {
    let version = v["version"].as_i64().filter(|n| *n >= 0);
    let draft = match (&v["draft"], &v["changes"], agreed) {
        (serde_json::Value::Object(d), _, _) if d.values().all(|x| x.is_string() || x.is_null()) => Some(tree_of(&v["draft"])),
        (serde_json::Value::Null, serde_json::Value::Array(cs), Some(agreed)) => changed(agreed, cs),
        _ => None,
    };
    let head = match &v["head"] { serde_json::Value::Null => Some(None), serde_json::Value::String(h) => Some(Some(h.clone())), _ => None };
    // Modes, when it keeps them: each a file's permission bits.
    let modes = match &v["modes"] {
        serde_json::Value::Null => Some(None),
        serde_json::Value::Object(o) => o.iter().map(|(p, m)| m.as_u64().filter(|m| *m <= 0o777).map(|m| (p.clone(), m as u32))).collect::<Option<Modes>>().map(Some),
        _ => None,
    };
    match (version, draft, head, modes) {
        (Some(version), Some(draft), Some(head), Some(modes)) => {
            let modes = modes.map(|m| modes_for(&draft, &m));
            Ok(LineThere { version, draft, head, modes })
        }
        _ => Err(odd(url)),
    }
}

/// A line of a repo as the Remote holds it (`GET /v1/repos/:name`).
#[derive(Debug, PartialEq)]
pub(super) struct LineThere {
    pub(super) version: i64,
    pub(super) draft: Tree,
    pub(super) head: Option<String>,
    /// Its files' modes; None from a Remote that keeps none yet (one before modes were).
    pub(super) modes: Option<Modes>,
}

/// Paths one diff carries at most (the Remote takes 5000).
const CHUNK: usize = 2000;

/// End this device's session on the Remote, then forget it here. Every repo
/// is sent first: forgetting what was agreed with a change still unsent
/// (a file removed here, say) would undo it at the next sign-in, when the
/// Remote's copy comes back as new. So a repo that cannot be sent stops it.
pub fn logout(repos: &Repos) -> Result<()> {
    let Ok(c) = Client::open() else { return forget_connection() };
    for name in repos.names()? {
        // Main's copy and each issue's, each in step before any record of them goes.
        let shown = repos.line(&name);
        let mut lines: Vec<String> = crate::repos::lines::worktrees(&name).into_iter().map(|(l, _)| l).collect();
        lines.push(crate::repos::lines::MAIN.into());
        for line in lines {
            let r = lock(&key_of(&name, &line)).and_then(|_held| {
                // Not shown, it would not be the copy sent; and the repo is shown again as it was, whatever sending did.
                crate::repos::lines::show_for_free(&name, &line)?;
                let r = sync_with(&c, repos, &name);
                crate::repos::lines::show_for_free(&name, &shown).and(r)
            });
            if let Err(e) = r {
                let what = if line == crate::repos::lines::MAIN { name.clone() } else { format!("{name}@{line}") };
                return Err(crate::tr!("{} could not be sent first ({}); this device stays on the Remote so nothing is lost. Once it is sent, sign out again",
                    "{} を先に送れませんでした（{}）。何も失わないよう、この端末は Remote につないだままです。送れたら、もう一度外してください", what, e));
            }
        }
    }
    // SSH stops with the device's session: no one reaches its Prompts once it is signed out.
    #[cfg(unix)]
    let _ = crate::ssh::stop(&crate::fs::paths::data_dir());
    // Everything is sent: signed out here whatever the Remote answers (its session ends there by itself).
    let _ = c.call("POST", "/api/auth/sign-out", Some(serde_json::json!({})));
    forget_connection()
}


