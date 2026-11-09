//! What each x86-64 instruction means, lowered on the kernel's Fx (kernel.rs): its operands read and written with
//! x86's partial-register rules, memory accessed at guest address = wasm address, flags deferred (a producer records
//! its operands, a consumer evaluates only the condition it needs), SSE on v128, the x87 in the coprocessor (x87.rs).

use crate::kernel::*;
use crate::op::*;
use iced_x86::{ConditionCode, Instruction, Mnemonic, OpKind, Register, RflagsBits};
use std::collections::BTreeMap;

/// CF, ZF, SF, OF and PF: each with its RflagsBits mask, its local and its bit in G_FLAGS.
pub const FLAG_BITS: [(Flag, u32, u32); 5] = [
    (Flag::C, RflagsBits::CF, L_CF), (Flag::Z, RflagsBits::ZF, L_ZF), (Flag::S, RflagsBits::SF, L_SF),
    (Flag::O, RflagsBits::OF, L_OF), (Flag::P, RflagsBits::PF, L_PF),
];

const RAX: u32 = 0;
const RCX: u32 = 1;
const RDX: u32 = 2;
const RSP: u32 = 4;
const RBP: u32 = 5;
const RSI: u32 = 6;
const RDI: u32 = 7;

/// An offset and alignment for an access to memory 0.
fn mem_at(offset: u64, align: u32) -> (u64, u32) { (offset, align) }

fn mask(size: u8) -> i64 { if size >= 8 { -1 } else { (1i64 << (size as u32 * 8)) - 1 } }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flags {
    /// Flags are in the CF/ZF/SF/OF/PF locals.
    Held,
    Sub(u8),
    Add(u8),
    Logic(u8),
    /// Like Add/Sub with operand 1, but CF lives in its local.
    Inc(u8),
    Dec(u8),
}

#[derive(Clone, Copy)]
pub enum Flag { C, Z, S, O, P }

#[derive(Default, Debug)]
pub struct Report {
    pub functions: usize,
    pub blocks: usize,
    pub instructions: usize,
    pub entries: usize,
    /// Mnemonics lowered to a trap, with how often they appear.
    pub unsupported: BTreeMap<String, usize>,
}

#[derive(Clone, Copy)]
enum Part { Full, Low32, Low16, Low8, High8 }

fn gpr(r: Register) -> Option<(u32, Part)> {
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

fn xmm(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::XMM0 as u32..=Register::XMM15 as u32).contains(&n).then(|| n - Register::XMM0 as u32)
}

impl Fx<'_> {
    pub(crate) fn unsupported(&mut self, i: &Instruction) {
        *self.report.unsupported.entry(format!("{:?}", i.mnemonic())).or_default() += 1;
        self.c64(i.ip() as i64);
        self.c32(TRAP_UNSUPPORTED);
        self.call(F_TRAP);
        self.e(UNREACHABLE);
    }

    pub(crate) fn zext32(&mut self) { self.e(I32_WRAP_I64); self.e(I64_EXTEND_I32_U); }

    /// Push a register's value, zero-extended from its width.
    pub(crate) fn read_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        self.get(l_reg(n));
        match part {
            Part::Full => {}
            Part::Low32 => self.zext32(),
            Part::Low16 => { self.c64(0xffff); self.e(I64_AND); }
            Part::Low8 => { self.c64(0xff); self.e(I64_AND); }
            Part::High8 => { self.c64(8); self.e(I64_SHR_U); self.c64(0xff); self.e(I64_AND); }
        }
        true
    }

    /// Pop an i64 and write it with x86 partial-register rules: 32-bit
    /// writes zero the upper half, 8/16-bit writes merge.
    pub(crate) fn write_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        let l = l_reg(n);
        match part {
            Part::Full => self.set(l),
            Part::Low32 => { self.zext32(); self.set(l); }
            Part::Low16 | Part::Low8 | Part::High8 => {
                let (m, shift) = match part { Part::Low16 => (0xffffi64, 0), Part::Low8 => (0xff, 0), _ => (0xff, 8) };
                self.c64(m); self.e(I64_AND);
                if shift > 0 { self.c64(shift); self.e(I64_SHL); }
                self.get(l); self.c64(!(m << shift)); self.e(I64_AND);
                self.e(I64_OR);
                self.set(l);
            }
        }
        if n == RSP && !std::mem::take(&mut self.rsp_up) { self.note_low(); }
        true
    }

    /// low = min(low, rsp) (G_LOW): a read and a compare, and a store only at a new low (rarely, once a thread's
    /// stack has been as deep once), not a select stored at every call.
    pub(crate) fn note_low(&mut self) {
        self.get(l_reg(RSP)); self.gget(G_LOW); self.e(I64_LT_U);
        self.if_();
        self.get(l_reg(RSP)); self.gset(G_LOW);
        self.end();
    }

    // ---- Memory operands ----

    /// Push the effective address as i64 (no segment base unless `segment`).
    pub(crate) fn effective(&mut self, i: &Instruction, segment: bool) {
        self.effective_from(i, segment, false, false);
    }

    /// The effective address, less what is returned: with `split`, a small
    /// positive displacement is left for the load or store to add itself (its
    /// offset), so it costs no instruction. The rest of the sum wraps at 4 GiB
    /// before the offset is added, so it must not be negative: it is only if
    /// the address is below the displacement, and under 64 KiB nothing is
    /// ever mapped (Linux's mmap_min_addr), so such an access faults either way.
    /// A large displacement (an absolute address, with a negative index
    /// counting up to it) stays in the sum.
    ///
    /// With `narrow`, the sum is an i32: memory's index, which is the sum's low
    /// 32 bits whether they are taken before adding or after (a wrap is a ring's
    /// map), so each register's low half is added in 32 bits and nothing is left
    /// to wrap. An optimizing compile makes that one 32-bit lea (its result
    /// zero-extended as it is), where the 64-bit sum was a lea and a mov that
    /// cleared its high half, at every access.
    pub(crate) fn effective_from(&mut self, i: &Instruction, segment: bool, split: bool, narrow: bool) -> u64 {
        let base = i.memory_base();
        let disp = i.memory_displacement64() as i64;
        let mut offset = 0;
        let add = if narrow { I32_ADD } else { I64_ADD };
        let cst = |fx: &mut Self, v: i64| if narrow { fx.c32(v as i32) } else { fx.c64(v) };
        let term = |fx: &mut Self, r: Register| {
            match gpr(r) {
                Some((n, _)) if narrow => { fx.get(l_reg(n)); fx.e(I32_WRAP_I64); }
                _ => { fx.read_reg(r); }
            }
        };
        if base == Register::RIP || base == Register::EIP {
            cst(self, disp);
        } else {
            let index = i.memory_index();
            let registers = base != Register::None || index != Register::None;
            // A 32-bit address (addr32) wraps at 4 GiB as x86 has it, so its displacement stays in the sum.
            let wide = [base, index].iter().all(|r| *r == Register::None || r.size() == 8);
            if split && registers && wide && (1..1 << 16).contains(&disp) { offset = disp as u64; }
            // A displacement of nothing is not added.
            let mut first = true;
            if !registers || disp - offset as i64 != 0 { cst(self, disp - offset as i64); first = false; }
            if base != Register::None {
                term(self, base);
                if !first { self.e(add); }
                first = false;
            }
            if index != Register::None {
                term(self, index);
                let scale = i.memory_index_scale();
                if scale > 1 {
                    cst(self, scale.trailing_zeros() as i64);
                    self.e(if narrow { I32_SHL } else { I64_SHL });
                }
                if !first { self.e(add); }
            }
        }
        if segment && i.memory_segment() == Register::FS {
            self.gget(G_FS);
            if narrow { self.e(I32_WRAP_I64); }
            self.e(add);
        }
        offset
    }

    pub(crate) fn address(&mut self, i: &Instruction) {
        self.effective_from(i, true, false, true);
    }

    /// The address for a load or store of operand memory, and the offset that load or store adds.
    pub(crate) fn place(&mut self, i: &Instruction) -> u64 {
        self.effective_from(i, true, true, true)
    }

    pub(crate) fn load_sized(&mut self, size: u8) { self.load_at(size, 0) }
    pub(crate) fn store_sized(&mut self, size: u8) { self.store_at(size, 0) }

    pub(crate) fn load_at(&mut self, size: u8, offset: u64) {
        let m = mem_at(offset, 0);
        self.e(match size {
            1 => Mem(I64_LOAD8_U, m.1, m.0),
            2 => Mem(I64_LOAD16_U, m.1, m.0),
            4 => Mem(I64_LOAD32_U, m.1, m.0),
            _ => Mem(I64_LOAD, m.1, m.0),
        });
    }

    pub(crate) fn store_at(&mut self, size: u8, offset: u64) {
        let m = mem_at(offset, 0);
        self.e(match size {
            1 => Mem(I64_STORE8, m.1, m.0),
            2 => Mem(I64_STORE16, m.1, m.0),
            4 => Mem(I64_STORE32, m.1, m.0),
            _ => Mem(I64_STORE, m.1, m.0),
        });
    }

    pub(crate) fn size(i: &Instruction, n: u32) -> u8 {
        match i.op_kind(n) {
            OpKind::Register => i.op_register(n).size() as u8,
            OpKind::Memory => i.memory_size().size() as u8,
            _ if n > 0 => Self::size(i, 0),
            OpKind::Immediate8 => 1,
            OpKind::Immediate16 | OpKind::Immediate8to16 => 2,
            OpKind::Immediate32 | OpKind::Immediate8to32 => 4,
            _ => 8,
        }
    }

    /// Push operand `n` zero-extended to i64 at `size` bytes.
    pub(crate) fn read(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
        match i.op_kind(n) {
            OpKind::Register => self.read_reg(i.op_register(n)),
            OpKind::Memory => { let at = self.place(i); self.load_at(size, at); true }
            OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate64
            | OpKind::Immediate8to16 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64
            | OpKind::Immediate8_2nd => {
                self.c64((i.immediate(n) as i64) & mask(size));
                true
            }
            _ => false,
        }
    }

    /// Write the value in local `from` to operand `n`.
    pub(crate) fn write(&mut self, i: &Instruction, n: u32, size: u8, from: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => { self.get(from); self.write_reg(i.op_register(n)) }
            OpKind::Memory => { let at = self.place(i); self.get(from); self.store_at(size, at); true }
            _ => false,
        }
    }

    pub(crate) fn sign_extend(&mut self, size: u8) {
        match size {
            1 => self.e(I64_EXTEND8_S),
            2 => self.e(I64_EXTEND16_S),
            4 => self.e(I64_EXTEND32_S),
            _ => {}
        }
    }

    pub(crate) fn mask_to(&mut self, size: u8) {
        if size < 8 {
            self.c64(mask(size));
            self.e(I64_AND);
        }
    }

    pub(crate) fn push_value(&mut self, from: u32) {
        self.push_with(|fx| { fx.get(from); true });
    }

    /// Push what `value` puts on the stack, made after rsp moved (so it must not read rsp).
    pub(crate) fn push_with(&mut self, value: impl FnOnce(&mut Self) -> bool) -> bool {
        self.get(l_reg(RSP)); self.c64(8); self.e(I64_SUB); self.tee(l_reg(RSP));
        self.e(I32_WRAP_I64);
        if !value(self) { return false; }
        self.e(Mem(I64_STORE, 3, 0));
        true
    }

    /// Write a value known now to a register: a full or 32-bit one takes it as it is.
    pub(crate) fn write_reg_known(&mut self, r: Register, value: i64) -> bool {
        match gpr(r) {
            Some((n, Part::Full)) => { self.c64(value); self.set(l_reg(n)); true }
            Some((n, Part::Low32)) => { self.c64(value & 0xffff_ffff); self.set(l_reg(n)); true }
            Some(_) => { self.c64(value); self.write_reg(r) }
            None => false,
        }
    }

    /// Put what `value` pushes into operand 0 (a register, or memory whose address is taken first).
    pub(crate) fn assign(&mut self, i: &Instruction, size: u8, value: impl FnOnce(&mut Self) -> bool) -> bool {
        match i.op0_kind() {
            OpKind::Register => value(self) && self.write_reg(i.op0_register()),
            OpKind::Memory => { let at = self.place(i); value(self) && { self.store_at(size, at); true } }
            _ => false,
        }
    }

    /// Whether the instruction's operand `n` reads rsp (as the register or in its address).
    pub(crate) fn uses_rsp(i: &Instruction, n: u32) -> bool {
        let rsp = |r: Register| r.full_register() == Register::RSP;
        match i.op_kind(n) {
            OpKind::Register => rsp(i.op_register(n)),
            OpKind::Memory => rsp(i.memory_base()) || rsp(i.memory_index()),
            _ => false,
        }
    }

    pub(crate) fn pop_value(&mut self, into: u32) {
        self.get(l_reg(RSP)); self.e(I32_WRAP_I64); self.e(Mem(I64_LOAD, 3, 0)); self.set(into);
        self.get(l_reg(RSP)); self.c64(8); self.e(I64_ADD); self.set(l_reg(RSP));
    }

    // ---- Flags ----

    /// Every change of the flag state goes through here, so a pending result never outlives its compare.
    pub(crate) fn set_flags(&mut self, state: Flags) {
        self.flags = state;
        self.fr_pending = false;
    }

    /// Push the deferred result (L_FR), making it from the operands if a compare left it unmade.
    pub(crate) fn fr(&mut self) {
        if let (true, Flags::Sub(size)) = (self.fr_pending, self.flags) {
            self.get(L_FA); self.get(L_FB); self.e(I64_SUB); self.mask_to(size);
        } else {
            self.get(L_FR);
        }
    }

    pub(crate) fn sign_bit(&mut self, local: u32, size: u8) {
        if local == L_FR { self.fr(); } else { self.get(local); }
        self.c64(size as i64 * 8 - 1);
        self.e(I64_SHR_U);
        self.c64(1);
        self.e(I64_AND);
        self.e(I32_WRAP_I64);
    }

    /// Push one flag of the current state as i32 0/1.
    pub(crate) fn flag(&mut self, f: Flag) {
        let state = self.flags;
        let (kind, size) = match state {
            Flags::Held => {
                self.get(match f { Flag::C => L_CF, Flag::Z => L_ZF, Flag::S => L_SF, Flag::O => L_OF, Flag::P => L_PF });
                return;
            }
            Flags::Sub(s) => (0, s),
            Flags::Add(s) => (1, s),
            Flags::Logic(s) => (2, s),
            Flags::Inc(s) => (3, s),
            Flags::Dec(s) => (4, s),
        };
        match f {
            Flag::Z => { self.fr(); self.e(I64_EQZ); }
            Flag::S => self.sign_bit(L_FR, size),
            Flag::P => {
                self.fr(); self.c64(0xff); self.e(I64_AND); self.e(I64_POPCNT);
                self.c64(1); self.e(I64_AND); self.e(I64_EQZ);
            }
            Flag::C => match kind {
                0 => { self.get(L_FA); self.get(L_FB); self.e(I64_LT_U); }
                1 => { self.fr(); self.get(L_FA); self.e(I64_LT_U); }
                2 => self.c32(0),
                _ => self.get(L_CF),
            },
            Flag::O => match kind {
                0 | 4 => {
                    // (a ^ b) & (a ^ r), sign bit
                    self.get(L_FA); self.get(L_FB); self.e(I64_XOR);
                    self.get(L_FA); self.fr(); self.e(I64_XOR);
                    self.e(I64_AND); self.set(l_t(4));
                    self.sign_bit(l_t(4), size);
                }
                1 | 3 => {
                    self.get(L_FA); self.get(L_FR); self.e(I64_XOR);
                    self.get(L_FB); self.get(L_FR); self.e(I64_XOR);
                    self.e(I64_AND); self.set(l_t(4));
                    self.sign_bit(l_t(4), size);
                }
                _ => self.c32(0),
            },
        }
    }

    pub(crate) fn hold_flags(&mut self) {
        if self.flags == Flags::Held {
            return;
        }
        // Compute every flag before overwriting any local the state reads.
        for (f, l) in [(Flag::Z, L_ZF), (Flag::S, L_SF), (Flag::O, L_OF), (Flag::P, L_PF), (Flag::C, L_CF)] {
            self.flag(f);
            self.set(l);
        }
        self.set_flags(Flags::Held);
    }

    /// Push the truth of condition `cc` as i32.
    /// Operand `n` of `i` as an i32, zero-extended from `size` (4 bytes or fewer).
    pub(crate) fn read32(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match gpr(i.op_register(n)) {
                Some((k, Part::Full | Part::Low32)) => { self.get(l_reg(k)); self.e(I32_WRAP_I64); true }
                Some(_) => { self.read_reg(i.op_register(n)); self.e(I32_WRAP_I64); true }
                None => false,
            },
            OpKind::Memory => {
                let at = self.place(i);
                self.e(match size { 1 => Mem(I32_LOAD8_U, 0, at), 2 => Mem(I32_LOAD16_U, 0, at), _ => Mem(I32_LOAD, 0, at) });
                true
            }
            OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate8to16 | OpKind::Immediate8to32 => {
                self.c32((i.immediate(n) as i64 & mask(size)) as i32);
                true
            }
            _ => false,
        }
    }

    /// Whether a compare's flags can be its next instruction's condition `cc` alone (fused): cmp of all but the
    /// overflow and parity conditions, test of all but parity.
    pub(crate) fn fusable(i: &Instruction, cc: ConditionCode) -> bool {
        use ConditionCode as C;
        let plain = |n: u32| matches!(i.op_kind(n), OpKind::Register | OpKind::Memory | OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32
            | OpKind::Immediate8to16 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64)
            && (i.op_kind(n) != OpKind::Register || gpr(i.op_register(n)).is_some());
        let ops = i.op_count() == 2 && plain(0) && plain(1);
        match i.mnemonic() {
            Mnemonic::Cmp => ops && !matches!(cc, C::o | C::no | C::p | C::np | C::None),
            Mnemonic::Test => ops && !matches!(cc, C::p | C::np | C::None),
            _ => false,
        }
    }

    /// A fused compare's condition: its operands compared as `cc` asks, at its width (in i32 at 4 bytes or fewer).
    pub(crate) fn fused_condition(&mut self, i: &Instruction, cc: ConditionCode) {
        use ConditionCode as C;
        let size = Self::size(i, 0);
        let narrow = size <= 4;
        let signed = matches!(cc, C::l | C::ge | C::le | C::g | C::s | C::ns);
        let operand = |fx: &mut Self, n: u32| {
            if narrow {
                fx.read32(i, n, size);
                if signed && size < 4 { fx.e(if size == 1 { I32_EXTEND8_S } else { I32_EXTEND16_S }); }
            } else {
                fx.read(i, n, size);
            }
        };
        let (eq, ne, lt_u, ge_u, le_u, gt_u, lt_s, ge_s, le_s, gt_s) = if narrow {
            (I32_EQ, I32_NE, I32_LT_U, I32_GE_U, I32_LE_U, I32_GT_U, I32_LT_S, I32_GE_S, I32_LE_S, I32_GT_S)
        } else {
            (I64_EQ, I64_NE, I64_LT_U, I64_GE_U, I64_LE_U, I64_GT_U, I64_LT_S, I64_GE_S, I64_LE_S, I64_GT_S)
        };
        let zero = |fx: &mut Self| if narrow { fx.c32(0) } else { fx.c64(0) };
        if i.mnemonic() == Mnemonic::Cmp {
            operand(self, 0);
            operand(self, 1);
            match cc {
                C::e => self.e(eq), C::ne => self.e(ne),
                C::b => self.e(lt_u), C::ae => self.e(ge_u), C::be => self.e(le_u), C::a => self.e(gt_u),
                C::l => self.e(lt_s), C::ge => self.e(ge_s), C::le => self.e(le_s), C::g => self.e(gt_s),
                // The sign of the difference at the compare's width.
                _ => {
                    self.e(if narrow { I32_SUB } else { I64_SUB });
                    if signed && size < 4 { self.e(if size == 1 { I32_EXTEND8_S } else { I32_EXTEND16_S }); }
                    zero(self);
                    self.e(if cc == C::s { lt_s } else { ge_s });
                }
            }
            return;
        }
        // test: the and of its operands, with CF and OF clear.
        operand(self, 0);
        operand(self, 1);
        self.e(if narrow { I32_AND } else { I64_AND });
        match cc {
            C::e | C::be => { zero(self); self.e(eq); }
            C::ne | C::a => { zero(self); self.e(ne); }
            C::s | C::l => { zero(self); self.e(lt_s); }
            C::ns | C::ge => { zero(self); self.e(ge_s); }
            C::le => { zero(self); self.e(le_s); }
            C::g => { zero(self); self.e(gt_s); }
            C::b | C::o => { self.e(DROP); self.c32(0); }
            _ => { self.e(DROP); self.c32(1); }
        }
    }

    pub(crate) fn condition(&mut self, cc: ConditionCode) {
        use ConditionCode as C;
        if let Some(i) = self.fused.take() { self.fused_condition(&i, cc); return; }
        if let Flags::Sub(size) = self.flags {
            let signed = matches!(cc, C::l | C::ge | C::le | C::g);
            let op = match cc {
                C::e => Some(I64_EQ), C::ne => Some(I64_NE),
                C::b => Some(I64_LT_U), C::ae => Some(I64_GE_U), C::be => Some(I64_LE_U), C::a => Some(I64_GT_U),
                C::l => Some(I64_LT_S), C::ge => Some(I64_GE_S), C::le => Some(I64_LE_S), C::g => Some(I64_GT_S),
                _ => None,
            };
            if let Some(op) = op {
                self.get(L_FA);
                if signed { self.sign_extend(size); }
                self.get(L_FB);
                if signed { self.sign_extend(size); }
                self.e(op);
                return;
            }
        }
        if let Flags::Logic(size) = self.flags {
            match cc {
                C::e => { self.fr(); self.e(I64_EQZ); return; }
                C::ne => { self.fr(); self.c64(0); self.e(I64_NE); return; }
                C::s | C::l => { self.sign_bit(L_FR, size); return; }
                C::ns | C::ge => { self.sign_bit(L_FR, size); self.e(I32_EQZ); return; }
                C::le | C::g => {
                    self.fr(); if size < 8 { self.sign_extend(size); } self.c64(0);
                    self.e(if cc == C::le { I64_LE_S } else { I64_GT_S });
                    return;
                }
                _ => {}
            }
        }
        match cc {
            C::o => self.flag(Flag::O),
            C::no => { self.flag(Flag::O); self.e(I32_EQZ); }
            C::b => self.flag(Flag::C),
            C::ae => { self.flag(Flag::C); self.e(I32_EQZ); }
            C::e => self.flag(Flag::Z),
            C::ne => { self.flag(Flag::Z); self.e(I32_EQZ); }
            C::be => { self.flag(Flag::C); self.flag(Flag::Z); self.e(I32_OR); }
            C::a => { self.flag(Flag::C); self.flag(Flag::Z); self.e(I32_OR); self.e(I32_EQZ); }
            C::s => self.flag(Flag::S),
            C::ns => { self.flag(Flag::S); self.e(I32_EQZ); }
            C::p => self.flag(Flag::P),
            C::np => { self.flag(Flag::P); self.e(I32_EQZ); }
            C::l => { self.flag(Flag::S); self.flag(Flag::O); self.e(I32_NE); }
            C::ge => { self.flag(Flag::S); self.flag(Flag::O); self.e(I32_EQ); }
            C::le => { self.flag(Flag::Z); self.flag(Flag::S); self.flag(Flag::O); self.e(I32_NE); self.e(I32_OR); }
            C::g => {
                self.flag(Flag::Z); self.e(I32_EQZ);
                self.flag(Flag::S); self.flag(Flag::O); self.e(I32_EQ);
                self.e(I32_AND);
            }
            C::None => self.c32(1),
        }
    }

    /// Record a deferred producer: a, b already in L_FA/L_FB, result in L_FR.
    pub(crate) fn defer(&mut self, state: Flags) {
        self.set_flags(state);
    }

}

// ---- Instruction semantics ----

impl Fx<'_> {
    /// add, sub, cmp, and, test, or, xor. What is kept for the flags is only
    /// what a later instruction reads (`need`): nothing when none does; the
    /// result alone for a logic op, whose flags all come from it; the two
    /// operands for a compare, whose result most conditions never ask for.
    pub(crate) fn binary(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
        let size = Self::size(i, 0);
        let (wasm, state, write) = match op {
            Mnemonic::Add => (I64_ADD, Flags::Add(size), true),
            Mnemonic::Sub => (I64_SUB, Flags::Sub(size), true),
            Mnemonic::Cmp => (I64_SUB, Flags::Sub(size), false),
            Mnemonic::And => (I64_AND, Flags::Logic(size), true),
            Mnemonic::Test => (I64_AND, Flags::Logic(size), false),
            Mnemonic::Or => (I64_OR, Flags::Logic(size), true),
            Mnemonic::Xor => (I64_XOR, Flags::Logic(size), true),
            _ => return false,
        };
        let memory = i.op0_kind() == OpKind::Memory;
        if !need && !write {
            // Nothing reads what it sets; only a read that may fault is kept.
            if memory { let at = self.place(i); self.load_at(size, at); self.e(DROP); }
            return true;
        }
        // The destination's address once, kept for the store.
        let mut at = 0;
        if memory && write { at = self.place(i); self.tee_raw(l_u(0)); self.get_raw(l_u(0)); self.load_at(size, at); } else if !self.read(i, 0, size) { return false; }
        let logic = matches!(state, Flags::Logic(_));
        if need && !logic {
            self.set(L_FA);
            if !self.read(i, 1, size) { return false; }
            self.set(L_FB);
            self.set_flags(state);
            if !write { self.fr_pending = true; return true; }
            self.get(L_FA); self.get(L_FB);
        } else if !self.read(i, 1, size) { return false; }
        self.e(wasm);
        if need {
            // The flags read the result at its width; a store or register write masks it anyway.
            self.mask_to(size);
            if write { self.tee_raw(L_FR); } else { self.set(L_FR); }
            self.set_flags(state);
            if !write { return true; }
        } else {
            self.set_flags(Flags::Held);
        }
        if memory { self.store_at(size, at); true } else {
            // A frame let go (add rsp, n at a function's end) is no new low.
            let up = i.op0_register() == Register::RSP && matches!(i.op1_kind(), OpKind::Immediate8to64 | OpKind::Immediate32to64)
                && match op { Mnemonic::Add => i.immediate(1) as i64 >= 0, Mnemonic::Sub => i.immediate(1) as i64 <= 0, _ => false };
            self.rsp_up = up;
            self.write_reg(i.op0_register())
        }
    }

    pub(crate) fn carry(&mut self, i: &Instruction, subtract: bool) -> bool {
        let size = Self::size(i, 0);
        self.flag(Flag::C); self.e(I64_EXTEND_I32_U); self.set(l_t(1));
        if !self.read(i, 0, size) { return false; }
        self.set(L_FA);
        if !self.read(i, 1, size) { return false; }
        self.set(L_FB);
        self.get(L_FA); self.get(L_FB);
        self.e(if subtract { I64_SUB } else { I64_ADD });
        self.get(l_t(1));
        self.e(if subtract { I64_SUB } else { I64_ADD });
        self.mask_to(size); self.set(L_FR);
        // CF: with carry-in the comparison includes equality.
        if subtract {
            self.get(L_FA); self.get(L_FB); self.e(I64_LE_U);
            self.get(L_FA); self.get(L_FB); self.e(I64_LT_U);
        } else {
            self.get(L_FR); self.get(L_FA); self.e(I64_LE_U);
            self.get(L_FR); self.get(L_FA); self.e(I64_LT_U);
        }
        self.get(l_t(1)); self.e(I32_WRAP_I64);
        self.e(SELECT);
        self.set(l_u(0));
        self.set_flags(if subtract { Flags::Sub(size) } else { Flags::Add(size) });
        for (f, l) in [(Flag::Z, L_ZF), (Flag::S, L_SF), (Flag::O, L_OF), (Flag::P, L_PF)] {
            self.flag(f);
            self.set(l);
        }
        self.get(l_u(0)); self.set(L_CF);
        self.set_flags(Flags::Held);
        self.write(i, 0, size, L_FR)
    }

    pub(crate) fn unary(&mut self, i: &Instruction, op: Mnemonic) -> bool {
        let size = Self::size(i, 0);
        if matches!(op, Mnemonic::Inc | Mnemonic::Dec) {
            // CF survives: capture it before the deferred operands change.
            if !matches!(self.flags, Flags::Held | Flags::Inc(_) | Flags::Dec(_)) {
                self.flag(Flag::C);
                self.set(L_CF);
            }
        }
        if !self.read(i, 0, size) { return false; }
        match op {
            Mnemonic::Not => {
                self.c64(mask(size)); self.e(I64_XOR); self.set(l_t(1));
                return self.write(i, 0, size, l_t(1));
            }
            Mnemonic::Neg => {
                self.set(L_FB); self.c64(0); self.set(L_FA);
                self.c64(0); self.get(L_FB); self.e(I64_SUB);
                self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Sub(size));
            }
            Mnemonic::Inc => {
                self.set(L_FA); self.c64(1); self.set(L_FB);
                self.get(L_FA); self.c64(1); self.e(I64_ADD); self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Inc(size));
            }
            Mnemonic::Dec => {
                self.set(L_FA); self.c64(1); self.set(L_FB);
                self.get(L_FA); self.c64(1); self.e(I64_SUB); self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Dec(size));
            }
            _ => return false,
        }
        self.write(i, 0, size, L_FR)
    }

    pub(crate) fn shift(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        let count_mask = if size == 8 { 63 } else { 31 };
        if !self.read(i, 0, size) { return false; }
        self.set(l_t(1));
        // Count: immediate, CL, or the implicit 1 of the short form.
        let constant = match i.op1_kind() {
            OpKind::Register => { self.read_reg(Register::CL); None }
            OpKind::Immediate8 => { let c = i.immediate8() as i64 & count_mask; self.c64(c); Some(c) }
            _ => { self.c64(1); Some(1) }
        };
        self.c64(count_mask); self.e(I64_AND); self.set(l_t(2));
        if constant == Some(0) {
            return true;
        }
        // Rotates of sub-64-bit values are done on a replicated value.
        match op {
            Mnemonic::Shl | Mnemonic::Sal => { self.get(l_t(1)); self.get(l_t(2)); self.e(I64_SHL); self.mask_to(size); }
            Mnemonic::Shr => { self.get(l_t(1)); self.get(l_t(2)); self.e(I64_SHR_U); }
            Mnemonic::Sar => {
                self.get(l_t(1)); self.sign_extend(size); self.get(l_t(2)); self.e(I64_SHR_S); self.mask_to(size);
            }
            Mnemonic::Rol | Mnemonic::Ror => {
                if size == 8 {
                    self.get(l_t(1)); self.get(l_t(2));
                    self.e(if op == Mnemonic::Rol { I64_ROTL } else { I64_ROTR });
                } else {
                    // rotate within `bits`: (x << c | x >> (bits - c)) & mask, c taken mod bits
                    self.get(l_t(2)); self.c64(bits); self.e(I64_REM_U); self.set(l_t(2));
                    let (a, b) = if op == Mnemonic::Rol { (I64_SHL, I64_SHR_U) } else { (I64_SHR_U, I64_SHL) };
                    self.get(l_t(1)); self.get(l_t(2)); self.e(a);
                    self.get(l_t(1)); self.c64(bits); self.get(l_t(2)); self.e(I64_SUB); self.e(b);
                    self.e(I64_OR); self.mask_to(size);
                }
            }
            _ => return false,
        }
        self.set(l_t(3));
        if need && !matches!(op, Mnemonic::Rol | Mnemonic::Ror) {
            // CF is the last bit shifted out; OF is defined for count 1.
            self.hold_flags();
            let variable = constant.is_none();
            let put = |fx: &mut Self, local: u32, compute: &dyn Fn(&mut Self)| {
                compute(fx);
                if variable { fx.get(local); fx.get(l_t(2)); fx.c64(0); fx.e(I64_NE); fx.e(SELECT); }
                fx.set(local);
            };
            put(self, L_CF, &|fx| {
                match op {
                    Mnemonic::Shl | Mnemonic::Sal => {
                        fx.get(l_t(1)); fx.c64(bits); fx.get(l_t(2)); fx.e(I64_SUB); fx.e(I64_SHR_U);
                    }
                    Mnemonic::Sar => {
                        fx.get(l_t(1)); fx.sign_extend(size); fx.get(l_t(2)); fx.c64(1); fx.e(I64_SUB); fx.e(I64_SHR_S);
                    }
                    _ => { fx.get(l_t(1)); fx.get(l_t(2)); fx.c64(1); fx.e(I64_SUB); fx.e(I64_SHR_U); }
                }
                fx.c64(1); fx.e(I64_AND); fx.e(I32_WRAP_I64);
            });
            put(self, L_ZF, &|fx| { fx.get(l_t(3)); fx.e(I64_EQZ); });
            put(self, L_SF, &|fx| fx.sign_bit(l_t(3), size));
            put(self, L_PF, &|fx| {
                fx.get(l_t(3)); fx.c64(0xff); fx.e(I64_AND); fx.e(I64_POPCNT); fx.c64(1); fx.e(I64_AND); fx.e(I64_EQZ);
            });
            put(self, L_OF, &|fx| match op {
                Mnemonic::Shl | Mnemonic::Sal => {
                    fx.sign_bit(l_t(3), size); fx.get(L_CF); fx.e(I32_XOR);
                }
                Mnemonic::Shr => fx.sign_bit(l_t(1), size),
                _ => fx.c32(0),
            });
        } else if need {
            self.hold_flags();
            // Rotates: CF is the bit that wrapped around.
            self.get(l_t(3));
            if op == Mnemonic::Rol { self.c64(1); self.e(I64_AND); } else { self.c64(bits - 1); self.e(I64_SHR_U); self.c64(1); self.e(I64_AND); }
            self.e(I32_WRAP_I64);
            if constant.is_none() { self.get(L_CF); self.get(l_t(2)); self.c64(0); self.e(I64_NE); self.e(SELECT); }
            self.set(L_CF);
        }
        self.write(i, 0, size, l_t(3))
    }

    /// rcl/rcr: rotate through the carry, by a count the instruction holds (its immediate, or the 1 of its short
    /// form; a count in CL is not lowered). Go's compiler makes `rcr $1` for division by a constant (the carry of
    /// an add put back as the top bit). Only CF and OF change.
    pub(crate) fn rotate_carry(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        let masked = match i.op1_kind() {
            OpKind::Register => return false,
            OpKind::Immediate8 => i.immediate8() as i64 & if size == 8 { 63 } else { 31 },
            _ => 1,
        };
        // The rotation goes through bits + 1 places (the value and CF): an 8- or 16-bit count is taken mod that.
        let c = if size < 4 { masked % (bits + 1) } else { masked };
        if c == 0 {
            return true;
        }
        if !self.read(i, 0, size) { return false; }
        self.set(l_t(1));
        self.flag(Flag::C); self.e(I64_EXTEND_I32_U); self.set(l_t(2));
        let left = op == Mnemonic::Rcl;
        // rcr: x >> c | CF << (bits - c) | x << (bits + 1 - c); rcl: x << c | CF << (c - 1) | x >> (bits + 1 - c).
        // A term shifted by the whole width holds nothing (wasm would take the shift mod 64): it is left out.
        let (near, far) = if left { (I64_SHL, I64_SHR_U) } else { (I64_SHR_U, I64_SHL) };
        if c < bits { self.get(l_t(1)); self.c64(c); self.e(near); } else { self.c64(0); }
        self.get(l_t(2)); self.c64(if left { c - 1 } else { bits - c }); self.e(I64_SHL); self.e(I64_OR);
        if c > 1 { self.get(l_t(1)); self.c64(bits + 1 - c); self.e(far); self.e(I64_OR); }
        self.mask_to(size); self.set(l_t(3));
        if need {
            self.hold_flags();
            // CF: the last bit rotated out of the value.
            self.get(l_t(1)); self.c64(if left { bits - c } else { c - 1 }); self.e(I64_SHR_U);
            self.c64(1); self.e(I64_AND); self.e(I32_WRAP_I64); self.set(L_CF);
            // OF, defined for a count of 1: the result's top bit against CF after (rcl) or its next bit (rcr).
            if c == 1 {
                self.sign_bit(l_t(3), size);
                if left {
                    self.get(L_CF);
                } else {
                    self.get(l_t(3)); self.c64(bits - 2); self.e(I64_SHR_U); self.c64(1); self.e(I64_AND);
                    self.e(I32_WRAP_I64);
                }
                self.e(I32_XOR); self.set(L_OF);
            }
        }
        self.write(i, 0, size, l_t(3))
    }

    /// shld/shrd: shift `dst` filling from `src`.
    pub(crate) fn double_shift(&mut self, i: &Instruction, need: bool) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        let left = i.mnemonic() == Mnemonic::Shld;
        if !self.read(i, 0, size) { return false; }
        self.set(l_t(1));
        if !self.read(i, 1, size) { return false; }
        self.set(l_t(2));
        match i.op2_kind() {
            OpKind::Register => { self.read_reg(Register::CL); }
            _ => self.c64(i.immediate8() as i64),
        }
        self.c64(if size == 8 { 63 } else { 31 }); self.e(I64_AND); self.set(l_t(3));
        // c == 0 leaves everything unchanged; wasm shifts by `bits` are
        // shifts by 0, so guard that case with a select.
        let (a, b) = if left { (I64_SHL, I64_SHR_U) } else { (I64_SHR_U, I64_SHL) };
        self.get(l_t(1)); self.get(l_t(3)); self.e(a);
        self.get(l_t(2)); self.c64(bits); self.get(l_t(3)); self.e(I64_SUB); self.e(b);
        self.e(I64_OR); self.mask_to(size);
        self.get(l_t(1)); self.get(l_t(3)); self.c64(0); self.e(I64_NE); self.e(SELECT);
        self.set(l_t(4));
        if need {
            self.hold_flags();
            // CF: last bit shifted out of dst.
            self.get(l_t(1));
            if left { self.c64(bits); self.get(l_t(3)); self.e(I64_SUB); self.e(I64_SHR_U); }
            else { self.get(l_t(3)); self.c64(1); self.e(I64_SUB); self.e(I64_SHR_U); }
            self.c64(1); self.e(I64_AND); self.e(I32_WRAP_I64);
            self.get(L_CF); self.get(l_t(3)); self.c64(0); self.e(I64_NE); self.e(SELECT); self.set(L_CF);
            self.get(l_t(4)); self.e(I64_EQZ); self.get(L_ZF); self.get(l_t(3)); self.c64(0); self.e(I64_NE); self.e(SELECT); self.set(L_ZF);
            self.sign_bit(l_t(4), size); self.get(L_SF); self.get(l_t(3)); self.c64(0); self.e(I64_NE); self.e(SELECT); self.set(L_SF);
            self.c32(0); self.set(L_OF);
        }
        self.write(i, 0, size, l_t(4))
    }

    pub(crate) fn multiply(&mut self, i: &Instruction, need: bool) -> bool {
        let signed = i.mnemonic() == Mnemonic::Imul;
        let ops = i.op_count();
        if ops == 1 {
            // rdx:rax = rax * src (or ax = al * src for bytes).
            let size = Self::size(i, 0);
            let accumulator = match size { 1 => Register::AL, 2 => Register::AX, 4 => Register::EAX, _ => Register::RAX };
            self.read_reg(accumulator); if signed { self.sign_extend(size); } self.set(l_t(1));
            if !self.read(i, 0, size) { return false; }
            if signed { self.sign_extend(size); }
            self.set(l_t(2));
            if size == 8 {
                self.get(l_t(1)); self.get(l_t(2)); self.call(if signed { F_MULHS } else { F_MULHU }); self.set(l_t(3));
                self.get(l_t(1)); self.get(l_t(2)); self.e(I64_MUL); self.set(l_reg(RAX));
                self.get(l_t(3)); self.set(l_reg(RDX));
                if need {
                    // Overflow when the high half is not the extension of the low.
                    self.get(l_t(3));
                    if signed { self.get(l_reg(RAX)); self.c64(63); self.e(I64_SHR_S); } else { self.c64(0); }
                    self.e(I64_NE);
                    self.set(l_u(0));
                }
            } else {
                self.get(l_t(1)); self.get(l_t(2)); self.e(I64_MUL); self.set(l_t(3));
                let bits = size as i64 * 8;
                if size == 1 {
                    self.get(l_t(3)); self.c64(0xffff); self.e(I64_AND); self.set(l_t(4));
                    self.get(l_t(4)); self.write_reg(Register::AX);
                } else {
                    let (lo, hi) = match size { 2 => (Register::AX, Register::DX), _ => (Register::EAX, Register::EDX) };
                    self.get(l_t(3)); self.write_reg(lo);
                    self.get(l_t(3)); self.c64(bits); self.e(I64_SHR_U); self.write_reg(hi);
                }
                if need {
                    self.get(l_t(3));
                    if signed { self.get(l_t(3)); self.sign_extend(size); self.e(I64_NE); }
                    else { self.c64(bits); self.e(I64_SHR_U); self.c64(0); self.e(I64_NE); }
                    self.set(l_u(0));
                }
            }
        } else {
            // imul r, r/m [, imm]: truncated product, OF=CF=did not fit.
            let size = Self::size(i, 0);
            let (a, b) = if ops == 3 { (1, 2) } else { (0, 1) };
            if !self.read(i, a, size) { return false; }
            self.sign_extend(size); self.set(l_t(1));
            if !self.read(i, b, size) { return false; }
            self.sign_extend(size); self.set(l_t(2));
            self.get(l_t(1)); self.get(l_t(2)); self.e(I64_MUL); self.set(l_t(3));
            if need {
                if size == 8 {
                    self.get(l_t(1)); self.get(l_t(2)); self.call(F_MULHS);
                    self.get(l_t(3)); self.c64(63); self.e(I64_SHR_S); self.e(I64_NE);
                } else {
                    self.get(l_t(3)); self.get(l_t(3)); self.sign_extend(size); self.e(I64_NE);
                }
                self.set(l_u(0));
            }
            self.get(l_t(3)); self.mask_to(size); self.set(l_t(3));
            if !self.write(i, 0, size, l_t(3)) { return false; }
        }
        if need {
            self.c32(0); self.set(L_ZF);
            self.c32(0); self.set(L_SF);
            self.c32(0); self.set(L_PF);
            self.get(l_u(0)); self.set(L_CF);
            self.get(l_u(0)); self.set(L_OF);
            self.set_flags(Flags::Held);
        }
        true
    }

    pub(crate) fn divide(&mut self, i: &Instruction) -> bool {
        let signed = i.mnemonic() == Mnemonic::Idiv;
        let size = Self::size(i, 0);
        if !self.read(i, 0, size) { return false; }
        self.set(l_t(2));
        if size == 8 {
            // 128/64 in the host only when rdx is not the extension of rax.
            self.get(l_reg(RDX));
            if signed { self.get(l_reg(RAX)); self.c64(63); self.e(I64_SHR_S); } else { self.c64(0); }
            self.e(I64_EQ);
            self.if_();
            self.depth += 1;
            self.get(l_reg(RAX)); self.get(l_t(2)); self.e(if signed { I64_DIV_S } else { I64_DIV_U }); self.set(l_t(3));
            self.get(l_reg(RAX)); self.get(l_t(2)); self.e(if signed { I64_REM_S } else { I64_REM_U }); self.set(l_reg(RDX));
            self.get(l_t(3)); self.set(l_reg(RAX));
            self.else_();
            self.get(l_reg(RDX)); self.get(l_reg(RAX)); self.get(l_t(2)); self.c32(signed as i32);
            self.call(F_DIV128);
            self.set(l_reg(RDX)); self.set(l_reg(RAX));
            self.end();
            self.depth -= 1;
            return true;
        }
        let bits = size as i64 * 8;
        // Dividend: dx:ax style pair, or ax for bytes.
        if size == 1 {
            self.read_reg(Register::AX);
            if signed { self.sign_extend(2); }
        } else {
            let (lo, hi) = match size { 2 => (Register::AX, Register::DX), _ => (Register::EAX, Register::EDX) };
            self.read_reg(hi); self.c64(bits); self.e(I64_SHL);
            self.read_reg(lo); self.e(I64_OR);
            if signed && size == 2 { self.e(I64_EXTEND32_S); }
        }
        self.set(l_t(1));
        if signed { self.get(l_t(2)); self.sign_extend(size); self.set(l_t(2)); }
        self.get(l_t(1)); self.get(l_t(2)); self.e(if signed { I64_DIV_S } else { I64_DIV_U }); self.set(l_t(3));
        self.get(l_t(1)); self.get(l_t(2)); self.e(if signed { I64_REM_S } else { I64_REM_U }); self.set(l_t(4));
        match size {
            1 => {
                self.get(l_t(4)); self.c64(0xff); self.e(I64_AND); self.c64(8); self.e(I64_SHL);
                self.get(l_t(3)); self.c64(0xff); self.e(I64_AND); self.e(I64_OR);
                self.write_reg(Register::AX);
            }
            2 => { self.get(l_t(3)); self.write_reg(Register::AX); self.get(l_t(4)); self.write_reg(Register::DX); }
            _ => { self.get(l_t(3)); self.write_reg(Register::EAX); self.get(l_t(4)); self.write_reg(Register::EDX); }
        }
        true
    }

    pub(crate) fn string(&mut self, i: &Instruction) -> bool {
        use Mnemonic::*;
        let (size, store): (u8, bool) = match i.mnemonic() {
            Movsb => (1, false), Movsw => (2, false), Movsd => (4, false), Movsq => (8, false),
            Stosb => (1, true), Stosw => (2, true), Stosd => (4, true), Stosq => (8, true),
            _ => return false,
        };
        let rep = i.has_rep_prefix();
        if self.backward {
            // Descending copy (memmove's overlapping case): the same bytes
            // as one memory.copy of the whole span, which is overlap-safe.
            if store || !rep { return false; }
            self.get(l_reg(RCX)); if size > 1 { self.c64(size.trailing_zeros() as i64); self.e(I64_SHL); } self.set(l_t(1));
            self.get(l_reg(RDI)); self.get(l_t(1)); self.e(I64_SUB); self.c64(size as i64); self.e(I64_ADD); self.e(I32_WRAP_I64);
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(I64_SUB); self.c64(size as i64); self.e(I64_ADD); self.e(I32_WRAP_I64);
            self.get(l_t(1)); self.e(I32_WRAP_I64);
            self.e(MEMORY_COPY);
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(I64_SUB); self.set(l_reg(RSI));
            self.get(l_reg(RDI)); self.get(l_t(1)); self.e(I64_SUB); self.set(l_reg(RDI));
            self.c64(0); self.set(l_reg(RCX));
            return true;
        }
        if rep {
            // count bytes = rcx * size
            self.get(l_reg(RCX)); if size > 1 { self.c64(size.trailing_zeros() as i64); self.e(I64_SHL); } self.set(l_t(1));
        } else {
            self.c64(size as i64); self.set(l_t(1));
        }
        if store {
            if size == 1 || !rep {
                if size == 1 {
                    self.get(l_reg(RDI)); self.e(I32_WRAP_I64);
                    self.get(l_reg(RAX)); self.e(I32_WRAP_I64);
                    self.get(l_t(1)); self.e(I32_WRAP_I64);
                    self.e(MEMORY_FILL);
                } else {
                    self.get(l_reg(RDI)); self.e(I32_WRAP_I64); self.get(l_reg(RAX)); self.store_sized(size);
                }
            } else {
                // Wider fills: loop over elements.
                self.get(l_reg(RDI)); self.set(l_t(2));
                self.get(l_reg(RCX)); self.set(l_t(3));
                self.block();
                self.loop_();
                self.get(l_t(3)); self.e(I64_EQZ); self.br_if(1);
                self.get(l_t(2)); self.e(I32_WRAP_I64); self.get(l_reg(RAX)); self.store_sized(size);
                self.get(l_t(2)); self.c64(size as i64); self.e(I64_ADD); self.set(l_t(2));
                self.get(l_t(3)); self.c64(1); self.e(I64_SUB); self.set(l_t(3));
                self.br(0);
                self.end();
                self.end();
            }
        } else {
            // x86 forward rep movs copies element by element, so overlapping
            // forward copies replicate; memory.copy is exact for the
            // non-overlapping and backward-safe cases compilers emit.
            self.get(l_reg(RDI)); self.e(I32_WRAP_I64);
            self.get(l_reg(RSI)); self.e(I32_WRAP_I64);
            self.get(l_t(1)); self.e(I32_WRAP_I64);
            self.e(MEMORY_COPY);
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(I64_ADD); self.set(l_reg(RSI));
        }
        self.get(l_reg(RDI)); self.get(l_t(1)); self.e(I64_ADD); self.set(l_reg(RDI));
        if rep { self.c64(0); self.set(l_reg(RCX)); }
        true
    }

    pub(crate) fn bit_test(&mut self, i: &Instruction) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        // Bit offset, and the operand it addresses.
        if !self.read(i, 1, size) { return false; }
        self.set(l_t(2));
        let register_offset_into_memory = i.op0_kind() == OpKind::Memory && i.op1_kind() == OpKind::Register;
        if register_offset_into_memory {
            // The offset is signed and may select a different word.
            self.effective(i, true);
            self.get(l_t(2)); self.sign_extend(size); self.c64(3); self.e(I64_SHR_S);
            self.c64(-(size as i64)); self.e(I64_AND);
            self.e(I64_ADD); self.set(l_t(5));
            self.get(l_t(5)); self.e(I32_WRAP_I64); self.load_sized(size); self.set(l_t(1));
        } else {
            if !self.read(i, 0, size) { return false; }
            self.set(l_t(1));
        }
        self.get(l_t(2)); self.c64(bits - 1); self.e(I64_AND); self.set(l_t(2));
        self.hold_flags();
        self.get(l_t(1)); self.get(l_t(2)); self.e(I64_SHR_U); self.c64(1); self.e(I64_AND); self.e(I32_WRAP_I64);
        self.set(L_CF);
        let op = match i.mnemonic() {
            Mnemonic::Bt => return true,
            Mnemonic::Bts => 0, Mnemonic::Btr => 1, _ => 2,
        };
        self.c64(1); self.get(l_t(2)); self.e(I64_SHL); self.set(l_t(3));
        self.get(l_t(1));
        match op {
            0 => { self.get(l_t(3)); self.e(I64_OR); }
            1 => { self.get(l_t(3)); self.c64(-1); self.e(I64_XOR); self.e(I64_AND); }
            _ => { self.get(l_t(3)); self.e(I64_XOR); }
        }
        self.mask_to(size);
        self.set(l_t(1));
        if register_offset_into_memory {
            self.get(l_t(5)); self.e(I32_WRAP_I64); self.get(l_t(1)); self.store_sized(size);
            true
        } else {
            self.write(i, 0, size, l_t(1))
        }
    }

    pub(crate) fn count_bits(&mut self, i: &Instruction, need: bool) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        if !self.read(i, 1, size) { return false; }
        self.set(l_t(1));
        let m = i.mnemonic();
        // wasm `select(a, b, c)` is `c ? a : b`.
        match m {
            Mnemonic::Popcnt => { self.get(l_t(1)); self.e(I64_POPCNT); }
            Mnemonic::Tzcnt | Mnemonic::Bsf => {
                // tzcnt of 0 is the operand width.
                self.c64(bits); self.get(l_t(1)); self.e(I64_CTZ);
                self.get(l_t(1)); self.e(I64_EQZ); self.e(SELECT);
            }
            Mnemonic::Lzcnt | Mnemonic::Bsr => {
                // Leading zeros within the operand width (0 gives the width).
                self.get(l_t(1)); self.e(I64_CLZ); self.c64(64 - bits); self.e(I64_SUB);
                if m == Mnemonic::Bsr { self.set(l_t(3)); self.c64(bits - 1); self.get(l_t(3)); self.e(I64_SUB); }
            }
            _ => return false,
        }
        self.set(l_t(3));
        if matches!(m, Mnemonic::Bsf | Mnemonic::Bsr) {
            // Source zero: destination unchanged, ZF set.
            if !self.read(i, 0, size) { return false; }
            self.set(l_t(4));
            self.get(l_t(4)); self.get(l_t(3)); self.get(l_t(1)); self.e(I64_EQZ); self.e(SELECT); self.set(l_t(3));
        }
        if need {
            self.hold_flags();
            self.get(l_t(1)); self.e(I64_EQZ);
            self.set(if m == Mnemonic::Tzcnt || m == Mnemonic::Lzcnt { L_CF } else { L_ZF });
            if m == Mnemonic::Popcnt {
                self.get(l_t(1)); self.e(I64_EQZ); self.set(L_ZF);
                self.c32(0); self.set(L_CF);
            }
            if m == Mnemonic::Tzcnt || m == Mnemonic::Lzcnt {
                self.get(l_t(3)); self.e(I64_EQZ); self.set(L_ZF);
            }
            self.c32(0); self.set(L_OF);
        }
        self.write(i, 0, size, l_t(3))
    }

    /// clock_gettime (228) of a wall or steady clock, answered here as Linux's vDSO answers it in the caller: its
    /// time asked of the host (F_TIME, a number: no 64-bit value crosses), the timespec written at rsi, 0 in l_t(1),
    /// and out of the two blocks around this. Any other call, a clock the kernel keeps (a CPU-time one), or rsi not
    /// a timespec in memory past the kernel's low page (the kernel says EFAULT): on, to the kernel.
    pub(crate) fn clock_gettime(&mut self) {
        self.get(l_reg(RAX)); self.c64(228); self.e(I64_NE); self.br_if(0);
        self.get(l_reg(RSI)); self.c64(4096); self.e(I64_SUB);
        self.e(MEMORY_SIZE); self.e(I64_EXTEND_I32_U); self.c64(16); self.e(I64_SHL); self.c64(4096 + 16); self.e(I64_SUB);
        self.e(I64_GT_U); self.br_if(0);
        self.get(l_reg(RDI)); self.e(I32_WRAP_I64); self.call(F_TIME);
        self.tee_raw(l_d(0)); self.get_raw(l_d(0)); self.e(F64_NE); self.br_if(0);
        // Seconds, and the rest in nanoseconds rounded as Math.round does (clock.ts answerTime), at most 999999999.
        self.get_raw(l_d(0)); self.f64c(1000.0); self.e(F64_DIV); self.e(F64_FLOOR); self.set_raw(l_d(1));
        self.get(l_reg(RSI)); self.e(I32_WRAP_I64); self.get_raw(l_d(1)); self.e(I64_TRUNC_SAT_F64_S); self.e(Mem(I64_STORE, 3, 0));
        self.get(l_reg(RSI)); self.e(I32_WRAP_I64);
        self.get_raw(l_d(0)); self.get_raw(l_d(1)); self.f64c(1000.0); self.e(F64_MUL); self.e(F64_SUB);
        self.f64c(1e6); self.e(F64_MUL); self.f64c(0.5); self.e(F64_ADD); self.e(F64_FLOOR);
        self.f64c(999_999_999.0); self.e(F64_MIN); self.e(I64_TRUNC_SAT_F64_S); self.e(Mem(I64_STORE, 3, 8));
        self.c64(0); self.set(l_t(1));
        self.br(1);
    }

    pub(crate) fn cpuid(&mut self) {
        // A plain core: SSE2 and SSE3, CMPXCHG16B and POPCNT; no SSSE3, SSE4 or AVX, so a
        // libc choosing its string routines by cpuid takes the SSE2 ones xlat translates.
        self.get(l_reg(RAX)); self.e(I32_WRAP_I64); self.e(I32_EQZ);
        self.if_();
        self.c64(1); self.set(l_reg(RAX));
        self.c64(0x756e_6547); self.set(l_reg(3)); // "Genu"
        self.c64(0x4965_6e69); self.set(l_reg(RDX)); // "ineI"
        self.c64(0x6c65_746e); self.set(l_reg(RCX)); // "ntel"
        self.else_();
        self.c64(0x0006_06a6); self.set(l_reg(RAX));
        self.c64(0); self.set(l_reg(3));
        self.c64((1 << 0) | (1 << 13) | (1 << 23)); self.set(l_reg(RCX));
        self.c64((1 << 0) | (1 << 4) | (1 << 8) | (1 << 15) | (1 << 23) | (1 << 25) | (1 << 26)); self.set(l_reg(RDX));
        self.end();
    }

    pub(crate) fn instruction(&mut self, i: &Instruction, need: bool) {
        use Mnemonic::*;
        let m = i.mnemonic();
        let ok = match m {
            Nop | Endbr64 | Pause | Prefetchnta | Prefetcht0 | Prefetcht1 | Prefetcht2 | Prefetchw | Lfence | Mfence
            | Sfence => true,
            Cld => { self.backward = false; true }
            Std => { self.backward = true; true }
            Shld | Shrd => self.double_shift(i, need),
            // A register write masks to its width and a store keeps only its bytes, so values go straight in.
            Mov => {
                let size = Self::size(i, 0);
                if xmm(i.op0_register()).is_some() || xmm(i.op1_register()).is_some() { false }
                else if i.op0_kind() == OpKind::Register && matches!(i.op1_kind(), OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32
                    | OpKind::Immediate64 | OpKind::Immediate8to32 | OpKind::Immediate8to64 | OpKind::Immediate32to64) {
                    self.write_reg_known(i.op0_register(), i.immediate(1) as i64)
                } else {
                    self.assign(i, size, |fx| fx.read(i, 1, size))
                }
            }
            Movzx => {
                let src = Self::size(i, 1);
                self.read(i, 1, src) && self.write_reg(i.op0_register())
            }
            Movsx | Movsxd => {
                let src = Self::size(i, 1);
                self.read(i, 1, src) && { self.sign_extend(src); self.write_reg(i.op0_register()) }
            }
            Lea => { self.effective(i, false); self.write_reg(i.op0_register()) }
            Add | Sub | Cmp | And | Test | Or | Xor => {
                // xor r, r is the idiom for zero: skip the read.
                if m == Xor && i.op0_kind() == OpKind::Register && i.op1_kind() == OpKind::Register
                    && i.op0_register() == i.op1_register() && !need {
                    self.write_reg_known(i.op0_register(), 0)
                } else {
                    self.binary(i, m, need)
                }
            }
            Adc => self.carry(i, false),
            Sbb => self.carry(i, true),
            Inc | Dec | Neg | Not => self.unary(i, m),
            Shl | Sal | Shr | Sar | Rol | Ror => self.shift(i, m, need),
            Rcl | Rcr => self.rotate_carry(i, m, need),
            Imul | Mul => self.multiply(i, need),
            Div | Idiv => self.divide(i),
            Cbw => { self.read_reg(Register::AL); self.sign_extend(1); self.write_reg(Register::AX) }
            Cwde => { self.read_reg(Register::AX); self.sign_extend(2); self.write_reg(Register::EAX) }
            Cdqe => { self.read_reg(Register::EAX); self.sign_extend(4); self.write_reg(Register::RAX) }
            Cwd => { self.read_reg(Register::AX); self.sign_extend(2); self.c64(16); self.e(I64_SHR_S); self.write_reg(Register::DX) }
            Cdq => { self.read_reg(Register::EAX); self.sign_extend(4); self.c64(32); self.e(I64_SHR_S); self.write_reg(Register::EDX) }
            Cqo => { self.get(l_reg(RAX)); self.c64(63); self.e(I64_SHR_S); self.set(l_reg(RDX)); true }
            Push => {
                let size = Self::size(i, 0).max(if i.op0_kind() == OpKind::Register { 8 } else { 1 });
                let size = if i.op0_kind() == OpKind::Memory { size } else { 8 };
                let immediate = i.op0_kind() != OpKind::Register && i.op0_kind() != OpKind::Memory;
                let value = |fx: &mut Self| fx.read(i, 0, size) && { if immediate { fx.sign_extend(size); } true };
                // The operand is read as it was before rsp moves: made first if it reads rsp.
                if Self::uses_rsp(i, 0) { value(self) && { self.set(l_t(1)); self.push_value(l_t(1)); true } } else { self.push_with(value) }
            }
            Pop => match gpr(i.op0_register()) {
                Some((n, Part::Full)) if i.op0_kind() == OpKind::Register && n != RSP => { self.pop_value(l_reg(n)); true }
                // The destination address uses rsp after the increment.
                _ => { self.pop_value(l_t(1)); self.write(i, 0, 8, l_t(1)) }
            },
            Leave => {
                self.get(l_reg(RBP)); self.set(l_reg(RSP));
                self.pop_value(l_reg(RBP));
                true
            }
            Xchg => {
                let size = Self::size(i, 0);
                self.read(i, 0, size) && { self.set(l_t(1)); self.read(i, 1, size) } && {
                    self.set(l_t(2)); self.write(i, 0, size, l_t(2)) && self.write(i, 1, size, l_t(1))
                }
            }
            Xadd => {
                let size = Self::size(i, 0);
                self.read(i, 0, size) && { self.set(L_FA); self.read(i, 1, size) } && {
                    self.set(L_FB);
                    self.get(L_FA); self.get(L_FB); self.e(I64_ADD); self.mask_to(size); self.set(L_FR);
                    self.defer(Flags::Add(size));
                    self.write(i, 1, size, L_FA) && self.write(i, 0, size, L_FR)
                }
            }
            Cmpxchg => {
                // Compare accumulator with dest; equal: dest = src, else acc = dest.
                let size = Self::size(i, 0);
                let acc = match size { 1 => Register::AL, 2 => Register::AX, 4 => Register::EAX, _ => Register::RAX };
                self.read_reg(acc); self.set(L_FA);
                self.read(i, 0, size) && {
                    self.set(L_FB);
                    self.get(L_FA); self.get(L_FB); self.e(I64_SUB); self.mask_to(size); self.set(L_FR);
                    self.defer(Flags::Sub(size));
                    self.get(L_FA); self.get(L_FB); self.e(I64_EQ);
                    self.if_();
                    self.depth += 1;
                    let ok = self.read(i, 1, size) && { self.set(l_t(1)); self.write(i, 0, size, l_t(1)) };
                    self.else_();
                    self.get(L_FB); self.write_reg(acc);
                    self.end();
                    self.depth -= 1;
                    ok
                }
            }
            Bswap => {
                let size = Self::size(i, 0);
                self.read(i, 0, size) && {
                    self.set(l_t(1)); self.c64(0); self.set(l_t(2));
                    for k in 0..size as i64 {
                        self.get(l_t(1)); self.c64(k * 8); self.e(I64_SHR_U); self.c64(0xff); self.e(I64_AND);
                        self.c64((size as i64 - 1 - k) * 8); self.e(I64_SHL);
                        self.get(l_t(2)); self.e(I64_OR); self.set(l_t(2));
                    }
                    self.write(i, 0, size, l_t(2))
                }
            }
            Bt | Bts | Btr | Btc => self.bit_test(i),
            Bsf | Bsr | Tzcnt | Lzcnt | Popcnt => self.count_bits(i, need),
            Movsb | Movsw | Movsd | Movsq | Stosb | Stosw | Stosd | Stosq
                if i.op0_kind() == OpKind::MemoryESRDI => self.string(i),
            Seto | Setno | Setb | Setae | Sete | Setne | Setbe | Seta | Sets | Setns | Setp | Setnp | Setl | Setge
            | Setle | Setg => {
                self.condition(i.condition_code()); self.e(I64_EXTEND_I32_U); self.set(l_t(1));
                self.write(i, 0, 1, l_t(1))
            }
            Cmovo | Cmovno | Cmovb | Cmovae | Cmove | Cmovne | Cmovbe | Cmova | Cmovs | Cmovns | Cmovp | Cmovnp
            | Cmovl | Cmovge | Cmovle | Cmovg => {
                // A 32-bit cmov zero-extends even when the condition is false.
                let size = Self::size(i, 0);
                self.read(i, 1, size) && { self.read(i, 0, size) } && {
                    self.condition(i.condition_code());
                    self.e(SELECT); self.set(l_t(1));
                    self.write(i, 0, size, l_t(1))
                }
            }
            Syscall => {
                self.save();
                self.block();
                self.block();
                self.clock_gettime();
                self.end();
                // The last argument is where execution resumes; a forked
                // child starts there.
                for r in [RAX, RDI, RSI, RDX, 10, 8, 9] { self.get(l_reg(r)); }
                self.c64(i.next_ip() as i64);
                self.call(F_SYSCALL);
                self.set(l_t(1));
                self.end();
                self.load();
                self.get(l_t(1)); self.set(l_reg(RAX));
                self.c64(i.next_ip() as i64); self.set(l_reg(RCX));
                // The flags come back as they were, held or not.
                true
            }
            // RFLAGS as x86 lays it out: CF, bit 1 (always set), PF, AF, ZF, SF, IF (set), DF, OF. AF is known while
            // an add, sub, inc or dec's operands are still held (bit 4 of a ^ b ^ r), else it reads as clear.
            Pushfq => {
                self.push_with(|fx| {
                    fx.c64(0x202 | if fx.backward { 0x400 } else { 0 });
                    for (f, bit) in [(Flag::C, 0), (Flag::P, 2), (Flag::Z, 6), (Flag::S, 7), (Flag::O, 11)] {
                        fx.flag(f); fx.e(I64_EXTEND_I32_U);
                        if bit > 0 { fx.c64(bit); fx.e(I64_SHL); }
                        fx.e(I64_OR);
                    }
                    if let Flags::Add(_) | Flags::Sub(_) | Flags::Inc(_) | Flags::Dec(_) = fx.flags {
                        fx.get(L_FA); fx.get(L_FB); fx.e(I64_XOR); fx.fr(); fx.e(I64_XOR);
                        fx.c64(0x10); fx.e(I64_AND); fx.e(I64_OR);
                    }
                    true
                })
            }
            // The flags back from the stack. DF is followed in the code as it is written (std, cld); a popped DF set
            // is a direction this translation does not follow, so it traps rather than copy the wrong way.
            Popfq => {
                self.pop_value(l_t(1));
                for (l, bit) in [(L_CF, 0), (L_PF, 2), (L_ZF, 6), (L_SF, 7), (L_OF, 11)] {
                    self.get(l_t(1)); if bit > 0 { self.c64(bit); self.e(I64_SHR_U); }
                    self.c64(1); self.e(I64_AND); self.e(I32_WRAP_I64); self.set(l);
                }
                self.set_flags(Flags::Held);
                self.backward = false;
                self.get(l_t(1)); self.c64(0x400); self.e(I64_AND); self.e(I64_EQZ); self.e(I32_EQZ);
                self.if_();
                self.c64(i.ip() as i64); self.c32(TRAP_UNSUPPORTED); self.call(F_TRAP); self.e(UNREACHABLE);
                self.end();
                true
            }
            Clc | Stc | Cmc => {
                // CF set, cleared or flipped; the other flags as they were (held first if a producer defers them).
                self.hold_flags();
                match i.mnemonic() { Clc => self.c32(0), Stc => self.c32(1), _ => { self.get(L_CF); self.c32(1); self.e(I32_XOR); } }
                self.set(L_CF);
                true
            }
            Movnti => { let size = Self::size(i, 0); self.assign(i, size, |fx| fx.read(i, 1, size)) }
            Clflush | Clflushopt | Clwb => true,
            // MXCSR as a process starts with it (round to nearest, every exception masked, no flush to zero): what
            // wasm computes. Another rounding or denormal mode is not followed, so setting one traps rather than
            // round otherwise than asked.
            Stmxcsr => { self.c64(0x1f80); self.set(l_t(1)); self.write(i, 0, 4, l_t(1)) }
            Ldmxcsr => {
                self.read(i, 0, 4) && {
                    self.c64(0xffc0); self.e(I64_AND); self.c64(0x1f80); self.e(I64_NE);
                    self.if_();
                    self.c64(i.ip() as i64); self.c32(TRAP_UNSUPPORTED); self.call(F_TRAP); self.e(UNREACHABLE);
                    self.end();
                    true
                }
            }
            Cpuid => { self.cpuid(); true }
            Rdtsc => {
                self.call(F_CLOCK); self.set(l_t(1));
                self.get(l_t(1)); self.zext32(); self.set(l_reg(RAX));
                self.get(l_t(1)); self.c64(32); self.e(I64_SHR_U); self.set(l_reg(RDX));
                true
            }
            _ => match self.x87(i) { Some(done) => done, None => self.vector(i) },
        };
        if !ok {
            self.unsupported(i);
        }
    }
}

// ---- SSE (the subset C compilers emit for x86-64-v2) ----

impl Fx<'_> {
    pub(crate) fn xread(&mut self, i: &Instruction, n: u32, bytes: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match xmm(i.op_register(n)) {
                Some(x) => { self.get(l_x(x)); true }
                None => false,
            },
            OpKind::Memory => {
                self.address(i);
                match bytes {
                    16 => self.e(Mem(V128_LOAD, 0, 0)),
                    8 => self.e(Mem(V128_LOAD64_ZERO, 0, 0)),
                    4 => self.e(Mem(V128_LOAD32_ZERO, 0, 0)),
                    _ => return false,
                }
                true
            }
            _ => false,
        }
    }

    pub(crate) fn xwrite(&mut self, i: &Instruction, n: u32, bytes: u32, from: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match xmm(i.op_register(n)) {
                Some(x) => { self.get(from); self.set(l_x(x)); true }
                None => false,
            },
            OpKind::Memory => {
                self.address(i);
                self.get(from);
                match bytes {
                    16 => self.e(Mem(V128_STORE, 0, 0)),
                    8 => { self.e(Mem(V128_STORE64_LANE, 0, 0)); self.f.push(0) }
                    4 => { self.e(Mem(V128_STORE32_LANE, 0, 0)); self.f.push(0) }
                    _ => return false,
                }
                true
            }
            _ => false,
        }
    }

    /// Scalar SSE: lane 0 of the destination is replaced, the rest is kept.
    pub(crate) fn scalar(&mut self, i: &Instruction) -> Option<bool> {
        use Mnemonic::*;
        let m = i.mnemonic();
        let double = matches!(m, Addsd | Subsd | Mulsd | Divsd | Sqrtsd | Minsd | Maxsd | Movsd | Ucomisd | Comisd
            | Cvtsd2ss | Cvttsd2si | Cvtsd2si | Cvtsi2sd | Cmpsd);
        let bytes = if double { 8 } else { 4 };
        let (extract, replace) = if double { (lane_op(F64X2_EXTRACT_LANE, 0), lane_op(F64X2_REPLACE_LANE, 0)) } else { (lane_op(F32X4_EXTRACT_LANE, 0), lane_op(F32X4_REPLACE_LANE, 0)) };
        let arith = match m {
            Addsd => Some(F64_ADD), Subsd => Some(F64_SUB), Mulsd => Some(F64_MUL), Divsd => Some(F64_DIV),
            Addss => Some(F32_ADD), Subss => Some(F32_SUB), Mulss => Some(F32_MUL), Divss => Some(F32_DIV),
            _ => None,
        };
        let done = |fx: &mut Self| { fx.set(l_v(0)); fx.xwrite(i, 0, 16, l_v(0)) };
        Some(match m {
            _ if arith.is_some() => {
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.get(l_v(1)); self.get(l_v(1)); self.e(extract);
                    self.xread(i, 1, bytes) } && { self.e(extract); self.e(arith.unwrap()); self.e(replace); done(self) }
            }
            Sqrtsd | Sqrtss => {
                self.xread(i, 0, 16) && { self.xread(i, 1, bytes) } && {
                    self.e(extract); self.e(if double { F64_SQRT } else { F32_SQRT }); self.e(replace); done(self)
                }
            }
            Minsd | Maxsd | Minss | Maxss => {
                // x86: if either is NaN or both zero, the second operand wins.
                let lt = matches!(m, Minsd | Minss);
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, bytes) } && {
                    self.set(l_v(0));
                    self.get(l_v(1));
                    self.get(l_v(1)); self.e(extract);
                    self.get(l_v(0)); self.e(extract);
                    self.get(l_v(1)); self.e(extract);
                    self.get(l_v(0)); self.e(extract);
                    self.e(match (double, lt) { (true, true) => F64_LT, (true, false) => F64_GT, (false, true) => F32_LT, _ => F32_GT });
                    self.e(SELECT);
                    self.e(replace); done(self)
                }
            }
            Movsd | Movss => {
                if i.op1_kind() == OpKind::Memory {
                    self.xread(i, 1, bytes) && done(self)
                } else if i.op0_kind() == OpKind::Memory {
                    self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, bytes, l_v(0)) }
                } else {
                    self.xread(i, 0, 16) && { self.xread(i, 1, 16) } && { self.e(extract); self.e(replace); done(self) }
                }
            }
            Cvtsi2sd | Cvtsi2ss => {
                let size = Self::size(i, 1);
                self.xread(i, 0, 16) && self.read(i, 1, size) && {
                    if size == 4 { self.e(I32_WRAP_I64); self.e(if double { F64_CONVERT_I32_S } else { F32_CONVERT_I32_S }); }
                    else { self.e(if double { F64_CONVERT_I64_S } else { F32_CONVERT_I64_S }); }
                    self.e(replace); done(self)
                }
            }
            Cvtss2sd | Cvtsd2ss => {
                self.xread(i, 0, 16) && { self.xread(i, 1, if m == Cvtss2sd { 4 } else { 8 }) } && {
                    if m == Cvtss2sd { self.e(lane_op(F32X4_EXTRACT_LANE, 0)); self.e(F64_PROMOTE_F32); self.e(lane_op(F64X2_REPLACE_LANE, 0)); }
                    else { self.e(lane_op(F64X2_EXTRACT_LANE, 0)); self.e(F32_DEMOTE_F64); self.e(lane_op(F32X4_REPLACE_LANE, 0)); }
                    done(self)
                }
            }
            Cvttsd2si | Cvtsd2si | Cvttss2si | Cvtss2si => {
                // Out of range and NaN give the "integer indefinite" value.
                let size = Self::size(i, 0);
                let round = matches!(m, Cvtsd2si | Cvtss2si);
                self.xread(i, 1, bytes) && {
                    self.e(extract);
                    if !double { self.e(F64_PROMOTE_F32); }
                    if round { self.e(F64_NEAREST); }
                    self.set_raw(l_d(0));
                    let limit = if size == 8 { (1u64 << 63) as f64 } else { 2147483648.0 };
                    self.get_raw(l_d(0));
                    self.e(if size == 8 { I64_TRUNC_SAT_F64_S } else { I32_TRUNC_SAT_F64_S });
                    if size != 8 { self.e(I64_EXTEND_I32_U); }
                    self.c64(if size == 8 { i64::MIN } else { 0x8000_0000 });
                    // in range: -limit <= v < limit (false for NaN)
                    self.get(l_d(0)); self.f64c(limit); self.e(F64_LT);
                    self.get(l_d(0)); self.f64c(-limit); self.e(F64_GE);
                    self.e(I32_AND);
                    self.e(SELECT);
                    self.write_reg(i.op0_register())
                }
            }
            Cmpsd | Cmpss if i.op_count() == 3 => {
                // Predicate mask in lane 0: all ones when true.
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.get(l_v(1)); self.e(extract);
                    if !double { self.e(F64_PROMOTE_F32); } self.set(l_d(0)); self.xread(i, 1, bytes) } && {
                    self.e(extract); if !double { self.e(F64_PROMOTE_F32); } self.set(l_d(1));
                    self.predicate(i.immediate8());
                    self.get(l_v(1));
                    if double {
                        self.c64(-1); self.c64(0); self.get(l_u(0)); self.e(SELECT);
                        self.e(lane_op(I64X2_REPLACE_LANE, 0));
                    } else {
                        self.c32(-1); self.c32(0); self.get(l_u(0)); self.e(SELECT);
                        self.e(lane_op(I32X4_REPLACE_LANE, 0));
                    }
                    done(self)
                }
            }
            Ucomisd | Comisd | Ucomiss | Comiss => {
                self.xread(i, 0, 16) && { self.e(extract); if !double { self.e(F64_PROMOTE_F32); } self.set_raw(l_d(0));
                    self.xread(i, 1, bytes) } && {
                    self.e(extract); if !double { self.e(F64_PROMOTE_F32); } self.set_raw(l_d(1));
                    self.compare_flags();
                    self.c32(0); self.set(L_OF); self.c32(0); self.set(L_SF);
                    self.set_flags(Flags::Held);
                    true
                }
            }
            _ => return None,
        })
    }

    /// SSE compare predicate (cmpsd imm8 & 7) of l_d(0) against l_d(1) into l_u(0).
    pub(crate) fn predicate(&mut self, imm: u8) {
        let unordered = |fx: &mut Self| {
            fx.get(l_d(0)); fx.get(l_d(0)); fx.e(F64_NE); fx.get(l_d(1)); fx.get(l_d(1)); fx.e(F64_NE); fx.e(I32_OR);
        };
        let pair = |fx: &mut Self, op: Op| { fx.get(l_d(0)); fx.get(l_d(1)); fx.e(op); };
        match imm & 7 {
            0 => pair(self, F64_EQ),
            1 => pair(self, F64_LT),
            2 => pair(self, F64_LE),
            3 => unordered(self),
            4 => pair(self, F64_NE),
            5 => { pair(self, F64_LT); self.e(I32_EQZ); }
            6 => { pair(self, F64_LE); self.e(I32_EQZ); }
            _ => { unordered(self); self.e(I32_EQZ); }
        }
        self.set(l_u(0));
    }

    /// ucomisd/fucomi flags from l_d(0) against l_d(1):
    /// unordered sets ZF, PF and CF; less sets CF; equal sets ZF.
    pub(crate) fn compare_flags(&mut self) {
        self.get(l_d(0)); self.get(l_d(0)); self.e(F64_NE); self.get(l_d(1)); self.get(l_d(1)); self.e(F64_NE); self.e(I32_OR);
        self.set(L_PF);
        self.get(l_d(0)); self.get(l_d(1)); self.e(F64_EQ); self.get(L_PF); self.e(I32_OR); self.set(L_ZF);
        self.get(l_d(0)); self.get(l_d(1)); self.e(F64_LT); self.get(L_PF); self.e(I32_OR); self.set(L_CF);
    }

    pub(crate) fn vector(&mut self, i: &Instruction) -> bool {
        use Mnemonic::*;
        let m = i.mnemonic();
        let is_x0 = i.op_count() > 0 && i.op0_kind() == OpKind::Register && xmm(i.op0_register()).is_some();
        let is_x1 = i.op_count() > 1 && i.op1_kind() == OpKind::Register && xmm(i.op1_register()).is_some();
        if let Some(done) = self.scalar(i) {
            return done;
        }
        if !(is_x0 || is_x1) {
            return false;
        }
        let binary = |fx: &mut Self, op: Op| -> bool {
            fx.xread(i, 0, 16) && fx.xread(i, 1, 16) && { fx.e(op); fx.set(l_v(0)); fx.xwrite(i, 0, 16, l_v(0)) }
        };
        let shuffled = |fx: &mut Self, lanes: [u8; 16]| -> bool {
            fx.xread(i, 0, 16) && fx.xread(i, 1, 16) && { fx.shuffle(lanes); fx.set(l_v(0)); fx.xwrite(i, 0, 16, l_v(0)) }
        };
        match m {
            Movdqa | Movdqu | Movaps | Movups | Movapd | Movupd | Lddqu => {
                self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) }
            }
            Movq | Movd => {
                let bytes = if m == Movq { 8 } else { 4 };
                if is_x0 && !is_x1 && i.op1_kind() == OpKind::Register {
                    // gpr -> xmm, zeroing the rest
                    self.read_reg(i.op1_register());
                    if bytes == 8 { self.e(I64X2_SPLAT); self.c64(0); self.e(lane_op(I64X2_REPLACE_LANE, 1)); }
                    else {
                        self.e(I32_WRAP_I64); self.e(I32X4_SPLAT);
                        self.c32(0); self.e(lane_op(I32X4_REPLACE_LANE, 1));
                        self.e(lane_op(I64X2_EXTRACT_LANE, 0)); self.zext32();
                        self.e(I64X2_SPLAT); self.c64(0); self.e(lane_op(I64X2_REPLACE_LANE, 1));
                    }
                    self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else if is_x1 && !is_x0 && i.op0_kind() == OpKind::Register {
                    self.xread(i, 1, 16);
                    self.e(lane_op(I64X2_EXTRACT_LANE, 0));
                    if bytes == 4 { self.zext32(); }
                    self.write_reg(i.op0_register())
                } else if is_x0 && i.op1_kind() == OpKind::Memory {
                    self.xread(i, 1, bytes) && { self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) }
                } else if is_x1 && i.op0_kind() == OpKind::Memory {
                    self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, bytes, l_v(0)) }
                } else if is_x0 && is_x1 {
                    // movq xmm, xmm keeps the low qword and zeroes the high one.
                    self.xread(i, 1, 16); self.e(lane_op(I64X2_EXTRACT_LANE, 0)); self.e(I64X2_SPLAT);
                    self.c64(0); self.e(lane_op(I64X2_REPLACE_LANE, 1)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else { false }
            }
            // Half moves: one qword of an xmm register from or to memory, the other kept.
            Movhps | Movhpd | Movlps | Movlpd => {
                let lane = if matches!(m, Movhps | Movhpd) { 1 } else { 0 };
                if is_x0 && i.op1_kind() == OpKind::Memory {
                    self.xread(i, 0, 16);
                    self.address(i); self.e(Mem(I64_LOAD, 0, 0));
                    self.e(lane_op(I64X2_REPLACE_LANE, lane)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else if is_x1 && i.op0_kind() == OpKind::Memory {
                    self.address(i);
                    self.xread(i, 1, 16); self.e(lane_op(I64X2_EXTRACT_LANE, lane));
                    self.e(Mem(I64_STORE, 0, 0));
                    true
                } else { false }
            }
            // Between registers: movhlps puts the source's high qword low, movlhps its low qword high.
            Movhlps | Movlhps if is_x0 && is_x1 => {
                let (from, to) = if m == Movhlps { (1, 0) } else { (0, 1) };
                self.xread(i, 0, 16);
                self.xread(i, 1, 16); self.e(lane_op(I64X2_EXTRACT_LANE, from));
                self.e(lane_op(I64X2_REPLACE_LANE, to)); self.set(l_v(0));
                self.xwrite(i, 0, 16, l_v(0))
            }
            Pxor | Xorps | Xorpd => {
                if is_x1 && i.op0_register() == i.op1_register() {
                    self.v128c(0); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                } else { binary(self, V128_XOR) }
            }
            Por | Orps | Orpd => binary(self, V128_OR),
            Pand | Andps | Andpd => binary(self, V128_AND),
            Pandn | Andnps | Andnpd => {
                self.xread(i, 1, 16) && self.xread(i, 0, 16) && {
                    self.e(V128_AND_NOT); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Paddb => binary(self, I8X16_ADD), Paddw => binary(self, I16X8_ADD),
            Paddd => binary(self, I32X4_ADD), Paddq => binary(self, I64X2_ADD),
            Psubb => binary(self, I8X16_SUB), Psubw => binary(self, I16X8_SUB),
            Psubd => binary(self, I32X4_SUB), Psubq => binary(self, I64X2_SUB),
            Pcmpeqb => binary(self, I8X16_EQ), Pcmpeqw => binary(self, I16X8_EQ),
            Pcmpeqd => binary(self, I32X4_EQ), Pcmpeqq => binary(self, I64X2_EQ),
            Pcmpgtb => binary(self, I8X16_GT_S), Pcmpgtw => binary(self, I16X8_GT_S),
            Pcmpgtd => binary(self, I32X4_GT_S), Pcmpgtq => binary(self, I64X2_GT_S),
            Addpd => binary(self, F64X2_ADD), Subpd => binary(self, F64X2_SUB),
            Mulpd => binary(self, F64X2_MUL), Divpd => binary(self, F64X2_DIV),
            Addps => binary(self, F32X4_ADD), Subps => binary(self, F32X4_SUB),
            Mulps => binary(self, F32X4_MUL), Divps => binary(self, F32X4_DIV),
            Unpcklpd => shuffled(self, [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]),
            Unpckhpd => shuffled(self, [8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31]),
            // Packs narrow with saturation: the destination's lanes low, the source's high.
            Packuswb => binary(self, I8X16_NARROW_I16X8_U), Packsswb => binary(self, I8X16_NARROW_I16X8_S),
            Packssdw => binary(self, I16X8_NARROW_I32X4_S), Packusdw => binary(self, I16X8_NARROW_I32X4_U),
            Paddusb => binary(self, I8X16_ADD_SAT_U), Paddusw => binary(self, I16X8_ADD_SAT_U),
            Paddsb => binary(self, I8X16_ADD_SAT_S), Paddsw => binary(self, I16X8_ADD_SAT_S),
            Psubusb => binary(self, I8X16_SUB_SAT_U), Psubusw => binary(self, I16X8_SUB_SAT_U),
            Psubsb => binary(self, I8X16_SUB_SAT_S), Psubsw => binary(self, I16X8_SUB_SAT_S),
            Pavgb => binary(self, I8X16_AVGR_U), Pavgw => binary(self, I16X8_AVGR_U),
            Pmullw => binary(self, I16X8_MUL), Pmulld => binary(self, I32X4_MUL),
            Pminub => binary(self, I8X16_MIN_U), Pmaxub => binary(self, I8X16_MAX_U),
            Pminsw => binary(self, I16X8_MIN_S), Pmaxsw => binary(self, I16X8_MAX_S),
            Pminud => binary(self, I32X4_MIN_U), Pmaxud => binary(self, I32X4_MAX_U),
            Pminsd => binary(self, I32X4_MIN_S), Pmaxsd => binary(self, I32X4_MAX_S),
            Punpcklbw => shuffled(self, [0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23]),
            Punpckhbw => shuffled(self, [8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31]),
            Punpcklwd => shuffled(self, [0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23]),
            Punpckhwd => shuffled(self, [8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31]),
            Punpckldq => shuffled(self, [0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23]),
            Punpckhdq => shuffled(self, [8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31]),
            Punpcklqdq => shuffled(self, [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]),
            Punpckhqdq => shuffled(self, [8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31]),
            Pmovmskb => {
                self.xread(i, 1, 16) && { self.e(I8X16_BITMASK); self.e(I64_EXTEND_I32_U); self.write_reg(i.op0_register()) }
            }
            Movmskps => {
                self.xread(i, 1, 16) && { self.e(I32X4_BITMASK); self.e(I64_EXTEND_I32_U); self.write_reg(i.op0_register()) }
            }
            Movmskpd => {
                self.xread(i, 1, 16) && { self.e(I64X2_BITMASK); self.e(I64_EXTEND_I32_U); self.write_reg(i.op0_register()) }
            }
            Pshufd => {
                let imm = i.immediate8();
                self.xread(i, 1, 16) && {
                    self.set(l_v(1));
                    let mut lanes = [0u8; 16];
                    for k in 0..4 {
                        let s = (imm >> (k * 2)) & 3;
                        for b in 0..4 { lanes[k * 4 + b] = s * 4 + b as u8; }
                    }
                    self.get(l_v(1)); self.get(l_v(1)); self.shuffle(lanes); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                }
            }
            // Insert a byte/word/dword/qword from a register or memory into one lane.
            Pinsrb | Pinsrw | Pinsrd | Pinsrq if is_x0 => {
                let lane = i.immediate8();
                let (size, op) = match m {
                    Pinsrb => (1, lane_op(I8X16_REPLACE_LANE, lane & 15)),
                    Pinsrw => (2, lane_op(I16X8_REPLACE_LANE, lane & 7)),
                    Pinsrd => (4, lane_op(I32X4_REPLACE_LANE, lane & 3)),
                    _ => (8, lane_op(I64X2_REPLACE_LANE, lane & 1)),
                };
                self.xread(i, 0, 16) && self.read(i, 1, size) && {
                    if size < 8 { self.e(I32_WRAP_I64); }
                    self.e(op); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            // Take one lane out, zero-extended, to a register or memory.
            Pextrb | Pextrw | Pextrd | Pextrq if is_x1 => {
                let lane = i.immediate8();
                self.xread(i, 1, 16) && {
                    let size = match m {
                        Pextrb => { self.e(lane_op(I8X16_EXTRACT_LANE_U, lane & 15)); self.e(I64_EXTEND_I32_U); 1 }
                        Pextrw => { self.e(lane_op(I16X8_EXTRACT_LANE_U, lane & 7)); self.e(I64_EXTEND_I32_U); 2 }
                        Pextrd => { self.e(lane_op(I32X4_EXTRACT_LANE, lane & 3)); self.e(I64_EXTEND_I32_U); 4 }
                        _ => { self.e(lane_op(I64X2_EXTRACT_LANE, lane & 1)); 8 }
                    };
                    self.set(l_t(0));
                    // A register destination takes the whole zero-extended value.
                    let width = if i.op0_kind() == OpKind::Register { i.op0_register().size() as u8 } else { size };
                    self.write(i, 0, width, l_t(0))
                }
            }
            // The low half from the destination, the high half from the source.
            Shufps | Shufpd => {
                let imm = i.immediate8();
                let mut lanes = [0u8; 16];
                if m == Shufps {
                    for k in 0..4u8 {
                        let s = (imm >> (k * 2)) & 3;
                        let from = if k < 2 { 0 } else { 16 };
                        for b in 0..4u8 { lanes[(k * 4 + b) as usize] = from + s * 4 + b; }
                    }
                } else {
                    for b in 0..8u8 {
                        lanes[b as usize] = (imm & 1) * 8 + b;
                        lanes[8 + b as usize] = 16 + ((imm >> 1) & 1) * 8 + b;
                    }
                }
                shuffled(self, lanes)
            }
            // Shuffle the four words of one half; the other half is copied.
            Pshuflw | Pshufhw => {
                let imm = i.immediate8();
                let base = if m == Pshuflw { 0u8 } else { 4 };
                self.xread(i, 1, 16) && {
                    self.set(l_v(1));
                    let mut lanes: [u8; 16] = core::array::from_fn(|b| b as u8);
                    for k in 0..4u8 {
                        let s = (imm >> (k * 2)) & 3;
                        for b in 0..2u8 { lanes[((base + k) * 2 + b) as usize] = (base + s) * 2 + b; }
                    }
                    self.get(l_v(1)); self.get(l_v(1)); self.shuffle(lanes); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Pslldq | Psrldq => {
                let n = i.immediate8().min(16);
                self.xread(i, 0, 16) && {
                    self.set(l_v(1));
                    let mut lanes = [16u8; 16];
                    for k in 0..16u8 {
                        let src = if m == Pslldq { k as i32 - n as i32 } else { k as i32 + n as i32 };
                        if (0..16).contains(&src) { lanes[k as usize] = src as u8; }
                    }
                    // Lanes >= 16 select from the zero vector.
                    self.get(l_v(1)); self.v128c(0); self.shuffle(lanes); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Psllw | Pslld | Psllq | Psrlw | Psrld | Psrlq | Psraw | Psrad if i.op1_kind() == OpKind::Immediate8 => {
                let n = i.immediate8() as i32;
                let (op, width) = match m {
                    Psllw => (I16X8_SHL, 16), Pslld => (I32X4_SHL, 32), Psllq => (I64X2_SHL, 64),
                    Psrlw => (I16X8_SHR_U, 16), Psrld => (I32X4_SHR_U, 32), Psrlq => (I64X2_SHR_U, 64),
                    Psraw => (I16X8_SHR_S, 16), _ => (I32X4_SHR_S, 32),
                };
                self.xread(i, 0, 16) && {
                    if n >= width && !matches!(m, Psraw | Psrad) {
                        self.e(DROP); self.v128c(0);
                    } else {
                        self.c32(n.min(width - 1)); self.e(op);
                    }
                    self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            // Shifts by a count in an xmm register or memory (its low qword): past the lane's
            // width a logical shift gives zero and an arithmetic one the sign in every bit.
            Psllw | Pslld | Psllq | Psrlw | Psrld | Psrlq | Psraw | Psrad => {
                let (op, width) = match m {
                    Psllw => (I16X8_SHL, 16), Pslld => (I32X4_SHL, 32), Psllq => (I64X2_SHL, 64),
                    Psrlw => (I16X8_SHR_U, 16), Psrld => (I32X4_SHR_U, 32), Psrlq => (I64X2_SHR_U, 64),
                    Psraw => (I16X8_SHR_S, 16), _ => (I32X4_SHR_S, 32),
                };
                let arith = matches!(m, Psraw | Psrad);
                self.xread(i, 1, 16) && {
                    self.e(lane_op(I64X2_EXTRACT_LANE, 0)); self.set(l_t(0));
                    self.xread(i, 0, 16) && {
                        self.set(l_v(1));
                        self.get(l_t(0)); self.c64(width as i64); self.e(I64_GE_U);
                        self.if_v128();
                        if arith { self.get(l_v(1)); self.c32(width - 1); self.e(op); } else { self.v128c(0); }
                        self.else_();
                        self.get(l_v(1)); self.get(l_t(0)); self.e(I32_WRAP_I64); self.e(op);
                        self.end();
                        self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                    }
                }
            }
            // ---- The rest of SSE and SSE2: x86-64's baseline, every one of it ----
            Movntdq | Movntps | Movntpd | Movntdqa => self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            Sqrtps => self.unary_v(i, 16, &[F32X4_SQRT]),
            Sqrtpd => self.unary_v(i, 16, &[F64X2_SQRT]),
            // Approximations x86 leaves to each CPU (within 1.5 * 2^-12): given exactly.
            Rcpps => self.xread(i, 1, 16) && { self.set(l_v(1)); self.v128c(f32x4_splat(1.0)); self.get(l_v(1)); self.e(F32X4_DIV); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            Rsqrtps => self.xread(i, 1, 16) && { self.e(F32X4_SQRT); self.set(l_v(1)); self.v128c(f32x4_splat(1.0)); self.get(l_v(1)); self.e(F32X4_DIV); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            // max: a > b ? a : b, so the second operand wins on a NaN or two zeros, as wasm's pmax(b, a) does.
            Maxps | Minps | Maxpd | Minpd => {
                let op = match m { Maxps => F32X4_P_MAX, Minps => F32X4_P_MIN, Maxpd => F64X2_P_MAX, _ => F64X2_P_MIN };
                self.xread(i, 1, 16) && self.xread(i, 0, 16) && { self.e(op); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) }
            }
            Cmpps | Cmppd => {
                let ps = m == Cmpps;
                let (eq, lt, le, ne) = if ps { (F32X4_EQ, F32X4_LT, F32X4_LE, F32X4_NE) } else { (F64X2_EQ, F64X2_LT, F64X2_LE, F64X2_NE) };
                let pred = i.immediate8() & 7;
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                    self.set(l_v(0));
                    let unordered = |fx: &mut Self| { fx.get(l_v(1)); fx.get(l_v(1)); fx.e(ne); fx.get(l_v(0)); fx.get(l_v(0)); fx.e(ne); fx.e(V128_OR); };
                    let pair = |fx: &mut Self, op: Op| { fx.get(l_v(1)); fx.get(l_v(0)); fx.e(op); };
                    match pred {
                        0 => pair(self, eq), 1 => pair(self, lt), 2 => pair(self, le), 3 => unordered(self),
                        4 => pair(self, ne), 5 => { pair(self, lt); self.e(V128_NOT); }
                        6 => { pair(self, le); self.e(V128_NOT); } _ => { unordered(self); self.e(V128_NOT); }
                    }
                    self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Unpcklps => shuffled(self, [0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23]),
            Unpckhps => shuffled(self, [8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31]),
            Cvtdq2ps => self.unary_v(i, 16, &[F32X4_CONVERT_I32X4_S]),
            Cvtdq2pd => self.unary_v(i, 8, &[F64X2_CONVERT_LOW_I32X4_S]),
            Cvtps2pd => self.unary_v(i, 8, &[F64X2_PROMOTE_LOW_F32X4]),
            Cvtpd2ps => self.unary_v(i, 16, &[F32X4_DEMOTE_F64X2_ZERO]),
            // To integers: a lane out of range (or NaN) is the "integer indefinite" 0x80000000, where wasm saturates.
            Cvttps2dq | Cvtps2dq => self.xread(i, 1, 16) && {
                if m == Cvtps2dq { self.e(F32X4_NEAREST); }
                self.set(l_v(1));
                self.get(l_v(1)); self.e(I32X4_TRUNC_SAT_F32X4_S);
                self.v128c(i32x4_splat(i32::MIN));
                self.get(l_v(1)); self.v128c(f32x4_splat(2147483648.0)); self.e(F32X4_LT);
                self.get(l_v(1)); self.v128c(f32x4_splat(-2147483648.0)); self.e(F32X4_GE);
                self.e(V128_AND);
                self.e(V128_BITSELECT); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            Cvttpd2dq | Cvtpd2dq => self.xread(i, 1, 16) && {
                if m == Cvtpd2dq { self.e(F64X2_NEAREST); }
                self.set(l_v(1));
                self.get(l_v(1)); self.e(I32X4_TRUNC_SAT_F64X2_S_ZERO);
                self.v128c(i32x4_splat(i32::MIN));
                // In range: -2^31 - 1 < v < 2^31 (those truncate into 32 bits); the two upper lanes are zero either way.
                self.get(l_v(1)); self.v128c(f64x2_splat(2147483648.0)); self.e(F64X2_LT);
                self.get(l_v(1)); self.v128c(f64x2_splat(-2147483649.0)); self.e(F64X2_GT);
                self.e(V128_AND);
                self.v128c(-1);
                self.shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                self.e(V128_BITSELECT); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // Unsigned 32 x 32 -> 64 of each qword's low half.
            Pmuludq => self.xread(i, 0, 16) && { self.v128c(LOW32); self.e(V128_AND); self.xread(i, 1, 16) } && {
                self.v128c(LOW32); self.e(V128_AND); self.e(I64X2_MUL); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // The high halves of the eight 16 x 16 products.
            Pmulhw | Pmulhuw => {
                let (lo, hi) = if m == Pmulhw { (I32X4_EXT_MUL_LOW_I16X8_S, I32X4_EXT_MUL_HIGH_I16X8_S) } else { (I32X4_EXT_MUL_LOW_I16X8_U, I32X4_EXT_MUL_HIGH_I16X8_U) };
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                    self.set(l_v(0));
                    self.get(l_v(1)); self.get(l_v(0)); self.e(lo);
                    self.get(l_v(1)); self.get(l_v(0)); self.e(hi);
                    self.shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
                    self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Pmaddwd => binary(self, I32X4_DOT_I16X8_S),
            // Sums of the bytes' absolute differences, each half into its qword.
            Psadbw => self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                self.set(l_v(0));
                self.get(l_v(1)); self.get(l_v(0)); self.e(I8X16_MAX_U);
                self.get(l_v(1)); self.get(l_v(0)); self.e(I8X16_MIN_U);
                self.e(I8X16_SUB);
                self.e(I16X8_EXT_ADD_PAIRWISE_I8X16_U); self.e(I32X4_EXT_ADD_PAIRWISE_I16X8_U);
                self.set(l_v(1));
                self.get(l_v(1)); self.v128c(LOW32); self.e(V128_AND);
                self.get(l_v(1)); self.c32(32); self.e(I64X2_SHR_U);
                self.e(I64X2_ADD); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // The bytes of the first whose mask byte (in the second) has its top bit, to [rdi] (operand 0, implied).
            Maskmovdqu => {
                self.get(l_reg(RDI)); self.e(I32_WRAP_I64); self.set(l_u(1));
                self.xread(i, 1, 16) && {
                    self.get(l_u(1)); self.e(Mem(V128_LOAD, 0, 0));
                    self.xread(i, 2, 16) && {
                        self.c32(7); self.e(I8X16_SHR_S);
                        self.e(V128_BITSELECT); self.set(l_v(0));
                        self.get(l_u(1)); self.get(l_v(0)); self.e(Mem(V128_STORE, 0, 0));
                        true
                    }
                }
            }
            _ => false,
        }
    }

    /// One operand in (operand 1, `bytes` of it from memory), `ops` on it, the result to operand 0.
    pub(crate) fn unary_v(&mut self, i: &Instruction, bytes: u32, ops: &[Op]) -> bool {
        self.xread(i, 1, bytes) && {
            for &op in ops { self.e(op); }
            self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
        }
    }
}

const LOW32: i128 = 0x0000_0000_ffff_ffff_0000_0000_ffff_ffff;
fn i32x4_splat(v: i32) -> i128 { let u = v as u32 as u128; (u | u << 32 | u << 64 | u << 96) as i128 }
fn f32x4_splat(v: f32) -> i128 { i32x4_splat(v.to_bits() as i32) }
fn f64x2_splat(v: f64) -> i128 { let u = v.to_bits() as u128; (u | u << 64) as i128 }

// ---- x87: an exact 80-bit coprocessor, the translator's own (x87.rs) ----

// The operations it does are crate::x87::NAMES, in the order of the `fpu` op index; the list is embedded in the
// module (xlat.fpu), so the host runs it only with a coprocessor that numbers them the same.

fn st(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::ST0 as u32..=Register::ST7 as u32).contains(&n).then(|| n - Register::ST0 as u32)
}

/// The x87 runtime's number (x87::NAMES) of what `m` names, if it does one: by mnemonic, found once for all of them
/// (not by name, formatted and searched for, at each instruction that comes this way).
fn x87_index(m: Mnemonic) -> Option<usize> {
    static INDEX: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let index = INDEX.get_or_init(|| Mnemonic::values().map(|m| {
        let name = format!("{m:?}").to_ascii_lowercase();
        let name = if name == "wait" { "fwait".to_string() } else { name };
        crate::x87::NAMES.iter().position(|&n| n == name).map_or(u8::MAX, |k| k as u8)
    }).collect());
    let k = index[m as usize];
    (k != u8::MAX).then_some(k as usize)
}

impl Fx<'_> {
    /// One x87 instruction: fpu(registers, op, memory size, st a, st b, operand, its top word) -> i64, called
    /// wasm to wasm, for the thread whose registers its instance names (G_X87). A memory operand read is loaded
    /// here and given as its bits (an 80-bit one's top word apart); one written is the call's value, stored here (an
    /// 80-bit one's top word asked for after, Op::High). The value is otherwise fcomi's flags (CF|ZF<<1|PF<<2), or
    /// the word fnstsw puts in AX.
    pub(crate) fn x87(&mut self, i: &Instruction) -> Option<bool> {
        let index = x87_index(i.mnemonic())?;
        let name = crate::x87::NAMES[index];
        let op = crate::x87::Op::at(index)?;
        let mut size = 0;
        let (mut a, mut b) = (0i32, 1i32);
        let mut memory = false;
        let mut regs = Vec::new();
        for n in 0..i.op_count() {
            match i.op_kind(n) {
                OpKind::Memory => { memory = true; size = i.memory_size().size() as i32; }
                OpKind::Register => match st(i.op_register(n)) {
                    Some(k) => regs.push(k as i32),
                    None if matches!(i.op_register(n), Register::AX) => {}
                    None => return Some(false),
                },
                _ => return Some(false),
            }
        }
        if let Some(&r) = regs.first() { a = r; }
        if let Some(&r) = regs.get(1) { b = r; }
        if memory && !matches!(size, 2 | 4 | 8 | 10) { return Some(false); }
        // Integer forms tell the coprocessor the memory holds an integer.
        let integer = name.starts_with("fi") && name != "fincstp";
        let stores = memory && op.stores();
        // A store's address first, kept for an 80-bit one's second part.
        let mut at = 0;
        if stores { at = self.place(i); self.tee_raw(l_u(0)); }
        self.gget(G_X87);
        self.c32(index as i32);
        self.c32(if integer { -size } else { size });
        self.c32(a); self.c32(b);
        if memory && !stores {
            let at = self.place(i);
            if size == 10 {
                self.tee_raw(l_u(0));
                self.load_at(8, at);
                self.get_raw(l_u(0)); self.e(Mem(I32_LOAD16_U, 0, at + 8));
            } else {
                self.load_at(size as u8, at);
                self.c32(0);
            }
        } else {
            self.c64(0); self.c32(0);
        }
        self.call(F_FPU);
        if stores {
            if size == 10 {
                self.store_at(8, at);
                self.get_raw(l_u(0));
                self.gget(G_X87);
                self.c32(crate::x87::Op::High as i32);
                self.c32(0); self.c32(0); self.c32(1); self.c64(0); self.c32(0);
                self.call(F_FPU);
                self.store_at(2, at + 8);
            } else {
                self.store_at(size as u8, at);
            }
            return Some(true);
        }
        match name {
            "fucomi" | "fcomi" | "fucomip" | "fcomip" => {
                self.e(I32_WRAP_I64);
                self.set(l_u(0));
                for (bit, l) in [(0, L_CF), (1, L_ZF), (2, L_PF)] {
                    self.get(l_u(0)); if bit > 0 { self.c32(bit); self.e(I32_SHR_U); } self.c32(1); self.e(I32_AND); self.set(l);
                }
                self.c32(0); self.set(L_OF); self.c32(0); self.set(L_SF);
                self.set_flags(Flags::Held);
            }
            "fnstsw" => { self.write_reg(Register::AX); }
            _ => self.e(DROP),
        }
        Some(true)
    }
}

