//! Code as tokens, for the plan: words, literals and the punctuation that shapes code, with comments, strings and
//! the like taken whole, so a `{` or an `if` inside them is never read as code. One pass over the bytes, never
//! backwards, so its time is linear in the file whatever is in it (bytes that are not UTF-8, a quote never closed,
//! a hundred thousand braces); a construct left open at the end of the file ends there.
//!
//! What a family of languages writes differently is all here: C-like ones (braces), Python (indentation) and the
//! shell (keywords that open and close). Within a family the languages differ in their literals: Rust's lifetimes
//! and raw strings, JavaScript's regular expressions and template literals, C++'s raw strings, Go's backquotes,
//! the shell's here-documents.

#![forbid(unsafe_code)]

/// A language the plan reads, by what it is written in.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Lang { C, Cpp, Rust, Js, Ts, Go, Java, CSharp, Kotlin, Swift, Python, Shell }

/// How a language's blocks are written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family { Brace, Indent, Shell }

impl Lang {
    /// The language of a file, by its name, or (for one without a known extension) its first line's `#!`.
    pub fn of(path: &str, head: &[u8]) -> Option<Lang> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        let by_ext = match ext.as_deref() {
            Some("c" | "h") => Some(Lang::C),
            Some("cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" | "ipp" | "tcc" | "inl") => Some(Lang::Cpp),
            Some("rs") => Some(Lang::Rust),
            Some("js" | "mjs" | "cjs" | "jsx") => Some(Lang::Js),
            Some("ts" | "mts" | "cts" | "tsx") => Some(Lang::Ts),
            Some("go") => Some(Lang::Go),
            Some("java") => Some(Lang::Java),
            Some("cs") => Some(Lang::CSharp),
            Some("kt" | "kts") => Some(Lang::Kotlin),
            Some("swift") => Some(Lang::Swift),
            Some("py" | "pyi") => Some(Lang::Python),
            Some("sh" | "bash" | "ksh" | "zsh") => Some(Lang::Shell),
            _ => None,
        };
        if by_ext.is_some() || ext.is_some() && !name.starts_with('.') { return by_ext; }
        let line = head.split(|&b| b == b'\n').next().unwrap_or_default();
        let line = String::from_utf8_lossy(line);
        let bang = line.strip_prefix("#!")?;
        let mut words = bang.split_whitespace();
        let mut prog = words.next().unwrap_or_default().rsplit('/').next().unwrap_or_default();
        if prog == "env" { prog = words.find(|w| !w.starts_with('-')).unwrap_or_default(); }
        match prog {
            "sh" | "bash" | "dash" | "ash" | "ksh" | "zsh" => Some(Lang::Shell),
            p if p.starts_with("python") => Some(Lang::Python),
            "node" | "deno" | "bun" => Some(Lang::Js),
            _ => None,
        }
    }

    pub fn family(self) -> Family {
        match self { Lang::Python => Family::Indent, Lang::Shell => Family::Shell, _ => Family::Brace }
    }

    /// The name it is said by.
    pub fn name(self) -> &'static str {
        match self {
            Lang::C => "C", Lang::Cpp => "C++", Lang::Rust => "Rust", Lang::Js => "JavaScript", Lang::Ts => "TypeScript",
            Lang::Go => "Go", Lang::Java => "Java", Lang::CSharp => "C#", Lang::Kotlin => "Kotlin", Lang::Swift => "Swift",
            Lang::Python => "Python", Lang::Shell => "shell",
        }
    }

    /// Whether `"…"` may run past the end of its line (elsewhere a line's end ends one left open: it was a mistake,
    /// and the next line is code again).
    fn quotes_span_lines(self) -> bool { matches!(self, Lang::Rust | Lang::Shell) }
    /// Whether `'…'` is a character (one), rather than a string.
    fn quote_is_char(self) -> bool { matches!(self, Lang::C | Lang::Cpp | Lang::Rust | Lang::Go | Lang::Java | Lang::CSharp | Lang::Kotlin) }
    fn hash_comments(self) -> bool { matches!(self, Lang::Python | Lang::Shell) }
    fn slash_comments(self) -> bool { !self.hash_comments() }
    fn triple_quotes(self) -> bool { matches!(self, Lang::Python | Lang::Java | Lang::Kotlin | Lang::Swift | Lang::CSharp) }
}

/// What a token is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum K {
    /// A name or a keyword (also a Rust lifetime, a shell word).
    Word,
    Num,
    /// A string, a character, a regular expression: taken whole.
    Str,
    /// `{` and `}`.
    Open,
    Close,
    /// `(` `)` `[` `]`.
    LParen,
    RParen,
    LBrack,
    RBrack,
    /// `;` (also the shell's `;;`).
    Semi,
    /// Every other piece of punctuation, its longer forms whole (`&&`, `||`, `=>`, `->`, `::`, `?.`, `??`).
    Punct,
    /// The end of a logical line: Python's (outside brackets, not continued), the shell's, and a C preprocessor
    /// line's.
    Nl,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Tok { pub k: K, pub start: u32, pub end: u32, pub line: u32 }

/// A file's tokens, and the words of its comments and strings (where an issue's words are often found).
pub struct Lexed {
    pub toks: Vec<Tok>,
    /// Byte ranges of comments and of strings' insides, in order.
    pub prose: Vec<(u32, u32)>,
    /// Lines, counted as a person does (a last line without its newline is one).
    pub lines: u32,
}

impl Lexed {
    pub fn text<'a>(&self, src: &'a [u8], t: &Tok) -> &'a [u8] { &src[t.start as usize..t.end as usize] }
}

/// Multi-character punctuation, the longest first where one starts another.
const OPS: [&[u8]; 16] = [b"...", b"&&", b"||", b"=>", b"->", b"::", b"?.", b"??", b"==", b"!=", b"<=", b">=", b"..", b"<<", b"++", b"--"];

fn is_word_byte(b: u8) -> bool { b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80 }

/// What the lexer is inside of, besides plain code.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Code inside a JavaScript template's `${…}`, with how many `{` are open in it.
    Interp(u32),
}

pub fn lex(src: &[u8], lang: Lang) -> Lexed {
    let mut l = Lexer { s: src, i: 0, lang, toks: Vec::new(), prose: Vec::new(), line: 1, nl_at: 0, depth: 0, modes: Vec::new(), heredocs: Vec::new(), pp: false, pp_frames: Vec::new() };
    // A byte-order mark is not code.
    if src.starts_with(&[0xEF, 0xBB, 0xBF]) { l.i = 3; }
    l.run();
    let lines = src.iter().filter(|&&b| b == b'\n').count() as u32 + u32::from(!src.is_empty() && src.last() != Some(&b'\n'));
    Lexed { toks: l.toks, prose: l.prose, lines }
}

struct Lexer<'a> {
    s: &'a [u8],
    i: usize,
    lang: Lang,
    toks: Vec<Tok>,
    prose: Vec<(u32, u32)>,
    /// The line at `nl_at` (lines are counted as the lexer passes them, never again).
    line: u32,
    nl_at: usize,
    /// Brackets open (Python's logical lines end only outside them).
    depth: u32,
    modes: Vec<Mode>,
    /// The shell's here-documents begun on this line: each one's word, and whether its lines may start with tabs.
    heredocs: Vec<(Vec<u8>, bool)>,
    /// On a C preprocessor include line.
    pp: bool,
    /// The #if branches open: whether each one's branch now is passed over.
    pp_frames: Vec<bool>,
}

impl Lexer<'_> {
    fn at(&self, k: usize) -> u8 { self.s.get(self.i + k).copied().unwrap_or(0) }

    /// The line of the byte at `pos` (never before one asked already).
    fn line_of(&mut self, pos: usize) -> u32 {
        let pos = pos.min(self.s.len());
        if pos > self.nl_at {
            self.line += self.s[self.nl_at..pos].iter().filter(|&&b| b == b'\n').count() as u32;
            self.nl_at = pos;
        }
        self.line
    }

    fn push(&mut self, k: K, start: usize, end: usize) {
        let line = self.line_of(start);
        self.toks.push(Tok { k, start: start as u32, end: end as u32, line });
    }

    fn prose(&mut self, start: usize, end: usize) {
        if end > start { self.prose.push((start as u32, end as u32)); }
    }

    /// The last token's kind and text, if any.
    fn last(&self) -> Option<(K, &[u8])> {
        self.toks.last().map(|t| (t.k, &self.s[t.start as usize..t.end as usize]))
    }

    fn run(&mut self) {
        let fam = self.lang.family();
        while self.i < self.s.len() {
            let c = self.s[self.i];
            match c {
                b'\n' => {
                    self.i += 1;
                    if !self.heredocs.is_empty() { self.heredoc_bodies(); }
                    if std::mem::take(&mut self.pp) { self.push(K::Nl, self.i - 1, self.i); }
                    if fam != Family::Brace && self.depth == 0 && !matches!(self.last(), Some((K::Nl, _)) | None) {
                        self.push(K::Nl, self.i - 1, self.i);
                    }
                }
                b' ' | b'\t' | b'\r' | 0x0C | 0x0B => self.i += 1,
                b'\\' if matches!(self.at(1), b'\n' | b'\r') => {
                    // A line continued: no logical end here.
                    self.i += if self.at(1) == b'\r' && self.at(2) == b'\n' { 3 } else { 2 };
                }
                b'#' if self.lang.hash_comments() && self.hash_starts_comment() => self.line_comment(),
                b'/' if self.lang.slash_comments() && self.at(1) == b'/' => self.line_comment(),
                b'/' if self.lang.slash_comments() && self.at(1) == b'*' => self.block_comment(),
                b'/' if matches!(self.lang, Lang::Js | Lang::Ts) && self.regex_may_start() => self.regex(),
                b'"' | b'\'' | b'`' => self.quoted(),
                b'{' => {
                    if let Some(Mode::Interp(n)) = self.modes.last_mut() { *n += 1; }
                    // Python's logical lines go on inside braces as inside brackets (the shell's braces hold commands).
                    if self.lang == Lang::Python { self.depth += 1; }
                    self.punct(K::Open, 1);
                }
                b'}' => {
                    if self.lang == Lang::Python { self.depth = self.depth.saturating_sub(1); }
                    match self.modes.last().copied() {
                        Some(Mode::Interp(0)) => { self.modes.pop(); self.i += 1; self.template(); }
                        Some(Mode::Interp(n)) => { if let Some(Mode::Interp(m)) = self.modes.last_mut() { *m = n - 1; } self.punct(K::Close, 1); }
                        None => self.punct(K::Close, 1),
                    }
                }
                b'(' => { self.depth += 1; self.punct(K::LParen, 1) }
                b')' => { self.depth = self.depth.saturating_sub(1); self.punct(K::RParen, 1) }
                b'[' => { self.depth += 1; self.punct(K::LBrack, 1) }
                b']' => { self.depth = self.depth.saturating_sub(1); self.punct(K::RBrack, 1) }
                b';' => {
                    let n = if self.lang == Lang::Shell && self.at(1) == b';' { 2 } else { 1 };
                    self.punct(K::Semi, n);
                    if fam == Family::Shell { self.push(K::Nl, self.i, self.i); }
                }
                b'0'..=b'9' => self.number(),
                b'$' if self.lang == Lang::Shell => self.shell_dollar(),
                b'<' if self.lang == Lang::Shell && self.at(1) == b'<' && self.at(2) != b'<' => self.heredoc_start(),
                c if is_word_byte(c) => self.word(),
                // A C preprocessor line: an include is read (it says what the file uses) and ends where its line does,
                // though no `;` ends it; any other directive is not the code's (a macro's body is not a function's,
                // `#if` and `#else` are not decisions), and of #if's branches only the first is read, as a compiler
                // reads one: braces the branches each open would not balance otherwise.
                b'#' if matches!(self.lang, Lang::C | Lang::Cpp) && self.at_line_start() => {
                    let w = self.directive();
                    if matches!(w.as_slice(), b"include" | b"import" | b"include_next") {
                        self.pp = true;
                        self.punct(K::Punct, 1);
                    } else {
                        self.branch(&w);
                        self.rest_of_line();
                        if self.skipping() { self.skip_branches(); }
                    }
                }
                _ => {
                    let n = OPS.iter().find(|op| self.s[self.i..].starts_with(op)).map_or(1, |op| op.len());
                    self.punct(K::Punct, n);
                }
            }
        }
        // Here-documents whose bodies never came: nothing more to read.
    }

    /// Whether only spaces are before `self.i` on its line.
    fn at_line_start(&self) -> bool {
        self.s[..self.i].iter().rev().take_while(|&&b| b != b'\n').all(|&b| b == b' ' || b == b'\t')
    }

    /// The directive of the preprocessor line at `self.i` (its `#`): the word after it.
    fn directive(&self) -> Vec<u8> {
        let mut j = self.i + 1;
        while matches!(self.s.get(j), Some(b' ' | b'\t')) { j += 1; }
        let start = j;
        while self.s.get(j).is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_') { j += 1; }
        self.s[start..j].to_vec()
    }

    /// #if's branches: a new one opens, the first is read, the others are passed over, #endif closes.
    fn branch(&mut self, w: &[u8]) {
        match w {
            b"if" | b"ifdef" | b"ifndef" => self.pp_frames.push(false),
            b"elif" | b"else" | b"elifdef" | b"elifndef" => { if let Some(f) = self.pp_frames.last_mut() { *f = true; } }
            b"endif" => { self.pp_frames.pop(); }
            _ => {}
        }
    }

    fn skipping(&self) -> bool { self.pp_frames.iter().any(|&f| f) }

    /// To the end of this logical line (continued lines with it, a comment begun on it whole), as prose.
    fn rest_of_line(&mut self) {
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != b'\n' {
            match self.s[self.i] {
                b'\\' if matches!(self.at(1), b'\n' | b'\r') => self.i += if self.at(1) == b'\r' && self.at(2) == b'\n' { 3 } else { 2 },
                b'/' if self.at(1) == b'*' => { let at = self.i; self.block_comment(); if self.i == at { self.i += 1; } }
                _ => self.i += 1,
            }
        }
        self.prose(start, self.i);
    }

    /// Lines of a branch not read, to the directive that ends the passing over (its line passed over too).
    fn skip_branches(&mut self) {
        while self.i < self.s.len() && self.skipping() {
            // At a line's end: on to the next line's first non-space.
            if self.s[self.i] == b'\n' { self.i += 1; continue; }
            while matches!(self.s.get(self.i), Some(b' ' | b'\t' | b'\r')) { self.i += 1; }
            if self.s.get(self.i) == Some(&b'#') {
                let w = self.directive();
                self.branch(&w);
            }
            self.rest_of_line();
        }
    }

    fn punct(&mut self, k: K, n: usize) {
        let start = self.i;
        self.i = (self.i + n).min(self.s.len());
        self.push(k, start, self.i);
    }

    /// The shell's `#` starts a comment only where a word would start; Python's always.
    fn hash_starts_comment(&self) -> bool {
        self.lang == Lang::Python || self.i == 0 || matches!(self.s[self.i - 1], b' ' | b'\t' | b'\n' | b';' | b'(' | b'&' | b'|')
    }

    fn line_comment(&mut self) {
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != b'\n' { self.i += 1; }
        self.prose(start, self.i);
    }

    /// `/* … */`, nested in Rust (and Swift, Kotlin), flat elsewhere.
    fn block_comment(&mut self) {
        let start = self.i;
        let nests = matches!(self.lang, Lang::Rust | Lang::Swift | Lang::Kotlin);
        let mut open = 0u32;
        while self.i < self.s.len() {
            if self.s[self.i] == b'/' && self.at(1) == b'*' && (nests || open == 0) { open += 1; self.i += 2; continue; }
            if self.s[self.i] == b'*' && self.at(1) == b'/' {
                self.i += 2;
                open -= 1;
                if open == 0 { break; }
                continue;
            }
            self.i += 1;
        }
        self.prose(start, self.i);
    }

    /// Where a `/` starts a regular expression rather than divides: where a value is expected (after an operator, an
    /// opening bracket, a comma, nothing, or a word like `return`), never after a value.
    fn regex_may_start(&self) -> bool {
        if matches!(self.at(1), b'/' | b'*') { return false; }
        match self.last() {
            None => true,
            Some((K::Word, w)) => matches!(w, b"return" | b"typeof" | b"instanceof" | b"in" | b"of" | b"new" | b"delete" | b"void" | b"throw" | b"case" | b"do" | b"else" | b"yield" | b"await"),
            Some((K::Num | K::Str | K::RParen | K::RBrack | K::Close, _)) => false,
            Some((K::Punct, p)) => !matches!(p, b"++" | b"--"),
            Some(_) => true,
        }
    }

    /// `/…/flags`: to its closing `/` outside a class (`[…]`), past escapes; a line's end first means it was a
    /// division after all, and only the `/` is taken.
    fn regex(&mut self) {
        let start = self.i;
        let mut j = self.i + 1;
        let mut class = false;
        while j < self.s.len() {
            match self.s[j] {
                b'\\' => j += 2,
                b'\n' => { self.punct(K::Punct, 1); return; }
                b'[' => { class = true; j += 1; }
                b']' => { class = false; j += 1; }
                b'/' if !class => break,
                _ => j += 1,
            }
        }
        if j >= self.s.len() { self.punct(K::Punct, 1); return; }
        j += 1;
        while j < self.s.len() && self.s[j].is_ascii_alphabetic() { j += 1; }
        self.prose(start + 1, j);
        self.i = j;
        self.push(K::Str, start, j);
    }

    fn number(&mut self) {
        let start = self.i;
        let digit_sep = matches!(self.lang, Lang::C | Lang::Cpp);
        while self.i < self.s.len() {
            let b = self.s[self.i];
            // Digits and letters, a decimal point before a digit (not Rust's `..`), an exponent's sign, C++'s `'`.
            let part = b.is_ascii_alphanumeric() || b == b'_'
                || b == b'.' && self.at(1) != b'.' && self.at(1).is_ascii_digit()
                || matches!(b, b'+' | b'-') && matches!(self.s[self.i - 1], b'e' | b'E' | b'p' | b'P') && !self.s[start..self.i].starts_with(b"0x")
                || b == b'\'' && digit_sep && self.at(1).is_ascii_alphanumeric();
            if !part { break; }
            self.i += 1;
        }
        self.push(K::Num, start, self.i);
    }

    fn word(&mut self) {
        let start = self.i;
        while self.i < self.s.len() && is_word_byte(self.s[self.i]) { self.i += 1; }
        let w = &self.s[start..self.i];
        let next = self.at(0);
        // Literals a prefix opens: Rust's r"…" r#"…"# b"…" br"…" c"…" b'…'; C++'s R"d(…)d"; Python's r'…' f"…" and
        // the like; C#'s @"…" is a `@` before the quote, read in quoted().
        match self.lang {
            Lang::Rust if matches!(w, b"r" | b"br" | b"cr") && matches!(next, b'"' | b'#') => {
                let hashes = self.s[self.i..].iter().take_while(|&&b| b == b'#').count();
                if self.s.get(self.i + hashes) == Some(&b'"') { self.i += hashes; return self.rust_raw(start, hashes); }
                if w == b"r" && hashes == 1 {
                    // r#ident: a raw identifier.
                    self.i += 1;
                    while self.i < self.s.len() && is_word_byte(self.s[self.i]) { self.i += 1; }
                }
            }
            Lang::Rust if matches!(w, b"b" | b"c") && matches!(next, b'"' | b'\'') => return self.quoted_from(start),
            Lang::Cpp if matches!(w, b"R" | b"LR" | b"uR" | b"UR" | b"u8R") && next == b'"' => return self.cpp_raw(start),
            Lang::Cpp | Lang::C if matches!(w, b"L" | b"u" | b"U" | b"u8") && matches!(next, b'"' | b'\'') => return self.quoted_from(start),
            Lang::Python if w.len() <= 2 && w.iter().all(|b| b"rRbBuUfF".contains(b)) && matches!(next, b'"' | b'\'') => return self.quoted_from(start),
            _ => {}
        }
        self.push(K::Word, start, self.i);
    }

    fn quoted(&mut self) { self.quoted_from(self.i) }

    /// A quoted literal starting at its quote (`self.i`), `start` before its prefix if it has one.
    fn quoted_from(&mut self, start: usize) {
        let q = self.s[self.i];
        let lang = self.lang;
        // Three of the quote: to the next three (Python, Java's text blocks, Kotlin, Swift, C#'s raw strings).
        if lang.triple_quotes() && q != b'`' && self.at(1) == q && self.at(2) == q {
            let body = self.i + 3;
            let mut j = body;
            while j < self.s.len() && !(self.s[j] == q && self.s.get(j + 1) == Some(&q) && self.s.get(j + 2) == Some(&q)) {
                j += if self.s[j] == b'\\' && lang == Lang::Python { 2 } else { 1 };
            }
            self.prose(body, j.min(self.s.len()));
            self.i = (j + 3).min(self.s.len());
            return self.push(K::Str, start, self.i);
        }
        match (lang, q) {
            (Lang::Js | Lang::Ts, b'`') => { self.i += 1; return self.template_from(start); }
            (Lang::Go, b'`') | (Lang::Shell, b'`') | (Lang::Shell, b'\'') => return self.until(start, q, false, true),
            (Lang::Rust, b'\'') => return self.rust_quote(start),
            (l, b'\'') if l.quote_is_char() => return self.until(start, q, true, false),
            _ => {}
        }
        // C#'s verbatim strings: `""` is a quote, `\` is itself.
        if lang == Lang::CSharp && start > 0 && self.s[start.saturating_sub(1)] == b'@' {
            let mut j = self.i + 1;
            while j < self.s.len() {
                if self.s[j] == b'"' { if self.s.get(j + 1) == Some(&b'"') { j += 2; continue; } break; }
                j += 1;
            }
            self.prose(self.i + 1, j.min(self.s.len()));
            self.i = (j + 1).min(self.s.len());
            return self.push(K::Str, start, self.i);
        }
        self.until(start, q, true, lang.quotes_span_lines() || q == b'`')
    }

    /// To the closing `q`: past escapes if `escapes`; a line's end ends it unless `spans`.
    fn until(&mut self, start: usize, q: u8, escapes: bool, spans: bool) {
        let body = self.i + 1;
        let mut j = body;
        while j < self.s.len() {
            let b = self.s[j];
            if b == q { break; }
            if b == b'\\' && escapes { j += 2; continue; }
            if b == b'\n' && !spans { break; }
            j += 1;
        }
        let j = j.min(self.s.len());
        self.prose(body, j);
        // Closed by its quote, the quote is in it; ended by a line, the line's end is not.
        self.i = if j < self.s.len() && self.s[j] == q { j + 1 } else { j };
        self.push(K::Str, start, self.i);
    }

    /// Rust's `'`: a character (`'a'`, `'\n'`, `'\u{1F600}'`, `'{'`), or else a lifetime or a label (`'a`, `'outer:`).
    fn rust_quote(&mut self, start: usize) {
        let i = self.i;
        if self.at(1) == b'\\' { return self.until(start, b'\'', true, false); }
        // One character (of however many bytes), then the quote: a character.
        let ch_len = match self.at(1) { b if b < 0x80 => 1, b if b >= 0xF0 => 4, b if b >= 0xE0 => 3, _ => 2 };
        if self.s.get(i + 1 + ch_len) == Some(&b'\'') && self.at(1) != b'\n' {
            self.prose(i + 1, i + 1 + ch_len);
            self.i = i + 2 + ch_len;
            return self.push(K::Str, start, self.i);
        }
        let mut j = i + 1;
        while j < self.s.len() && is_word_byte(self.s[j]) { j += 1; }
        if j == i + 1 { return self.punct(K::Punct, 1); }
        self.i = j;
        self.push(K::Word, start, j);
    }

    /// Rust's r#"…"#: to the quote followed by as many `#`.
    fn rust_raw(&mut self, start: usize, hashes: usize) {
        let body = self.i + 1;
        let mut j = body;
        while j < self.s.len() {
            if self.s[j] == b'"' && self.s[j + 1..].iter().take(hashes).filter(|&&b| b == b'#').count() == hashes { break; }
            j += 1;
        }
        self.prose(body, j.min(self.s.len()));
        self.i = (j + 1 + hashes).min(self.s.len());
        self.push(K::Str, start, self.i);
    }

    /// C++'s R"delim(…)delim".
    fn cpp_raw(&mut self, start: usize) {
        let open = self.i + 1;
        let paren = self.s[open..].iter().take(17).position(|&b| b == b'(').map(|p| open + p);
        let Some(paren) = paren else { return self.until(start, b'"', true, false) };
        let mut close = Vec::with_capacity(paren - open + 2);
        close.push(b')');
        close.extend_from_slice(&self.s[open..paren]);
        close.push(b'"');
        let body = paren + 1;
        let end = self.s[body..].windows(close.len()).position(|w| w == close.as_slice()).map_or(self.s.len(), |p| body + p);
        self.prose(body, end);
        self.i = (end + close.len()).min(self.s.len());
        self.push(K::Str, start, self.i);
    }

    /// A JavaScript template literal from just past its backquote: its text to the closing backquote, or to a `${`,
    /// whose code is read as code until its `}`.
    fn template_from(&mut self, start: usize) {
        let mut j = self.i;
        while j < self.s.len() {
            match self.s[j] {
                b'\\' => j += 2,
                b'`' => break,
                b'$' if self.s.get(j + 1) == Some(&b'{') => {
                    self.prose(self.i, j);
                    self.push(K::Str, start, j);
                    self.modes.push(Mode::Interp(0));
                    self.i = j + 2;
                    return;
                }
                _ => j += 1,
            }
        }
        let j = j.min(self.s.len());
        self.prose(self.i, j);
        self.i = (j + 1).min(self.s.len());
        self.push(K::Str, start, self.i);
    }

    /// Back in a template after its `${…}`.
    fn template(&mut self) { self.template_from(self.i) }

    /// The shell's `$`: `${…}` (to its matching brace), `$(…)` and `$((…))` (as code), `$'…'`, or a variable.
    fn shell_dollar(&mut self) {
        let start = self.i;
        match self.at(1) {
            b'{' => {
                let mut j = self.i + 2;
                let mut open = 1u32;
                while j < self.s.len() && open > 0 {
                    match self.s[j] { b'{' => open += 1, b'}' => open -= 1, b'\\' => j += 1, _ => {} }
                    j += 1;
                }
                self.i = j.min(self.s.len());
                self.push(K::Word, start, self.i);
            }
            b'\'' => { self.i += 1; self.until(start, b'\'', true, true) }
            b'(' => { self.i += 1; self.push(K::Punct, start, self.i) }
            _ => {
                self.i += 1;
                while self.i < self.s.len() && (is_word_byte(self.s[self.i]) || matches!(self.s[self.i], b'?' | b'#' | b'@' | b'*' | b'!' | b'-')) {
                    self.i += 1;
                    if !is_word_byte(self.s[self.i - 1]) { break; }
                }
                self.push(K::Word, start, self.i);
            }
        }
    }

    /// `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: its body (the lines after this one, to WORD alone) is text.
    fn heredoc_start(&mut self) {
        let start = self.i;
        let mut j = self.i + 2;
        let tabs = self.s.get(j) == Some(&b'-');
        if tabs { j += 1; }
        while matches!(self.s.get(j), Some(b' ' | b'\t')) { j += 1; }
        let quote = self.s.get(j).copied().filter(|&b| b == b'\'' || b == b'"');
        if quote.is_some() { j += 1; }
        let w0 = j;
        while j < self.s.len() && (is_word_byte(self.s[j]) || matches!(self.s[j], b'-' | b'.')) { j += 1; }
        let word = self.s[w0..j].to_vec();
        if quote.is_some() && self.s.get(j) == quote.as_ref() { j += 1; }
        self.i = j;
        if word.is_empty() { return self.push(K::Punct, start, start + 2); }
        self.heredocs.push((word, tabs));
        self.push(K::Str, start, j);
    }

    /// The bodies of the here-documents begun on the line just ended, each to its word alone on a line.
    fn heredoc_bodies(&mut self) {
        for (word, tabs) in std::mem::take(&mut self.heredocs) {
            let body = self.i;
            loop {
                if self.i >= self.s.len() { break; }
                let end = self.s[self.i..].iter().position(|&b| b == b'\n').map_or(self.s.len(), |p| self.i + p);
                let mut line = &self.s[self.i..end];
                if tabs { while line.first() == Some(&b'\t') { line = &line[1..]; } }
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                let at = self.i;
                self.i = (end + 1).min(self.s.len());
                if line == word.as_slice() { self.prose(body, at); break; }
                if self.i >= self.s.len() { self.prose(body, self.s.len()); }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn kinds(src: &str, lang: Lang) -> Vec<(K, String)> {
        let l = lex(src.as_bytes(), lang);
        l.toks.iter().map(|t| (t.k, String::from_utf8_lossy(l.text(src.as_bytes(), t)).into_owned())).collect()
    }
    fn code(src: &str, lang: Lang) -> String {
        kinds(src, lang).into_iter().map(|(k, t)| match k { K::Str => "S".to_string(), K::Nl => "\n".to_string(), _ => t }).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn languages_by_name_and_by_their_first_line() {
        assert_eq!(Lang::of("a/b.rs", b""), Some(Lang::Rust));
        assert_eq!(Lang::of("x.H", b""), Some(Lang::C));
        assert_eq!(Lang::of("x.tsx", b""), Some(Lang::Ts));
        assert_eq!(Lang::of("README.md", b"#!/bin/sh\n"), None, "an extension says it, whatever the first line");
        assert_eq!(Lang::of("bin/run", b"#!/usr/bin/env python3\nx"), Some(Lang::Python));
        assert_eq!(Lang::of("bin/run", b"#!/usr/bin/env -S bash -e\n"), Some(Lang::Shell));
        assert_eq!(Lang::of(".profile", b"#!/bin/sh\n"), Some(Lang::Shell), "a dotfile's name is not an extension");
        assert_eq!(Lang::of("Makefile", b"all:\n"), None);
    }

    #[test]
    fn braces_and_keywords_inside_literals_and_comments_are_not_code() {
        assert_eq!(code("a = \"{ if }\"; // { if\n/* } while */ b", Lang::C), "a = S ; b");
        assert_eq!(code("let s = r#\"a \" { }\"#; let c = '{'; let l: &'a T;", Lang::Rust), "let s = S ; let c = S ; let l : & 'a T ;");
        assert_eq!(code("fn f<'a>(x: &'a str) -> char { 'x' }", Lang::Rust), "fn f < 'a > ( x : & 'a str ) -> char { S }");
        assert_eq!(code("'outer: loop { break 'outer; }", Lang::Rust), "'outer : loop { break 'outer ; }");
        assert_eq!(code("/* a /* nested } */ still */ x", Lang::Rust), "x");
        assert_eq!(code("/* a /* flat */ x", Lang::C), "x");
        assert_eq!(code("let b = b'{'; let s = b\"}\"; let u = '\\u{7B}';", Lang::Rust), "let b = S ; let s = S ; let u = S ;");
        assert_eq!(code("x = /[{]/g.test(s) ? a / b : c", Lang::Js), "x = S . test ( s ) ? a / b : c");
        assert_eq!(code("return /}/.source", Lang::Ts), "return S . source");
        assert_eq!(code("a = b / c / d", Lang::Js), "a = b / c / d");
        assert_eq!(code("x = `a ${ {k: 1}.k } { b ${`n ${y}`} }`", Lang::Js), "x = S { k : 1 } . k S S y S S");
        assert_eq!(code("auto s = R\"x(a )\" } )x\"; int n = 1'000;", Lang::Cpp), "auto s = S ; int n = 1'000 ;");
        assert_eq!(code("s := `{\n}` + \"}\"", Lang::Go), "s : = S + S");
        assert_eq!(code("s = '''{\n}''' + f\"{x}\" # }", Lang::Python), "s = S + S");
        assert_eq!(code("echo '{' \"}\" ${a:-}} # {\n", Lang::Shell), "echo S S ${a:-} } \n");
    }

    #[test]
    fn a_literal_left_open_ends_at_its_line_where_it_cannot_span_lines() {
        assert_eq!(code("a = \"oops\nb { }", Lang::C), "a = S b { }");
        assert_eq!(code("a = 'x\nb { }", Lang::Js), "a = S b { }");
        // Rust's strings span lines: one never closed is the rest of the file.
        assert_eq!(code("a = \"oops\nb { }", Lang::Rust), "a = S");
        // A `/` that finds no closing `/` on its line is a division.
        assert_eq!(code("a = (b) / 2\nif (x) { }", Lang::Js), "a = ( b ) / 2 if ( x ) { }");
        assert_eq!(code("x = [/a\n{ }", Lang::Js), "x = [ / a { }");
    }

    #[test]
    fn shell_here_documents_and_comments() {
        let s = "cat <<EOF\n{ if\nEOF\nif x; then y; fi\ncat <<-'E'\n\t}\n\tE\nz # }\na#b\n";
        assert_eq!(code(s, Lang::Shell), "cat S \n if x ; \n then y ; \n fi \n cat S \n z \n a # b \n");
    }

    #[test]
    fn python_logical_lines_end_outside_brackets_and_continuations() {
        let s = "x = (1,\n  2)\ny = 3 \\\n  + 4\nif a:\n    b\n";
        assert_eq!(code(s, Lang::Python), "x = ( 1 , 2 ) \n y = 3 + 4 \n if a : \n b \n");
    }

    #[test]
    fn c_preprocessor_lines_end_where_their_line_does() {
        // An include is read and ends at its line; a define (its continued lines too) is not code.
        assert_eq!(code("#include \"a.h\"\n#define X(a) \\\n  { if (a)\nint f(void) { return a # b; }", Lang::C),
            "# include S \n int f ( void ) { return a # b ; }");
        // Only #if's first branch is read: each branch opening its own brace still balances.
        let kr = "#ifdef KR_headers\nint g(a) int a; {\n#elif defined(X)\nint g(int a, int b) {\n#else\nint g(int a) {\n#endif\n  return a;\n}\nint h(void) { }\n";
        assert_eq!(code(kr, Lang::C), "int g ( a ) int a ; { return a ; } int h ( void ) { }");
        // Nested, and the first branch's own nesting: the outer #else is passed over whole.
        let nested = "#if A\n#if B\nx {\n#else\ny {\n#endif\n#else\n#if C\nz {\n#endif\nw {\n#endif\n}";
        assert_eq!(code(nested, Lang::C), "x { }");
        // Directives the code never sees end nothing: `#  else` with spaces, `#endif` with a comment.
        assert_eq!(code("#if A\na\n#  else /* x\n y */\nb\n#endif // c\nc", Lang::C), "a c");
    }

    #[test]
    fn lines_are_counted_on_tokens_and_whole() {
        let src = "a\n\nb\r\n  c";
        let l = lex(src.as_bytes(), Lang::C);
        assert_eq!(l.toks.iter().map(|t| t.line).collect::<Vec<_>>(), vec![1, 3, 4]);
        assert_eq!(l.lines, 4);
        assert_eq!(lex(b"", Lang::C).lines, 0);
        assert_eq!(lex(b"x\n", Lang::C).lines, 1);
        // A byte-order mark is not a token.
        assert_eq!(code("\u{FEFF}x", Lang::C), "x");
    }

    #[test]
    fn prose_holds_comments_and_string_insides() {
        let src = "// Hello world\nlet s = \"There is no repo\";";
        let l = lex(src.as_bytes(), Lang::Rust);
        let texts: Vec<&str> = l.prose.iter().map(|&(a, b)| &src[a as usize..b as usize]).collect();
        assert_eq!(texts, ["// Hello world", "There is no repo"]);
    }

    /// A tiny deterministic generator (splitmix64): the same cases every run.
    pub(crate) struct Rng(pub u64);
    impl Rng {
        pub fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }
        pub fn below(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize }
    }

    const ALL: [Lang; 12] = [Lang::C, Lang::Cpp, Lang::Rust, Lang::Js, Lang::Ts, Lang::Go, Lang::Java, Lang::CSharp, Lang::Kotlin, Lang::Swift, Lang::Python, Lang::Shell];

    /// Whatever the bytes: tokens in order, within the file, never overlapping; every language.
    fn sound(src: &[u8], lang: Lang) {
        let l = lex(src, lang);
        let mut at = 0u32;
        let mut line = 1u32;
        for t in &l.toks {
            assert!(t.start >= at && t.end >= t.start && t.end as usize <= src.len(), "{lang:?} {t:?} after {at} in {:?}", String::from_utf8_lossy(src));
            assert!(t.line >= line, "{lang:?} lines go back at {t:?}");
            at = t.end;
            line = t.line;
        }
        for &(a, b) in &l.prose { assert!(a <= b && b as usize <= src.len()); }
    }

    #[test]
    fn any_bytes_lex_without_failing_in_every_language() {
        let mut rng = Rng(7);
        let alphabet: &[u8] = b"{}()[]\"'`/\\*#$<-\n\r\t ;:|&?=.,!@rRbxu0123456789ifelseforwhile\xE3\x81\x82\xFF\x00";
        for _ in 0..3000 {
            let n = rng.below(200);
            let src: Vec<u8> = (0..n).map(|_| alphabet[rng.below(alphabet.len())]).collect();
            for lang in ALL { sound(&src, lang); }
        }
        // Every literal opener at the very end of the file.
        for end in ["\"", "'", "`", "/*", "//", "r#\"", "R\"x(", "'''", "<<EOF", "${", "$'", "`${", "\\", "b'", "'\\"] {
            for lang in ALL { sound(format!("x = {end}").as_bytes(), lang); }
        }
    }

    #[test]
    fn time_is_linear_whatever_the_file() {
        // Nesting, a template's interpolations within each other, a comment never closed, quotes never closed: each
        // a megabyte, each read in one pass (a quadratic lexer would take minutes here).
        let deep = "{".repeat(1 << 20);
        let interp = "`${".repeat(1 << 18);
        let open = format!("/*{}", "x".repeat(1 << 20));
        let quotes = "\"\n".repeat(1 << 19);
        let heredocs = "cat <<A <<B <<C\n".repeat(1 << 16);
        let started = std::time::Instant::now();
        for (src, lang) in [(&deep, Lang::Rust), (&interp, Lang::Ts), (&open, Lang::C), (&quotes, Lang::Js), (&heredocs, Lang::Shell)] {
            sound(src.as_bytes(), lang);
        }
        assert!(started.elapsed().as_secs() < 20, "{:?}", started.elapsed());
    }
}
