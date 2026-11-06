//! The repos whose Prompts may reach the network, on this device only (never sent).

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use super::state::{get, set};

/// Give `repo`'s Prompts the network here (`on`), or take it; kept sorted, as Runtime keeps it
/// (src/pages/runtime/prompts.ts). Whether it changed.
pub fn set_network(repo: &str, on: bool) -> Result<bool> {
    // A file that could not be read is not written over.
    let mut all: Vec<String> = get("network")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if all.iter().any(|r| r == repo) == on { return Ok(false); }
    if on { all.push(repo.to_string()); } else { all.retain(|r| r != repo); }
    all.sort();
    all.dedup();
    set("network", &serde_json::to_string(&all).map_err(|e| e.to_string())?)?;
    Ok(true)
}

/// The repos whose Prompts may reach the network here, in order.
pub fn networked() -> Vec<String> {
    let Ok(Some(text)) = get("network") else { return Vec::new() };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
}

/// Whether `repo`'s Prompts may reach the network (granted in Runtime; `l3 prompt --network` for one Prompt).
pub fn network(repo: &str) -> bool {
    networked().iter().any(|r| r == repo)
}

