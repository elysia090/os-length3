//! The copy here as the Remote would hold it: each file by its digest,
//! read again only when it changed, and what cannot travel, with why.

use super::*;

#[derive(Debug, Default)]
pub struct Local {
    pub tree: Tree,
    /// sha -> where its bytes are (one place is enough).
    pub(super) files: BTreeMap<String, PathBuf>,
    /// Paths that are not sent, and why.
    pub unsynced: Vec<(String, String)>,
    pub bytes: u64,
    /// Every file digested, for the stamps kept (stamps_save).
    read: Vec<PathBuf>,
}

/// What a file's digest was when it was last read, by what it looked like then.
pub(super) type Seen = HashMap<PathBuf, ((u64, i128, u64), String)>;
pub(super) fn seen() -> &'static Mutex<Seen> {
    static S: OnceLock<Mutex<Seen>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn stamp(m: &fs::Metadata) -> (u64, i128, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (m.len(), m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, m.ino())
    }
    #[cfg(not(unix))]
    {
        let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128);
        (m.len(), t, 0)
    }
}

/// A file's digest, read again only when its size, time or inode moved.
pub(super) fn digest(path: &Path, meta: &fs::Metadata) -> Option<String> {
    let s = stamp(meta);
    if let Some((was, sha)) = seen().lock().ok()?.get(path) {
        if *was == s {
            return Some(sha.clone());
        }
    }
    let sha = sha256(&fs::read(path).ok()?);
    seen().lock().ok()?.insert(path.to_path_buf(), (s, sha.clone()));
    Some(sha)
}

/// The repo directory as the Remote would hold it (its .git aside).
pub fn local_tree(dir: &Path) -> Local {
    let kept = stamps_file(dir);
    if let Some(f) = &kept { stamps_load(f); }
    let mut out = Local::default();
    walk(dir, "", &mut out);
    if let Some(f) = &kept { stamps_save(f, &out.read); }
    out
}

/// Where the digests of a repo copy are kept between runs, as git keeps its
/// index: by each file's size, time and inode, so l3 (a new process each
/// time) reads again only what changed instead of every byte of every repo.
/// They are what sync last read, so they are kept with sync's other records.
/// Only copies this OS holds are kept for.
pub(super) fn stamps_file(dir: &Path) -> Option<PathBuf> {
    let (data, repos) = (crate::paths::data_dir(), crate::paths::repos_dir());
    if !(dir.starts_with(&data) || dir.starts_with(&repos)) { return None; }
    // Where they were kept before (cache/digests): nothing reads it now.
    let old = data.join("cache");
    if old.join("digests").is_dir() { let _ = fs::remove_dir_all(old.join("digests")); let _ = fs::remove_dir(&old); }
    Some(sync_dir().join("digests").join(&sha256(dir.to_string_lossy().as_bytes())[..16]))
}

/// Take in kept digests. A file changed within the same moment the stamps
/// were written may look unchanged (a coarse clock), so, as git does with a
/// racily clean index, those are read again.
pub(super) fn stamps_load(file: &Path) {
    let Ok(text) = fs::read_to_string(file) else { return };
    let mut lines = text.lines();
    let Some(written) = lines.next().and_then(|l| l.parse::<i128>().ok()) else { return };
    let Ok(mut map) = seen().lock() else { return };
    for line in lines {
        let mut w = line.splitn(5, ' ');
        let (Some(len), Some(t), Some(ino), Some(sha), Some(path)) = (w.next(), w.next(), w.next(), w.next(), w.next()) else { continue };
        let (Ok(len), Ok(t), Ok(ino)) = (len.parse::<u64>(), t.parse::<i128>(), ino.parse::<u64>()) else { continue };
        if t >= written - 2_000_000_000 { continue; }
        map.entry(PathBuf::from(path)).or_insert(((len, t, ino), sha.to_string()));
    }
}

/// Keep the digests of the files just read: exactly these, so what is gone is forgotten.
pub(super) fn stamps_save(file: &Path, read: &[PathBuf]) {
    let Ok(map) = seen().lock() else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i128);
    let mut text = format!("{now}\n");
    for p in read {
        let Some(((len, t, ino), sha)) = map.get(p) else { continue };
        let path = p.to_string_lossy();
        if path.contains('\n') { continue; }
        text.push_str(&format!("{len} {t} {ino} {sha} {path}\n"));
    }
    drop(map);
    let Some(dir) = file.parent() else { return };
    if fs::create_dir_all(dir).is_err() { return; }
    // Not kept, the next run reads those files again: work lost, nothing wrong.
    let _ = crate::atomic::replace(file, text.as_bytes(), crate::atomic::How::CACHE);
}

pub(super) fn walk(dir: &Path, prefix: &str, out: &mut Local) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut empty = true;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // A file this OS is writing is not the repo's yet.
        if crate::usage::is_temporary(&name) {
            continue;
        }
        empty = false;
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if is_git_name(&name) {
            out.unsynced.push((rel, crate::tr!("git history", "git の履歴")));
            continue;
        }
        let Ok(meta) = e.path().symlink_metadata() else { continue };
        if meta.file_type().is_symlink() {
            out.unsynced.push((rel, crate::tr!("a link", "リンク")));
        } else if meta.is_dir() {
            // Made from the repo's own files (owned.rs): not the repo's to send, nor what keeps it here.
            if crate::owned::derived(dir, &name, &e.path()) { continue; }
            walk(&e.path(), &rel, out);
        } else if meta.is_file() {
            if meta.len() > BLOB_LIMIT {
                out.unsynced.push((rel, crate::tr!("a file over 16 MB", "16 MB を超えるファイル")));
                continue;
            }
            let Some(sha) = digest(&e.path(), &meta) else { out.unsynced.push((rel, crate::tr!("a file that cannot be read", "読めないファイル"))); continue };
            out.bytes += meta.len();
            out.read.push(e.path());
            out.files.insert(sha.clone(), e.path());
            out.tree.insert(rel, Some(sha));
        } else {
            out.unsynced.push((rel, crate::tr!("a special file", "特殊なファイル")));
        }
    }
    if empty && !prefix.is_empty() {
        out.tree.insert(prefix.to_string(), None);
    }
}
