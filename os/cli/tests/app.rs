//! `l3 app`: the desktop app opened from the command line. The help leads
//! to it; the one open is brought forward and never a second started; a
//! device without it is told where to get it (exit 4); a start that fails
//! or never answers is never said as open; closing closes only the app.
//! The app here is the test's own: a program that notes it was started,
//! and a socket answering as the app answers (core/src/desktop.rs).

mod common;
use common::{Home, Ran};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// l3 with `args` off a terminal, `env` over this home's, PATH holding nothing (no app is on it).
fn run(home: &Home, args: &[&str], env: &[(&str, &str)]) -> Ran {
    let empty = home.path("empty-bin");
    std::fs::create_dir_all(&empty).unwrap();
    let mut c = home.command("en", args);
    c.env("PATH", &empty).stdin(std::process::Stdio::null());
    for (k, v) in env { c.env(k, v); }
    let out = c.output().expect("l3 runs");
    Ran { code: out.status.code().unwrap_or(-1), stdout: home.shown(&out.stdout), stderr: home.shown(&out.stderr) }
}

/// A program standing in for the app: `body` after it notes in `started` that it ran.
fn program(home: &Home, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let at = home.path("fake-app");
    // The shell's own words alone: l3 runs it with a PATH that holds nothing.
    std::fs::write(&at, format!("#!/bin/sh\n: > \"{}\"\n{body}\n", home.path("started").display())).unwrap();
    std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
    at
}

/// The app open, as l3 reaches it: a socket in the app's folder answering each word as the app does, and keeping
/// the words. `close` closes it (its socket goes, and nothing answers after).
fn open_app(data: &Path) -> Arc<Mutex<Vec<String>>> {
    let dir = length3_core::desktop::dir(data);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("socket");
    let listener = UnixListener::bind(&socket).unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let kept = asked.clone();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let mut word = String::new();
            let _ = BufReader::new(&s).read_line(&mut word);
            let word = word.trim().to_string();
            kept.lock().unwrap().push(word.clone());
            let said = match word.as_str() { "here" => "here", "show" => "shown", "close" => "closing", _ => "?" };
            let _ = (&s).write_all(format!("{said}\n").as_bytes());
            if word == "close" { let _ = std::fs::remove_file(&socket); return; }
        }
    });
    asked
}

fn wait_for(path: &Path) -> bool {
    let end = Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        if Instant::now() > end { return false; }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

#[test]
fn the_help_leads_to_the_app() {
    let home = Home::new("app-help");
    for lang in ["en", "ja"] {
        let help = home.run(lang, &["help"]);
        assert_eq!(help.code, 0, "{help:?}");
        // Listed with Runtime's commands, and said in a line of its own: how to open it and how to close it.
        let runtime = help.stdout.split("\nRuntime\n").nth(1).and_then(|r| r.split("\n\n").next()).unwrap_or_default();
        assert!(runtime.lines().any(|l| l.trim_start().starts_with("app ")), "{lang}: {}", help.stdout);
        let line = help.stdout.lines().find(|l| l.starts_with("App ") || l.starts_with("アプリ ")).unwrap_or_default();
        assert!(line.contains("l3 app ") && line.contains("l3 app close"), "{lang}: {}", help.stdout);
        let forms = home.run(lang, &["help", "app"]);
        assert!(forms.stdout.lines().any(|l| l.trim_start().starts_with("l3 app ") || l.trim() == "l3 app"), "{lang}: {}", forms.stdout);
        assert!(forms.stdout.contains("l3 app close"), "{lang}: {}", forms.stdout);
        // What a person is told never has them build anything.
        for never in ["cargo", "npm", "vite"] { assert!(!help.stdout.contains(never) && !forms.stdout.contains(never), "{lang}: {never}"); }
    }
}

#[test]
fn without_the_app_it_says_where_to_get_it_and_exits_4() {
    let home = Home::new("app-none");
    let ran = run(&home, &["app"], &[("DISPLAY", ":0")]);
    assert_eq!(ran.code, 4, "{ran:?}");
    assert!(ran.stdout.is_empty(), "{ran:?}");
    assert!(ran.stderr.contains("not on this device"), "{ran:?}");
    // The Remote's copy of this release's files, and what to do with each.
    assert!(ran.stderr.contains("http://127.0.0.1:9/v1/desktop/os-length3-linux-") && ran.stderr.contains("-desktop-amd64.deb"), "{ran:?}");
    assert!(ran.stderr.contains("sudo apt install ./os-length3-linux-") && ran.stderr.contains("AppImage"), "{ran:?}");
    for never in ["cargo", "npm", "vite"] { assert!(!ran.stderr.contains(never), "{never}: {ran:?}"); }
    let json = run(&home, &["app", "--json"], &[]);
    assert_eq!(json.code, 4, "{json:?}");
    let v: serde_json::Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(v["error"]["kind"], "notFound");
    // An AppImage downloaded but not yet allowed to run is found, and said so.
    let apps = home.path("Applications");
    std::fs::create_dir_all(&apps).unwrap();
    std::fs::write(apps.join("os-length3-linux-0.4.1-desktop-x86_64.AppImage"), "").unwrap();
    let ran = run(&home, &["app"], &[("DISPLAY", ":0")]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("chmod +x $HOME/Applications/os-length3-linux-0.4.1-desktop-x86_64.AppImage"), "{ran:?}");
}

#[test]
fn the_app_open_is_brought_forward_and_no_second_is_started() {
    let home = Home::new("app-open");
    let asked = open_app(&home.dir);
    let fake = program(&home, "");
    for args in [&["app"][..], &["app", "--json"]] {
        let ran = run(&home, args, &[("LENGTH3_APP", fake.to_str().unwrap()), ("DISPLAY", ":0")]);
        assert_eq!(ran.code, 0, "{ran:?}");
        if args.len() == 1 { assert!(ran.stdout.contains("open already") && ran.stdout.contains("no second"), "{ran:?}"); }
        else { assert_eq!(serde_json::from_str::<serde_json::Value>(&ran.stdout).unwrap()["started"], false, "{ran:?}"); }
    }
    assert!(!home.path("started").exists(), "a second app was started");
    assert_eq!(*asked.lock().unwrap(), ["show", "show"]);
}

#[test]
fn a_start_that_fails_or_cannot_show_a_window_is_never_said_as_open() {
    let home = Home::new("app-fails");
    let fake = program(&home, "exit 3");
    let ran = run(&home, &["app"], &[("LENGTH3_APP", fake.to_str().unwrap()), ("DISPLAY", ":0")]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stdout.is_empty() && ran.stderr.contains("could not start") && ran.stderr.contains("nothing is open"), "{ran:?}");
    assert!(home.path("started").exists());
    // No screen to show a window on: said before anything is started.
    std::fs::remove_file(home.path("started")).unwrap();
    let ran = run(&home, &["app"], &[("LENGTH3_APP", fake.to_str().unwrap())]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("no screen"), "{ran:?}");
    assert!(!home.path("started").exists());
    // Named where nothing is: not on this device, and where to get it.
    let ran = run(&home, &["app"], &[("LENGTH3_APP", "/nowhere/length3-os"), ("DISPLAY", ":0")]);
    assert_eq!(ran.code, 4, "{ran:?}");
    assert!(ran.stderr.contains("/nowhere/length3-os") && ran.stderr.contains("/v1/desktop/"), "{ran:?}");
}

#[test]
fn a_started_app_is_said_open_once_it_answers() {
    let home = Home::new("app-starts");
    // The app as it starts: running on its own, and answering a moment later.
    let sleep = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|d| d.join("sleep")).find(|p| p.is_file()).expect("a sleep");
    let fake = program(&home, &format!("exec {} 30", sleep.display()));
    let marker = home.path("started");
    let data = home.dir.clone();
    let answering = std::thread::spawn(move || wait_for(&marker).then(|| open_app(&data)));
    let ran = run(&home, &["app", "--json"], &[("LENGTH3_APP", fake.to_str().unwrap()), ("DISPLAY", ":0")]);
    let asked = answering.join().unwrap();
    let v: serde_json::Value = serde_json::from_str(&ran.stdout).unwrap_or_default();
    if let Some(pid) = v["pid"].as_i64() { unsafe { libc::kill(pid as i32, libc::SIGTERM) }; }
    assert_eq!(ran.code, 0, "{ran:?}");
    assert_eq!((v["open"].as_bool(), v["started"].as_bool()), (Some(true), Some(true)), "{ran:?}");
    // It was asked whether it is here, never told to show a window it had just opened.
    assert!(asked.unwrap().lock().unwrap().iter().all(|w| w == "here"));
}

#[test]
fn closing_closes_the_app_alone() {
    let home = Home::new("app-close");
    let ran = run(&home, &["app", "close"], &[]);
    assert_eq!((ran.code, ran.stdout.trim()), (0, "The app was not open"), "{ran:?}");
    let asked = open_app(&home.dir);
    let ran = run(&home, &["app", "close"], &[]);
    assert_eq!(ran.code, 0, "{ran:?}");
    assert!(ran.stdout.contains("Closed the app") && ran.stdout.contains("goes on"), "{ran:?}");
    assert_eq!(asked.lock().unwrap().first().map(String::as_str), Some("close"));
}
