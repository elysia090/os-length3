//! The flags: deferred (what makes them records its operands, what reads them evaluates only the condition it
//! needs), held in their locals when they must be, a compare fused with the branch that alone reads it, and handed
//! between functions in their global.

use crate::abi::*;
use crate::frame::*;
use crate::wasm::*;
use crate::x86::*;

/// CF, ZF, SF, OF and PF: each with its RflagsBits mask, its local and its bit in G_FLAGS.
pub const FLAG_BITS: [(Flag, u32, u32); 5] = [
    (Flag::C, RflagsBits::CF, L_CF), (Flag::Z, RflagsBits::ZF, L_ZF), (Flag::S, RflagsBits::SF, L_SF),
    (Flag::O, RflagsBits::OF, L_OF), (Flag::P, RflagsBits::PF, L_PF),
];

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

impl Fx<'_> {
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
