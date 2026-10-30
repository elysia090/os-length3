//! The SSH listener (`l3 address ssh serve`) against an ordinary OpenSSH
//! client, beside a Remote of the test's own that says SSH is on.

#![cfg(target_os = "linux")]

mod common;
use common::{FakeRemote, Home};
use std::io::BufRead;
use std::process::{Command, Stdio};

/// A port free on loopback now.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[test]
fn a_connection_kept_open_takes_one_session_after_another() {
    if Command::new("ssh").arg("-V").output().is_err() || Command::new("ssh-keygen").arg("--help").output().is_err() {
        eprintln!("no OpenSSH here: not tried");
        return;
    }
    let home = Home::new("ssh-sessions");
    home.repo("notes", &[("a.txt", "x\n")]);
    assert!(home.root(), "this host lends no sh for a root");
    let key = home.path("id");
    assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", ""]).arg("-f").arg(&key).status().unwrap().success());
    let public = std::fs::read_to_string(home.path("id.pub")).unwrap();
    let dotfiles = serde_json::json!({".authorized_keys": public}).to_string();
    std::fs::create_dir_all(home.path("home")).unwrap();
    std::fs::write(home.path("home/dotfiles.json"), &dotfiles).unwrap();
    let kept = dotfiles.clone();
    let remote = FakeRemote::start(move |a| match (a.method.as_str(), a.path.as_str()) {
        ("GET", "/v1/home/dotfiles") => (200, serde_json::json!({"value": kept, "version": 1}).to_string()),
        ("POST", "/v1/ssh/this/beat") => (200, r#"{"on":true}"#.into()),
        (_, "/v1/ssh/this") => (200, "{}".into()),
        _ => (404, r#"{"error":"Not found"}"#.into()),
    });
    home.signed_in(&remote.url);
    let port = free_port();
    let mut serve = home.command("en", &["address", "ssh", "serve"]).env("LENGTH3_SSH_PORT", port.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut ready = String::new();
    std::io::BufReader::new(serve.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    let control = home.path("control");
    let ssh = |extra: &[&str]| {
        let mut c = Command::new("ssh");
        c.args(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes",
            "-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", "LogLevel=ERROR"])
            .arg("-o").arg(format!("ControlPath={}", control.display())).arg("-i").arg(&key).args(["-p", &port.to_string()]).args(extra)
            .env("HOME", &home.dir).stdin(Stdio::null());
        c.output().unwrap()
    };
    // Each session runs its command by `l3 prompt` in notes, on the test's root, and ends with the command's code.
    let mut codes = Vec::new();
    for _ in 0..6 { codes.push(ssh(&["notes@127.0.0.1", "exit 3"]).status.code()); }
    let _ = ssh(&["-O", "exit", "notes@127.0.0.1"]);
    let _ = serve.kill();
    let _ = serve.wait();
    let log = std::fs::read_to_string(home.path("ssh/log")).unwrap_or_default();
    assert_eq!(codes, vec![Some(3); 6], "{log}");
    // More than CHANNELS (4), one after another, all on the one connection (bug: every session ever opened
    // counted, so the fifth was refused there, and the client signed in anew for each one after).
    assert_eq!(log.matches(" in as notes ").count(), 1, "{log}");
    assert_eq!(log.matches("session notes: ended 3").count(), 6, "{log}");
}
