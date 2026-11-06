//! Lines added and removed between two texts: the longest common
//! subsequence of lines, as git's diff would count them for files of the
//! size a repo holds. Past a size where that is too slow, lines are counted
//! as a multiset instead (still right for appends and removals; only a move
//! reads as both). The same as src/repos/linediff.ts, for the app and l3.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind { Same, Add, Del }

const CAP: usize = 2_000_000;

fn split(t: &str) -> Vec<&str> {
    if t.is_empty() { Vec::new() } else { t.strip_suffix('\n').unwrap_or(t).split('\n').collect() }
}

pub fn ops<'a>(before: &'a str, after: &'a str) -> Vec<(Kind, &'a str)> {
    let (a, b) = (split(before), split(after));
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] { head += 1; }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] { tail += 1; }
    let (x, y) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let mut out: Vec<(Kind, &str)> = a[..head].iter().map(|l| (Kind::Same, *l)).collect();
    if x.len().saturating_mul(y.len()) > CAP {
        let mut count = std::collections::HashMap::new();
        for l in x { *count.entry(*l).or_insert(0usize) += 1; }
        let mut added = Vec::new();
        for l in y {
            match count.get_mut(l) { Some(n) if *n > 0 => *n -= 1, _ => added.push(*l) }
        }
        for l in x {
            if let Some(n) = count.get_mut(l) { if *n > 0 { *n -= 1; out.push((Kind::Del, *l)); } }
        }
        out.extend(added.into_iter().map(|l| (Kind::Add, l)));
    } else {
        let w = y.len() + 1;
        let mut lcs = vec![0u32; (x.len() + 1) * w];
        for i in (0..x.len()).rev() {
            for j in (0..y.len()).rev() {
                lcs[i * w + j] = if x[i] == y[j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < x.len() && j < y.len() {
            if x[i] == y[j] { out.push((Kind::Same, x[i])); i += 1; j += 1; }
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
mod tests {
    use super::*;

    #[test]
    fn a_change_in_the_middle_is_one_line_each_way() {
        let o = ops("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(counts(&o), (1, 1));
        assert_eq!(o, vec![(Kind::Same, "a"), (Kind::Del, "b"), (Kind::Add, "B"), (Kind::Same, "c")]);
        assert_eq!(counts(&ops("", "x\ny")), (2, 0));
        assert_eq!(counts(&ops("x\n", "")), (0, 1));
    }
}
