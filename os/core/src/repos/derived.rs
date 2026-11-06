//! What is derived from a repo's own files: folders a tool makes from them and makes again (node_modules beside a
//! package.json, target beside a Cargo.toml, a venv, a folder that says it is a cache). Not the repo's to send, and
//! free to go when room is wanted; known by proof, not by name alone.

use crate::text::names::is_git_name;
use std::path::{Path, PathBuf};

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
            if is_git_name(&name) || !e.file_type().is_ok_and(|t| t.is_dir()) { continue; }
            let path = e.path();
            if derived(dir, &name, &path) { out.push(path); } else { go(&path, out); }
        }
    }
    let mut out = Vec::new();
    go(dir, &mut out);
    out
}
