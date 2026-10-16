// The webview reaches the host only through these named commands. Nothing
// here reads or writes outside the OS's own data directory, and every one of
// them is what `l3` does on the command line, through the same core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use length3_core::{git, home, paths, repos, system};

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

/// Home's state (profile, TODO, band) as JSON text; l3 reads the same files.
#[tauri::command]
fn state_get(key: String) -> Result<Option<String>, String> {
    home::get(&key)
}

#[tauri::command]
fn state_set(key: String, json: String) -> Result<(), String> {
    home::set(&key, &json)
}

/// Changes not yet cut, by folder.
#[tauri::command]
fn git_changes(repo: String) -> Result<git::Changes, String> {
    git::changes(&managed()?.dir(&repo)?)
}

/// The changes not yet cut, line by line.
#[tauri::command]
fn git_diff(repo: String) -> Result<Vec<git::FileDiff>, String> {
    git::diff(&managed()?.dir(&repo)?, DIFF_LIMIT)
}

/// Cut the changes not yet cut, under an issue (`issue` is its file name in
/// issue/) or, without one, named by `line` ("Kind：件名").
#[tauri::command]
fn git_cut(repo: String, issue: Option<String>, line: String, note: String) -> Result<git::Commit, String> {
    git::cut_in(&managed()?, &repo, issue.as_deref(), &line, &note)
}

#[tauri::command]
fn git_log(repo: String) -> Result<Vec<git::Commit>, String> {
    git::log(&managed()?.dir(&repo)?, 50)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            capacity, repo_list, repo_create, repo_tree, repo_read, repo_write, repo_add,
            repo_mkdir, repo_remove, state_get, state_set, git_changes, git_diff, git_cut, git_log
        ])
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
