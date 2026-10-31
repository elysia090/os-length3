//! Recover functions and basic blocks from a static executable.
//!
//! Seeds are the entry point, function symbols, direct call targets and every
//! code address the linker recorded in a relocation. Each function is walked
//! on its own; a block reachable from two functions is simply translated
//! twice, so no block ever needs an owner.

use crate::elf::Elf;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind, Register};
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
        let Some((table, index, relative)) = table_read(&b.code) else { continue };
        let Some(table) = table.or_else(|| only_lea(blocks, index.1)) else { continue };
        let index = index.0;
        let bound = bound_of(blocks, b.start, index);
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
fn only_lea(blocks: &[Block], register: Register) -> Option<u64> {
    let writes_it = |i: &&Instruction| i.op0_kind() == OpKind::Register && i.op0_register().full_register() == register.full_register()
        && !matches!(i.mnemonic(), Mnemonic::Push | Mnemonic::Pop | Mnemonic::Cmp | Mnemonic::Test);
    let mut writes = blocks.iter().flat_map(|b| &b.code).filter(writes_it);
    let i = writes.next()?;
    (writes.next().is_none() && i.mnemonic() == Mnemonic::Lea && i.is_ip_rel_memory_operand() && i.op0_register() == register).then(|| i.ip_rel_memory_address())
}

/// How many entries the table read at block `at` has, from the bounds check before it: `cmp I, N` then `ja` past it
/// or `jbe` to it, in a block of the function's that goes on to `at`.
fn bound_of(blocks: &[Block], at: u64, index: Register) -> Option<u64> {
    blocks.iter().find_map(|p| {
        let Exit::Branch { taken, fall } = p.exit else { return None };
        let [.., cmp, jcc] = p.code.as_slice() else { return None };
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
    let targets: &[u64] = match &b.exit {
        Exit::Jump(a) | Exit::Fall(a) => std::slice::from_ref(a),
        Exit::Branch { taken, .. } => std::slice::from_ref(taken),
        _ => &[],
    };
    targets.iter().copied().filter(|&a| f.block_index(a).is_some_and(|j| j <= k)).collect()
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
        for (k, b) in function.blocks.iter().enumerate() {
            if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit { mark(ret); }
            // A loop's head: where a thread that has run long is taken back to the kernel, and goes on later.
            for a in back_edges(&function, k, b) { mark(a); }
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
    walk_program(elf, &elf.relocation_targets, elf.symbols.is_empty(), &[], true)
}

/// Exactly the functions starting at `seeds` (with the entry and the named ones): what the program's runs have
/// translated so far, its first module's and those of the code they reached later, in one translation of its own,
/// so each process of it starts with one module, not hundreds, and every jump among that code is found in its first
/// table. A call to a function past these is not followed (it is reached later, as before): following them all
/// would translate much of a large program no run has reached.
pub fn discover_seeded(elf: &Elf, seeds: &[u64]) -> Program {
    walk_program(elf, &elf.relocation_targets, false, seeds, false)
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
    walk_program(elf, &targets, !named, &[], true)
}

/// Walk from the entry, the symbols in code, `seeds`, and `targets` (sorted) as pointers, each one a start of its own
/// when `pointed_start`; and from every function a call reaches, when `follow`.
fn walk_program(elf: &Elf, targets: &[u64], pointed_start: bool, seeds: &[u64], follow: bool) -> Program {
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
        let jobs: Vec<(u64, u64, &[u64])> = starts.iter().filter(|s| !done.contains_key(s)).map(|&start| {
            let end = range[&start];
            (start, end, &pointers[pointers.partition_point(|&a| a <= start)..pointers.partition_point(|&a| a < end)])
        }).collect();
        // Without relocations that say where its tables are, those its switches read (switch_targets).
        let guess = elf.relative_slots.is_empty();
        let mut switches = Vec::new();
        for (start, blocks, calls) in walk_all(elf, &jobs, &|a| starts.contains(&a), &mut references) {
            if guess { switches.extend(switch_targets(elf, &blocks, start, range[&start])); }
            // Not following calls, code it goes on to all the same: what it jumps or runs into past its range is code
            // the runs reached as part of it before more starts cut it there.
            let next: Vec<u64> = if follow { calls } else { continuations(&blocks) };
            found.extend(next.into_iter().filter(|t| elf.is_code(*t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        // Code whose address code takes (rip-relative, as a callback is passed): a function, as a pointer to it is.
        if follow { found.extend(references.iter().copied().filter(|&a| elf.is_code(a) && !starts.contains(&a))); }
        let mut tables = if guess { switches } else { relative_table_targets(elf, &references) };
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
        for (k, b) in function.blocks.iter().enumerate() {
            if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit {
                mark(ret, &function);
            }
            // A loop's head: where a thread that has run long is taken back to the kernel, and goes on later.
            for a in back_edges(&function, k, b) { mark(a, &function); }
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
