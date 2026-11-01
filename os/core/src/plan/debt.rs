//! What the repo's debt costs, and what to do about it first.
//!
//! Every kind of debt is weighed in one unit: the lines a change must read (or write again) beyond what the change
//! itself is, per hundred commits, at the rate the repo's history says each file changes. A change lands on a line of
//! a file at random (each line as likely), so it lands in a function as often as the function is long:
//!
//! - A function of complexity c over T (cognitive complexity, shape.rs) costs every change that lands in it the part
//!   of a reading of it beyond what T would take: its lines times (c - T) / c. Rewriting it costs about one reading
//!   (its lines), so it pays back after c / (c - T) changes land in it, however long it is. Done: rewritten, every
//!   function in its place at most T.
//! - A circle of files (graph.rs) costs every change to a file in it a look at each file that depends on it, more
//!   than without the circle: PER_FILE lines each. Done: the uses Eades–Lin–Smyth's order runs backwards are moved
//!   (PER_USE lines of work each), and the files are a circle no more.
//! - Code written k times (dup.rs) costs every change that lands in one copy the other k-1 copies, read and changed
//!   again. Done: folded into one, no copy left between those files.
//!
//! A step pays for itself after effort / cost hundred commits (its payback). It is a step to take when it pays back
//! within the horizon: as many commits again as the history has (Lindy: what has lasted is as likely to last as long
//! again), at least 100 and at most 1000. Debt that would not pay back in time is kept, and said to be: keeping it is
//! the cheaper choice, and the plan says so rather than hiding it. The steps are in order of payback. The dominant ones
//! are the fewest that together cost 80% of all the debt.
//!
//! The constants (T, PER_FILE, PER_USE) set how the three kinds compare. A step's place is sure when no weighting of
//! the kinds within a factor of SURE either way would put a step of another kind before it: since each kind's weight
//! scales all its steps alike, that holds when it pays back SURE² times faster than any later step of another kind.

#![forbid(unsafe_code)]

use super::{graph, Analysis};
use serde::Serialize;
use std::collections::BTreeMap;

/// Campbell's threshold for a function (SonarSource's default).
pub const T: u32 = 15;
pub const PER_FILE: f64 = 10.0;
pub const PER_USE: f64 = 10.0;
pub const SURE: f64 = 2.0;
/// The share of all the debt the dominant steps carry.
pub const DOMINANT: f64 = 0.8;
/// The newest commits held out to check the rates against.
pub const FORETOLD: usize = 300;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Rewrite, Untangle, Fold }

/// A place a step is about: a file, lines in it, and the function's name if it is one.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct At { pub path: String, pub line: u32, pub end: u32, #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<String> }

/// What a step is done when, each checkable by planning again.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "check", rename_all = "camelCase")]
pub enum Check {
    /// No function in `path` named `name` (or new in its place) over `most`.
    AtMost { path: String, name: String, most: u32 },
    /// These files are not in one circle.
    NoCircle { paths: Vec<String> },
    /// No copy between these places' files.
    NoCopy { paths: Vec<String> },
    /// The repo's tests pass (run, not planned).
    Tests,
}

/// The numbers a step stands on.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "of", rename_all = "camelCase")]
pub enum Facts {
    Function { complexity: u32, nesting: u32, lines: u32, changes: f64 },
    Circle { files: usize, cut: Vec<Cut>, reach: u64 },
    Copies { copies: usize, lines: u32, tokens: u32 },
}

/// A use to move to break a circle: from one file to another, how many, where.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Cut { pub from: String, pub to: String, pub uses: u32, pub lines: Vec<u32> }

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub kind: Kind,
    pub at: Vec<At>,
    /// Lines per hundred commits keeping it as it is costs.
    pub cost: f64,
    /// Lines of work the step is.
    pub effort: f64,
    /// Commits until it has paid for itself.
    pub payback: f64,
    pub facts: Facts,
    pub done: Vec<Check>,
    pub dominant: bool,
    pub sure: bool,
}

/// The repo at a glance.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Summary {
    pub files: usize,
    pub code_files: usize,
    pub functions: usize,
    pub lines: u64,
    pub commits: usize,
    pub over: usize,
    pub circles: usize,
    pub largest_circle: usize,
    pub copies: usize,
    /// The share of file pairs where a change to one can reach the other (MacCormack et al.), as a fraction.
    pub propagation: f64,
    pub set_aside: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Plan {
    pub summary: Summary,
    /// Whether the rates come from history (without it, every file is taken to change as often).
    pub history: bool,
    pub horizon: u32,
    /// All the debt's cost, per hundred commits.
    pub cost: f64,
    /// How well the rates the costs stand on foretold the newest commits (past.rs foretold), when there is history
    /// enough to hold some out.
    pub foretold: Option<super::past::Foretold>,
    /// The steps to take, by payback.
    pub steps: Vec<Step>,
    /// Debt that costs less to keep than to pay off within the horizon.
    pub kept: Vec<Step>,
    /// How many steps (taken or kept) are dominant.
    pub dominant: usize,
}

fn rate(a: &Analysis, f: usize) -> f64 { a.rates.change.get(f).copied().unwrap_or(0.0) }

/// The share of a file's changes landing in `lines` of it.
fn share(a: &Analysis, f: usize, lines: u32) -> f64 {
    let total = a.files[f].lines.max(1) as f64;
    (lines as f64 / total).min(1.0)
}

fn function_steps(a: &Analysis) -> Vec<Step> {
    let mut out = Vec::new();
    for (f, file) in a.files.iter().enumerate() {
        for g in file.funcs.iter().filter(|g| g.complexity > T) {
            let lines = g.end.saturating_sub(g.line) + 1;
            let changes = rate(a, f) * share(a, f, lines);
            let cost = changes * lines as f64 * (g.complexity - T) as f64 / g.complexity as f64;
            out.push(Step {
                kind: Kind::Rewrite,
                at: vec![At { path: file.path.clone(), line: g.line, end: g.end, name: Some(g.name.clone()) }],
                cost, effort: lines as f64, payback: 0.0,
                facts: Facts::Function { complexity: g.complexity, nesting: g.nesting, lines, changes },
                done: vec![Check::AtMost { path: file.path.clone(), name: g.name.clone(), most: T }, Check::Tests],
                dominant: false, sure: false,
            });
        }
    }
    out
}

/// Each file's dependents (itself among them): the files a change to it may reach.
fn dependents(n: usize, edges: &[(usize, usize)]) -> Vec<u32> {
    let mut rev = vec![Vec::new(); n];
    for &(a, b) in edges { rev[b].push(a); }
    for r in rev.iter_mut() { r.sort_unstable(); r.dedup(); }
    graph::reach(&rev)
}

fn circle_steps(a: &Analysis) -> Vec<Step> {
    let n = a.files.len();
    let all: Vec<(usize, usize)> = a.graph.edges.iter().map(|e| (e.from, e.to)).collect();
    let before = dependents(n, &all);
    let weighed: Vec<(usize, usize, u32)> = a.graph.edges.iter().map(|e| (e.from, e.to, e.uses)).collect();
    let mut out = Vec::new();
    for circle in &a.circles {
        let cut = graph::feedback_arcs(circle, &weighed);
        let kept: Vec<(usize, usize)> = all.iter().copied().filter(|e| cut.binary_search(e).is_err()).collect();
        let after = dependents(n, &kept);
        let cost: f64 = (0..n).map(|f| rate(a, f) * PER_FILE * (before[f] - after[f]) as f64).sum();
        let cuts: Vec<Cut> = cut.iter().filter_map(|&(x, y)| {
            let e = a.graph.edges.iter().find(|e| e.from == x && e.to == y)?;
            Some(Cut { from: a.files[x].path.clone(), to: a.files[y].path.clone(), uses: e.uses, lines: e.lines.clone() })
        }).collect();
        let uses: u32 = cuts.iter().map(|c| c.uses).sum();
        let paths: Vec<String> = circle.iter().map(|&f| a.files[f].path.clone()).collect();
        // Its files, the most changed first (the one it is said to be around).
        let mut members: Vec<usize> = circle.clone();
        members.sort_by(|&x, &y| rate(a, y).total_cmp(&rate(a, x)).then(x.cmp(&y)));
        out.push(Step {
            kind: Kind::Untangle,
            at: members.iter().map(|&f| At { path: a.files[f].path.clone(), line: 1, end: a.files[f].lines.max(1), name: None }).collect(),
            cost, effort: uses.max(1) as f64 * PER_USE, payback: 0.0,
            facts: Facts::Circle { files: circle.len(), cut: cuts, reach: (0..n).map(|f| (before[f] - after[f]) as u64).sum() },
            done: vec![Check::NoCircle { paths }, Check::Tests],
            dominant: false, sure: false,
        });
    }
    out
}

/// Copies gathered into groups, each a place and the places that are copies of it (one hop: two places alike only
/// through a third are not taken as copies of each other). Two places each half or more of the other are one place.
/// The place with most copies is grouped first.
fn copy_steps(a: &Analysis) -> Vec<Step> {
    let mut places: Vec<(usize, u32, u32)> = Vec::new();
    let mut tokens: Vec<u32> = Vec::new();
    let find = |pl: (usize, u32, u32), places: &[(usize, u32, u32)]| places.iter().position(|&(f, s, e)| {
        let overlap = e.min(pl.2).saturating_sub(s.max(pl.1)) + 1;
        let longer = (e - s + 1).max(pl.2 - pl.1 + 1);
        f == pl.0 && s <= pl.2 && pl.1 <= e && overlap * 2 >= longer
    });
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for c in &a.copies {
        let mut id = |pl: (usize, u32, u32)| match find(pl, &places) {
            Some(i) => { tokens[i] = tokens[i].max(c.tokens); i }
            None => { places.push(pl); tokens.push(c.tokens); places.len() - 1 }
        };
        let (x, y) = (id(c.a), id(c.b));
        if x != y { pairs.push((x.min(y), x.max(y))); }
    }
    pairs.sort_unstable();
    pairs.dedup();
    let mut partners: Vec<Vec<usize>> = vec![Vec::new(); places.len()];
    for &(x, y) in &pairs { partners[x].push(y); partners[y].push(x); }
    let mut taken = vec![false; places.len()];
    let mut by_copies: Vec<usize> = (0..places.len()).collect();
    by_copies.sort_by(|&x, &y| partners[y].len().cmp(&partners[x].len()).then(places[x].cmp(&places[y])));
    let mut out = Vec::new();
    for &centre in &by_copies {
        if taken[centre] { continue; }
        let mut members: Vec<usize> = std::iter::once(centre).chain(partners[centre].iter().copied().filter(|&q| !taken[q])).collect();
        if members.len() < 2 { continue; }
        members[1..].sort_by(|&x, &y| places[x].cmp(&places[y]));
        for &m in &members { taken[m] = true; }
        let k = members.len();
        let lines: Vec<u32> = members.iter().map(|&i| places[i].2 - places[i].1 + 1).collect();
        let mean = lines.iter().sum::<u32>() as f64 / k as f64;
        let cost: f64 = members.iter().zip(&lines).map(|(&i, &l)| rate(a, places[i].0) * share(a, places[i].0, l) * (k - 1) as f64 * mean).sum();
        let at: Vec<At> = members.iter().map(|&i| At { path: a.files[places[i].0].path.clone(), line: places[i].1, end: places[i].2, name: None }).collect();
        let mut paths: Vec<String> = at.iter().map(|x| x.path.clone()).collect();
        paths.sort();
        paths.dedup();
        out.push(Step {
            kind: Kind::Fold,
            cost, effort: mean + 2.0 * k as f64, payback: 0.0,
            facts: Facts::Copies { copies: k, lines: mean.round() as u32, tokens: members.iter().map(|&i| tokens[i]).max().unwrap_or(0) },
            done: vec![Check::NoCopy { paths }, Check::Tests],
            at, dominant: false, sure: false,
        });
    }
    out
}

pub fn summary(a: &Analysis) -> Summary {
    Summary {
        files: a.files.len(),
        code_files: a.files.iter().filter(|f| f.lang.is_some()).count(),
        functions: a.files.iter().map(|f| f.funcs.iter().filter(|g| g.name != super::shape::TOP).count()).sum(),
        lines: a.files.iter().filter(|f| f.lang.is_some()).map(|f| f.lines as u64).sum(),
        commits: a.history.read,
        over: a.files.iter().map(|f| f.funcs.iter().filter(|g| g.complexity > T).count()).sum(),
        circles: a.circles.len(),
        largest_circle: a.circles.first().map_or(0, Vec::len),
        copies: a.copies.len(),
        propagation: graph::propagation_cost(&a.reach),
        set_aside: a.set_aside,
    }
}

/// The plan for the repo's debt.
pub fn plan(a: &Analysis) -> Plan {
    let mut all: Vec<Step> = function_steps(a);
    all.extend(circle_steps(a));
    all.extend(copy_steps(a));
    all.retain(|s| s.cost > 0.0);
    for s in &mut all { s.payback = 100.0 * s.effort / s.cost; }
    let cost: f64 = all.iter().map(|s| s.cost).sum();
    // Dominant: the fewest, by cost, that carry DOMINANT of it all.
    let mut by_cost: Vec<usize> = (0..all.len()).collect();
    by_cost.sort_by(|&x, &y| all[y].cost.total_cmp(&all[x].cost).then(all[x].at.cmp(&all[y].at)));
    let mut carried = 0.0;
    let mut dominant = 0;
    for &i in &by_cost {
        if carried >= DOMINANT * cost { break; }
        carried += all[i].cost;
        all[i].dominant = true;
        dominant += 1;
    }
    all.sort_by(|x, y| x.payback.total_cmp(&y.payback).then(y.cost.total_cmp(&x.cost)).then(x.at.cmp(&y.at)).then(x.kind.cmp(&y.kind)));
    // Sure: faster by SURE² than every later step of another kind.
    let n = all.len();
    let mut fastest_after: BTreeMap<Kind, f64> = BTreeMap::new();
    for i in (0..n).rev() {
        let speed = 1.0 / all[i].payback;
        let rival = fastest_after.iter().filter(|(k, _)| **k != all[i].kind).map(|(_, v)| *v).fold(0.0, f64::max);
        all[i].sure = speed >= SURE * SURE * rival;
        let e = fastest_after.entry(all[i].kind).or_insert(0.0);
        *e = e.max(speed);
    }
    let history = a.rates.known;
    let horizon = if history { (a.history.read as u32).clamp(100, 1000) } else { 1000 };
    let (steps, kept): (Vec<Step>, Vec<Step>) = all.into_iter().partition(|s| s.payback <= horizon as f64);
    let foretold = super::past::foretold(&a.history, a.files.len(), FORETOLD, super::past::HALF_LIFE);
    Plan { summary: summary(a), history, horizon, cost, foretold, steps, kept, dominant }
}

/// Whether a check holds of the repo as analyzed (Tests: not for the plan to say; None).
pub fn holds(a: &Analysis, check: &Check) -> Option<bool> {
    let index = |p: &str| a.files.iter().position(|f| f.path == p);
    Some(match check {
        Check::AtMost { path, name, most } => match index(path) {
            None => true,
            Some(f) => a.files[f].funcs.iter().filter(|g| &g.name == name).all(|g| g.complexity <= *most),
        },
        Check::NoCircle { paths } => {
            let ids: Vec<usize> = paths.iter().filter_map(|p| index(p)).collect();
            !a.circles.iter().any(|c| ids.iter().filter(|i| c.binary_search(i).is_ok()).count() > 1)
        }
        Check::NoCopy { paths } => {
            let ids: Vec<usize> = paths.iter().filter_map(|p| index(p)).collect();
            !a.copies.iter().any(|c| ids.contains(&c.a.0) && ids.contains(&c.b.0))
        }
        Check::Tests => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{analyze, past, Snapshot, Text};

    fn snap(files: &[(&str, String)]) -> Snapshot {
        Snapshot { texts: files.iter().map(|(p, s)| Text { path: p.to_string(), bytes: s.as_bytes().to_vec() }).collect(), set_aside: 0, git: true }
    }

    /// A function of complexity well over T, `lines` lines long.
    fn tangled(name: &str, depth: usize) -> String {
        let mut s = format!("fn {name}(a: u32) -> u32 {{\n");
        for d in 0..depth { s.push_str(&format!("{}if a > {d} {{\n", "  ".repeat(d + 1))); }
        s.push_str(&format!("{}return a;\n", "  ".repeat(depth + 1)));
        for d in (0..depth).rev() { s.push_str(&format!("{}}}\n", "  ".repeat(d + 1))); }
        s.push_str("  0\n}\n");
        s
    }
    /// The same lines, straight.
    fn straight(name: &str, depth: usize) -> String {
        let mut s = format!("fn {name}(a: u32) -> u32 {{\n");
        for d in 0..depth { s.push_str(&format!("  let _x{d} = a;\n")); }
        s.push_str("  let _y = a;\n");
        for d in 0..depth { s.push_str(&format!("  let _z{d} = a;\n")); }
        s.push_str("  0\n}\n");
        s
    }
    fn history(files: &[usize], n: usize) -> past::History {
        past::History { commits: (0..n).map(|i| past::Commit { id: i.to_string(), time: 0, subject: "change".into(), files: vec![files[i % files.len()]], fix: false }).collect(), read: n }
    }

    #[test]
    fn a_step_taken_removes_exactly_what_it_said_it_cost() {
        // Two tangled functions in two files, one changed far more often.
        let files = [("src/hot.rs", tangled("hot", 7) + &straight("calm", 3)), ("src/cold.rs", tangled("cold", 6))];
        let h = history(&[0, 0, 0, 1], 400);
        let a = analyze(&snap(&files), h.clone());
        let p = plan(&a);
        assert!(p.history);
        assert_eq!(p.steps.len(), 2, "{:?}", p.steps);
        let first = &p.steps[0];
        assert_eq!(first.at[0].name.as_deref(), Some("hot"));
        assert!(first.payback < p.steps[1].payback);
        assert!((p.cost - p.steps.iter().map(|s| s.cost).sum::<f64>()).abs() < 1e-9);
        // Take it: the same lines, straight. Its checks hold, and the debt left is exactly the rest.
        let after = analyze(&snap(&[("src/hot.rs", straight("hot", 7) + &straight("calm", 3)), files[1].clone()]), h);
        assert_eq!(after.files[0].lines, a.files[0].lines, "the same lines, so nothing else's share moves");
        for c in &first.done { assert_ne!(holds(&after, c), Some(false), "{c:?}"); }
        assert_eq!(holds(&a, &first.done[0]), Some(false), "before, it did not hold");
        let p2 = plan(&after);
        assert!((p2.cost - (p.cost - first.cost)).abs() < 1e-9, "{} vs {} - {}", p2.cost, p.cost, first.cost);
    }

    #[test]
    fn a_circle_is_cut_where_it_is_thinnest_and_cutting_it_holds() {
        let mut files: Vec<(&str, String)> = vec![("src/lib.rs", "mod a;\nmod b;\nmod c;\n".into())];
        files.push(("src/a.rs", "use crate::b::x;\nuse crate::b::y;\nuse crate::b::z;\n".into()));
        files.push(("src/b.rs", "use crate::c::x;\nuse crate::c::y;\n".into()));
        files.push(("src/c.rs", "fn f() { crate::a::g(); }\n".into()));
        let a = analyze(&snap(&files), history(&[1, 2, 3], 300));
        let p = plan(&a);
        let step = p.steps.iter().chain(&p.kept).find(|s| s.kind == Kind::Untangle).expect("the circle a → b → c → a");
        let Facts::Circle { files: n, cut, .. } = &step.facts else { panic!() };
        assert_eq!(*n, 3);
        assert_eq!(cut.iter().map(|c| (c.from.as_str(), c.to.as_str(), c.uses)).collect::<Vec<_>>(), [("src/c.rs", "src/a.rs", 1)]);
        let fixed = analyze(&snap(&[files[0].clone(), files[1].clone(), files[2].clone(), ("src/c.rs", "fn f() { g(); }\n".into())]), history(&[1, 2, 3], 300));
        assert_eq!(holds(&a, &step.done[0]), Some(false));
        assert_eq!(holds(&fixed, &step.done[0]), Some(true));
    }

    #[test]
    fn copies_are_one_step_and_folding_them_holds() {
        // Varied code (not a table's rows), copied with its names changed.
        let body = "    let total = w.iter().sum::<u32>();\n    if total > 10 { println!(\"big {}\", total); }\n    for (i, x) in w.iter().enumerate() {\n        match x % 3 { 0 => out.push(i), 1 => out.insert(0, i), _ => {} }\n    }\n    while let Some(v) = out.pop() { if v == 7 { break; } }\n    let mean = total as f64 / w.len().max(1) as f64;\n    assert!(mean >= 0.0, \"mean {}\", mean);\n";
        let one = format!("fn a(w: &[u32]) {{\n{body}}}\n");
        let two = format!("fn b(q: &[u32]) {{\n{}}}\n", body.replace("w.", "q."));
        let three = format!("fn c(z: &[u32]) {{\n{}}}\n", body.replace("w.", "z.").replace("total", "sum"));
        let a = analyze(&snap(&[("x.rs", one.clone()), ("y.rs", two), ("z.rs", three)]), history(&[0, 1, 2], 300));
        let p = plan(&a);
        let folds: Vec<&Step> = p.steps.iter().chain(&p.kept).filter(|s| s.kind == Kind::Fold).collect();
        assert_eq!(folds.len(), 1, "three copies, one step: {folds:?}");
        assert!(matches!(folds[0].facts, Facts::Copies { copies: 3, .. }));
        let gone = analyze(&snap(&[("x.rs", one), ("y.rs", "fn b() {}\n".into()), ("z.rs", "fn c() {}\n".into())]), history(&[0, 1, 2], 300));
        assert_eq!(holds(&gone, &folds[0].done[0]), Some(true));
        assert_eq!(holds(&a, &folds[0].done[0]), Some(false));
    }

    #[test]
    fn what_never_changes_is_kept_and_dominance_and_sureness_are_what_they_say() {
        // A tangled file no commit touches: keeping it costs nothing, so it is no step at all.
        let a = analyze(&snap(&[("src/old.rs", tangled("old", 8)), ("src/new.rs", "fn n() {}\n".into())]), history(&[1], 300));
        let p = plan(&a);
        assert!(p.steps.is_empty() && p.kept.is_empty());
        assert_eq!(p.summary.over, 1);
        // Many functions: the dominant ones carry 80% by cost and are the fewest that do.
        let files: Vec<(String, String)> = (0..12).map(|i| (format!("src/f{i}.rs"), tangled(&format!("f{i}"), 4 + i % 5))).collect();
        let fs: Vec<(&str, String)> = files.iter().map(|(p, s)| (p.as_str(), s.clone())).collect();
        let a = analyze(&snap(&fs), history(&(0..12).collect::<Vec<_>>(), 600));
        let p = plan(&a);
        let all: Vec<&Step> = p.steps.iter().chain(&p.kept).collect();
        let dom: f64 = all.iter().filter(|s| s.dominant).map(|s| s.cost).sum();
        assert!(dom >= DOMINANT * p.cost - 1e-9);
        let least_dominant = all.iter().filter(|s| s.dominant).map(|s| s.cost).fold(f64::INFINITY, f64::min);
        assert!(dom - least_dominant < DOMINANT * p.cost, "one fewer would not do");
        assert_eq!(all.iter().filter(|s| s.dominant).count(), p.dominant);
        // Sure is what it says, over every pair (the identical functions are copies too, so two kinds are here): a
        // step is sure exactly when every later step of another kind pays back SURE² times slower or more.
        let fold_seen = all.iter().any(|s| s.kind == Kind::Fold);
        assert!(fold_seen, "the functions of the same depth are the same code");
        let ordered: Vec<&Step> = { let mut v = all.clone(); v.sort_by(|x, y| x.payback.total_cmp(&y.payback)); v };
        for (i, s) in ordered.iter().enumerate() {
            let holds = ordered[i + 1..].iter().filter(|t| t.kind != s.kind).all(|t| t.payback >= SURE * SURE * s.payback);
            assert_eq!(s.sure, holds, "{:?} at {}", s.kind, s.payback);
        }
        // Steps are in order of payback.
        assert!(p.steps.windows(2).all(|w| w[0].payback <= w[1].payback));
    }

    #[test]
    fn without_history_every_file_is_taken_to_change_alike() {
        let a = analyze(&snap(&[("a.rs", tangled("a", 7)), ("b.rs", tangled("b", 7))]), past::History::default());
        let p = plan(&a);
        assert!(!p.history);
        assert_eq!(p.horizon, 1000);
        assert_eq!(p.steps.len(), 2);
        assert!((p.steps[0].cost - p.steps[1].cost).abs() < 1e-9);
        assert_eq!(p.steps[0].at[0].path, "a.rs", "ties by place");
    }
}
