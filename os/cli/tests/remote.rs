//! l3 against a Remote of the test's own, which answers what a real one
//! would not (a captive portal's page, a shape it does not know, another
//! account's repos): whatever comes back, nothing here is lost by it.

mod common;
use common::{FakeRemote, Home};

fn sha(text: &str) -> String {
    length3_core::remote::sha256(text.as_bytes())
}

const NOT_FOUND: (u16, &str) = (404, r#"{"error":"Not found"}"#);

#[test]
fn an_answer_that_is_not_a_repo_leaves_the_copy_here_as_it_is() {
    // A Wi-Fi sign-in page, an empty object, a version that is text, a draft that is not a tree: each was read
    // as a repo at version 0 with no files, and every file unchanged since the last agreement was removed here.
    for said in ["<html>Sign in to the Wi-Fi</html>", "{}", r#"{"version":"4","draft":{}}"#, r#"{"version":4,"draft":null,"head":null}"#] {
        let remote = FakeRemote::start(move |a| {
            if a.method == "GET" && a.route() == "/v1/repos/notes" { (200, said.to_string()) } else { (NOT_FOUND.0, NOT_FOUND.1.to_string()) }
        });
        let home = Home::new("odd-answer");
        home.signed_in(&remote.url);
        home.repo("notes", &[("a.txt", "kept\n")]);
        let agreed = format!(r#"{{"version":3,"tree":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n"));
        home.agreed("notes", &agreed);
        let ran = home.run("en", &["file", "notes"]);
        assert!(home.path("repos/notes/a.txt").exists(), "{said}: a.txt was removed\n{ran:?}");
        assert_eq!(std::fs::read_to_string(home.path("sync/notes.json")).unwrap(), agreed, "{said}: what was agreed changed");
        assert!(ran.stderr.contains("did not answer as a Remote does"), "{said}: {ran:?}");
        // Nothing was sent on the strength of it.
        assert!(!remote.said().iter().any(|s| s.starts_with("PATCH")), "{said}: {:?}", remote.said());
    }
}

/// A Remote that approves every device code at once as the account `user` (token "new"), knows no session
/// but that one, holds no repo until notes is sent, and takes whatever is sent.
fn approving(user: &'static str) -> FakeRemote {
    let url = std::sync::Arc::new(std::sync::OnceLock::<String>::new());
    let at = url.clone();
    let notes = std::sync::Mutex::new(None::<String>);
    let remote = FakeRemote::start(move |a| {
        let page = format!("{}/?device=&user_code=ABCD", at.get().map_or("", String::as_str));
        match (a.method.as_str(), a.route()) {
            ("POST", "/api/auth/device/code") => (200, format!(r#"{{"device_code":"d","user_code":"ABCD","verification_uri":"{page}","verification_uri_complete":"{page}","interval":1,"expires_in":60}}"#)),
            ("POST", "/api/auth/device/token") => (200, r#"{"access_token":"new"}"#.into()),
            ("GET", "/api/auth/get-session") if a.auth.as_deref() == Some("Bearer new") => (200, format!(r#"{{"user":{{"id":"{user}","name":"{user}"}}}}"#)),
            ("GET", "/api/auth/get-session") => (401, r#"{"error":"Unauthorized"}"#.into()),
            ("POST", "/v1/blobs/missing") => (200, a.text()),
            ("PUT", p) if p.starts_with("/v1/blobs/") => (200, "{}".into()),
            ("PATCH", "/v1/repos/notes/draft") => {
                let set = serde_json::from_str::<serde_json::Value>(&a.text()).unwrap()["set"].to_string();
                *notes.lock().unwrap() = Some(format!(r#"{{"version":1,"draft":{set},"head":null}}"#));
                (200, r#"{"version":1}"#.into())
            }
            ("GET", "/v1/repos/notes") if notes.lock().unwrap().is_some() => (200, notes.lock().unwrap().clone().unwrap()),
            ("GET", "/v1/repos") => (200, "[]".into()),
            _ => (NOT_FOUND.0, NOT_FOUND.1.to_string()),
        }
    });
    url.set(remote.url.clone()).unwrap();
    remote
}

/// A home with the repo notes (a.txt) agreed at version 3 with the session `remote.json` names.
fn agreed_home(name: &str, remote_json: &str) -> Home {
    let home = Home::new(name);
    std::fs::create_dir_all(home.path("home")).unwrap();
    std::fs::write(home.path("home/remote.json"), remote_json).unwrap();
    home.repo("notes", &[("a.txt", "kept\n")]);
    home.agreed("notes", &format!(r#"{{"version":3,"tree":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n")));
    home
}

#[test]
fn signing_in_as_another_account_or_on_another_remote_never_takes_the_last_ones_copy_apart() {
    // Kept, the last one's base was taken for what this one agreed, and every file it held that this one
    // does not (all of them: this account has never seen notes) was removed here as if removed there.
    for (case, was) in [("another account", r#"{"url":"URL","token":"test-token","user":"u1"}"#), ("another Remote", r#"{"url":"http://127.0.0.1:9","token":"test-token"}"#)] {
        let remote = approving("u2");
        let home = agreed_home("another-account", &was.replace("URL", &remote.url));
        let ran = home.run("en", &["login", &remote.url]);
        assert_eq!(ran.code, 0, "{case}: {ran:?}");
        assert!(home.path("repos/notes/a.txt").exists(), "{case}: a.txt was removed\n{ran:?}");
        let sent = remote.asked.lock().unwrap().iter().find(|a| a.method == "PATCH").map(|a| a.text()).unwrap_or_default();
        if case == "another account" {
            // The last account's copy stays theirs: never sent into this account's repo of the same name.
            assert!(sent.is_empty(), "{case}: {sent}");
            let agreed = std::fs::read_to_string(home.path("sync/notes.json")).unwrap();
            assert!(agreed.contains("\"who\":\"u1\""), "{case}: {agreed}");
        } else {
            // Another Remote: it goes there as new.
            assert!(sent.contains("\"a.txt\"") && sent.contains("\"version\":0"), "{case}: {sent}");
        }
        let kept = std::fs::read_to_string(home.path("home/remote.json")).unwrap();
        assert!(kept.contains("\"token\":\"new\"") && kept.contains("\"user\":\"u2\""), "{case}: {kept}");
    }
}

#[test]
fn an_answer_larger_than_any_a_remote_gives_is_refused_not_held() {
    // ureq's into_json read without end: an answer that never stops was held in memory until there was none.
    let remote = FakeRemote::start(|a| match a.path.as_str() {
        "/v1/repos" => (200, format!("[{}\"x\"]", "\"x\",".repeat((256 << 20) / 4 + 1))),
        _ => (NOT_FOUND.0, NOT_FOUND.1.to_string()),
    });
    let home = Home::new("endless");
    home.signed_in(&remote.url);
    let ran = home.run("en", &["remote", "on", "notes"]);
    assert_eq!(ran.code, 3, "{ran:?}");
    assert!(ran.stderr.contains("did not answer as a Remote does"), "{ran:?}");
}

#[test]
fn what_a_remote_says_when_it_refuses_reaches_the_terminal_as_words_only() {
    // Its `error` was printed as it came: ESC ] retitles the window, ESC [ moves the cursor over what was said.
    let remote = FakeRemote::start(|_| (403, "{\"error\":\"no\\u001b]0;pwned\\u0007\\u001b[2J\"}".into()));
    let home = Home::new("refusal-words");
    home.signed_in(&remote.url);
    let ran = home.run("en", &["remote", "on", "notes"]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("no\u{FFFD}]0;pwned") && !ran.stderr.contains('\u{1b}'), "{ran:?}");
}

/// A Remote that discarded the repo notes: it takes it again only as new (?anew=1), and then holds it.
fn discarded() -> FakeRemote {
    let held = std::sync::Mutex::new(None::<String>);
    FakeRemote::start(move |a| match (a.method.as_str(), a.path.as_str()) {
        ("GET", _) if a.route() == "/v1/repos/notes" => match held.lock().unwrap().clone() {
            Some(line) => (200, line),
            None => (404, r#"{"error":"That repo is not on the Remote","gone":1}"#.into()),
        },
        ("POST", "/v1/blobs/missing") => (200, "[]".into()),
        ("PATCH", "/v1/repos/notes/draft?anew=1") => {
            let set = serde_json::from_str::<serde_json::Value>(&a.text()).unwrap()["set"].to_string();
            *held.lock().unwrap() = Some(format!(r#"{{"version":1,"draft":{set},"head":null}}"#));
            (200, r#"{"version":1}"#.into())
        }
        ("PATCH", _) => (410, r#"{"error":"This repo was discarded on the Remote.","gone":1}"#.into()),
        _ => (NOT_FOUND.0, NOT_FOUND.1.to_string()),
    })
}

#[test]
fn a_repo_made_here_under_a_name_the_remote_discarded_goes_there_as_new() {
    // Never in step with the Remote, it asks to be taken as new (bug: l3 never did, so it was refused for good
    // and told to turn on a repo that could not be).
    let remote = discarded();
    let home = Home::new("discarded-fresh");
    home.signed_in(&remote.url);
    home.repo("notes", &[("a.txt", "mine\n")]);
    let ran = home.run("en", &["file", "notes"]);
    assert_eq!((ran.code, ran.stderr.as_str()), (0, ""), "{ran:?}");
    assert!(remote.said().contains(&"PATCH /v1/repos/notes/draft?anew=1".to_string()), "{:?}", remote.said());
    assert!(home.path("repos/notes/a.txt").exists());
    // A copy that was in step does not ask so, nor is it taken apart: what was discarded stays discarded there.
    let remote = discarded();
    let home = Home::new("discarded-agreed");
    home.signed_in(&remote.url);
    home.repo("notes", &[("a.txt", "mine\n"), ("b.txt", "changed here\n")]);
    home.agreed("notes", &format!(r#"{{"version":3,"tree":{{"a.txt":"{}","b.txt":"{}"}},"head":null}}"#, sha("mine\n"), sha("b\n")));
    let ran = home.run("en", &["file", "notes"]);
    assert!(ran.stderr.contains("Repo deleted on Remote; local copy preserved") && !ran.stderr.contains("l3 remote on"), "{ran:?}");
    assert!(home.path("repos/notes/a.txt").exists() && home.path("repos/notes/b.txt").exists(), "the copy here is kept");
    assert!(!remote.said().iter().any(|s| s.contains("anew") || s.starts_with("PATCH")), "{:?}", remote.said());
}

#[test]
fn a_page_to_approve_on_that_the_remote_does_not_stand_behind_is_never_shown() {
    let remote = FakeRemote::start(|a| match a.path.as_str() {
        "/api/auth/device/code" => (200, r#"{"device_code":"d","user_code":"ABCD","verification_uri":"https://evil.example/","verification_uri_complete":"https://evil.example/?user_code=ABCD","interval":1,"expires_in":60}"#.into()),
        _ => (NOT_FOUND.0, NOT_FOUND.1.to_string()),
    });
    let home = Home::new("evil-page");
    let ran = home.run("en", &["login", &remote.url]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(!ran.stdout.contains("evil.example") && ran.stderr.contains("not its own"), "{ran:?}");
    assert!(!remote.said().iter().any(|s| s.contains("/device/token")), "{:?}", remote.said());
}

#[test]
fn signing_in_again_where_the_session_is_alive_changes_nothing() {
    let remote = approving("u1");
    let home = agreed_home("login-again", &format!(r#"{{"url":"{}","token":"new","user":"u1"}}"#, remote.url));
    let ran = home.run("en", &["login", &remote.url]);
    assert_eq!((ran.code, ran.stdout.as_str()), (0, &*format!("Signed in already · {} as u1\n", remote.url.trim_start_matches("http://"))), "{ran:?}");
    assert!(!remote.said().iter().any(|s| s.contains("/device/")), "no new session was asked for: {:?}", remote.said());
    // On another Remote, it is refused, and the session here stays.
    let ran = home.run("en", &["login", "http://127.0.0.1:9"]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("l3 logout first"), "{ran:?}");
    assert!(std::fs::read_to_string(home.path("home/remote.json")).unwrap().contains("\"token\":\"new\""));
    assert!(home.path("sync/notes.json").exists());
}

/// What a writer here did while Free ran: each file it wrote by its name and was told was written.
type Wrote = std::sync::Arc<std::sync::Mutex<Vec<(std::path::PathBuf, String)>>>;

/// A Remote holding notes at version 1 (a.txt as `kept`), taking nothing sent; at its `at`'th answer of the
/// line's draft (1: the sync's, 2: Free's last ask, after the copy is checked), a writer here begins to write
/// new files into the repo by their names for a while, as an editor saves, and the answer waits on it a little.
fn holding_notes(home: &Home, at: usize, wrote: &Wrote) -> (FakeRemote, std::sync::Arc<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>>) {
    let draft = format!(r#"{{"version":1,"draft":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n"));
    let asked = std::sync::atomic::AtomicUsize::new(0);
    let writer = std::sync::Arc::new(std::sync::Mutex::new(None));
    let (w, wrote, repo) = (writer.clone(), wrote.clone(), home.path("repos/notes"));
    let remote = FakeRemote::start(move |a| match (a.method.as_str(), a.route()) {
        ("GET", "/v1/repos") => (200, r#"[{"name":"notes","head":null,"version":1,"bytes":5,"updatedAt":"x"}]"#.into()),
        ("GET", "/v1/repos/notes") => {
            if asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == at {
                let (wrote, repo) = (wrote.clone(), repo.clone());
                *w.lock().unwrap() = Some(std::thread::spawn(move || {
                    let end = std::time::Instant::now() + std::time::Duration::from_millis(400);
                    let mut n = 0;
                    while std::time::Instant::now() < end {
                        let (path, text) = (repo.join(format!("late-{n}.txt")), format!("late {n}\n"));
                        if std::fs::write(&path, &text).is_ok() { wrote.lock().unwrap().push((path, text)); }
                        n += 1;
                        std::thread::yield_now();
                    }
                }));
                // The writer is under way while Free waits for this answer.
                let begun = std::time::Instant::now();
                while begun.elapsed() < std::time::Duration::from_millis(100) { std::thread::yield_now(); }
            }
            (200, draft.clone())
        }
        _ => (NOT_FOUND.0, NOT_FOUND.1.to_string()),
    });
    (remote, writer)
}

#[test]
fn bytes_written_while_free_runs_are_kept_here_or_never_written_and_never_freed_into_nowhere() {
    for at in [1, 2] {
        let home = Home::new(&format!("free-late-{at}"));
        home.repo("notes", &[("a.txt", "kept\n")]);
        home.agreed("notes", &format!(r#"{{"version":1,"tree":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n")));
        let wrote: Wrote = Default::default();
        let (remote, writer) = holding_notes(&home, at, &wrote);
        home.signed_in(&remote.url);
        let ran = home.run("en", &["free", "notes"]);
        if let Some(w) = writer.lock().unwrap().take() { w.join().unwrap(); }
        let wrote = wrote.lock().unwrap();
        // Whatever the writer was told it wrote is here, byte for byte: the Remote took none of it.
        for (path, text) in wrote.iter() {
            assert_eq!(std::fs::read_to_string(path).ok().as_deref(), Some(text.as_str()), "at {at}: {} was lost; {ran:?}", path.display());
        }
        if !wrote.is_empty() { assert_ne!(ran.code, 0, "at {at}: freed over late bytes: {ran:?}"); }
        if ran.code == 0 {
            assert!(!home.path("repos/notes").exists(), "at {at}: {ran:?}");
        } else {
            assert_eq!(std::fs::read_to_string(home.path("repos/notes/a.txt")).unwrap(), "kept\n", "at {at}: {ran:?}");
            assert!(std::fs::read_dir(home.path("repos")).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("freeing")), "at {at}: a copy was left aside");
        }
        // Once the copy is moved aside, a write by its name cannot land anywhere Free lets go: it fails, and is told.
        if at == 2 { assert!(wrote.is_empty() && ran.code == 0, "{ran:?} {wrote:?}"); }
    }
}

#[test]
fn a_repo_a_program_holds_open_is_not_freed_and_what_it_writes_after_stays() {
    use std::io::Write;
    let home = Home::new("free-held");
    home.repo("notes", &[("a.txt", "kept\n")]);
    home.agreed("notes", &format!(r#"{{"version":1,"tree":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n")));
    let (remote, _) = holding_notes(&home, usize::MAX, &Default::default());
    home.signed_in(&remote.url);
    // Open for writing before Free begins, as an editor or a log holds a file: it could write on after any check.
    let mut held = std::fs::OpenOptions::new().append(true).open(home.path("repos/notes/a.txt")).unwrap();
    let ran = home.run("en", &["free", "notes"]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("is open in pid") && ran.stderr.contains("kept here"), "{ran:?}");
    held.write_all(b"after\n").unwrap();
    drop(held);
    assert_eq!(std::fs::read_to_string(home.path("repos/notes/a.txt")).unwrap(), "kept\nafter\n");
}

#[test]
fn an_execute_bit_a_remote_cannot_keep_is_said_and_its_last_copy_is_not_freed() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new("free-mode");
    home.repo("notes", &[("a.txt", "kept\n")]);
    home.agreed("notes", &format!(r#"{{"version":1,"tree":{{"a.txt":"{}"}},"head":null}}"#, sha("kept\n")));
    std::fs::set_permissions(home.path("repos/notes/a.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
    // A Remote from before modes were kept: its line says none.
    let (remote, _) = holding_notes(&home, usize::MAX, &Default::default());
    home.signed_in(&remote.url);
    let ran = home.run("en", &["repo", "--json"]);
    assert!(ran.stdout.contains("\"unsendable\": [\n        \"a.txt\"\n      ]"), "{ran:?}");
    let ran = home.run("en", &["free", "notes"]);
    assert_eq!(ran.code, 1, "{ran:?}");
    assert!(ran.stderr.contains("execute bit"), "{ran:?}");
    assert_eq!(std::fs::metadata(home.path("repos/notes/a.txt")).unwrap().permissions().mode() & 0o777, 0o755);
}
