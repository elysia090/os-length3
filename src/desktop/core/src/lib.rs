//! What Length³ OS means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `l3` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.

pub mod boundary;
pub mod root;
pub mod git;
pub mod home;
pub mod issues;
#[cfg(target_os = "linux")]
pub mod launch;
pub mod paths;
pub mod repos;
pub mod system;
pub mod templates;
pub mod usage;
pub mod text;

pub type Result<T> = std::result::Result<T, String>;
