//! Linux execution-domain authority, separate from translation and file payloads.
//!
//! Private memory/image admission and sealed resident/lazy read ABI.
//! A private fixed-memory read/exit guest diagnostic is connected; the normal
//! Node/Worker Linux runtime entry is not migrated.
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

mod fs_context;

mod execution;

mod syscall;

mod stack;

mod credentials;

mod path;
