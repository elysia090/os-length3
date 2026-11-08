//! The tests of repos/store.rs.

use super::*;

fn scratch(tag: &str) -> Repos {
    let root = crate::fs::testing::dir(&format!("length3-repos-{tag}"));
    let _ = fs::remove_dir_all(&root);
    Repos::new(root).unwrap()
}

#[test]
fn names_are_plain() {
    assert!(valid_name("my-repo_1.0"));
    for bad in ["", ".git", "a/b", "..", "a b", &"x".repeat(65)] {
        assert!(!valid_name(bad), "{bad}");
    }
}

#[test]
fn templates_hold_only_repo_files() {
    let r = scratch("tpl");
    for t in ["empty", "standard", "c"] {
        r.create(t, t).unwrap();
        let names: Vec<String> = r.tree(t, "").unwrap().into_iter().map(|e| e.name).collect();
        assert!(names.contains(&"README.md".into()), "{t}: {names:?}");
        assert!(!names.iter().any(|n| n == "inbox.md" || n == "TODO.md"), "{t}: {names:?}");
    }
    let c: Vec<String> = r.tree("c", "").unwrap().into_iter().map(|e| e.name).collect();
    // Its issues' folder is the OS's, made for the first issue, never a scaffold's (repos.ts ISSUES).
    assert_eq!(c[..2], ["docs", "src"]);
    assert!(r.create("c", "c").is_err());
    assert!(r.create("x", "nope").is_err());
    assert_eq!(r.list(true).unwrap().len(), 3);
    assert_eq!(r.names().unwrap(), ["c", "empty", "standard"]);
    // Nothing made aside is left, and what is in the way of a name is never written into.
    assert!(fs::read_dir(&r.root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
    fs::create_dir(r.root.join("taken")).unwrap();
    assert!(r.create("taken", "standard").unwrap_err().contains("already"));
    assert_eq!(fs::read_dir(r.root.join("taken")).unwrap().count(), 0);
}

#[test]
fn paths_stay_inside_the_repo() {
    let r = scratch("paths");
    r.create("a", "standard").unwrap();
    r.create("b", "standard").unwrap();
    assert!(r.read("a", "../b/README.md", 100).is_err());
    assert!(r.read("a", "/etc/passwd", 100).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(r.root.join("b"), r.root.join("a/escape")).unwrap();
        assert!(r.read("a", "escape/README.md", 100).is_err());
    }
    assert_eq!(r.read("a", "README.md", 100).unwrap().text.as_deref(), Some("# a\n"));
}

#[cfg(unix)]
#[test]
fn a_link_to_nothing_is_known_from_a_file_that_is_not_there() {
    let r = scratch("dangling");
    r.create("a", "standard").unwrap();
    std::os::unix::fs::symlink("nowhere", r.root.join("a/dangling")).unwrap();
    std::os::unix::fs::symlink("README.md", r.root.join("a/readme")).unwrap();
    assert!(r.dangling("a", "dangling"));
    // What reading it says is "there is no" (root3 says it with 4, as for anything not there).
    assert!(r.read("a", "dangling", 100).is_err());
    for not in ["readme", "README.md", "missing", "missing/deeper"] { assert!(!r.dangling("a", not), "{not}"); }
    assert!(!r.dangling("nope", "dangling"));
}

#[test]
fn writes_replace_existing_files_inside_the_repo_only() {
    let r = scratch("write");
    r.create("a", "c").unwrap();
    r.create("b", "empty").unwrap();
    assert_eq!(r.write("a", "src/main.c", "int main;\n", 100).unwrap(), 10);
    assert_eq!(r.read("a", "src/main.c", 100).unwrap().text.as_deref(), Some("int main;\n"));
    assert!(r.write("a", "new.txt", "x", 100).is_err());
    assert!(r.write("a", "src", "x", 100).is_err());
    assert!(r.write("a", "../b/README.md", "x", 100).is_err());
    assert!(r.write("a", "README.md", &"x".repeat(101), 100).is_err());
    let names: Vec<String> = r.tree("a", "src").unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, ["main.c"]);
    assert_eq!(r.read("b", "README.md", 100).unwrap().text.as_deref(), Some("# b\n"));
}

#[test]
fn put_replaces_or_makes_a_file_and_names_the_path_when_it_cannot() {
    let r = scratch("put");
    r.create("a", "standard").unwrap();
    assert_eq!(r.put("a", "README.md", "x\n", 100, false).unwrap(), (2, false));
    assert!(r.put("a", "new/deep.txt", "y", 100, false).unwrap_err().contains("a/new/deep.txt"));
    assert_eq!(r.put("a", "new/deep.txt", "y", 100, true).unwrap(), (1, true));
    assert_eq!(r.put("a", ".gitignore", "target\n", 100, true).unwrap(), (7, true));
    assert_eq!(r.read("a", "new/deep.txt", 100).unwrap().text.as_deref(), Some("y"));
    assert!(r.put("a", ".git/config", "x", 100, true).is_err());
    assert!(r.put("a", "../b/x", "x", 100, true).is_err());
    assert!(r.put("a", "", "x", 100, true).is_err());
    assert!(r.read("a", "nope.txt", 10).unwrap_err().contains("a/nope.txt"));
    assert!(r.tree("a", "README.md").unwrap_err().contains("a/README.md"));
}

#[test]
fn issues_without_a_number_are_given_one_by_renaming_their_files() {
    let r = scratch("number");
    r.create("a", "standard").unwrap();
    r.add_issue("a", Some("Fix"), "one", "").unwrap();
    r.add("a", "issue", "notes.md", "Docs：notes\n", 100).unwrap();
    r.add("a", "issue", "002 (other device).md", "Fix：theirs\n", 100).unwrap();
    r.add("a", "issue", "worked.md", "Fix：held by a work\n", 100).unwrap();
    let done = r.number_issues("a", &["issue/worked.md".to_string()]).unwrap();
    assert_eq!(done, [("002 (other device).md".to_string(), "002.md".to_string()), ("notes.md".into(), "003.md".into())]);
    let list = r.issues("a").unwrap();
    assert_eq!(list.iter().map(|i| (i.n, i.title.as_str())).collect::<Vec<_>>(), [(None, "held by a work"), (Some(3), "notes"), (Some(2), "theirs"), (Some(1), "one")]);
    assert!(r.number_issues("a", &["issue/worked.md".to_string()]).unwrap().is_empty());
    assert_eq!(r.add_issue("a", None, "next", "").unwrap(), "004.md");
}

#[test]
fn an_issue_is_found_by_its_number_or_file() {
    let r = scratch("issue-file");
    r.create("a", "standard").unwrap();
    r.add_issue("a", None, "one", "").unwrap();
    assert_eq!(r.issue_file("a", "1").unwrap(), "001.md");
    assert_eq!(r.issue_file("a", "#001").unwrap(), "001.md");
    assert_eq!(r.issue_file("a", "issue/001.md").unwrap(), "001.md");
    assert!(r.issue_file("a", "2").unwrap_err().contains("#2"));
    assert!(r.issue_file("nope", "1").is_err());
    r.create("e", "empty").unwrap();
    assert!(r.issue_file("e", "1").unwrap_err().contains("#1"));
}

#[test]
fn the_issues_folder_is_named_at_a_repo_top_only() {
    for (rel, is) in [("issue", true), ("issue/", true), ("/issue/001.md", true), ("issue/a/b", true),
        ("issues", false), ("issue.md", false), ("docs/issue", false), ("", false)] {
        assert_eq!(is_issues(rel), is, "{rel:?}");
    }
}

#[test]
fn new_files_go_into_existing_directories_and_never_replace() {
    let r = scratch("add");
    r.create("a", "standard").unwrap();
    assert_eq!(r.add("a", "docs", "001.md", "Fix：x\n", 100).unwrap(), 8);
    assert_eq!(r.read("a", "docs/001.md", 100).unwrap().text.as_deref(), Some("Fix：x\n"));
    assert!(r.add("a", "docs", "001.md", "again", 100).is_err());
    assert!(r.add("a", "missing", "x.md", "x", 100).is_err());
    assert!(r.add("a", "docs", "../x.md", "x", 100).is_err());
    assert!(r.add("a", "docs", ".hidden", "x", 100).is_err());
    assert!(r.add("a", "../b", "x.md", "x", 100).is_err());
    assert!(r.add("a", "README.md", "x.md", "x", 100).is_err());
}

#[test]
fn directories_are_made_and_removed_inside_the_repo_only() {
    let r = scratch("tree-ops");
    r.create("a", "standard").unwrap();
    r.mkdir("a", "src/deep").unwrap();
    assert!(r.root.join("a/src/deep").is_dir());
    assert!(r.mkdir("a", "../b").is_err());
    assert!(r.mkdir("a", "README.md/x").is_err());
    r.remove("a", "src").unwrap();
    assert!(!r.root.join("a/src").exists());
    assert!(r.remove("a", "").is_err());
    assert!(r.remove("a", ".git").is_err());
    assert!(r.remove("a", "../a").is_err());
    assert!(r.root.join("a/README.md").exists());
}

#[test]
fn files_and_folders_are_renamed_or_moved_within_the_repo_and_never_over_another() {
    let r = scratch("rename");
    r.create("a", "c").unwrap();
    r.move_to("a", "src/main.c", "src/hello.c").unwrap();
    assert!(r.root.join("a/src/hello.c").is_file() && !r.root.join("a/src/main.c").exists());
    r.mkdir("a", "src/empty").unwrap();
    r.move_to("a", "src", "lib").unwrap();
    assert!(r.root.join("a/lib/hello.c").is_file() && r.root.join("a/lib/empty").is_dir());
    assert!(r.move_to("a", "lib/hello.c", "lib/empty").is_err());
    assert!(r.move_to("a", "lib", "docs").is_err());
    for bad in ["", "/", "x//y", ".hidden", "x/.hidden", ".git", "x/.git/y", "GIT~1", "..", "../b", "x\\y"] {
        assert!(r.move_to("a", "lib/hello.c", bad).is_err(), "{bad}");
    }
    assert!(r.move_to("a", "", "b").is_err());
    assert!(r.move_to("a", "missing", "b").is_err());
    assert!(r.move_to("a", "../a/lib", "b").is_err());
    assert!(r.move_to("a", ".git", "b").is_err());
    r.move_to("a", "lib/hello.c", "lib/hello.c").unwrap();
    assert!(r.root.join("a/lib/hello.c").is_file());
    // Moved: to the top, into a folder there, into folders made on its way.
    r.move_to("a", "lib/hello.c", "hello.c").unwrap();
    assert!(r.root.join("a/hello.c").is_file() && !r.root.join("a/lib/hello.c").exists());
    r.move_to("a", "hello.c", "lib/empty/hello.c").unwrap();
    assert!(r.root.join("a/lib/empty/hello.c").is_file());
    r.move_to("a", "lib/empty", "notes/old/empty").unwrap();
    assert!(r.root.join("a/notes/old/empty/hello.c").is_file() && !r.root.join("a/lib/empty").exists());
    // Never inside itself, and never through a file in the way.
    assert!(r.move_to("a", "notes", "notes/inner/notes").is_err());
    assert!(r.root.join("a/notes/old/empty/hello.c").is_file() && !r.root.join("a/notes/inner").exists());
    assert!(r.move_to("a", "notes", "README.md/notes").is_err());
}

#[test]
fn nothing_reaches_the_repos_git() {
    // What the Prompt writes back goes through here: a guest must not be
    // able to plant git config or hooks, which run on the host.
    let r = scratch("dotgit");
    r.create("a", "standard").unwrap();
    let git = r.root.join("a/.git");
    fs::create_dir_all(git.join("hooks")).unwrap();
    fs::write(git.join("config"), "[core]\n").unwrap();
    for name in [".git", ".GIT", ".Git.", ".git ", "git~1", "GIT~1", ".g\u{200c}it"] {
        assert!(is_git_name(name), "{name}");
    }
    for name in ["git", ".github", ".gitignore", "x.git"] {
        assert!(!is_git_name(name), "{name}");
    }
    assert!(r.write("a", ".git/config", "[core]\n\tfsmonitor = evil\n", 1024).is_err());
    assert!(r.add("a", ".git/hooks", "pre-commit", "#!/bin/sh\n", 1024).is_err());
    assert!(r.add("a", ".git", "config2", "x", 1024).is_err());
    // Said as what it is (bug: "leaves the repo").
    assert!(r.mkdir("a", ".git/hooks/x").is_err_and(|e| e.contains(".git") && !e.contains("leaves")));
    assert!(r.mkdir("a", ".GIT/x").is_err());
    assert!(r.read("a", ".git/config", 1024).is_err());
    assert!(r.tree("a", ".git").is_err());
    assert!(r.remove("a", ".git/config").is_err());
    assert!(r.add("a", "", "git~1", "x", 1024).is_err());
    // Through a link the repo itself carries.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(".git", r.root.join("a/g")).unwrap();
        assert!(r.write("a", "g/config", "x", 1024).is_err());
        assert!(r.add("a", "g/hooks", "pre-commit", "x", 1024).is_err());
        r.remove("a", "g").unwrap();
        assert!(git.join("config").exists(), "removing the link leaves .git");
    }
    assert_eq!(fs::read_to_string(git.join("config")).unwrap(), "[core]\n");
    assert!(!git.join("hooks/pre-commit").exists());
    assert!(r.tree("a", "").unwrap().iter().all(|e| e.name != ".git"));
}

#[test]
fn issues_are_numbered_files_read_back_newest_first() {
    let r = scratch("issues");
    r.create("a", "standard").unwrap();
    assert_eq!(r.add_issue("a", Some("Fix"), "壊れる", "手順").unwrap(), "001.md");
    assert_eq!(r.add_issue("a", None, "メモ", "").unwrap(), "002.md");
    let list = r.issues("a").unwrap();
    assert_eq!(list.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["メモ", "壊れる"]);
    assert_eq!(list[1].kind.as_deref(), Some("Fix"));
    // Any repo takes an issue: issue/ is made for the first.
    r.create("e", "empty").unwrap();
    assert!(r.issues("e").unwrap().is_empty());
    assert_eq!(r.add_issue("e", None, "x", "").unwrap(), "001.md");
    assert_eq!(r.issues("e").unwrap()[0].n, Some(1));
    assert!(r.add_issue("a", None, "  ", "").is_err());
}

#[test]
fn reads_are_bounded_and_binary_is_not_text() {
    let r = scratch("read");
    r.create("a", "empty").unwrap();
    fs::write(r.root.join("a/big.txt"), "あ".repeat(10)).unwrap();
    let c = r.read("a", "big.txt", 7).unwrap();
    assert!(c.truncated && c.text.as_deref() == Some("ああ") && c.size == 30);
    fs::write(r.root.join("a/bin"), [1u8, 0, 2]).unwrap();
    assert!(r.read("a", "bin", 10).unwrap().text.is_none());
}

mod shared_cases {
    //! The cases in src/shared/cases.json, which the app's tests read too.
    use crate::{repos::issues, text::title};
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../../shared/cases.json")).unwrap()
    }
    fn opt(v: &Value) -> Option<String> { v.as_str().map(String::from) }

    #[test]
    fn kinds_issues_and_names_agree_with_the_app() {
        let c = cases();
        for k in c["kind"].as_array().unwrap() {
            let (kind, title) = title::kind_of(k[0].as_str().unwrap());
            assert_eq!((kind, title), (opt(&k[1]), k[2].as_str().unwrap().to_string()), "{k}");
        }
        for k in c["issue"].as_array().unwrap() {
            let i = issues::parse("r", "x.md", k[0].as_str().unwrap());
            assert_eq!((i.kind, i.title, i.detail), (opt(&k[1]), k[2].as_str().unwrap().into(), k[3].as_str().unwrap().into()), "{k}");
        }
        for k in c["issueText"].as_array().unwrap() {
            let t = issues::text(k[0].as_str(), k[1].as_str().unwrap(), k[2].as_str().unwrap());
            assert_eq!(t, k[3].as_str().unwrap(), "{k}");
        }
        for k in c["closed"].as_array().unwrap() {
            let t = k[0].as_str().unwrap();
            let i = issues::parse("r", "x.md", t);
            assert_eq!((i.kind, i.title, i.detail, i.closed), (opt(&k[1]), k[2].as_str().unwrap().into(), k[3].as_str().unwrap().into(), opt(&k[4])), "{k}");
            assert_eq!(issues::reopen_text(t), k[5].as_str().unwrap(), "{k}");
        }
        for k in c["close"].as_array().unwrap() {
            let t = issues::close_text(k[0].as_str().unwrap(), k[1].as_str().unwrap());
            assert_eq!(t, k[2].as_str().unwrap(), "{k}");
            assert_eq!(issues::parse("r", "x.md", &t).closed, opt(&k[1]));
        }
        for k in c["nextIssue"].as_array().unwrap() {
            let names: Vec<&str> = k[0].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(issues::next_name(&names), k[1].as_str().unwrap(), "{k}");
        }
        for k in c["validName"].as_array().unwrap() {
            assert_eq!(super::valid_name(k[0].as_str().unwrap()), k[1].as_bool().unwrap(), "{k}");
        }
        for k in c["gitName"].as_array().unwrap() {
            assert_eq!(super::is_git_name(k[0].as_str().unwrap()), k[1].as_bool().unwrap(), "{k}");
        }
    }

    /// The cases of `key` whose answer is not the one wanted, each with what came instead: empty when all agree.
    fn disagreeing(key: &str, want: impl Fn(&Value) -> Value, got: impl Fn(&Value) -> Value) -> Vec<String> {
        cases()[key].as_array().unwrap().iter()
            .filter_map(|c| { let (w, g) = (want(c), got(c)); (w != g).then(|| format!("{c}: wanted {w}, got {g}")) })
            .collect()
    }
    fn s(v: &Value) -> &str { v.as_str().unwrap() }

    #[test]
    fn an_issue_file_is_numbered_by_its_name_as_the_app_numbers_it() {
        assert_eq!(disagreeing("issueNumber", |c| c[1].clone(), |c| serde_json::json!(issues::number_of(s(&c[0])))), Vec::<String>::new());
    }

    #[test]
    fn a_sync_plans_the_same_takes_and_conflicts_as_the_app() {
        use crate::remote::{plan, Tree};
        let tree = |v: &Value| -> Tree { v.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from))).collect() };
        // [path] is a removal (None), [path, null] a folder (Some(None)), [path, digest] a file.
        let take = |v: &Value| v.as_array().unwrap().iter().map(|t| {
            let t = t.as_array().unwrap();
            (s(&t[0]).to_string(), t.get(1).map(|d| d.as_str().map(String::from)))
        }).collect::<Vec<_>>();
        let wrong: Vec<String> = cases()["plan"].as_array().unwrap().iter().filter_map(|c| {
            let p = plan(&tree(&c["base"]), &tree(&c["here"]), &tree(&c["there"]));
            let both: Vec<(String, Option<String>)> = c["both"].as_array().unwrap().iter().map(|b| (s(&b[0]).into(), b[1].as_str().map(String::from))).collect();
            (p.take != take(&c["take"]) || p.both != both).then(|| format!("{}: {:?}", s(&c["why"]), p))
        }).collect();
        assert_eq!(wrong, Vec::<String>::new());
    }

    #[test]
    fn the_copy_kept_beside_a_file_is_named_as_the_app_names_it() {
        let got = |c: &Value| serde_json::json!(crate::remote::beside_as(s(&c[0]), s(&c[1]), c[2].as_u64().unwrap() as u32));
        assert_eq!(disagreeing("beside", |c| c[3].clone(), got), Vec::<String>::new());
    }

    #[test]
    fn lines_changed_are_counted_and_laid_out_as_the_app_does() {
        use crate::text::diff::{counts, Kind, ops};
        assert_eq!(disagreeing("lineDiff", |c| serde_json::json!([c[2], c[3]]), |c| serde_json::json!(counts(&ops(s(&c[0]), s(&c[1]))))), Vec::<String>::new());
        let laid = |c: &Value| {
            if c[4].is_null() { return Value::Null; }
            serde_json::json!(ops(s(&c[0]), s(&c[1])).iter().map(|(k, l)| format!("{}{l}", match k { Kind::Same => '=', Kind::Add => '+', Kind::Del => '-' })).collect::<Vec<_>>())
        };
        assert_eq!(disagreeing("lineDiff", |c| c[4].clone(), laid), Vec::<String>::new());
    }

    #[test]
    fn two_todo_lists_are_joined_as_the_app_joins_them() {
        // Compared as JSON (root3 writes an item's fields in its own order), or as text where it is none.
        let read = |t: &str| serde_json::from_str::<Value>(t).unwrap_or_else(|_| Value::String(t.into()));
        let got = |c: &Value| read(&crate::home::join_todo(s(&c["base"]), s(&c["here"]), s(&c["there"])));
        assert_eq!(disagreeing("todoJoin", |c| read(s(&c["want"])), got), Vec::<String>::new());
    }

    #[test]
    fn a_dotfile_may_be_written_into_root_under_the_names_the_app_allows() {
        assert_eq!(disagreeing("dotfileName", |c| c[1].clone(), |c| serde_json::json!(crate::home::dotfile_name(s(&c[0])))), Vec::<String>::new());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_pipe_in_a_repo_is_refused_not_waited_on() {
    use rustix::fs::{mknodat, FileType, Mode, CWD};
    let r = scratch("pipe");
    r.create("p", "empty").unwrap();
    mknodat(CWD, r.root().join("p/pipe"), FileType::Fifo, Mode::from_raw_mode(0o600), 0).unwrap();
    // Opened, it would wait for a writer that never comes; it is not opened at all.
    assert!(r.read("p", "pipe", 1024).unwrap_err().contains("not a file"));
    assert!(r.bytes("p", "pipe", 1024).unwrap_err().contains("not a file"));
}
