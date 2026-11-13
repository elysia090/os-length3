//! An x86-64 instruction as sods reads it: decoded from the program's own bytes (the decoder is iced's, taken in
//! here and nowhere else), what its code alone says of it (where it goes on, the flags it reads and writes), and the
//! registers it names, as the lowering numbers them.

use crate::elf::Elf;
pub use iced_x86::{ConditionCode, Instruction, InstructionInfoFactory, Mnemonic, OpAccess, OpKind, Register, RflagsBits};
pub(crate) use iced_x86::{Decoder, DecoderOptions};
use iced_x86::FlowControl;
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};

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
pub(crate) fn runs_on(i: &Instruction) -> bool { kinds().word(i) & 7 == go::NEXT as u32 }

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
/// bits. Worked out once for a code, so an instruction is one look-up, not one walk of iced's tables per question.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Kind { pub flow: u8, pub reads: u8, pub writes: u8, pub bits: u8 }

/// Every way an instruction reads and writes the flags kept (read, written): what iced says of each of its codes,
/// and of each as its operands change it (the test asks them all). An instruction's way is its place here.
const WAYS: [(u8, u8); 24] = [
    (0x00, 0x00), (0x00, 0x04), (0x00, 0x10), (0x00, 0x11), (0x00, 0x27), (0x00, 0x33), (0x00, 0x36), (0x00, 0x37),
    (0x01, 0x00), (0x01, 0x01), (0x02, 0x00), (0x03, 0x00), (0x04, 0x00), (0x07, 0x00), (0x10, 0x00), (0x10, 0x10),
    (0x10, 0x11), (0x10, 0x37), (0x11, 0x11), (0x14, 0x00), (0x20, 0x00), (0x36, 0x00), (0x37, 0x00), (0x37, 0x37),
];
fn way(reads: u8, writes: u8) -> u8 { WAYS.iter().position(|&w| w == (reads, writes)).expect("every way with the flags is listed") as u8 }

/// An instruction's class: its way with the flags, and whether it goes out to the kernel; six bits (find.rs keeps
/// one for each instruction it has decoded).
pub(crate) const CLASS_TRAPS: u8 = 32;
/// What class `c` says: the flags read, those written, and TRAPS or nothing.
#[inline(always)]
pub(crate) fn of_class(c: u8) -> [u8; 3] { let (r, w) = WAYS[(c & 31) as usize % WAYS.len()]; [r, w, if c & CLASS_TRAPS != 0 { TRAPS } else { 0 }] }

/// Every code's Kind, each worked out the first time an instruction of that code is met: a program has a few hundred
/// of iced's thousands, and working one out asks iced seven times. A code's word is its flow, its way with the
/// flags, its reads, its writes and its bits; nothing while it is not worked out.
pub(crate) struct Kinds { of: Vec<AtomicU32> }
const KNOWN: u32 = 1 << 31;

impl Kinds {
    #[inline(always)]
    fn word(&self, i: &Instruction) -> u32 {
        let w = self.of[i.code() as usize].load(Relaxed);
        if w != 0 { w } else { self.learn(i.code()) }
    }
    #[cold]
    #[inline(never)]
    fn learn(&self, code: iced_x86::Code) -> u32 {
        let k = kind_of(code);
        let w = KNOWN | k.flow as u32 | (way(k.reads, k.writes) as u32) << 3 | (k.reads as u32) << 8 | (k.writes as u32) << 16 | (k.bits as u32) << 24;
        self.of[code as usize].store(w, Relaxed);
        w
    }
    /// `i`'s Kind, and its class.
    #[inline(always)]
    pub(crate) fn kind_class(&self, i: &Instruction) -> (Kind, u8) {
        let w = self.word(i);
        let k = Kind { flow: (w & 7) as u8, reads: (w >> 8) as u8, writes: (w >> 16) as u8, bits: (w >> 24 & 0x7f) as u8 };
        let traps = if k.bits & TRAPS != 0 { CLASS_TRAPS } else { 0 };
        if k.bits & OPERANDS == 0 { (k, (w >> 3 & 31) as u8 | traps) } else { let k = by_operands(i, k); (k, way(k.reads, k.writes) | traps) }
    }
    /// `i`'s Kind.
    #[inline(always)]
    pub(crate) fn kind(&self, i: &Instruction) -> Kind { self.kind_class(i).0 }
}

/// `i`'s Kind.
#[inline(always)]
pub(crate) fn kind(i: &Instruction) -> Kind { kinds().kind(i) }
#[cold]
#[inline(never)]
fn by_operands(i: &Instruction, k: Kind) -> Kind { Kind { reads: read_by(i), writes: written_by(i), ..k } }
fn read_by(i: &Instruction) -> u8 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { (i.rflags_read() & ALL_FLAGS) as u8 } }
fn written_by(i: &Instruction) -> u8 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { (i.rflags_modified() & ALL_FLAGS) as u8 } }

#[inline(always)]
pub(crate) fn kinds() -> &'static Kinds {
    static KINDS: std::sync::OnceLock<Kinds> = std::sync::OnceLock::new();
    KINDS.get_or_init(|| Kinds { of: iced_x86::Code::values().map(|_| AtomicU32::new(0)).collect() })
}

/// A shift, a rotate or a double shift counted by cl: by 0 it leaves every flag as it was, so the flags it writes
/// are flags it reads (what made them before is still wanted).
fn counted_by_cl(code: iced_x86::Code) -> bool { format!("{code:?}").ends_with("_CL") }

/// What iced says of the flags an instruction of `code` reads and writes: as it is, then with each immediate and
/// each pair of registers that may change it. (One counted by cl reads what it writes: counted_by_cl.)
fn said(code: iced_x86::Code) -> [(u8, u8); 7] {
    let mut i = Instruction::default();
    i.set_code(code);
    let by_cl = counted_by_cl(code);
    let flags = |i: &Instruction| { let (r, w) = (read_by(i), written_by(i)); (if by_cl { r | w } else { r }, w) };
    let with = |imm: u8| { let mut j = i; j.set_immediate8(imm); flags(&j) };
    let mut j = i;
    j.set_op0_kind(OpKind::Register);
    j.set_op1_kind(OpKind::Register);
    j.set_op0_register(Register::RAX);
    j.set_op1_register(Register::RAX);
    let same = flags(&j);
    j.set_op1_register(Register::RCX);
    [flags(&i), with(1), with(2), with(9), with(17), same, flags(&j)]
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
    let said = said(code);
    let (base, operands) = (said[0], said.iter().any(|&f| f != said[0]));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every way iced says an instruction reads and writes the flags kept has its place in WAYS, and nothing else has.
    #[test]
    fn every_way_with_the_flags_is_listed() {
        let mut met = [false; WAYS.len()];
        for code in iced_x86::Code::values() { for (r, w) in said(code) { met[way(r, w) as usize] = true; } }
        assert!(met.iter().all(|&m| m), "a way no instruction has: {met:?}");
    }
}
