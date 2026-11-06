//! This device, apart from what the person keeps on it: its secrets (vault.rs, agent_key.rs, and what must not
//! leave with a file: secrets.rs), how it reaches the network (net.rs, download.rs), and the desktop app on it
//! (desktop.rs).

pub mod agent_key;
#[cfg(unix)]
pub mod desktop;
#[cfg(not(target_os = "wasi"))]
pub mod download;
pub mod vault;
pub mod net;
pub mod secrets;
