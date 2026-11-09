//! Finding the code: from the entry, the symbols, the pointers the relocations name and the calls each walk makes,
//! each function walked in its range (to the next start or its symbol's size), its switches' tables read, and its
//! blocks cut into runs of about RUN. Each instruction is decoded once here, kept as 16 bytes by its offset (no map is
//! hashed); a walk is made again only where a new start lies in what it reached.

use crate::elf::Elf;
use crate::program::*;
use iced_x86::{Decoder, DecoderOptions, Instruction, Mnemonic, OpKind, Register};
use std::collections::{BTreeMap, BTreeSet, VecDeque};


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
        // The starts not walked yet: both lists in order, gone through together.
        let mut walked = done.keys().copied().peekable();
        let jobs: Vec<Job> = sorted.iter().filter(|&&s| { while walked.next_if(|&d| d < s).is_some() {} walked.next_if_eq(&s).is_none() }).map(|&s| {
            let e = end(s);
            let ((p, q), (i, j)) = (inside(&pointers, s, e), inside(&sorted, s, e));
            (s, e, &pointers[p..q], &sorted[i..j])
        }).collect();
        let (mut found, mut switches) = (Vec::new(), Vec::new());
        for (s, blocks, calls) in walk_all(elf, &jobs, collect.then_some(&mut references)) {
            if guess && follow.tables { switches.extend(switch_targets(elf, &blocks, s, end(s))); }
            // Not following calls, code it goes on to all the same: what it jumps or runs into past its range.
            found.extend(if follow.calls { calls } else { continuations(&blocks) });
            done.insert(s, blocks);
        }
        // Each place once (a function is called from many), then only those not known yet.
        found.sort_unstable();
        found.dedup();
        found.retain(|t| elf.is_code(*t) && !known.contains(t) && !starts.contains(t));
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
    let mut scratch = Layout::default();
    for (start, blocks) in done {
        let name = names.get(&start).cloned().unwrap_or_else(|| format!("fn_{start:x}"));
        let first = functions.len();
        for f in runs(start, name, blocks, &mut scratch) {
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
            // Only the pointers between its first and last block can land in it: both in address order, gone through
            // together.
            if let Some((lo, hi)) = f.span() {
                let mut by_address = f.by_address.iter().map(|&b| (f.blocks[b as usize].start, b)).peekable();
                for &p in &pointers[pointers.partition_point(|&a| a < lo)..pointers.partition_point(|&a| a <= hi)] {
                    while by_address.next_if(|&(a, _)| a < p).is_some() {}
                    if let Some(&(a, b)) = by_address.peek() { if a == p { marks.push((p, (k, b))); } }
                }
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
}

/// What a walk keeps of an instruction it decoded, in 16 bytes.
#[derive(Clone, Copy)]
struct Step { target: u64, len: u8, flow: u8, reads: u8, writes: u8, bits: u8 }

use go::{BRANCH, CALL, INDIRECT_CALL, INDIRECT_JUMP, JUMP, NEXT};
// A step's bits besides Kind's (TRAPS, SYSCALL).
const TARGET: u8 = 1;

impl Step {
    fn of(i: &Instruction) -> Step {
        let k = kind(i);
        let target = matches!(i.op0_kind(), OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16);
        let bits = k.bits & (TRAPS | SYSCALL) | if target { TARGET } else { 0 };
        Step { target: if target { i.near_branch_target() } else { 0 }, len: i.len() as u8, flow: k.flow, reads: k.reads, writes: k.writes, bits }
    }
}

/// What a walk keeps while it walks, by each byte's offset from its start: for each byte 1 + the index of the step
/// that starts there (0: none), with LEADER where a block starts. Code past its range goes in `outside` (a few places
/// at most). One is kept from walk to walk, cleared, not freed.
#[derive(Default)]
struct Scratch { base: u64, span: usize, high: usize, at: Vec<u32>, outside: Vec<(u64, u32)>, steps: Vec<Step>, leads: Vec<u64> }

const LEADER: u32 = 1 << 31;

impl Scratch {
    #[inline]
    fn offset(&self, a: u64) -> Option<usize> { let o = a.wrapping_sub(self.base); (o < self.span as u64).then_some(o as usize) }
    #[inline]
    fn entry(&mut self, a: u64) -> &mut u32 {
        let o = a.wrapping_sub(self.base);
        if o < self.at.len() as u64 { self.high = self.high.max(o as usize + 1); return &mut self.at[o as usize]; }
        self.entry_past(a)
    }
    /// An entry past what `at` holds yet: grown to it, or one of the few outside the walk's range.
    #[cold]
    fn entry_past(&mut self, a: u64) -> &mut u32 {
        if let Some(o) = self.offset(a) {
            if o >= self.at.len() { self.at.resize((o + 1).next_multiple_of(4096).min(self.span), 0); }
            self.high = self.high.max(o + 1);
            return &mut self.at[o];
        }
        let k = self.outside.iter().position(|&(x, _)| x == a).unwrap_or_else(|| { self.outside.push((a, 0)); self.outside.len() - 1 });
        &mut self.outside[k].1
    }
    #[inline]
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
    // (What a walk before held past this one's range is zero, and no entry of this one.)
    s.at.truncate(s.span);
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
        // Each instruction's entry looked up once: its step, and where it is the next one, whether it was decoded and leads.
        let mut e = s.get(b);
        let (exit, last) = loop {
            let step = s.steps[(e & !LEADER) as usize - 1];
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
                NEXT => {
                    e = s.get(next);
                    if e & !LEADER == 0 { if inside(next) { Exit::Trap } else { Exit::TailJump(next) } }
                    else if e & LEADER != 0 { Exit::Fall(next) }
                    else { at = next; continue; }
                }
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


pub(crate) fn decode(elf: &Elf, address: u64) -> Option<Instruction> {
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
fn runs(start: u64, name: String, blocks: Vec<Block>, scratch: &mut Layout) -> Vec<Function> {
    let exact = RUN_BLOCKS.with(|r| r.get());
    let run = exact.unwrap_or(RUN);
    if blocks.len() <= run { return vec![Function::laid_out(start, name, blocks, scratch)]; }
    // A cut before block p breaks each loop with head < p <= last (a walk's blocks are in address order).
    let mut breaks = vec![false; blocks.len()];
    if exact.is_none() {
        for lp in loops_of(&blocks).0.into_iter().filter(|lp| lp.last - lp.head < KEEP) { breaks[lp.head + 1..=lp.last].fill(true); }
    }
    let mut out: Vec<Function> = Vec::with_capacity(blocks.len().div_ceil(run));
    let mut held: Vec<Block> = Vec::with_capacity(run);
    let named = |out: &Vec<Function>| if out.is_empty() { name.clone() } else { format!("{name}.{}", out.len() + 1) };
    for (p, b) in blocks.into_iter().enumerate() {
        if held.len() >= run + KEEP * exact.is_none() as usize || (held.len() >= run && !breaks[p]) {
            let n = named(&out);
            out.push(Function::laid_out(held[0].start, n, std::mem::take(&mut held), scratch));
        }
        held.push(b);
    }
    let n = named(&out);
    out.push(Function::laid_out(held[0].start, n, held, scratch));
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

