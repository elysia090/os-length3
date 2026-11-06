//! This device, apart from the repos on it: Home's settings (home.rs), its secrets (vault.rs, agent_key.rs, and what
//! must not leave with a file: secrets.rs), how it reaches the network (net.rs, fetch.rs), the Prompts running on it
//! (prompts.rs), and the desktop app on it (desktop.rs).

pub mod agent_key;
#[cfg(unix)]
pub mod desktop;
#[cfg(not(target_os = "wasi"))]
pub mod fetch;
pub mod home;
pub mod net;
#[cfg(not(target_os = "wasi"))]
pub mod prompts;
pub mod secrets;
pub mod vault;
