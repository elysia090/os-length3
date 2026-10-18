//! Runtime: the root Prompts run on, then this device (everything this OS
//! holds, largest first, each with what can be done with it); what every
//! Prompt is given (dotfiles); and whether SSH reaches this device's Prompts (l3 address).

use super::{stdin_text, Ctx};
use crate::args::Call;
use crate::out::{self, bytes, things, Error, Reply, Result};
use crate::spec::{Fact, On};
use crate::target;
use length3_core::{fetch::Progress, home, paths, remote, root, tr, usage};
use serde_json::json;

/// The repos a Prompt has open here (the app's or l3's): they stay while it runs, as in Runtime.
fn in_prompts() -> Vec<String> {
    length3_core::prompt::running(&paths::data_dir()).into_iter().map(|r| r.repo).collect()
}

pub fn page(_: &Ctx, _: &Call) -> Result<Reply> {
    let s = usage::space(&paths::data_dir(), &paths::repos_dir(), &in_prompts());
    let current = root::current(&paths::data_dir()).map(|(_, r)| r);
    let mut t = vec![match &current {
        Some(r) => tr!("root  {} {} (where Prompts run)", "root  {} {}（Prompt が動く環境）", r.name, r.version),
        None => tr!("root  none yet (l3 root fetch)", "root  まだありません（l3 root fetch）"),
    }];
    // SSH into the Prompts: the listener, when it runs (l3 address lists where; l3 address ssh off stops it).
    let listening = length3_core::ssh::listening(&paths::data_dir());
    t.push(match &listening {
        Some(l) => tr!("SSH  on · {} · port {} (l3 address; l3 address ssh off stops it)", "SSH  オン · {} · ポート {}（l3 address。止めるなら l3 address ssh off）", l.scope.said(), l.port),
        None => tr!("SSH  off (l3 address ssh on)", "SSH  オフ（l3 address ssh on）"),
    });
    t.push(String::new());
    t.push(tr!("This device  {} free of {} (the host's figures) · this OS {}", "この端末  空き {} / {}（ホストの値） · この OS {}", bytes(s.host_free), bytes(s.host_total), bytes(s.allocated)));
    if s.freeable > 0 { crate::menu::page_fact(Fact::AnyFreeable); }
    for i in &s.items {
        let act = match i.room { usage::Room::Free | usage::Room::SyncFree => tr!("free", "空ける"), usage::Room::Keep => tr!("stays", "残す") };
        crate::menu::see(|| crate::menu::Subject { on: On::Thing, word: i.id.strip_prefix("repo:").unwrap_or(&i.id).to_string(), repo: None,
            label: i.what.clone(), detail: format!("{} · {act}", bytes(i.allocated)), facts: if i.room == usage::Room::Keep { Vec::new() } else { vec![Fact::Freeable] } });
        t.push(format!("  {:>9}  {}  {}  {}", bytes(i.allocated), act, i.what, i.detail));
        t.push(format!("             {}{}", i.why, if i.room == usage::Room::Keep { String::new() } else { tr!("  (l3 free {})", "（l3 free {}）", i.id.strip_prefix("repo:").unwrap_or(&i.id)) }));
    }
    if s.freeable > 0 { t.push(tr!("Can be freed: {} (all of it: l3 free all)", "空けられるもの：{}（全部なら l3 free all）", bytes(s.freeable))); }
    let items: Vec<_> = s.items.iter().map(|i| json!({"id": i.id, "what": i.what, "allocated": i.allocated, "room": i.room})).collect();
    Ok(Reply::data(t.join("\n"), json!({"root": current, "ssh": listening.map(|l| json!({"port": l.port, "scope": l.scope, "destinations": l.destinations(), "fingerprint": l.fingerprint})), "hostTotal": s.host_total, "hostFree": s.host_free, "host": s.host,
        "allocated": s.allocated, "freeable": s.freeable, "items": items})))
}

/// `l3 free ID… | all`: each named thing looked at again and freed, or why it stays.
pub fn free(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    let words = call.words(0);
    // A word that is nothing names nothing (bug: it was looked for as a repo with no name, and said as such).
    if words.iter().any(|w| w.trim().is_empty()) {
        return Err(Error::Usage(tr!("Name what to free: l3 free ID… (l3 runtime lists them), or l3 free all", "空けるものを書いてください：l3 free ID…（l3 runtime で一覧）、または l3 free all")));
    }
    let open = in_prompts();
    let space = usage::space(&data, &paths::repos_dir(), &open);
    let ids: Vec<String> = if words == ["all"] {
        usage::all_freeable(&space)
    } else {
        words.iter().map(|i| if i.contains(':') || i == "home" { i.clone() } else { format!("repo:{i}") }).collect()
    };
    if let Some(unknown) = ids.iter().find(|id| !space.items.iter().any(|i| &i.id == *id)) {
        return Err(Error::NotFound(tr!("Nothing here is called {} (l3 runtime lists what there is)", "{} というものはここにありません（l3 runtime で一覧）", unknown.strip_prefix("repo:").unwrap_or(unknown))));
    }
    if ids.is_empty() { return Ok(Reply::done(tr!("Nothing can be freed", "空けられるものはありません"), json!({"freed": 0, "removed": [], "kept": []}))); }
    let r = usage::free(&data, &paths::repos_dir(), &ids, &open);
    let kept: Vec<_> = r.kept.iter().map(|(id, why)| json!({"id": id, "why": why})).collect();
    let data = json!({"freed": r.freed, "removed": r.removed, "kept": kept, "hostFreeBefore": r.host_free_before, "hostFreeAfter": r.host_free_after, "reflectedMs": r.reflected_ms});
    let reasons: Vec<String> = r.kept.iter().map(|(id, why)| tr!("  kept {}: {}", "  残したもの {}：{}", id.strip_prefix("repo:").unwrap_or(id), why)).collect();
    if r.removed.is_empty() {
        return Err(Error::Refused(format!("{}\n{}", tr!("Nothing was freed", "何も空けられませんでした"), reasons.join("\n"))));
    }
    let mut t = vec![tr!("Freed {} ({}, counted from the files' blocks)", "{} を空けました（{}、ファイルの実割当で確認）", bytes(r.freed), things(r.removed.len()))];
    let change = r.host_free_after as i64 - r.host_free_before as i64;
    t.push(match r.reflected_ms {
        Some(ms) => tr!("  host free space {:+} B (seen in {} ms; observed, other programs write too)", "  ホストの空き {:+} B（{} ms で反映。他のプログラムの書込も含む観測値）", change, ms),
        None => tr!("  host free space {:+} B (not seen to change within 2 s)", "  ホストの空き {:+} B（2秒以内には反映が見えませんでした）", change),
    });
    for id in r.removed.iter().filter_map(|i| i.strip_prefix("repo:")) {
        t.push(tr!("  {} stays on the Remote; l3 repo open {} brings it back", "  {} は Remote にあります。l3 repo open {} で戻ります", id, id));
    }
    t.extend(reasons);
    Ok(Reply::done(t.join("\n"), data))
}

pub fn roots(_: &Ctx, _: &Call) -> Result<Reply> {
    let held = root::held(&paths::data_dir());
    let data = json!(held.iter().map(|(r, c)| json!({"root": r, "current": c})).collect::<Vec<_>>());
    if held.is_empty() { return Ok(Reply::data(tr!("No root yet (l3 root fetch)", "root はまだありません（l3 root fetch）"), data)); }
    let t: Vec<String> = held.iter().map(|(r, current)| format!("{} {}  {} · {}  {}{}", r.name, r.version, out::files(r.files as usize), bytes(r.bytes), out::short(&r.sha256),
        if *current { tr!("  in use", "  使用中") } else { String::new() })).collect();
    Ok(Reply::data(t.join("\n"), data))
}

/// How far a fetch is, on standard error: every 4 MB and at the end, and each retry.
/// On a terminal the count is redrawn in its line; elsewhere (a log) each is a line of its own.
fn progress() -> impl FnMut(Progress) {
    use std::io::IsTerminal;
    let tty = std::io::stderr().is_terminal();
    let (mut last, mut drawn) = (0u64, false);
    move |p| match p {
        Progress::Bytes(got, all) if got.saturating_sub(last) >= 4 << 20 || got == all => {
            last = got;
            let said = tr!("Fetching {} / {}", "取得中 {} / {}", bytes(got), bytes(all));
            if !tty { eprintln!("{said}"); return; }
            eprint!("\r{said}");
            drawn = got != all;
            if got == all { eprintln!(); }
        }
        Progress::Retry(n, why) => {
            // A count being redrawn ends its line first.
            if std::mem::take(&mut drawn) { eprintln!(); }
            eprintln!("{}", tr!("{}. Continuing where it stopped (try {})", "{}。続きから取ります（{}回目）", why, n));
        }
        _ => {}
    }
}

fn the_remote() -> String {
    remote::connection().map_or_else(remote::default_url, |c| c.url)
}

fn installed(r: &root::Installed) -> String {
    tr!("Installed {} {} ({} · {})", "{} {} を入れました（{} · {}）", r.name, r.version, out::files(r.files as usize), bytes(r.bytes))
}

pub fn root_fetch(_: &Ctx, _: &Call) -> Result<Reply> {
    let r = root::fetch_and_install(&paths::data_dir(), &the_remote(), progress())?;
    Ok(Reply::done(installed(&r), json!(r)))
}

/// `l3 root use l3|ubuntu|debian`: l3's own (fetched if not held), or another distribution's root.
pub fn root_use(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    let r = match call.word(0).unwrap_or_default() {
        "l3" => match root::use_held(&data, root::RELEASES[0].sha256) {
            Some(r) => r,
            None => root::fetch_and_install(&data, &the_remote(), progress())?,
        },
        id => {
            let d = root::distro(id).ok_or_else(|| Error::Usage(tr!("No such root: {} (l3, ubuntu or debian)", "そういう root はありません：{}（l3、ubuntu、debian）", id)))?;
            root::fetch_distro(&data, &the_remote(), d, progress())?
        }
    };
    Ok(Reply::done(tr!("Prompts run on {} {}", "Prompt は {} {} で動きます", r.name, r.version), json!(r)))
}

pub fn root_install(_: &Ctx, call: &Call) -> Result<Reply> {
    let bundle = std::path::Path::new(call.word(0).unwrap_or_default());
    if bundle.is_dir() { return Err(Error::Usage(tr!("{} is a folder; a root is installed from its bundle, a file", "{} はフォルダーです。root はそのバンドル（ファイル）から入れます", bundle.display()))); }
    if !bundle.is_file() { return Err(Error::NotFound(tr!("There is no file {}", "ファイル {} はありません", bundle.display()))); }
    let r = root::install(&paths::data_dir(), bundle)?;
    Ok(Reply::done(installed(&r), json!(r)))
}

/// `l3 network`: the repos whose Prompts may reach the network on this device (Runtime's switch; never sent).
pub fn network_list(_: &Ctx, _: &Call) -> Result<Reply> {
    let all = home::networked();
    let text = if all.is_empty() { tr!("No repo's Prompts reach the network (l3 network on REPO)", "ネットワークに届く repo の Prompt はありません（l3 network on REPO）") }
        else { all.join("\n") };
    Ok(Reply::data(text, json!(all)))
}

/// `l3 network on|off REPO`, as Runtime's switch: a Prompt's namespace cannot be given the network once
/// made, so it has it from its next start; taken, the repo's Prompts stop at once.
pub fn network_set(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let on = call.word(0) == Some("on");
    let repo = target::repo(ctx, call, 1)?;
    let changed = home::set_network(&repo, on)?;
    let running = length3_core::prompt::running(&paths::data_dir()).iter().filter(|r| r.repo == repo).count();
    let stopped = if !on && running > 0 { super::forge::stop_prompts(&repo) } else { Vec::new() };
    let mut text = match (on, changed) {
        (true, true) => tr!("{}'s Prompts reach the network from the next one", "{} の Prompt は次からネットワークに届きます", repo),
        (true, false) => tr!("{}'s Prompts had the network already", "{} の Prompt はもうネットワークに届きます", repo),
        (false, true) => tr!("{}'s Prompts no longer reach the network", "{} の Prompt はもうネットワークに届きません", repo),
        (false, false) => tr!("{}'s Prompts had no network; nothing changed", "{} の Prompt はネットワークを持っていませんでした。何も変えていません", repo),
    };
    if on && running > 0 { text += &tr!("\n  the one running has none until it starts again (l3 prompt stop {})", "\n  動いているものは、開き直すまでネットワークなしです（l3 prompt stop {}）", repo); }
    if !stopped.is_empty() { text += &format!("\n  {}", super::forge::said_stopped(&repo, &stopped)); }
    Ok(Reply::done(text, json!({"repo": repo, "network": on, "changed": changed, "stopped": stopped, "granted": home::networked()})))
}

pub fn dotfile_list(_: &Ctx, _: &Call) -> Result<Reply> {
    let all = home::dotfiles();
    let data = json!(all.iter().map(|(n, t)| json!({"name": n, "bytes": t.len()})).collect::<Vec<_>>());
    if all.is_empty() { return Ok(Reply::data(tr!("No dotfiles yet (l3 dotfile write .profile < file)", "dotfile はまだありません（l3 dotfile write .profile < file）"), data)); }
    Ok(Reply::data(all.iter().map(|(n, t)| format!("{n}  {}", bytes(t.len() as u64))).collect::<Vec<_>>().join("\n"), data))
}

pub fn dotfile_show(_: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    let (_, text) = home::dotfiles().into_iter().find(|(n, _)| n == name).ok_or_else(|| Error::NotFound(tr!("There is no dotfile {}", "dotfile {} はありません", name)))?;
    Ok(Reply::Raw { json: json!({"name": name, "text": text}), text })
}

pub fn dotfile_write(_: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    if !home::dotfile_name(name) { return Err(Error::Usage(tr!("A dotfile is named with a dot first: .profile", "dotfile の名前は . で始めます：.profile"))); }
    let text = stdin_text(name, call.flags.empty, 1 << 19)?;
    let was = home::set_dotfile(name, Some(&text))?;
    let said = if was { tr!("Saved {} ({}; every Prompt starts with it in /root)", "{} を保存しました（{}。どの Prompt も /root に置いて始まります）", name, bytes(text.len() as u64)) }
        else { tr!("Made {} ({}; every Prompt starts with it in /root)", "{} を作りました（{}。どの Prompt も /root に置いて始まります）", name, bytes(text.len() as u64)) };
    Ok(Reply::done(said, json!({"name": name, "bytes": text.len(), "made": !was})))
}

pub fn dotfile_rm(_: &Ctx, call: &Call) -> Result<Reply> {
    let name = call.word(0).unwrap_or_default();
    if !home::dotfiles().iter().any(|(n, _)| n == name) { return Err(Error::NotFound(tr!("There is no dotfile {}", "dotfile {} はありません", name))); }
    home::set_dotfile(name, None)?;
    Ok(Reply::done(tr!("Removed {}", "{} を消しました", name), json!({"name": name})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_that_is_nothing_frees_nothing_and_says_how_it_is_written() {
        let c = Ctx::test(None, vec![]);
        for argv in [vec!["free", ""], vec!["free", "hello", " "]] {
            let argv: Vec<String> = argv.into_iter().map(String::from).collect();
            let call = crate::args::parse(&argv, &c).unwrap();
            assert!(matches!(free(&c, &call), Err(Error::Usage(_))), "{argv:?}");
        }
    }
}
