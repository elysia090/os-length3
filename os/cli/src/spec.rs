//! l3's commands as one table. Parsing (args.rs), what each form runs, the
//! help (help.rs), shell completion (completion.rs), what may run inside the
//! app's Prompt and what is kept in step with the Remote around it all read
//! this, so none of them can drift from the others. Its order is the app's
//! rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote; then the
//! two whose subject is people, Server and Inbox; then l3's own words.

use crate::cmd::{file, forge, git, home, people, remote, runtime, Ctx};
use crate::{args::Call, help, out::{Reply, Result}};

/// Words in English and in Japanese.
pub type Words = [&'static str; 2];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group { Home, Forge, File, Git, Runtime, Remote, Server, Inbox, Other }

impl Group {
    pub const ALL: [Group; 9] = [Group::Home, Group::Forge, Group::File, Group::Git, Group::Runtime, Group::Remote, Group::Server, Group::Inbox, Group::Other];

    pub fn name(self) -> &'static str {
        match self {
            Group::Home => "Home", Group::Forge => "Forge", Group::File => "File", Group::Git => "Git", Group::Runtime => "Runtime",
            Group::Remote => "Remote", Group::Server => "Server", Group::Inbox => "Inbox", Group::Other => "l3",
        }
    }
}

/// What a word in a form stands for; how it is read, checked and completed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arg {
    /// A repo here (or `owner:repo`, one's own); optional: the repo you are in.
    Repo { optional: bool },
    /// REPO/PATH, or a path from where you are in a repo; optional: where you are.
    Path { optional: bool },
    /// An issue: #N in its repo, REPO#N, or words of its title.
    Issue,
    /// Words, taken as they are (never as a name).
    Text(&'static str),
    Number(&'static str),
    /// One of these words.
    Choice(&'static [&'static str]),
    /// name@domain, or a name on your own Remote.
    Address,
    /// A dotfile's name (.profile).
    Dotfile,
    /// One or more words.
    Many(&'static str),
    /// A command to run: the words after `--`.
    Argv,
}

/// A flag a form takes (--json every form takes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flag {
    /// -m TEXT, named for what the text is (a note, a detail, why).
    Note(&'static str),
    /// -t TEMPLATE
    Template,
    /// --network
    Network,
    /// --todo
    Todo,
    /// --empty: standard input may be empty
    Empty,
    /// -o FILE
    Out,
}

/// What a form needs: a Remote to talk to, and whether it may run inside the app's Prompt.
#[derive(Clone, Copy)]
pub struct Needs { pub remote: bool, pub in_prompt: bool }

/// How a form keeps the repos and the Remote in step: TakeIn takes in the
/// Remote's changes to the repo it reads first (or, naming none, sends what
/// changed so what it shows is current); both it and Send send every repo
/// that changed afterwards. None: the form keeps in step itself, or leaves it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sync { None, TakeIn, Send }

pub type Run = fn(&Ctx, &Call) -> Result<Reply>;

pub struct Form {
    /// The word after the command that names this form ("add"), if one does.
    pub verb: Option<&'static str>,
    pub args: &'static [Arg],
    pub flags: &'static [Flag],
    pub about: Words,
    pub needs: Needs,
    pub sync: Sync,
    pub run: Run,
    /// Kept for those used to it, not shown in help.
    pub hidden: bool,
}

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub group: Group,
    pub about: Words,
    pub forms: &'static [Form],
    pub hidden: bool,
}

const LOCAL: Needs = Needs { remote: false, in_prompt: true };
const DEVICE: Needs = Needs { remote: false, in_prompt: false };
const REMOTE: Needs = Needs { remote: true, in_prompt: false };

const fn f(verb: Option<&'static str>, args: &'static [Arg], flags: &'static [Flag], about: Words, needs: Needs, sync: Sync, run: Run) -> Form {
    Form { verb, args, flags, about, needs, sync, run, hidden: false }
}
const fn hidden(verb: Option<&'static str>, args: &'static [Arg], needs: Needs, sync: Sync, run: Run) -> Form {
    Form { verb, args, flags: &[], about: ["", ""], needs, sync, run, hidden: true }
}
const fn c(name: &'static str, aliases: &'static [&'static str], group: Group, about: Words, forms: &'static [Form]) -> Command {
    Command { name, aliases, group, about, forms, hidden: false }
}

const REPO: Arg = Arg::Repo { optional: false };
const REPO_HERE: Arg = Arg::Repo { optional: true };
const PATH: Arg = Arg::Path { optional: false };
const PATH_HERE: Arg = Arg::Path { optional: true };
const TITLE: Arg = Arg::Text("\"Fix：title\"");
const SAID: Arg = Arg::Text("\"text\"");
use self::Sync::{None as Keep, Send, TakeIn};

pub static COMMANDS: &[Command] = &[
    c("todo", &[], Group::Home, ["Home's TODO", "Home の TODO"], &[
        f(None, &[], &[], ["the list", "一覧"], DEVICE, Send, home::todo_list),
        hidden(Some("ls"), &[], DEVICE, Send, home::todo_list),
        f(Some("add"), &[TITLE], &[Flag::Note("detail")], ["add one", "足す"], DEVICE, Send, home::todo_add),
        f(Some("done"), &[Arg::Number("N")], &[], ["mark the Nth done (again to undo)", "N 番目を完了に（もう一度で戻す）"], DEVICE, Send, home::todo_done),
    ]),
    c("profile", &[], Group::Home, ["your name, handle and bio", "名前、ハンドル、自己紹介"], &[
        f(None, &[], &[], ["as others see it", "人から見えるとおりに"], DEVICE, Send, home::profile_show),
        f(None, &[Arg::Choice(&["name", "handle", "bio"]), SAID], &[], ["change one", "ひとつ変える"], DEVICE, Send, home::profile_set),
    ]),
    c("lang", &[], Group::Home, ["the language l3 and the app speak", "l3 とアプリが話す言語"], &[
        f(None, &[], &[], ["the one spoken now", "いま話している言語"], DEVICE, Send, home::lang_show),
        f(None, &[Arg::Choice(&["en", "ja"])], &[], ["choose", "選ぶ"], DEVICE, Send, home::lang_set),
    ]),
    c("repo", &[], Group::Forge, ["repos here and on the Remote", "この端末と Remote の repo"], &[
        f(None, &[], &[], ["each, and where it stands", "それぞれと、その状態"], LOCAL, TakeIn, forge::repo_list),
        hidden(Some("ls"), &[], LOCAL, TakeIn, forge::repo_list),
        f(Some("new"), &[Arg::Text("NAME")], &[Flag::Template], ["make one", "作る"], DEVICE, Send, forge::repo_new),
        f(Some("open"), &[Arg::Text("NAME")], &[], ["bring one from the Remote", "Remote から持ってくる"], REMOTE, Keep, forge::repo_open),
    ]),
    c("band", &[], Group::Forge, ["the repos out on Forge's band", "Forge の帯に出ている repo"], &[
        f(None, &[], &[], ["the list", "一覧"], DEVICE, Send, forge::band_list),
        f(None, &[Arg::Choice(&["add", "rm"]), REPO], &[], ["put one out, or take it in", "出す、しまう"], DEVICE, Send, forge::band_set),
    ]),
    c("prompt", &[], Group::Forge, ["a shell in the repo, inside the root", "root の中で repo のシェル"], &[
        f(None, &[REPO_HERE, Arg::Argv], &[Flag::Network], ["the repo inside the root, without privileges; --network gives it the network", "root の中で repo を開く（権限なし）。--network でネットワークを渡す"], DEVICE, TakeIn, forge::prompt),
    ]),
    c("file", &[], Group::File, ["a folder's entries, a file's text", "フォルダーの中身、ファイルの本文"], &[
        f(Some("write"), &[PATH], &[Flag::Empty], ["replace or make a file with standard input", "標準入力でファイルを置き換える・作る"], LOCAL, Send, file::write),
        f(Some("mkdir"), &[PATH], &[], ["make a folder", "フォルダーを作る"], LOCAL, Send, file::mkdir),
        f(Some("rm"), &[PATH], &[], ["remove a file, or a folder and all in it", "ファイル、またはフォルダーを中身ごと消す"], LOCAL, Send, file::rm),
        f(None, &[PATH_HERE], &[], ["read (in a repo, PATH is from where you are)", "読む（repo の中では今いる所から）"], LOCAL, TakeIn, file::read),
    ]),
    c("git", &[], Group::Git, ["the issues not merged, and what comes next", "Merge されていない Issue と、次にすること"], &[
        f(None, &[REPO_HERE], &[], ["each issue, with what comes next", "Issue ごとに、次にすること"], LOCAL, TakeIn, git::page),
    ]),
    c("issue", &[], Group::Git, ["one issue, or a new one", "Issue ひとつ、または新しく"], &[
        f(Some("new"), &[REPO_HERE, TITLE], &[Flag::Note("detail")], ["write a new one", "新しく書く"], LOCAL, Send, git::issue_new),
        f(None, &[Arg::Issue], &[], ["its card, its Review, Merge", "カード、Review、Merge"], LOCAL, TakeIn, git::issue_show),
        hidden(None, &[REPO_HERE], LOCAL, TakeIn, git::page),
    ]),
    c("start", &[], Group::Git, ["work on an issue, in its own copy", "Issue の作業を、その写しで"], &[
        f(None, &[Arg::Issue], &[], ["start (or continue): the repo shows its copy", "始める（続ける）。repo はその写しになる"], REMOTE, TakeIn, git::start),
    ]),
    c("main", &[], Group::Git, ["back to main", "main に戻る"], &[
        f(None, &[REPO_HERE], &[], ["the repo shows main again", "repo は main に戻る"], DEVICE, Send, git::main),
    ]),
    c("commit", &[], Group::Git, ["commit the work", "作業を Commit"], &[
        f(None, &[REPO_HERE], &[Flag::Note("note")], ["on an issue, named after it", "Issue の作業では、その名前で"], REMOTE, Send, git::commit),
        f(None, &[REPO_HERE, TITLE], &[Flag::Note("note")], ["named by its line (on an issue, the line is its note)", "行の名前で（Issue の作業では、行はメモに）"], REMOTE, Send, git::commit),
    ]),
    c("push", &[], Group::Git, ["hand the work to main as its change", "作業を Change として main に渡す"], &[
        f(None, &[REPO_HERE], &[Flag::Note("note")], ["again: its next version", "もう一度で次の版"], REMOTE, Send, git::push),
    ]),
    c("reset", &[], Group::Git, ["take the change back", "Change を取り下げる"], &[
        f(None, &[REPO_HERE], &[], ["the one the work handed in", "作業が渡したもの"], REMOTE, Send, git::reset),
    ]),
    c("diff", &[], Group::Git, ["the lines changed", "変えた行"], &[
        f(None, &[Arg::Issue], &[], ["the issue's change", "Issue の Change"], REMOTE, Send, git::diff),
        f(None, &[REPO_HERE], &[], ["what is not committed", "Commit していないもの"], REMOTE, TakeIn, git::diff),
    ]),
    c("log", &[], Group::Git, ["the commits", "コミット"], &[
        f(None, &[REPO_HERE], &[], ["of what the repo shows", "repo がいま見せているものの"], REMOTE, TakeIn, git::log),
    ]),
    c("review", &[], Group::Git, ["approve a version, or ask for changes", "版を承認する、直しを頼む"], &[
        f(None, &[Arg::Issue, Arg::Choice(&["approve", "changes"])], &[Flag::Note("note")], ["of its current version", "いまの版について"], REMOTE, Send, git::review),
    ]),
    c("reply", &[], Group::Git, ["a comment in its Review", "Review にコメント"], &[
        f(None, &[Arg::Issue, SAID], &[], ["under its current version", "いまの版に"], REMOTE, Send, git::reply),
    ]),
    c("merge", &[], Group::Git, ["main takes the change", "main に取り込む"], &[
        f(None, &[Arg::Issue], &[], ["its current version", "いまの版を"], REMOTE, Send, git::merge),
    ]),
    c("reject", &[], Group::Git, ["main does not take it", "取り込まない"], &[
        f(None, &[Arg::Issue], &[Flag::Note("why")], ["its issue stays open", "Issue は開いたまま"], REMOTE, Send, git::reject),
    ]),
    c("runtime", &[], Group::Runtime, ["the root, and this device by size", "root と、この端末の容量"], &[
        f(None, &[], &[], ["what is here, and what can go", "あるものと、空けられるもの"], DEVICE, Send, runtime::page),
    ]),
    c("free", &[], Group::Runtime, ["give room back", "容量を空ける"], &[
        f(None, &[Arg::Choice(&["all"])], &[], ["everything that can go", "空けられるものすべて"], DEVICE, Keep, runtime::free),
        f(None, &[Arg::Many("ID")], &[], ["what l3 runtime names; a repo's changes go to the Remote first", "l3 runtime が示すもの。repo の変更は先に Remote へ"], DEVICE, Keep, runtime::free),
        hidden(None, &[], DEVICE, Send, runtime::page),
    ]),
    c("root", &[], Group::Runtime, ["the root Prompts run on", "Prompt が動く root"], &[
        f(None, &[], &[], ["each held, and which is in use", "持っているものと、使っているもの"], DEVICE, Send, runtime::roots),
        f(Some("fetch"), &[], &[], ["the newest release", "最新のリリースを取る"], DEVICE, Send, runtime::root_fetch),
        f(Some("use"), &[Arg::Choice(&["l3", "ubuntu", "debian"])], &[], ["the one Prompts run on (fetched if not held); .packages and .setup set it up", "Prompt が動くもの（なければ取る）。.packages と .setup で用意"], DEVICE, Send, runtime::root_use),
        f(Some("install"), &[Arg::Text("BUNDLE")], &[], ["from a file", "ファイルから"], DEVICE, Send, runtime::root_install),
    ]),
    c("ssh", &[], Group::Runtime, ["whether SSH may reach each address", "アドレスごとに SSH でつないでよいか"], &[
        f(None, &[], &[], ["each address", "アドレスごとに"], REMOTE, Send, runtime::ssh_list),
        f(None, &[Arg::Choice(&["on", "off"]), Arg::Address], &[], ["allow it, or not", "許す、許さない"], REMOTE, Send, runtime::ssh_set),
    ]),
    c("dotfile", &["dotfiles"], Group::Runtime, ["what every Prompt starts with in /root", "どの Prompt も /root に置いて始まるもの"], &[
        f(Some("write"), &[Arg::Dotfile], &[Flag::Empty], ["replace (or make) it with standard input", "標準入力で置き換える（なければ作る）"], DEVICE, Send, runtime::dotfile_write),
        f(Some("rm"), &[Arg::Dotfile], &[], ["remove it", "消す"], DEVICE, Send, runtime::dotfile_rm),
        f(None, &[], &[], ["the list", "一覧"], DEVICE, Send, runtime::dotfile_list),
        f(None, &[Arg::Dotfile], &[], ["one's text", "ひとつの本文"], DEVICE, Send, runtime::dotfile_show),
    ]),
    c("remote", &[], Group::Remote, ["the Remote, and where each repo stands", "Remote と、各 repo の状態"], &[
        f(None, &[], &[], ["each repo brought into step", "各 repo を Remote とそろえて"], DEVICE, Keep, remote::page),
        f(Some("on"), &[Arg::Text("REPO")], &[], ["bring back a repo turned off", "切った repo を戻す"], REMOTE, Keep, remote::on),
        f(Some("sign-in"), &[], &[], ["passkeys, the code to turn a repo off, the providers", "パスキー、repo を切るコード、プロバイダー"], REMOTE, Keep, remote::sign_in),
        f(Some("devices"), &[], &[], ["each device signed in", "サインインしている端末"], REMOTE, Keep, remote::devices),
        f(Some("devices"), &[Arg::Choice(&["rm"]), Arg::Number("N")], &[], ["sign one out", "ひとつ外す"], REMOTE, Keep, remote::devices_rm),
    ]),
    c("login", &[], Group::Remote, ["connect this device (approve in the browser)", "この端末をつなぐ（ブラウザで承認）"], &[
        f(None, &[], &[], ["to the Remote this OS ships with ($LENGTH3_REMOTE)", "この OS の Remote へ（$LENGTH3_REMOTE）"], DEVICE, Keep, remote::login),
        f(None, &[Arg::Text("URL")], &[], ["to another Remote", "別の Remote へ"], DEVICE, Keep, remote::login),
    ]),
    c("logout", &[], Group::Remote, ["disconnect this device", "この端末を外す"], &[
        f(None, &[], &[], ["every repo is sent first; the repos stay here", "先に各 repo を送る。repo はこの端末に残る"], DEVICE, Keep, remote::logout),
    ]),
    c("server", &[], Group::Server, ["people you know: boards, each a talk and a TODO kept together", "知り合いの集まり：板ごとに話とみんなの TODO"], &[
        f(None, &[], &[], ["each server you are in, and its boards", "入っているサーバーと、その板"], REMOTE, Send, people::servers),
        f(Some("get"), &[Arg::Text("SERVER[#BOARD]")], &[Flag::Todo, Flag::Out], ["boards as text (--todo: the TODO only; -o: into a file, or a folder)", "板をテキストで（--todo で TODO だけ、-o でファイルかフォルダーへ）"], REMOTE, Send, people::server_get),
        f(Some("post"), &[Arg::Text("SERVER#BOARD"), SAID], &[], ["write in a board", "板に書く"], REMOTE, Send, people::server_post),
    ]),
    c("inbox", &[], Group::Inbox, ["conversations: contacts, then requests", "会話（連絡先、次にリクエスト）"], &[
        f(Some("send"), &[Arg::Address, SAID], &[], ["Review： or Question： first to ask; a /root/… path says what about", "頭に Review： か Question： で依頼。/root/… で対象"], REMOTE, Send, people::inbox_send),
        f(None, &[Arg::Choice(&["accept", "block"]), Arg::Address], &[], ["someone who wrote first", "先に書いてきた人を"], REMOTE, Send, people::inbox_decide),
        f(None, &[], &[], ["each conversation", "会話ごとに"], REMOTE, Send, people::inbox_list),
        f(None, &[Arg::Address], &[], ["one", "ひとつ"], REMOTE, Send, people::inbox_thread),
    ]),
    c("address", &[], Group::Inbox, ["your names, and your code", "あなたの名前とコード"], &[
        f(None, &[], &[], ["each, with its term, and your code", "それぞれと期限、あなたのコード"], REMOTE, Send, people::addresses),
        f(Some("claim"), &[Arg::Text("NAME[@DOMAIN]")], &[], ["a name here: first come, for five years; on your domain, beside it", "ここでの名前（早い者勝ち、5年）。自分のドメインなら並べて"], REMOTE, Send, people::address_claim),
        f(Some("renew"), &[Arg::Address], &[], ["five more years from now", "今から5年延ばす"], REMOTE, Send, people::address_renew),
        f(Some("release"), &[Arg::Address], &[], ["let it go: held for you 30 days, claim it again to take it back", "手放す（30日はあなたのために取り置き、取り直せば戻る）"], REMOTE, Send, people::address_release),
        f(Some("domain"), &[Arg::Text("DOMAIN")], &[], ["the DNS record that proves it is yours", "あなたのものだと示す DNS レコード"], REMOTE, Send, people::address_domain),
    ]),
    c("help", &[], Group::Other, ["how to use l3", "l3 の使い方"], &[
        f(None, &[], &[], ["each command", "コマンドの一覧"], LOCAL, Keep, help::run),
        f(None, &[Arg::Text("COMMAND|all")], &[], ["a command's forms, or every form", "コマンドの書き方、またはすべての書き方"], LOCAL, Keep, help::run),
    ]),
    c("version", &[], Group::Other, ["l3's version, and the root's", "l3 と root の版"], &[
        f(None, &[], &[], ["", ""], LOCAL, Keep, crate::cmd::version),
    ]),
    c("completion", &[], Group::Other, ["shell completion", "シェルの補完"], &[
        f(None, &[Arg::Choice(&["bash", "zsh", "fish"])], &[], ["eval \"$(l3 completion bash)\"", "eval \"$(l3 completion bash)\""], LOCAL, Keep, crate::completion::script),
    ]),
    Command { name: "complete", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, forms: &[
        hidden(None, &[Arg::Argv], LOCAL, Keep, crate::completion::complete),
    ] },
    Command { name: "sync", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, forms: &[
        hidden(None, &[], LOCAL, Keep, remote::no_sync),
        hidden(None, &[Arg::Many("…")], LOCAL, Keep, remote::no_sync),
    ] },
    // `l3` alone: this device at a glance.
    Command { name: "", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, forms: &[
        hidden(None, &[], LOCAL, TakeIn, crate::cmd::overview),
    ] },
];

/// A command by its name or an alias.
pub fn find(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name || c.aliases.contains(&name))
}

/// The commands help and completion show.
pub fn shown() -> impl Iterator<Item = &'static Command> {
    COMMANDS.iter().filter(|c| !c.hidden)
}

/// A form as it is written: `l3 issue new [REPO] "Fix：title" [-m detail]`.
pub fn usage(c: &Command, f: &Form) -> String {
    // `l3` alone has no name to follow it.
    let mut s = if c.name.is_empty() { "l3".to_string() } else { format!("l3 {}", c.name) };
    if let Some(v) = f.verb { s += &format!(" {v}"); }
    for a in f.args {
        s += " ";
        s += &match a {
            Arg::Repo { optional: true } => "[REPO]".to_string(),
            Arg::Repo { optional: false } => "REPO".to_string(),
            Arg::Path { optional: true } => "[REPO[/PATH]]".to_string(),
            Arg::Path { optional: false } => "REPO/PATH".to_string(),
            Arg::Issue => "ISSUE".to_string(),
            Arg::Text(n) | Arg::Number(n) => n.to_string(),
            Arg::Choice(w) => w.join("|"),
            Arg::Address => "ADDRESS".to_string(),
            Arg::Dotfile => "NAME".to_string(),
            Arg::Many(n) => format!("{n}…"),
            Arg::Argv => "[-- CMD…]".to_string(),
        };
    }
    for fl in f.flags {
        s += " ";
        s += &match fl {
            Flag::Note(w) => format!("[-m {w}]"),
            Flag::Template => format!("[-t {}]", length3_core::templates::all().iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join("|")),
            Flag::Network => "[--network]".to_string(),
            Flag::Todo => "[--todo]".to_string(),
            Flag::Empty => "[--empty]".to_string(),
            Flag::Out => "[-o FILE]".to_string(),
        };
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_says_what_it_does_and_how() {
        for c in shown() {
            assert!(!c.about[0].is_empty() && !c.about[1].is_empty(), "{}", c.name);
            assert!(c.forms.iter().any(|f| !f.hidden), "{}", c.name);
        }
        let all: Vec<String> = shown().flat_map(|c| c.forms.iter().filter(|f| !f.hidden).map(move |f| usage(c, f))).collect();
        assert!(all.iter().any(|u| u.starts_with("l3 issue new [REPO] \"Fix：title\" [-m detail]")), "{all:?}");
        assert!(all.contains(&"l3 prompt [REPO] [-- CMD…] [--network]".to_string()));
        assert!(all.contains(&"l3 root use l3|ubuntu|debian".to_string()));
    }

    #[test]
    fn names_and_aliases_are_each_one_commands() {
        let mut seen = std::collections::HashSet::new();
        for c in COMMANDS {
            for n in std::iter::once(&c.name).chain(c.aliases) { assert!(seen.insert(*n), "{n} twice"); }
        }
        assert_eq!(find("dotfiles").map(|c| c.name), Some("dotfile"));
    }

    #[test]
    fn what_reaches_the_remote_or_the_device_is_kept_out_of_the_prompt() {
        for name in ["review", "reply", "ssh", "band", "profile", "lang", "dotfile", "todo", "remote", "login", "logout", "start", "commit", "push", "merge", "reject", "log", "diff", "server", "inbox", "address", "runtime", "free", "root", "prompt"] {
            let c = find(name).unwrap();
            assert!(c.forms.iter().all(|f| !f.needs.in_prompt), "{name}");
        }
        for name in ["file", "git", "help", "version"] { assert!(find(name).unwrap().forms.iter().all(|f| f.needs.in_prompt), "{name}"); }
    }
}
