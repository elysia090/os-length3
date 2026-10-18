//! How a Prompt's repo is named when l3 starts l3 for it (the SSH listener,
//! the app): by LENGTH3_REPO, from the data directory, never as a word, which
//! l3 reads against the forms of `l3 prompt` first.

mod common;
use common::Home;

#[test]
fn a_repo_called_like_a_verb_is_reached_by_its_name() {
    let home = Home::new("verb-repos");
    for name in ["ls", "stop"] { home.repo(name, &[("a.txt", "x\n")]); }
    // As a word it is the verb: `ssh ls@host` listed every Prompt on the device instead of opening ls's.
    let ran = home.run("en", &["prompt", "ls"]);
    assert!(ran.stdout.contains("No Prompt is running"), "{ran:?}");
    // Named as the listener and the app name it now, it is the repo (there is no root here, so it says that).
    for name in ["ls", "stop"] {
        let out = home.command("en", &["prompt"]).env("LENGTH3_REPO", name).stdin(std::process::Stdio::null()).output().unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(4), "{name}: {err}");
        assert!(err.contains("No root yet"), "{name}: {err}");
    }
}
