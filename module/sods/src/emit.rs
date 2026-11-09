//! Wasm code written straight into bytes: the operators the lowering makes most often by hand (an opcode and its
//! immediates as LEB128, as the binary format lays them), the rest through wasm-encoder. The bytes are the same either
//! way; by hand, an operator is a push or two, not a value built, matched, encoded and dropped.

use wasm_encoder::{BlockType, Encode, Instruction as W, MemArg, MemArgTarget, ValType};

/// An unsigned LEB128.
pub fn uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 { out.push(b); return; }
        out.push(b | 0x80);
    }
}

/// A signed LEB128.
pub fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) { out.push(b); return; }
        out.push(b | 0x80);
    }
}

/// A value type, as wasm-encoder writes it (a reference type is more than a byte).
pub fn val_type(out: &mut Vec<u8>, t: ValType) {
    match t {
        ValType::I32 => out.push(0x7f),
        ValType::I64 => out.push(0x7e),
        ValType::F32 => out.push(0x7d),
        ValType::F64 => out.push(0x7c),
        ValType::V128 => out.push(0x7b),
        ValType::Ref(_) => t.encode(out),
    }
}

fn with(out: &mut Vec<u8>, opcode: u8, v: u32) {
    out.push(opcode);
    uleb(out, v as u64);
}

/// An access to memory 0, not atomic: its immediates are its alignment and offset alone.
fn plain(m: &MemArg) -> bool { m.target == MemArgTarget::Memory(0) && m.ordering.is_none() }

fn memory(out: &mut Vec<u8>, opcode: u8, m: &MemArg) {
    out.push(opcode);
    uleb(out, m.align as u64);
    uleb(out, m.offset);
}

/// One operator.
pub fn op(out: &mut Vec<u8>, i: &W) {
    let byte = match *i {
        W::LocalGet(l) => return with(out, 0x20, l),
        W::LocalSet(l) => return with(out, 0x21, l),
        W::LocalTee(l) => return with(out, 0x22, l),
        W::GlobalGet(g) => return with(out, 0x23, g),
        W::GlobalSet(g) => return with(out, 0x24, g),
        W::I32Const(v) => { out.push(0x41); return sleb(out, v as i64); }
        W::I64Const(v) => { out.push(0x42); return sleb(out, v); }
        W::Br(d) => return with(out, 0x0c, d),
        W::BrIf(d) => return with(out, 0x0d, d),
        W::Call(f) => return with(out, 0x10, f),
        W::ReturnCall(f) => return with(out, 0x12, f),
        W::Block(BlockType::Empty) => return out.extend_from_slice(&[0x02, 0x40]),
        W::Loop(BlockType::Empty) => return out.extend_from_slice(&[0x03, 0x40]),
        W::If(BlockType::Empty) => return out.extend_from_slice(&[0x04, 0x40]),
        W::I32Load(ref m) if plain(m) => return memory(out, 0x28, m),
        W::I64Load(ref m) if plain(m) => return memory(out, 0x29, m),
        W::I32Load8U(ref m) if plain(m) => return memory(out, 0x2d, m),
        W::I32Load16U(ref m) if plain(m) => return memory(out, 0x2f, m),
        W::I64Load8U(ref m) if plain(m) => return memory(out, 0x31, m),
        W::I64Load16U(ref m) if plain(m) => return memory(out, 0x33, m),
        W::I64Load32U(ref m) if plain(m) => return memory(out, 0x35, m),
        W::I32Store(ref m) if plain(m) => return memory(out, 0x36, m),
        W::I64Store(ref m) if plain(m) => return memory(out, 0x37, m),
        W::I64Store8(ref m) if plain(m) => return memory(out, 0x3c, m),
        W::I64Store16(ref m) if plain(m) => return memory(out, 0x3d, m),
        W::I64Store32(ref m) if plain(m) => return memory(out, 0x3e, m),
        W::Unreachable => 0x00,
        W::Else => 0x05,
        W::End => 0x0b,
        W::Return => 0x0f,
        W::Drop => 0x1a,
        W::Select => 0x1b,
        W::I32Eqz => 0x45, W::I32Eq => 0x46, W::I32Ne => 0x47, W::I32LtS => 0x48, W::I32LtU => 0x49,
        W::I32GtS => 0x4a, W::I32GtU => 0x4b, W::I32LeS => 0x4c, W::I32LeU => 0x4d, W::I32GeS => 0x4e, W::I32GeU => 0x4f,
        W::I64Eqz => 0x50, W::I64Eq => 0x51, W::I64Ne => 0x52, W::I64LtS => 0x53, W::I64LtU => 0x54,
        W::I64GtS => 0x55, W::I64GtU => 0x56, W::I64LeS => 0x57, W::I64LeU => 0x58, W::I64GeS => 0x59, W::I64GeU => 0x5a,
        W::I32Add => 0x6a, W::I32Sub => 0x6b, W::I32Mul => 0x6c,
        W::I32And => 0x71, W::I32Or => 0x72, W::I32Xor => 0x73, W::I32Shl => 0x74, W::I32ShrS => 0x75, W::I32ShrU => 0x76,
        W::I64Add => 0x7c, W::I64Sub => 0x7d, W::I64Mul => 0x7e,
        W::I64And => 0x83, W::I64Or => 0x84, W::I64Xor => 0x85, W::I64Shl => 0x86, W::I64ShrS => 0x87, W::I64ShrU => 0x88,
        W::I64Rotl => 0x89, W::I64Rotr => 0x8a,
        W::I32WrapI64 => 0xa7, W::I64ExtendI32S => 0xac, W::I64ExtendI32U => 0xad,
        W::I32Extend8S => 0xc0, W::I32Extend16S => 0xc1, W::I64Extend8S => 0xc2, W::I64Extend16S => 0xc3, W::I64Extend32S => 0xc4,
        _ => return i.encode(out),
    };
    out.push(byte);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    /// Every operator written by hand is the bytes wasm-encoder writes.
    #[test]
    fn as_wasm_encoder_writes() {
        let m = |offset, align| MemArg { offset, align, target: MemArgTarget::Memory(0), ordering: None };
        let all = [
            W::LocalGet(0), W::LocalSet(127), W::LocalTee(128), W::GlobalGet(300), W::GlobalSet(1 << 20),
            W::I32Const(0), W::I32Const(-1), W::I32Const(63), W::I32Const(64), W::I32Const(-65), W::I32Const(i32::MIN), W::I32Const(i32::MAX),
            W::I64Const(0), W::I64Const(-1), W::I64Const(0xffff_ffff), W::I64Const(i64::MIN), W::I64Const(i64::MAX), W::I64Const(-8192),
            W::Br(0), W::BrIf(200), W::Call(5), W::ReturnCall(70000),
            W::Block(BlockType::Empty), W::Loop(BlockType::Empty), W::If(BlockType::Empty),
            W::I32Load(m(0, 2)), W::I64Load(m(1 << 33, 3)), W::I32Load8U(m(7, 0)), W::I32Load16U(m(128, 1)), W::I64Load8U(m(0, 0)),
            W::I64Load16U(m(9, 1)), W::I64Load32U(m(4096, 2)), W::I32Store(m(0, 2)), W::I64Store(m(65536, 3)), W::I64Store8(m(1, 0)),
            W::I64Store16(m(2, 1)), W::I64Store32(m(3, 2)),
            W::Unreachable, W::Else, W::End, W::Return, W::Drop, W::Select,
            W::I32Eqz, W::I32Eq, W::I32Ne, W::I32LtS, W::I32LtU, W::I32GtS, W::I32GtU, W::I32LeS, W::I32LeU, W::I32GeS, W::I32GeU,
            W::I64Eqz, W::I64Eq, W::I64Ne, W::I64LtS, W::I64LtU, W::I64GtS, W::I64GtU, W::I64LeS, W::I64LeU, W::I64GeS, W::I64GeU,
            W::I32Add, W::I32Sub, W::I32Mul, W::I32And, W::I32Or, W::I32Xor, W::I32Shl, W::I32ShrS, W::I32ShrU,
            W::I64Add, W::I64Sub, W::I64Mul, W::I64And, W::I64Or, W::I64Xor, W::I64Shl, W::I64ShrS, W::I64ShrU, W::I64Rotl, W::I64Rotr,
            W::I32WrapI64, W::I64ExtendI32S, W::I64ExtendI32U,
            W::I32Extend8S, W::I32Extend16S, W::I64Extend8S, W::I64Extend16S, W::I64Extend32S,
            W::BrTable(Cow::Owned(vec![0, 3, 1]), 2), W::I64Clz, W::F64Add,
        ];
        for i in &all {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            op(&mut mine, i);
            i.encode(&mut theirs);
            assert_eq!(mine, theirs, "{i:?}");
        }
        for v in [0u64, 1, 127, 128, 16383, 16384, u32::MAX as u64, u64::MAX] {
            let (mut mine, mut theirs) = (Vec::new(), Vec::new());
            uleb(&mut mine, v);
            v.encode(&mut theirs);
            assert_eq!(mine, theirs, "{v}");
        }
    }
}
