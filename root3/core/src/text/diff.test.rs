//! The tests of text/diff.rs.

use super::*;

#[test]
fn a_change_in_the_middle_is_one_line_each_way() {
    let o = ops("a\nb\nc\n", "a\nB\nc\n");
    assert_eq!(counts(&o), (1, 1));
    assert_eq!(o, vec![(Kind::Same, "a"), (Kind::Del, "b"), (Kind::Add, "B"), (Kind::Same, "c")]);
    assert_eq!(counts(&ops("", "x\ny")), (2, 0));
    assert_eq!(counts(&ops("x\n", "")), (0, 1));
}

/// The table filled as root3/app/repos/linediff.ts fills it, line against line: what `ops` must give, number for number.
fn as_the_page_does<'a>(before: &'a str, after: &'a str) -> Vec<(Kind, &'a str)> {
    let (a, b) = (split(before), split(after));
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] { head += 1; }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] { tail += 1; }
    let (x, y) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let mut out: Vec<(Kind, &str)> = a[..head].iter().map(|l| (Kind::Same, *l)).collect();
    if x.len() * y.len() > CAP {
        let mut count = HashMap::new();
        for l in x { *count.entry(*l).or_insert(0usize) += 1; }
        let mut added = Vec::new();
        for l in y { match count.get_mut(l) { Some(n) if *n > 0 => *n -= 1, _ => added.push(*l) } }
        for l in x { if let Some(n) = count.get_mut(l) { if *n > 0 { *n -= 1; out.push((Kind::Del, *l)); } } }
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

#[test]
fn every_text_is_told_as_the_page_tells_it_line_for_line() {
    let s = std::cell::Cell::new(0x9e37_79b9_7f4a_7c15u64);
    let next = |n: u64| { s.set(s.get().wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407)); (s.get() >> 33) % n };
    // Few distinct lines, so lines repeat and the table has many ways of equal length to choose between.
    let text = |lines: u64| (0..lines).map(|_| format!("l{}\n", next(6))).collect::<String>();
    for _ in 0..400 {
        let (n, m) = (next(40), next(40));
        let (a, b) = (text(n), text(m));
        assert_eq!(ops(&a, &b), as_the_page_does(&a, &b), "{a:?} → {b:?}");
    }
    // Past the cap, counted as a multiset, the same too.
    let (a, b) = (text(1500), text(1500));
    assert_eq!(ops(&a, &b), as_the_page_does(&a, &b));
}
