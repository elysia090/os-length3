//! Finding the code: from the entry, the symbols, the pointers the relocations name and the calls each walk makes,
//! each function walked in its range (to the next start or its symbol's size), its switches' tables read, and its
//! blocks laid out and cut into runs (layout.rs). Each instruction is decoded once, whatever is walked again: what a
//! walk needs of it is kept as 16 bits by its address (no map is hashed), for as long as the code is looked for.

use crate::elf::Elf;
use crate::layout::{joined, runs, Layout};
use crate::program::*;
use crate::scan::{scan, ASKED, INVALID, REL32, REL8, SYSTEM};
use crate::x86::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU16, Ordering::Relaxed};
use std::sync::OnceLock;

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
    // What the code names: this round's (`fresh`), and all so far where tables are found by them.
    let (mut references, mut fresh): (Vec<u64>, Vec<u64>) = (Vec::new(), Vec::new());
    let after = |set: &BTreeSet<u64>, a: u64| set.range(a + 1..).next().copied().unwrap_or(u64::MAX);
    let before = |set: &BTreeSet<u64>, a: u64| set.range(..a).next_back().copied();
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    let seen = Seen::new(elf);
    // (The instructions of a block read for its switch: one list, read into again and again.)
    let mut read: Vec<Instruction> = Vec::new();
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
        fresh.clear();
        let (walked, mut found) = walk_all(elf, &seen, &jobs, collect.then_some(&mut fresh));
        let mut switches = Vec::new();
        // Not following calls, code it goes on to all the same: what it jumps or runs into past its range.
        if !follow.calls { found.clear(); }
        for (s, blocks) in walked {
            if guess && follow.tables { switch_targets(elf, &blocks, s, end(s), &mut read, &mut switches); }
            if !follow.calls { found.extend(continuations(&blocks)); }
            done.insert(s, blocks);
        }
        // Only those not known yet, then each place once (a function is called from many): the few that are new are
        // what is sorted.
        found.retain(|t| elf.is_code(*t) && !known.contains(t) && !starts.contains(t));
        found.sort_unstable();
        found.dedup();
        // What this round's code names, each place once: an instruction is asked what it names when it is first
        // scanned, and what the rounds before named are starts by now, or are no code.
        fresh.sort_unstable();
        fresh.dedup();
        if follow.taken { found.extend(fresh.iter().copied().filter(|&a| elf.is_code(a) && !starts.contains(&a))); }
        let mut tables = if !follow.tables { Vec::new() } else if guess { switches } else { references.extend_from_slice(&fresh); relative_table_targets(elf, &references) };
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
        let name = names.get(&start).cloned().unwrap_or_default();
        let (first, from) = (functions.len(), marks.len());
        runs(start, name, blocks, &mut scratch, &mut functions);
        for (k, f) in functions.iter().enumerate().skip(first) {
            let k = k as u32;
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
        }
        joined(&functions[first..], first, &mut marks);
        // (Each function's marks in order as they are made: functions come in the order of their addresses, so all of
        // them are then nearly in order, which Entries::of's sort takes in one pass.)
        marks[from..].sort_unstable();
    }
    Program { entry: elf.entry, functions, entries: Entries::of(marks) }
}

/// A walk's work: its start, the end of its range, the pointers into the range and the other starts inside it.
type Job<'a> = (u64, u64, &'a [u64], &'a [u64]);

/// Each job walked: natively on every core, in wasm (one thread) in turn; in the order given. With what they call
/// or go on to outside, all together.
fn walk_all(elf: &Elf, seen: &Seen, jobs: &[Job], references: Option<&mut Vec<u64>>) -> (Vec<(u64, Vec<Block>)>, Vec<u64>) {
    let collect = references.is_some();
    let go = |part: &[Job], r: &mut Vec<u64>, calls: &mut Vec<u64>| -> Vec<(u64, Vec<Block>)> {
        let mut scratch = Scratch::default();
        part.iter().map(|&job| (job.0, walk(elf, seen, job, collect.then_some(&mut *r), calls, &mut scratch))).collect()
    };
    let mut own = Vec::new();
    let r = references.unwrap_or(&mut own);
    let mut calls = Vec::new();
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    if threads == 1 || jobs.len() < 64 { let walked = go(jobs, r, &mut calls); return (walked, calls); }
    let size = jobs.len().div_ceil(threads);
    let parts: Vec<_> = std::thread::scope(|scope| {
        let workers: Vec<_> = jobs.chunks(size).map(|part| { let go = &go; scope.spawn(move || { let (mut r, mut calls) = (Vec::new(), Vec::new()); let out = go(part, &mut r, &mut calls); (out, r, calls) }) }).collect();
        workers.into_iter().map(|w| w.join().expect("a walking thread panicked")).collect()
    });
    let mut out = Vec::with_capacity(jobs.len());
    for (walked, mine, called) in parts { out.extend(walked); r.extend(mine); calls.extend(called); }
    (out, calls)
}

/// What finding keeps of every instruction it has decoded, for as long as it looks: 16 bits each, by its address (a
/// page of them made when code on it is first decoded). A function is walked again when a start found later lies in
/// what it reached, and its walks, as any other's that come the same way, read here what the first scanned (scan.rs:
/// an entry is what a scan gives); the walks of a round, on every core, share it (two that scan the same place write
/// the same).
struct Seen { base: u64, pages: Vec<OnceLock<Box<[AtomicU16; PAGE]>>> }

const PAGE: usize = 4096;
impl Seen {
    fn new(elf: &Elf) -> Seen {
        let code = || elf.segments.iter().filter(|s| s.executable);
        let base = code().map(|s| s.vaddr).min().unwrap_or(0) & !(PAGE as u64 - 1);
        let end = code().map(|s| s.vaddr + s.data.len() as u64).max().unwrap_or(0);
        Seen { base, pages: (0..end.saturating_sub(base).div_ceil(PAGE as u64)).map(|_| OnceLock::new()).collect() }
    }
    /// (The page in 64 bits: an address before `base` wraps far past the last, and a 32-bit usize would cut it to
    /// one it is not on.)
    #[inline]
    fn page(&self, a: u64) -> Option<(&OnceLock<Box<[AtomicU16; PAGE]>>, usize)> {
        let o = a.wrapping_sub(self.base);
        let p = o / PAGE as u64;
        (p < self.pages.len() as u64).then(|| (&self.pages[p as usize], (o % PAGE as u64) as usize))
    }
    #[inline]
    fn get(&self, a: u64) -> u16 {
        match self.page(a) { Some((p, k)) => p.get().map_or(0, |p| p[k].load(Relaxed)), None => 0 }
    }
    /// `e` kept for the instruction at `a`; false where it is nowhere code can be.
    fn set(&self, a: u64, e: u16) -> bool {
        let Some((p, k)) = self.page(a) else { return false };
        let page = p.get_or_init(|| {
            let fresh: Box<[AtomicU16]> = (0..PAGE).map(|_| AtomicU16::new(0)).collect();
            fresh.try_into().unwrap_or_else(|_| unreachable!("a page is PAGE entries"))
        });
        page[k].store(e, Relaxed);
        true
    }
}

/// What a walk keeps while it walks, by each byte's offset from its start: whether an instruction that starts there
/// was WALKED, and whether a block starts there (LEADER). Code past its range goes in `outside` (a few places at
/// most). One is kept from walk to walk, cleared, not freed.
#[derive(Default)]
struct Scratch { base: u64, span: usize, high: usize, mark: Vec<u8>, outside: Vec<(u64, u8)>, leads: Vec<u64>, work: Vec<u64> }

const WALKED: u8 = 1;
const LEADER: u8 = 2;

impl Scratch {
    #[inline]
    fn at(&mut self, a: u64) -> &mut u8 {
        let o = a.wrapping_sub(self.base);
        if o < self.mark.len() as u64 { self.high = self.high.max(o as usize + 1); return &mut self.mark[o as usize]; }
        self.past(a)
    }
    /// A mark past what `mark` holds yet: grown to it, or one of the few outside the walk's range.
    #[cold]
    fn past(&mut self, a: u64) -> &mut u8 {
        let o = a.wrapping_sub(self.base);
        if o < self.span as u64 {
            let o = o as usize;
            self.mark.resize((o + 1).next_multiple_of(4096).min(self.span), 0);
            self.high = self.high.max(o + 1);
            return &mut self.mark[o];
        }
        let k = self.outside.iter().position(|&(x, _)| x == a).unwrap_or_else(|| { self.outside.push((a, 0)); self.outside.len() - 1 });
        &mut self.outside[k].1
    }
    #[inline]
    fn get(&self, a: u64) -> u8 {
        let o = a.wrapping_sub(self.base);
        if o < self.span as u64 { self.mark.get(o as usize).copied().unwrap_or(0) } else { self.outside.iter().find(|&&(x, _)| x == a).map_or(0, |&(_, m)| m) }
    }
    fn lead(&mut self, a: u64) {
        let m = self.at(a);
        if *m & LEADER == 0 { *m |= LEADER; self.leads.push(a); }
    }
}

use go::{BRANCH, CALL, INDIRECT_CALL, INDIRECT_JUMP, JUMP, NEXT};

/// The blocks of the function at `start` within its range (and `extra` places in it pointers name, but not the
/// `inner` starts of others), and (onto `calls`) the code it calls or goes on to outside: each block from a leader along next_ip
/// (not address order, so a wrong table guess decoding bytes inside an instruction leaves the real blocks as they are).
fn walk(elf: &Elf, seen: &Seen, (start, end, extra, inner): Job, mut references: Option<&mut Vec<u64>>, calls: &mut Vec<u64>, s: &mut Scratch) -> Vec<Block> {
    let inside = |a: u64| a >= start && a < end && (a == start || inner.is_empty() || inner.binary_search(&a).is_err());
    // The code from the start to its segment's end; code elsewhere (a call's continuation past the segment) found
    // on its own.
    let code = elf.code_at(start).unwrap_or_default();
    let bytes_at = |a: u64| match a.checked_sub(start).filter(|&o| o < code.len() as u64) { Some(o) => &code[o as usize..], None => elf.code_at(a).unwrap_or_default() };
    // Where the instruction at `at` (its entry `e`) goes: 0 where it names no place.
    let target = |at: u64, e: u16| -> u64 {
        let len = (e & 15) as usize;
        let (next, b) = (at + len as u64, bytes_at(at));
        match (e >> 7 & 3, b.get(..len)) {
            (REL8, Some(b)) => next.wrapping_add(b[len - 1] as i8 as u64),
            (REL32, Some(b)) if len >= 4 => next.wrapping_add(i32::from_le_bytes([b[len - 4], b[len - 3], b[len - 2], b[len - 1]]) as u64),
            (ASKED, _) => decode(elf, at).map_or(0, |i| i.near_branch_target()),
            _ => 0,
        }
    };
    (s.base, s.span) = (start, (end.min(start + code.len() as u64) - start) as usize);
    // (What a walk before held past this one's range is zero, and no mark of this one.)
    s.mark.truncate(s.span);
    s.outside.clear();
    s.leads.clear();
    s.work.clear();
    s.lead(start);
    s.work.push(start);
    for &a in extra { if inside(a) { s.lead(a); s.work.push(a); } }
    let go = |a: u64, s: &mut Scratch, calls: &mut Vec<u64>| if inside(a) { s.lead(a); s.work.push(a); } else { calls.push(a); };
    while let Some(mut at) = s.work.pop() {
        loop {
            // Joining code walked from another path starts a block.
            let m = s.at(at);
            let was = *m;
            *m = was | WALKED;
            if was & WALKED != 0 { s.lead(at); break; }
            let mut e = seen.get(at);
            if e == 0 {
                let found = scan(bytes_at(at), at);
                e = found.entry;
                if !seen.set(at, e) { e = INVALID; }
                if e != INVALID {
                    if let Some(r) = references.as_deref_mut() {
                        r.extend(found.rip(bytes_at(at), at));
                        // Where code is not position-independent, an address in its code given as a number is one too.
                        if elf.fixed { r.extend(found.imm(bytes_at(at)).filter(|&a| elf.is_code(a))); }
                    }
                }
            }
            if e == INVALID { *s.at(at) &= !WALKED; break; }
            let next = at + (e & 15) as u64;
            if e & SYSTEM != 0 { s.lead(at); s.lead(next); }
            match (e >> 4 & 7) as u8 {
                NEXT if inside(next) => { at = next; continue; }
                NEXT => calls.push(next),
                CALL | INDIRECT_CALL => {
                    if e >> 7 & 3 != 0 { calls.push(target(at, e)); }
                    s.lead(next);
                    s.work.push(next);
                }
                BRANCH => { go(target(at, e), s, calls); go(next, s, calls); }
                JUMP if e >> 7 & 3 != 0 => go(target(at, e), s, calls),
                _ => {}
            }
            break;
        }
    }
    let mut order = std::mem::take(&mut s.leads);
    order.sort_unstable();
    order.retain(|&a| s.get(a) & WALKED != 0);
    let mut blocks = Vec::with_capacity(order.len());
    for &b in &order {
        let (mut at, mut reads, mut writes, mut traps, mut count) = (b, 0u8, 0u8, false, 0u32);
        let (exit, last, system) = loop {
            let e = seen.get(at);
            let [r, w, bits] = of_class((e >> 9 & 63) as u8);
            reads |= r & !writes;
            writes |= w;
            traps |= bits & TRAPS != 0;
            count += 1;
            let len = (e & 15) as u8;
            let next = at + len as u64;
            let exit = match (e >> 4 & 7) as u8 {
                CALL if e >> 7 & 3 != 0 => Exit::Call { target: target(at, e), ret: next },
                CALL | INDIRECT_CALL => Exit::IndirectCall { ret: next },
                BRANCH => Exit::Branch { taken: target(at, e), fall: next },
                JUMP => { let t = target(at, e); if inside(t) { Exit::Jump(t) } else { Exit::TailJump(t) } }
                INDIRECT_JUMP => Exit::IndirectJump,
                go::RETURN => Exit::Return,
                // Running into the next function is a tail call to it.
                NEXT => {
                    let m = s.get(next);
                    if m & WALKED == 0 { if inside(next) { Exit::Trap } else { Exit::TailJump(next) } }
                    else if m & LEADER != 0 { Exit::Fall(next) }
                    else { at = next; continue; }
                }
                _ => Exit::Trap,
            };
            break (exit, len, e & SYSTEM != 0);
        };
        let len = (at + last as u64 - b) as u32;
        blocks.push(Block { start: b, len, count, reads, writes, last, resumes: system, traps, exit });
    }
    s.leads = order;
    s.mark[..s.high].fill(0);
    s.high = 0;
    blocks
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
fn switch_targets(elf: &Elf, blocks: &[Block], start: u64, end: u64, read: &mut Vec<Instruction>, out: &mut Vec<u64>) {
    for b in blocks.iter().filter(|b| b.exit == Exit::IndirectJump) {
        b.decode(elf, read);
        let Some((table, (index, base), relative)) = table_read(read) else { continue };
        let Some(table) = table.or_else(|| only_lea(elf, blocks, base, read)) else { continue };
        let bound = bound_of(elf, blocks, b.start, index, read);
        for k in 0..bound.unwrap_or(TABLE_ENTRIES) {
            let target = if relative { elf.read_i32(table + 4 * k).map(|e| table.wrapping_add(e as i64 as u64)) } else { elf.read_u64(table + 8 * k) };
            let Some(t) = target.filter(|&t| elf.is_code(t) && (bound.is_some() || (t >= start && t < end))) else { break };
            out.push(t);
        }
    }
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
fn only_lea(elf: &Elf, blocks: &[Block], register: Register, read: &mut Vec<Instruction>) -> Option<u64> {
    let writes_it = |i: &Instruction| i.op0_kind() == OpKind::Register && i.op0_register().full_register() == register.full_register()
        && !matches!(i.mnemonic(), Mnemonic::Push | Mnemonic::Pop | Mnemonic::Cmp | Mnemonic::Test);
    let mut only = None;
    for b in blocks {
        b.decode(elf, read);
        for i in read.iter().filter(|i| writes_it(i)) {
            if only.is_some() { return None; }
            only = Some(*i);
        }
    }
    let i = only?;
    (i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() && i.op0_register() == register).then(|| i.ip_rel_memory_address())
}

/// How many entries the table read at block `at` has, from `cmp I, N` then `ja` past it or `jbe` to it in a block
/// that goes on to `at`.
fn bound_of(elf: &Elf, blocks: &[Block], at: u64, index: Register, read: &mut Vec<Instruction>) -> Option<u64> {
    blocks.iter().find_map(|p| {
        let Exit::Branch { taken, fall } = p.exit else { return None };
        if taken != at && fall != at { return None; }
        p.decode(elf, read);
        let [.., cmp, jcc] = read.as_slice() else { return None };
        let to_table = (jcc.mnemonic() == Mnemonic::Ja && fall == at) || (jcc.mnemonic() == Mnemonic::Jbe && taken == at);
        let same = cmp.op0_kind() == OpKind::Register && cmp.op0_register().full_register() == index.full_register();
        let n = matches!(cmp.op1_kind(), OpKind::Immediate8 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32 | OpKind::Immediate32to64).then(|| cmp.immediate(1));
        (to_table && cmp.mnemonic() == Mnemonic::Cmp && same).then_some(n?).filter(|&n| n < TABLE_ENTRIES).map(|n| n + 1)
    })
}
