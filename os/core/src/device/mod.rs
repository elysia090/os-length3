//! This device, apart from what the person keeps on it: its secrets (device/vault.rs, device/agent_key.rs, and what must not
//! leave with a file: device/secrets.rs), how it reaches the network (device/net.rs, download.rs), and the desktop app on it
//! (device/desktop.rs).

// No unsafe code in this layer: in a browser, the page is asked through core/web (device/net.rs `through_page`).
#![forbid(unsafe_code)]

pub mod agent_key;
#[cfg(unix)]
pub mod desktop;
#[cfg(not(target_os = "wasi"))]
pub mod download;
pub mod vault;
pub mod net;
pub mod secrets;
