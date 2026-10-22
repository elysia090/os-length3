//! Where the OS keeps its things. One data directory per person:
//! `<data>/repos/<name>` for repos and `<data>/home/` for Home's state.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::env;
use std::path::PathBuf;

/// The app's identifier; the platform data directory is named after it.
pub const IDENTIFIER: &str = "com.length3.os";

/// The data directory: `$LENGTH3_HOME` if set, else the platform's place for
/// app data (the same place the app uses), else `./.length3`.
pub fn data_dir() -> PathBuf {
    if let Some(home) = env::var_os("LENGTH3_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    platform().map(|d| d.join(IDENTIFIER)).unwrap_or_else(|| PathBuf::from(".length3"))
}

/// Where repos live. Inside the app's Prompt this is `/root` (set through
/// `$LENGTH3_REPOS`), the same place the shell sees them.
pub fn repos_dir() -> PathBuf {
    match env::var_os("LENGTH3_REPOS").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => data_dir().join("repos"),
    }
}

/// Home's state: profile, TODO and the band.
pub fn home_dir() -> PathBuf {
    data_dir().join("home")
}

#[cfg(target_os = "linux")]
fn platform() -> Option<PathBuf> {
    env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
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
