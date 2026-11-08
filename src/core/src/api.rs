//! The one way a page asks the core: a command's name and its arguments as JSON, its answer as JSON.
//! The app's window asks it through Tauri (src/desktop/src/main.rs), a browser through the same core built
//! for the web (web/), and l3 calls the modules themselves: what a person can do is done by this code alone,
//! whichever of the three they are in front of. What only a host can do (open a page in the browser, start a
//! Prompt on the root, SSH) is the host's, around this.

// No unsafe code here.
#![forbid(unsafe_code)]

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{agent::activity, agent::hands, agent::tasks, device::agent_key, fs::paths, history, history::work, home, remote, remote::account, storage};

/// Files the editor may save; anything read in part is never written back.
pub const READ_LIMIT: u64 = 256 * 1024;
/// Lines of difference shown at most, across all files.
const DIFF_LIMIT: usize = 2000;

/// The commands that write a repo's files or Home's state: a host runs them in the order the page sent them
/// (the app on its window's thread), never side by side with each other.
pub const WRITES: &[&str] = &["repo_create", "repo_write", "repo_put", "repo_add", "repo_mkdir", "repo_remove", "repo_move", "repo_rename",
    "repo_delete", "state_set", "dotfile_set", "dotfiles_take"];

/// Answer `name` with `args` (an object of the command's arguments, by name).
pub fn call(name: &str, args: &Value) -> crate::Result<Value> {
    let a = Args(args);
    let repos = || crate::repos::store::Repos::open();
    // The repo as it is seen now, or (`main`) main's copy whatever work it shows: where its issues are.
    let seen = || -> crate::Result<crate::repos::store::Repos> { let r = repos()?; Ok(if a.opt::<bool>("main")?.unwrap_or(false) { r.on_main() } else { r }) };
    match name {
        "repo_list" => to(repos()?.list(a.opt("fresh")?.unwrap_or(false))?),
        // Their names alone: nothing walked (what a page that only names them, or only checks one is there, asks).
        "repo_names" => to(repos()?.names()?),
        "repo_create" => to(repos()?.create(&a.s("name")?, &a.s("template")?)?),
        "repo_tree" => to(seen()?.tree(&a.s("repo")?, &a.s("path")?)?),
        "repo_read" => to(seen()?.read(&a.s("repo")?, &a.s("path")?, READ_LIMIT)?),
        "repo_write" => to(seen()?.write(&a.s("repo")?, &a.s("path")?, &a.s("text")?, READ_LIMIT)?),
        // A file's bytes for a browser's Prompt (as base64), of any kind, up to what one Prompt copies in all.
        "repo_bytes" => {
            use base64::Engine;
            to(base64::engine::general_purpose::STANDARD.encode(repos()?.bytes(&a.s("repo")?, &a.s("path")?, 32 << 20)?))
        }
        // What a browser's Prompt wrote back, whole (its bytes as base64): a file of any kind, its folders made.
        "repo_put" => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD.decode(a.s("bytes")?).map_err(|e| format!("bytes: {e}"))?;
            to(repos()?.put(&a.s("repo")?, &a.s("path")?, bytes, u64::MAX, true)?.0)
        }
        "repo_add" => to(seen()?.add(&a.s("repo")?, &a.s("dir")?, &a.s("name")?, &a.s("text")?, READ_LIMIT)?),
        "repo_mkdir" => to(seen()?.mkdir(&a.s("repo")?, &a.s("path")?)?),
        "repo_remove" => to(seen()?.remove(&a.s("repo")?, &a.s("path")?)?),
        "repo_move" => to(repos()?.move_to(&a.s("repo")?, &a.s("path")?, &a.s("to")?)?),
        // A repo itself renamed, or taken from this device whole (`open`: the repos a Prompt has open, the host's to know).
        "repo_rename" => to(remote::rename_repo(&repos()?, &a.s("repo")?, &a.s("to")?, &a.list("open")?)?),
        "repo_delete" => to(remote::delete_repo(&repos()?, &a.s("repo")?, &a.list("open")?)?),
        "state_get" => {
            let key = a.s("key")?;
            // A session kept as earlier releases kept it (its bearer beside the rest) is kept as now before it is read.
            if key == "remote" { let _ = remote::connection(); }
            to(home::get(&key)?)
        }
        // What this device runs of the dotfiles is changed only by a dotfile written here or taken here (below), never set;
        // and which Remote it is on, as whom, only by signing in or out (a page set it, and this device's repos would be
        // sent wherever it said).
        "state_set" => {
            let key = a.s("key")?;
            if key == "trusted" { return Err(crate::tr!("What runs here is changed by writing a dotfile or taking one", "ここで動くものは、dotfile を書くか取り込むかで変わります")); }
            if key == "remote" { return Err(crate::tr!("Which Remote this device is on is changed by signing in or out", "どの Remote につなぐかは、サインインかサインアウトで変わります")); }
            to(home::set(&key, &a.s("json")?)?)
        }
        // A dotfile written here (`text` null: removed) runs here at once; one changed elsewhere runs here once taken
        // (`names`, or every one waiting). home/dotfiles.rs dotfiles_in_effect.
        "dotfile_set" => to(home::set_dotfile(&a.s("name")?, a.opt::<String>("text")?.as_deref())?),
        "dotfiles_take" => to(home::take_dotfiles(&a.list("names")?)?),
        "dotfiles_in_effect" => to(home::dotfiles_in_effect().into_iter().collect::<std::collections::BTreeMap<_, _>>()),
        // The Agent's key (device/agent_key.rs), kept on this device only: whether there is one, as it may be shown; kept (with
        // the model it opens) or taken away (`key` null); and, whole, for the page that asks the model with it.
        // A key a passkey sealed (a browser's: src/app/account/seal.ts) is said as sealed; the page opens it, once a session.
        "agent_key" => to(agent_key::held().map(|h| match h {
            agent_key::Held::Given(k) => json!({"shown": agent_key::shown(&k.key), "model": k.model}),
            agent_key::Held::Sealed(s) => json!({"shown": s.shown, "model": s.model, "sealed": true}),
        })),
        // A key a page sealed by a passkey, kept sealed: `key` read only for how it is shown and its variable, never kept.
        "agent_key_seal" => {
            let key = a.s("key")?;
            let (_, variable) = agent_key::kind(key.trim()).ok_or_else(|| crate::tr!("This is not an API key this OS knows", "この OS が知っている API キーではありません"))?;
            to(agent_key::seal(&agent_key::Sealed { sealed: a.get("sealed")?, shown: agent_key::shown(key.trim()), variable: variable.into(),
                model: a.opt::<String>("model")?.unwrap_or_default().trim().into() })?)
        }
        "agent_key_set" => {
            let key = a.opt::<String>("key")?;
            let model = a.opt::<String>("model")?.unwrap_or_default();
            to(agent_key::set(key.as_deref().map(|k| (k, model.as_str())))?)
        }
        // What a key given would be read as (its variable), before it is kept; refused when it is no key this OS knows.
        "agent_key_kind" => to(agent_key::kind(a.s("key")?.trim()).map(|(_, var)| var)
            .ok_or_else(|| crate::tr!("This is not an API key this OS knows", "この OS が知っている API キーではありません"))?),
        "agent_key_use" => to(agent_key::held().and_then(|h| match h {
            agent_key::Held::Given(k) => agent_key::kind(&k.key).map(|(_, var)| json!({"key": k.key, "variable": var, "model": k.model})),
            agent_key::Held::Sealed(s) => Some(json!({"sealed": s.sealed, "variable": s.variable, "model": s.model})),
        })),

        // The Agent's hands' rules (agent/hands.rs), one meaning wherever it works: a file's lines read from where asked,
        // with where to go on; a run's output as it is given back; an edit as pieces of text found once and replaced
        // (the file is the caller's to write, so what watches the repo hears of it as of any write).
        "agent_read" => {
            let (repo, path) = (a.s("repo")?, a.s("path")?);
            let c = seen()?.read(&repo, &path, READ_LIMIT)?;
            let text = c.text.ok_or_else(|| crate::tr!("{} is not text", "{} はテキストではありません", path))?;
            to(hands::part(&text, a.opt("offset")?, a.opt("limit")?)?)
        }
        "agent_tail" => to(hands::tail(&a.s("output")?)),
        "agent_edit" => to(hands::edit(&a.s("path")?, &a.s("text")?, &a.get::<Vec<hands::Change>>("edits")?)?),

        // The box's Agent saying what it does, as an agent's hooks do (agent/activity.rs from_box): asked, answered.
        "agent_said" => {
            let repo = a.s("repo")?;
            crate::repos::store::Repos::open()?.dir(&repo)?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            to(activity::append(&activity::from_box(&a.s("session")?, &repo, a.get("kind")?, &a.opt::<String>("text")?.unwrap_or_default(), now))?)
        }
        // What agents do in the repos, as their hooks said it (agent/activity.rs): null when nothing came since `cursor`.
        // And the work handed to the agent (agent/tasks.rs), when it changed since `tasks` (the mark last read). Null when
        // neither moved: what a page asks every second reads a few bytes then.
        "agents" => {
            let journal = activity::now_since(&a.opt::<activity::Cursor>("cursor")?.unwrap_or_default(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64));
            let mark = tasks::mark();
            let book = (a.opt::<[u64; 3]>("tasks")? != Some(mark)).then(|| json!({"mark": mark, "agent": tasks::agent(),
                "list": tasks::all().into_iter().filter(|k| !k.state.over()).collect::<Vec<_>>()}));
            if journal.is_none() && book.is_none() { Ok(Value::Null) } else { Ok(json!({"journal": journal, "tasks": book})) }
        }
        // The person's deed on a task: hand it over, put it away, answer it; or a question asked.
        "task" => match a.s("deed")?.as_str() {
            "take" => to(tasks::take(a.get("id")?)?),
            "drop" => to(tasks::drop_task(a.get("id")?)?),
            "reply" => to(tasks::reply(a.get("id")?, &a.s("words")?)?),
            "ask" => to(tasks::ask(&a.s("repo")?, &a.s("words")?)?),
            d => Err(crate::tr!("There is no deed {}", "{} という操作はありません", d)),
        },

        // What this OS holds: `open`, the repos a Prompt has open (the host's to know).
        "space" => to(storage::space(paths::data_dir(), paths::repos_dir(), &a.list("open")?, a.opt("fresh")?.unwrap_or(false))),
        "free" => to(storage::free(paths::data_dir(), paths::repos_dir(), &a.list("ids")?, &a.list("open")?)),

        // Signing in: the code, and the page to approve it on, which only the host can open; the page is the
        // Remote's own (or its app's, on the origin it says), never one a page names.
        "remote_login_start" => {
            let url = remote::default_url();
            let code = remote::device_start(&url, &a.s("client")?)?;
            if !remote::device_page_ok(&url, remote::app_origin(&url).as_deref(), &code.verification_uri_complete) {
                return Err(crate::tr!("The Remote named a page that is not its own", "Remote が自分のものでないページを示しました"));
            }
            to(code)
        }
        "remote_login_wait" => to(remote::device_finish(&remote::default_url(), &a.s("client")?, &a.get("code")?)?),
        "remote_logout" => to(remote::logout(&repos()?)?),
        // A session a page signed in with (a provider, a passkey): the cookie the Remote set, which the browser keeps
        // and no script reads; another account's copies kept theirs (login.rs connect).
        "remote_connect" => to(remote::connect(&a.s("url")?, None)?),
        // The app's page asking its Remote, sent with this device's session, which the page never holds.
        "remote_ask" => to(remote::ask(&a.s("method")?, &a.s("path")?, a.opt::<String>("body")?.as_deref(),
            &a.opt::<Vec<(String, String)>>("headers")?.unwrap_or_default())?),
        // The Remote already let this session go: nothing can be sent with it, and nothing here is let go.
        "remote_forget" => to(remote::forget_connection()?),
        "remote_repos" => to(remote::remote_repos()?),
        "remote_status" => to(remote::status(&repos()?)?),
        "sync_repo" => to(remote::sync(&repos()?, &a.s("repo")?)?),
        "repo_fetch" => to(storage::bring_repo(&repos()?, &a.s("repo")?)?),
        // One of Home's settings agreed with the Remote (home/agree.rs agree_with).
        "home_sync" => to(remote::sync_home(&a.s("key")?)?),
        // One of them taken off this device, only as the Remote has it (home/agree.rs leave).
        "home_leave" => to(remote::leave_home(&a.s("key")?)?),
        // The plan's page (Checkout, or the portal) as the Remote makes it for this account; the host opens it.
        "plan_page" => to(account::plan_page(if a.s("kind")? == "portal" { "portal" } else { "checkout" }, a.opt::<String>("tier")?.as_deref())?),
        // What only the browser can do (a passkey's), as a page of the Remote's own app; the host opens it.
        "app_page" => to(account::app_page(&a.s("ask")?, a.opt::<String>("repo")?.as_deref())?),

        "history_changes" => to(history::changes(&repos()?, &a.s("repo")?)?),
        "history_changed" => to(history::changed(&repos()?, &a.s("repo")?)?),
        "history_diff" => to(history::diff(&repos()?, &a.s("repo")?, DIFF_LIMIT)?),
        "history_at_head" => to(history::at_head(&repos()?, &a.s("repo")?, &a.s("path")?)?),
        "history_cut" => {
            let issue = a.opt("issue")?.map(|f: String| format!("issue/{}", f.trim_start_matches("issue/")));
            to(history::cut(&repos()?, &a.s("repo")?, issue.as_deref(), &a.s("line")?, &a.s("note")?)?)
        }
        "history_log" => to(history::log(&repos()?, &a.s("repo")?, 50)?),
        // An issue's own file committed on main by itself, as it was just written ("new", "change", "close", "reopen");
        // and those main holds not committed yet (written signed out, renumbered), each by itself.
        "issue_commit" => to(history::commit_issue(&repos()?, &a.s("repo")?, &a.s("file")?, &a.s("deed")?)?),
        "issues_settle" => to(history::settle_issues(&repos()?, &a.s("repo")?)?),
        "history_push" => to(history::push(&repos()?, &a.s("repo")?)?),
        "history_submit" => to(history::submit(&repos()?, &a.s("repo")?, &a.s("note")?)?),
        "history_reset" => to(history::reset(&repos()?, &a.s("repo")?)?),
        "work_start" => to(work::start(&repos()?, &a.s("repo")?, &a.s("issue")?)?),
        "work_switch" => to(work::switch(&repos()?, &a.s("repo")?, &a.s("line")?)?),
        "work_state" => to(crate::history::work::state(&repos()?, &a.s("repo")?)?),
        "work_lines" => to(crate::remote::lines(&a.s("repo")?)?),
        "changes_list" => to(history::changes_of_repo(&a.s("repo")?)?),
        // Each repo's own answer, as `answer` gives one: {ok: {work, lines, changes}}, or {error} (with its status and
        // detail when the Remote refused it).
        "work_standings" => to(crate::history::work::standings(&repos()?, &a.list("repos")?)?.into_iter()
            .map(|r| r.map_or_else(|why| why, |s| json!({"ok": s}))).collect::<Vec<_>>()),
        "change_review" => to(history::review(&a.s("repo")?, &a.s("id")?, &a.s("verdict")?, &a.s("note")?, &a.list("marks")?)?),
        "change_merge" => to(history::merge(&a.s("repo")?, &a.s("id")?)?),
        "change_reject" => to(history::reject(&a.s("repo")?, &a.s("id")?, &a.s("note")?)?),
        "change_diff" => to(history::change_diff(&a.s("repo")?, &a.s("id")?, DIFF_LIMIT)?),
        _ => Err(crate::tr!("There is no command {}", "{} というコマンドはありません", name)),
    }
}

fn to<T: Serialize>(v: T) -> crate::Result<Value> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// A command's arguments, read by name; one missing or of the wrong kind is said by its name.
struct Args<'a>(&'a Value);

impl Args<'_> {
    fn get<T: DeserializeOwned>(&self, key: &str) -> crate::Result<T> {
        serde_json::from_value(self.0.get(key).cloned().unwrap_or(Value::Null))
            .map_err(|e| crate::tr!("{}: {}", "{}：{}", key, e))
    }
    fn opt<T: DeserializeOwned>(&self, key: &str) -> crate::Result<Option<T>> { self.get(key) }
    fn s(&self, key: &str) -> crate::Result<String> { self.get(key) }
    fn list(&self, key: &str) -> crate::Result<Vec<String>> {
        Ok(self.opt::<Vec<String>>(key)?.unwrap_or_default())
    }
}

/// The answer as a host passes it on: `{"ok": …}` or `{"error": "…"}`.
///
/// A refusal of the Remote's says how it answered too: `status` (0: not reached, 401: it no longer knows
/// this device) and its `detail` (a plan's rule, say), so a page tells a refusal from a fault as the app does.
pub fn answer(name: &str, args: &Value) -> Value {
    remote::forget_failure();
    match call(name, args) {
        Ok(v) => json!({"ok": v}),
        Err(e) => match remote::last_failure().filter(|(_, said)| *said == e) {
            Some((f, _)) => {
                let status = match f { remote::Failure::Status(code) => code, remote::Failure::Unknown => 401, _ => 0 };
                json!({"error": e, "status": status, "detail": remote::last_detail()})
            }
            None => json!({"error": e}),
        },
    }
}
