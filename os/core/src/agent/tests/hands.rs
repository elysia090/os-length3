//! The tests of agent/hands.rs.

use super::*;

fn ch(old: &str, new: &str) -> Change { Change { old: old.into(), new: new.into() } }

#[test]
fn a_read_gives_lines_from_where_it_is_asked_and_says_where_to_go_on() {
    let text = "a\nb\nc\nd\n";
    let p = part(text, None, None).unwrap();
    assert_eq!((p.text.as_str(), p.from, p.to, p.lines, p.next), ("a\nb\nc\nd", 1, 4, 4, None));
    let p = part(text, Some(2), Some(2)).unwrap();
    assert_eq!((p.from, p.to, p.next), (2, 3, Some(4)));
    assert_eq!(p.text, "b\nc\n\n[Lines 2-3 of 4. Use offset=4 to go on.]");
    assert!(part(text, Some(9), None).unwrap_err().contains("4 lines"));
    // An empty file is read, empty; nothing past it is.
    assert_eq!(part("", None, None).unwrap().text, "");
}

#[test]
fn a_read_stops_at_its_most_lines_or_bytes() {
    let many: String = (0..MOST_LINES + 5).map(|i| format!("{i}\n")).collect();
    let p = part(&many, None, None).unwrap();
    assert_eq!((p.to, p.next), (MOST_LINES, Some(MOST_LINES + 1)));
    let wide = format!("{}\n{}\n", "x".repeat(MOST_BYTES - 10), "y".repeat(40));
    let p = part(&wide, None, None).unwrap();
    assert_eq!((p.to, p.next), (1, Some(2)));
    // A line longer than a read holds is still read, cut.
    let p = part(&"é".repeat(MOST_BYTES), None, None).unwrap();
    assert!(p.text.len() <= MOST_BYTES && p.to == 1);
}

#[test]
fn a_run_gives_back_its_last_lines() {
    assert_eq!(tail("one\ntwo\n"), "one\ntwo");
    let many: String = (0..MOST_LINES + 3).map(|i| format!("{i}\n")).collect();
    let t = tail(&many);
    assert!(t.starts_with("[3 earlier lines left out]\n3\n"), "{}", &t[..40]);
    assert!(t.ends_with(&format!("{}", MOST_LINES + 2)));
}

#[test]
fn an_edit_replaces_each_piece_found_once_and_says_where() {
    let text = "#include <stdio.h>\n\nint main(void) {\n\tprintf(\"%d\\n\", count);\n}\n";
    let e = edit("count.c", text, &[ch("count)", "n)"), ch("int main(void)", "int main(int argc, char **argv)")]).unwrap();
    assert_eq!(e.text, "#include <stdio.h>\n\nint main(int argc, char **argv) {\n\tprintf(\"%d\\n\", n);\n}\n");
    assert_eq!(e.spans.iter().map(|s| (s.line, s.column)).collect::<Vec<_>>(), [(3, 1), (4, 17)]);
    assert_eq!((e.added, e.removed), (2, 2));
}

#[test]
fn an_edit_refused_leaves_the_reason_and_nothing_else() {
    let text = "a = 1\na = 1\nb = 2\n";
    assert!(edit("f", text, &[ch("a = 1", "a = 3")]).unwrap_err().contains("2 times"));
    assert!(edit("f", text, &[ch("c = 3", "")]).unwrap_err().contains("Could not find"));
    assert!(edit("f", text, &[ch("", "x")]).unwrap_err().contains("empty"));
    assert!(edit("f", text, &[ch("b = 2", "b = 2")]).unwrap_err().contains("Nothing changed"));
    let both = edit("f", "abcdef", &[ch("abcd", "x"), ch("cdef", "y")]).unwrap_err();
    assert!(both.contains("edits[0] and edits[1] overlap"), "{both}");
}

#[test]
fn an_edit_written_with_other_quotes_or_blanks_still_finds_its_piece_and_keeps_the_rest() {
    // The file ends lines with \r\n and has a blank at a line's end; the model wrote plain quotes and \n.
    let text = "say(\u{201C}hi\u{201D});  \r\nkeep\u{2014}this\r\n";
    let e = edit("f", text, &[ch("say(\"hi\");\nkeep", "say(\"yo\");\r\nkeep")]).unwrap();
    assert_eq!(e.text, "say(\"yo\");\r\nkeep\u{2014}this\r\n");
    assert_eq!((e.spans[0].line, e.spans[0].column), (1, 1));
}
