//! Repos the app manages, under its own data directory. Every path from the
//! webview is checked to stay inside one repo, after following symlinks.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};


pub use crate::Result;
use crate::{repos::issues, repos::templates, tr};
use crate::text::i18n::io_error;
use crate::text::names::{is_git_name, valid_name};

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
    /// As last counted in this process, so possibly older than now: the page asks for it counted afresh.
    pub kept: bool,
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

/// Where a repo's issues are kept, at its top (repos/issues.rs). It is the OS's to keep: the issues are met as issues
/// (Git, the box, root3 issue), never among the files File, Forge and root3 file show; the Prompt's copy still has them.
pub const ISSUES: &str = "issue";

/// Whether `rel` (a path in a repo) is its issues' folder or in it.
pub fn is_issues(rel: &str) -> bool {
    let rel = rel.trim_matches('/');
    rel == ISSUES || rel.strip_prefix(ISSUES).is_some_and(|r| r.starts_with('/'))
}

fn touches_git(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::Normal(p) if is_git_name(&p.to_string_lossy())))
}

pub struct Repos {
    root: PathBuf,
    /// Whether a repo here is seen through the work it is on (history/work.rs):
    /// the person's repos on the host are; a Prompt's /root and tests are not.
    lines: bool,
}

impl Repos {
    /// The repos of this person, where the app keeps them.
    pub fn open() -> Result<Repos> {
        let mut r = Repos::new(crate::fs::paths::repos_dir().to_path_buf())?;
        r.lines = std::env::var_os("ROOT3_PROMPT").is_none();
        Ok(r)
    }

    pub fn root(&self) -> &Path { &self.root }

    /// The same repos seen on main, whatever work each shows now: an issue is main's (its file is read, written and
    /// committed there), so it is the same issue from the work on it as from anywhere else.
    pub fn on_main(&self) -> Repos { Repos { root: self.root.clone(), lines: false } }

    pub fn new(root: PathBuf) -> Result<Repos> {
        // Inside the Prompt the repos are the guest's /root; on the host
        // they are the person's alone.
        if std::env::var_os("ROOT3_PROMPT").is_none() {
            crate::fs::write::private_dir(&root).map_err(|e| io_error(root.display(), &e))?;
        } else {
            fs::create_dir_all(&root).map_err(|e| io_error(root.display(), &e))?;
        }
        Ok(Repos { root, lines: false })
    }

    /// The line of work `name` shows now: main, or an issue's (history/work.rs).
    pub fn line(&self, name: &str) -> String {
        if self.lines { crate::repos::lines::current(name) } else { crate::repos::lines::MAIN.into() }
    }

    /// Where `name`'s files are now: its own directory (main), or the
    /// worktree of the issue it is being worked on for.
    pub fn place(&self, name: &str) -> Result<PathBuf> {
        let main = self.repo(name)?;
        if !self.lines {
            return Ok(main);
        }
        let line = crate::repos::lines::current(name);
        Ok(if line == crate::repos::lines::MAIN { main } else { crate::repos::lines::worktree(name, &line) })
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

    /// The repos' names, in order, and nothing else: no repo is walked (list walks each to say its size).
    pub fn names(&self) -> Result<Vec<String>> {
        let mut out: Vec<String> = fs::read_dir(&self.root).map_err(|e| io_error(self.root.display(), &e))?.flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| valid_name(n) && self.root.join(n).is_dir())
            .collect();
        out.sort();
        Ok(out)
    }

    /// Each repo as its card says it, as last counted (repos/measure.rs); `fresh`: counted now.
    pub fn list(&self, fresh: bool) -> Result<Vec<Summary>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| io_error(self.root.display(), &e))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !valid_name(&name) || !entry.path().is_dir() {
                continue;
            }
            out.push(self.summary_of(&name, fresh)?);
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    /// The repo `name` as its card says it now: its own files, their bytes, and when they last changed (measure.rs).
    pub fn summary(&self, name: &str) -> Result<Summary> {
        self.summary_of(name, true)
    }

    fn summary_of(&self, name: &str, fresh: bool) -> Result<Summary> {
        let (m, kept) = super::measure::measured(&self.place(name)?, fresh);
        Ok(Summary { name: name.to_string(), files: m.files, bytes: m.bytes, modified: m.modified, kept })
    }

    /// Create a repo from a template (src/shared/templates.json). Inbox and TODO
    /// are the OS's, not the repo's, so templates hold only the repo's own files.
    /// The repo is made aside, under a name no repo has (a dot first), and moved into place whole, never
    /// over one there (bug: it was made in place, so a failure or crash part way left half a repo that
    /// `repo new` then refused as there already, and two makes at once wrote into one).
    pub fn create(&self, name: &str, template: &str) -> Result<Summary> {
        let dir = self.repo(name)?;
        let there = || tr!("There is a repo {} already", "repo {} はもうあります", name);
        if dir.symlink_metadata().is_ok() {
            return Err(there());
        }
        let t = templates::find(template).ok_or_else(|| {
            let ids: Vec<String> = templates::all().into_iter().map(|t| t.id).collect();
            tr!("No template {} ({})", "テンプレート {} はありません（{}）", template, ids.join(", "))
        })?;
        let aside = self.root.join(format!(".{name}.length3-{}-0", crate::pid()));
        let _ = fs::remove_dir_all(&aside);
        let fill = || -> Result<()> {
            fs::create_dir(&aside).map_err(|e| io_error(name, &e))?;
            for d in &t.dirs {
                fs::create_dir_all(aside.join(d)).map_err(|e| io_error(shown(name, d), &e))?;
            }
            for (path, text) in t.files_for(name) {
                let target = aside.join(&path);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| io_error(shown(name, &path), &e))?;
                }
                fs::write(target, text).map_err(|e| io_error(shown(name, &path), &e))?;
            }
            crate::fs::write::rename_new(&aside, &dir).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { there() } else { io_error(name, &e) })
        };
        if let Err(e) = fill() {
            let _ = fs::remove_dir_all(&aside);
            return Err(e);
        }
        self.summary(name)
    }

    pub fn tree(&self, repo: &str, relative: &str) -> Result<Vec<Entry>> {
        let dir = self.inside(repo, relative)?;
        if !dir.is_dir() { return Err(tr!("{} is a file, not a folder", "{} はフォルダーではなくファイルです", shown(repo, relative))); }
        // Each entry looked at from its folder (not by its whole path again), and only a file's size asked for.
        let mut out: Vec<Entry> = fs::read_dir(&dir).map_err(|e| io_error(shown(repo, relative), &e))?.flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if is_git_name(&name) { return None; }
                let meta = e.metadata().ok()?;
                let kind = if meta.file_type().is_symlink() { "link" } else if meta.is_dir() { "dir" } else { "file" };
                Some(Entry { name, kind, size: meta.len() })
            })
            .collect();
        // Directories first, then names, like a reader expects.
        out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    /// A file in `repo` to read: its path and size, once it is known to be a file. A folder is refused, and so is
    /// anything else that is not a file (a pipe, a socket, a device), before it is opened: opening a pipe waits for
    /// whoever writes into it, which may be never.
    fn readable(&self, repo: &str, relative: &str) -> Result<(PathBuf, u64, String)> {
        let path = self.inside(repo, relative)?;
        let at = shown(repo, relative);
        let meta = fs::metadata(&path).map_err(|e| io_error(&at, &e))?;
        if meta.is_dir() { return Err(tr!("{} is a folder, not a file", "{} はファイルではなくフォルダーです", at)); }
        if !meta.is_file() { return Err(tr!("{} is not a file", "{} はファイルではありません", at)); }
        Ok((path, meta.len(), at))
    }

    pub fn read(&self, repo: &str, relative: &str, limit: u64) -> Result<Contents> {
        let (path, size, at) = self.readable(repo, relative)?;
        // Room for all of it first, so it comes in one read (and one more that finds the end), not a read for each
        // doubling of a buffer.
        let mut bytes = Vec::with_capacity(size.min(limit) as usize);
        fs::File::open(&path).map_err(|e| io_error(&at, &e))?.take(limit).read_to_end(&mut bytes).map_err(|e| io_error(&at, &e))?;
        let truncated = size > bytes.len() as u64;
        let text = if bytes.contains(&0) { None } else {
            // A cut may split a character; drop the incomplete tail.
            match String::from_utf8(bytes) {
                Ok(t) => Some(t),
                Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                    let valid = e.utf8_error().valid_up_to();
                    let mut bytes = e.into_bytes();
                    bytes.truncate(valid);
                    String::from_utf8(bytes).ok()
                }
                Err(_) => None,
            }
        };
        Ok(Contents { text, size, truncated })
    }

    /// A file's bytes whole, whatever it holds (a Prompt's copy of the repo); one over `limit` is refused.
    pub fn bytes(&self, repo: &str, relative: &str, limit: u64) -> Result<Vec<u8>> {
        let (path, size, at) = self.readable(repo, relative)?;
        if size > limit { return Err(too_large(&at, limit)); }
        fs::read(&path).map_err(|e| io_error(&at, &e))
    }
}

impl Repos {
    /// Replace the text of an existing file inside `repo`. New files, directories
    /// and anything over `limit` bytes are refused. The text goes to a temporary
    /// file beside the target first and is renamed over it, so a failed write
    /// never leaves half a file.
    pub fn write(&self, repo: &str, relative: &str, text: &str, limit: u64) -> Result<u64> {
        self.write_bytes(repo, relative, text.as_bytes(), limit)
    }

    fn write_bytes(&self, repo: &str, relative: &str, text: &[u8], limit: u64) -> Result<u64> {
        if text.len() as u64 > limit {
            return Err(too_large(&shown(repo, relative), limit));
        }
        let path = self.inside(repo, relative)?;
        let meta = fs::metadata(&path).map_err(|e| io_error(shown(repo, relative), &e))?;
        if !meta.is_file() {
            return Err(tr!("{} is not a file", "{} はファイルではありません", shown(repo, relative)));
        }
        // The file keeps its permissions (a script stays executable).
        #[cfg(unix)]
        let mode = { use std::os::unix::fs::PermissionsExt; Some(meta.permissions().mode() & 0o7777) };
        #[cfg(not(unix))]
        let mode = None;
        crate::fs::write::replace(&path, text, crate::fs::write::How { mode, durable: true })
            .map_err(|e| io_error(shown(repo, relative), &e))?;
        Ok(text.len() as u64)
    }

    /// Write `relative` in `repo` whole: replace the file there, or, with
    /// `create`, make it new (and the folders on its way). The bytes written,
    /// and whether the file is new. Any bytes: what a Prompt made is not only text.
    pub fn put(&self, repo: &str, relative: &str, text: impl AsRef<[u8]>, limit: u64, create: bool) -> Result<(u64, bool)> {
        let text = text.as_ref();
        let rel = relative.trim_matches('/');
        let at = shown(repo, rel);
        if rel.is_empty() {
            return Err(tr!("Name a file in {}: {}/PATH", "{} の中のファイルを書いてください：{}/PATH", repo, repo));
        }
        if fs::symlink_metadata(self.place(repo)?.join(rel)).is_ok() {
            return self.write_bytes(repo, rel, text, limit).map(|n| (n, false));
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
        file.write_all(text).map_err(|e| io_error(&at, &e))?;
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

    /// Give a file or folder of `repo` a new name, or a new place in it: `to` is
    /// its path from the repo's top (`notes/plan.md`), each part a plain name
    /// as a new file's, and the folders on its way are made. What is there
    /// already is never replaced, a folder never goes inside itself, and the
    /// repo itself and its .git are never moved. A link is moved itself,
    /// never what it names.
    pub fn move_to(&self, repo: &str, relative: &str, to: &str) -> Result<()> {
        let to = to.trim_matches('/');
        if to.split('/').any(|p| p.is_empty() || p.starts_with('.') || p.contains('\\') || is_git_name(p)) {
            return Err(tr!("{:?} cannot name a file", "{:?} はファイルの名前になりません", to));
        }
        let rel = Path::new(relative.trim_end_matches('/'));
        let (Some(parent), Some(file)) = (rel.parent(), rel.file_name()) else {
            return Err(tr!("The repo itself is not renamed this way", "repo そのものはこの方法では名前を変えられません"));
        };
        if touches_git(rel) || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            return Err(tr!("{} leaves the repo", "{} は repo の外です", shown(repo, relative)));
        }
        let from = self.inside(repo, &parent.to_string_lossy())?.join(file);
        fs::symlink_metadata(&from).map_err(|e| io_error(shown(repo, relative), &e))?;
        if Path::new(to) == rel { return Ok(()); }
        if Path::new(to).starts_with(rel) {
            return Err(tr!("{} cannot go inside itself", "{} はそれ自身の中には移せません", shown(repo, relative)));
        }
        let (dir, name) = to.rsplit_once('/').unwrap_or(("", to));
        if !dir.is_empty() { self.mkdir(repo, dir)?; }
        let target = self.inside(repo, dir)?.join(name);
        let at = shown(repo, to);
        // A name that differs only in case is the same file on some disks: that one is renamed, not refused.
        let same = fs::symlink_metadata(&target).is_ok() && from.canonicalize().ok() == target.canonicalize().ok()
            && !fs::symlink_metadata(&from).is_ok_and(|m| m.file_type().is_symlink());
        if fs::symlink_metadata(&target).is_ok() && !same {
            return Err(tr!("{} is there already", "{} はもうあります", at));
        }
        fs::rename(&from, &target).map_err(|e| io_error(&at, &e))
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
#[path = "tests/store.rs"]
mod tests;
