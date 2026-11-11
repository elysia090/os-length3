//! An issue is a number and its words: "#3 Fix：件名", then the detail
//! (root3/app/repos/issues.ts). That is all a person meets; how it is kept is the OS's
//! business. It is kept as one plain file in the repo's `issue/`, written
//! the way TODO items are: the first line names it, the lines after are the
//! detail. The file is named by the issue's number, which the OS gives: the
//! next one when an issue is written, and the next free one for a file there
//! that has none (one written by hand, or two devices' issues that met under
//! one number). Dates go in the text, never in the name. Its issue/ is the OS's
//! (crate::repos::store::ISSUES): never among the files File, Forge and root3 file show, nor
//! made by a scaffold; an issue is met as an issue (Git, the box, root3 issue).

use crate::text::title::{kind_of, named};
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Issue {
    pub repo: String,
    /// Its number in the repo; none only until the OS has given it one.
    pub n: Option<u64>,
    /// How it is kept, inside issue/: never shown to a person.
    pub file: String,
    pub kind: Option<String>,
    pub title: String,
    pub detail: String,
    /// Closed without being done: what its last line says after "Closed：" (the day, and who).
    pub closed: Option<String>,
}

/// The number a file in issue/ is named by ("007.md" is 7), or none (`^0*\d+\.md$`).
pub fn number_of(file: &str) -> Option<u64> {
    let stem = file.strip_suffix(".md")?;
    if stem.is_empty() || !stem.bytes().all(|b| b.is_ascii_digit()) { return None; }
    stem.parse().ok()
}

/// A closed issue says so on its last line, after its detail: "Closed：2031-10-17 sora"
/// (the day it was closed, and who); reopening takes the line away again.
fn closed_line(line: &str) -> Option<&str> {
    let t = line.trim();
    t.strip_prefix("Closed：").or_else(|| t.strip_prefix("Closed:")).map(str::trim)
}

/// Which of `lines` closes the issue: its last one with words, if it is such a line (never the first, which names it).
fn closed_at(lines: &[&str]) -> Option<usize> {
    let j = lines.iter().rposition(|l| !l.trim().is_empty())?;
    (j > 0 && closed_line(lines[j]).is_some()).then_some(j)
}

pub fn parse(repo: &str, file: &str, text: &str) -> Issue {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // A file written with CRLF line ends reads as one written with LF: no line keeps its CR.
    let all: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let at = closed_at(&all);
    let closed = at.and_then(|j| closed_line(all[j])).map(String::from);
    let lines = &all[..at.unwrap_or(all.len())];
    let first = lines.first().copied().unwrap_or("");
    let (kind, title) = kind_of(first.trim_start_matches('#').trim_start());
    let detail = lines.iter().skip(1).copied().collect::<Vec<_>>().join("\n").trim().to_string();
    let title = if title.is_empty() { file.strip_suffix(".md").unwrap_or(file).to_string() } else { title };
    Issue { repo: repo.into(), n: number_of(file), file: file.into(), kind, title, detail, closed }
}

/// An issue's text open again: without the line that closed it.
pub fn reopen_text(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    match closed_at(&lines) {
        Some(j) => format!("{}\n", lines[..j].join("\n").trim_end()),
        None => text.to_string(),
    }
}

/// An issue's text closed: its words as they are, then "Closed：" and `mark` (the day, and who) on a line of its own.
pub fn close_text(text: &str, mark: &str) -> String {
    format!("{}\n\nClosed：{}\n", reopen_text(text).trim_end(), mark.trim())
}

/// The text of a new issue file.
pub fn text(kind: Option<&str>, title: &str, detail: &str) -> String {
    let head = named(kind, title);
    let body = detail.trim();
    if body.is_empty() { format!("{head}\n") } else { format!("{head}\n\n{body}\n") }
}

/// The file the next issue is kept in, after every number already there.
pub fn next_name<S: AsRef<str>>(names: &[S]) -> String {
    let used = names.iter().filter_map(|n| number_of(n.as_ref())).max().unwrap_or(0);
    format!("{:03}.md", used + 1)
}

/// How an issue is called by the file that keeps it: "#7"; nothing until it has a number.
pub fn number(file: &str) -> String {
    number_of(file.trim_start_matches("issue/")).map(|n| format!("#{n}")).unwrap_or_default()
}

/// Whether `file` (in issue/) is the one `which` names: its number ("3",
/// "003", "003.md"), or, for one without a number, its file's own name.
pub fn named_by(file: &str, which: &str) -> bool {
    let want = which.trim_start_matches('#');
    let digits = !want.is_empty() && want.trim_end_matches(".md").bytes().all(|b| b.is_ascii_digit());
    match number_of(file) {
        Some(n) if digits => want.trim_end_matches(".md").parse::<u64>().ok() == Some(n),
        _ => file == want || file.strip_suffix(".md") == Some(want),
    }
}

/// The issues of `list` that `words` names by its title, as a person says
/// it (case aside, the kind's colon either width): those whose title or
/// first line is exactly the words, else those holding every word of them.
/// More than one is a choice for the person, never a guess.
pub fn by_title<'a>(list: &'a [Issue], words: &str) -> Vec<&'a Issue> {
    let fold = |s: &str| s.to_lowercase().replace('：', ":");
    let want = fold(words.trim());
    let terms: Vec<&str> = want.split(|c: char| c.is_whitespace() || c == ':').filter(|t| !t.is_empty()).collect();
    if terms.is_empty() { return Vec::new(); }
    let first = |i: &Issue| fold(&named(i.kind.as_deref(), &i.title));
    let exact: Vec<&Issue> = list.iter().filter(|i| fold(&i.title) == want || first(i) == want).collect();
    if !exact.is_empty() { return exact; }
    list.iter().filter(|i| { let f = first(i); terms.iter().all(|t| f.contains(t)) }).collect()
}

/// By number, the newest first; one still without a number is newer than any.
pub fn sort(list: &mut [Issue]) {
    list.sort_by(|a, b| b.n.unwrap_or(u64::MAX).cmp(&a.n.unwrap_or(u64::MAX)).then_with(|| a.file.cmp(&b.file)));
}

/// By number, the oldest first (as Git lays them out); those without a number last.
pub fn sort_oldest_first(list: &mut [Issue]) {
    list.sort_by(|a, b| a.n.unwrap_or(u64::MAX).cmp(&b.n.unwrap_or(u64::MAX)).then_with(|| a.file.cmp(&b.file)));
}

/// What numbering the issues without one does: each, oldest name first, takes
/// the next free number, except one a work or a change refers to (`in_use`,
/// "issue/<file>"), which keeps the name it began with. The same on every
/// device, so two doing it at once agree. (old file, new file) for each.
pub fn numbering(list: &[Issue], in_use: &[String]) -> Vec<(String, String)> {
    let used = |i: &Issue| in_use.iter().any(|u| u.strip_prefix("issue/") == Some(i.file.as_str()));
    let mut loose: Vec<&Issue> = list.iter().filter(|i| i.n.is_none() && !used(i)).collect();
    loose.sort_by(|a, b| a.file.cmp(&b.file));
    // The next free number is one past the highest there, and each given makes it the highest.
    let mut last = list.iter().filter_map(|i| number_of(&i.file)).max().unwrap_or(0);
    loose.into_iter().map(|i| { last += 1; (i.file.clone(), format!("{last:03}.md")) }).collect()
}

#[cfg(test)]
#[path = "issues.test.rs"]
mod tests;
