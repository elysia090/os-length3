//! l3 at a terminal, through a real pty: bare `l3` is the rail; a purpose
//! picked prints its page and its deeds; a deed asks for its words in place
//! and runs as the command it says; a command typed is followed by its next
//! deeds, passed by with Esc. And where l3 must stay a plain command (L3_PLAIN,
//! --json, TERM=dumb), it writes exactly what it writes off a terminal.

mod common;
use common::{Home, DOWN, ENTER, ESC, RIGHT};

/// A home with the repo notes in it.
fn with_notes(name: &str) -> Home {
    let home = Home::new(name);
    assert_eq!(home.run("en", &["repo", "new", "notes"]).code, 0);
    home
}

#[test]
fn bare_l3_is_the_rail_a_purpose_its_page_and_a_deed_asks_its_words_in_place() {
    let home = with_notes("menu-git");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("Git      Issues and commits · 0 issues open").expect("q leaves");
    // A number goes to the place, Enter opens it: its page, said as the command it is, then its deeds.
    l3.send("4").expect("› 4  Git");
    l3.send(ENTER).expect("→ l3 git").expect("No issues yet").expect("› 1  Write an issue").expect("Backspace purposes");
    // The deed asks for its one line in place, under its name and what goes in it, as the app's field does.
    l3.send(ENTER).expect("Repo  notes").expect("First line  Kind：title");
    l3.send("Fix：restart loses the draft\r")
        .expect("→ l3 issue new notes \"Fix：restart loses the draft\"")
        .expect("Wrote notes#1 Fix：restart loses the draft")
        // The issue just written is landed on, with what comes next for it.
        .expect("› 1  #1 Fix：restart loses the draft")
        .expect("[Open]");
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.starts_with("Length³ OS · not signed in\n› Git  Issues and commits\n→ l3 git\n"), "{screen}");
    // Left, the rows stay as text: no mark, no keys.
    assert!(!screen.contains("q leaves") && !screen.lines().last().unwrap_or_default().contains('›'), "{screen}");
    let file = std::fs::read_to_string(home.path("repos/notes/issue/001.md")).expect("the issue's file");
    assert!(file.starts_with("Fix：restart loses the draft"), "{file}");
}

#[test]
fn in_japanese_home_adds_a_todo_and_lands_on_it() {
    let home = Home::new("menu-ja");
    let mut l3 = home.pty("ja", &[], &[]);
    l3.expect("Home     プロフィール · TODO 残り 0 / 0").expect("q 終わる");
    l3.send(ENTER).expect("→ l3 todo").expect("TODO はまだありません").expect("→ l3 profile").expect("› 1  TODO を足す").expect("Backspace 目的");
    l3.send(ENTER).expect("1行目  種別：件名");
    l3.send("Fix：レールの名前\r").expect("→ l3 todo add Fix：レールの名前").expect("TODO に足しました：Fix：レールの名前（残り1件）")
        .expect("› 1  ○ Fix：レールの名前").expect("[完了]");
    l3.send(ESC);
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    assert_eq!(home.run("ja", &["todo"]).stdout, "  1 ○ Fix：レールの名前\n");
}

#[test]
fn a_name_refused_is_said_under_its_field_and_asked_again() {
    let home = with_notes("menu-plus");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("+        New repo");
    l3.send("+").expect("› 9  +");
    l3.send(ENTER).expect("[standard]");
    l3.send(ENTER).expect("Template  standard").expect("Name  Letters, digits");
    l3.send("notes\r").expect("→ l3 repo new notes -t standard").expect("There is a repo notes already");
    l3.send("notes2\r").expect("Made notes2 (standard · 1 file)").expect("› ").expect("notes2");
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    // Said under the field, not as l3's error line.
    assert!(screen.contains("\n    There is a repo notes already\n") && !screen.contains("l3: There is"), "{screen}");
    assert!(home.path("repos/notes2/README.md").exists());
}

#[test]
fn after_a_command_typed_its_next_deeds_are_offered_and_esc_passes_them_by() {
    let home = Home::new("menu-after");
    assert_eq!(home.run("en", &["todo", "add", "Fix：the rail's names"]).code, 0);
    // Passed by, nothing of the row stays: the terminal reads as the command alone.
    let mut l3 = home.pty("en", &["todo"], &[]);
    l3.expect("Done 1").expect("goes on");
    l3.send(ESC);
    assert_eq!(l3.finish(), (0, "  1 ○ Fix：the rail's names".to_string()));
    // Chosen, the deed runs as the command it is, and the next ones come after it.
    let mut l3 = home.pty("en", &["todo", "done", "1"], &[]);
    l3.expect("Done: Fix：the rail's names").expect("goes on");
    l3.send(RIGHT).expect("[Edit]");
    l3.send(RIGHT).expect("[Not done]");
    l3.send(ENTER).expect("→ l3 todo done 1").expect("Not done again: Fix：the rail's names").expect("goes on");
    l3.send(ENTER);
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.ends_with("Not done again: Fix：the rail's names"), "{screen}");
}

#[test]
fn where_l3_must_stay_a_plain_command_it_writes_what_it_writes_off_a_terminal() {
    let home = with_notes("menu-plain");
    assert_eq!(home.run("en", &["todo", "add", "Fix：x"]).code, 0);
    for (env, args) in [(vec![("L3_PLAIN", "1")], vec![]), (vec![("TERM", "dumb")], vec![]), (vec![], vec!["--json"]), (vec![("L3_PLAIN", "1")], vec!["todo"]), (vec![("L3_PLAIN", "1")], vec!["git"])] {
        let plain = home.run("en", &args);
        // Nothing is typed: were l3 to offer or ask, it would wait, and this would not end.
        let (code, screen) = home.pty("en", &args, &env).finish();
        assert_eq!((code, home.shown(screen.as_bytes())), (plain.code, plain.stdout.trim_end().to_string()), "{env:?} {args:?}");
    }
}

#[test]
fn the_rail_walks_with_arrows_and_letters_and_backspace_comes_back_to_it() {
    let home = with_notes("menu-keys");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("q leaves");
    l3.send(DOWN).expect("› 2  Forge");
    l3.send("r").expect("› 5  Runtime");
    l3.send("r").expect("› 6  Remote");
    l3.send("f").expect("› 2  Forge");
    l3.send(ENTER).expect("→ l3 band").expect("notes").expect("Backspace purposes");
    l3.send("\x7f").expect("Length³ OS · not signed in").expect("q leaves");
    l3.send("q");
    assert_eq!(l3.finish().0, 0);
}
