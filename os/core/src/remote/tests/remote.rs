//! The tests of /remote.rs.

use super::*;

#[test]
fn a_remote_that_holds_no_files_says_the_work_stays_here() {
    let said = |code: u16, body: &str| http::refused(code, body.as_bytes());
    let no_files = said(503, r#"{"error":"Remote cannot store files right now","files":false}"#);
    assert!(no_files == "Remote cannot accept files right now; changes stay on this device"
        || no_files == "Remote はいまファイルを置けません。作業はこの端末に残ります", "{no_files}");
    // Any other 503 (its database out of reach) is said as the Remote says it.
    assert!(said(503, r#"{"error":"Remote cannot reach its database"}"#).contains("Remote cannot reach its database"));
}

fn t(pairs: &[(&str, Option<&str>)]) -> Tree {
    pairs.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect()
}

#[test]
fn only_their_changes_are_taken_and_a_file_changed_on_both_keeps_both() {
    let base = t(&[("a", Some("1")), ("b", Some("1")), ("c", Some("1")), ("gone", Some("1")), ("edited", Some("1"))]);
    let here = t(&[("a", Some("2")), ("b", Some("1")), ("c", Some("x")), ("gone", Some("1")), ("new", Some("n"))]);
    let there = t(&[("a", Some("1")), ("b", Some("3")), ("c", Some("y")), ("dir", None), ("edited", Some("2"))]);
    let p = plan(&base, &here, &there);
    // Removed here but changed there: the change comes back.
    assert_eq!(p.take, vec![("b".into(), Some(Some("3".into()))), ("dir".into(), Some(None)), ("edited".into(), Some(Some("2".into()))), ("gone".into(), None)]);
    assert_eq!(p.both, vec![("c".into(), Some("y".into()))]);
}

#[test]
fn only_a_line_as_the_remote_answers_it_is_taken() {
    let url = "https://os.length3.com";
    let ok = serde_json::json!({"version": 3, "draft": {"a.txt": "ab", "dir": null}, "head": "c1", "updatedAt": 1});
    assert_eq!(line_there(url, &ok, None).unwrap(), LineThere { version: 3, draft: t(&[("a.txt", Some("ab")), ("dir", None)]), head: Some("c1".into()), modes: None });
    // A Remote that keeps modes says them; only its files' are taken, and only as permission bits.
    let moded = serde_json::json!({"version": 3, "draft": {"run.sh": "ab", "dir": null}, "head": null, "modes": {"run.sh": 493, "dir": 493, "gone": 493}});
    assert_eq!(line_there(url, &moded, None).unwrap().modes, Some(Modes::from([("run.sh".to_string(), 0o755)])));
    for odd in [serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": []}), serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": {"a": "755"}}),
        serde_json::json!({"version": 3, "draft": {}, "head": null, "modes": {"a": 0o4755}})] {
        assert!(line_there(url, &odd, None).is_err(), "{odd}");
    }
    assert_eq!(line_there(url, &serde_json::json!({"version": 0, "draft": {}, "head": null}), None).unwrap().head, None);
    for odd in [serde_json::Value::Null, serde_json::json!({}), serde_json::json!({"version": "3", "draft": {}, "head": null}),
        serde_json::json!({"version": 3, "draft": null, "head": null}), serde_json::json!({"version": 3, "draft": {"a": 1}, "head": null}),
        serde_json::json!({"version": -1, "draft": {}, "head": null}), serde_json::json!({"version": 3, "draft": {}, "head": 7})] {
        assert!(line_there(url, &odd, None).is_err(), "{odd}");
    }
}

#[test]
fn what_a_remote_says_of_its_code_never_makes_the_wait_overflow_or_last_for_ever() {
    let code = |interval: u64, expires_in: u64| DeviceCode { device_code: "d".into(), user_code: "U".into(), verification_uri: String::new(),
        verification_uri_complete: String::new(), interval, expires_in };
    assert_eq!(polling(&code(5, 900)), (Duration::from_secs(900), Duration::from_secs(5)));
    assert_eq!(polling(&code(0, 0)), (Duration::from_secs(60), Duration::from_secs(1)));
    let (wait, step) = polling(&code(u64::MAX, u64::MAX));
    assert_eq!((wait, step), (Duration::from_secs(1800), Duration::from_secs(60)));
    // What panicked before: a deadline that far out.
    assert!(std::time::Instant::now().checked_add(Duration::from_secs(u64::MAX)).is_none());
    let _ = std::time::Instant::now() + wait;
}

#[test]
fn a_session_is_another_on_another_remote_or_for_another_account() {
    let was = |user: Option<&str>| Connection { url: DEFAULT_URL.into(), session: "t".into(), user: user.map(String::from) };
    assert!(!another(&was(Some("u1")), DEFAULT_URL, Some("u1")));
    assert!(another(&was(Some("u1")), DEFAULT_URL, Some("u2")));
    assert!(another(&was(Some("u1")), "http://127.0.0.1:8787", Some("u1")));
    assert!(another(&was(None), "http://127.0.0.1:8787", None));
    // Whose either is cannot be told: the same account.
    assert!(!another(&was(None), DEFAULT_URL, Some("u2")));
    assert!(!another(&was(Some("u1")), DEFAULT_URL, None));
    // A session kept without an account reads as before; one with it keeps it. Kept, it says which session, never
    // what proves it.
    let old: KeptBefore = serde_json::from_str(r#"{"url":"https://os.length3.com","token":"t.sig"}"#).unwrap();
    assert_eq!((old.user, old.token.as_deref()), (None, Some("t.sig")));
    assert_eq!(serde_json::to_string(&was(None)).unwrap(), r#"{"url":"https://os.length3.com","session":"t"}"#);
}

#[test]
fn a_copy_in_step_is_not_taken_apart_by_a_remote_without_it() {
    let url = "https://os.length3.com";
    // Never in step: the Remote's empty, and all here is new.
    assert_eq!(there_of(url, Reply::NotFound(Default::default()), 0, None), Ok(None));
    // In step before: not taken for removed there, and said.
    assert!(there_of(url, Reply::NotFound(serde_json::json!({"gone": 1})), 3, None).is_err_and(|e| e.contains("deleted") || e.contains("破棄")));
    assert!(there_of(url, Reply::NotFound(Default::default()), 3, None).is_err_and(|e| e.contains("not found on Remote") || e.contains("見つかりません")));
    let line = serde_json::json!({"version": 3, "draft": {}, "head": null});
    assert_eq!(there_of(url, Reply::Ok(line), 3, None), Ok(Some(LineThere { version: 3, draft: Tree::new(), head: None, modes: None })));
}

#[test]
fn what_changed_since_the_version_agreed_is_laid_on_what_was_agreed_in_turn() {
    let url = "https://os.length3.com";
    let agreed = t(&[("a.txt", Some("1")), ("dir/b.txt", Some("2")), ("dir/c/d.txt", Some("3")), ("dirt.txt", Some("4"))]);
    let said = serde_json::json!({"version": 5, "head": null, "modes": {"new.sh": 493, "gone.sh": 493}, "changes": [
        {"set": {"a.txt": "9"}, "remove": []},
        {"set": {"new.sh": "7", "empty": null}, "remove": ["dir"]},
    ]});
    let line = line_there(url, &said, Some(&agreed)).unwrap();
    // A folder taken away goes with all under it, and nothing beside it of a name that begins the same.
    assert_eq!(line.draft, t(&[("a.txt", Some("9")), ("dirt.txt", Some("4")), ("empty", None), ("new.sh", Some("7"))]));
    assert_eq!(line.modes, Some(Modes::from([("new.sh".to_string(), 0o755)])));
    // Nothing since: what was agreed. Without it to lay them on, or a change not of the Remote's form: refused.
    assert_eq!(line_there(url, &serde_json::json!({"version": 3, "head": null, "changes": []}), Some(&agreed)).unwrap().draft, agreed);
    assert!(line_there(url, &said, None).is_err());
    assert!(line_there(url, &serde_json::json!({"version": 5, "head": null, "changes": [{"set": {"a": 1}, "remove": []}]}), Some(&agreed)).is_err());
}

#[test]
fn a_copy_never_in_step_is_sent_as_a_new_repo() {
    assert!(draft_path("notes", crate::repos::lines::MAIN, false).ends_with("/draft?anew=1"));
    assert!(draft_path("notes", crate::repos::lines::MAIN, true).ends_with("/draft"));
    assert_eq!(draft_path("notes", "001", false), "/v1/repos/notes/draft?line=001");
}

#[test]
fn the_other_devices_version_goes_beside_it() {
    assert_eq!(beside("README.md"), "README (other device).md");
    assert_eq!(beside("src/main.c"), "src/main (other device).c");
    assert_eq!(beside("Makefile"), "Makefile (other device)");
    assert_eq!(beside(".env"), ".env (other device)");
    assert_eq!(beside_as("docs/plan.md", "ren-laptop", 1), "docs/plan (ren-laptop).md");
    assert_eq!(beside_as("Makefile", "ren-laptop", 2), "Makefile (ren-laptop 2)");
    assert_eq!(tag_of("ren's laptop/../x"), "ren s laptop .. x");
    assert_eq!(tag_of(""), "this device");
}

#[test]
fn a_link_planted_where_a_file_is_written_is_not_written_through() {
    let d = crate::fs::testing::dir("length3-plant");
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join("repo")).unwrap();
    let outside = d.join("outside.txt");
    fs::write(&outside, "the person's own file").unwrap();
    let pid = std::process::id();
    // Where the writer used to put its temporary, and where it puts it now.
    std::os::unix::fs::symlink(&outside, d.join(format!("repo/.length3-{pid}-a.txt"))).unwrap();
    for n in 0..8 { std::os::unix::fs::symlink(&outside, d.join(format!("repo/.a.txt.length3-{pid}-{n}"))).unwrap(); }
    write_file(&d.join("repo/a.txt"), b"from the Remote").unwrap();
    assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own file");
    assert_eq!(fs::read_to_string(d.join("repo/a.txt")).unwrap(), "from the Remote");
    // A link at the file's own name is refused, not followed.
    std::os::unix::fs::symlink(&outside, d.join("repo/b.txt")).unwrap();
    assert!(write_file(&d.join("repo/b.txt"), b"x").is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "the person's own file");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn a_remote_is_named_by_an_http_url() {
    for ok in ["http://127.0.0.1:8787", "https://os.length3.com", "https://r.example/x"] { assert!(valid_url(ok), "{ok}"); }
    for bad in ["nonsense", "ftp://x", "https://", "http:// x", "os.length3.com"] { assert!(!valid_url(bad), "{bad}"); }
}

#[test]
fn the_remote_this_os_ships_with_is_os_length3_com_and_its_former_name_is_taken_to_it() {
    assert_eq!(DEFAULT_URL, "https://os.length3.com");
    assert!(valid_url(DEFAULT_URL));
    // A device that signed in by the former name (0.4.x) goes on with the same session on the one name.
    for former in ["https://remote.length3.com", "https://remote.length3.com/", "https://Remote.Length3.com"] { assert_eq!(current_url(former), DEFAULT_URL, "{former}"); }
    // Anything else is left as it is: another Remote, a path under the former name, plain http.
    for other in ["https://os.length3.com", "http://127.0.0.1:8787", "https://r.example/x", "https://remote.length3.com/x", "http://remote.length3.com"] {
        assert_eq!(current_url(other), other.trim_end_matches('/'), "{other}");
    }
}

#[test]
fn a_device_is_approved_on_the_remote_or_the_app_it_names_and_nowhere_else() {
    // As the production Remote answers: the app on the one name the device reaches it by.
    let page = "https://os.length3.com/?device=&user_code=ABCD1234";
    assert!(device_page_ok(DEFAULT_URL, Some(DEFAULT_URL), page));
    assert!(device_page_ok(DEFAULT_URL, None, page));
    // A Remote that keeps its app on another name (as the former name did), only on that app's origin.
    let (remote, app) = ("https://remote.length3.com", Some("https://os.length3.com"));
    assert!(device_page_ok(remote, app, page));
    assert!(device_page_ok(remote, None, "https://remote.length3.com/?device=&user_code=X"));
    assert!(!device_page_ok(remote, None, page));
    assert!(!device_page_ok(DEFAULT_URL, Some(DEFAULT_URL), "https://remote.length3.com/?device=&user_code=X"));
    for bad in ["https://os.length3.com.evil.example/?device", "https://os.length3.com@evil.example/?device", "https://evil.example/?device",
        "http://os.length3.com/?device", "file:///etc/passwd", "javascript:alert(1)"] {
        assert!(!device_page_ok(remote, app, bad), "{bad}");
    }
    // What it names must be a bare origin over https; http only beside a Remote on http.
    // A browser reads a backslash as a slash and what is before an @ as no host: neither is an origin to name
    // (account.rs app_page asks the same of the page it opens).
    for bad in ["https://os.length3.com\\@evil.example/?account=off", "https://os.length3.com\\.evil.example/?device"] {
        assert!(!device_page_ok(remote, app, bad), "{bad}");
    }
    for bad_app in ["http://os.length3.com", "https://os.length3.com/x", "file://os.length3.com", "javascript:x", "",
        "https://evil.example\\@os.length3.com", "https://evil.example@os.length3.com"] {
        assert!(!device_page_ok(remote, Some(bad_app), &format!("{bad_app}/?device")), "{bad_app}");
    }
    assert!(device_page_ok("http://127.0.0.1:8790", Some("http://localhost:1420"), "http://localhost:1420/?device=&user_code=X"));
    // The Remote a page is checked against is one by its own URL too: the device's connection is set by whoever
    // signed in (remote_connect takes what the window says), and app_page builds its page on it, so a "Remote"
    // that is a file, a script or nothing would vouch for a page under itself that the opener hands the desktop.
    for (bad_remote, page) in [("file:///home/me/x", "file:///home/me/x/?account=off&repo=a"), ("javascript:alert(1)//", "javascript:alert(1)///?account=sign-in"),
        ("", "/?account=sign-in"), ("https://evil.example\\@os.length3.com", "https://evil.example\\@os.length3.com/?account=off&repo=a")] {
        assert!(!device_page_ok(bad_remote, None, page), "{bad_remote}");
    }
}

#[test]
fn the_tree_leaves_out_git_and_links_and_says_so() {
    let d = crate::fs::testing::dir("length3-tree");
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(d.join(".git")).unwrap();
    fs::create_dir_all(d.join("empty")).unwrap();
    fs::create_dir_all(d.join("src")).unwrap();
    fs::write(d.join("src/a.bin"), [0u8, 159, 146, 150]).unwrap();
    fs::write(d.join(".length3-1-x"), "half written").unwrap();
    std::os::unix::fs::symlink("/etc/passwd", d.join("link")).unwrap();
    let l = local_tree(&d);
    assert_eq!(l.tree.keys().cloned().collect::<Vec<_>>(), ["empty", "src/a.bin"]);
    assert_eq!(l.tree["empty"], None);
    let why: Vec<&str> = l.unsynced.iter().map(|(p, _)| p.as_str()).collect();
    assert!(why.contains(&".git") && why.contains(&"link"), "{why:?}");
    assert!(place(&d, "../x").is_err() && place(&d, ".git/config").is_err() && place(&d, "link/x").is_err());
    // A file rewritten in place is read again.
    let before = l.tree["src/a.bin"].clone();
    fs::write(d.join("src/a.bin"), "changed").unwrap();
    assert_ne!(local_tree(&d).tree["src/a.bin"], before);
    let _ = fs::remove_dir_all(&d);
}
