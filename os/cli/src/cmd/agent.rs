//! Agents: the work handed to one (core tasks.rs), and what Claude Code, Grok Build and the like do in the person's
//! repos, as their own hooks say it (core agents.rs). `l3 agent` is what is offered, asked, ready to look at, and at
//! work; take, drop, reply and ask are the person's deeds on it. `l3 agent on` sets an agent up (its hooks, and the
//! work handed to it), `off` takes that out again, `hooks` only shows them; `l3 agent hook HARNESS` is what a
//! harness calls on each event. `l3 agent run` (set off by a deed) runs a repo's tasks one at a time, each in its
//! Prompt (`l3 agent inside`).

use super::Ctx;
use crate::args::Call;
use crate::out::{ago, Error, Reply, Result};
use length3_core::{agents, atomic, compute, paths, tasks, tr};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

/// The events each harness is set up to say, by the names Claude Code gives them (Grok Build takes the same).
const EVENTS: [&str; 7] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
/// What a harness's event may bring on standard input: past it, the rest is read and let go (a tool's whole
/// input, a file written, may be in it; the few words kept come first).
const PAYLOAD: usize = 4 * 1024 * 1024;

/// A session as a line: the harness, where (repo, and the issue as #N), what it does, how long ago.
fn said(s: &agents::Session) -> (String, String) {
    let at = if s.line == length3_core::work::MAIN { s.repo.clone() } else { format!("{} {}", s.repo, super::git::line_called(&s.line)) };
    let state = match s.state.as_str() {
        "working" => tr!("working", "作業中"),
        "waits" => tr!("waits for you", "あなたを待っています"),
        _ => tr!("ended", "終了"),
    };
    let doing = if s.doing.is_empty() || s.state == "ended" { String::new() } else { format!(" · {}", s.doing) };
    (format!("{}  {at}", s.harness), format!("{state}{doing} · {}", ago(s.last)))
}

/// Where a task is, as a person calls it: the repo, and its issue as #N.
fn task_at(k: &tasks::Task) -> String {
    if k.issue.is_empty() { k.repo.clone() } else { format!("{} {}", k.repo, length3_core::issues::number(&k.issue)) }
}

/// A task as a line: what it is for, and the deed that goes on with it.
fn task_line(k: &tasks::Task) -> (String, String) {
    let agent = tasks::agent().map(|h| tasks::agent_name(&h)).unwrap_or_default();
    let what = match (k.state, k.deed) {
        (tasks::State::Offered, tasks::Deed::Take) => tr!("{} can take it: {} (l3 agent take {})", "{} が引き受けられます：{}（l3 agent take {}）", agent, k.words, k.id),
        (tasks::State::Offered, _) => tr!("{} can fix it: {} (l3 agent take {})", "{} が直せます：{}（l3 agent take {}）", agent, k.words, k.id),
        (tasks::State::Asking, _) => tr!("{} (l3 agent reply {} \"…\")", "{}（l3 agent reply {} \"…\"）", k.questions.join(" / "), k.id),
        (tasks::State::Ready, _) => {
            let first = k.found.first().map(|f| if f.path.is_empty() { f.text.clone() } else { format!("{}{}: {}", f.path, f.line.map(|n| format!(":{n}")).unwrap_or_default(), f.text) });
            let head = if k.found.is_empty() { k.said.clone() } else { tr!("{}, the heaviest first: {}", "{}。重いものから：{}", crate::out::count(k.found.len(), "finding", "findings", "{}件"), first.unwrap_or_default()) };
            tr!("{} (l3 agent drop {} once looked at)", "{}（見たら l3 agent drop {}）", head, k.id)
        }
        (tasks::State::Stopped, _) => tr!("{} ({}; then l3 agent take {})", "{}（{}。それから l3 agent take {}）", k.said, k.fix, k.id),
        (tasks::State::Waiting, _) => tr!("waits its turn", "順番を待っています"),
        (tasks::State::Working, _) => tr!("at work", "作業中"),
        _ => String::new(),
    };
    (format!("{:>3}  {}", k.id, task_at(k)), what)
}

/// `l3 agent`: what the agent can take, what it asks, what is ready to look at, what could not run, then each agent
/// at work on this device now.
pub fn list(_: &Ctx, _: &Call) -> Result<Reply> {
    let now = crate::out::now_ms();
    let list = agents::sessions(&agents::all(), now, agents::RECENT);
    let all: Vec<tasks::Task> = tasks::all().into_iter().filter(|k| !k.state.over()).collect();
    let mut t = Vec::new();
    for (state, head) in [(tasks::State::Asking, tr!("Asks you", "あなたへの質問")), (tasks::State::Ready, tr!("To look at", "見てほしいもの")),
        (tasks::State::Offered, tr!("Can take", "引き受けられるもの")), (tasks::State::Stopped, tr!("Could not run", "動けなかったもの")),
        (tasks::State::Working, tr!("Handed over", "任せたもの")), (tasks::State::Waiting, String::new())] {
        let rows: Vec<(String, String)> = all.iter().filter(|k| k.state == state).map(task_line).collect();
        if rows.is_empty() { continue; }
        if !head.is_empty() || t.is_empty() { if !t.is_empty() { t.push(String::new()); } t.push(if head.is_empty() { tr!("Handed over", "任せたもの") } else { head }); }
        t.extend(crate::out::columns(&rows).into_iter().map(|l| format!("  {l}")));
    }
    if !list.is_empty() {
        if !t.is_empty() { t.push(String::new()); }
        t.push(tr!("At work", "作業中"));
        t.extend(crate::out::columns(&list.iter().map(said).collect::<Vec<_>>()).into_iter().map(|l| format!("  {l}")));
    }
    if t.is_empty() {
        t.push(match tasks::agent() {
            Some(h) => tr!("Nothing for {} now: it is offered each issue you write, and reads each change you hand in", "{} にいまはありません。書いた Issue ごとに引き受けを申し出て、渡した Change は自分で読みます", tasks::agent_name(&h)),
            None => tr!("No agent here (l3 agent on claude: it then takes the issues you hand it, and reads your changes)", "エージェントはいません（l3 agent on claude で、任せた Issue を引き受け、渡した Change を読むようになります）"),
        });
    }
    Ok(Reply::data(t.join("\n"), json!({"agent": tasks::agent(), "tasks": all, "sessions": list})))
}

/// `l3 agent hook HARNESS [EVENT]`: what a harness calls on each event. It says nothing and always ends well:
/// an agent is never held up or stopped by being watched. In a Prompt, nothing is kept (the device's journal is
/// not there).
pub fn hook(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let payload = read_payload();
    if ctx.prompt { return Ok(Reply::Nothing); }
    let harness = call.word(0).unwrap_or_default();
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(e) = agents::report(harness, call.word(1), &payload, &cwd, crate::out::now_ms()) {
        if let Err(why) = agents::append(&e) { crate::out::note(&why); }
    }
    Ok(Reply::Nothing)
}

/// Standard input, all of it read (a harness writing more than is kept is never left blocked), PAYLOAD kept; none
/// at a terminal.
fn read_payload() -> String {
    use std::io::{IsTerminal, Read};
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() { return String::new(); }
    let mut kept = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match stdin.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => if kept.len() < PAYLOAD { kept.extend_from_slice(&chunk[..n.min(PAYLOAD - kept.len())]); },
        }
    }
    String::from_utf8(kept).unwrap_or_default()
}

/// A word as the shell takes it, whatever it holds.
fn quoted(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) { s.to_string() } else { format!("'{}'", s.replace('\'', "'\\''")) }
}

/// The hooks `harness` is given: each event calls this l3 (by where it is, so it needs no PATH), five seconds at
/// most. Grok Build matches tools by a regular expression, Claude Code by `*`.
fn config(harness: &str) -> Value {
    let l3 = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "l3".into());
    let command = format!("{} agent hook {harness}", quoted(&l3));
    let all = if harness == "grok" { ".*" } else { "*" };
    let mut hooks = Map::new();
    for e in EVENTS {
        let mut entry = json!({"hooks": [{"type": "command", "command": command, "timeout": 5}]});
        if e.ends_with("ToolUse") { entry["matcher"] = json!(all); }
        hooks.insert(e.into(), json!([entry]));
    }
    json!({"hooks": hooks})
}

/// Where `harness` reads its hooks from: Claude Code's settings (all of them, ours among the person's own), or a
/// file of Grok Build's own, ours alone.
fn where_for(harness: &str) -> Result<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| Error::Refused(tr!("HOME is not set", "HOME が設定されていません")));
    Ok(match harness {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).map_or_else(|| home().map(|h| h.join(".claude")), Ok)?.join("settings.json"),
        _ => std::env::var_os("GROK_HOME").map(PathBuf::from).map_or_else(|| home().map(|h| h.join(".grok")), Ok)?.join("hooks").join("l3.json"),
    })
}

/// Whether a hook is one of ours (any l3's, wherever it was then).
fn ours(hook: &Value) -> bool {
    hook.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.contains(" agent hook "))
}

/// `settings` without our hooks: each event's entries without them, an entry left with none gone, an event left
/// with none gone, and "hooks" gone when nothing is left in it.
fn without_ours(mut settings: Value) -> Value {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else { return settings };
    for entries in hooks.values_mut() {
        let Some(list) = entries.as_array_mut() else { continue };
        for entry in list.iter_mut() {
            if let Some(h) = entry.get_mut("hooks").and_then(|h| h.as_array_mut()) { h.retain(|x| !ours(x)); }
        }
        list.retain(|entry| entry.get("hooks").and_then(|h| h.as_array()).is_none_or(|h| !h.is_empty()));
    }
    hooks.retain(|_, entries| entries.as_array().is_none_or(|l| !l.is_empty()));
    if hooks.is_empty() { settings.as_object_mut().map(|o| o.remove("hooks")); }
    settings
}

/// `settings` with our hooks for `harness` (once, whatever was there before).
fn with_ours(settings: Value, harness: &str) -> Value {
    let mut settings = without_ours(settings);
    let Some(o) = settings.as_object_mut() else { return settings };
    let hooks = o.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() { *hooks = json!({}); }
    for (event, entries) in config(harness)["hooks"].as_object().unwrap() {
        let list = hooks.as_object_mut().unwrap().entry(event.clone()).or_insert_with(|| json!([]));
        if !list.is_array() { *list = json!([]); }
        list.as_array_mut().unwrap().extend(entries.as_array().unwrap().iter().cloned());
    }
    settings
}

/// The file a harness reads, as it is (nothing there: nothing set), or why it is not taken.
fn read_settings(path: &std::path::Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => serde_json::from_str::<Value>(&t).ok().filter(|v| v.is_object())
            .ok_or_else(|| Error::Refused(tr!("{} is not JSON l3 can read, so it is left as it is", "{} は l3 が読める JSON ではないので、そのままにしています", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(Error::Io(e.to_string())),
    }
}

fn harness_said(harness: &str) -> &'static str {
    if harness == "claude" { "Claude Code" } else { "Grok Build" }
}

/// `l3 agent hooks claude|grok`: what `l3 agent on` would write, to set it up by hand.
pub fn hooks(_: &Ctx, call: &Call) -> Result<Reply> {
    let harness = call.word(0).unwrap_or_default();
    let c = config(harness);
    Ok(Reply::Raw { text: format!("{}\n", serde_json::to_string_pretty(&c).unwrap_or_default()), json: json!({"path": where_for(harness)?, "config": c}) })
}

/// `l3 agent on claude|grok`: the harness says what it does from its next session on.
pub fn on(_: &Ctx, call: &Call) -> Result<Reply> {
    let harness = call.word(0).unwrap_or_default();
    let path = where_for(harness)?;
    let settings = with_ours(read_settings(&path)?, harness);
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
    atomic::replace(&path, format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default()).as_bytes(), atomic::How::PRIVATE)?;
    tasks::set_agent(Some(harness))?;
    let trust = if harness == "grok" { tr!(" (Grok Build asks once to trust hooks: /hooks-trust)", "（Grok Build は一度だけフックの信頼を求めます：/hooks-trust）") } else { String::new() };
    Ok(Reply::done(tr!("{} is offered each issue you write and reads each change you hand in; what it does shows on its issue (set in {}){}", "{} は書いた Issue ごとに引き受けを申し出て、渡した Change を読みます。していることは Issue に出ます（{} に設定）{}", harness_said(harness), path.display(), trust),
        json!({"harness": harness, "path": path})))
}

/// `l3 agent off claude|grok`: our hooks taken out, the rest of the file as it was.
pub fn off(_: &Ctx, call: &Call) -> Result<Reply> {
    let harness = call.word(0).unwrap_or_default();
    let path = where_for(harness)?;
    let settings = without_ours(read_settings(&path)?);
    if tasks::agent().as_deref() == Some(harness) { tasks::set_agent(None)?; }
    if harness != "claude" && settings.as_object().is_some_and(|o| o.is_empty()) {
        // Grok's file is ours alone: nothing left in it, it goes.
        match std::fs::remove_file(&path) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(Error::Io(e.to_string())), _ => {} }
    } else if path.exists() {
        atomic::replace(&path, format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default()).as_bytes(), atomic::How::PRIVATE)?;
    }
    Ok(Reply::done(tr!("{} is handed nothing more, and no longer says what it does here", "{} にはもう何も任せず、作業も知らせません", harness_said(harness)), json!({"harness": harness, "path": path})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_twice_is_on_once_and_off_leaves_the_persons_own_hooks_as_they_were() {
        let theirs = json!({"model": "x", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard.sh"}]}]}});
        let once = with_ours(theirs.clone(), "claude");
        assert_eq!(with_ours(once.clone(), "claude"), once);
        let pre = once["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[1]["matcher"], "*");
        assert!(pre[1]["hooks"][0]["command"].as_str().unwrap().ends_with(" agent hook claude"));
        assert_eq!(once["hooks"].as_object().unwrap().len(), EVENTS.len());
        assert_eq!(without_ours(once), theirs);
        assert_eq!(without_ours(with_ours(json!({}), "grok")), json!({}));
        assert_eq!(config("grok")["hooks"]["PostToolUse"][0]["matcher"], ".*");
    }

    #[test]
    fn a_path_is_one_word_to_the_shell_whatever_it_holds() {
        assert_eq!(quoted("/usr/bin/l3"), "/usr/bin/l3");
        assert_eq!(quoted("/home/a b/it's/l3"), "'/home/a b/it'\\''s/l3'");
    }
}


// ---- the work handed to it (core tasks.rs) ----

fn task_id(call: &Call) -> Result<u64> {
    call.word(0).and_then(|w| w.trim_start_matches('#').parse().ok()).ok_or_else(|| Error::Usage(tr!("Name a task by its number (l3 agent lists them)", "タスクを番号で書いてください（l3 agent で一覧）")))
}

/// `l3 agent take N`: hand it over (or try again what could not run); it begins in its turn.
pub fn take(_: &Ctx, call: &Call) -> Result<Reply> {
    let k = tasks::take(task_id(call)?)?;
    Ok(Reply::done(tr!("Handed over: {} {}; it shows on its issue as it goes", "任せました：{} {}。進み具合は Issue に出ます", task_at(&k), k.words), json!({"task": k})))
}

/// `l3 agent drop N`: not now (an offer), or looked at (what was ready).
pub fn put_away(_: &Ctx, call: &Call) -> Result<Reply> {
    let k = tasks::drop_task(task_id(call)?)?;
    Ok(Reply::done(tr!("Put away: {} {}", "片づけました：{} {}", task_at(&k), k.words), json!({"task": k})))
}

/// `l3 agent reply N "text"`: the answer to what it asked; it goes on with it.
pub fn reply(_: &Ctx, call: &Call) -> Result<Reply> {
    let words = call.word(1).unwrap_or_default();
    if words.trim().is_empty() { return Err(Error::Usage(tr!("Write the answer: l3 agent reply N \"text\"", "答えを書いてください：l3 agent reply N \"本文\""))); }
    let k = tasks::reply(task_id(call)?, words)?;
    Ok(Reply::done(tr!("Answered; it goes on with {} {}", "答えました。{} {} の続きにかかります", task_at(&k), k.words), json!({"task": k})))
}

/// `l3 agent ask [REPO] "text"`: a question about the repo, answered reading only.
pub fn ask(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = crate::target::repo(ctx, call, 0)?;
    let words = call.word(1).unwrap_or_default();
    if words.trim().is_empty() { return Err(Error::Usage(tr!("Write the question: l3 agent ask [REPO] \"text\"", "質問を書いてください：l3 agent ask [REPO] \"本文\""))); }
    let k = tasks::ask(&repo, words)?;
    Ok(Reply::done(tr!("Asked; the answer comes to l3 agent (and the app's right pane)", "聞きました。答えは l3 agent（とアプリの右ペイン）に来ます"), json!({"task": k})))
}

/// What one run keeps of what it printed, whole, at most.
const LOG: u64 = 1024 * 1024;
/// A run's words said on its issue at most this often (each the latest), and at most this many in all.
const SAY_EVERY: u64 = 500;
const SAY_MOST: usize = 2000;

/// `l3 agent run` (set off by a deed, core tasks.rs kick): the repo's tasks waiting, one at a time, the most complex
/// first, each in the repo's Prompt; another runner for the repo already at it, this one leaves at once.
pub fn run(ctx: &Ctx, _: &Call) -> Result<Reply> {
    let repo = ctx.here.as_ref().map(|h| h.repo.clone()).ok_or_else(|| Error::Usage(tr!("Which repo? (LENGTH3_REPO)", "どの repo ですか（LENGTH3_REPO）")))?;
    loop {
        let Some(hold) = tasks::hold(&repo)? else { return Ok(Reply::Nothing) };
        while let Some(k) = tasks::next(&repo)? {
            let o = run_one(ctx, &k);
            tasks::finished(k.id, o)?;
        }
        drop(hold);
        // One set off while this let go is left to this one: nothing waiting is ever left without a runner.
        let shown = length3_core::work::current(&repo);
        if !tasks::all().iter().any(|k| k.repo == repo && k.state == tasks::State::Waiting && (!k.deed.writes() || shown == length3_core::work::MAIN || shown == k.line)) {
            return Ok(Reply::Nothing);
        }
    }
}

fn stopped(why: String, fix: String) -> tasks::Outcome {
    tasks::Outcome { code: -1, stopped: Some((why, fix)), ..Default::default() }
}

/// One task run: where (its copy), how (its command), what it is told, then its Prompt, what it prints said on its
/// issue as an agent's work is and kept whole in its log; what it ended with read back.
fn run_one(ctx: &Ctx, k: &tasks::Task) -> tasks::Outcome {
    use length3_core::{history, home, work};
    let (repo, line) = (k.repo.as_str(), k.line.as_str());
    let Ok(repos) = ctx.repos() else { return stopped(tr!("{} is not here", "{} はここにありません", repo), String::new()) };
    let harness = if k.deed == tasks::Deed::Tests { None } else {
        match tasks::agent() { Some(h) => Some(h), None => return stopped(tr!("No agent is set up", "エージェントが設定されていません"), "l3 agent on claude".into()) }
    };
    let name = harness.as_deref().map(tasks::agent_name).unwrap_or_default();
    // What writes runs on the issue's own copy, shown as the work the person would have started; what reads, on the
    // copy it is about.
    if k.deed.writes() && work::current(repo) != line {
        let at = if work::worktree(repo, line).is_dir() { work::switch(&repos, repo, line) } else { work::start(&repos, repo, &k.issue).map(|_| ()) };
        if let Err(why) = at { return stopped(why, if ctx.connected() { String::new() } else { "l3 login".into() }); }
    }
    let copy = work::worktree(repo, line);
    let dir = if work::current(repo) == line || line == work::MAIN || !copy.is_dir() { repos.dir(repo) } else { Ok(copy) };
    let Ok(dir) = dir else { return stopped(tr!("{} is not here", "{} はここにありません", repo), String::new()) };
    let command = match &harness {
        None => match tasks::tests_command(&dir) { Some(c) => c, None => return stopped(String::new(), String::new()) },
        Some(h) => match tasks::agent_command(h) {
            Some(c) => c,
            None => return stopped(tr!("{} cannot be run for you yet", "{} はまだ任せて動かせません", name), tr!("keep its command in .agent", ".agent にコマンドを書く")),
        },
    };
    if harness.is_some() && !home::network(repo) {
        return stopped(tr!("{} needs the network in {}'s Prompt", "{} には {} の Prompt でネットワークがいります", name, repo), format!("l3 network on {repo}"));
    }
    // The issue's words, and for a review the change's files, weighed: the order it reads in.
    let issue = (!k.issue.is_empty()).then(|| repos.on_main().read(repo, &k.issue, 64 * 1024).ok().and_then(|c| c.text)
        .map(|t| length3_core::issues::parse(repo, k.issue.trim_start_matches("issue/"), &t))).flatten();
    let number = issue.as_ref().and_then(|i| i.n).map(|n| format!("#{n}")).unwrap_or_else(|| line.to_string());
    let detail = issue.as_ref().map(|i| i.detail.clone()).unwrap_or_default();
    let (parts, files) = if k.deed == tasks::Deed::Review {
        let diff = history::change_diff(repo, line, 4000).unwrap_or_default();
        tasks::weigh(&diff.iter().filter(|f| !f.binary).map(|f| {
            let changed = f.lines.iter().filter(|l| l.kind == "add" || l.kind == "del").count() as u64;
            (f.path.clone(), changed, std::fs::read_to_string(dir.join(&f.path)).unwrap_or_default())
        }).collect::<Vec<_>>())
    } else { (Vec::new(), Vec::new()) };
    let told = if k.reply.is_empty() { tasks::instructions(k, &number, &detail, &parts, &files) } else { k.reply.clone() };
    let said_first = match k.deed {
        tasks::Deed::Take => tr!("takes {}", "{} にかかります", number),
        tasks::Deed::Review => tr!("reads {}, the heaviest part first", "{} を重いところから読みます", number),
        tasks::Deed::Tests => tr!("runs the tests", "テストを走らせます"),
        tasks::Deed::Fix => tr!("fixes the tests", "テストを直します"),
        tasks::Deed::Ask => k.words.clone(),
    };
    let journal = |kind: agents::Kind, text: &str| {
        let e = agents::Event { at: crate::out::now_ms(), harness: harness.clone().unwrap_or_else(|| "tests".into()), session: format!("task-{}", k.id),
            repo: repo.into(), line: line.into(), kind, text: agents::line_of(text) };
        if let Err(why) = agents::append(&e) { crate::out::note(&why); }
    };
    // What the run is, by what it is made of (core compute.rs): the same Spec builds it here, and anywhere else.
    let root = match super::runtime::root_now(&paths::data_dir()) {
        Ok((_, about)) => about.sha256,
        Err(e) => return stopped(e.message().to_string(), "l3 root fetch".into()),
    };
    let title = issue.as_ref().map(|i| i.title.clone()).unwrap_or_default();
    let resume = if k.reply.is_empty() { String::new() } else { k.session.clone() };
    let minutes = match k.deed { tasks::Deed::Ask => 10, tasks::Deed::Tests => 15, tasks::Deed::Review => 20, tasks::Deed::Fix => 30, tasks::Deed::Take => 60 };
    let spec = compute::Spec {
        environment: launch_environment(&root),
        root, repo: repo.into(), line: line.into(),
        argv: vec!["/bin/sh".into(), "-c".into(), format!("[ -f /root/.profile ] && . /root/.profile\n{command}")],
        env: [("L3_TASK", told), ("L3_RESUME", resume), ("L3_ISSUE", number), ("L3_TITLE", title), ("L3_REPO", repo.to_string())]
            .into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        network: home::network(repo),
        budget: compute::Budget::minutes(minutes),
    };
    journal(agents::Kind::Start, &said_first);
    let (o, usage, over) = supervise(k, &spec, &journal);
    let what = match k.deed { tasks::Deed::Take => "take", tasks::Deed::Review => "review", tasks::Deed::Tests => "tests", tasks::Deed::Fix => "fix", tasks::Deed::Ask => "ask" };
    let _ = compute::record(&compute::Run { spec: spec.digest(), place: "here".into(), repo: repo.into(), line: line.into(), what: what.into(),
        at: crate::out::now_ms().saturating_sub(usage.wall_ms), usage, over, code: o.code });
    journal(agents::Kind::End, &if o.code == 0 { tr!("done", "完了") } else { tr!("ended ({})", "終了（{}）", o.code) });
    if let Some(over) = over { return stopped(over.said(&spec.budget), String::new()); }
    if o.code == 127 {
        return if harness.is_some() { stopped(tr!("{} is not in {}'s Prompt", "{} が {} の Prompt にありません", name, repo), tr!("put it in .setup", ".setup に入れる")) } else { stopped(String::new(), String::new()) };
    }
    o
}

/// The environment the person's dotfiles ask of the root `root` here (launch.rs environment_of; none off Linux).
fn launch_environment(root: &str) -> String {
    #[cfg(target_os = "linux")]
    return length3_core::launch::environment_of(root, &length3_core::home::dotfiles_in_effect());
    #[cfg(not(target_os = "linux"))]
    return { let _ = root; String::new() };
}

/// The run itself: `l3 agent inside N` (the Prompt), given its Spec; watched as it goes (core compute.rs watch),
/// stopped past its budget; what it prints read line by line into the journal (an agent's stream of JSON as its
/// tools) and the log; its last words and session kept. What it used, and what of its budget it went past.
fn supervise(k: &tasks::Task, spec: &compute::Spec, journal: &dyn Fn(agents::Kind, &str)) -> (tasks::Outcome, compute::Usage, Option<compute::Over>) {
    use std::io::{BufRead, Write};
    let mut o = tasks::Outcome { code: -1, ..Default::default() };
    let log_path = tasks::log_path(k);
    let started = (|| -> std::io::Result<_> {
        length3_core::boundary::private_dir(log_path.parent().unwrap())?;
        let log = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)?;
        let (reader, writer) = std::io::pipe()?;
        let child = std::process::Command::new(std::env::current_exe()?).args(["agent", "inside", &k.id.to_string()])
            .env("LENGTH3_REPO", &k.repo).env("L3_SPEC", serde_json::to_string(spec).unwrap_or_default())
            .current_dir(paths::data_dir()).stdin(std::process::Stdio::null()).stdout(writer.try_clone()?).stderr(writer).spawn()?;
        Ok((log, reader, child))
    })();
    let Ok((mut log, reader, child)) = started else {
        return (stopped(tr!("The Prompt could not start", "Prompt を始められませんでした"), String::new()), compute::Usage::default(), None);
    };
    // Watched from beside it while its output is read: past its budget, its supervisor goes, and the Prompt with it.
    let pid = child.id();
    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    let ended = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let (child, ended, budget) = (child.clone(), ended.clone(), spec.budget);
        std::thread::spawn(move || watched(pid, &budget, &ended, move || { let _ = child.lock().map(|mut c| c.kill()); }))
    };
    let (mut logged, mut said, mut last, mut waiting) = (0u64, 0usize, 0u64, None::<String>);
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    for l in std::io::BufReader::new(reader).split(b'\n').map_while(|l| l.ok()) {
        if logged < LOG { let _ = log.write_all(&l).and_then(|_| log.write_all(b"\n")); logged += l.len() as u64 + 1; }
        let text = String::from_utf8_lossy(&l).into_owned();
        // An agent's stream of JSON: its session (to go on in with a reply) and its last words.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
            if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) { o.session = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect(); }
            if v.get("type").and_then(|t| t.as_str()) == Some("result") { o.result = v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string(); }
        } else {
            tail.push_back(text.clone());
            if tail.len() > 40 { tail.pop_front(); }
        }
        let Some(words) = agents::said_in_output(&text) else { continue };
        let now = crate::out::now_ms();
        if now - last >= SAY_EVERY && said < SAY_MOST { journal(agents::Kind::Tool, &words); said += 1; last = now; waiting = None; } else { waiting = Some(words); }
    }
    if let Some(words) = waiting { journal(agents::Kind::Tool, &words); }
    o.code = child.lock().ok().and_then(|mut c| c.wait().ok()).map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    ended.store(true, std::sync::atomic::Ordering::SeqCst);
    let (usage, over) = watcher.join().unwrap_or_default();
    if o.result.is_empty() { o.result = Vec::from(tail).join("\n"); }
    (o, usage, over)
}

/// The run `pid` supervises, watched until `ended` (core compute.rs watch); off Linux, only its wall time.
fn watched(pid: u32, budget: &compute::Budget, ended: &std::sync::atomic::AtomicBool, stop: impl FnOnce()) -> (compute::Usage, Option<compute::Over>) {
    let is_over = || ended.load(std::sync::atomic::Ordering::SeqCst);
    #[cfg(target_os = "linux")]
    return compute::watch(pid, budget, std::time::Duration::from_millis(250), is_over, stop);
    #[cfg(not(target_os = "linux"))]
    return { let _ = (pid, budget, stop); let t = std::time::Instant::now(); while !is_over() { std::thread::sleep(std::time::Duration::from_millis(250)); }
        (compute::Usage { wall_ms: t.elapsed().as_millis() as u64, ..Default::default() }, None) };
}

/// `l3 agent inside N` (by `l3 agent run`): the run its Spec says (L3_SPEC, core compute.rs), built here: the root
/// it names (held here by its sha256), the repo's copy of its line (main's, the issue's), what it is told in its
/// environment, the network only if the repo has it here (a Spec asking for more is refused, whoever wrote it).
/// Ends with its command's code.
#[cfg(target_os = "linux")]
pub fn inside(ctx: &Ctx, call: &Call) -> Result<Reply> {
    use length3_core::{home, launch, prompt, root, work};
    let repo = ctx.here.as_ref().map(|h| h.repo.clone()).ok_or_else(|| Error::Usage(tr!("Which repo? (LENGTH3_REPO)", "どの repo ですか（LENGTH3_REPO）")))?;
    task_id(call)?;
    let spec: compute::Spec = serde_json::from_str(&std::env::var("L3_SPEC").unwrap_or_default())
        .map_err(|_| Error::Usage(tr!("l3 agent inside is l3 agent run's", "l3 agent inside は l3 agent run が使うものです")))?;
    if spec.repo != repo { return Err(Error::Refused(tr!("The run is for {}, not {}", "この実行は {} のもので、{} のものではありません", spec.repo, repo))); }
    if spec.network && !home::network(&repo) {
        return Err(Error::Refused(tr!("{} has no network here (l3 network on {0})", "{} にはここでネットワークがありません（l3 network on {0}）", repo)));
    }
    let data = paths::data_dir();
    let held = root::held(&data).into_iter().map(|(a, _)| a).find(|a| a.sha256 == spec.root)
        .ok_or_else(|| Error::NotFound(tr!("The root it runs on is not here (l3 root fetch)", "実行する root がここにありません（l3 root fetch）")))?;
    let root = root::system_dir(&data).join(&spec.root).join("root");
    let repos = ctx.repos()?;
    let copy = work::worktree(&repo, &spec.line);
    let dir = if spec.line == work::MAIN { repos.on_main().dir(&repo)? } else if copy.is_dir() { copy } else { repos.dir(&repo)? };
    let s = launch::Sandbox { root, repo: dir, name: repo.clone(), argv: spec.argv.clone(), network: spec.network,
        dotfiles: launch::dotfiles_in_effect(), data: Some(data.clone()), env: spec.env.clone() };
    // Recorded as any Prompt is: l3 prompt ls and Runtime see it, l3 prompt stop ends it.
    let mut recorded = prompt::record(&data, &repo, s.network, &s.root)?;
    length3_core::usage::make_room(&data, &paths::repos_dir(), super::forge::PROMPT_ROOM);
    launch::set_up(&s, held.distro.is_some())?;
    recorded.ready()?;
    let code = launch::run(&s)?;
    drop(recorded);
    if ctx.connected() { crate::sync::send(&repo); }
    std::process::exit(code);
}

#[cfg(not(target_os = "linux"))]
pub fn inside(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("A Prompt runs on Linux only for now", "Prompt はいま Linux だけです")))
}
