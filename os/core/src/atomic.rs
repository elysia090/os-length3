//! Replacing a file whole, so that neither a reader nor a crash ever sees
//! half of it. The bytes go into a new file beside it, made afresh (O_EXCL:
//! never opened through a link someone planted at its name), are flushed to
//! the disk, and the new file is renamed over the old in one step; then the
//! directory is flushed, so the rename itself outlives a crash. The new
//! file's name is this OS's temporary (`.<name>.length3-<pid>-<n>`,
//! usage.rs), so a walk skips it and a leftover is reclaimed.

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
    /// Work saved, made again when lost.
    pub const CACHE: How = How { mode: None, durable: false };
}

/// The temporary `path` is written through: a name of this OS's own, free beside it.
#[cfg_attr(not(unix), allow(unused_variables))] // modes and directory syncs are the host's
fn beside(path: &Path, how: How) -> io::Result<(PathBuf, fs::File)> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut last = None;
    for _ in 0..64 {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_file_name(format!(".{name}.length3-{}-{n}", crate::pid()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = how.mode {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
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
    let done = fill(f, bytes, how).and_then(|_| fs::rename(&tmp, path));
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
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(io::Error::other);
        let (a, b) = (c(from)?, c(to)?);
        // SAFETY: two NUL-terminated paths that live across the call.
        let r = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), libc::RENAME_NOREPLACE) };
        if r == 0 { return Ok(()); }
        let e = io::Error::last_os_error();
        // A kernel or filesystem without it: asked the slower way below.
        if !matches!(e.raw_os_error(), Some(libc::ENOSYS) | Some(libc::EINVAL)) { return Err(e); }
    }
    if to.symlink_metadata().is_ok() { return Err(io::Error::from(io::ErrorKind::AlreadyExists)); }
    fs::rename(from, to)
}

/// Flush the directory `path` is in, so a rename into it is on the disk.
/// Where a directory cannot be opened to flush (not unix), the rename stands as the system keeps it.
#[cfg_attr(not(unix), allow(unused_variables))] // modes and directory syncs are the host's
fn sync_dir(path: &Path) {
    #[cfg(unix)]
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        if let Ok(d) = fs::File::open(dir) { let _ = d.sync_all(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("length3-atomic-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_file_is_replaced_whole_and_nothing_is_left_beside_it() {
        let d = scratch("whole");
        let at = d.join("state.json");
        replace(&at, b"{\"a\":1}", How::RECORD).unwrap();
        replace(&at, b"{\"a\":2}", How::CACHE).unwrap();
        assert_eq!(fs::read(&at).unwrap(), b"{\"a\":2}");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        // Into a folder that is not there: an error, and nothing made.
        assert!(replace(&d.join("missing/x"), b"x", How::RECORD).is_err());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_file_made_once_is_never_replaced() {
        let d = scratch("create");
        let at = d.join("host_key");
        create(&at, b"first", How::PRIVATE).unwrap();
        assert_eq!(create(&at, b"second", How::PRIVATE).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&at).unwrap(), b"first");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_directory_goes_into_place_whole_and_never_over_another() {
        let d = scratch("rename-new");
        fs::create_dir_all(d.join("aside/sub")).unwrap();
        fs::create_dir(d.join("taken")).unwrap();
        assert_eq!(rename_new(&d.join("aside"), &d.join("taken")).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert!(d.join("aside/sub").is_dir() && fs::read_dir(d.join("taken")).unwrap().count() == 0);
        rename_new(&d.join("aside"), &d.join("free")).unwrap();
        assert!(d.join("free/sub").is_dir() && !d.join("aside").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_the_owners_alone_whatever_it_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("private");
        let at = d.join("remote.json");
        fs::write(&at, "old").unwrap();
        fs::set_permissions(&at, fs::Permissions::from_mode(0o644)).unwrap();
        replace(&at, b"token", How::PRIVATE).unwrap();
        assert_eq!(fs::metadata(&at).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_planted_at_the_temporarys_name_is_not_written_through() {
        let d = scratch("planted");
        let outside = d.join("outside");
        fs::write(&outside, "the person's own").unwrap();
        let pid = std::process::id();
        for n in 0..8 { std::os::unix::fs::symlink(&outside, d.join(format!(".a.length3-{pid}-{n}"))).unwrap(); }
        replace(&d.join("a"), b"new", How::RECORD).unwrap();
        assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own");
        assert_eq!(fs::read_to_string(d.join("a")).unwrap(), "new");
        let _ = fs::remove_dir_all(&d);
    }
}
