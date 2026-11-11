//! What each general instruction means, lowered on the frame: arithmetic and logic, shifts, multiplies and divides,
//! the string instructions, bits, the stack, a system call; and the way in for every instruction (`instruction`),
//! which sends the x87's on to fpu.rs and the vector ones to sse.rs.

use crate::abi::*;
use crate::flags::*;
use crate::frame::*;
use crate::operand::mask;
use crate::wasm::*;
use crate::x86::*;

impl Fx<'_> {
    pub(crate) fn unsupported(&mut self, i: &Instruction) {
        *self.report.unsupported.entry(format!("{:?}", i.mnemonic())).or_default() += 1;
        self.c64(i.ip() as i64);
        self.c32(TRAP_UNSUPPORTED);
        self.call(F_TRAP);
        self.e(UNREACHABLE);
    }

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
        // libc choosing its string routines by cpuid takes the SSE2 ones sods translates.
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
