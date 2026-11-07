//! One at a time, across the app and l3: a Prompt recording what it holds (prompt/running.rs), the root made current
//! (root/), and a thing looked at again and let go (storage's `free`). What a Prompt took, or the root made current,
//! before the look is seen by it; after, it finds the thing there, or not at all, never going.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Held until dropped: closing its file lets go, and the next `lock` of the same data goes on.
pub struct Lock {
    _file: File,
}

/// The lock of the OS's data at `data`, waited for while another holds it.
pub fn lock(data: &Path) -> io::Result<Lock> {
    // Beside the Prompts' records (prompt/running.rs), which it is about; their directory made, private, the first time.
    let dir = data.join("prompts");
    let open = || OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".lock"));
    let file = match open() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => { crate::fs::write::private_dir(&dir)?; open()? }
        other => other?,
    };
    // The browser's core is one instance at a time, and has no locks to take.
    match file.lock() {
        Err(e) if e.kind() != io::ErrorKind::Unsupported => Err(e),
        _ => Ok(Lock { _file: file }),
    }
}

#[cfg(test)]
#[path = "tests/lock.rs"]
mod tests;
