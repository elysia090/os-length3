//! Recognize the indexed loads that feed indirect branches, and find the
//! address and bound of the table before admitting any target.

use crate::elf::Elf;
use crate::layout::successors;
use crate::program::{Block, Exit, NO};
use crate::x86::{Instruction, InstructionInfoFactory, Mnemonic, OpAccess, OpKind, Register};

/// Cap a guess when no bound for the indexed read can be recovered.
const TABLE_ENTRIES: u64 = 4096;

pub(super) fn switch_targets(elf: &Elf, blocks: &[Block], start: u64, end: u64, precise: bool,
                             read: &mut Vec<Instruction>, out: &mut Vec<u64>) {
    let mut flow = None;
    for (k, b) in blocks.iter().enumerate().filter(|(_, b)| b.exit == Exit::IndirectJump) {
        b.decode(elf, read);
        let Some(indexed) = table_read(read) else { continue };
        let table = indexed.address.or_else(|| {
            if precise {
                let (pred, info) = flow.get_or_insert_with(|| (predecessors(blocks), InstructionInfoFactory::new()));
                if let Some(address) = reaching_base(elf, blocks, pred, k, indexed.base, read, info) {
                    return Some(address);
                }
            }
            only_lea(elf, blocks, indexed.base, read)
        });
        let Some(table) = table else { continue };
        let bound = match indexed.index {
            IndexBound::Mask(entries) => Some(entries),
            IndexBound::Incoming(input) => bound_of(elf, blocks, b.start, input, read),
            IndexBound::Unknown => None,
        };
        for k in 0..bound.unwrap_or(TABLE_ENTRIES) {
            let target = if indexed.relative { elf.read_i32(table + 4 * k).map(|e| table.wrapping_add(e as i64 as u64)) }
                else { elf.read_u64(table + 8 * k) };
            let Some(t) = target.filter(|&t| elf.is_code(t) && (bound.is_some() || (t >= start && t < end))) else { break };
            out.push(t);
        }
    }
}

struct Table {
    address: Option<u64>,
    base: Register,
    index: IndexBound,
    relative: bool,
}

fn table_read(code: &[Instruction]) -> Option<Table> {
    let (jmp, before) = code.split_last()?;
    if jmp.mnemonic() != Mnemonic::Jmp { return None; }
    let entry = |i: &Instruction, scale: u32| (i.memory_index() != Register::None && i.memory_index_scale() == scale).then(|| i.memory_index());
    let absolute = |i: &Instruction, before: &[Instruction]| {
        let index = entry(i, 8)?;
        Some(Table {address: Some(i.memory_displacement64()), base: Register::None,
            index: index_bound(before, index), relative: false})
    };
    if jmp.op0_kind() == OpKind::Memory && jmp.memory_base() == Register::None { return absolute(jmp, before); }
    if jmp.op0_kind() != OpKind::Register { return None; }
    let target = jmp.op0_register();
    let last = |p: &dyn Fn(&Instruction) -> bool, within: &[Instruction]| within.iter().rposition(p);
    if let Some(k) = last(&|i| i.mnemonic() == Mnemonic::Mov && i.op0_register() == target && i.op1_kind() == OpKind::Memory, before) {
        let i = &before[k];
        if i.memory_base() == Register::None { return absolute(i, &before[..k]); }
    }
    let a = last(&|i| i.mnemonic() == Mnemonic::Add && i.op0_register() == target && i.op1_kind() == OpKind::Register, before)?;
    let base = before[a].op1_register();
    let m = last(&|i| i.mnemonic() == Mnemonic::Movsxd && i.op0_register() == target && i.op1_kind() == OpKind::Memory
        && i.memory_base() == base && i.memory_displacement64() == 0, &before[..a])?;
    let index = entry(&before[m], 4)?;
    let address = match before[..m].iter().rev().find(|i| explicit_write(i, base)) {
        Some(i) => Some(lea(i, base)?),
        None => None,
    };
    Some(Table {address, base, index: index_bound(&before[..m], index), relative: true})
}

fn lea(i: &Instruction, register: Register) -> Option<u64> {
    (i.mnemonic() == Mnemonic::Lea && i.op0_register() == register && i.is_ip_rel_memory_operand()).then(|| i.ip_rel_memory_address())
}

fn explicit_write(i: &Instruction, register: Register) -> bool {
    i.op0_kind() == OpKind::Register && i.op0_register().full_register() == register.full_register()
        && !matches!(i.mnemonic(), Mnemonic::Push | Mnemonic::Cmp | Mnemonic::Test)
}

fn small_immediate(i: &Instruction) -> Option<u64> {
    matches!(i.op1_kind(), OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 |
        OpKind::Immediate8to16 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64)
        .then(|| i.immediate(1)).filter(|&n| n < TABLE_ENTRIES)
}

enum IndexBound {
    Mask(u64),
    Incoming(IndexInput),
    Unknown,
}

enum IndexInput {
    Register {name: Register, width: Option<usize>},
    Memory {address: Address, width: usize},
}

#[derive(PartialEq, Eq)]
struct Address {
    segment: Register,
    base: Register,
    index: Register,
    scale: u32,
    displacement: u64,
}

impl Address {
    fn of(i: &Instruction) -> Self {
        Self {segment: i.memory_segment(), base: i.memory_base(), index: i.memory_index(), scale: i.memory_index_scale(),
            displacement: i.memory_displacement64()}
    }
}

/// Follow copies back to the input the predecessor compared. A 32-bit copy
/// clears the high bits; a memory load at entry still sees the guarded address.
fn index_bound(before: &[Instruction], mut index: Register) -> IndexBound {
    let mut width: Option<usize> = None;
    for (position, i) in before.iter().enumerate().rev() {
        if !explicit_write(i, index) { continue; }
        let written = i.op0_register().size();
        if written < 4 { return IndexBound::Unknown; }
        if matches!(i.mnemonic(), Mnemonic::Mov | Mnemonic::Movzx) && i.op1_kind() == OpKind::Register {
            index = i.op1_register();
            let copied = written.min(index.size());
            width = Some(width.map_or(copied, |previous| previous.min(copied)));
            continue;
        }
        if position == 0 && matches!(i.mnemonic(), Mnemonic::Mov | Mnemonic::Movzx) && i.op1_kind() == OpKind::Memory {
            return IndexBound::Incoming(IndexInput::Memory {address: Address::of(i), width: i.memory_size().size()});
        }
        return if i.mnemonic() == Mnemonic::And {
            small_immediate(i).map_or(IndexBound::Unknown, |mask| IndexBound::Mask(mask + 1))
        } else { IndexBound::Unknown };
    }
    IndexBound::Incoming(IndexInput::Register {name: index, width})
}

fn predecessors(blocks: &[Block]) -> Vec<Vec<usize>> {
    let mut incoming = vec![Vec::new(); blocks.len()];
    for (block, next) in successors(blocks).into_iter().enumerate() {
        for target in next.into_iter().filter(|&target| target != NO) {
            incoming[target as usize].push(block);
        }
    }
    incoming
}

/// Only definitions that can reach this switch over direct edges are relevant.
/// Follow each predecessor at most once and stop its walk at the last write.
fn reaching_base(elf: &Elf, blocks: &[Block], pred: &[Vec<usize>], block: usize, register: Register,
                 read: &mut Vec<Instruction>, info: &mut InstructionInfoFactory) -> Option<u64> {
    let register = register.full_register();
    let preserved = matches!(register, Register::RBX | Register::RBP | Register::RSP |
        Register::R12 | Register::R13 | Register::R14 | Register::R15);
    let mut seen = vec![false; blocks.len()];
    let mut todo = pred[block].clone();
    let mut address = None;
    while let Some(k) = todo.pop() {
        if std::mem::replace(&mut seen[k], true) { continue; }
        let b = &blocks[k];
        if !preserved && matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) { continue; }
        b.decode(elf, read);
        let definition = read.iter().rev().find(|i| info.info(i).used_registers().iter().any(|used|
            used.register().full_register() == register &&
            matches!(used.access(), OpAccess::Write | OpAccess::CondWrite | OpAccess::ReadWrite | OpAccess::ReadCondWrite)));
        if let Some(i) = definition {
            if let Some(at) = lea(i, register) {
                if address.is_some_and(|previous| previous != at) { return None; }
                address = Some(at);
            }
        } else {
            todo.extend_from_slice(&pred[k]);
        }
    }
    address
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
fn bound_of(elf: &Elf, blocks: &[Block], at: u64, input: IndexInput, read: &mut Vec<Instruction>) -> Option<u64> {
    blocks.iter().find_map(|p| {
        let Exit::Branch { taken, fall } = p.exit else { return None };
        if taken != at && fall != at { return None; }
        p.decode(elf, read);
        let [.., cmp, jcc] = read.as_slice() else { return None };
        let to_table = (jcc.mnemonic() == Mnemonic::Ja && fall == at) || (jcc.mnemonic() == Mnemonic::Jbe && taken == at);
        let same = match &input {
            IndexInput::Register {name, width} => cmp.op0_kind() == OpKind::Register &&
                width.is_none_or(|width| cmp.op0_register().size() >= width) &&
                cmp.op0_register().full_register() == name.full_register(),
            IndexInput::Memory {address, width} => cmp.op0_kind() == OpKind::Memory && cmp.memory_size().size() == *width &&
                Address::of(cmp) == *address,
        };
        (to_table && cmp.mnemonic() == Mnemonic::Cmp && same).then(|| small_immediate(cmp)).flatten().map(|n| n + 1)
    })
}
