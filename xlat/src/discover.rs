//! Recover functions and basic blocks from a static executable.
//!
//! Seeds are the entry point, function symbols, direct call targets and every
//! code address the linker recorded in a relocation. Each function is walked
//! on its own; a block reachable from two functions is simply translated
//! twice, so no block ever needs an owner.

use crate::elf::Elf;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::hash::{BuildHasherDefault, Hasher};

/// Addresses hashed by one multiply: a walk looks up every instruction it
/// decodes, and the standard hasher (made to resist chosen keys, which
/// addresses are not here) costs more than the lookup.
#[derive(Default)]
struct Address(u64);

impl Hasher for Address {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes { self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15); }
    }
    fn write_u64(&mut self, n: u64) {
        let h = n.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        self.0 = h ^ (h >> 32);
    }
}

type ByAddress = BuildHasherDefault<Address>;

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

#[derive(Clone, Debug)]
pub struct Block {
    pub start: u64,
    /// Every instruction including the terminator.
    pub code: Vec<Instruction>,
    pub exit: Exit,
}

#[derive(Clone, Debug)]
pub struct Function {
    pub start: u64,
    pub name: String,
    /// Sorted by address; index 0 is the function entry.
    pub blocks: Vec<Block>,
}

impl Function {
    pub fn block_index(&self, address: u64) -> Option<usize> {
        self.blocks.binary_search_by_key(&address, |b| b.start).ok()
    }
}

#[derive(Debug)]
pub struct Program {
    pub entry: u64,
    pub functions: Vec<Function>,
    /// Code addresses execution may arrive at from outside a function's own
    /// direct control flow: entries, call continuations and stored pointers.
    pub entries: BTreeMap<u64, (u32, u32)>,
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

/// Walk each (start, end, extra) on its own: natively they share the cores,
/// in wasm (one thread) they go in turn. Returns each start's blocks and the
/// code it goes on to, in the order given.
fn walk_all(elf: &Elf, jobs: &[(u64, u64, &[u64])], is_start: &(dyn Fn(u64) -> bool + Sync), references: &mut BTreeSet<u64>) -> Vec<(u64, Vec<Block>, Vec<u64>)> {
    let go = |part: &[(u64, u64, &[u64])], references: &mut BTreeSet<u64>| -> Vec<(u64, Vec<Block>, Vec<u64>)> {
        part.iter().map(|&(start, end, extra)| { let (b, c) = walk(elf, start, end, extra, is_start, Some(&mut *references)); (start, b, c) }).collect()
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

fn walk(elf: &Elf, start: u64, end: u64, extra: &[u64], is_start: &(dyn Fn(u64) -> bool + Sync), mut references: Option<&mut BTreeSet<u64>>) -> (Vec<Block>, Vec<u64>) {
    let inside = |a: u64| a >= start && a < end && (a == start || !is_start(a));
    // Looked up by address while walking, put in order once at the end.
    let mut first: Vec<u64> = std::iter::once(start).chain(extra.iter().copied().filter(|&a| inside(a))).collect();
    first.sort_unstable();
    first.dedup();
    let mut leaders: HashSet<u64, ByAddress> = first.iter().copied().collect();
    let mut instructions: HashMap<u64, Instruction, ByAddress> = HashMap::default();
    let mut work: VecDeque<u64> = first.into_iter().collect();
    let mut calls = Vec::new();
    while let Some(mut at) = work.pop_front() {
        loop {
            if instructions.contains_key(&at) {
                // Joining code decoded from another path starts a block.
                leaders.insert(at);
                break;
            }
            let Some(i) = decode(elf, at) else {
                break;
            };
            instructions.insert(at, i);
            if resumes_after(&i) {
                leaders.insert(at);
                leaders.insert(i.next_ip());
            }
            if let Some(r) = references.as_deref_mut() {
                if i.is_ip_rel_memory_operand() { r.insert(i.ip_rel_memory_address()); }
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
                    leaders.insert(next);
                    work.push_back(next);
                    break;
                }
                FlowControl::IndirectCall => {
                    leaders.insert(next);
                    work.push_back(next);
                    break;
                }
                FlowControl::ConditionalBranch => {
                    let t = direct_target(&i).unwrap();
                    for a in [t, next] {
                        if inside(a) {
                            leaders.insert(a);
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
                            leaders.insert(t);
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
    let mut blocks = Vec::new();
    let mut order: Vec<u64> = leaders.iter().copied().filter(|a| instructions.contains_key(a)).collect();
    order.sort_unstable();
    for block_start in order {
        let mut code = Vec::new();
        let mut at = block_start;
        let exit = loop {
            let i = instructions[&at];
            code.push(i);
            let next = i.next_ip();
            match flow(&i) {
                FlowControl::Call => break match direct_target(&i) {
                    Some(target) => Exit::Call { target, ret: next },
                    None => Exit::IndirectCall { ret: next },
                },
                FlowControl::IndirectCall => break Exit::IndirectCall { ret: next },
                FlowControl::ConditionalBranch => break Exit::Branch { taken: direct_target(&i).unwrap(), fall: next },
                FlowControl::UnconditionalBranch => {
                    let t = direct_target(&i).unwrap();
                    break if inside(t) { Exit::Jump(t) } else { Exit::TailJump(t) };
                }
                FlowControl::IndirectBranch => break Exit::IndirectJump,
                FlowControl::Return => break Exit::Return,
                FlowControl::Next | FlowControl::Interrupt if i.mnemonic() != Mnemonic::Int3 => {
                    if !instructions.contains_key(&next) {
                        // Running into the next function is a tail call to it.
                        break if inside(next) { Exit::Trap } else { Exit::TailJump(next) };
                    }
                    if leaders.contains(&next) {
                        break Exit::Fall(next);
                    }
                    at = next;
                }
                _ => break Exit::Trap,
            }
        };
        blocks.push(Block { start: block_start, code, exit });
    }
    (blocks, calls)
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

/// Functions reached from `seeds`, for a program already running: code at
/// `known` addresses is translated already, so a walk stops there and a
/// call to it goes through the dispatcher. Nothing of the file is read but
/// the code execution reaches from the seeds.
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
    loop {
        let mut found = BTreeSet::new();
        for &start in &starts {
            if done.contains_key(&start) { continue; }
            let end = after(known, start).min(after(&starts, start));
            // The range ends at the next start of either set, so nothing inside it is a start: no lookup per
            // instruction. Nor are data references wanted (they find jump tables when the whole program is walked).
            let (blocks, calls) = walk(elf, start, end, &[], &|_| false, None);
            found.extend(calls.into_iter().filter(|t| elf.is_code(*t) && !known.contains(t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        let walked: usize = done.values().flatten().map(|b| b.code.len()).sum();
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
    let mut entries = BTreeMap::new();
    for (index, (start, blocks)) in done.into_iter().enumerate() {
        let function = Function { start, name: format!("fn_{start:x}"), blocks };
        let f = index as u32;
        let mut mark = |address: u64| {
            if let Some(b) = function.block_index(address) { entries.entry(address).or_insert((f, b as u32)); }
        };
        mark(start);
        for b in &function.blocks {
            if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit { mark(ret); }
            if b.code.last().is_some_and(resumes_after) {
                mark(b.code.last().unwrap().ip());
                mark(b.code.last().unwrap().next_ip());
            }
        }
        functions.push(function);
    }
    Program { entry: elf.entry, functions, entries }
}

/// The program's code from its entry, its function symbols and what its relocations point at: what a running program
/// has translated first, the rest being reached later (`discover_within`).
pub fn discover(elf: &Elf) -> Program {
    walk_program(elf, &elf.relocation_targets, elf.symbols.is_empty())
}

/// The whole program, ahead of time: as `discover`, and where no function of its own is named (stripped, or only a
/// post-link tool's absolute marks) every function its pointers name, the dynamic segment's included. Code reached
/// only through a pointer is then translated with the rest, not when it is first run (a shell's builtins and
/// applets); for a large program that is far more than one run reaches.
pub fn discover_whole(elf: &Elf) -> Program {
    let mut targets: Vec<u64> = elf.relocation_targets.iter().chain(&elf.dynamic_pointers).copied().collect();
    targets.sort_unstable();
    targets.dedup();
    let named = elf.symbols.iter().any(|s| s.function && elf.is_code(s.value));
    walk_program(elf, &targets, !named)
}

/// Walk from the entry, the symbols in code, and `targets` (sorted) as pointers, each one a start of its own when
/// `pointed_start`.
fn walk_program(elf: &Elf, targets: &[u64], pointed_start: bool) -> Program {
    let mut starts: BTreeSet<u64> = BTreeSet::from([elf.entry]);
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
        let jobs: Vec<(u64, u64, &[u64])> = starts.iter().filter(|s| !done.contains_key(s)).map(|&start| {
            let end = range[&start];
            (start, end, &pointers[pointers.partition_point(|&a| a <= start)..pointers.partition_point(|&a| a < end)])
        }).collect();
        for (start, blocks, calls) in walk_all(elf, &jobs, &|a| starts.contains(&a), &mut references) {
            found.extend(calls.into_iter().filter(|t| elf.is_code(*t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        let mut tables = relative_table_targets(elf, &references);
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
    let mut entries = BTreeMap::new();
    for (index, (start, blocks)) in done.into_iter().enumerate() {
        let function = Function {
            start,
            name: names.get(&start).cloned().unwrap_or_else(|| format!("fn_{start:x}")),
            blocks,
        };
        let f = index as u32;
        let mut mark = |address: u64, function: &Function| {
            if let Some(b) = function.block_index(address) {
                entries.entry(address).or_insert((f, b as u32));
            }
        };
        mark(start, &function);
        for b in &function.blocks {
            if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit {
                mark(ret, &function);
            }
            if b.code.last().is_some_and(resumes_after) {
                mark(b.code.last().unwrap().ip(), &function);
                mark(b.code.last().unwrap().next_ip(), &function);
            }
        }
        // Only the pointers (sorted) between its first and last block can land in it.
        if let (Some(first), Some(last)) = (function.blocks.first(), function.blocks.last()) {
            let span = &pointers[pointers.partition_point(|&a| a < first.start)..pointers.partition_point(|&a| a <= last.start)];
            for &p in span {
                mark(p, &function);
            }
        }
        functions.push(function);
    }
    Program { entry: elf.entry, functions, entries }
}
