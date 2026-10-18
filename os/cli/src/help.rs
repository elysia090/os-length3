//! l3's help, made from the table (spec.rs): `l3 help` (each command by
//! the rail), `l3 help COMMAND` (its forms), `l3 help all` (every form, each
//! group aligned on its own). `l3 COMMAND --help` is `l3 help COMMAND`.

use crate::args::{not_a_command, Call};
use crate::cmd::Ctx;
use crate::out::{Error, Reply, Result};
use crate::spec::{self, Command, Group, Words};
use length3_core::i18n::ja;
use serde_json::json;
use std::io::IsTerminal;

fn say(w: Words) -> &'static str {
    if ja() { w[1] } else { w[0] }
}

/// Bold, where the output is a terminal that wants it.
fn bold(s: &str) -> String {
    if std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() { format!("\x1b[1m{s}\x1b[0m") } else { s.to_string() }
}

/// How many columns `s` takes in a terminal (CJK and full-width forms take two).
pub fn width(s: &str) -> usize {
    s.chars().map(|c| if matches!(c as u32, 0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6) { 2 } else { 1 }).sum()
}

fn pad(s: &str, cols: usize) -> String {
    format!("{s}{}", " ".repeat(cols.saturating_sub(width(s))))
}

pub fn run(_: &Ctx, call: &Call) -> Result<Reply> {
    match call.word(0) {
        None => Ok(Reply::data(overview(), data(spec::shown().collect()))),
        Some("all") => Ok(Reply::data(all(), data(spec::shown().collect()))),
        Some(name) => match spec::find(name).filter(|c| !c.hidden) {
            Some(c) => Ok(Reply::data(command(c), data(vec![c]))),
            None => Err(Error::Usage(not_a_command(name))),
        },
    }
}

fn data(cs: Vec<&Command>) -> serde_json::Value {
    json!(cs.iter().map(|c| json!({"name": c.name, "aliases": c.aliases, "group": c.group.name(), "about": say(c.about),
        "forms": c.forms.iter().filter(|f| !f.hidden).map(|f| json!({"usage": spec::usage(c, f), "about": say(f.about)})).collect::<Vec<_>>()})).collect::<Vec<_>>())
}

/// `l3 help`: each command in a line, by the rail.
pub fn overview() -> String {
    let mut s = String::new();
    s += if ja() { "l3 — Length³ OS をコマンドで。アプリと同じ言葉と順番です。\n\n" } else { "l3 — Length³ OS on the command line, in the app's words and order.\n\n" };
    s += &format!("{}  l3 <command> [args] [--json]   {}\n", bold(if ja() { "使い方" } else { "Usage" }),
        if ja() { "（l3 だけで、ターミナルではメニュー、ほかではこの端末のいま）" } else { "(l3 alone: the menu at a terminal, elsewhere this device at a glance)" });
    for g in Group::ALL {
        let cs: Vec<&Command> = spec::shown().filter(|c| c.group == g).collect();
        if cs.is_empty() { continue; }
        s += &format!("\n{}\n", bold(g.name()));
        for c in cs { s += &format!("  {} {}\n", pad(c.name, 10), say(c.about)); }
    }
    s += &format!("\n{}\n", bold(if ja() { "フラグ" } else { "Flags" }));
    for (f, w) in [
        ("--json", ["data instead of text (every command)", "文の代わりにデータ（どのコマンドも）"]),
        ("--", ["the end of flags: what follows is words, even with a - first", "フラグの終わり。後ろは - で始まっても言葉"]),
        ("-h, --help", ["a command's forms (l3 help COMMAND)", "コマンドの書き方（l3 help COMMAND）"]),
        ("-V, --version", ["l3's version, and the root's", "l3 と root の版"]),
    ] {
        s += &format!("  {} {}\n", pad(f, 14), say(w));
    }
    s += &format!("\n{}\n", bold(if ja() { "終了コード" } else { "Exit codes" }));
    s += if ja() { "  0 できた · 1 できなかった · 2 書き方の誤り · 3 Remote に届かない · 4 見つからない\n\n" } else { "  0 done · 1 not done · 2 not how it is written · 3 the Remote out of reach · 4 not found\n\n" };
    s += if ja() {
        "repo の中（とその Prompt）では REPO を省けます。ISSUE は repo の中なら N か #N、外なら REPO#N、または件名の言葉（「再起動」など）です。\n`l3 help all` ですべての書き方、`l3 completion bash|zsh|fish` で補完。\nターミナルでは、l3 だけでアプリのレールと同じ目的が並び、選ぶとそのページと次の操作が出ます（実行するコマンドも表示）。コマンドのあとにも次の操作を出します（Enter か Esc でそのまま）。パイプ、--json、TERM=dumb、L3_PLAIN=1 では何も尋ねません。\n\n名前は持ち主が先：hello, hello/src/a.c, hello#3, ren@length3.com:hello（あなたの repo を全部書いた形）, trip#general（サーバーの板）。"
    } else {
        "In a repo (or its Prompt) REPO may be left out. An ISSUE is N or #N in its repo, REPO#N elsewhere, or words of its title (\"restart\").\n`l3 help all` lists every form; `l3 completion bash|zsh|fish` completes them.\nAt a terminal, l3 alone lists the app's purposes as its rail does; one picked shows its page and what can be done next, each deed saying the command it runs. A command typed is followed by its next deeds too (Enter or Esc passes them by). Through a pipe, with --json, TERM=dumb or L3_PLAIN=1, nothing is offered or asked.\n\nNames, owner first: hello, hello/src/a.c, hello#3, ren@length3.com:hello (yours, written in full), trip#general (a server's board)."
    };
    s
}

/// Each form of `cs` in a line, its words after it, aligned at `cols`.
fn forms(cs: &[&Command], cols: usize) -> String {
    let mut s = String::new();
    for c in cs {
        for f in c.forms.iter().filter(|f| !f.hidden) {
            let u = spec::usage(c, f);
            let what = say(f.about);
            s += &if what.is_empty() { format!("  {u}\n") } else if width(&u) > cols { format!("  {u}\n  {}  {what}\n", " ".repeat(cols)) } else { format!("  {}  {what}\n", pad(&u, cols)) };
        }
    }
    s
}

fn widest(cs: &[&Command]) -> usize {
    cs.iter().flat_map(|c| c.forms.iter().filter(|f| !f.hidden).map(move |f| width(&spec::usage(c, f)))).max().unwrap_or(0).min(56)
}

/// `l3 help COMMAND`: what it does, and each way to write it.
pub fn command(c: &Command) -> String {
    let mut s = format!("{} — {}\n\n{}", bold(&format!("l3 {}", c.name)), say(c.about), forms(&[c], widest(&[c])).trim_end());
    if !c.aliases.is_empty() { s += &format!("\n\n{}{}", if ja() { "別名：" } else { "Also: " }, c.aliases.iter().map(|a| format!("l3 {a}")).collect::<Vec<_>>().join(", ")); }
    if c.forms.iter().any(|f| f.args.contains(&spec::Arg::Issue)) {
        s += &format!("\n\n{}", if ja() { "ISSUE：repo の中なら N か #N、外なら REPO#N、または件名の言葉（「再起動」など。ひとつに決まらなければ番号で）" } else { "ISSUE: N or #N in its repo, REPO#N elsewhere, or words of its title (\"restart\"; by its number when the words fit more than one)" });
    }
    if c.name == "repo" {
        let t: Vec<String> = length3_core::templates::all().into_iter().map(|t| format!("{} ({})", t.id, t.label)).collect();
        s += &format!("\n\n{}{}", if ja() { "テンプレート：" } else { "Templates: " }, t.join(", "));
    }
    s
}

/// `l3 help all`: every form, by the rail, each group aligned on its own.
pub fn all() -> String {
    let mut s = String::new();
    for g in Group::ALL {
        let cs: Vec<&Command> = spec::shown().filter(|c| c.group == g).collect();
        if cs.is_empty() { continue; }
        s += &format!("{}\n{}\n", bold(g.name()), forms(&cs, widest(&cs)));
    }
    s.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_all_holds_every_form_and_aligns_each_group() {
        let a = all();
        assert!(a.contains("l3 issue new"), "{a}");
        assert!(a.contains("l3 help [COMMAND|all]") || a.contains("l3 help COMMAND|all"), "{a}");
        // Within a group, the words after each form start in one column.
        for g in Group::ALL {
            let cs: Vec<&Command> = spec::shown().filter(|c| c.group == g).collect();
            let text = forms(&cs, widest(&cs));
            let mut at = std::collections::HashSet::new();
            for c in &cs {
                for f in c.forms.iter().filter(|f| !f.hidden && !say(f.about).is_empty()) {
                    let u = format!("  {}", spec::usage(c, f));
                    let Some(line) = text.lines().find(|l| l.starts_with(&u) && l.ends_with(say(f.about))) else { continue };
                    at.insert(width(&line[..line.len() - say(f.about).len()]));
                }
            }
            assert!(at.len() <= 1, "{}: {at:?}\n{text}", g.name());
        }
        assert_eq!(width("Fix：t"), 6);
    }

    #[test]
    fn help_knows_its_own_words() {
        for c in ["help", "version", "completion", "dotfile"] {
            assert!(spec::find(c).is_some_and(|c| !c.hidden), "{c}");
        }
        assert!(command(spec::find("repo").unwrap()).contains("standard"));
    }
}
