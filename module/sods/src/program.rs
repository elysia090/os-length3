//! A program as it is found: its functions, their blocks in the order they are lowered and their successors, and the
//! entries execution may arrive at from outside a function's own control flow. A block keeps 48 bytes of what its
//! instructions say, not the instructions (40 bytes each): they are decoded again where they are lowered.

use iced_x86::{Decoder, DecoderOptions, Instruction, Mnemonic, RflagsBits};
use crate::elf::Elf;
use crate::find::decode;


#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exit {
    /// Falls into the block at this address.
    Fall(u64),
    Jump(u64),
    /// A direct jump that leaves the function: a tail call.
    TailJump(u64),
    Branch { taken: u64, fall: u64 },
    IndirectJump,
    Call { target: u64, ret: u64 },
    IndirectCall { ret: u64 },
    Return,
    /// Undecodable or deliberately trapping code (ud2, hlt, int3).
    Trap,
}

/// A block: where it is, what the analyses need of its instructions, and how it ends. Its instructions are not kept
/// (40 bytes each): they are decoded again where they are lowered, from the program's own bytes.
#[derive(Clone, Debug)]
pub struct Block {
    pub start: u64,
    /// Its bytes (every instruction's, the terminator's too) and how many instructions they are.
    pub len: u32,
    pub count: u32,
    /// The flags (as ALL_FLAGS) it reads before it writes them, and those it writes.
    pub reads: u8,
    pub writes: u8,
    /// Its last instruction's length.
    pub last: u8,
    /// Its last instruction is a system call (a process stops and goes on there, and a fork child starts after it).
    pub resumes: bool,
    /// One of its instructions goes out to the kernel (a system call, an int).
    pub traps: bool,
    pub exit: Exit,
}

impl Block {
    /// Where it ends: the address after its last instruction.
    pub fn end(&self) -> u64 { self.start + self.len as u64 }
    pub fn last_ip(&self) -> u64 { self.end() - self.last as u64 }
    /// Its instructions, decoded again from `elf` into `into`.
    pub fn decode(&self, elf: &Elf, into: &mut Vec<Instruction>) {
        Code::new(elf, self.start).decode(elf, self, into);
    }
    pub fn instructions(&self, elf: &Elf) -> Vec<Instruction> {
        let mut out = Vec::with_capacity(self.count as usize);
        self.decode(elf, &mut out);
        out
    }
}

/// One decoder over a segment's code, moved to each block decoded (not made again for each).
pub(crate) struct Code<'e> { base: u64, decoder: Decoder<'e> }

impl<'e> Code<'e> {
    pub(crate) fn new(elf: &'e Elf, base: u64) -> Code<'e> {
        Code { base, decoder: Decoder::with_ip(64, elf.code_at(base).unwrap_or_default(), base, DecoderOptions::NONE) }
    }
    pub(crate) fn decode(&mut self, elf: &Elf, b: &Block, into: &mut Vec<Instruction>) {
        into.clear();
        let (base, max) = (self.base, self.decoder.max_position() as u64);
        let within = |a: u64| a.checked_sub(base).filter(|&o| o < max);
        let mut at = b.start;
        if let Some(o) = within(at) { let _ = self.decoder.set_position(o as usize); self.decoder.set_ip(at); }
        for _ in 0..b.count {
            // (A block running on past this segment's end, or in another, decodes the rest on its own.)
            let here = within(at).is_some_and(|o| o == self.decoder.position() as u64);
            let i = if here { self.decoder.decode() } else { decode(elf, at).unwrap_or_default() };
            at = i.next_ip();
            into.push(i);
        }
    }
}

/// CF, ZF, SF, OF and PF: the flags translated code keeps (as RflagsBits).
pub const ALL_FLAGS: u32 = RflagsBits::OF | RflagsBits::SF | RflagsBits::ZF | RflagsBits::CF | RflagsBits::PF;
// A system call keeps the flags here (r11 is not given them), so it neither reads nor writes them.
pub fn flags_read(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_read() & ALL_FLAGS } }
pub fn flags_written(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_modified() & ALL_FLAGS } }

#[derive(Clone, Debug)]
pub struct Function {
    pub start: u64,
    pub name: String,
    /// In the order they are lowered (`lay_out`): index 0 is the function's entry.
    pub blocks: Vec<Block>,
    /// Each block's successors within (as goes_to has them), by index; NO where none or not this function's.
    pub succ: Vec<[u32; 2]>,
    /// Its blocks' indices, by their addresses.
    by_address: Vec<u32>,
}

impl Function {
    /// The function of `blocks` (sorted by address, the entry first), in the order they are lowered.
    pub fn new(start: u64, name: String, blocks: Vec<Block>) -> Function {
        // Successors found once, in address order; laid out, each index goes where its block went.
        let at = |a: u64| blocks.binary_search_by_key(&a, |b| b.start).ok().map_or(NO, |k| k as u32);
        let succ: Vec<[u32; 2]> = blocks.iter().map(|b| goes_to(b).map(|a| a.map_or(NO, at))).collect();
        let Some(order) = lay_out(&succ) else {
            return Function { start, name, by_address: (0..blocks.len() as u32).collect(), blocks, succ };
        };
        let mut place = vec![0u32; order.len()];
        for (new, &old) in order.iter().enumerate() { place[old] = new as u32; }
        let moved = |t: u32| if t == NO { NO } else { place[t as usize] };
        let succ = order.iter().map(|&old| succ[old].map(moved)).collect();
        let mut old: Vec<Option<Block>> = blocks.into_iter().map(Some).collect();
        let blocks = order.iter().filter_map(|&k| old[k].take()).collect();
        Function { start, name, blocks, succ, by_address: place }
    }
    pub fn block_index(&self, address: u64) -> Option<usize> {
        self.by_address.binary_search_by_key(&address, |&k| self.blocks[k as usize].start).ok().map(|i| self.by_address[i] as usize)
    }
    /// The first and last of its blocks' addresses.
    pub fn span(&self) -> Option<(u64, u64)> {
        let at = |k: &u32| self.blocks[*k as usize].start;
        Some((at(self.by_address.first()?), at(self.by_address.last()?)))
    }
}

#[derive(Debug)]
pub struct Program {
    pub entry: u64,
    pub functions: Vec<Function>,
    /// Code addresses execution may arrive at from outside a function's own direct control flow: entries, call
    /// continuations, loop heads, system calls and stored pointers.
    pub entries: Entries,
}

/// Each entry's address and the function and block it is, sorted by address: one each, the first marked where a
/// place was marked more than once.
#[derive(Debug, Default)]
pub struct Entries(Vec<(u64, (u32, u32))>);

impl Entries {
    pub(crate) fn of(mut marks: Vec<(u64, (u32, u32))>) -> Entries {
        // The first marked of an address is the one of the lowest function (a function marks an address one way).
        marks.sort_unstable_by_key(|&(a, (f, _))| (a, f));
        marks.dedup_by_key(|&mut (a, _)| a);
        marks.shrink_to_fit();
        Entries(marks)
    }
    pub fn get(&self, address: &u64) -> Option<&(u32, u32)> {
        self.0.binary_search_by_key(address, |&(a, _)| a).ok().map(|k| &self.0[k].1)
    }
    pub fn contains_key(&self, address: &u64) -> bool { self.get(address).is_some() }
    pub fn len(&self) -> usize { self.0.len() }
    pub fn is_empty(&self) -> bool { self.0.is_empty() }
    pub fn keys(&self) -> impl Iterator<Item = &u64> + '_ { self.0.iter().map(|(a, _)| a) }
    pub fn values(&self) -> impl Iterator<Item = &(u32, u32)> + '_ { self.0.iter().map(|(_, v)| v) }
    pub fn iter(&self) -> impl Iterator<Item = (&u64, &(u32, u32))> + '_ { self.0.iter().map(|(a, v)| (a, v)) }
}

impl<'a> IntoIterator for &'a Entries {
    type Item = (&'a u64, &'a (u32, u32));
    type IntoIter = std::iter::Map<std::slice::Iter<'a, (u64, (u32, u32))>, fn(&'a (u64, (u32, u32))) -> (&'a u64, &'a (u32, u32))>;
    fn into_iter(self) -> Self::IntoIter { self.0.iter().map(|(a, v)| (a, v)) }
}

/// Where a block may go on to within its function: where it falls or jumps, both sides of a branch, where a call
/// comes back to.
pub fn goes_to(b: &Block) -> [Option<u64>; 2] {
    match b.exit {
        Exit::Fall(a) | Exit::Jump(a) | Exit::Call { ret: a, .. } | Exit::IndirectCall { ret: a } => [Some(a), None],
        Exit::Branch { taken, fall } => [Some(taken), Some(fall)],
        _ => [None, None],
    }
}

/// A loop made of blocks `head..=last` (in the order they are lowered), gone round from its last block or any before
/// it back to its head; `parent`: the loop it lies within.
#[derive(Clone, Copy, Debug)]
pub struct Loop { pub head: usize, pub last: usize, pub parent: Option<usize> }

/// The loops `blocks`' back edges make (to a block at or before their own, `at` finding a block by address), each
/// from its head through the last block that goes back to it (one overlapping another without lying within it is not
/// made); and the innermost each block lies within past its head.
pub fn loops_of(blocks: &[Block], at: impl Fn(u64) -> Option<usize>) -> (Vec<Loop>, Vec<Option<usize>>) {
    let succ: Vec<[u32; 2]> = blocks.iter().map(|b| goes_to(b).map(|a| a.and_then(&at).map_or(NO, |k| k as u32))).collect();
    let (mut loops, mut within, mut last, mut open) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    loops_into(&succ, &mut loops, (&mut last, &mut open));
    within_of(&loops, blocks.len(), &mut within);
    (loops, within)
}

/// No block (in a block's successors, by index within its function).
pub const NO: u32 = u32::MAX;

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

/// The order (new place → place by address) blocks with successors `succ` (by address, the entry first) are lowered in,
/// None where it stays: each loop's blocks together, its head
/// first, the rest in reverse postorder, so a jump to a block before is a loop's round and any other a jump forward
/// (a compiler's while loop, its test last and jumped into, and its rare paths after it jumping back in, laid out by
/// address goes round through the dispatch; laid out so, it is a wasm loop).
fn lay_out(succ: &[[u32; 2]]) -> Option<Vec<usize>> {
    let n = succ.len();
    if n < 3 { return None; }
    const NONE: usize = usize::MAX;
    let succ: Vec<[usize; 2]> = succ.iter().map(|to| to.map(|t| if t == NO { NONE } else { t as usize })).collect();
    // Depth first from the entry, then from each block not reached (only through the dispatch): each walk's reverse
    // postorder after the ones before; a jump to a block on the walk's path is a loop's round.
    let (mut rpo, mut state, mut rounds) = (vec![0usize; n], vec![0u8; n], Vec::new());
    let (mut numbered, mut post, mut path) = (0, Vec::with_capacity(n), Vec::new());
    for root in 0..n {
        if state[root] != 0 { continue; }
        post.clear();
        path.push((root, 0));
        state[root] = 1;
        while let Some(&mut (u, ref mut next)) = path.last_mut() {
            if *next == 2 { state[u] = 2; post.push(u); path.pop(); continue; }
            let v = succ[u][*next];
            *next += 1;
            if v == NONE { continue; }
            match state[v] { 0 => { state[v] = 1; path.push((v, 0)); } 1 => rounds.push((v, u)), _ => {} }
        }
        for (i, &u) in post.iter().rev().enumerate() { rpo[u] = numbered + i; }
        numbered += post.len();
    }
    if rounds.is_empty() { return None; }
    let mut first = vec![0usize; n + 1];
    for &v in succ.iter().flatten() { if v != NONE { first[v + 1] += 1; } }
    for k in 0..n { first[k + 1] += first[k]; }
    let mut preds = vec![0usize; first[n]];
    let mut fill = first.clone();
    for (u, s) in succ.iter().enumerate() { for &v in s { if v != NONE { preds[fill[v]] = u; fill[v] += 1; } } }
    // Each loop (a head), its blocks: those that reach a round to it without going through it, after it in the walk.
    rounds.sort_unstable();
    let mut heads: Vec<usize> = rounds.iter().map(|&(h, _)| h).collect();
    heads.dedup();
    let (mut mark, mut work) = (vec![NONE; n], Vec::new());
    let body: Vec<Vec<usize>> = heads.iter().enumerate().map(|(l, &h)| {
        let mut inside = vec![h];
        mark[h] = l;
        let at = rounds.partition_point(|&(g, _)| g < h);
        for &(_, u) in rounds[at..].iter().take_while(|&&(g, _)| g == h) {
            if rpo[u] > rpo[h] && mark[u] != l { mark[u] = l; inside.push(u); work.push(u); }
        }
        while let Some(u) = work.pop() {
            for &p in &preds[first[u]..first[u + 1]] { if mark[p] != l && rpo[p] > rpo[h] { mark[p] = l; inside.push(p); work.push(p); } }
        }
        inside
    }).collect();
    // Ranked from the least loop (fewest blocks, then latest head): a block's loop is the least holding it, a loop's
    // parent the least holding its head that ranks after it, so they nest as a tree.
    let mut ranked: Vec<usize> = (0..heads.len()).collect();
    ranked.sort_unstable_by_key(|&l| (body[l].len(), usize::MAX - rpo[heads[l]]));
    let mut place = vec![0usize; heads.len()];
    for (i, &l) in ranked.iter().enumerate() { place[l] = i; }
    let mut head_of = vec![NONE; n];
    for (l, &h) in heads.iter().enumerate() { head_of[h] = l; }
    let (mut owner, mut parent) = (vec![NONE; n], vec![NONE; heads.len()]);
    for &m in &ranked {
        for &b in &body[m] {
            if owner[b] == NONE { owner[b] = m; }
            let l = head_of[b];
            if l != NONE && l != m && parent[l] == NONE && place[m] > place[l] { parent[l] = m; }
        }
    }
    // Laid out from the outside in: a region's blocks and the loops directly in it in the walk's order, each loop
    // whole where its head falls. An item: a block b, or a loop n + l.
    let regions = heads.len() + 1;
    let region = |o: usize| if o == NONE { heads.len() } else { o };
    let mut start = vec![0usize; regions + 1];
    for &o in owner.iter().chain(&parent) { start[region(o) + 1] += 1; }
    for r in 0..regions { start[r + 1] += start[r]; }
    let mut items = vec![(0usize, 0usize); start[regions]];
    let mut put = start.clone();
    for (b, &o) in owner.iter().enumerate() { let r = region(o); items[put[r]] = (rpo[b], b); put[r] += 1; }
    for (l, &p) in parent.iter().enumerate() { let r = region(p); items[put[r]] = (rpo[heads[l]], n + l); put[r] += 1; }
    for r in 0..regions { items[start[r]..start[r + 1]].sort_unstable(); }
    let mut order = Vec::with_capacity(n);
    let mut stack = vec![(heads.len(), start[heads.len()])];
    while let Some(&mut (r, ref mut at)) = stack.last_mut() {
        if *at == start[r + 1] { stack.pop(); continue; }
        let item = items[*at].1;
        *at += 1;
        if item < n { order.push(item); } else { stack.push((item - n, start[item - n])); }
    }
    (order.len() == n && order[0] == 0).then_some(order)
}
