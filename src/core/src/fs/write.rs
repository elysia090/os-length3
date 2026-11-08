//! How the OS writes its own files. What it keeps is the person's alone: its directories are private (0700), so
//! other users of the host see neither repos nor Home's state. And a file is replaced whole, so that neither a
//! reader nor a crash ever sees half of it: the bytes go into a new file beside it, made afresh (O_EXCL: never
//! opened through a link someone planted at its name), are flushed to the disk, and the new file is renamed over
//! the old in one step; then the directory is flushed, so the rename itself outlives a crash. The new file's name
//! is this OS's temporary (`.<name>.length3-<pid>-<n>`), which a walk skips and storage reclaims when it is left.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// How a file is replaced.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct How {
    /// Its permission bits; None: what the process's umask gives a new file.
    pub mode: Option<u32>,
    /// Flushed to the disk before and after the rename. A cache, which is
    /// only work saved, is not: losing it to a crash costs reading again.
    pub durable: bool,
}

impl How {
    /// A record the OS goes by.
    pub const RECORD: How = How { mode: None, durable: true };
    /// The person's own state (a session token, Home's settings): theirs alone.
    pub const PRIVATE: How = How { mode: Some(0o600), durable: true };
    /// Work saved, made again when lost: not flushed, and its old copy taken away just before the new one is named
    /// (`replace`), so a reader may meanwhile find none, which for a cache is only not kept; never half of one.
    pub const CACHE: How = How { mode: None, durable: false };
}

/// A file made with `mode`, where the host keeps modes (unix); elsewhere with the host's own.
#[cfg(unix)]
fn with_mode(options: &mut fs::OpenOptions, mode: Option<u32>) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(mode) = mode { options.mode(mode); }
}
#[cfg(not(unix))]
fn with_mode(_: &mut fs::OpenOptions, _: Option<u32>) {}

/// The temporary `path` is written through: a name of this OS's own, free beside it.
fn beside(path: &Path, how: How) -> io::Result<(PathBuf, fs::File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut last = None;
    for _ in 0..64 {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_file_name(format!(".{name}.length3-{}-{n}", crate::pid()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        with_mode(&mut options, how.mode);
        match options.open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("no free name")))
}

/// Write `bytes` into the temporary `f` and flush it as `how` says.
fn fill(mut f: fs::File, bytes: &[u8], how: How) -> io::Result<()> {
    f.write_all(bytes)?;
    // The umask may have taken bits the mode asks for: set exactly.
    #[cfg(unix)]
    if let Some(mode) = how.mode {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    if how.durable { f.sync_all()?; }
    Ok(())
}

/// Replace `path` with `bytes`, whole. On failure `path` is as it was and nothing is left beside it.
pub fn replace(path: &Path, bytes: &[u8], how: How) -> io::Result<()> {
    let (tmp, f) = beside(path, how)?;
    let done = fill(f, bytes, how).and_then(|_| {
        // A cache's old copy goes first: renamed over one, ext4 writes the new file out at once (auto_da_alloc), some
        // 20 times the write itself. A reader between the two finds none, which for a cache is only not kept.
        if !how.durable { let _ = fs::remove_file(path); }
        fs::rename(&tmp, path)
    });
    match done {
        Ok(()) => { if how.durable { sync_dir(path); } Ok(()) }
        Err(e) => { let _ = fs::remove_file(&tmp); Err(e) }
    }
}

/// Make `path` with `bytes`, whole, unless something is there already (an
/// AlreadyExists error then, and what is there stays): for what must be made
/// once and never replaced, such as a host key two starts could both make.
pub fn create(path: &Path, bytes: &[u8], how: How) -> io::Result<()> {
    let (tmp, f) = beside(path, how)?;
    // A link refuses a name that is taken, where a rename would replace it.
    let done = fill(f, bytes, how).and_then(|_| fs::hard_link(&tmp, path));
    let _ = fs::remove_file(&tmp);
    if done.is_ok() && how.durable { sync_dir(path); }
    done
}

/// Move `from` to `to` in one step unless something is at `to` (AlreadyExists then): a directory made
/// aside goes into place whole, and never over (or, empty, into) one another made meanwhile.
pub fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use rustix::{fs::{renameat_with, RenameFlags, CWD}, io::Errno};
        match renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE) {
            Ok(()) => return Ok(()),
            // A kernel or filesystem without it: asked the slower way below.
            Err(Errno::NOSYS | Errno::INVAL | Errno::NOTSUP) => {}
            Err(e) => return Err(e.into()),
        }
    }
    if to.symlink_metadata().is_ok() { return Err(io::Error::from(io::ErrorKind::AlreadyExists)); }
    fs::rename(from, to)
}

/// Flush the directory `path` is in, so a rename into it is on the disk.
/// Where a directory cannot be opened to flush (not unix), the rename stands as the system keeps it.
#[cfg(unix)]
fn sync_dir(path: &Path) {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        if let Ok(d) = fs::File::open(dir) { let _ = d.sync_all(); }
    }
}
#[cfg(not(unix))]
fn sync_dir(_: &Path) {}

/// The pid in a name this OS gives its temporary files (`.<name>.length3-<pid>-<n>`), if it is one. A setting's
/// temporary (`<key>.json.<pid>`) is only one in the settings directory: in a repo, a name like that is a person's
/// own file. Read back from the name's end, so a name that is neither costs a byte or two, not a search.
pub(crate) fn temporary_writer(name: &str, in_settings: bool) -> Option<u32> {
    /// `s` split before the digits it ends with.
    fn digits(s: &str) -> (&str, &str) { s.split_at(s.trim_end_matches(|c: char| c.is_ascii_digit()).len()) }
    if name.starts_with('.') {
        let (rest, n) = digits(name);
        if let Some((mark, pid)) = rest.strip_suffix('-').map(digits) {
            if !n.is_empty() && mark.len() > ".length3-".len() && mark.ends_with(".length3-") { return pid.parse().ok(); }
        }
    }
    let (stem, pid) = name.rsplit_once('.')?;
    if in_settings && stem.ends_with(".json") { pid.parse().ok() } else { None }
}

/// Whether a name in a repo is one this OS gives a file while it writes it.
pub fn is_temporary(name: &str) -> bool {
    name.starts_with(".length3-") || temporary_writer(name, false).is_some()
}

/// Make the OS's own directory private to the person (0700), and every folder made on the way to it: made so, never
/// for a moment open, and one there already made so. Other users of the host see neither repos nor Home's state.
pub fn private_dir(dir: &Path) -> io::Result<()> {
    let mut make = fs::DirBuilder::new();
    make.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        make.mode(0o700).create(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    make.create(dir)
}

#[cfg(test)]
#[path = "write.test.rs"]
mod tests;
