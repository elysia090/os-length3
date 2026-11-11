//! An x86-64 instruction as sods reads it: decoded from the program's own bytes (the decoder is iced's, taken in
//! here and nowhere else), what its code alone says of it (where it goes on, the flags it reads and writes), and the
//! registers it names, as the lowering numbers them.

use crate::elf::Elf;
pub use iced_x86::{ConditionCode, Instruction, InstructionInfoFactory, Mnemonic, OpAccess, OpKind, Register, RflagsBits};
pub(crate) use iced_x86::{Decoder, DecoderOptions};
use iced_x86::FlowControl;

/// The instruction at `address`, if its bytes are one.
pub(crate) fn decode(elf: &Elf, address: u64) -> Option<Instruction> {
    let bytes = elf.code_at(address)?;
    let i = Decoder::with_ip(64, &bytes[..bytes.len().min(15)], address, DecoderOptions::NONE).decode();
    (!i.is_invalid()).then_some(i)
}

/// Every instruction of `code` (at `start`, each after the one before).
#[cfg(test)]
pub(crate) fn decode_all(code: &[u8], start: u64) -> Vec<Instruction> {
    let mut d = Decoder::with_ip(64, code, start, DecoderOptions::NONE);
    std::iter::from_fn(|| d.can_decode().then(|| d.decode())).collect()
}

/// One decoder over a segment's code, moved to each block decoded (not made again for each): `count` instructions
/// from `start`, into `into`.
pub(crate) struct Code<'e> { base: u64, decoder: Decoder<'e> }

impl<'e> Code<'e> {
    pub(crate) fn new(elf: &'e Elf, base: u64) -> Code<'e> {
        Code { base, decoder: Decoder::with_ip(64, elf.code_at(base).unwrap_or_default(), base, DecoderOptions::NONE) }
    }
    pub(crate) fn decode(&mut self, elf: &Elf, start: u64, count: u32, into: &mut Vec<Instruction>) {
        // Each instruction decoded where it is kept, the decoder moved only where the block starts.
        into.clear();
        into.resize(count as usize, Instruction::default());
        let o = start.wrapping_sub(self.base);
        if o < self.decoder.max_position() as u64 { let _ = self.decoder.set_position(o as usize); self.decoder.set_ip(start); }
        let mut at = start;
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

// ---- The registers ----

/// The general registers the lowering names itself, by number.
pub(crate) const RAX: u32 = 0;
pub(crate) const RCX: u32 = 1;
pub(crate) const RDX: u32 = 2;
pub(crate) const RSP: u32 = 4;
pub(crate) const RBP: u32 = 5;
pub(crate) const RSI: u32 = 6;
pub(crate) const RDI: u32 = 7;

#[derive(Clone, Copy)]
pub(crate) enum Part { Full, Low32, Low16, Low8, High8 }

/// The general register `r` is (or is part of), by its number, and which part.
pub(crate) fn gpr(r: Register) -> Option<(u32, Part)> {
    let high = matches!(r, Register::AH | Register::CH | Register::DH | Register::BH);
    if high {
        let n = match r { Register::AH => 0, Register::CH => 1, Register::DH => 2, _ => 3 };
        return Some((n, Part::High8));
    }
    let full = r.full_register();
    if !(Register::RAX as u32..=Register::R15 as u32).contains(&(full as u32)) { return None; }
    let n = full as u32 - Register::RAX as u32;
    let part = match r.size() { 8 => Part::Full, 4 => Part::Low32, 2 => Part::Low16, _ => Part::Low8 };
    Some((n, part))
}

/// The vector register `r` is, by its number.
pub(crate) fn xmm(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::XMM0 as u32..=Register::XMM15 as u32).contains(&n).then(|| n - Register::XMM0 as u32)
}

/// The x87 register `r` is, from the top of its stack.
pub(crate) fn st(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::ST0 as u32..=Register::ST7 as u32).contains(&n).then(|| n - Register::ST0 as u32)
}

/// The bit of a register a summary keeps (a vector register by its own number: iced's full register of an xmm is its
/// zmm).
pub(crate) fn bit(r: Register) -> Option<u32> {
    let n = r as u32;
    for first in [Register::XMM0, Register::YMM0, Register::ZMM0] {
        let first = first as u32;
        if (first..first + 16).contains(&n) { return Some(16 + n - first); }
    }
    let full = r.full_register() as u32;
    (Register::RAX as u32..=Register::R15 as u32).contains(&full).then(|| full - Register::RAX as u32)
}
