//! Forge: the repos (here and on the Remote), the band, and the Prompt.

use super::Ctx;
use crate::args::Call;
use crate::out::{bytes, files, Error, Reply, Result};
use crate::spec::{Fact, On};
use crate::target;
use length3_core::{home, remote, repos, tr, work};
use serde_json::json;

/// `l3 repo`: each repo here and where it stands, then those only on the Remote.
pub fn repo_list(ctx: &Ctx, _: &Call) -> Result<Reply> {
    let r = ctx.repos()?;
    let here = r.list()?;
    let connected = ctx.connected();
    let there = if connected { remote::remote_repos().unwrap_or_default() } else { Vec::new() };
    let only_there: Vec<&remote::RemoteRepo> = there.iter().filter(|t| !here.iter().any(|h| h.name == t.name)).collect();
    let mut rows = Vec::new();
    let mut t = Vec::new();
    for s in &here {
        let line = if ctx.prompt { work::MAIN.to_string() } else { r.line(&s.name) };
        let st = if ctx.prompt { None } else { remote::status_of(&r, &s.name).ok() };
        // Where it stands with the Remote, as a word for data and words for a person.
        let (state, said) = match &st {
            None => ("unknown", String::new()),
            Some(st) if !connected => if st.unsynced.is_empty() { ("offline", String::new()) } else { ("offline", tr!(" · some things cannot be sent", " · 送れないものあり")) },
            Some(st) if st.fresh => ("notSent", tr!(" · not sent yet", " · まだ送っていません")),
            Some(st) if st.changed > 0 => ("changed", tr!(" · {} not sent", " · {}件未送信", st.changed)),
            Some(_) => ("inStep", tr!(" · in step", " · Remote と同じ")),
        };
        let working = if line != work::MAIN { tr!(" · working on {}", " · {} の作業中", super::git::line_called(&line)) } else { String::new() };
        crate::menu::see(|| crate::menu::Subject { on: On::Repo, word: s.name.clone(), repo: Some(s.name.clone()), label: s.name.clone(),
            detail: format!("{} · {}{working}{said}", files(s.files as usize), bytes(s.bytes)), facts: Vec::new() });
        t.push((s.name.clone(), format!("{} · {}{working}{said}", files(s.files as usize), bytes(s.bytes))));
        rows.push(json!({"name": s.name, "files": s.files, "bytes": s.bytes, "modified": s.modified, "line": line, "state": state,
            "changed": st.as_ref().map_or(0, |s| s.changed), "unsendable": st.as_ref().map(|s| s.unsynced.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>()).unwrap_or_default()}));
    }
    for o in &only_there {
        crate::menu::see(|| crate::menu::Subject { on: On::RemoteRepo, word: o.name.clone(), repo: None, label: o.name.clone(),
            detail: tr!("only on the Remote · {}", "Remote にだけあります · {}", bytes(o.bytes)), facts: vec![Fact::OnlyThere] });
        t.push((o.name.clone(), tr!("only on the Remote · {} (l3 repo open {})", "Remote にだけあります · {}（l3 repo open {} で開けます）", bytes(o.bytes), o.name)));
    }
    let text = if t.is_empty() { tr!("No repos yet (l3 repo new NAME makes one)", "repo はまだありません（l3 repo new NAME で作れます）") } else { crate::out::columns(&t).join("\n") };
    Ok(Reply::data(text, json!({"here": rows, "remote": only_there})))
}

pub fn repo_new(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    if !repos::valid_name(name) {
        return Err(Error::Usage(tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", name)));
    }
    let template = call.flags.template.as_deref().unwrap_or("standard");
    // One of the words -t shows, like any choice: another is not how it is written (2).
    if length3_core::templates::find(template).is_none() {
        let ids: Vec<String> = length3_core::templates::all().into_iter().map(|t| t.id).collect();
        return Err(Error::Usage(tr!("No template {} ({})", "テンプレート {} はありません（{}）", template, ids.join(", "))));
    }
    let s = ctx.repos()?.create(name, template)?;
    Ok(Reply::done(tr!("Made {} ({} · {})", "{} を作りました（{} · {}）", s.name, template, files(s.files as usize)), json!({"repo": s, "template": template})))
}

/// A repo renamed, as its gear in the app renames it: only one no Remote has agreed (the Remote knows a repo by its
/// name), never while a Prompt has it open; what this device keeps of it by name goes with it.
pub fn repo_mv(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let to = call.word(1).unwrap_or_default();
    remote::rename_repo(&ctx.repos()?, &repo, to, &[])?;
    Ok(Reply::done(tr!("Renamed {} to {}", "{} の名前を {} に変えました", repo, to), json!({"repo": to, "was": repo})))
}

/// A repo taken from this device whole, as its gear in the app deletes one no Remote has. One the Remote has is
/// guarded there (turning it off asks for the account's name, the repo's, a code and a passkey): it is not deleted
/// from here, and l3 says where it is.
pub fn repo_rm(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    if remote::agreed(&repo) {
        return Err(Error::Refused(tr!(
            "{} is on the Remote: turn it off there first (in the app, its gear's Delete), which asks for your passkey",
            "{} は Remote にあります。先にそちらで止めてください（アプリでは歯車の「削除」。パスキーを求められます）", repo)));
    }
    remote::delete_repo(&ctx.repos()?, &repo, &[])?;
    Ok(Reply::done(tr!("Deleted {} from this device", "{} をこの端末から消しました", repo), json!({"repo": repo})))
}

pub fn repo_open(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    let r = ctx.repos()?;
    let was_here = r.dir(name).is_ok();
    let s = remote::fetch(&r, name)?;
    let text = if was_here { tr!("{} was here already; brought into step ({} taken in, {} sent)", "{} はもうこの端末にありました。Remote とそろえました（取り込み{}件、送信{}件）", name, s.taken, s.sent) }
        else { tr!("{} is here now ({})", "{} をこの端末に開きました（{}）", name, files(s.taken)) };
    Ok(Reply::done(text, json!({"repo": name, "synced": s, "wasHere": was_here})))
}

fn here_names(ctx: &Ctx) -> Result<Vec<String>> {
    Ok(ctx.repos()?.list()?.into_iter().map(|s| s.name).collect())
}

pub fn band_list(ctx: &Ctx, _: &Call) -> Result<Reply> {
    let here = here_names(ctx)?;
    let b = home::band(&here)?;
    // Each repo here, for the menu: those out on the band first, as the band reads.
    let running: Vec<String> = length3_core::prompt::running(&length3_core::paths::data_dir()).into_iter().map(|r| r.repo).collect();
    for name in b.iter().chain(here.iter().filter(|n| !b.contains(n))) {
        let on = b.contains(name);
        crate::menu::see(|| {
            let mut facts = vec![if on { Fact::OnBand } else { Fact::OffBand }];
            if running.contains(name) { facts.push(Fact::Running); }
            let detail = [if on { tr!("on the band", "帯に出ています") } else { String::new() }, if running.contains(name) { tr!("a Prompt running", "Prompt が動いています") } else { String::new() }]
                .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ");
            crate::menu::Subject { on: On::Repo, word: name.clone(), repo: Some(name.clone()), label: name.clone(), detail, facts }
        });
    }
    let text = if b.is_empty() { tr!("Nothing on the band (l3 band add REPO)", "帯には何もありません（l3 band add REPO）") } else { b.join("\n") };
    Ok(Reply::data(text, json!(b)))
}

pub fn band_set(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let on = call.word(0) == Some("add");
    let repo = target::repo(ctx, call, 1)?;
    let changed = home::set_band(&here_names(ctx)?, &repo, on)?;
    let text = match (on, changed) {
        (true, true) => tr!("{} is on the band", "{} を帯に出しました", repo),
        (true, false) => tr!("{} was on the band already", "{} はもう帯に出ています", repo),
        (false, true) => tr!("{} is off the band", "{} を帯から外しました", repo),
        (false, false) => tr!("{} was not on the band; nothing changed", "{} は帯に出ていませんでした。何も変えていません", repo),
    };
    Ok(Reply::done(text, json!({"repo": repo, "on": on, "changed": changed, "band": home::band(&here_names(ctx)?)?})))
}

/// Room a Prompt wants beside what it holds already (what .packages and .setup install, what it writes).
#[cfg(target_os = "linux")]
pub(crate) const PROMPT_ROOM: u64 = 256 << 20;

/// `l3 prompt [REPO] [-- CMD…]`: the repo inside the root, without privileges.
#[cfg(target_os = "linux")]
pub fn prompt(ctx: &Ctx, call: &Call) -> Result<Reply> {
    use length3_core::{launch, paths, prompt};
    use std::io::IsTerminal;
    let repo = target::repo(ctx, call, 0)?;
    let data = paths::data_dir();
    let dir = ctx.repos()?.dir(&repo)?;
    let (root, about) = super::runtime::root_now(&data)?;
    // Another distribution's own shell where there is a terminal to draw it on; sh otherwise.
    let bash = about.distro.is_some() && root.join("bin/bash").exists() && std::io::stdin().is_terminal();
    let cmd = call.words(1);
    let argv: Vec<String> = if cmd.is_empty() { vec![if bash { "/bin/bash" } else { "/bin/sh" }.into(), "-i".into()] } else { cmd };
    let s = launch::Sandbox { root, repo: dir, name: repo.clone(), argv, network: call.flags.network || length3_core::home::network(&repo), dotfiles: launch::dotfiles_in_effect(), data: Some(data.clone()), env: Vec::new() };
    // Recorded from the start, by the process that runs it, so `l3 prompt ls` (and Runtime) see it, `l3 prompt stop`
    // can end it, and nothing it holds is freed (usage.rs): first being prepared, as what .packages and .setup ask for
    // is set up (once, while they and the root stay as they are), then running.
    let prepared = || -> std::io::Result<prompt::Recorded> {
        let mut recorded = prompt::record(&data, &repo, s.network, &s.root)?;
        // Recorded, what it holds stays; room is made round it if the device is short (usage.rs make_room).
        length3_core::usage::make_room(&data, &paths::repos_dir(), PROMPT_ROOM);
        launch::set_up(&s, about.distro.is_some())?;
        recorded.ready()?;
        Ok(recorded)
    };
    let code = if crate::menu::active() {
        // Said before the shell takes the keys: in it, Ctrl-C is the program's (as at any shell), and leaving it comes back here.
        crate::out::note(&tr!("exit (or Ctrl-D) comes back to the menu; Ctrl-C goes to what runs in the Prompt", "exit（か Ctrl-D）でメニューに戻ります。Ctrl-C は Prompt の中で動くものに届きます"));
        // From the menu, in a child: the menu keeps its own namespaces (a second Prompt could not be made
        // in them) and may have a thread still asking the Remote (a process with two cannot make them).
        launch::run_apart_with(&s, prepared)
    } else {
        let recorded = prepared().map_err(|e| Error::Io(e.to_string()))?;
        let code = launch::run(&s);
        drop(recorded);
        code
    };
    let code = code.map_err(|e| Error::Io(e.to_string()))?;
    if ctx.connected() { crate::sync::send(&repo); }
    // Opened from the menu, the menu goes on once the shell ends, back on the repo it was opened on; typed, l3 ends with the shell's code.
    if crate::menu::active() {
        crate::out::note(&tr!("The Prompt of {} ended ({}); back to the menu", "{} の Prompt が終わりました（{}）。メニューに戻ります", repo, code));
        return Ok(Reply::Nothing);
    }
    std::process::exit(code);
}

#[cfg(not(target_os = "linux"))]
pub fn prompt(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("l3 prompt is Linux only for now", "l3 prompt はいま Linux だけです")))
}

/// `l3 prompt ls`: each Prompt running on this device, the app's among them.
pub fn prompt_list(_: &Ctx, _: &Call) -> Result<Reply> {
    use length3_core::{paths, prompt};
    let all = prompt::running(&paths::data_dir());
    let mut t = Vec::new();
    let mut rows = Vec::new();
    for r in &all {
        let held = prompt::held_by(r);
        let mut line = match (held, r.preparing) {
            (Some(h), false) => tr!("{} processes · {}", "プロセス {} · {}", h.processes, bytes(h.memory)),
            (None, false) => tr!("starting", "起動中"),
            // Being prepared, what it holds is what prepares it.
            (Some(h), true) => tr!("preparing (.packages, .setup) · {} processes · {}", "用意中（.packages、.setup） · プロセス {} · {}", h.processes, bytes(h.memory)),
            (None, true) => tr!("preparing (.packages, .setup)", "用意中（.packages、.setup）"),
        };
        if r.network { line += &tr!(" · with the network", " · ネットワークあり"); }
        t.push((r.repo.clone(), line));
        rows.push(json!({"repo": r.repo, "pid": r.pid, "network": r.network, "started": r.started, "held": held, "preparing": r.preparing, "root": r.root}));
    }
    let text = if t.is_empty() { tr!("No Prompt is running (l3 prompt REPO opens one)", "動いている Prompt はありません（l3 prompt REPO で開けます）") } else { crate::out::columns(&t).join("\n") };
    Ok(Reply::data(text, json!(rows)))
}

/// `l3 prompt stop [REPO]`: each Prompt of the repo stops, as Stop in Runtime does.
pub fn prompt_stop(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let repo = target::repo(ctx, call, 0)?;
    let stopped = stop_prompts(&repo);
    if stopped.is_empty() { return Err(Error::NotFound(tr!("No Prompt of {} is running (l3 prompt ls lists those that are)", "{} の Prompt は動いていません（動いているものは l3 prompt ls）", repo))); }
    Ok(Reply::done(said_stopped(&repo, &stopped), json!({"repo": repo, "stopped": stopped})))
}

/// `l3 prompt pause|resume [REPO]`: its Prompts paused (all they hold stays, they use no CPU) or going on again.
#[cfg(target_os = "linux")]
pub fn prompt_pause(ctx: &Ctx, call: &Call) -> Result<Reply> {
    use length3_core::{paths, prompt};
    let paused = call.word(0) == Some("pause");
    let repo = target::repo(ctx, call, 1)?;
    let told: usize = prompt::running(&paths::data_dir()).iter().filter(|r| r.repo == repo).filter_map(prompt::ns_of_running).map(|ns| prompt::pause(ns, paused)).sum();
    if told == 0 { return Err(Error::NotFound(tr!("No Prompt of {} is running (l3 prompt ls lists those that are)", "{} の Prompt は動いていません（動いているものは l3 prompt ls）", repo))); }
    let text = if paused { tr!("Paused {}'s Prompt: what it holds stays, it uses no CPU (l3 prompt resume {0})", "{} の Prompt を一時停止しました。持っているものはそのまま、CPU は使いません（l3 prompt resume {0}）", repo) }
        else { tr!("{}'s Prompt goes on", "{} の Prompt を再開しました", repo) };
    Ok(Reply::done(text, json!({"repo": repo, "paused": paused, "processes": told})))
}

#[cfg(not(target_os = "linux"))]
pub fn prompt_pause(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("l3 prompt is Linux only for now", "l3 prompt はいま Linux だけです")))
}

/// Stop every Prompt of `repo` running here; what each held and how it ended.
pub fn stop_prompts(repo: &str) -> Vec<length3_core::prompt::Stopped> {
    use length3_core::{paths, prompt};
    let data = paths::data_dir();
    prompt::running(&data).iter().filter(|r| r.repo == repo).map(|r| prompt::stop(&data, r)).collect()
}

/// What stopping gave back, as Runtime says it.
pub fn said_stopped(repo: &str, stopped: &[length3_core::prompt::Stopped]) -> String {
    let memory: u64 = stopped.iter().map(|s| s.before.memory).sum();
    let left: u32 = stopped.iter().map(|s| s.left).sum();
    if left > 0 { return tr!("Stopped {}'s Prompt, but {} processes are still there", "{} の Prompt を止めましたが、まだプロセスが {} 残っています", repo, left); }
    match stopped.iter().filter_map(|s| s.ms).max() {
        Some(ms) => tr!("Stopped {}'s Prompt · gave back {} ({} ms)", "{} の Prompt を止めました · {} を返しました（{} ms）", repo, bytes(memory), ms),
        None => tr!("Stopped {}'s Prompt", "{} の Prompt を止めました", repo),
    }
}
