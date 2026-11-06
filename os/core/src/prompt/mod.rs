//! A Prompt: started on this machine's kernel with the root and nothing of the host's but what is handed in
//! (launch.rs), what its programs may not ask the kernel at all (seccomp.rs), what it writes outside its repo and how
//! long each part lives (writes.rs), and the Prompts running here as the host's /proc tells (running.rs).

#[cfg(target_os = "linux")]
pub mod launch;
#[cfg(not(target_os = "wasi"))]
pub mod running;
#[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
pub mod seccomp;
pub mod writes;
