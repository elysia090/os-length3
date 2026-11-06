//! Where the OS keeps its things. One data directory per person:
//! `<data>/repos/<name>` for repos and `<data>/home/` for Home's state.

use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The app's identifier; the platform data directory is named after it.
pub const IDENTIFIER: &str = "com.length3.os";

/// The data directory: `$LENGTH3_HOME` if set, else the platform's place for app data (the same place the app uses),
/// else `./.length3`. Read once: a process's environment is what it started with (nothing here sets it).
pub fn data_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| match set("LENGTH3_HOME") {
        Some(home) => home,
        None => platform().map(|d| d.join(IDENTIFIER)).unwrap_or_else(|| PathBuf::from(".length3")),
    })
}

/// Where repos live. Inside the app's Prompt this is `/root` (set through `$LENGTH3_REPOS`), the same place the
/// shell sees them. Read once, as `data_dir`.
pub fn repos_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| set("LENGTH3_REPOS").unwrap_or_else(|| data_dir().join("repos")))
}

/// The variable `name` as a path, if it is set and not empty.
fn set(name: &str) -> Option<PathBuf> {
    env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Home's state: profile, TODO and the band.
pub fn home_dir() -> PathBuf {
    data_dir().join("home")
}

#[cfg(target_os = "linux")]
fn platform() -> Option<PathBuf> {
    set("XDG_DATA_HOME").or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

#[cfg(target_os = "macos")]
fn platform() -> Option<PathBuf> {
    env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
}

#[cfg(target_os = "windows")]
fn platform() -> Option<PathBuf> {
    env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform() -> Option<PathBuf> {
    None
}
