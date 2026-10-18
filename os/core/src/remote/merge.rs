//! Taking in what changed on the Remote: the plan (file by file against
//! the base), and writing the Remote's side into the copy here, beside
//! what is in its way and never through a link.

use super::*;

/// What taking in a remote tree means here.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Paths to make what the Remote has (None: remove; Some(None): a folder).
    pub take: Vec<(String, Option<Option<String>>)>,
    /// Changed on both sides differently: theirs (the Remote's) takes the name, this device's goes beside it.
    pub both: Vec<(String, Option<String>)>,
}

pub fn plan(base: &Tree, here: &Tree, there: &Tree) -> Plan {
    let mut p = Plan::default();
    let paths: BTreeSet<&String> = base.keys().chain(here.keys()).chain(there.keys()).collect();
    for path in paths {
        let (b, l, r) = (base.get(path), here.get(path), there.get(path));
        if l == r || r == b {
            continue;
        }
        if l == b || (l.is_none() && r.is_some()) {
            // Only changed there; or removed here and changed there, where the change wins.
            p.take.push((path.clone(), r.cloned()));
        } else if let Some(Some(theirs)) = r {
            p.both.push((path.clone(), Some(theirs.clone())));
        }
        // Removed there but changed here: this device's stays, and is sent.
    }
    p
}

/// "dir/name (other device).ext" beside `path`: the Remote's, where something here is in its way.
pub fn beside(path: &str) -> String {
    beside_as(path, "other device", 1)
}

/// "dir/name (who).ext" beside `path`; the n'th such is "(who n)".
pub fn beside_as(path: &str, who: &str, n: u32) -> String {
    let (dir, file) = path.rsplit_once('/').map_or(("", path), |(d, f)| (d, f));
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let name = if n > 1 { format!("{stem} ({who} {n}){ext}") } else { format!("{stem} ({who}){ext}") };
    if dir.is_empty() { name } else { format!("{dir}/{name}") }
}

/// This machine as a file's name can carry it: its host name, its letters, digits and . _ - alone.
pub fn device_tag() -> String {
    let mut buf = [0u8; 256];
    let got = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    let raw = if got { String::from_utf8_lossy(&buf[..buf.iter().position(|&b| b == 0).unwrap_or(buf.len())]).into_owned() } else { String::new() };
    tag_of(&raw)
}

pub(super) fn tag_of(raw: &str) -> String {
    let words: String = raw.chars().map(|c| if c.is_alphanumeric() || "._-".contains(c) { c } else { ' ' }).collect();
    let tag = words.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect::<String>();
    if tag.is_empty() { "this device".into() } else { tag }
}

/// A path inside `dir`, its folders made, refusing any part that is .git or a link.
pub(super) fn place(dir: &Path, rel: &str) -> Result<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || is_git_name(p)) {
        return Err(crate::tr!("{}: cannot be written here", "{}：ここには書けません", rel));
    }
    let mut at = dir.to_path_buf();
    for p in &parts[..parts.len() - 1] {
        at.push(p);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(crate::tr!("{}: a part of the way is not a folder", "{}：途中がフォルダーではありません", rel)),
            Err(_) => fs::create_dir(&at).map_err(|e| crate::tr!("{}: {}", "{}：{}", at.display(), e))?,
        }
    }
    Ok(at.join(parts[parts.len() - 1]))
}

/// Write `bytes` to `path` whole (atomic.rs): never through what is already
/// there, since a program in a Prompt can plant a link at any name in the
/// repo, and writing through it would reach any file the person can write.
/// Durable before the base that records it is (set_base): a file the base
/// says came from the Remote but a crash took back would be sent as a change.
pub(super) fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) {
        return Err(crate::tr!("{}: something that is not a file is there", "{}：ファイルではないものがあります", path.display()));
    }
    crate::atomic::replace(path, bytes, crate::atomic::How::RECORD).map_err(|e| crate::tr!("{}: {}", "{}：{}", path.display(), e))
}

/// Whether what is at `at` is still what the tree read said (None: nothing).
pub(super) fn still(at: &Path, expect: Option<&Option<String>>) -> bool {
    match (fs::symlink_metadata(at), expect) {
        (Err(_), None) => true,
        (Ok(m), Some(None)) => m.is_dir(),
        (Ok(m), Some(Some(sha))) if m.is_file() => digest(at, &m).as_ref() == Some(sha),
        _ => false,
    }
}

/// Write the Remote's side of `p` here. A file that cannot be written where
/// it is (a folder in its place, or a file where its folder would be) goes
/// beside; a path that changed here while this ran is left for the next round.
pub(super) fn apply(client: &Client, dir: &Path, here: &Tree, p: &Plan) -> Result<Vec<String>> {
    let mut aside = Vec::new();
    let unwritable = |path: &str| crate::tr!("{}: could not be written", "{}：書けませんでした", path);
    let put_beside = |path: &str, bytes: &[u8]| -> Result<()> {
        let at = place(dir, &beside(path)).map_err(|_| unwritable(path))?;
        write_file(&at, bytes)
    };
    for (path, what) in &p.take {
        // What a derived directory holds here is made here; the Remote's word on it is not taken.
        if crate::owned::within_derived(dir, path) { continue; }
        let Ok(at) = place(dir, path) else {
            if let Some(Some(sha)) = what {
                let bytes = client.blob(sha)?;
                let top = path.split('/').next().unwrap_or(path);
                let moved = format!("{}{}", beside(top), &path[top.len()..]);
                write_file(&place(dir, &moved).map_err(|_| unwritable(path))?, &bytes)?;
                aside.push(path.clone());
            }
            continue;
        };
        if here.contains_key(path) && !still(&at, here.get(path)) {
            continue;
        }
        match what {
            None => {
                if let Ok(m) = fs::symlink_metadata(&at) {
                    if m.is_dir() { fs::remove_dir_all(&at) } else { fs::remove_file(&at) }.map_err(|e| e.to_string())?;
                }
            }
            Some(None) => {
                if fs::symlink_metadata(&at).is_err() {
                    fs::create_dir(&at).map_err(|e| e.to_string())?;
                }
            }
            Some(Some(sha)) => {
                let bytes = client.blob(sha)?;
                if write_file(&at, &bytes).is_err() {
                    put_beside(path, &bytes)?;
                    aside.push(path.clone());
                }
            }
        }
    }
    for (path, theirs) in &p.both {
        let Some(sha) = theirs else { continue };
        let bytes = client.blob(sha)?;
        // The Remote's keeps the name (it got there first); this device's is kept beside it first, under
        // this device's name, so neither is lost if writing the other fails, and the name says whose it is everywhere.
        let at = place(dir, path).map_err(|_| unwritable(path))?;
        match fs::read(&at) {
            Ok(mine) => {
                let who = device_tag();
                let mut n = 1;
                let mut keep = place(dir, &beside_as(path, &who, n)).map_err(|_| unwritable(path))?;
                while fs::symlink_metadata(&keep).is_ok() {
                    n += 1;
                    keep = place(dir, &beside_as(path, &who, n)).map_err(|_| unwritable(path))?;
                }
                write_file(&keep, &mine)?;
                write_file(&at, &bytes)?;
            }
            // Not a file here any more: the Remote's goes beside what is in its way.
            Err(_) => put_beside(path, &bytes)?,
        }
        aside.push(path.clone());
    }
    Ok(aside)
}
