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
        for name in owned.iter().map(String::as_str).chain(["build", "hello"]) {
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
}
