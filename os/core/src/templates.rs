//! Repo templates, defined once in `shared/templates.json` and read by both
//! the app and l3. A template holds only the repo's own files; Inbox and TODO
//! belong to the OS, not to a repo.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
pub struct Template {
    pub id: String,
    pub label: String,
    pub dirs: Vec<String>,
    /// [path, text] with `{name}` standing for the repo's name.
    pub files: Vec<(String, String)>,
}

const SOURCE: &str = include_str!("../../shared/templates.json");

pub fn all() -> Vec<Template> {
    serde_json::from_str(SOURCE).expect("shared/templates.json is valid")
}

/// `id`'s template; "" is none at all: a repo whose files all come from elsewhere (the Remote, a Prompt).
pub fn find(id: &str) -> Option<Template> {
    if id.is_empty() {
        return Some(Template { id: String::new(), label: String::new(), dirs: Vec::new(), files: Vec::new() });
    }
    all().into_iter().find(|t| t.id == id)
}

impl Template {
    /// The files of a repo called `name`, `{name}` filled in.
    pub fn files_for(&self, name: &str) -> Vec<(String, String)> {
        self.files.iter().map(|(p, t)| (p.clone(), t.replace("{name}", name))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// What the C template builds never names a path the template makes, whatever
    /// the repo is called: a repo named `src` (or `docs`, `Makefile`, …) builds
    /// as one named `hello` does, and prints hello. Built for real where this
    /// machine has cc and make.
    #[test]
    fn c_builds_whatever_the_repo_is_named() {
        let t = find("c").unwrap();
        let owned: Vec<String> =
            t.dirs.iter().cloned().chain(t.files.iter().map(|(p, _)| p.split('/').next().unwrap().to_string())).collect();
        let tools = ["cc", "make"].iter().all(|c| Command::new(c).arg("--version").output().is_ok_and(|o| o.status.success()));
        for name in owned.iter().map(String::as_str).chain(["build", "hello", "CACHEDIR.TAG"]) {
            let files = t.files_for(name);
            let makefile = &files.iter().find(|(p, _)| p == "Makefile").unwrap().1;
            let target = makefile.lines().next().unwrap().split(':').next().unwrap().to_string();
            let first = target.split('/').next().unwrap();
            assert!(target.contains('/') && !owned.iter().any(|o| o == first), "{name}: {target}");
            if !tools {
                continue;
            }
            let dir = std::env::temp_dir().join(format!("length3-template-{}-{name}", std::process::id()));
            for d in &t.dirs {
                std::fs::create_dir_all(dir.join(d)).unwrap();
            }
            for (p, text) in &files {
                let at = dir.join(p);
                std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                std::fs::write(at, text).unwrap();
            }
            let made = Command::new("make").arg("-s").current_dir(&dir).output().unwrap();
            assert!(made.status.success(), "{name}: {}", String::from_utf8_lossy(&made.stderr));
            let ran = Command::new(dir.join(&target)).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&ran.stdout), "hello\n", "{name}");
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    /// What C's make builds is derived (#58): the directory it makes says it is a cache (CACHEDIR.TAG, with the
    /// standard signature), so it is listed and freed apart from the repo and never sent; the sources are neither;
    /// and make makes it again once it went. Built for real where this machine has cc and make.
    #[test]
    fn what_c_builds_is_derived_and_made_again_once_freed() {
        let tools = ["cc", "make"].iter().all(|c| Command::new(c).arg("--version").output().is_ok_and(|o| o.status.success()));
        if !tools {
            eprintln!("skipped: no cc or make here");
            return;
        }
        let t = find("c").unwrap();
        let dir = std::env::temp_dir().join(format!("length3-template-derived-{}", std::process::id()));
        for d in &t.dirs {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for (p, text) in t.files_for("hello") {
            std::fs::create_dir_all(dir.join(&p).parent().unwrap()).unwrap();
            std::fs::write(dir.join(p), text).unwrap();
        }
        for _ in 0..2 {
            let made = Command::new("make").arg("-s").current_dir(&dir).output().unwrap();
            assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
            let tag = std::fs::read_to_string(dir.join("build/CACHEDIR.TAG")).unwrap();
            assert!(tag.starts_with("Signature: 8a477f597d28d172789f06886806bc55"), "{tag:?}");
            assert_eq!(crate::owned::derived_in(&dir), [dir.join("build")]);
            let sent: Vec<String> = crate::remote::local_tree(&dir).tree.keys().cloned().collect();
            assert_eq!(sent, ["Makefile", "README.md", "docs", "issue", "src/main.c"]);
            // Freed as Runtime frees what is derived: the directory goes, and the sources stay to make it again.
            std::fs::remove_dir_all(dir.join("build")).unwrap();
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
