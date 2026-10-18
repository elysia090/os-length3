//! What Length³ OS means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `l3` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.

pub mod account;
pub mod atomic;
pub mod boundary;
pub mod fetch;
pub mod root;
pub mod history;
pub mod home;
pub mod i18n;
pub mod inbox;
pub mod issues;
pub mod linediff;
pub mod names;
pub mod net;
#[cfg(target_os = "linux")]
pub mod launch;
pub mod owned;
pub mod paths;
pub mod prompt;
pub mod remote;
pub mod repos;
pub mod servers;
#[cfg(unix)]
pub mod ssh;
pub mod system;
pub mod templates;
pub mod usage;
pub mod work;
pub mod text;

pub type Result<T> = std::result::Result<T, String>;
