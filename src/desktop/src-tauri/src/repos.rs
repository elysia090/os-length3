//! Repos the app manages, under its own data directory. Every path from the
//! webview is checked to stay inside one repo, after following symlinks.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

pub type Result<T> = std::result::Result<T, String>;

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

pub struct Repos {
    root: PathBuf,
}

impl Repos {
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

    /// A path inside `repo`; `..`, absolute paths and symlinks that lead out
    /// of the repo are refused.
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
        if !real.starts_with(&real_base) {
            return Err(format!("path {relative:?} leads outside the repo"));
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
                if e.file_name() == ".git" { continue; }
                let Ok(meta) = e.metadata() else { continue };
                let time = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
                modified = modified.max(time);
                if meta.is_dir() { stack.push(e.path()); } else { files += 1; bytes += meta.len(); }
            }
        }
        Ok(Summary { name: name.to_string(), files, bytes, modified, git: dir.join(".git").is_dir() })
    }

    /// Create a repo from a template. Every repo has `inbox.md` and `TODO.md`.
    pub fn create(&self, name: &str, template: &str) -> Result<Summary> {
        let dir = self.repo(name)?;
        if dir.exists() {
            return Err(format!("repo {name} already exists"));
        }
        let mut files: Vec<(&str, String)> = vec![
            ("inbox.md", "# inbox\n".into()),
            ("TODO.md", "# TODO\n".into()),
        ];
        let mut dirs: Vec<&str> = Vec::new();
        match template {
            "empty" => {}
            "standard" | "c" => {
                files.push(("README.md", format!("# {name}\n")));
                dirs.extend(["docs", "issue"]);
                if template == "c" {
                    files.push(("src/main.c", "#include <stdio.h>\n\nint main(void) {\n    puts(\"hello\");\n    return 0;\n}\n".into()));
                    files.push(("Makefile", format!("{name}: src/main.c\n\tcc -O2 -o $@ src/main.c\n")));
                }
            }
            _ => return Err(format!("unknown template {template:?}")),
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for d in dirs {
            fs::create_dir_all(dir.join(d)).map_err(|e| e.to_string())?;
        }
        for (path, text) in files {
            let target = dir.join(path);
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
            .filter(|e| e.file_name() != ".git")
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
    fn templates_always_have_inbox_and_todo() {
        let r = scratch("tpl");
        for t in ["empty", "standard", "c"] {
            r.create(t, t).unwrap();
            let names: Vec<String> = r.tree(t, "").unwrap().into_iter().map(|e| e.name).collect();
            assert!(names.contains(&"inbox.md".into()) && names.contains(&"TODO.md".into()), "{t}: {names:?}");
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
