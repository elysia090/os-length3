//! A Prompt: a repo's box. What is asked of muk for it, in muk's own words (bundle.rs: the bundle, for every host);
//! one started on this machine (start.rs: the bundle written, `muk run`, its terminal handed to `prompt attach`); what
//! it writes outside its repo and how long each part lives (writes.rs); and the Prompts running here as the host's
//! /proc tells (running.rs). No box is made here: that is muk's (module/muk), on every host.

pub mod bundle;
#[cfg(target_os = "linux")]
pub mod start;
#[cfg(not(target_os = "wasi"))]
pub mod running;
pub mod writes;
