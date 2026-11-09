//! The kernel: x86-64 code found (find), what the whole program decides before any function is made (facts), and
//! each function made a wasm function (frame), straight into its bytes. What each instruction means is ops.rs, on
//! the kernel's Fx; the module around the code is image.rs.
//!
//! What it costs, an x86 instruction at a time (git's first translation: 680,365 instructions in 178,101 blocks of
//! 7,813 functions): each is decoded twice, once to be found and once to be lowered (iced's decoder, about 120 of the
//! host's instructions each); a walk keeps 16 bytes of it, by its offset (no map is hashed); a block keeps 48 bytes;
//! lowered, it is a few operators written as their bytes, a note of each register it moves, and the flags needed
//! after it. A function's scratch is made once and cleared for the next; nothing is sorted but a walk's leaders and
//! the program's entries, and nothing is lowered twice.

use crate::elf::Elf;
use crate::op::*;
use crate::ops::{Flags, Report, FLAG_BITS};
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, InstructionInfoFactory, Mnemonic, OpAccess, OpKind, Register, RflagsBits};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

// ---- The program ----

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
    /// The block of `code` (at `start`, each instruction after the one before), ending as `exit` says.
    pub fn of(start: u64, code: &[Instruction], exit: Exit) -> Block {
        let steps: Vec<Step> = code.iter().map(Step::of).collect();
        Block::of_steps(start, &steps, exit)
    }
    fn of_steps(start: u64, steps: &[Step], exit: Exit) -> Block {
        let (mut reads, mut writes, mut traps, mut len) = (0, 0, false, 0);
        for s in steps {
            reads |= s.reads & !writes;
            writes |= s.writes;
            traps |= s.bits & TRAPS != 0;
            len += s.len as u32;
        }
        let last = steps.last().expect("a block holds an instruction");
        Block { start, len, count: steps.len() as u32, reads, writes, last: last.len, resumes: last.bits & SYSCALL != 0, traps, exit }
    }
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
struct Code<'e> { base: u64, decoder: Decoder<'e> }

impl<'e> Code<'e> {
    fn new(elf: &'e Elf, base: u64) -> Code<'e> {
        Code { base, decoder: Decoder::with_ip(64, elf.code_at(base).unwrap_or_default(), base, DecoderOptions::NONE) }
    }
    fn decode(&mut self, elf: &Elf, b: &Block, into: &mut Vec<Instruction>) {
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
    fn of(mut marks: Vec<(u64, (u32, u32))>) -> Entries {
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

// ---- Find ----

/// Where a walk of the program starts and how far it goes: from `starts`, the symbols in code (with `symbols`) and
/// `targets` (sorted pointers, each a start of its own when `pointed_start`); each function in its range (to the next
/// start, of these or of `known`, or its symbol's size); on as `follow` says, until nothing new is found or `budget`
/// instructions are walked.
struct Find<'a> {
    starts: BTreeSet<u64>,
    targets: &'a [u64],
    pointed_start: bool,
    known: &'a BTreeSet<u64>,
    budget: usize,
    follow: Follow,
    symbols: bool,
}

/// What a walk of the program goes on to from what it walked.
#[derive(Clone, Copy)]
struct Follow {
    /// Every function a call reaches (else only code a function jumps or runs into past its range).
    calls: bool,
    /// The cases of its switches.
    tables: bool,
    /// Every function whose address code takes (a callback passed, rip-relative or, where code is not
    /// position-independent, as a number).
    taken: bool,
}

/// The program's code from its entry, its function symbols and what its relocations point at: what a running program
/// has translated first, the rest being reached later (`discover_within`).
pub fn discover(elf: &Elf) -> Program {
    let known = BTreeSet::new();
    find(elf, Find { starts: BTreeSet::from([elf.entry]), targets: &elf.relocation_targets, pointed_start: elf.symbols.is_empty(), known: &known, budget: usize::MAX, follow: Follow { calls: true, tables: true, taken: false }, symbols: true })
}

/// Exactly the functions starting at `seeds` (with the entry and the named ones): what the program's runs have
/// translated so far, in one translation of its own. Neither a call to a function past these nor a switch's table is
/// followed (each is reached later, as before).
pub fn discover_seeded(elf: &Elf, seeds: &[u64]) -> Program {
    let (starts, known) = (std::iter::once(elf.entry).chain(seeds.iter().copied().filter(|&a| elf.is_code(a))).collect(), BTreeSet::new());
    find(elf, Find { starts, targets: &elf.relocation_targets, pointed_start: false, known: &known, budget: usize::MAX, follow: Follow { calls: false, tables: false, taken: false }, symbols: true })
}

/// The whole program, ahead of time: as `discover`, and where no function of its own is named every function its
/// pointers name; and every function whose address code takes.
pub fn discover_whole(elf: &Elf) -> Program {
    let mut targets: Vec<u64> = elf.relocation_targets.iter().chain(&elf.data_pointers).copied().collect();
    targets.sort_unstable();
    targets.dedup();
    let named = elf.symbols.iter().any(|s| s.function && elf.is_code(s.value));
    let known = BTreeSet::new();
    find(elf, Find { starts: BTreeSet::from([elf.entry]), targets: &targets, pointed_start: !named, known: &known, budget: usize::MAX, follow: Follow { calls: true, tables: true, taken: true }, symbols: true })
}

pub fn discover_from(elf: &Elf, seeds: &[u64], known: &BTreeSet<u64>) -> Program {
    discover_within(elf, seeds, known, usize::MAX)
}

/// How many instructions code reached later is walked to, past its seeds' own functions, before what they call is
/// left to be reached: following everything a running program's first jump could call translated six times what
/// ran (cc1 compiling a line).
pub const BUDGET: usize = 1000;

/// Functions reached from `seeds` for a program already running: code at `known` addresses is translated already, so
/// a walk stops there and a call to it goes through the dispatcher; past `budget` instructions walked, a call or jump
/// to code not walked does too. Nothing of the file is read but the code execution reaches from the seeds.
pub fn discover_within(elf: &Elf, seeds: &[u64], known: &BTreeSet<u64>, budget: usize) -> Program {
    let starts = seeds.iter().copied().filter(|a| elf.is_code(*a) && !known.contains(a)).collect();
    find(elf, Find { starts, targets: &[], pointed_start: false, known, budget, follow: Follow { calls: true, tables: false, taken: false }, symbols: false })
}

/// The program `walk` finds.
fn find(elf: &Elf, walk: Find) -> Program {
    let Find { mut starts, targets, pointed_start, known, budget, follow, symbols } = walk;
    let (mut sizes, mut names) = (BTreeMap::new(), BTreeMap::new());
    if symbols {
        // Function symbols, and untyped ones (assembly entry points like _init) that code also points at.
        for s in elf.symbols.iter().filter(|s| elf.is_code(s.value) && (s.function || targets.binary_search(&s.value).is_ok())) {
            starts.insert(s.value);
            sizes.entry(s.value).or_insert(s.size);
            names.entry(s.value).or_insert_with(|| s.name.clone());
        }
    }
    let mut pointers: Vec<u64> = targets.iter().copied().filter(|&a| elf.is_code(a)).collect();
    if pointed_start { starts.extend(pointers.iter().copied()); }
    // Without relocations that say where its tables are, the tables its switches read (switch_targets).
    let guess = elf.relative_slots.is_empty();
    let collect = follow.taken || (follow.tables && !guess);
    let mut references: Vec<u64> = Vec::new();
    let after = |set: &BTreeSet<u64>, a: u64| set.range(a + 1..).next().copied().unwrap_or(u64::MAX);
    let before = |set: &BTreeSet<u64>, a: u64| set.range(..a).next_back().copied();
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    loop {
        let sorted: Vec<u64> = starts.iter().copied().collect();
        let end = |s: u64| {
            let next = after(&starts, s).min(after(known, s));
            match sizes.get(&s) { Some(&size) if size > 0 => s + size, _ => next }
        };
        let inside = |all: &[u64], s: u64, e: u64| (all.partition_point(|&a| a <= s), all.partition_point(|&a| a < e));
        let jobs: Vec<Job> = sorted.iter().filter(|s| !done.contains_key(s)).map(|&s| {
            let e = end(s);
            let ((p, q), (i, j)) = (inside(&pointers, s, e), inside(&sorted, s, e));
            (s, e, &pointers[p..q], &sorted[i..j])
        }).collect();
        let mut found = Vec::new();
        let mut switches = Vec::new();
        for (s, blocks, calls) in walk_all(elf, &jobs, collect.then_some(&mut references)) {
            if guess && follow.tables { switches.extend(switch_targets(elf, &blocks, s, end(s))); }
            // Not following calls, code it goes on to all the same: what it jumps or runs into past its range.
            let next = if follow.calls { calls } else { continuations(&blocks) };
            found.extend(next.into_iter().filter(|t| elf.is_code(*t) && !known.contains(t) && !starts.contains(t)));
            done.insert(s, blocks);
        }
        if collect { references.sort_unstable(); references.dedup(); }
        if follow.taken { found.extend(references.iter().copied().filter(|&a| elf.is_code(a) && !starts.contains(&a))); }
        let mut tables = if !follow.tables { Vec::new() } else if guess { switches } else { relative_table_targets(elf, &references) };
        tables.sort_unstable();
        tables.dedup();
        tables.retain(|t| pointers.binary_search(t).is_err());
        let walked: usize = if budget == usize::MAX { 0 } else { done.values().flatten().map(|b| b.count as usize).sum() };
        if (found.is_empty() && tables.is_empty()) || walked >= budget { break; }
        // A table's targets are leaders of the functions that hold them; a new start splits the walk whose range
        // held it (unless a known start ends that range before it).
        for t in &tables { if let Some(h) = starts.range(..=*t).next_back() { done.remove(h); } }
        pointers.extend(tables);
        pointers.sort_unstable();
        // (Only when what it walked reaches the new start: a walk that stopped short of it would be walked again to the
        // same blocks.)
        for &t in &found {
            if let Some(b) = before(&starts, t) {
                let reaches = done.get(&b).is_some_and(|blocks| blocks.iter().any(|k| k.end() >= t));
                if reaches && before(known, t).is_none_or(|k| k < b) { done.remove(&b); }
            }
        }
        starts.extend(found);
    }
    let mut functions = Vec::new();
    let mut marks = Vec::new();
    for (start, blocks) in done {
        let name = names.get(&start).cloned().unwrap_or_else(|| format!("fn_{start:x}"));
        let first = functions.len();
        for f in runs(start, name, blocks) {
            let k = functions.len() as u32;
            let found = |a: u64| f.block_index(a).map(|b| (a, (k, b as u32)));
            let at = |t: u32| (f.blocks[t as usize].start, (k, t));
            marks.extend(found(f.start));
            for (j, (b, to)) in f.blocks.iter().zip(&f.succ).enumerate() {
                if matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) && to[0] != NO { marks.push(at(to[0])); }
                // A loop's head: where a thread that has run long is taken back to the kernel, and goes on later.
                for &t in to { if t != NO && t as usize <= j { marks.push(at(t)); } }
                if b.resumes { marks.extend(found(b.last_ip())); marks.extend(found(b.end())); }
            }
            // Only the pointers between its first and last block can land in it.
            if let Some((lo, hi)) = f.span() {
                marks.extend(pointers[pointers.partition_point(|&a| a < lo)..pointers.partition_point(|&a| a <= hi)].iter().filter_map(|&p| found(p)));
            }
            functions.push(f);
        }
        joined(&functions[first..], first, &mut marks);
    }
    Program { entry: elf.entry, functions, entries: Entries::of(marks) }
}

/// A walk's work: its start, the end of its range, the pointers into the range and the other starts inside it.
type Job<'a> = (u64, u64, &'a [u64], &'a [u64]);

/// Each job walked: natively on every core, in wasm (one thread) in turn; in the order given.
fn walk_all(elf: &Elf, jobs: &[Job], references: Option<&mut Vec<u64>>) -> Vec<(u64, Vec<Block>, Vec<u64>)> {
    let collect = references.is_some();
    let go = |part: &[Job], r: &mut Vec<u64>| -> Vec<(u64, Vec<Block>, Vec<u64>)> {
        let mut scratch = Scratch::default();
        part.iter().map(|&(s, e, extra, inner)| { let (b, c) = walk(elf, (s, e), extra, inner, collect.then_some(&mut *r), &mut scratch); (s, b, c) }).collect()
    };
    let mut own = Vec::new();
    let r = references.unwrap_or(&mut own);
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    if threads == 1 || jobs.len() < 64 { return go(jobs, r); }
    let size = jobs.len().div_ceil(threads);
    let parts: Vec<_> = std::thread::scope(|scope| {
        let workers: Vec<_> = jobs.chunks(size).map(|part| { let go = &go; scope.spawn(move || { let mut r = Vec::new(); let out = go(part, &mut r); (out, r) }) }).collect();
        workers.into_iter().map(|w| w.join().expect("a walking thread panicked")).collect()
    });
    let mut out = Vec::with_capacity(jobs.len());
    for (walked, mine) in parts { out.extend(walked); r.extend(mine); }
    out
}

/// What a walk keeps of an instruction it decoded, in 16 bytes.
#[derive(Clone, Copy)]
struct Step { target: u64, len: u8, flow: u8, reads: u8, writes: u8, bits: u8 }

/// A step's flow.
mod go {
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
use go::{BRANCH, CALL, INDIRECT_CALL, INDIRECT_JUMP, JUMP, NEXT, STOP};
// A step's bits.
const TARGET: u8 = 1;
const TRAPS: u8 = 2;
const SYSCALL: u8 = 4;

impl Step {
    fn of(i: &Instruction) -> Step {
        let m = i.mnemonic();
        let flow = match i.flow_control() {
            _ if runs_on(i) => NEXT,
            FlowControl::Call => CALL,
            FlowControl::IndirectCall => INDIRECT_CALL,
            FlowControl::ConditionalBranch => BRANCH,
            FlowControl::UnconditionalBranch => JUMP,
            FlowControl::IndirectBranch => INDIRECT_JUMP,
            FlowControl::Return => go::RETURN,
            _ => STOP,
        };
        let target = matches!(i.op0_kind(), OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16).then(|| i.near_branch_target());
        let traps = matches!(m, Mnemonic::Syscall | Mnemonic::Sysenter | Mnemonic::Int | Mnemonic::Int1 | Mnemonic::Int3 | Mnemonic::Into);
        let bits = if target.is_some() { TARGET } else { 0 } | if traps { TRAPS } else { 0 } | if m == Mnemonic::Syscall { SYSCALL } else { 0 };
        Step { target: target.unwrap_or(0), len: i.len() as u8, flow, reads: flags_read(i) as u8, writes: flags_written(i) as u8, bits }
    }
}

/// What a walk keeps while it walks, by each byte's offset from its start: for each byte 1 + the index of the step
/// that starts there (0: none), with LEADER where a block starts. Code past its range goes in `outside` (a few places
/// at most). One is kept from walk to walk, cleared, not freed.
#[derive(Default)]
struct Scratch { base: u64, span: usize, high: usize, at: Vec<u32>, outside: Vec<(u64, u32)>, steps: Vec<Step>, leads: Vec<u64> }

const LEADER: u32 = 1 << 31;

impl Scratch {
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
        if *e & LEADER == 0 { *e |= LEADER; self.leads.push(a); }
    }
    fn decoded(&self, a: u64) -> bool { self.get(a) & !LEADER != 0 }
    fn record(&mut self, a: u64, s: Step) {
        self.steps.push(s);
        let n = self.steps.len() as u32;
        let e = self.entry(a);
        *e = (*e & LEADER) | n;
    }
    fn step(&self, a: u64) -> Step { self.steps[(self.get(a) & !LEADER) as usize - 1] }
}

/// The blocks of the function at `start` within its range (and `extra` places in it pointers name, but not the
/// `inner` starts of others), and the code it calls or goes on to outside: each block from a leader along next_ip
/// (not address order, so a wrong table guess decoding bytes inside an instruction leaves the real blocks as they are).
fn walk(elf: &Elf, (start, end): (u64, u64), extra: &[u64], inner: &[u64], mut references: Option<&mut Vec<u64>>, s: &mut Scratch) -> (Vec<Block>, Vec<u64>) {
    let inside = |a: u64| a >= start && a < end && (a == start || inner.is_empty() || inner.binary_search(&a).is_err());
    // One decoder over the code from the start to its segment's end, moved only where a walk jumps; code elsewhere
    // (a call's continuation past the segment) decoded on its own.
    let code = elf.code_at(start).unwrap_or_default();
    let mut decoder = Decoder::with_ip(64, code, start, DecoderOptions::NONE);
    let mut i = Instruction::default();
    (s.base, s.span) = (start, (end.min(start + code.len() as u64) - start) as usize);
    s.steps.clear();
    s.outside.clear();
    s.leads.clear();
    let mut work: VecDeque<u64> = VecDeque::new();
    let mut first: Vec<u64> = std::iter::once(start).chain(extra.iter().copied().filter(|&a| inside(a))).collect();
    first.sort_unstable();
    first.dedup();
    for a in first { s.lead(a); work.push_back(a); }
    let mut calls = Vec::new();
    let go = |a: u64, s: &mut Scratch, work: &mut VecDeque<u64>, calls: &mut Vec<u64>| if inside(a) { s.lead(a); work.push_back(a); } else { calls.push(a); };
    while let Some(mut at) = work.pop_front() {
        loop {
            // Joining code decoded from another path starts a block.
            if s.decoded(at) { s.lead(at); break; }
            match at.checked_sub(start).filter(|&o| o < code.len() as u64) {
                Some(o) => {
                    if decoder.ip() != at { let _ = decoder.set_position(o as usize); decoder.set_ip(at); }
                    decoder.decode_out(&mut i);
                }
                None => match decode(elf, at) { Some(d) => i = d, None => break },
            }
            if i.is_invalid() { break; }
            let step = Step::of(&i);
            s.record(at, step);
            let next = at + step.len as u64;
            if step.bits & SYSCALL != 0 { s.lead(at); s.lead(next); }
            if let Some(r) = references.as_deref_mut() {
                if i.is_ip_rel_memory_operand() { r.push(i.ip_rel_memory_address()); }
                // Where code is not position-independent, an address in its code given as a number is one too.
                if elf.fixed {
                    for k in 0..i.op_count() {
                        if matches!(i.op_kind(k), OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64) && elf.is_code(i.immediate(k)) { r.push(i.immediate(k)); }
                    }
                }
            }
            match step.flow {
                NEXT if inside(next) => { at = next; continue; }
                NEXT => calls.push(next),
                CALL | INDIRECT_CALL => {
                    if step.bits & TARGET != 0 { calls.push(step.target); }
                    s.lead(next);
                    work.push_back(next);
                }
                BRANCH => { go(step.target, s, &mut work, &mut calls); go(next, s, &mut work, &mut calls); }
                JUMP if step.bits & TARGET != 0 => go(step.target, s, &mut work, &mut calls),
                _ => {}
            }
            break;
        }
    }
    let mut order = std::mem::take(&mut s.leads);
    order.sort_unstable();
    order.retain(|&a| s.decoded(a));
    let mut blocks = Vec::with_capacity(order.len());
    for &b in &order {
        let (mut at, mut reads, mut writes, mut traps, mut count) = (b, 0u8, 0u8, false, 0u32);
        let (exit, last) = loop {
            let step = s.step(at);
            reads |= step.reads & !writes;
            writes |= step.writes;
            traps |= step.bits & TRAPS != 0;
            count += 1;
            let next = at + step.len as u64;
            let t = step.target;
            let exit = match step.flow {
                CALL if step.bits & TARGET != 0 => Exit::Call { target: t, ret: next },
                CALL | INDIRECT_CALL => Exit::IndirectCall { ret: next },
                BRANCH => Exit::Branch { taken: t, fall: next },
                JUMP => if inside(t) { Exit::Jump(t) } else { Exit::TailJump(t) },
                INDIRECT_JUMP => Exit::IndirectJump,
                go::RETURN => Exit::Return,
                // Running into the next function is a tail call to it.
                NEXT if !s.decoded(next) => if inside(next) { Exit::Trap } else { Exit::TailJump(next) },
                NEXT if s.get(next) & LEADER != 0 => Exit::Fall(next),
                NEXT => { at = next; continue; }
                _ => Exit::Trap,
            };
            break (exit, step);
        };
        let len = (at + last.len as u64 - b) as u32;
        blocks.push(Block { start: b, len, count, reads, writes, last: last.len, resumes: last.bits & SYSCALL != 0, traps, exit });
    }
    s.leads = order;
    s.at[..s.high].fill(0);
    s.high = 0;
    (blocks, calls)
}

/// Whether `i` goes on to the next instruction as translation sees it (a system call returns in place; int3 traps).
fn runs_on(i: &Instruction) -> bool {
    let m = i.mnemonic();
    m == Mnemonic::Syscall || (matches!(i.flow_control(), FlowControl::Next | FlowControl::Interrupt) && m != Mnemonic::Int3)
}

fn decode(elf: &Elf, address: u64) -> Option<Instruction> {
    let bytes = elf.code_at(address)?;
    let i = Decoder::with_ip(64, &bytes[..bytes.len().min(15)], address, DecoderOptions::NONE).decode();
    (!i.is_invalid()).then_some(i)
}

/// Where a function's blocks jump or run on to outside it (its tail jumps, branches out of it): not its calls.
fn continuations(blocks: &[Block]) -> Vec<u64> {
    let own = |a: &u64| blocks.binary_search_by_key(a, |b| b.start).is_ok();
    let mut out = Vec::new();
    for b in blocks {
        match b.exit {
            Exit::TailJump(t) => out.push(t),
            Exit::Branch { taken, fall } => out.extend([taken, fall].into_iter().filter(|a| !own(a))),
            Exit::Fall(t) | Exit::Jump(t) if !own(&t) => out.push(t),
            _ => {}
        }
    }
    out
}

/// Targets of position-relative jump tables: each slot holds `target - base`, the base the table's start that code
/// addresses with a rip-relative `lea`; a slot belongs to the nearest base at or below it, and runs of consecutive
/// slots start a table too.
fn relative_table_targets(elf: &Elf, references: &[u64]) -> Vec<u64> {
    let mut bases: BTreeSet<u64> = references.iter().copied().filter(|&a| !elf.is_code(a)).collect();
    let mut previous = None;
    for &p in &elf.relative_slots {
        if previous != Some(p.wrapping_sub(4)) { bases.insert(p); }
        previous = Some(p);
    }
    let mut out: Vec<u64> = elf.relative_slots.iter().filter_map(|&p| {
        let base = *bases.range(..=p).next_back()?;
        Some(base.wrapping_add(elf.read_i32(p)? as i64 as u64)).filter(|&t| elf.is_code(t))
    }).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The most entries a table is read for when what bounds it is not found.
const TABLE_ENTRIES: u64 = 4096;

/// The cases of the switches in `blocks` (a function's, in `start..end`) that jump through a table, found from the
/// code that reads it, for a program whose relocations do not say where its tables are:
///
/// ```text
/// cmp I, N; ja default                  the bound, in a block before
/// lea B, [rip + table]                  (or once in the function, for every switch of a loop)
/// movsxd T, dword [B + I*4]; add T, B; jmp T
/// ```
///
/// or absolute (`jmp [table + I*8]`, or `mov T, [table + I*8]; jmp T`). N + 1 entries; where the bound is not found,
/// those that land in the function, at most TABLE_ENTRIES.
fn switch_targets(elf: &Elf, blocks: &[Block], start: u64, end: u64) -> Vec<u64> {
    let mut out = Vec::new();
    for b in blocks.iter().filter(|b| b.exit == Exit::IndirectJump) {
        let Some((table, (index, base), relative)) = table_read(&b.instructions(elf)) else { continue };
        let Some(table) = table.or_else(|| only_lea(elf, blocks, base)) else { continue };
        let bound = bound_of(elf, blocks, b.start, index);
        for k in 0..bound.unwrap_or(TABLE_ENTRIES) {
            let target = if relative { elf.read_i32(table + 4 * k).map(|e| table.wrapping_add(e as i64 as u64)) } else { elf.read_u64(table + 8 * k) };
            let Some(t) = target.filter(|&t| elf.is_code(t) && (bound.is_some() || (t >= start && t < end))) else { break };
            out.push(t);
        }
    }
    out
}

/// The table a block ending in an indirect jump reads: its address (None: in the register given with the index, put
/// there before this block), the register that indexes it and the one that holds it, and whether it is relative.
fn table_read(code: &[Instruction]) -> Option<(Option<u64>, (Register, Register), bool)> {
    let (jmp, before) = code.split_last()?;
    if jmp.mnemonic() != Mnemonic::Jmp { return None; }
    let entry = |i: &Instruction, scale: u32| (i.memory_index() != Register::None && i.memory_index_scale() == scale).then(|| i.memory_index());
    if jmp.op0_kind() == OpKind::Memory && jmp.memory_base() == Register::None {
        return Some((Some(jmp.memory_displacement64()), (entry(jmp, 8)?, Register::None), false));
    }
    if jmp.op0_kind() != OpKind::Register { return None; }
    let target = jmp.op0_register();
    let last = |p: &dyn Fn(&Instruction) -> bool, within: &[Instruction]| within.iter().rposition(p);
    if let Some(k) = last(&|i| i.mnemonic() == Mnemonic::Mov && i.op0_register() == target && i.op1_kind() == OpKind::Memory, before) {
        let i = &before[k];
        if i.memory_base() == Register::None { return Some((Some(i.memory_displacement64()), (entry(i, 8)?, Register::None), false)); }
    }
    let a = last(&|i| i.mnemonic() == Mnemonic::Add && i.op0_register() == target && i.op1_kind() == OpKind::Register, before)?;
    let base = before[a].op1_register();
    let m = last(&|i| i.mnemonic() == Mnemonic::Movsxd && i.op0_register() == target && i.op1_kind() == OpKind::Memory
        && i.memory_base() == base && i.memory_displacement64() == 0, &before[..a])?;
    let index = entry(&before[m], 4)?;
    match last(&|i| i.op0_kind() == OpKind::Register && i.op0_register() == base, &before[..m]).map(|l| &before[l]) {
        Some(i) if i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() => Some((Some(i.ip_rel_memory_address()), (index, base), true)),
        Some(_) => None,
        None => Some((None, (index, base), true)),
    }
}

/// The constant `register` holds where the function puts it in one place only (`lea register, [rip + constant]`) and
/// writes it nowhere else (push and pop of the caller's value aside).
fn only_lea(elf: &Elf, blocks: &[Block], register: Register) -> Option<u64> {
    let writes_it = |i: &Instruction| i.op0_kind() == OpKind::Register && i.op0_register().full_register() == register.full_register()
        && !matches!(i.mnemonic(), Mnemonic::Push | Mnemonic::Pop | Mnemonic::Cmp | Mnemonic::Test);
    let mut writes = blocks.iter().flat_map(|b| b.instructions(elf)).filter(writes_it);
    let i = writes.next()?;
    (writes.next().is_none() && i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() && i.op0_register() == register).then(|| i.ip_rel_memory_address())
}

/// How many entries the table read at block `at` has, from `cmp I, N` then `ja` past it or `jbe` to it in a block
/// that goes on to `at`.
fn bound_of(elf: &Elf, blocks: &[Block], at: u64, index: Register) -> Option<u64> {
    blocks.iter().find_map(|p| {
        let Exit::Branch { taken, fall } = p.exit else { return None };
        if taken != at && fall != at { return None; }
        let code = p.instructions(elf);
        let [.., cmp, jcc] = code.as_slice() else { return None };
        let to_table = (jcc.mnemonic() == Mnemonic::Ja && fall == at) || (jcc.mnemonic() == Mnemonic::Jbe && taken == at);
        let same = cmp.op0_kind() == OpKind::Register && cmp.op0_register().full_register() == index.full_register();
        let n = matches!(cmp.op1_kind(), OpKind::Immediate8 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32 | OpKind::Immediate32to64).then(|| cmp.immediate(1));
        (to_table && cmp.mnemonic() == Mnemonic::Cmp && same).then_some(n?).filter(|&n| n < TABLE_ENTRIES).map(|n| n + 1)
    })
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
/// sooner than where it breaks no loop of up to KEEP blocks (the first keeps its name; the others are `name.2`...).
fn runs(start: u64, name: String, blocks: Vec<Block>) -> Vec<Function> {
    let exact = RUN_BLOCKS.with(|r| r.get());
    let run = exact.unwrap_or(RUN);
    if blocks.len() <= run { return vec![Function::new(start, name, blocks)]; }
    // A cut before block p breaks each loop with head < p <= last (a walk's blocks are in address order).
    let mut breaks = vec![false; blocks.len()];
    if exact.is_none() {
        let at = |a: u64| blocks.binary_search_by_key(&a, |b| b.start).ok();
        for lp in loops_of(&blocks, at).0.into_iter().filter(|lp| lp.last - lp.head < KEEP) { breaks[lp.head + 1..=lp.last].fill(true); }
    }
    let mut out: Vec<Function> = Vec::with_capacity(blocks.len().div_ceil(run));
    let mut held: Vec<Block> = Vec::with_capacity(run);
    let named = |out: &Vec<Function>| if out.is_empty() { name.clone() } else { format!("{name}.{}", out.len() + 1) };
    for (p, b) in blocks.into_iter().enumerate() {
        if held.len() >= run + KEEP * exact.is_none() as usize || (held.len() >= run && !breaks[p]) {
            let n = named(&out);
            out.push(Function::new(held[0].start, n, std::mem::take(&mut held)));
        }
        held.push(b);
    }
    let n = named(&out);
    out.push(Function::new(held[0].start, n, held));
    out
}

/// Where a run of a function cut into `runs` (the program's from `first`) goes on in another: an entry of that run.
fn joined(runs: &[Function], first: usize, marks: &mut Vec<(u64, (u32, u32))>) {
    if runs.len() < 2 { return; }
    let holder = |a: u64| runs.iter().enumerate().find_map(|(r, f)| f.block_index(a).map(|b| (r, b)));
    for f in runs {
        for a in f.blocks.iter().flat_map(|b| goes_to(b).into_iter().flatten()) {
            if f.block_index(a).is_none() { if let Some((r, k)) = holder(a) { marks.push((a, ((first + r) as u32, k as u32))); } }
        }
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
const NO: u32 = u32::MAX;

/// As `loops_of`, from each block's successors, into `loops`, with `last` and `open` for scratch.
fn loops_into(succ: &[[u32; 2]], loops: &mut Vec<Loop>, (last, open): (&mut Vec<usize>, &mut Vec<usize>)) {
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
fn within_of(loops: &[Loop], n: usize, within: &mut Vec<Option<usize>>) {
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

// ---- Facts ----

/// Flag liveness over the whole program in flat arrays, every function's blocks in turn (function f's from
/// `first[f]`): the flags each block reads before writing and writes, where it goes (a block of its own function, an
/// entry of another's, or other code, handed every flag), and the flags live into it. A compare can end one function
/// and the jump that reads it begin another (the post-link compiler merges equal tails): such an entry is handed what
/// it reads, in G_FLAGS. Each entry starts reading nothing and grows to what its code reads (the least fixed point),
/// a function solved again only when an entry it goes to grew.
pub struct Liveness {
    entries: Vec<u64>,
    /// What each entry reads first, each function's blocks' first, uses, defs, successors and fixed outs.
    reads: Vec<u8>,
    first: Vec<u32>,
    used: Vec<u8>,
    defined: Vec<u8>,
    to: Vec<[u32; 2]>,
    fixed: Vec<u8>,
    /// The entry a block is (or NONE), the flags live into it, and what each function's entries read.
    entry: Vec<u32>,
    live: Vec<u8>,
    cases: Vec<u8>,
}

const NONE: u32 = u32::MAX;
const ENTRY: u32 = 1 << 31;
/// A block ending in an indirect jump keeps what its function's entries read (it may land on any).
const INDIRECT: u8 = 0x80;

impl Liveness {
    pub fn new(program: &Program) -> Liveness {
        let entries: Vec<u64> = program.entries.keys().copied().collect();
        let blocks: usize = program.functions.iter().map(|f| f.blocks.len()).sum();
        let mut l = Liveness {
            reads: vec![0; entries.len()], first: Vec::with_capacity(program.functions.len() + 1), used: Vec::with_capacity(blocks),
            defined: Vec::with_capacity(blocks), to: Vec::with_capacity(blocks), fixed: Vec::with_capacity(blocks),
            entry: vec![NONE; blocks], live: vec![0; blocks], cases: vec![0; program.functions.len()], entries,
        };
        for f in &program.functions {
            l.first.push(l.used.len() as u32);
            for (b, at) in f.blocks.iter().zip(&f.succ) {
                let (mut to, mut fixed) = ([NONE; 2], if b.exit == Exit::IndirectJump { INDIRECT } else { 0 });
                let mut add = |a: u64, k: u32| {
                    let t = if k != NO { k } else {
                        match l.entries.binary_search(&a) { Ok(e) => e as u32 | ENTRY, Err(_) => { fixed |= ALL_FLAGS as u8; return; } }
                    };
                    to[(to[0] != NONE) as usize] = t;
                };
                match b.exit {
                    Exit::Fall(a) | Exit::Jump(a) => add(a, at[0]),
                    Exit::TailJump(a) => add(a, NO),
                    Exit::Branch { taken, fall } => { add(taken, at[0]); add(fall, at[1]); }
                    _ => {}
                }
                l.used.push(b.reads);
                l.defined.push(b.writes);
                l.to.push(to);
                l.fixed.push(fixed);
            }
        }
        l.first.push(l.used.len() as u32);
        for (e, &(f, b)) in program.entries.values().enumerate() { l.entry[(l.first[f as usize] + b) as usize] = e as u32; }
        // The functions that go to each entry (packed), and each function once at first.
        let mut count = vec![0u32; l.entries.len() + 1];
        l.each_going(|e, _| count[e + 1] += 1);
        for e in 0..l.entries.len() { count[e + 1] += count[e]; }
        let mut by = vec![0u32; count[l.entries.len()] as usize];
        let mut at = count.clone();
        l.each_going(|e, f| { by[at[e] as usize] = f; at[e] += 1; });
        let mut queued = vec![true; program.functions.len()];
        let mut work: VecDeque<u32> = (0..program.functions.len() as u32).collect();
        while let Some(f) = work.pop_front() {
            queued[f as usize] = false;
            l.solve(f as usize);
            for g in l.first[f as usize] as usize..l.first[f as usize + 1] as usize {
                let e = l.entry[g];
                if e == NONE || l.reads[e as usize] == l.live[g] { continue; }
                l.reads[e as usize] = l.live[g];
                for &d in &by[count[e as usize] as usize..count[e as usize + 1] as usize] {
                    if !queued[d as usize] { queued[d as usize] = true; work.push_back(d); }
                }
            }
        }
        l
    }
    fn each_going(&self, mut on: impl FnMut(usize, u32)) {
        for f in 0..self.cases.len() {
            for t in self.to[self.first[f] as usize..self.first[f + 1] as usize].iter().flatten() {
                if *t != NONE && t & ENTRY != 0 { on((t & !ENTRY) as usize, f as u32); }
            }
        }
    }
    /// The flags live into each block of function `f`, from nothing, as its entries now read.
    fn solve(&mut self, f: usize) {
        let (lo, hi) = (self.first[f] as usize, self.first[f + 1] as usize);
        self.live[lo..hi].fill(0);
        let mut cases = 0;
        loop {
            let mut changed = false;
            for g in (lo..hi).rev() {
                let (held, ext) = self.out(lo, g, cases);
                let new = self.used[g] | ((held | ext) & !self.defined[g]);
                if new != self.live[g] {
                    self.live[g] = new;
                    if self.entry[g] != NONE { cases |= new; }
                    changed = true;
                }
            }
            if !changed { break; }
        }
        self.cases[f] = cases;
    }
    /// The flags live out of block `g` (its function's from `lo`): into its own function's blocks, and handed out.
    fn out(&self, lo: usize, g: usize, cases: u8) -> (u8, u8) {
        let mut held = if self.fixed[g] & INDIRECT != 0 { cases } else { 0 };
        let mut ext = self.fixed[g] & !INDIRECT;
        for &t in &self.to[g] {
            if t == NONE { continue; }
            if t & ENTRY != 0 { ext |= self.reads[(t & !ENTRY) as usize]; } else { held |= self.live[lo + t as usize]; }
        }
        (held, ext)
    }
    fn live_out(&self, f: u32, k: usize) -> (u32, u32) {
        let lo = self.first[f as usize] as usize;
        let (held, ext) = self.out(lo, lo + k, self.cases[f as usize]);
        (held as u32, ext as u32)
    }
    /// The flags code going to `address`, outside its function, hands over: what that entry reads, or all.
    pub fn handed(&self, address: u64) -> u32 { self.entries.binary_search(&address).map_or(ALL_FLAGS, |e| self.reads[e] as u32) }
    fn is_entry(&self, f: u32, k: usize) -> bool { self.entry[self.first[f as usize] as usize + k] != NONE }
}

/// What a function may do to the registers as a call sees it: bit n for r_n, 16 + n for xmm_n (as Fx::used). A call
/// moves registers through their globals; knowing what the callee may read and write, a caller stores only those and
/// takes back only what it may write, the rest staying in its locals across the call. That holds only while nothing
/// between the call and its return looks at the globals as a whole (the kernel, at a system call, a time slice's end,
/// code not translated yet, a trap): a callee that may go out to it (`exits`) is called as any call is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary { pub reads: u32, pub writes: u32, pub exits: bool }

/// The longest chain of calls made without counting their depth: one longer goes out, so the host's stack is never
/// more than this many frames past what DEPTH_LIMIT allows.
const QUIET_CHAIN: u32 = 16;

/// The bit of a register a summary keeps (a vector register by its own number: iced's full register of an xmm is its
/// zmm).
fn bit(r: Register) -> Option<u32> {
    let n = r as u32;
    for first in [Register::XMM0, Register::YMM0, Register::ZMM0] {
        let first = first as u32;
        if (first..first + 16).contains(&n) { return Some(16 + n - first); }
    }
    let full = r.full_register() as u32;
    (Register::RAX as u32..=Register::R15 as u32).contains(&full).then(|| full - Register::RAX as u32)
}

/// Every function's summary, in the program's order: what it itself may do, where it does not go out (decoded again
/// only there), then its callees' taken on, callees first (Kahn's order: what is never taken is on a cycle of calls).
pub fn summarize(elf: &Elf, program: &Program) -> Vec<Summary> {
    let n = program.functions.len();
    let mut starts: Vec<(u64, usize)> = program.functions.iter().enumerate().map(|(k, f)| (f.start, k)).collect();
    starts.sort_unstable();
    let (mut info, mut code) = (InstructionInfoFactory::new(), Vec::new());
    let rsp = 1 << (Register::RSP as u32 - Register::RAX as u32);
    let (mut summaries, callees): (Vec<Summary>, Vec<Vec<usize>>) = program.functions.iter().map(|f| {
        let mut s = Summary { reads: rsp, writes: rsp, exits: has_loop(f) };
        let mut callees = Vec::new();
        for (b, to) in f.blocks.iter().zip(&f.succ) {
            s.exits |= b.traps || match b.exit {
                Exit::Call { target, .. } => match starts.binary_search_by_key(&target, |&(a, _)| a) { Ok(k) => { callees.push(starts[k].1); false } Err(_) => true },
                Exit::Fall(_) | Exit::Jump(_) => to[0] == NO,
                Exit::Branch { .. } => to[0] == NO || to[1] == NO,
                Exit::TailJump(_) | Exit::IndirectJump | Exit::IndirectCall { .. } | Exit::Trap => true,
                Exit::Return => false,
            };
        }
        if s.exits { return (s, callees); }
        let mut at = Code::new(elf, f.span().map_or(f.start, |(lo, _)| lo));
        for b in &f.blocks {
            at.decode(elf, b, &mut code);
            for u in code.iter().flat_map(|i| info.info(i).used_registers().to_vec()) {
                let Some(k) = bit(u.register()) else { continue };
                // A write that keeps any of what was there reads it too (an 8- or 16-bit register's, an xmm's, a
                // conditional one's).
                let keeps = k >= 16 || u.register().size() < 4;
                match u.access() {
                    OpAccess::Read | OpAccess::CondRead => s.reads |= 1 << k,
                    OpAccess::Write if !keeps => s.writes |= 1 << k,
                    OpAccess::Write | OpAccess::CondWrite | OpAccess::ReadWrite | OpAccess::ReadCondWrite => { s.reads |= 1 << k; s.writes |= 1 << k; }
                    _ => {}
                }
            }
        }
        (s, callees)
    }).unzip();
    let mut waiting: Vec<usize> = callees.iter().map(|c| c.len()).collect();
    let mut callers: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, c) in callees.iter().enumerate() { for &g in c { callers[g].push(k); } }
    let mut ready: Vec<usize> = (0..n).filter(|&k| waiting[k] == 0).collect();
    let (mut taken, mut height) = (vec![false; n], vec![0u32; n]);
    while let Some(k) = ready.pop() {
        taken[k] = true;
        for &g in &callees[k] {
            let c = summaries[g];
            let s = &mut summaries[k];
            (s.reads, s.writes, s.exits) = (s.reads | c.reads, s.writes | c.writes, s.exits | c.exits);
            height[k] = height[k].max(height[g] + 1);
        }
        if height[k] > QUIET_CHAIN { summaries[k].exits = true; }
        for &c in &callers[k] { waiting[c] -= 1; if waiting[c] == 0 { ready.push(c); } }
    }
    for k in 0..n { if !taken[k] { summaries[k].exits = true; } }
    summaries
}

/// Whether `function` goes backward anywhere (a loop's head), within it or out to an address before a block's (a run
/// of the same function).
pub fn has_loop(function: &Function) -> bool {
    function.blocks.iter().zip(&function.succ).enumerate().any(|(k, (b, to))| {
        goes_to(b).into_iter().zip(to).any(|(a, &t)| if t != NO { t as usize <= k } else { a.is_some_and(|a| a <= b.start) })
    })
}

// ---- Frame ----

/// Imported functions (the host's, then in a module made later the first module's helpers), and where the guest's
/// functions start.
pub const F_SYSCALL: u32 = 0;
pub const F_TRAP: u32 = 1;
pub const F_DIV128: u32 = 2;
pub const F_CLOCK: u32 = 3;
pub const F_FPU: u32 = 4;
pub const F_TRACE: u32 = 5;
/// The host's answer for code not translated yet: the entry (function << 32 | block), or -1.
pub const F_MISS: u32 = 6;
/// A wall or steady clock's time in ms, as the host's kernel keeps it; NaN for any other clock.
pub const F_TIME: u32 = 7;
pub const F_MULHU: u32 = 8;
pub const F_MULHS: u32 = 9;
pub const F_RESOLVE: u32 = 10;
pub const F_DISPATCH: u32 = 11;
pub const FIRST_GUEST: u32 = 13;

/// Globals every module of a program shares: r0..r15, fs, x0..x15, then these.
pub const G_FS: u32 = 16;
pub const fn g_xmm(n: u32) -> u32 { 17 + n }
/// CF, ZF, SF, OF and PF as bits 0..4: what an entry that reads flags first is handed.
pub const G_FLAGS: u32 = 33;
/// Loops gone round and calls made before the thread goes back to the kernel (its time slice).
pub const G_BUDGET: u32 = 34;
/// Calls the thread is inside, in wasm frames: past DEPTH_LIMIT a call starts afresh from the kernel.
pub const G_DEPTH: u32 = 35;
pub const DEPTH_LIMIT: i32 = 400;
/// The least rsp has been (how deep the thread's stack has gone).
pub const G_LOW: u32 = 36;
/// The thread's x87 registers: their handle in the coprocessor (x87.rs).
pub const G_X87: u32 = 37;
pub const GLOBALS: u32 = 38;
/// A word below where anything may be mapped: nonzero when the kernel wants the thread to look in (a signal, another
/// thread's turn), read at each loop's head.
pub const INTERRUPT: u32 = 0x100;

/// Trap codes reported to the host with the guest address.
pub const TRAP_UNMAPPED_TARGET: i32 = 1;
pub const TRAP_UNDECODED: i32 = 2;
pub const TRAP_UNSUPPORTED: i32 = 3;
/// Not faults: the time slice is up (at a loop's head, the address named), or the calls are deep enough that the next
/// starts from the kernel. Registers and the flags the target reads are in globals.
pub const TRAP_YIELD: i32 = 5;
pub const TRAP_UNWIND: i32 = 6;
/// What the program itself traps with: ud2 (SIGILL), int3 (SIGTRAP), hlt (SIGSEGV).
pub const TRAP_UD2: i32 = 7;
pub const TRAP_INT3: i32 = 8;
pub const TRAP_HLT: i32 = 9;

// Locals: the parameter, r0..r15, the block, the flags held, the deferred operands, scratch, xmm, v128 and f64
// scratch, then these.
pub const L_ENTRY: u32 = 0;
pub const fn l_reg(n: u32) -> u32 { 1 + n }
pub const L_BLK: u32 = 17;
pub const L_CF: u32 = 18;
pub const L_ZF: u32 = 19;
pub const L_SF: u32 = 20;
pub const L_OF: u32 = 21;
pub const L_PF: u32 = 22;
pub const L_FA: u32 = 23;
pub const L_FB: u32 = 24;
pub const L_FR: u32 = 25;
pub const fn l_t(k: u32) -> u32 { 26 + k }
pub const fn l_u(k: u32) -> u32 { 32 + k }
pub const fn l_x(n: u32) -> u32 { 34 + n }
pub const fn l_v(k: u32) -> u32 { 50 + k }
pub const fn l_d(k: u32) -> u32 { 52 + k }
/// The stack pointer the function was entered with at its start (all ones elsewhere): an indirect jump leaving rsp
/// above it goes to a frame further out (a longjmp), handed up.
const L_SP0: u32 = 54;
/// The budget, counted down in a local while a function with a loop runs, moved with the registers.
const L_BUDGET: u32 = 55;
/// Where a loop entered past its head goes on: that block + 1, read at each loop's head, 0 once there.
const L_INTO: u32 = 56;
const LOCALS: usize = 57;
const RSP: u32 = 4;

/// Each local's type (a function declares only those it touches: V8's first tier zeroes them at every entry).
const fn kind(l: u32) -> u8 {
    match l {
        L_BLK | L_CF..=L_PF | L_BUDGET | L_INTO => I32,
        _ if l >= l_u(0) && l < l_x(0) => I32,
        _ if l >= l_x(0) && l < l_d(0) => V128,
        _ if l >= l_d(0) && l < L_SP0 => F64,
        _ => I64,
    }
}
const I32: u8 = 0x7f;
const I64: u8 = 0x7e;
const F64: u8 = 0x7c;
const V128: u8 = 0x7b;

/// A sync's scope when it may move any register.
pub const ALL: u32 = u32::MAX;

/// A label open in a function's code: the end of a block's (a jump forward to it), or a loop's (its head).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lab { Block(usize), Loop(usize) }

/// A register read or written (as Fx::used; a write's `true` where it surely happens, not inside a conditional), a
/// sync (its index, `true` where not inside a conditional), or a place the code may go on to this function's blocks.
#[derive(Clone, Copy)]
enum Ev { Read(u8), Write(u8, bool), Sync(u32, bool), Edge }

/// What every function's lowering reads.
#[derive(Clone, Copy)]
pub struct Lowering<'p> {
    pub elf: &'p Elf,
    pub program: &'p Program,
    pub handed: &'p Liveness,
    pub summaries: &'p [Summary],
    pub trace: bool,
}

/// A function as it is made: its code (locals and syncs put in at the end), what it noted, and where it is.
pub struct Fx<'p> {
    pub f: Vec<u8>,
    /// Where it syncs registers with their globals (byte offset, save, the registers it may move at most).
    syncs: Vec<(usize, bool, u32)>,
    /// The registers it touches (bit n for r_n, 16 + n for xmm_n), and what each part noted: [0] the prologue,
    /// [k + 1] block k, part k's from `ev_at[k]`.
    used: u32,
    ev: Vec<Ev>,
    ev_at: Vec<usize>,
    /// Nesting of wasm blocks in the current block's code (a write inside one may not happen), and between the code
    /// and the dispatch loop.
    nest: u32,
    pub depth: u32,
    /// Each local's number in the function (0: not touched yet), numbered as first touched, and their types.
    slots: [u32; LOCALS],
    kinds: Vec<u8>,
    /// What ops keeps across instructions (ops.rs).
    pub flags: Flags,
    pub fr_pending: bool,
    pub fused: Option<Instruction>,
    pub rsp_up: bool,
    pub backward: bool,
    entry: Vec<bool>,
    /// Each block's successors within, by index (NO: none).
    succ: &'p [[u32; 2]],
    /// Whether there is a dispatch loop (a lean function has none).
    dispatch: bool,
    pub program: &'p Program,
    function: &'p Function,
    pub report: &'p mut Report,
    pub handed: &'p Liveness,
    /// The block being lowered; whether its budget is counted in L_BUDGET; what each function may do (summaries).
    at: usize,
    budget: bool,
    summaries: &'p [Summary],
    /// Its loops made wasm loops, the innermost each block lies within past its head, the loop each block heads,
    /// the labels open (outermost first), and where each block's and loop's label is among them while open.
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
}

/// A LEB128, unsigned and signed.
pub fn uleb(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 { out.push(v as u8 | 0x80); v >>= 7; }
    out.push(v as u8);
}
pub fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) { out.push(b); return; }
        out.push(b | 0x80);
    }
}

/// An access to memory 0: its operator, alignment and offset.
pub struct Mem(pub Op, pub u32, pub u64);
/// An operator with its lane.
pub const fn lane_op(o: Op, lane: u8) -> Op { Op(o.0 | (lane as u32) << (8 * o.1 as u32), o.1 + 1) }
/// What Fx::e writes: an operator, or an access to memory.
pub trait Emit { fn emit(self, fx: &mut Fx); }
impl Emit for Op { fn emit(self, fx: &mut Fx) { fx.op(self) } }
impl Emit for Mem { fn emit(self, fx: &mut Fx) { fx.mem(self.0, self.1, self.2) } }

/// The bit (as Fx::used) of each local that holds a register, or NOT_REG.
const NOT_REG: u8 = u8::MAX;
const REG_BIT: [u8; LOCALS] = {
    let mut t = [NOT_REG; LOCALS];
    let mut k = 0;
    while k < 16 { t[l_reg(k) as usize] = k as u8; t[l_x(k) as usize] = 16 + k as u8; k += 1; }
    t
};

impl Fx<'_> {
    // ---- Emit ----
    pub fn op(&mut self, o: Op) {
        if o.1 == 1 { self.f.push(o.0 as u8) } else { self.f.extend_from_slice(&o.0.to_le_bytes()[..o.1 as usize]) }
    }
    fn imm(&mut self, o: Op, v: u32) { self.op(o); uleb(&mut self.f, v as u64); }
    pub fn c32(&mut self, v: i32) { self.konst(0x41, v as i64) }
    pub fn c64(&mut self, v: i64) { self.konst(0x42, v) }
    fn konst(&mut self, opcode: u8, v: i64) {
        if (-64..64).contains(&v) { self.f.extend_from_slice(&[opcode, v as u8 & 0x7f]) } else { self.f.push(opcode); sleb(&mut self.f, v) }
    }
    pub fn f64c(&mut self, v: f64) { self.f.push(0x44); self.f.extend_from_slice(&v.to_le_bytes()); }
    pub fn v128c(&mut self, v: i128) { self.f.extend_from_slice(&[0xfd, 0x0c]); self.f.extend_from_slice(&v.to_le_bytes()); }
    pub fn shuffle(&mut self, lanes: [u8; 16]) { self.f.extend_from_slice(&[0xfd, 0x0d]); self.f.extend_from_slice(&lanes); }
    /// A load or store (its opcode) of memory 0 at `offset` past the address, aligned to 2^align.
    pub fn mem(&mut self, o: Op, align: u32, offset: u64) { self.op(o); uleb(&mut self.f, align as u64); uleb(&mut self.f, offset); }
    pub fn e(&mut self, x: impl Emit) { x.emit(self) }
    pub fn gget(&mut self, g: u32) { self.imm(Op(0x23, 1), g) }
    pub fn gset(&mut self, g: u32) { self.imm(Op(0x24, 1), g) }
    pub fn call(&mut self, f: u32) { self.imm(Op(0x10, 1), f) }
    pub fn return_call(&mut self, f: u32) { self.imm(Op(0x12, 1), f) }
    pub fn br(&mut self, d: u32) { self.imm(Op(0x0c, 1), d) }
    pub fn br_if(&mut self, d: u32) { self.imm(Op(0x0d, 1), d) }
    pub fn br_table(&mut self, targets: &[u32], default: u32) {
        self.imm(Op(0x0e, 1), targets.len() as u32);
        for &t in targets { uleb(&mut self.f, t as u64); }
        uleb(&mut self.f, default as u64);
    }
    pub fn block(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x02, 0x40]); }
    pub fn loop_(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x03, 0x40]); }
    pub fn if_(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x04, 0x40]); }
    pub fn if_v128(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x04, V128]); }
    pub fn else_(&mut self) { self.f.push(0x05); }
    pub fn end(&mut self) { self.nest = self.nest.saturating_sub(1); self.f.push(0x0b); }
    /// A local as the function numbers it: numbered as it is first touched.
    fn slot(&mut self, l: u32) -> u32 {
        let s = &mut self.slots[l as usize];
        if l != L_ENTRY && *s == 0 { self.kinds.push(kind(l)); *s = self.kinds.len() as u32; }
        *s
    }
    /// A local moved, and the register it holds noted.
    fn local(&mut self, opcode: u8, l: u32) {
        let b = REG_BIT[l as usize];
        if b != NOT_REG {
            self.used |= 1 << b;
            self.ev.push(if opcode == 0x20 { Ev::Read(b) } else { Ev::Write(b, self.nest == 0) });
        }
        let s = self.slot(l);
        if s < 0x80 { self.f.extend_from_slice(&[opcode, s as u8]) } else { self.f.push(opcode); uleb(&mut self.f, s as u64) }
    }
    pub fn get(&mut self, l: u32) { self.local(0x20, l) }
    pub fn set(&mut self, l: u32) { self.local(0x21, l) }
    pub fn tee(&mut self, l: u32) { self.local(0x22, l) }
    /// A local moved with nothing noted.
    fn raw(&mut self, opcode: u8, l: u32) { let s = self.slot(l); self.f.push(opcode); uleb(&mut self.f, s as u64); }
    pub fn get_raw(&mut self, l: u32) { self.raw(0x20, l) }
    pub fn set_raw(&mut self, l: u32) { self.raw(0x21, l) }
    pub fn tee_raw(&mut self, l: u32) { self.raw(0x22, l) }

    // ---- Registers and their globals ----
    pub fn save(&mut self) { self.sync_in(true, ALL); }
    pub fn load(&mut self) { self.sync_in(false, ALL); }
    /// A sync (put in by `finish`, once the whole function says what it moves) that moves at most `scope`.
    fn sync_in(&mut self, save: bool, scope: u32) {
        self.syncs.push((self.f.len(), save, scope));
        self.ev.push(Ev::Sync(self.syncs.len() as u32 - 1, self.nest == 0));
    }

    // ---- Labels ----
    fn open(&mut self, l: Lab) {
        let at = Some(self.labels.len() as u32);
        match l { Lab::Block(b) => self.block_at[b] = at, Lab::Loop(i) => self.loop_at[i] = at }
        self.labels.push(l);
    }
    fn close(&mut self, l: Lab) {
        debug_assert_eq!(self.labels.last(), Some(&l), "labels closed out of order");
        self.labels.pop();
        match l { Lab::Block(b) => self.block_at[b] = None, Lab::Loop(i) => self.loop_at[i] = None }
    }
    /// The depth of a br from here to the label at `at` among those open.
    fn to(&self, at: u32) -> u32 { self.depth - 1 - at }
    /// The depth of a br to `address` when it is a block after this one whose label is open.
    fn forward(&self, target: u32) -> Option<u32> {
        let b = (target != NO && target as usize > self.at).then_some(target as usize)?;
        self.block_at[b].map(|at| self.to(at))
    }

    /// Into loop `l` at its head: its label and those of the blocks directly within it. Entered past its head (only
    /// ever from the dispatch: a call's continuation, a loop within, after the thread went to the kernel there), on to
    /// that block, or the head of the loop within this one that holds it, which sends it on in turn: a local tested
    /// every round, the rest only then.
    fn enter_loop(&mut self, l: usize) {
        let Loop { head, last, .. } = self.loops[l];
        self.loop_();
        self.open(Lab::Loop(l));
        let mine: Vec<usize> = (head + 1..=last).rev().filter(|&b| self.within[b] == Some(l)).collect();
        for b in mine { self.block(); self.open(Lab::Block(b)); }
        if !(head + 1..=last).any(|b| self.entry[b]) { return; }
        self.depth = self.labels.len() as u32;
        // Ok(its label) within this loop itself, Err(the label of the head of the loop within this one that holds it).
        let route: Vec<Result<u32, u32>> = (head + 1..=last).map(|b| {
            let (mut w, mut t) = (self.within[b], b);
            while let Some(c) = w { if c == l { break; } t = self.loops[c].head; w = self.loops[c].parent; }
            let at = self.block_at[t].unwrap_or_default();
            if t == b { Ok(at) } else { Err(at) }
        }).collect();
        self.get(L_INTO);
        self.if_();
        self.block();
        let outer: Vec<u32> = route.iter().map(|r| match *r { Ok(_) => 0, Err(at) => self.to(at) + 2 }).collect();
        self.get(L_INTO); self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&outer, 1);
        self.end();
        let inner: Vec<u32> = route.iter().map(|r| match *r { Ok(at) => self.to(at) + 1, Err(_) => 0 }).collect();
        self.get(L_INTO); self.c32(0); self.set(L_INTO);
        self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&inner, 0);
        self.end();
    }

    /// On at `address`: falling through to the next block, out to a block after this one, round a loop it is in,
    /// round the dispatch loop, or out of the function.
    fn goto(&mut self, (address, target): (u64, u32), next: Option<u64>) {
        if Some(address) == next { self.ev.push(Ev::Edge); return; }
        match (target != NO).then_some(target as usize) {
            Some(b) => {
                if b <= self.at { self.time_slice(address); }
                self.ev.push(Ev::Edge);
                let label = if b > self.at { self.block_at[b] } else { self.heads[b].and_then(|l| self.loop_at[l]) };
                match label {
                    Some(at) => self.br(self.to(at)),
                    None => { debug_assert!(self.dispatch, "a lean function went round the dispatch"); self.c32(b as i32); self.set(L_BLK); self.br(self.depth); }
                }
            }
            None => {
                // Out to an address before this block's (another run of the same function) may go round a loop.
                if address <= self.function.blocks[self.at].start { self.time_slice(address); }
                self.tail(address)
            }
        }
    }

    /// Nonzero when the thread's budget is spent (one less now).
    fn spent(&mut self) {
        if self.budget { self.get(L_BUDGET); self.c32(1); self.op(I32_SUB); self.tee(L_BUDGET); self.op(I32_EQZ); }
        else { self.gget(G_BUDGET); self.c32(1); self.op(I32_SUB); self.gset(G_BUDGET); self.gget(G_BUDGET); self.op(I32_EQZ); }
    }

    /// At a loop's head: its turn is up when its budget is spent, or when it is asked to look in (a signal, taken at a
    /// loop as a CPU takes an interrupt, so `while (!got) pause();` takes it at the call).
    fn time_slice(&mut self, address: u64) {
        self.spent();
        self.c32(0); self.mem(I32_LOAD, 2, INTERRUPT as u64);
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save();
        self.save_flags(self.handed.handed(address));
        self.c64(address as i64); self.c32(TRAP_YIELD); self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
    }

    /// Before a call: past DEPTH_LIMIT frames, or when the budget is spent, made from the kernel instead (to the
    /// target `target` pushes); else one frame more.
    fn enter_call(&mut self, flags: u32, target: impl FnOnce(&mut Self)) {
        self.note_low();
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.spent();
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save_flags(flags);
        target(self);
        self.c32(TRAP_UNWIND); self.c32(TRAP_YIELD);
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.op(SELECT);
        self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
        self.gget(G_DEPTH); self.c32(1); self.op(I32_ADD); self.gset(G_DEPTH);
    }
    fn leave_call(&mut self) { self.gget(G_DEPTH); self.c32(1); self.op(I32_SUB); self.gset(G_DEPTH); }

    /// To code outside this function without growing the stack.
    fn tail(&mut self, address: u64) {
        self.save();
        self.save_flags(self.handed.handed(address));
        match self.program.entries.get(&address) {
            Some(&(f, b)) => { self.c32(b as i32); self.return_call(FIRST_GUEST + f); }
            None => { self.c64(address as i64); self.return_call(F_DISPATCH); }
        }
    }

    /// After a call: on at its return address (taking back `writes`, or all of them, from the globals), or, handed
    /// another (a longjmp out of the callee, in l_t(0)), to the function's resume (after what this frame holds is
    /// saved, where a quiet call left it in the locals).
    fn after_call(&mut self, ret: (u64, u32), next: Option<u64>, writes: Option<u32>) {
        self.get(l_t(0)); self.c64(ret.0 as i64); self.op(I64_NE);
        self.if_();
        if writes.is_some() { self.save(); }
        self.br(self.depth + 1 + self.dispatch as u32);
        self.end();
        self.sync_in(false, writes.unwrap_or(ALL));
        self.set_flags(Flags::Held);
        self.goto(ret, next);
    }
}

/// The function `target` starts and its summary, when it is one of this program's that never goes out.
fn quiet(program: &Program, summaries: &[Summary], target: u64) -> Option<(u32, Summary)> {
    let &(f, b) = program.entries.get(&target)?;
    let s = *summaries.get(f as usize)?;
    (b == 0 && program.functions[f as usize].start == target && !s.exits).then_some((f, s))
}

/// What making a function needs, kept from one function to the next (cleared, not freed), so none allocates.
#[derive(Default)]
pub struct Frame {
    f: Vec<u8>,
    ev: Vec<Ev>,
    ev_at: Vec<usize>,
    syncs: Vec<(usize, bool, u32)>,
    kinds: Vec<u8>,
    entry: Vec<bool>,
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
    code: Vec<Instruction>,
    needed: Vec<u32>,
    /// clean_loops' and sync_masks' own.
    marks: (Vec<usize>, Vec<usize>),
    cold: Vec<bool>,
    entered: Vec<bool>,
    masks: Masks,
}

/// What sync_masks keeps: each block's flow, the syncs noted on the way and their masks, and the blocks an indirect
/// jump within may go to.
#[derive(Default)]
struct Masks { flow: Vec<Flow>, notes: Vec<(usize, usize, u32, u32)>, mask: Vec<u32>, starts: Vec<usize> }

/// A block as the sync masks see it: where it goes within (up to two, or INDIRECT: any entry), its forward and
/// backward transfers (`value & P | G`), and what is dirty into it and live into it.
#[derive(Clone, Copy, Default)]
struct Flow { to: [u32; 2], n: u8, edged: bool, forward: (u32, u32), backward: (u32, u32), dirty: u32, live: u32 }
const TO_ENTRIES: u8 = u8::MAX;

/// Entries the dispatch starts at only to go on after the thread went to the kernel there, or a longjmp: a call's
/// continuation, a loop's head, a system call's or the instruction after it. A loop entered past its head at one is
/// still a wasm loop (enter_loop routes it); one entered at others (a switch's cases, another run's code) is not.
fn cold_entries(function: &Function, succ: &[[u32; 2]], cold: &mut Vec<bool>) {
    cold.clear();
    cold.resize(function.blocks.len(), false);
    for (k, b) in function.blocks.iter().enumerate() {
        // (A call's return is its first successor.)
        if matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) && succ[k][0] != NO { cold[succ[k][0] as usize] = true; }
        for &t in &succ[k] { if t != NO && t as usize <= k { cold[t as usize] = true; } }
        if b.resumes {
            if let Some(t) = function.block_index(b.end()) { cold[t] = true; }
            if b.count == 1 { cold[k] = true; }
        }
    }
}

/// Of the function's loops (into `s.loops`, with `s.within` and `s.heads`), those made wasm loops: the ones no jump
/// from outside enters past their head and no entry but a cold one lies in past their head, each within the nearest
/// such. Returns whether the function needs no dispatch loop beyond its entry: no jump back but a kept loop's round.
fn clean_loops(function: &Function, s: &mut Frame) -> bool {
    let n = function.blocks.len();
    loops_into(&function.succ, &mut s.loops, (&mut s.marks.0, &mut s.marks.1));
    cold_entries(function, &function.succ, &mut s.cold);
    loop {
        s.heads.clear();
        s.heads.resize(n, None);
        for (l, lp) in s.loops.iter().enumerate() { s.heads[lp.head] = Some(l); }
        s.entered.clear();
        s.entered.resize(s.loops.len(), false);
        let (loops, entered, heads) = (&s.loops, &mut s.entered, &s.heads);
        let mut rounds_only = true;
        let mut mark = |t: usize, from: Option<usize>| for (l, lp) in loops.iter().enumerate() {
            if t > lp.head && t <= lp.last && from.is_none_or(|k| k < lp.head || k > lp.last) { entered[l] = true; }
        };
        for (k, to) in function.succ.iter().enumerate() {
            if !s.cold[k] && s.entry[k] { mark(k, None); }
            for t in to.iter().filter(|&&t| t != NO).map(|&t| t as usize) {
                if t > k { mark(t, Some(k)); continue; }
                if !heads[t].is_some_and(|l| (loops[l].head..=loops[l].last).contains(&k)) { mark(t, None); rounds_only = false; }
            }
        }
        if !s.entered.contains(&true) {
            within_of(&s.loops, n, &mut s.within);
            return rounds_only;
        }
        // The loops kept, in place (a loop's parent comes before it), each within the nearest kept one: their parents
        // as they were read from `was`, the slots before a loop being written over as it is reached.
        let (now, was) = (&mut s.marks.0, &mut s.marks.1);
        now.clear();
        now.resize(s.loops.len(), usize::MAX);
        was.clear();
        was.extend(s.loops.iter().map(|lp| lp.parent.unwrap_or(usize::MAX)));
        let mut kept = 0;
        for l in 0..s.loops.len() {
            if s.entered[l] { continue; }
            let mut p = was[l];
            while p != usize::MAX && s.entered[p] { p = was[p]; }
            now[l] = kept;
            s.loops[kept] = Loop { parent: (p != usize::MAX).then(|| now[p]), ..s.loops[l] };
            kept += 1;
        }
        s.loops.truncate(kept);
    }
}

/// Function `index` (numbered in the table from `base`) made, its body with its size before it, onto `out`. Lean
/// when it may be (entered only at its start, with no indirect jump and no jump back but a loop's round: no dispatch
/// loop, no br_table, and with no call no resume either); V8's first tier checks the stack at each loop's head and
/// zeroes the locals of a function with more than a few.
pub fn lower_function(cx: &Lowering, index: u32, base: u32, report: &mut Report, frame: &mut Frame, out: &mut Vec<u8>) {
    let Lowering { elf, program, handed, summaries, trace } = *cx;
    let function = &program.functions[index as usize];
    let n = function.blocks.len();
    // Whether each block is an entry, found once here.
    frame.entry.clear();
    frame.entry.extend((0..n).map(|k| handed.is_entry(index, k)));
    let rounds_only = clean_loops(function, frame);
    let entered_within = function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) || frame.entry.iter().skip(1).any(|&e| e);
    let lean = !entered_within && rounds_only;
    let cases = handed.cases[index as usize] as u32;
    let mut s = std::mem::take(frame);
    s.loop_at.clear();
    s.loop_at.resize(s.loops.len(), None);
    s.block_at.clear();
    s.block_at.resize(n, None);
    s.ev_at.clear();
    s.ev_at.push(0);
    s.f.clear(); s.ev.clear(); s.syncs.clear(); s.kinds.clear(); s.labels.clear();
    let mut fx = Fx {
        f: s.f, syncs: s.syncs, used: 0, ev: s.ev, ev_at: s.ev_at, nest: 0, depth: 0,
        slots: [0; LOCALS], kinds: s.kinds, flags: Flags::Held, fr_pending: false, fused: None, rsp_up: false, backward: false,
        entry: s.entry, dispatch: !lean, program, function, report, handed, at: 0, budget: has_loop(function), summaries, succ: &function.succ,
        loop_at: s.loop_at, loops: s.loops, within: s.within, heads: s.heads, labels: s.labels, block_at: s.block_at,
    };
    let (mut code, mut needed) = (s.code, s.needed);
    // The stack pointer it began with, only where it is read: past a call (the resume) or an indirect jump.
    let calls = function.blocks.iter().any(|b| matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }));
    if calls || function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) {
        fx.gget(RSP); fx.c64(-1); fx.get(L_ENTRY); fx.op(I32_EQZ); fx.op(SELECT); fx.set(L_SP0);
    }
    // Entered at L_ENTRY: from outside, or again from the resume below, as from outside.
    let resume = !lean || calls;
    if resume { fx.loop_(); }
    if !lean { fx.get(L_ENTRY); fx.set(L_BLK); }
    fx.load();
    fx.load_flags(cases);
    if resume { fx.block(); }
    if !lean { fx.loop_(); }
    // A label for each block within no loop past its head, the last block's outermost: each ends where its code starts.
    let outside: Vec<usize> = (0..n).rev().filter(|&b| fx.within[b].is_none()).collect();
    for b in outside { fx.block(); fx.open(Lab::Block(b)); }
    fx.depth = fx.labels.len() as u32;
    if !lean {
        // Each entry to its label; one within a loop past its head to the head of the outermost loop it lies within,
        // with L_INTO saying where to go on. Block 0 (a call's way in) first: a br_table of n is log n compares.
        let outermost = |fx: &Fx, b: usize| {
            let (mut l, mut t) = (fx.within[b], b);
            while let Some(w) = l { t = fx.loops[w].head; l = fx.loops[w].parent; }
            fx.to(fx.block_at[t].unwrap_or_default())
        };
        let heads: Vec<u32> = (0..n).map(|b| outermost(&fx, b)).collect();
        if (0..n).any(|b| fx.entry[b] && fx.within[b].is_some()) {
            fx.block();
            let targets: Vec<u32> = (0..n).map(|b| if fx.within[b].is_some() { 0 } else { heads[b] + 1 }).collect();
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(targets[0]);
            fx.get(L_BLK);
            fx.br_table(&targets, 0);
            fx.end();
            fx.get(L_BLK); fx.c32(1); fx.op(I32_ADD); fx.set(L_INTO);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        } else {
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(heads[0]);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        }
    }
    let mut decoder = Code::new(elf, function.span().map_or(function.start, |(lo, _)| lo));
    for (k, block) in function.blocks.iter().enumerate() {
        decoder.decode(elf, block, &mut code);
        // Block k's label closed so its code starts here; a loop it heads is gone round from here.
        fx.end();
        fx.close(Lab::Block(k));
        if let Some(l) = fx.heads[k] { fx.enter_loop(l); }
        fx.ev_at.push(fx.ev.len());
        fx.nest = 0;
        fx.depth = fx.labels.len() as u32;
        fx.set_flags(Flags::Held);
        fx.backward = false;
        fx.at = k;
        fx.report.blocks += 1;
        if trace { fx.c64(block.start as i64); fx.call(F_TRACE); }
        let next = function.blocks.get(k + 1).map(|b| b.start);
        let (held, ext) = handed.live_out(index, k);
        // The flags needed after each instruction, from the end back.
        needed.clear();
        needed.resize(code.len(), 0);
        let mut live = held | ext;
        for (j, i) in code.iter().enumerate().rev() { needed[j] = live; live = (live & !flags_written(i)) | flags_read(i); }
        let last = code.len() - 1;
        for (j, i) in code.iter().enumerate() {
            fx.report.instructions += 1;
            if j == last && !runs_on(i) { break; }
            // A compare whose flags only the branch that ends the block reads is that branch's condition.
            if j + 1 == last && held | ext == 0 && matches!(block.exit, Exit::Branch { .. }) && Fx::fusable(i, code[last].condition_code()) {
                fx.fused = Some(*i);
                continue;
            }
            fx.instruction(i, needed[j] != 0);
        }
        let term = code[last];
        let to = fx.succ[k];
        if held != 0 && !matches!(block.exit, Exit::Branch { .. }) { fx.hold_flags(); }
        match block.exit {
            Exit::Fall(a) | Exit::Jump(a) => fx.goto((a, to[0]), next),
            Exit::TailJump(a) => fx.tail(a),
            Exit::Branch { taken, fall } => {
                fx.condition(term.condition_code());
                if held != 0 { fx.set(l_u(1)); fx.hold_flags(); fx.get(l_u(1)); }
                // A side going forward to a label open here is a br_if to it; where the taken side is the next block,
                // the condition turned round goes to the other.
                let (taken, fall) = ((taken, to[0]), (fall, to[1]));
                if let Some(d) = fx.forward(taken.1) {
                    fx.ev.push(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(fall, next);
                } else if let Some(d) = fx.forward(fall.1).filter(|_| Some(taken.0) == next) {
                    fx.op(I32_EQZ);
                    fx.ev.push(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(taken, next);
                } else {
                    fx.if_();
                    fx.depth += 1;
                    fx.goto(taken, None);
                    fx.depth -= 1;
                    fx.end();
                    fx.goto(fall, next);
                }
            }
            Exit::IndirectJump => {
                fx.read(&term, 0, 8);
                fx.set(l_t(0));
                fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
                // This function's own (by the table's numbering, which a module made later starts at its base).
                fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
                fx.ev.push(Ev::Edge);
                fx.if_();
                fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_BLK);
                fx.br(fx.depth + 1);
                fx.end();
                fx.save();
                // Elsewhere, it is handed what this function's own cases read: up to the frames further out when rsp
                // is above where this one began (a longjmp), else to the dispatcher.
                fx.save_flags(cases);
                fx.get(l_reg(RSP)); fx.get(L_SP0); fx.op(I64_GT_U);
                fx.if_();
                fx.get(l_t(0)); fx.op(RETURN);
                fx.end();
                fx.get(l_t(0)); fx.return_call(F_DISPATCH);
            }
            Exit::Call { target, ret } => {
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                if let Some((f, s)) = quiet(program, fx.summaries, target) {
                    // To a function that never goes out: only what it may touch is moved, and its depth not counted.
                    fx.note_low();
                    fx.sync_in(true, s.reads | s.writes);
                    fx.c32(0); fx.call(FIRST_GUEST + f);
                    fx.set(l_t(0));
                    fx.after_call((ret, to[0]), next, Some(s.writes));
                } else {
                    fx.save();
                    fx.enter_call(handed.handed(target), |fx| fx.c64(target as i64));
                    match program.entries.get(&target) {
                        Some(&(f, b)) => { fx.c32(b as i32); fx.call(FIRST_GUEST + f); }
                        None => { fx.c64(target as i64); fx.call(F_DISPATCH); }
                    }
                    fx.set(l_t(0));
                    fx.leave_call();
                    fx.after_call((ret, to[0]), next, None);
                }
            }
            Exit::IndirectCall { ret } => {
                // The target is read before the return address is pushed.
                fx.read(&term, 0, 8);
                fx.set(l_t(2));
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.save();
                fx.enter_call(ALL_FLAGS, |fx| fx.get(l_t(2)));
                fx.get(l_t(2)); fx.call(F_DISPATCH);
                fx.set(l_t(0));
                fx.leave_call();
                fx.after_call((ret, to[0]), next, None);
            }
            Exit::Return => {
                fx.pop_value(l_t(0));
                if term.op_count() == 1 { fx.get(l_reg(RSP)); fx.c64(term.immediate16() as i64); fx.op(I64_ADD); fx.set(l_reg(RSP)); }
                fx.save();
                fx.get(l_t(0)); fx.op(RETURN);
            }
            Exit::Trap => {
                fx.c64(term.ip() as i64);
                fx.c32(match term.mnemonic() { Mnemonic::Ud2 => TRAP_UD2, Mnemonic::Int3 => TRAP_INT3, Mnemonic::Hlt => TRAP_HLT, _ => TRAP_UNDECODED });
                fx.call(F_TRAP);
                fx.op(UNREACHABLE);
            }
        }
        // The loops this is the last block of end here, the innermost first.
        while let Some(&Lab::Loop(l)) = fx.labels.last() {
            if fx.loops[l].last != k { break; }
            fx.end();
            fx.close(Lab::Loop(l));
        }
    }
    if !resume {
        fx.op(UNREACHABLE);
        fx.end();
        return finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out);
    }
    if !lean { fx.end(); }
    fx.op(UNREACHABLE);
    fx.end();
    // The resume: a call came back to an address not its own (after_call), in l_t(0). One of this function's entries
    // is entered again here, registers and flags from their globals, so a longjmp to a frame of this function's goes
    // on in it; anything else goes up, at once when rsp is above where this frame began.
    fx.gget(RSP); fx.get(L_SP0); fx.op(I64_GT_U);
    fx.if_();
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
    if lean {
        fx.get(l_t(1)); fx.c64(((base + index) as i64) << 32); fx.op(I64_EQ);
        fx.br_if(0);
    } else {
        fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
        fx.if_();
        fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_ENTRY);
        fx.br(1);
        fx.end();
    }
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.op(UNREACHABLE);
    fx.end();
    finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out)
}

/// The rest of a frame, handed back with the function's own buffers.
type Rest = (Vec<Instruction>, Vec<u32>, (Vec<usize>, Vec<usize>), Vec<bool>, Vec<bool>, Masks);

/// Onto `out`: the function's size, its locals, then its code with each sync put in, only the registers it must move
/// (sync_masks: one the function never touches stays in its global, where code it calls and the host find it); and
/// every buffer back into `frame`.
fn finish(mut fx: Fx, rest: Rest, frame: &mut Frame, out: &mut Vec<u8>) {
    let (code, needed, marks, cold, entered, mut masks) = rest;
    sync_masks(&fx, &mut masks);
    if fx.budget { fx.slot(L_BUDGET); }
    let (used, budget, slots) = (fx.used, fx.budget, fx.slots);
    // Room for the size (five bytes at most), then the body; the size written in at the end, and the body moved up
    // to it.
    let at = out.len();
    out.extend_from_slice(&[0; 5]);
    let groups = 1 + fx.kinds.windows(2).filter(|w| w[0] != w[1]).count() - fx.kinds.is_empty() as usize;
    uleb(out, groups as u64);
    let mut k = 0;
    while k < fx.kinds.len() {
        let run = fx.kinds[k..].iter().take_while(|&&t| t == fx.kinds[k]).count();
        uleb(out, run as u64);
        out.push(fx.kinds[k]);
        k += run;
    }
    // A move: local.get, global.set (a save), or global.get, local.set (a load).
    let pair = |f: &mut Vec<u8>, save: bool, local: u32, global: u32| {
        let (first, a, second, b) = if save { (0x20, local, 0x24, global) } else { (0x23, global, 0x21, local) };
        f.push(first); uleb(f, a as u64); f.push(second); uleb(f, b as u64);
    };
    let mut from = 0;
    for (&(offset, save, scope), &m) in fx.syncs.iter().zip(&masks.mask) {
        out.extend_from_slice(&fx.f[from..offset]);
        let mut moved = used & m;
        while moved != 0 {
            let n = moved.trailing_zeros();
            moved &= moved - 1;
            let (local, global) = if n < 16 { (l_reg(n), n) } else { (l_x(n - 16), g_xmm(n - 16)) };
            pair(out, save, slots[local as usize], global);
        }
        // (A call to a function that never goes out leaves the budget alone: it has no loop, and counts no call.)
        if budget && scope == ALL { pair(out, save, slots[L_BUDGET as usize], G_BUDGET); }
        from = offset;
    }
    out.extend_from_slice(&fx.f[from..]);
    let body = out.len() - at - 5;
    let mut size = [0u8; 5];
    let mut n = 0;
    let mut v = body;
    loop { size[n] = (v & 0x7f) as u8 | if v >= 0x80 { 0x80 } else { 0 }; n += 1; v >>= 7; if v == 0 { break; } }
    out[at..at + n].copy_from_slice(&size[..n]);
    out.copy_within(at + 5.., at + n);
    out.truncate(out.len() - (5 - n));
    *frame = Frame {
        f: fx.f, ev: fx.ev, ev_at: fx.ev_at, syncs: fx.syncs, kinds: fx.kinds, entry: fx.entry, loops: fx.loops, within: fx.within,
        heads: fx.heads, labels: fx.labels, block_at: fx.block_at, loop_at: fx.loop_at, code, needed, marks, cold, entered, masks,
    };
}

/// Which registers each sync must move (into `mask`, by sync). Between syncs a register lives in its local; its
/// global is what code outside reads and writes. A save stores only what was written since last stored or loaded on
/// some path here; a load takes in only what is read before it is surely written again; a save's stores count as
/// reads. Both flows through a block are `value & P | G` of the value coming in, so each block's events are gone
/// through once for its P and G, and the fixed points found block by block.
fn sync_masks(fx: &Fx, Masks { flow, notes, mask, starts }: &mut Masks) {
    let (function, syncs, events, ev_at) = (fx.function, &fx.syncs, &fx.ev, &fx.ev_at);
    let n = function.blocks.len();
    let ev = |k: usize| &events[ev_at[k]..ev_at.get(k + 1).copied().unwrap_or(events.len())];
    // Where the prologue's dispatch, and an indirect jump within, may go; each block's successors within.
    starts.clear();
    starts.extend((0..n).filter(|&k| k == 0 || fx.entry[k]));
    flow.clear();
    flow.extend(function.blocks.iter().zip(fx.succ).map(|(b, to)| {
        let mut f = Flow::default();
        if b.exit == Exit::IndirectJump { f.n = TO_ENTRIES; return f; }
        for &k in to.iter().filter(|&&k| k != NO) { f.to[f.n as usize] = k; f.n += 1; }
        f
    }));
    let to = |flow: &[Flow], k: usize, each: &mut dyn FnMut(usize)| {
        let f = &flow[k];
        if f.n == TO_ENTRIES { for &s in starts.iter() { each(s) } } else { for &s in &f.to[..f.n as usize] { each(s as usize) } }
    };
    mask.clear();
    mask.resize(syncs.len(), 0);
    notes.clear();
    // Forward: written since the last sync on some path. A save takes what is dirty where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g, mut out_p, mut out_g) = (ALL, 0, 0, 0);
        for e in ev(k + 1) {
            match *e {
                Ev::Write(r, _) => g |= 1 << r,
                Ev::Sync(m, top) if syncs[m as usize].1 => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => { out_p |= p; out_g |= g; f.edged = true; }
                _ => {}
            }
        }
        if !f.edged { out_p |= p; out_g |= g; }
        f.forward = (out_p, out_g);
    }
    loop {
        let mut changed = false;
        for k in 0..n {
            let out = (flow[k].dirty & flow[k].forward.0) | flow[k].forward.1;
            let f = flow[k];
            let mut go = |s: usize| if flow[s].dirty | out != flow[s].dirty { flow[s].dirty |= out; changed = true; };
            if f.n == TO_ENTRIES { for &s in starts.iter() { go(s) } } else { for &s in &f.to[..f.n as usize] { go(s as usize) } }
        }
        if !changed { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((flow[k].dirty & p) | g) & syncs[m].2; }
    notes.clear();
    // Backward: read before surely written again. A load takes what is live where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g) = (if f.edged { 0 } else { ALL }, 0);
        for e in ev(k + 1).iter().rev() {
            match *e {
                Ev::Read(r) => g |= 1 << r,
                Ev::Write(r, true) => { p &= !(1 << r); g &= !(1 << r); }
                Ev::Write(_, false) => {}
                Ev::Sync(m, _) if syncs[m as usize].1 => g |= mask[m as usize],
                Ev::Sync(m, top) => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => p = ALL,
            }
        }
        f.backward = (p, g);
    }
    let after = |flow: &[Flow], k: usize| { let mut a = 0; to(flow, k, &mut |s| a |= flow[s].live); a };
    loop {
        let mut changed = false;
        for k in (0..n).rev() {
            let l = (after(flow, k) & flow[k].backward.0) | flow[k].backward.1;
            if flow[k].live | l != flow[k].live { flow[k].live |= l; changed = true; }
        }
        if !changed { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((after(flow, k) & p) | g) & syncs[m].2; }
    // The prologue takes in what any block it may start at reads.
    let start = starts.iter().fold(0, |acc, &k| acc | flow[k].live);
    for e in ev(0) { if let Ev::Sync(m, _) = *e { if !syncs[m as usize].1 { mask[m as usize] |= start; } } }
}

impl Fx<'_> {
    /// Hand the flags in `mask` to code outside, in G_FLAGS, each computed from the state as it is.
    pub fn save_flags(&mut self, mask: u32) {
        let mut first = true;
        for (k, &(f, bit, _)) in FLAG_BITS.iter().enumerate() {
            if mask & bit == 0 { continue; }
            self.flag(f);
            if k > 0 { self.c32(k as i32); self.op(I32_SHL); }
            if !first { self.op(I32_OR); }
            first = false;
        }
        if first { return; }
        self.op(I64_EXTEND_I32_U);
        self.gset(G_FLAGS);
    }
    /// Take the flags in `mask` that the code before left in G_FLAGS.
    pub fn load_flags(&mut self, mask: u32) {
        for (k, &(_, bit, l)) in FLAG_BITS.iter().enumerate() {
            if mask & bit == 0 { continue; }
            self.gget(G_FLAGS);
            self.op(I32_WRAP_I64);
            if k > 0 { self.c32(k as i32); self.op(I32_SHR_U); }
            self.c32(1); self.op(I32_AND);
            self.set(l);
        }
        self.set_flags(Flags::Held);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced_x86::{Decoder, DecoderOptions, Instruction};

    /// Functions of one block each (x86 bytes at an address, ending as given), in a program of one executable
    /// segment that holds them all.
    fn program(functions: &[(u64, &[u8], Exit)]) -> (Elf, Program) {
        let base = 0x1000;
        let end = functions.iter().map(|&(a, c, _)| a + c.len() as u64).max().unwrap();
        let mut bytes = vec![0; (end - base) as usize];
        for &(a, c, _) in functions { bytes[(a - base) as usize..][..c.len()].copy_from_slice(c); }
        let made = functions.iter().map(|(start, code, exit)| {
            let mut d = Decoder::with_ip(64, code, *start, DecoderOptions::NONE);
            let code: Vec<Instruction> = std::iter::from_fn(|| d.can_decode().then(|| d.decode())).collect();
            Function::new(*start, format!("f_{start:x}"), vec![Block::of(*start, &code, exit.clone())])
        }).collect::<Vec<_>>();
        (Elf::of_code(base, bytes), Program { entry: made[0].start, functions: made, entries: Default::default() })
    }
    const RAX: u32 = 1 << 0;
    const RSP: u32 = 1 << 4;
    const RDI: u32 = 1 << 7;
    const XMM0: u32 = 1 << 16;

    /// LEB128 as wasm-encoder writes it.
    #[test]
    fn leb_as_wasm_encoder_writes() {
        use wasm_encoder::Encode;
        for v in [0u64, 1, 63, 64, 127, 128, 16383, 16384, u32::MAX as u64, u64::MAX] {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            uleb(&mut mine, v);
            v.encode(&mut theirs);
            assert_eq!(mine, theirs, "{v}");
        }
        for v in [0i64, -1, 63, 64, -64, -65, 8191, -8192, i64::MIN, i64::MAX] {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            sleb(&mut mine, v);
            v.encode(&mut theirs);
            assert_eq!(mine, theirs, "{v}");
        }
    }

    #[test]
    fn a_leaf_reads_and_writes_what_its_instructions_do() {
        // lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[(0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return)]);
        let s = summarize(&elf, &p)[0];
        assert_eq!(s, Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false });
    }

    #[test]
    fn a_caller_takes_on_its_callees_and_recursion_goes_out() {
        // 0x2000: call 0x1000 (then ret); 0x1000: lea rax, [rdi + rdi*2 + 1]; ret
        let (elf, p) = program(&[
            (0x2000, &[0xe8, 0xfb, 0xef, 0xff, 0xff], Exit::Call { target: 0x1000, ret: 0x2005 }),
            (0x1000, &[0x48, 0x8d, 0x44, 0x7f, 0x01, 0xc3], Exit::Return),
        ]);
        let s = summarize(&elf, &p);
        assert_eq!(s[0], Summary { reads: RDI | RSP, writes: RAX | RSP, exits: false });
        // 0x3000: call 0x3000, itself.
        let (elf, p) = program(&[(0x3000, &[0xe8, 0xfb, 0xff, 0xff, 0xff], Exit::Call { target: 0x3000, ret: 0x3005 })]);
        assert!(summarize(&elf, &p)[0].exits);
        // cvtsi2sd xmm0, rdi; ret: what it writes in xmm0 (keeping its high half) is read and written.
        let (elf, p) = program(&[(0x5000, &[0xf2, 0x48, 0x0f, 0x2a, 0xc7, 0xc3], Exit::Return)]);
        let s = summarize(&elf, &p)[0];
        assert_eq!((s.reads & XMM0, s.writes & XMM0), (XMM0, XMM0));
        // A system call goes out.
        let (elf, p) = program(&[(0x4000, &[0x0f, 0x05, 0xc3], Exit::Return)]);
        assert!(summarize(&elf, &p)[0].exits);
    }
}
