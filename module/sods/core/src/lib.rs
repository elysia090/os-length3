//! Portable execution-core contracts, independent of host and distribution glue.
//!
//! Byte-effect validation, owned regular-file payloads/lazy attempts and read
//! leases. Namespace, process/FD state and mapping-pin enforcement remain outside
//! this crate; these slices are not a complete migrated kernel.
pub mod byte_effect;
pub mod files;
pub mod pending_read;
#[cfg(target_arch = "wasm32")]
mod web_files;
