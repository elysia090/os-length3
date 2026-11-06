//! Running a repo's programs: a Prompt on this machine (launch.rs, with what its programs may not ask the kernel:
//! seccomp.rs), what a run is and what it used wherever it runs (compute.rs), and microVMs on servers (vm.rs).

pub mod compute;
#[cfg(target_os = "linux")]
pub mod launch;
#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
pub mod seccomp;
#[cfg(target_os = "linux")]
pub mod vm;
