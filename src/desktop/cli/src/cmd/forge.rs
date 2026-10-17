//! Forge: the repos (here and on the Remote), the band, and the Prompt.

use super::Ctx;
use crate::args::Call;
use crate::out::{bytes, files, Error, Reply, Result};
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
        let working = if line != work::MAIN { tr!(" · working on issue/{}.md", " · issue/{}.md の作業中", line) } else { String::new() };
        t.push(format!("{}\t{} · {}{working}{said}", s.name, files(s.files as usize), bytes(s.bytes)));
        rows.push(json!({"name": s.name, "files": s.files, "bytes": s.bytes, "modified": s.modified, "line": line, "state": state,
            "changed": st.as_ref().map_or(0, |s| s.changed), "unsendable": st.as_ref().map(|s| s.unsynced.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>()).unwrap_or_default()}));
    }
    for o in &only_there {
        t.push(tr!("{}\tonly on the Remote · {} (l3 repo open {})", "{}\tRemote だけ · {}（l3 repo open {} で開けます）", o.name, bytes(o.bytes), o.name));
    }
    if t.is_empty() { t.push(tr!("No repos yet (l3 repo new NAME makes one)", "repo はまだありません（l3 repo new NAME で作れます）")); }
    Ok(Reply::data(t.join("\n"), json!({"here": rows, "remote": only_there})))
}

pub fn repo_new(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    if !repos::valid_name(name) {
        return Err(Error::Usage(tr!("{:?} is not a repo name (letters, digits, . _ -)", "{:?} は repo の名前になりません（英数字と . _ -）", name)));
    }
    let template = call.flags.template.as_deref().unwrap_or("standard");
    let s = ctx.repos()?.create(name, template)?;
    Ok(Reply::done(tr!("Made {} ({} · {})", "{} を作りました（{} · {}）", s.name, template, files(s.files as usize)), json!({"repo": s, "template": template})))
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
    let b = home::band(&here_names(ctx)?)?;
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
        (false, true) => tr!("{} is off the band", "{} を帯から下げました", repo),
        (false, false) => tr!("{} was not on the band; nothing changed", "{} は帯に出ていませんでした。何も変えていません", repo),
    };
    Ok(Reply::done(text, json!({"repo": repo, "on": on, "changed": changed, "band": home::band(&here_names(ctx)?)?})))
}

/// `l3 prompt [REPO] [-- CMD…]`: the repo inside the root, without privileges.
#[cfg(target_os = "linux")]
pub fn prompt(ctx: &Ctx, call: &Call) -> Result<Reply> {
    use length3_core::{launch, paths, root};
    use std::io::IsTerminal;
    let repo = target::repo(ctx, call, 0)?;
    let (root, about) = root::current(&paths::data_dir()).ok_or_else(|| Error::NotFound(tr!("No root yet (l3 root fetch)", "root がありません（l3 root fetch）")))?;
    let dir = ctx.repos()?.dir(&repo)?;
    // Another distribution's own shell where there is a terminal to draw it on; sh otherwise.
    let bash = about.distro.is_some() && root.join("bin/bash").exists() && std::io::stdin().is_terminal();
    let cmd = call.words(1);
    let argv: Vec<String> = if cmd.is_empty() { vec![if bash { "/bin/bash" } else { "/bin/sh" }.into(), "-i".into()] } else { cmd };
    let s = launch::Sandbox { root, repo: dir, name: repo.clone(), argv, network: call.flags.network, dotfiles: launch::dotfiles(), data: Some(paths::data_dir()) };
    // What .packages and .setup ask for, first (once, while they and the root stay as they are).
    launch::set_up(&s, about.distro.is_some()).map_err(|e| Error::Io(e.to_string()))?;
    let code = launch::run(&s).map_err(|e| Error::Io(e.to_string()))?;
    if ctx.connected() { crate::sync::send(&repo); }
    std::process::exit(code);
}

#[cfg(not(target_os = "linux"))]
pub fn prompt(_: &Ctx, _: &Call) -> Result<Reply> {
    Err(Error::Refused(tr!("l3 prompt is Linux only for now", "l3 prompt はいま Linux だけです")))
}
