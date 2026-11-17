//! Linux execution-domain authority, separate from translation and file payloads.
//!
//! Private memory admission and sealed resident-file read ABI.
//! No guest Linux runtime entry exists yet.
//! The legacy TypeScript runtime is not replaced by this crate.
mod effect;

mod lease;

#[cfg(target_arch = "wasm32")]
mod wasm;

mod inode;

mod descriptor;

mod read;

mod filesystem;

mod mount;
