//! why at a terminal, through a real pty: bare `why` is the rail; a purpose
//! picked prints its page and its deeds; a deed asks for its words in place
//! and runs as the command it says; a command typed is followed by its next
//! deeds, passed by with Esc. And where why must stay a plain command (WHY_PLAIN,
//! --json, TERM=dumb), it writes exactly what it writes off a terminal.

#[path = "../common/mod.rs"]
mod common;
use common::{DOWN, ENTER, ESC, Home, LEFT, RIGHT};

/// A home with the repo notes in it.
fn with_notes(name: &str) -> Home {
    let home = Home::new(name);
    assert_eq!(home.run("en", &["repo", "new", "notes"]).code, 0);
    home
}

#[test]
fn bare_why_is_the_rail_a_purpose_its_page_and_a_deed_asks_its_words_in_place() {
    let home = with_notes("menu-git");
    let mut why = home.pty("en", &[], &[]);
    why.expect("Git      Issues and commits · 0 issues open").expect("q leaves");
    // A number goes to the place, Enter opens it: its page, said as the command it is, then its deeds.
    why.send("4").expect("› 4  Git");
    why.send(ENTER).expect("→ why git").expect("No issues yet").expect("› 1  Write an issue").expect("Backspace purposes");
    // The deed asks for its one line in place, under its name and what goes in it, as the app's field does.
    why.send(ENTER).expect("Repo  notes").expect("First line  Kind：title");
    why.send("Fix：restart loses the draft\r")
        .expect("→ why issue new notes \"Fix：restart loses the draft\"")
        .expect("Wrote notes#1 Fix：restart loses the draft")
        // The issue just written is landed on, with what comes next for it.
        .expect("› 1  #1 Fix：restart loses the draft")
        .expect("[Open]");
    why.send("q");
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.starts_with("why* · not signed in\n› Git  Issues and commits\n→ why git\n"), "{screen}");
    // Left, the rows stay as text: no mark, no keys.
    assert!(!screen.contains("q leaves") && !screen.lines().last().unwrap_or_default().contains('›'), "{screen}");
    let file = std::fs::read_to_string(home.path("repos/notes/issue/001.md")).expect("the issue's file");
    assert!(file.starts_with("Fix：restart loses the draft"), "{file}");
}

#[test]
fn in_japanese_home_adds_a_todo_and_lands_on_it() {
    let home = Home::new("menu-ja");
    let mut why = home.pty("ja", &[], &[]);
    why.expect("Home     プロフィール · TODO 残り 0 / 0").expect("q 終わる");
    why.send(ENTER).expect("→ why todo").expect("TODO はまだありません").expect("→ why profile").expect("› 1  TODO を足す").expect("Backspace 目的");
    why.send(ENTER).expect("1行目  種別：件名");
    why.send("Fix：レールの名前\r").expect("→ why todo add Fix：レールの名前").expect("TODO に足しました：Fix：レールの名前（残り1件）")
        .expect("› 1  ○ Fix：レールの名前").expect("[完了]");
    why.send(ESC);
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    assert_eq!(home.run("ja", &["todo"]).stdout, "  1 ○ Fix：レールの名前\n");
}

#[test]
fn a_name_refused_is_said_under_its_field_and_asked_again() {
    let home = with_notes("menu-plus");
    let mut why = home.pty("en", &[], &[]);
    why.expect("+        New repo");
    why.send("+").expect("› 9  +");
    // One scaffold, as the app makes it: nothing to choose, the name first.
    why.send(ENTER).expect("Name  Letters, digits");
    // The name is asked again before the next is typed, as a person reads the refusal first (typed sooner, the
    // terminal would echo it beside the refusal, as CI's faster runner once showed), with what was written in it to fix.
    why.send("notes\r").expect("→ why repo new notes").expect("There is a repo notes already").expect("Name  Letters, digits").expect("› notes");
    why.send("2\r").expect("Made notes2 (standard · 1 file)").expect("› ").expect("notes2");
    why.send("q");
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    // Said under the field, not as why's error line.
    assert!(screen.contains("\n    There is a repo notes already\n") && !screen.contains("why: There is"), "{screen}");
    assert!(home.path("repos/notes2/README.md").exists());
}

#[test]
fn after_a_command_typed_its_next_deeds_are_said_without_taking_a_key_and_why_next_opens_them() {
    let home = Home::new("menu-after");
    assert_eq!(home.run("en", &["todo", "add", "Fix：the rail's names"]).code, 0);
    // Said, not asked: why ends with no key pressed, so whatever is typed next is the shell's, every character of it.
    let (code, screen) = home.pty("en", &["todo"], &[]).finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.starts_with("  1 ○ Fix：the rail's names\n  Next  Done 1 · Add a TODO"), "{screen}");
    assert!(screen.ends_with("why next chooses one with the keys"), "{screen}");
    let (code, screen) = home.pty("en", &["todo", "done", "1"], &[]).finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.contains("Done: Fix：the rail's names\n  Next for 1 ✓ Fix：the rail's names  Edit · Not done · Remove"), "{screen}");
    // why next: the same deeds, walked with the keys; chosen, the deed runs as the command it is, and the next ones come after it.
    let mut why = home.pty("en", &["next"], &[]);
    why.expect("→ why todo done 1").expect("1 ✓ Fix：the rail's names").expect("goes on");
    why.send(RIGHT).expect("[Edit]");
    why.send(RIGHT).expect("[Not done]");
    why.send(ENTER).expect("→ why todo done 1").expect("Not done again: Fix：the rail's names").expect("goes on");
    why.send(ENTER);
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(screen.ends_with("Not done again: Fix：the rail's names"), "{screen}");
    // Off a terminal there are no keys to choose with, and it says so.
    let off = home.run("en", &["next"]);
    assert_eq!((off.code, off.stderr.as_str()), (1, "why: why next chooses with the keys, at a terminal\n"));
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
    let mut why = home.pty("en", &[], &[]);
    why.expect("q leaves");
    why.send(ENTER).expect("› 1  ○ Fix：typo").expect("[Done]");
    why.send(RIGHT).expect("[Edit]");
    // The field starts with the title; ← then Backspace takes the p, and X goes where the cursor is.
    why.send(ENTER).expect("First line").expect("› Fix：typo").expect("Esc not now");
    why.send(LEFT).send("\x7f").send("X").expect("› Fix：tyXo");
    // Home, Delete and a word beyond ASCII, by whole characters.
    why.send("\x1b[H").send("\x1b[3~").send("直").expect("› 直ix：tyXo");
    why.send(ENTER).expect("→ why todo edit 1 直ix：tyXo").expect("Changed TODO 1: 直ix：tyXo").expect("[Done]");
    // Esc: nothing done, the title as it was.
    why.send(RIGHT).expect("[Edit]");
    why.send(ENTER).expect("› 直ix：tyXo");
    why.send("more").send(ESC).expect("Not done").expect("[Edit]");
    // Enter with nothing changed: the same item, said so.
    why.send(ENTER).expect("› 直ix：tyXo");
    why.send(ENTER).expect("TODO 1 was so already: 直ix：tyXo");
    why.send("q");
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    let json = home.run("en", &["todo", "--json"]).stdout;
    assert!(json.contains("\"title\": \"直ix：tyXo\"") && !json.contains("\\u001b"), "{json}");
}

#[test]
fn a_folder_opened_is_where_the_menu_is_empty_or_not_and_a_new_one_is_made_there() {
    let home = with_notes("menu-folder");
    let mut why = home.pty("en", &[], &[]);
    why.expect("q leaves");
    why.send("3").expect("› 3  File");
    why.send(ENTER).expect("→ why file").expect("› 1  notes").expect("[Open]");
    why.send(ENTER).expect("→ why file notes").expect("File · notes").expect("Backspace purposes");
    // New folder asks its path from the folder the menu is in.
    why.send("n").expect("› 3  New folder");
    why.send(ENTER).expect("Path").expect("› notes/");
    why.send("empty\r").expect("→ why file mkdir notes/empty").expect("Made the folder notes/empty").expect("empty/");
    // Opened, the empty folder is the page: its own deeds, not its parent's list again.
    why.send("e").expect("› 2  empty/");
    why.send(ENTER).expect("→ why file notes/empty").expect("notes/empty is empty").expect("File · notes/empty").expect("› 1  New folder");
    // Asked from there, and let go with Esc: nothing made.
    why.send(ENTER).expect("› notes/empty/");
    why.send("x").send(ESC).expect("Not done").expect("› 1  New folder");
    why.send("q");
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
    assert!(home.path("repos/notes/empty").is_dir() && std::fs::read_dir(home.path("repos/notes/empty")).unwrap().count() == 0);
}

#[test]
fn ctrl_c_in_a_field_leaves_why_and_nothing_half_made_stays() {
    let home = Home::new("menu-ctrl-c");
    let mut why = home.pty("en", &[], &[]);
    why.expect("q leaves");
    why.send("+").expect("› 9  +");
    why.send(ENTER).expect("Name").expect("Ctrl-C leaves why");
    why.send("half").send("\x03");
    let (code, _) = why.finish();
    assert_eq!(code, 130);
    assert!(!home.path("repos/half").exists());
}

#[test]
fn where_why_must_stay_a_plain_command_it_writes_what_it_writes_off_a_terminal() {
    let home = with_notes("menu-plain");
    assert_eq!(home.run("en", &["todo", "add", "Fix：x"]).code, 0);
    for (env, args) in [(vec![("WHY_PLAIN", "1")], vec![]), (vec![("TERM", "dumb")], vec![]), (vec![], vec!["--json"]), (vec![("WHY_PLAIN", "1")], vec!["todo"]), (vec![("WHY_PLAIN", "1")], vec!["git"])] {
        let plain = home.run("en", &args);
        // Nothing is typed: were why to offer or ask, it would wait, and this would not end.
        let (code, screen) = home.pty("en", &args, &env).finish();
        assert_eq!((code, home.shown(screen.as_bytes())), (plain.code, plain.stdout.trim_end().to_string()), "{env:?} {args:?}");
    }
}

#[test]
fn the_rail_walks_with_arrows_and_letters_and_backspace_comes_back_to_it() {
    let home = with_notes("menu-keys");
    let mut why = home.pty("en", &[], &[]);
    why.expect("q leaves");
    why.send(DOWN).expect("› 2  Forge");
    why.send("r").expect("› 5  Runtime");
    why.send("r").expect("› 6  Remote");
    why.send("f").expect("› 2  Forge");
    why.send(ENTER).expect("→ why band").expect("notes").expect("Backspace purposes");
    why.send("\x7f").expect("why* · not signed in").expect("q leaves");
    why.send("q");
    assert_eq!(why.finish().0, 0);
}

#[test]
fn a_prompt_opened_from_the_menu_comes_back_to_the_menu_on_its_repo_when_it_ends() {
    let home = with_notes("menu-prompt");
    assert!(home.root(), "this host lends no sh for a root");
    let mut why = home.pty("en", &[], &[]);
    why.expect("q leaves");
    why.send("2").expect("› 2  Forge");
    why.send(ENTER).expect("→ why band").expect("› 1  notes").expect("[Prompt]");
    why.send(ENTER).expect("→ why prompt notes");
    // Where the host lets a user make namespaces, the shell; elsewhere why says why it could not, the Prompt ends with
    // its code, and the menu goes on all the same.
    let ran = why.wait_for(&["# ", "$ ", "ended ("]);
    if ran != "ended (" {
        why.send("echo in-$((40+2))\r").expect("in-42");
        why.send("exit\r").expect("The Prompt of notes ended (0); back to the menu");
    }
    // Back on the repo it was opened on, its deeds offered again, and the keys the menu's.
    why.expect("› 1  notes").expect("[Prompt]").expect("Backspace purposes");
    if ran != "ended (" {
        // Again, from the same menu: a second Prompt is made as the first was, and its code said.
        why.send(ENTER).expect("→ why prompt notes");
        why.wait_for(&["# ", "$ "]);
        why.send("exit 3\r").expect("The Prompt of notes ended (3); back to the menu").expect("› 1  notes");
    }
    why.send("q");
    let (code, screen) = why.finish();
    assert_eq!(code, 0, "{screen}");
}
