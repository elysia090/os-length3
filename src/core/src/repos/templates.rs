//! Repo templates, defined once in `src/shared/templates.json` and read by both
//! the app and l3. A template holds only the repo's own files; Inbox and TODO
//! belong to the OS, not to a repo.

use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
pub struct Template {
    pub id: String,
    pub label: String,
    pub dirs: Vec<String>,
    /// [path, text] with `{name}` standing for the repo's name.
    pub files: Vec<(String, String)>,
}

const SOURCE: &str = include_str!("../../../shared/templates.json");

pub fn all() -> Vec<Template> {
    serde_json::from_str(SOURCE).expect("src/shared/templates.json is valid")
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
#[path = "tests/templates.rs"]
mod tests;
