//! Shell completion from the table: the scripts ask `l3 complete -- WORDS…`
//! for what may come next, and l3 answers from the forms: the commands, a
//! command's verbs and choices, its flags, and what fits each slot: repo
//! names where a repo goes, paths in a repo where a path goes, issues where
//! an issue goes, dotfiles where a dotfile goes. Nothing asks the Remote.

use crate::args::Call;
use crate::cmd::Ctx;
use crate::out::{Error, Reply, Result};
use crate::spec::{self, Arg, Command, Flag};
use crate::target;
use length3_core::{home, templates};
use serde_json::json;

pub fn script(_: &Ctx, call: &Call) -> Result<Reply> {
    let shell = call.word(0).unwrap_or_default();
    let text = match shell {
        "bash" | "zsh" => format!(
            "# l3 completion ({shell}): eval \"$(l3 completion {shell})\"\n{}_l3() {{\n  local IFS=$'\\n'\n  COMPREPLY=($(l3 complete -- \"${{COMP_WORDS[@]:1:$COMP_CWORD}}\" 2>/dev/null))\n  if [ \"${{#COMPREPLY[@]}}\" -eq 1 ] && [ \"${{COMPREPLY[0]%/}}\" != \"${{COMPREPLY[0]}}\" ]; then compopt -o nospace 2>/dev/null; fi\n}}\ncomplete -F _l3 l3\n",
            if shell == "zsh" { "autoload -U +X bashcompinit && bashcompinit\n" } else { "" }),
        "fish" => "# l3 completion (fish): l3 completion fish | source\ncomplete -c l3 -f -a '(l3 complete -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'\n".to_string(),
        _ => return Err(Error::Usage("l3 completion bash|zsh|fish".into())),
    };
    Ok(Reply::Raw { json: json!({"shell": shell, "script": text}), text })
}

/// `l3 complete -- WORDS…`: what may come as the last word (the one being written), a line each.
pub fn complete(ctx: &Ctx, call: &Call) -> Result<Reply> {
    let words = call.words(0);
    let list = candidates(ctx, &words);
    if list.is_empty() && !call.flags.json { return Ok(Reply::Nothing); }
    Ok(Reply::data(list.join("\n"), json!(list)))
}

fn spellings(f: Flag) -> &'static [&'static str] {
    match f {
        Flag::Note(_) => &["-m"],
        Flag::Template => &["-t"],
        Flag::Network => &["--network"],
        Flag::Todo => &["--todo"],
        Flag::Empty => &["--empty"],
        Flag::Out => &["-o"],
        Flag::Force => &["--force"],
    }
}

/// The words that may be written last, given those before it.
pub fn candidates(ctx: &Ctx, words: &[String]) -> Vec<String> {
    let (cur, done) = match words.split_last() { Some((c, d)) => (c.as_str(), d), None => ("", &[][..]) };
    let mut out: Vec<String> = Vec::new();
    let Some((first, rest)) = done.split_first() else {
        out.extend(spec::shown().map(|c| c.name.to_string()));
        return keep(out, cur);
    };
    let Some(c) = spec::find(first) else { return Vec::new() };
    // The word after a flag that takes one.
    match done.last().map(String::as_str) {
        Some("-t" | "--template") => return keep(templates::all().into_iter().map(|t| t.id).collect(), cur),
        Some(w) if crate::args::takes_value(w) => return Vec::new(),
        _ => {}
    }
    if cur.starts_with('-') {
        let mut flags: Vec<String> = c.forms.iter().flat_map(|f| f.flags.iter().flat_map(|fl| spellings(*fl).iter().map(|s| s.to_string()))).collect();
        flags.extend(["--json", "--help", "--"].map(String::from));
        return keep(flags, cur);
    }
    // The words typed so far, their flags (and what those take) aside.
    let mut pos: Vec<&str> = Vec::new();
    let mut skip = false;
    for w in rest {
        if skip { skip = false; continue; }
        if crate::args::takes_value(w) { skip = true; continue; }
        if !w.starts_with('-') { pos.push(w); }
    }
    if c.name == "help" {
        if pos.is_empty() { out.extend(spec::shown().map(|c| c.name.to_string())); out.push("all".into()); }
        return keep(out, cur);
    }
    for f in c.forms.iter().filter(|f| !f.hidden) {
        let after: &[&str] = match f.verb {
            Some(v) if pos.first() == Some(&v) => &pos[1..],
            Some(v) => { if pos.is_empty() { out.push(v.to_string()); } continue; }
            None => &pos,
        };
        let args: Vec<Arg> = f.args.iter().copied().filter(|a| *a != Arg::Argv).collect();
        let mut at = after.len();
        // A slot left out (REPO in a repo) lets the next one be written here too.
        while let Some(a) = args.get(at.min(args.len())) {
            out.extend(slot(ctx, c, *a, cur, f.verb));
            if !matches!(a, Arg::Repo { optional: true } | Arg::Path { optional: true }) || at + 1 >= args.len() { break; }
            at += 1;
        }
    }
    keep(out, cur)
}

/// What fits one slot.
fn slot(ctx: &Ctx, _c: &Command, a: Arg, cur: &str, verb: Option<&str>) -> Vec<String> {
    let repos = || ctx.repos().and_then(|r| Ok(r.list()?)).map(|l| l.into_iter().map(|s| s.name).collect::<Vec<_>>()).unwrap_or_default();
    match a {
        Arg::Repo { .. } => repos(),
        Arg::Choice(c) => c.iter().map(|s| s.to_string()).collect(),
        Arg::Dotfile => {
            let mut names: Vec<String> = home::dotfiles().into_iter().map(|(n, _)| n).collect();
            if verb == Some("write") { names.extend(home::COMMON_DOTFILES.iter().map(|s| s.to_string())); }
            names
        }
        Arg::Issue => {
            let r = match ctx.repos() { Ok(r) => r, Err(_) => return Vec::new() };
            let mut out = Vec::new();
            for name in repos() {
                for i in r.issues(&name).unwrap_or_default().into_iter().filter(|i| i.n.is_some()) {
                    let n = length3_core::issues::number(&i.file);
                    if ctx.here.as_ref().is_some_and(|h| h.repo == name) { out.push(n.clone()); }
                    out.push(format!("{name}{n}"));
                }
            }
            out
        }
        Arg::Path { .. } => paths(ctx, cur),
        Arg::Address | Arg::Text(_) | Arg::Number(_) | Arg::Many(_) | Arg::Argv => Vec::new(),
    }
}

/// Paths that start with `cur`: what is in the folder it names so far; outside a repo, the repos first.
fn paths(ctx: &Ctx, cur: &str) -> Vec<String> {
    let (base, _) = cur.rsplit_once('/').unwrap_or(("", cur));
    let shown_base = if cur.contains('/') { format!("{base}/") } else { String::new() };
    let mut out = Vec::new();
    if !cur.contains('/') && ctx.here.as_ref().is_none_or(|h| h.folder.is_empty()) {
        out.extend(ctx.repos().and_then(|r| Ok(r.list()?)).unwrap_or_default().into_iter().map(|s| format!("{}/", s.name)));
    }
    let word = if cur.contains('/') { Some(base) } else { None };
    if word.is_none() && ctx.here.is_none() { return out; }
    let Ok((repo, rel)) = target::path_of(ctx, word.filter(|b| !b.is_empty()).or(if cur.starts_with('/') { Some("/") } else { None })) else { return out };
    let Ok(r) = ctx.repos() else { return out };
    for e in r.tree(&repo, &rel).unwrap_or_default() {
        out.push(format!("{shown_base}{}{}", e.name, if e.kind == "dir" { "/" } else { "" }));
    }
    out
}

/// Those that start with what is written, each once, in order.
fn keep(list: Vec<String>, cur: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in list { if w.starts_with(cur) && !out.contains(&w) { out.push(w); } }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> { s.split(' ').map(String::from).collect() }

    #[test]
    fn completion_follows_the_table() {
        let c = Ctx::test(None, vec![]);
        assert!(candidates(&c, &w("com")).contains(&"commit".to_string()));
        assert!(candidates(&c, &w("com")).contains(&"completion".to_string()));
        assert!(!candidates(&c, &w("")).iter().any(|x| x == "complete" || x == "sync" || x.is_empty()));
        assert_eq!(candidates(&c, &w("address ")), ["claim", "renew", "release", "domain"]);
        assert_eq!(candidates(&c, &w("dotfile ")), ["write", "rm"]);
        assert!(candidates(&c, &w("dotfile write .p")).contains(&".profile".to_string()));
        assert_eq!(candidates(&c, &w("review x#1 ")), ["approve", "changes"]);
        assert_eq!(candidates(&c, &w("todo add x -")), ["-m", "--json", "--help", "--"]);
        assert_eq!(candidates(&c, &w("repo new x -t ")).first().map(String::as_str), Some("standard"));
        assert_eq!(candidates(&c, &w("completion ")), ["bash", "zsh", "fish"]);
        assert!(candidates(&c, &w("help ")).contains(&"all".to_string()));
        assert_eq!(candidates(&c, &w("remote devices ")), ["rm"]);
        // Every spelling parsing takes a value after is one here too (bug: --message was read as a word).
        assert!(candidates(&c, &w("review x#1 --message ")).is_empty());
        assert_eq!(candidates(&c, &w("review x#1 --message note ")), ["approve", "changes"]);
    }

    #[test]
    fn every_shell_gets_a_script() {
        let c = Ctx::test(None, vec![]);
        for sh in ["bash", "zsh", "fish"] {
            let argv: Vec<String> = vec!["completion".into(), sh.into()];
            let call = crate::args::parse(&argv, &c).unwrap();
            let Ok(Reply::Raw { text, .. }) = script(&c, &call) else { panic!() };
            assert!(text.contains("l3 complete --"), "{sh}");
        }
    }
}
