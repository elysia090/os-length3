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

use std::path::{Path, PathBuf};

/// The repo's environment: `upper` (what was written over the root) and
/// `work` (the overlay's scratch, on the same filesystem).
pub fn env_dir(data: &Path, repo: &str) -> PathBuf {
    data.join("envs").join(repo)
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
            if crate::repos::valid_name(&name) && e.path().is_dir() { out.push((kind, name, e.path())); }
        }
    }
    out.sort();
    out
}

/// Whether the directory `path` (named `name`, in `parent`) is derived: made
/// from the repo's own files, by a tool that makes it again from them. Its
/// lifetime is its sources': it is not the repo's to send, and it goes when
/// room is wanted. Known by proof, not by name alone: a directory that says
/// it is a cache (CACHEDIR.TAG, as cargo and pytest write), or a tool's
/// usual directory beside the file it is made from.
pub fn derived(parent: &Path, name: &str, path: &Path) -> bool {
    if path.join("CACHEDIR.TAG").is_file() { return true; }
    let beside = |f: &str| parent.join(f).is_file();
    match name {
        "node_modules" | ".next" | ".nuxt" | ".svelte-kit" | ".parcel-cache" | ".turbo" => beside("package.json"),
        "target" => beside("Cargo.toml"),
        ".venv" | "venv" => path.join("pyvenv.cfg").is_file(),
        "__pycache__" | ".pytest_cache" | ".mypy_cache" | ".ruff_cache" | ".tox" => true,
        ".gradle" => ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].iter().any(|f| beside(f)),
        ".zig-cache" | "zig-cache" | "zig-out" => beside("build.zig"),
        _ => false,
    }
}

/// Whether `rel` (a path in the repo at `dir`) lies in a derived directory here.
pub fn within_derived(dir: &Path, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut at = dir.to_path_buf();
    for p in &parts[..parts.len().saturating_sub(1)] {
        let parent = at.clone();
        at.push(p);
        if at.is_dir() && derived(&parent, p, &at) { return true; }
    }
    false
}

/// The derived directories of the repo at `dir` (outermost ones), and what they hold.
pub fn derived_in(dir: &Path) -> Vec<PathBuf> {
    fn go(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if crate::repos::is_git_name(&name) || !e.file_type().is_ok_and(|t| t.is_dir()) { continue; }
            let path = e.path();
            if derived(dir, &name, &path) { out.push(path); } else { go(&path, out); }
        }
    }
    let mut out = Vec::new();
    go(dir, &mut out);
    out
}
