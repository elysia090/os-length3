//! The tests of words/linediff.rs.

use super::*;

#[test]
fn a_change_in_the_middle_is_one_line_each_way() {
    let o = ops("a\nb\nc\n", "a\nB\nc\n");
    assert_eq!(counts(&o), (1, 1));
    assert_eq!(o, vec![(Kind::Same, "a"), (Kind::Del, "b"), (Kind::Add, "B"), (Kind::Same, "c")]);
    assert_eq!(counts(&ops("", "x\ny")), (2, 0));
    assert_eq!(counts(&ops("x\n", "")), (0, 1));
}
