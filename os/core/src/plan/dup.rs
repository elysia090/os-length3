//! Code written twice: stretches of tokens that are the same once names and literals are set aside (a copy with its
//! names changed is still a copy), found by winnowing (Schleimer, Wilkerson and Aiken, "Winnowing: local algorithms
//! for document fingerprinting", 2003): every K-token stretch is hashed, and of every W hashes in a row the least is
//! kept. Two files that share a stretch of K + W - 1 tokens or more share a kept hash, so every such copy is found;
//! from it, the copy is followed token by token both ways to its whole length. A stretch that says little (a table's
//! rows, a run of `}`) is not a copy of anything worth folding: one with fewer than DIVERSE kinds of token is left.
//! Nor is code that only has the same shape: two of a hundred declarations alike but for their names and strings
//! (each flag of a program defined the same way) were each written for itself, not copied. A copy keeps most of what
//! it was copied from: of the places where names stand, at least ALIKE must be the very same text, and of those
//! where literals stand (if there are a few), at least ALIKE_LITERALS. Parallel declarations keep their names (the
//! same methods of the same trait, a hundred times) and differ in their literals (each flag's own name and words);
//! a copy keeps both.

#![forbid(unsafe_code)]

use std::collections::HashMap;

/// Tokens hashed together.
pub const K: usize = 24;
/// Hashes a window keeps the least of.
pub const W: usize = 16;
/// The shortest copy reported, in tokens (every copy this long is found: it is at least K + W - 1).
pub const MIN_TOKENS: usize = 60;
/// The fewest kinds of token a copy must have.
pub const DIVERSE: usize = 12;
/// The share of a copy's names that must be the same text in both places.
pub const ALIKE: f64 = 0.6;
/// The share of its literals, when it has at least LITERALS of them.
pub const ALIKE_LITERALS: f64 = 0.5;
pub const LITERALS: usize = 3;
/// A hash found in more places than this is boilerplate, not a copy to fold.
const COMMON: usize = 32;

/// A token as copies are compared: names as one symbol, literals as another, everything else as itself.
pub const NAME: u32 = 1;
pub const LITERAL: u32 = 2;

/// One copy: the same tokens in two places, each (file, first token, one past the last).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Copy { pub a: (usize, u32, u32), pub b: (usize, u32, u32) }

impl Copy { pub fn tokens(&self) -> u32 { self.a.2 - self.a.1 } }

fn mix(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The kept hashes of one file's tokens: (hash, position of its stretch).
pub fn fingerprints(toks: &[u32]) -> Vec<(u64, u32)> {
    if toks.len() < K { return Vec::new(); }
    const B: u64 = 1_000_003;
    let top = (0..K - 1).fold(1u64, |p, _| p.wrapping_mul(B));
    let mut h = 0u64;
    let mut hashes = Vec::with_capacity(toks.len() - K + 1);
    for (i, &t) in toks.iter().enumerate() {
        if i >= K { h = h.wrapping_sub((toks[i - K] as u64).wrapping_mul(top)); }
        h = h.wrapping_mul(B).wrapping_add(t as u64);
        if i + 1 >= K { hashes.push(mix(h)); }
    }
    // The least of each window of W (the rightmost of equals), each kept once: a deque of candidates.
    let mut out: Vec<(u64, u32)> = Vec::new();
    let mut dq: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    let w = W.min(hashes.len());
    for i in 0..hashes.len() {
        while dq.back().is_some_and(|&j| hashes[j] >= hashes[i]) { dq.pop_back(); }
        dq.push_back(i);
        if dq.front().is_some_and(|&j| j + w <= i) { dq.pop_front(); }
        if i + 1 >= w {
            if let Some(&j) = dq.front() {
                if out.last().is_none_or(|&(_, p)| p as usize != j) { out.push((hashes[j], j as u32)); }
            }
        }
    }
    out
}

/// A file's tokens: as compared (names and literals each one symbol), and as written (each token's text, hashed).
pub struct Tokens { pub compared: Vec<u32>, pub written: Vec<u32> }

/// Every copy among the files, each once, each as long as it goes.
pub fn copies(files: &[Tokens]) -> Vec<Copy> {
    let mut index: HashMap<u64, Vec<(u32, u32)>> = HashMap::new();
    for (f, toks) in files.iter().enumerate() {
        for (h, p) in fingerprints(&toks.compared) { index.entry(h).or_default().push((f as u32, p)); }
    }
    let mut keys: Vec<&u64> = index.keys().collect();
    keys.sort_unstable();
    // Copies found so far, by (file a, file b, diagonal): the stretches of a they cover.
    let mut covered: HashMap<(u32, u32, i64), Vec<(u32, u32)>> = HashMap::new();
    let mut out = Vec::new();
    for h in keys {
        let places = &index[h];
        if places.len() < 2 || places.len() > COMMON { continue; }
        for x in 0..places.len() {
            for y in x + 1..places.len() {
                let ((fa, pa), (fb, pb)) = if places[x] <= places[y] { (places[x], places[y]) } else { (places[y], places[x]) };
                let diag = pb as i64 - pa as i64;
                if fa == fb && (diag as usize) < K { continue; }
                let key = (fa, fb, diag);
                if covered.get(&key).is_some_and(|c| c.iter().any(|&(s, e)| s <= pa && pa < e)) { continue; }
                let (ta, tb) = (&files[fa as usize].compared, &files[fb as usize].compared);
                // Back, then on, while the tokens agree (and, in one file, the two stretches stay apart).
                let (mut a0, mut b0) = (pa as usize, pb as usize);
                while a0 > 0 && b0 > 0 && ta[a0 - 1] == tb[b0 - 1] { a0 -= 1; b0 -= 1; }
                let (mut a1, mut b1) = (pa as usize, pb as usize);
                while a1 < ta.len() && b1 < tb.len() && ta[a1] == tb[b1] && !(fa == fb && a1 >= b0) { a1 += 1; b1 += 1; }
                covered.entry(key).or_default().push((a0 as u32, a1 as u32));
                if a1 - a0 < MIN_TOKENS { continue; }
                let mut kinds: Vec<u32> = ta[a0..a1].to_vec();
                kinds.sort_unstable();
                kinds.dedup();
                if kinds.len() < DIVERSE { continue; }
                let (wa, wb) = (&files[fa as usize].written, &files[fb as usize].written);
                let agree = |kind: u32| {
                    let at: Vec<usize> = (a0..a1).filter(|&i| ta[i] == kind).collect();
                    (at.iter().filter(|&&i| wa.get(i) == wb.get(i - a0 + b0)).count(), at.len())
                };
                let ((names_same, names), (lits_same, lits)) = (agree(NAME), agree(LITERAL));
                if names > 0 && (names_same as f64) < ALIKE * names as f64 { continue; }
                if lits >= LITERALS && (lits_same as f64) < ALIKE_LITERALS * lits as f64 { continue; }
                out.push(Copy { a: (fa as usize, a0 as u32, a1 as u32), b: (fb as usize, b0 as u32, b1 as u32) });
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::lex::tests::Rng;

    /// Random code-like tokens: names, literals and some hundred other kinds.
    fn code(rng: &mut Rng, n: usize) -> Vec<u32> {
        (0..n).map(|_| match rng.below(10) { 0..=2 => NAME, 3 => LITERAL, _ => 10 + rng.below(200) as u32 }).collect()
    }
    /// Tokens as written for these as compared: each name and literal a text of its own, from `seed`.
    fn written(compared: &[u32], rng: &mut Rng) -> Tokens {
        Tokens { compared: compared.to_vec(), written: compared.iter().map(|&c| if c <= LITERAL { 1000 + rng.below(50) as u32 } else { c }).collect() }
    }
    /// The same text as written (a copy as it was copied).
    fn same(t: &Tokens) -> Tokens { Tokens { compared: t.compared.clone(), written: t.written.clone() } }

    #[test]
    fn every_window_keeps_a_hash() {
        let mut rng = Rng(1);
        for _ in 0..200 {
            let n = K + rng.below(400);
            let t = code(&mut rng, n);
            let f = fingerprints(&t);
            let positions: Vec<u32> = f.iter().map(|x| x.1).collect();
            // Each window of W stretches has a kept position in it (the guarantee winnowing rests on).
            let stretches = n - K + 1;
            for start in 0..stretches.saturating_sub(W - 1) {
                assert!(positions.iter().any(|&p| p as usize >= start && (p as usize) < start + W), "window at {start} of {stretches}");
            }
            assert!(positions.windows(2).all(|w| w[0] < w[1]));
        }
    }

    /// Files of random tokens (each name and literal its own text), with `copy` planted in each at a random place.
    fn planted(rng: &mut Rng, copy: &Tokens, files: usize) -> (Vec<Tokens>, Vec<usize>) {
        let mut out = Vec::new();
        let mut at = Vec::new();
        for _ in 0..files {
            let (pre, post) = (rng.below(300), rng.below(300));
            let p = code(rng, pre);
            let q = code(rng, post);
            let (wp, wq) = (written(&p, rng), written(&q, rng));
            out.push(Tokens {
                compared: [p, copy.compared.clone(), q].concat(),
                written: [wp.written, copy.written.clone(), wq.written].concat(),
            });
            at.push(pre);
        }
        (out, at)
    }

    #[test]
    fn a_planted_copy_is_found_whole_and_unrelated_code_has_none() {
        let mut rng = Rng(2);
        for case in 0..300 {
            let len = MIN_TOKENS + rng.below(200);
            let c = code(&mut rng, len);
            let copy = written(&c, &mut rng);
            let (files, at) = planted(&mut rng, &copy, 2);
            let found = copies(&files);
            let hit = found.iter().find(|x| x.a.0 == 0 && x.b.0 == 1 && x.a.1 as usize <= at[0] && x.a.2 as usize >= at[0] + len);
            assert!(hit.is_some(), "case {case}: {found:?} for a copy at {}..{} and {}", at[0], at[0] + len, at[1]);
            // Nothing else is a copy (beyond chance stretches the copy's ends grow by a token or two).
            assert!(found.iter().all(|x| x.tokens() as usize <= len + 8), "case {case}");
        }
        let mut rng = Rng(3);
        let files: Vec<Tokens> = (0..20).map(|_| { let c = code(&mut rng, 2000); written(&c, &mut rng) }).collect();
        assert_eq!(copies(&files), []);
    }

    #[test]
    fn a_copy_with_some_names_changed_is_one_and_the_same_shape_alone_is_not() {
        let mut rng = Rng(6);
        let c = code(&mut rng, 150);
        let original = written(&c, &mut rng);
        let named: Vec<usize> = (0..c.len()).filter(|&i| c[i] <= LITERAL).collect();
        // A third of its names and literals changed: still a copy. Half or all: the same shape, not a copy.
        for (share, found) in [(0.3, true), (0.5, false), (1.0, false)] {
            let mut renamed = same(&original);
            for &i in named.iter().take((share * named.len() as f64) as usize) { renamed.written[i] += 5000; }
            assert_eq!(!copies(&[same(&original), renamed]).is_empty(), found, "{share} of its names changed");
        }
        // Every name kept, every literal its own (a hundred declarations of one trait's methods): not a copy.
        let mut parallel = same(&original);
        for (i, &x) in c.iter().enumerate() { if x == LITERAL { parallel.written[i] += 7000; } }
        assert!(copies(&[same(&original), parallel]).is_empty());
    }

    #[test]
    fn a_copy_within_one_file_and_three_copies() {
        let mut rng = Rng(4);
        let c = written(&code(&mut rng, 90), &mut rng);
        let gap = written(&code(&mut rng, 50), &mut rng);
        let one = Tokens { compared: [c.compared.clone(), gap.compared, c.compared.clone()].concat(), written: [c.written.clone(), gap.written, c.written.clone()].concat() };
        let found = copies(&[one]);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].a, found[0].b), ((0, 0, 90), (0, 140, 230)));
        let three = copies(&[same(&c), same(&c), same(&c)]);
        assert_eq!(three.len(), 3, "each pair of the three: {three:?}");
    }

    #[test]
    fn repetition_is_not_a_copy() {
        // A table: `{ L , L } ,` again and again, in two files and within one.
        let row = [100, LITERAL, 101, LITERAL, 102, 101];
        let table: Vec<u32> = row.iter().copied().cycle().take(600).collect();
        let t = Tokens { written: table.clone(), compared: table };
        assert_eq!(copies(&[same(&t), t]), []);
    }
}
