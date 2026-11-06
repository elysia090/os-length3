//! The tests of agent/tasks.rs.

use super::*;

fn book_in(name: &str) -> PathBuf {
    let d = crate::testing::dir(&format!("l3-tasks-{name}"));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn a_newer_edge_stands_for_an_older_one_not_yet_run_and_the_most_complex_waiting_runs_first() {
    let d = book_in("order");
    let ids = with_in(&d, |b| {
        let file = put(b, Ask { repo: "r", line: "001", issue: "issue/001.md", deed: Deed::Ask, unit: Unit::Question, words: "why?", weight: 0 }, State::Waiting);
        let light = put(b, Ask { repo: "r", line: "002", issue: "issue/002.md", deed: Deed::Review, unit: Unit::Goal, words: "x", weight: 3 }, State::Waiting);
        let heavy = put(b, Ask { repo: "r", line: "003", issue: "issue/003.md", deed: Deed::Review, unit: Unit::Goal, words: "y", weight: 9 }, State::Waiting);
        // Handed in again before it ran: the same task, renewed.
        let again = put(b, Ask { repo: "r", line: "003", issue: "issue/003.md", deed: Deed::Review, unit: Unit::Goal, words: "y2", weight: 10 }, State::Waiting);
        assert_eq!(again.id, heavy.id);
        [file.id, light.id, heavy.id]
    }).unwrap();
    let order: Vec<u64> = with_in(&d, |b| {
        let mut w: Vec<&Task> = b.tasks.iter().filter(|k| k.state == State::Waiting).collect();
        w.sort_by(|a, b| a.unit.cmp(&b.unit).then(b.weight.cmp(&a.weight)).then(a.made.cmp(&b.made)));
        w.iter().map(|k| k.id).collect()
    }).unwrap();
    assert_eq!(order, [ids[2], ids[1], ids[0]]);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn an_agents_last_words_are_read_as_findings_questions_and_what_it_did() {
    let text = "I looked.\n- FINDING file src/a.ts:12 the loop never ends\nFINDING goal - it does not close the issue\n\
            FINDING file ../etc/passwd:1 out of the repo\nQUESTION Should the old name stay?\nDONE reviewed";
    let (found, questions, said) = read_result(text);
    assert_eq!(found.iter().map(|f| (f.unit, f.path.as_str(), f.line)).collect::<Vec<_>>(),
        [(Unit::Goal, "", None), (Unit::File, "src/a.ts", Some(12)), (Unit::File, "", Some(1))]);
    assert_eq!(found[1].text, "the loop never ends");
    assert_eq!(questions, ["Should the old name stay?"]);
    assert_eq!(said, "reviewed");
    assert_eq!(read_result("All good.\n\nNothing to change.\n").2, "Nothing to change.");
}

#[test]
fn a_change_is_read_heaviest_part_first_and_heaviest_file_first() {
    let tangled = "if a { for x in y { if b && c { } } } else { match z { } }";
    let (parts, files) = weigh(&[("src/ui/a.ts".into(), 10, "let a = 1;".into()), ("src/core/b.rs".into(), 8, tangled.into()),
        ("README.md".into(), 40, "words".into())]);
    assert_eq!(files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["README.md", "src/core/b.rs", "src/ui/a.ts"]);
    assert_eq!(parts[0].0, ".");
    assert!(branches(tangled) >= 6);
}

#[test]
fn the_tests_a_repo_has_are_found_by_what_it_holds() {
    let d = book_in("tests");
    std::fs::create_dir_all(&d).unwrap();
    assert_eq!(tests_command(&d), None);
    std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
    assert_eq!(tests_command(&d), None);
    std::fs::write(d.join("package.json"), r#"{"scripts":{"test":"node --test"}}"#).unwrap();
    assert_eq!(tests_command(&d).as_deref(), Some("npm test"));
    let _ = std::fs::remove_dir_all(&d);
}
