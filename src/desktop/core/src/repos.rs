//! Repos the app manages, under its own data directory. Every path from the
//! webview is checked to stay inside one repo, after following symlinks.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

pub use crate::Result;
use crate::{issues, templates};

#[derive(Serialize, Debug)]
pub struct Summary {
    pub name: String,
    pub files: u64,
    pub bytes: u64,
    /// Milliseconds since the epoch of the newest change seen.
    pub modified: u64,
    pub git: bool,
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
}

impl Repos {
    /// The repos of this person, where the app keeps them.
    pub fn open() -> Result<Repos> {
        Repos::new(crate::paths::repos_dir())
    }

    pub fn root(&self) -> &Path { &self.root }

    pub fn new(root: PathBuf) -> Result<Repos> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Repos { root })
    }

    fn repo(&self, name: &str) -> Result<PathBuf> {
        if !valid_name(name) {
            return Err(format!("invalid repo name {name:?}"));
        }
        Ok(self.root.join(name))
    }

    /// The repo's own directory, once its name is checked and it exists.
    pub fn dir(&self, repo: &str) -> Result<PathBuf> {
        if !self.repo(repo)?.is_dir() {
            return Err(format!("repo {repo} はありません"));
        }
        self.inside(repo, "")
    }

    /// A path inside `repo`; `..`, absolute paths, symlinks that lead out of
    /// the repo, and anything in its `.git` (by name or through a symlink)
    /// are refused.
    fn inside(&self, repo: &str, relative: &str) -> Result<PathBuf> {
        let base = self.repo(repo)?;
        let mut path = base.clone();
        for c in Path::new(relative).components() {
            match c {
                Component::Normal(part) => path.push(part),
                Component::CurDir => {}
                _ => return Err(format!("path {relative:?} leaves the repo")),
            }
        }
        let real = path.canonicalize().map_err(|e| e.to_string())?;
        let real_base = base.canonicalize().map_err(|e| e.to_string())?;
        let Ok(within) = real.strip_prefix(&real_base) else {
            return Err(format!("path {relative:?} leads outside the repo"));
        };
        if touches_git(Path::new(relative)) || touches_git(within) {
            return Err(format!("path {relative:?} is in the repo's .git"));
        }
        Ok(real)
    }

    pub fn list(&self) -> Result<Vec<Summary>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())?.flatten() {
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
        let dir = self.repo(name)?;
        let (mut files, mut bytes, mut modified) = (0, 0, 0);
        // Bounded walk: summaries must stay cheap for large repos.
        let mut stack = vec![dir.clone()];
        let mut budget = 20_000;
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
                budget -= 1;
                if budget == 0 { break; }
                if is_git_name(&e.file_name().to_string_lossy()) { continue; }
                let Ok(meta) = e.metadata() else { continue };
                let time = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                modified = modified.max(time);
                if meta.is_dir() { stack.push(e.path()); } else { files += 1; bytes += meta.len(); }
            }
        }
        Ok(Summary { name: name.to_string(), files, bytes, modified, git: dir.join(".git").is_dir() })
    }

    /// Create a repo from a template (shared/templates.json). Inbox and TODO
    /// are the OS's, not the repo's, so templates hold only the repo's own files.
    pub fn create(&self, name: &str, template: &str) -> Result<Summary> {
        let dir = self.repo(name)?;
        if dir.exists() {
            return Err(format!("repo {name} already exists"));
        }
        let t = templates::find(template).ok_or_else(|| format!("unknown template {template:?}"))?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for d in &t.dirs {
            fs::create_dir_all(dir.join(d)).map_err(|e| e.to_string())?;
        }
        for (path, text) in t.files_for(name) {
            let target = dir.join(&path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(target, text).map_err(|e| e.to_string())?;
        }
        init_git(&dir);
        self.summary(name)
    }

    pub fn tree(&self, repo: &str, relative: &str) -> Result<Vec<Entry>> {
        let dir = self.inside(repo, relative)?;
        let mut out: Vec<Entry> = fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten()
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
        let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let mut bytes = Vec::new();
        fs::File::open(&path).map_err(|e| e.to_string())?.take(limit).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
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
            return Err(format!("{relative:?} is larger than {limit} bytes"));
        }
        let path = self.inside(repo, relative)?;
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(format!("{relative:?} is not a file"));
        }
        let name = path.file_name().ok_or("no file name")?.to_string_lossy().into_owned();
        let temp = path.with_file_name(format!(".{name}.length3-{}", std::process::id()));
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
            return Err(e.to_string());
        }
        Ok(text.len() as u64)
    }
}

impl Repos {
    /// Make a new file `name` in the existing directory `dir` of `repo`. An
    /// existing file is never replaced, and the name is one plain path part.
    pub fn add(&self, repo: &str, dir: &str, name: &str, text: &str, limit: u64) -> Result<u64> {
        if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') || is_git_name(name) {
            return Err(format!("invalid file name {name:?}"));
        }
        if text.len() as u64 > limit {
            return Err(format!("{name:?} is larger than {limit} bytes"));
        }
        let parent = self.inside(repo, dir)?;
        if !fs::metadata(&parent).map_err(|e| e.to_string())?.is_dir() {
            return Err(format!("{dir:?} is not a directory"));
        }
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(parent.join(name))
            .map_err(|e| e.to_string())?;
        file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
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
                Component::Normal(part) if !is_git_name(&part.to_string_lossy()) => path.push(part),
                Component::CurDir => {}
                _ => return Err(format!("path {relative:?} leaves the repo")),
            }
            match fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => return Err(format!("{relative:?} is in the way of a file")),
                Err(_) => fs::create_dir(&path).map_err(|e| e.to_string())?,
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
                return fs::remove_file(&named).map_err(|e| e.to_string());
            }
        }
        let path = self.inside(repo, relative)?;
        if path == base {
            return Err("the repo itself is not removed this way".into());
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) }.map_err(|e| e.to_string())
    }

    /// The repo's issues, newest written first; None when it has no issue/.
    pub fn issues(&self, repo: &str) -> Result<Option<Vec<issues::Issue>>> {
        let Ok(entries) = self.tree(repo, "issue") else { return Ok(None) };
        let mut out = Vec::new();
        for e in entries.into_iter().filter(|e| e.kind == "file") {
            if let Ok(Contents { text: Some(text), .. }) = self.read(repo, &format!("issue/{}", e.name), 256 * 1024) {
                out.push(issues::parse(repo, &e.name, &text));
            }
        }
        issues::sort(&mut out);
        Ok(Some(out))
    }

    /// Write a new issue as the next numbered file in `issue/`; returns its name.
    pub fn add_issue(&self, repo: &str, kind: Option<&str>, title: &str, detail: &str) -> Result<String> {
        if title.trim().is_empty() {
            return Err("an issue needs a title".into());
        }
        let names: Vec<String> = self.tree(repo, "issue").map_err(|_| format!("{repo} has no issue/"))?
            .into_iter().map(|e| e.name).collect();
        let name = issues::next_name(&names);
        self.add(repo, "issue", &name, &issues::text(kind, title, detail), 256 * 1024)?;
        Ok(name)
    }
}

/// `git init` without the user's global or system configuration, so a new
/// repo never inherits host settings. Missing git just leaves no `.git`.
fn init_git(dir: &Path) {
    let _ = Command::new("git")
        .args(["-c", "init.defaultBranch=main", "init", "-q"])
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TEMPLATE_DIR", "")
        .status();
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
        assert!(r.mkdir("a", ".git/hooks/x").is_err());
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
        let list = r.issues("a").unwrap().unwrap();
        assert_eq!(list.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["メモ", "壊れる"]);
        assert_eq!(list[1].kind.as_deref(), Some("Fix"));
        r.create("e", "empty").unwrap();
        assert!(r.issues("e").unwrap().is_none());
        assert!(r.add_issue("e", None, "x", "").is_err());
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
