//! l3 at a terminal, through a real pty: bare `l3` is the rail; a purpose
//! picked prints its page and its deeds; a deed asks for its words in place
//! and runs as the command it says; a command typed is followed by its next
//! deeds, passed by with Esc. And where l3 must stay a plain command (L3_PLAIN,
//! --json, TERM=dumb), it writes exactly what it writes off a terminal.

mod common;
use common::{Home, DOWN, ENTER, ESC, LEFT, RIGHT};

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
    // The name is asked again before the next is typed, as a person reads the refusal first (typed sooner, the
    // terminal would echo it beside the refusal, as CI's faster runner once showed), with what was written in it to fix.
    l3.send("notes\r").expect("→ l3 repo new notes -t standard").expect("There is a repo notes already").expect("Name  Letters, digits").expect("› notes");
    l3.send("2\r").expect("Made notes2 (standard · 1 file)").expect("› ").expect("notes2");
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    // Said under the field, not as l3's error line.
    assert!(screen.contains("\n    There is a repo notes already\n") && !screen.contains("l3: There is"), "{screen}");
    assert!(home.path("repos/notes2/README.md").exists());
}

#[test]
fn after_a_command_typed_its_next_deeds_are_said_without_taking_a_key_and_l3_next_opens_them() {
    let home = Home::new("menu-after");
    assert_eq!(home.run("en", &["todo", "add", "Fix：the rail's names"]).code, 0);
    // Said, not asked: l3 ends with no key pressed, so whatever is typed next is the shell's, every character of it.
    let (code, screen) = home.pty("en", &["todo"], &[]).finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.starts_with("  1 ○ Fix：the rail's names\n  Next  Done 1 · Add a TODO"), "{screen}");
    assert!(screen.ends_with("l3 next chooses one with the keys"), "{screen}");
    let (code, screen) = home.pty("en", &["todo", "done", "1"], &[]).finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.contains("Done: Fix：the rail's names\n  Next for 1 ✓ Fix：the rail's names  Edit · Not done · Remove"), "{screen}");
    // l3 next: the same deeds, walked with the keys; chosen, the deed runs as the command it is, and the next ones come after it.
    let mut l3 = home.pty("en", &["next"], &[]);
    l3.expect("→ l3 todo done 1").expect("1 ✓ Fix：the rail's names").expect("goes on");
    l3.send(RIGHT).expect("[Edit]");
    l3.send(RIGHT).expect("[Not done]");
    l3.send(ENTER).expect("→ l3 todo done 1").expect("Not done again: Fix：the rail's names").expect("goes on");
    l3.send(ENTER);
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.ends_with("Not done again: Fix：the rail's names"), "{screen}");
    // Off a terminal there are no keys to choose with, and it says so.
    let off = home.run("en", &["next"]);
    assert_eq!((off.code, off.stderr.as_str()), (1, "l3: l3 next chooses with the keys, at a terminal\n"));
}

#[test]
fn a_new_todo_past_the_twelfth_is_offered_first_and_what_is_left_out_is_said() {
    let home = Home::new("menu-thirteenth");
    for n in 1..=12 { assert_eq!(home.run("en", &["todo", "add", &format!("Fix：item {n}")]).code, 0); }
    let (code, screen) = home.pty("en", &["todo", "add", "Fix：the thirteenth"], &[]).finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.contains("Added to TODO: Fix：the thirteenth (13 open)\n  Next for 13 ○ Fix：the thirteenth  Done · Edit · Remove"), "{screen}");
    let (_, screen) = home.pty("en", &["todo"], &[]).finish();
    assert!(screen.contains("Done 12 · (5 more)"), "{screen}");
}

#[test]
fn a_todo_is_edited_from_its_title_a_key_at_a_time_and_only_what_is_typed_is_kept() {
    let home = Home::new("menu-edit");
    assert_eq!(home.run("en", &["todo", "add", "Fix：typo"]).code, 0);
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("q leaves");
    l3.send(ENTER).expect("› 1  ○ Fix：typo").expect("[Done]");
    l3.send(RIGHT).expect("[Edit]");
    // The field starts with the title; ← then Backspace takes the p, and X goes where the cursor is.
    l3.send(ENTER).expect("First line").expect("› Fix：typo").expect("Esc not now");
    l3.send(LEFT).send("\x7f").send("X").expect("› Fix：tyXo");
    // Home, Delete and a word beyond ASCII, by whole characters.
    l3.send("\x1b[H").send("\x1b[3~").send("直").expect("› 直ix：tyXo");
    l3.send(ENTER).expect("→ l3 todo edit 1 直ix：tyXo").expect("Changed TODO 1: 直ix：tyXo").expect("[Done]");
    // Esc: nothing done, the title as it was.
    l3.send(RIGHT).expect("[Edit]");
    l3.send(ENTER).expect("› 直ix：tyXo");
    l3.send("more").send(ESC).expect("Not done").expect("[Edit]");
    // Enter with nothing changed: the same item, said so.
    l3.send(ENTER).expect("› 直ix：tyXo");
    l3.send(ENTER).expect("TODO 1 was so already: 直ix：tyXo");
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    let json = home.run("en", &["todo", "--json"]).stdout;
    assert!(json.contains("\"title\": \"直ix：tyXo\"") && !json.contains("\\u001b"), "{json}");
}

#[test]
fn a_folder_opened_is_where_the_menu_is_empty_or_not_and_a_new_one_is_made_there() {
    let home = with_notes("menu-folder");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("q leaves");
    l3.send("3").expect("› 3  File");
    l3.send(ENTER).expect("→ l3 file").expect("› 1  notes").expect("[Open]");
    l3.send(ENTER).expect("→ l3 file notes").expect("File · notes").expect("Backspace purposes");
    // New folder asks its path from the folder the menu is in.
    l3.send("n").expect("› 4  New folder");
    l3.send(ENTER).expect("Path").expect("› notes/");
    l3.send("empty\r").expect("→ l3 file mkdir notes/empty").expect("Made the folder notes/empty").expect("empty/");
    // Opened, the empty folder is the page: its own deeds, not its parent's list again.
    l3.send("e").expect("› 2  empty/");
    l3.send(ENTER).expect("→ l3 file notes/empty").expect("notes/empty is empty").expect("File · notes/empty").expect("› 1  New folder");
    // Asked from there, and let go with Esc: nothing made.
    l3.send(ENTER).expect("› notes/empty/");
    l3.send("x").send(ESC).expect("Not done").expect("› 1  New folder");
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(home.path("repos/notes/empty").is_dir() && std::fs::read_dir(home.path("repos/notes/empty")).unwrap().count() == 0);
}

#[test]
fn ctrl_c_in_a_field_leaves_l3_and_nothing_half_made_stays() {
    let home = Home::new("menu-ctrl-c");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("q leaves");
    l3.send("+").expect("› 9  +");
    l3.send(ENTER).expect("[standard]");
    l3.send(ENTER).expect("Name").expect("Ctrl-C leaves l3");
    l3.send("half").send("\x03");
    let (code, _) = l3.finish();
    assert_eq!(code, 130);
    assert!(!home.path("repos/half").exists());
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

#[test]
fn a_prompt_opened_from_the_menu_comes_back_to_the_menu_on_its_repo_when_it_ends() {
    let home = with_notes("menu-prompt");
    assert!(home.root(), "this host lends no sh for a root");
    let mut l3 = home.pty("en", &[], &[]);
    l3.expect("q leaves");
    l3.send("2").expect("› 2  Forge");
    l3.send(ENTER).expect("→ l3 band").expect("› 1  notes").expect("[Prompt]");
    l3.send(ENTER).expect("→ l3 prompt notes");
    // Where the host lets a user make namespaces, the shell; elsewhere l3 says it cannot, and the menu goes on all the same.
    let ran = l3.wait_for(&["# ", "$ ", "unshare"]);
    if ran != "unshare" {
        l3.send("echo in-$((40+2))\r").expect("in-42");
        l3.send("exit\r").expect("The Prompt of notes ended (0); back to the menu");
    }
    // Back on the repo it was opened on, its deeds offered again, and the keys the menu's.
    l3.expect("› 1  notes").expect("[Prompt]").expect("Backspace purposes");
    if ran != "unshare" {
        // Again, from the same menu: a second Prompt is made as the first was, and its code said.
        l3.send(ENTER).expect("→ l3 prompt notes");
        l3.wait_for(&["# ", "$ "]);
        l3.send("exit 3\r").expect("The Prompt of notes ended (3); back to the menu").expect("› 1  notes");
    }
    l3.send("q");
    let (code, screen) = l3.finish();
    assert_eq!(code, 0, "{screen}");
}
