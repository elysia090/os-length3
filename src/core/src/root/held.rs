//! The roots held on this device (`<data>/system/<sha256>`), the one Prompts use (`current`), what is in one, and a
//! bundle checked against its pin through the very handle it is read from.

use std::fs;
use std::io::{self};
#[cfg(unix)]
pub(super) use std::os::unix::fs::symlink;
use std::path::{Component, Path, PathBuf};
use super::pins::{Release, RELEASES};

pub(super) fn point_current(data: &Path, sha256: &str) -> Result<(), String> {
    // Under the lock 空ける looks again under (usage::lock), and only at a root still whole: one freed since
    // it was found here is not made current, and the one made current is not freed after.
    let _still = crate::fs::lock::lock(data).map_err(|e| e.to_string())?;
    if !system_dir(data).join(sha256).join("installed.json").is_file() {
        return Err(crate::tr!("That root was freed meanwhile; fetch it again", "その root はそのあいだに空けられました。もう一度取ってください"));
    }
    // A new link renamed over the old one: never a moment without one.
    let link = system_dir(data).join(format!(".current.length3-{}-0", crate::pid()));
    let _ = fs::remove_file(&link);
    symlink(sha256, &link).map_err(|e| e.to_string())?;
    fs::rename(&link, current_link(data)).map_err(|e| e.to_string())
}

/// Make a root held here the one Prompts use; None if it is not held.
pub fn use_held(data: &Path, sha256: &str) -> Option<Installed> {
    let dir = system_dir(data).join(sha256);
    let about: Installed = serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).ok()?).ok()?;
    point_current(data, sha256).ok()?;
    Some(about)
}

/// Every root held here, the current one first.
pub fn held(data: &Path) -> Vec<(Installed, bool)> {
    let now = current(data).map(|(_, a)| a.sha256);
    // Each root once: by its own directory, not through `current` or one being made.
    let mut out: Vec<(Installed, bool)> = fs::read_dir(system_dir(data)).into_iter().flatten().flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| fs::read_to_string(e.path().join("installed.json")).ok())
        .filter_map(|t| serde_json::from_str::<Installed>(&t).ok())
        .map(|a| { let c = now.as_deref() == Some(&a.sha256); (a, c) })
        .collect();
    out.sort_by_key(|(_, c)| !c);
    out
}

/// What `path` (absolute, as the Prompt sees it) holds in the current root, by name. Only the root's own
/// directories are read: a path with `..`, or through a link (which inside the root may name anything on the
/// host), is refused rather than followed.
pub fn list(data: &Path, path: &str) -> Result<Vec<Entry>, String> {
    let (root, _) = current(data).ok_or_else(|| crate::tr!("There is no root", "root がありません"))?;
    let rel = Path::new(path).strip_prefix("/").map_err(|_| crate::tr!("Not a path from /: {}", "/ からのパスではありません：{}", path))?;
    let mut dir = root;
    for c in rel.components() {
        let Component::Normal(name) = c else { return Err(crate::tr!("Not a path from /: {}", "/ からのパスではありません：{}", path)) };
        dir.push(name);
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            return Err(crate::tr!("Not a directory of the root: {}", "root のディレクトリではありません：{}", path));
        }
    }
    let base = path.trim_end_matches('/');
    let mut out: Vec<Entry> = fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().filter_map(|e| {
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

/// One entry of a directory of the current root, as File's tree of "/" shows it in the app (a browser reads the
/// same tree from root3's index instead).
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

/// The root Prompts use, if one is installed.
pub fn current(data: &Path) -> Option<(PathBuf, Installed)> {
    let dir = system_dir(data).join(fs::read_link(current_link(data)).ok()?);
    let about: Installed = serde_json::from_str(&fs::read_to_string(dir.join("installed.json")).ok()?).ok()?;
    Some((dir.join("root"), about))
}

fn current_link(data: &Path) -> PathBuf {
    system_dir(data).join("current")
}

/// Open `path` and check it against a pin by its sha256 and size (`pinned` says what it is, or why not),
/// read through the handle that is returned, wound back to its start, for the caller to unpack. What was
/// checked is then what is read: a check by name and a second open could read two different files (one
/// put in its place between them, or a disk that answers twice differently).
pub(super) fn open_pinned<T>(path: &Path, pinned: impl FnOnce(&str, u64) -> Result<T, String>) -> Result<(fs::File, T), String> {
    let mut f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (sha, n) = crate::fs::hash::sha256_read(&mut f).map_err(|e| format!("{}: {e}", path.display()))?;
    let what = pinned(&sha, n)?;
    io::Seek::rewind(&mut f).map_err(|e| e.to_string())?;
    Ok((f, what))
}

pub(super) fn not_pinned(sha: &str, n: u64) -> String {
    crate::tr!("Not a known release (sha256 {}…, {} bytes)", "知らないリリースです（sha256 {}…, {} bytes）", &sha[..12], n)
}

pub(super) fn release_of(sha: &str, n: u64) -> Result<&'static Release, String> {
    RELEASES.iter().find(|r| r.sha256 == sha && r.bytes == n).ok_or_else(|| not_pinned(sha, n))
}

/// The release a bundle is, by its digest; anything not pinned is refused.
pub fn identify(bundle: &Path) -> Result<&'static Release, String> {
    open_pinned(bundle, release_of).map(|(_, r)| r)
}

pub fn system_dir(data: &Path) -> PathBuf {
    data.join("system")
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Installed {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub files: u64,
    pub bytes: u64,
    /// What the host set aside for it (st_blocks), counted once when it was
    /// put in place: a root does not change, so it is never walked again to
    /// say its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allocated: Option<u64>,
    /// Another distribution's root (its id: ubuntu, debian); none for root3's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
}

/// Built for the web there is no root to fetch or install (a Prompt there runs the web's own), but the
/// roots held are read, counted and let go by this same code.
#[cfg(not(unix))]
pub(super) fn symlink(_: impl AsRef<Path>, _: impl AsRef<Path>) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

