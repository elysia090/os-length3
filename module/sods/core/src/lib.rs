//! Portable execution-core contracts, independent of host and distribution glue.
//!
//! This first unit validates the private byte-effect representation. It does not
//! yet implement the kernel, allocate exported slots, or enforce mapping pins.
pub mod byte_effect;
