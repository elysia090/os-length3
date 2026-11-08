//! The tests of agent/activity.rs.

use super::*;

#[test]
fn every_harness_names_its_events_its_own_way_and_each_is_one_kind() {
    for (name, kind) in [("PreToolUse", Kind::Tool), ("pre_tool_use", Kind::Tool), ("pre-tool", Kind::Tool), ("PostToolUse", Kind::ToolDone),
        ("UserPromptSubmit", Kind::Prompt), ("user-prompt-submit", Kind::Prompt), ("Stop", Kind::Stop), ("turn_end", Kind::Stop),
        ("Notification", Kind::Waits), ("SessionStart", Kind::Start), ("session-end", Kind::End)] {
        assert_eq!(kind_of(name), Some(kind), "{name}");
    }
    assert_eq!(kind_of("PreCompact"), None);
}

#[test]
fn the_box_agent_is_a_session_as_any_harness_is_asked_then_its_turn_over() {
    let asked = from_box("s1\u{1b}[2J", "garden", Kind::Prompt, "How is it\nbuilt?", 10);
    assert_eq!((asked.harness.as_str(), asked.session.as_str(), asked.line.as_str(), asked.text.as_str()), ("box", "s12J", "main", "How is it"));
    let answered = from_box("s1", "garden", Kind::Stop, "Run make.", 20);
    let s = sessions(&[from_box("s1", "garden", Kind::Start, "", 5), from_box("s1", "garden", Kind::Prompt, "How?", 10), answered], 30, RECENT);
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].state.as_str(), s[0].doing.as_str()), ("waits", "Run make."));
}

#[test]
fn a_report_keeps_what_it_did_in_one_line_and_nothing_a_page_would_act_on() {
    let v = serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "npm test\n\u{1b}[2Jrm -rf /"}});
    assert_eq!(text_of(Kind::Tool, &v), "Bash: npm test");
    let v = serde_json::json!({"tool_name": "Edit", "tool_input": {"file_path": "src/a.ts"}});
    assert_eq!(text_of(Kind::ToolDone, &v), "Edit: src/a.ts");
    let long = "x".repeat(400);
    assert_eq!(text_of(Kind::Prompt, &serde_json::json!({"prompt": format!("\u{7}{long}")})).chars().count(), WORDS);
}

#[test]
fn a_session_works_waits_and_ends_as_it_last_said_and_goes_quiet_after_an_hour() {
    let e = |at: u64, session: &str, kind: Kind, text: &str| Event { at, harness: "claude".into(), session: session.into(), repo: "notes".into(),
        line: "001".into(), kind, text: text.into() };
    let events = [e(1, "a", Kind::Start, ""), e(2, "a", Kind::Tool, "Bash: npm test"), e(3, "b", Kind::Prompt, "fix it"), e(4, "a", Kind::Stop, ""),
        e(5, "b", Kind::Tool, "Edit: a.c")];
    let now = sessions(&events, 10, 60_000);
    assert_eq!(now.iter().map(|s| (s.session.as_str(), s.state.as_str(), s.doing.as_str())).collect::<Vec<_>>(),
        [("b", "working", "Edit: a.c"), ("a", "waits", "Bash: npm test")]);
    // Nothing said for an hour: gone; ended long ago: not shown.
    assert!(sessions(&events, 10 + GONE_AFTER + 10, 60_000).is_empty());
    assert_eq!(sessions(&[e(1, "a", Kind::End, "")], 2, 60_000)[0].state, "ended");
}

#[test]
fn a_page_reads_only_what_came_since_and_all_again_once_the_journal_was_cut() {
    let dir = crate::fs::testing::dir("root3-agents");
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("agents.jsonl");
    let e = |at: u64, kind: Kind| Event { at, harness: "grok".into(), session: "a".into(), repo: "notes".into(), line: "main".into(), kind, text: String::new() };
    assert!(now_in(&path, &Cursor::default(), 1).is_none());
    append_to(&path, &e(1, Kind::Start)).unwrap();
    let first = now_in(&path, &Cursor::default(), 1).unwrap();
    assert_eq!((first.events.len(), first.sessions[0].state.as_str()), (1, "working"));
    assert!(now_in(&path, &first.cursor, 2).is_none());
    append_to(&path, &e(3, Kind::Stop)).unwrap();
    let next = now_in(&path, &first.cursor, 3).unwrap();
    assert_eq!((next.events.iter().map(|e| e.kind).collect::<Vec<_>>(), next.sessions[0].state.as_str()), (vec![Kind::Stop], "waits"));
    // Cut (or made anew): its first line is another, and all of it is read again.
    std::fs::write(&path, format!("{}\n", serde_json::to_string(&e(4, Kind::End)).unwrap())).unwrap();
    let again = now_in(&path, &next.cursor, 4).unwrap();
    assert_eq!((again.events.len(), again.sessions[0].state.as_str()), (1, "ended"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn what_a_program_prints_is_said_as_its_work_and_an_agents_stream_as_its_tools() {
    assert_eq!(said_in_output("  \u{1b}[1;32mcompiling\u{1b}[0m a.c\u{7}").as_deref(), Some("compiling a.c"));
    assert_eq!(said_in_output(""), None);
    let tool = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me run it"},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}"#;
    assert_eq!(said_in_output(tool).as_deref(), Some("Bash: npm test"));
    let words = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done.\nAll green"}]}}"#;
    assert_eq!(said_in_output(words).as_deref(), Some("Done."));
    assert_eq!(said_in_output(r#"{"type":"result","result":"Fixed #3"}"#).as_deref(), Some("Fixed #3"));
    assert_eq!(said_in_output(r#"{"type":"system","subtype":"init"}"#), None);
}
