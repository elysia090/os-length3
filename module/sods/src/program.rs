//! A program as it is found: its functions, their blocks in the order they are lowered and their successors, and the
//! entries execution may arrive at from outside a function's own control flow. A block keeps 48 bytes of what its
//! instructions say, not the instructions (40 bytes each): they are decoded again where they are lowered.

use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind, Register, RflagsBits};
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
        // Each instruction decoded where it is kept, the decoder moved only where the block starts.
        into.clear();
        into.resize(b.count as usize, Instruction::default());
        let o = b.start.wrapping_sub(self.base);
        if o < self.decoder.max_position() as u64 { let _ = self.decoder.set_position(o as usize); self.decoder.set_ip(b.start); }
        let mut at = b.start;
        for i in into.iter_mut() {
            // (A block running on past this segment's end, or in another, decodes the rest on its own.)
            if self.decoder.ip() == at && self.decoder.can_decode() { self.decoder.decode_out(i) } else { *i = decode(elf, at).unwrap_or_default() }
            at = i.next_ip();
        }
    }
}

/// CF, ZF, SF, OF and PF: the flags translated code keeps (as RflagsBits).
pub const ALL_FLAGS: u32 = RflagsBits::OF | RflagsBits::SF | RflagsBits::ZF | RflagsBits::CF | RflagsBits::PF;
// A system call keeps the flags here (r11 is not given them), so it neither reads nor writes them.
pub fn flags_read(i: &Instruction) -> u32 { kind(i).reads as u32 }
pub fn flags_written(i: &Instruction) -> u32 { kind(i).writes as u32 }
/// Whether `i` goes on to the next instruction as translation sees it (a system call returns in place; int3 traps).
pub(crate) fn runs_on(i: &Instruction) -> bool { kinds()[i.code() as usize].flow == go::NEXT }

/// An instruction's flow as translation sees it.
pub(crate) mod go {
    pub const NEXT: u8 = 0;
    pub const CALL: u8 = 1;
    pub const INDIRECT_CALL: u8 = 2;
    pub const BRANCH: u8 = 3;
    pub const JUMP: u8 = 4;
    pub const INDIRECT_JUMP: u8 = 5;
    pub const RETURN: u8 = 6;
    /// Undecodable, trapping, or a flow translation does not follow (int3, ud2, hlt, xbegin).
    pub const STOP: u8 = 7;
}
// A Kind's bits: it goes out to the kernel (a system call, an int); it is a system call; its flags depend on its
// operands (a shift by an immediate, a register xor'd with itself), so they are asked of the instruction.
pub(crate) const TRAPS: u8 = 2;
pub(crate) const SYSCALL: u8 = 4;
const OPERANDS: u8 = 8;

/// What an instruction's code alone says of it: its flow, the flags (as ALL_FLAGS) it reads and writes, and Kind's
/// bits. Worked out once for every code, so an instruction is one look-up, not one walk of iced's tables per question.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Kind { pub flow: u8, pub reads: u8, pub writes: u8, pub bits: u8 }

/// `i`'s Kind.
#[inline(always)]
pub(crate) fn kind(i: &Instruction) -> Kind {
    let k = kinds()[i.code() as usize];
    if k.bits & OPERANDS == 0 { k } else { by_operands(i, k) }
}
#[cold]
#[inline(never)]
fn by_operands(i: &Instruction, k: Kind) -> Kind { Kind { reads: read_by(i), writes: written_by(i), ..k } }
fn read_by(i: &Instruction) -> u8 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { (i.rflags_read() & ALL_FLAGS) as u8 } }
fn written_by(i: &Instruction) -> u8 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { (i.rflags_modified() & ALL_FLAGS) as u8 } }

#[inline(always)]
fn kinds() -> &'static [Kind] {
    static KINDS: std::sync::OnceLock<Vec<Kind>> = std::sync::OnceLock::new();
    KINDS.get_or_init(|| iced_x86::Code::values().map(kind_of).collect())
}

/// The Kind of every instruction of `code`: what iced says of one, and whether what it says of the flags changes
/// with an immediate or with its two registers being one.
fn kind_of(code: iced_x86::Code) -> Kind {
    let mut i = Instruction::default();
    i.set_code(code);
    let m = i.mnemonic();
    let flow = match i.flow_control() {
        _ if m == Mnemonic::Syscall => go::NEXT,
        FlowControl::Next | FlowControl::Interrupt if m != Mnemonic::Int3 => go::NEXT,
        FlowControl::Call => go::CALL,
        FlowControl::IndirectCall => go::INDIRECT_CALL,
        FlowControl::ConditionalBranch => go::BRANCH,
        FlowControl::UnconditionalBranch => go::JUMP,
        FlowControl::IndirectBranch => go::INDIRECT_JUMP,
        FlowControl::Return => go::RETURN,
        _ => go::STOP,
    };
    let flags = |i: &Instruction| (read_by(i), written_by(i));
    let base = flags(&i);
    let mut operands = false;
    for imm in [1, 2, 9, 17] { let mut j = i; j.set_immediate8(imm); operands |= flags(&j) != base; }
    let mut j = i;
    j.set_op0_kind(OpKind::Register);
    j.set_op1_kind(OpKind::Register);
    j.set_op0_register(Register::RAX);
    j.set_op1_register(Register::RAX);
    operands |= flags(&j) != base;
    j.set_op1_register(Register::RCX);
    operands |= flags(&j) != base;
    let traps = matches!(m, Mnemonic::Syscall | Mnemonic::Sysenter | Mnemonic::Int | Mnemonic::Int1 | Mnemonic::Int3 | Mnemonic::Into);
    let bits = if traps { TRAPS } else { 0 } | if m == Mnemonic::Syscall { SYSCALL } else { 0 } | if operands { OPERANDS } else { 0 };
    Kind { flow, reads: base.0, writes: base.1, bits }
}

#[derive(Clone, Debug)]
pub struct Function {
    pub start: u64,
    pub name: String,
    /// In the order they are lowered (`lay_out`): index 0 is the function's entry.
    pub blocks: Vec<Block>,
    /// Each block's successors within (as goes_to has them), by index; NO where none or not this function's.
    pub succ: Vec<[u32; 2]>,
    /// Its blocks' indices, by their addresses.
    pub(crate) by_address: Vec<u32>,
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
pub struct Entries(Vec<(u64, (u32, u32))>, Buckets);

/// Where in a sorted list of addresses each stretch of 2^shift bytes from `base` begins: a look-up is a load and a
/// search of the few addresses in one stretch, not of all of them.
#[derive(Debug, Default)]
pub(crate) struct Buckets { base: u64, shift: u32, at: Vec<u32> }

impl Buckets {
    /// Over `sorted` (ascending), about as many stretches as addresses.
    pub(crate) fn of(sorted: impl ExactSizeIterator<Item = u64> + Clone) -> Buckets {
        let (n, mut all) = (sorted.len(), sorted.clone());
        let (Some(base), Some(last)) = (all.next(), sorted.clone().last()) else { return Buckets::default() };
        let shift = ((last - base) / n as u64).max(1).ilog2();
        let count = ((last - base) >> shift) as usize + 1;
        let mut at = vec![0u32; count + 1];
        for a in sorted { at[((a - base) >> shift) as usize + 1] += 1; }
        for k in 0..count { at[k + 1] += at[k]; }
        Buckets { base, shift, at }
    }
    /// The range of the list where `address` would be.
    #[inline]
    pub(crate) fn range(&self, address: u64) -> std::ops::Range<usize> {
        // (In 64 bits throughout: an address before `base` wraps to far past the last stretch, and a 32-bit usize
        // would cut it to a stretch it is not in.)
        let b = address.wrapping_sub(self.base) >> self.shift;
        if b >= self.at.len().saturating_sub(1) as u64 { return 0..0; }
        let b = b as usize;
        self.at[b] as usize..self.at[b + 1] as usize
    }
}

impl Entries {
    pub(crate) fn of(mut marks: Vec<(u64, (u32, u32))>) -> Entries {
        // The first marked of an address is the one of the lowest function (a function marks an address one way).
        marks.sort_unstable_by_key(|&(a, (f, _))| (a as u128) << 32 | f as u128);
        marks.dedup_by_key(|&mut (a, _)| a);
        marks.shrink_to_fit();
        let buckets = Buckets::of(marks.iter().map(|&(a, _)| a));
        Entries(marks, buckets)
    }
    pub fn get(&self, address: &u64) -> Option<&(u32, u32)> { self.index(*address).map(|k| &self.0[k].1) }
    /// Where `address` is among the entries (as Liveness numbers them), found once for all that is asked of it.
    pub fn index(&self, address: u64) -> Option<usize> {
        let r = self.1.range(address);
        self.0[r.clone()].binary_search_by_key(&address, |&(a, _)| a).ok().map(|k| r.start + k)
    }
    pub fn at(&self, k: usize) -> (u32, u32) { self.0[k].1 }
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
