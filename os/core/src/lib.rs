//! What Length³ OS means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `l3` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.
//!
//! Unsafe code is only where the OS is called and no safe interface has the call yet, each block a single call with
//! its arguments made just before it: the Prompt's namespaces and seccomp filter (prompt/launch.rs, prompt/seccomp.rs),
//! a signal or the clock's tick (prompt/running.rs, ssh/listener.rs, storage/items.rs), SSH's pty (ssh/reach.rs), a
//! sync (root/install.rs), the host's name (remote/merge.rs), and the page the browser's core asks (device/net.rs).
//! A layer with none says `#![forbid(unsafe_code)]` once, for all its files (fs/), and so does every module without it.

// The layers, each above the ones before it: a module uses only what is in its own layer or one listed before
// it (scripts/layers.mjs checks it). Each is a folder whose mod.rs says what it holds.
pub mod fs;
pub mod text;
pub mod device;
pub mod home;
pub mod repos;
pub mod prompt;
#[cfg(unix)]
pub mod ssh;
pub mod agent;
pub mod remote;
pub mod history;
pub mod root;
pub mod storage;
pub mod compute;
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
