//! One at a time, across the app and l3: a Prompt recording what it holds, the root made current, and a thing
//! looked at again and let go (空ける). What a Prompt took, or the root made current, before the look is seen by
//! it; after, it finds the thing there, or not at all, never going.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use std::fs;
use std::path::Path;

pub fn lock(data: &Path) -> std::io::Result<Lock> {
    // Beside the Prompts' records (prompt.rs), which it is about.
    let dir = data.join("prompts");
    crate::fs::write::private_dir(&dir)?;
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

