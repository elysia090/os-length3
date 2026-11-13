//! Commits: what is not committed becomes history on the work's line, issues committed as they are written and
//! settled, the log of a line, and a work's commits pushed.

use crate::remote::{self, Client, Reply, Tree};
use crate::repos::store::Repos;
use crate::text::title::named;
use crate::Result;
use super::changes::{After, blob, changes_of, head_tree, text};
use super::log::Cut;
use super::review::{push, submit, words};

/// Each issue file main's draft holds and its last commit does not (written while signed out, renumbered, or one
/// whose own commit did not go): committed now, each by itself, by what happened to it; a file gone goes with the
/// first. How many commits were made (none signed out).
pub fn settle_issues(repos: &Repos, repo: &str) -> Result<usize> {
    let Ok(client) = Client::open() else { return Ok(0) };
    let main = repos.on_main();
    let key = remote::key_of(repo, crate::repos::lines::MAIN);
    let now = remote::local_tree(&main.dir(repo)?).tree;
    let then = head_tree(&client, repo, &key, remote::base(&key).and_then(|b| b.head).as_deref())?;
    let file = |t: &Tree, p: &str| matches!(t.get(p), Some(Some(_)));
    let loose: std::collections::BTreeSet<String> = then.keys().chain(now.keys())
        .filter(|p| p.starts_with("issue/") && then.get(*p) != now.get(*p) && (file(&then, p) || file(&now, p))).cloned().collect();
    let (here, mut gone): (Vec<String>, Vec<String>) = loose.into_iter().partition(|p| file(&now, p));
    let closed = |t: Option<&str>| t.and_then(|t| crate::repos::issues::parse("", "x.md", t).closed).is_some();
    let mut made = 0;
    for p in &here {
        let text = main.read(repo, p, 256 * 1024).ok().and_then(|c| c.text);
        let before = match then.get(p) { Some(Some(sha)) => blob(&client, sha).ok().and_then(|b| self::text(&b)), _ => None };
        let deed = match (&before, closed(before.as_deref()), closed(text.as_deref())) {
            (None, _, _) => "new",
            (_, false, true) => "close",
            (_, true, false) => "reopen",
            _ => "change",
        };
        let mut paths = vec![p.clone()];
        paths.append(&mut gone);
        if cut_paths(repos, repo, &paths, &issue_words(p, text.as_deref(), deed))?.is_some() { made += 1; }
    }
    if !gone.is_empty() && cut_paths(repos, repo, &gone, &issue_words(&gone[0], None, "change"))?.is_some() { made += 1; }
    Ok(made)
}

/// An issue's own file committed on main by itself, as it was just written (`deed`: "new", "change", "close",
/// "reopen"). Signed out, it waits (settle_issues commits it once there is a Remote); as main last committed it,
/// there is nothing to commit. Whether a commit was made.
pub fn commit_issue(repos: &Repos, repo: &str, file: &str, deed: &str) -> Result<bool> {
    let path = format!("issue/{}", file.trim_start_matches("issue/"));
    let text = repos.on_main().read(repo, &path, 256 * 1024).ok().and_then(|c| c.text);
    // Written here, it is offered to the agent; closed, what was for it is done with (agent/tasks.rs). Signed in or not.
    match deed {
        "new" => crate::agent::tasks::issue_written(repo, &path, &text.as_deref().map(|t| crate::repos::issues::parse(repo, file, t).title).unwrap_or_default()),
        "close" => crate::agent::tasks::issue_over(repo, &path),
        _ => {}
    }
    if Client::open().is_err() { return Ok(false); }
    Ok(cut_paths(repos, repo, std::slice::from_ref(&path), &issue_words(&path, text.as_deref(), deed))?.is_some())
}

/// The words an issue's own commit goes by: "Issue #3: Fix：title" (written, or its words changed), "Close #3: …",
/// "Reopen #3: …"; "Issue #3 removed" for a file gone (renumbered).
pub fn issue_words(file: &str, text: Option<&str>, deed: &str) -> String {
    let file = file.trim_start_matches("issue/");
    let n = crate::repos::issues::number(file);
    let which = if n.is_empty() { file.trim_end_matches(".md").to_string() } else { n };
    let Some(text) = text else { return format!("Issue {which} removed") };
    let i = crate::repos::issues::parse("", file, text);
    let verb = match deed { "close" => "Close", "reopen" => "Reopen", _ => "Issue" };
    format!("{verb} {which}: {}", named(i.kind.as_deref(), &i.title))
}

/// Commit only `paths` of main's draft, everything else as main's last commit has it, by `title`: what an issue's own
/// file needs, so that it is history as soon as it is written, changed, closed or reopened, never riding in a commit
/// of whatever else the draft holds, nor in a work's change (a work starts from main's last commit, which has it).
/// None when they are as main last committed them. Main's, whatever work the repo shows.
fn cut_paths(repos: &Repos, repo: &str, paths: &[String], title: &str) -> Result<Option<Cut>> {
    let main = repos.on_main();
    let client = Client::open()?;
    let key = remote::key_of(repo, crate::repos::lines::MAIN);
    let only = |t: &Tree| -> Tree { t.iter().filter(|(p, _)| paths.contains(p)).map(|(p, v)| (p.clone(), v.clone())).collect() };
    for _ in 0..4 {
        let s = remote::sync(&main, repo)?;
        if let Some((path, why)) = s.unsynced.iter().find(|(p, _)| paths.contains(p)) {
            return Err(crate::tr!("{} cannot be sent to the Remote ({})", "{} を Remote に送れません（{}）", path, why));
        }
        let b = remote::base(&key).unwrap_or_default();
        // Never committed yet: what the repo was made with is its first commit (Start, as the Remote makes one when
        // work first starts), so a work begun after holds the repo's files and not only the issue.
        if b.head.is_none() {
            // Its files and folders, less the issue's own and the folders it is in (issue/: the issue's commit has it).
            let rest: Vec<&String> = b.tree.iter()
                .filter(|(p, v)| !paths.contains(p) && !(v.is_none() && paths.iter().any(|q| q.starts_with(&format!("{p}/")))))
                .map(|(p, _)| p).collect();
            if !rest.is_empty() {
                let mut body = serde_json::json!({"version": s.version, "parent": null, "kind": "", "title": "Start", "issue": "", "note": "", "added": 0, "removed": 0});
                // Without the issue, where the paths are few enough to name (else the whole draft, the issue in it).
                if rest.len() <= 5000 { body["paths"] = serde_json::json!(rest); }
                match client.call("POST", &remote::at_path(repo, crate::repos::lines::MAIN, "/cuts"), Some(body))? {
                    Reply::Ok(v) => { let _ = remote::set_head(&key, v["id"].as_str().unwrap_or_default()); }
                    Reply::Conflict(v) => { let _ = remote::set_head_from(&key, &v); }
                    Reply::NotFound(_) => return Err(crate::tr!("The Remote does not have this repo", "Remote にこの repo がありません")),
                }
                continue;
            }
        }
        let then = head_tree(&client, repo, &key, b.head.as_deref())?;
        let c = changes_of(Some(&client), After::Here(main.dir(repo)?), &only(&then), &only(&b.tree))?;
        if c.files == 0 { return Ok(None); }
        let body = serde_json::json!({
            "version": s.version, "parent": b.head, "kind": "", "title": title, "issue": "", "note": "",
            "added": c.added, "removed": c.removed, "paths": paths,
        });
        match client.call("POST", &remote::at_path(repo, crate::repos::lines::MAIN, "/cuts"), Some(body))? {
            Reply::Ok(v) => {
                let id = v["id"].as_str().unwrap_or_default().to_string();
                let _ = remote::set_head(&key, &id);
                return Ok(Some(Cut {
                    id, issue: None, kind: None, title: title.into(), note: String::new(), time: v["time"].as_u64().unwrap_or(0),
                    folders: c.folders.iter().map(|f| f.folder.clone()).collect(), files: c.files, added: c.added, removed: c.removed, merged: None, handed: None,
                }));
            }
            Reply::Conflict(v) => { let _ = remote::set_head_from(&key, &v); }
            Reply::NotFound(_) => return Err(crate::tr!("The Remote does not have this repo", "Remote にこの repo がありません")),
        }
    }
    Err(crate::tr!("Remote changed concurrently; commit aborted", "Remote 側で更新が続いているためコミットできませんでした"))
}

/// Commit: bring the draft into step with the Remote, then make it history
/// on the line the repo shows, under `issue` (its file in issue/) and named
/// after it, or named by `line`. Work on an issue commits under that issue.
pub fn cut(repos: &Repos, repo: &str, issue: Option<&str>, line: &str, note: &str) -> Result<Cut> {
    let (kind, title, issue) = words(repos, repo, issue, line)?;
    if title.trim().is_empty() {
        return Err(crate::tr!("Commit requires a title (e.g. Fix: title)", "コミットにはタイトルが必要です（例：Fix: 件名）"));
    }
    let client = Client::open().map_err(|_| crate::tr!("Commits are kept on the Remote. Sign in to it first (why login)", "コミットは Remote に残ります。先に Remote にサインインしてください（why login）"))?;
    let (key, on) = remote::key(repos, repo);
    for _ in 0..4 {
        let s = remote::sync(repos, repo)?;
        if let Some((path, why)) = s.unsynced.first() {
            return Err(crate::tr!("Something cannot be sent to the Remote ({}: {}); make it sendable, then commit", "Remote に送れないものがあります（{}: {}）。送れるようにしてから Commit してください", path, why));
        }
        let b = remote::base(&key).unwrap_or_default();
        let then = head_tree(&client, repo, &key, b.head.as_deref())?;
        let c = changes_of(Some(&client), After::Here(repos.dir(repo)?), &then, &b.tree)?;
        if c.files == 0 {
            return Err(crate::tr!("Nothing to commit", "まだ Commit していない変更がありません"));
        }
        let body = serde_json::json!({
            "version": s.version, "parent": b.head, "kind": kind.clone().unwrap_or_default(), "title": title.trim(),
            "issue": issue, "note": note.trim(), "added": c.added, "removed": c.removed,
        });
        match client.call("POST", &remote::at_path(repo, &on, "/cuts"), Some(body))? {
            Reply::Ok(v) => {
                let id = v["id"].as_str().unwrap_or_default().to_string();
                // Not kept here: the next sync takes the Remote's head again, which is this commit.
                let _ = remote::set_head(&key, &id);
                // A commit on an issue's work is handed in as it is made: there is no step of its own to push it, and
                // its change is always its last commit. Its tests run by themselves too (agent/tasks.rs).
                let handed = if on == crate::repos::lines::MAIN { None } else { push(repos, repo).and_then(|_| submit(repos, repo, "")).ok().map(|c| c.version) };
                if let Ok(dir) = repos.dir(repo) { crate::agent::tasks::committed(repo, &on, &dir); }
                return Ok(Cut {
                    id, issue: (!issue.is_empty()).then_some(issue), kind, title: title.trim().into(), note: note.trim().into(),
                    time: v["time"].as_u64().unwrap_or(0), folders: c.folders.iter().map(|f| f.folder.clone()).collect(),
                    files: c.files, added: c.added, removed: c.removed, merged: None, handed,
                });
            }
            // Another device moved the draft or committed first: in step again, and once more.
            // The Remote's head is taken in to try again from; not kept, the next sync takes it.
            Reply::Conflict(v) => { let _ = remote::set_head_from(&key, &v); }
            Reply::NotFound(_) => return Err(crate::tr!("The Remote does not have this repo", "Remote にこの repo がありません")),
        }
    }
    Err(crate::tr!("Remote changed concurrently; commit aborted", "Remote 側で更新が続いているためコミットできませんでした"))
}

