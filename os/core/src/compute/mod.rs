//! Compute wherever it runs: what a run is, what it may use and what it used (spec.rs), and microVMs on servers
//! (vm.rs), driven through Firecracker (firecracker.rs) with their disks (image.rs) and their line to the host
//! (wire.rs).

// No unsafe code in this layer.
#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
pub mod firecracker;
#[cfg(target_os = "linux")]
pub mod image;
pub mod spec;
#[cfg(target_os = "linux")]
pub mod vm;
#[cfg(target_os = "linux")]
pub mod wire;
