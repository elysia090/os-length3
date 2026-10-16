// The webview reaches the host only through these named commands. Nothing
// here writes or reads outside the app's own data directory.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::Path;
use tauri::Manager;

mod repos;

/// Volume facts for the filesystem holding the app's data, in bytes.
/// `total`/`free` are what the outermost host reports for that filesystem;
/// `app` is what this app has allocated under its own directory.
#[derive(Serialize)]
struct Capacity {
    total: u64,
    free: u64,
    app: u64,
    measured: &'static str,
}

#[cfg(unix)]
fn filesystem(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes())?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let unit = s.f_frsize as u64;
    Ok((s.f_blocks as u64 * unit, s.f_bavail as u64 * unit))
}

#[cfg(not(unix))]
fn filesystem(_: &Path) -> std::io::Result<(u64, u64)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no host adapter for this OS yet"))
}

/// Allocated (not logical) bytes, so sparse files count only what they hold.
fn allocated(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    #[cfg(unix)]
    let own = { use std::os::unix::fs::MetadataExt; meta.blocks() * 512 };
    #[cfg(not(unix))]
    let own = meta.len();
    if !meta.is_dir() {
        return own;
    }
    own + std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| allocated(&e.path())).sum())
        .unwrap_or(0)
}

#[tauri::command]
fn capacity(app: tauri::AppHandle) -> Result<Capacity, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (total, free) = filesystem(&dir).map_err(|e| e.to_string())?;
    Ok(Capacity { total, free, app: allocated(&dir), measured: "statvfs+st_blocks" })
}

fn managed(app: &tauri::AppHandle) -> Result<repos::Repos, String> {
    repos::Repos::new(app.path().app_data_dir().map_err(|e| e.to_string())?.join("repos"))
}

#[tauri::command]
fn repo_list(app: tauri::AppHandle) -> Result<Vec<repos::Summary>, String> {
    managed(&app)?.list()
}

#[tauri::command]
fn repo_create(app: tauri::AppHandle, name: String, template: String) -> Result<repos::Summary, String> {
    managed(&app)?.create(&name, &template)
}

#[tauri::command]
fn repo_tree(app: tauri::AppHandle, repo: String, path: String) -> Result<Vec<repos::Entry>, String> {
    managed(&app)?.tree(&repo, &path)
}

#[tauri::command]
fn repo_read(app: tauri::AppHandle, repo: String, path: String) -> Result<repos::Contents, String> {
    managed(&app)?.read(&repo, &path, READ_LIMIT)
}

/// Files the editor may save; anything read in part is never written back.
#[tauri::command]
fn repo_write(app: tauri::AppHandle, repo: String, path: String, text: String) -> Result<u64, String> {
    managed(&app)?.write(&repo, &path, &text, READ_LIMIT)
}

/// A new file in an existing directory of the repo; never replaces one.
#[tauri::command]
fn repo_add(app: tauri::AppHandle, repo: String, dir: String, name: String, text: String) -> Result<u64, String> {
    managed(&app)?.add(&repo, &dir, &name, &text, READ_LIMIT)
}

const READ_LIMIT: u64 = 256 * 1024;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![capacity, repo_list, repo_create, repo_tree, repo_read, repo_write, repo_add])
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
