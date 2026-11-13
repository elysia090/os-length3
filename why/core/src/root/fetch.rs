//! A root fetched over the network (the Remote by digest first, then its makers), room asked for before a byte
//! comes, then installed and made the one Prompts use. A browser's core fetches none: the web reads why its own way.

use super::held::{Installed, system_dir, use_held};
use super::install::{install, install_distro};
use super::pins::{by_digest, Distro, RELEASES, sources};
use std::fs;
use std::path::Path;

/// Fetch the newest pinned release from the Remote and install it; the
/// bundle is let go once its root is in place. `room` is asked for what the
/// bundle and its tree take before a byte comes (storage/free.rs fetch_root).
pub fn fetch_and_install(data: &Path, remote: &str, room: impl FnOnce(u64), progress: impl FnMut(crate::device::download::Progress)) -> Result<Installed, String> {
    let r = &RELEASES[0];
    let bundles = system_dir(data).join(".bundles");
    crate::fs::write::private_dir(&system_dir(data)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bundles).map_err(|e| e.to_string())?;
    let bundle = bundles.join(format!("{}.tar.zst", r.sha256));
    room(r.bytes.saturating_mul(3));
    // The Remote first, then the publisher's, then the release channel
    // (`sources`). Whichever gives it, the bytes are only kept if they are
    // the pinned digest.
    fetch_first(&sources(remote, r), r.sha256, r.bytes, &bundle, progress)?;
    let installed = install(data, &bundle)?;
    let _ = fs::remove_file(&bundle);
    Ok(installed)
}

/// Fetch another distribution's root (the Remote by digest first, then its
/// makers), install it, and make it the one Prompts use. `room` is asked for
/// what its bundle and its tree take before a byte comes (root/fetch.rs fetch_distro).
pub fn fetch_distro(data: &Path, remote: &str, d: &Distro, room: impl FnOnce(u64), progress: impl FnMut(crate::device::download::Progress)) -> Result<Installed, String> {
    if let Some(had) = use_held(data, d.sha256) { return Ok(had); }
    let bundles = system_dir(data).join(".bundles");
    crate::fs::write::private_dir(&system_dir(data)).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bundles).map_err(|e| e.to_string())?;
    let archive = bundles.join(format!("{}.tar.gz", d.sha256));
    // Its bundle and its tree: room made for them first.
    room(d.bytes.saturating_mul(3));
    let mut progress = progress;
    if let Err(first) = crate::device::download::fetch(&by_digest(remote, d.sha256), d.sha256, d.bytes, &archive, &mut progress) {
        crate::device::download::fetch(d.url, d.sha256, d.bytes, &archive, &mut progress).map_err(|e| format!("{first} / {e}"))?;
    }
    let installed = install_distro(data, d, &archive);
    let _ = fs::remove_file(&archive);
    installed
}

/// The first of `urls` that gives the pinned file; when none does, what each said.
fn fetch_first(urls: &[String], sha256: &str, bytes: u64, dest: &Path, mut progress: impl FnMut(crate::device::download::Progress)) -> Result<(), String> {
    let mut said = Vec::new();
    for url in urls {
        match crate::device::download::fetch(url, sha256, bytes, dest, &mut progress) {
            Ok(()) => return Ok(()),
            Err(e) => said.push(e),
        }
    }
    Err(crate::tr!("No source has this root yet ({}). The Remote has every root pinned here once its deploy has put it there.",
        "この root はまだどこからも取れません（{}）。ここで固定した root は、デプロイのときに Remote に置かれます。", said.join(" / ")))
}

