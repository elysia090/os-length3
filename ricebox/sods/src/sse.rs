//! SSE on v128: the subset C compilers emit for x86-64-v2.

use crate::flags::*;
use crate::frame::*;
use crate::wasm::*;
use crate::x86::*;

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
