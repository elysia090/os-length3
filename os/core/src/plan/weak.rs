//! What is plainly weak in code: the things a careful engineer stops at on reading it. Each is a pattern in the
//! tokens (never in comments or strings, the lexer has set those apart), with what it costs and the usual way out;
//! each is checked here against code that has it and code that only looks like it. They are of eight kinds:
//!
//! - speed: work done again each time round a loop that could be done once (a regular expression built, a request
//!   made, a list searched from the start, a sort, a sleep while polling), a collection made only to be counted;
//! - memory: a file read whole only to go through it line by line, a cache filled and never emptied, a value cloned
//!   only to be lent;
//! - structure: a file or a folder grown past what one person holds in mind, a file of everything (utils), a file
//!   nothing builds or uses, names of one folder in several styles;
//! - comments: what a reader cannot work out alone without one (a long function's purpose, a long regular
//!   expression, why an `unsafe` block is sound, why a wait is that long);
//! - dead code: a function nothing calls, code left commented out, statements after a return;
//! - length: a function too long, too many parameters, the same line written again and again;
//! - care: an error caught and dropped, a program that stops on an unexpected value, `==` in JavaScript, floats
//!   compared exactly, type checks turned off, `forEach(async …)`, Python's shared default arguments and bare
//!   `except:`, the shell's unquoted variables, a TODO left, debugging left in, `defer` in a loop;
//! - security: a key or a private key written into the code.
//!
//! Loops are what a token sits in: a `for`/`while`/`loop`/`do` body, or the function given to `forEach`, `map`,
//! `filter`, `reduce`, `for_each` and their kin (each element is a time round). Test code is told apart (a test's
//! sleep is a slow test, not a slow program; a test's unwrap is how tests fail) by its file's name and folder, and in
//! Rust by `#[cfg(test)]` and `#[test]`.

#![forbid(unsafe_code)]

use super::lex::{Lang, Lexed, Tok, K};
use super::shape::{Func, TOP};
use serde::Serialize;

/// The kinds of weakness, each with its area, how much it matters (1 to 3), and its words.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    LoopRegex, LoopAwait, LoopRequest, LoopSearch, LoopSort, Poll, NeedlessCollect, CloneToLend, AllocToCompare, DeepCopy,
    ReadWhole, UnboundedCache,
    LongFile, CrowdedFolder, GrabBag, Unbuilt, Unused, MixedNames,
    UncommentedComplex, UncommentedRegex, UncommentedUnsafe, UnnamedWait,
    UnusedFunction, CommentedOut, Unreachable,
    LongFunction, ManyParams, Repetitive,
    Swallowed, Unwrap, LooseEquality, FloatEquality, TypeEscape, AsyncForEach, MutableDefault, BareExcept, Unquoted, Todo,
    DebugLeft, DeferInLoop, TestSleep,
    Secret,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Area { Speed, Memory, Structure, Comments, Dead, Length, Care, Security }

impl Kind {
    pub fn area(self) -> Area {
        use Kind::*;
        match self {
            LoopRegex | LoopAwait | LoopRequest | LoopSearch | LoopSort | Poll | NeedlessCollect | AllocToCompare | DeepCopy => Area::Speed,
            ReadWhole | UnboundedCache | CloneToLend => Area::Memory,
            LongFile | CrowdedFolder | GrabBag | Unbuilt | Unused | MixedNames => Area::Structure,
            UncommentedComplex | UncommentedRegex | UncommentedUnsafe | UnnamedWait => Area::Comments,
            UnusedFunction | CommentedOut | Unreachable => Area::Dead,
            LongFunction | ManyParams | Repetitive => Area::Length,
            Swallowed | Unwrap | LooseEquality | FloatEquality | TypeEscape | AsyncForEach | MutableDefault | BareExcept | Unquoted | Todo
            | DebugLeft | DeferInLoop | TestSleep => Area::Care,
            Secret => Area::Security,
        }
    }
    /// How much it matters: 3 a defect or a leak waiting, 2 a cost every run or every reader pays, 1 untidiness.
    pub fn weight(self) -> u32 {
        use Kind::*;
        match self {
            Secret | AsyncForEach | Swallowed | MutableDefault | Unreachable | LoopRequest | DeferInLoop | Unbuilt => 3,
            LoopRegex | LoopAwait | LoopSearch | LoopSort | Poll | UnboundedCache | LooseEquality | FloatEquality | BareExcept | Unquoted
            | UncommentedUnsafe | UnusedFunction | DebugLeft | ReadWhole | UncommentedComplex | TypeEscape | TestSleep | LongFunction => 2,
            _ => 1,
        }
    }
    pub fn all() -> &'static [Kind] {
        use Kind::*;
        &[LoopRegex, LoopAwait, LoopRequest, LoopSearch, LoopSort, Poll, NeedlessCollect, CloneToLend, AllocToCompare, DeepCopy,
          ReadWhole, UnboundedCache, LongFile, CrowdedFolder, GrabBag, Unbuilt, Unused, MixedNames,
          UncommentedComplex, UncommentedRegex, UncommentedUnsafe, UnnamedWait, UnusedFunction, CommentedOut, Unreachable,
          LongFunction, ManyParams, Repetitive, Swallowed, Unwrap, LooseEquality, FloatEquality, TypeEscape, AsyncForEach,
          MutableDefault, BareExcept, Unquoted, Todo, DebugLeft, DeferInLoop, TestSleep, Secret]
    }
    /// What it is, and the way out, in the language spoken.
    pub fn said(self) -> (String, String) {
        use crate::tr;
        use Kind::*;
        match self {
            LoopRegex => (tr!("builds a regular expression each time round a loop", "ループのたびに正規表現を作り直している"), tr!("build it once, before the loop", "ループの前で一度だけ作る")),
            LoopAwait => (tr!("waits for each time round a loop before starting the next", "ループの1回ごとに待ってから次を始めている"), tr!("start them together and wait once (Promise.all, join_all, gather) if each does not need the last", "前の結果が要らないなら、まとめて始めて一度だけ待つ（Promise.all、join_all、gather）")),
            LoopRequest => (tr!("makes a request or starts a process each time round a loop", "ループのたびにリクエストを送るかプロセスを起動している"), tr!("ask once for all of them", "まとめて一度で聞く")),
            LoopSearch => (tr!("searches a list from its start each time round a loop", "ループのたびにリストを頭から探している"), tr!("index it once in a Map/Set (HashMap/HashSet) and look up", "一度 Map/Set（HashMap/HashSet）に索引して引く")),
            LoopSort => (tr!("sorts each time round a loop", "ループのたびにソートしている"), tr!("sort once, outside it (or keep it sorted)", "ループの外で一度だけ（または整列を保つ）")),
            Poll => (tr!("sleeps in a loop, waiting for something to change", "ループの中で眠って変化を待っている"), tr!("be told when it changes (an event, a channel, a condition)", "変わったら知らせてもらう（イベント、チャネル、条件変数）")),
            NeedlessCollect => (tr!("collects into a list only to count or go through it", "数えるか回すだけのために一度リストに集めている"), tr!("count or iterate the iterator itself", "イテレーターのまま数える・回す")),
            CloneToLend => (tr!("clones a value only to lend it", "貸すだけの値を複製している"), tr!("lend the value itself (&x)", "そのまま貸す（&x）")),
            AllocToCompare => (tr!("makes a new string only to compare it", "比べるためだけに新しい文字列を作っている"), tr!("compare as it is (as_str, ==)", "そのまま比べる（as_str、==）")),
            DeepCopy => (tr!("deep-copies through JSON", "JSON を通して深く複製している"), tr!("structuredClone, or copy what is needed", "structuredClone、または要る分だけ写す")),
            ReadWhole => (tr!("reads a whole file into memory only to go through it line by line", "行ごとに見るだけなのに、ファイル全体をメモリに読んでいる"), tr!("read it a line at a time (BufReader::lines, readline, a stream)", "1行ずつ読む（BufReader::lines、readline、ストリーム）")),
            UnboundedCache => (tr!("fills a cache that nothing ever empties", "何も空けないキャッシュを満たし続けている"), tr!("bound it (LRU, a size or an age) or clear it", "上限を設ける（LRU、大きさか古さ）か空ける")),
            LongFile => (tr!("is longer than one person holds in mind", "一人が頭に収められる長さを超えている"), tr!("split it by what each part is for", "受け持ちごとに分ける")),
            CrowdedFolder => (tr!("holds more files than one looks through", "見渡せる数を超えるファイルが入っている"), tr!("group them into folders by what they are for", "受け持ちごとにフォルダーへ分ける")),
            GrabBag => (tr!("is a file of everything: its name says nothing of what is in it", "何でも入れのファイル：名前が中身を言っていない"), tr!("move each part beside what uses it, or name each file for what it does", "使う側の隣へ移すか、受け持ちを名前にしたファイルへ")),
            Unbuilt => (tr!("is never built: no `mod` names it", "ビルドされない：どの `mod` も指していない"), tr!("delete it, or add it where it belongs", "消すか、あるべき場所に加える")),
            Unused => (tr!("nothing imports it, and it is no entry point", "どこからも import されず、入口でもない"), tr!("delete it if nothing outside the repo uses it", "リポジトリの外で使われていなければ消す")),
            MixedNames => (tr!("names its files in several styles", "ファイル名の書き方が混ざっている"), tr!("name them one way", "一つの書き方にそろえる")),
            UncommentedComplex => (tr!("is hard to follow and says nowhere what it is for", "追いにくいのに、何のためかがどこにも書かれていない"), tr!("say in a comment what it is for and why it is shaped so", "何のためか、なぜこの形かをコメントで書く")),
            UncommentedRegex => (tr!("has a long regular expression no comment explains", "長い正規表現にコメントがない"), tr!("say what it matches, with an example", "何に合うかを例とともに書く")),
            UncommentedUnsafe => (tr!("has an unsafe block with no SAFETY comment", "unsafe ブロックに SAFETY コメントがない"), tr!("say why what it does is sound (// SAFETY: …)", "なぜ安全かを書く（// SAFETY: …）")),
            UnnamedWait => (tr!("waits a number of milliseconds nothing explains", "理由の書かれていない待ち時間がある"), tr!("name it (a constant) and say why that long", "定数に名前を付け、なぜその長さかを書く")),
            UnusedFunction => (tr!("is a function nothing in the repo calls or names", "リポジトリのどこからも呼ばれず、名前も出てこない関数"), tr!("delete it (git keeps it)", "消す（git が覚えている）")),
            CommentedOut => (tr!("has code left commented out", "コメントアウトされたコードが残っている"), tr!("delete it (git keeps it)", "消す（git が覚えている）")),
            Unreachable => (tr!("has statements after a return that never run", "return の後ろに決して実行されない文がある"), tr!("delete them, or move the return", "消すか、return を動かす")),
            LongFunction => (tr!("is a function too long to read at once", "一度に読めない長さの関数"), tr!("split it into steps with names", "名前のある手順に分ける")),
            ManyParams => (tr!("takes more parameters than a call can be read with", "呼び出しが読めないほど引数が多い"), tr!("pass one value that names them (a struct, an object)", "名前を持つ一つの値で渡す（構造体、オブジェクト）")),
            Repetitive => (tr!("writes the same line again and again", "同じ形の行を繰り返し書いている"), tr!("say it once: a table and a loop", "表とループで一度だけ書く")),
            Swallowed => (tr!("catches an error and drops it", "エラーを捕まえて捨てている"), tr!("handle it, pass it on, or say in the block why it can be ignored", "扱うか、上に渡すか、無視してよい理由をブロック内に書く")),
            Unwrap => (tr!("stops the program on a value it did not expect (unwrap/expect)", "想定外の値でプログラムを止める（unwrap/expect）"), tr!("return the error (?) with what was being done", "何をしていたかを添えてエラーを返す（?）")),
            LooseEquality => (tr!("compares with == (converting types first)", "== で比べている（型を変換してから比べる）"), tr!("===", "===")),
            FloatEquality => (tr!("compares floating-point numbers exactly", "浮動小数点数を完全一致で比べている"), tr!("compare within a tolerance", "許容差で比べる")),
            TypeEscape => (tr!("turns type checking off (any, @ts-ignore)", "型検査を切っている（any、@ts-ignore）"), tr!("give it its type", "型を与える")),
            AsyncForEach => (tr!("gives forEach an async function: nothing waits for it", "forEach に async 関数を渡している：誰も待っていない"), tr!("for … of with await, or Promise.all over map", "for … of と await、または map と Promise.all")),
            MutableDefault => (tr!("has a default argument every call shares ([] or {})", "全呼び出しで共有される既定引数（[] や {}）がある"), tr!("default to None and make a new one inside", "既定値は None にして中で作る")),
            BareExcept => (tr!("catches everything, Ctrl-C and exit too (except:)", "Ctrl-C や終了まで全部捕まえている（except:）"), tr!("catch what can happen (except ValueError:)", "起こりうるものだけ捕まえる（except ValueError:）")),
            Unquoted => (tr!("uses a variable unquoted: spaces split it, * expands", "変数を引用符なしで使っている：空白で割れ、* が展開される"), tr!("\"$var\"", "\"$var\"")),
            Todo => (tr!("has a TODO left", "TODO が残っている"), tr!("do it, or make it an issue", "片付けるか Issue にする")),
            DebugLeft => (tr!("has debugging left in (dbg!, debugger)", "デバッグ用のコードが残っている（dbg!、debugger）"), tr!("delete it", "消す")),
            DeferInLoop => (tr!("defers in a loop: nothing is released until the function returns", "ループ内で defer している：関数が返るまで何も解放されない"), tr!("release it in the loop, or move the body to a function", "ループ内で解放するか、本体を関数に出す")),
            TestSleep => (tr!("is a test that sleeps: slow, and flaky when the machine is slower", "眠るテスト：遅く、機械が遅いと不安定"), tr!("wait for the condition itself", "条件そのものを待つ")),
            Secret => (tr!("has a key written into it", "鍵が書き込まれている"), tr!("take it out, revoke it, and read it from the environment", "取り除いて失効させ、環境から読む")),
        }
    }
}

/// One weakness found: what, where (a file by index, a line, the function it is in), how many times there, and the
/// text it is about (a name, a pattern).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub kind: Kind,
    #[serde(skip)]
    pub file: usize,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub func: Option<String>,
    pub count: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub about: String,
}

/// Whether a path is test code by its name and folder.
pub fn test_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    path.split('/').any(|p| matches!(p, "test" | "tests" | "__tests__" | "spec" | "specs" | "testdata" | "selftest" | "e2e" | "fixtures"))
        || name.starts_with("test_") || name.contains(".test.") || name.contains(".spec.") || name.contains("_test.") || name.ends_with("_tests.rs")
        || name.contains("test.")
}

/// What a file's scan reads.
pub struct File<'a> {
    pub path: &'a str,
    pub lang: Lang,
    pub src: &'a [u8],
    pub lexed: &'a Lexed,
    pub funcs: &'a [Func],
}

struct Scan<'a> {
    f: &'a File<'a>,
    t: &'a [Tok],
    /// Each token's loop depth, and whether it is test code.
    loops: Vec<u16>,
    test: Vec<bool>,
    /// For each `(`/`[`/`{`, its closer (usize::MAX for none), and for closers their opener.
    mate: Vec<usize>,
    /// Lines a comment is on.
    comments: std::collections::BTreeSet<u32>,
    /// Line starts in bytes.
    nl: Vec<usize>,
    out: Vec<Finding>,
}

const NONE: usize = usize::MAX;

/// The weaknesses a file's own text shows (the repo-wide ones, structure and unused functions, are `repo`'s).
pub fn scan(f: &File) -> Vec<Finding> {
    let t = &f.lexed.toks;
    let mut mate = vec![NONE; t.len()];
    let mut open: Vec<usize> = Vec::new();
    for (i, x) in t.iter().enumerate() {
        match x.k {
            K::LParen | K::LBrack | K::Open => open.push(i),
            K::RParen | K::RBrack | K::Close => {
                let want = match x.k { K::RParen => K::LParen, K::RBrack => K::LBrack, _ => K::Open };
                if let Some(pos) = open.iter().rposition(|&o| t[o].k == want) {
                    // Openers of other kinds left open above it were never closed: drop them.
                    let o = open[pos];
                    open.truncate(pos);
                    mate[o] = i;
                    mate[i] = o;
                }
            }
            _ => {}
        }
    }
    let mut nl = vec![0usize];
    for (i, &b) in f.src.iter().enumerate() { if b == b'\n' { nl.push(i + 1); } }
    let line_of = |at: u32| nl.partition_point(|&s| s <= at as usize) as u32;
    let mut comments = std::collections::BTreeSet::new();
    for &(a, b) in &f.lexed.prose {
        let head = &f.src[a as usize..(a as usize + 2).min(f.src.len())];
        let is_comment = head.starts_with(b"//") || head.starts_with(b"/*") || (matches!(f.lang, Lang::Python | Lang::Shell) && head.starts_with(b"#"));
        if is_comment { for l in line_of(a)..=line_of(b.max(a + 1) - 1) { comments.insert(l); } }
    }
    let mut s = Scan { f, t, loops: vec![0; t.len()], test: vec![test_path(f.path); t.len()], mate, comments, nl, out: Vec::new() };
    s.mark_loops();
    s.mark_tests();
    s.tokens();
    s.caches();
    s.functions();
    s.commented_out();
    s.out
}

fn text<'a>(f: &File<'a>, t: &Tok) -> &'a [u8] { &f.src[t.start as usize..t.end as usize] }

impl<'a> Scan<'a> {
    fn txt(&self, i: usize) -> &'a [u8] { text(self.f, &self.t[i]) }
    fn word(&self, i: usize, w: &[u8]) -> bool { self.t.get(i).is_some_and(|x| x.k == K::Word) && self.txt(i) == w }
    fn punct(&self, i: usize, p: &[u8]) -> bool { self.t.get(i).is_some_and(|x| x.k == K::Punct) && self.txt(i) == p }
    fn line_of(&self, at: usize) -> u32 { self.nl.partition_point(|&s| s <= at) as u32 }
    /// A method call `.name(` at i (i the name).
    fn method(&self, i: usize, names: &[&[u8]]) -> bool {
        i > 0 && self.t[i].k == K::Word && names.contains(&self.txt(i)) && self.punct(i - 1, b".") && self.t.get(i + 1).is_some_and(|x| x.k == K::LParen)
    }
    fn func_at(&self, line: u32) -> Option<String> {
        self.f.funcs.iter().filter(|g| g.line <= line && line <= g.end && g.name != TOP).min_by_key(|g| g.end - g.line).map(|g| g.name.clone())
    }
    fn found(&mut self, kind: Kind, i: usize, about: &str) {
        let line = self.t.get(i).map_or(1, |x| x.line);
        let func = self.func_at(line);
        // One a line of a kind: two in one line are one place to change (unwraps are counted, below).
        if kind != Kind::Unwrap && self.out.last().is_some_and(|f| f.kind == kind && f.line == line) { return; }
        self.out.push(Finding { kind, file: 0, line, func, count: 1, about: about.chars().take(60).collect() });
    }
    fn commented_near(&self, line: u32, above: u32) -> bool {
        (line.saturating_sub(above)..=line).any(|l| self.comments.contains(&l))
    }

    /// Loop bodies: a brace a loop keyword opens, the brackets of a call to an iterating method, Python's and the
    /// shell's loop blocks.
    fn mark_loops(&mut self) {
        let n = self.t.len();
        let mut delta = vec![0i32; n + 1];
        let lang = self.f.lang;
        let iterating: &[&[u8]] = &[b"forEach", b"map", b"flatMap", b"filter", b"reduce", b"some", b"every", b"for_each", b"filter_map", b"flat_map", b"try_for_each", b"fold", b"all", b"any", b"find_map"];
        for i in 0..n {
            let x = self.t[i];
            match lang {
                Lang::Python => {
                    let at_line_start = i == 0 || self.t[i - 1].k == K::Nl;
                    if at_line_start && (self.word(i, b"for") || self.word(i, b"while") || self.word(i, b"async") && self.word(i + 1, b"for")) {
                        // The block: the lines after, deeper than this one.
                        let indent = self.col(i);
                        let mut j = i;
                        while j < n && self.t[j].k != K::Nl { j += 1; }
                        let start = j;
                        let mut end = j;
                        while j < n {
                            if self.t[j].k == K::Nl { j += 1; continue; }
                            if self.col(j) <= indent { break; }
                            while j < n && self.t[j].k != K::Nl { j += 1; }
                            end = j;
                        }
                        if end > start { delta[start] += 1; delta[end] -= 1; }
                    }
                }
                Lang::Shell => {
                    if (self.word(i, b"for") || self.word(i, b"while") || self.word(i, b"until")) && (i == 0 || matches!(self.t[i - 1].k, K::Nl | K::Semi)) {
                        // to the matching `done`
                        let mut depth = 0;
                        let mut j = i + 1;
                        while j < n {
                            if self.word(j, b"do") { depth += 1; }
                            if self.word(j, b"done") { depth -= 1; if depth == 0 { break; } }
                            j += 1;
                        }
                        delta[i] += 1;
                        delta[j.min(n)] -= 1;
                    }
                }
                _ => {
                    let keyword = x.k == K::Word && matches!(self.txt(i), b"for" | b"while" | b"do") || lang == Lang::Rust && self.word(i, b"loop");
                    let not_member = i == 0 || !self.punct(i - 1, b".");
                    // Rust's `impl … for …` and `for<'a>` are no loops.
                    let rust_impl = lang == Lang::Rust && self.word(i, b"for") && (self.punct(i + 1, b"<") || i > 0 && !matches!(self.t[i - 1].k, K::Open | K::Close | K::Semi | K::Punct));
                    if keyword && not_member && !rust_impl {
                        // The first `{` after it at its own bracket depth (C's `for (…)` skipped whole).
                        let mut j = i + 1;
                        while j < n && self.t[j].k != K::Open && self.t[j].k != K::Semi {
                            if matches!(self.t[j].k, K::LParen | K::LBrack) && self.mate[j] != NONE { j = self.mate[j]; }
                            j += 1;
                        }
                        if j < n && self.t[j].k == K::Open && self.mate[j] != NONE { delta[j] += 1; delta[self.mate[j]] -= 1; }
                    }
                    if self.method(i, iterating) && self.mate[i + 1] != NONE { delta[i + 1] += 1; delta[self.mate[i + 1]] -= 1; }
                }
            }
        }
        let mut d = 0i32;
        for (depth, step) in self.loops.iter_mut().zip(&delta) { d += step; *depth = d.max(0) as u16; }
    }

    fn col(&self, i: usize) -> u32 {
        let at = self.t[i].start as usize;
        let start = self.nl[self.line_of(at) as usize - 1];
        at.saturating_sub(start) as u32
    }

    /// Rust's test code: `#[cfg(test)]` and `#[test]` items.
    fn mark_tests(&mut self) {
        if self.f.lang != Lang::Rust { return; }
        let n = self.t.len();
        for i in 0..n {
            let attr = self.punct(i, b"#") && self.t.get(i + 1).is_some_and(|x| x.k == K::LBrack)
                && (self.word(i + 2, b"test") || self.word(i + 2, b"cfg") && self.word(i + 4, b"test"));
            if !attr { continue; }
            // The item after the attribute: to its first `{`, and that block whole.
            let mut j = self.mate[i + 1];
            if j == NONE { continue; }
            while j < n && self.t[j].k != K::Open && self.t[j].k != K::Semi { j += 1; }
            if j < n && self.t[j].k == K::Open && self.mate[j] != NONE { for k in i..=self.mate[j] { self.test[k] = true; } }
        }
    }

    fn tokens(&mut self) {
        let n = self.t.len();
        let lang = self.f.lang;
        let js = matches!(lang, Lang::Js | Lang::Ts);
        for i in 0..n {
            let x = self.t[i];
            let in_loop = self.loops[i] > 0;
            let test = self.test[i];
            match x.k {
                K::Word => {
                    let w = self.txt(i);
                    // Speed: built, asked, searched, sorted, slept on each time round.
                    if in_loop {
                        let regex = (w == b"Regex" && self.punct(i + 1, b"::") && self.word(i + 2, b"new"))
                            || (js && w == b"RegExp" && (self.word(i.wrapping_sub(1), b"new") || self.t.get(i + 1).is_some_and(|y| y.k == K::LParen)))
                            || (lang == Lang::Python && self.method(i, &[b"compile"]) && self.word(i.wrapping_sub(2), b"re"));
                        if regex { self.found(Kind::LoopRegex, i, ""); }
                        if self.word(i, b"await") || lang == Lang::Rust && self.punct(i.wrapping_sub(1), b".") && w == b"await" {
                            // Not an `await` that is the loop's own (for await (…), async iteration).
                            if !(self.word(i.wrapping_sub(1), b"for")) { self.found(Kind::LoopAwait, i, ""); }
                        }
                        let request = (js && w == b"fetch" && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && !self.punct(i.wrapping_sub(1), b"."))
                            || (w == b"Command" && self.punct(i + 1, b"::") && self.word(i + 2, b"new"))
                            || (js && matches!(w, b"execSync" | b"spawnSync" | b"execFileSync") && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen))
                            || (lang == Lang::Python && w == b"requests" && self.punct(i + 1, b".") && self.t.get(i + 2).is_some_and(|y| matches!(text(self.f, y), b"get" | b"post" | b"put" | b"delete")))
                            || (lang == Lang::Python && w == b"subprocess" && self.punct(i + 1, b"."));
                        if request && !test { self.found(Kind::LoopRequest, i, ""); }
                        let search = (js && self.method(i, &[b"find", b"findIndex", b"indexOf", b"filter", b"some"]))
                            || (lang == Lang::Rust && self.method(i, &[b"find", b"position", b"any"]) && self.method(i.wrapping_sub(4), &[b"iter"]));
                        // The search's own brackets are a loop level only inside it: the call itself is in the loops around.
                        if search && !test { self.found(Kind::LoopSearch, i, &String::from_utf8_lossy(w)); }
                        if self.method(i, &[b"sort", b"sort_by", b"sort_unstable", b"sort_by_key", b"sort_unstable_by"]) && !test { self.found(Kind::LoopSort, i, ""); }
                        let sleep = (w == b"sleep" && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen))
                            || (js && w == b"setTimeout" && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && self.word(i.wrapping_sub(2), b"Promise"));
                        if sleep && !test { self.found(Kind::Poll, i, ""); }
                        if lang == Lang::Go && w == b"defer" { self.found(Kind::DeferInLoop, i, ""); }
                    }
                    if test && (w == b"sleep" || w == b"waitForTimeout") && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && !self.punct(i.wrapping_sub(1), b"::") {
                        self.found(Kind::TestSleep, i, "");
                    }
                    // Memory.
                    if lang == Lang::Rust && w == b"collect" && self.punct(i + 1, b"::") && !test {
                        // .collect::<Vec<…>>() then .len() / .iter() / .into_iter() / .is_empty()
                        let mut j = i + 2;
                        while j < n && j < i + 16 && self.t[j].k != K::LParen { j += 1; }
                        if j < n && self.mate[j] != NONE {
                            let after = self.mate[j] + 1;
                            let typed_vec = (i + 2..j).any(|k| self.word(k, b"Vec"));
                            if typed_vec && self.punct(after, b".") && self.t.get(after + 1).is_some_and(|y| matches!(text(self.f, y), b"len" | b"iter" | b"into_iter" | b"is_empty" | b"count")) {
                                self.found(Kind::NeedlessCollect, i, "");
                            }
                        }
                    }
                    if lang == Lang::Rust && w == b"clone" && self.punct(i.wrapping_sub(1), b".") && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && self.t.get(i + 2).is_some_and(|y| y.k == K::RParen) && !test {
                        // &a.b.clone() given straight to a call (`, ` or `)` after it).
                        let mut j = i - 1;
                        while j >= 2 && self.punct(j, b".") && self.t[j - 1].k == K::Word { j -= 2; }
                        let lent = self.punct(j, b"&") && self.t.get(i + 3).is_some_and(|y| y.k == K::RParen || y.k == K::Punct && text(self.f, y) == b",");
                        if lent { self.found(Kind::CloneToLend, i, ""); }
                    }
                    if lang == Lang::Rust && matches!(w, b"to_string" | b"to_owned") && self.punct(i.wrapping_sub(1), b".") && !test
                        && (self.punct(i + 3, b"==") || self.punct(i + 3, b"!=")) && self.t.get(i + 4).is_some_and(|y| y.k == K::Str) {
                        self.found(Kind::AllocToCompare, i, "");
                    }
                    if js && w == b"JSON" && self.punct(i + 1, b".") && self.word(i + 2, b"parse") && self.word(i + 4, b"JSON") && self.word(i + 6, b"stringify") {
                        self.found(Kind::DeepCopy, i, "");
                    }
                    // Whole files read to go through their lines.
                    let read_whole = (lang == Lang::Rust && w == b"read_to_string" && self.statement_has(i, &[b"lines"]))
                        || (js && w == b"readFileSync" && self.statement_has(i, &[b"split"]) && self.statement_has_str(i, b"\\n"))
                        || (lang == Lang::Python && self.method(i, &[b"readlines"]) || lang == Lang::Python && self.method(i, &[b"read"]) && self.method(i + 3, &[b"splitlines"]));
                    if read_whole && !test { self.found(Kind::ReadWhole, i, ""); }
                    // Care.
                    if lang == Lang::Rust && matches!(w, b"unwrap" | b"expect") && self.punct(i.wrapping_sub(1), b".") && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen)
                        && !test && !self.f.path.ends_with("build.rs") && !self.f.path.contains("/examples/") && !self.f.path.contains("/benches/")
                        // A lock poisoned is a thread that already panicked: unwrap is the convention.
                        && !self.method(i.wrapping_sub(4), &[b"lock", b"read", b"write"]) {
                        self.found(Kind::Unwrap, i, "");
                    }
                    if js && (w == b"any" && (self.punct(i.wrapping_sub(1), b":") || self.word(i.wrapping_sub(1), b"as")) && lang == Lang::Ts && !test) {
                        self.found(Kind::TypeEscape, i, "any");
                    }
                    if js && w == b"forEach" && self.punct(i.wrapping_sub(1), b".") && self.word(i + 2, b"async") { self.found(Kind::AsyncForEach, i, ""); }
                    if lang == Lang::Rust && w == b"dbg" && self.punct(i + 1, b"!") && !test { self.found(Kind::DebugLeft, i, "dbg!"); }
                    if js && w == b"debugger" && self.t.get(i + 1).is_none_or(|y| y.k == K::Semi || y.line != x.line) { self.found(Kind::DebugLeft, i, "debugger"); }
                    if lang == Lang::Python && w == b"except" && self.punct(i + 1, b":") { self.found(Kind::BareExcept, i, ""); }
                    if lang == Lang::Python && w == b"def" { self.mutable_defaults(i); }
                    if w == b"unsafe" && lang == Lang::Rust && self.t.get(i + 1).is_some_and(|y| y.k == K::Open) && !self.unsafe_explained(x.line) {
                        self.found(Kind::UncommentedUnsafe, i, "");
                    }
                    // A wait of a bare number of milliseconds or seconds, nothing saying why.
                    let wait = (matches!(w, b"from_millis" | b"from_secs" | b"sleep") && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && self.t.get(i + 2).is_some_and(|y| y.k == K::Num))
                        || (js && w == b"setTimeout" && self.t.get(i + 1).is_some_and(|y| y.k == K::LParen) && self.mate[i + 1] != NONE && {
                            let close = self.mate[i + 1];
                            close >= 2 && self.t[close - 1].k == K::Num && self.punct(close - 2, b",")
                        });
                    if wait && !test {
                        let num = if self.t.get(i + 2).is_some_and(|y| y.k == K::Num) { i + 2 } else { self.mate[i + 1] - 1 };
                        let v: f64 = String::from_utf8_lossy(self.txt(num)).replace('_', "").parse().unwrap_or(0.0);
                        if v >= 100.0 && !self.commented_near(x.line, 1) { self.found(Kind::UnnamedWait, num, &String::from_utf8_lossy(self.txt(num))); }
                    }
                    if lang == Lang::Shell && w.starts_with(b"$") && w.len() > 1 && !matches!(w, b"$#" | b"$?" | b"$$" | b"$!" | b"$-" | b"$0") && self.unquoted_arg(i) {
                        self.found(Kind::Unquoted, i, &String::from_utf8_lossy(w));
                    }
                }
                K::Punct => {
                    let p = self.txt(i);
                    if js && matches!(p, b"==" | b"!=") && !self.punct(i + 1, b"=") {
                        // `== null` catches null and undefined at once: the one use of == worth keeping.
                        let null = self.word(i + 1, b"null") || self.word(i.wrapping_sub(1), b"null") || self.word(i + 1, b"undefined");
                        if !null && !test { self.found(Kind::LooseEquality, i, ""); }
                    }
                    if matches!(p, b"==" | b"!=") && !matches!(lang, Lang::Shell) {
                        let float = |k: usize| self.t.get(k).is_some_and(|y| y.k == K::Num && {
                            let s = text(self.f, y);
                            s.contains(&b'.') && !s.starts_with(b"0x") && s.iter().any(|c| (b'1'..=b'9').contains(c))
                        });
                        if (float(i + 1) || float(i.wrapping_sub(1))) && !test { self.found(Kind::FloatEquality, i, ""); }
                    }
                    if lang == Lang::Python && p == b":" && self.word(i.wrapping_sub(1), b"except") {}
                }
                K::Open => {
                    // An empty catch: `catch (e) {}` / `catch {}`, nothing said in it; Go's `if err != nil {}`.
                    let close = self.mate[i];
                    if close != NONE && close == i + 1 && !self.commented_near(self.t[close].line, 0) {
                        let caught = (1..=6).filter_map(|b| i.checked_sub(b)).any(|k| self.word(k, b"catch") || self.word(k, b"except"))
                            || lang == Lang::Go && (1..=5).filter_map(|b| i.checked_sub(b)).any(|k| self.word(k, b"err")) && (1..=5).filter_map(|b| i.checked_sub(b)).any(|k| self.word(k, b"nil"));
                        let header_ok = i > 0 && (self.word(i - 1, b"catch") || self.t[i - 1].k == K::RParen && self.mate[i - 1] != NONE && self.word(self.mate[i - 1].wrapping_sub(1), b"catch")
                            || lang == Lang::Go && self.word(i - 1, b"nil"));
                        if caught && header_ok { self.found(Kind::Swallowed, i, ""); }
                    }
                    // Unreachable: after `return …;` (or throw/break/continue) in a block that is no switch's.
                    self.unreachable_in(i);
                }
                K::Str => {
                    let s = self.txt(i);
                    if let Some(k) = secret(s) { self.found(Kind::Secret, i, k); }
                    let regex_literal = js && s.starts_with(b"/") && s.len() >= 27;
                    let regex_new = s.len() >= 27 && i >= 2 && self.t[i - 1].k == K::LParen
                        && (self.word(i - 2, b"new") && self.punct(i - 3, b"::") && self.word(i - 4, b"Regex") || self.word(i - 2, b"RegExp") || self.word(i - 2, b"compile") && self.word(i - 4, b"re"));
                    if (regex_literal || regex_new) && !self.commented_near(x.line, 1) && !test { self.found(Kind::UncommentedRegex, i, ""); }
                }
                _ => {}
            }
            if lang == Lang::Python && x.k == K::Word && self.word(i, b"except") {
                // `except …: pass` alone
                let mut j = i;
                while j < n && !self.punct(j, b":") && self.t[j].k != K::Nl { j += 1; }
                if self.punct(j, b":") && self.t.get(j + 1).is_some_and(|y| y.k == K::Nl) && self.word(j + 2, b"pass") && self.t.get(j + 3).is_none_or(|y| y.k == K::Nl)
                    && !self.commented_near(self.t[j + 2].line, 0) {
                    self.found(Kind::Swallowed, i, "");
                }
            }
        }
        // TODO comments.
        for &(a, b) in &self.f.lexed.prose {
            let body = &self.f.src[a as usize..b as usize];
            let head = &body[..body.len().min(2)];
            let comment = head.starts_with(b"//") || head.starts_with(b"/*") || matches!(self.f.lang, Lang::Python | Lang::Shell) && head.starts_with(b"#");
            if !comment { continue; }
            if !self.test.first().copied().unwrap_or(false) && matches!(self.f.lang, Lang::Js | Lang::Ts) {
                for escape in [&b"@ts-ignore"[..], b"@ts-nocheck", b"eslint-disable"] {
                    if body.windows(escape.len()).any(|w| w == escape) {
                        let line = self.line_of(a as usize);
                        let func = self.func_at(line);
                        self.out.push(Finding { kind: Kind::TypeEscape, file: 0, line, func, count: 1, about: String::from_utf8_lossy(escape).into_owned() });
                    }
                }
            }
            for marker in [&b"TODO"[..], b"FIXME", b"XXX", b"HACK"] {
                if let Some(p) = body.windows(marker.len()).position(|w| w == marker) {
                    let after = body.get(p + marker.len()).copied().unwrap_or(b' ');
                    let before = if p == 0 { b' ' } else { body[p - 1] };
                    if !after.is_ascii_alphanumeric() && !before.is_ascii_alphanumeric() {
                        let line = self.line_of(a as usize + p);
                        let func = self.func_at(line);
                        self.out.push(Finding { kind: Kind::Todo, file: 0, line, func, count: 1, about: String::from_utf8_lossy(&body[p..body.len().min(p + 60)]).lines().next().unwrap_or_default().to_string() });
                        break;
                    }
                }
            }
        }
        // Unwraps are many where they are: one finding a function, counted.
        let mut merged: Vec<Finding> = Vec::new();
        for f in std::mem::take(&mut self.out) {
            if f.kind == Kind::Unwrap {
                if let Some(m) = merged.iter_mut().find(|m| m.kind == Kind::Unwrap && m.func == f.func) { m.count += 1; continue; }
            }
            merged.push(f);
        }
        self.out = merged;
    }

    /// Whether the statement token `i` is in names one of `words` (to its `;` or its line's end).
    fn statement_has(&self, i: usize, words: &[&[u8]]) -> bool {
        let line = self.t[i].line;
        self.t[i..].iter().enumerate().take_while(|(_, y)| y.k != K::Semi && y.line <= line + 2).any(|(k, y)| y.k == K::Word && words.contains(&text(self.f, &self.t[i + k])))
    }
    fn statement_has_str(&self, i: usize, needle: &[u8]) -> bool {
        let line = self.t[i].line;
        self.t[i..].iter().take_while(|y| y.k != K::Semi && y.line <= line + 2).any(|y| y.k == K::Str && text(self.f, y).windows(needle.len()).any(|w| w == needle))
    }

    fn unsafe_explained(&self, line: u32) -> bool {
        (line.saturating_sub(3)..=line).any(|l| self.comments.contains(&l) && self.line_text(l).contains("SAFETY"))
    }
    fn line_text(&self, line: u32) -> String {
        let a = self.nl.get(line as usize - 1).copied().unwrap_or(0);
        let b = self.nl.get(line as usize).copied().unwrap_or(self.f.src.len());
        String::from_utf8_lossy(&self.f.src[a..b]).into_owned()
    }

    /// `def f(x=[]):` and `={}`, `=set()`, `=dict()`, `=list()`.
    fn mutable_defaults(&mut self, def: usize) {
        let Some(open) = (def..self.t.len().min(def + 4)).find(|&k| self.t[k].k == K::LParen) else { return };
        let close = self.mate[open];
        if close == NONE { return; }
        let mut k = open + 1;
        while k < close {
            if self.punct(k, b"=") {
                let empty_lit = matches!(self.t.get(k + 1).map(|y| y.k), Some(K::LBrack | K::Open)) && self.mate[k + 1] == k + 2;
                let call = self.t.get(k + 1).is_some_and(|y| y.k == K::Word && matches!(text(self.f, y), b"list" | b"dict" | b"set")) && self.t.get(k + 2).is_some_and(|y| y.k == K::LParen) && self.mate[k + 2] == k + 3;
                if empty_lit || call { self.found(Kind::MutableDefault, k, ""); }
            }
            k += 1;
        }
    }

    /// A shell word `$x` standing as an argument of a command, outside quotes (the lexer took quoted ones as
    /// strings): not the command, not in `[[ … ]]` or `(( … ))`, not an assignment's right side.
    fn unquoted_arg(&self, i: usize) -> bool {
        if i == 0 { return false; }
        let prev = self.t[i - 1];
        if matches!(prev.k, K::Nl | K::Semi) { return false; }
        if prev.k == K::Punct && matches!(text(self.f, &prev), b"=" | b"((" | b"[[") { return false; }
        // In [[ … ]] or (( … )) words do not split.
        let line_start = (0..i).rev().find(|&k| matches!(self.t[k].k, K::Nl | K::Semi)).map_or(0, |k| k + 1);
        let doubled = (line_start..i).any(|k| self.t[k].k == K::LBrack && self.t.get(k + 1).is_some_and(|y| y.k == K::LBrack && y.start == self.t[k].end)
            || self.t[k].k == K::LParen && self.t.get(k + 1).is_some_and(|y| y.k == K::LParen && y.start == self.t[k].end));
        if doubled { return false; }
        // `case $x in`, `for x in $list` (the list is meant to split)
        if (line_start..i).any(|k| self.word(k, b"case") || self.word(k, b"for")) { return false; }
        // An assignment `a=$b` lexes as a word ending in `=`: no split there either.
        if prev.k == K::Word && text(self.f, &prev).ends_with(b"=") && prev.end == self.t[i].start { return false; }
        // Glued to another word (`"$a"x` aside): `x$y` is one word, still split; a lone `$x` argument is what counts.
        true
    }

    fn unreachable_in(&mut self, open: usize) {
        let close = self.mate[open];
        if close == NONE { return; }
        // A switch's body: case labels after a break are reachable.
        let is_switch = (1..=8).filter_map(|b| open.checked_sub(b)).any(|k| self.word(k, b"switch") || self.word(k, b"match") || self.word(k, b"select") || self.word(k, b"when"));
        if is_switch { return; }
        let mut k = open + 1;
        while k < close {
            let x = self.t[k];
            if matches!(x.k, K::Open | K::LParen | K::LBrack) && self.mate[k] != NONE { k = self.mate[k] + 1; continue; }
            let ends = x.k == K::Word && matches!(self.txt(k), b"return" | b"throw" | b"continue" | b"break")
                && (k == open + 1 || matches!(self.t[k - 1].k, K::Semi | K::Close | K::Open));
            if ends {
                // To the end of that statement.
                let mut j = k + 1;
                while j < close && self.t[j].k != K::Semi {
                    if matches!(self.t[j].k, K::Open | K::LParen | K::LBrack) && self.mate[j] != NONE { j = self.mate[j]; }
                    j += 1;
                }
                let next = j + 1;
                // Something after it in the same block that is no label (`case`, `default`, `name:`), no brace.
                if next < close && self.t[next].k != K::Close && !self.word(next, b"case") && !self.word(next, b"default")
                    && !(self.t[next].k == K::Word && self.punct(next + 1, b":")) && j < close && self.t[j].k == K::Semi && self.f.lang != Lang::Go {
                    self.found(Kind::Unreachable, next, "");
                }
                return;
            }
            k += 1;
        }
    }

    /// A cache kept at the top of a module (outside every function, named for what it holds: cache, memo, seen,
    /// pending) that is filled and never emptied: a Map or Set in JavaScript, a dict or set in Python, a static
    /// HashMap in Rust.
    fn caches(&mut self) {
        let n = self.t.len();
        let mut depth = 0i32;
        let mut tops: Vec<(usize, &[u8])> = Vec::new();
        let lang = self.f.lang;
        for i in 0..n {
            match self.t[i].k { K::Open => depth += 1, K::Close => depth -= 1, _ => {} }
            if depth != 0 || self.t[i].k != K::Word { continue; }
            let name = self.txt(i);
            let lower = String::from_utf8_lossy(name).to_lowercase();
            if !["cache", "memo", "seen", "pending"].iter().any(|k| lower.contains(k)) { continue; }
            let declared = match lang {
                Lang::Js | Lang::Ts => (self.word(i.wrapping_sub(1), b"const") || self.word(i.wrapping_sub(1), b"let")) && self.punct(i + 1, b"=") && self.word(i + 2, b"new") && (self.word(i + 3, b"Map") || self.word(i + 3, b"Set")),
                Lang::Python => (i == 0 || self.t[i - 1].k == K::Nl) && self.col(i) == 0 && self.punct(i + 1, b"=")
                    && (self.t.get(i + 2).is_some_and(|y| y.k == K::Open) && self.mate[i + 2] == i + 3 || self.word(i + 2, b"dict") || self.word(i + 2, b"set")),
                Lang::Rust => self.word(i.wrapping_sub(1), b"static") && (i + 2..n.min(i + 12)).any(|k| self.word(k, b"HashMap") || self.word(k, b"HashSet") || self.word(k, b"BTreeMap")),
                _ => false,
            };
            if declared { tops.push((i, name)); }
        }
        for (at, name) in tops {
            let used = |verbs: &[&[u8]]| (0..n).any(|k| self.t[k].k == K::Word && self.txt(k) == name && self.punct(k + 1, b".") && self.t.get(k + 2).is_some_and(|y| verbs.contains(&text(self.f, y))))
                || (0..n).any(|k| self.t[k].k == K::Word && self.txt(k) == name && verbs.iter().any(|v| self.method(k + 4, &[v])) && self.punct(k + 1, b"."));
            let fills = used(&[b"set", b"add", b"insert", b"push", b"append", b"setdefault", b"entry", b"lock"]);
            let empties = used(&[b"delete", b"clear", b"remove", b"pop", b"retain", b"drain", b"truncate", b"popitem", b"discard", b"take"])
                || (0..n).any(|k| k != at && self.t[k].k == K::Word && self.txt(k) == name && self.punct(k + 1, b"=") && !self.punct(k + 2, b"="));
            if fills && !empties { let line = self.t[at].line; self.out.push(Finding { kind: Kind::UnboundedCache, file: 0, line, func: None, count: 1, about: String::from_utf8_lossy(name).into_owned() }); }
        }
    }

    /// Length and comments by function: too long, too many parameters, repetitive, complex with nothing said.
    fn functions(&mut self) {
        let funcs: Vec<Func> = self.f.funcs.iter().filter(|g| g.name != TOP).cloned().collect();
        for g in &funcs {
            let first_tok = self.t.iter().position(|x| x.line >= g.line).unwrap_or(0);
            if self.test.get(first_tok).copied().unwrap_or(false) { continue; }
            let lines = g.end - g.line + 1;
            let at = |s: &Self| s.t.iter().position(|x| x.line == g.line).unwrap_or(0);
            if lines > 100 { let i = at(self); self.push_at(Kind::LongFunction, g, i, &format!("{lines}")); }
            if g.complexity > super::debt::T && !(g.line.saturating_sub(4)..=g.end).any(|l| self.comments.contains(&l)) {
                let i = at(self);
                self.push_at(Kind::UncommentedComplex, g, i, &format!("{}", g.complexity));
            }
            // Parameters: the first bracket group on its first line.
            if let Some(open) = (first_tok..self.t.len()).take_while(|&k| self.t[k].line <= g.line + 1).find(|&k| self.t[k].k == K::LParen) {
                let close = self.mate[open];
                if close != NONE {
                    let mut params = 0u32;
                    let mut depth = 0;
                    let mut any = false;
                    for k in open + 1..close {
                        match self.t[k].k {
                            K::LParen | K::LBrack | K::Open => depth += 1,
                            K::RParen | K::RBrack | K::Close => depth -= 1,
                            K::Punct if depth == 0 && self.txt(k) == b"," => { params += u32::from(any); any = false; continue; }
                            _ => {}
                        }
                        if !(self.word(k, b"self") || self.punct(k, b"&") || self.word(k, b"mut")) { any = true; }
                    }
                    if any { params += 1; }
                    if params > 6 { self.push_at(Kind::ManyParams, g, open, &format!("{params}")); }
                }
            }
            // The same line again and again: lines by their shape (each token's kind, names and literals alike).
            if lines >= 15 {
                let mut shapes: std::collections::HashMap<Vec<u8>, u32> = std::collections::HashMap::new();
                let mut counted = 0u32;
                let mut cur: Vec<u8> = Vec::new();
                let mut cur_line = 0;
                for x in self.t.iter().filter(|x| x.line >= g.line && x.line <= g.end) {
                    if x.line != cur_line {
                        if cur.len() >= 4 { *shapes.entry(std::mem::take(&mut cur)).or_insert(0) += 1; counted += 1; }
                        cur.clear();
                        cur_line = x.line;
                    }
                    cur.push(match x.k { K::Word | K::Num | K::Str => b'a', K::Punct => text(self.f, x)[0], K::Open => b'{', K::Close => b'}', K::LParen => b'(', K::RParen => b')', K::LBrack => b'[', K::RBrack => b']', K::Semi => b';', K::Nl => b'n' });
                }
                if cur.len() >= 4 { *shapes.entry(cur).or_insert(0) += 1; counted += 1; }
                if let Some(most) = shapes.values().copied().max() {
                    if most >= 10 && most * 5 >= counted * 2 { let i = at(self); self.push_at(Kind::Repetitive, g, i, &format!("{most}")); }
                }
            }
        }
    }

    fn push_at(&mut self, kind: Kind, g: &Func, _i: usize, about: &str) {
        self.out.push(Finding { kind, file: 0, line: g.line, func: Some(g.name.clone()), count: 1, about: about.into() });
    }

    /// Three or more comment lines in a row that read as code: ending in `;`, `{` or `}`, or a call or an
    /// assignment, and no sentence.
    fn commented_out(&mut self) {
        let mut run: Vec<u32> = Vec::new();
        let lines: Vec<u32> = self.comments.iter().copied().collect();
        let flush = |run: &mut Vec<u32>, s: &mut Self| {
            if run.len() >= 3 && !s.test.first().copied().unwrap_or(false) {
                let line = run[0];
                let func = s.func_at(line);
                s.out.push(Finding { kind: Kind::CommentedOut, file: 0, line, func, count: run.len() as u32, about: String::new() });
            }
            run.clear();
        };
        for l in lines {
            let text = self.line_text(l);
            let body = text.trim().trim_start_matches("//").trim_start_matches('#').trim_start_matches("/*").trim_end_matches("*/").trim();
            let code_like = !body.is_empty() && !body.starts_with('!') && !body.starts_with('/')
                && (body.ends_with(';') || body.ends_with('{') || body == "}" || body.ends_with(");") || (body.contains('(') && body.ends_with(')') && !body.contains(' ') )
                    || (body.contains(" = ") && body.ends_with(';')));
            let sentence = body.split_whitespace().count() > 3 && body.chars().next().is_some_and(char::is_uppercase) && body.ends_with('.');
            // Only a whole line that is a comment (code with a comment after it is not commented-out code).
            let whole = text.trim_start().starts_with("//") || text.trim_start().starts_with('#') && matches!(self.f.lang, Lang::Python | Lang::Shell);
            if code_like && !sentence && whole && run.last().is_none_or(|&p| p + 1 == l) { run.push(l); }
            else if code_like && !sentence && whole { flush(&mut run, self); run.push(l); }
            else { flush(&mut run, self); }
        }
        flush(&mut run, self);
    }
}

/// A string that is a key: a cloud key's shape, a private key's armour.
fn secret(s: &[u8]) -> Option<&'static str> {
    let inner = s.get(1..s.len().saturating_sub(1)).unwrap_or_default();
    let t = String::from_utf8_lossy(inner);
    let alnum_run = |from: &str, min: usize| t.split(from).nth(1).is_some_and(|rest| rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count() >= min);
    if t.contains("-----BEGIN") && t.contains("PRIVATE KEY") { return Some("private key"); }
    if t.starts_with("AKIA") && t.len() == 20 && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) { return Some("AWS key"); }
    if (t.starts_with("ghp_") || t.starts_with("github_pat_")) && alnum_run("_", 30) { return Some("GitHub token"); }
    if t.starts_with("sk-") && alnum_run("sk-", 30) && !t.contains("...") && !t.contains("xxx") { return Some("API key"); }
    if (t.starts_with("xoxb-") || t.starts_with("xoxp-")) && t.len() > 30 { return Some("Slack token"); }
    None
}

// ---- the repo's own: structure and what nothing uses ----

/// What the repo-wide checks read of each file.
pub struct RepoFile<'a> {
    pub path: &'a str,
    pub lang: Option<Lang>,
    pub lines: u32,
    pub funcs: &'a [Func],
    /// Its function definitions' names as defined (the function's own token).
    pub test: bool,
}

/// Structure and what nothing uses: `names` counts every identifier-like word of the whole repo (code, comments,
/// strings, documents); `importers` how many files use each file (graph.rs); `built` which Rust files a crate's
/// `mod` tree reaches (None where the repo has no crate).
pub fn repo(files: &[RepoFile], names: &std::collections::HashMap<String, u32>, importers: &[u32], built: Option<&[bool]>) -> Vec<Finding> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<Finding>, kind, file, line, func: Option<String>, about: String| out.push(Finding { kind, file, line, func, count: 1, about });
    for (i, f) in files.iter().enumerate() {
        let Some(lang) = f.lang else { continue };
        if f.lines > 1000 { push(&mut out, Kind::LongFile, i, 1, None, f.lines.to_string()); }
        let name = f.path.rsplit('/').next().unwrap_or(f.path);
        let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
        let real = f.funcs.iter().filter(|g| g.name != TOP).count();
        if matches!(stem.as_str(), "utils" | "util" | "helpers" | "helper" | "misc" | "common" | "stuff" | "functions") && real > 15 {
            push(&mut out, Kind::GrabBag, i, 1, None, real.to_string());
        }
        if lang == Lang::Rust && built.is_some_and(|b| !b[i]) && !f.test && !f.path.ends_with("build.rs") && !f.path.contains("/examples/") && !f.path.contains("/benches/")
            && !f.path.contains("/bin/") && !f.path.contains("/tests/") {
            push(&mut out, Kind::Unbuilt, i, 1, None, String::new());
        }
        let entry = matches!(stem.as_str(), "main" | "index" | "lib" | "mod" | "app" | "server" | "cli" | "setup" | "manage" | "conftest" | "__init__" | "__main__" | "build")
            || f.test || f.path.starts_with("scripts/") || f.path.contains("/scripts/") || f.path.contains("/bin/") || f.path.contains("/examples/")
            || name.contains(".config.") || name.ends_with(".d.ts") || name.starts_with('.');
        if matches!(lang, Lang::Js | Lang::Ts) && importers.get(i).copied().unwrap_or(0) == 0 && !entry {
            // Named from elsewhere (an HTML page, a manifest, a worker's URL)? Then it is used.
            let named = names.get(&stem).copied().unwrap_or(0) + names.get(name).copied().unwrap_or(0);
            if named <= 1 { push(&mut out, Kind::Unused, i, 1, None, String::new()); }
        }
        // Functions nothing names but their own definition.
        if !f.test {
            for g in f.funcs.iter().filter(|g| g.name != TOP && !g.name.starts_with('(') && !g.name.contains(' ')) {
                let n = &g.name;
                let exempt = n.len() < 4 || matches!(n.as_str(), "main" | "new" | "default" | "drop" | "fmt" | "from" | "into" | "init" | "setup" | "teardown" | "render" | "constructor" | "handler" | "run")
                    || n.starts_with("test") || n.starts_with("Test") || n.starts_with("Benchmark") || n.starts_with("__") || n.starts_with("on") && n.chars().nth(2).is_some_and(char::is_uppercase);
                if !exempt && names.get(n).copied().unwrap_or(0) <= 1 { push(&mut out, Kind::UnusedFunction, i, g.line, Some(n.clone()), String::new()); }
            }
        }
    }
    // Folders: how many code files each holds, and in how many naming styles.
    let mut folders: std::collections::BTreeMap<&str, Vec<usize>> = std::collections::BTreeMap::new();
    for (i, f) in files.iter().enumerate() {
        if f.lang.is_none() { continue; }
        folders.entry(f.path.rfind('/').map_or("", |p| &f.path[..p])).or_default().push(i);
    }
    for (_, members) in folders {
        if members.len() > 40 { out.push(Finding { kind: Kind::CrowdedFolder, file: members[0], line: 1, func: None, count: members.len() as u32, about: String::new() }); }
        let style = |p: &str| {
            let stem = p.rsplit('/').next().unwrap_or(p).split('.').next().unwrap_or("");
            if stem.contains('-') { 1 } else if stem.contains('_') { 2 } else if stem.chars().skip(1).any(char::is_uppercase) && stem.chars().next().is_some_and(char::is_lowercase) { 3 } else { 0 }
        };
        let mut seen = [0usize; 4];
        for &m in &members { seen[style(files[m].path)] += 1; }
        let styles = seen[1..].iter().filter(|&&c| c >= 2).count();
        if styles >= 2 { out.push(Finding { kind: Kind::MixedNames, file: members[0], line: 1, func: None, count: styles as u32, about: String::new() }); }
    }
    out
}

/// Every identifier-like word of a text, counted into `into`.
pub fn count_names(text: &[u8], into: &mut std::collections::HashMap<String, u32>) {
    let mut i = 0;
    while i < text.len() {
        if text[i].is_ascii_alphabetic() || text[i] == b'_' {
            let s = i;
            while i < text.len() && (text[i].is_ascii_alphanumeric() || text[i] == b'_') { i += 1; }
            if i - s >= 3 { *into.entry(String::from_utf8_lossy(&text[s..i]).into_owned()).or_insert(0) += 1; }
        } else { i += 1; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{lex::lex, shape::shape};

    fn kinds(path: &str, src: &str) -> Vec<(Kind, u32)> {
        let lang = Lang::of(path, src.as_bytes()).expect("a language");
        let l = lex(src.as_bytes(), lang);
        let sh = shape(src.as_bytes(), &l, lang);
        scan(&File { path, lang, src: src.as_bytes(), lexed: &l, funcs: &sh.funcs }).into_iter().map(|f| (f.kind, f.line)).collect()
    }
    fn has(path: &str, src: &str, k: Kind) -> bool { kinds(path, src).iter().any(|x| x.0 == k) }

    /// Each check: code that has it, and code that only looks like it.
    #[test]
    fn speed() {
        assert!(has("a.rs", "fn f(xs: &[String]) { for x in xs { let r = Regex::new(\"a+\").unwrap(); } }", Kind::LoopRegex));
        assert!(!has("a.rs", "fn f(xs: &[String]) { let r = Regex::new(\"a+\").unwrap(); for x in xs { r.is_match(x); } }", Kind::LoopRegex));
        assert!(has("a.ts", "async function f(ids) { for (const id of ids) { const r = await get(id); } }", Kind::LoopAwait));
        assert!(!has("a.ts", "async function f(ids) { for await (const r of stream) { use(r); } await Promise.all(ids.map(get)); }", Kind::LoopAwait));
        assert!(has("a.ts", "function f(ids) { ids.forEach((id) => { fetch(`/x/${id}`); }); }", Kind::LoopRequest));
        assert!(!has("a.ts", "function f(ids) { return fetch('/x?ids=' + ids.join(',')); }", Kind::LoopRequest));
        assert!(has("a.ts", "function f(a, b) { for (const x of a) { if (b.find((y) => y.id === x.id)) {} } }", Kind::LoopSearch));
        assert!(!has("a.ts", "function f(a) { return a.filter((x) => x.ok); }", Kind::LoopSearch), "the loop's own filter searches nothing");
        assert!(has("a.rs", "fn f(a: &[u8], b: &[u8]) { for x in a { if b.iter().any(|y| y == x) {} } }", Kind::LoopSearch));
        assert!(has("a.py", "def f(xs):\n    for x in xs:\n        time.sleep(1)\n", Kind::Poll));
        assert!(!has("tests/a_test.py", "def test_f(xs):\n    for x in xs:\n        time.sleep(1)\n", Kind::Poll), "a test's sleep is a slow test");
        assert!(has("tests/a.test.ts", "test('x', async () => { await page.waitForTimeout(500); });", Kind::TestSleep));
        assert!(has("a.rs", "fn f(v: &[u8]) -> usize { v.iter().filter(|x| **x > 0).collect::<Vec<_>>().len() }", Kind::NeedlessCollect));
        assert!(!has("a.rs", "fn f(v: &[u8]) -> Vec<u8> { v.iter().copied().collect::<Vec<_>>() }", Kind::NeedlessCollect));
        assert!(has("a.rs", "fn f(s: &S) { g(&s.name.clone()); }", Kind::CloneToLend));
        assert!(!has("a.rs", "fn f(s: &S) { let n = s.name.clone(); g(&n); h(s.name.clone()); }", Kind::CloneToLend));
        assert!(has("a.rs", "fn f(s: &str) -> bool { s.to_string() == \"x\" }", Kind::AllocToCompare));
        assert!(has("a.js", "const b = JSON.parse(JSON.stringify(a));", Kind::DeepCopy));
        assert!(has("a.rs", "fn f(xs: &mut [Vec<u8>]) { for x in xs.iter_mut() { x.sort(); } }", Kind::LoopSort));
        // `impl Trait for Type` is no loop: nothing in it is "in a loop".
        assert!(!has("a.rs", "impl Show for Big { fn f(&self) { let r = Regex::new(\"a\").unwrap(); } }", Kind::LoopRegex));
    }

    #[test]
    fn memory_and_care() {
        assert!(has("a.rs", "fn f(p: &Path) { for l in fs::read_to_string(p).unwrap_or_default().lines() {} }", Kind::ReadWhole));
        assert!(has("a.py", "def f(p):\n    for l in open(p).readlines():\n        pass\n", Kind::ReadWhole));
        assert!(has("a.ts", "function f() { try { g(); } catch (e) {} }", Kind::Swallowed));
        assert!(!has("a.ts", "function f() { try { g(); } catch (e) { /* the file may be gone: nothing to do */ } }", Kind::Swallowed));
        assert!(!has("a.ts", "function f() { try { g(); } catch (e) { log(e); } }", Kind::Swallowed));
        assert!(has("a.py", "def f():\n    try:\n        g()\n    except ValueError:\n        pass\n", Kind::Swallowed));
        assert!(has("a.py", "def f():\n    try:\n        g()\n    except:\n        raise\n", Kind::BareExcept));
        assert!(has("a.py", "def f(x, seen=[]):\n    pass\n", Kind::MutableDefault));
        assert!(has("a.py", "def f(x, seen=set()):\n    pass\n", Kind::MutableDefault));
        assert!(!has("a.py", "def f(x, seen=None, n=[1]):\n    pass\n", Kind::MutableDefault));
        assert!(has("a.js", "if (a == b) {}", Kind::LooseEquality));
        assert!(!has("a.js", "if (a === b || a == null) {}", Kind::LooseEquality));
        assert!(has("a.c", "int f(double x) { return x == 0.1; }", Kind::FloatEquality));
        assert!(!has("a.c", "int f(double x) { return x == 0.0 || x == 0; }", Kind::FloatEquality), "zero is exact");
        assert!(has("a.ts", "function f(x: any) { return x as any; }", Kind::TypeEscape));
        assert!(has("a.ts", "xs.forEach(async (x) => { await g(x); });", Kind::AsyncForEach));
        assert!(has("a.ts", "// @ts-ignore\nconst x: number = y;", Kind::TypeEscape));
        assert!(has("a.ts", "const cache = new Map();\nexport function get(k) { if (!cache.has(k)) cache.set(k, load(k)); return cache.get(k); }", Kind::UnboundedCache));
        assert!(!has("a.ts", "const cache = new Map();\nexport function get(k) { cache.set(k, 1); if (cache.size > 100) cache.clear(); }", Kind::UnboundedCache));
        assert!(!has("a.ts", "export function f() { const seen = new Set(); seen.add(1); }", Kind::UnboundedCache), "inside a function it goes with the call");
        assert!(has("a.py", "_memo = {}\ndef fib(n):\n    _memo[n] = n\n    _memo.setdefault(n, 1)\n", Kind::UnboundedCache));
        assert!(has("a.sh", "rm -rf $dir\n", Kind::Unquoted));
        assert!(!has("a.sh", "rm -rf \"$dir\"\nx=$y\nif [[ -n $z ]]; then :; fi\nfor f in $list; do :; done\necho $#\n", Kind::Unquoted));
        assert!(has("a.rs", "fn f(o: Option<u8>) -> u8 { o.unwrap() }", Kind::Unwrap));
        assert!(!has("a.rs", "fn f(m: &Mutex<u8>) { *m.lock().unwrap() += 1; }\n#[cfg(test)]\nmod tests { fn t() { Some(1).unwrap(); } }", Kind::Unwrap));
        // Unwraps in one function are one finding, counted.
        let src = "fn f(a: Option<u8>, b: Option<u8>) -> u8 { a.unwrap() + b.unwrap() + a.unwrap() }";
        let lang = Lang::Rust;
        let l = lex(src.as_bytes(), lang);
        let sh = shape(src.as_bytes(), &l, lang);
        let found = scan(&File { path: "a.rs", lang, src: src.as_bytes(), lexed: &l, funcs: &sh.funcs });
        assert_eq!(found.iter().filter(|f| f.kind == Kind::Unwrap).map(|f| f.count).collect::<Vec<_>>(), [3]);
        assert!(has("a.rs", "fn f() { let x = dbg!(1); }", Kind::DebugLeft));
        assert!(has("a.js", "function f() { debugger; }", Kind::DebugLeft));
        assert!(has("a.go", "func f(fs []string) { for _, p := range fs { f, _ := os.Open(p); defer f.Close() } }", Kind::DeferInLoop));
        assert!(has("a.rs", "// TODO: handle the empty case\nfn f() {}", Kind::Todo));
        assert!(!has("a.rs", "// TODOs live in issues\nfn f() { let todo = 1; }", Kind::Todo));
        assert!(has("a.ts", "const k = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';", Kind::Secret));
        assert!(!has("a.ts", "const k = 'sk-...'; const label = 'sk-ant- keys start so';", Kind::Secret));
    }

    #[test]
    fn comments_dead_and_length() {
        assert!(has("a.rs", "fn f() { unsafe { g() } }", Kind::UncommentedUnsafe));
        assert!(!has("a.rs", "fn f() {\n    // SAFETY: g reads nothing it is not given.\n    unsafe { g() }\n}", Kind::UncommentedUnsafe));
        assert!(has("a.ts", "const r = /^([a-z0-9_-]+)@([a-z0-9.-]+)\\.([a-z]{2,})$/i;", Kind::UncommentedRegex));
        assert!(!has("a.ts", "// name@domain\nconst r = /^([a-z0-9_-]+)@([a-z0-9.-]+)\\.([a-z]{2,})$/i;", Kind::UncommentedRegex));
        assert!(has("a.ts", "setTimeout(go, 1500);", Kind::UnnamedWait));
        assert!(!has("a.ts", "setTimeout(go, 0); setTimeout(go, RETRY_MS);", Kind::UnnamedWait));
        assert!(has("a.ts", "function f(x) {\n  return 1;\n  g(x);\n}", Kind::Unreachable));
        assert!(!has("a.ts", "function f(x) {\n  switch (x) { case 1: return 1; case 2: return 2; }\n  if (x) { return 3; }\n  return 4;\n}", Kind::Unreachable));
        assert!(has("a.c", "int f(void) {\n  // x = g(1);\n  // if (x) {\n  //   y = 2;\n  // }\n  return 0;\n}", Kind::CommentedOut));
        assert!(!has("a.c", "int f(void) {\n  // The caller holds the lock.\n  // It is released on return.\n  // See g() for why.\n  return 0;\n}", Kind::CommentedOut));
        assert!(has("a.ts", "function f(a, b, c, d, e, g, h) {}", Kind::ManyParams));
        assert!(!has("a.rs", "fn f(&self, a: u8, b: (u8, u8), c: u8, d: u8, e: u8) {}", Kind::ManyParams));
        let rows: String = (0..14).map(|i| format!("  m.set('k{i}', v{i});\n")).collect();
        assert!(has("a.ts", &format!("function f(m) {{\n{rows}  return m;\n}}\n"), Kind::Repetitive));
        let deep = format!("fn f(a: u32) {{\n{}{}}}\n", (0..6).map(|d| format!("{}if a > {d} {{\n", " ".repeat(d))).collect::<String>(), "}\n".repeat(6));
        assert!(has("a.rs", &deep, Kind::UncommentedComplex));
        assert!(!has("a.rs", &format!("/// Six thresholds, each a level deeper.\n{deep}"), Kind::UncommentedComplex));
    }

    #[test]
    fn the_repo_wide_ones() {
        let names: std::collections::HashMap<String, u32> = [("used_twice", 2), ("lonely_one", 1), ("helper", 1)].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let f = |name: &str, line| Func { name: name.into(), line, end: line + 3, complexity: 0, nesting: 0 };
        let funcs = [f("used_twice", 1), f("lonely_one", 5), f("main", 9), f("test_x", 12), f("(closure)", 20)];
        let files = [
            RepoFile { path: "src/a.rs", lang: Some(Lang::Rust), lines: 40, funcs: &funcs, test: false },
            RepoFile { path: "src/stray.rs", lang: Some(Lang::Rust), lines: 10, funcs: &[], test: false },
            RepoFile { path: "web/helper.ts", lang: Some(Lang::Ts), lines: 10, funcs: &[], test: false },
            RepoFile { path: "web/index.ts", lang: Some(Lang::Ts), lines: 10, funcs: &[], test: false },
        ];
        let found = repo(&files, &names, &[1, 0, 0, 0], Some(&[true, false, true, true]));
        let got: Vec<(Kind, usize)> = found.iter().map(|x| (x.kind, x.file)).collect();
        assert!(got.contains(&(Kind::UnusedFunction, 0)) && found.iter().filter(|x| x.kind == Kind::UnusedFunction).count() == 1, "{found:?}");
        assert!(got.contains(&(Kind::Unbuilt, 1)));
        assert!(got.contains(&(Kind::Unused, 2)) && !got.contains(&(Kind::Unused, 3)), "an index is an entry point");
    }

    #[test]
    fn every_kind_has_its_words_and_area() {
        for &k in Kind::all() {
            let (what, fix) = k.said();
            assert!(!what.is_empty() && !fix.is_empty(), "{k:?}");
            assert!((1..=3).contains(&k.weight()));
            let _ = k.area();
        }
    }

    #[test]
    fn any_bytes_scan_without_failing() {
        let mut rng = crate::plan::lex::tests::Rng(13);
        let alphabet: &[u8] = b"{}()[]\"'`/\\*#$<-\n ;:|&?=.,!@forwhileifawaitcatchreturnunsafesleepRegexnew0123456789";
        for _ in 0..1500 {
            let n = rng.below(160);
            let src: Vec<u8> = (0..n).map(|_| alphabet[rng.below(alphabet.len())]).collect();
            for (path, lang) in [("a.rs", Lang::Rust), ("a.ts", Lang::Ts), ("a.py", Lang::Python), ("a.sh", Lang::Shell), ("a.c", Lang::C), ("a.go", Lang::Go)] {
                let l = lex(&src, lang);
                let sh = shape(&src, &l, lang);
                let _ = scan(&File { path, lang, src: &src, lexed: &l, funcs: &sh.funcs });
            }
        }
    }
}
