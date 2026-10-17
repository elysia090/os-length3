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

/// How an issue is called by its file: issue/001.md is #1; a name that is not a number is itself.
pub fn number(file: &str) -> String {
    let stem = file.trim_start_matches("issue/").trim_end_matches(".md");
    if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) { format!("#{}", stem.trim_start_matches('0').max("0")) } else { stem.to_string() }
}

/// Whether `file` (in issue/) is the one `which` names: "3", "003", "003.md" or a name's stem.
pub fn named_by(file: &str, which: &str) -> bool {
    let (stem, want) = (file.trim_end_matches(".md"), which.trim_end_matches(".md"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(stem) && digits(want) { stem.trim_start_matches('0') == want.trim_start_matches('0') } else { stem == want }
}

/// Newest written first: the numbers say the order.
pub fn sort(list: &mut [Issue]) {
    list.sort_by(|a, b| b.file.cmp(&a.file));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issue_is_called_by_its_number() {
        assert_eq!(number("001.md"), "#1");
        assert_eq!(number("issue/010.md"), "#10");
        assert_eq!(number("000.md"), "#0");
        assert_eq!(number("notes.md"), "notes");
        assert_eq!(number("3"), "#3");
        assert!(named_by("003.md", "3") && named_by("003.md", "003.md") && named_by("003.md", "03"));
        assert!(named_by("notes.md", "notes") && !named_by("003.md", "4") && !named_by("notes.md", "3"));
    }
}
