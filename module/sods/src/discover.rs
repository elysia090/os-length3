//! Recover functions and basic blocks from a static executable.
//!
//! Seeds are the entry point, function symbols, direct call targets and every
//! code address the linker recorded in a relocation. Each function is walked
//! on its own; a block reachable from two functions is simply translated
//! twice, so no block ever needs an owner.

use crate::elf::Elf;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind, Register, RflagsBits};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

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

/// A block: where it is, what lowering and the analyses before it need of its instructions, and how it ends. Its
/// instructions are not kept (40 bytes each, most of what a translator would hold): they are decoded again where
/// they are lowered (`decode`), from the program's own bytes.
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
    /// Its last instruction is a system call (resumes_after).
    pub resumes: bool,
    /// One of its instructions goes out to the kernel (a system call, an int).
    pub traps: bool,
    pub exit: Exit,
}

impl Block {
    /// The block of `code` (at `start`, each instruction after the one before), ending as `exit` says.
    pub fn of(start: u64, code: &[Instruction], exit: Exit) -> Block {
        let (mut reads, mut writes, mut traps) = (0, 0, false);
        for i in code {
            reads |= flags_read(i) & !writes;
            writes |= flags_written(i);
            traps |= matches!(i.mnemonic(), Mnemonic::Syscall | Mnemonic::Sysenter | Mnemonic::Int | Mnemonic::Int1 | Mnemonic::Int3 | Mnemonic::Into);
        }
        let last = code.last().expect("a block holds an instruction");
        Block {
            start, len: (last.next_ip() - start) as u32, count: code.len() as u32, reads: reads as u8, writes: writes as u8,
            last: last.len() as u8, resumes: resumes_after(last), traps, exit,
        }
    }

    /// The block of `steps` (at `start`, each after the one before), ending as `exit` says.
    fn of_steps(start: u64, steps: &[Step], exit: Exit) -> Block {
        let (mut reads, mut writes, mut traps) = (0, 0, false);
        for s in steps {
            reads |= s.reads & !writes;
            writes |= s.writes;
            traps |= s.bits & TRAPS != 0;
        }
        let last = steps.last().expect("a block holds an instruction");
        let len: u32 = steps.iter().map(|s| s.len as u32).sum();
        Block { start, len, count: steps.len() as u32, reads, writes, last: last.len, resumes: last.bits & SYSCALL != 0, traps, exit }
    }

    /// Where it ends: the address after its last instruction.
    pub fn end(&self) -> u64 { self.start + self.len as u64 }

    /// Its last instruction's address.
    pub fn last_ip(&self) -> u64 { self.end() - self.last as u64 }

    /// Its instructions, decoded again from `elf` (the program it was found in) into `into`.
    pub fn decode(&self, elf: &Elf, into: &mut Vec<Instruction>) {
        into.clear();
        let bytes = elf.code_at(self.start).unwrap_or_default();
        let mut decoder = Decoder::with_ip(64, bytes, self.start, DecoderOptions::NONE);
        let mut at = self.start;
        for _ in 0..self.count {
            // (A block running on past its segment's end, which none found has, decodes the rest on its own.)
            let i = if at - self.start < bytes.len() as u64 { decoder.decode() } else { decode(elf, at).unwrap_or_default() };
            at = i.next_ip();
            into.push(i);
        }
    }

    /// Its instructions, as `decode`.
    pub fn instructions(&self, elf: &Elf) -> Vec<Instruction> {
        let mut out = Vec::with_capacity(self.count as usize);
        self.decode(elf, &mut out);
        out
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
    /// In the order they are lowered (`lowered`): index 0 is the function entry.
    pub blocks: Vec<Block>,
    /// Its blocks' indices, by their addresses.
    by_address: Vec<u32>,
}

impl Function {
    /// The function of `blocks` (sorted by address, the entry first), in the order they are lowered.
    pub fn new(start: u64, name: String, mut blocks: Vec<Block>) -> Function {
        lowered(&mut blocks);
        let mut by_address: Vec<u32> = (0..blocks.len() as u32).collect();
        by_address.sort_unstable_by_key(|&k| blocks[k as usize].start);
        Function { start, name, blocks, by_address }
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

/// Where a block may go on to within its function, by address: where it falls or jumps, both sides of a branch,
/// where a call it makes comes back to.
pub fn goes_to(b: &Block) -> [Option<u64>; 2] {
    match b.exit {
        Exit::Fall(a) | Exit::Jump(a) | Exit::Call { ret: a, .. } | Exit::IndirectCall { ret: a } => [Some(a), None],
        Exit::Branch { taken, fall } => [Some(taken), Some(fall)],
        _ => [None, None],
    }
}

/// A loop made of blocks `head..=last` (in the order they are lowered), gone round from its last block or any before
/// it back to its head (a back edge). `parent`: the loop it lies within, if any.
#[derive(Clone, Copy, Debug)]
pub struct Loop { pub head: usize, pub last: usize, pub parent: Option<usize> }

/// The loops `blocks`' back edges make (to its own block or one before it, `at` finding a block by its address):
/// each from the block it goes back to through the last block that goes back to it. One that overlaps another
/// without lying within it is not made. With them, the innermost loop each block lies within past that loop's head.
pub fn loops_of(blocks: &[Block], at: impl Fn(u64) -> Option<usize>) -> (Vec<Loop>, Vec<Option<usize>>) {
    let n = blocks.len();
    let mut last: Vec<Option<usize>> = vec![None; n];
    for (k, b) in blocks.iter().enumerate() {
        for h in goes_to(b).into_iter().flatten().filter_map(&at).filter(|&h| h <= k) { last[h] = Some(last[h].map_or(k, |e| e.max(k))); }
    }
    let mut loops: Vec<Loop> = Vec::new();
    // The loops open where each head is reached, outermost first.
    let mut open: Vec<usize> = Vec::new();
    for (head, e) in last.iter().enumerate() {
        let Some(e) = *e else { continue };
        while open.last().is_some_and(|&o| loops[o].last < head) { open.pop(); }
        if open.last().is_some_and(|&o| e > loops[o].last) { continue; }
        loops.push(Loop { head, last: e, parent: open.last().copied() });
        open.push(loops.len() - 1);
    }
    // Inner loops come after the loops they lie within: each block's innermost is the last to claim it.
    let mut within = vec![None; n];
    for (l, lp) in loops.iter().enumerate() {
        for w in &mut within[lp.head + 1..=lp.last] { *w = Some(l); }
    }
    (loops, within)
}

/// `blocks` (sorted by address, the entry first) put in the order they are lowered: each loop's blocks together, its
/// head (where it is entered) first, and the rest in reverse postorder, so a jump to a block before it is a loop's round
/// and any other a jump forward. A compiler lays a while loop out with its test last and jumps in to the test, and puts
/// what seldom runs (an error's path, a slow case) after the loop with a jump back into it; laid out by address, such a
/// loop is entered past its first block and goes round through the dispatch (lower.rs), where laid out so it is a wasm
/// loop. A loop entered at more than one block (not one a compiler makes from structured code) is laid out from where
/// the walk first came in, and still goes round through the dispatch.
fn lowered(blocks: &mut Vec<Block>) {
    let n = blocks.len();
    if n < 3 { return; }
    // Each block's successors within, by index (at most two).
    let mut by_start: Vec<(u64, usize)> = blocks.iter().enumerate().map(|(k, b)| (b.start, k)).collect();
    by_start.sort_unstable();
    let index = |a: u64| by_start.binary_search_by_key(&a, |&(s, _)| s).ok().map(|i| by_start[i].1);
    const NONE: usize = usize::MAX;
    let succ: Vec<[usize; 2]> = blocks.iter().map(|b| goes_to(b).map(|a| a.and_then(index).unwrap_or(NONE))).collect();
    // A walk from the entry, then from each block not reached yet (reached through the dispatch only), in order: each
    // walk's reverse postorder after the ones before it. A jump to a block still on the walk's path is a loop's round.
    let mut rpo = vec![0usize; n];
    let mut state = vec![0u8; n];
    let mut rounds: Vec<(usize, usize)> = Vec::new();
    let mut numbered = 0;
    let mut post = Vec::with_capacity(n);
    let mut path: Vec<(usize, usize)> = Vec::new();
    for root in 0..n {
        if state[root] != 0 { continue; }
        post.clear();
        path.push((root, 0));
        state[root] = 1;
        while let Some(&mut (u, ref mut next)) = path.last_mut() {
            if *next < 2 {
                let v = succ[u][*next];
                *next += 1;
                if v == NONE { continue; }
                match state[v] {
                    0 => { state[v] = 1; path.push((v, 0)); }
                    1 => rounds.push((v, u)),
                    _ => {}
                }
            } else {
                state[u] = 2;
                post.push(u);
                path.pop();
            }
        }
        for (i, &u) in post.iter().rev().enumerate() { rpo[u] = numbered + i; }
        numbered += post.len();
    }
    // No loop: the order stays.
    if rounds.is_empty() { return; }
    // Predecessors, packed.
    let mut first = vec![0usize; n + 1];
    for s in &succ { for &v in s { if v != NONE { first[v + 1] += 1; } } }
    for k in 0..n { first[k + 1] += first[k]; }
    let mut preds = vec![0usize; first[n]];
    let mut fill = first.clone();
    for (u, s) in succ.iter().enumerate() { for &v in s { if v != NONE { preds[fill[v]] = u; fill[v] += 1; } } }
    // Each loop (one a head), its blocks: those that reach a round to its head without going through the head, after
    // the head in the walk's order (none before it lies within it).
    rounds.sort_unstable();
    let mut heads: Vec<usize> = rounds.iter().map(|&(h, _)| h).collect();
    heads.dedup();
    let mut mark = vec![usize::MAX; n];
    let mut work: Vec<usize> = Vec::new();
    let body: Vec<Vec<usize>> = heads.iter().enumerate().map(|(l, &h)| {
        let mut inside = vec![h];
        mark[h] = l;
        let at = rounds.partition_point(|&(g, _)| g < h);
        for &(_, u) in rounds[at..].iter().take_while(|&&(g, _)| g == h) {
            if rpo[u] > rpo[h] && mark[u] != l { mark[u] = l; inside.push(u); work.push(u); }
        }
        while let Some(u) = work.pop() {
            for &p in &preds[first[u]..first[u + 1]] {
                if mark[p] != l && rpo[p] > rpo[h] { mark[p] = l; inside.push(p); work.push(p); }
            }
        }
        inside
    }).collect();
    // Loops ordered from the least (fewest blocks, then latest head): a block's loop is the least holding it, a loop's
    // the least holding its head that comes after it in that order, so they nest as a tree.
    let mut ranked: Vec<usize> = (0..heads.len()).collect();
    ranked.sort_unstable_by_key(|&l| (body[l].len(), usize::MAX - rpo[heads[l]]));
    let mut place_of = vec![0usize; heads.len()];
    for (i, &l) in ranked.iter().enumerate() { place_of[l] = i; }
    let mut head_of = vec![NONE; n];
    for (l, &h) in heads.iter().enumerate() { head_of[h] = l; }
    let mut owner = vec![NONE; n];
    let mut parent = vec![NONE; heads.len()];
    for &m in &ranked {
        for &b in &body[m] {
            if owner[b] == NONE { owner[b] = m; }
            let l = head_of[b];
            if l != NONE && l != m && parent[l] == NONE && place_of[m] > place_of[l] { parent[l] = m; }
        }
    }
    // Laid out from the outside in: a region's blocks and the loops directly within it in the walk's order, each
    // loop's whole where its head falls. Each region's items, packed (region heads.len() is the outside).
    let regions = heads.len() + 1;
    let region = |o: usize| if o == NONE { heads.len() } else { o };
    let mut start = vec![0usize; regions + 1];
    for &o in &owner { start[region(o) + 1] += 1; }
    for &p in &parent { start[region(p) + 1] += 1; }
    for r in 0..regions { start[r + 1] += start[r]; }
    // An item: a block (b), or a loop (n + l); with its place in the walk's order.
    let mut items = vec![(0usize, 0usize); start[regions]];
    let mut put = start.clone();
    for (b, &o) in owner.iter().enumerate() { let r = region(o); items[put[r]] = (rpo[b], b); put[r] += 1; }
    for (l, &p) in parent.iter().enumerate() { let r = region(p); items[put[r]] = (rpo[heads[l]], n + l); put[r] += 1; }
    for r in 0..regions { items[start[r]..start[r + 1]].sort_unstable(); }
    let mut order = Vec::with_capacity(n);
    let mut stack: Vec<(usize, usize)> = vec![(heads.len(), start[heads.len()])];
    while let Some(&mut (r, ref mut at)) = stack.last_mut() {
        if *at == start[r + 1] { stack.pop(); continue; }
        let (_, item) = items[*at];
        *at += 1;
        if item < n { order.push(item); } else { let l = item - n; stack.push((l, start[l])); }
    }
    // (The entry is first in the walk, in no loop but one it heads: it stays first.)
    if order.len() != n || order[0] != 0 { return; }
    let mut old: Vec<Option<Block>> = std::mem::take(blocks).into_iter().map(Some).collect();
    *blocks = order.into_iter().filter_map(|k| old[k].take()).collect();
}

/// About how many blocks one wasm function is made of. An optimizing compile takes time that grows faster than a
/// function's size, and a browser optimizes what runs long enough whatever its size: cc1's functions cut into runs of
/// 1024 blocks had V8 optimize 36 MB of them (a run of 130 KB took 0.7 s) on all four cores while a small C file was
/// compiled, which took 11 s where it took 4.8 s with nothing optimized. In runs of about 64 blocks it optimizes 7 MB in
/// 3.9 s, and the compile takes 4.1-4.3 s. A function past this is cut into runs of consecutive blocks, each a wasm
/// function of its own; from one run into another is a tail call to that run's entry, as a jump out of a function is.
pub const RUN: usize = 64;
/// The most blocks of a loop that a run grows past RUN to hold whole (to twice RUN at most): going round it stays a
/// branch, not a tail call from one run to another and in again through the dispatch.
const KEEP: usize = RUN;

thread_local! {
    /// Runs of exactly this many blocks, loops cut as anything is, when set for testing the cut (set_run).
    static RUN_BLOCKS: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// Cut functions into runs of exactly `blocks` blocks from now on (at least one): for testing the cut on small programs.
pub fn set_run(blocks: usize) { RUN_BLOCKS.with(|r| r.set(Some(blocks.max(1)))); }

/// `function` as wasm functions are made of it: whole, or cut into runs of about RUN blocks, a run cut no sooner than
/// where it breaks no loop of up to KEEP blocks (the first keeps its name and its entry; the others are named after it
/// with their place: `name.2`).
fn runs(start: u64, name: String, blocks: Vec<Block>) -> Vec<Function> {
    let exact = RUN_BLOCKS.with(|r| r.get());
    let run = exact.unwrap_or(RUN);
    if blocks.len() <= run { return vec![Function::new(start, name, blocks)]; }
    // A cut before block p breaks each loop with head < p <= last.
    let mut breaks = vec![false; blocks.len()];
    if exact.is_none() {
        // (A walk's blocks are in address order.)
        let at = |a: u64| blocks.binary_search_by_key(&a, |b| b.start).ok();
        for lp in loops_of(&blocks, at).0.into_iter().filter(|lp| lp.last - lp.head < KEEP) {
            for b in &mut breaks[lp.head + 1..=lp.last] { *b = true; }
        }
    }
    let mut out: Vec<Function> = Vec::with_capacity(blocks.len().div_ceil(run));
    let mut held: Vec<Block> = Vec::with_capacity(run);
    for (p, b) in blocks.into_iter().enumerate() {
        if held.len() >= run + KEEP * exact.is_none() as usize || (held.len() >= run && !breaks[p]) {
            let name = if out.is_empty() { name.clone() } else { format!("{name}.{}", out.len() + 1) };
            out.push(Function::new(held[0].start, name, std::mem::take(&mut held)));
        }
        held.push(b);
    }
    let name = if out.is_empty() { name } else { format!("{name}.{}", out.len() + 1) };
    out.push(Function::new(held[0].start, name, held));
    out
}

/// Where a run of a function cut into `runs` (the program's functions from `first`) goes on in another run: each such
/// place an entry of the run that holds it, so the jump is a tail call to it.
fn joined(runs: &[Function], first: usize, entries: &mut Vec<(u64, (u32, u32))>) {
    if runs.len() < 2 { return; }
    let holder = |a: u64| runs.iter().enumerate().find_map(|(r, f)| f.block_index(a).map(|b| (r, b)));
    for f in runs {
        for b in &f.blocks {
            for a in goes_to(b).into_iter().flatten() {
                if f.block_index(a).is_some() { continue; }
                if let Some((r, k)) = holder(a) { entries.push((a, ((first + r) as u32, k as u32))); }
            }
        }
    }
}

#[derive(Debug)]
pub struct Program {
    pub entry: u64,
    pub functions: Vec<Function>,
    /// Code addresses execution may arrive at from outside a function's own
    /// direct control flow: entries, call continuations and stored pointers.
    pub entries: Entries,
}

/// Each entry's address and the function and block it is, sorted by address: one each, the first marked where a
/// place was marked more than once.
#[derive(Debug, Default)]
pub struct Entries(Vec<(u64, (u32, u32))>);

impl Entries {
    /// The entries `marks` (in the order marked) name.
    fn of(mut marks: Vec<(u64, (u32, u32))>) -> Entries {
        // A stable sort: of the marks at one address, the first stays first.
        marks.sort_by_key(|&(a, _)| a);
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

fn decode(elf: &Elf, address: u64) -> Option<Instruction> {
    let bytes = elf.code_at(address)?;
    let mut decoder = Decoder::with_ip(64, &bytes[..bytes.len().min(15)], address, DecoderOptions::NONE);
    let instruction = decoder.decode();
    (!instruction.is_invalid()).then_some(instruction)
}

/// Control flow as translation sees it: a system call returns in place.
pub fn flow(i: &Instruction) -> FlowControl {
    match i.mnemonic() {
        Mnemonic::Syscall => FlowControl::Next,
        _ => i.flow_control(),
    }
}

/// System calls are where the host may stop and resume a process: a call
/// that must wait is re-executed from the syscall itself, and a forked
/// child starts right after it. Both addresses are dispatch entries.
pub fn resumes_after(i: &Instruction) -> bool {
    i.mnemonic() == Mnemonic::Syscall
}

fn direct_target(i: &Instruction) -> Option<u64> {
    matches!(i.op0_kind(), OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16).then(|| i.near_branch_target())
}

/// A walk's work: its start, the end of its range, the pointers into the range (sorted), and the other function
/// starts inside it (sorted; almost always none).
type Job<'a> = (u64, u64, &'a [u64], &'a [u64]);

/// Walk each job on its own: natively they share the cores, in wasm (one thread) they go in turn. Returns each
/// start's blocks and the code it goes on to, in the order given.
fn walk_all(elf: &Elf, jobs: &[Job], references: &mut BTreeSet<u64>) -> Vec<(u64, Vec<Block>, Vec<u64>)> {
    let go = |part: &[Job], references: &mut BTreeSet<u64>| -> Vec<(u64, Vec<Block>, Vec<u64>)> {
        let mut scratch = Scratch::default();
        part.iter().map(|&(start, end, extra, inner)| { let (b, c) = walk(elf, (start, end), extra, inner, Some(&mut *references), &mut scratch); (start, b, c) }).collect()
    };
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    // A few walks are not worth a thread.
    if threads == 1 || jobs.len() < 64 {
        return go(jobs, references);
    }
    let size = jobs.len().div_ceil(threads);
    let parts: Vec<_> = std::thread::scope(|scope| {
        let workers: Vec<_> = jobs.chunks(size).map(|part| { let go = &go; scope.spawn(move || { let mut r = BTreeSet::new(); let out = go(part, &mut r); (out, r) }) }).collect();
        workers.into_iter().map(|w| w.join().expect("a walking thread panicked")).collect()
    });
    let mut out = Vec::with_capacity(jobs.len());
    for (walked, r) in parts { out.extend(walked); references.extend(r); }
    out
}

/// New function starts split only the functions whose ranges held them:
/// walk those again, and keep every other walk.
fn split(done: &mut BTreeMap<u64, Vec<Block>>, starts: &BTreeSet<u64>, found: &BTreeSet<u64>) {
    for &t in found {
        if let Some(&before) = starts.range(..t).next_back() { done.remove(&before); }
    }
}

/// The half-open range a function may own: its symbol size, or up to the
/// next function start when the size is unknown.
fn ranges(starts: &BTreeSet<u64>, sizes: &BTreeMap<u64, u64>) -> BTreeMap<u64, u64> {
    let mut out = BTreeMap::new();
    let all: Vec<u64> = starts.iter().copied().collect();
    for (i, &start) in all.iter().enumerate() {
        let next = all.get(i + 1).copied().unwrap_or(u64::MAX);
        let end = match sizes.get(&start) {
            Some(&size) if size > 0 => (start + size).min(next.max(start + size)),
            _ => next,
        };
        out.insert(start, end);
    }
    out
}

/// What a walk keeps of an instruction it decoded: what makes blocks of it, and what a block keeps of it (as
/// Block::of finds from an instruction), in 16 bytes, not an iced Instruction's 40 copied in and out.
#[derive(Clone, Copy)]
struct Step {
    /// Where its direct branch or call goes (with TARGET).
    target: u64,
    len: u8,
    /// How it goes on: one of NEXT .. STOP.
    flow: u8,
    reads: u8,
    writes: u8,
    /// TARGET, TRAPS, SYSCALL.
    bits: u8,
}

// A step's flow (flow() as a walk reads it).
const NEXT: u8 = 0;
const CALL: u8 = 1;
const INDIRECT_CALL: u8 = 2;
const BRANCH: u8 = 3;
const JUMP: u8 = 4;
const INDIRECT_JUMP: u8 = 5;
const RETURN: u8 = 6;
/// Anything else: undecodable, trapping, or a flow translation does not follow (int3, ud2, hlt, xbegin).
const STOP: u8 = 7;
// A step's bits.
const TARGET: u8 = 1;
const TRAPS: u8 = 2;
const SYSCALL: u8 = 4;

impl Step {
    fn of(i: &Instruction) -> Step {
        let flow = match flow(i) {
            FlowControl::Next | FlowControl::Interrupt if i.mnemonic() != Mnemonic::Int3 => NEXT,
            FlowControl::Call => CALL,
            FlowControl::IndirectCall => INDIRECT_CALL,
            FlowControl::ConditionalBranch => BRANCH,
            FlowControl::UnconditionalBranch => JUMP,
            FlowControl::IndirectBranch => INDIRECT_JUMP,
            FlowControl::Return => RETURN,
            _ => STOP,
        };
        let target = direct_target(i);
        let traps = matches!(i.mnemonic(), Mnemonic::Syscall | Mnemonic::Sysenter | Mnemonic::Int | Mnemonic::Int1 | Mnemonic::Int3 | Mnemonic::Into);
        let bits = if target.is_some() { TARGET } else { 0 } | if traps { TRAPS } else { 0 } | if resumes_after(i) { SYSCALL } else { 0 };
        Step { target: target.unwrap_or(0), len: i.len() as u8, flow, reads: flags_read(i) as u8, writes: flags_written(i) as u8, bits }
    }
    fn target(&self) -> Option<u64> { (self.bits & TARGET != 0).then_some(self.target) }
}

/// What a walk keeps while it walks, by each byte's offset from its start (not hashed: a byte's place is its own
/// address): the steps it decoded, in order, and for each byte 1 + the index of the one that starts there (0:
/// none), with LEADER where a block starts. Code past its range (a call's continuation past the end) goes in
/// `outside`, a few places at most. A thread keeps one from walk to walk, cleared, not freed.
#[derive(Default)]
struct Scratch {
    base: u64,
    /// The bytes from `base` kept by offset, and how far into them this walk has been.
    span: usize,
    high: usize,
    at: Vec<u32>,
    outside: Vec<(u64, u32)>,
    steps: Vec<Step>,
    /// Every place marked a leader, as marked.
    leads: Vec<u64>,
    /// A block's steps as it is made.
    block: Vec<Step>,
}

/// A block starts at this byte (Scratch::at).
const LEADER: u32 = 1 << 31;

impl Scratch {
    fn begin(&mut self, base: u64, span: usize) {
        (self.base, self.span) = (base, span);
        self.steps.clear();
        self.outside.clear();
        self.leads.clear();
    }
    fn offset(&self, a: u64) -> Option<usize> { a.checked_sub(self.base).filter(|&o| o < self.span as u64).map(|o| o as usize) }
    fn entry(&mut self, a: u64) -> &mut u32 {
        if let Some(o) = self.offset(a) {
            if o >= self.at.len() { self.at.resize((o + 1).next_multiple_of(4096).min(self.span), 0); }
            self.high = self.high.max(o + 1);
            return &mut self.at[o];
        }
        let k = self.outside.iter().position(|&(x, _)| x == a).unwrap_or_else(|| { self.outside.push((a, 0)); self.outside.len() - 1 });
        &mut self.outside[k].1
    }
    fn get(&self, a: u64) -> u32 {
        match self.offset(a) {
            Some(o) => self.at.get(o).copied().unwrap_or(0),
            None => self.outside.iter().find(|&&(x, _)| x == a).map_or(0, |&(_, v)| v),
        }
    }
    fn lead(&mut self, a: u64) {
        let e = self.entry(a);
        if *e & LEADER == 0 {
            *e |= LEADER;
            self.leads.push(a);
        }
    }
    fn is_leader(&self, a: u64) -> bool { self.get(a) & LEADER != 0 }
    fn is_decoded(&self, a: u64) -> bool { self.get(a) & !LEADER != 0 }
    fn record(&mut self, a: u64, s: Step) {
        self.steps.push(s);
        let n = self.steps.len() as u32;
        let e = self.entry(a);
        *e = (*e & LEADER) | n;
    }
    fn step(&self, a: u64) -> Step { self.steps[(self.get(a) & !LEADER) as usize - 1] }
    /// Where blocks start in what was decoded, in order.
    fn leaders(&mut self) -> Vec<u64> {
        let mut out = std::mem::take(&mut self.leads);
        out.sort_unstable();
        out.retain(|&a| self.is_decoded(a));
        out
    }
    fn end(&mut self) {
        self.at[..self.high].fill(0);
        self.high = 0;
    }
}

fn walk(elf: &Elf, (start, end): (u64, u64), extra: &[u64], inner: &[u64], mut references: Option<&mut BTreeSet<u64>>, scratch: &mut Scratch) -> (Vec<Block>, Vec<u64>) {
    let inside = |a: u64| a >= start && a < end && (a == start || inner.binary_search(&a).is_err());
    // One decoder over the code from the start to its segment's end, moved to each instruction; code elsewhere (a
    // call's continuation past the range's segment) is decoded on its own.
    let code = elf.code_at(start).unwrap_or_default();
    let mut decoder = Decoder::with_ip(64, code, start, DecoderOptions::NONE);
    let mut decode = |at: u64| -> Option<Instruction> {
        let Some(offset) = at.checked_sub(start).filter(|&o| o < code.len() as u64) else { return decode(elf, at) };
        decoder.set_position(offset as usize).ok()?;
        decoder.set_ip(at);
        let instruction = decoder.decode();
        (!instruction.is_invalid()).then_some(instruction)
    };
    scratch.begin(start, (end.min(start + code.len() as u64) - start) as usize);
    let mut first: Vec<u64> = std::iter::once(start).chain(extra.iter().copied().filter(|&a| inside(a))).collect();
    first.sort_unstable();
    first.dedup();
    for &a in &first { scratch.lead(a); }
    let mut work: VecDeque<u64> = first.into_iter().collect();
    let mut calls = Vec::new();
    while let Some(mut at) = work.pop_front() {
        loop {
            if scratch.is_decoded(at) {
                // Joining code decoded from another path starts a block.
                scratch.lead(at);
                break;
            }
            let Some(i) = decode(at) else {
                break;
            };
            scratch.record(at, Step::of(&i));
            if resumes_after(&i) {
                scratch.lead(at);
                scratch.lead(i.next_ip());
            }
            if let Some(r) = references.as_deref_mut() {
                if i.is_ip_rel_memory_operand() { r.insert(i.ip_rel_memory_address()); }
                // Where code is not position-independent, an address in its code given as a number is one too.
                if elf.fixed {
                    for k in 0..i.op_count() {
                        if matches!(i.op_kind(k), OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64) && elf.is_code(i.immediate(k)) {
                            r.insert(i.immediate(k));
                        }
                    }
                }
            }
            let next = i.next_ip();
            match flow(&i) {
                FlowControl::Next | FlowControl::Interrupt if i.mnemonic() != Mnemonic::Int3 => {
                    if !inside(next) {
                        calls.push(next);
                        break;
                    }
                    at = next;
                }
                FlowControl::Call => {
                    if let Some(t) = direct_target(&i) {
                        calls.push(t);
                    }
                    scratch.lead(next);
                    work.push_back(next);
                    break;
                }
                FlowControl::IndirectCall => {
                    scratch.lead(next);
                    work.push_back(next);
                    break;
                }
                FlowControl::ConditionalBranch => {
                    let t = direct_target(&i).unwrap();
                    for a in [t, next] {
                        if inside(a) {
                            scratch.lead(a);
                            work.push_back(a);
                        } else {
                            calls.push(a);
                        }
                    }
                    break;
                }
                FlowControl::UnconditionalBranch => {
                    if let Some(t) = direct_target(&i) {
                        if inside(t) {
                            scratch.lead(t);
                            work.push_back(t);
                        } else {
                            calls.push(t);
                        }
                    }
                    break;
                }
                _ => break,
            }
        }
    }

    // Each block runs from a leader along next_ip until a terminator or the
    // next leader. Following next_ip (not address order) keeps blocks right
    // even when a wrong table guess decoded bytes inside an instruction.
    let order = scratch.leaders();
    let mut blocks = Vec::with_capacity(order.len());
    let mut steps = std::mem::take(&mut scratch.block);
    for block_start in order {
        steps.clear();
        let mut at = block_start;
        let exit = loop {
            let s = scratch.step(at);
            steps.push(s);
            let next = at + s.len as u64;
            match s.flow {
                CALL => break match s.target() {
                    Some(target) => Exit::Call { target, ret: next },
                    None => Exit::IndirectCall { ret: next },
                },
                INDIRECT_CALL => break Exit::IndirectCall { ret: next },
                BRANCH => break Exit::Branch { taken: s.target().unwrap(), fall: next },
                JUMP => {
                    let t = s.target().unwrap();
                    break if inside(t) { Exit::Jump(t) } else { Exit::TailJump(t) };
                }
                INDIRECT_JUMP => break Exit::IndirectJump,
                RETURN => break Exit::Return,
                NEXT => {
                    if !scratch.is_decoded(next) {
                        // Running into the next function is a tail call to it.
                        break if inside(next) { Exit::Trap } else { Exit::TailJump(next) };
                    }
                    if scratch.is_leader(next) {
                        break Exit::Fall(next);
                    }
                    at = next;
                }
                _ => break Exit::Trap,
            }
        };
        blocks.push(Block::of_steps(block_start, &steps, exit));
    }
    scratch.block = steps;
    scratch.end();
    (blocks, calls)
}

/// Where a function's blocks jump or run on to outside it (its tail jumps, and branches out of it): not its calls.
fn continuations(blocks: &[Block]) -> Vec<u64> {
    let own: BTreeSet<u64> = blocks.iter().map(|b| b.start).collect();
    let mut out = Vec::new();
    for b in blocks {
        match b.exit {
            Exit::TailJump(t) => out.push(t),
            Exit::Branch { taken, fall } => out.extend([taken, fall].into_iter().filter(|a| !own.contains(a))),
            Exit::Fall(t) | Exit::Jump(t) if !own.contains(&t) => out.push(t),
            _ => {}
        }
    }
    out
}

/// Targets of position-relative jump tables. Each entry holds
/// `target - base`, where the base is the table start that code addresses
/// with a rip-relative `lea`. A slot belongs to the nearest base at or below
/// it; runs of consecutive slots also start a table.
fn relative_table_targets(elf: &Elf, references: &BTreeSet<u64>) -> Vec<u64> {
    let mut bases: BTreeSet<u64> = references.iter().copied().filter(|&a| !elf.is_code(a)).collect();
    let mut previous = None;
    for &p in &elf.relative_slots {
        if previous != Some(p.wrapping_sub(4)) {
            bases.insert(p);
        }
        previous = Some(p);
    }
    let mut out = Vec::new();
    for &p in &elf.relative_slots {
        let Some(&base) = bases.range(..=p).next_back() else { continue };
        let Some(value) = elf.read_i32(p) else { continue };
        let target = base.wrapping_add(value as i64 as u64);
        if elf.is_code(target) {
            out.push(target);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// The most entries a table is read for when what bounds it is not found.
const TABLE_ENTRIES: u64 = 4096;

/// The cases of the switches in `blocks` (one function's, whose range is `start`..`end`) that jump through a table,
/// found from the code that reads the table, for a program whose relocations do not say where its tables are
/// (linked without --emit-relocs, as most are). As compilers make them, position-independent:
///
/// ```text
/// cmp    I, N               the block before: ja past the table, or jbe to it
/// ja     default
/// lea    B, [rip + table]   (or once in the function, for every switch of a loop)
/// movsxd T, dword [B + I*4]
/// add    T, B
/// jmp    T                  to table + entry
/// ```
///
/// or absolute (`jmp [table + I*8]`, or a `mov T, [table + I*8]` before `jmp T`), each entry a case itself. N + 1
/// entries; where the bound is not found, those that land in the function (a switch's cases are its own), at most
/// TABLE_ENTRIES. One read past its table's end adds blocks that never run (a walk follows each instruction's
/// length, so a block starting inside another instruction leaves the real ones as they are).
fn switch_targets(elf: &Elf, blocks: &[Block], start: u64, end: u64) -> Vec<u64> {
    let mut out = Vec::new();
    for b in blocks.iter().filter(|b| b.exit == Exit::IndirectJump) {
        let Some((table, index, relative)) = table_read(&b.instructions(elf)) else { continue };
        let Some(table) = table.or_else(|| only_lea(elf, blocks, index.1)) else { continue };
        let index = index.0;
        let bound = bound_of(elf, blocks, b.start, index);
        for k in 0..bound.unwrap_or(TABLE_ENTRIES) {
            let target = if relative {
                let Some(entry) = elf.read_i32(table + 4 * k) else { break };
                table.wrapping_add(entry as i64 as u64)
            } else {
                let Some(entry) = elf.read_u64(table + 8 * k) else { break };
                entry
            };
            let ok = elf.is_code(target) && (bound.is_some() || (target >= start && target < end));
            if !ok { break; }
            out.push(target);
        }
    }
    out
}

/// The table a block ending in an indirect jump goes through, as switch_targets shows: its address (None: the one
/// in the register given with the index, put there before this block), the register that indexes it (and the one
/// that holds it), and whether its entries are relative to it.
fn table_read(code: &[Instruction]) -> Option<(Option<u64>, (Register, Register), bool)> {
    let (jmp, before) = code.split_last()?;
    if jmp.mnemonic() != Mnemonic::Jmp { return None; }
    let entry = |i: &Instruction, scale: u32| (i.memory_index() != Register::None && i.memory_index_scale() == scale).then(|| i.memory_index());
    // jmp [table + I*8]
    if jmp.op0_kind() == OpKind::Memory && jmp.memory_base() == Register::None {
        return Some((Some(jmp.memory_displacement64()), (entry(jmp, 8)?, Register::None), false));
    }
    if jmp.op0_kind() != OpKind::Register { return None; }
    let target = jmp.op0_register();
    let last = |p: &dyn Fn(&Instruction) -> bool, within: &[Instruction]| within.iter().rposition(p);
    // mov T, [table + I*8]; jmp T
    if let Some(k) = last(&|i| i.mnemonic() == Mnemonic::Mov && i.op0_register() == target && i.op1_kind() == OpKind::Memory, before) {
        let i = &before[k];
        if i.memory_base() == Register::None { return Some((Some(i.memory_displacement64()), (entry(i, 8)?, Register::None), false)); }
    }
    // lea B, [rip + table]; movsxd T, dword [B + I*4]; add T, B; jmp T
    let a = last(&|i| i.mnemonic() == Mnemonic::Add && i.op0_register() == target && i.op1_kind() == OpKind::Register, before)?;
    let base = before[a].op1_register();
    let m = last(&|i| i.mnemonic() == Mnemonic::Movsxd && i.op0_register() == target && i.op1_kind() == OpKind::Memory
        && i.memory_base() == base && i.memory_displacement64() == 0, &before[..a])?;
    let index = entry(&before[m], 4)?;
    let l = last(&|i| i.op0_kind() == OpKind::Register && i.op0_register() == base, &before[..m]);
    match l.map(|l| &before[l]) {
        Some(i) if i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() => Some((Some(i.ip_rel_memory_address()), (index, base), true)),
        // Written otherwise here: not a table read as above.
        Some(_) => None,
        None => Some((None, (index, base), true)),
    }
}

/// The constant `register` holds where a function puts it in one place only (`lea register, [rip + constant]`, as a
/// loop over a switch does once, before the loop), and writes it nowhere else (its caller's value saved and put back
/// around it, push and pop, is not the function's).
fn only_lea(elf: &Elf, blocks: &[Block], register: Register) -> Option<u64> {
    let writes_it = |i: &Instruction| i.op0_kind() == OpKind::Register && i.op0_register().full_register() == register.full_register()
        && !matches!(i.mnemonic(), Mnemonic::Push | Mnemonic::Pop | Mnemonic::Cmp | Mnemonic::Test);
    let mut writes = blocks.iter().flat_map(|b| b.instructions(elf)).filter(writes_it);
    let i = writes.next()?;
    (writes.next().is_none() && i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() && i.op0_register() == register).then(|| i.ip_rel_memory_address())
}

/// How many entries the table read at block `at` has, from the bounds check before it: `cmp I, N` then `ja` past it
/// or `jbe` to it, in a block of the function's that goes on to `at`.
fn bound_of(elf: &Elf, blocks: &[Block], at: u64, index: Register) -> Option<u64> {
    blocks.iter().find_map(|p| {
        let Exit::Branch { taken, fall } = p.exit else { return None };
        // (Only a block that goes on to it can bound it: the others are not decoded.)
        if taken != at && fall != at { return None; }
        let code = p.instructions(elf);
        let [.., cmp, jcc] = code.as_slice() else { return None };
        let to_table = (jcc.mnemonic() == Mnemonic::Ja && fall == at) || (jcc.mnemonic() == Mnemonic::Jbe && taken == at);
        let same = cmp.op0_kind() == OpKind::Register && cmp.op0_register().full_register() == index.full_register();
        let n = match cmp.op1_kind() {
            OpKind::Immediate8 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32 | OpKind::Immediate32to64 => Some(cmp.immediate(1)),
            _ => None,
        };
        (to_table && cmp.mnemonic() == Mnemonic::Cmp && same).then_some(n?).filter(|&n| n < TABLE_ENTRIES).map(|n| n + 1)
    })
}

/// Functions reached from `seeds`, for a program already running: code at
/// `known` addresses is translated already, so a walk stops there and a
/// call to it goes through the dispatcher. Nothing of the file is read but
/// the code execution reaches from the seeds.
/// The blocks of `f` that block `k` goes back to (at or before itself): the heads of its loops.
pub fn back_edges(f: &Function, k: usize, b: &Block) -> Vec<u64> {
    goes_to(b).into_iter().flatten().filter(|&a| f.block_index(a).is_some_and(|j| j <= k)).collect()
}

pub fn discover_from(elf: &Elf, seeds: &[u64], known: &BTreeSet<u64>) -> Program {
    discover_within(elf, seeds, known, usize::MAX)
}

/// How many instructions code reached later is walked to, past its seeds'
/// own functions, before what they call is left to be reached. A running
/// program's first jump somewhere asks for code; following everything it
/// could call from there translated six times what ran (cc1 compiling a
/// line: 29,355 functions, 5,225 of them entered). At this size, against
/// following everything (whole root, the browser's translator): gcc
/// building hello 10.1 -> 6.8 s, git init/add/commit/log 2.5 -> 1.8 s,
/// make the same; each module is cheap enough that more of them cost less
/// than the code they would not hold.
pub const BUDGET: usize = 1000;

/// discover_from, following the code the seeds call only while what was
/// walked holds fewer than `budget` instructions: past that, a call or jump
/// to code not walked goes through the dispatcher, and that code is
/// translated when it is first reached, if it ever is.
pub fn discover_within(elf: &Elf, seeds: &[u64], known: &BTreeSet<u64>, budget: usize) -> Program {
    // Starts are looked up in `known` where they are, not copied: it holds every function a large program has reached.
    let mut starts: BTreeSet<u64> = seeds.iter().copied().filter(|a| elf.is_code(*a) && !known.contains(a)).collect();
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    let after = |set: &BTreeSet<u64>, a: u64| set.range(a + 1..).next().copied().unwrap_or(u64::MAX);
    let before = |set: &BTreeSet<u64>, a: u64| set.range(..a).next_back().copied();
    let mut scratch = Scratch::default();
    loop {
        let mut found = BTreeSet::new();
        for &start in &starts {
            if done.contains_key(&start) { continue; }
            let end = after(known, start).min(after(&starts, start));
            // The range ends at the next start of either set, so nothing inside it is a start: no lookup per
            // instruction. Nor are data references wanted (they find jump tables when the whole program is walked).
            // Nor the cases of its switches: a compiler's are hundreds, of which a run takes a few (each is reached
            // later as it is taken).
            let (blocks, calls) = walk(elf, (start, end), &[], &[], None, &mut scratch);
            found.extend(calls.into_iter().filter(|t| elf.is_code(*t) && !known.contains(t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        let walked: usize = done.values().flatten().map(|b| b.count as usize).sum();
        if found.is_empty() || walked >= budget { break; }
        // A new start splits the walk whose range held it, when that walk is one of these.
        for &t in &found {
            if let Some(b) = before(&starts, t) {
                if before(known, t).is_none_or(|k| k < b) { done.remove(&b); }
            }
        }
        starts.extend(found);
    }
    let mut functions = Vec::new();
    let mut entries = Vec::new();
    for (start, blocks) in done {
        let first = functions.len();
        for function in runs(start, format!("fn_{start:x}"), blocks) {
            let f = functions.len() as u32;
            let mut mark = |address: u64| {
                if let Some(b) = function.block_index(address) { entries.push((address, (f, b as u32))); }
            };
            mark(function.start);
            for (k, b) in function.blocks.iter().enumerate() {
                if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit { mark(ret); }
                // A loop's head: where a thread that has run long is taken back to the kernel, and goes on later.
                for a in back_edges(&function, k, b) { mark(a); }
                if b.resumes {
                    mark(b.last_ip());
                    mark(b.end());
                }
            }
            functions.push(function);
        }
        joined(&functions[first..], first, &mut entries);
    }
    Program { entry: elf.entry, functions, entries: Entries::of(entries) }
}

/// The program's code from its entry, its function symbols and what its relocations point at: what a running program
/// has translated first, the rest being reached later (`discover_within`).
pub fn discover(elf: &Elf) -> Program {
    walk_program(elf, &elf.relocation_targets, elf.symbols.is_empty(), &[], Follow::Calls)
}

/// Exactly the functions starting at `seeds` (with the entry and the named ones): what the program's runs have
/// translated so far, its first module's and those of the code they reached later, in one translation of its own,
/// so each process of it starts with one module, not hundreds, and every jump among that code is found in its first
/// table. A call to a function past these is not followed, nor a switch's table (each is reached later, as before):
/// following them all would translate much of a large program no run has reached.
pub fn discover_seeded(elf: &Elf, seeds: &[u64]) -> Program {
    walk_program(elf, &elf.relocation_targets, false, seeds, Follow::Not)
}

/// The whole program, ahead of time: as `discover`, and where no function of its own is named (stripped, or only a
/// post-link tool's absolute marks) every function its pointers name, the dynamic segment's included. Code reached
/// only through a pointer is then translated with the rest, not when it is first run (a shell's builtins and
/// applets); for a large program that is far more than one run reaches.
pub fn discover_whole(elf: &Elf) -> Program {
    let mut targets: Vec<u64> = elf.relocation_targets.iter().chain(&elf.data_pointers).copied().collect();
    targets.sort_unstable();
    targets.dedup();
    let named = elf.symbols.iter().any(|s| s.function && elf.is_code(s.value));
    walk_program(elf, &targets, !named, &[], Follow::Everything)
}

/// What a walk of the program goes on to from what it has walked.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Follow {
    /// Only code a function jumps or runs into past its range (a translation of exactly what runs reached).
    Not,
    /// Every function a call reaches: what a running program translates first.
    Calls,
    /// And every function whose address code takes (a callback passed, rip-relative or, where code is not
    /// position-independent, as a number): the whole program, ahead of time. Not for a first translation: a
    /// compiler's (cc1, 60,000 functions, none named) would be all of it, where a run reaches a few thousand.
    Everything,
}

/// Walk from the entry, the symbols in code, `seeds`, and `targets` (sorted) as pointers, each one a start of its own
/// when `pointed_start`; and on as `follow` says.
fn walk_program(elf: &Elf, targets: &[u64], pointed_start: bool, seeds: &[u64], follow: Follow) -> Program {
    let mut starts: BTreeSet<u64> = BTreeSet::from([elf.entry]);
    starts.extend(seeds.iter().copied().filter(|&a| elf.is_code(a)));
    let mut sizes = BTreeMap::new();
    let mut names = BTreeMap::new();
    // Function symbols, and untyped ones (assembly entry points like _init,
    // _fini) that code also points at.
    let pointed: BTreeSet<u64> = targets.iter().copied().collect();
    for s in elf.symbols.iter().filter(|s| elf.is_code(s.value) && (s.function || pointed.contains(&s.value))) {
        starts.insert(s.value);
        sizes.entry(s.value).or_insert(s.size);
        names.entry(s.value).or_insert_with(|| s.name.clone());
    }
    let mut pointers: Vec<u64> = targets.iter().copied().filter(|&a| elf.is_code(a)).collect();
    let mut references = BTreeSet::new();
    if pointed_start {
        starts.extend(pointers.iter().copied());
    }

    // Walk until no new call target appears.
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    loop {
        let range = ranges(&starts, &sizes);
        let mut found = Vec::new();
        // The pointers (sorted) inside each function's range.
        let sorted: Vec<u64> = starts.iter().copied().collect();
        let jobs: Vec<Job> = starts.iter().filter(|s| !done.contains_key(s)).map(|&start| {
            let end = range[&start];
            let within = |all: &[u64]| (all.partition_point(|&a| a <= start), all.partition_point(|&a| a < end));
            let ((p, q), (i, j)) = (within(&pointers), within(&sorted));
            (start, end, &pointers[p..q], &sorted[i..j])
        }).collect();
        // Without relocations that say where its tables are, those its switches read (switch_targets).
        let guess = elf.relative_slots.is_empty();
        let mut switches = Vec::new();
        for (start, blocks, calls) in walk_all(elf, &jobs, &mut references) {
            if guess && follow != Follow::Not { switches.extend(switch_targets(elf, &blocks, start, range[&start])); }
            // Not following calls, code it goes on to all the same: what it jumps or runs into past its range is code
            // the runs reached as part of it before more starts cut it there.
            let next: Vec<u64> = if follow == Follow::Not { continuations(&blocks) } else { calls };
            found.extend(next.into_iter().filter(|t| elf.is_code(*t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        // Code whose address code takes (as a callback is passed): a function, as a pointer to it is.
        if follow == Follow::Everything { found.extend(references.iter().copied().filter(|&a| elf.is_code(a) && !starts.contains(&a))); }
        // Not following calls, nor the cases of switches (as discover_within: each is reached later as it is taken;
        // following them all, a compiler's consolidation translated two and a half times the functions its runs had).
        let mut tables = if follow == Follow::Not { Vec::new() } else if guess { switches } else { relative_table_targets(elf, &references) };
        tables.sort_unstable();
        tables.dedup();
        tables.retain(|t| pointers.binary_search(t).is_err());
        if found.is_empty() && tables.is_empty() {
            break;
        }
        // A table's targets are leaders of the functions that hold them.
        let held: BTreeSet<u64> = tables.iter().filter_map(|t| starts.range(..=*t).next_back().copied()).collect();
        for h in held { done.remove(&h); }
        pointers.extend(tables);
        pointers.sort_unstable();
        let found: BTreeSet<u64> = found.into_iter().collect();
        split(&mut done, &starts, &found);
        starts.extend(found);
    }

    let mut functions = Vec::new();
    let mut entries = Vec::new();
    for (start, blocks) in done {
        let name = names.get(&start).cloned().unwrap_or_else(|| format!("fn_{start:x}"));
        let first_run = functions.len();
        for function in runs(start, name, blocks) {
            let f = functions.len() as u32;
            let mut mark = |address: u64, function: &Function| {
                if let Some(b) = function.block_index(address) {
                    entries.push((address, (f, b as u32)));
                }
            };
            mark(function.start, &function);
            for (k, b) in function.blocks.iter().enumerate() {
                if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit {
                    mark(ret, &function);
                }
                // A loop's head: where a thread that has run long is taken back to the kernel, and goes on later.
                for a in back_edges(&function, k, b) { mark(a, &function); }
                if b.resumes {
                    mark(b.last_ip(), &function);
                    mark(b.end(), &function);
                }
            }
            // Only the pointers (sorted) between its first and last block can land in it.
            if let Some((first, last)) = function.span() {
                let span = &pointers[pointers.partition_point(|&a| a < first)..pointers.partition_point(|&a| a <= last)];
                for &p in span {
                    mark(p, &function);
                }
            }
            functions.push(function);
        }
        joined(&functions[first_run..], first_run, &mut entries);
    }
    Program { entry: elf.entry, functions, entries: Entries::of(entries) }
}
