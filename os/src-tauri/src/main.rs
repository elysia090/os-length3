// The webview reaches the host only through these named commands. Nothing
// here reads or writes outside the OS's own data directory, and every one of
// them is what `l3` does on the command line, through the same core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use length3_core::{history, home, paths, remote, repos, system, usage};

#[cfg(target_os = "linux")]
mod shells;
/// Elsewhere a Prompt on the root is not there yet; the commands say so.
#[cfg(not(target_os = "linux"))]
mod shells {
    fn not_here() -> String { length3_core::tr!("A Prompt on the root is Linux only for now", "root の Prompt はいま Linux だけです") }
    #[derive(Default)]
    pub struct Shells;
    #[tauri::command] pub fn prompt_open(_repo: String) -> Result<u32, String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_input(_id: u32, _text: String) -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_interrupt(_id: u32) -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_held(_id: u32) -> Option<length3_core::prompt::Held> { None }
    #[tauri::command] pub fn prompt_close(_id: u32) -> Result<length3_core::prompt::Stopped, String> { Err(not_here()) }
    #[tauri::command] pub fn root_status() -> Option<()> { None }
    #[tauri::command] pub async fn root_fetch() -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub async fn root_use(_id: String) -> Result<(), String> { Err(not_here()) }
    impl Shells { pub fn open_repos(&self) -> Vec<String> { Vec::new() } }
}

/// Files the editor may save; anything read in part is never written back.
const READ_LIMIT: u64 = 256 * 1024;
/// Lines of difference shown at most, across all files.
const DIFF_LIMIT: usize = 2000;

fn managed() -> Result<repos::Repos, String> {
    repos::Repos::open()
}

#[tauri::command]
fn capacity() -> Result<system::Capacity, String> {
    system::capacity(&paths::data_dir())
}

/// この端末: everything this OS holds, largest first, and what can be done with each.
#[tauri::command]
fn space(shells: tauri::State<'_, shells::Shells>) -> usage::Space {
    usage::space(&paths::data_dir(), &paths::repos_dir(), &shells.open_repos())
}

/// 空ける: these go, each looked at again first (a repo's changes are sent before it goes).
#[tauri::command]
async fn free(app: tauri::AppHandle, ids: Vec<String>) -> Result<usage::Freed, String> {
    let open = tauri::Manager::state::<shells::Shells>(&app).open_repos();
    blocking(move || Ok(usage::free(&paths::data_dir(), &paths::repos_dir(), &ids, &open))).await
}

/// Network and file walks run off the window's thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn repo_list() -> Result<Vec<repos::Summary>, String> {
    managed()?.list()
}

#[tauri::command]
fn repo_create(name: String, template: String) -> Result<repos::Summary, String> {
    managed()?.create(&name, &template)
}

#[tauri::command]
fn repo_tree(repo: String, path: String) -> Result<Vec<repos::Entry>, String> {
    managed()?.tree(&repo, &path)
}

#[tauri::command]
fn repo_read(repo: String, path: String) -> Result<repos::Contents, String> {
    managed()?.read(&repo, &path, READ_LIMIT)
}

#[tauri::command]
fn repo_write(repo: String, path: String, text: String) -> Result<u64, String> {
    managed()?.write(&repo, &path, &text, READ_LIMIT)
}

/// A new file in an existing directory of the repo; never replaces one.
#[tauri::command]
fn repo_add(repo: String, dir: String, name: String, text: String) -> Result<u64, String> {
    managed()?.add(&repo, &dir, &name, &text, READ_LIMIT)
}

#[tauri::command]
fn repo_mkdir(repo: String, path: String) -> Result<(), String> {
    managed()?.mkdir(&repo, &path)
}

#[tauri::command]
fn repo_remove(repo: String, path: String) -> Result<(), String> {
    managed()?.remove(&repo, &path)
}

/// A file or folder of the repo given a new name in its folder; never over another.
#[tauri::command]
fn repo_rename(repo: String, path: String, name: String) -> Result<(), String> {
    managed()?.rename(&repo, &path, &name)
}

/// Home's state (profile, TODO, band) as JSON text; l3 reads the same files.
#[tauri::command]
fn state_get(key: String) -> Result<Option<String>, String> {
    home::get(&key)
}

#[tauri::command]
fn state_set(key: String, json: String) -> Result<(), String> {
    home::set(&key, &json)
}

// ---- the Remote (core/src/remote.rs, history.rs) ----

/// Sign in: a code to approve in the browser, which is opened on its page.
/// The Remote is this device's own, never one the page names, and only a
/// page that Remote stands behind is opened: its own, or its app's, on the
/// origin it says in /v1/about (remote::device_page_ok).
#[tauri::command]
async fn remote_login_start(app: tauri::AppHandle) -> Result<remote::DeviceCode, String> {
    let url = remote::default_url();
    let (code, origin) = blocking({ let url = url.clone(); move || Ok((remote::device_start(&url, "length3-app")?, remote::app_origin(&url))) }).await?;
    if !remote::device_page_ok(&url, origin.as_deref(), &code.verification_uri_complete) {
        return Err(length3_core::tr!("The Remote named a page that is not its own", "Remote が自分のものでないページを示しました"));
    }
    use tauri_plugin_opener::OpenerExt;
    // Not opened (no browser to hand it to): the page shows the code and its address to open by hand.
    let _ = app.opener().open_url(&code.verification_uri_complete, None::<&str>);
    Ok(code)
}

/// Wait until the code is approved (or refused, or expires).
#[tauri::command]
async fn remote_login_wait(code: remote::DeviceCode) -> Result<(), String> {
    let url = remote::default_url();
    blocking(move || remote::device_finish(&url, "length3-app", &code)).await
}

#[tauri::command]
async fn remote_logout() -> Result<(), String> {
    // Every repo is sent first; one that cannot be keeps the device signed in.
    blocking(|| remote::logout(&managed()?)).await
}

/// Repos the Remote holds (those not here can be opened).
#[tauri::command]
async fn remote_repos() -> Result<Vec<remote::RemoteRepo>, String> {
    blocking(remote::remote_repos).await
}

/// Where each repo here stands, from what is here alone.
#[tauri::command]
async fn remote_status() -> Result<Vec<remote::Status>, String> {
    blocking(|| remote::status(&managed()?)).await
}

/// Send what changed here and take in what changed there.
#[tauri::command]
async fn sync_repo(repo: String) -> Result<remote::Synced, String> {
    blocking(move || remote::sync(&managed()?, &repo)).await
}

/// Bring a repo that is only on the Remote here.
#[tauri::command]
async fn repo_fetch(repo: String) -> Result<remote::Synced, String> {
    blocking(move || remote::fetch(&managed()?, &repo)).await
}

/// What is not yet cut, by folder.
#[tauri::command]
async fn history_changes(repo: String) -> Result<history::Changes, String> {
    blocking(move || history::changes(&managed()?, &repo)).await
}

/// The same, line by line.
#[tauri::command]
async fn history_diff(repo: String) -> Result<Vec<history::FileDiff>, String> {
    blocking(move || history::diff(&managed()?, &repo, DIFF_LIMIT)).await
}

/// A file as it was at the last commit (none: it was not there), to put it back.
#[tauri::command]
async fn history_at_head(repo: String, path: String) -> Result<Option<String>, String> {
    blocking(move || history::at_head(&managed()?, &repo, &path)).await
}

/// Commit, under an issue (its file name in issue/) or named by `line` ("Kind：件名").
#[tauri::command]
async fn history_cut(repo: String, issue: Option<String>, line: String, note: String) -> Result<history::Cut, String> {
    blocking(move || history::cut(&managed()?, &repo, issue.as_deref().map(|f| format!("issue/{}", f.trim_start_matches("issue/"))).as_deref(), &line, &note)).await
}

#[tauri::command]
async fn history_log(repo: String) -> Result<Vec<history::Cut>, String> {
    blocking(move || history::log(&managed()?, &repo, 50)).await
}

// ---- work on an issue, and the changes handed to main (core/src/work.rs, history.rs) ----

/// Work on `issue` (its file, issue/NNN.md): the repo then shows that work's copy.
#[tauri::command]
async fn work_start(repo: String, issue: String) -> Result<length3_core::work::Line, String> {
    blocking(move || length3_core::work::start(&managed()?, &repo, &issue)).await
}

/// Show `line` ("main" or an issue's) where the repo is seen.
#[tauri::command]
async fn work_switch(repo: String, line: String) -> Result<(), String> {
    blocking(move || length3_core::work::switch(&managed()?, &repo, &line)).await
}

/// The work the repo shows, and where it stands.
#[tauri::command]
async fn work_state(repo: String) -> Result<history::Work, String> {
    blocking(move || history::work(&managed()?, &repo)).await
}

#[tauri::command]
async fn work_lines(repo: String) -> Result<Vec<length3_core::work::Line>, String> {
    blocking(move || length3_core::work::lines(&repo)).await
}

#[tauri::command]
async fn history_push(repo: String) -> Result<String, String> {
    blocking(move || history::push(&managed()?, &repo)).await
}

#[tauri::command]
async fn history_submit(repo: String, note: String) -> Result<history::Change, String> {
    blocking(move || history::submit(&managed()?, &repo, &note)).await
}

#[tauri::command]
async fn history_reset(repo: String) -> Result<history::Change, String> {
    blocking(move || history::reset(&managed()?, &repo)).await
}

#[tauri::command]
async fn changes_list(repo: String) -> Result<Vec<history::Change>, String> {
    blocking(move || history::changes_of_repo(&repo)).await
}

#[tauri::command]
async fn change_review(repo: String, id: String, verdict: String, note: String, marks: Vec<String>) -> Result<history::Change, String> {
    blocking(move || history::review(&repo, &id, &verdict, &note, &marks)).await
}

#[tauri::command]
async fn change_merge(repo: String, id: String) -> Result<history::Change, String> {
    blocking(move || history::merge(&repo, &id)).await
}

#[tauri::command]
async fn change_reject(repo: String, id: String, note: String) -> Result<history::Change, String> {
    blocking(move || history::reject(&repo, &id, &note)).await
}

#[tauri::command]
async fn change_diff(repo: String, id: String) -> Result<Vec<history::FileDiff>, String> {
    blocking(move || history::change_diff(&repo, &id, DIFF_LIMIT)).await
}

// ---- SSH into this device's Prompts (core/src/ssh.rs; the listener is l3's) ----

/// Whether this device listens for SSH, where each repo is reached, and its host key.
#[derive(serde::Serialize)]
struct SshHere { on: bool, port: Option<u16>, destinations: Vec<String>, fingerprint: Option<String> }

fn ssh_now() -> SshHere {
    #[cfg(unix)]
    if let Some(l) = length3_core::ssh::listening(&paths::data_dir()) {
        return SshHere { on: true, port: Some(l.port), destinations: l.destinations, fingerprint: Some(l.fingerprint) };
    }
    SshHere { on: false, port: None, destinations: Vec::new(), fingerprint: None }
}

#[tauri::command]
fn ssh_here() -> SshHere {
    ssh_now()
}

/// Turn it on or off as `l3 address ssh on|off` does, by the l3 beside the app: the same listener, kept by l3
/// in the background whether or not the app stays open, and the same checks (a key in .authorized_keys first).
#[tauri::command]
async fn ssh_set(on: bool) -> Result<SshHere, String> {
    blocking(move || {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let out = std::process::Command::new(length3_core::prompt::l3_path(&exe))
            .args(["address", "ssh", if on { "on" } else { "off" }, "--json"])
            .stdin(std::process::Stdio::null()).output()
            .map_err(|e| length3_core::tr!("Could not start l3: {}", "l3 を起動できませんでした：{}", e))?;
        if !out.status.success() {
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
            return Err(v["error"]["message"].as_str().map(String::from).unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        Ok(ssh_now())
    }).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shells::Shells::default())
        .invoke_handler(tauri::generate_handler![
            capacity, space, free, repo_list, repo_create, repo_tree, repo_read, repo_write, repo_add,
            repo_mkdir, repo_remove, repo_rename, state_get, state_set,
            remote_login_start, remote_login_wait, remote_logout, remote_repos, remote_status,
            sync_repo, repo_fetch, history_changes, history_diff, history_at_head, history_cut, history_log,
            work_start, work_switch, work_state, work_lines, history_push, history_submit, history_reset,
            changes_list, change_review, change_merge, change_reject, change_diff,
            shells::prompt_open, shells::prompt_input, shells::prompt_interrupt, shells::prompt_held, shells::prompt_close,
            shells::root_status, shells::root_fetch, shells::root_use, ssh_here, ssh_set
        ])
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
