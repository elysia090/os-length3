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
    let (total, free) = room(dir)?;
    Ok(Capacity { total, free, app: crate::usage::allocated(dir), measured: "statvfs+st_blocks" })
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


