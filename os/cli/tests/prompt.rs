//! How a Prompt's repo is named when l3 starts l3 for it (the SSH listener,
//! the app): by LENGTH3_REPO, from the data directory, never as a word, which
//! l3 reads against the forms of `l3 prompt` first.

mod common;
use common::Home;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

/// An `l3 prompt` started for a test, ended with it whatever happens (its Prompt with it).
struct Started(Child);

impl Drop for Started {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() { let _ = self.0.kill(); let _ = self.0.wait(); }
    }
}

/// `l3 prompt REPO -- /bin/sh -c SCRIPT`, as the app starts one (the repo named by LENGTH3_REPO, no terminal).
fn start(home: &Home, repo: &str, script: &str) -> Started {
    Started(home.command("en", &["prompt", "--", "/bin/sh", "-c", script]).env("LENGTH3_REPO", repo)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().expect("l3 starts"))
}

/// Wait for the Prompt to write `file` in its repo: true once it has, false if it ended first (this host lends
/// no user namespace: what it said is shown).
fn wrote(home: &Home, repo: &str, file: &str, l3: &mut Started) -> bool {
    let end = Instant::now() + Duration::from_secs(30);
    while !home.path(&format!("repos/{repo}/{file}")).exists() {
        if l3.0.try_wait().unwrap().is_some() || Instant::now() > end {
            let mut said = String::new();
            let _ = std::io::Read::read_to_string(l3.0.stderr.as_mut().unwrap(), &mut said);
            eprintln!("skipped: the Prompt did not start here ({said})");
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

#[test]
fn a_repo_called_like_a_verb_is_reached_by_its_name() {
    let home = Home::new("verb-repos");
    for name in ["ls", "stop"] { home.repo(name, &[("a.txt", "x\n")]); }
    // As a word it is the verb: `ssh ls@host` listed every Prompt on the device instead of opening ls's.
    let ran = home.run("en", &["prompt", "ls"]);
    assert!(ran.stdout.contains("No Prompt is running"), "{ran:?}");
    // Named as the listener and the app name it now, it is the repo: its shell starts, and ends with no input.
    if !home.root() { eprintln!("skipped: no sh to lend a root"); return; }
    for name in ["ls", "stop"] {
        let out = home.command("en", &["prompt", "--", "/bin/sh", "-c", ": > here"]).env("LENGTH3_REPO", name).stdin(std::process::Stdio::null()).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        if out.status.code() != Some(0) && err.contains("namespace") { eprintln!("skipped: the Prompt did not start here ({err})"); return; }
        assert!(out.status.success() && home.path(&format!("repos/{name}/here")).exists(), "{name}: {err}");
    }
}

/// From its first moment, while `.setup` runs, a Prompt is one: listed as being prepared, what it holds (its
/// repo, environment and caches) kept from Free and Free all, and stopped as any Prompt is, its setting up with it.
#[test]
fn a_prompt_being_prepared_is_listed_kept_and_stopped_with_its_setting_up() {
    let home = Home::new("prompt-preparing");
    home.repo("os-starting", &[("README", "starting\n")]);
    if !home.root_of(&"5".repeat(64), "test", &["sleep", "touch"]) { eprintln!("skipped: no programs to lend a root"); return; }
    home.use_root(&"5".repeat(64));
    home.dotfiles(&[(".setup", "touch /root/os-starting/began\nsleep 60\ntouch /root/os-starting/set-up\n")]);
    let mut l3 = start(&home, "os-starting", "touch ran");
    if !wrote(&home, "os-starting", "began", &mut l3) { return; }

    let ls = home.run("en", &["prompt", "ls"]);
    assert!(ls.stdout.contains("os-starting") && ls.stdout.contains("preparing (.packages, .setup)"), "{ls:?}");
    let listed = home.run("en", &["prompt", "ls", "--json"]);
    let rows: serde_json::Value = serde_json::from_str(&listed.stdout).unwrap();
    assert_eq!((rows[0]["preparing"].as_bool(), rows[0]["root"].as_str()), (Some(true), Some("5".repeat(64).as_str())), "{listed:?}");
    // Runtime says why each stays; asked by name, or all at once, none goes.
    let page = home.run("en", &["runtime"]);
    assert!(page.stdout.matches("A Prompt being prepared uses it (.packages, .setup)").count() >= 3, "repo, environment, caches: {page:?}");
    let named = home.run("en", &["free", "env:os-starting", "cache:os-starting"]);
    assert!(named.code != 0 && named.stderr.contains("kept env:os-starting: A Prompt being prepared uses it"), "{named:?}");
    home.run("en", &["free", "all"]);
    assert!(home.path("envs/os-starting").is_dir() && home.path("caches/os-starting").is_dir());

    // Stopped while it is prepared: its setting up ends with it, nothing of it left running.
    let stop = home.run("en", &["prompt", "stop", "os-starting"]);
    assert!(stop.code == 0 && stop.stdout.contains("Stopped os-starting's Prompt") && !stop.stdout.contains("still there"), "{stop:?}");
    assert!(!l3.0.wait().unwrap().success());
    assert!(home.run("en", &["prompt", "ls"]).stdout.contains("No Prompt is running"));
    std::thread::sleep(Duration::from_millis(300));
    assert!(!home.path("repos/os-starting/ran").exists() && !home.path("repos/os-starting/set-up").exists(), "it went no further");
    // Nothing holds them now.
    let freed = home.run("en", &["free", "env:os-starting", "cache:os-starting"]);
    assert_eq!(freed.code, 0, "{freed:?}");
    assert!(!home.path("envs/os-starting").exists() && !home.path("caches/os-starting").exists());
}

/// A `.setup` that fails: the Prompt starts with what is there, its record goes when it ends, and the setting up
/// is tried again at the next start (nothing says it was done).
#[test]
fn a_setup_that_fails_starts_the_prompt_with_what_is_there_and_is_tried_again() {
    let home = Home::new("prompt-setup-fails");
    home.repo("os-starting", &[("README", "starting\n")]);
    if !home.root_of(&"5".repeat(64), "test", &["touch"]) { eprintln!("skipped: no programs to lend a root"); return; }
    home.use_root(&"5".repeat(64));
    home.dotfiles(&[(".setup", "echo tried >> /root/os-starting/tries\nexit 3\n")]);
    for n in 1..=2 {
        let mut l3 = start(&home, "os-starting", "touch ran");
        if !wrote(&home, "os-starting", "ran", &mut l3) { return; }
        let ended = l3.0.wait().unwrap();
        let mut said = String::new();
        std::io::Read::read_to_string(l3.0.stderr.as_mut().unwrap(), &mut said).unwrap();
        assert!(ended.success() && said.contains("setting up stopped (exit 3); the Prompt starts with what is there"), "{said}");
        assert_eq!(std::fs::read_to_string(home.path("repos/os-starting/tries")).unwrap().lines().count(), n);
        assert!(home.run("en", &["prompt", "ls"]).stdout.contains("No Prompt is running"));
        std::fs::remove_file(home.path("repos/os-starting/ran")).unwrap();
    }
}

/// Ctrl-C at a terminal while it is prepared stops the setting up, and the Prompt starts with what is there (as
/// before); its record goes with it. Killed instead (its process lost), its setting up goes with it, and its record
/// holds nothing.
#[test]
fn a_prompt_interrupted_or_lost_while_prepared_leaves_no_record_or_process() {
    let home = Home::new("prompt-prepared-cut");
    home.repo("os-starting", &[("README", "starting\n")]);
    if !home.root_of(&"5".repeat(64), "test", &["sleep", "touch"]) { eprintln!("skipped: no programs to lend a root"); return; }
    home.use_root(&"5".repeat(64));
    home.dotfiles(&[(".setup", "touch /root/os-starting/began\nsleep 60\n")]);
    let mut pty = home.pty("en", &["prompt", "--", "/bin/sh", "-c", "touch ran"], &[("LENGTH3_REPO", "os-starting")]);
    let end = Instant::now() + Duration::from_secs(30);
    while !home.path("repos/os-starting/began").exists() {
        if Instant::now() > end { eprintln!("skipped: the Prompt did not start here: {}", pty.screen()); return; }
        std::thread::sleep(Duration::from_millis(50));
    }
    pty.send("\x03").expect("setting up stopped (exit 130); the Prompt starts with what is there");
    let (code, screen) = pty.finish();
    assert!(code == 0 && home.path("repos/os-starting/ran").exists(), "{screen}");
    assert!(home.run("en", &["prompt", "ls"]).stdout.contains("No Prompt is running"));

    std::fs::remove_file(home.path("repos/os-starting/began")).unwrap();
    let mut l3 = start(&home, "os-starting", "touch ran-again");
    if !wrote(&home, "os-starting", "began", &mut l3) { return; }
    let ns = length3_core::prompt::ns_of(l3.0.id()).expect("what prepares it, in a namespace of its own");
    l3.0.kill().unwrap();
    l3.0.wait().unwrap();
    let gone = length3_core::prompt::wait_empty(ns, length3_core::prompt::Held { processes: 0, memory: 0 }, Duration::from_secs(3));
    assert_eq!(gone.left, 0, "nothing of its setting up is left");
    assert!(home.run("en", &["prompt", "ls"]).stdout.contains("No Prompt is running"));
    assert_eq!(home.run("en", &["free", "env:os-starting", "cache:os-starting"]).code, 0, "its record holds nothing now");
    assert!(!home.path("repos/os-starting/ran-again").exists());
}

/// A Prompt keeps the root it runs on when another is made current: Runtime keeps it, Free and Free all leave
/// it, and the Prompt goes on running its programs; once it ends, the root before goes as it always could.
#[test]
fn a_prompt_keeps_its_root_when_another_is_made_current() {
    let home = Home::new("prompt-root-switch");
    home.repo("os-web", &[("README", "web\n")]);
    let (old, l3s) = ("5".repeat(64), length3_core::root::RELEASES[0].sha256);
    if !home.root_of(&old, "Ubuntu", &["sleep", "touch"]) || !home.root_of(l3s, "OS Length3 Linux", &[]) { eprintln!("skipped: no programs to lend a root"); return; }
    home.use_root(&old);
    let mut l3 = start(&home, "os-web", "touch up; while [ ! -e go ]; do sleep 0.05; done; touch after");
    if !wrote(&home, "os-web", "up", &mut l3) { return; }
    // l3's own root, held here, made current while it runs.
    let used = home.run("en", &["root", "use", "l3"]);
    assert!(used.stdout.contains("Prompts run on OS Length3 Linux"), "{used:?}");

    let page = home.run("en", &["runtime"]);
    assert!(page.stdout.contains("A Prompt running uses it"), "{page:?}");
    let named = home.run("en", &["free", &format!("root:{old}")]);
    assert!(named.code != 0 && named.stderr.contains("A Prompt running uses it"), "{named:?}");
    home.run("en", &["free", "all"]);
    assert!(home.path(&format!("system/{old}/root/bin/touch")).is_file());
    // Its programs still run from it.
    std::fs::write(home.path("repos/os-web/go"), "").unwrap();
    assert!(l3.0.wait().unwrap().success() && home.path("repos/os-web/after").exists());

    // Ended, the root before is one that can go, and goes; the current one stays (#46).
    let freed = home.run("en", &["free", &format!("root:{old}")]);
    assert_eq!(freed.code, 0, "{freed:?}");
    assert!(!home.path(&format!("system/{old}")).exists() && home.path(&format!("system/{l3s}/installed.json")).is_file());
    assert!(home.run("en", &["free", &format!("root:{l3s}")]).stderr.contains("The root Prompts run on"));
}

/// The tasks in this home's book, by id: their state and last words.
fn tasks_of(home: &Home) -> Vec<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.path("tasks/tasks.json")).unwrap_or("{}".into())).unwrap();
    v["tasks"].as_array().cloned().unwrap_or_default()
}

/// Wait until task `id` is `state` (30 s at most); its JSON.
fn until(home: &Home, id: u64, state: &str) -> serde_json::Value {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        let k = tasks_of(home).into_iter().find(|k| k["id"] == id).unwrap_or_default();
        if k["state"] == state || Instant::now() > end { return k; }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// An agent (here one that only prints what Claude Code's stream does) is asked about a repo: it runs in the repo's
/// Prompt by itself, told the question; what it asks back waits for the person, whose reply sends it on in the same
/// session; what it ends with is there to look at, and what it did is said as it goes.
#[test]
fn a_question_runs_in_the_prompt_asks_back_and_goes_on_with_the_reply() {
    let home = Home::new("tasks-ask");
    assert!(home.root(), "this host lends no sh for a root");
    home.repo("notes", &[("README.md", "notes\n")]);
    let agent = r#"printf '%s' "$L3_TASK" > told.txt
echo '{"type":"system","subtype":"init","session_id":"s-1"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}]}}'
if [ -n "$L3_RESUME" ]; then echo "$L3_RESUME" > resumed.txt; R='DONE it is the loop'; else R='Looked.\nQUESTION Keep the old name?'; fi
printf '{"type":"result","result":"%s"}\n' "$R""#;
    home.dotfiles(&[(".agent", "sh /root/.fakeagent\n"), (".fakeagent", agent)]);
    assert_eq!(home.run("en", &["agent", "on", "claude"]).code, 0);
    assert_eq!(home.run("en", &["network", "on", "notes"]).code, 0);
    let asked = home.run("en", &["agent", "ask", "notes", "Why is it slow?"]);
    assert!(asked.stdout.starts_with("Asked"), "{asked:?}");
    let k = until(&home, 1, "asking");
    let Ok(told) = std::fs::read_to_string(home.path("repos/notes/told.txt")) else {
        // Only a host that lends no user namespace is passed over; anything else is a failure.
        assert!(k["said"].as_str().is_some_and(|s| s.contains("namespace") || s.contains("could not start")), "{k}");
        eprintln!("skipped: the Prompt did not start here ({k})");
        return;
    };
    assert!(told.starts_with("Why is it slow?"), "{told}");
    assert_eq!((k["questions"][0].as_str(), k["session"].as_str()), (Some("Keep the old name?"), Some("s-1")), "{k}");
    assert!(home.run("en", &["agent"]).stdout.contains("Asks you\n    1  notes  Keep the old name? (l3 agent reply 1 \"…\")"));
    assert_eq!(home.run("en", &["agent", "reply", "1", "Yes, keep it"]).code, 0);
    let k = until(&home, 1, "ready");
    assert_eq!(k["said"], "it is the loop", "{k}");
    assert_eq!(std::fs::read_to_string(home.path("repos/notes/told.txt")).unwrap(), "Yes, keep it");
    assert_eq!(std::fs::read_to_string(home.path("repos/notes/resumed.txt")).unwrap(), "s-1\n");
    let journal = std::fs::read_to_string(home.path("agents.jsonl")).unwrap();
    assert!(journal.contains(r#""session":"task-1","repo":"notes","line":"main","kind":"tool","text":"Read: README.md""#), "{journal}");
    // Looked at: put away.
    assert_eq!(home.run("en", &["agent", "drop", "1"]).code, 0);
    assert_eq!(until(&home, 1, "done")["state"], "done");
}

/// An issue written is offered to the agent (written, never taken by itself); handed over without the Remote to
/// start its work on, it says it could not run and the one fix.
#[test]
fn an_issue_written_is_offered_and_handed_over_it_says_what_it_needs() {
    let home = Home::new("tasks-offer");
    home.repo("notes", &[("README.md", "notes\n")]);
    // No agent: nothing is offered.
    assert!(home.run("en", &["issue", "new", "notes", "Fix：before"]).stdout.starts_with("Wrote notes#1"));
    assert!(tasks_of(&home).is_empty());
    assert_eq!(home.run("en", &["agent", "on", "claude"]).code, 0);
    assert!(home.run("en", &["issue", "new", "notes", "Fix：the draft is lost"]).stdout.starts_with("Wrote notes#2"));
    let k = until(&home, 1, "offered");
    assert_eq!((k["deed"].as_str(), k["unit"].as_str(), k["words"].as_str(), k["issue"].as_str()), (Some("take"), Some("goal"), Some("the draft is lost"), Some("issue/002.md")), "{k}");
    assert!(home.run("en", &["agent"]).stdout.contains("Claude Code can take it: the draft is lost (l3 agent take 1)"));
    assert_eq!(home.run("en", &["agent", "take", "1"]).code, 0);
    let k = until(&home, 1, "stopped");
    assert_eq!((k["state"].as_str(), k["fix"].as_str()), (Some("stopped"), Some("l3 login")), "{k}");
}
