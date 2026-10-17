//! Repos the app manages, under its own data directory. Every path from the
//! webview is checked to stay inside one repo, after following symlinks.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

pub use crate::Result;
use crate::{issues, templates, tr};

/// An error of the file system about `at` (a repo, or repo/path), in the OS's words.
pub fn io_error(at: impl std::fmt::Display, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => tr!("There is no {}", "{} はありません", at),
        std::io::ErrorKind::PermissionDenied => tr!("{}: not allowed", "{}：許可されていません", at),
        std::io::ErrorKind::AlreadyExists => tr!("{} is there already", "{} はもうあります", at),
        _ => tr!("{}: {}", "{}：{}", at, e),
    }
}

/// `repo/rel` as it is named to a person ("hello", "hello/src/a.c").
pub fn shown(repo: &str, rel: &str) -> String {
    let rel = rel.trim_matches('/');
    if rel.is_empty() || rel == "." { repo.to_string() } else { format!("{repo}/{rel}") }
}

fn too_large(at: &str, limit: u64) -> String {
    tr!("{} is larger than {} KB", "{} は {} KB を超えています", at, limit / 1024)
}

#[derive(Serialize, Debug)]
pub struct Summary {
    pub name: String,
    pub files: u64,
    pub bytes: u64,
    /// Milliseconds since the epoch of the newest change seen.
    pub modified: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    /// "dir", "file" or "link".
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Serialize, Debug)]
pub struct Contents {
    /// UTF-8 text, absent for binary files.
    pub text: Option<String>,
    pub size: u64,
    pub truncated: bool,
}

/// Repo names are plain directory names: letters, digits, `.`, `_`, `-`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Whether a path part names a repo's `.git` however it is spelt: git, and
/// the file systems under it, treat `.GIT` (case-insensitive volumes),
/// `.git.` or `.git ` (trailing dots and spaces dropped), `git~1` (the short
/// name) and `.git` with invisible code points (ignored by HFS+) as `.git`
/// itself. Nothing reached through the store may land in it: its config and
/// hooks run commands on the host the next time git runs.
pub fn is_git_name(part: &str) -> bool {
    let visible: String = part.chars()
        .filter(|c| !matches!(*c as u32, 0x200C..=0x200F | 0x202A..=0x202E | 0x206A..=0x206F | 0xFEFF))
        .collect::<String>().to_ascii_lowercase();
    let name = visible.trim_end_matches(['.', ' ']);
    name == ".git" || name == "git~1"
}

fn touches_git(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::Normal(p) if is_git_name(&p.to_string_lossy())))
}

pub struct Repos {
    root: PathBuf,
    /// Whether a repo here is seen through the work it is on (work.rs):
    /// the person's repos on the host are; a Prompt's /root and tests are not.
    lines: bool,
}

impl Repos {
    /// The repos of this person, where the app keeps them.
    pub fn open() -> Result<Repos> {
        let mut r = Repos::new(crate::paths::repos_dir())?;
        r.lines = std::env::var_os("L3_PROMPT").is_none();
        Ok(r)
    }

    pub fn root(&self) -> &Path { &self.root }

    pub fn new(root: PathBuf) -> Result<Repos> {
        // Inside the Prompt the repos are the guest's /root; on the host
        // they are the person's alone.
        if std::env::var_os("L3_PROMPT").is_none() {
            crate::boundary::private_dir(&root).map_err(|e| io_error(root.display(), &e))?;
        } else {
            fs::create_dir_all(&root).map_err(|e| io_error(root.display(), &e))?;
        }
        Ok(Repos { root, lines: false })
    }

    /// The line of work `name` shows now: main, or an issue's (work.rs).
    pub fn line(&self, name: &str) -> String {
        if self.lines { crate::work::current(name) } else { crate::work::MAIN.into() }
    }

    /// Where `name`'s files are now: its own directory (main), or the
    /// worktree of the issue it is being worked on for.
    pub fn place(&self, name: &str) -> Result<PathBuf> {
        let main = self.repo(name)?;
        if !self.lines {
            return Ok(main);
        }
        let line = crate::work::current(name);
        Ok(if line == crate::work::MAIN { main } else { crate::work::worktree(name, &line) })
    }

    fn repo(&self, name: &str) -> Result<PathBuf> {
        if !valid_name(name) {
            return Err(tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", name));
        }
        Ok(self.root.join(name))
    }

    /// The repo's own directory, once its name is checked and it exists.
    pub fn dir(&self, repo: &str) -> Result<PathBuf> {
        if !self.repo(repo)?.is_dir() || !self.place(repo)?.is_dir() {
            return Err(crate::tr!("There is no repo {}", "repo {} はありません", repo));
        }
        self.inside(repo, "")
    }

    /// A path inside `repo`; `..`, absolute paths, symlinks that lead out of
    /// the repo, and anything in its `.git` (by name or through a symlink)
    /// are refused.
    fn inside(&self, repo: &str, relative: &str) -> Result<PathBuf> {
        let base = self.place(repo)?;
        let mut path = base.clone();
        for c in Path::new(relative).components() {
            match c {
                Component::Normal(part) => path.push(part),
                Component::CurDir => {}
                _ => return Err(tr!("{} leaves the repo", "{} は repo の外です", shown(repo, relative))),
            }
        }
        let real = path.canonicalize().map_err(|e| io_error(shown(repo, relative), &e))?;
        let real_base = base.canonicalize().map_err(|e| io_error(repo, &e))?;
        let Ok(within) = real.strip_prefix(&real_base) else {
            return Err(tr!("{} leads outside the repo", "{} は repo の外につながっています", shown(repo, relative)));
        };
        if touches_git(Path::new(relative)) || touches_git(within) {
            return Err(tr!("{} is in the repo's .git", "{} は repo の .git の中です", shown(repo, relative)));
        }
        Ok(real)
    }

    /// Whether `relative` in `repo` is a link to nothing: the link is there, what it names is not.
    pub fn dangling(&self, repo: &str, relative: &str) -> bool {
        let Ok(base) = self.place(repo) else { return false };
        let at = base.join(relative);
        at.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) && at.metadata().is_err()
    }

    pub fn list(&self) -> Result<Vec<Summary>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| io_error(self.root.display(), &e))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_name(&name) || !entry.path().is_dir() {
                continue;
            }
            out.push(self.summary(&name)?);
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub fn summary(&self, name: &str) -> Result<Summary> {
        let dir = self.place(name)?;
        let (mut files, mut bytes, mut modified) = (0, 0, 0);
        // Bounded walk: summaries must stay cheap for large repos.
        let mut stack = vec![dir.clone()];
        let mut budget = 20_000;
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).map_err(|e| io_error(d.display(), &e))?.flatten() {
                budget -= 1;
                if budget == 0 { break; }
                if is_git_name(&e.file_name().to_string_lossy()) { continue; }
                let Ok(meta) = e.metadata() else { continue };
                let time = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                modified = modified.max(time);
                if meta.is_dir() { stack.push(e.path()); } else { files += 1; bytes += meta.len(); }
            }
        }
        Ok(Summary { name: name.to_string(), files, bytes, modified })
    }

    /// Create a repo from a template (shared/templates.json). Inbox and TODO
    /// are the OS's, not the repo's, so templates hold only the repo's own files.
    pub fn create(&self, name: &str, template: &str) -> Result<Summary> {
        let dir = self.repo(name)?;
        if dir.exists() {
            return Err(tr!("There is a repo {} already", "repo {} はもうあります", name));
        }
        let t = templates::find(template).ok_or_else(|| {
            let ids: Vec<String> = templates::all().into_iter().map(|t| t.id).collect();
            tr!("No template {} ({})", "テンプレート {} はありません（{}）", template, ids.join(", "))
        })?;
        fs::create_dir_all(&dir).map_err(|e| io_error(name, &e))?;
        for d in &t.dirs {
            fs::create_dir_all(dir.join(d)).map_err(|e| io_error(shown(name, d), &e))?;
        }
        for (path, text) in t.files_for(name) {
            let target = dir.join(&path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| io_error(shown(name, &path), &e))?;
            }
            fs::write(target, text).map_err(|e| io_error(shown(name, &path), &e))?;
        }
        self.summary(name)
    }

    pub fn tree(&self, repo: &str, relative: &str) -> Result<Vec<Entry>> {
        let dir = self.inside(repo, relative)?;
        if !dir.is_dir() { return Err(tr!("{} is a file, not a folder", "{} はフォルダーではなくファイルです", shown(repo, relative))); }
        let mut out: Vec<Entry> = fs::read_dir(&dir).map_err(|e| io_error(shown(repo, relative), &e))?.flatten()
            .filter(|e| !is_git_name(&e.file_name().to_string_lossy()))
            .filter_map(|e| {
                let meta = e.path().symlink_metadata().ok()?;
                let kind = if meta.file_type().is_symlink() { "link" } else if meta.is_dir() { "dir" } else { "file" };
                Some(Entry { name: e.file_name().to_string_lossy().into_owned(), kind, size: meta.len() })
            })
            .collect();
        // Directories first, then names, like a reader expects.
        out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub fn read(&self, repo: &str, relative: &str, limit: u64) -> Result<Contents> {
        let path = self.inside(repo, relative)?;
        let at = shown(repo, relative);
        let meta = fs::metadata(&path).map_err(|e| io_error(&at, &e))?;
        if meta.is_dir() { return Err(tr!("{} is a folder, not a file", "{} はファイルではなくフォルダーです", at)); }
        let size = meta.len();
        let mut bytes = Vec::new();
        fs::File::open(&path).map_err(|e| io_error(&at, &e))?.take(limit).read_to_end(&mut bytes).map_err(|e| io_error(&at, &e))?;
        let truncated = size > bytes.len() as u64;
        let text = if bytes.contains(&0) { None } else {
            // A cut may split a character; drop the incomplete tail.
            match String::from_utf8(bytes) {
                Ok(t) => Some(t),
                Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                    let valid = e.utf8_error().valid_up_to();
                    Some(String::from_utf8(e.into_bytes()[..valid].to_vec()).unwrap())
                }
                Err(_) => None,
            }
        };
        Ok(Contents { text, size, truncated })
    }
}

impl Repos {
    /// Replace the text of an existing file inside `repo`. New files, directories
    /// and anything over `limit` bytes are refused. The text goes to a temporary
    /// file beside the target first and is renamed over it, so a failed write
    /// never leaves half a file.
    pub fn write(&self, repo: &str, relative: &str, text: &str, limit: u64) -> Result<u64> {
        if text.len() as u64 > limit {
            return Err(too_large(&shown(repo, relative), limit));
        }
        let path = self.inside(repo, relative)?;
        let meta = fs::metadata(&path).map_err(|e| io_error(shown(repo, relative), &e))?;
        if !meta.is_file() {
            return Err(tr!("{} is not a file", "{} はファイルではありません", shown(repo, relative)));
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // `.<name>.length3-<pid>-<n>`: usage.rs recognises it as this OS's own
        // temporary, reclaimable once its writer is gone.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = path.with_file_name(format!(".{name}.length3-{}-{n}", std::process::id()));
        // Made afresh (never through a link or into a file already there).
        let made = fs::OpenOptions::new().write(true).create_new(true).open(&temp);
        let result = made.and_then(|mut f| {
            use std::io::Write;
            f.write_all(text.as_bytes())?;
            f.sync_all()
        })
            .and_then(|_| fs::set_permissions(&temp, meta.permissions()))
            .and_then(|_| fs::rename(&temp, &path));
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::AlreadyExists { let _ = fs::remove_file(&temp); }
            return Err(io_error(shown(repo, relative), &e));
        }
        Ok(text.len() as u64)
    }

    /// Write `relative` in `repo` whole: replace the file there, or, with
    /// `create`, make it new (and the folders on its way). The bytes written,
    /// and whether the file is new.
    pub fn put(&self, repo: &str, relative: &str, text: &str, limit: u64, create: bool) -> Result<(u64, bool)> {
        let rel = relative.trim_matches('/');
        let at = shown(repo, rel);
        if rel.is_empty() {
            return Err(tr!("Name a file in {}: {}/PATH", "{} の中のファイルを書いてください：{}/PATH", repo, repo));
        }
        if fs::symlink_metadata(self.place(repo)?.join(rel)).is_ok() {
            return self.write(repo, rel, text, limit).map(|n| (n, false));
        }
        if !create {
            return Err(tr!("There is no {}", "{} はありません", at));
        }
        let (dir, name) = rel.rsplit_once('/').unwrap_or(("", rel));
        if name == "." || name == ".." || is_git_name(name) {
            return Err(tr!("{:?} cannot name a new file", "{:?} は新しいファイルの名前になりません", name));
        }
        if text.len() as u64 > limit {
            return Err(too_large(&at, limit));
        }
        if !dir.is_empty() { self.mkdir(repo, dir)?; }
        let parent = self.inside(repo, dir)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(parent.join(name)).map_err(|e| io_error(&at, &e))?;
        file.write_all(text.as_bytes()).map_err(|e| io_error(&at, &e))?;
        Ok((text.len() as u64, true))
    }
}

impl Repos {
    /// The file in `repo`'s issue/ that `which` names: its number ("3",
    /// "003") or its file ("003.md", "issue/003.md").
    pub fn issue_file(&self, repo: &str, which: &str) -> Result<String> {
        self.dir(repo)?;
        let names: Vec<String> = self.tree(repo, "issue").map(|l| l.into_iter().filter(|e| e.kind == "file").map(|e| e.name).collect()).unwrap_or_default();
        let which = which.trim_start_matches('#').trim_start_matches("issue/");
        let digits = !which.is_empty() && which.trim_end_matches(".md").bytes().all(|b| b.is_ascii_digit());
        let called = if digits { format!("#{}", which.trim_end_matches(".md").trim_start_matches('0').max("0")) } else { which.to_string() };
        names.into_iter().find(|n| issues::named_by(n, which))
            .ok_or_else(|| tr!("{} has no issue {}", "{} に Issue {} はありません", repo, called))
    }

    /// Make a new file `name` in the existing directory `dir` of `repo`. An
    /// existing file is never replaced, and the name is one plain path part.
    pub fn add(&self, repo: &str, dir: &str, name: &str, text: &str, limit: u64) -> Result<u64> {
        if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') || is_git_name(name) {
            return Err(tr!("{:?} cannot name a new file", "{:?} は新しいファイルの名前になりません", name));
        }
        let at = shown(repo, &format!("{dir}/{name}"));
        if text.len() as u64 > limit {
            return Err(too_large(&at, limit));
        }
        let parent = self.inside(repo, dir)?;
        if !fs::metadata(&parent).map_err(|e| io_error(shown(repo, dir), &e))?.is_dir() {
            return Err(tr!("{} is not a folder", "{} はフォルダーではありません", shown(repo, dir)));
        }
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(parent.join(name))
            .map_err(|e| io_error(&at, &e))?;
        file.write_all(text.as_bytes()).map_err(|e| io_error(&at, &e))?;
        Ok(text.len() as u64)
    }
}

impl Repos {
    /// Make a directory (and its parents) inside `repo`. Nothing outside the
    /// repo can be reached: each part is a plain name.
    pub fn mkdir(&self, repo: &str, relative: &str) -> Result<()> {
        let base = self.inside(repo, "")?;
        let mut path = base.clone();
        for c in Path::new(relative).components() {
            match c {
                Component::Normal(part) if is_git_name(&part.to_string_lossy()) => return Err(tr!("{} is in the repo's .git", "{} は repo の .git の中です", shown(repo, relative))),
                Component::Normal(part) => path.push(part),
                Component::CurDir => {}
                _ => return Err(tr!("{} leaves the repo", "{} は repo の外です", shown(repo, relative))),
            }
            match fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => return Err(tr!("A file is in the way of {}", "{} の途中にファイルがあります", shown(repo, relative))),
                Err(_) => fs::create_dir(&path).map_err(|e| io_error(shown(repo, relative), &e))?,
            }
        }
        Ok(())
    }

    /// Remove a file, or a directory with everything in it, inside `repo`.
    /// The repo itself and its .git are never removed this way.
    pub fn remove(&self, repo: &str, relative: &str) -> Result<()> {
        let base = self.inside(repo, "")?;
        let rel = Path::new(relative);
        // A link is removed itself, never what it names; its folder must be
        // inside the repo like anything else.
        if let (Some(parent), Some(name)) = (rel.parent(), rel.file_name()) {
            let named = self.inside(repo, &parent.to_string_lossy())?.join(name);
            if !touches_git(rel) && fs::symlink_metadata(&named).is_ok_and(|m| m.file_type().is_symlink()) {
                return fs::remove_file(&named).map_err(|e| io_error(shown(repo, relative), &e));
            }
        }
        let path = self.inside(repo, relative)?;
        if path == base {
            return Err(tr!("The repo itself is not removed this way", "repo そのものはこの方法では消せません"));
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| io_error(shown(repo, relative), &e))?;
        if meta.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) }.map_err(|e| io_error(shown(repo, relative), &e))
    }

    /// The repo's issues by number, the newest first (one still without a
    /// number is newer); none when it has no issue/ yet.
    pub fn issues(&self, repo: &str) -> Result<Vec<issues::Issue>> {
        self.dir(repo)?;
        let Ok(entries) = self.tree(repo, "issue") else { return Ok(Vec::new()) };
        let mut out = Vec::new();
        for e in entries.into_iter().filter(|e| e.kind == "file") {
            // Gone between the listing and the reading, or not text: it is no issue.
            if let Ok(Contents { text: Some(text), .. }) = self.read(repo, &format!("issue/{}", e.name), 256 * 1024) {
                out.push(issues::parse(repo, &e.name, &text));
            }
        }
        issues::sort(&mut out);
        Ok(out)
    }

    /// Write a new issue: it takes the next number (issue/ is made for the first). Its file.
    pub fn add_issue(&self, repo: &str, kind: Option<&str>, title: &str, detail: &str) -> Result<String> {
        if title.trim().is_empty() {
            return Err(tr!("An issue needs a title", "Issue には件名がいります"));
        }
        self.dir(repo)?;
        let names: Vec<String> = match self.tree(repo, "issue") {
            Ok(list) => list.into_iter().map(|e| e.name).collect(),
            Err(_) => { self.mkdir(repo, "issue")?; Vec::new() }
        };
        let name = issues::next_name(&names);
        self.add(repo, "issue", &name, &issues::text(kind, title, detail), 256 * 1024)?;
        Ok(name)
    }

    /// Give each issue without a number the next free one (issues::numbering),
    /// by renaming its file; one a work or change refers to (`in_use`,
    /// "issue/<file>") keeps its name. What was renamed, (old, new).
    pub fn number_issues(&self, repo: &str, in_use: &[String]) -> Result<Vec<(String, String)>> {
        let plan = issues::numbering(&self.issues(repo)?, in_use);
        let mut done = Vec::new();
        for (old, new) in plan {
            let Ok(Contents { text: Some(text), .. }) = self.read(repo, &format!("issue/{old}"), 256 * 1024) else { continue };
            self.add(repo, "issue", &new, &text, 256 * 1024)?;
            self.remove(repo, &format!("issue/{old}"))?;
            done.push((old, new));
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> Repos {
        let root = std::env::temp_dir().join(format!("length3-repos-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        Repos::new(root).unwrap()
    }

    #[test]
    fn names_are_plain() {
        assert!(valid_name("my-repo_1.0"));
        for bad in ["", ".git", "a/b", "..", "a b", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn templates_hold_only_repo_files() {
        let r = scratch("tpl");
        for t in ["empty", "standard", "c"] {
            r.create(t, t).unwrap();
            let names: Vec<String> = r.tree(t, "").unwrap().into_iter().map(|e| e.name).collect();
            assert!(names.contains(&"README.md".into()), "{t}: {names:?}");
            assert!(!names.iter().any(|n| n == "inbox.md" || n == "TODO.md"), "{t}: {names:?}");
        }
        let c: Vec<String> = r.tree("c", "").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(c[..3], ["docs", "issue", "src"]);
        assert!(r.create("c", "c").is_err());
        assert!(r.create("x", "nope").is_err());
        assert_eq!(r.list().unwrap().len(), 3);
    }

    #[test]
    fn paths_stay_inside_the_repo() {
        let r = scratch("paths");
        r.create("a", "standard").unwrap();
        r.create("b", "standard").unwrap();
        assert!(r.read("a", "../b/README.md", 100).is_err());
        assert!(r.read("a", "/etc/passwd", 100).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(r.root.join("b"), r.root.join("a/escape")).unwrap();
            assert!(r.read("a", "escape/README.md", 100).is_err());
        }
        assert_eq!(r.read("a", "README.md", 100).unwrap().text.as_deref(), Some("# a\n"));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_nothing_is_known_from_a_file_that_is_not_there() {
        let r = scratch("dangling");
        r.create("a", "standard").unwrap();
        std::os::unix::fs::symlink("nowhere", r.root.join("a/dangling")).unwrap();
        std::os::unix::fs::symlink("README.md", r.root.join("a/readme")).unwrap();
        assert!(r.dangling("a", "dangling"));
        // What reading it says is "there is no" (l3 says it with 4, as for anything not there).
        assert!(r.read("a", "dangling", 100).is_err());
        for not in ["readme", "README.md", "missing", "missing/deeper"] { assert!(!r.dangling("a", not), "{not}"); }
        assert!(!r.dangling("nope", "dangling"));
    }

    #[test]
    fn writes_replace_existing_files_inside_the_repo_only() {
        let r = scratch("write");
        r.create("a", "c").unwrap();
        r.create("b", "empty").unwrap();
        assert_eq!(r.write("a", "src/main.c", "int main;\n", 100).unwrap(), 10);
        assert_eq!(r.read("a", "src/main.c", 100).unwrap().text.as_deref(), Some("int main;\n"));
        assert!(r.write("a", "new.txt", "x", 100).is_err());
        assert!(r.write("a", "src", "x", 100).is_err());
        assert!(r.write("a", "../b/README.md", "x", 100).is_err());
        assert!(r.write("a", "README.md", &"x".repeat(101), 100).is_err());
        let names: Vec<String> = r.tree("a", "src").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["main.c"]);
        assert_eq!(r.read("b", "README.md", 100).unwrap().text.as_deref(), Some("# b\n"));
    }

    #[test]
    fn put_replaces_or_makes_a_file_and_names_the_path_when_it_cannot() {
        let r = scratch("put");
        r.create("a", "standard").unwrap();
        assert_eq!(r.put("a", "README.md", "x\n", 100, false).unwrap(), (2, false));
        assert!(r.put("a", "new/deep.txt", "y", 100, false).unwrap_err().contains("a/new/deep.txt"));
        assert_eq!(r.put("a", "new/deep.txt", "y", 100, true).unwrap(), (1, true));
        assert_eq!(r.put("a", ".gitignore", "target\n", 100, true).unwrap(), (7, true));
        assert_eq!(r.read("a", "new/deep.txt", 100).unwrap().text.as_deref(), Some("y"));
        assert!(r.put("a", ".git/config", "x", 100, true).is_err());
        assert!(r.put("a", "../b/x", "x", 100, true).is_err());
        assert!(r.put("a", "", "x", 100, true).is_err());
        assert!(r.read("a", "nope.txt", 10).unwrap_err().contains("a/nope.txt"));
        assert!(r.tree("a", "README.md").unwrap_err().contains("a/README.md"));
    }

    #[test]
    fn issues_without_a_number_are_given_one_by_renaming_their_files() {
        let r = scratch("number");
        r.create("a", "standard").unwrap();
        r.add_issue("a", Some("Fix"), "one", "").unwrap();
        r.add("a", "issue", "notes.md", "Docs：notes\n", 100).unwrap();
        r.add("a", "issue", "002 (other device).md", "Fix：theirs\n", 100).unwrap();
        r.add("a", "issue", "worked.md", "Fix：held by a work\n", 100).unwrap();
        let done = r.number_issues("a", &["issue/worked.md".to_string()]).unwrap();
        assert_eq!(done, [("002 (other device).md".to_string(), "002.md".to_string()), ("notes.md".into(), "003.md".into())]);
        let list = r.issues("a").unwrap();
        assert_eq!(list.iter().map(|i| (i.n, i.title.as_str())).collect::<Vec<_>>(), [(None, "held by a work"), (Some(3), "notes"), (Some(2), "theirs"), (Some(1), "one")]);
        assert!(r.number_issues("a", &["issue/worked.md".to_string()]).unwrap().is_empty());
        assert_eq!(r.add_issue("a", None, "next", "").unwrap(), "004.md");
    }

    #[test]
    fn an_issue_is_found_by_its_number_or_file() {
        let r = scratch("issue-file");
        r.create("a", "standard").unwrap();
        r.add_issue("a", None, "one", "").unwrap();
        assert_eq!(r.issue_file("a", "1").unwrap(), "001.md");
        assert_eq!(r.issue_file("a", "#001").unwrap(), "001.md");
        assert_eq!(r.issue_file("a", "issue/001.md").unwrap(), "001.md");
        assert!(r.issue_file("a", "2").unwrap_err().contains("#2"));
        assert!(r.issue_file("nope", "1").is_err());
        r.create("e", "empty").unwrap();
        assert!(r.issue_file("e", "1").unwrap_err().contains("#1"));
    }

    #[test]
    fn new_files_go_into_existing_directories_and_never_replace() {
        let r = scratch("add");
        r.create("a", "standard").unwrap();
        assert_eq!(r.add("a", "issue", "001.md", "Fix：x\n", 100).unwrap(), 8);
        assert_eq!(r.read("a", "issue/001.md", 100).unwrap().text.as_deref(), Some("Fix：x\n"));
        assert!(r.add("a", "issue", "001.md", "again", 100).is_err());
        assert!(r.add("a", "missing", "x.md", "x", 100).is_err());
        assert!(r.add("a", "issue", "../x.md", "x", 100).is_err());
        assert!(r.add("a", "issue", ".hidden", "x", 100).is_err());
        assert!(r.add("a", "../b", "x.md", "x", 100).is_err());
        assert!(r.add("a", "README.md", "x.md", "x", 100).is_err());
    }

    #[test]
    fn directories_are_made_and_removed_inside_the_repo_only() {
        let r = scratch("tree-ops");
        r.create("a", "standard").unwrap();
        r.mkdir("a", "src/deep").unwrap();
        assert!(r.root.join("a/src/deep").is_dir());
        assert!(r.mkdir("a", "../b").is_err());
        assert!(r.mkdir("a", "README.md/x").is_err());
        r.remove("a", "src").unwrap();
        assert!(!r.root.join("a/src").exists());
        assert!(r.remove("a", "").is_err());
        assert!(r.remove("a", ".git").is_err());
        assert!(r.remove("a", "../a").is_err());
        assert!(r.root.join("a/README.md").exists());
    }

    #[test]
    fn nothing_reaches_the_repos_git() {
        // What the Prompt writes back goes through here: a guest must not be
        // able to plant git config or hooks, which run on the host.
        let r = scratch("dotgit");
        r.create("a", "standard").unwrap();
        let git = r.root.join("a/.git");
        fs::create_dir_all(git.join("hooks")).unwrap();
        fs::write(git.join("config"), "[core]\n").unwrap();
        for name in [".git", ".GIT", ".Git.", ".git ", "git~1", "GIT~1", ".g\u{200c}it"] {
            assert!(is_git_name(name), "{name}");
        }
        for name in ["git", ".github", ".gitignore", "x.git"] {
            assert!(!is_git_name(name), "{name}");
        }
        assert!(r.write("a", ".git/config", "[core]\n\tfsmonitor = evil\n", 1024).is_err());
        assert!(r.add("a", ".git/hooks", "pre-commit", "#!/bin/sh\n", 1024).is_err());
        assert!(r.add("a", ".git", "config2", "x", 1024).is_err());
        // Said as what it is (bug: "leaves the repo").
        assert!(r.mkdir("a", ".git/hooks/x").is_err_and(|e| e.contains(".git") && !e.contains("leaves")));
        assert!(r.mkdir("a", ".GIT/x").is_err());
        assert!(r.read("a", ".git/config", 1024).is_err());
        assert!(r.tree("a", ".git").is_err());
        assert!(r.remove("a", ".git/config").is_err());
        assert!(r.add("a", "", "git~1", "x", 1024).is_err());
        // Through a link the repo itself carries.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(".git", r.root.join("a/g")).unwrap();
            assert!(r.write("a", "g/config", "x", 1024).is_err());
            assert!(r.add("a", "g/hooks", "pre-commit", "x", 1024).is_err());
            r.remove("a", "g").unwrap();
            assert!(git.join("config").exists(), "removing the link leaves .git");
        }
        assert_eq!(fs::read_to_string(git.join("config")).unwrap(), "[core]\n");
        assert!(!git.join("hooks/pre-commit").exists());
        assert!(r.tree("a", "").unwrap().iter().all(|e| e.name != ".git"));
    }

    #[test]
    fn issues_are_numbered_files_read_back_newest_first() {
        let r = scratch("issues");
        r.create("a", "standard").unwrap();
        assert_eq!(r.add_issue("a", Some("Fix"), "壊れる", "手順").unwrap(), "001.md");
        assert_eq!(r.add_issue("a", None, "メモ", "").unwrap(), "002.md");
        let list = r.issues("a").unwrap();
        assert_eq!(list.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["メモ", "壊れる"]);
        assert_eq!(list[1].kind.as_deref(), Some("Fix"));
        // Any repo takes an issue: issue/ is made for the first.
        r.create("e", "empty").unwrap();
        assert!(r.issues("e").unwrap().is_empty());
        assert_eq!(r.add_issue("e", None, "x", "").unwrap(), "001.md");
        assert_eq!(r.issues("e").unwrap()[0].n, Some(1));
        assert!(r.add_issue("a", None, "  ", "").is_err());
    }

    #[test]
    fn reads_are_bounded_and_binary_is_not_text() {
        let r = scratch("read");
        r.create("a", "empty").unwrap();
        fs::write(r.root.join("a/big.txt"), "あ".repeat(10)).unwrap();
        let c = r.read("a", "big.txt", 7).unwrap();
        assert!(c.truncated && c.text.as_deref() == Some("ああ") && c.size == 30);
        fs::write(r.root.join("a/bin"), [1u8, 0, 2]).unwrap();
        assert!(r.read("a", "bin", 10).unwrap().text.is_none());
    }
}

#[cfg(test)]
mod shared_cases {
    //! The cases in shared/cases.json, which the app's tests read too.
    use crate::{issues, text};
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../shared/cases.json")).unwrap()
    }
    fn opt(v: &Value) -> Option<String> { v.as_str().map(String::from) }

    #[test]
    fn kinds_issues_and_names_agree_with_the_app() {
        let c = cases();
        for k in c["kind"].as_array().unwrap() {
            let (kind, title) = text::kind_of(k[0].as_str().unwrap());
            assert_eq!((kind, title), (opt(&k[1]), k[2].as_str().unwrap().to_string()), "{k}");
        }
        for k in c["issue"].as_array().unwrap() {
            let i = issues::parse("r", "x.md", k[0].as_str().unwrap());
            assert_eq!((i.kind, i.title, i.detail), (opt(&k[1]), k[2].as_str().unwrap().into(), k[3].as_str().unwrap().into()), "{k}");
        }
        for k in c["issueText"].as_array().unwrap() {
            let t = issues::text(k[0].as_str(), k[1].as_str().unwrap(), k[2].as_str().unwrap());
            assert_eq!(t, k[3].as_str().unwrap(), "{k}");
        }
        for k in c["nextIssue"].as_array().unwrap() {
            let names: Vec<&str> = k[0].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(issues::next_name(&names), k[1].as_str().unwrap(), "{k}");
        }
        for k in c["validName"].as_array().unwrap() {
            assert_eq!(super::valid_name(k[0].as_str().unwrap()), k[1].as_bool().unwrap(), "{k}");
        }
        for k in c["gitName"].as_array().unwrap() {
            assert_eq!(super::is_git_name(k[0].as_str().unwrap()), k[1].as_bool().unwrap(), "{k}");
        }
    }
}
