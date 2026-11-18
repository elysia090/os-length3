//! Linux execution-domain authority, separate from translation and file payloads.
//!
//! Private memory/image admission and sealed resident/lazy read ABI.
//! An opt-in fixed-memory read-only caller/stdio profile is connected; the
//! default Node/Worker Linux runtime entry is not migrated.
//! The legacy TypeScript runtime is not replaced by this crate.
#[cfg(all(feature = "capture-v1", feature = "sendfile-probe"))]
compile_error!("capture-v1 cannot be built with synthetic probe features");
#[cfg(all(
    feature = "owned-stdout-v1",
    any(feature = "capture-v1", feature = "sendfile-probe")
))]
compile_error!("owned-stdout-v1 cannot compose with capture or synthetic probe features");

mod effect;

mod lease;

#[cfg(target_arch = "wasm32")]
mod wasm;

mod inode;

mod prepared_root;

mod descriptor;

mod read;

#[cfg(not(feature = "capture-v1"))]
mod sendfile;

mod filesystem;

mod mount;

mod fs_context;

mod execution;

mod single_task;

mod syscall;

mod stack;

mod credentials;

mod path;

mod startup;
