//! The person's repos on this device: the store every path into one goes through (store.rs), what a repo's folder
//! holds, counted in one walk (measure.rs), what in it is derived from its files (derived.rs), the lines of work and
//! which one a repo shows (lines.rs), its issues (issues.rs), and the templates a new one starts from (templates.rs).

// No unsafe code in this layer.
#![forbid(unsafe_code)]

pub mod derived;
pub mod issues;
pub mod lines;
pub mod measure;
pub mod store;
pub mod templates;
