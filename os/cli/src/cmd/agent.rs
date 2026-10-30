//! Agents: what Claude Code, Grok Build and the like do in the person's repos, as their own hooks say it (core
//! agents.rs). `l3 agent hook HARNESS` is what a harness calls, with its event on standard input; `l3 agent on`
//! sets a harness up to call it, `l3 agent off` takes that out again, `l3 agent hooks` only shows it. `l3 agent`
//! is who works where now, as the app shows it on each issue.

use super::Ctx;
use crate::args::Call;
use crate::out::{ago, Error, Reply, Result};
use length3_core::{agents, atomic, tr};
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

/// `l3 agent`: each agent at work on this device now, and those that ended a moment ago.
pub fn list(_: &Ctx, _: &Call) -> Result<Reply> {
    let now = crate::out::now_ms();
    let list = agents::sessions(&agents::all(), now, agents::RECENT);
    let t = if list.is_empty() {
        tr!("No agent at work here (l3 agent on claude, or grok: each says what it does as it does it)", "ここで作業中のエージェントはいません（l3 agent on claude か grok で、作業を逐一知らせます）")
    } else {
        crate::out::columns(&list.iter().map(said).collect::<Vec<_>>()).join("\n")
    };
    Ok(Reply::data(t, json!({"sessions": list})))
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
    let trust = if harness == "grok" { tr!(" (Grok Build asks once to trust hooks: /hooks-trust)", "（Grok Build は一度だけフックの信頼を求めます：/hooks-trust）") } else { String::new() };
    Ok(Reply::done(tr!("{} says what it does from its next session, on each issue in Git and in l3 agent; set in {}{}", "{} は次のセッションから作業を知らせます（Git の各 Issue と l3 agent に出ます）。{} に設定しました{}", harness_said(harness), path.display(), trust),
        json!({"harness": harness, "path": path})))
}

/// `l3 agent off claude|grok`: our hooks taken out, the rest of the file as it was.
pub fn off(_: &Ctx, call: &Call) -> Result<Reply> {
    let harness = call.word(0).unwrap_or_default();
    let path = where_for(harness)?;
    let settings = without_ours(read_settings(&path)?);
    if harness != "claude" && settings.as_object().is_some_and(|o| o.is_empty()) {
        // Grok's file is ours alone: nothing left in it, it goes.
        match std::fs::remove_file(&path) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(Error::Io(e.to_string())), _ => {} }
    } else if path.exists() {
        atomic::replace(&path, format!("{}\n", serde_json::to_string_pretty(&settings).unwrap_or_default()).as_bytes(), atomic::How::PRIVATE)?;
    }
    Ok(Reply::done(tr!("{} no longer says what it does here", "{} はもう作業を知らせません", harness_said(harness)), json!({"harness": harness, "path": path})))
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
