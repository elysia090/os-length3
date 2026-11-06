//! This device: how much room the filesystem holding the OS's data has, and
//! how much the OS itself holds there.

use serde::Serialize;
use std::fs;
use std::path::Path;

/// `total`/`free` are what the outermost host reports for that filesystem;
/// `app` is what the OS has allocated under its own directory.
#[derive(Serialize, Debug)]
pub struct Capacity {
    pub total: u64,
    pub free: u64,
    pub app: u64,
    pub measured: &'static str,
}

pub fn capacity(dir: &Path) -> crate::Result<Capacity> {
    let (total, free) = room(dir)?;
    Ok(Capacity { total, free, app: allocated(dir), measured: "statvfs+st_blocks" })
}

/// The filesystem's `total` and `free` alone: no walk of what the OS holds.
pub fn room(dir: &Path) -> crate::Result<(u64, u64)> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    filesystem(dir).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn filesystem(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = CString::new(path.as_os_str().as_bytes())?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let unit = s.f_frsize as u64;
    Ok((s.f_blocks as u64 * unit, s.f_bavail as u64 * unit))
}

#[cfg(not(unix))]
fn filesystem(_: &Path) -> std::io::Result<(u64, u64)> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no host adapter for this OS yet"))
}

/// Bytes the host has set aside for everything under `dir`.
pub fn allocated(dir: &Path) -> u64 {
    tally(dir).2 + dir.symlink_metadata().map(|m| blocks(&m)).unwrap_or(0)
}

fn tally_into(dir: &Path, seen: &mut std::collections::HashSet<(u64, u64)>) -> (u64, u64, u64) {
    let mut out = (0, 0, 0);
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            let (f, l, a) = tally_into(&e.path(), seen);
            out = (out.0 + f, out.1 + l, out.2 + a + blocks(&meta));
        } else if links(&meta) < 2 || seen.insert(inode(&meta)) {
            out = (out.0 + 1, out.1 + meta.len(), out.2 + blocks(&meta));
        }
    }
    out
}

/// Files, logical and allocated bytes under `dir`, not following links; a
/// file with several hard links is counted once.
pub(crate) fn tally(dir: &Path) -> (u64, u64, u64) {
    tally_into(dir, &mut std::collections::HashSet::new())
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

pub fn lock(data: &Path) -> std::io::Result<Lock> {
    // Beside the Prompts' records (prompt.rs), which it is about.
    let dir = data.join("prompts");
    crate::disk::write::private_dir(&dir)?;
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".lock"))?;
    // The browser's core is one instance at a time, and has no locks to take.
    match f.lock() { Err(e) if e.kind() != std::io::ErrorKind::Unsupported => return Err(e), _ => {} }
    Ok(Lock(f))
}

/// One at a time, across the app and l3: a Prompt recording what it holds (prompt.rs), the root made
/// current (root.rs), and a thing looked at again and let go (`free`). What a Prompt took, or the root
/// made current, before the look is seen by it; after, it finds the thing there, or not at all, never going.
pub struct Lock(fs::File);

impl Drop for Lock {
    /// Let go of as soon as it is done with (closing the file would too).
    fn drop(&mut self) { let _ = self.0.unlock(); }
}




