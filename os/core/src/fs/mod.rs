//! Files on this device as the OS keeps its own: where they are (fs/paths.rs), written private and whole
//! (write.rs), how much room they take and the disk has (size.rs), named by their bytes (hash.rs), and the lock that
//! makes changing hands one at a time (lock.rs).

pub mod hash;
pub mod lock;
pub mod paths;
pub mod size;
#[cfg(all(test, unix))]
pub(crate) mod testing;
pub mod write;
