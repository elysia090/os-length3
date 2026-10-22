//! What Length³ OS means by a repo, a file, an issue and a TODO, in one place.
//! The app (through Tauri commands) and `l3` (on the command line, on the host
//! or inside the app's Prompt) both use this crate, so the two cannot drift.
//!
//! Unsafe code is only where the OS is called through libc (the Prompt's
//! namespaces and seccomp filter: launch.rs, seccomp.rs; SSH's pty: ssh.rs;
//! a lock, a rename, a sync, a signal: remote, atomic, root, prompt, usage,
//! system), each block a single call with its arguments made just before it.
//! Every other module says `#![forbid(unsafe_code)]`, so none is added there.

pub mod account;
pub mod api;
pub mod atomic;
pub mod boundary;
#[cfg(unix)]
pub mod desktop;
#[cfg(not(target_os = "wasi"))]
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
#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
pub mod seccomp;
pub mod owned;
pub mod paths;
#[cfg(not(target_os = "wasi"))]
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
