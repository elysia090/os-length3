//! The Agent's hands as Pi gives them (read, write, edit, bash), with Pi's rules, kept here so the app, its web build
//! and l3 hold one meaning of each: what is read of a file and where reading goes on (`part`), and an edit as exact
//! text replaced, each piece found once in the file as it was (`edit`). The model is never shown the screen: what a
//! tool did goes back to it as text, and with it where in the file it was done (`Edited::spans`), which the screen
//! plays as a person's doing at a person's pace.
//!
//! Only the rules are here: the file is read and written by whoever holds the repo (the app's store, l3's), so what
//! watches the repo hears of it as of any write.

use serde::{Deserialize, Serialize};

/// What one read gives at most: this many lines, or this many bytes, whichever comes first (Pi's).
pub const MOST_LINES: usize = 2000;
pub const MOST_BYTES: usize = 50 * 1024;

/// Of a file's text, what one read gives: its lines `from`..=`to` (1-based) of `lines`, and where to go on (`next`).
#[derive(Serialize, Debug, PartialEq)]
pub struct Part {
    /// The lines read, as they are, and (more left) where reading goes on, said to the model.
    pub text: String,
    pub from: usize,
    pub to: usize,
    pub lines: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<usize>,
}

/// A file's lines as a reader counts them: the newline at its end ends the last line, it does not begin another.
fn lines_of(text: &str) -> Vec<&str> {
    if text.is_empty() { return Vec::new(); }
    text.strip_suffix('\n').unwrap_or(text).split('\n').collect()
}

/// `text`'s lines from `offset` (1-based; the first by default), at most `limit` of them, cut at MOST_LINES or
/// MOST_BYTES: what the model reads, and where it goes on from. An offset past the end is refused, saying the end.
pub fn part(text: &str, offset: Option<usize>, limit: Option<usize>) -> Result<Part, String> {
    let all = lines_of(text);
    let from = offset.unwrap_or(1).max(1);
    if from > all.len().max(1) {
        return Err(format!("Offset {from} is beyond the end of the file ({} lines in all).", all.len()));
    }
    let wanted = limit.unwrap_or(usize::MAX).clamp(1, MOST_LINES);
    let (mut out, mut to) = (String::new(), from - 1);
    for line in all.iter().skip(from - 1).take(wanted) {
        // A first line longer than a read holds is still read, cut: the model is told how to go on past it.
        if !out.is_empty() && out.len() + line.len() + 1 > MOST_BYTES { break; }
        if !out.is_empty() { out.push('\n'); }
        out.push_str(cut_to(line, MOST_BYTES));
        to += 1;
    }
    let next = (to < all.len()).then_some(to + 1);
    if let Some(n) = next {
        out.push_str(&format!("\n\n[Lines {from}-{to} of {}. Use offset={n} to go on.]", all.len()));
    }
    Ok(Part { text: out, from, to, lines: all.len(), next })
}

/// `s` cut to at most `most` bytes, at a character's edge.
fn cut_to(s: &str, most: usize) -> &str {
    if s.len() <= most { return s; }
    let mut at = most;
    while !s.is_char_boundary(at) { at -= 1; }
    &s[..at]
}

/// What a command printed, as the model is given it: its last MOST_LINES lines or MOST_BYTES, whichever is less, and
/// how much was left out before them.
pub fn tail(output: &str) -> String {
    let all = lines_of(output);
    let (mut kept, mut bytes) = (0usize, 0usize);
    for line in all.iter().rev() {
        if kept == MOST_LINES || (kept > 0 && bytes + line.len() + 1 > MOST_BYTES) { break; }
        bytes += line.len() + 1;
        kept += 1;
    }
    let shown = all[all.len() - kept..].join("\n");
    if kept == all.len() { return shown; }
    let shown = if shown.len() > MOST_BYTES { last_of(&shown, MOST_BYTES).to_string() } else { shown };
    format!("[{} earlier lines left out]\n{shown}", all.len() - kept)
}

/// The end of `s`, at most `most` bytes of it, from a character's edge (a line of output can be cut anywhere in it).
fn last_of(s: &str, most: usize) -> &str {
    if s.len() <= most { return s; }
    let mut at = s.len() - most;
    while !s.is_char_boundary(at) { at += 1; }
    &s[at..]
}

/// One piece of an edit: text as it is in the file, and what takes its place.
#[derive(Deserialize, Debug, Clone)]
pub struct Change {
    #[serde(rename = "oldText")]
    pub old: String,
    #[serde(rename = "newText")]
    pub new: String,
}

/// Where a piece was replaced: its first line and column (1-based, in characters) in the file as it was, what it
/// was and what it is now. The screen goes there and writes it as a person would.
#[derive(Serialize, Debug, PartialEq)]
pub struct Span {
    pub line: usize,
    pub column: usize,
    pub old: String,
    pub new: String,
}

/// A file edited: its text now, where each piece was replaced (first in the file first), the lines added and taken.
#[derive(Serialize, Debug, PartialEq)]
pub struct Edited {
    pub text: String,
    pub spans: Vec<Span>,
    pub added: usize,
    pub removed: usize,
}

/// `text` with what is written in it brought to one form, and for each of its bytes the byte of `text` it came from:
/// the newline as \n, no blank at a line's end, typographic quotes, dashes and spaces as their ASCII ones. A model
/// writes code as it was shown, not always byte for byte; found in this form, a piece is still replaced in the file's
/// own bytes (the rest of the file never changes).
struct Plain { text: String, from: Vec<usize> }

fn plain_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        c => c,
    }
}

fn plain(text: &str) -> Plain {
    let (mut out, mut from) = (String::with_capacity(text.len()), Vec::with_capacity(text.len() + 1));
    let mut held: Vec<(usize, char)> = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        // \r\n is one newline; a lone \r is kept.
        if c == '\r' && chars.peek().map(|&(_, n)| n) == Some('\n') { continue; }
        let c = plain_char(c);
        if c == ' ' || c == '\t' { held.push((at, c)); continue; }
        // Blanks are kept only when something follows them on their line.
        if c != '\n' { for &(a, b) in &held { push(&mut out, &mut from, a, b); } }
        held.clear();
        push(&mut out, &mut from, at, c);
    }
    from.push(text.len());
    Plain { text: out, from }
}

fn push(out: &mut String, from: &mut Vec<usize>, at: usize, c: char) {
    for _ in 0..c.len_utf8() { from.push(at); }
    out.push(c);
}

/// Where `needle` is in `hay`: its byte offsets, every one.
fn found(hay: &str, needle: &str) -> Vec<usize> { hay.match_indices(needle).map(|(i, _)| i).collect() }

/// `text` (the file at `path`) with each change's old text, found once in it as it was, replaced by its new text.
/// Refused, the file unchanged: an old text empty, not there, there more than once, two that overlap, or nothing
/// changed. Found as written first; else in the one form both are brought to (`plain`).
pub fn edit(path: &str, text: &str, changes: &[Change]) -> Result<Edited, String> {
    let many = changes.len() > 1;
    let which = |i: usize| if many { format!("edits[{i}]") } else { "the text".into() };
    if changes.is_empty() { return Err(format!("No edits given for {path}.")); }
    let p = plain(text);
    let mut at: Vec<(usize, usize, usize)> = Vec::new(); // (start, end) in `text`'s bytes, and which change
    for (i, c) in changes.iter().enumerate() {
        if c.old.is_empty() { return Err(format!("The old text of {} must not be empty in {path}.", which(i))); }
        let exact = found(text, &c.old);
        let (start, end) = if exact.len() == 1 {
            (exact[0], exact[0] + c.old.len())
        } else if exact.len() > 1 {
            return Err(format!("{} is in {path} {} times. It must be there once: give more of what is around it.", which(i), exact.len()));
        } else {
            let needle = plain(&c.old).text;
            if needle.is_empty() { return Err(format!("The old text of {} must not be empty in {path}.", which(i))); }
            let loose = found(&p.text, &needle);
            match loose.len() {
                0 => return Err(format!("Could not find {} in {path}. It must be as it is in the file, every space and line.", which(i))),
                1 => {}
                n => return Err(format!("{} is in {path} {n} times. It must be there once: give more of what is around it.", which(i))),
            }
            let (s, e) = (loose[0], loose[0] + needle.len());
            // The end is just past the last byte found: the file's byte that last one came from, and its character.
            let last = p.from[e - 1];
            (p.from[s], last + text[last..].chars().next().map_or(1, char::len_utf8))
        };
        at.push((start, end, i));
    }
    at.sort();
    for w in at.windows(2) {
        if w[0].1 > w[1].0 {
            return Err(format!("edits[{}] and edits[{}] overlap in {path}. Make them one edit, or edit apart.", w[0].2, w[1].2));
        }
    }
    let (mut out, mut spans, mut was) = (String::with_capacity(text.len()), Vec::new(), 0);
    let (mut added, mut removed) = (0, 0);
    for &(s, e, i) in &at {
        out.push_str(&text[was..s]);
        out.push_str(&changes[i].new);
        let before = &text[..s];
        let line = before.matches('\n').count() + 1;
        let column = before[before.rfind('\n').map_or(0, |n| n + 1)..].chars().count() + 1;
        let (a, r) = lines_changed(&text[s..e], &changes[i].new);
        added += a;
        removed += r;
        spans.push(Span { line, column, old: text[s..e].to_string(), new: changes[i].new.clone() });
        was = e;
    }
    out.push_str(&text[was..]);
    if out == text { return Err(format!("Nothing changed in {path}: the new text is the old.")); }
    Ok(Edited { text: out, spans, added, removed })
}

/// The lines `old` → `new` adds and takes, its lines alike at the start and the end left out.
fn lines_changed(old: &str, new: &str) -> (usize, usize) {
    let (o, n): (Vec<&str>, Vec<&str>) = (old.split('\n').collect(), new.split('\n').collect());
    let head = o.iter().zip(&n).take_while(|(a, b)| a == b).count();
    let tail = o[head..].iter().rev().zip(n[head..].iter().rev()).take_while(|(a, b)| a == b).count();
    (n.len() - head - tail, o.len() - head - tail)
}

#[cfg(test)]
#[path = "tests/hands.rs"]
mod tests;
