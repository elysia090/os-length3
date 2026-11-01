//! Which files depend on which, as their code says (Rust's `mod` and paths, JavaScript's imports, C's includes,
//! Python's imports, Go's, Java's, the shell's `.`), and what that structure costs: the groups of files that depend
//! on each other in a circle (strongly connected components, Tarjan 1972), how far a change can travel (propagation
//! cost: the share of file pairs where one reaches the other, MacCormack, Rusnak and Baldwin 2006), and for a
//! circle, the fewest uses to cut so it is one no more (a feedback arc set, by Eades, Lin and Smyth's 1993 greedy
//! order, its arcs weighed by how many uses each is).
//!
//! A C header and the source of the same name are one module (`x.h` is implemented by `x.c`), the source standing
//! for both: a file that includes the header depends on what the source does, so the circles C really has (`a.c`
//! uses `b.h`, `b.c` uses `a.h`) are seen, and a source including its own header is none.

#![forbid(unsafe_code)]

use super::lex::{Lang, Tok, K};
use std::collections::{BTreeMap, HashMap};

/// A file as the graph reads it.
pub struct Src<'a> {
    pub path: &'a str,
    pub lang: Lang,
    pub src: &'a [u8],
    pub toks: &'a [Tok],
}

/// One file's uses of another: how many, and the first lines they are on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge { pub from: usize, pub to: usize, pub uses: u32, pub lines: Vec<u32> }

#[derive(Clone, Debug, Default)]
pub struct Graph {
    pub n: usize,
    /// In order of (from, to), each pair once.
    pub edges: Vec<Edge>,
}

impl Graph {
    pub fn adjacency(&self) -> Vec<Vec<usize>> {
        let mut adj = vec![Vec::new(); self.n];
        for e in &self.edges { adj[e.from].push(e.to); }
        adj
    }
}

/// The files' dependencies on each other. `all`: every path in the repo with its text (code or not: the manifests
/// that name crates and modules are read from it), indexed as the graph's nodes are.
pub fn build(files: &[Src], all: &[(&str, &[u8])]) -> Graph {
    let paths: Vec<&str> = all.iter().map(|(p, _)| *p).collect();
    let index: HashMap<&str, usize> = paths.iter().enumerate().map(|(i, p)| (*p, i)).collect();
    let text_of = |p: &str| index.get(p).map(|&i| all[i].1);
    let by_name = Names::new(&paths);
    let rust = RustCrates::new(&paths, &text_of);
    let all = &paths;
    let mut uses: BTreeMap<(usize, usize), (u32, Vec<u32>)> = BTreeMap::new();
    fn add_use(uses: &mut BTreeMap<(usize, usize), (u32, Vec<u32>)>, from: usize, to: usize, line: u32) {
        if from == to { return; }
        let e = uses.entry((from, to)).or_insert((0, Vec::new()));
        e.0 += 1;
        if e.1.len() < 3 && !e.1.contains(&line) { e.1.push(line); }
    }
    let go_module = text_of("go.mod").map(go_module_of);
    for f in files {
        let Some(&from) = index.get(f.path) else { continue };
        let refs = match f.lang {
            Lang::Rust => rust.refs(f),
            Lang::Js | Lang::Ts => js_refs(f, &index),
            Lang::C | Lang::Cpp => c_refs(f, &index, &by_name),
            Lang::Python => py_refs(f, &index),
            Lang::Go => go_refs(f, go_module.as_deref(), all),
            Lang::Java | Lang::Kotlin => jvm_refs(f, &index, &by_name),
            Lang::Shell => sh_refs(f, &index),
            _ => Vec::new(),
        };
        for (to, line) in refs { add_use(&mut uses, from, to, line); }
    }
    // A header and the source of its name beside it are one module: a use of the header is a use of the source (what
    // it does is what the user depends on), and the source's include of its own header is no use of another file.
    let mut module: Vec<usize> = (0..all.len()).collect();
    for (i, p) in all.iter().enumerate() {
        let Some(stem) = p.strip_suffix(".h").or_else(|| p.strip_suffix(".hpp")).or_else(|| p.strip_suffix(".hh")) else { continue };
        if let Some(&j) = [".c", ".cc", ".cpp", ".cxx"].iter().find_map(|ext| index.get(format!("{stem}{ext}").as_str())) { module[i] = j; }
    }
    let mut merged: BTreeMap<(usize, usize), (u32, Vec<u32>)> = BTreeMap::new();
    for ((from, to), (n, lines)) in uses {
        let (a, b) = (module[from], module[to]);
        if a == b { continue; }
        let e = merged.entry((a, b)).or_insert((0, Vec::new()));
        e.0 += n;
        for l in lines { if e.1.len() < 3 && !e.1.contains(&l) { e.1.push(l); } }
    }
    Graph { n: all.len(), edges: merged.into_iter().map(|((from, to), (uses, lines))| Edge { from, to, uses, lines }).collect() }
}

fn text<'a>(f: &Src<'a>, t: &Tok) -> &'a [u8] { &f.src[t.start as usize..t.end as usize] }
fn word(f: &Src, t: Option<&Tok>, w: &[u8]) -> bool { t.is_some_and(|t| t.k == K::Word && text(f, t) == w) }
fn punct(f: &Src, t: Option<&Tok>, p: &[u8]) -> bool { t.is_some_and(|t| t.k == K::Punct && text(f, t) == p) }

/// A string token's inside (its quotes off).
fn unquote(s: &[u8]) -> Option<&str> {
    let s = std::str::from_utf8(s).ok()?;
    let q = s.chars().next()?;
    if !matches!(q, '"' | '\'' | '`') { return None; }
    let inner = s.strip_prefix(q)?;
    Some(inner.strip_suffix(q).unwrap_or(inner))
}

fn dir_of(p: &str) -> &str { p.rfind('/').map_or("", |i| &p[..i]) }

/// `base`/`rel` with `.` and `..` worked out; None if it leaves the repo.
fn join(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') { Vec::new() } else { base.split('/').filter(|s| !s.is_empty()).collect() };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => { parts.pop()?; }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// Paths by the name they end with, for includes and imports that name a file wherever it is.
struct Names<'a> { by_file: HashMap<&'a str, Vec<&'a str>> }

impl<'a> Names<'a> {
    fn new(all: &[&'a str]) -> Names<'a> {
        let mut by_file: HashMap<&str, Vec<&str>> = HashMap::new();
        for p in all { by_file.entry(p.rsplit('/').next().unwrap_or(p)).or_default().push(p); }
        Names { by_file }
    }
    /// The one path ending in `/suffix` (or being it); among several, the one sharing most of `near`'s folders.
    fn find(&self, suffix: &str, near: &str) -> Option<&'a str> {
        let name = suffix.rsplit('/').next().unwrap_or(suffix);
        let cands: Vec<&&str> = self.by_file.get(name)?.iter().filter(|p| **p == suffix || p.ends_with(&format!("/{suffix}"))).collect();
        let shared = |p: &str| p.split('/').zip(near.split('/')).take_while(|(a, b)| a == b).count();
        cands.into_iter().max_by(|a, b| shared(a).cmp(&shared(b)).then(b.cmp(a))).copied()
    }
}

// ---- Rust ----

/// The crates of the repo (each `Cargo.toml` beside a `src/`), their modules, and which file each module is.
struct RustCrates {
    /// Crate name (as code writes it: `-` as `_`) to its root module's folder (`core/src`).
    crates: HashMap<String, String>,
    /// A module's path (`core/src` + `::plan::lex`) to its file's index.
    modules: HashMap<String, usize>,
    /// Each Rust file's crate folder and module path.
    of: HashMap<String, (String, Vec<String>)>,
}

impl RustCrates {
    fn new<'a>(all: &[&str], text_of: &dyn Fn(&str) -> Option<&'a [u8]>) -> RustCrates {
        let mut crates = HashMap::new();
        let index: HashMap<&str, usize> = all.iter().enumerate().map(|(i, p)| (*p, i)).collect();
        // A crate: a src/ folder with lib.rs or main.rs; its name from its Cargo.toml when the files hold it.
        let mut roots: Vec<String> = all.iter().filter_map(|p| p.strip_suffix("/lib.rs").or_else(|| p.strip_suffix("/main.rs")))
            .filter(|d| d.ends_with("src") ).map(String::from).collect();
        roots.sort();
        roots.dedup();
        for root in &roots {
            let manifest = format!("{}Cargo.toml", root.strip_suffix("src").unwrap_or(root));
            let name = text_of(&manifest).and_then(cargo_name)
                .unwrap_or_else(|| dir_of(root).rsplit('/').next().unwrap_or("crate").to_string());
            crates.insert(name.replace('-', "_"), root.clone());
        }
        let mut modules = HashMap::new();
        let mut of = HashMap::new();
        for p in all.iter().filter(|p| p.ends_with(".rs")) {
            let Some(root) = roots.iter().filter(|r| p.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()) else { continue };
            let rel = &p[root.len() + 1..];
            let rel = rel.strip_suffix(".rs").unwrap_or(rel);
            let mut segs: Vec<String> = rel.split('/').map(String::from).collect();
            if matches!(segs.last().map(String::as_str), Some("mod")) || segs.len() == 1 && matches!(segs[0].as_str(), "lib" | "main") { segs.pop(); }
            if let Some(&i) = index.get(*p) {
                modules.insert(format!("{root}::{}", segs.join("::")), i);
                of.insert(p.to_string(), (root.clone(), segs));
            }
        }
        RustCrates { crates, modules, of }
    }

    /// The module file a path names (`crate::a::b::c` → a/b.rs if `c` is in it), the longest prefix that is one.
    fn resolve(&self, root: &str, segs: &[String]) -> Option<usize> {
        (1..=segs.len()).rev().find_map(|n| self.modules.get(&format!("{root}::{}", segs[..n].join("::"))).copied())
    }

    fn refs(&self, f: &Src) -> Vec<(usize, u32)> {
        let Some((root, here)) = self.of.get(f.path) else { return Vec::new() };
        let t = f.toks;
        let mut out = Vec::new();
        let mut i = 0;
        while i < t.len() {
            // `mod name;`: the child module's file.
            if word(f, t.get(i), b"mod") && t.get(i + 1).is_some_and(|x| x.k == K::Word) && t.get(i + 2).is_some_and(|x| x.k == K::Semi) {
                let mut segs = here.clone();
                segs.push(String::from_utf8_lossy(text(f, &t[i + 1])).into_owned());
                if let Some(to) = self.modules.get(&format!("{root}::{}", segs.join("::"))) { out.push((*to, t[i].line)); }
                i += 3;
                continue;
            }
            // A path: `crate::…`, `super::…`, `self::…`, `other_crate::…`, a child module's `name::…`; `use` trees too.
            if t[i].k == K::Word && punct(f, t.get(i + 1), b"::") && !(i > 0 && punct(f, t.get(i - 1), b"::")) {
                let in_use = (i > 0 && word(f, t.get(i - 1), b"use")) || (i > 1 && word(f, t.get(i - 2), b"use") && word(f, t.get(i - 1), b"pub"));
                let (base, segs, next) = self.path_at(f, i, root, here);
                if let Some(base) = base {
                    if in_use && punct(f, t.get(next), b"::") && t.get(next + 1).is_some_and(|x| x.k == K::Open) {
                        // use a::b::{c, d::e}: each a path from a::b.
                        let mut j = next + 2;
                        let mut depth = 1;
                        let mut item: Vec<String> = Vec::new();
                        while j < t.len() && depth > 0 {
                            match t[j].k {
                                K::Open => depth += 1,
                                K::Close => depth -= 1,
                                K::Word if depth == 1 => item.push(String::from_utf8_lossy(text(f, &t[j])).into_owned()),
                                K::Punct if depth == 1 && text(f, &t[j]) == b"," => {
                                    self.push_path(&mut out, &base, &segs, &item, t[i].line);
                                    item.clear();
                                }
                                _ => {}
                            }
                            j += 1;
                        }
                        self.push_path(&mut out, &base, &segs, &item, t[i].line);
                        i = j;
                        continue;
                    }
                    if let Some(to) = self.resolve(&base, &segs) { out.push((to, t[i].line)); }
                }
                i = next.max(i + 1);
                continue;
            }
            i += 1;
        }
        out
    }

    fn push_path(&self, out: &mut Vec<(usize, u32)>, base: &str, segs: &[String], item: &[String], line: u32) {
        let mut all: Vec<String> = segs.to_vec();
        all.extend(item.iter().filter(|w| w.as_str() != "self" && w.as_str() != "as").take(4).cloned());
        if let Some(to) = self.resolve(base, &all) { out.push((to, line)); }
    }

    /// The path starting at `i`: the crate folder it is in, its module segments from that crate's root, and the
    /// token after it.
    fn path_at(&self, f: &Src, i: usize, root: &str, here: &[String]) -> (Option<String>, Vec<String>, usize) {
        let t = f.toks;
        let mut words: Vec<String> = Vec::new();
        let mut j = i;
        while j < t.len() && t[j].k == K::Word {
            words.push(String::from_utf8_lossy(text(f, &t[j])).into_owned());
            j += 1;
            if punct(f, t.get(j), b"::") && t.get(j + 1).is_some_and(|x| x.k == K::Word) { j += 1; } else { break; }
        }
        let first = words.first().map(String::as_str).unwrap_or_default();
        let (base, mut segs) = match first {
            "crate" => (Some(root.to_string()), words[1..].to_vec()),
            "self" => (Some(root.to_string()), [here, &words[1..]].concat()),
            "super" => {
                let ups = words.iter().take_while(|w| *w == "super").count();
                let mut s = here.to_vec();
                for _ in 0..ups { s.pop(); }
                (Some(root.to_string()), [s.as_slice(), &words[ups..]].concat())
            }
            w if self.crates.contains_key(w) => (self.crates.get(w).cloned(), words[1..].to_vec()),
            // A child module of this one (2018's paths from where the code is).
            w if self.modules.contains_key(&format!("{root}::{}", [here, &[w.to_string()]].concat().join("::"))) => (Some(root.to_string()), [here, &words].concat()),
            _ => (None, Vec::new()),
        };
        segs.truncate(8);
        (base, segs, j)
    }
}

fn cargo_name(toml: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(toml).ok()?;
    let mut in_package = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') { in_package = l == "[package]"; continue; }
        if in_package {
            if let Some(v) = l.strip_prefix("name") { return Some(v.trim_start().strip_prefix('=')?.trim().trim_matches('"').to_string()); }
        }
    }
    None
}

// ---- JavaScript and TypeScript ----

fn js_refs(f: &Src, index: &HashMap<&str, usize>) -> Vec<(usize, u32)> {
    let t = f.toks;
    let mut out = Vec::new();
    for i in 0..t.len() {
        if t[i].k != K::Str { continue; }
        let before = |k: usize| i.checked_sub(k).map(|j| &t[j]);
        let is_import = word(f, before(1), b"from") || word(f, before(1), b"import")
            || (t.get(i + 1).is_some_and(|x| x.k == K::RParen) && before(1).is_some_and(|x| x.k == K::LParen)
                && (word(f, before(2), b"require") || word(f, before(2), b"import")));
        if !is_import { continue; }
        let Some(spec) = unquote(text(f, &t[i])) else { continue };
        if !(spec.starts_with("./") || spec.starts_with("../")) { continue; }
        if let Some(to) = js_resolve(dir_of(f.path), spec, index) { out.push((to, t[i].line)); }
    }
    out
}

fn js_resolve(dir: &str, spec: &str, index: &HashMap<&str, usize>) -> Option<usize> {
    let base = join(dir, spec)?;
    let stripped = [".js", ".mjs", ".cjs", ".jsx"].iter().find_map(|e| base.strip_suffix(e)).map(String::from);
    let mut cands = vec![base.clone()];
    for b in [Some(base.clone()), stripped].into_iter().flatten() {
        for e in [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"] {
            cands.push(format!("{b}{e}"));
        }
    }
    cands.iter().find_map(|c| index.get(c.as_str()).copied())
}

// ---- C and C++ ----

fn c_refs(f: &Src, index: &HashMap<&str, usize>, names: &Names) -> Vec<(usize, u32)> {
    let t = f.toks;
    let mut out = Vec::new();
    for i in 1..t.len() {
        if !(t[i].k == K::Str && word(f, t.get(i - 1), b"include") && i >= 2 && punct(f, t.get(i - 2), b"#")) { continue; }
        let Some(spec) = unquote(text(f, &t[i])) else { continue };
        let here = join(dir_of(f.path), spec).and_then(|p| index.get(p.as_str()).copied());
        let to = here.or_else(|| names.find(spec.trim_start_matches("./"), f.path).and_then(|p| index.get(p).copied()));
        if let Some(to) = to { out.push((to, t[i].line)); }
    }
    out
}

// ---- Python ----

fn py_refs(f: &Src, index: &HashMap<&str, usize>) -> Vec<(usize, u32)> {
    let t = f.toks;
    let mut out = Vec::new();
    let module = |dots: usize, name: &str| -> Option<usize> {
        let base = if dots == 0 { String::new() } else {
            let mut d = dir_of(f.path).to_string();
            for _ in 1..dots { d = dir_of(&d).to_string(); }
            d
        };
        let rel = name.replace('.', "/");
        let path = if base.is_empty() { rel } else if rel.is_empty() { base } else { format!("{base}/{rel}") };
        // From the repo's top, and from a src/ folder (the common layouts).
        [String::new(), "src/".into()].iter().find_map(|root| {
            index.get(format!("{root}{path}.py").as_str()).or_else(|| index.get(format!("{root}{path}/__init__.py").as_str())).copied()
        })
    };
    let mut i = 0;
    while i < t.len() {
        let at_line_start = i == 0 || t[i - 1].k == K::Nl;
        if at_line_start && (word(f, t.get(i), b"import") || word(f, t.get(i), b"from")) {
            let from = word(f, t.get(i), b"from");
            let mut j = i + 1;
            let mut dots = 0;
            while punct(f, t.get(j), b".") || punct(f, t.get(j), b"...") || punct(f, t.get(j), b"..") { dots += text(f, &t[j]).len(); j += 1; }
            let mut name = String::new();
            while let Some(x) = t.get(j).filter(|x| x.k == K::Word) {
                if word(f, Some(x), b"import") || word(f, Some(x), b"as") { break; }
                name.push_str(&String::from_utf8_lossy(text(f, x)));
                if punct(f, t.get(j + 1), b".") { name.push('.'); j += 2; } else { j += 1; break; }
            }
            let line = t[i].line;
            if from {
                // from a.b import c: a/b/c.py if it is a module, else a/b.
                let mut k = j;
                while k < t.len() && !word(f, t.get(k), b"import") && t[k].k != K::Nl { k += 1; }
                let mut items = Vec::new();
                k += 1;
                while k < t.len() && t[k].k != K::Nl {
                    if t[k].k == K::Word && !word(f, t.get(k), b"as") && !(k > 0 && word(f, t.get(k - 1), b"as")) { items.push(String::from_utf8_lossy(text(f, &t[k])).into_owned()); }
                    k += 1;
                }
                let mut found = false;
                for it in &items {
                    let sub = if name.is_empty() { it.clone() } else { format!("{name}.{it}") };
                    if let Some(to) = module(dots, &sub) { out.push((to, line)); found = true; }
                }
                if !found { if let Some(to) = module(dots, &name) { out.push((to, line)); } }
                i = k;
                continue;
            }
            if let Some(to) = module(0, &name) { out.push((to, line)); }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

// ---- Go, Java, Kotlin, shell ----

fn go_module_of(src: &[u8]) -> String {
    String::from_utf8_lossy(src).lines().find_map(|l| l.trim().strip_prefix("module ").map(|m| m.trim().to_string())).unwrap_or_default()
}

fn go_refs(f: &Src, module: Option<&str>, all: &[&str]) -> Vec<(usize, u32)> {
    let Some(module) = module.filter(|m| !m.is_empty()) else { return Vec::new() };
    let t = f.toks;
    let mut specs: Vec<(&[u8], u32)> = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if !word(f, t.get(i), b"import") { i += 1; continue; }
        // import "a" | import alias "a" | import ( "a"; alias "b" … )
        let mut j = i + 1;
        if t.get(j).is_some_and(|x| x.k == K::LParen) {
            j += 1;
            while j < t.len() && t[j].k != K::RParen {
                if t[j].k == K::Str { specs.push((text(f, &t[j]), t[j].line)); }
                j += 1;
            }
        } else {
            if t.get(j).is_some_and(|x| x.k == K::Word || x.k == K::Punct) && t.get(j + 1).is_some_and(|x| x.k == K::Str) { j += 1; }
            if let Some(x) = t.get(j).filter(|x| x.k == K::Str) { specs.push((text(f, x), x.line)); }
        }
        i = j + 1;
    }
    let mut out = Vec::new();
    for (s, line) in specs {
        let Some(spec) = unquote(s) else { continue };
        let Some(rel) = spec.strip_prefix(module).filter(|r| r.is_empty() || r.starts_with('/')).map(|r| r.trim_start_matches('/')) else { continue };
        for (j, p) in all.iter().enumerate() {
            if dir_of(p) == rel && p.ends_with(".go") && !p.ends_with("_test.go") && *p != f.path { out.push((j, line)); }
        }
    }
    out
}

fn jvm_refs(f: &Src, index: &HashMap<&str, usize>, names: &Names) -> Vec<(usize, u32)> {
    let t = f.toks;
    let ext = if f.lang == Lang::Kotlin { "kt" } else { "java" };
    let mut out = Vec::new();
    for i in 0..t.len() {
        if !word(f, t.get(i), b"import") { continue; }
        let mut parts = Vec::new();
        let mut j = i + 1;
        if word(f, t.get(j), b"static") { j += 1; }
        while let Some(x) = t.get(j).filter(|x| x.k == K::Word) {
            parts.push(String::from_utf8_lossy(text(f, x)).into_owned());
            if punct(f, t.get(j + 1), b".") { j += 2; } else { break; }
        }
        // a.b.C (or a.b.C.member): the file C.ext in the folders a/b.
        for n in (1..=parts.len()).rev() {
            let path = format!("{}.{ext}", parts[..n].join("/"));
            if let Some(p) = names.find(&path, f.path) {
                if let Some(&to) = index.get(p) { out.push((to, t[i].line)); }
                break;
            }
        }
    }
    out
}

fn sh_refs(f: &Src, index: &HashMap<&str, usize>) -> Vec<(usize, u32)> {
    let t = f.toks;
    let mut out = Vec::new();
    for i in 0..t.len().saturating_sub(1) {
        let at_command = i == 0 || t[i - 1].k == K::Nl;
        if !(at_command && (punct(f, t.get(i), b".") || word(f, t.get(i), b"source"))) { continue; }
        // The path: a word or a string, `$here/` and `"$(dirname "$0")"/` as the script's own folder.
        let mut spec = String::new();
        let mut j = i + 1;
        while let Some(x) = t.get(j).filter(|x| x.k != K::Nl && x.line == t[i].line) {
            let s = String::from_utf8_lossy(text(f, x)).into_owned();
            spec.push_str(unquote(s.as_bytes()).unwrap_or(&s));
            j += 1;
        }
        // `$here/x`, `${dir}/x`, `$(dirname "$0")/x`: from the script's own folder.
        let rel = if spec.starts_with('$') { spec.split_once('/').map_or("", |(_, r)| r) } else { spec.as_str() };
        let cands = [join(dir_of(f.path), rel), join("", rel)];
        if let Some(to) = cands.iter().flatten().find_map(|c| index.get(c.as_str()).copied()) { out.push((to, t[i].line)); }
    }
    out
}

// ---- what the structure costs ----

/// The strongly connected components (Tarjan's, without recursion): each a group of files that reach each other,
/// each sorted, the groups in the order Tarjan finds them (sinks first).
pub fn sccs(adj: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let n = adj.len();
    let mut index = vec![u32::MAX; n];
    let mut low = vec![0u32; n];
    let mut on = vec![false; n];
    let mut stack = Vec::new();
    let mut out = Vec::new();
    let mut next = 0u32;
    let mut work: Vec<(usize, usize)> = Vec::new();
    for s in 0..n {
        if index[s] != u32::MAX { continue; }
        work.push((s, 0));
        while let Some(&(v, k)) = work.last() {
            if k == 0 {
                index[v] = next;
                low[v] = next;
                next += 1;
                stack.push(v);
                on[v] = true;
            }
            if let Some(&w) = adj[v].get(k) {
                if let Some(top) = work.last_mut() { top.1 += 1; }
                if index[w] == u32::MAX { work.push((w, 0)); }
                else if on[w] { low[v] = low[v].min(index[w]); }
                continue;
            }
            work.pop();
            if let Some(&(u, _)) = work.last() { low[u] = low[u].min(low[v]); }
            if low[v] == index[v] {
                let mut comp = Vec::new();
                while let Some(w) = stack.pop() {
                    on[w] = false;
                    comp.push(w);
                    if w == v { break; }
                }
                comp.sort_unstable();
                out.push(comp);
            }
        }
    }
    out
}

/// How many files each file reaches, itself among them (the visibility matrix's rows, MacCormack et al.).
/// Exact (bit sets over the components, sinks first) up to `EXACT` components; past that, the components' reach
/// is still exact but counted by a walk from each.
pub fn reach(adj: &[Vec<usize>]) -> Vec<u32> {
    let n = adj.len();
    let comps = sccs(adj);
    let mut comp_of = vec![0usize; n];
    for (c, members) in comps.iter().enumerate() { for &v in members { comp_of[v] = c; } }
    let m = comps.len();
    let words = n.div_ceil(64);
    const EXACT: usize = 6000;
    let mut out = vec![0u32; n];
    if m <= EXACT {
        // Tarjan gives the components sinks first: each one's reach is its members and its successors' reach.
        let mut bits = vec![0u64; m * words];
        for (c, members) in comps.iter().enumerate() {
            let (done, rest) = bits.split_at_mut(c * words);
            let mine = &mut rest[..words];
            for &v in members {
                mine[v / 64] |= 1 << (v % 64);
                for &w in &adj[v] {
                    let d = comp_of[w];
                    if d != c { let other = &done[d * words..(d + 1) * words]; for (a, b) in mine.iter_mut().zip(other) { *a |= *b; } }
                }
            }
            let count = mine.iter().map(|w| w.count_ones()).sum::<u32>();
            for &v in members { out[v] = count; }
        }
        return out;
    }
    let mut seen = vec![u32::MAX; n];
    let mut queue = Vec::new();
    for (c, members) in comps.iter().enumerate() {
        let s = members[0];
        queue.clear();
        queue.push(s);
        seen[s] = c as u32;
        let mut count = 0u32;
        while let Some(v) = queue.pop() {
            count += 1;
            for &w in &adj[v] { if seen[w] != c as u32 { seen[w] = c as u32; queue.push(w); } }
        }
        for &v in members { out[v] = count; }
    }
    out
}

/// The share of ordered file pairs (a file with itself among them) where the first reaches the second.
pub fn propagation_cost(reach: &[u32]) -> f64 {
    let n = reach.len();
    if n == 0 { return 0.0; }
    reach.iter().map(|&r| r as f64).sum::<f64>() / (n as f64 * n as f64)
}

/// Arcs to cut so the files `nodes` (a circle) are one no more: those running backwards in Eades, Lin and Smyth's
/// order, with each vertex's out-weight less in-weight standing for its degrees (uses, not arcs, are what a cut
/// costs). Returns (from, to) pairs among `edges`, sorted.
pub fn feedback_arcs(nodes: &[usize], edges: &[(usize, usize, u32)]) -> Vec<(usize, usize)> {
    let pos: HashMap<usize, usize> = nodes.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let k = nodes.len();
    let mut out_w = vec![0i64; k];
    let mut in_w = vec![0i64; k];
    let mut outs: Vec<Vec<(usize, i64)>> = vec![Vec::new(); k];
    let mut ins: Vec<Vec<(usize, i64)>> = vec![Vec::new(); k];
    for &(a, b, w) in edges {
        let (Some(&a), Some(&b)) = (pos.get(&a), pos.get(&b)) else { continue };
        if a == b { continue; }
        out_w[a] += w as i64;
        in_w[b] += w as i64;
        outs[a].push((b, w as i64));
        ins[b].push((a, w as i64));
    }
    let mut alive = vec![true; k];
    let mut left = k;
    let mut s1: Vec<usize> = Vec::new();
    let mut s2: Vec<usize> = Vec::new();
    let remove = |v: usize, alive: &mut Vec<bool>, out_w: &mut Vec<i64>, in_w: &mut Vec<i64>| {
        alive[v] = false;
        for &(b, w) in &outs[v] { if alive[b] { in_w[b] -= w; } }
        for &(a, w) in &ins[v] { if alive[a] { out_w[a] -= w; } }
    };
    while left > 0 {
        let mut changed = true;
        while changed {
            changed = false;
            for v in 0..k {
                if alive[v] && out_w[v] == 0 { s2.push(v); remove(v, &mut alive, &mut out_w, &mut in_w); left -= 1; changed = true; }
            }
            for v in 0..k {
                if alive[v] && in_w[v] == 0 { s1.push(v); remove(v, &mut alive, &mut out_w, &mut in_w); left -= 1; changed = true; }
            }
        }
        if left == 0 { break; }
        // The vertex with most out-weight over in-weight goes first (ties: the lowest, so the order is the same
        // every run).
        let v = (0..k).filter(|&v| alive[v]).max_by(|&a, &b| (out_w[a] - in_w[a]).cmp(&(out_w[b] - in_w[b])).then(b.cmp(&a)));
        let Some(v) = v else { break };
        s1.push(v);
        remove(v, &mut alive, &mut out_w, &mut in_w);
        left -= 1;
    }
    s2.reverse();
    s1.extend(s2);
    let mut order = vec![0usize; k];
    for (i, &v) in s1.iter().enumerate() { order[v] = i; }
    let mut cut: Vec<(usize, usize)> = edges.iter().filter_map(|&(a, b, _)| {
        let (pa, pb) = (*pos.get(&a)?, *pos.get(&b)?);
        (pa != pb && order[pa] > order[pb]).then_some((a, b))
    }).collect();
    cut.sort_unstable();
    cut.dedup();
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::lex::{lex, Lang};
    use crate::plan::lex::tests::Rng;

    /// The graph of these files (path, text), as (from path, to path, uses).
    fn deps(files: &[(&str, &str)]) -> Vec<(String, String, u32)> {
        let paths: Vec<&str> = files.iter().map(|f| f.0).collect();
        let lexed: Vec<_> = files.iter().map(|(p, s)| Lang::of(p, s.as_bytes()).map(|l| (l, lex(s.as_bytes(), l)))).collect();
        let srcs: Vec<Src> = files.iter().zip(&lexed).filter_map(|((p, s), l)| l.as_ref().map(|(lang, lx)| Src { path: p, lang: *lang, src: s.as_bytes(), toks: &lx.toks })).collect();
        let all: Vec<(&str, &[u8])> = files.iter().map(|(p, s)| (*p, s.as_bytes())).collect();
        let g = build(&srcs, &all);
        g.edges.iter().map(|e| (paths[e.from].to_string(), paths[e.to].to_string(), e.uses)).collect()
    }
    fn pairs(d: &[(String, String, u32)]) -> Vec<(&str, &str)> { d.iter().map(|(a, b, _)| (a.as_str(), b.as_str())).collect() }

    #[test]
    fn rust_modules_paths_and_use_trees() {
        let d = deps(&[
            ("core/Cargo.toml", "[package]\nname = \"length3-core\"\n"),
            ("core/src/lib.rs", "pub mod plan;\nmod text;\nuse crate::text::words;\n"),
            ("core/src/plan/mod.rs", "pub mod lex;\nuse super::text;\nuse crate::{text::words, plan::lex::Tok};\nfn f() { self::lex::lex(); }\n"),
            ("core/src/plan/lex.rs", "fn g() { crate::text::x(); }\n"),
            ("core/src/text.rs", "fn h() { let s = \"crate::plan::lex\"; }\n"),
            ("cli/Cargo.toml", "[package]\nname = \"l3\"\n"),
            ("cli/src/main.rs", "use length3_core::plan::lex::Tok;\nfn main() { length3_core::text::x(); }\n"),
        ]);
        assert_eq!(pairs(&d), [
            ("core/src/lib.rs", "core/src/plan/mod.rs"), ("core/src/lib.rs", "core/src/text.rs"),
            ("core/src/plan/mod.rs", "core/src/plan/lex.rs"), ("core/src/plan/mod.rs", "core/src/text.rs"),
            ("core/src/plan/lex.rs", "core/src/text.rs"),
            ("cli/src/main.rs", "core/src/plan/lex.rs"), ("cli/src/main.rs", "core/src/text.rs"),
        ]);
        // Uses are counted: lib.rs names text twice (`mod text;`, `use crate::text::…`).
        assert_eq!(d[1].2, 2);
    }

    #[test]
    fn js_c_python_and_shell() {
        let d = deps(&[
            ("src/a.ts", "import {b} from './b.js';\nimport x from '../lib/x';\nconst c = await import('./c');\nimport 'react';\n"),
            ("src/b.ts", "export * from './c/index';\nconst q = require(\"./a\");\n"),
            ("src/c/index.ts", "// import d from './nope'\n"),
            ("lib/x.mjs", ""),
            ("jq/src/main.c", "#include \"jv.h\"\n#include <stdio.h>\n#include \"util/str.h\"\n"),
            ("jq/src/jv.h", ""), ("jq/src/jv.c", "#include \"jv.h\"\n#include \"main.h\"\n"), ("jq/src/main.h", ""),
            ("jq/src/util/str.h", ""),
            ("pkg/__init__.py", ""), ("pkg/m.py", "from . import n\nfrom .n import thing\nimport pkg.sub.deep as d\n"), ("pkg/n.py", ""),
            ("pkg/sub/deep.py", "from ..m import x\n"),
            ("run.sh", ". ./lib.sh\nsource \"$here/lib.sh\"\n"), ("lib.sh", ""),
            ("go.mod", "module example.com/m\n"), ("cmd/main.go", "package main\nimport (\n  \"fmt\"\n  q \"example.com/m/pkg\"\n)\n"),
            ("pkg/a.go", "package pkg\nimport \"example.com/m/pkg/sub\"\n"), ("pkg/a_test.go", ""), ("pkg/sub/b.go", "package sub\n"),
            ("src/main/java/a/App.java", "import a.util.Helper;\nimport static a.util.Helper.run;\n"), ("src/main/java/a/util/Helper.java", ""),
        ]);
        assert_eq!(pairs(&d), [
            ("src/a.ts", "src/b.ts"), ("src/a.ts", "src/c/index.ts"), ("src/a.ts", "lib/x.mjs"),
            ("src/b.ts", "src/a.ts"), ("src/b.ts", "src/c/index.ts"),
            ("jq/src/main.c", "jq/src/jv.c"), ("jq/src/main.c", "jq/src/util/str.h"),
            ("jq/src/jv.c", "jq/src/main.c"),
            ("pkg/m.py", "pkg/n.py"), ("pkg/m.py", "pkg/sub/deep.py"),
            ("pkg/sub/deep.py", "pkg/m.py"),
            ("run.sh", "lib.sh"),
            ("cmd/main.go", "pkg/a.go"), ("pkg/a.go", "pkg/sub/b.go"),
            ("src/main/java/a/App.java", "src/main/java/a/util/Helper.java"),
        ]);
        let uses = |a: &str, b: &str| d.iter().find(|(x, y, _)| x == a && y == b).map(|e| e.2);
        assert_eq!(uses("run.sh", "lib.sh"), Some(2));
        assert_eq!(uses("pkg/m.py", "pkg/n.py"), Some(2));
        assert_eq!(uses("src/main/java/a/App.java", "src/main/java/a/util/Helper.java"), Some(2));
    }

    fn random_graph(rng: &mut Rng, n: usize, m: usize) -> Vec<Vec<usize>> {
        let mut adj = vec![Vec::new(); n];
        for _ in 0..m { let (a, b) = (rng.below(n), rng.below(n)); if a != b && !adj[a].contains(&b) { adj[a].push(b); } }
        adj
    }
    fn reach_brute(adj: &[Vec<usize>], s: usize) -> Vec<bool> {
        let mut seen = vec![false; adj.len()];
        let mut q = vec![s];
        seen[s] = true;
        while let Some(v) = q.pop() { for &w in &adj[v] { if !seen[w] { seen[w] = true; q.push(w); } } }
        seen
    }

    #[test]
    fn components_and_reach_agree_with_brute_force_on_random_graphs() {
        let mut rng = Rng(11);
        for case in 0..400 {
            let n = 1 + rng.below(40);
            let m = rng.below(3 * n);
            let adj = random_graph(&mut rng, n, m);
            let brute: Vec<Vec<bool>> = (0..n).map(|s| reach_brute(&adj, s)).collect();
            // Two files are in one component exactly when each reaches the other.
            let comps = sccs(&adj);
            let mut comp = vec![usize::MAX; n];
            for (c, m) in comps.iter().enumerate() { for &v in m { assert_eq!(comp[v], usize::MAX, "case {case}: twice"); comp[v] = c; } }
            for a in 0..n { for b in 0..n { assert_eq!(comp[a] == comp[b], brute[a][b] && brute[b][a], "case {case} {a} {b}"); } }
            // Sinks first: no component reaches one found after it.
            for (c, m) in comps.iter().enumerate() { for &v in m { for &w in &adj[v] { assert!(comp[w] <= c, "case {case}"); } } }
            let r = reach(&adj);
            for s in 0..n { assert_eq!(r[s] as usize, brute[s].iter().filter(|&&x| x).count(), "case {case} from {s}"); }
        }
    }

    #[test]
    fn reach_without_bitsets_is_the_same() {
        // Past the exact limit the count is a walk per component: on a long chain, the same numbers.
        let n = 6500;
        let adj: Vec<Vec<usize>> = (0..n).map(|i| if i + 1 < n { vec![i + 1] } else { vec![] }).collect();
        let r = reach(&adj);
        assert_eq!(r[0] as usize, n);
        assert_eq!(r[n - 1], 1);
        assert!((propagation_cost(&r) - (n as f64 + 1.0) / (2.0 * n as f64)).abs() < 1e-9);
    }

    #[test]
    fn cutting_the_feedback_arcs_leaves_no_circle() {
        let mut rng = Rng(5);
        for case in 0..300 {
            let n = 2 + rng.below(25);
            let m = rng.below(4 * n) + n;
            let adj = random_graph(&mut rng, n, m);
            let edges: Vec<(usize, usize, u32)> = adj.iter().enumerate().flat_map(|(a, ws)| ws.iter().map(move |&b| (a, b, 1 + ((a * 7 + b) % 5) as u32))).collect();
            for comp in sccs(&adj).into_iter().filter(|c| c.len() > 1) {
                let cut = feedback_arcs(&comp, &edges);
                assert!(!cut.is_empty());
                let mut rest = vec![Vec::new(); n];
                for &(a, b, _) in &edges { if comp.contains(&a) && comp.contains(&b) && !cut.contains(&(a, b)) { rest[a].push(b); } }
                assert!(sccs(&rest).iter().all(|c| c.len() == 1), "case {case}: still a circle after cutting {cut:?}");
                // The same arcs whatever order the edges come in.
                let mut shuffled = edges.clone();
                shuffled.reverse();
                assert_eq!(feedback_arcs(&comp, &shuffled), cut, "case {case}");
            }
        }
        // A circle of three with one light arc: that arc is the one cut.
        assert_eq!(feedback_arcs(&[0, 1, 2], &[(0, 1, 5), (1, 2, 5), (2, 0, 1)]), [(2, 0)]);
    }

    #[test]
    fn relabeling_the_files_relabels_the_answers() {
        let mut rng = Rng(3);
        for _ in 0..100 {
            let n = 2 + rng.below(30);
            let adj = random_graph(&mut rng, n, 2 * n);
            let perm: Vec<usize> = { let mut p: Vec<usize> = (0..n).collect(); for i in (1..n).rev() { p.swap(i, rng.below(i + 1)); } p };
            let mut moved = vec![Vec::new(); n];
            for (a, ws) in adj.iter().enumerate() { for &b in ws { moved[perm[a]].push(perm[b]); } }
            let (r, rm) = (reach(&adj), reach(&moved));
            for v in 0..n { assert_eq!(r[v], rm[perm[v]]); }
            let sizes = |c: Vec<Vec<usize>>| { let mut s: Vec<usize> = c.iter().map(Vec::len).collect(); s.sort(); s };
            assert_eq!(sizes(sccs(&adj)), sizes(sccs(&moved)));
        }
    }
}
