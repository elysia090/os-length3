//! Issues are plain files in a repo's `issue/`, one each, numbered in the order
//! written (001.md, 002.md, …). The first line names it ("Fix：件名"); the
//! lines after are the detail. Dates go in the text, never in the name.

use crate::text::{kind_of, named};
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Issue {
    pub repo: String,
    pub file: String,
    pub kind: Option<String>,
    pub title: String,
    pub detail: String,
}

pub fn parse(repo: &str, file: &str, text: &str) -> Issue {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split('\n');
    let first = lines.next().unwrap_or("");
    let (kind, title) = kind_of(first.trim_start_matches('#').trim_start());
    let detail = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let title = if title.is_empty() { file.to_string() } else { title };
    Issue { repo: repo.into(), file: file.into(), kind, title, detail }
}

/// The text of a new issue file.
pub fn text(kind: Option<&str>, title: &str, detail: &str) -> String {
    let head = named(kind, title);
    let body = detail.trim();
    if body.is_empty() { format!("{head}\n") } else { format!("{head}\n\n{body}\n") }
}

/// The next free number among the names already in `issue/`.
pub fn next_name<S: AsRef<str>>(names: &[S]) -> String {
    let used = names.iter()
        .filter_map(|n| n.as_ref().strip_suffix(".md"))
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|n| n.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("{:03}.md", used + 1)
}

/// Newest written first: the numbers say the order.
pub fn sort(list: &mut [Issue]) {
    list.sort_by(|a, b| b.file.cmp(&a.file));
}
