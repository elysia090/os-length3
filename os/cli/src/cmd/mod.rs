//! What each form does, by the rail: Home, Forge, File, Git, Runtime,
//! Remote, then people (Server, Inbox). Each takes where l3 runs (Ctx) and
//! the call, and answers with a Reply.

pub mod file;
pub mod forge;
pub mod git;
pub mod home;
pub mod people;
pub mod remote;
pub mod runtime;

use crate::args::Call;
use crate::out::{Error, Reply, Result};
use length3_core::{home as core_home, paths, remote as core_remote, repos::Repos, tr, work};
use serde_json::json;

/// Where l3 runs: in which repo (and where in it), and whether inside the app's Prompt.
pub struct Ctx {
    pub here: Option<work::Here>,
    /// Inside the app's Prompt: only the open repo is here (under /root), written back and sent by the app.
    pub prompt: bool,
    #[cfg(test)]
    known: Vec<&'static str>,
}

impl Ctx {
    pub fn new() -> Ctx {
        Ctx {
            here: std::env::current_dir().ok().and_then(|d| work::here(&d)),
            prompt: std::env::var_os("L3_PROMPT").is_some(),
            #[cfg(test)]
            known: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn test(here: Option<&str>, known: Vec<&'static str>) -> Ctx {
        Ctx { here: here.map(|r| work::Here { repo: r.into(), line: work::MAIN.into(), folder: String::new() }), prompt: false, known }
    }

    pub fn repos(&self) -> Result<Repos> {
        // Tests read words, never the person's repos.
        if cfg!(test) { return Err(Error::Io("no repos in tests".into())); }
        Ok(Repos::open()?)
    }

    /// Whether the repo `name` is here.
    pub fn has_repo(&self, name: &str) -> bool {
        #[cfg(test)]
        { self.known.contains(&name) }
        #[cfg(not(test))]
        { length3_core::repos::valid_name(name) && Repos::open().is_ok_and(|r| r.dir(name).is_ok()) }
    }

    /// Whether `rel` is in the repo `repo` (as it shows now).
    pub fn exists(&self, repo: &str, rel: &str) -> bool {
        if cfg!(test) { return false; }
        Repos::open().and_then(|r| r.place(repo)).is_ok_and(|d| d.join(rel).symlink_metadata().is_ok())
    }

    /// Whether this device is on a Remote (never from inside a Prompt).
    pub fn connected(&self) -> bool {
        !self.prompt && core_remote::connection().is_some()
    }
}

/// Before a form runs: whether it may run here (a Prompt, a Remote), then
/// what keeping in step asks first.
pub fn before(ctx: &Ctx, call: &Call) -> Result<()> {
    let needs = call.form.needs;
    if ctx.prompt && !needs.in_prompt {
        let why = if needs.remote { tr!("the Remote is the app's to reach", "Remote に届くのはアプリです") }
            else { tr!("{} is the app's", "{} はアプリのものです", call.command.group.name()) };
        return Err(Error::Refused(tr!("l3 {} cannot be used in this Prompt: {}. Use the app, or l3 on the device", "l3 {} はこの Prompt では使えません（{}）。アプリか、端末の l3 でどうぞ", call.command.name, why)));
    }
    if needs.remote && core_remote::connection().is_none() {
        return Err(Error::Offline(tr!("l3 {} needs the Remote, and this device is not on one (l3 login)", "l3 {} には Remote がいります。この端末はつながっていません（l3 login）", call.command.name)));
    }
    crate::sync::before(ctx, call);
    Ok(())
}

/// `l3 version`: l3's, and the root's in use.
pub fn version(_: &Ctx, _: &Call) -> Result<Reply> {
    let v = include_str!("../../../RELEASE").trim();
    let root = length3_core::root::current(&paths::data_dir()).map(|(_, i)| i);
    let mut text = format!("l3 {v}");
    if let Some(i) = &root { text += &format!("\nroot {} {} ({})", i.name, i.version, crate::out::short(&i.sha256)); }
    Ok(Reply::data(text, json!({"version": v, "root": root})))
}

/// `l3` alone: this device at a glance.
pub fn overview(ctx: &Ctx, _: &Call) -> Result<Reply> {
    let r = ctx.repos()?;
    let list = r.list()?;
    let todos = if ctx.prompt { Vec::new() } else { core_home::todos()? };
    let open = todos.iter().filter(|t| !t.done).count();
    let issues: usize = list.iter().map(|s| r.issues(&s.name).map_or(0, |v| v.len())).sum();
    let c = if ctx.prompt { None } else { core_remote::connection() };
    let data = json!({"repos": list.len(), "issues": issues, "todo": {"open": open, "all": todos.len()},
        "home": paths::data_dir(), "remote": c.as_ref().map(|c| &c.url), "prompt": ctx.prompt});
    let mut t = Vec::new();
    if ctx.prompt {
        t.push(tr!("Length³ OS  {} (this Prompt's repo; what you change is written back and sent by the app)", "Length³ OS  {}（この Prompt の repo。変えたファイルはアプリが書き戻し、Remote に送ります）", paths::repos_dir().display()));
    } else {
        t.push(format!("Length³ OS  {}", paths::data_dir().display()));
        t.push(match &c {
            Some(c) => tr!("  Remote {} (sent as you change)", "  Remote {}（変えるたびに送ります）", host(&c.url)),
            None => tr!("  Remote not connected (l3 login)", "  Remote まだつないでいません（l3 login）"),
        });
    }
    t.push(format!("  repo   {}", list.len()));
    t.push(format!("  Issue  {issues}"));
    if !ctx.prompt { t.push(tr!("  TODO   {} open of {}", "  TODO   残り {} / {}", open, todos.len())); }
    t.push(tr!("`l3 help` shows how to use it", "`l3 help` で使い方を見られます"));
    Ok(Reply::data(t.join("\n"), data))
}

/// A Remote's address as it is shown: without its scheme.
pub fn host(url: &str) -> &str {
    url.split("://").nth(1).unwrap_or(url)
}

/// Standard input, all of it, as text, for a form that writes it somewhere.
/// Nothing at all is refused unless `empty` (--empty): an empty pipe is
/// more often a mistake than a wish to empty a file.
pub fn stdin_text(what: &str, empty: bool, limit: u64) -> Result<String> {
    use std::io::{IsTerminal, Read};
    if std::io::stdin().is_terminal() {
        return Err(Error::Usage(tr!("The text for {} comes from standard input: l3 … < file, or a pipe", "{} の本文は標準入力から渡します：l3 … < file か、パイプで", what)));
    }
    let mut bytes = Vec::new();
    std::io::stdin().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Refused(tr!("Standard input is larger than {0} for {1}", "{1} には標準入力が大きすぎます（{0} まで）", crate::out::bytes(limit), what)));
    }
    if bytes.is_empty() && !empty {
        return Err(Error::Refused(tr!("Standard input was empty, so nothing was written to {} (--empty writes it empty)", "標準入力が空なので {} には何も書いていません（空にするなら --empty）", what)));
    }
    String::from_utf8(bytes).map_err(|_| Error::Refused(tr!("Standard input is not text (UTF-8); {} takes text", "標準入力がテキスト（UTF-8）ではありません。{} にはテキストを渡します", what)))
}
