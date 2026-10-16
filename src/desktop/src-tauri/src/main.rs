// The webview reaches the host only through these named commands. Nothing
// here reads or writes outside the OS's own data directory, and every one of
// them is what `l3` does on the command line, through the same core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use length3_core::{home, paths, repos, system};

/// Files the editor may save; anything read in part is never written back.
const READ_LIMIT: u64 = 256 * 1024;

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            capacity, repo_list, repo_create, repo_tree, repo_read, repo_write, repo_add,
            repo_mkdir, repo_remove, state_get, state_set
        ])
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
