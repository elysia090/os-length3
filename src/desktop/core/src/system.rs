//! This device: how much room the filesystem holding the OS's data has, and
//! how much the OS itself holds there.

use serde::Serialize;
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
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (total, free) = filesystem(dir).map_err(|e| e.to_string())?;
    Ok(Capacity { total, free, app: allocated(dir), measured: "statvfs+st_blocks" })
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

/// Allocated (not logical) bytes, so sparse files count only what they hold.
pub fn allocated(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    #[cfg(unix)]
    let own = { use std::os::unix::fs::MetadataExt; meta.blocks() * 512 };
    #[cfg(not(unix))]
    let own = meta.len();
    if !meta.is_dir() {
        return own;
    }
    own + std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| allocated(&e.path())).sum())
        .unwrap_or(0)
}
