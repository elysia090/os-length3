//! Linux execution-domain authority, separate from translation and file payloads.
//!
//! Private memory/image admission and sealed resident/lazy read ABI.
//! An opt-in fixed-memory read-only caller/stdio profile is connected; the
//! default Node/Worker Linux runtime entry is not migrated.
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

mod startup;
