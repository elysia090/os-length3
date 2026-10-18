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
            if a.method == "GET" && a.path == "/v1/repos/notes" { (200, said.to_string()) } else { (NOT_FOUND.0, NOT_FOUND.1.to_string()) }
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
