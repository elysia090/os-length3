//! What the OS keeps from the host. The OS starts no host program for a
//! repo: history is the Remote's (history.rs), and a repo's own tools run
//! inside the root (launch.rs). Its own data is private to the person.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::path::Path;

/// Make the OS's own directory private to the person (0700). Other users of
/// the host see neither repos nor Home's state.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
