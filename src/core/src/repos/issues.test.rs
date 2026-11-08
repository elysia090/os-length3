//! The tests of repos/issues.rs.

use super::*;

#[test]
fn an_issue_is_called_by_its_number() {
    assert_eq!((number_of("007.md"), number_of("1000.md"), number_of("000.md")), (Some(7), Some(1000), Some(0)));
    assert_eq!((number_of("notes.md"), number_of("002 (other device).md"), number_of("3"), number_of(".md")), (None, None, None, None));
    assert_eq!(number("001.md"), "#1");
    assert_eq!(number("issue/010.md"), "#10");
    assert_eq!(number("notes.md"), "");
    assert!(named_by("003.md", "3") && named_by("003.md", "#3") && named_by("003.md", "003.md") && named_by("003.md", "03"));
    assert!(named_by("notes.md", "notes") && named_by("notes.md", "notes.md") && !named_by("003.md", "4") && !named_by("notes.md", "3"));
    assert_eq!(parse("a", "012.md", "x").n, Some(12));
    assert_eq!(parse("a", "notes.md", "x").n, None);
    assert_eq!(parse("a", "empty.md", "").title, "empty");
}

#[test]
fn a_new_issue_takes_the_next_number() {
    assert_eq!(next_name::<&str>(&[]), "001.md");
    assert_eq!(next_name(&["001.md", "007.md", "notes.md", "002 (other device).md"]), "008.md");
    assert_eq!(next_name(&["999.md"]), "1000.md");
}

#[test]
fn issues_sort_by_number_not_by_name() {
    let mut list = vec![parse("r", "999.md", "a"), parse("r", "notes.md", "b"), parse("r", "1000.md", "c"), parse("r", "002.md", "d")];
    sort(&mut list);
    assert_eq!(list.iter().map(|i| i.n).collect::<Vec<_>>(), [None, Some(1000), Some(999), Some(2)]);
    sort_oldest_first(&mut list);
    assert_eq!(list.iter().map(|i| i.n).collect::<Vec<_>>(), [Some(2), Some(999), Some(1000), None]);
}

#[test]
fn issues_without_a_number_take_the_next_free_ones_unless_a_work_holds_them() {
    // As the app's own test (src/app/repos/issues.test.ts).
    let list = vec![parse("a", "001.md", "A"), parse("a", "002.md", "B"), parse("a", "002 (other device).md", "C"), parse("a", "notes.md", "D"), parse("a", "worked.md", "E")];
    let plan = numbering(&list, &["issue/worked.md".to_string()]);
    assert_eq!(plan, [("002 (other device).md".to_string(), "003.md".to_string()), ("notes.md".into(), "004.md".into())]);
    // Done once, there is nothing more to do: two devices doing it agree.
    let after: Vec<Issue> = vec![parse("a", "001.md", "A"), parse("a", "002.md", "B"), parse("a", "003.md", "C"), parse("a", "004.md", "D"), parse("a", "worked.md", "E")];
    assert!(numbering(&after, &["issue/worked.md".to_string()]).is_empty());
    let mut sorted = after;
    sort(&mut sorted);
    assert_eq!(sorted.iter().map(|i| (i.n, i.title.as_str())).collect::<Vec<_>>(), [(None, "E"), (Some(4), "D"), (Some(3), "C"), (Some(2), "B"), (Some(1), "A")]);
}

#[test]
fn an_issue_is_found_by_the_words_of_its_title() {
    let list = vec![parse("r", "001.md", "Fix：restart loses the draft\n"), parse("r", "002.md", "Docs：readme\n"), parse("r", "003.md", "Fix：readme typo\n")];
    let files = |w: &str| by_title(&list, w).iter().map(|i| i.file.as_str()).collect::<Vec<_>>();
    assert_eq!(files("restart"), ["001.md"]);
    assert_eq!(files("Restart LOSES"), ["001.md"]);
    assert_eq!(files("docs: readme"), ["002.md"]);
    assert_eq!(files("Docs：readme"), ["002.md"]);
    // "readme" alone is two issues' word, but one's whole title: that one.
    assert_eq!(files("readme"), ["002.md"]);
    assert_eq!(files("fix"), ["001.md", "003.md"]);
    assert!(files("nothing like it").is_empty() && files("  ").is_empty());
}
