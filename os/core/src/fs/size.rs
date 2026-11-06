//! Room: what the filesystem holding the OS's data has (`room`), and what a folder takes of it (`allocated`), counted
//! as the host counts it: in blocks set aside, each file once however many names it has.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// The filesystem's `total` and `free` bytes, as the outermost host reports them, and what the OS has set aside
/// under its own directory (`app`).
#[derive(Serialize, Debug)]
pub struct Capacity {
    pub total: u64,
    pub free: u64,
    pub app: u64,
}

pub fn capacity(dir: &Path) -> crate::Result<Capacity> {
    let (total, free) = room(dir)?;
    Ok(Capacity { total, free, app: allocated(dir) })
}

/// The filesystem's `total` and `free` alone: no walk of what the OS holds.
pub fn room(dir: &Path) -> crate::Result<(u64, u64)> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    filesystem(dir).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn filesystem(path: &Path) -> std::io::Result<(u64, u64)> {
    let s = rustix::fs::statvfs(path)?;
    Ok((s.f_blocks * s.f_frsize, s.f_bavail * s.f_frsize))
}

#[cfg(not(unix))]
fn filesystem(_: &Path) -> std::io::Result<(u64, u64)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no host adapter for this OS yet"))
}

/// Bytes the host has set aside for `path` and everything under it, links not followed; a file with several names
/// (hard links) is counted once.
pub fn allocated(path: &Path) -> u64 {
    let Ok(meta) = path.symlink_metadata() else { return 0 };
    blocks(&meta) + if meta.is_dir() { under(path, &mut HashSet::new()) } else { 0 }
}

/// What the entries under `dir` take; `seen`, the files with more than one name met so far.
fn under(dir: &Path, seen: &mut HashSet<(u64, u64)>) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut sum = 0;
    for e in entries.flatten() {
        // Asked of the directory already open, by the entry's name (fstatat), not by its whole path again.
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            sum += blocks(&meta) + under(&e.path(), seen);
        } else if links(&meta) < 2 || seen.insert(inode(&meta)) {
            sum += blocks(&meta);
        }
    }
    sum
}

#[cfg(unix)]
pub(crate) fn inode(meta: &fs::Metadata) -> (u64, u64) { use std::os::unix::fs::MetadataExt; (meta.dev(), meta.ino()) }

#[cfg(not(unix))]
pub(crate) fn inode(_: &fs::Metadata) -> (u64, u64) { (0, 0) }

#[cfg(unix)]
pub(crate) fn links(meta: &fs::Metadata) -> u64 { use std::os::unix::fs::MetadataExt; meta.nlink() }

#[cfg(not(unix))]
pub(crate) fn links(_: &fs::Metadata) -> u64 { 1 }

#[cfg(unix)]
pub(crate) fn blocks(meta: &fs::Metadata) -> u64 { use std::os::unix::fs::MetadataExt; meta.blocks() * 512 }

#[cfg(not(unix))]
pub(crate) fn blocks(meta: &fs::Metadata) -> u64 { meta.len() }

#[cfg(all(test, unix))]
#[path = "tests/size.rs"]
mod tests;
