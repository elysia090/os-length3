//! The distribution's root, as root3 holds it on a device. The canonical copy
//! is the release: a `.tar.zst` bundle named by its sha256, pinned here. It
//! is root3: the desktop app installs it, and the web reads the same tree from
//! it (scripts/webroot.ts), so one entry here pins both.
//! Installing checks the bundle against the pin before reading a byte of
//! it, unpacks it into a fresh directory (refusing any entry that would land
//! outside, follow a link, or be a device), and moves that into place in one
//! step. The root is then only read: a Prompt mounts it read-only.
//!
//!   <data>/system/<sha256>/root       the tree
//!   <data>/system/<sha256>/manifest   the release's own record
//!   <data>/system/current             which one Prompts use
//!
//! One known-good previous root is kept, so a bad update can be undone;
//! older ones are what 空ける gives back.
//!
//! Other distributions' roots (Ubuntu, Debian) are held the same way: their
//! makers' own root archive, taken only at the digest pinned here, unpacked
//! by the same rules. A Prompt runs whichever root is current.

// No unsafe code in this layer.
#![forbid(unsafe_code)]

mod pins;
mod held;
mod unpack;
#[cfg(not(target_os = "wasi"))]
mod fetch;
mod install;

pub use self::pins::{Distro, distro, DISTROS, github_url, Release, release_url, RELEASES, sources};
pub use self::held::{current, Entry, held, identify, Installed, list, system_dir, use_held};
pub use self::unpack::unpack;
#[cfg(not(target_os = "wasi"))]
pub use self::fetch::{fetch_and_install, fetch_distro};
pub use self::install::{install, install_distro};

#[cfg(test)]
#[path = "tests/root.rs"]
mod tests;
