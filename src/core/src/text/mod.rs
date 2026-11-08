//! The OS's words: English or Japanese (i18n.rs, the tr! macro), a first line's kind and title (title.rs), names as
//! l3 and the app write them (names.rs), and the lines added and removed between two texts (diff.rs).

// No unsafe code in this layer.
#![forbid(unsafe_code)]

pub mod diff;
pub mod i18n;
pub mod names;
pub mod title;
