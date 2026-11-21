//! A closed guarded scalar probe, not a guest exec path. Translate a verified
//! x86 byte span ending immediately before its RET boundary:
//! mov rax,[rdi+signed disp]; mov [rsi+signed disp],rax; (RET not lowered).
//! The generated module imports checked accesses, not a raw linear memory.
use iced_x86::{Code, Decoder, DecoderOptions, OpKind, Register};
use wasm_encoder::{CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction as I, Module, TypeSection, ValType};

pub const UNSUPPORTED: &str = "unsupported guarded scalar span";

/// The accepted initial encoding has exactly REX.W, no other prefixes or SIB.
fn displacement(bytes: &[u8], load: bool) -> Option<(usize, i64)> {
    let op = if load { 0x8b } else { 0x89 };
    let rm = if load { 7 } else { 6 };
    if bytes.first() != Some(&0x48) || bytes.get(1) != Some(&op) { return None; }
    let (len, disp) = match *bytes.get(2)? {
        m if m == rm => (3, 0),
        m if m == (0x40 | rm) => (4, *bytes.get(3)? as i8 as i64),
        m if m == (0x80 | rm) => (7, i32::from_le_bytes(bytes.get(3..7)?.try_into().ok()?) as i64),
        _ => return None,
    };
    let mut decoder = Decoder::new(64, bytes.get(..len)?, DecoderOptions::NONE);
    let i = decoder.decode();
    let (form, base, kinds) = if load { (Code::Mov_r64_rm64, Register::RDI, (OpKind::Register, OpKind::Memory)) }
        else { (Code::Mov_rm64_r64, Register::RSI, (OpKind::Memory, OpKind::Register)) };
    let reg = if load { i.op0_register() } else { i.op1_register() };
    if i.code() != form || i.len() != len || decoder.can_decode() || (i.op0_kind(), i.op1_kind()) != kinds
        || reg != Register::RAX || i.memory_base() != base || i.memory_index() != Register::None
        || i.memory_displacement64() as i64 != disp { return None; }
    Some((len, disp))
}

pub fn translate(code: &[u8]) -> Result<Vec<u8>, &'static str> {
    if !(7..=15).contains(&code.len()) { return Err(UNSUPPORTED); }
    let (n, source) = displacement(code, true).ok_or(UNSUPPORTED)?;
    let (m, destination) = displacement(&code[n..], false).ok_or(UNSUPPORTED)?;
    if code.get(n + m..) != Some(&[0xc3]) { return Err(UNSUPPORTED); }

    let mut types = TypeSection::new();
    use ValType::{I32, I64};
    types.ty().function([I64, I32], [I64]); // guard.read(address, width)
    types.ty().function([I64, I32, I64], []); // guard.write(address, width, value)
    types.ty().function([I64, I64], [I64]); // run(rdi, rsi) -> rax at the instruction boundary
    let mut imports = ImportSection::new();
    imports.import("guard", "read", EntityType::Function(0));
    imports.import("guard", "write", EntityType::Function(1));
    let mut functions = FunctionSection::new();
    functions.function(2);
    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, 2);
    let mut function = Function::new([(1, I64)]);
    for i in [
        I::LocalGet(0), I::I64Const(source), I::I64Add, I::I32Const(8), I::Call(0), I::LocalSet(2),
        I::LocalGet(1), I::I64Const(destination), I::I64Add, I::I32Const(8), I::LocalGet(2), I::Call(1),
        I::LocalGet(2), I::End,
    ] { function.instruction(&i); }
    let mut body = CodeSection::new();
    body.function(&function);
    let mut module = Module::new();
    module.section(&types).section(&imports).section(&functions).section(&exports).section(&body);
    Ok(module.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_encodings_and_memoryless_output() {
        for bytes in [
            &[0x48,0x8b,0x07,0x48,0x89,0x06,0xc3][..],
            &[0x48,0x8b,0x47,0xf8,0x48,0x89,0x46,0x10,0xc3],
            &[0x48,0x8b,0x87,0x00,0x80,0xff,0xff,0x48,0x89,0x86,0xaa,0,0,0,0xc3],
        ] {
            let wasm = translate(bytes).unwrap();
            wasmparser::Validator::new().validate_all(&wasm).unwrap();
            assert!(!wasmparser::Parser::new(0).parse_all(&wasm).any(|x| matches!(x.unwrap(), wasmparser::Payload::MemorySection(_))));
        }
    }

    #[test]
    fn unsupported_is_an_error_not_replayed_through_normal_lowering() {
        for bytes in [
            &[0x90,0x48,0x8b,0x07,0x48,0x89,0x06,0xc3][..],
            &[0x64,0x48,0x8b,0x07,0x48,0x89,0x06,0xc3],
            &[0x48,0x8b,0x07,0x48,0x89,0x07,0xc3],
            &[0x48,0x8b,0x07,0x48,0x89,0x06,0xc3,0x90],
            &[0x48,0x8b,0x47,0x80,0x48,0x89,0x46,0xc3],
        ] { assert_eq!(translate(bytes), Err(UNSUPPORTED)); }
    }
}
