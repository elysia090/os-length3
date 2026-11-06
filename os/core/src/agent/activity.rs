//! What agents do in the person's repos, as their own harnesses say it: Claude Code, Grok Build, DeepSeek Harness
//! (which runs Claude Code's hooks) and the like each call `l3 agent hook HARNESS` from their hooks, with the
//! event's JSON on standard input. Nothing of the agent runs through here; each report is a line appended to
//! `<data>/agents.jsonl`, this device's alone (never sent), and what the app and `l3 agent` show is read from it
//! (`sessions`): which agent works on which repo and issue, what it does now, whether it waits for the person.
//!
//! The journal is a log, not a state: a line is never changed, only added. It is cut to its latest half once it
//! passes JOURNAL bytes, and a reader names where it read to (`Cursor`: the file's generation, the bytes read), so
//! a page that looks every second reads only what came since, and starts over when the file was cut.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

/// The journal's size past which it keeps only its latest half.
const JOURNAL: u64 = 512 * 1024;
/// A session with nothing said for this long is taken as gone (its harness was closed without saying so).
const GONE_AFTER: u64 = 60 * 60 * 1000;
/// What one report keeps of the words it carries (a prompt, a command): enough to recognise it by.
const WORDS: usize = 160;

/// What an agent's harness said happened.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// A session began.
    Start,
    /// The person (or another program) asked it something.
    Prompt,
    /// It is about to use a tool (`text`: which, and on what).
    Tool,
    /// A tool it used is done.
    ToolDone,
    /// It waits for the person: a permission to give, a question to answer.
    Waits,
    /// Its turn is over: what it was asked is done, or it stopped.
    Stop,
    /// The session ended.
    End,
}

/// One report, as the journal keeps it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Event {
    /// When it came, in ms.
    pub at: u64,
    /// The harness that said it (claude, grok, dsh, codex, …).
    pub harness: String,
    /// Its session, as the harness names it.
    pub session: String,
    pub repo: String,
    /// The line it works on: an issue's (its file's stem), or main.
    pub line: String,
    pub kind: Kind,
    /// What it carries, cut short: the tool and what it is used on, the prompt's first line.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// The kind a harness's event name stands for, whichever way it writes it (`PreToolUse`, `pre_tool_use`,
/// `pre-tool`, …); None for one that says nothing the person needs (a compaction, a subagent's start).
pub fn kind_of(event: &str) -> Option<Kind> {
    let e: String = event.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    Some(match e.as_str() {
        "sessionstart" | "start" => Kind::Start,
        "userpromptsubmit" | "prompt" | "promptsubmit" => Kind::Prompt,
        "pretooluse" | "pretool" | "tool" | "toolstart" => Kind::Tool,
        "posttooluse" | "posttool" | "tooldone" | "toolend" => Kind::ToolDone,
        "notification" | "waits" | "permission" | "permissionrequest" => Kind::Waits,
        "stop" | "turnend" | "subagentstop" | "done" => Kind::Stop,
        "sessionend" | "end" => Kind::End,
        _ => return None,
    })
}

/// Words as one line a page shows: a terminal's colours and moves taken out (ESC [ … a letter), no control
/// characters (nothing a terminal or a page would act on), at most WORDS characters.
pub fn line_of(s: &str) -> String {
    let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let (mut one, mut chars) = (String::new(), first.chars().peekable());
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            while chars.next().is_some_and(|c| !('@'..='~').contains(&c)) {}
            continue;
        }
        one.push(if c.is_control() { ' ' } else { c });
    }
    let one = one.trim();
    if one.chars().count() <= WORDS { one.to_string() } else { format!("{}…", one.chars().take(WORDS - 1).collect::<String>()) }
}

/// A tool and what it is used on, as a report says it ("Bash: npm test").
pub fn tool_text(tool: &str, input: Option<&serde_json::Value>) -> String {
    let on = input.map(|i| {
        let f = |k: &str| i.get(k).and_then(|x| x.as_str()).unwrap_or("");
        [f("command"), f("file_path"), f("path"), f("pattern"), f("url"), f("description")].into_iter().find(|x| !x.is_empty()).unwrap_or("").to_string()
    }).unwrap_or_default();
    let tool = if tool.is_empty() { "tool" } else { tool };
    line_of(&if on.is_empty() { tool.to_string() } else { format!("{tool}: {on}") })
}

/// What a line a program printed says of its work, as a page shows it: a tool it used, its words, or its result, when
/// the line is an agent's stream of JSON (Claude Code's `--output-format stream-json`, which others take after); the
/// line itself otherwise. None for a line that says nothing (empty, or JSON that is none of those).
pub fn said_in_output(line: &str) -> Option<String> {
    let t = line.trim();
    if t.is_empty() { return None; }
    if !t.starts_with('{') { return Some(line_of(t)); }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else { return Some(line_of(t)) };
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match s(&v, "type").as_str() {
        "assistant" => {
            let content = v.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            let tool = content.iter().rev().find(|c| s(c, "type") == "tool_use").map(|c| tool_text(&s(c, "name"), c.get("input")));
            tool.or_else(|| content.iter().find(|c| s(c, "type") == "text").map(|c| line_of(&s(c, "text")))).filter(|x| !x.is_empty())
        }
        "result" => Some(line_of(&s(&v, "result"))).filter(|x| !x.is_empty()),
        _ => None,
    }
}

/// What a report says it carries: the tool and what it is used on (a command, a file), or the prompt's first line.
/// Every harness writes these in the same few fields (Claude Code's hooks, which the others take after).
fn text_of(kind: Kind, v: &serde_json::Value) -> String {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    match kind {
        Kind::Tool | Kind::ToolDone => tool_text([s("tool_name"), s("tool")].into_iter().find(|x| !x.is_empty()).unwrap_or(""), v.get("tool_input").or_else(|| v.get("input"))),
        Kind::Prompt => line_of(s("prompt")),
        Kind::Waits => line_of(s("message")),
        _ => String::new(),
    }
}

/// A report read from a harness's hook: its JSON (`payload`), the harness's name, and the event's when the payload
/// does not say it (`event`); where it works is its `cwd` (else `cwd_here`), a repo here or an issue's copy of one.
/// None when it says nothing worth keeping, or works outside the person's repos.
pub fn report(harness: &str, event: Option<&str>, payload: &str, cwd_here: &std::path::Path, now: u64) -> Option<Event> {
    let v: serde_json::Value = serde_json::from_str(payload).unwrap_or(serde_json::Value::Null);
    let s = |k: &str| v.get(k).and_then(|x| x.as_str());
    let name = s("hook_event_name").or(s("event")).or(s("type")).or(event)?;
    let kind = kind_of(name)?;
    let cwd = s("cwd").map(PathBuf::from).unwrap_or_else(|| cwd_here.to_path_buf());
    let here = crate::repos::lines::here(&cwd)?;
    let harness: String = harness.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(24).collect::<String>().to_ascii_lowercase();
    let session: String = s("session_id").or(s("session")).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).take(64).collect();
    Some(Event { at: now, harness: if harness.is_empty() { "agent".into() } else { harness }, session, repo: here.repo, line: here.line, kind, text: text_of(kind, &v) })
}

/// The box's own Agent (the app's, asked from the box at a repo's foot) said as a harness's hooks say it, as `box`:
/// its `session`, the line `repo` shows, `kind` (asked, answered), its words as one line. The same journal and the
/// same sessions as any agent's: wherever agents are shown at work, it is too.
pub fn from_box(session: &str, repo: &str, kind: Kind, text: &str, now: u64) -> Event {
    let session = session.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).take(64).collect();
    Event { at: now, harness: "box".into(), session, repo: repo.into(), line: crate::repos::lines::current(repo), kind, text: line_of(text) }
}

fn journal() -> PathBuf {
    crate::fs::paths::data_dir().join("agents.jsonl")
}

/// Keep `e` at the journal's end (cut to its latest half once it is too large).
pub fn append(e: &Event) -> Result<()> {
    append_to(&journal(), e)
}

fn append_to(path: &std::path::Path, e: &Event) -> Result<()> {
    append_line(path, &serde_json::to_string(e).map_err(|e| e.to_string())?, JOURNAL)
}

/// Keep `line` at the end of the log at `path` (0600, its folder private), the log cut to its latest half once it
/// passes `most` bytes: the journal's way, and the compute ledger's.
pub(crate) fn append_line(path: &std::path::Path, line: &str, most: u64) -> Result<()> {
    crate::fs::write::private_dir(path.parent().unwrap_or(std::path::Path::new("."))).map_err(|e| e.to_string())?;
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > most {
        // Its latest half, from the first whole line in it. (A line appended to the file being cut is lost: one
        // line, once in a long while, of a log kept to show what happened.)
        let bytes = std::fs::read(path).unwrap_or_default();
        let half = &bytes[bytes.len() / 2..];
        let from = half.iter().position(|b| *b == b'\n').map_or(half.len(), |i| i + 1);
        crate::fs::write::replace(path, &half[from..], crate::fs::write::How::PRIVATE).map_err(|e| e.to_string())?;
    }
    // One write of one line, appended: lines from several processes at once are never interleaved.
    let mut open = std::fs::OpenOptions::new();
    open.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let mut f = open.open(path).map_err(|e| e.to_string())?;
    f.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())
}

/// Every report the journal holds, oldest first (a line that cannot be read is passed over).
pub fn events_in(text: &str) -> Vec<Event> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Where a reader read the journal to: the bytes read of the file as it was when it read (`len`), and that file's
/// first line, by which a file cut since (or made anew) is known.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Cursor { pub len: u64, pub head: String }

/// One agent's session, as the journal says it now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Session {
    pub harness: String,
    pub session: String,
    pub repo: String,
    pub line: String,
    pub started: u64,
    pub last: u64,
    /// working: it is doing something; waits: it waits for the person (a permission, an answer, its turn over);
    /// ended: it said so, or said nothing for an hour.
    pub state: String,
    /// What it does or did last (a tool and what on), or was asked.
    pub doing: String,
}

/// The sessions `events` tell of, newest first: those not ended, and those ended within `recent` ms of `now`.
pub fn sessions(events: &[Event], now: u64, recent: u64) -> Vec<Session> {
    let mut by: Vec<Session> = Vec::new();
    for e in events {
        let key = (e.harness.as_str(), e.session.as_str(), e.repo.as_str());
        let at = by.iter().position(|s| (s.harness.as_str(), s.session.as_str(), s.repo.as_str()) == key);
        let s = match at {
            Some(i) => &mut by[i],
            None => { by.push(Session { harness: e.harness.clone(), session: e.session.clone(), repo: e.repo.clone(), line: e.line.clone(),
                started: e.at, last: e.at, state: String::new(), doing: String::new() }); by.last_mut().unwrap() }
        };
        s.last = e.at;
        s.line = e.line.clone();
        s.state = match e.kind { Kind::Waits | Kind::Stop => "waits", Kind::End => "ended", _ => "working" }.into();
        if !e.text.is_empty() { s.doing = e.text.clone(); }
    }
    for s in &mut by { if s.state != "ended" && now.saturating_sub(s.last) > GONE_AFTER { s.state = "ended".into(); } }
    by.retain(|s| s.state != "ended" || now.saturating_sub(s.last) <= recent);
    by.sort_by_key(|s| std::cmp::Reverse(s.last));
    by
}

/// What the journal says now, for a page that read it to `from`: what came since (all of it, when the file is not
/// the one `from` read), who works where, and where this read ends. None when nothing came since: a page that asks
/// every second reads a few bytes then (the file's size and its first line), never the journal.
pub fn now_since(from: &Cursor, now: u64) -> Option<Now> {
    now_in(&journal(), from, now)
}

fn now_in(path: &std::path::Path, from: &Cursor, now: u64) -> Option<Now> {
    use std::io::BufRead;
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let head = |text: &str| text.lines().next().unwrap_or("").to_string();
    if len == from.len && !from.head.is_empty() {
        let mut first = String::new();
        if let Ok(f) = std::fs::File::open(path) { let _ = std::io::BufReader::new(f).read_line(&mut first); }
        if head(&first) == from.head { return None; }
    }
    if len == 0 && from.head.is_empty() && from.len == 0 { return None; }
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let cursor = Cursor { len: text.len() as u64, head: head(&text) };
    let same = !from.head.is_empty() && from.head == cursor.head && (from.len as usize) <= text.len() && text.is_char_boundary(from.len as usize);
    let all = events_in(&text);
    let events = if same { events_in(&text[from.len as usize..]) } else { all.clone() };
    Some(Now { sessions: sessions(&all, now, RECENT), events, cursor })
}

/// Sessions ended within this long are still shown, as ended.
pub const RECENT: u64 = 10 * 60 * 1000;

/// What a page is told when something came.
#[derive(Serialize, Debug)]
pub struct Now { pub events: Vec<Event>, pub sessions: Vec<Session>, pub cursor: Cursor }

/// The journal now: every report it holds.
pub fn all() -> Vec<Event> {
    events_in(&std::fs::read_to_string(journal()).unwrap_or_default())
}

#[cfg(test)]
#[path = "tests/activity.rs"]
mod tests;
