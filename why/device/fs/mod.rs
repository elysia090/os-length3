//! Files on this device as the OS keeps its own: where they are (paths.rs), written private and whole (write.rs), the
//! room they take and the disk has (size.rs), figures measured of folders kept a while (kept.rs), named by their bytes
//! (hash.rs), and the lock that makes changing hands one at a time (lock.rs).

// No unsafe code in this layer: the host is called through rustix's safe interface.
#![forbid(unsafe_code)]

pub mod hash;
pub mod kept;
pub mod lock;
pub mod paths;
pub mod size;
#[cfg(all(test, unix))]
pub(crate) mod testing;
pub mod write;
