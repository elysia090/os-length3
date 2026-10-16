//! What Length³ OS means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `l3` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.

pub mod git;
pub mod home;
pub mod issues;
pub mod paths;
pub mod repos;
pub mod system;
pub mod templates;
pub mod text;

pub type Result<T> = std::result::Result<T, String>;
