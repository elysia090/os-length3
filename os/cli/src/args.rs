//! Reading a command line against the table (spec.rs): the command (or an
//! alias), then the one form its words fit, each word in its slot; flags
//! anywhere before `--`, and only those the form takes. `--` ends the flags
//! for every command: what follows is words, even if they begin with `-`
//! (and for `l3 prompt`, the command to run). A word that is a form's verb is
//! that form's: `l3 file write` without a path is a mistake, not a repo
//! called "write".

use crate::cmd::Ctx;
use crate::out::Error;
use crate::spec::{self, Arg, Command, Flag, Form};
use length3_core::{i18n::ja, tr};

/// What was given for one slot of a form.
#[derive(Debug, Clone, PartialEq)]
pub enum Slot { Empty, One(String), Many(Vec<String>) }

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Flags {
    pub json: bool,
    pub note: Option<String>,
    pub template: Option<String>,
    pub network: bool,
    pub todo: bool,
    pub empty: bool,
    pub out: Option<String>,
}

pub struct Call {
    pub command: &'static Command,
    pub form: &'static Form,
    /// One for each of the form's args, in order.
    pub slots: Vec<Slot>,
    pub flags: Flags,
}

impl Call {
    /// The word given for slot `i`, if one was.
    pub fn word(&self, i: usize) -> Option<&str> {
        match self.slots.get(i) { Some(Slot::One(w)) => Some(w), _ => None }
    }
    /// The words given for slot `i` (a Many or Argv slot), or the one word.
    pub fn words(&self, i: usize) -> Vec<String> {
        match self.slots.get(i) { Some(Slot::Many(w)) => w.clone(), Some(Slot::One(w)) => vec![w.clone()], _ => Vec::new() }
    }
    pub fn note(&self) -> &str { self.flags.note.as_deref().unwrap_or_default() }
}

/// Which flag a word on the command line is.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Given { Json, Help, Version, Takes(Flag) }

/// The flags l3 knows by spelling; `value`: it takes the word after it.
fn flag(name: &str) -> Option<(Given, bool)> {
    Some(match name {
        "--json" => (Given::Json, false),
        "-h" | "--help" => (Given::Help, false),
        "-V" | "--version" => (Given::Version, false),
        "-m" | "--note" | "--detail" | "--message" => (Given::Takes(Flag::Note("")), true),
        "-t" | "--template" => (Given::Takes(Flag::Template), true),
        "-o" | "--out" => (Given::Takes(Flag::Out), true),
        "--network" => (Given::Takes(Flag::Network), false),
        "--todo" => (Given::Takes(Flag::Todo), false),
        "--empty" => (Given::Takes(Flag::Empty), false),
        _ => return None,
    })
}

fn same_flag(a: Flag, b: Flag) -> bool {
    matches!((a, b), (Flag::Note(_), Flag::Note(_))) || a == b
}

fn usage(s: String) -> Error { Error::Usage(s) }

/// Read `argv` (without the program's name). `ctx` says where l3 runs: in a
/// repo, an optional REPO may be left out, and a word that is no repo here is the next slot's.
pub fn parse(argv: &[String], ctx: &Ctx) -> Result<Call, Error> {
    let mut words: Vec<String> = Vec::new();
    let mut after: Option<Vec<String>> = None;
    let mut flags = Flags::default();
    let mut given: Vec<(Flag, String)> = Vec::new();
    let (mut help, mut version) = (false, false);
    let mut unknown: Option<String> = None;
    let mut it = argv.iter();
    while let Some(w) = it.next() {
        if w == "--" { after = Some(it.by_ref().cloned().collect()); break; }
        if !(w.starts_with('-') && w.len() > 1) { words.push(w.clone()); continue; }
        let (name, inline) = match w.split_once('=') { Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())), _ => (w.as_str(), None) };
        let Some((g, takes_value)) = flag(name) else { unknown.get_or_insert_with(|| w.clone()); continue };
        let value = if takes_value {
            Some(match inline { Some(v) => v, None => it.next().cloned().ok_or_else(|| usage(tr!("{} needs a value after it", "{} の後に値を書いてください", name)))? })
        } else if inline.is_some() {
            return Err(usage(tr!("{} takes no value", "{} は値をとりません", name)));
        } else { None };
        match g {
            Given::Json => flags.json = true,
            Given::Help => help = true,
            Given::Version => version = true,
            Given::Takes(f) => {
                match f {
                    Flag::Note(_) => flags.note = value,
                    Flag::Template => flags.template = value,
                    Flag::Out => flags.out = value,
                    Flag::Network => flags.network = true,
                    Flag::Todo => flags.todo = true,
                    Flag::Empty => flags.empty = true,
                }
                given.push((f, name.to_string()));
            }
        }
    }
    // -h and -V win over everything else: help for the command named, or l3's version.
    if version && !help {
        return Ok(simple("version", Vec::new(), flags));
    }
    let named = words.first().cloned();
    if help {
        let slots = named.into_iter().map(|n| Slot::One(spec::find(&n).map_or(n, |c| c.name.to_string()))).collect();
        return Ok(simple("help", slots, flags));
    }
    let name = named.unwrap_or_default();
    let command = spec::find(&name).ok_or_else(|| usage(not_a_command(&name)))?;
    if let Some(u) = unknown {
        return Err(usage(tr!("l3 does not know the flag {}\n\n{}", "{} というフラグはありません\n\n{}", u, forms_of(command))));
    }
    let rest = if words.is_empty() { &[][..] } else { &words[1..] };
    // A form's verb, or a choice its first word must be, is that form's alone.
    let is_verb = |f: &Form, w: &str| f.verb == Some(w) || (f.verb.is_none() && matches!(f.args.first(), Some(Arg::Choice(c)) if c.contains(&w)));
    let verbal = rest.first().filter(|w| command.forms.iter().any(|f| is_verb(f, w)));
    let candidates: Vec<&'static Form> = command.forms.iter().filter(|f| match verbal {
        Some(v) => is_verb(f, v),
        None => f.verb.is_none(),
    }).collect();
    let mut flag_error = None;
    for strict in [true, false] {
        for f in &candidates {
            let pos: Vec<String> = match f.verb { Some(_) => rest[1..].to_vec(), None => rest.to_vec() };
            let argv_slot = f.args.contains(&Arg::Argv);
            let (pos, tail) = if argv_slot { (pos, after.clone().unwrap_or_default()) } else { ([pos, after.clone().unwrap_or_default()].concat(), Vec::new()) };
            if !argv_slot && after.is_some() && f.args.is_empty() && !pos.is_empty() { continue; }
            let plain: Vec<Arg> = f.args.iter().copied().filter(|a| *a != Arg::Argv).collect();
            let Some(mut slots) = fit(&plain, &pos, strict, ctx) else { continue };
            if argv_slot {
                let at = f.args.iter().position(|a| *a == Arg::Argv).unwrap_or(slots.len());
                slots.insert(at, if tail.is_empty() { Slot::Empty } else { Slot::Many(tail) });
            }
            if let Some((_, spelled)) = given.iter().find(|(g, _)| !f.flags.iter().any(|t| same_flag(*t, *g))) {
                flag_error.get_or_insert_with(|| usage(tr!("{} is not a flag of {}\n\n{}", "{} は {} のフラグではありません\n\n{}", spelled, spec::usage(command, f), forms_of(command))));
                continue;
            }
            return Ok(Call { command, form: f, slots, flags });
        }
    }
    Err(flag_error.unwrap_or_else(|| usage(not_a_form(command, rest))))
}

fn simple(name: &str, slots: Vec<Slot>, flags: Flags) -> Call {
    let command = spec::find(name).expect("in the table");
    let form = command.forms.iter().find(|f| f.args.len() == slots.len()).unwrap_or(&command.forms[0]);
    Call { command, form, slots, flags }
}

/// Each word in its slot, optional slots filled first when the word suits
/// them; every word must find one. None when the form does not fit.
fn fit(args: &[Arg], words: &[String], strict: bool, ctx: &Ctx) -> Option<Vec<Slot>> {
    let Some((a, more)) = args.split_first() else { return words.is_empty().then(Vec::new) };
    if let Arg::Many(_) = a {
        return (!words.is_empty() && more.is_empty()).then(|| vec![Slot::Many(words.to_vec())]);
    }
    let optional = matches!(a, Arg::Repo { optional: true } | Arg::Path { optional: true });
    if let Some((w, rest)) = words.split_first() {
        if suits(*a, w, strict, ctx) {
            if let Some(mut tail) = fit(more, rest, strict, ctx) {
                tail.insert(0, Slot::One(w.clone()));
                return Some(tail);
            }
        }
    }
    if !optional { return None; }
    let mut tail = fit(more, words, strict, ctx)?;
    tail.insert(0, Slot::Empty);
    Some(tail)
}

/// `owner:repo…`: a principal's name, then a colon.
pub fn owner_shaped(w: &str) -> bool {
    w.split_once(':').is_some_and(|(o, _)| !o.is_empty() && !w.contains("://") && o.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')))
}

/// Whether `w` can stand in slot `a`. Strictly, in a repo, an optional REPO
/// takes only a repo that is here, so another word goes to the next slot
/// (`l3 commit "x"` in a repo is a title).
fn suits(a: Arg, w: &str, strict: bool, ctx: &Ctx) -> bool {
    let repo_shaped = |w: &str| length3_core::repos::valid_name(w) || owner_shaped(w);
    match a {
        Arg::Repo { optional } => repo_shaped(w) && (!strict || !optional || ctx.here.is_none() || owner_shaped(w) || ctx.has_repo(w)),
        Arg::Path { .. } | Arg::Text(_) => true,
        // By its number, or by its title; strictly, a repo here is the repo, not a title.
        Arg::Issue => !w.trim().is_empty() && (crate::target::numbered(w) || !strict || !(length3_core::repos::valid_name(w) && ctx.has_repo(w))),
        Arg::Number(_) => !w.is_empty() && w.bytes().all(|b| b.is_ascii_digit()),
        Arg::Choice(c) => c.contains(&w),
        Arg::Address => !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | '+')),
        Arg::Dotfile => w.starts_with('.'),
        Arg::Many(_) | Arg::Argv => true,
    }
}

/// How far apart two words are: edits, a swap of two letters side by side
/// counting as one (optimal string alignment).
pub fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() { row[0] = i; }
    for (j, cell) in d[0].iter_mut().enumerate() { *cell = j; }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] { d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1); }
        }
    }
    d[a.len()][b.len()]
}

/// The known word nearest `word`, if near enough to be what was meant; never `word` itself.
pub fn nearest<'a>(word: &str, among: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    among.into_iter().filter(|w| *w != word).map(|w| (distance(word, w), w))
        .filter(|(d, w)| *d <= (w.chars().count() / 3).max(1)).min_by_key(|(d, _)| *d).map(|(_, w)| w)
}

/// What to say when the first word is not a command.
pub fn not_a_command(word: &str) -> String {
    let names = spec::shown().flat_map(|c| std::iter::once(c.name).chain(c.aliases.iter().copied()));
    match nearest(word, names) {
        Some(w) => tr!("Not a command: l3 {}\nDid you mean: l3 {}", "わからないコマンドです：l3 {}\nもしかして：l3 {}", word, w),
        None => tr!("Not a command: l3 {}\n`l3 help` lists the commands", "わからないコマンドです：l3 {}\n`l3 help` でコマンドの一覧を見られます", word),
    }
}

/// A command's forms, as help shows them.
pub fn forms_of(c: &Command) -> String {
    let rows: Vec<String> = c.forms.iter().filter(|f| !f.hidden).map(|f| format!("  {}", spec::usage(c, f))).collect();
    rows.join("\n")
}

fn not_a_form(c: &Command, rest: &[String]) -> String {
    let verbs = c.forms.iter().flat_map(|f| f.verb.into_iter().chain(match (f.verb, f.args.first()) { (None, Some(Arg::Choice(w))) => w.to_vec(), _ => Vec::new() }));
    let hint = rest.first().and_then(|w| nearest(w, verbs)).map(|v| tr!("Did you mean: l3 {} {}\n", "もしかして：l3 {} {}\n", c.name, v)).unwrap_or_default();
    let written = std::iter::once(c.name.to_string()).chain(rest.iter().cloned()).collect::<Vec<_>>().join(" ");
    if ja() { format!("l3 {written} の書き方ではありません\n{hint}\n{}", forms_of(c)) } else { format!("Not how l3 {written} is written\n{hint}\n{}", forms_of(c)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(here: Option<&str>, repos: &[&'static str]) -> Ctx {
        Ctx::test(here, repos.to_vec())
    }
    fn p(line: &str, c: &Ctx) -> Result<Call, Error> {
        let argv: Vec<String> = shell_words(line);
        parse(&argv, c)
    }
    /// Split like a shell would for these tests: spaces, and "…" kept whole.
    fn shell_words(s: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut any = false;
        for ch in s.chars() {
            match ch {
                '"' => { quoted = !quoted; any = true; }
                ' ' if !quoted => { if any { out.push(std::mem::take(&mut cur)); any = false; } }
                _ => { cur.push(ch); any = true; }
            }
        }
        if any { out.push(cur); }
        out
    }
    fn form(c: &Call) -> String { spec::usage(c.command, c.form) }

    #[test]
    fn a_word_fills_the_slot_it_suits() {
        let out = ctx(None, &["hello"]);
        let inside = ctx(Some("hello"), &["hello"]);
        let c = p("commit nope", &out).unwrap();
        assert_eq!((form(&c), c.slots.clone()), ("l3 commit [REPO] [-m note]".into(), vec![Slot::One("nope".into())]));
        let c = p("commit nope", &inside).unwrap();
        assert_eq!(c.slots, vec![Slot::Empty, Slot::One("nope".into())]);
        let c = p("commit hello", &inside).unwrap();
        assert_eq!(c.slots, vec![Slot::One("hello".into())]);
        // A title with a slash, or a colon, is a title.
        let c = p("commit \"Fix：a/b\"", &inside).unwrap();
        assert_eq!(c.slots, vec![Slot::Empty, Slot::One("Fix：a/b".into())]);
        let c = p("issue new Docs:readme", &inside).unwrap();
        assert_eq!(c.slots, vec![Slot::Empty, Slot::One("Docs:readme".into())]);
        let c = p("issue new hello Docs:readme", &out).unwrap();
        assert_eq!(c.slots, vec![Slot::One("hello".into()), Slot::One("Docs:readme".into())]);
        // In a repo, a word that is no repo here still reaches the slot when nothing else fits (and is then not found).
        let c = p("log nope", &inside).unwrap();
        assert_eq!(c.slots, vec![Slot::One("nope".into())]);
        assert_eq!(form(&p("diff hello#1", &out).unwrap()), "l3 diff ISSUE");
        assert_eq!(form(&p("diff \"restart loses\"", &out).unwrap()), "l3 diff ISSUE");
        assert_eq!(form(&p("issue hello", &out).unwrap()), "l3 issue [REPO]");
        assert_eq!(p("start readme", &out).unwrap().word(0), Some("readme"));
        assert_eq!(form(&p("diff hello", &out).unwrap()), "l3 diff [REPO]");
    }

    #[test]
    fn dashes_end_the_flags_and_text_may_begin_with_one() {
        let c = ctx(None, &[]);
        let call = p("todo add -- -1 is a number", &c);
        assert!(call.is_err(), "three words are not one");
        let call = p("todo add -- \"-1 is a number\"", &c).unwrap();
        assert_eq!(call.slots, vec![Slot::One("-1 is a number".into())]);
        let call = p("todo add \"x\" -m -detail", &c).unwrap();
        assert_eq!(call.flags.note.as_deref(), Some("-detail"));
        let call = p("prompt hello -- ls -la --json", &ctx(None, &["hello"])).unwrap();
        assert_eq!(call.slots, vec![Slot::One("hello".into()), Slot::Many(vec!["ls".into(), "-la".into(), "--json".into()])]);
        assert!(!call.flags.json);
        let call = p("prompt --network", &ctx(Some("hello"), &["hello"])).unwrap();
        assert!(call.flags.network && call.slots == vec![Slot::Empty, Slot::Empty]);
        assert!(p("file -- write", &c).is_ok_and(|c| c.word(0) == Some("write")));
    }

    #[test]
    fn flags_out_of_place_and_unknown_ones_are_mistakes() {
        let c = ctx(None, &[]);
        assert!(matches!(p("todo --network", &c), Err(Error::Usage(_))));
        assert!(matches!(p("todo --frobnicate", &c), Err(Error::Usage(_))));
        assert!(matches!(p("todo add", &c), Err(Error::Usage(_))));
        assert!(matches!(p("todo add x -m", &c), Err(Error::Usage(_))));
        assert!(p("todo add x --note=why", &c).is_ok_and(|c| c.note() == "why"));
        assert!(p("repo --json", &c).is_ok_and(|c| c.flags.json));
        assert!(matches!(p("lang --json=1", &c), Err(Error::Usage(_))));
    }

    #[test]
    fn a_verb_is_its_forms_alone() {
        let c = ctx(None, &[]);
        assert!(matches!(p("file write", &c), Err(Error::Usage(m)) if m.contains("file write")));
        assert!(matches!(p("inbox accept", &c), Err(Error::Usage(_))));
        assert!(matches!(p("dotfile write", &c), Err(Error::Usage(_))));
        assert_eq!(form(&p("dotfile write .profile", &c).unwrap()), "l3 dotfile write NAME [--empty]");
        assert_eq!(form(&p("dotfiles", &c).unwrap()), "l3 dotfile");
        assert_eq!(form(&p("remote devices rm 2", &c).unwrap()), "l3 remote devices rm N");
        assert_eq!(form(&p("free all", &c).unwrap()), "l3 free all");
        assert_eq!(form(&p("free repo:a repo:b", &c).unwrap()), "l3 free ID…");
    }

    #[test]
    fn help_and_version_and_mistyped_words() {
        let c = ctx(None, &[]);
        for (line, want) in [("help help", "help"), ("help version", "version"), ("commit --help", "commit"), ("dotfiles -h", "dotfile")] {
            let call = p(line, &c).unwrap();
            assert_eq!((call.command.name, call.word(0)), ("help", Some(want)), "{line}");
        }
        assert_eq!(p("-V", &c).unwrap().command.name, "version");
        assert_eq!(p("", &c).unwrap().command.name, "");
        let Err(Error::Usage(m)) = p("comit", &c) else { panic!() };
        assert!(m.contains("l3 commit"), "{m}");
        let Err(Error::Usage(m)) = p("todo ad x", &c) else { panic!() };
        assert!(m.contains("l3 todo add"), "{m}");
        assert_eq!(nearest("help", ["help", "hello"]), None);
        assert_eq!(nearest("rpeo", ["repo", "root"]), Some("repo"));
        assert_eq!(distance("rpeo", "repo"), 1);
    }
}
