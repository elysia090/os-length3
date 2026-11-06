//! What a Prompt writes outside its repo, and how long each part lives.
//! Every place a program may write has an owner, and the owner's lifetime
//! bounds what is written there:
//!
//!   /root/<repo>            the repo: canonical on the Remote
//!   /usr, /etc, /var/lib …  the repo's environment: what its package
//!                           manager installed over the root (an overlay's
//!                           upper layer, envs/<repo>), kept for the repo's
//!                           Prompts, freed back to the plain root at will
//!   /var/cache, /var/tmp,   the repo's caches (caches/<repo>/…): kept
//!   /var/log, ~/.cache      between Prompts to be quick, but all of it can
//!                           be made again, so it goes whenever room is
//!                           wanted, without asking
//!   /tmp, /run              the Prompt: gone when it ends
//!   /                       the root: shared, read-only, named by its digest
//!
//! Each owner is a directory of its own on the host. What a guest frees is
//! freed on the host at once, and what it leaves behind the host can take
//! back without the guest's help: there is no disk image whose freed blocks
//! the host cannot see, and no balloon or trim for a guest to forget.
//! Anything of a repo that is no longer on this device has no owner here,
//! and goes.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};

/// The repo's environment: `upper` (what was written over the root),
/// `work` (the overlay's scratch, on the same filesystem), and `prompts`
/// (the Prompts sharing that overlay now: prompt/launch.rs).
pub fn env_dir(data: &Path, repo: &str) -> PathBuf {
    data.join("envs").join(repo)
}

/// The repo's environment over one root (named by its digest): what was
/// installed over one root never lies over another.
pub fn env_over(data: &Path, repo: &str, root: &Path) -> PathBuf {
    let key: String = root.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().chars().take(16).collect()).unwrap_or_else(|| "root".into());
    env_dir(data, repo).join(key)
}

/// The repo's caches, one directory each.
pub fn cache_dir(data: &Path, repo: &str) -> PathBuf {
    data.join("caches").join(repo)
}

/// Where in a Prompt the caches are (the path inside, relative to /), and
/// what each directory is called on the host.
pub const CACHES: [(&str, &str); 4] = [
    ("var/cache", "var-cache"),
    ("var/tmp", "var-tmp"),
    ("var/log", "var-log"),
    ("root/.cache", "home-cache"),
];

/// Every repo with an environment or caches here, by kind ("env", "cache").
pub fn held(data: &Path) -> Vec<(&'static str, String, PathBuf)> {
    let mut out = Vec::new();
    for (kind, dir) in [("env", data.join("envs")), ("cache", data.join("caches"))] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if crate::text::names::valid_name(&name) && e.path().is_dir() { out.push((kind, name, e.path())); }
        }
    }
    out.sort();
    out
}
