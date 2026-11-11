//! The order a function's blocks are lowered in: each loop's blocks together, its head first, so a jump back is a
//! loop's round and any other a jump forward; the loops that order makes; and a function past RUN blocks cut into
//! runs, each a wasm function of its own.

use crate::program::*;

/// A loop made of blocks `head..=last` (in the order they are lowered), gone round from its last block or any before
/// it back to its head; `parent`: the loop it lies within.
#[derive(Clone, Copy, Debug)]
pub struct Loop { pub head: usize, pub last: usize, pub parent: Option<usize> }

/// Each block's successors among `blocks` (in address order) by index, NO for none there: most often the next block,
/// else searched for.
pub(crate) fn successors(blocks: &[Block]) -> Vec<[u32; 2]> {
    let at = |k: usize, a: u64| match blocks.get(k + 1) {
        Some(b) if b.start == a => (k + 1) as u32,
        _ => blocks.binary_search_by_key(&a, |b| b.start).ok().map_or(NO, |k| k as u32),
    };
    blocks.iter().enumerate().map(|(k, b)| goes_to(b).map(|a| a.map_or(NO, |a| at(k, a)))).collect()
}

/// The loops of `blocks` (in address order) and the innermost each block is in.
pub fn loops_of(blocks: &[Block]) -> (Vec<Loop>, Vec<Option<usize>>) {
    let succ = successors(blocks);
    let (mut loops, mut within, mut last, mut open) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    loops_into(&succ, &mut loops, (&mut last, &mut open));
    within_of(&loops, blocks.len(), &mut within);
    (loops, within)
}

/// As `loops_of`, from each block's successors, into `loops`, with `last` and `open` for scratch.
pub(crate) fn loops_into(succ: &[[u32; 2]], loops: &mut Vec<Loop>, (last, open): (&mut Vec<usize>, &mut Vec<usize>)) {
    const NO: usize = usize::MAX;
    last.clear();
    last.resize(succ.len(), NO);
    for (k, to) in succ.iter().enumerate() {
        for h in to.iter().map(|&h| h as usize).filter(|&h| h <= k) { last[h] = if last[h] == NO { k } else { last[h].max(k) }; }
    }
    loops.clear();
    open.clear();
    for (head, &e) in last.iter().enumerate() {
        if e == NO { continue; }
        while open.last().is_some_and(|&o| loops[o].last < head) { open.pop(); }
        if open.last().is_some_and(|&o| e > loops[o].last) { continue; }
        loops.push(Loop { head, last: e, parent: open.last().copied() });
        open.push(loops.len() - 1);
    }
}

/// The innermost of `loops` (inner after outer) each of `n` blocks lies within past its head.
pub(crate) fn within_of(loops: &[Loop], n: usize, within: &mut Vec<Option<usize>>) {
    within.clear();
    within.resize(n, None);
    for (l, lp) in loops.iter().enumerate() { within[lp.head + 1..=lp.last].fill(Some(l)); }
}

/// Whether `function` goes backward anywhere (a loop's head), within it or out to an address before a block's (a run
/// of the same function).
pub fn has_loop(function: &Function) -> bool {
    function.blocks.iter().zip(&function.succ).enumerate().any(|(k, (b, to))| {
        goes_to(b).into_iter().zip(to).any(|(a, &t)| if t != NO { t as usize <= k } else { a.is_some_and(|a| a <= b.start) })
    })
}

/// What laying out a function's blocks works in, kept from one function to the next (nothing is allocated per
/// function once it has grown).
#[derive(Default)]
pub struct Layout {
    rpo: Vec<usize>, state: Vec<u8>, rounds: Vec<(usize, usize)>, post: Vec<usize>, path: Vec<(usize, usize)>,
    first: Vec<usize>, preds: Vec<usize>, fill: Vec<usize>, heads: Vec<usize>, mark: Vec<usize>, work: Vec<usize>,
    body: Vec<usize>, body_at: Vec<usize>, ranked: Vec<usize>, place: Vec<usize>, head_of: Vec<usize>, owner: Vec<usize>,
    parent: Vec<usize>, start: Vec<usize>, items: Vec<(usize, usize)>, put: Vec<usize>, stack: Vec<(usize, usize)>,
    order: Vec<usize>,
}

impl Layout {
    /// The order (new place → place by address, into `order`) blocks with successors `succ` (by address, the entry
    /// first) are lowered in, or false where it stays: each loop's blocks together, its head first, the rest in reverse
    /// postorder, so a jump to a block before is a loop's round and any other a jump forward (a compiler's while loop,
    /// its test last and jumped into, and its rare paths after it jumping back in, laid out by address goes round
    /// through the dispatch; laid out so, it is a wasm loop).
    fn lay_out(&mut self, succ: &[[u32; 2]]) -> bool {
        let n = succ.len();
        if n < 3 { return false; }
        const NONE: usize = usize::MAX;
        let Layout { rpo, state, rounds, post, path, first, preds, fill, heads, mark, work, body, body_at, ranked, place, head_of, owner, parent, start, items, put, stack, order } = self;
        // Depth first from the entry, then from each block not reached (only through the dispatch): each walk's reverse
        // postorder after the ones before; a jump to a block on the walk's path is a loop's round.
        rpo.clear(); rpo.resize(n, 0);
        state.clear(); state.resize(n, 0);
        rounds.clear();
        let mut numbered = 0;
        for root in 0..n {
            if state[root] != 0 { continue; }
            post.clear();
            path.push((root, 0));
            state[root] = 1;
            while let Some(&mut (u, ref mut next)) = path.last_mut() {
                if *next == 2 { state[u] = 2; post.push(u); path.pop(); continue; }
                let v = succ[u][*next];
                *next += 1;
                if v == NO { continue; }
                let v = v as usize;
                match state[v] { 0 => { state[v] = 1; path.push((v, 0)); } 1 => rounds.push((v, u)), _ => {} }
            }
            for (i, &u) in post.iter().rev().enumerate() { rpo[u] = numbered + i; }
            numbered += post.len();
        }
        if rounds.is_empty() { return false; }
        first.clear(); first.resize(n + 1, 0);
        for &v in succ.iter().flatten() { if v != NO { first[v as usize + 1] += 1; } }
        for k in 0..n { first[k + 1] += first[k]; }
        preds.clear(); preds.resize(first[n], 0);
        fill.clear(); fill.extend_from_slice(first);
        for (u, s) in succ.iter().enumerate() { for &v in s { if v != NO { let v = v as usize; preds[fill[v]] = u; fill[v] += 1; } } }
        // Each loop (a head), its blocks: those that reach a round to it without going through it, after it in the walk.
        rounds.sort_unstable();
        heads.clear(); heads.extend(rounds.iter().map(|&(h, _)| h)); heads.dedup();
        mark.clear(); mark.resize(n, NONE);
        body.clear(); body_at.clear();
        for (l, &h) in heads.iter().enumerate() {
            body_at.push(body.len());
            body.push(h);
            mark[h] = l;
            let at = rounds.partition_point(|&(g, _)| g < h);
            for &(_, u) in rounds[at..].iter().take_while(|&&(g, _)| g == h) {
                if rpo[u] > rpo[h] && mark[u] != l { mark[u] = l; body.push(u); work.push(u); }
            }
            while let Some(u) = work.pop() {
                for &p in &preds[first[u]..first[u + 1]] { if mark[p] != l && rpo[p] > rpo[h] { mark[p] = l; body.push(p); work.push(p); } }
            }
        }
        body_at.push(body.len());
        // Ranked from the least loop (fewest blocks, then latest head): a block's loop is the least holding it, a loop's
        // parent the least holding its head that ranks after it, so they nest as a tree.
        ranked.clear(); ranked.extend(0..heads.len());
        ranked.sort_unstable_by_key(|&l| (body_at[l + 1] - body_at[l], usize::MAX - rpo[heads[l]]));
        place.clear(); place.resize(heads.len(), 0);
        for (i, &l) in ranked.iter().enumerate() { place[l] = i; }
        head_of.clear(); head_of.resize(n, NONE);
        for (l, &h) in heads.iter().enumerate() { head_of[h] = l; }
        owner.clear(); owner.resize(n, NONE);
        parent.clear(); parent.resize(heads.len(), NONE);
        for &m in ranked.iter() {
            for &b in &body[body_at[m]..body_at[m + 1]] {
                if owner[b] == NONE { owner[b] = m; }
                let l = head_of[b];
                if l != NONE && l != m && parent[l] == NONE && place[m] > place[l] { parent[l] = m; }
            }
        }
        // Laid out from the outside in: a region's blocks and the loops directly in it in the walk's order, each loop
        // whole where its head falls. An item: a block b, or a loop n + l.
        let regions = heads.len() + 1;
        let region = |o: usize| if o == NONE { heads.len() } else { o };
        start.clear(); start.resize(regions + 1, 0);
        for &o in owner.iter().chain(parent.iter()) { start[region(o) + 1] += 1; }
        for r in 0..regions { start[r + 1] += start[r]; }
        items.clear(); items.resize(start[regions], (0, 0));
        put.clear(); put.extend_from_slice(start);
        for (b, &o) in owner.iter().enumerate() { let r = region(o); items[put[r]] = (rpo[b], b); put[r] += 1; }
        for (l, &p) in parent.iter().enumerate() { let r = region(p); items[put[r]] = (rpo[heads[l]], n + l); put[r] += 1; }
        for r in 0..regions { items[start[r]..start[r + 1]].sort_unstable(); }
        order.clear();
        stack.clear(); stack.push((heads.len(), start[heads.len()]));
        while let Some(&mut (r, ref mut at)) = stack.last_mut() {
            if *at == start[r + 1] { stack.pop(); continue; }
            let item = items[*at].1;
            *at += 1;
            if item < n { order.push(item); } else { stack.push((item - n, start[item - n])); }
        }
        order.len() == n && order[0] == 0
    }
}

impl Function {
    /// The function of `blocks` (sorted by address, the entry first), in the order they are lowered.
    pub fn new(start: u64, name: String, blocks: Vec<Block>) -> Function { Function::laid_out(start, name, blocks, &mut Layout::default()) }
    /// As `new`, laid out in `scratch`.
    pub fn laid_out(start: u64, name: String, blocks: Vec<Block>, scratch: &mut Layout) -> Function {
        // Successors found once, in address order; laid out, each index goes where its block went.
        let succ = successors(&blocks);
        if !scratch.lay_out(&succ) {
            return Function { start, name, by_address: (0..blocks.len() as u32).collect(), blocks, succ };
        }
        let order = &scratch.order;
        let mut place = vec![0u32; order.len()];
        for (new, &old) in order.iter().enumerate() { place[old] = new as u32; }
        let moved = |t: u32| if t == NO { NO } else { place[t as usize] };
        let succ = order.iter().map(|&old| succ[old].map(moved)).collect();
        let blocks = order.iter().map(|&k| blocks[k].clone()).collect();
        Function { start, name, blocks, succ, by_address: place }
    }
}

/// About how many blocks one wasm function is made of: an optimizing compile takes time that grows faster than a
/// function's size, and a browser optimizes what runs long enough whatever its size (cc1 cut into runs of 1024 blocks
/// had V8 optimize 36 MB of them while a small C file compiled; in runs of 64, 7 MB). A function past this is cut
/// into runs of consecutive blocks, each a wasm function; from one into another is a tail call to its entry.
pub const RUN: usize = 64;
/// The most blocks of a loop that a run grows past RUN to hold whole (to twice RUN at most).
const KEEP: usize = RUN;

thread_local! {
    /// Runs of exactly this many blocks, loops cut as anything is, when set for testing the cut (set_run).
    static RUN_BLOCKS: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// Cut functions into runs of exactly `blocks` blocks from now on (at least one): for testing the cut.
pub fn set_run(blocks: usize) { RUN_BLOCKS.with(|r| r.set(Some(blocks.max(1)))); }

/// `start`'s function as wasm functions are made of it: whole, or cut into runs of about RUN blocks, a run cut no
/// sooner than where it breaks no loop of up to KEEP blocks (the first keeps its name; the others are `name.2`...):
/// onto `out`.
pub(crate) fn runs(start: u64, name: String, blocks: Vec<Block>, scratch: &mut Layout, out: &mut Vec<Function>) {
    let exact = RUN_BLOCKS.with(|r| r.get());
    let run = exact.unwrap_or(RUN);
    if blocks.len() <= run { return out.push(Function::laid_out(start, name, blocks, scratch)); }
    // (Cut, each run is named for the whole: one with no name of its own by where the whole starts.)
    let name = if name.is_empty() { format!("fn_{start:x}") } else { name };
    // A cut before block p breaks each loop with head < p <= last (a walk's blocks are in address order).
    let mut breaks = vec![false; blocks.len()];
    if exact.is_none() {
        for lp in loops_of(&blocks).0.into_iter().filter(|lp| lp.last - lp.head < KEEP) { breaks[lp.head + 1..=lp.last].fill(true); }
    }
    let first = out.len();
    let mut held: Vec<Block> = Vec::with_capacity(run);
    let named = |out: &Vec<Function>| if out.len() == first { name.clone() } else { format!("{name}.{}", out.len() - first + 1) };
    for (p, b) in blocks.into_iter().enumerate() {
        if held.len() >= run + KEEP * exact.is_none() as usize || (held.len() >= run && !breaks[p]) {
            let n = named(out);
            out.push(Function::laid_out(held[0].start, n, std::mem::take(&mut held), scratch));
        }
        held.push(b);
    }
    let n = named(out);
    out.push(Function::laid_out(held[0].start, n, held, scratch));
}

/// Where a run of a function cut into `runs` (the program's from `first`) goes on in another: an entry of that run.
pub(crate) fn joined(runs: &[Function], first: usize, marks: &mut Vec<(u64, (u32, u32))>) {
    if runs.len() < 2 { return; }
    let holder = |a: u64| runs.iter().enumerate().find_map(|(r, f)| f.block_index(a).map(|b| (r, b)));
    for f in runs {
        for a in f.blocks.iter().flat_map(|b| goes_to(b).into_iter().flatten()) {
            if f.block_index(a).is_none() { if let Some((r, k)) = holder(a) { marks.push((a, ((first + r) as u32, k as u32))); } }
        }
    }
}
