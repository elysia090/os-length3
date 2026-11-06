//! A root fetched, checked, unpacked beside the others and put in place whole, then made the one Prompts use.

use std::fs;
use std::io::{self};
use std::path::Path;
use super::held::{Installed, not_pinned, open_pinned, point_current, release_of, system_dir};
use super::pins::Distro;
use super::unpack::{Frames, unpack};

/// Put what was written on the filesystem holding `dir` on the disk.
fn flush(dir: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    rustix::fs::syncfs(fs::File::open(dir)?)?;
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = dir;
        rustix::fs::sync();
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Unpack a root (by `fill`, into a directory aside), check it, then move it
/// into place in one rename and make it current. Held already: only made current.
fn put_in_place(data: &Path, sha256: &str, name: &str, version: &str, distro: Option<&str>, fill: impl FnOnce(&Path) -> io::Result<(u64, u64)>) -> Result<Installed, String> {
    let system = system_dir(data);
    crate::fs::write::private_dir(&system).map_err(|e| e.to_string())?;
    let dir = system.join(sha256);
    if !dir.join("installed.json").exists() {
        let aside = system.join(format!(".{sha256}.length3-{}-0", crate::pid()));
        let _ = fs::remove_dir_all(&aside);
        fs::create_dir(&aside).map_err(|e| e.to_string())?;
        let (files, bytes) = match fill(&aside) {
            Ok(v) => v,
            Err(e) => { let _ = fs::remove_dir_all(&aside); return Err(crate::tr!("Could not unpack: {}", "展開できませんでした：{}", e)); }
        };
        if !aside.join("root/bin/sh").exists() && fs::symlink_metadata(aside.join("root/bin/sh")).is_err() {
            let _ = fs::remove_dir_all(&aside);
            return Err(crate::tr!("This release has no root/bin/sh", "このリリースには root/bin/sh がありません"));
        }
        let about = Installed { name: name.into(), version: version.into(), sha256: sha256.into(), files, bytes,
            allocated: Some(crate::fs::size::allocated(&aside)), distro: distro.map(String::from) };
        fs::write(aside.join("installed.json"), serde_json::to_string(&about).unwrap()).map_err(|e| e.to_string())?;
        // installed.json says the root is whole, and nothing checks it again: the tree is on the disk before
        // it is renamed into place, or a crash soon after could leave a root that says so with empty files.
        flush(&aside).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&aside, &dir).map_err(|e| e.to_string())?;
    }
    point_current(data, sha256)?;
    serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Install a release bundle: checked, unpacked aside, then made current in
/// one rename. The root before stays, as the one to go back to.
pub fn install(data: &Path, bundle: &Path) -> Result<Installed, String> {
    let (file, release) = open_pinned(bundle, release_of)?;
    put_in_place(data, release.sha256, release.name, release.version, None, |aside| Frames::new(file).and_then(|z| unpack(z, aside)))
}

/// What a distribution's root needs to work in a Prompt: there is one user
/// in a Prompt's namespace, so apt does not drop to another for downloads,
/// and dpkg need not wait on syncs the overlay makes cheap anyway.
fn ready_for_a_prompt(tree: &Path) -> io::Result<()> {
    let apt = tree.join("etc/apt/apt.conf.d");
    if apt.is_dir() {
        fs::write(apt.join("00length3"), "// A Prompt has one user: apt fetches as it, not as _apt,\n// and its log is not handed to a group (adm) the Prompt does not have.\nAPT::Sandbox::User \"root\";\nDir::Log::Terminal \"\";\n")?;
    }
    let dpkg = tree.join("etc/dpkg/dpkg.cfg.d");
    if dpkg.is_dir() {
        fs::write(dpkg.join("length3"), "force-unsafe-io\n")?;
    }
    Ok(())
}

pub(super) fn unpack_distro(data: &Path, d: &Distro, archive: fs::File) -> Result<Installed, String> {
    put_in_place(data, d.sha256, d.name, d.version, Some(d.id), |aside| {
        let tree = aside.join("root");
        fs::create_dir(&tree)?;
        let counted = unpack(flate2::read::MultiGzDecoder::new(io::BufReader::new(archive)), &tree)?;
        ready_for_a_prompt(&tree)?;
        Ok(counted)
    })
}

/// Install a distribution's root from its archive and make it current. The archive is checked against
/// its pin through the handle it is then unpacked from (open_pinned).
pub fn install_distro(data: &Path, d: &Distro, archive: &Path) -> Result<Installed, String> {
    let file = open_pinned(archive, |sha, n| (sha == d.sha256 && n == d.bytes).then_some(()).ok_or_else(|| not_pinned(sha, n)))?.0;
    unpack_distro(data, d, file)
}

