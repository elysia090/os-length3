//! WebAssembly as bytes: its numbers (LEB128), its value types, and the operators the lowering writes, each as its bytes (little end first in the word) and how many: written
//! with one store (Fx::op), not built as a value, matched, encoded and dropped. Those with immediates are their
//! opcode, the immediates written after by the method that takes them (memory's alignment and offset, a lane). The
//! test checks each against wasm-encoder's bytes.

/// An operator's bytes (up to four) and how many there are.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Op(pub u32, pub u8);

pub const DROP: Op = Op(0x1a, 1);
pub const F32_ADD: Op = Op(0x92, 1);
pub const F32_CONVERT_I32_S: Op = Op(0xb2, 1);
pub const F32_CONVERT_I64_S: Op = Op(0xb4, 1);
pub const F32_DEMOTE_F64: Op = Op(0xb6, 1);
pub const F32_DIV: Op = Op(0x95, 1);
pub const F32_GT: Op = Op(0x5e, 1);
pub const F32_LT: Op = Op(0x5d, 1);
pub const F32_MUL: Op = Op(0x94, 1);
pub const F32_SQRT: Op = Op(0x91, 1);
pub const F32_SUB: Op = Op(0x93, 1);
pub const F32X4_ADD: Op = Op(0x01e4fd, 3);
pub const F32X4_CONVERT_I32X4_S: Op = Op(0x01fafd, 3);
pub const F32X4_DEMOTE_F64X2_ZERO: Op = Op(0x5efd, 2);
pub const F32X4_DIV: Op = Op(0x01e7fd, 3);
pub const F32X4_EQ: Op = Op(0x41fd, 2);
pub const F32X4_EXTRACT_LANE: Op = Op(0x1ffd, 2);
pub const F32X4_GE: Op = Op(0x46fd, 2);
pub const F32X4_LE: Op = Op(0x45fd, 2);
pub const F32X4_LT: Op = Op(0x43fd, 2);
pub const F32X4_MUL: Op = Op(0x01e6fd, 3);
pub const F32X4_NE: Op = Op(0x42fd, 2);
pub const F32X4_NEAREST: Op = Op(0x6afd, 2);
pub const F32X4_P_MAX: Op = Op(0x01ebfd, 3);
pub const F32X4_P_MIN: Op = Op(0x01eafd, 3);
pub const F32X4_REPLACE_LANE: Op = Op(0x20fd, 2);
pub const F32X4_SQRT: Op = Op(0x01e3fd, 3);
pub const F32X4_SUB: Op = Op(0x01e5fd, 3);
pub const F64_ADD: Op = Op(0xa0, 1);
pub const F64_CONVERT_I32_S: Op = Op(0xb7, 1);
pub const F64_CONVERT_I64_S: Op = Op(0xb9, 1);
pub const F64_DIV: Op = Op(0xa3, 1);
pub const F64_EQ: Op = Op(0x61, 1);
pub const F64_FLOOR: Op = Op(0x9c, 1);
pub const F64_GE: Op = Op(0x66, 1);
pub const F64_GT: Op = Op(0x64, 1);
pub const F64_LE: Op = Op(0x65, 1);
pub const F64_LT: Op = Op(0x63, 1);
pub const F64_MIN: Op = Op(0xa4, 1);
pub const F64_MUL: Op = Op(0xa2, 1);
pub const F64_NE: Op = Op(0x62, 1);
pub const F64_NEAREST: Op = Op(0x9e, 1);
pub const F64_PROMOTE_F32: Op = Op(0xbb, 1);
pub const F64_SQRT: Op = Op(0x9f, 1);
pub const F64_SUB: Op = Op(0xa1, 1);
pub const F64X2_ADD: Op = Op(0x01f0fd, 3);
pub const F64X2_CONVERT_LOW_I32X4_S: Op = Op(0x01fefd, 3);
pub const F64X2_DIV: Op = Op(0x01f3fd, 3);
pub const F64X2_EQ: Op = Op(0x47fd, 2);
pub const F64X2_EXTRACT_LANE: Op = Op(0x21fd, 2);
pub const F64X2_GT: Op = Op(0x4afd, 2);
pub const F64X2_LE: Op = Op(0x4bfd, 2);
pub const F64X2_LT: Op = Op(0x49fd, 2);
pub const F64X2_MUL: Op = Op(0x01f2fd, 3);
pub const F64X2_NE: Op = Op(0x48fd, 2);
pub const F64X2_NEAREST: Op = Op(0x0194fd, 3);
pub const F64X2_P_MAX: Op = Op(0x01f7fd, 3);
pub const F64X2_P_MIN: Op = Op(0x01f6fd, 3);
pub const F64X2_PROMOTE_LOW_F32X4: Op = Op(0x5ffd, 2);
pub const F64X2_REPLACE_LANE: Op = Op(0x22fd, 2);
pub const F64X2_SQRT: Op = Op(0x01effd, 3);
pub const F64X2_SUB: Op = Op(0x01f1fd, 3);
pub const I16X8_ADD: Op = Op(0x018efd, 3);
pub const I16X8_ADD_SAT_S: Op = Op(0x018ffd, 3);
pub const I16X8_ADD_SAT_U: Op = Op(0x0190fd, 3);
pub const I16X8_AVGR_U: Op = Op(0x019bfd, 3);
pub const I16X8_EQ: Op = Op(0x2dfd, 2);
pub const I16X8_EXT_ADD_PAIRWISE_I8X16_U: Op = Op(0x7dfd, 2);
pub const I16X8_EXTRACT_LANE_U: Op = Op(0x19fd, 2);
pub const I16X8_GT_S: Op = Op(0x31fd, 2);
pub const I16X8_MAX_S: Op = Op(0x0198fd, 3);
pub const I16X8_MIN_S: Op = Op(0x0196fd, 3);
pub const I16X8_MUL: Op = Op(0x0195fd, 3);
pub const I16X8_NARROW_I32X4_S: Op = Op(0x0185fd, 3);
pub const I16X8_NARROW_I32X4_U: Op = Op(0x0186fd, 3);
pub const I16X8_REPLACE_LANE: Op = Op(0x1afd, 2);
pub const I16X8_SHL: Op = Op(0x018bfd, 3);
pub const I16X8_SHR_S: Op = Op(0x018cfd, 3);
pub const I16X8_SHR_U: Op = Op(0x018dfd, 3);
pub const I16X8_SUB: Op = Op(0x0191fd, 3);
pub const I16X8_SUB_SAT_S: Op = Op(0x0192fd, 3);
pub const I16X8_SUB_SAT_U: Op = Op(0x0193fd, 3);
pub const I32_ADD: Op = Op(0x6a, 1);
pub const I32_AND: Op = Op(0x71, 1);
pub const I32_EQ: Op = Op(0x46, 1);
pub const I32_EQZ: Op = Op(0x45, 1);
pub const I32_EXTEND16_S: Op = Op(0xc1, 1);
pub const I32_EXTEND8_S: Op = Op(0xc0, 1);
pub const I32_GE_S: Op = Op(0x4e, 1);
pub const I32_GE_U: Op = Op(0x4f, 1);
pub const I32_GT_S: Op = Op(0x4a, 1);
pub const I32_GT_U: Op = Op(0x4b, 1);
pub const I32_LE_S: Op = Op(0x4c, 1);
pub const I32_LE_U: Op = Op(0x4d, 1);
pub const I32_LOAD: Op = Op(0x28, 1);
pub const I32_LOAD16_U: Op = Op(0x2f, 1);
pub const I32_LOAD8_U: Op = Op(0x2d, 1);
pub const I32_LT_S: Op = Op(0x48, 1);
pub const I32_LT_U: Op = Op(0x49, 1);
pub const I32_NE: Op = Op(0x47, 1);
pub const I32_OR: Op = Op(0x72, 1);
pub const I32_SHL: Op = Op(0x74, 1);
pub const I32_SHR_U: Op = Op(0x76, 1);
pub const I32_STORE: Op = Op(0x36, 1);
pub const I32_SUB: Op = Op(0x6b, 1);
pub const I32_TRUNC_SAT_F64_S: Op = Op(0x02fc, 2);
pub const I32_WRAP_I64: Op = Op(0xa7, 1);
pub const I32_XOR: Op = Op(0x73, 1);
pub const I32X4_ADD: Op = Op(0x01aefd, 3);
pub const I32X4_BITMASK: Op = Op(0x01a4fd, 3);
pub const I32X4_DOT_I16X8_S: Op = Op(0x01bafd, 3);
pub const I32X4_EQ: Op = Op(0x37fd, 2);
pub const I32X4_EXT_ADD_PAIRWISE_I16X8_U: Op = Op(0x7ffd, 2);
pub const I32X4_EXT_MUL_HIGH_I16X8_S: Op = Op(0x01bdfd, 3);
pub const I32X4_EXT_MUL_HIGH_I16X8_U: Op = Op(0x01bffd, 3);
pub const I32X4_EXT_MUL_LOW_I16X8_S: Op = Op(0x01bcfd, 3);
pub const I32X4_EXT_MUL_LOW_I16X8_U: Op = Op(0x01befd, 3);
pub const I32X4_EXTRACT_LANE: Op = Op(0x1bfd, 2);
pub const I32X4_GT_S: Op = Op(0x3bfd, 2);
pub const I32X4_MAX_S: Op = Op(0x01b8fd, 3);
pub const I32X4_MAX_U: Op = Op(0x01b9fd, 3);
pub const I32X4_MIN_S: Op = Op(0x01b6fd, 3);
pub const I32X4_MIN_U: Op = Op(0x01b7fd, 3);
pub const I32X4_MUL: Op = Op(0x01b5fd, 3);
pub const I32X4_REPLACE_LANE: Op = Op(0x1cfd, 2);
pub const I32X4_SHL: Op = Op(0x01abfd, 3);
pub const I32X4_SHR_S: Op = Op(0x01acfd, 3);
pub const I32X4_SHR_U: Op = Op(0x01adfd, 3);
pub const I32X4_SPLAT: Op = Op(0x11fd, 2);
pub const I32X4_SUB: Op = Op(0x01b1fd, 3);
pub const I32X4_TRUNC_SAT_F32X4_S: Op = Op(0x01f8fd, 3);
pub const I32X4_TRUNC_SAT_F64X2_S_ZERO: Op = Op(0x01fcfd, 3);
pub const I64_ADD: Op = Op(0x7c, 1);
pub const I64_AND: Op = Op(0x83, 1);
pub const I64_CLZ: Op = Op(0x79, 1);
pub const I64_CTZ: Op = Op(0x7a, 1);
pub const I64_DIV_S: Op = Op(0x7f, 1);
pub const I64_DIV_U: Op = Op(0x80, 1);
pub const I64_EQ: Op = Op(0x51, 1);
pub const I64_EQZ: Op = Op(0x50, 1);
pub const I64_EXTEND16_S: Op = Op(0xc3, 1);
pub const I64_EXTEND32_S: Op = Op(0xc4, 1);
pub const I64_EXTEND8_S: Op = Op(0xc2, 1);
pub const I64_EXTEND_I32_U: Op = Op(0xad, 1);
pub const I64_GE_S: Op = Op(0x59, 1);
pub const I64_GE_U: Op = Op(0x5a, 1);
pub const I64_GT_S: Op = Op(0x55, 1);
pub const I64_GT_U: Op = Op(0x56, 1);
pub const I64_LE_S: Op = Op(0x57, 1);
pub const I64_LE_U: Op = Op(0x58, 1);
pub const I64_LOAD: Op = Op(0x29, 1);
pub const I64_LOAD16_U: Op = Op(0x33, 1);
pub const I64_LOAD32_U: Op = Op(0x35, 1);
pub const I64_LOAD8_U: Op = Op(0x31, 1);
pub const I64_LT_S: Op = Op(0x53, 1);
pub const I64_LT_U: Op = Op(0x54, 1);
pub const I64_MUL: Op = Op(0x7e, 1);
pub const I64_NE: Op = Op(0x52, 1);
pub const I64_OR: Op = Op(0x84, 1);
pub const I64_POPCNT: Op = Op(0x7b, 1);
pub const I64_REM_S: Op = Op(0x81, 1);
pub const I64_REM_U: Op = Op(0x82, 1);
pub const I64_ROTL: Op = Op(0x89, 1);
pub const I64_ROTR: Op = Op(0x8a, 1);
pub const I64_SHL: Op = Op(0x86, 1);
pub const I64_SHR_S: Op = Op(0x87, 1);
pub const I64_SHR_U: Op = Op(0x88, 1);
pub const I64_STORE: Op = Op(0x37, 1);
pub const I64_STORE16: Op = Op(0x3d, 1);
pub const I64_STORE32: Op = Op(0x3e, 1);
pub const I64_STORE8: Op = Op(0x3c, 1);
pub const I64_SUB: Op = Op(0x7d, 1);
pub const I64_TRUNC_SAT_F64_S: Op = Op(0x06fc, 2);
pub const I64_XOR: Op = Op(0x85, 1);
pub const I64X2_ADD: Op = Op(0x01cefd, 3);
pub const I64X2_BITMASK: Op = Op(0x01c4fd, 3);
pub const I64X2_EQ: Op = Op(0x01d6fd, 3);
pub const I64X2_EXTRACT_LANE: Op = Op(0x1dfd, 2);
pub const I64X2_GT_S: Op = Op(0x01d9fd, 3);
pub const I64X2_MUL: Op = Op(0x01d5fd, 3);
pub const I64X2_REPLACE_LANE: Op = Op(0x1efd, 2);
pub const I64X2_SHL: Op = Op(0x01cbfd, 3);
pub const I64X2_SHR_U: Op = Op(0x01cdfd, 3);
pub const I64X2_SPLAT: Op = Op(0x12fd, 2);
pub const I64X2_SUB: Op = Op(0x01d1fd, 3);
pub const I8X16_ADD: Op = Op(0x6efd, 2);
pub const I8X16_ADD_SAT_S: Op = Op(0x6ffd, 2);
pub const I8X16_ADD_SAT_U: Op = Op(0x70fd, 2);
pub const I8X16_AVGR_U: Op = Op(0x7bfd, 2);
pub const I8X16_BITMASK: Op = Op(0x64fd, 2);
pub const I8X16_EQ: Op = Op(0x23fd, 2);
pub const I8X16_EXTRACT_LANE_U: Op = Op(0x16fd, 2);
pub const I8X16_GT_S: Op = Op(0x27fd, 2);
pub const I8X16_MAX_U: Op = Op(0x79fd, 2);
pub const I8X16_MIN_U: Op = Op(0x77fd, 2);
pub const I8X16_NARROW_I16X8_S: Op = Op(0x65fd, 2);
pub const I8X16_NARROW_I16X8_U: Op = Op(0x66fd, 2);
pub const I8X16_REPLACE_LANE: Op = Op(0x17fd, 2);
pub const I8X16_SHR_S: Op = Op(0x6cfd, 2);
pub const I8X16_SUB: Op = Op(0x71fd, 2);
pub const I8X16_SUB_SAT_S: Op = Op(0x72fd, 2);
pub const I8X16_SUB_SAT_U: Op = Op(0x73fd, 2);
pub const MEMORY_COPY: Op = Op(0x00000afc, 4);
pub const MEMORY_FILL: Op = Op(0x000bfc, 3);
pub const MEMORY_SIZE: Op = Op(0x003f, 2);
pub const RETURN: Op = Op(0x0f, 1);
pub const SELECT: Op = Op(0x1b, 1);
pub const UNREACHABLE: Op = Op(0x00, 1);
pub const V128_AND: Op = Op(0x4efd, 2);
pub const V128_AND_NOT: Op = Op(0x4ffd, 2);
pub const V128_BITSELECT: Op = Op(0x52fd, 2);
pub const V128_LOAD: Op = Op(0x00fd, 2);
pub const V128_LOAD32_ZERO: Op = Op(0x5cfd, 2);
pub const V128_LOAD64_ZERO: Op = Op(0x5dfd, 2);
pub const V128_NOT: Op = Op(0x4dfd, 2);
pub const V128_OR: Op = Op(0x50fd, 2);
pub const V128_STORE: Op = Op(0x0bfd, 2);
pub const V128_STORE32_LANE: Op = Op(0x5afd, 2);
pub const V128_STORE64_LANE: Op = Op(0x5bfd, 2);
pub const V128_XOR: Op = Op(0x51fd, 2);

/// An operator with its lane.
pub const fn lane_op(o: Op, lane: u8) -> Op { Op(o.0 | (lane as u32) << (8 * o.1 as u32), o.1 + 1) }

/// The value types, as a function's locals name them.
pub const I32: u8 = 0x7f;
pub const I64: u8 = 0x7e;
pub const F64: u8 = 0x7c;
pub const V128: u8 = 0x7b;

/// A LEB128, unsigned and signed.
#[inline]
pub fn uleb(out: &mut Vec<u8>, v: u64) { if v < 0x80 { out.push(v as u8) } else { uleb_long(out, v) } }
#[cold]
fn uleb_long(out: &mut Vec<u8>, mut v: u64) {
    let (mut bytes, mut n) = ([0u8; 10], 0);
    while v >= 0x80 { bytes[n] = v as u8 | 0x80; n += 1; v >>= 7; }
    bytes[n] = v as u8;
    out.extend_from_slice(&bytes[..=n]);
}
/// (Its bytes made in a buffer of its own, then put in at once: one check of room, not one a byte.)
pub fn sleb(out: &mut Vec<u8>, mut v: i64) {
    let (mut bytes, mut n) = ([0u8; 10], 0);
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) { bytes[n] = b; break; }
        bytes[n] = b | 0x80;
        n += 1;
    }
    out.extend_from_slice(&bytes[..=n]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_encoder::{Encode, Instruction as W, MemArg, MemArgTarget};

    fn bytes(o: Op) -> Vec<u8> { o.0.to_le_bytes()[..o.1 as usize].to_vec() }

    /// Each operator is wasm-encoder's bytes: whole where it has no immediates, its opcode where it has.
    #[test]
    fn as_wasm_encoder_writes() {
        let m = MemArg { offset: 0, align: 0, target: MemArgTarget::Memory(0), ordering: None };
        let with = |w: W, imm: usize| { let mut v = Vec::new(); w.encode(&mut v); v.truncate(v.len() - imm); v };
        let plain: &[(Op, W)] = &[
            (DROP, W::Drop),
            (F32_ADD, W::F32Add),
            (F32_CONVERT_I32_S, W::F32ConvertI32S),
            (F32_CONVERT_I64_S, W::F32ConvertI64S),
            (F32_DEMOTE_F64, W::F32DemoteF64),
            (F32_DIV, W::F32Div),
            (F32_GT, W::F32Gt),
            (F32_LT, W::F32Lt),
            (F32_MUL, W::F32Mul),
            (F32_SQRT, W::F32Sqrt),
            (F32_SUB, W::F32Sub),
            (F32X4_ADD, W::F32x4Add),
            (F32X4_CONVERT_I32X4_S, W::F32x4ConvertI32x4S),
            (F32X4_DEMOTE_F64X2_ZERO, W::F32x4DemoteF64x2Zero),
            (F32X4_DIV, W::F32x4Div),
            (F32X4_EQ, W::F32x4Eq),
            (F32X4_GE, W::F32x4Ge),
            (F32X4_LE, W::F32x4Le),
            (F32X4_LT, W::F32x4Lt),
            (F32X4_MUL, W::F32x4Mul),
            (F32X4_NE, W::F32x4Ne),
            (F32X4_NEAREST, W::F32x4Nearest),
            (F32X4_P_MAX, W::F32x4PMax),
            (F32X4_P_MIN, W::F32x4PMin),
            (F32X4_SQRT, W::F32x4Sqrt),
            (F32X4_SUB, W::F32x4Sub),
            (F64_ADD, W::F64Add),
            (F64_CONVERT_I32_S, W::F64ConvertI32S),
            (F64_CONVERT_I64_S, W::F64ConvertI64S),
            (F64_DIV, W::F64Div),
            (F64_EQ, W::F64Eq),
            (F64_FLOOR, W::F64Floor),
            (F64_GE, W::F64Ge),
            (F64_GT, W::F64Gt),
            (F64_LE, W::F64Le),
            (F64_LT, W::F64Lt),
            (F64_MIN, W::F64Min),
            (F64_MUL, W::F64Mul),
            (F64_NE, W::F64Ne),
            (F64_NEAREST, W::F64Nearest),
            (F64_PROMOTE_F32, W::F64PromoteF32),
            (F64_SQRT, W::F64Sqrt),
            (F64_SUB, W::F64Sub),
            (F64X2_ADD, W::F64x2Add),
            (F64X2_CONVERT_LOW_I32X4_S, W::F64x2ConvertLowI32x4S),
            (F64X2_DIV, W::F64x2Div),
            (F64X2_EQ, W::F64x2Eq),
            (F64X2_GT, W::F64x2Gt),
            (F64X2_LE, W::F64x2Le),
            (F64X2_LT, W::F64x2Lt),
            (F64X2_MUL, W::F64x2Mul),
            (F64X2_NE, W::F64x2Ne),
            (F64X2_NEAREST, W::F64x2Nearest),
            (F64X2_P_MAX, W::F64x2PMax),
            (F64X2_P_MIN, W::F64x2PMin),
            (F64X2_PROMOTE_LOW_F32X4, W::F64x2PromoteLowF32x4),
            (F64X2_SQRT, W::F64x2Sqrt),
            (F64X2_SUB, W::F64x2Sub),
            (I16X8_ADD, W::I16x8Add),
            (I16X8_ADD_SAT_S, W::I16x8AddSatS),
            (I16X8_ADD_SAT_U, W::I16x8AddSatU),
            (I16X8_AVGR_U, W::I16x8AvgrU),
            (I16X8_EQ, W::I16x8Eq),
            (I16X8_EXT_ADD_PAIRWISE_I8X16_U, W::I16x8ExtAddPairwiseI8x16U),
            (I16X8_GT_S, W::I16x8GtS),
            (I16X8_MAX_S, W::I16x8MaxS),
            (I16X8_MIN_S, W::I16x8MinS),
            (I16X8_MUL, W::I16x8Mul),
            (I16X8_NARROW_I32X4_S, W::I16x8NarrowI32x4S),
            (I16X8_NARROW_I32X4_U, W::I16x8NarrowI32x4U),
            (I16X8_SHL, W::I16x8Shl),
            (I16X8_SHR_S, W::I16x8ShrS),
            (I16X8_SHR_U, W::I16x8ShrU),
            (I16X8_SUB, W::I16x8Sub),
            (I16X8_SUB_SAT_S, W::I16x8SubSatS),
            (I16X8_SUB_SAT_U, W::I16x8SubSatU),
            (I32_ADD, W::I32Add),
            (I32_AND, W::I32And),
            (I32_EQ, W::I32Eq),
            (I32_EQZ, W::I32Eqz),
            (I32_EXTEND16_S, W::I32Extend16S),
            (I32_EXTEND8_S, W::I32Extend8S),
            (I32_GE_S, W::I32GeS),
            (I32_GE_U, W::I32GeU),
            (I32_GT_S, W::I32GtS),
            (I32_GT_U, W::I32GtU),
            (I32_LE_S, W::I32LeS),
            (I32_LE_U, W::I32LeU),
            (I32_LT_S, W::I32LtS),
            (I32_LT_U, W::I32LtU),
            (I32_NE, W::I32Ne),
            (I32_OR, W::I32Or),
            (I32_SHL, W::I32Shl),
            (I32_SHR_U, W::I32ShrU),
            (I32_SUB, W::I32Sub),
            (I32_TRUNC_SAT_F64_S, W::I32TruncSatF64S),
            (I32_WRAP_I64, W::I32WrapI64),
            (I32_XOR, W::I32Xor),
            (I32X4_ADD, W::I32x4Add),
            (I32X4_BITMASK, W::I32x4Bitmask),
            (I32X4_DOT_I16X8_S, W::I32x4DotI16x8S),
            (I32X4_EQ, W::I32x4Eq),
            (I32X4_EXT_ADD_PAIRWISE_I16X8_U, W::I32x4ExtAddPairwiseI16x8U),
            (I32X4_EXT_MUL_HIGH_I16X8_S, W::I32x4ExtMulHighI16x8S),
            (I32X4_EXT_MUL_HIGH_I16X8_U, W::I32x4ExtMulHighI16x8U),
            (I32X4_EXT_MUL_LOW_I16X8_S, W::I32x4ExtMulLowI16x8S),
            (I32X4_EXT_MUL_LOW_I16X8_U, W::I32x4ExtMulLowI16x8U),
            (I32X4_GT_S, W::I32x4GtS),
            (I32X4_MAX_S, W::I32x4MaxS),
            (I32X4_MAX_U, W::I32x4MaxU),
            (I32X4_MIN_S, W::I32x4MinS),
            (I32X4_MIN_U, W::I32x4MinU),
            (I32X4_MUL, W::I32x4Mul),
            (I32X4_SHL, W::I32x4Shl),
            (I32X4_SHR_S, W::I32x4ShrS),
            (I32X4_SHR_U, W::I32x4ShrU),
            (I32X4_SPLAT, W::I32x4Splat),
            (I32X4_SUB, W::I32x4Sub),
            (I32X4_TRUNC_SAT_F32X4_S, W::I32x4TruncSatF32x4S),
            (I32X4_TRUNC_SAT_F64X2_S_ZERO, W::I32x4TruncSatF64x2SZero),
            (I64_ADD, W::I64Add),
            (I64_AND, W::I64And),
            (I64_CLZ, W::I64Clz),
            (I64_CTZ, W::I64Ctz),
            (I64_DIV_S, W::I64DivS),
            (I64_DIV_U, W::I64DivU),
            (I64_EQ, W::I64Eq),
            (I64_EQZ, W::I64Eqz),
            (I64_EXTEND16_S, W::I64Extend16S),
            (I64_EXTEND32_S, W::I64Extend32S),
            (I64_EXTEND8_S, W::I64Extend8S),
            (I64_EXTEND_I32_U, W::I64ExtendI32U),
            (I64_GE_S, W::I64GeS),
            (I64_GE_U, W::I64GeU),
            (I64_GT_S, W::I64GtS),
            (I64_GT_U, W::I64GtU),
            (I64_LE_S, W::I64LeS),
            (I64_LE_U, W::I64LeU),
            (I64_LT_S, W::I64LtS),
            (I64_LT_U, W::I64LtU),
            (I64_MUL, W::I64Mul),
            (I64_NE, W::I64Ne),
            (I64_OR, W::I64Or),
            (I64_POPCNT, W::I64Popcnt),
            (I64_REM_S, W::I64RemS),
            (I64_REM_U, W::I64RemU),
            (I64_ROTL, W::I64Rotl),
            (I64_ROTR, W::I64Rotr),
            (I64_SHL, W::I64Shl),
            (I64_SHR_S, W::I64ShrS),
            (I64_SHR_U, W::I64ShrU),
            (I64_SUB, W::I64Sub),
            (I64_TRUNC_SAT_F64_S, W::I64TruncSatF64S),
            (I64_XOR, W::I64Xor),
            (I64X2_ADD, W::I64x2Add),
            (I64X2_BITMASK, W::I64x2Bitmask),
            (I64X2_EQ, W::I64x2Eq),
            (I64X2_GT_S, W::I64x2GtS),
            (I64X2_MUL, W::I64x2Mul),
            (I64X2_SHL, W::I64x2Shl),
            (I64X2_SHR_U, W::I64x2ShrU),
            (I64X2_SPLAT, W::I64x2Splat),
            (I64X2_SUB, W::I64x2Sub),
            (I8X16_ADD, W::I8x16Add),
            (I8X16_ADD_SAT_S, W::I8x16AddSatS),
            (I8X16_ADD_SAT_U, W::I8x16AddSatU),
            (I8X16_AVGR_U, W::I8x16AvgrU),
            (I8X16_BITMASK, W::I8x16Bitmask),
            (I8X16_EQ, W::I8x16Eq),
            (I8X16_GT_S, W::I8x16GtS),
            (I8X16_MAX_U, W::I8x16MaxU),
            (I8X16_MIN_U, W::I8x16MinU),
            (I8X16_NARROW_I16X8_S, W::I8x16NarrowI16x8S),
            (I8X16_NARROW_I16X8_U, W::I8x16NarrowI16x8U),
            (I8X16_SHR_S, W::I8x16ShrS),
            (I8X16_SUB, W::I8x16Sub),
            (I8X16_SUB_SAT_S, W::I8x16SubSatS),
            (I8X16_SUB_SAT_U, W::I8x16SubSatU),
            (RETURN, W::Return),
            (SELECT, W::Select),
            (UNREACHABLE, W::Unreachable),
            (V128_AND, W::V128And),
            (V128_AND_NOT, W::V128AndNot),
            (V128_BITSELECT, W::V128Bitselect),
            (V128_NOT, W::V128Not),
            (V128_OR, W::V128Or),
            (V128_XOR, W::V128Xor),
        ];
        for (o, w) in plain { assert_eq!(bytes(*o), with(w.clone(), 0), "{w:?}"); }
        let memarg: &[(Op, W)] = &[
            (I32_LOAD, W::I32Load(m)),
            (I64_LOAD, W::I64Load(m)),
            (I32_LOAD8_U, W::I32Load8U(m)),
            (I32_LOAD16_U, W::I32Load16U(m)),
            (I64_LOAD8_U, W::I64Load8U(m)),
            (I64_LOAD16_U, W::I64Load16U(m)),
            (I64_LOAD32_U, W::I64Load32U(m)),
            (I32_STORE, W::I32Store(m)),
            (I64_STORE, W::I64Store(m)),
            (I64_STORE8, W::I64Store8(m)),
            (I64_STORE16, W::I64Store16(m)),
            (I64_STORE32, W::I64Store32(m)),
            (V128_LOAD, W::V128Load(m)),
            (V128_STORE, W::V128Store(m)),
            (V128_LOAD32_ZERO, W::V128Load32Zero(m)),
            (V128_LOAD64_ZERO, W::V128Load64Zero(m)),
        ];
        for (o, w) in memarg { assert_eq!(bytes(*o), with(w.clone(), 2), "{w:?}"); }
        let lane: &[(Op, W)] = &[
            (I8X16_EXTRACT_LANE_U, W::I8x16ExtractLaneU(0)),
            (I8X16_REPLACE_LANE, W::I8x16ReplaceLane(0)),
            (I16X8_EXTRACT_LANE_U, W::I16x8ExtractLaneU(0)),
            (I16X8_REPLACE_LANE, W::I16x8ReplaceLane(0)),
            (I32X4_EXTRACT_LANE, W::I32x4ExtractLane(0)),
            (I32X4_REPLACE_LANE, W::I32x4ReplaceLane(0)),
            (I64X2_EXTRACT_LANE, W::I64x2ExtractLane(0)),
            (I64X2_REPLACE_LANE, W::I64x2ReplaceLane(0)),
            (F32X4_EXTRACT_LANE, W::F32x4ExtractLane(0)),
            (F32X4_REPLACE_LANE, W::F32x4ReplaceLane(0)),
            (F64X2_EXTRACT_LANE, W::F64x2ExtractLane(0)),
            (F64X2_REPLACE_LANE, W::F64x2ReplaceLane(0)),
        ];
        for (o, w) in lane { assert_eq!(bytes(*o), with(w.clone(), 1), "{w:?}"); }
        assert_eq!(bytes(V128_STORE32_LANE), with(W::V128Store32Lane { memarg: m, lane: 0 }, 3));
        assert_eq!(bytes(V128_STORE64_LANE), with(W::V128Store64Lane { memarg: m, lane: 0 }, 3));
        assert_eq!(bytes(MEMORY_COPY), with(W::MemoryCopy { src_mem: 0, dst_mem: 0 }, 0));
        assert_eq!(bytes(MEMORY_FILL), with(W::MemoryFill(0), 0));
        assert_eq!(bytes(MEMORY_SIZE), with(W::MemorySize(0), 0));
    }

    #[test]
    fn leb_as_wasm_encoder_writes() {
        use wasm_encoder::Encode;
        for v in [0u64, 1, 63, 64, 127, 128, 16383, 16384, u32::MAX as u64, u64::MAX] {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            uleb(&mut mine, v);
            v.encode(&mut theirs);
            assert_eq!(mine, theirs, "{v}");
        }
        for v in [0i64, -1, 63, 64, -64, -65, 8191, -8192, i64::MIN, i64::MAX] {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            sleb(&mut mine, v);
            v.encode(&mut theirs);
            assert_eq!(mine, theirs, "{v}");
        }
    }
}
