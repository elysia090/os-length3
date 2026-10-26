//! The one way a page asks the core: a command's name and its arguments as JSON, its answer as JSON.
//! The app's window asks it through Tauri (src-tauri/src/main.rs), a browser through the same core built
//! for the web (web/), and l3 calls the modules themselves: what a person can do is done by this code alone,
//! whichever of the three they are in front of. What only a host can do (open a page in the browser, start a
//! Prompt on the root, SSH) is the host's, around this.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::{account, history, home, paths, remote, repos, system, usage, work};

/// Files the editor may save; anything read in part is never written back.
pub const READ_LIMIT: u64 = 256 * 1024;
/// Lines of difference shown at most, across all files.
pub const DIFF_LIMIT: usize = 2000;

/// The commands that write a repo's files or Home's state: a host runs them in the order the page sent them
/// (the app on its window's thread), never side by side with each other.
pub const WRITES: &[&str] = &["repo_create", "repo_write", "repo_put", "repo_add", "repo_mkdir", "repo_remove", "repo_move", "state_set"];

/// Answer `name` with `args` (an object of the command's arguments, by name).
pub fn call(name: &str, args: &Value) -> crate::Result<Value> {
    let a = Args(args);
    let repos = || repos::Repos::open();
    match name {
        "repo_list" => to(repos()?.list()?),
        "repo_create" => to(repos()?.create(&a.s("name")?, &a.s("template")?)?),
        "repo_tree" => to(repos()?.tree(&a.s("repo")?, &a.s("path")?)?),
        "repo_read" => to(repos()?.read(&a.s("repo")?, &a.s("path")?, READ_LIMIT)?),
        "repo_write" => to(repos()?.write(&a.s("repo")?, &a.s("path")?, &a.s("text")?, READ_LIMIT)?),
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
        "repo_add" => to(repos()?.add(&a.s("repo")?, &a.s("dir")?, &a.s("name")?, &a.s("text")?, READ_LIMIT)?),
        "repo_mkdir" => to(repos()?.mkdir(&a.s("repo")?, &a.s("path")?)?),
        "repo_remove" => to(repos()?.remove(&a.s("repo")?, &a.s("path")?)?),
        "repo_move" => to(repos()?.move_to(&a.s("repo")?, &a.s("path")?, &a.s("to")?)?),
        "state_get" => to(home::get(&a.s("key")?)?),
        "state_set" => to(home::set(&a.s("key")?, &a.s("json")?)?),

        // The capacity and what this OS holds: `open`, the repos a Prompt has open (the host's to know).
        "capacity" => to(system::capacity(&paths::data_dir())?),
        "space" => to(usage::space(&paths::data_dir(), &paths::repos_dir(), &a.list("open")?)),
        "free" => to(usage::free(&paths::data_dir(), &paths::repos_dir(), &a.list("ids")?, &a.list("open")?)),

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
        // A session a page signed in with (a provider, a passkey): kept as the app keeps its own, another account's
        // copies kept theirs (login.rs connect).
        "remote_connect" => to(remote::connect(&a.s("url")?, a.s("token")?)?),
        // The Remote already let this session go: nothing can be sent with it, and nothing here is let go.
        "remote_forget" => to(remote::forget_connection()?),
        "remote_repos" => to(remote::remote_repos()?),
        "remote_status" => to(remote::status(&repos()?)?),
        "sync_repo" => to(remote::sync(&repos()?, &a.s("repo")?)?),
        "repo_fetch" => to(remote::fetch(&repos()?, &a.s("repo")?)?),
        // One of Home's settings agreed with the Remote (home.rs agree_with).
        "home_sync" => to(remote::sync_home(&a.s("key")?)?),
        // The plan's page (Checkout, or the portal) as the Remote makes it for this account; the host opens it.
        "plan_page" => to(account::plan_page(if a.s("kind")? == "portal" { "portal" } else { "checkout" }, a.opt::<String>("tier")?.as_deref())?),
        // What only the browser can do (a passkey's), as a page of the Remote's own app; the host opens it.
        "app_page" => to(account::app_page(&a.s("ask")?, a.opt::<String>("repo")?.as_deref())?),

        "history_changes" => to(history::changes(&repos()?, &a.s("repo")?)?),
        "history_diff" => to(history::diff(&repos()?, &a.s("repo")?, DIFF_LIMIT)?),
        "history_at_head" => to(history::at_head(&repos()?, &a.s("repo")?, &a.s("path")?)?),
        "history_cut" => {
            let issue = a.opt("issue")?.map(|f: String| format!("issue/{}", f.trim_start_matches("issue/")));
            to(history::cut(&repos()?, &a.s("repo")?, issue.as_deref(), &a.s("line")?, &a.s("note")?)?)
        }
        "history_log" => to(history::log(&repos()?, &a.s("repo")?, 50)?),
        "history_push" => to(history::push(&repos()?, &a.s("repo")?)?),
        "history_submit" => to(history::submit(&repos()?, &a.s("repo")?, &a.s("note")?)?),
        "history_reset" => to(history::reset(&repos()?, &a.s("repo")?)?),
        "work_start" => to(work::start(&repos()?, &a.s("repo")?, &a.s("issue")?)?),
        "work_switch" => to(work::switch(&repos()?, &a.s("repo")?, &a.s("line")?)?),
        "work_state" => to(history::work(&repos()?, &a.s("repo")?)?),
        "work_lines" => to(work::lines(&a.s("repo")?)?),
        "changes_list" => to(history::changes_of_repo(&a.s("repo")?)?),
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
