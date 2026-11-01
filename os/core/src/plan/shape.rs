//! A file's functions and how hard each is to follow: its cognitive complexity (G. Ann Campbell, "Cognitive
//! Complexity", SonarSource, 2018): +1 for each break in the straight flow (if, else, a loop, a switch, catch, goto,
//! a jump to a label, a ternary, a run of like boolean operators, recursion), and for those that nest (all but else,
//! the boolean runs, jumps and recursion) +1 more for each structure they sit in. Unlike cyclomatic complexity it
//! does not count a switch's cases one by one (each is read at a glance) and does count nesting (which is what makes
//! code hard to hold in mind).
//!
//! What is a function: one a name declares (`fn`, `function`, `func`, `fun`, `def`, a method, a function assigned to
//! a name) is a unit of its own wherever it is; one without a name (a closure, a callback, a lambda) is read as part
//! of the function it is written in, one level deeper, as Campbell's nested functions are. Outside any function,
//! code is the file's top level, a unit of its own. Braceless bodies (`if (x) y;`) do not deepen the nesting.
//!
//! One exception: a closure longer than LONG lines is read as a unit of its own (a route's handler registered in a
//! function that sets up thirty of them, a test's body): what it holds is counted to it, at its own nesting, not to
//! the function it was written in.

#![forbid(unsafe_code)]

use super::lex::{Family, Lang, Lexed, Tok, K};
use serde::Serialize;

/// A function, or a file's top level, and how hard it is to follow.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Func {
    /// Its name; `(closure)` for one without, `(top level)` for the code outside every function.
    pub name: String,
    /// Its first and last lines.
    pub line: u32,
    pub end: u32,
    /// Its cognitive complexity.
    pub complexity: u32,
    /// The deepest its structures nest.
    pub nesting: u32,
}

pub const TOP: &str = "(top level)";
/// Lines past which a closure is a unit of its own.
pub const LONG: u32 = 25;
pub const CLOSURE: &str = "(closure)";

/// A file's functions in order (its top level among them if anything there is complex), and its lines of code.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    pub funcs: Vec<Func>,
    /// Lines a token starts on.
    pub code_lines: u32,
}

pub fn shape(src: &[u8], lexed: &Lexed, lang: Lang) -> Shape {
    let mut code_lines = 0;
    let mut last = 0;
    for t in &lexed.toks {
        if t.line != last && t.k != K::Nl { code_lines += 1; last = t.line; }
    }
    let funcs = match lang.family() {
        Family::Brace => Braces::new(src, &lexed.toks, lang).run(),
        Family::Indent => python(src, &lexed.toks),
        Family::Shell => shell(src, &lexed.toks),
    };
    Shape { funcs, code_lines }
}

/// The units being counted: each function, and the top level once anything there counts.
struct Units {
    funcs: Vec<Func>,
    top: Option<usize>,
    /// The closures open that count toward the function around them, innermost last: what each has added, so one
    /// found long when it closes can be taken out as a unit of its own.
    closures: Vec<Closure>,
}

struct Closure { unit: Option<usize>, name: String, line: u32, base: u32, sum: u32, nested: u32, deepest: u32 }

impl Units {
    fn open(&mut self, name: String, line: u32) -> usize {
        self.funcs.push(Func { name, line, end: line, complexity: 0, nesting: 0 });
        self.funcs.len() - 1
    }
    /// `n` added to `unit` (the top level if none), at nesting `nest`, on `line`.
    fn add(&mut self, unit: Option<usize>, n: u32, nest: u32, line: u32) {
        let u = match unit {
            Some(u) => u,
            None => *self.top.get_or_insert_with(|| { self.funcs.push(Func { name: TOP.into(), line, end: line, complexity: 0, nesting: 0 }); self.funcs.len() - 1 }),
        };
        let f = &mut self.funcs[u];
        f.complexity += n;
        f.nesting = f.nesting.max(nest);
        if unit.is_none() { f.end = f.end.max(line); f.line = f.line.min(line); }
        // What a function declared inside the closure adds is that function's, not the closure's.
        if let Some(c) = self.closures.last_mut().filter(|c| c.unit == unit) { c.sum += n; c.deepest = c.deepest.max(nest); }
    }
    /// A structure that nests (+1, and +1 for each it sits in: `nest`).
    fn nested(&mut self, unit: Option<usize>, nest: u32, line: u32) {
        self.add(unit, 1 + nest, nest + 1, line);
        if let Some(c) = self.closures.last_mut().filter(|c| c.unit == unit) { c.nested += 1; }
    }
    /// A closure counted toward `unit` closes on `end`: long, it is taken out as a unit of its own (each structure
    /// in it at its own nesting, `base` less); short, what it added stays, and counts toward the closure around it.
    fn close_closure(&mut self, unit: Option<usize>, end: u32) {
        let Some(c) = self.closures.pop() else { return };
        if end.saturating_sub(c.line) + 1 > LONG && c.sum > 0 {
            if let Some(u) = unit { self.funcs[u].complexity = self.funcs[u].complexity.saturating_sub(c.sum); }
            let complexity = c.sum - c.base * c.nested;
            self.funcs.push(Func { name: c.name, line: c.line, end, complexity, nesting: c.deepest.saturating_sub(c.base) });
            return;
        }
        if let Some(o) = self.closures.last_mut() { o.sum += c.sum; o.nested += c.nested; o.deepest = o.deepest.max(c.deepest); }
    }
    /// In order of where they start (the top level where its first counted line is).
    fn done(mut self) -> Vec<Func> {
        self.funcs.sort_by_key(|f| (f.line, f.end));
        self.funcs
    }
}

/// Brace kinds: a control structure's body (deepens the nesting), a `do`'s (its `while` is not another loop), a
/// function's, or any other block.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bk { Ctl, Do, Fn, Plain }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pend { Ctl, Do, GoFor }

#[derive(Clone, Copy)]
struct Level {
    kind: Bk,
    /// The unit what is inside counts toward, and whether this brace opened it.
    unit: Option<usize>,
    opened: bool,
    /// Whether that unit is a named function (anonymous closures in it count toward it).
    named: bool,
    /// A closure counted toward it (Units::closures has its count).
    tracked: bool,
    nest: u32,
    /// What was waiting outside, given back when this closes.
    pending: Option<(Pend, u32)>,
    paren: u32,
}

/// A function a keyword introduced, waiting for its body: where the keyword is, and at what bracket depth.
#[derive(Clone, Copy)]
struct FnKw { at: usize, paren: u32 }

struct Braces<'a> {
    s: &'a [u8],
    t: &'a [Tok],
    lang: Lang,
    /// For each `)` and `]`, its `(` or `[` (usize::MAX for none).
    mate: Vec<usize>,
    units: Units,
}

const NONE: usize = usize::MAX;

impl<'a> Braces<'a> {
    fn new(s: &'a [u8], t: &'a [Tok], lang: Lang) -> Braces<'a> {
        let mut mate = vec![NONE; t.len()];
        let mut open: Vec<usize> = Vec::new();
        for (i, tok) in t.iter().enumerate() {
            match tok.k {
                K::LParen | K::LBrack => open.push(i),
                K::RParen | K::RBrack => {
                    // An opener of the other kind is left open (code that does not balance): this one has none.
                    let want = if tok.k == K::RParen { K::LParen } else { K::LBrack };
                    if let Some(&o) = open.last() { if t[o].k == want { mate[i] = o; open.pop(); } }
                }
                _ => {}
            }
        }
        Braces { s, t, lang, mate, units: Units { funcs: Vec::new(), top: None, closures: Vec::new() } }
    }

    fn text(&self, i: usize) -> &'a [u8] { let t = &self.t[i]; &self.s[t.start as usize..t.end as usize] }
    fn word(&self, i: usize, w: &[u8]) -> bool { self.t.get(i).is_some_and(|t| t.k == K::Word) && self.text(i) == w }
    fn punct(&self, i: usize, p: &[u8]) -> bool { self.t.get(i).is_some_and(|t| t.k == K::Punct) && self.text(i) == p }
    /// A word after `.`, `?.`, `::` or `->` is a member's name, never a keyword (`promise.catch(…)`).
    fn member(&self, i: usize) -> bool { i > 0 && self.t[i - 1].k == K::Punct && matches!(self.text(i - 1), b"." | b"?." | b"::" | b"->") }

    fn run(mut self) -> Vec<Func> {
        let lang = self.lang;
        let mut stack: Vec<Level> = Vec::new();
        let mut pending: Option<(Pend, u32)> = None;
        let mut paren = 0u32;
        let mut fn_kws: Vec<FnKw> = Vec::new();
        let mut flat_if = false;
        let mut after_do = false;
        let mut bool_op: Option<&[u8]> = None;
        let mut recursed: Vec<bool> = Vec::new();
        let n = self.t.len();
        for i in 0..n {
            let tok = self.t[i];
            let top = stack.last().copied();
            let unit = top.and_then(|l| l.unit);
            let nest = top.map_or(0, |l| l.nest);
            let was_after_do = std::mem::replace(&mut after_do, false);
            match tok.k {
                K::Word if !self.member(i) => {
                    let w = self.text(i);
                    let (ctl, pend) = keyword(lang, w);
                    match ctl {
                        Kw::If => {
                            if std::mem::replace(&mut flat_if, false) { self.units.add(unit, 1, nest, tok.line); } else { self.units.nested(unit, nest, tok.line); }
                            pending = Some((Pend::Ctl, paren));
                        }
                        Kw::Else => {
                            if self.word(i + 1, b"if") { flat_if = true; }
                            else { self.units.add(unit, 1, nest, tok.line); pending = Some((Pend::Ctl, paren)); }
                        }
                        Kw::Loop if w == b"while" && was_after_do => {}
                        // Rust's `impl Trait for Type` and `for<'a>` are no loops: one starts a statement.
                        Kw::Loop if lang == Lang::Rust && w == b"for" && !self.statement_start(i) => {}
                        Kw::Loop | Kw::Switch | Kw::Catch => {
                            self.units.nested(unit, nest, tok.line);
                            pending = Some((pend.unwrap_or(Pend::Ctl), paren));
                        }
                        Kw::Jump => self.units.add(unit, 1, nest, tok.line),
                        Kw::Label => {
                            // break/continue to a label: Rust's 'label, or a name before the statement ends.
                            let labelled = self.t.get(i + 1).is_some_and(|x| x.k == K::Word && x.line == tok.line
                                && (lang != Lang::Rust || self.text(i + 1).starts_with(b"'")));
                            if labelled { self.units.add(unit, 1, nest, tok.line); }
                        }
                        Kw::Func => {
                            // fn/func/fun/function: a function's body is the next brace at this depth (a fn pointer
                            // type, `fn(u8)`, introduces none in Rust).
                            if !(lang == Lang::Rust && self.t.get(i + 1).is_some_and(|x| x.k == K::LParen)) {
                                fn_kws.push(FnKw { at: i, paren });
                            }
                        }
                        Kw::None => {
                            // Recursion: the unit's own name called within it.
                            if let Some(u) = unit {
                                if self.t.get(i + 1).is_some_and(|x| x.k == K::LParen) && self.units.funcs[u].name.as_bytes() == w
                                    && u < recursed.len() && !recursed[u] {
                                    recursed[u] = true;
                                    self.units.add(Some(u), 1, nest, tok.line);
                                }
                            }
                        }
                    }
                }
                K::Punct => {
                    let p = self.text(i);
                    if p == b"&&" || p == b"||" && !self.rust_closure_bars(i) {
                        if bool_op != Some(p) { self.units.add(unit, 1, nest, tok.line); }
                        bool_op = Some(p);
                        continue;
                    }
                    if p == b"?" && self.ternary(i) { self.units.nested(unit, nest, tok.line); }
                    if p == b"=>" { pending = None; }
                    if p == b"," || p == b"=" { bool_op = None; }
                }
                K::LParen | K::LBrack => { paren += 1; bool_op = None; }
                K::RParen | K::RBrack => { paren = paren.saturating_sub(1); bool_op = None; }
                K::Semi => {
                    bool_op = None;
                    if pending.is_some_and(|(p, at)| at >= paren && p != Pend::GoFor) { pending = None; }
                    while fn_kws.last().is_some_and(|f| f.paren >= paren) { fn_kws.pop(); }
                }
                K::Open => {
                    bool_op = None;
                    while fn_kws.last().is_some_and(|f| f.paren > paren) { fn_kws.pop(); }
                    let (kind, name) = if let Some((p, _)) = pending.filter(|&(_, at)| at == paren) {
                        (if p == Pend::Do { Bk::Do } else { Bk::Ctl }, None)
                    } else if fn_kws.last().is_some_and(|f| f.paren == paren) {
                        let f = fn_kws.pop().unwrap_or(FnKw { at: i, paren });
                        (Bk::Fn, Some(self.keyword_fn_name(f.at, i)))
                    } else {
                        self.header(i)
                    };
                    if kind != Bk::Ctl && kind != Bk::Do { pending = pending.filter(|&(_, at)| at != paren); }
                    let saved = (pending.take(), std::mem::replace(&mut paren, 0));
                    let named_here = name.as_ref().is_some_and(|n| n.as_str() != CLOSURE);
                    let level = match kind {
                        // A named function: a unit of its own, wherever it is.
                        Bk::Fn if named_here || unit.is_none() || !top.is_some_and(|l| l.named) => {
                            let u = self.units.open(name.unwrap_or_else(|| CLOSURE.into()), self.decl_line(i));
                            recursed.resize(self.units.funcs.len(), false);
                            Level { kind, unit: Some(u), opened: true, named: named_here, tracked: false, nest: 0, pending: saved.0, paren: saved.1 }
                        }
                        // A closure in a named function: part of it, a level deeper.
                        Bk::Fn => {
                            self.units.closures.push(Closure { unit, name: self.callback_name(i), line: self.decl_line(i), base: nest + 1, sum: 0, nested: 0, deepest: 0 });
                            Level { kind, unit, opened: false, named: true, tracked: true, nest: nest + 1, pending: saved.0, paren: saved.1 }
                        }
                        Bk::Ctl | Bk::Do => Level { kind, unit, opened: false, named: top.is_some_and(|l| l.named), tracked: false, nest: nest + 1, pending: saved.0, paren: saved.1 },
                        Bk::Plain => Level { kind, unit, opened: false, named: top.is_some_and(|l| l.named), tracked: false, nest, pending: saved.0, paren: saved.1 },
                    };
                    stack.push(level);
                }
                K::Close => {
                    bool_op = None;
                    if let Some(l) = stack.pop() {
                        if l.opened { if let Some(u) = l.unit { self.units.funcs[u].end = tok.line; } }
                        if l.tracked { self.units.close_closure(l.unit, tok.line); }
                        after_do = l.kind == Bk::Do;
                        pending = l.pending;
                        paren = l.paren;
                    }
                }
                _ => {}
            }
        }
        // Functions never closed end where the file does.
        let last_line = self.t.last().map_or(0, |t| t.line);
        for l in stack.into_iter().rev() {
            if l.opened { if let Some(u) = l.unit { self.units.funcs[u].end = last_line; } }
            if l.tracked { self.units.close_closure(l.unit, last_line); }
        }
        self.units.done()
    }

    /// The line a function starts on: its declaration's (the header's first token on the brace's own statement).
    fn decl_line(&self, open: usize) -> u32 {
        let mut j = open;
        let mut steps = 0;
        let mut line = self.t[open].line;
        while j > 0 && steps < 64 {
            j -= 1;
            steps += 1;
            match self.t[j].k {
                K::Semi | K::Open | K::Close | K::Nl => break,
                K::RParen | K::RBrack if self.mate[j] != NONE => { j = self.mate[j]; line = self.t[j].line; }
                K::LParen | K::LBrack => break,
                _ => line = self.t[j].line,
            }
        }
        line
    }

    /// Whether token `i` starts a statement (or an expression a statement holds): first, or after a brace, `;`,
    /// `=>`, `=`, a label's `:`, `(`, `,`, and not before `<` (Rust's `for<'a>`).
    fn statement_start(&self, i: usize) -> bool {
        if self.punct(i + 1, b"<") { return false; }
        i == 0 || matches!(self.t[i - 1].k, K::Open | K::Close | K::Semi | K::LParen)
            || self.t[i - 1].k == K::Punct && matches!(self.text(i - 1), b"=>" | b"=" | b":" | b",")
    }

    /// `||` as a Rust closure's empty parameters (`move || {`, `f(|| x)`), not an operator.
    fn rust_closure_bars(&self, i: usize) -> bool {
        self.lang == Lang::Rust && (i == 0 || matches!(self.t[i - 1].k, K::LParen | K::Open | K::Semi) || self.word(i - 1, b"move")
            || self.t[i - 1].k == K::Punct && matches!(self.text(i - 1), b"," | b"=" | b"=>"))
    }

    /// `?` as a ternary: in a language that has one, and not TypeScript's optional (`a?: T`), a wildcard (`<?>`) or
    /// the end of an expression (`x?)`).
    fn ternary(&self, i: usize) -> bool {
        matches!(self.lang, Lang::C | Lang::Cpp | Lang::Java | Lang::Js | Lang::Ts | Lang::CSharp)
            && !self.t.get(i + 1).is_none_or(|n| matches!(n.k, K::RParen | K::RBrack | K::Semi | K::Close)
                || n.k == K::Punct && matches!(self.text(i + 1), b":" | b"," | b"=" | b">"))
    }

    /// The name of a function a keyword introduced (`at`), from the keyword to its body (`open`): Go's receiver and
    /// any generics skipped, the last word before its parameters; none (a closure) if there is no word.
    fn keyword_fn_name(&self, at: usize, open: usize) -> String {
        let mut j = at + 1;
        // Go's receiver, `func (r *T) Name(`, or a literal's parameters, `func(x int) {`.
        if self.t.get(j).is_some_and(|x| x.k == K::LParen) && self.mate_of_open(j).is_some() {
            let close = self.mate_of_open(j).unwrap_or(j);
            if self.t.get(close + 1).is_some_and(|x| x.k == K::Word) { j = close + 1; } else { return self.assigned_name(at); }
        }
        let mut name: Option<usize> = None;
        let mut angle = 0u32;
        while j < open {
            let x = self.t[j];
            match x.k {
                K::LParen if angle == 0 => break,
                K::Word if angle == 0 => name = Some(j),
                K::Punct if self.text(j) == b"<" => angle += 1,
                K::Punct if self.text(j) == b">" => angle = angle.saturating_sub(1),
                K::Punct if matches!(self.text(j), b"*" | b"." | b"::") => {}
                _ if angle > 0 => {}
                _ => break,
            }
            j += 1;
        }
        match name {
            Some(n) => String::from_utf8_lossy(self.text(n)).into_owned(),
            None => self.assigned_name(at),
        }
    }

    fn mate_of_open(&self, open: usize) -> Option<usize> {
        // The mate table maps closers to openers; an opener's closer is found by scanning forward to the one that
        // maps back to it (bounded: headers are short).
        (open + 1..self.t.len().min(open + 256)).find(|&k| self.mate[k] == open)
    }

    /// A function expression's name from what it is given to: `name = …`, `name: …` (else a closure).
    fn assigned_name(&self, at: usize) -> String {
        let mut j = at;
        let mut steps = 0;
        while j > 0 && steps < 6 {
            j -= 1;
            steps += 1;
            let x = self.t[j];
            if x.k == K::Punct && matches!(self.text(j), b"=" | b":") {
                return if j > 0 && self.t[j - 1].k == K::Word { String::from_utf8_lossy(self.text(j - 1)).into_owned() } else { CLOSURE.into() };
            }
            if !(x.k == K::Word || x.k == K::Punct && self.text(j) == b"*" || matches!(x.k, K::RParen | K::LParen)) { break; }
            if x.k == K::RParen && self.mate[j] != NONE { j = self.mate[j]; }
        }
        CLOSURE.into()
    }

    /// What a `{` no control keyword and no function keyword opens, read from its header (the tokens back to the
    /// statement's start, brackets skipped whole): a closure (`=> {`, `| {`, `-> {` in Java, a C++ lambda's `[…](…) {`),
    /// a method (`name(…) … {`), or any other block.
    fn header(&self, open: usize) -> (Bk, Option<String>) {
        let lang = self.lang;
        let Some(prev) = open.checked_sub(1) else { return (Bk::Plain, None) };
        let p = self.t[prev];
        // C as Kernighan and Ritchie wrote it: `int f(a, b) int a; char *b; {`.
        if lang == Lang::C && p.k == K::Semi {
            if let Some(name) = self.kr_name(open) { return (Bk::Fn, Some(name)); }
        }
        if p.k == K::Punct {
            let pt = self.text(prev);
            if pt == b"=>" && matches!(lang, Lang::Js | Lang::Ts | Lang::CSharp) {
                return (Bk::Fn, Some(self.arrow_name(prev)));
            }
            if pt == b"->" && lang == Lang::Java { return (Bk::Fn, Some(CLOSURE.into())); }
            if matches!(pt, b"|" | b"||") && lang == Lang::Rust { return (Bk::Fn, Some(CLOSURE.into())); }
        }
        if !matches!(lang, Lang::C | Lang::Cpp | Lang::Java | Lang::CSharp | Lang::Js | Lang::Ts | Lang::Swift | Lang::Kotlin | Lang::Rust) {
            return (Bk::Plain, None);
        }
        // Back to the statement's start: brackets skipped whole, generics' commas kept.
        let mut h: Vec<usize> = Vec::new();
        let mut j = open;
        let mut angle = 0u32;
        while j > 0 && h.len() < 64 {
            j -= 1;
            let x = self.t[j];
            match x.k {
                K::Semi | K::Open | K::Close | K::LParen | K::LBrack | K::Nl => break,
                K::RParen | K::RBrack => {
                    if self.mate[j] == NONE { break; }
                    h.push(j);
                    j = self.mate[j];
                    h.push(j);
                }
                K::Punct => {
                    let pt = self.text(j);
                    if pt == b">" { angle += 1; } else if pt == b"<" { angle = angle.saturating_sub(1); }
                    if pt == b"," && angle == 0 && matches!(lang, Lang::Js | Lang::Ts) { break; }
                    if matches!(pt, b"=" | b"=>") && angle == 0 { h.push(j); break; }
                    h.push(j);
                }
                _ => h.push(j),
            }
        }
        h.reverse();
        // Rust: a closure with a return type (`|x| -> T {`); anything else is a block (functions are `fn`).
        if lang == Lang::Rust {
            let closure = h.windows(2).any(|w| self.punct(w[1], b"->") && matches!(self.text(w[0]), b"|" | b"||"));
            return if closure { (Bk::Fn, Some(CLOSURE.into())) } else { (Bk::Plain, None) };
        }
        // A C++ lambda: `[captures](params) … {` or `[captures] {`.
        if lang == Lang::Cpp {
            let first_group = h.iter().position(|&k| self.t[k].k == K::LParen);
            let lambda = match first_group {
                Some(n) => n > 0 && self.t[h[n - 1]].k == K::RBrack,
                None => p.k == K::RBrack,
            };
            if lambda { return (Bk::Fn, Some(CLOSURE.into())); }
        }
        if h.iter().any(|&k| self.t[k].k == K::Word && matches!(self.text(k), b"class" | b"struct" | b"enum" | b"interface" | b"union"
            | b"namespace" | b"record" | b"new" | b"impl" | b"trait" | b"module" | b"object" | b"extern" | b"extends" | b"implements"))
            || h.iter().any(|&k| self.punct(k, b"=")) {
            return (Bk::Plain, None);
        }
        // The first bracket group a name stands before, decorators (`@Get(…)`) skipped.
        for (n, &k) in h.iter().enumerate() {
            if self.t[k].k != K::LParen { continue; }
            let mut w = n.checked_sub(1).map(|m| h[m]);
            // Generics: `name<T>(`.
            if let Some(g) = w.filter(|&g| self.punct(g, b">")) {
                let mut depth = 0i32;
                let mut m = h.iter().position(|&x| x == g).unwrap_or(0);
                loop {
                    let x = h[m];
                    if self.punct(x, b">") { depth += 1; }
                    if self.punct(x, b"<") { depth -= 1; if depth == 0 { break; } }
                    if m == 0 { break; }
                    m -= 1;
                }
                w = m.checked_sub(1).map(|m| h[m]).filter(|_| depth == 0);
            }
            let Some(w) = w else { continue };
            if self.t[w].k == K::RBrack && matches!(lang, Lang::Js | Lang::Ts) { return (Bk::Fn, Some("[computed]".into())); }
            if self.t[w].k != K::Word { continue; }
            if w > 0 && self.punct(w - 1, b"@") { continue; }
            let name = self.text(w);
            if matches!(name, b"if" | b"for" | b"while" | b"switch" | b"catch" | b"synchronized" | b"using" | b"lock" | b"fixed"
                | b"foreach" | b"with" | b"return" | b"sizeof" | b"typeof" | b"alignof" | b"decltype" | b"defined" | b"when" | b"assert"
                | b"await" | b"yield" | b"throw" | b"case" | b"do" | b"else" | b"delete" | b"static_assert" | b"guard" | b"checked" | b"unchecked") {
                return (Bk::Plain, None);
            }
            return (Bk::Fn, Some(String::from_utf8_lossy(name).into_owned()));
        }
        (Bk::Plain, None)
    }

    /// What a closure is given to, as its name when it is a unit of its own: the call it is an argument of
    /// (`app.get('/a', (c) => {` is `get('/a') callback`), else a closure.
    fn callback_name(&self, open: usize) -> String {
        let mut j = open;
        let mut steps = 0;
        while j > 0 && steps < 64 {
            j -= 1;
            steps += 1;
            match self.t[j].k {
                K::RParen | K::RBrack if self.mate[j] != NONE => j = self.mate[j],
                K::LParen => {
                    let Some(w) = j.checked_sub(1).filter(|&w| self.t[w].k == K::Word) else { break };
                    let first = self.t.get(j + 1).filter(|x| x.k == K::Str).map(|x| String::from_utf8_lossy(&self.s[x.start as usize..x.end as usize]).into_owned());
                    let callee = String::from_utf8_lossy(self.text(w)).into_owned();
                    return match first { Some(s) if s.len() <= 40 => format!("{callee}({s}) callback"), _ => format!("{callee}() callback") };
                }
                K::Semi | K::Open | K::Close => break,
                _ => {}
            }
        }
        CLOSURE.into()
    }

    /// The name of a K&R function whose body `open` is: back over its parameters' declarations (no `=`, no block) to
    /// a list of bare names in brackets after a name, the declarations starting right after it.
    fn kr_name(&self, open: usize) -> Option<String> {
        let mut j = open;
        let mut steps = 0;
        while j > 0 && steps < 200 {
            j -= 1;
            steps += 1;
            match self.t[j].k {
                K::RParen if self.mate[j] != NONE => {
                    let m = self.mate[j];
                    let starts_decls = self.t.get(j + 1).is_some_and(|x| x.k == K::Word);
                    let named = m > 0 && self.t[m - 1].k == K::Word && !matches!(self.text(m - 1), b"if" | b"for" | b"while" | b"switch" | b"return" | b"sizeof");
                    let bare = (m + 1..j).all(|k| self.t[k].k == K::Word || self.punct(k, b",")) && (m + 1..j).any(|k| self.t[k].k == K::Word);
                    if starts_decls && named && bare { return Some(String::from_utf8_lossy(self.text(m - 1)).into_owned()); }
                    j = m;
                }
                K::Open | K::Close => return None,
                K::Punct if self.text(j) == b"=" => return None,
                _ => {}
            }
        }
        None
    }

    /// An arrow function's name from what it is given to (`const name = (…) => {`, `name: (…) => {`), else a closure.
    /// A `:` after a bracket is the arrow's return type (`(a): T => {`), passed over.
    fn arrow_name(&self, arrow: usize) -> String {
        let mut j = arrow;
        let mut steps = 0;
        while j > 0 && steps < 32 {
            j -= 1;
            steps += 1;
            match self.t[j].k {
                K::RParen | K::RBrack if self.mate[j] != NONE => j = self.mate[j],
                K::Punct if matches!(self.text(j), b"=" | b":") => {
                    let before = j.checked_sub(1).map(|b| self.t[b]);
                    match before {
                        Some(b) if b.k == K::Word => return String::from_utf8_lossy(self.text(j - 1)).into_owned(),
                        _ if self.text(j) == b":" => {}
                        _ => return CLOSURE.into(),
                    }
                }
                K::Semi | K::Open | K::Close | K::LParen | K::LBrack => return CLOSURE.into(),
                K::Punct if self.text(j) == b"," => return CLOSURE.into(),
                _ => {}
            }
        }
        CLOSURE.into()
    }
}

/// What a word is to the brace languages' flow.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kw { If, Else, Loop, Switch, Catch, Jump, Label, Func, None }

fn keyword(lang: Lang, w: &[u8]) -> (Kw, Option<Pend>) {
    use Lang::*;
    let kw = match w {
        b"if" => Kw::If,
        b"guard" if lang == Swift => Kw::If,
        b"else" => Kw::Else,
        b"for" | b"while" => Kw::Loop,
        b"loop" if lang == Rust => Kw::Loop,
        b"foreach" if lang == CSharp => Kw::Loop,
        b"do" if matches!(lang, C | Cpp | Java | Js | Ts | CSharp | Kotlin) => return (Kw::Loop, Some(Pend::Do)),
        b"repeat" if lang == Swift => return (Kw::Loop, Some(Pend::Do)),
        b"switch" if lang != Rust => Kw::Switch,
        b"match" if lang == Rust => Kw::Switch,
        b"when" if lang == Kotlin => Kw::Switch,
        b"select" if lang == Go => Kw::Switch,
        b"catch" => Kw::Catch,
        b"goto" => Kw::Jump,
        b"break" | b"continue" => Kw::Label,
        b"fn" if lang == Rust => Kw::Func,
        b"func" if matches!(lang, Go | Swift) => Kw::Func,
        b"fun" if lang == Kotlin => Kw::Func,
        b"function" if matches!(lang, Js | Ts) => Kw::Func,
        _ => Kw::None,
    };
    let pend = (kw == Kw::Loop && w == b"for" && lang == Go).then_some(Pend::GoFor);
    (kw, pend)
}

/// Python: blocks by indentation. A logical line's first word says what it is; `if` elsewhere on a line is a
/// conditional expression (or a comprehension's filter), counted as a ternary.
fn python(src: &[u8], t: &[Tok]) -> Vec<Func> {
    struct Block { indent: u32, unit: Option<usize>, opened: bool, nest: u32 }
    let mut units = Units { funcs: Vec::new(), top: None, closures: Vec::new() };
    let mut stack: Vec<Block> = Vec::new();
    let text = |x: &Tok| &src[x.start as usize..x.end as usize];
    let mut i = 0;
    let mut last_line = 0;
    while i < t.len() {
        // One logical line: t[i..e].
        let e = t[i..].iter().position(|x| x.k == K::Nl).map_or(t.len(), |p| i + p);
        if e == i { i += 1; continue; }
        let first = t[i];
        let indent = column(src, first.start as usize);
        while stack.last().is_some_and(|b| b.indent >= indent) {
            if let Some(b) = stack.pop() { if b.opened { if let Some(u) = b.unit { units.funcs[u].end = last_line; } } }
        }
        let top = stack.last();
        let unit = top.and_then(|b| b.unit);
        let nest = top.map_or(0, |b| b.nest);
        let opens = t[e - 1].k == K::Punct && text(&t[e - 1]) == b":";
        let mut head = i;
        if text(&first) == b"async" { head += 1; }
        let w = if head < e && t[head].k == K::Word { text(&t[head]) } else { b"" };
        let mut block: Option<Block> = None;
        match w {
            b"if" | b"while" | b"for" | b"except" => {
                units.add(unit, 1 + nest, nest + 1, first.line);
                block = Some(Block { indent, unit, opened: false, nest: nest + 1 });
            }
            b"elif" | b"else" => {
                units.add(unit, 1, nest, first.line);
                block = Some(Block { indent, unit, opened: false, nest: nest + 1 });
            }
            b"match" if opens && e - head > 2 => {
                units.add(unit, 1 + nest, nest + 1, first.line);
                block = Some(Block { indent, unit, opened: false, nest: nest + 1 });
            }
            b"def" => {
                let name = t.get(head + 1).filter(|x| x.k == K::Word).map_or(CLOSURE.into(), |x| String::from_utf8_lossy(text(x)).into_owned());
                let u = units.open(name, first.line);
                block = Some(Block { indent, unit: Some(u), opened: true, nest: 0 });
            }
            _ => {}
        }
        // Within the line: conditional expressions, boolean runs, recursion.
        let mut bool_op: Option<&[u8]> = None;
        // Recursion is the function's own name called in it: on a `def` line, the unit is the new one and its name
        // (the word after `def`) is not a call.
        let declared = block.as_ref().filter(|b| b.opened).and_then(|b| b.unit);
        let own = declared.or(unit);
        let from = if declared.is_some() { head + 2 } else { head + 1 };
        for k in from..e {
            let x = t[k];
            match (x.k, text(&x)) {
                (K::Word, b"if") => units.add(unit, 1 + nest, nest + 1, x.line),
                (K::Word, op @ (b"and" | b"or")) => { if bool_op != Some(op) { units.add(unit, 1, nest, x.line); } bool_op = Some(op); }
                (K::Word, b"lambda") => {}
                (K::LParen | K::RParen | K::LBrack | K::RBrack | K::Open | K::Close, _) => bool_op = None,
                (K::Punct, b",") => bool_op = None,
                (K::Word, name) => {
                    if let Some(u) = own {
                        if units.funcs[u].name.as_bytes() == name && t.get(k + 1).is_some_and(|n| n.k == K::LParen) {
                            units.add(Some(u), 1, nest, x.line);
                        }
                    }
                }
                _ => {}
            }
        }
        last_line = t[e - 1].line;
        if let Some(b) = block { if opens { stack.push(b); } else if b.opened { if let Some(u) = b.unit { units.funcs[u].end = last_line; } } }
        else if opens { stack.push(Block { indent, unit, opened: false, nest }); }
        i = e + 1;
    }
    for b in stack { if b.opened { if let Some(u) = b.unit { units.funcs[u].end = last_line; } } }
    units.done()
}

/// The column a byte is at on its line (a tab to the next multiple of 8, as Python counts).
fn column(src: &[u8], at: usize) -> u32 {
    let start = src[..at].iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1);
    src[start..at].iter().fold(0u32, |c, &b| if b == b'\t' { (c / 8 + 1) * 8 } else { c + 1 })
}

/// The shell: `if`…`fi`, the loops…`done`, `case`…`esac` nest; `name() {` and `function name` are functions.
fn shell(src: &[u8], t: &[Tok]) -> Vec<Func> {
    #[derive(Clone, Copy, PartialEq)]
    enum Sk { If, Loop, Case, Brace, Fn }
    struct Lv { k: Sk, unit: Option<usize>, nest: u32 }
    let mut units = Units { funcs: Vec::new(), top: None, closures: Vec::new() };
    let mut stack: Vec<Lv> = Vec::new();
    let text = |x: &Tok| &src[x.start as usize..x.end as usize];
    let mut command = true;
    let mut bool_op: Option<&[u8]> = None;
    let mut fn_name: Option<(String, u32)> = None;
    for (i, x) in t.iter().enumerate() {
        let top = stack.last();
        let unit = top.and_then(|l| l.unit);
        let nest = top.map_or(0, |l| l.nest);
        let at_command = std::mem::replace(&mut command, false);
        match (x.k, text(x)) {
            (K::Nl | K::Semi, _) => { command = true; bool_op = None; }
            (K::Punct, op @ (b"&&" | b"||")) => {
                if bool_op != Some(op) { units.add(unit, 1, nest, x.line); }
                bool_op = Some(op);
                command = true;
            }
            (K::Punct, b"|" | b"!") | (K::LParen, _) => command = true,
            (K::Word, w) if at_command => {
                match w {
                    b"if" | b"while" | b"until" | b"for" | b"select" | b"case" => {
                        units.add(unit, 1 + nest, nest + 1, x.line);
                        let k = match w { b"if" => Sk::If, b"case" => Sk::Case, _ => Sk::Loop };
                        stack.push(Lv { k, unit, nest: nest + 1 });
                    }
                    b"elif" | b"else" => units.add(unit, 1, nest.saturating_sub(1), x.line),
                    b"fi" | b"done" | b"esac" => {
                        let want = match w { b"fi" => Sk::If, b"done" => Sk::Loop, _ => Sk::Case };
                        if let Some(p) = stack.iter().rposition(|l| l.k == want) { stack.truncate(p); }
                    }
                    b"then" | b"do" | b"in" => command = true,
                    b"function" => {
                        if let Some(n) = t.get(i + 1).filter(|n| n.k == K::Word) { fn_name = Some((String::from_utf8_lossy(text(n)).into_owned(), x.line)); }
                    }
                    _ => {
                        // name() {
                        if t.get(i + 1).is_some_and(|n| n.k == K::LParen) && t.get(i + 2).is_some_and(|n| n.k == K::RParen) {
                            fn_name = Some((String::from_utf8_lossy(w).into_owned(), x.line));
                        }
                    }
                }
            }
            (K::Open, _) => {
                command = true;
                if let Some((name, line)) = fn_name.take() {
                    let u = units.open(name, line);
                    stack.push(Lv { k: Sk::Fn, unit: Some(u), nest: 0 });
                } else {
                    stack.push(Lv { k: Sk::Brace, unit, nest });
                }
            }
            (K::Close, _) => {
                if let Some(p) = stack.iter().rposition(|l| matches!(l.k, Sk::Brace | Sk::Fn)) {
                    if stack[p].k == Sk::Fn { if let Some(u) = stack[p].unit { units.funcs[u].end = x.line; } }
                    stack.truncate(p);
                }
            }
            _ => {}
        }
    }
    let last_line = t.last().map_or(0, |t| t.line);
    for l in stack { if l.k == Sk::Fn { if let Some(u) = l.unit { units.funcs[u].end = last_line; } } }
    units.done()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::lex::lex;

    fn funcs(src: &str, lang: Lang) -> Vec<(String, u32)> {
        let l = lex(src.as_bytes(), lang);
        shape(src.as_bytes(), &l, lang).funcs.into_iter().map(|f| (f.name, f.complexity)).collect()
    }
    fn one(src: &str, lang: Lang) -> u32 {
        let f = funcs(src, lang);
        assert_eq!(f.len(), 1, "{f:?}");
        f[0].1
    }
    fn total(src: &str, lang: Lang) -> u32 { funcs(src, lang).iter().map(|f| f.1).sum() }

    #[test]
    fn campbells_examples_score_as_in_the_paper() {
        let sum_of_primes = "int sumOfPrimes(int max) {\n  int total = 0;\n  OUT: for (int i = 1; i <= max; ++i) {\n    for (int j = 2; j < i; ++j) {\n      if (i % j == 0) {\n        continue OUT;\n      }\n    }\n    total += i;\n  }\n  return total;\n}\n";
        assert_eq!(funcs(sum_of_primes, Lang::Java), [("sumOfPrimes".to_string(), 7)]);
        let get_words = "String getWords(int number) {\n  switch (number) {\n    case 1: return \"one\";\n    case 2: return \"a couple\";\n    default: return \"lots\";\n  }\n}\n";
        assert_eq!(funcs(get_words, Lang::Java), [("getWords".to_string(), 1)]);
        let add_version = r#"private void addVersion(final Entry entry, final Transaction txn)
    throws PersistitInterruptedException, RollbackException {
  final TransactionIndex ti = _persistit.getTransactionIndex();
  while (true) {
    try {
      synchronized (this) {
        if (frst != null) {
          if (frst.getVersion() > entry.getVersion()) {
            throw new RollbackException();
          }
          if (txn.isActive()) {
            for (Entry e = frst; e != null; e = e._previous) {
              final long version = e.getVersion();
              final long depends = ti.wwDependency(version, txn.getTransactionStatus(), 0);
              if (depends == TIMED_OUT) {
                throw new WWRetryException(version);
              }
              if (depends != 0
                  && depends != ABORTED) {
                throw new RollbackException();
              }
            }
          }
        }
        entry.setPrevious(frst);
        frst = entry;
        break;
      }
    } catch (final WWRetryException re) {
      try {
        final long depends = _persistit.getTransactionIndex()
            .wwDependency(re.getVersionHandle(),txn.getTransactionStatus(),
                SharedResourcePool.DEFAULT_MAX_WAIT_TIME);
        if (depends != 0 && depends != ABORTED) {
          throw new RollbackException();
        }
      } catch (final InterruptedException ie) {
        throw new PersistitInterruptedException(ie);
      }
    } catch (final InterruptedException ie) {
      throw new PersistitInterruptedException(ie);
    }
  }
}
"#;
        assert_eq!(funcs(add_version, Lang::Java), [("addVersion".to_string(), 35)]);
    }

    #[test]
    fn functions_are_found_and_named_in_each_language() {
        assert_eq!(funcs("fn a() {}\nimpl X {\n  pub fn b<T, U>(&self) -> T where T: Fn(u8), U: Clone { if x {} }\n}\ntrait Y { fn c(); fn d() {} }", Lang::Rust),
            [("a".into(), 0), ("b".into(), 1), ("d".into(), 0)]);
        assert_eq!(funcs("func (r *T) Name(x int) (int, error) { if x > 0 { return 1, nil }; return 0, nil }\nfunc main() { go func() { for {} }() }", Lang::Go),
            [("Name".into(), 1), ("main".into(), 2)]);
        assert_eq!(funcs("static int add(int a, int b) { return a > b ? a : b; }\nstruct s { int x; };\nint main(void) { if (add(1, 2)) { return 1; } }", Lang::C),
            [("add".into(), 1), ("main".into(), 1)]);
        assert_eq!(funcs("class A extends B {\n  constructor(x) { super(x); }\n  async get(id) { return id ?? 0; }\n  *gen() { yield 1; }\n}\nexport const f = async (a) => { if (a) {} };\nfunction g() { return [1].map((x) => { if (x) { return 1 } }) }\nconst o = { m(x) { if (x) {} }, n: function () { while (1) {} } };", Lang::Js),
            [("constructor".into(), 0), ("get".into(), 0), ("gen".into(), 0), ("f".into(), 1), ("g".into(), 2), ("m".into(), 1), ("n".into(), 1)]);
        assert_eq!(funcs("export function f(a?: number): Promise<void> { return a ? x : y; }\nclass C { @Get(':id') find(@Param('id') id: string): T { if (id) {} } }", Lang::Ts),
            [("f".into(), 1), ("find".into(), 1)]);
        assert_eq!(funcs("template <typename A, typename B> int f(A a) { auto g = [&](int x) { if (x) {} }; }\nFoo::Foo(int x) : a(x), b(2) { if (x) {} }", Lang::Cpp),
            [("f".into(), 2), ("Foo".into(), 1)]);
        assert_eq!(funcs("fun <T> List<T>.second(): T { if (x) {}; return this[1] }\nfun main() { list.forEach { if (it) {} } }", Lang::Kotlin),
            [("second".into(), 1), ("main".into(), 1)]);
        assert_eq!(funcs("def a(x):\n    if x:\n        return [y for y in x if y]\n    elif x is None:\n        pass\n    else:\n        def inner():\n            while True:\n                pass\n    return a(x) if x and y or z else 0\n\nclass K:\n    async def m(self):\n        try:\n            pass\n        except E:\n            pass\n", Lang::Python),
            [("a".into(), 1 + 2 + 1 + 1 + 1 + 1 + 1 + 1), ("inner".into(), 1), ("m".into(), 1)]);
        assert_eq!(funcs("f() {\n  if [ -n \"$1\" ]; then\n    for x in a b; do echo $x; done\n  elif [ x ]; then :\n  else :\n  fi\n}\nfunction g {\n  case $1 in a) : ;; esac\n}\n[ -f x ] || exit 1\n", Lang::Shell),
            [("f".into(), 1 + 2 + 1 + 1), ("g".into(), 1), (TOP.into(), 1)]);
    }

    #[test]
    fn a_long_closure_is_a_unit_of_its_own_and_a_short_one_part_of_its_function() {
        let pad = "    log(1);\n".repeat(LONG as usize);
        let src = format!("export function repos(app) {{\n  app.get('/a', async (c) => {{\n    if (a) {{\n      for (const x of y) {{\n        if (x) {{}}\n      }}\n    }}\n{pad}  }});\n  items.forEach(x => {{ if (x) {{}} }});\n}}\n");
        assert_eq!(funcs(&src, Lang::Js), [("repos".into(), 2), ("get('/a') callback".into(), 1 + 2 + 3)]);
        // Long closures in long closures: each at its own nesting; the function keeps only its own.
        let inner = format!("    run(() => {{\n      if (b) {{}}\n{pad}    }});\n");
        let src = format!("function f() {{\n  outer(() => {{\n    if (a) {{}}\n{inner}{pad}  }});\n  if (c) {{}}\n}}\n");
        assert_eq!(funcs(&src, Lang::Js), [("f".into(), 1), ("outer() callback".into(), 1), ("run() callback".into(), 1)]);
        // A short one stays part of its function, a level deeper.
        let short = "function f() {\n  outer(() => {\n    if (a) {}\n  });\n}\n";
        assert_eq!(funcs(short, Lang::Js), [("f".into(), 2)]);
        // A function declared in a long closure keeps what is its own; the closure gives back only its own.
        let decl = format!("function f() {{\n  outer(() => {{\n    function g() {{ if (b) {{}} if (c) {{}} }}\n    if (a) {{}}\n{pad}  }});\n}}\n");
        assert_eq!(funcs(&decl, Lang::Js), [("f".into(), 0), ("outer() callback".into(), 1), ("g".into(), 2)]);
    }

    #[test]
    fn kernighan_and_ritchie_functions() {
        assert_eq!(funcs("int g(a, f) int a; int (*f)(); { if (a) return 1; return 0; }\nstatic char *h(s) char *s; { return s; }\nint x; int y; { }", Lang::C),
            [("g".into(), 1), ("h".into(), 0)]);
    }

    #[test]
    fn nesting_else_and_boolean_runs() {
        let f = |body: &str| one(&format!("int f() {{ {body} }}"), Lang::C);
        assert_eq!(f("if (a) {} else if (b) {} else {}"), 3);
        assert_eq!(f("if (a) { if (b) { if (c) {} } }"), 1 + 2 + 3);
        assert_eq!(f("if (a && b && c) {}"), 2);
        assert_eq!(f("if (a && b || c && d) {}"), 4);
        assert_eq!(f("if (a && (b || c)) {}"), 3);
        assert_eq!(f("do { if (a) {} } while (x);"), 1 + 2);
        assert_eq!(f("while (a) for (;;) {}"), 2, "braceless bodies do not nest");
        assert_eq!(f("goto out; out: return;"), 1);
        assert_eq!(f("return f();"), 1, "recursion");
        assert_eq!(one("fn f(x: Option<u8>) { 'a: loop { match x { Some(y) if y > 0 => { break 'a; } _ => {} } } }", Lang::Rust), 1 + 2 + 3 + 1);
        assert_eq!(one("fn f() { let g = move || { if a || b {} }; v.iter().map(|x| { if x {} }); }", Lang::Rust), 2 + 1 + 2);
        assert_eq!(one("fn f() { let Some(x) = y else { return }; }", Lang::Rust), 1);
        // `impl … for …` and `for<'a>` are no loops; a loop after a label or in an arm is.
        assert_eq!(funcs("impl Flag for After { fn f(&self) -> bool { 'a: for x in y { for z in x {} } } }\nfn g<F>(f: F) where F: for<'a> Fn(&'a u8) { let _ = match x { _ => for _ in y {} }; }", Lang::Rust),
            [("f".into(), 1 + 2), ("g".into(), 1 + 2)]);
        assert_eq!(one("function f() { p.catch((e) => e).then(x => { if (x) {} }); }", Lang::Js), 2);
        assert_eq!(one("function f(a) { const r = /{/; const s = `${ a ? 1 : 2 }`; }", Lang::Js), 1);
        assert_eq!(one("function f(o) { return o?.a ?? o!.b; }", Lang::Ts), 0);
    }

    #[test]
    fn what_is_not_code_never_counts() {
        let plain = "int f(int a) { if (a) { return 1; } return 0; }";
        let noisy = "int f(int a) /* { if */ { // while (x) {\n if (a) { const char *s = \"if (b) { for\"; char c = '{'; return 1; } return 0; }";
        assert_eq!(total(noisy, Lang::C), total(plain, Lang::C));
        let plain = "fn f(a: u8) { if a > 0 { g() } }";
        let noisy = "fn f(a: u8) { /* if { /* } */ */ if a > 0 { let _ = r#\"} if {\"#; let _: &'static str = \"}\"; g() } }";
        assert_eq!(total(noisy, Lang::Rust), total(plain, Lang::Rust));
    }
}
