//! The tests of text/title.rs.

use super::*;

#[test]
fn a_first_line_is_a_kind_and_a_title_only_when_it_says_so() {
    let k = |s: &str| kind_of(s);
    assert_eq!(k("Fix：再起動すると保存内容が消える"), (Some("Fix".into()), "再起動すると保存内容が消える".into()));
    assert_eq!(k("  fix-up :  the thing  "), (Some("fix-up".into()), "the thing  ".into()));
    assert_eq!(k("買う：牛乳"), (Some("買う".into()), "牛乳".into()));
    // An address's scheme, a word starting with a digit, a word too long, no colon at all: a plain line.
    assert_eq!(k("https://length3.com/a"), (None, "https://length3.com/a".into()));
    assert_eq!(k("2fa: on"), (None, "2fa: on".into()));
    assert_eq!(k("abcdefghijklmnopq: x"), (None, "abcdefghijklmnopq: x".into()));
    assert_eq!(k("abcdefghijklmnop: x"), (Some("abcdefghijklmnop".into()), "x".into()));
    assert_eq!(k("Buy milk"), (None, "Buy milk".into()));
    assert_eq!(k(""), (None, "".into()));
    assert_eq!(named(Some("Fix"), " a "), "Fix：a");
    assert_eq!(named(None, " a "), "a");
}
