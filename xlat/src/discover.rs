//! Recover functions and basic blocks from a static executable.
//!
//! Seeds are the entry point, function symbols, direct call targets and every
//! code address the linker recorded in a relocation. Each function is walked
//! on its own; a block reachable from two functions is simply translated
//! twice, so no block ever needs an owner.

use crate::elf::Elf;
use iced_x86::{Decoder, DecoderOptions, FlowControl, Instruction, Mnemonic, OpKind};
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

fn walk(elf: &Elf, start: u64, end: u64, extra: &[u64], function_starts: &BTreeSet<u64>, references: &mut BTreeSet<u64>) -> (Vec<Block>, Vec<u64>) {
    let inside = |a: u64| a >= start && a < end && (a == start || !function_starts.contains(&a));
    let mut leaders = BTreeSet::from([start]);
    leaders.extend(extra.iter().copied().filter(|&a| inside(a)));
    let mut instructions: BTreeMap<u64, Instruction> = BTreeMap::new();
    let mut work: VecDeque<u64> = leaders.iter().copied().collect();
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
            if i.is_ip_rel_memory_operand() {
                references.insert(i.ip_rel_memory_address());
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
    for &block_start in leaders.iter().filter(|a| instructions.contains_key(a)) {
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
    let mut starts: BTreeSet<u64> = seeds.iter().copied().filter(|a| elf.is_code(*a) && !known.contains(a)).collect();
    let sizes = BTreeMap::new();
    let mut references = BTreeSet::new();
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    loop {
        let all: BTreeSet<u64> = starts.union(known).copied().collect();
        let range = ranges(&all, &sizes);
        let mut found = Vec::new();
        for &start in &starts {
            if done.contains_key(&start) { continue; }
            let (blocks, calls) = walk(elf, start, range[&start], &[], &all, &mut references);
            found.extend(calls.into_iter().filter(|t| elf.is_code(*t) && !all.contains(t)));
            done.insert(start, blocks);
        }
        if found.is_empty() { break; }
        starts.extend(found);
        done.clear();
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

pub fn discover(elf: &Elf) -> Program {
    let mut starts: BTreeSet<u64> = BTreeSet::from([elf.entry]);
    let mut sizes = BTreeMap::new();
    let mut names = BTreeMap::new();
    // Function symbols, and untyped ones (assembly entry points like _init,
    // _fini) that code also points at.
    let pointed: BTreeSet<u64> = elf.relocation_targets.iter().copied().collect();
    for s in elf.symbols.iter().filter(|s| elf.is_code(s.value) && (s.function || pointed.contains(&s.value))) {
        starts.insert(s.value);
        sizes.entry(s.value).or_insert(s.size);
        names.entry(s.value).or_insert_with(|| s.name.clone());
    }
    let mut pointers: Vec<u64> = elf.relocation_targets.iter().copied().filter(|&a| elf.is_code(a)).collect();
    let mut references = BTreeSet::new();
    if elf.symbols.is_empty() {
        starts.extend(pointers.iter().copied());
    }

    // Walk until no new call target appears.
    let mut done: BTreeMap<u64, Vec<Block>> = BTreeMap::new();
    loop {
        let range = ranges(&starts, &sizes);
        let mut found = Vec::new();
        for &start in &starts {
            if done.contains_key(&start) {
                continue;
            }
            let end = range[&start];
            let extra: Vec<u64> = pointers.iter().copied().filter(|&a| a > start && a < end).collect();
            let (blocks, calls) = walk(elf, start, end, &extra, &starts, &mut references);
            found.extend(calls.into_iter().filter(|t| elf.is_code(*t) && !starts.contains(t)));
            done.insert(start, blocks);
        }
        let mut tables = relative_table_targets(elf, &references);
        tables.retain(|t| pointers.binary_search(t).is_err());
        if found.is_empty() && tables.is_empty() {
            break;
        }
        pointers.extend(tables);
        pointers.sort_unstable();
        starts.extend(found);
        // A new start splits whichever function's range covered it.
        done.clear();
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
        for &p in &pointers {
            mark(p, &function);
        }
        functions.push(function);
    }
    Program { entry: elf.entry, functions, entries }
}
