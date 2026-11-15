//! The roots held in a directory (`<system>/<sha256>`), the one in use (`current`), what is in one, and a bundle
//! put in place: unpacked aside, checked against its pin as it is read, and renamed into place whole.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use crate::read::Hashed;
use crate::Error;

/// What a bundle must be to be taken: its sha256 and its length.
#[derive(Debug, Clone, Copy)]
pub struct Pin<'a> {
    pub sha256: &'a str,
    pub bytes: u64,
}

/// How a bundle holds its tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    /// A release: zstd frames of a tar whose tree is `root/`, its own record (`manifest`) beside it.
    Release,
    /// Another distribution's archive, as its makers publish it: a .tar.gz of the tree itself.
    TarGz,
}

/// What a root is said to be, by whoever pinned it.
#[derive(Debug, Clone, Copy)]
pub struct About<'a> {
    pub name: &'a str,
    pub version: &'a str,
    /// Another distribution's root (its id: ubuntu, debian); none for ricebox's own.
    pub distro: Option<&'a str>,
}

/// A root held: what installed.json says.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Installed {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub files: u64,
    pub bytes: u64,
    /// What the host set aside for it (st_blocks), counted once when it was put in place: a root does not change, so
    /// it is never walked again to say its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocated: Option<u64>,
    /// Another distribution's root (its id: ubuntu, debian); none for ricebox's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

fn about(dir: &Path) -> Option<Installed> {
    serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).ok()?).ok()
}

fn current_link(system: &Path) -> PathBuf {
    system.join("current")
}

/// The root in use, if one is: its tree, and what it is.
pub fn current(system: &Path) -> Option<(PathBuf, Installed)> {
    let dir = system.join(fs::read_link(current_link(system)).ok()?);
    Some((dir.join("root"), about(&dir)?))
}

/// Every root held, the one in use first.
pub fn held(system: &Path) -> Vec<(Installed, bool)> {
    let now = current(system).map(|(_, a)| a.sha256);
    // Each root once: by its own directory, not through `current` or one being made.
    let mut out: Vec<(Installed, bool)> = fs::read_dir(system).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| about(&e.path()))
        .map(|a| { let c = now.as_deref() == Some(&a.sha256); (a, c) })
        .collect();
    out.sort_by_key(|(_, c)| !c);
    out
}

/// The root `sha256`, held, made the one in use: what it is. A new link renamed over the old one: never a moment
/// without one. Whoever calls holds what keeps a root from being let go meanwhile: one let go since it was found is
/// not made current (NotHeld), and one made current is then not let go.
pub fn point_current(system: &Path, sha256: &str) -> Result<Installed, Error> {
    let what = about(&system.join(sha256)).ok_or(Error::NotHeld)?;
    #[cfg(unix)]
    {
        let link = system.join(format!(".current.{}", std::process::id()));
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(sha256, &link)?;
        fs::rename(&link, current_link(system))?;
        Ok(what)
    }
    #[cfg(not(unix))]
    { let _ = what; Err(Error::NotHere) }
}

/// One entry of a directory of the root in use.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Entry {
    pub name: String,
    /// "dir", "file" or "link".
    pub kind: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// What `path` (absolute, as a program in the root sees it) holds in the root in use, by name. Only the root's own
/// directories are read: a path with `..`, or through a link (which inside the root may name anything on the
/// host), is refused rather than followed.
pub fn list(system: &Path, path: &str) -> Result<Vec<Entry>, Error> {
    let (root, _) = current(system).ok_or(Error::NotHeld)?;
    let rel = Path::new(path).strip_prefix("/").map_err(|_| Error::NotADirectory(path.into()))?;
    let mut dir = root;
    for c in rel.components() {
        let Component::Normal(name) = c else { return Err(Error::NotADirectory(path.into())) };
        dir.push(name);
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) { return Err(Error::NotADirectory(path.into())); }
    }
    let base = path.trim_end_matches('/');
    let mut out: Vec<Entry> = fs::read_dir(&dir)?.flatten().filter_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        let meta = e.path().symlink_metadata().ok()?;
        let path = format!("{base}/{name}");
        Some(if meta.file_type().is_symlink() {
            Entry { name, kind: "link", path, size: None, target: fs::read_link(e.path()).ok().map(|t| t.to_string_lossy().into_owned()) }
        } else if meta.is_dir() {
            Entry { name, kind: "dir", path, size: None, target: None }
        } else {
            Entry { name, kind: "file", path, size: Some(meta.len()), target: None }
        })
    }).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// What the host set aside for the tree at `path` (st_blocks, each entry once by its own name).
#[cfg(unix)]
fn allocated(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(m) = fs::symlink_metadata(path) else { return 0 };
    let own = m.blocks() * 512;
    if !m.is_dir() { return own; }
    own + fs::read_dir(path).into_iter().flatten().flatten().map(|e| allocated(&e.path())).sum::<u64>()
}

/// A directory only its owner enters, made where it is not there.
fn private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() { return Ok(()); }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?; }
    Ok(())
}

/// Put the root `bundle` holds in place under `system`, by the digest `pin` says it has: unpacked into a directory
/// aside, the bundle hashed as it is read (once: what is checked is what was unpacked, through the one handle),
/// `ready` given the tree to make it fit (another distribution's settings), then moved into place in one rename
/// once all of it is on the disk. A bundle that is not what its pin says, or holds no root, leaves nothing. Held
/// already, it is only said. It is not made the one in use (point_current).
#[cfg(target_os = "linux")]
pub fn put(system: &Path, bundle: impl Read, pin: Pin, form: Form, said: About, ready: impl FnOnce(&Path) -> io::Result<()>) -> Result<Installed, Error> {
    private_dir(system)?;
    let dir = system.join(pin.sha256);
    if let Some(had) = about(&dir) { return Ok(had); }
    static MADE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let aside = system.join(format!(".{}.{}-{}", pin.sha256, std::process::id(), MADE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&aside);
    fs::create_dir(&aside)?;
    let made = (|| -> Result<Installed, Error> {
        let mut hashed = Hashed::new(bundle);
        let counted = match form {
            Form::Release => crate::read::Frames::new(&mut hashed).and_then(|frames| crate::unpack::unpack(frames, &aside)),
            Form::TarGz => fs::create_dir(aside.join("root")).and_then(|()| crate::unpack::unpack(flate2::read::MultiGzDecoder::new(io::BufReader::with_capacity(1 << 20, &mut hashed)), &aside.join("root"))),
        }.map_err(Error::Unpack)?;
        let (sha256, bytes) = hashed.finish()?;
        if sha256 != pin.sha256 || bytes != pin.bytes { return Err(Error::NotPinned { sha256, bytes }); }
        if fs::symlink_metadata(aside.join("root/bin/sh")).is_err() { return Err(Error::NoShell); }
        ready(&aside.join("root"))?;
        let what = Installed { name: said.name.into(), version: said.version.into(), sha256, files: counted.files, bytes: counted.bytes,
            allocated: Some(allocated(&aside)), distro: said.distro.map(String::from) };
        fs::write(aside.join("installed.json"), serde_json::to_string(&what).map_err(io::Error::other)?)?;
        // installed.json says the root is whole, and nothing checks it again: the tree is on the disk before it is
        // renamed into place, or a crash soon after could leave a root that says so with empty files.
        rustix::fs::syncfs(fs::File::open(&aside)?).map_err(io::Error::from)?;
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&aside, &dir)?;
        Ok(what)
    })();
    if made.is_err() { let _ = fs::remove_dir_all(&aside); }
    made
}

/// A bundle is unpacked on Linux only: a root runs nowhere else.
#[cfg(not(target_os = "linux"))]
pub fn put(_: &Path, _: impl Read, _: Pin, _: Form, _: About, _: impl FnOnce(&Path) -> io::Result<()>) -> Result<Installed, Error> {
    Err(Error::NotHere)
}

#[cfg(test)]
#[path = "held.test.rs"]
mod tests;
