//! What an agent does for the person, and when. Three rules make it:
//!
//! - **It reads by itself; it writes only when handed.** A review of a change handed in and a run of the repo's tests
//!   start by themselves; solving an issue or fixing failing tests is offered, and starts once the person hands it
//!   over.
//! - **It moves at the edges of the person's own work, never on a clock**: an issue written, a commit, a change handed
//!   in, a merge, back on main. Those are where the person's attention is free, and where what changed is whole.
//! - **The most complex first.** Units go goal (an issue), responsibility (a folder of the change: one part of the
//!   system), test, file, question: tasks waiting run in that order, the heaviest first within one, and a review
//!   reads a change in it, top down, the hardest part first.
//!
//! A task goes offered → waiting → working → ready, or asking (it needs the person: their reply sends it on again),
//! done (looked at, or its issue merged), dropped (not now), stopped (it could not run, and the one fix). The person
//! sees none of those words: an offer to hand over, the work going on in its issue's box, a question, something to
//! look at. One runs at a time in a repo (`l3 agent run`, set off by `kick`), on its own Prompt: the issue's copy for
//! what writes, so it is the work the person would have started; the change's copy for a review.
//!
//! Kept in `<data>/tasks.json`, this device's alone (never sent).

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use crate::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What a task is about, the most complex first.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Unit { Goal, Responsibility, Test, File, Question }

impl Unit {
    pub fn word(self) -> &'static str {
        match self { Unit::Goal => "goal", Unit::Responsibility => "responsibility", Unit::Test => "test", Unit::File => "file", Unit::Question => "question" }
    }
    fn of(word: &str) -> Option<Unit> {
        [Unit::Goal, Unit::Responsibility, Unit::Test, Unit::File, Unit::Question].into_iter().find(|u| u.word() == word)
    }
}

/// What it does.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Deed {
    /// Solve an issue, on its own copy. Writes: offered.
    Take,
    /// Read a change handed in, top down, the hardest part first. Reads: by itself.
    Review,
    /// Run the repo's tests on the work (no agent). Reads: by itself.
    Tests,
    /// Make the tests that failed pass. Writes: offered.
    Fix,
    /// Answer the person's question. Reads: asked.
    Ask,
}

impl Deed {
    /// Whether it changes the repo's files (and so runs only once handed, on the issue's copy the repo shows).
    pub fn writes(self) -> bool { matches!(self, Deed::Take | Deed::Fix) }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum State { Offered, Waiting, Working, Asking, Ready, Done, Dropped, Stopped }

impl State {
    /// Over: nothing more comes of it.
    pub fn over(self) -> bool { matches!(self, State::Done | State::Dropped) }
}

/// Something it found, at a unit (and where).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Finding {
    pub unit: Unit,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Task {
    pub id: u64,
    pub repo: String,
    /// The line it is on: an issue's, or main.
    pub line: String,
    /// The issue it is for (issue/NNN.md), if one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub issue: String,
    pub deed: Deed,
    pub unit: Unit,
    /// What it is for, in the person's words: the issue's title, the question.
    pub words: String,
    pub state: State,
    pub made: u64,
    pub updated: u64,
    /// How heavy it is: the order tasks waiting run in, within a unit.
    #[serde(default)]
    pub weight: u64,
    /// What it found, the most important first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub found: Vec<Finding>,
    /// What only the person can answer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<String>,
    /// Its last words: what it did, the answer, or why it stopped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub said: String,
    /// Stopped: the one thing that lets it run (an l3 line).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fix: String,
    /// The agent's session, to go on in with the person's reply.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session: String,
    /// The person's reply, given when it runs again.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reply: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Book { next: u64, tasks: Vec<Task> }

/// Tasks over are kept this long (a page that missed them still says what came of them), at most this many in all.
const KEPT: u64 = 24 * 60 * 60 * 1000;
const MOST: usize = 200;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn dir() -> PathBuf { crate::paths::data_dir().join("tasks") }

/// The book, changed by `f` under its lock (the app, l3 and each repo's runner change it).
fn with<T>(f: impl FnOnce(&mut Book) -> T) -> Result<T> {
    with_in(&dir(), f)
}

fn with_in<T>(dir: &Path, f: impl FnOnce(&mut Book) -> T) -> Result<T> {
    crate::boundary::private_dir(dir).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".lock")).map_err(|e| e.to_string())?;
    // The browser's core is one instance at a time, and has no locks to take.
    match lock.lock() { Err(e) if e.kind() != std::io::ErrorKind::Unsupported => return Err(e.to_string()), _ => {} }
    let path = dir.join("tasks.json");
    let mut book: Book = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let out = f(&mut book);
    let t = now();
    book.tasks.retain(|k| !k.state.over() || t.saturating_sub(k.updated) < KEPT);
    let extra = book.tasks.len().saturating_sub(MOST);
    book.tasks.drain(..extra);
    let bytes = serde_json::to_vec(&book).map_err(|e| e.to_string())?;
    crate::atomic::replace(&path, &bytes, crate::atomic::How::PRIVATE).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The tasks now (those over a moment ago among them), oldest first.
pub fn all() -> Vec<Task> {
    std::fs::read(dir().join("tasks.json")).ok().and_then(|b| serde_json::from_slice::<Book>(&b).ok()).map(|b| b.tasks).unwrap_or_default()
}

/// What the book and the agent are now, for a page to know whether to read them again: the book's size and when it
/// changed, and whether an agent is set up.
pub fn mark() -> [u64; 3] {
    let m = std::fs::metadata(dir().join("tasks.json")).ok();
    [m.as_ref().map_or(0, |m| m.len()), m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64),
        u64::from(dir().join("agent").is_file())]
}

/// What a task is for, as an edge or a deed asks for it.
struct Ask<'a> { repo: &'a str, line: &'a str, issue: &'a str, deed: Deed, unit: Unit, words: &'a str, weight: u64 }

/// A task for `a`, as `state`: one not yet run for the same thing is that task, renewed (a newer edge stands for an
/// older one); one running or asking is left to go on, and a new one waits after it.
fn put(book: &mut Book, a: Ask, state: State) -> Task {
    let Ask { repo, line, issue, deed, unit, words, weight } = a;
    let t = now();
    let same = |k: &Task| k.repo == repo && k.line == line && k.issue == issue && k.deed == deed;
    if let Some(k) = book.tasks.iter_mut().find(|k| same(k) && matches!(k.state, State::Offered | State::Waiting | State::Stopped | State::Ready)) {
        // An offer taken stays taken; one ready or stopped is begun again.
        k.state = if k.state == State::Waiting { State::Waiting } else { state };
        k.words = words.into();
        k.weight = weight;
        k.updated = t;
        k.found.clear();
        k.questions.clear();
        k.said.clear();
        k.fix.clear();
        return k.clone();
    }
    book.next += 1;
    let k = Task { id: book.next, repo: repo.into(), line: line.into(), issue: issue.into(), deed, unit, words: words.into(), state, made: t, updated: t,
        weight, found: Vec::new(), questions: Vec::new(), said: String::new(), fix: String::new(), session: String::new(), reply: String::new() };
    book.tasks.push(k.clone());
    k
}

/// The agent this device hands work to (`l3 agent on`), if one.
pub fn agent() -> Option<String> {
    std::fs::read_to_string(dir().join("agent")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Hand work to `harness` from now on (None: to none).
pub fn set_agent(harness: Option<&str>) -> Result<()> {
    crate::boundary::private_dir(&dir()).map_err(|e| e.to_string())?;
    match harness {
        Some(h) => crate::atomic::replace(&dir().join("agent"), h.as_bytes(), crate::atomic::How::PRIVATE).map_err(|e| e.to_string()),
        None => match std::fs::remove_file(dir().join("agent")) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) },
    }
}

/// The agent as a person knows it.
pub fn agent_name(harness: &str) -> String {
    match harness { "box" => "Agent".into(), "claude" => "Claude Code".into(), "grok" => "Grok Build".into(), "dsh" => "DeepSeek Harness".into(), "codex" => "Codex".into(), h => h.into() }
}

/// How the agent is run in a Prompt, told `$L3_TASK` (and `$L3_RESUME`, its session to go on in): the first line of
/// the person's `.agent` dotfile when they keep one, else the harness's own way.
pub fn agent_command(harness: &str) -> Option<String> {
    let own = crate::home::dotfiles_in_effect().into_iter().find(|(n, _)| n == ".agent")
        .and_then(|(_, t)| t.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).map(String::from));
    own.or_else(|| match harness {
        // Its own Prompt is the sandbox: nothing outside the repo, the network only as the repo was given it.
        "claude" => Some(r#"IS_SANDBOX=1 claude -p "$L3_TASK" --output-format stream-json --verbose --dangerously-skip-permissions ${L3_RESUME:+--resume "$L3_RESUME"}"#.into()),
        _ => None,
    })
}

// ---- the edges it moves at ----

/// An issue written here: offered to the agent, when one is set up.
pub fn issue_written(repo: &str, issue: &str, title: &str) {
    let (Some(_), Some(line)) = (agent(), crate::work::line_for(issue)) else { return };
    let _ = with(|b| put(b, Ask { repo, line: &line, issue, deed: Deed::Take, unit: Unit::Goal, words: title, weight: 0 }, State::Offered));
}

/// A commit on an issue's work: its tests run by themselves, when the repo says how to run them.
pub fn committed(repo: &str, line: &str, dir: &Path) {
    if line == crate::work::MAIN || tests_command(dir).is_none() { return; }
    let issue = format!("issue/{line}.md");
    if with(|b| put(b, Ask { repo, line, issue: &issue, deed: Deed::Tests, unit: Unit::Test, words: "", weight: 0 }, State::Waiting)).is_ok() { kick(repo); }
}

/// A change handed in here: read by the agent by itself, when one is set up.
pub fn handed_in(repo: &str, line: &str, issue: &str, title: &str) {
    if agent().is_none() { return; }
    if with(|b| put(b, Ask { repo, line, issue, deed: Deed::Review, unit: Unit::Goal, words: title, weight: 0 }, State::Waiting)).is_ok() { kick(repo); }
}

/// An issue merged (or closed): what was offered or waiting for it is done with.
pub fn issue_over(repo: &str, issue: &str) {
    let _ = with(|b| for k in b.tasks.iter_mut().filter(|k| k.repo == repo && k.issue == issue && !k.state.over() && k.state != State::Working) {
        k.state = State::Done;
        k.updated = now();
    });
}

/// The repo is back on main: work handed over that waited for it can begin.
pub fn back_on_main(repo: &str) {
    if all().iter().any(|k| k.repo == repo && k.state == State::Waiting) { kick(repo); }
}

// ---- the person's deeds ----

/// Hand an offer over (or what stopped, to try again): it waits its turn.
pub fn take(id: u64) -> Result<Task> {
    let k = with(|b| b.tasks.iter_mut().find(|k| k.id == id).map(|k| {
        if matches!(k.state, State::Offered | State::Stopped | State::Ready) { k.state = State::Waiting; k.updated = now(); }
        k.clone()
    }))?.ok_or_else(|| crate::tr!("There is no task {}", "タスク {} はありません", id))?;
    kick(&k.repo);
    Ok(k)
}

/// Not now (an offer), or looked at (what is ready): over.
pub fn drop_task(id: u64) -> Result<Task> {
    with(|b| b.tasks.iter_mut().find(|k| k.id == id).map(|k| {
        if k.state != State::Working { k.state = if k.state == State::Ready { State::Done } else { State::Dropped }; k.updated = now(); }
        k.clone()
    }))?.ok_or_else(|| crate::tr!("There is no task {}", "タスク {} はありません", id))
}

/// The person's answer to what it asked: it goes on with it.
pub fn reply(id: u64, words: &str) -> Result<Task> {
    let k = with(|b| b.tasks.iter_mut().find(|k| k.id == id && k.state == State::Asking).map(|k| {
        k.reply = words.trim().to_string();
        k.questions.clear();
        k.state = State::Waiting;
        k.updated = now();
        k.clone()
    }))?.ok_or_else(|| crate::tr!("Task {} asks nothing", "タスク {} は何も聞いていません", id))?;
    kick(&k.repo);
    Ok(k)
}

/// A question about `repo` (its main, or the line it shows): answered by the agent, reading only.
pub fn ask(repo: &str, words: &str) -> Result<Task> {
    if agent().is_none() { return Err(crate::tr!("No agent to ask (l3 agent on claude)", "聞けるエージェントがいません（l3 agent on claude）")); }
    let line = crate::work::current(repo);
    let k = with(|b| put(b, Ask { repo, line: &line, issue: "", deed: Deed::Ask, unit: Unit::Question, words: words.trim(), weight: 0 }, State::Waiting))?;
    kick(&k.repo);
    Ok(k)
}

// ---- running them ----

/// The next task of `repo` to run, now working: the most complex unit first, the heaviest within it, then the oldest.
/// One that writes waits while the repo shows another issue's work (the person's own), and runs once it is back.
pub fn next(repo: &str) -> Result<Option<Task>> {
    let shown = crate::work::current(repo);
    with(|b| {
        let mut ready: Vec<&mut Task> = b.tasks.iter_mut().filter(|k| k.repo == repo && k.state == State::Waiting
            && (!k.deed.writes() || shown == crate::work::MAIN || shown == k.line)).collect();
        ready.sort_by(|a, b| a.unit.cmp(&b.unit).then(b.weight.cmp(&a.weight)).then(a.made.cmp(&b.made)));
        ready.into_iter().next().map(|k| { k.state = State::Working; k.updated = now(); k.clone() })
    })
}

/// How a run ended, as the runner read it.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub code: i32,
    /// The agent's last words (its result), or the last lines the command printed.
    pub result: String,
    pub session: String,
    /// It could not run: why, and the one fix.
    pub stopped: Option<(String, String)>,
}

/// A run over: what it found and asked, kept; tests that failed, offered to fix.
pub fn finished(id: u64, o: Outcome) -> Result<Option<Task>> {
    with(|b| {
        let at = b.tasks.iter().position(|k| k.id == id)?;
        let (found, questions, said) = read_result(&o.result);
        let k = &mut b.tasks[at];
        k.updated = now();
        k.reply.clear();
        if !o.session.is_empty() { k.session = o.session.clone(); }
        if let Some((why, fix)) = &o.stopped {
            // What runs by itself and cannot run here (no test runner in the Prompt) says nothing: it is no one's to fix.
            k.state = if k.deed == Deed::Tests { State::Dropped } else { State::Stopped };
            k.said = why.clone();
            k.fix = fix.clone();
            return Some(k.clone());
        }
        if k.deed == Deed::Tests {
            if o.code == 0 { k.state = State::Done; return Some(k.clone()); }
            k.state = State::Ready;
            k.found = failing(&o.result).into_iter().map(|text| Finding { unit: Unit::Test, path: String::new(), line: None, text }).collect();
            k.said = crate::tr!("The tests fail ({})", "テストが通りません（{}）", o.code);
            let (repo, line, issue, words) = (k.repo.clone(), k.line.clone(), k.issue.clone(), k.found.first().map(|f| f.text.clone()).unwrap_or_default());
            let done = k.clone();
            if agent().is_some() { put(b, Ask { repo: &repo, line: &line, issue: &issue, deed: Deed::Fix, unit: Unit::Test, words: &words, weight: 0 }, State::Offered); }
            return Some(done);
        }
        k.found = found;
        k.questions = questions;
        k.said = if said.is_empty() && o.code != 0 { crate::tr!("It ended without finishing ({})", "終わりきらずに止まりました（{}）", o.code) } else { said };
        k.state = if !k.questions.is_empty() { State::Asking } else { State::Ready };
        Some(k.clone())
    })
}

/// What an agent's last words say, by the lines it was asked to end with: `FINDING unit path[:line] what`,
/// `QUESTION what`, `DONE what`; its last line when it said none of them.
pub fn read_result(text: &str) -> (Vec<Finding>, Vec<String>, String) {
    let (mut found, mut questions, mut done) = (Vec::new(), Vec::new(), String::new());
    for l in text.lines().map(str::trim) {
        let l = l.trim_start_matches(['-', '*', ' ']);
        if let Some(rest) = l.strip_prefix("FINDING ") {
            let mut w = rest.splitn(3, ' ');
            let (unit, at, what) = (w.next().unwrap_or(""), w.next().unwrap_or(""), w.next().unwrap_or(""));
            let Some(unit) = Unit::of(unit) else { found.push(Finding { unit: Unit::File, path: String::new(), line: None, text: crate::agents::line_of(rest) }); continue };
            let (path, line) = match at.rsplit_once(':') { Some((p, n)) if n.parse::<u32>().is_ok() => (p, n.parse().ok()), _ => (at, None) };
            // A path is a repo's own, never one out of it.
            let path = if path == "-" || path.starts_with('/') || path.split('/').any(|p| p == "..") { "" } else { path };
            found.push(Finding { unit, path: path.into(), line, text: crate::agents::line_of(what) });
        } else if let Some(q) = l.strip_prefix("QUESTION ") {
            questions.push(crate::agents::line_of(q));
        } else if let Some(d) = l.strip_prefix("DONE ") {
            done = crate::agents::line_of(d);
        }
    }
    if done.is_empty() && found.is_empty() && questions.is_empty() {
        done = text.lines().rev().find(|l| !l.trim().is_empty()).map(crate::agents::line_of).unwrap_or_default();
    }
    // The most complex unit first, as it read them.
    found.sort_by_key(|f| f.unit);
    (found, questions, done)
}

/// The lines of a test run that say what failed (at most five), else its last line.
fn failing(out: &str) -> Vec<String> {
    let said = |l: &str| { let l = l.to_ascii_lowercase(); ["fail", "error", "panicked", "not ok", "assert"].iter().any(|w| l.contains(w)) };
    let mut v: Vec<String> = out.lines().filter(|l| said(l)).map(crate::agents::line_of).filter(|l| !l.is_empty()).collect();
    v.dedup();
    v.truncate(5);
    if v.is_empty() { v.extend(out.lines().rev().find(|l| !l.trim().is_empty()).map(crate::agents::line_of)); }
    v
}

/// How the repo in `dir` runs its tests, by what it holds: npm's test script, cargo, go, make's test, pytest.
pub fn tests_command(dir: &Path) -> Option<String> {
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).ok();
    if let Some(p) = read("package.json") {
        let v: serde_json::Value = serde_json::from_str(&p).unwrap_or_default();
        if let Some(t) = v.pointer("/scripts/test").and_then(|t| t.as_str()) {
            if !t.contains("no test specified") { return Some("npm test".into()); }
        }
    }
    if dir.join("Cargo.toml").is_file() { return Some("cargo test".into()); }
    if dir.join("go.mod").is_file() { return Some("go test ./...".into()); }
    if read("Makefile").is_some_and(|m| m.lines().any(|l| l.starts_with("test:"))) { return Some("make test".into()); }
    if dir.join("pytest.ini").is_file() || read("pyproject.toml").is_some_and(|p| p.contains("pytest")) { return Some("python3 -m pytest -q".into()); }
    None
}

// ---- the order a change is read in ----

/// How tangled a text is: the places it branches (a cheap cyclomatic count, any language).
pub fn branches(text: &str) -> u64 {
    let words = ["if", "else", "for", "while", "match", "case", "catch", "except", "elif", "when", "switch", "loop"];
    let mut n = 0u64;
    for token in text.split(|c: char| !c.is_alphanumeric() && c != '_') { if words.contains(&token) { n += 1; } }
    n + text.matches("&&").count() as u64 + text.matches("||").count() as u64 + text.matches(" ? ").count() as u64
}

/// Paths, each with its weight, the heaviest first.
pub type Weighed = Vec<(String, u64)>;

/// A change's files and folders, each weighed (lines changed, times how tangled what they are now is), the heaviest
/// first: the order a review reads them in. `files`: each path, the lines added and removed, and its text now.
pub fn weigh(files: &[(String, u64, String)]) -> (Weighed, Weighed) {
    let mut by_file: Weighed = files.iter().map(|(p, changed, now)| (p.clone(), changed * (1 + branches(now).min(400) / 4).max(1))).collect();
    by_file.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut by_part: Weighed = Vec::new();
    for (p, w) in &by_file {
        let part = p.rsplit_once('/').map_or(".", |(d, _)| d).to_string();
        match by_part.iter_mut().find(|(d, _)| *d == part) { Some(x) => x.1 += w, None => by_part.push((part, *w)) }
    }
    by_part.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    (by_part, by_file)
}

/// The words a deed is given to the agent: what it is for, the order to read in (a review's, the hardest first),
/// and the lines to end with, which l3 reads back.
pub fn instructions(k: &Task, number: &str, detail: &str, parts: &[(String, u64)], files: &[(String, u64)]) -> String {
    let list = |v: &[(String, u64)]| v.iter().take(12).map(|(p, _)| format!("   - {p}")).collect::<Vec<_>>().join("\n");
    let ending = "End with one line per question only the person can answer, `QUESTION <question>`, if you cannot go on without them; \
        otherwise with one line `DONE <what you did, in one sentence>`.";
    match k.deed {
        Deed::Take => format!("Solve issue {number} of this repo: {}\n\n{detail}\n\nThis folder is the issue's own copy. Change what the issue asks and \
            nothing else, and run the repo's tests if it has any. {ending}", k.words),
        Deed::Fix => format!("The tests fail on issue {number} ({}). Make them pass without weakening them; change nothing else. {ending}", k.words),
        Deed::Ask => format!("{}\n\nAnswer from this repo, in a few sentences, changing no file. End with one line `DONE <the answer in one sentence>`.", k.words),
        Deed::Review => format!("Review the change handed in for issue {number}: {}\n\n{detail}\n\nRead it in this order, the most complex first, \
            and finish each step before the next:\n1. The goal: does it do what the issue asks, all of it, and nothing else?\n\
            2. Each part it touches, the heaviest first; does each still do one thing?\n{}\n3. The tests: do they cover what changed? Run them.\n\
            4. Each file, the heaviest first:\n{}\n\nChange no file. End with one line per finding, the most important first: \
            `FINDING <goal|responsibility|test|file> <path>[:<line>] <what is wrong and why>`, and one line per question only the person \
            can answer, `QUESTION <question>`. If nothing is wrong, end with one line `DONE <one sentence>`.", k.words, list(parts), list(files)),
        Deed::Tests => String::new(),
    }
}

/// Set `repo`'s runner off in the background, if none runs (`l3 agent run`, by this process when it is l3, else by
/// the l3 beside the app). Never waited for, never failing what set it off.
pub fn kick(repo: &str) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let Ok(exe) = std::env::current_exe() else { return };
        let l3 = if exe.file_name().is_some_and(|n| n == "l3") { exe } else { crate::prompt::l3_path(&exe) };
        // The repo named by LENGTH3_REPO from the data directory, never as a word (a repo called --network is no flag).
        let mut c = Command::new(l3);
        c.args(["agent", "run"]).env("LENGTH3_REPO", repo).current_dir(crate::paths::data_dir())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            // Its own group: a terminal's Ctrl-C to the l3 that set it off does not reach it.
            .process_group(0);
        if let Ok(mut child) = c.spawn() { std::thread::spawn(move || { let _ = child.wait(); }); }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = repo;
}

/// The runner's hold on `repo`: one at a time (the others leave at once). None when another holds it.
pub fn hold(repo: &str) -> Result<Option<std::fs::File>> {
    crate::boundary::private_dir(&dir()).map_err(|e| e.to_string())?;
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir().join(format!("{repo}.run"))).map_err(|e| e.to_string())?;
    match f.try_lock() {
        Ok(()) => Ok(Some(f)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(e)) => Err(e.to_string()),
    }
}

/// Where a run's whole output is kept.
pub fn log_path(k: &Task) -> PathBuf { dir().join(&k.repo).join(format!("{}.log", k.id)) }

#[cfg(test)]
mod tests {
    use super::*;

    fn book_in(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("l3-tasks-{name}-{}", std::process::id()));
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
}
