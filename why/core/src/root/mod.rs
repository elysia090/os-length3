//! The roots why runs its Prompts on: which it trusts and where one comes from. A root itself (its bundle unpacked,
//! the roots held on a device, the one in use) is ricebox's, all of it (module/ricebox/src): what is here is a
//! product's part.
//!
//!   which        ricebox's releases by their pins, and the other distributions why takes (Ubuntu, Debian), each
//!                at one digest (pins.rs). Nothing else is put in place
//!   from where   the Remote this device uses, by digest; then the publisher's; then the release channel (fetch.rs)
//!   where held   `<data>/system` (ricebox lays it out), under the lock storage looks again under before it lets
//!                a root go
//!   made ready   another distribution's root, for a box of one user
//!   in words     what ricebox refuses, said in why's two languages
//!
//! One known-good previous root is kept, so a bad update can be undone; older ones are what 空ける gives back.

// No unsafe code in this layer.
#![forbid(unsafe_code)]

mod pins;
#[cfg(not(target_os = "wasi"))]
mod fetch;

use std::path::{Path, PathBuf};

pub use self::pins::{Distro, distro, DISTROS, github_url, Release, release_url, RELEASES, sources};
#[cfg(not(target_os = "wasi"))]
pub use self::fetch::{fetch_and_install, fetch_distro};
pub use ricebox::{Entry, Installed};
use ricebox::{About, Form, Pin};

/// Where roots are held on this device.
pub fn system_dir(data: &Path) -> PathBuf {
    data.join("system")
}

/// What ricebox refused, in why's words.
fn said(e: ricebox::Error) -> String {
    match e {
        ricebox::Error::Io(e) => e.to_string(),
        ricebox::Error::NotPinned { sha256, bytes } => not_pinned(&sha256, bytes),
        ricebox::Error::Unpack(e) => crate::tr!("Could not unpack: {}", "展開できませんでした：{}", e),
        ricebox::Error::NoShell => crate::tr!("This release has no root/bin/sh", "このリリースには root/bin/sh がありません"),
        ricebox::Error::NotHeld => crate::tr!("That root was freed meanwhile; fetch it again", "その root はそのあいだに空けられました。もう一度取ってください"),
        ricebox::Error::NotADirectory(path) => crate::tr!("Not a directory of the root: {}", "root のディレクトリではありません：{}", path),
        ricebox::Error::NotHere => crate::tr!("A root is put in place on Linux only", "root を置けるのは Linux だけです"),
    }
}

fn not_pinned(sha: &str, n: u64) -> String {
    crate::tr!("Not a known release (sha256 {}…, {} bytes)", "知らないリリースです（sha256 {}…, {} bytes）", &sha[..sha.len().min(12)], n)
}

/// The root Prompts use, if one is installed.
pub fn current(data: &Path) -> Option<(PathBuf, Installed)> {
    ricebox::current(&system_dir(data))
}

/// Every root held here, the current one first.
pub fn held(data: &Path) -> Vec<(Installed, bool)> {
    ricebox::held(&system_dir(data))
}

/// A root held made the one Prompts use, under the lock 空ける looks again under (fs/lock.rs), and only a root still
/// whole: one freed since it was found here is not made current, and the one made current is not freed after.
fn point_current(data: &Path, sha256: &str) -> Result<Installed, String> {
    let _still = crate::fs::lock::lock(data).map_err(|e| e.to_string())?;
    ricebox::point_current(&system_dir(data), sha256).map_err(said)
}

/// Make a root held here the one Prompts use; None if it is not held.
pub fn use_held(data: &Path, sha256: &str) -> Option<Installed> {
    point_current(data, sha256).ok()
}

/// What `path` (absolute, as the Prompt sees it) holds in the current root, by name: File's tree of "/" in the app
/// (a browser reads the same tree from the root's index instead).
pub fn list(data: &Path, path: &str) -> Result<Vec<Entry>, String> {
    ricebox::list(&system_dir(data), path).map_err(|e| match e {
        ricebox::Error::NotHeld => crate::tr!("There is no root", "root がありません"),
        ricebox::Error::NotADirectory(p) if !p.starts_with('/') || p.split('/').any(|c| c == "..") => crate::tr!("Not a path from /: {}", "/ からのパスではありません：{}", p),
        e => said(e),
    })
}

/// The release a bundle is, by its digest; anything not pinned is refused.
pub fn identify(bundle: &Path) -> Result<&'static Release, String> {
    let (sha, n) = std::fs::File::open(bundle).and_then(ricebox::digest_of).map_err(|e| format!("{}: {e}", bundle.display()))?;
    RELEASES.iter().find(|r| r.sha256 == sha && r.bytes == n).ok_or_else(|| not_pinned(&sha, n))
}

/// A release's bundle put in place by its pin and made current. The root before stays, as the one to go back to.
fn put_release(data: &Path, r: &Release, bundle: &Path) -> Result<Installed, String> {
    let file = std::fs::File::open(bundle).map_err(|e| format!("{}: {e}", bundle.display()))?;
    ricebox::put(&system_dir(data), file, Pin { sha256: r.sha256, bytes: r.bytes }, Form::Release, About { name: r.name, version: r.version, distro: None }, |_| Ok(())).map_err(said)?;
    point_current(data, r.sha256)
}

/// Install a release bundle a person has as a file: it is one why pins (by its digest), or it is refused; then
/// checked again as it is unpacked, through the handle it is unpacked from.
pub fn install(data: &Path, bundle: &Path) -> Result<Installed, String> {
    put_release(data, identify(bundle)?, bundle)
}

/// What a distribution's root needs to work in a Prompt: there is one user in a Prompt's box, so apt does not
/// drop to another for downloads, and dpkg need not wait on syncs.
fn ready_for_a_prompt(tree: &Path) -> std::io::Result<()> {
    let apt = tree.join("etc/apt/apt.conf.d");
    if apt.is_dir() {
        std::fs::write(apt.join("00why"), "// A Prompt has one user: apt fetches as it, not as _apt,\n// and its log is not handed to a group (adm) the Prompt does not have.\nAPT::Sandbox::User \"root\";\nDir::Log::Terminal \"\";\n")?;
    }
    let dpkg = tree.join("etc/dpkg/dpkg.cfg.d");
    if dpkg.is_dir() {
        std::fs::write(dpkg.join("why"), "force-unsafe-io\n")?;
    }
    Ok(())
}

/// Install a distribution's root from its archive and make it current. The archive is checked against its pin as
/// it is unpacked, through the one handle.
pub fn install_distro(data: &Path, d: &Distro, archive: &Path) -> Result<Installed, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    ricebox::put(&system_dir(data), file, Pin { sha256: d.sha256, bytes: d.bytes }, Form::TarGz, About { name: d.name, version: d.version, distro: Some(d.id) }, ready_for_a_prompt).map_err(said)?;
    point_current(data, d.sha256)
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
