//! Owned regular-file payloads, lazy-loading state and read leases.
//!
//! No host capabilities, Linux ABI, namespace, descriptors or distribution policy.
pub mod store;
pub mod read_lease;
#[cfg(all(target_arch = "wasm32", feature = "wasm-abi"))]
mod wasm;
