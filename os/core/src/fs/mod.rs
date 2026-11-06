//! Files on this device as the OS keeps its own: where they are (paths.rs), written private and whole
//! (write.rs), how much room they take and the disk has (size.rs), named by their bytes (hash.rs).

pub mod hash;
pub mod paths;
pub mod size;
#[cfg(all(test, unix))]
pub(crate) mod testing;
pub mod write;
