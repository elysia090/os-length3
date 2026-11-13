//! A work handed to main as a change: handed in, reviewed, merged, rejected or taken back; a repo's changes and
//! where each stands; the merged issues this device has seen.

use crate::repos::store::Repos;
use crate::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, OnceLock};
use crate::remote::{self, Client, Reply};
use crate::text::title::kind_of;
use super::changes::{After, diff_of, differ, FileDiff, pairs, places};
use super::log::progress;

/// A change's diff against where it began, line by line.
pub fn change_diff(repo: &str, id: &str, limit: usize) -> Result<Vec<FileDiff>> {
    let c = find(repo, id)?;
    let client = Client::open()?;
    let (then, now) = differ(&client, repo, c.base.as_deref(), &c.head)?;
    diff_of(pairs(Some(&client), After::Remote(&client), &then, &now)?, limit)
}

/// Reset: take back the change the work handed in (its author's decision).
pub fn reset(repos: &Repos, repo: &str) -> Result<Change> {
    let on = repos.line(repo);
    if on == crate::repos::lines::MAIN {
        return Err(crate::tr!("{} shows main: reset takes back the change of the issue being worked on (why start REPO#N first)", "{} は main を見せています。reset は作業中の Issue の Change を取り下げます（先に why start REPO#N）", repo));
    }
    let c = find(repo, &on)?;
    placed(repo, change_call(repo, &c.id, "reset", serde_json::json!({}))?)
}

/// Reject: main does not take it (the receiver's decision; the issue stays open).
pub fn reject(repo: &str, id: &str, note: &str) -> Result<Change> {
    let c = find(repo, id)?;
    placed(repo, change_call(repo, &c.id, "reject", serde_json::json!({"note": note}))?)
}

/// Merge: main takes the change's current version.
pub fn merge(repo: &str, id: &str) -> Result<Change> {
    let c = find(repo, id)?;
    let merged = placed(repo, change_call(repo, &c.id, "merge", serde_json::json!({"version": c.version}))?)?;
    // What was offered or waiting for its issue is done with (agent/tasks.rs).
    crate::agent::tasks::issue_over(repo, &merged.issue);
    Ok(merged)
}

/// Review the change's current version.
pub fn review(repo: &str, id: &str, verdict: &str, note: &str, marks: &[String]) -> Result<Change> {
    let c = find(repo, id)?;
    if !["approve", "changes", "comment"].contains(&verdict) {
        return Err(crate::tr!("A review is approve, changes or comment", "レビューは approve、changes、comment のどれかです"));
    }
    // Approving a version one handed in oneself is allowed, as in the app and on the Remote:
    // every repo is one account's today, so its Review is the owner's own check before Merge.
    // A repo with more than one member is when this tightens (another member approves).
    placed(repo, change_call(repo, &c.id, "reviews", serde_json::json!({"version": c.version, "verdict": verdict, "note": note, "marks": marks}))?)
}

fn find(repo: &str, id: &str) -> Result<Change> {
    changes_of_repo(repo)?.into_iter().find(|c| c.id == id || c.id.starts_with(id) || c.line == id)
        .ok_or_else(|| {
            // Named as a person calls it: the work on issue 002 is notes#2 (bug: "handed in for 002").
            let n = crate::repos::issues::number(&format!("{id}.md"));
            let called = if n.is_empty() { id.to_string() } else { format!("{repo}{n}") };
            crate::tr!("{} has no change yet: its work is pushed first", "{} にはまだ Change がありません。先に作業を Push します", called)
        })
}

fn change_call(repo: &str, id: &str, verb: &str, body: serde_json::Value) -> Result<serde_json::Value> {
    match Client::open()?.call("POST", &format!("/v1/repos/{repo}/changes/{id}/{verb}"), Some(body))? {
        Reply::Ok(v) => Ok(v),
        Reply::Conflict(v) if v["conflicts"].is_array() => Err(crate::tr!("Both changed these files; resolve them in the work, push and change again: {}", "両方で変わったファイルがあります。作業の側で直して Push し、もう一度 Change してください：{}",
            v["conflicts"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect::<Vec<_>>().join(", "))),
        Reply::Conflict(v) if v["version"].is_number() => Err(crate::tr!("The change has a newer version ({}); look at it first", "Change に新しい版があります（第{}版）。先にそれを見てください", v["version"])),
        Reply::Conflict(v) => {
            // A Latin word stands a space apart from the Japanese before it (bug: もうMerge 済み).
            let state = state_word(v["state"].as_str().unwrap_or("?"));
            let apart = if state.starts_with(|c: char| c.is_ascii_alphabetic()) { " " } else { "" };
            Err(if crate::text::i18n::ja() { format!("この Change はもう{apart}{state}です") } else { format!("The change is {state} already") })
        }
        Reply::NotFound(_) => Err(crate::tr!("Change not found", "該当する Change はありません")),
    }
}

/// A change's state in the OS's words.
pub fn state_word(state: &str) -> String {
    match state {
        "open" => crate::tr!("undecided", "未決"),
        "merged" => crate::tr!("merged", "Merge 済み"),
        "rejected" => crate::tr!("rejected", "Reject 済み"),
        "reset" => crate::tr!("taken back", "取り下げ済み"),
        other => other.to_string(),
    }
}

/// Push, then Change, as the app's Push button does: what is pushed goes to main as its next version.
pub fn hand_in(repos: &Repos, repo: &str, note: &str) -> Result<HandIn> {
    let on = repos.line(repo);
    let before = if on == crate::repos::lines::MAIN { None } else { changes_of_repo(repo)?.into_iter().find(|c| c.line == on) };
    let head = push(repos, repo)?;
    let change = submit(repos, repo, note)?;
    Ok(HandIn { pushed: (!head.is_empty()).then_some(head), change, before })
}

/// What handing the work in did: the commit pushed (none when nothing was
/// new), the change as main now has it, and as it was before (if it was).
#[derive(Serialize, Debug, Clone)]
pub struct HandIn {
    pub pushed: Option<String>,
    pub change: Change,
    pub before: Option<Change>,
}

impl HandIn {
    /// Nothing new was handed in: main already had this very version.
    pub fn same(&self) -> bool {
        self.pushed.is_none() && self.before.as_ref().is_some_and(|b| b.state == "open" && b.version == self.change.version)
    }
}

/// Change: what the work pushed goes to main (again: a new version).
pub fn submit(repos: &Repos, repo: &str, note: &str) -> Result<Change> {
    let on = repos.line(repo);
    if on == crate::repos::lines::MAIN {
        return Err(crate::tr!("A change comes from an issue's work (why start REPO#N)", "Change は Issue の作業から渡します（why start REPO#N）"));
    }
    let (kind, title, _) = words(repos, repo, None, "")?;
    let client = Client::open()?;
    let v = client.call("POST", &format!("/v1/repos/{repo}/changes"), Some(serde_json::json!({
        "line": on, "kind": kind.unwrap_or_default(), "title": title.trim(), "note": note.trim()})))?;
    match v {
        Reply::Ok(v) => {
            let c = placed(repo, v)?;
            // Handed in here: the agent reads it by itself (agent/tasks.rs).
            crate::agent::tasks::handed_in(repo, &c.line, &c.issue, &c.title);
            Ok(c)
        }
        Reply::Conflict(v) if v["error"] == "Push required: Changes reflect pushed commits" => Err(crate::tr!("Push required: Changes reflect pushed commits", "先にプッシュしてください。Change にはプッシュされた内容が含まれます。")),
        Reply::Conflict(v) if v["error"] == "This Change is already merged" => Err(crate::tr!("Its change is merged already", "この作業の Change はもう Merge 済みです")),
        Reply::Conflict(_) => Err(crate::tr!("No commits made yet", "作業開始以降コミットされた内容はありません")),
        Reply::NotFound(_) => Err(crate::tr!("The Remote has no such work", "Remote にその作業がありません")),
    }
}

pub(crate) fn remember_merged(repo: &str, issues: impl Iterator<Item = String>) {
    let mut all = merged_seen(repo);
    let before = all.len();
    for i in issues.filter(|i| !i.is_empty()) { if !all.contains(&i) { all.push(i); } }
    if all.len() == before { return; }
    all.sort();
    // What this device saw merged, to hide it while away; not kept, it is seen again once the Remote answers.
    if crate::fs::write::private_dir(&crate::fs::paths::data_dir().join("sync")).is_ok() {
        if let Ok(b) = serde_json::to_vec(&all) { let _ = crate::fs::write::replace(&merged_file(repo), &b, crate::fs::write::How::CACHE); }
    }
}

pub fn merged_seen(repo: &str) -> Vec<String> {
    fs::read(merged_file(repo)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The issues of `repo` seen merged ("issue/001.md"), kept here so a page
/// read offline still knows them: a merge is never undone.
fn merged_file(repo: &str) -> std::path::PathBuf {
    crate::fs::paths::data_dir().join("sync").join(format!("{repo}.merged.json"))
}

/// A change as the Remote answered it, with where it reaches.
fn placed(repo: &str, v: serde_json::Value) -> Result<Change> {
    let mut c: Change = serde_json::from_value(v).map_err(|e| e.to_string())?;
    place(&Client::open()?, repo, &mut c)?;
    Ok(c)
}

/// Fill in where `c` reaches: the folders it touches and how many files (the Remote says only its commits).
fn place(client: &Client, repo: &str, c: &mut Change) -> Result<()> {
    let key = (repo.to_string(), c.base.clone(), c.head.clone());
    let known = reaches().lock().map_err(|e| e.to_string())?.get(&key).cloned();
    let reach = match known {
        Some(r) => r,
        None => {
            let (then, now) = differ(client, repo, c.base.as_deref(), &c.head)?;
            let r = places(&then, &now);
            reaches().lock().map_err(|e| e.to_string())?.insert(key, r.clone());
            r
        }
    };
    (c.folders, c.files) = reach;
    Ok(())
}

fn reaches() -> &'static Mutex<Reaches> {
    static R: OnceLock<Mutex<Reaches>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What changes reach, by the repo, the line and the commit they come to.
type Reaches = HashMap<(String, Option<String>, String), Reach>;

/// Where a change from one commit to another reaches, as `place` found it. A commit's id is made from all it is (the
/// Remote's cutId: its tree among it), so what two commits come to never changes: a change listed again (each time
/// Git is drawn, and Forge while a work is shown) asks the Remote for neither of its trees again.
type Reach = (Vec<String>, usize);

/// The changes of `repo` as the Remote listed them, each placed (where it reaches), the merged ones remembered.
pub(crate) fn listed(client: &Client, repo: &str, v: serde_json::Value) -> Result<Vec<Change>> {
    let mut list: Vec<Change> = serde_json::from_value(v).map_err(|e| e.to_string())?;
    for c in &mut list { place(client, repo, c)?; }
    remember_merged(repo, list.iter().filter(|c| c.state == "merged").map(|c| c.issue.clone()));
    Ok(list)
}

/// The changes handed to `repo`'s main, newest first, each with where it reaches.
pub fn changes_of_repo(repo: &str) -> Result<Vec<Change>> {
    let client = Client::open()?;
    let list = client.json("GET", &format!("/v1/repos/{repo}/changes"), None)?;
    listed(&client, repo, list)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Review {
    pub version: i64,
    /// "approve", "changes" or "comment".
    pub verdict: String,
    #[serde(default)]
    pub note: String,
    /// Lines marked in the version's diff, "path:index".
    #[serde(default)]
    pub marks: Vec<String>,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub time: u64,
}

/// A change handed to main.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Change {
    pub id: String,
    pub repo: String,
    pub line: String,
    #[serde(default)]
    pub issue: String,
    #[serde(default)]
    pub kind: String,
    pub title: String,
    pub version: i64,
    pub base: Option<String>,
    pub head: String,
    /// "open", "merged", "rejected" or "reset".
    pub state: String,
    #[serde(default)]
    pub note: String,
    #[serde(default, rename = "submittedBy")]
    pub submitted_by: String,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(default)]
    pub reviews: Vec<Review>,
    /// The folders it touches and how many files, filled in here.
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub files: usize,
}

/// The words a commit goes by: an issue's first line (and its file), or the line given.
pub(super) fn words(repos: &Repos, repo: &str, issue: Option<&str>, line: &str) -> Result<(Option<String>, String, String)> {
    // Work on an issue commits under it, whatever else is said.
    let on = repos.line(repo);
    let issue = issue.map(String::from).or_else(|| (on != crate::repos::lines::MAIN).then(|| format!("issue/{on}.md")));
    match issue {
        Some(file) => {
            let file = file.trim_start_matches("issue/").to_string();
            let text = repos.read(repo, &format!("issue/{file}"), 256 * 1024)?.text.ok_or_else(|| crate::tr!("The issue is not text", "Issue がバイナリです"))?;
            let i = crate::repos::issues::parse(repo, &file, &text);
            Ok((i.kind, i.title, format!("issue/{file}")))
        }
        None => {
            let (kind, title) = kind_of(line);
            Ok((kind, title, String::new()))
        }
    }
}

/// Push: the work's commits become the line's state on the Remote.
pub fn push(repos: &Repos, repo: &str) -> Result<String> {
    let on = repos.line(repo);
    if on == crate::repos::lines::MAIN {
        return Err(crate::tr!("main is pushed by merging changes into it; work on an issue to push", "main には Change を Merge して入れます。Issue の作業で Push してください"));
    }
    // Nothing new is no push: an empty answer says so.
    let l = remote::line(repo, &on)?.ok_or_else(|| crate::tr!("The Remote has no such work", "Remote にその作業がありません"))?;
    let (commits, unpushed) = progress(repo, &l)?;
    if commits == 0 { return Err(crate::tr!("No commits made yet", "作業開始以降コミットされた内容はありません")); }
    if unpushed == 0 { return Ok(String::new()); }
    let client = Client::open()?;
    let (key, _) = remote::key(repos, repo);
    let head = remote::base(&key).and_then(|b| b.head).ok_or_else(|| crate::tr!("Nothing committed yet", "まだ何も Commit していません"))?;
    let v = client.json("POST", &format!("/v1/repos/{repo}/lines/{on}/push"), Some(serde_json::json!({"head": head})))?;
    Ok(v["pushed"].as_str().unwrap_or_default().to_string())
}


