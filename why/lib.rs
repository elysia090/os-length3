//! What why* means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `why` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.
//!
//! Unsafe code is only where the OS is called and no safe interface has the call yet, each block a single call with
//! its arguments made just before it: a signal's handler, a child told to end with its parent, and the wait for a
//! Prompt's box (prompt/start.rs; the box itself is muk's to make, ricebox/muk). The host's other calls (a signal, a
//! sync, its name, a filesystem's room, the routes and interfaces a network is reached by) go through rustix's and nix's safe interfaces; the
//! browser's core asks the page through why/api/web, which hands device/net.rs the call. A layer with none says
//! `#![forbid(unsafe_code)]` once, for all its files (device/fs/), and so does every module without it.

// The layers, each above the ones before it: a module uses only what is in its own layer or one listed before
// it (scripts/layers.ts checks it). Each is a folder whose mod.rs says what it holds, and the folder is in the part
// of why it belongs to (docs/STRUCTURE.md): a part's layers are not always next to each other in this order, since
// what frees a device's room knows what a repo is, and a repo's history knows what was sent.
#[path = "device/fs/mod.rs"]
pub mod fs;
pub mod text;
pub mod device;
pub mod home;
pub mod repo;
pub mod prompt;
#[cfg(unix)]
pub mod ssh;
pub mod agent;
pub mod shipto;
#[path = "repo/history/mod.rs"]
pub mod history;
#[path = "prompt/roots/mod.rs"]
pub mod roots;
#[path = "device/storage/mod.rs"]
pub mod storage;
pub mod api;

pub type Result<T> = std::result::Result<T, String>;

/// This process's id, as temporaries are named by it. The core built for the browser (wasm32-wasip1) has
/// none, and std panics when asked: one instance runs at a time there, so its number is always 1.
pub fn pid() -> u32 {
    #[cfg(not(target_os = "wasi"))]
    return std::process::id();
    #[cfg(target_os = "wasi")]
    return 1;
}
