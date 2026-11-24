//! Which loops can be represented by structured Wasm branches.

use super::{loops_into, within_of, Loop};
use crate::program::{Exit, Function, NO};

#[derive(Default)]
pub(crate) struct LoopRegions {
    pub(crate) loops: Vec<Loop>,
    pub(crate) within: Vec<Option<usize>>,
    pub(crate) heads: Vec<Option<usize>>,
    cold: Vec<bool>,
    incoming: Vec<Incoming>,
    // Scratch for finding candidates, then for pruning and renumbering them.
    work: (Vec<usize>, Vec<usize>),
}

#[derive(Clone, Copy)]
struct Incoming {
    // Source block plus one. Zero denotes an unstructured entry from anywhere.
    earliest: usize,
    // Source block plus one. Zero denotes no backward edge.
    latest_back: usize,
}

impl LoopRegions {
    /// Find the loops whose interiors are entered only from inside the loop
    /// or through a cold resume. Return whether all backward edges are rounds
    /// of a retained loop, so they can branch without the dispatch loop.
    pub(crate) fn prepare(&mut self, function: &Function, entries: &[bool]) -> bool {
        let n = function.blocks.len();
        let (first, parents) = (&mut self.work.0, &mut self.work.1);
        if function.has_back_edge {
            loops_into(&function.succ, &mut self.loops, (first, parents));
        } else {
            self.loops.clear();
        }
        index_loops(&self.loops, n, &mut self.heads, &mut self.within);
        if self.loops.is_empty() { return !function.has_back_edge; }

        cold_entries(function, &mut self.cold);
        self.incoming.clear();
        self.incoming.resize(n, Incoming { earliest: usize::MAX, latest_back: 0 });
        for (source, targets) in function.succ.iter().enumerate() {
            for target in targets.iter().copied().filter(|&t| t != NO).map(|t| t as usize) {
                let edge = &mut self.incoming[target];
                if source < target {
                    edge.earliest = edge.earliest.min(source + 1);
                } else {
                    edge.latest_back = edge.latest_back.max(source + 1);
                }
            }
        }

        // The minimum source entering a loop past its head suffices to test
        // the whole loop. Visit its head after its interior so a rejected
        // child can invalidate its ancestors in the same pass.
        first.clear();
        first.resize(self.loops.len(), usize::MAX);
        let mut rounds_only = true;
        for block in (0..n).rev() {
            let Incoming { mut earliest, latest_back } = self.incoming[block];
            let child = self.heads[block];
            let round = child.is_some_and(|l| first[l] > block && latest_back <= self.loops[l].last + 1);
            if latest_back != 0 && !round {
                rounds_only = false;
                earliest = 0;
            }
            if entries[block] && !self.cold[block] { earliest = 0; }
            if let Some(l) = self.within[block] {
                if let Some(child) = child { earliest = earliest.min(first[child]); }
                first[l] = first[l].min(earliest);
            }
        }

        // A parent's replacement is known before any of its children.
        parents.clear();
        let mut kept = 0;
        for (l, &earliest) in first.iter().enumerate() {
            let lp = self.loops[l];
            let parent = lp.parent.map_or(usize::MAX, |p| parents[p]);
            if earliest <= lp.head {
                parents.push(parent);
            } else {
                parents.push(kept);
                self.loops[kept] = Loop { parent: (parent != usize::MAX).then_some(parent), ..lp };
                kept += 1;
            }
        }
        if kept != self.loops.len() {
            self.loops.truncate(kept);
            index_loops(&self.loops, n, &mut self.heads, &mut self.within);
        }
        rounds_only
    }
}

fn index_loops(loops: &[Loop], n: usize, heads: &mut Vec<Option<usize>>, within: &mut Vec<Option<usize>>) {
    heads.clear();
    heads.resize(n, None);
    for (l, lp) in loops.iter().enumerate() { heads[lp.head] = Some(l); }
    within_of(loops, n, within);
}

/// A call or syscall continuation and a slice's loop head may resume
/// directly through the dispatch, including in a structured loop's body.
fn cold_entries(function: &Function, cold: &mut Vec<bool>) {
    cold.clear();
    cold.resize(function.blocks.len(), false);
    for (k, (b, to)) in function.blocks.iter().zip(&function.succ).enumerate() {
        if matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) && to[0] != NO {
            cold[to[0] as usize] = true;
        }
        for &t in to {
            if t as usize <= k { cold[t as usize] = true; }
        }
        if b.resumes {
            if let Some(t) = function.block_index(b.end()) { cold[t] = true; }
            if b.count == 1 { cold[k] = true; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::program::Block;

    fn nested() -> Function {
        let blocks = (0..8).map(|start| Block {
            start, len: 1, count: 1, reads: 0, writes: 0, last: 1,
            resumes: false, traps: false, exit: Exit::Return,
        }).collect();
        Function {
            start: 0, name: String::new(), blocks,
            succ: vec![[1, NO], [2, NO], [3, NO], [4, NO], [5, NO], [3, 6], [7, NO], [1, NO]],
            has_back_edge: true, by_address: None,
        }
    }

    #[test]
    fn dropping_an_inner_loop_exposes_a_backward_edge_into_its_parent() {
        let mut function = nested();
        let mut regions = LoopRegions::default();
        assert!(regions.prepare(&function, &[false; 8]));
        assert_eq!(regions.loops[1].parent, Some(0));
        assert_eq!(regions.within[3], Some(0));
        assert_eq!(regions.within[4], Some(1));

        function.succ[2][1] = 4;
        assert!(!regions.prepare(&function, &[false; 8]));
        assert!(regions.loops.is_empty());
        assert!(regions.heads.iter().all(Option::is_none));
    }

    #[test]
    fn a_cold_call_continuation_can_enter_a_nested_loop() {
        let mut function = nested();
        let mut regions = LoopRegions::default();
        let mut entries = [false; 8];
        entries[4] = true;
        assert!(!regions.prepare(&function, &entries));
        function.blocks[3].exit = Exit::Call { target: 20, ret: 4 };
        assert!(regions.prepare(&function, &entries));
        assert_eq!(regions.loops.len(), 2);
    }
}
