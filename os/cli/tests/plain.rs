//! Off a terminal l3 is a plain command: what it writes and how it exits are
//! what scripts and CI read, so they stay byte for byte as recorded (in
//! tests/golden), whatever l3 offers a person at a terminal.

mod common;
use common::{golden, Home};

/// A day's work from nothing: a repo, an issue, a TODO; then each page read,
/// as text and as data, and a few mistakes.
const SCRIPT: &[&[&str]] = &[
    &["repo", "new", "notes"],
    &["issue", "new", "notes", "Fix：restart loses the draft"],
    &["todo", "add", "Fix：the rail's names"],
    &["todo", "add", "Docs：readme"],
    &["todo", "done", "2"],
    &[],
    &["--json"],
    &["todo"],
    &["profile"],
    &["band"],
    &["file"],
    &["file", "notes"],
    // What l3 file reads is the repos: / and what else is under it are named as such, never as a repo.
    &["file", "/"],
    &["file", "/root"],
    &["file", "/bin"],
    &["file", "/root/vocab"],
    &["file", "notes/README.md"],
    &["file", "rm", "notes/docs"],
    &["help", "commit"],
    &["git"],
    &["git", "--json"],
    &["issue", "notes#1"],
    &["issue", "close", "notes#1"],
    &["git"],
    &["issue", "reopen", "notes#1"],
    &["help", "git"],
    &["comit"],
    &["todo", "add"],
    &["inbox"],
    &["start", "notes#1"],
    &["remote"],
    &["server", "--json"],
];

fn day(lang: &str) -> String {
    let home = Home::new(&format!("plain-{lang}"));
    SCRIPT.iter().map(|args| home.run(lang, args).transcript(args)).collect()
}

#[test]
fn off_a_terminal_every_command_writes_and_exits_as_recorded_in_english() {
    golden("plain-en.txt", &day("en"));
}

#[test]
fn off_a_terminal_every_command_writes_and_exits_as_recorded_in_japanese() {
    golden("plain-ja.txt", &day("ja"));
}
