//! Linux execution-domain authority, separate from translation and file payloads.
//!
//! Internal memory-admission ABI only: no Linux runtime entry exists yet.
//! The legacy TypeScript runtime is not replaced by this crate.
mod effect;

mod lease;

#[cfg(target_arch = "wasm32")]
mod wasm;

mod inode;
