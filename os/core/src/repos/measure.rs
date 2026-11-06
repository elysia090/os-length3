//! What a repo's folder holds, counted in one walk: its own files (what is sent of it, as sync reads it: not its .git,
//! nor what is derived, nor a link or a temporary), their bytes and the newest change among them; the blocks the host
//! set aside for all of it but what is derived; the derived folders, not walked into (Storage counts each of them
//! once, the list of repos never needs to); and the temporaries this OS left in it. The list of repos and Storage
//! each walked the folder again for each of these.

use super::derived::derived;
use crate::fs::size::{blocks, inode, links};
use crate::fs::write::is_temporary;
use crate::text::names::is_git_name;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A repo's folder, as last counted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Measure {
    /// Its own files, their bytes, and the newest change among them and their folders (milliseconds since the epoch).
    pub files: u64,
    pub bytes: u64,
    pub modified: u64,
    /// The blocks set aside for the folder but what is derived: its own files, its .git, links, and the folders.
    pub allocated: u64,
    /// The derived folders (the outermost ones), not walked into.
    pub derived: Vec<PathBuf>,
    /// Files named as this OS names a file while it writes it (fs/write.rs), outside .git and what is derived.
    pub temporaries: Vec<PathBuf>,
}

/// The repo at `dir`, counted now.
pub fn measure(dir: &Path) -> Measure {
    let mut m = Measure::default();
    if let Ok(meta) = dir.symlink_metadata() { m.allocated = blocks(&meta); }
    walk(dir, true, &mut m, &mut HashSet::new());
    m
}

/// Everything under `dir`; `own` is false under a .git, whose files are not the repo's own.
fn walk(dir: &Path, own: bool, m: &mut Measure, seen: &mut HashSet<(u64, u64)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // Asked of the directory already open, by the entry's name (fstatat), links not followed.
        let Ok(meta) = e.metadata() else { continue };
        let name = e.file_name();
        let name = name.to_string_lossy();
        if meta.is_dir() {
            let path = e.path();
            if own && derived(dir, &name, &path) {
                m.derived.push(path);
                continue;
            }
            let git = is_git_name(&name);
            m.allocated += blocks(&meta);
            if own && !git { m.modified = m.modified.max(millis(&meta)); }
            walk(&path, own && !git, m, seen);
        } else {
            // A file with several names takes its blocks once; each name of it is a file of the repo's.
            if links(&meta) < 2 || seen.insert(inode(&meta)) { m.allocated += blocks(&meta); }
            if !own || !meta.is_file() || is_git_name(&name) { continue; }
            if is_temporary(&name) {
                m.temporaries.push(e.path());
            } else {
                m.files += 1;
                m.bytes += meta.len();
                m.modified = m.modified.max(millis(&meta));
            }
        }
    }
}

fn millis(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(all(test, unix))]
#[path = "tests/measure.rs"]
mod tests;
