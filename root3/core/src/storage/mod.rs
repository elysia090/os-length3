//! この端末: what this OS holds on the device, measured where the host
//! measures it, as one list by size, each thing saying what can be done
//! with it:
//!
//!   空ける          it is not needed here: an old root (fetched again from
//!                   the Remote when wanted), a leftover temporary, a repo
//!                   whose copy is exactly what the Remote has
//!   空ける (sent)    a repo with changes the Remote does not have yet: they
//!                   are sent first, then the copy goes
//!   (kept)          and why: the root Prompts run on, a repo holding what
//!                   cannot be sent, Home's settings
//!
//! What a repo's Prompts wrote outside it is listed too, by owner and
//! lifetime (prompt/writes.rs): its environment (what its package manager put over
//! the root; freeing it brings the plain root back) and its caches (made
//! again when needed); and inside it, what is derived from its files
//! (node_modules, target, a venv: made again by the tool that made them).
//! None of these is ever the only copy of anything the person made, so all
//! may go; the first two go once their repo is not on this device.
//!
//! A repo that is freed stays on the Remote and comes back when opened.
//!
//! What a Prompt holds stays while it runs, and from the moment it starts
//! being prepared (`.packages`, `.setup`): its repo, the repo's environment,
//! caches and what is derived in it, and the root it runs on, whichever is
//! current now. Each Prompt here records what it holds (prompt/running.rs) under the
//! same lock (`lock`) a thing is looked at again under just before it goes,
//! and the current root is changed under, so none of these comes between the
//! look and the removal.
//!
//! Every figure says how it is known. `allocated` is what the host's
//! filesystem has set aside (st_blocks), which is what giving room back is
//! about: a sparse or deleted file counts only what it really holds, and a
//! file with several hard links is counted once. Host free space is what
//! the host reports; after freeing, the change in it is observed, not
//! attributed, because other programs write too.
//!
//! A leftover is disposable by proof, not by name: a temporary file this OS
//! itself writes while replacing a file (`.<name>.root3-<pid>-<n>`,
//! `<key>.json.<pid>` in Home) whose writer is gone and which is older than
//! a minute; in the system directory, a root half unpacked by an install
//! that died, and a release bundle or partial download not in use. Nothing
//! in a repo's .git and no file the person made is ever a leftover.

// No unsafe code in this layer.
#![forbid(unsafe_code)]

mod items;
mod free;

pub use self::items::{all_freeable, Certainty, Held, Item, Room, Space, space, system, SystemUsage};
#[cfg(not(target_os = "wasi"))]
pub use self::free::{fetch_distro, fetch_root};
pub use self::free::{bring_repo, free, Freed, make_room};

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
