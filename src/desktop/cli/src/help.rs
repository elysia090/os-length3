//! l3's commands as one table: the help (`l3 help`, `l3 help COMMAND`,
//! `l3 COMMAND --help`), the suggestion for a mistyped word, and the shell
//! completion all read it, so they cannot drift from each other. Its order
//! is the app's rail: Server first (the one whose subject is people), then
//! what is done with repos.

use length3_core::i18n::ja;
use std::io::IsTerminal;

/// A word in English and in Japanese.
type Words = [&'static str; 2];

pub struct Command {
    pub name: &'static str,
    group: &'static str,
    about: Words,
    /// Each form: how it is written, and what it does.
    forms: &'static [(&'static str, Words)],
    /// The words that may come next (for completion).
    pub next: &'static [&'static str],
    /// Takes a repo (or REPO#N) next, which may be left out in a repo.
    pub repo: bool,
}

const fn c(name: &'static str, group: &'static str, about: Words, forms: &'static [(&'static str, Words)], next: &'static [&'static str], repo: bool) -> Command {
    Command { name, group, about, forms, next, repo }
}

pub const COMMANDS: &[Command] = &[
    c("server", "Server", ["people you know: boards, each a plan and its talk", "知り合いの集まり: 板ごとに計画と話"], &[
        ("l3 server", ["each server you are in, and its boards", "入っているサーバーと、その板"]),
        ("l3 server get SERVER[/BOARD] [--plan]", ["take boards home as text, here (the plan only with --plan)", "板をテキストでここに置く（--plan で計画だけ）"]),
        ("l3 server post SERVER/BOARD \"text\"", ["write in a board", "板に書く"]),
    ], &["get", "post"], false),
    c("todo", "Home", ["Home's TODO", "Home の TODO"], &[
        ("l3 todo", ["the list", "一覧"]),
        ("l3 todo add \"Fix：title\" [-m detail]", ["add one", "足す"]),
        ("l3 todo done N", ["mark the Nth done (again to undo)", "N 番目を完了に（もう一度で戻す）"]),
    ], &["add", "done"], false),
    c("profile", "Home", ["your name, handle and bio", "名前、ハンドル、自己紹介"], &[
        ("l3 profile", ["as others see it", "人から見えるとおりに"]),
        ("l3 profile name|handle|bio \"text\"", ["change one", "ひとつ変える"]),
    ], &["name", "handle", "bio"], false),
    c("lang", "Home", ["the language l3 and the app speak", "l3 とアプリが話す言語"], &[
        ("l3 lang [en|ja]", ["show it, or choose", "見る、または選ぶ"]),
    ], &["en", "ja"], false),
    c("repo", "Forge", ["repos here and on the Remote", "この端末と Remote の repo"], &[
        ("l3 repo", ["each, and where it stands", "それぞれと、その状態"]),
        ("l3 repo new NAME [-t standard|c|empty]", ["make one", "作る"]),
        ("l3 repo open NAME", ["bring one from the Remote", "Remote から持ってくる"]),
    ], &["new", "open"], false),
    c("band", "Forge", ["the repos out on Forge's band", "Forge の帯に出ている repo"], &[
        ("l3 band", ["the list", "一覧"]),
        ("l3 band add|rm REPO", ["put one out, or take it in", "出す、しまう"]),
    ], &["add", "rm"], false),
    c("prompt", "Forge", ["a shell in the repo, inside the root", "root の中で repo のシェル"], &[
        ("l3 prompt [REPO] [-- CMD…]", ["the repo inside the root (no privileges)", "root の中で repo を開く（権限なし）"]),
        ("    --network", ["give it the network (off by default)", "ネットワークを渡す（既定ではなし）"]),
    ], &[], true),
    c("file", "File", ["a directory's entries, or a file's text", "ディレクトリの中身、ファイルの本文"], &[
        ("l3 file [REPO[/PATH]]", ["read (in a repo, PATH is from where you are)", "読む（repo の中では今いる所から）"]),
        ("l3 file write REPO/PATH", ["replace a file with standard input", "標準入力でファイルを置き換える"]),
    ], &["write"], true),
    c("git", "Git", ["the issues not merged, and what comes next", "Merge されていない Issue と、次にすること"], &[
        ("l3 git [REPO]", ["each issue, with what comes next", "Issue ごとに、次にすること"]),
    ], &[], true),
    c("issue", "Git", ["one issue, or a new one", "Issue ひとつ、または新しく"], &[
        ("l3 issue REPO#N", ["its card, its Review, Merge", "カード、Review、Merge"]),
        ("l3 issue new [REPO] \"Fix：title\" [-m detail]", ["write a new one", "新しく書く"]),
    ], &["new"], true),
    c("start", "Git", ["work on an issue, in its own copy", "Issue の作業を、その写しで"], &[
        ("l3 start REPO#N", ["start (or continue): the repo shows its copy", "始める（続ける）。repo はその写しになる"]),
    ], &[], true),
    c("main", "Git", ["back to main", "main に戻る"], &[
        ("l3 main [REPO]", ["the repo shows main again", "repo は main に戻る"]),
    ], &[], true),
    c("commit", "Git", ["commit the work", "作業を Commit"], &[
        ("l3 commit [REPO] [-m note]", ["named after its issue", "Issue の名前で"]),
        ("l3 commit [REPO] \"Fix：title\"", ["on main, named by the line", "main で、行の名前で"]),
    ], &[], true),
    c("push", "Git", ["hand the work to main as its change", "作業を Change として main に渡す"], &[
        ("l3 push [REPO] [-m note]", ["again: its next version", "もう一度で次の版"]),
    ], &[], true),
    c("reset", "Git", ["take the change back", "Change を取り下げる"], &[
        ("l3 reset [REPO]", ["", ""]),
    ], &[], true),
    c("diff", "Git", ["the lines changed", "変えた行"], &[
        ("l3 diff [REPO]", ["what is not committed", "Commit していないもの"]),
        ("l3 diff REPO#N", ["the issue's change", "Issue の Change"]),
    ], &[], true),
    c("log", "Git", ["the commits", "コミット"], &[
        ("l3 log [REPO]", ["of what the repo shows", "repo がいま見せているものの"]),
    ], &[], true),
    c("review", "Git", ["approve a version, or ask for changes", "版を承認する、直しを頼む"], &[
        ("l3 review REPO#N approve|changes [-m note]", ["", ""]),
    ], &[], true),
    c("reply", "Git", ["a comment in its Review", "Review にコメント"], &[
        ("l3 reply REPO#N \"text\"", ["", ""]),
    ], &[], true),
    c("merge", "Git", ["main takes the change", "main に取り込む"], &[
        ("l3 merge REPO#N", ["once approved", "承認のあと"]),
    ], &[], true),
    c("reject", "Git", ["main does not take it", "取り込まない"], &[
        ("l3 reject REPO#N [-m why]", ["its issue stays open", "Issue は開いたまま"]),
    ], &[], true),
    c("runtime", "Runtime", ["the root, and this device by size", "root と、この端末の容量"], &[
        ("l3 runtime", ["what is here, and what can go", "あるものと、空けられるもの"]),
    ], &[], false),
    c("free", "Runtime", ["give room back", "容量を空ける"], &[
        ("l3 free ID… | all", ["a repo's changes go to the Remote first", "repo の変更は先に Remote へ"]),
    ], &["all"], false),
    c("root", "Runtime", ["the root Prompts run on", "Prompt が動く root"], &[
        ("l3 root", ["each held, and which is in use", "持っているものと、使っているもの"]),
        ("l3 root fetch", ["the newest release", "最新のリリースを取る"]),
        ("l3 root install BUNDLE", ["from a file", "ファイルから"]),
    ], &["fetch", "install"], false),
    c("ssh", "Runtime", ["whether SSH may reach each address", "アドレスごとに SSH でつないでよいか"], &[
        ("l3 ssh", ["each address", "アドレスごとに"]),
        ("l3 ssh on|off ADDRESS", ["", ""]),
    ], &["on", "off"], false),
    c("dotfiles", "Runtime", ["what every Prompt starts with in /root", "どの Prompt も /root に置いて始まるもの"], &[
        ("l3 dotfiles", ["the list", "一覧"]),
        ("l3 dotfile NAME", ["one's text", "ひとつの本文"]),
        ("l3 dotfile write NAME", ["replace (or make) it with standard input", "標準入力で置き換える（なければ作る）"]),
        ("l3 dotfile rm NAME", ["", ""]),
    ], &[], false),
    c("remote", "Remote", ["the Remote, and where each repo stands", "Remote と、各 repo の状態"], &[
        ("l3 remote", ["", ""]),
        ("l3 remote on REPO", ["bring back a repo turned off", "切った repo を戻す"]),
        ("l3 remote sign-in", ["passkeys, the code to turn a repo off, the providers", "パスキー、repo を切るコード、プロバイダー"]),
        ("l3 remote devices [rm N]", ["each device signed in; remove one", "サインインしている端末。外す"]),
    ], &["on", "sign-in", "devices"], false),
    c("login", "Remote", ["connect this device (approve in the browser)", "この端末をつなぐ（ブラウザで承認）"], &[
        ("l3 login [URL]", ["", ""]),
    ], &[], false),
    c("logout", "Remote", ["disconnect this device", "この端末を外す"], &[
        ("l3 logout", ["", ""]),
    ], &[], false),
    c("inbox", "Inbox", ["conversations: contacts, then requests", "会話（連絡先、次にリクエスト）"], &[
        ("l3 inbox", ["each conversation", "会話ごとに"]),
        ("l3 inbox ADDRESS", ["one (name@domain)", "ひとつ（name@domain）"]),
        ("l3 inbox send ADDRESS \"text\"", ["Review： or Question： first to ask; a /root/… path says what about", "頭に Review： か Question： で依頼。/root/… で対象"]),
        ("l3 inbox accept|block ADDRESS", ["", ""]),
    ], &["send", "accept", "block"], false),
    c("address", "Inbox", ["your addresses", "あなたのアドレス"], &[
        ("l3 address", ["each", "一覧"]),
        ("l3 address claim NAME[@DOMAIN]", ["", ""]),
        ("l3 address domain DOMAIN", ["the DNS record that proves it is yours", "あなたのものだと示す DNS レコード"]),
    ], &["claim", "domain"], false),
];

/// Words l3 knows that are not on the rail.
const OTHER: &[&str] = &["help", "completion", "version", "dotfile"];

fn say(w: Words) -> &'static str {
    if ja() { w[1] } else { w[0] }
}

pub fn find(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name || (name == "dotfile" && c.name == "dotfiles"))
}

/// Bold, where the output is a terminal that wants it.
fn bold(s: &str) -> String {
    if std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() { format!("\x1b[1m{s}\x1b[0m") } else { s.to_string() }
}

fn groups() -> Vec<&'static str> {
    let mut g: Vec<&str> = Vec::new();
    for c in COMMANDS { if !g.contains(&c.group) { g.push(c.group); } }
    g
}

/// `l3 help`: each command in a line, by the rail.
pub fn overview() -> String {
    let mut s = String::new();
    s += if ja() { "l3 — Length³ OS をコマンドで。アプリと同じ言葉と順番です。\n\n" } else { "l3 — Length³ OS on the command line, in the app's words and order.\n\n" };
    s += &format!("{}  l3 <command> [args] [--json]   {}\n", bold(if ja() { "使い方" } else { "Usage" }),
        if ja() { "（l3 だけで、この端末のいま）" } else { "(l3 alone: this device at a glance)" });
    for g in groups() {
        s += &format!("\n{}\n", bold(g));
        for c in COMMANDS.iter().filter(|c| c.group == g) { s += &format!("  {:<10} {}\n", c.name, say(c.about)); }
    }
    s += &format!("\n{}\n", bold(if ja() { "フラグ" } else { "Flags" }));
    for (f, w) in [("--json", ["JSON instead of text", "文の代わりに JSON"]), ("-h, --help", ["a command's forms (l3 help COMMAND)", "コマンドの書き方（l3 help COMMAND）"]), ("-V, --version", ["l3's version, and the root's", "l3 と root の版"])] {
        s += &format!("  {f:<14} {}\n", say(w));
    }
    s += "\n";
    s += if ja() {
        "repo の中（とその Prompt）では REPO を省けます。#N はその repo の Issue N です。\n`l3 help all` ですべての書き方、`l3 completion bash|zsh|fish` で補完。"
    } else {
        "In a repo (or its Prompt) REPO may be left out, and #N is that repo's issue N.\n`l3 help all` lists every form; `l3 completion bash|zsh|fish` completes them."
    };
    s
}

/// How many columns `s` takes in a terminal (CJK and full-width forms take two).
fn width(s: &str) -> usize {
    s.chars().map(|c| if matches!(c as u32, 0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6) { 2 } else { 1 }).sum()
}

fn forms(c: &Command) -> String {
    let mut s = String::new();
    let cols = c.forms.iter().map(|(f, _)| width(f)).max().unwrap_or(0).min(44);
    for (f, w) in c.forms {
        let what = say(*w);
        if what.is_empty() { s += &format!("  {f}\n"); } else { s += &format!("  {f}{}  {what}\n", " ".repeat(cols.saturating_sub(width(f)))); }
    }
    s
}

/// `l3 help COMMAND`: what it does, and each way to write it.
pub fn command(c: &Command) -> String {
    format!("{} — {}\n\n{}", bold(&format!("l3 {}", c.name)), say(c.about), forms(c).trim_end())
}

/// `l3 help all`: every form, by the rail.
pub fn all() -> String {
    let mut s = String::new();
    for g in groups() {
        s += &format!("{}\n", bold(g));
        for c in COMMANDS.iter().filter(|c| c.group == g) { s += &forms(c); }
    }
    s.trim_end().to_string()
}

/// How far apart two words are: edits, a swap of two letters side by side
/// counting as one (optimal string alignment).
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() { row[0] = i; }
    for j in 0..=b.len() { d[0][j] = j; }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] { d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1); }
        }
    }
    d[a.len()][b.len()]
}

/// The known word nearest `word`, if it is near enough to be what was meant.
pub fn nearest<'a>(word: &str, among: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    among.into_iter().map(|w| (distance(word, w), w)).filter(|(d, w)| *d <= (w.len() / 3).max(1)).min_by_key(|(d, _)| *d).map(|(_, w)| w)
}

/// What to say when the words are not a command.
pub fn not_a_command(words: &[&str]) -> String {
    let all = || COMMANDS.iter().map(|c| c.name).chain(OTHER.iter().copied());
    let first = words.first().copied().unwrap_or("");
    if let Some(c) = find(first) {
        // A command, but not one of its forms: a mistyped next word, or the wrong count.
        let hint = words.get(1).and_then(|w| nearest(w, c.next.iter().copied())).filter(|w| Some(w) != words.get(1))
            .map(|w| if ja() { format!("もしかして: l3 {} {w}\n", c.name) } else { format!("Did you mean: l3 {} {w}\n", c.name) }).unwrap_or_default();
        return if ja() { format!("l3 {} の書き方ではありません\n{hint}\n{}", words.join(" "), forms(c).trim_end()) } else { format!("Not how l3 {} is written\n{hint}\n{}", words.join(" "), forms(c).trim_end()) };
    }
    match nearest(first, all()) {
        Some(w) => if ja() { format!("わからないコマンドです: l3 {first}\nもしかして: l3 {w}") } else { format!("Not a command: l3 {first}\nDid you mean: l3 {w}") },
        None => if ja() { format!("わからないコマンドです: l3 {first}\n`l3 help` でコマンドの一覧を見られます") } else { format!("Not a command: l3 {first}\n`l3 help` lists the commands") },
    }
}

/// A completion script for `shell`, made from the table: commands, then
/// what may follow each, and repo names (`l3 complete repos`) where a repo goes.
pub fn completion(shell: &str) -> Result<String, String> {
    let names: Vec<&str> = COMMANDS.iter().map(|c| c.name).chain(OTHER.iter().copied()).collect();
    let repos: Vec<&str> = COMMANDS.iter().filter(|c| c.repo).map(|c| c.name).collect();
    match shell {
        "bash" | "zsh" => {
            let mut cases = String::new();
            for c in COMMANDS.iter().filter(|c| !c.next.is_empty()) { cases += &format!("    {}) w=\"{}\" ;;\n", c.name, c.next.join(" ")); }
            cases += "    help) w=\"all $(printf '%s ' $cmds)\" ;;\n    completion) w=\"bash zsh fish\" ;;\n";
            let head = if shell == "zsh" { "autoload -U +X bashcompinit && bashcompinit\n" } else { "" };
            Ok(format!("# l3 completion ({shell}): eval \"$(l3 completion {shell})\"\n{head}_l3() {{
  local cur=${{COMP_WORDS[COMP_CWORD]}} cmd=${{COMP_WORDS[1]}} w=\"\"
  local cmds=\"{}\"
  if [ \"$COMP_CWORD\" -eq 1 ]; then COMPREPLY=($(compgen -W \"$cmds\" -- \"$cur\")); return; fi
  case $cmd in
{cases}  esac
  case \" {} \" in *\" $cmd \"*) w=\"$w $(l3 complete repos 2>/dev/null)\" ;; esac
  COMPREPLY=($(compgen -W \"$w\" -- \"$cur\"))
}}
complete -F _l3 l3\n", names.join(" "), repos.join(" ")))
        }
        "fish" => {
            let mut s = String::from("# l3 completion (fish): l3 completion fish | source\ncomplete -c l3 -f\n");
            for c in COMMANDS { s += &format!("complete -c l3 -n __fish_use_subcommand -a {} -d '{}'\n", c.name, say(c.about).replace('\'', "\\'")); }
            for w in OTHER { s += &format!("complete -c l3 -n __fish_use_subcommand -a {w}\n"); }
            for c in COMMANDS.iter().filter(|c| !c.next.is_empty()) { s += &format!("complete -c l3 -n '__fish_seen_subcommand_from {}' -a '{}'\n", c.name, c.next.join(" ")); }
            s += &format!("complete -c l3 -n '__fish_seen_subcommand_from {}' -a '(l3 complete repos 2>/dev/null)'\n", repos.join(" "));
            s += "complete -c l3 -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'\n";
            Ok(s)
        }
        _ => Err(if ja() { "l3 completion bash|zsh|fish".into() } else { "l3 completion bash|zsh|fish".into() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mistyped_word_finds_what_was_meant() {
        let all = || COMMANDS.iter().map(|c| c.name);
        assert_eq!(nearest("comit", all()), Some("commit"));
        assert_eq!(nearest("rpeo", all()), Some("repo"));
        assert_eq!(nearest("xyzzy", all()), None);
        assert_eq!(nearest("nwe", ["new", "open"]), Some("new"));
        assert_eq!(distance("rpeo", "repo"), 1);
        assert_eq!(width("Fix：t"), 6);
    }

    #[test]
    fn every_command_says_what_it_does_and_how() {
        for c in COMMANDS {
            assert!(!c.about[0].is_empty() && !c.about[1].is_empty(), "{}", c.name);
            assert!(c.forms.iter().all(|(f, _)| f.starts_with("l3 ") || f.starts_with("    -")), "{}", c.name);
        }
        for shell in ["bash", "zsh", "fish"] { assert!(completion(shell).unwrap().contains("commit")); }
    }
}
