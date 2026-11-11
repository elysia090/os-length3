//! Lines added and removed between two texts: the longest common subsequence of lines, as git's diff would count them
//! for files of the size a repo holds. Past a size where that is too slow, lines are counted as a multiset instead
//! (still right for appends and removals; only a move reads as both). The same as root3/app/repos/linediff.ts, for the app
//! and root3: the same table, the same choice between two equal ways (a removal before an addition).
//!
//! Each line is a number before the table is filled (the same text, the same number), so each of its cells compares
//! two numbers, not two lines' bytes.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind { Same, Add, Del }

/// Cells of the table past which lines are counted as a multiset.
const CAP: usize = 2_000_000;

fn split(t: &str) -> Vec<&str> {
    if t.is_empty() { Vec::new() } else { t.strip_suffix('\n').unwrap_or(t).split('\n').collect() }
}

/// Each line of `before` and `after` as it stays, goes or comes, in order.
pub fn ops<'a>(before: &'a str, after: &'a str) -> Vec<(Kind, &'a str)> {
    let (a, b) = (split(before), split(after));
    // Common head and tail first: most edits touch a little in the middle.
    let head = a.iter().zip(&b).take_while(|(p, q)| p == q).count();
    let tail = a[head..].iter().rev().zip(b[head..].iter().rev()).take_while(|(p, q)| p == q).count();
    let (x, y) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let mut out = Vec::with_capacity(a.len().max(b.len()) + x.len().min(y.len()));
    out.extend(a[..head].iter().map(|l| (Kind::Same, *l)));
    let mut ids: HashMap<&str, u32> = HashMap::with_capacity(x.len() + y.len());
    let mut id = |l: &&'a str| { let n = ids.len() as u32; *ids.entry(*l).or_insert(n) };
    let xs: Vec<u32> = x.iter().map(&mut id).collect();
    let ys: Vec<u32> = y.iter().map(&mut id).collect();
    if xs.len().saturating_mul(ys.len()) > CAP {
        let mut count = vec![0usize; ids.len()];
        for &l in &xs { count[l as usize] += 1; }
        let mut added = Vec::new();
        for (&l, text) in ys.iter().zip(y) {
            match &mut count[l as usize] { 0 => added.push(*text), n => *n -= 1 }
        }
        for (&l, text) in xs.iter().zip(x) {
            let n = &mut count[l as usize];
            if *n > 0 { *n -= 1; out.push((Kind::Del, *text)); }
        }
        out.extend(added.into_iter().map(|l| (Kind::Add, l)));
    } else {
        // lcs[i * w + j]: the longest common run of xs[i..] and ys[j..]; filled a row at a time from the last, each
        // row from the one below it, right to left. The cell to the right is the one just made (`right`), kept in a
        // register, and the row walked as iterators, so no cell is looked up by index nor read back from memory. A
        // run is never longer than the shorter side, at most √CAP lines: two bytes hold one. (A bit a cell would do
        // for the walk back, which asks only which way a cell went, but packing it costs more than the bytes it
        // saves: 16 instructions a cell to 9.)
        let w = ys.len() + 1;
        let mut lcs = vec![0u16; (xs.len() + 1) * w];
        for (i, &l) in xs.iter().enumerate().rev() {
            let (row, below) = lcs[i * w..].split_at_mut(w);
            let mut right = 0;
            for ((cell, &y), (&down, &diagonal)) in row[..ys.len()].iter_mut().zip(&ys).zip(below.iter().zip(&below[1..w])).rev() {
                right = if l == y { diagonal + 1 } else { down.max(right) };
                *cell = right;
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < xs.len() && j < ys.len() {
            if xs[i] == ys[j] { out.push((Kind::Same, x[i])); i += 1; j += 1; }
            else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] { out.push((Kind::Del, x[i])); i += 1; }
            else { out.push((Kind::Add, y[j])); j += 1; }
        }
        out.extend(x[i..].iter().map(|l| (Kind::Del, *l)));
        out.extend(y[j..].iter().map(|l| (Kind::Add, *l)));
    }
    out.extend(a[a.len() - tail..].iter().map(|l| (Kind::Same, *l)));
    out
}

/// (added, removed)
pub fn counts(ops: &[(Kind, &str)]) -> (u64, u64) {
    ops.iter().fold((0, 0), |(a, r), (k, _)| match k { Kind::Add => (a + 1, r), Kind::Del => (a, r + 1), Kind::Same => (a, r) })
}

#[cfg(test)]
#[path = "diff.test.rs"]
mod tests;
