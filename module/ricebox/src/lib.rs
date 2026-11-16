//! A ricebox root on a device: its form at rest, and nothing of who uses it.
//!
//!   <system>/<sha256>/root             the tree, as its bundle unpacked it; only read after
//!   <system>/<sha256>/manifest         the release's own record, where its bundle has one
//!   <system>/<sha256>/installed.json   what it is (Installed): it is there, so the root is whole
//!   <system>/current                   which one is in use: a link to one of them
//!
//! A root is named by the sha256 of its bundle and taken only at that digest: the canonical copy is the release,
//! a `.tar.zst` (zstd frames of a tar whose tree is `root/`). Another distribution's root (its makers' own archive,
//! a `.tar.gz` of the tree) is held the same way, by the same rules. A bundle is unpacked into a directory aside,
//! every entry placed beneath it and through no link (unpack.rs), checked against its pin as it is read, and moved
//! into place in one rename once the whole of it is on the disk; a bundle that is not what its pin says leaves
//! nothing behind.
//!
//! What is not here: which roots a product trusts and where it fetches one from, what runs on a root, and the words
//! a person is told. Whoever calls says the directory roots are held in, and holds whatever keeps one from being
//! let go while it is made current.
//!
//! Its bounds, counted by hand, for a root put in place (a file of the bundle is n bytes; the tree has F files, D
//! directories, L links):
//!
//!   the bundle's bytes     read once, each hashed once and decoded once: the digest is taken from the same bytes
//!                          the tree is made of, through the one handle (never a second read to check it)
//!   a file of the tree     three calls: made (beneath its directory, never over anything, with its mode), written
//!                          (once, where it fits what was decoded at a time: a megabyte), closed
//!   a directory, a link    one call each; a directory come into is held (one call) while its files are made, so
//!                          no file is named by more than its own name
//!
//! unpack.test.rs counts the calls and holds them there.

// A bundle is unpacked and a box run on Linux alone; elsewhere (a browser's core, another system) the roots held are
// only read, and what unpacking is made of is there unused.
#![cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]
// Unsafe code is run.rs's alone (the OS called where no safe call says it), each block one call; every other module has none.
#![deny(unsafe_code)]

pub mod bundle;
mod held;
mod read;
#[cfg(target_os = "linux")]
pub mod run;
#[cfg(target_os = "linux")]
mod unpack;

pub use held::{current, held, list, point_current, put, About, Entry, Form, Installed, Pin};
pub use read::digest_of;
#[cfg(target_os = "linux")]
pub use unpack::{unpack, Unpacked};

/// Why a root was not put in place, made current or read.
#[derive(Debug)]
pub enum Error {
    /// The host's own refusal.
    Io(std::io::Error),
    /// The bundle is not what its pin says: what it is instead.
    NotPinned { sha256: String, bytes: u64 },
    /// The bundle could not be unpacked: what was wrong with it.
    Unpack(std::io::Error),
    /// What was unpacked has no /bin/sh: it is no root.
    NoShell,
    /// The root is not held (it was let go meanwhile, or never was).
    NotHeld,
    /// Not a directory of the root, by a path from /.
    NotADirectory(String),
    /// A bundle is unpacked on Linux only.
    NotHere,
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error { Error::Io(e) }
}
