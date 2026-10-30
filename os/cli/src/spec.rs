//! l3's commands as one table. Parsing (args.rs), what each form runs, the
//! help (help.rs), shell completion (completion.rs), what may run inside the
//! app's Prompt and what is kept in step with the Remote around it all read
//! this, so none of them can drift from the others. Its order is the app's
//! rail: Home, Forge (and its Prompt), File, Git, Runtime, Remote; then the
//! two whose subject is people, Server and Inbox; then l3's own words.

use crate::cmd::{address, app, file, forge, git, home, people, remote, runtime, Ctx};
use crate::{args::Call, help, out::{Reply, Result}};

/// Words in English and in Japanese.
pub type Words = [&'static str; 2];

/// The words for the language spoken.
pub fn say(w: Words) -> &'static str {
    if length3_core::i18n::ja() { w[1] } else { w[0] }
}

/// Each command's purpose: the rail's places, then l3's own words. New is
/// the rail's round + (a new repo): it starts something rather than opening
/// a place, so no command is its own, only a deed offered there.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group { Home, Forge, File, Git, Runtime, Remote, Server, Inbox, Other, New }

impl Group {
    pub const ALL: [Group; 9] = [Group::Home, Group::Forge, Group::File, Group::Git, Group::Runtime, Group::Remote, Group::Server, Group::Inbox, Group::Other];
    /// The rail, top to bottom, as the menu shows it (purposes.ts RAIL).
    pub const RAIL: [Group; 9] = [Group::Home, Group::Forge, Group::File, Group::Git, Group::Runtime, Group::Remote, Group::Server, Group::Inbox, Group::New];

    pub fn name(self) -> &'static str {
        match self {
            Group::Home => "Home", Group::Forge => "Forge", Group::File => "File", Group::Git => "Git", Group::Runtime => "Runtime",
            Group::Remote => "Remote", Group::Server => "Server", Group::Inbox => "Inbox", Group::Other => "l3", Group::New => "+",
        }
    }

    /// What the place is for, in one phrase: the rail's role line (purposes.ts, its Japanese the app's).
    pub fn role(self) -> Words {
        match self {
            Group::Home => ["Profile", "プロフィール"],
            Group::Forge => ["Your workshop", "自分の作業場"],
            // The app's File opens all of /; l3 reads the repos only (/root/REPO/PATH), so its line says that.
            Group::File => ["Files in your repos", "repo のファイル"],
            Group::Git => ["Issues and commits", "Issue とコミット"],
            Group::Runtime => ["This device and its environments", "この端末と環境"],
            Group::Remote => ["Where your repos are kept", "repo を置く場所"],
            Group::Server => ["People you know", "知り合い"],
            Group::Inbox => ["Messages to you", "自分に届くメッセージ"],
            Group::New => ["New repo", "新しい repo"],
            Group::Other => ["", ""],
        }
    }
}

// ---- What the menu offers (menu.rs) ----
//
// Bare `l3` on a terminal shows the rail; a purpose shows its page (the
// forms marked `page`), and under it the deeds of each thing on the page and
// of the page itself. A deed is a form of this table, given the words the
// thing it is pressed on supplies, asking for the rest in place; so every
// choice in the menu is a command l3 parses and runs, and says as it runs.

/// What holds of this device or of a thing on a page. Each is read where the
/// page is made (cmd/*), by the same reading that writes the page itself
/// (an issue's from the facts its card's "next:" line is written from).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fact {
    // This device.
    SignedIn, SignedOut, NoRoot,
    // A TODO item.
    Done, NotDone,
    // A repo here: on Forge's band or not; a Prompt of it running.
    OnBand, OffBand, Running,
    // A repo on the Remote: turned off; only there.
    TurnedOff, OnlyThere,
    // An issue (git.rs `facts`).
    CanStart, CanCommit, CanPush, Undecided, Approved, WorkedHere, OnWork, Closed, Merged,
    // A conversation: someone who wrote first, not accepted yet.
    Request,
    // Something on this device by size that can go; anything on the page that can.
    Freeable, AnyFreeable,
    // A folder, not a file (File).
    Folder,
}

/// What a deed is pressed on: a thing on the page (its word fills the slot
/// that takes it), or the page itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum On { Page, Todo, Repo, Issue, RemoteRepo, Path, Thing, Board, Thread }

/// Where a deed sits among a thing's deeds (DESIGN.md §3, "Where a deed
/// sits"): what the thing is for first, then the rest, then what goes
/// against it or leaves it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Weight { Own, Also, Away }

/// A deed the menu offers: a button's word, what it is pressed on, when it is
/// offered, the words it gives the form itself and what it asks for.
#[derive(Clone, Copy, Debug)]
pub struct Deed {
    /// The button's word (the app's, where the app has the button).
    pub label: Words,
    pub on: On,
    /// Offered when each of these holds of the thing (or of the device)…
    pub when: &'static [Fact],
    /// …and none of these.
    pub unless: &'static [Fact],
    /// Words it gives slots itself (slot, word): `review ISSUE approve`.
    pub gives: &'static [(usize, &'static str)],
    /// Flags it asks for too: a note (-m, may be left empty), a template (-t, chosen).
    pub asks: &'static [Flag],
    /// The words over its one written field, where the slot's own do not say it ("Name").
    pub field: Option<Words>,
    pub weight: Weight,
    /// Asked in place first, as the app asks in the card: it cannot be undone at once.
    pub confirm: bool,
    /// Purposes it is offered on besides its command's own.
    pub also: &'static [Group],
    /// What its written field starts with, from the thing it is pressed on (its word): a TODO's line to fix in place.
    pub prefill: Option<Prefill>,
}

/// What a field starts with, given the word of the thing a deed is pressed on.
pub type Prefill = fn(Option<&str>) -> Option<String>;

impl Deed {
    pub const fn when(self, when: &'static [Fact]) -> Deed { Deed { when, ..self } }
    pub const fn unless(self, unless: &'static [Fact]) -> Deed { Deed { unless, ..self } }
    pub const fn gives(self, gives: &'static [(usize, &'static str)]) -> Deed { Deed { gives, ..self } }
    pub const fn asks(self, asks: &'static [Flag]) -> Deed { Deed { asks, ..self } }
    pub const fn field(self, w: Words) -> Deed { Deed { field: Some(w), ..self } }
    pub const fn also(self, also: &'static [Group]) -> Deed { Deed { also, ..self } }
    pub const fn second(self) -> Deed { Deed { weight: Weight::Also, ..self } }
    pub const fn away(self) -> Deed { Deed { weight: Weight::Away, ..self } }
    pub const fn confirm(self) -> Deed { Deed { confirm: true, ..self } }
    pub const fn prefill(self, f: Prefill) -> Deed { Deed { prefill: Some(f), ..self } }
}

/// A deed pressed on `on`, offered always, asking only for what its slots need.
const fn d(label: Words, on: On) -> Deed {
    Deed { label, on, when: &[], unless: &[], gives: &[], asks: &[], field: None, weight: Weight::Own, confirm: false, also: &[], prefill: None }
}

/// The words over a field the menu asks to be written, and under it what goes in it.
pub fn field_words(a: Arg) -> (Words, Words) {
    match a {
        Arg::Text("\"Fix：title\"") => (["First line", "1行目"], ["Kind：title, as Fix：The title wraps on a phone", "種別：件名。例：Fix：スマホでタイトルが折り返す"]),
        Arg::Text("NAME") => (["Name", "名前"], ["Letters, digits and . _ -, up to 64 characters", "英数字と . _ - 、64文字まで"]),
        Arg::Text("\"text\"") => (["Text", "本文"], ["", ""]),
        Arg::Address => (["To", "宛先"], ["A name on your Remote (ren), or name@domain", "Remote の名前（ren）か name@domain"]),
        Arg::Path { .. } => (["Path", "パス"], ["REPO/PATH, as File shows it", "REPO/PATH（File の見せ方で）"]),
        Arg::Repo { .. } => (["Repo", "repo"], ["", ""]),
        Arg::Issue => (["Issue", "Issue"], ["", ""]),
        Arg::Number(_) => (["Number", "番号"], ["", ""]),
        Arg::Dotfile => (["Dotfile", "dotfile"], ["", ""]),
        _ => (["", ""], ["", ""]),
    }
}

/// The words over a flag the menu asks for.
pub fn flag_words(f: Flag) -> Words {
    match f {
        Flag::Note("detail") => ["Detail (may be left empty)", "詳細（なくてもよい）"],
        Flag::Note("why") => ["Why (may be left empty)", "理由（なくてもよい）"],
        Flag::Note(_) => ["Note (may be left empty)", "メモ（なくてもよい）"],
        Flag::Template => ["Template", "テンプレート"],
        _ => ["", ""],
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
    /// --force: write over what is there
    Force,
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
    /// Part of its purpose's page: what picking the purpose in the menu prints.
    pub page: bool,
    /// What the menu offers that this form does.
    pub deeds: &'static [Deed],
}

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub group: Group,
    pub about: Words,
    pub forms: &'static [Form],
    pub hidden: bool,
    /// Home's settings it reads or writes that are kept on the Remote
    /// (home::SYNCED): taken in before it runs (sync.rs), sent after.
    pub home: &'static [&'static str],
}

const LOCAL: Needs = Needs { remote: false, in_prompt: true };
const DEVICE: Needs = Needs { remote: false, in_prompt: false };
const REMOTE: Needs = Needs { remote: true, in_prompt: false };

const fn f(verb: Option<&'static str>, args: &'static [Arg], flags: &'static [Flag], about: Words, needs: Needs, sync: Sync, run: Run) -> Form {
    Form { verb, args, flags, about, needs, sync, run, hidden: false, page: false, deeds: &[] }
}
const fn hidden(verb: Option<&'static str>, args: &'static [Arg], needs: Needs, sync: Sync, run: Run) -> Form {
    Form { verb, args, flags: &[], about: ["", ""], needs, sync, run, hidden: true, page: false, deeds: &[] }
}
/// A form that is (part of) its purpose's page in the menu.
const fn page(f: Form) -> Form {
    Form { page: true, ..f }
}
/// A form the menu offers as these deeds.
const fn offer(deeds: &'static [Deed], f: Form) -> Form {
    Form { deeds, ..f }
}
const fn c(name: &'static str, aliases: &'static [&'static str], group: Group, about: Words, forms: &'static [Form]) -> Command {
    Command { name, aliases, group, about, forms, hidden: false, home: &[] }
}
/// A command that reads or writes `home`, Home's settings on the Remote.
const fn on_home(home: &'static [&'static str], c: Command) -> Command {
    Command { home, ..c }
}

const REPO: Arg = Arg::Repo { optional: false };
const REPO_HERE: Arg = Arg::Repo { optional: true };
const PATH: Arg = Arg::Path { optional: false };
const PATH_HERE: Arg = Arg::Path { optional: true };
const TITLE: Arg = Arg::Text("\"Fix：title\"");
const SAID: Arg = Arg::Text("\"text\"");
use self::Sync::{None as Keep, Send, TakeIn};
use self::Fact as F;

pub static COMMANDS: &[Command] = &[
    on_home(&["todo"], c("todo", &[], Group::Home, ["Home's TODO", "Home の TODO"], &[
        page(f(None, &[], &[], ["the list", "一覧"], DEVICE, Send, home::todo_list)),
        hidden(Some("ls"), &[], DEVICE, Send, home::todo_list),
        offer(&[d(["Add a TODO", "TODO を足す"], On::Page)],
            f(Some("add"), &[TITLE], &[Flag::Note("detail")], ["add one", "足す"], DEVICE, Send, home::todo_add)),
        offer(&[d(["Edit", "書き直す"], On::Todo).prefill(home::todo_line).second()],
            f(Some("edit"), &[Arg::Number("N"), TITLE], &[Flag::Note("detail")], ["rewrite the Nth (its detail stays unless given)", "N 番目を書き直す（詳細は書かなければそのまま）"], DEVICE, Send, home::todo_edit)),
        offer(&[d(["Done", "完了"], On::Todo).when(&[F::NotDone]), d(["Not done", "未完了に戻す"], On::Todo).when(&[F::Done]).second()],
            f(Some("done"), &[Arg::Number("N")], &[], ["mark the Nth done (again to undo)", "N 番目を完了に（もう一度で戻す）"], DEVICE, Send, home::todo_done)),
        offer(&[d(["Remove", "消す"], On::Todo).away()],
            f(Some("rm"), &[Arg::Number("N")], &[], ["remove the Nth", "N 番目を消す"], DEVICE, Send, home::todo_rm)),
    ])),
    on_home(&["profile"], c("profile", &[], Group::Home, ["your name, handle and bio", "名前、ハンドル、自己紹介"], &[
        page(f(None, &[], &[], ["as others see it", "人から見えるとおりに"], DEVICE, Send, home::profile_show)),
        offer(&[d(["Edit name", "名前を変える"], On::Page).gives(&[(0, "name")]).field(["Name", "名前"]).prefill(|_| home::profile_now("name")).second(),
                d(["Edit handle", "ハンドルを変える"], On::Page).gives(&[(0, "handle")]).field(["Handle", "ハンドル"]).prefill(|_| home::profile_now("handle")).second(),
                d(["Edit bio", "自己紹介を変える"], On::Page).gives(&[(0, "bio")]).field(["Bio", "自己紹介"]).prefill(|_| home::profile_now("bio")).second()],
            f(None, &[Arg::Choice(&["name", "handle", "bio"]), SAID], &[], ["change one", "ひとつ変える"], DEVICE, Send, home::profile_set)),
    ])),
    c("lang", &[], Group::Home, ["the language l3 and the app speak", "l3 とアプリが話す言語"], &[
        f(None, &[], &[], ["the one spoken now", "いま話している言語"], DEVICE, Send, home::lang_show),
        f(None, &[Arg::Choice(&["en", "ja"])], &[], ["choose", "選ぶ"], DEVICE, Send, home::lang_set),
    ]),
    c("repo", &[], Group::Forge, ["repos here and on the Remote", "この端末と Remote の repo"], &[
        f(None, &[], &[], ["each, and where it stands", "それぞれと、その状態"], LOCAL, TakeIn, forge::repo_list),
        hidden(Some("ls"), &[], LOCAL, TakeIn, forge::repo_list),
        // The one scaffold, as the app makes it: nothing to choose (-t says another, typed).
        offer(&[d(["New repo", "新しい repo"], On::Page).also(&[Group::New])],
            f(Some("new"), &[Arg::Text("NAME")], &[Flag::Template], ["make one", "作る"], DEVICE, Send, forge::repo_new)),
        offer(&[d(["Open here", "この端末に開く"], On::RemoteRepo).when(&[F::OnlyThere]).also(&[Group::File, Group::Remote])],
            f(Some("open"), &[Arg::Text("NAME")], &[], ["bring one from the Remote", "Remote から持ってくる"], REMOTE, Keep, forge::repo_open)),
        // Rename and Delete, as the repo's gear has them in the app.
        f(Some("mv"), &[REPO, Arg::Text("NEW")], &[], ["rename one the Remote does not have yet", "Remote にまだない repo の名前を変える"], DEVICE, Send, forge::repo_mv),
        f(Some("rm"), &[REPO], &[], ["delete one from this device, with all in it", "repo を中身ごとこの端末から消す"], DEVICE, Keep, forge::repo_rm),
    ]),
    c("band", &[], Group::Forge, ["the repos out on Forge's band", "Forge の帯に出ている repo"], &[
        page(f(None, &[], &[], ["the list", "一覧"], DEVICE, Send, forge::band_list)),
        offer(&[d(["Put on the band", "帯に出す"], On::Repo).gives(&[(0, "add")]).when(&[F::OffBand]).second(),
                d(["Take off the band", "帯から外す"], On::Repo).gives(&[(0, "rm")]).when(&[F::OnBand]).away()],
            f(None, &[Arg::Choice(&["add", "rm"]), REPO], &[], ["put one out, or take it in", "出す、しまう"], DEVICE, Send, forge::band_set)),
    ]),
    on_home(&["dotfiles"], c("prompt", &[], Group::Forge, ["a shell in the repo, inside the root", "root の中で repo のシェル"], &[
        offer(&[d(["Prompt", "Prompt"], On::Repo).unless(&[F::NoRoot])],
            f(None, &[REPO_HERE, Arg::Argv], &[Flag::Network], ["the repo inside the root, without privileges; --network gives it the network", "root の中で repo を開く（権限なし）。--network でネットワークを渡す"], DEVICE, TakeIn, forge::prompt)),
        f(Some("ls"), &[], &[], ["the Prompts running or being prepared on this device (the app's too)", "この端末で動いている・用意中の Prompt（アプリのものも）"], DEVICE, Keep, forge::prompt_list),
        offer(&[d(["Stop", "止める"], On::Repo).when(&[F::Running]).away()],
            f(Some("stop"), &[REPO_HERE], &[], ["stop the repo's Prompts: every process in them ends", "repo の Prompt を止める（中のプロセスはすべて終わる）"], DEVICE, Send, forge::prompt_stop)),
    ])),
    c("file", &[], Group::File, ["a folder's entries, a file's text", "フォルダーの中身、ファイルの本文"], &[
        f(Some("write"), &[PATH], &[Flag::Empty], ["replace or make a file with standard input", "標準入力でファイルを置き換える・作る"], LOCAL, Send, file::write),
        offer(&[d(["New folder", "フォルダーを作る"], On::Page).second()],
            f(Some("mkdir"), &[PATH], &[], ["make a folder", "フォルダーを作る"], LOCAL, Send, file::mkdir)),
        offer(&[d(["Delete", "消す"], On::Path).away().confirm()],
            f(Some("rm"), &[PATH], &[], ["delete a file, or a folder and all in it", "ファイル、またはフォルダーを中身ごと消す"], LOCAL, Send, file::rm)),
        page(offer(&[d(["Open", "開く"], On::Repo), d(["Open", "開く"], On::Path)],
            f(None, &[PATH_HERE], &[], ["read (in a repo, PATH is from where you are)", "読む（repo の中では今いる所から）"], LOCAL, TakeIn, file::read))),
    ]),
    c("git", &[], Group::Git, ["the issues not merged, and what comes next", "Merge されていない Issue と、次にすること"], &[
        page(f(None, &[REPO_HERE], &[], ["each issue, with what comes next", "Issue ごとに、次にすること"], LOCAL, TakeIn, git::page)),
    ]),
    c("issue", &[], Group::Git, ["one issue, a new one, or closing one", "Issue ひとつ、新しく、または閉じる"], &[
        offer(&[d(["Write an issue", "Issue を書く"], On::Page)],
            f(Some("new"), &[REPO_HERE, TITLE], &[Flag::Note("detail")], ["write a new one", "新しく書く"], LOCAL, Send, git::issue_new)),
        offer(&[d(["Close", "閉じる"], On::Issue).unless(&[F::Undecided, F::OnWork, F::Closed, F::Merged]).away()],
            f(Some("close"), &[Arg::Issue], &[], ["one that will not be done", "やらないものを閉じる"], LOCAL, Send, git::issue_close)),
        offer(&[d(["Reopen", "もう一度開く"], On::Issue).when(&[F::Closed])],
            f(Some("reopen"), &[Arg::Issue], &[], ["a closed one, open again", "閉じたものをもう一度開く"], LOCAL, Send, git::issue_reopen)),
        offer(&[d(["Open", "開く"], On::Issue).second()],
            f(None, &[Arg::Issue], &[], ["its card, its Review, Merge", "カード、Review、Merge"], LOCAL, TakeIn, git::issue_show)),
        hidden(None, &[REPO_HERE], LOCAL, TakeIn, git::page),
    ]),
    c("start", &[], Group::Git, ["work on an issue, in its own copy", "Issue の作業を、その写しで"], &[
        offer(&[d(["Start", "始める"], On::Issue).when(&[F::CanStart])],
            f(None, &[Arg::Issue], &[], ["start (or continue): the repo shows its copy", "始める（続ける）。repo はその写しになる"], REMOTE, TakeIn, git::start)),
    ]),
    c("main", &[], Group::Git, ["back to main", "main に戻る"], &[
        offer(&[d(["Back to main", "main に戻る"], On::Issue).when(&[F::WorkedHere]).away()],
            f(None, &[REPO_HERE], &[], ["the repo shows main again", "repo は main に戻る"], DEVICE, Send, git::main)),
    ]),
    c("commit", &[], Group::Git, ["commit the work", "作業を Commit"], &[
        offer(&[d(["Commit", "Commit"], On::Issue).when(&[F::CanCommit])],
            f(None, &[REPO_HERE], &[Flag::Note("note")], ["on an issue, named after it", "Issue の作業では、その名前で"], REMOTE, Send, git::commit)),
        f(None, &[REPO_HERE, TITLE], &[Flag::Note("note")], ["with its subject, Kind：subject (on an issue, the words are its note)", "Commit の件名（種別：件名）で（Issue の作業では、メモに）"], REMOTE, Send, git::commit),
    ]),
    c("push", &[], Group::Git, ["hand the work to main as its change", "作業を Change として main に渡す"], &[
        offer(&[d(["Push", "Push"], On::Issue).when(&[F::CanPush])],
            f(None, &[REPO_HERE], &[Flag::Note("note")], ["again: its next version", "もう一度で次の版"], REMOTE, Send, git::push)),
    ]),
    c("reset", &[], Group::Git, ["take the change back", "Change を取り下げる"], &[
        offer(&[d(["Reset", "Reset"], On::Issue).when(&[F::WorkedHere, F::Undecided]).away().confirm()],
            f(None, &[REPO_HERE], &[], ["the one the work handed in", "作業が渡したもの"], REMOTE, Send, git::reset)),
    ]),
    c("diff", &[], Group::Git, ["the lines changed", "変えた行"], &[
        offer(&[d(["Diff", "Diff"], On::Issue).when(&[F::Undecided]).second()],
            f(None, &[Arg::Issue], &[], ["the issue's change", "Issue の Change"], REMOTE, Send, git::diff)),
        offer(&[d(["Diff", "Diff"], On::Issue).when(&[F::CanCommit]).unless(&[F::Undecided]).second()],
            f(None, &[REPO_HERE], &[], ["what is not committed", "Commit していないもの"], REMOTE, TakeIn, git::diff)),
    ]),
    c("log", &[], Group::Git, ["the commits", "コミット"], &[
        offer(&[d(["Log", "ログ"], On::Page).second()],
            f(None, &[REPO_HERE], &[], ["of what the repo shows", "repo がいま見せているものの"], REMOTE, TakeIn, git::log)),
    ]),
    c("review", &[], Group::Git, ["approve a version, or ask for changes", "版を承認する、直しを頼む"], &[
        offer(&[d(["Approve", "承認"], On::Issue).gives(&[(1, "approve")]).when(&[F::Undecided]).unless(&[F::Approved]),
                d(["Ask for changes", "直しを頼む"], On::Issue).gives(&[(1, "changes")]).asks(&[Flag::Note("note")]).when(&[F::Undecided]).second()],
            f(None, &[Arg::Issue, Arg::Choice(&["approve", "changes"])], &[Flag::Note("note")], ["of its current version", "いまの版について"], REMOTE, Send, git::review)),
    ]),
    c("reply", &[], Group::Git, ["a comment in its Review", "Review にコメント"], &[
        offer(&[d(["Reply", "返信する"], On::Issue).when(&[F::Undecided]).second()],
            f(None, &[Arg::Issue, SAID], &[], ["under its current version", "いまの版に"], REMOTE, Send, git::reply)),
    ]),
    c("merge", &[], Group::Git, ["main takes the change", "main に取り込む"], &[
        offer(&[d(["Merge", "Merge"], On::Issue).when(&[F::Undecided])],
            f(None, &[Arg::Issue], &[], ["its current version", "いまの版を"], REMOTE, Send, git::merge)),
    ]),
    c("reject", &[], Group::Git, ["main does not take it", "取り込まない"], &[
        offer(&[d(["Reject", "Reject"], On::Issue).asks(&[Flag::Note("why")]).when(&[F::Undecided]).away()],
            f(None, &[Arg::Issue], &[Flag::Note("why")], ["its issue stays open", "Issue は開いたまま"], REMOTE, Send, git::reject)),
    ]),
    c("runtime", &[], Group::Runtime, ["the root, and this device by size", "root と、この端末の容量"], &[
        page(f(None, &[], &[], ["what is here, and what can go", "あるものと、空けられるもの"], DEVICE, Send, runtime::page)),
    ]),
    c("free", &[], Group::Runtime, ["give room back", "容量を空ける"], &[
        offer(&[d(["Free all", "すべて空ける"], On::Page).gives(&[(0, "all")]).when(&[F::AnyFreeable]).second().confirm()],
            f(None, &[Arg::Choice(&["all"])], &[], ["everything that can go", "空けられるものすべて"], DEVICE, Keep, runtime::free)),
        offer(&[d(["Free", "空ける"], On::Thing).when(&[F::Freeable]).confirm()],
            f(None, &[Arg::Many("ID")], &[], ["what l3 runtime names; a repo's changes go to the Remote first", "l3 runtime が示すもの。repo の変更は先に Remote へ"], DEVICE, Keep, runtime::free)),
        hidden(None, &[], DEVICE, Send, runtime::page),
    ]),
    c("root", &[], Group::Runtime, ["the root Prompts run on", "Prompt が動く root"], &[
        f(None, &[], &[], ["each held, and which is in use", "持っているものと、使っているもの"], DEVICE, Send, runtime::roots),
        offer(&[d(["Fetch the root", "root を取ってくる"], On::Page).when(&[F::NoRoot])],
            f(Some("fetch"), &[], &[], ["the newest release", "最新のリリースを取る"], DEVICE, Send, runtime::root_fetch)),
        offer(&[d(["Use a root", "root を選ぶ"], On::Page).second()],
            f(Some("use"), &[Arg::Choice(&["l3", "ubuntu", "debian"])], &[], ["the one Prompts run on (fetched if not held); .packages and .setup set it up", "Prompt が動くもの（なければ取る）。.packages と .setup で用意"], DEVICE, Send, runtime::root_use)),
        f(Some("install"), &[Arg::Text("BUNDLE")], &[], ["from a file", "ファイルから"], DEVICE, Send, runtime::root_install),
    ]),
    c("network", &[], Group::Runtime, ["whether a repo's Prompts may reach the network (on this device)", "repo の Prompt がネットワークに届いてよいか（この端末で）"], &[
        f(None, &[], &[], ["the repos given it", "渡している repo"], DEVICE, Send, runtime::network_list),
        f(None, &[Arg::Choice(&["on", "off"]), REPO], &[], ["give it (from the next Prompt), or take it (its Prompts stop)", "渡す（次の Prompt から）、取り上げる（その Prompt は止まる）"], DEVICE, Send, runtime::network_set),
    ]),
    on_home(&["dotfiles"], c("dotfile", &["dotfiles"], Group::Runtime, ["what every Prompt starts with in /root", "どの Prompt も /root に置いて始まるもの"], &[
        f(Some("write"), &[Arg::Dotfile], &[Flag::Empty], ["replace (or make) it with standard input", "標準入力で置き換える（なければ作る）"], DEVICE, Send, runtime::dotfile_write),
        f(Some("rm"), &[Arg::Dotfile], &[], ["remove it", "消す"], DEVICE, Send, runtime::dotfile_rm),
        f(Some("take"), &[], &[], ["run here too what changed on another device (until then it runs nowhere here)", "別の端末で変わったものを、ここでも動かす（それまでここでは動かない）"], DEVICE, Keep, runtime::dotfile_take),
        f(Some("take"), &[Arg::Dotfile], &[], ["that one only", "それだけ"], DEVICE, Keep, runtime::dotfile_take),
        f(None, &[], &[], ["the list (what changed on another device says so)", "一覧（別の端末で変わったものはそう書く）"], DEVICE, Send, runtime::dotfile_list),
        f(None, &[Arg::Dotfile], &[], ["one's text", "ひとつの本文"], DEVICE, Send, runtime::dotfile_show),
    ])),
    c("address", &[], Group::Runtime, ["where to reach this device over SSH, as `ip addr` gives an IP", "この端末に SSH で届く先（ip addr が IP を答えるように）"], &[
        f(None, &[], &[], ["each repo's destination for ssh, one a line, and who may connect (off: asks whether to turn it on, and from where)", "repo ごとの ssh の接続先を1行にひとつと、どこから接続できるか（オフならオンにするか、どこからかを聞く）"], DEVICE, Keep, address::show),
        f(Some("ssh"), &[Arg::Choice(&["on", "off"])], &[], ["turn SSH on or off here without asking (on: from where it was last chosen; at first this device only)", "聞かずに、この端末の SSH をオン・オフ（オンは前に選んだ範囲で。最初はこの端末からだけ）"], DEVICE, Keep, address::set),
        f(Some("ssh"), &[Arg::Choice(&["on"]), Arg::Choice(&["device", "network"])], &[], ["on, from this device only, or from PCs on the same network too (never the Internet)", "オン：この端末からだけ、または同じネットワークの PC からも（インターネットからは入れない）"], DEVICE, Keep, address::set),
        hidden(Some("ssh"), &[Arg::Choice(&["serve"])], DEVICE, Keep, address::serve),
    ]),
    // The desktop app: the same OS in a window, opened from here (the one open brought forward, never a second).
    c("app", &[], Group::Runtime, ["the desktop app: the same OS in a window", "デスクトップアプリ：同じ OS をウィンドウで"], &[
        offer(&[d(["Open the app", "アプリを開く"], On::Page).second()],
            f(None, &[], &[], ["open it, or bring forward the one open (not on this device: where to get it)", "開く。開いていれば前に出す（この端末になければ入手先を出す）"], DEVICE, Keep, app::open)),
        f(Some("close"), &[], &[], ["close it, as its window's close button does (what l3 runs goes on)", "ウィンドウの閉じるボタンと同じに閉じる（l3 が動かしているものはそのまま）"], DEVICE, Keep, app::close),
    ]),
    c("remote", &[], Group::Remote, ["the Remote, and where each repo stands", "Remote と、各 repo の状態"], &[
        page(f(None, &[], &[], ["each repo, and where it stands", "各 repo とその状態"], DEVICE, Keep, remote::page)),
        offer(&[d(["Turn on", "戻す"], On::RemoteRepo).when(&[F::TurnedOff])],
            f(Some("on"), &[Arg::Text("REPO")], &[], ["bring back a repo turned off", "オフにした repo を戻す"], REMOTE, Keep, remote::on)),
        offer(&[d(["Sign-in", "サインイン方法"], On::Page).second()],
            f(Some("sign-in"), &[], &[], ["passkeys, the code to turn a repo off, the providers", "パスキー、repo をオフにするコード、サインイン方法"], REMOTE, Keep, remote::sign_in)),
        offer(&[d(["Devices", "端末"], On::Page).second()],
            f(Some("devices"), &[], &[], ["each device signed in", "サインインしている端末"], REMOTE, Keep, remote::devices)),
        f(Some("devices"), &[Arg::Choice(&["rm"]), Arg::Number("N")], &[], ["sign one out", "ひとつサインアウトさせる"], REMOTE, Keep, remote::devices_rm),
        offer(&[d(["Plan", "プラン"], On::Page).second()],
            f(Some("plan"), &[], &[], ["the tier you are on, what the Remote keeps against it, and the tiers", "いまのプラン、Remote に置いている量とその枠、プランの種類"], REMOTE, Keep, remote::plan)),
        f(Some("plan"), &[Arg::Choice(&["subscribe", "manage"])], &[], ["the page to subscribe on (the least tier), or to manage or cancel on", "登録するページ（いちばん小さいプラン）、管理・解約するページ"], REMOTE, Keep, remote::plan_page),
        f(Some("plan"), &[Arg::Choice(&["subscribe", "switch"]), Arg::Choice(&["go", "pro", "max"])], &[], ["the page to subscribe to a tier on, or to change to it on", "そのプランに登録するページ、そのプランに変えるページ"], REMOTE, Keep, remote::plan_page),
    ]),
    c("login", &[], Group::Remote, ["sign this device in (approved in the browser)", "この端末でサインインする（ブラウザで承認）"], &[
        offer(&[d(["Sign in", "サインイン"], On::Page).when(&[F::SignedOut]).also(&[Group::Git, Group::Server, Group::Inbox])],
            f(None, &[], &[], ["to the Remote this OS ships with ($LENGTH3_REMOTE)", "この OS の Remote へ（$LENGTH3_REMOTE）"], DEVICE, Keep, remote::login)),
        f(None, &[Arg::Text("URL")], &[], ["to another Remote", "別の Remote へ"], DEVICE, Keep, remote::login),
    ]),
    c("logout", &[], Group::Remote, ["sign this device out", "この端末をサインアウトする"], &[
        offer(&[d(["Sign out", "サインアウト"], On::Page).when(&[F::SignedIn]).away().confirm()],
            f(None, &[], &[], ["every repo is sent first; the repos stay here", "先に各 repo を送る。repo はこの端末に残る"], DEVICE, Keep, remote::logout)),
    ]),
    c("server", &[], Group::Server, ["people you know: boards, each a talk and a TODO kept together", "知り合いの集まり：板ごとに話とみんなの TODO"], &[
        page(f(None, &[], &[], ["each server you are in, and its boards", "入っているサーバーと、その板"], REMOTE, Send, people::servers)),
        offer(&[d(["Read", "読む"], On::Board).second()],
            f(Some("get"), &[Arg::Text("SERVER[#BOARD]")], &[Flag::Todo, Flag::Out, Flag::Force], ["boards as text (--todo: the TODO only; -o: into a file, or a folder; --force: over what is there)", "板をテキストで（--todo で TODO だけ、-o でファイルかフォルダーへ、--force で上書き）"], REMOTE, Send, people::server_get)),
        offer(&[d(["Write", "書く"], On::Board)],
            f(Some("post"), &[Arg::Text("SERVER#BOARD"), SAID], &[], ["write in a board", "板に書く"], REMOTE, Send, people::server_post)),
    ]),
    c("inbox", &[], Group::Inbox, ["conversations: contacts, then requests", "会話（連絡先、次にリクエスト）"], &[
        offer(&[d(["Write", "書く"], On::Thread).second(), d(["Write to someone", "誰かに書く"], On::Page)],
            f(Some("send"), &[Arg::Address, SAID], &[], ["Review： or Question： first to ask; a /root/… path says what about", "頭に Review： か Question： で依頼。/root/… で対象"], REMOTE, Send, people::inbox_send)),
        offer(&[d(["Accept", "受ける"], On::Thread).gives(&[(0, "accept")]).when(&[F::Request]),
                d(["Block", "ブロック"], On::Thread).gives(&[(0, "block")]).when(&[F::Request]).away().confirm()],
            f(None, &[Arg::Choice(&["accept", "block"]), Arg::Address], &[], ["someone who wrote first", "先に書いてきた人を"], REMOTE, Send, people::inbox_decide)),
        page(f(None, &[], &[], ["each conversation", "会話ごとに"], REMOTE, Send, people::inbox_list)),
        offer(&[d(["Open", "開く"], On::Thread)],
            f(None, &[Arg::Address], &[], ["one", "ひとつ"], REMOTE, Send, people::inbox_thread)),
    ]),
    c("name", &[], Group::Inbox, ["your names, as people find you (name@domain), and your code", "あなたの名前（人があなたを見つける name@domain）と、あなたのコード"], &[
        f(None, &[], &[], ["each name, one a line, nothing else", "名前を1行にひとつ、それだけ"], REMOTE, Send, people::name_only),
        f(Some("ls"), &[], &[], ["each, and your code", "それぞれと、あなたのコード"], REMOTE, Send, people::names),
        hidden(Some("list"), &[], REMOTE, Send, people::names),
        f(Some("set"), &[Arg::Text("NAME")], &[], ["change your username (given at your first sign-in): the one before is held for you 30 days", "ユーザー名を変える（最初のサインインで付いた名前。前の名前は30日取り置き）"], REMOTE, Send, people::name_set),
        f(Some("claim"), &[Arg::Text("NAME[@DOMAIN]")], &[], ["another name, here or on your domain, beside your username", "ユーザー名とは別の名前を、ここか自分のドメインで"], REMOTE, Send, people::name_claim),
        f(Some("release"), &[Arg::Address], &[], ["let another name go: held for you 30 days, claim it again to take it back", "別の名前を手放す（30日はあなたのために取り置き、取り直せば戻る）"], REMOTE, Send, people::name_release),
        f(Some("domain"), &[Arg::Text("DOMAIN")], &[], ["the DNS record that proves it is yours", "あなたのものだと示す DNS レコード"], REMOTE, Send, people::name_domain),
    ]),
    c("help", &[], Group::Other, ["how to use l3", "l3 の使い方"], &[
        f(None, &[], &[], ["each command", "コマンドの一覧"], LOCAL, Keep, help::run),
        f(None, &[Arg::Text("COMMAND|all")], &[], ["a command's forms, or every form", "コマンドの書き方、またはすべての書き方"], LOCAL, Keep, help::run),
    ]),
    c("next", &[], Group::Other, ["the last command's next deeds, chosen with the keys", "直前のコマンドの次を、キーで選ぶ"], &[
        f(None, &[], &[], ["at a terminal", "端末で"], LOCAL, Keep, crate::cmd::next),
    ]),
    c("version", &[], Group::Other, ["l3's version, and the root's", "l3 と root の版"], &[
        f(None, &[], &[], ["", ""], LOCAL, Keep, crate::cmd::version),
    ]),
    c("completion", &[], Group::Other, ["shell completion", "シェルの補完"], &[
        f(None, &[Arg::Choice(&["bash", "zsh", "fish"])], &[], ["eval \"$(l3 completion bash)\"", "eval \"$(l3 completion bash)\""], LOCAL, Keep, crate::completion::script),
    ]),
    Command { name: "complete", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, home: &[], forms: &[
        hidden(None, &[Arg::Argv], LOCAL, Keep, crate::completion::complete),
    ] },
    Command { name: "sync", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, home: &[], forms: &[
        hidden(None, &[], LOCAL, Keep, remote::no_sync),
        hidden(None, &[Arg::Many("…")], LOCAL, Keep, remote::no_sync),
    ] },
    // `l3` alone: this device at a glance.
    Command { name: "", aliases: &[], group: Group::Other, about: ["", ""], hidden: true, home: &["todo"], forms: &[
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

/// What a word of a form stands for, in the language spoken: the words a
/// person writes are named in their language; REPO, N and the like are names
/// of slots, the same in both (as the help's own text writes them).
pub fn placeholder(w: &str) -> &str {
    if !length3_core::i18n::ja() { return w; }
    match w {
        "\"Fix：title\"" => "\"Fix：件名\"",
        "\"text\"" => "\"本文\"",
        "note" => "メモ",
        "detail" => "詳細",
        "why" => "理由",
        _ => w,
    }
}

/// A form as it is written: `l3 issue new [REPO] "Fix：title" [-m detail]`.
/// A form as a program reads it (`l3 help --json`): its verb, its words in order, each with its kind (the choices
/// of one that is one of a few words), its flags (with the value each takes), what it needs to run (the Remote; this
/// device; or nothing more, so it runs in a Prompt too) and how it keeps in step with the Remote. An agent reads the
/// table once and writes any command from it, as `usage` writes it for a person.
pub fn schema(f: &Form) -> serde_json::Value {
    use serde_json::json;
    let words: Vec<serde_json::Value> = f.args.iter().map(|a| match a {
        Arg::Repo { optional } => json!({"kind": "repo", "optional": optional}),
        Arg::Path { optional } => json!({"kind": "path", "optional": optional}),
        Arg::Issue => json!({"kind": "issue"}),
        Arg::Text(n) => json!({"kind": "text", "name": n.trim_matches('"')}),
        Arg::Number(n) => json!({"kind": "number", "name": n}),
        Arg::Choice(w) => json!({"kind": "choice", "choices": w}),
        Arg::Address => json!({"kind": "address"}),
        Arg::Dotfile => json!({"kind": "dotfile"}),
        Arg::Many(n) => json!({"kind": "many", "name": n}),
        Arg::Argv => json!({"kind": "argv", "optional": true}),
    }).collect();
    let flags: Vec<serde_json::Value> = f.flags.iter().map(|fl| match fl {
        Flag::Note(w) => json!({"flag": "-m", "value": w}),
        Flag::Template => json!({"flag": "-t", "value": "template", "choices": length3_core::templates::all().iter().map(|t| t.id.clone()).collect::<Vec<_>>()}),
        Flag::Network => json!({"flag": "--network"}),
        Flag::Todo => json!({"flag": "--todo"}),
        Flag::Empty => json!({"flag": "--empty"}),
        Flag::Out => json!({"flag": "-o", "value": "file"}),
        Flag::Force => json!({"flag": "--force"}),
    }).collect();
    let needs = if f.needs.remote { "remote" } else if f.needs.in_prompt { "anywhere" } else { "device" };
    let sync = match f.sync { Sync::None => "none", Sync::TakeIn => "take-in", Sync::Send => "send" };
    json!({"verb": f.verb, "words": words, "flags": flags, "needs": needs, "sync": sync})
}

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
            Arg::Text(n) | Arg::Number(n) => placeholder(n).to_string(),
            Arg::Choice(w) => w.join("|"),
            Arg::Address => "NAME".to_string(),
            Arg::Dotfile => "NAME".to_string(),
            Arg::Many(n) => format!("{n}…"),
            Arg::Argv => "[-- CMD…]".to_string(),
        };
    }
    for fl in f.flags {
        s += " ";
        s += &match fl {
            Flag::Note(w) => format!("[-m {}]", placeholder(w)),
            Flag::Template => format!("[-t {}]", length3_core::templates::all().iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join("|")),
            Flag::Network => "[--network]".to_string(),
            Flag::Todo => "[--todo]".to_string(),
            Flag::Empty => "[--empty]".to_string(),
            Flag::Out => "[-o FILE]".to_string(),
            Flag::Force => "[--force]".to_string(),
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
        let new = if length3_core::i18n::ja() { "l3 issue new [REPO] \"Fix：件名\" [-m 詳細]" } else { "l3 issue new [REPO] \"Fix：title\" [-m detail]" };
        assert!(all.iter().any(|u| u.starts_with(new)), "{all:?}");
        assert!(all.contains(&format!("l3 todo edit N {} [-m {}]", placeholder("\"Fix：title\""), placeholder("detail"))), "{all:?}");
        assert!(all.contains(&"l3 prompt ls".to_string()) && all.contains(&"l3 prompt stop [REPO]".to_string()));
        assert!(all.contains(&"l3 network on|off REPO".to_string()));
        // In Japanese, what a person writes is named in Japanese (bug: "Fix：title" and "-m note" stayed English).
        if length3_core::i18n::ja() {
            for english in ["title", "\"text\"", "-m note", "-m detail", "-m why"] { assert!(!all.iter().any(|u| u.contains(english)), "{english}: {all:?}"); }
        }
        assert!(all.contains(&"l3 server get SERVER[#BOARD] [--todo] [-o FILE] [--force]".to_string()));
        assert!(all.contains(&"l3 prompt [REPO] [-- CMD…] [--network]".to_string()));
        assert!(all.contains(&"l3 issue close ISSUE".to_string()) && all.contains(&"l3 issue reopen ISSUE".to_string()), "{all:?}");
        assert!(all.contains(&"l3 root use l3|ubuntu|debian".to_string()));
        // SSH is the device's (Runtime's), names are Inbox's: neither keeps the other's old forms.
        assert!(all.contains(&"l3 address".to_string()) && all.contains(&"l3 address ssh on|off".to_string()), "{all:?}");
        assert!(all.contains(&"l3 name claim NAME[@DOMAIN]".to_string()) && !all.iter().any(|u| u.starts_with("l3 address claim") || u.contains("ssh serve")), "{all:?}");
        assert_eq!(find("address").map(|c| c.group), Some(Group::Runtime));
        assert_eq!(find("name").map(|c| c.group), Some(Group::Inbox));
        // The app is opened and closed from here, as Runtime's: one way each.
        assert!(all.contains(&"l3 app".to_string()) && all.contains(&"l3 app close".to_string()), "{all:?}");
        assert_eq!(find("app").map(|c| c.group), Some(Group::Runtime));
    }

    /// A word that fits a slot, as the menu would give it.
    fn sample(a: Arg) -> Option<String> {
        Some(match a {
            Arg::Issue => "notes#1".into(), Arg::Repo { .. } => "notes".into(), Arg::Path { .. } => "notes/a.txt".into(),
            Arg::Text(_) => "Fix：x".into(), Arg::Number(_) => "1".into(), Arg::Choice(c) => c[0].into(), Arg::Address => "ren".into(),
            Arg::Dotfile => ".profile".into(), Arg::Many(_) => "notes".into(), Arg::Argv => return None,
        })
    }

    #[test]
    fn every_deed_the_menu_offers_is_a_form_l3_reads_back_as_itself() {
        let ctx = crate::cmd::Ctx::test(None, vec!["notes"]);
        let mut n = 0;
        for c in COMMANDS {
            for f in c.forms {
                for d in f.deeds {
                    let words: Vec<Option<String>> = f.args.iter().enumerate()
                        .map(|(i, a)| d.gives.iter().find(|(k, _)| *k == i).map(|(_, w)| w.to_string()).or_else(|| sample(*a))).collect();
                    let flags: Vec<(Flag, String)> = d.asks.iter().map(|fl| (*fl, if *fl == Flag::Template { "standard".into() } else { "why".into() })).collect();
                    let argv = crate::menu::command_line(c, f, &words, &flags);
                    let call = crate::args::parse(&argv, &ctx).unwrap_or_else(|e| panic!("{} ({argv:?}): {e:?}", d.label[0]));
                    assert!(std::ptr::eq(call.form, f), "{} ({argv:?}) is read as {}", d.label[0], usage(call.command, call.form));
                    // What it gives itself is one of the words its slot takes; what it is pressed on fills a slot.
                    for (k, w) in d.gives { assert!(matches!(f.args.get(*k), Some(Arg::Choice(c)) if c.contains(w)), "{}: {w}", d.label[0]); }
                    assert!(d.on == On::Page || f.args.iter().any(|a| crate::menu::takes(*a, d.on)), "{}: nothing takes a {:?}", d.label[0], d.on);
                    assert!(!d.label[0].is_empty() && !d.label[1].is_empty() && !f.hidden, "{}", c.name);
                    n += 1;
                }
            }
        }
        assert!(n > 30, "{n} deeds");
    }

    #[test]
    fn every_place_on_the_rail_has_a_page_and_plus_makes_a_repo() {
        for g in Group::RAIL.iter().filter(|g| **g != Group::New) {
            assert!(!crate::menu::page_forms(*g).is_empty(), "{}", g.name());
            assert!(!g.role()[0].is_empty() && !g.role()[1].is_empty());
        }
        let plus = crate::menu::deeds_of(Group::New);
        assert_eq!(plus.iter().map(|o| (o.command.name, o.form.verb)).collect::<Vec<_>>(), [("repo", Some("new"))]);
        // The help's groups stay as they were: + is the rail's alone.
        assert!(!Group::ALL.contains(&Group::New) && COMMANDS.iter().all(|c| c.group != Group::New));
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
    fn what_reads_homes_settings_takes_them_in_from_the_remote() {
        // Each names only settings the Remote keeps (the band, the language and the network grant are the device's).
        for c in COMMANDS { for k in c.home { assert!(length3_core::home::SYNCED.contains(k), "{}: {k}", c.name); } }
        for (name, key) in [("todo", "todo"), ("profile", "profile"), ("dotfile", "dotfiles"), ("prompt", "dotfiles"), ("", "todo")] {
            assert!(find(name).unwrap().home.contains(&key), "{name}");
        }
        for name in ["lang", "band", "network"] { assert!(find(name).unwrap().home.is_empty(), "{name}"); }
    }

    #[test]
    fn what_reaches_the_remote_or_the_device_is_kept_out_of_the_prompt() {
        for name in ["review", "reply", "network", "band", "profile", "lang", "dotfile", "todo", "remote", "login", "logout", "start", "commit", "push", "merge", "reject", "log", "diff", "server", "inbox", "address", "name", "runtime", "free", "root", "prompt", "app"] {
            let c = find(name).unwrap();
            assert!(c.forms.iter().all(|f| !f.needs.in_prompt), "{name}");
        }
        for name in ["file", "git", "help", "version"] { assert!(find(name).unwrap().forms.iter().all(|f| f.needs.in_prompt), "{name}"); }
    }
}
