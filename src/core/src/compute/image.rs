//! A VM's disks. The root is one disk per root (by its sha256), read-only, made once from the root held here and
//! shared by every VM booted from it: its bytes are on the host once, and the host's page cache holds them once for
//! all of them. A run's own disk is small and fresh: what it is given (the repo's copy, the dotfiles), with room to
//! write, its blocks taken on the host only as it writes them (a sparse file). Both are ext4, made by mke2fs from a
//! folder, without mounting anything (no privilege asked).

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the root disks are kept.
pub fn roots(data: &Path) -> PathBuf { data.join("vm").join("roots") }

/// Bytes a folder's files take, as its disk needs room for them.
fn size_of(dir: &Path) -> u64 {
    fn walk(d: &Path, n: &mut u64) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let Ok(m) = e.path().symlink_metadata() else { continue };
            *n += m.len().max(4096);
            if m.is_dir() { walk(&e.path(), n); }
        }
    }
    let mut n = 0;
    walk(dir, &mut n);
    n
}

/// An ext4 disk at `out` holding `dir`'s tree, `bytes` large (sparse), labelled `label`.
pub fn make(dir: &Path, out: &Path, bytes: u64, label: &str) -> io::Result<()> {
    if let Some(p) = out.parent() { crate::fs::write::private_dir(p)?; }
    let aside = out.with_extension("making");
    let _ = std::fs::remove_file(&aside);
    std::fs::File::create(&aside)?.set_len(bytes)?;
    // No journal: the root is never written, and a run's disk is thrown away with its VM.
    let ran = Command::new("mkfs.ext4").args(["-q", "-F", "-O", "^has_journal", "-L", label, "-d"]).arg(dir).arg(&aside)
        .output().map_err(|e| io::Error::new(e.kind(), format!("mkfs.ext4: {e} (e2fsprogs)")))?;
    if !ran.status.success() {
        let _ = std::fs::remove_file(&aside);
        return Err(io::Error::other(format!("mkfs.ext4: {}", String::from_utf8_lossy(&ran.stderr).trim())));
    }
    std::fs::rename(&aside, out)
}

/// The disk the root `digest` (held here, `root` its tree) boots VMs from: made the first time, then the same file.
pub fn root_disk(data: &Path, digest: &str, root: &Path) -> io::Result<PathBuf> {
    let out = roots(data).join(format!("{digest}.ext4"));
    if out.is_file() { return Ok(out); }
    // Room for its files and their folders, and a quarter more for ext4's own.
    let bytes = (size_of(root) * 5 / 4 + (64 << 20)).next_multiple_of(1 << 20);
    make(root, &out, bytes, "root3root")?;
    Ok(out)
}

/// A run's own disk at `out`: `given` (a folder: the repo's copy, the dotfiles) and `room` bytes more to write in.
pub fn run_disk(given: &Path, out: &Path, room: u64) -> io::Result<()> {
    make(given, out, (size_of(given) * 5 / 4 + room).next_multiple_of(1 << 20), "root3run")
}

/// A file of a disk, read without mounting it (debugfs): what a run left there.
pub fn read_file(disk: &Path, path: &str) -> io::Result<Vec<u8>> {
    let ran = Command::new("debugfs").args(["-R", &format!("cat {path}")]).arg(disk).output()?;
    if !ran.status.success() { return Err(io::Error::other(String::from_utf8_lossy(&ran.stderr).trim().to_string())); }
    Ok(ran.stdout)
}

#[cfg(test)]
#[path = "tests/image.rs"]
mod tests;
