//! Small opt-in instruction-at-a-time Task proof. This is not the stock ABI,
//! a general lowering, or an occasion to fall back to raw-memory translation.
use iced_x86::{Code, Decoder, DecoderError, DecoderOptions, OpKind, Register};
use wasm_encoder::{CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction as I, Module, TypeSection, ValType};

#[derive(Debug, PartialEq, Eq)]
pub enum Rejection { Unsupported = 1, MoreBytes = 2 }

const READ: u32 = 0;
const WRITE: u32 = 1;
const REG: u32 = 2;
const SET: u32 = 3;
const SYSCALL: u32 = 4;
const TARGET: u32 = 5;
const XMM_LOW: u32 = 6;
const SET_XMM: u32 = 7;
const STORE_ALIGNED_128: u32 = 8;
const RFLAGS: i32 = 17;
const SUB_STATUS: i64 = 0x8d5; // OF, SF, ZF, AF, PF, CF only
const SP: i32 = 4;
const TMP: u32 = 1;

pub fn translate(bytes: &[u8]) -> Result<Vec<u8>, Rejection> {
    use Rejection::{MoreBytes, Unsupported};
    use ValType::{I32, I64};
    if !(1..=15).contains(&bytes.len()) { return Err(Unsupported); }
    // Only these initial bytes can begin an admitted instruction. In
    // particular a long/legacy prefix cannot cause out-of-contract decoding.
    if !matches!(bytes[0], 0x0f | 0x41 | 0x48 | 0x66 | 0x50..=0x57 | 0xb8..=0xbf | 0xc3 | 0xe8) {
        return Err(Unsupported);
    }
    let mut d = Decoder::new(64, bytes, DecoderOptions::NONE);
    let i = d.decode();
    match d.last_error() {
        DecoderError::NoMoreBytes => return Err(MoreBytes),
        DecoderError::None => (),
        _ => return Err(Unsupported),
    }
    if i.len() != bytes.len() { return Err(Unsupported); }
    let n = i.len() as i64;
    let pc_after = [I::LocalGet(0), I::I64Const(n), I::I64Add];
    let r = |r: Register| (r as i32) - (Register::RAX as i32);
    let e = |r: Register| (r as i32) - (Register::EAX as i32);
    let x = |r: Register| (r as i32) - (Register::XMM0 as i32);
    let sub_sp = i.code() == Code::Sub_rm64_imm32 && n == 7 && bytes[0..3] == [0x48,0x81,0xec];
    let mut vector = false;
    let mut f = Function::new([(if sub_sp { 2 } else { 1 }, I64)]); // 0 = RIP, 1-2 scratch
    let mut emit = |seq: &[I<'_>]| { for x in seq { f.instruction(x); } };

    if i.code() == Code::Retnq && bytes == [0xc3] {
        // Capture the entire checked load and a canonical target before
        // committing RSP; execute rights are checked on the subsequent fetch.
        emit(&[I::I32Const(SP), I::Call(REG), I::Call(READ), I::Call(TARGET), I::LocalSet(TMP)]);
        emit(&[I::I32Const(SP), I::I32Const(SP), I::Call(REG), I::I64Const(8), I::I64Add, I::Call(SET), I::LocalGet(TMP)]);
    } else if i.code() == Code::Call_rel32_64 && bytes[0] == 0xe8 && n == 5 {
        let delta = i32::from_le_bytes(bytes[1..5].try_into().unwrap()) as i64;
        emit(&pc_after);
        emit(&[I::I64Const(delta), I::I64Add, I::Call(TARGET), I::LocalSet(TMP)]);
        emit(&[I::I32Const(SP), I::Call(REG), I::I64Const(8), I::I64Sub]);
        emit(&pc_after);
        emit(&[I::Call(WRITE), I::I32Const(SP), I::I32Const(SP), I::Call(REG), I::I64Const(8), I::I64Sub, I::Call(SET), I::LocalGet(TMP)]);
    } else {
        match i.code() {
            Code::Mov_r32_imm32 if n == 5 && (0xb8..=0xbf).contains(&bytes[0]) => {
                emit(&[I::I32Const(e(i.op0_register())), I::I64Const(i.immediate32() as i64), I::Call(SET)]);
            }
            Code::Mov_r64_imm64 if n == 10 && bytes[0] == 0x48 && (0xb8..=0xbf).contains(&bytes[1]) => {
                emit(&[I::I32Const(r(i.op0_register())), I::I64Const(i.immediate64() as i64), I::Call(SET)]);
            }
            // Exact REX.W LEA r64,[RIP+disp32], as in the pinned
            // interpreter's real _dl_start prefix. No dereference or flags;
            // a potentially noncanonical bit pattern is legal for LEA alone.
            Code::Lea_r64_m if n == 7 && bytes[0..2] == [0x48,0x8d] && bytes[2] & 0xc7 == 5
                && i.op1_kind() == OpKind::Memory && i.memory_base() == Register::RIP
                && i.memory_index() == Register::None => {
                let delta = i32::from_le_bytes(bytes[3..7].try_into().unwrap()) as i64;
                emit(&[I::I32Const(r(i.op0_register()))]);
                emit(&pc_after);
                emit(&[I::I64Const(delta), I::I64Add, I::Call(SET)]);
            }
            Code::Mov_rm64_r64 if n == 3 && bytes[0..2] == [0x48,0x89]
                && i.op0_kind() == OpKind::Register && i.op1_kind() == OpKind::Register => {
                emit(&[I::I32Const(r(i.op0_register())), I::I32Const(r(i.op1_register())), I::Call(REG), I::Call(SET)]);
            }
            // Just the exact no-displacement [rsp] memory load, no other
            // SIB forms, segment overrides, writes, or address-size prefix.
            Code::Mov_r64_rm64 if n == 4 && bytes[0..2] == [0x48,0x8b] && bytes[2] & 0xc7 == 4
                && bytes[3] == 0x24 && i.op1_kind() == OpKind::Memory
                && i.memory_base() == Register::RSP && i.memory_index() == Register::None => {
                emit(&[I::I32Const(r(i.op0_register())), I::I32Const(SP), I::Call(REG), I::Call(READ), I::Call(SET)]);
            }
            Code::Push_r64 if (n == 1 && (0x50..=0x57).contains(&bytes[0]))
                || (n == 2 && bytes[0] == 0x41 && (0x50..=0x57).contains(&bytes[1])) => {
                emit(&[I::I32Const(SP), I::Call(REG), I::I64Const(8), I::I64Sub, I::LocalTee(TMP),
                    I::I32Const(r(i.op0_register())), I::Call(REG), I::Call(WRITE), I::I32Const(SP), I::LocalGet(TMP), I::Call(SET)]);
            }
            Code::Movq_xmm_rm64 if n == 5 && bytes[0..4] == [0x66,0x48,0x0f,0x6e]
                && bytes[4] & 0xc0 == 0xc0 && i.op1_kind() == OpKind::Register => {
                // Legacy MOVQ from GPR defines the upper 64 bits as zero.
                vector = true;
                emit(&[I::I32Const(x(i.op0_register())), I::I32Const(r(i.op1_register())), I::Call(REG),
                    I::I64Const(0), I::Call(SET_XMM)]);
            }
            Code::Punpcklqdq_xmm_xmmm128 if n == 4 && bytes[0..3] == [0x66,0x0f,0x6c]
                && bytes[3] & 0xc0 == 0xc0 && i.op1_kind() == OpKind::Register => {
                // Read both inputs before replacing the destination, also for self-alias.
                vector = true;
                let dst = x(i.op0_register());
                emit(&[I::I32Const(dst), I::I32Const(dst), I::Call(XMM_LOW),
                    I::I32Const(x(i.op1_register())), I::Call(XMM_LOW), I::Call(SET_XMM)]);
            }
            Code::Movaps_xmmm128_xmm if n == 4 && bytes[0..2] == [0x0f,0x29] && bytes[2] & 0xc7 == 0x45
                && i.op0_kind() == OpKind::Memory && i.memory_base() == Register::RBP
                && i.memory_index() == Register::None => {
                vector = true;
                emit(&[I::I32Const(r(Register::RBP)), I::Call(REG), I::I64Const(bytes[3] as i8 as i64), I::I64Add,
                    I::I32Const(x(i.op1_register())), I::Call(STORE_ALIGNED_128)]);
            }
            Code::Mov_rm64_r64 if n == 7 && bytes[0..2] == [0x48,0x89] && bytes[2] & 0xc7 == 0x85
                && i.op0_kind() == OpKind::Memory && i.memory_base() == Register::RBP
                && i.memory_index() == Register::None => {
                let disp = i32::from_le_bytes(bytes[3..7].try_into().unwrap()) as i64;
                emit(&[I::I32Const(r(Register::RBP)), I::Call(REG), I::I64Const(disp), I::I64Add,
                    I::I32Const(r(i.op1_register())), I::Call(REG), I::Call(WRITE)]);
            }
            Code::Sub_rm64_imm32 if sub_sp => {
                // Exact SUB rsp, sign-extended imm32. Keep raw architectural
                // RFLAGS distinct from the stock lowerer's flag encoding.
                let b = I::I64Const(i32::from_le_bytes(bytes[3..7].try_into().unwrap()) as i64);
                const A: I<'static> = I::LocalGet(1);
                const R: I<'static> = I::LocalGet(2);
                emit(&[I::I32Const(SP), I::Call(REG), I::LocalTee(1), b.clone(), I::I64Sub, I::LocalSet(2)]);
                emit(&[I::I32Const(RFLAGS), I::I32Const(RFLAGS), I::Call(REG), I::I64Const(!SUB_STATUS), I::I64And]);
                emit(&[A, b.clone(), I::I64LtU, I::I64ExtendI32U, I::I64Or]); // CF: unsigned borrow
                emit(&[R, I::I64Const(255), I::I64And, I::I64Popcnt, I::I64Const(1), I::I64And,
                    I::I64Const(1), I::I64Xor, I::I64Const(2), I::I64Shl, I::I64Or]); // PF: even low byte
                emit(&[A, b.clone(), I::I64Xor, R, I::I64Xor, I::I64Const(16), I::I64And, I::I64Or]); // AF
                emit(&[R, I::I64Eqz, I::I64ExtendI32U, I::I64Const(6), I::I64Shl, I::I64Or]); // ZF
                emit(&[R, I::I64Const(63), I::I64ShrU, I::I64Const(7), I::I64Shl, I::I64Or]); // SF
                emit(&[A, b, I::I64Xor, A, R, I::I64Xor, I::I64And, I::I64Const(63), I::I64ShrU,
                    I::I64Const(11), I::I64Shl, I::I64Or, I::Call(SET)]); // OF
                emit(&[I::I32Const(SP), R, I::Call(SET)]);
            }
            Code::Syscall if bytes == [0x0f,0x05] => {
                emit(&pc_after);
                emit(&[I::Call(SYSCALL)]);
            }
            _ => return Err(Unsupported),
        }
        emit(&pc_after);
    }
    emit(&[I::End]);
    let mut types = TypeSection::new();
    types.ty().function([I64], [I64]); // read64 and target
    types.ty().function([I64, I64], []); // write64
    types.ty().function([I32], [I64]); // reg
    types.ty().function([I32, I64], []); // set
    types.ty().function([I64], []); // syscall
    let mut imports = ImportSection::new();
    for (name, signature) in [("read64",0),("write64",1),("reg",2),("set",3),("syscall",4),("target",0)] {
        imports.import("guard", name, EntityType::Function(signature));
    }
    // Preserve the exact scalar ABI for non-vector steps. The extended ABI
    // exposes register lanes and one checked operation, never a Memory.
    if vector {
        types.ty().function([I32, I64, I64], []); // replace both lanes
        types.ty().function([I64, I32], []); // checked aligned store of lane pair
        for (name, ty) in [("xmmLow",2),("setXmm",5),("storeAligned128",6)] {
            imports.import("guard",name,EntityType::Function(ty));
        }
    }
    let mut functions = FunctionSection::new();
    functions.function(0);
    let mut exports = ExportSection::new();
    exports.export("step", ExportKind::Func, if vector { 9 } else { 6 });
    let mut body = CodeSection::new();
    body.function(&f);
    let mut module = Module::new();
    module.section(&types).section(&imports).section(&functions).section(&exports).section(&body);
    Ok(module.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_closed_encodings_generate_memoryless_steps() {
        for bytes in [[0x54].as_slice(), &[0x57], &[0xc3], &[0xe8,0,0,0,0], &[0x0f,0x05],
            &[0xba,0,0,0,0x80], &[0x48,0xb8,1,0,0,0,1,0,0,0], &[0x48,0x89,0xe6], &[0x48,0x8b,0x3c,0x24], &[0x48,0x8d,0x35,0xc8,0x21,0xfe,0xff],
            &[0x66,0x48,0x0f,0x6e,0xd6], &[0x66,0x0f,0x6c,0xd3], &[0x0f,0x29,0x55,0x80], &[0x41,0x57],
            &[0x48,0x81,0xec,0x88,0,0,0], &[0x48,0x89,0xbd,0x78,0xff,0xff,0xff]] {
            let wasm = translate(bytes).unwrap();
            wasmparser::Validator::new().validate_all(&wasm).unwrap();
            assert!(!wasmparser::Parser::new(0).parse_all(&wasm).any(|x| matches!(x.unwrap(), wasmparser::Payload::MemorySection(_))));
        }
    }

    #[test]
    fn a_partial_instruction_is_not_an_admitted_instruction() {
        for bytes in [[0x48].as_slice(), &[0x0f], &[0xe8,0,0,0], &[0x48,0x8b,0x04]] {
            assert_eq!(translate(bytes), Err(Rejection::MoreBytes));
        }
        for bytes in [[0x90].as_slice(), &[0x66,0x54], &[0xf3,0xc3], &[0x48,0x89,0x04,0x24], &[0x48,0x8b,0x04,0x64],
            &[0x0f,0xa2], &[0xc3,0x90], &[0x48,0x8d,0x04,0x25,0,0,0,0], &[0x4c,0x8d,0x05,0,0,0,0], &[0x48,0xc7,0xc0,0,0,0,0],
            &[0x66,0x48,0x0f,0x6e,0x16], &[0x66,0x0f,0x6c,0x13], &[0x0f,0x29,0xd5], &[0x0f,0x29,0x56,0x80],
            &[0x48,0x81,0xe9,0x88,0,0,0], &[0x0f,0x31]] {
            assert_eq!(translate(bytes), Err(Rejection::Unsupported));
        }
    }
}
