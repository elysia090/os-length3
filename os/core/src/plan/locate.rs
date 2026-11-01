//! Where an issue's fix most likely goes, and what to read first to find it.
//!
//! Each file is a document of its words (its names split where they join, `parseLine` and `parse_line` both
//! "parse" "line"; its comments' and strings' words; its path's), and the issue a query. A file's chance is
//!
//!   p(f | issue) ∝ exp(γ · bm25(issue, f)) · prior(f)^β
//!
//! bm25 the usual ranking of documents by a query's words (Robertson and Zaragoza, 2009), prior(f) how often f was
//! fixed before (with one fix's worth spread over every file, so a file never fixed is not ruled out), and γ and β
//! fitted to this repo's own past: its newest fixes held out, each one's subject the query and the files it changed
//! the answer, the prior counted from the commits older than all of them. What was fitted is said with how well it
//! did there (the share of those fixes whose files came first, or in the first five), and against the text alone and
//! the history alone: a reader can see whether to trust it.
//!
//! What to read first: a fault in one of several places, each place's chance p and the lines it takes to read c,
//! is found with the least reading on average by reading in order of p/c, highest first (the classic rule for search
//! with sure detection: exchanging any two neighbours out of that order costs more).
//!
//! Words in Japanese (and Chinese) have no spaces between them: their characters are taken in overlapping pairs,
//! which find the same words without a dictionary.

#![forbid(unsafe_code)]

use super::Analysis;
use serde::Serialize;
use std::collections::HashMap;

const STOP: [&str; 40] = ["the", "an", "of", "to", "in", "is", "it", "and", "or", "for", "on", "with", "as", "at", "by", "be", "this", "that",
    "from", "are", "was", "not", "but", "if", "else", "when", "then", "than", "so", "do", "does", "no", "can", "we", "you", "should", "would",
    "there", "its", "into"];

fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F)
}

/// A word as it is matched: lower case, its plural and tense set aside (`files`, `file`; `parsed`, `parse`).
fn stem(w: &str) -> String {
    let mut s = w.to_string();
    if s.len() > 4 && s.ends_with("ies") { s.truncate(s.len() - 3); s.push('y'); }
    else if s.len() > 4 && (s.ends_with("ses") || s.ends_with("xes") || s.ends_with("zes") || s.ends_with("ches") || s.ends_with("shes")) { s.truncate(s.len() - 2); }
    else if s.len() > 3 && s.ends_with('s') && !s.ends_with("ss") && !s.ends_with("us") { s.pop(); }
    if s.len() > 5 && s.ends_with("ing") { s.truncate(s.len() - 3); }
    else if s.len() > 4 && s.ends_with("ed") { s.truncate(s.len() - 2); }
    if s.len() > 4 && s.ends_with('e') { s.pop(); }
    s
}

/// The words of a text, as files and issues are matched by them.
pub fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut run: Vec<char> = Vec::new();
    let flush_word = |word: &mut String, out: &mut Vec<String>| {
        if word.chars().count() >= 2 {
            let lower = word.to_lowercase();
            if !STOP.contains(&lower.as_str()) && !lower.chars().all(|c| c.is_ascii_digit()) { out.push(stem(&lower)); }
        }
        word.clear();
    };
    let flush_run = |run: &mut Vec<char>, out: &mut Vec<String>| {
        if run.len() == 1 { out.push(run[0].to_string()); }
        for w in run.windows(2) { out.push(w.iter().collect()); }
        run.clear();
    };
    let mut prev: Option<char> = None;
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if cjk(c) {
            flush_word(&mut word, &mut out);
            run.push(c);
            prev = Some(c);
            continue;
        }
        flush_run(&mut run, &mut out);
        if c.is_alphanumeric() {
            // A new word where names join: lower to upper (parseLine), the last of capitals before a lower
            // (HTTPServer), letters to digits.
            let boundary = prev.is_some_and(|p| (p.is_lowercase() && c.is_uppercase())
                || (p.is_uppercase() && c.is_uppercase() && chars.get(i + 1).is_some_and(|n| n.is_lowercase()))
                || (p.is_alphabetic() != c.is_alphabetic()));
            if boundary { flush_word(&mut word, &mut out); }
            word.push(c);
        } else {
            flush_word(&mut word, &mut out);
        }
        prev = Some(c);
    }
    flush_word(&mut word, &mut out);
    flush_run(&mut run, &mut out);
    out
}

/// An index of the files' words for BM25.
pub struct Index {
    /// Each word's files and how often it is in each.
    postings: HashMap<String, Vec<(u32, f64)>>,
    len: Vec<f64>,
    avg: f64,
    n: usize,
}

const K1: f64 = 1.2;
const B: f64 = 0.75;

impl Index {
    pub fn new(docs: &[Vec<(String, u32)>]) -> Index {
        let mut postings: HashMap<String, Vec<(u32, f64)>> = HashMap::new();
        let mut len = Vec::with_capacity(docs.len());
        for (i, d) in docs.iter().enumerate() {
            let mut l = 0.0;
            for (w, c) in d { postings.entry(w.clone()).or_default().push((i as u32, *c as f64)); l += *c as f64; }
            len.push(l);
        }
        let avg = if docs.is_empty() { 1.0 } else { (len.iter().sum::<f64>() / docs.len() as f64).max(1.0) };
        Index { postings, len, avg, n: docs.len() }
    }

    /// Each file with a word of the query, and its score (files with none score 0), by file.
    pub fn scores(&self, query: &[(String, f64)]) -> Vec<(u32, f64)> {
        let mut acc: HashMap<u32, f64> = HashMap::new();
        for (w, qtf) in query {
            let Some(post) = self.postings.get(w) else { continue };
            let df = post.len() as f64;
            let idf = (1.0 + (self.n as f64 - df + 0.5) / (df + 0.5)).ln();
            for &(d, tf) in post {
                let norm = K1 * (1.0 - B + B * self.len[d as usize] / self.avg);
                *acc.entry(d).or_insert(0.0) += qtf * idf * tf * (K1 + 1.0) / (tf + norm);
            }
        }
        let mut v: Vec<(u32, f64)> = acc.into_iter().collect();
        v.sort_unstable_by_key(|x| x.0);
        v
    }
}

/// A query from text: its words, how often each (the title's count twice).
pub fn query(title: &str, body: &str) -> Vec<(String, f64)> {
    let mut q: HashMap<String, f64> = HashMap::new();
    for w in words(title) { *q.entry(w).or_insert(0.0) += 2.0; }
    for w in words(body) { *q.entry(w).or_insert(0.0) += 1.0; }
    let mut v: Vec<(String, f64)> = q.into_iter().collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// The prior: each file's fixes, with one fix spread over all files.
fn prior(fixes: &[f64]) -> Vec<f64> {
    let n = fixes.len().max(1) as f64;
    let total: f64 = fixes.iter().sum::<f64>() + 1.0;
    fixes.iter().map(|&c| (c + 1.0 / n) / total).collect()
}

/// p(f | query) over every file, in log space, normalized.
fn posterior(scores: &[(u32, f64)], log_prior: &[f64], gamma: f64, beta: f64, mention: &[u32]) -> Vec<f64> {
    let mut lp: Vec<f64> = log_prior.iter().map(|&p| beta * p).collect();
    for &(d, s) in scores { lp[d as usize] += gamma * s; }
    // A file the issue names by its path (or its name, if only one file has it) is all but certain.
    for &d in mention { lp[d as usize] += 8.0; }
    let top = lp.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let z: f64 = lp.iter().map(|&x| (x - top).exp()).sum();
    lp.iter().map(|&x| x - top - z.ln()).collect()
}

/// The files a text names: a path that is a file's, or a file name only one file has.
pub fn mentioned(a: &Analysis, text: &str) -> Vec<u32> {
    let mut by_name: HashMap<&str, Vec<u32>> = HashMap::new();
    for (i, f) in a.files.iter().enumerate() { by_name.entry(f.path.rsplit('/').next().unwrap_or(&f.path)).or_default().push(i as u32); }
    let mut out = Vec::new();
    for tok in text.split(|c: char| c.is_whitespace() || matches!(c, '`' | '"' | '\'' | '(' | ')' | ',' | ';' | '<' | '>' | '[' | ']')) {
        let tok = tok.trim_end_matches(['.', ':']).split(':').next().unwrap_or_default().trim_start_matches("./");
        if tok.len() < 3 || !tok.contains('.') { continue; }
        if let Some(i) = a.files.iter().position(|f| f.path == tok || f.path.ends_with(&format!("/{tok}")) && tok.contains('/')) { out.push(i as u32); continue; }
        if let Some(v) = by_name.get(tok).filter(|v| v.len() == 1) { out.push(v[0]); }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// What fitting γ and β on the repo's past gave.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Fit {
    pub gamma: f64,
    pub beta: f64,
    /// Fixes held out, and the share whose files came first, and among the first five.
    pub held_out: usize,
    pub first: f64,
    pub top5: f64,
    /// The same with the words alone (β = 0) and the history alone (γ = 0).
    pub words_top5: f64,
    pub history_top5: f64,
}

const HELD_OUT: usize = 200;
/// The grid fitted over (on the corpus the best γ was below 0.25 everywhere: BM25's sums are large, so the words'
/// pull is tempered; the grid reaches well past both ends of what was best).
const GAMMAS: [f64; 9] = [0.0, 0.015, 0.03, 0.06, 0.125, 0.25, 0.5, 1.0, 2.0];
const BETAS: [f64; 6] = [0.0, 0.25, 0.5, 1.0, 1.5, 2.0];

/// γ and β fitted to the repo's newest fixes (None without HELD_OUT/10 of them, or none with files still here).
pub fn fit(a: &Analysis, index: &Index) -> Option<Fit> {
    let fixes: Vec<usize> = a.history.commits.iter().enumerate().filter(|(_, c)| c.fix && !c.files.is_empty()).map(|(i, _)| i).take(HELD_OUT).collect();
    if fixes.len() < HELD_OUT / 10 { return None; }
    // The prior from every commit older than the oldest held out.
    let oldest = *fixes.last()?;
    let mut counts = vec![0.0; a.files.len()];
    for c in &a.history.commits[oldest + 1..] { if c.fix { for &f in &c.files { counts[f] += 1.0; } } }
    let log_prior: Vec<f64> = prior(&counts).iter().map(|p| p.ln()).collect();
    // Each held-out fix: its subject's scores, and the files it changed.
    type Case<'a> = (Vec<(u32, f64)>, &'a [usize]);
    let cases: Vec<Case> = fixes.iter().map(|&i| {
        let c = &a.history.commits[i];
        (index.scores(&query(&c.subject, "")), c.files.as_slice())
    }).collect();
    let judge = |gamma: f64, beta: f64| -> (f64, f64, f64) {
        let (mut ll, mut first, mut top5) = (0.0, 0.0, 0.0);
        for (scores, truth) in &cases {
            let lp = posterior(scores, &log_prior, gamma, beta, &[]);
            let mass: f64 = truth.iter().map(|&f| lp[f].exp()).sum();
            ll += mass.max(1e-300).ln();
            let best = truth.iter().map(|&f| lp[f]).fold(f64::NEG_INFINITY, f64::max);
            // Its rank: files above the best true one (ties counted against it, so a flat answer is not a hit).
            let above = lp.iter().filter(|&&x| x >= best).count() - 1;
            if above == 0 { first += 1.0; }
            if above < 5 { top5 += 1.0; }
        }
        let n = cases.len() as f64;
        (ll / n, first / n, top5 / n)
    };
    let mut best = (f64::NEG_INFINITY, 0.0, 0.0, 0.0, 0.0);
    for &g in &GAMMAS {
        for &b in &BETAS {
            let (ll, f1, f5) = judge(g, b);
            if ll > best.0 + 1e-12 { best = (ll, g, b, f1, f5); }
        }
    }
    let words_top5 = GAMMAS.iter().filter(|&&g| g > 0.0).map(|&g| judge(g, 0.0)).max_by(|x, y| x.0.total_cmp(&y.0)).map_or(0.0, |x| x.2);
    let history_top5 = BETAS.iter().filter(|&&b| b > 0.0).map(|&b| judge(0.0, b)).max_by(|x, y| x.0.total_cmp(&y.0)).map_or(0.0, |x| x.2);
    Some(Fit { gamma: best.1, beta: best.2, held_out: cases.len(), first: best.3, top5: best.4, words_top5, history_top5 })
}

/// A likely place: a file, its chance, and the function in it the issue's words point to most.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Place {
    pub file: usize,
    pub path: String,
    pub chance: f64,
    pub func: Option<String>,
    pub line: u32,
    pub end: u32,
    /// Lines to read there (the function's, else the file's).
    pub read: u32,
}

/// Where `title`/`body` likely goes: the files by chance, highest first (at most `most`), each with the function
/// that holds most of the issue's words; and the fit used (None: the words alone, γ = 1, β = 0).
pub fn locate(a: &Analysis, texts: &[&[u8]], title: &str, body: &str, most: usize) -> (Vec<Place>, Option<Fit>) {
    let index = Index::new(&a.words);
    let fitted = fit(a, &index);
    let (gamma, beta) = fitted.as_ref().map_or((1.0, 0.0), |f| (f.gamma, f.beta));
    let counts: Vec<f64> = (0..a.files.len()).map(|f| a.history.commits.iter().filter(|c| c.fix && c.files.contains(&f)).count() as f64).collect();
    let log_prior: Vec<f64> = prior(&counts).iter().map(|p| p.ln()).collect();
    let q = query(title, body);
    let mention = mentioned(a, &format!("{title}\n{body}"));
    let lp = posterior(&index.scores(&q), &log_prior, gamma, beta, &mention);
    let mut order: Vec<usize> = (0..a.files.len()).collect();
    order.sort_by(|&x, &y| lp[y].total_cmp(&lp[x]).then(x.cmp(&y)));
    let qwords: HashMap<&str, f64> = q.iter().map(|(w, c)| (w.as_str(), *c)).collect();
    let places = order.into_iter().take(most).map(|f| {
        let facts = &a.files[f];
        // The function whose lines hold most of the issue's words (by weight), if any does.
        let lines: Vec<&[u8]> = texts.get(f).map(|t| t.split(|&b| b == b'\n').collect()).unwrap_or_default();
        let held = |from: u32, to: u32| -> f64 {
            let from = from.saturating_sub(1) as usize;
            let to = (to as usize).min(lines.len());
            if from >= to { return 0.0; }
            let text = String::from_utf8_lossy(&lines[from..to].join(&b'\n')).into_owned();
            let mut seen: Vec<String> = words(&text);
            seen.sort();
            seen.dedup();
            seen.iter().filter_map(|w| qwords.get(w.as_str())).sum()
        };
        let best = facts.funcs.iter().filter(|g| g.name != super::shape::TOP)
            .map(|g| (held(g.line, g.end), g)).filter(|(s, _)| *s > 0.0)
            .max_by(|x, y| x.0.total_cmp(&y.0).then(y.1.line.cmp(&x.1.line)));
        match best {
            Some((_, g)) => Place { file: f, path: facts.path.clone(), chance: lp[f].exp(), func: Some(g.name.clone()), line: g.line, end: g.end, read: g.end - g.line + 1 },
            None => Place { file: f, path: facts.path.clone(), chance: lp[f].exp(), func: None, line: 1, end: facts.lines.max(1), read: facts.lines.max(1) },
        }
    }).collect();
    (places, fitted)
}

/// The order to read places in so the fault is found with the least reading on average: highest chance per line
/// first (ties: the more likely, then the earlier).
pub fn reading_order(places: &[Place]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..places.len()).collect();
    idx.sort_by(|&x, &y| {
        let (a, b) = (&places[x], &places[y]);
        (b.chance / b.read.max(1) as f64).total_cmp(&(a.chance / a.read.max(1) as f64)).then(b.chance.total_cmp(&a.chance)).then(x.cmp(&y))
    });
    idx
}

/// The reading an order costs on average until the fault is found (it is in one of the places, by their chances
/// renormalized among them).
pub fn expected_reading(places: &[Place], order: &[usize]) -> f64 {
    let total: f64 = places.iter().map(|p| p.chance).sum::<f64>().max(1e-300);
    let mut read = 0.0;
    let mut cost = 0.0;
    for &i in order {
        read += places[i].read as f64;
        cost += places[i].chance / total * read;
    }
    cost
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{analyze, past, Snapshot, Text};
    use crate::plan::lex::tests::Rng;

    #[test]
    fn words_split_names_and_pair_cjk() {
        assert_eq!(words("parseLine parse_line HTTPServer files2"), ["pars", "line", "pars", "line", "http", "server", "file"]);
        // A word and its forms meet: parse, parses, parsed, parsing; file, files; line, lines.
        assert_eq!(words("parse parses parsed parsing file files line lines"), ["pars", "pars", "pars", "pars", "file", "file", "line", "line"]);
        assert_eq!(words("The parser crashes on empty input"), ["parser", "crash", "empty", "input"]);
        assert_eq!(words("repo がありません"), ["repo", "があ", "あり", "りま", "ませ", "せん"]);
        assert_eq!(words("x 1 22 a"), Vec::<String>::new());
        assert_eq!(words("日"), ["日"]);
    }

    fn place(chance: f64, read: u32) -> Place { Place { file: 0, path: String::new(), chance, func: None, line: 1, end: read, read } }

    #[test]
    fn reading_by_chance_per_line_is_never_beaten_by_another_order() {
        // Every order of up to six places, brute force: none reads less on average than p/c's.
        let mut rng = Rng(9);
        for _ in 0..300 {
            let n = 1 + rng.below(6);
            let ps: Vec<Place> = (0..n).map(|_| place(1.0 + rng.below(100) as f64, 1 + rng.below(80) as u32)).collect();
            let best = expected_reading(&ps, &reading_order(&ps));
            let mut perm: Vec<usize> = (0..n).collect();
            // Heap's algorithm over all n! orders.
            let mut c = vec![0usize; n];
            let mut i = 0;
            assert!(expected_reading(&ps, &perm) >= best - 1e-9);
            while i < n {
                if c[i] < i {
                    if i % 2 == 0 { perm.swap(0, i); } else { perm.swap(c[i], i); }
                    assert!(expected_reading(&ps, &perm) >= best - 1e-9, "{perm:?} beats p/c");
                    c[i] += 1;
                    i = 0;
                } else { c[i] = 0; i += 1; }
            }
        }
    }

    fn snapshot(files: &[(&str, &str)]) -> Snapshot {
        Snapshot { texts: files.iter().map(|(p, s)| Text { path: p.to_string(), bytes: s.as_bytes().to_vec() }).collect(), set_aside: 0, git: false }
    }

    #[test]
    fn an_issue_finds_the_file_and_function_its_words_are_in() {
        let files = [
            ("feet.c", "#include \"feet.h\"\nint inches(double feet) {\n  return (int)(feet * 12);\n}\nint yards(double feet) {\n  return (int)(feet / 3);\n}\n"),
            ("print.c", "#include <stdio.h>\nvoid show(int n) { printf(\"%d\\n\", n); }\n"),
            ("README.md", "# Measures\n\nConverts lengths.\n"),
            ("msg.rs", "fn missing() { tr!(\"There is no repo {}\", \"repo {} はありません\"); }\n"),
        ];
        let snap = snapshot(&files);
        let a = analyze(&snap, past::History::default());
        let texts: Vec<&[u8]> = snap.texts.iter().map(|t| t.bytes.as_slice()).collect();
        let (places, fitted) = locate(&a, &texts, "Inches round down", "inches(7.3) gives 87; should be 88", 3);
        assert!(fitted.is_none(), "no history to fit to");
        assert_eq!(places[0].path, "feet.c");
        assert_eq!(places[0].func.as_deref(), Some("inches"));
        assert_eq!((places[0].line, places[0].end), (2, 4));
        let sum: f64 = places.iter().map(|p| p.chance).sum();
        assert!(places[0].chance > 0.5 && sum <= 1.0 + 1e-9);
        // In Japanese, by its words' pairs.
        let (places, _) = locate(&a, &texts, "repo がありませんと出る", "", 2);
        assert_eq!(places[0].path, "msg.rs");
        // Named by its file: that file, whatever the words.
        let (places, _) = locate(&a, &texts, "Wrong output", "see print.c", 1);
        assert_eq!(places[0].path, "print.c");
    }

    #[test]
    fn fitting_on_the_past_finds_where_fixes_go_and_says_how_well() {
        // Twenty files, each with its own words; a history whose fixes each name a file's words and change it.
        let mut rng = Rng(21);
        let vocab: Vec<String> = (0..20).map(|i| format!("alpha{}beta{} gamma{}", (b'a' + i as u8) as char, (b'a' + (i * 7 % 20) as u8) as char, i)).collect();
        let files: Vec<(String, String)> = (0..20).map(|i| (format!("src/m{i}.rs"), format!("fn f{i}() {{ let {} = 1; }}\n", vocab[i].split_whitespace().next().unwrap_or("x")))).collect();
        let snap = Snapshot { texts: files.iter().map(|(p, s)| Text { path: p.clone(), bytes: s.as_bytes().to_vec() }).collect(), set_aside: 0, git: true };
        let commits: Vec<past::Commit> = (0..300).map(|k| {
            let f = rng.below(20);
            let subject = format!("Fix {} handling", vocab[f].split_whitespace().next().unwrap_or("x"));
            past::Commit { id: k.to_string(), time: 0, subject, files: vec![f], fix: true }
        }).collect();
        let a = analyze(&snap, past::History { commits, read: 300 });
        let index = Index::new(&a.words);
        let fit = fit(&a, &index).expect("enough fixes");
        assert_eq!(fit.held_out, HELD_OUT);
        assert!(fit.first > 0.9, "{fit:?}");
        assert!(fit.top5 >= fit.first && fit.words_top5 > fit.history_top5, "{fit:?}");
        assert!(fit.gamma > 0.0);
    }
}
