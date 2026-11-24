//! The module around the guest's code: its types, imports, globals, table and helpers (64x64 high products, entry
//! resolution and the dispatcher), the program's image and entry table, its names and the facts the loader reads;
//! the code itself written into one buffer as the kernel makes each function.

use crate::abi::*;
use crate::elf::Elf;
use crate::facts::{summarize, Liveness};
use crate::frame::Report;
use crate::lower::{lower_with_imports, Frame, Lowering};
use crate::program::{Entries, Program};
use crate::wasm::uleb;
use std::borrow::Cow;
use std::sync::OnceLock;
use wasm_encoder::{
    BlockType, ConstExpr, CustomSection, ElementSection, Elements, Encode, EntityType, ExportKind, ExportSection,
    Function as WasmFunction, FunctionSection, GlobalSection, GlobalType, ImportSection, Instruction as W, MemArg,
    MemArgTarget, MemoryType, Module, RefType, Section, SectionId, TableSection, TableType, TypeSection, ValType,
};

// ---- Module indices ----
const T_FN: u32 = 0; // (block i32) -> next address i64
const T_SYSCALL: u32 = 1;
const T_TRAP: u32 = 2;
const T_DIV: u32 = 3;
const T_CLOCK: u32 = 4;
const T_PAIR: u32 = 5; // (i64, i64) -> i64
const T_RESOLVE: u32 = 6;
const T_RUN: u32 = 7;
const T_FPU: u32 = 8; // (registers, op, size, st a, st b, operand, its top word) -> i64
const T_TRACE: u32 = 9; // (i64) -> ()
const T_TIME: u32 = 10; // (clock id) -> ms, NaN when the kernel is to answer
const T_MAPPED_ACCESS: u32 = 11; // (wide address, access or FX operation) -> i32
const T_MAPPED_STRING: u32 = 12; // (dst, src, count, value, width, mode) -> bytes moved
const T_MAPPED_FPU: u32 = 13; // (op, size, st a, st b, lo, hi, instruction pointer, opcode) -> i64

/// The first module's own functions (mulhu to run), made before the guest's.
const HELPERS: u32 = FIRST_GUEST - F_MULHU;
/// Imported functions, in index order: the host's, then (in a module made later) the first module's.
const HOST_IMPORTS: [&str; 8] = ["syscall", "trap", "div128", "clock", "fpu", "trace", "miss", "time"];
const SHARED: [&str; 5] = ["mulhu", "mulhs", "resolve", "dispatch", "run"];
const GLOBAL_NAMES: [&str; GLOBALS as usize + 1] = [
    "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
    "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15", "fs",
    "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7",
    "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15",
    "fl", "budget", "depth", "low", "x87", "rf", "mxcsr",
];
fn global_type(n: u32) -> ValType {
    match n {
        0..=G_FS | G_FLAGS | G_LOW | G_RF => ValType::I64,
        G_BUDGET | G_DEPTH | G_X87 | G_MXCSR | G_MAPPED_BASE => ValType::I32,
        _ => ValType::V128,
    }
}

fn mem_at(offset: u64, align: u32) -> MemArg { MemArg { offset, align, target: MemArgTarget::Memory(0), ordering: None } }


/// Slots in the dispatcher's cache of where addresses were found (16 bytes
/// each, past the entry table). One gcc building hello dispatched 1.8
/// million times to code made later, each a call out to the host before.
const DISPATCH_CACHE: u64 = 1 << 14;

// Only the mapped core can name these memories. Fragments import guest RAM.
#[cfg(feature = "mapped-code")]
const MAPPED_ENTRY_MEMORY: u32 = 1;
#[cfg(feature = "mapped-code")]
const MAPPED_ACCESS_MEMORY: u32 = 2;
#[cfg(feature = "mapped-code")]
const MAPPED_CONTEXT_MEMORY: u32 = 3;
#[cfg(feature = "mapped-code")]
const MAPPED_CORE_TRAP: u32 = 0;
#[cfg(feature = "mapped-code")]
const MAPPED_CORE_MISS: u32 = 1;
#[cfg(feature = "mapped-code")]
const MAPPED_CORE_ACCESS: u32 = 2;
#[cfg(feature = "mapped-code")]
const MAPPED_CORE_HELPERS: u32 = 3;

/// Common 64x64 high products.
fn math_helpers(code: &mut Out, mulhu: u32) {
    // mulhu(a, b): schoolbook on 32-bit halves.
    let mut f = WasmFunction::new([(6, ValType::I64)]);
    let (a, b, al, ah, bl, bh, mid, t) = (0, 1, 2, 3, 4, 5, 6, 7);
    for (dst, src, shift) in [(al, a, false), (ah, a, true), (bl, b, false), (bh, b, true)] {
        f.instruction(&W::LocalGet(src));
        if shift { f.instruction(&W::I64Const(32)); f.instruction(&W::I64ShrU); } else { f.instruction(&W::I64Const(0xffff_ffff)); f.instruction(&W::I64And); }
        f.instruction(&W::LocalSet(dst));
    }
    // t = al*bl >> 32 ; mid = ah*bl + t ; t = al*bh + (mid & 0xffffffff)
    for i in [
        W::LocalGet(al), W::LocalGet(bl), W::I64Mul, W::I64Const(32), W::I64ShrU, W::LocalSet(t),
        W::LocalGet(ah), W::LocalGet(bl), W::I64Mul, W::LocalGet(t), W::I64Add, W::LocalSet(mid),
        W::LocalGet(al), W::LocalGet(bh), W::I64Mul, W::LocalGet(mid), W::I64Const(0xffff_ffff), W::I64And, W::I64Add,
        W::LocalSet(t),
        W::LocalGet(ah), W::LocalGet(bh), W::I64Mul, W::LocalGet(mid), W::I64Const(32), W::I64ShrU, W::I64Add,
        W::LocalGet(t), W::I64Const(32), W::I64ShrU, W::I64Add, W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

    // mulhs(a, b) = mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)
    let mut f = WasmFunction::new([]);
    for i in [
        W::LocalGet(0), W::LocalGet(1), W::Call(mulhu),
        W::LocalGet(1), W::I64Const(0), W::LocalGet(0), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::LocalGet(0), W::I64Const(0), W::LocalGet(1), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

}

/// The static entry table and cache are in guest memory, past a fixed image.
fn static_lookup(code: &mut Out, entries: u32, table: u64, cache: u64) {
    // resolve(addr): what the dispatch cache (below) holds for it, else a binary search of the sorted 16-byte entries
    // in memory 1, what it finds kept there: an indirect jump within a function (a switch's table), and the frame a
    // longjmp lands in, look it up again and again.
    let m1 = |offset| mem_at(table + offset, 3);
    let mc = |offset| mem_at(cache + offset, 3);
    let mut f = WasmFunction::new([(4, ValType::I32), (1, ValType::I64)]);
    let (addr, lo, hi, mid, at, key) = (0, 1, 2, 3, 4, 5);
    for i in [
        W::LocalGet(addr), W::I64Const(0x9e37_79b9_7f4a_7c15u64 as i64), W::I64Mul, W::I64Const(64 - DISPATCH_CACHE.trailing_zeros() as i64), W::I64ShrU,
        W::I32WrapI64, W::I32Const(4), W::I32Shl, W::LocalSet(at),
        W::LocalGet(at), W::I64Load(mc(0)), W::LocalGet(addr), W::I64Eq, W::LocalGet(addr), W::I64Const(0), W::I64Ne, W::I32And,
        W::If(BlockType::Empty), W::LocalGet(at), W::I64Load(mc(8)), W::Return, W::End,
        W::I32Const(0), W::LocalSet(lo), W::I32Const(entries as i32), W::LocalSet(hi),
        W::Block(BlockType::Empty), W::Loop(BlockType::Empty),
        W::LocalGet(lo), W::LocalGet(hi), W::I32GeU, W::BrIf(1),
        W::LocalGet(lo), W::LocalGet(hi), W::I32Add, W::I32Const(1), W::I32ShrU, W::LocalSet(mid),
        W::LocalGet(mid), W::I32Const(4), W::I32Shl, W::I64Load(m1(0)), W::LocalTee(key),
        W::LocalGet(addr), W::I64Eq,
        W::If(BlockType::Empty),
        W::LocalGet(at), W::LocalGet(addr), W::I64Store(mc(0)),
        W::LocalGet(at), W::LocalGet(mid), W::I32Const(4), W::I32Shl, W::I64Load(m1(8)), W::LocalTee(key), W::I64Store(mc(8)),
        W::LocalGet(key), W::Return,
        W::End,
        W::LocalGet(key), W::LocalGet(addr), W::I64LtU,
        W::If(BlockType::Empty), W::LocalGet(mid), W::I32Const(1), W::I32Add, W::LocalSet(lo),
        W::Else, W::LocalGet(mid), W::LocalSet(hi), W::End,
        W::Br(0), W::End, W::End,
        W::I64Const(-1), W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

    // dispatch(addr): enter the function holding addr at that block. Where
    // an address was found is kept in a direct-mapped cache past the entry
    // table (address, then function << 32 | block): a call between modules
    // made later, or a return out of every translated frame, then costs a
    // load and a compare, not a search and a call out to the host. An empty
    // slot holds address 0, which is never taken as found.
    let mc = |offset| mem_at(cache + offset, 3);
    let mut f = WasmFunction::new([(1, ValType::I64), (1, ValType::I32)]);
    let (v, at) = (1, 2);
    for i in [
        W::LocalGet(0), W::I64Const(0x9e37_79b9_7f4a_7c15u64 as i64), W::I64Mul, W::I64Const(64 - DISPATCH_CACHE.trailing_zeros() as i64), W::I64ShrU,
        W::I32WrapI64, W::I32Const(4), W::I32Shl, W::LocalSet(at),
        W::LocalGet(at), W::I64Load(mc(0)), W::LocalGet(0), W::I64Eq, W::LocalGet(0), W::I64Const(0), W::I64Ne, W::I32And,
        W::If(BlockType::Empty), W::LocalGet(at), W::I64Load(mc(8)), W::LocalSet(v),
        W::Else,
        W::LocalGet(0), W::Call(F_RESOLVE), W::LocalTee(v), W::I64Const(0), W::I64LtS,
        // Not in this module's table: the host translates it now, or says it cannot.
        W::If(BlockType::Empty), W::LocalGet(0), W::Call(F_MISS), W::LocalSet(v), W::End,
        W::LocalGet(v), W::I64Const(0), W::I64LtS,
        W::If(BlockType::Empty), W::LocalGet(0), W::I32Const(TRAP_UNMAPPED_TARGET), W::Call(F_TRAP), W::Unreachable, W::End,
        W::LocalGet(at), W::LocalGet(0), W::I64Store(mc(0)),
        W::LocalGet(at), W::LocalGet(v), W::I64Store(mc(8)),
        W::End,
        W::LocalGet(1), W::I32WrapI64,
        W::LocalGet(1), W::I64Const(32), W::I64ShrU, W::I32WrapI64,
        W::ReturnCallIndirect { type_index: T_FN, table_index: 0 },
        W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

}

/// Resolve all published PCs inside the core. Entries are kept at most
/// half full by the host so linear probing always encounters an empty key.
/// The core only reads this memory. Its shift shares slot zero's padding.
#[cfg(feature = "mapped-code")]
fn mapped_lookup(code: &mut Out) {
    let index = |offset, align| MemArg { offset, align, target: MemArgTarget::Memory(MAPPED_ENTRY_MEMORY), ordering: None };
    let (pc, shift, slot, key, at) = (0, 1, 2, 3, 4);
    let mut f = WasmFunction::new([(4, ValType::I32)]);
    for i in [
        W::I32Const(0), W::I32Load(index(4, 2)), W::LocalSet(shift),
        W::LocalGet(pc), W::I32WrapI64, W::I32Const(0x9e37_79b1u32 as i32), W::I32Mul,
        W::LocalGet(shift), W::I32ShrU, W::LocalSet(slot),
        W::Block(BlockType::Empty), W::Loop(BlockType::Empty),
        W::LocalGet(slot), W::I32Const(4), W::I32Shl, W::LocalTee(at),
        W::I32Load(index(0, 2)), W::LocalTee(key), W::I32Eqz, W::BrIf(1),
        W::LocalGet(key), W::I64ExtendI32U, W::LocalGet(pc), W::I64Eq,
        W::If(BlockType::Empty), W::LocalGet(at), W::I64Load(index(8, 3)), W::Return, W::End,
        W::LocalGet(slot), W::I32Const(1), W::I32Add,
        W::I32Const(-1), W::LocalGet(shift), W::I32ShrU, W::I32And, W::LocalSet(slot),
        W::Br(0), W::End, W::End,
        W::LocalGet(pc), W::Call(MAPPED_CORE_MISS), W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

    let mut f = WasmFunction::new([(1, ValType::I64)]);
    for i in [
        W::LocalGet(0), W::Call(MAPPED_CORE_HELPERS + F_RESOLVE - F_MULHU), W::LocalTee(1), W::I64Const(0), W::I64LtS,
        W::If(BlockType::Empty), W::LocalGet(0), W::I32Const(TRAP_UNMAPPED_TARGET),
        W::Call(MAPPED_CORE_TRAP), W::Unreachable, W::End,
        W::LocalGet(1), W::I32WrapI64,
        W::LocalGet(1), W::I64Const(32), W::I64ShrU, W::I32WrapI64,
        W::ReturnCallIndirect { type_index: T_FN, table_index: 0 }, W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);
}

fn run_loop(code: &mut Out, dispatch: u32) {
    // run(addr): follow returns that leave every translated frame.
    let mut f = WasmFunction::new([]);
    for i in [
        W::Loop(BlockType::Empty), W::LocalGet(0), W::Call(dispatch), W::LocalSet(0), W::Br(0), W::End, W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

}

/// Every function of `program`, lowered into `code` in order, as the table holds them from `base`. Each is lowered
/// on its own, so natively they share the cores; wasm has one thread and lowers in turn, each into the module as it
/// is made (a big program's functions are most of what the translator would otherwise hold at once).
fn lower_all(elf: &Elf, program: &Program, base: u32, replay_targets: Option<&Entries>,
    options: Options, report: &mut Report, code: &mut Out, frame: &mut Frame) -> bool {
    let summaries = summarize(elf, program);
    let resumable_syscalls = elf.mapped();
    let handed = Liveness::for_lowering(program, &summaries, resumable_syscalls);
    let cx = Lowering { elf, program, handed: &handed, summaries: &summaries, trace: options.trace, resumable_syscalls };
    let n = program.functions.len();
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    let mut xmm_imports = false;
    // A few functions are not worth a thread.
    if threads == 1 || n < 64 {
        for f in 0..n { xmm_imports |= lower_with_imports(&cx, f as u32, base, replay_targets, report, frame, &mut code.wasm); }
        return xmm_imports;
    }
    let size = n.div_ceil(threads);
    // Each thread's functions in one buffer, each with its size before it, as the code section holds them.
    let parts = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..n).step_by(size).map(|at| {
            let cx = &cx;
            scope.spawn(move || {
                let mut r = Report::default();
                let (mut made, mut frame) = (Vec::new(), Frame::default());
                let mut xmm = false;
                for f in at..(at + size).min(n) {
                    xmm |= lower_with_imports(cx, f as u32, base, replay_targets, &mut r, &mut frame, &mut made);
                }
                (made, r, xmm)
            })
        }).collect();
        workers.into_iter().map(|w| w.join().expect("a lowering thread panicked")).collect::<Vec<_>>()
    });
    for (functions, r, xmm) in parts {
        code.wasm.extend_from_slice(&functions);
        report.blocks += r.blocks;
        report.instructions += r.instructions;
        xmm_imports |= xmm;
        for (m, k) in r.unsupported { *report.unsupported.entry(m).or_default() += k; }
    }
    xmm_imports
}

/// A module written into one buffer as it is made: the sections before its code, then the code section as its
/// functions are lowered (its size, not known until they all are, written last), then the
/// sections after. A big program's translation is nearly all its code, held once: not in a section of its own and
/// then again in the module. (A module grown as it is written holds it a few times over at once, in a memory that
/// only grows, and each time it grows, an engine may collect its whole heap: room for it all is made at the start.)
struct Out {
    wasm: Vec<u8>,
    /// Where the code section's size goes: five bytes kept for it.
    size_at: usize,
}

impl Out {
    /// The header and `head`, then the code section's id, size reservation
    /// and function count. Reserve the estimated module size up front.
    fn new(head: &[&dyn Section], functions: u32, room: usize) -> Out {
        Self::after_prefix(&Module::HEADER, head, functions, room)
    }

    fn after_prefix(prefix: &[u8], head: &[&dyn Section], functions: u32, room: usize) -> Out {
        let mut wasm = Vec::with_capacity(prefix.len() + room);
        wasm.extend_from_slice(prefix);
        for s in head { s.append_to(&mut wasm); }
        wasm.push(SectionId::Code as u8);
        let size_at = wasm.len();
        wasm.extend_from_slice(&[0; 5]);
        uleb(&mut wasm, functions as u64);
        Out { wasm, size_at }
    }

    /// A function wasm-encoder made.
    fn encoded(&mut self, f: &WasmFunction) { f.encode(&mut self.wasm); }

    /// Fill the reserved five-byte u32 LEB128 without moving the code section.
    fn finish(mut self, image: Option<&Image>, tail: &[&dyn Section]) -> Vec<u8> {
        let from = self.size_at + 5;
        let mut size = u32::try_from(self.wasm.len() - from).expect("Wasm code section fits in u32");
        for byte in &mut self.wasm[self.size_at..from - 1] {
            *byte = (size & 0x7f) as u8 | 0x80;
            size >>= 7;
        }
        self.wasm[from - 1] = size as u8;
        if let Some(i) = image { i.append_to(&mut self.wasm); }
        for s in tail { s.append_to(&mut self.wasm); }
        self.wasm
    }
}

/// About how many bytes a module of `program` takes past its head: its code (35 or so for each instruction, every
/// program measured), `data` bytes of image, the names, starts and entries.
fn room(program: &Program, data: usize) -> usize {
    function_room(program) + data + 4096
}

fn function_room(program: &Program) -> usize {
    let instructions: usize = program.functions.iter().flat_map(|f| &f.blocks).map(|b| b.count as usize).sum();
    instructions * 40 + program.functions.len() * 48 + program.entries.len() * 16
}

/// The data section: each segment's bytes (an address, then the bytes there), written from where they lie (an
/// ELF's own bytes are the most of them; wasm_encoder's DataSection would copy them in first).
struct Image<'a>(Vec<(u64, &'a [u8])>);

impl Image<'_> {
    /// Each segment's head: active in memory 0 at a constant address, then its size.
    fn heads(&self) -> Vec<Vec<u8>> {
        self.0.iter().map(|&(at, bytes)| {
            let mut h = vec![0];
            ConstExpr::i32_const(at as i32).encode(&mut h);
            (bytes.len() as u32).encode(&mut h);
            h
        }).collect()
    }

    /// Its contents' size: the count, then each segment.
    fn byte_len(&self) -> usize {
        let mut count = Vec::new();
        (self.0.len() as u32).encode(&mut count);
        count.len() + self.heads().iter().zip(&self.0).map(|(h, s)| h.len() + s.1.len()).sum::<usize>()
    }
}

impl Encode for Image<'_> {
    fn encode(&self, sink: &mut Vec<u8>) {
        (self.byte_len() as u32).encode(sink);
        (self.0.len() as u32).encode(sink);
        for (h, s) in self.heads().iter().zip(&self.0) {
            sink.extend_from_slice(h);
            sink.extend_from_slice(s.1);
        }
    }
}

impl Section for Image<'_> {
    fn id(&self) -> u8 { SectionId::Data.into() }
}

#[derive(Clone, Copy, Default)]
pub struct Options {
    /// Report every block entry to the host's `trace` import.
    pub trace: bool,
}

pub struct Translation {
    pub wasm: Vec<u8>,
    pub report: Report,
}

/// The output's first byte may follow room left for a larger import prefix.
/// Wasm callers consume the exact slice without moving the code section.
#[derive(Default)]
pub(crate) struct OutputBytes {
    bytes: Vec<u8>,
    start: usize,
}

impl From<Vec<u8>> for OutputBytes {
    fn from(bytes: Vec<u8>) -> Self { Self {bytes, start: 0} }
}

impl OutputBytes {
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn as_slice(&self) -> &[u8] { &self.bytes[self.start..] }

    fn into_vec(mut self) -> Vec<u8> {
        drop(self.bytes.drain(..self.start));
        self.bytes
    }
}

/// Where the lowest loaded segment starts, page aligned.
pub fn image_start(elf: &Elf) -> u64 {
    elf.segments.iter().map(|s| s.vaddr).min().unwrap_or(0) & !4095
}

/// Lowest address above every loaded segment, page aligned.
pub fn image_end(elf: &Elf) -> u64 {
    elf.segments.iter().map(|s| s.vaddr + s.memsz).max().unwrap_or(0).next_multiple_of(4096)
}

/// The function types every module of a program declares, in this order.
fn types(mapped: bool) -> TypeSection {
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I64]);
    types.ty().function([ValType::I64; 8], [ValType::I64]);
    types.ty().function([ValType::I64, ValType::I32], []);
    types.ty().function([ValType::I64, ValType::I64, ValType::I64, ValType::I32], [ValType::I64, ValType::I64]);
    types.ty().function([], [ValType::I64]);
    types.ty().function([ValType::I64, ValType::I64], [ValType::I64]);
    types.ty().function([ValType::I64], [ValType::I64]);
    types.ty().function([ValType::I64], []);
    types.ty().function([ValType::I32, ValType::I32, ValType::I32, ValType::I32, ValType::I32, ValType::I64, ValType::I32], [ValType::I64]);
    types.ty().function([ValType::I64], []);
    types.ty().function([ValType::I32], [ValType::F64]);
    if mapped {
        use ValType::{I32, I64};
        types.ty().function([I64, I32], [I32]);
        types.ty().function([I64, I64, I64, I64, I32, I32], [I64]);
        types.ty().function([I32, I32, I32, I32, I64, I32, I64, I32], [I64]);
    }
    types
}

fn host_types(mapped: bool) -> [u32; 8] {
    [T_SYSCALL, T_TRAP, T_DIV, T_CLOCK, if mapped { T_MAPPED_FPU } else { T_FPU }, T_TRACE, T_RESOLVE, T_TIME]
}

/// Check a scalar/SIMD span against the VM's separate page-rights memory.
/// Guest memory operations can name only memory zero. The slow import
/// reports the original wide fault address before any byte is changed.
#[cfg(feature = "mapped-code")]
fn mapped_address() -> WasmFunction {
    const ADDRESS_LIMIT: i64 = 256 << 20;
    const PAGE_SHIFT: i32 = 12;
    const PAGE_MASK: i32 = (1 << PAGE_SHIFT) - 1;
    const LAST_PAGE: i32 = (ADDRESS_LIMIT as i32 >> PAGE_SHIFT) - 1;
    let (address, access, narrow, page, offset) = (0, 1, 2, 3, 4);
    let rights = |offset| MemArg {offset, align: 0, target: MemArgTarget::Memory(MAPPED_ACCESS_MEMORY), ordering: None};
    let mut f = WasmFunction::new([(3, ValType::I32)]);
    for op in [
        W::Block(BlockType::Empty),
        W::LocalGet(address), W::I64Const(ADDRESS_LIMIT), W::I64GeU, W::BrIf(0),
        W::LocalGet(address), W::I32WrapI64, W::LocalTee(narrow), W::I32Const(PAGE_SHIFT), W::I32ShrU, W::LocalTee(page),
        // The VM publishes only the R/W bits in each byte.
        W::I32Load8U(rights(0)), W::LocalGet(access), W::I32And, W::I32Eqz, W::BrIf(0),
        // Only the last 15 bytes of a page can cross into the next one.
        W::LocalGet(narrow), W::I32Const(PAGE_MASK), W::I32And, W::LocalTee(offset),
        W::I32Const(PAGE_MASK + 1 - MAX_MAPPED_OPERAND_BYTES), W::I32GtU,
        W::If(BlockType::Empty),
        W::LocalGet(offset), W::LocalGet(access), W::I32Const(63), W::I32And, W::I32Const(2), W::I32ShrU, W::I32Add,
        W::I32Const(PAGE_MASK), W::I32GtU,
        W::If(BlockType::Empty),
        W::LocalGet(page), W::I32Const(LAST_PAGE), W::I32Eq, W::BrIf(2),
        W::LocalGet(page), W::I32Load8U(rights(1)), W::LocalGet(access), W::I32And, W::I32Eqz, W::BrIf(2),
        W::End,
        W::End,
        W::LocalGet(narrow), W::Return,
        W::End,
        W::LocalGet(address), W::LocalGet(access),
        W::Call(MAPPED_CORE_ACCESS), W::End,
    ] { f.instruction(&op); }
    f
}

/// The mapped scalar and vector prefixes use identical indices for their
/// common imports. Ordinary static fragments have their own prefix.
fn fragment_prefix(mapped: bool, vectors: bool) -> &'static [u8] {
    static PREFIX: [OnceLock<Vec<u8>>; 3] = [const { OnceLock::new() }; 3];
    let slot = if mapped { 1 + usize::from(vectors) } else { 0 };
    PREFIX[slot].get_or_init(|| {
        let mut prefix = Module::HEADER.to_vec();
        let types = types(mapped);
        let mut imports = ImportSection::new();
        imports.import("env", "memory", EntityType::Memory(MemoryType { minimum: 1, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None }));
        for (name, ty) in HOST_IMPORTS.iter().zip(host_types(mapped)) { imports.import("env", name, EntityType::Function(ty)); }
        for (name, ty) in SHARED.iter().zip([T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN]) { imports.import("main", name, EntityType::Function(ty)); }
        if mapped {
            imports.import("env", "mapped_string", EntityType::Function(T_MAPPED_STRING));
            imports.import("env", "mapped_fx_state", EntityType::Function(T_MAPPED_ACCESS));
            imports.import("main", "mapped_address", EntityType::Function(T_MAPPED_ACCESS));
        }
        let mut add_global = |n| {
            let (from, name) = if n == G_MAPPED_BASE { ("piece", "base") } else { ("main", GLOBAL_NAMES[n as usize]) };
            imports.import(from, name, EntityType::Global(GlobalType { val_type: global_type(n), mutable: true, shared: false }));
        };
        if mapped {
            let ids = (0..=G_FS).chain(MAPPED_SCALARS)
                .chain((0..if vectors { 16 } else { 0 }).map(g_xmm));
            for (k, g) in ids.enumerate() {
                debug_assert_eq!(fragment_global_index(g, true), k as u32);
                add_global(g);
            }
        } else {
            for n in core_globals(false) { add_global(n); }
        }
        types.append_to(&mut prefix);
        imports.append_to(&mut prefix);
        prefix
    })
}

/// Code reached later, for a program already running: its functions as one
/// more module, which takes everything else from the first module (memory,
/// helpers and registers) and carries no data, so instantiating it changes
/// nothing in memory. The host installs its functions in the core's table.
/// Static fragments carry absolute slots in `sods.entries`. Mapped
/// fragments carry starts and local slot records in one ABI section.
pub fn translate_more(elf: &Elf, program: &Program, base: u32, options: Options) -> Translation {
    translate_more_in(elf, program, base, options, &mut Frame::default())
}

pub(crate) fn translate_more_in(elf: &Elf, program: &Program, base: u32, options: Options, frame: &mut Frame) -> Translation {
    if elf.mapped() {
        let (wasm, report) = translate_mapped_in(elf, std::slice::from_ref(program), options, frame);
        return Translation {wasm: wasm.into_vec(), report};
    }
    let mut report = Report { functions: program.functions.len(), entries: program.entries.len(), ..Default::default() };

    let mut functions = FunctionSection::new();
    for _ in &program.functions { functions.function(T_FN); }

    let mut tables = TableSection::new();
    let mut exports = ExportSection::new();
    let mut elements = ElementSection::new();
    let count = program.functions.len() as u32;
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count as u64, maximum: Some(count as u64), table64: false, shared: false });
    exports.export("table", ExportKind::Table, 0);
    let indices = (0..count).map(|slot| guest_function(slot, false)).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));

    let mut code = Out::after_prefix(fragment_prefix(false, false), &[&functions, &tables, &exports, &elements], count, room(program, 0));
    lower_all(elf, program, base, None, options, &mut report, &mut code, frame);

    // Its functions by the guest's names, as in the first module: every module numbers its own from the
    // same index, so without them a profile or a trace cannot tell one module's function from another's.
    let mut names = wasm_encoder::NameMap::new();
    for (k, n) in HOST_IMPORTS.iter().chain(SHARED.iter()).enumerate() { names.append(k as u32, n); }
    let mut name = String::new();
    for (k, f) in program.functions.iter().enumerate() { names.append(guest_function(k as u32, false), f.shown(&mut name)); }
    let mut name_section = wasm_encoder::NameSection::new();
    name_section.functions(&names);

    let mut table = Vec::with_capacity(program.entries.len() * 16);
    for (&address, &(f, b)) in &program.entries {
        table.extend_from_slice(&address.to_le_bytes());
        table.extend_from_slice(&((((f + base) as u64) << 32) | b as u64).to_le_bytes());
    }
    let entries = CustomSection { name: Cow::Borrowed("sods.entries"), data: Cow::Owned(table) };
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    let starts = CustomSection { name: Cow::Borrowed("sods.starts"), data: Cow::Owned(starts) };

    let wasm = code.finish(None, &[&name_section, &entries, &starts]);
    Translation { wasm, report }
}

/// Emit the programs in discovery order, retaining each part's call and flag
/// analysis. The merged entries link replay parts and describe the final
/// dispatcher state of the module.
pub(crate) fn translate_mapped_in(elf: &Elf, programs: &[Program], options: Options, frame: &mut Frame) -> (OutputBytes, Report) {
    let functions = programs.iter().map(|p| p.functions.len()).sum::<usize>();
    let replay_targets = (programs.len() > 1).then(|| Entries::replay_targets(programs));
    let entries = replay_targets.as_ref().or_else(|| programs.first().map(|p| &p.entries));
    let mut report = Report { functions, entries: entries.map_or(0, Entries::len), ..Default::default() };
    let count = functions as u32;
    let mut funcs = FunctionSection::new();
    let mut exports = ExportSection::new();
    // A fragment need not import the core's table or carry a table of its own.
    for slot in 0..count {
        funcs.function(T_FN);
        exports.export(&slot.to_string(), ExportKind::Func, guest_function(slot, true));
    }
    let room = 4096 + programs.iter().map(function_room).sum::<usize>();
    let full = fragment_prefix(true, true);
    let mut code = Out::after_prefix(full, &[&funcs, &exports], count, room);
    let mut names = wasm_encoder::NameMap::new();
    let mut name = String::new();
    let mut metadata = Vec::with_capacity(4 + functions * 4 + report.entries * 12);
    metadata.extend(count.to_le_bytes());
    for f in programs.iter().flat_map(|p| &p.functions) { metadata.extend((f.start as u32).to_le_bytes()); }

    let (mut base, mut xmm_imports) = (0, false);
    for program in programs {
        xmm_imports |= lower_all(elf, program, base, replay_targets.as_ref(), options, &mut report, &mut code, frame);
        for (k, f) in program.functions.iter().enumerate() { names.append(guest_function(base + k as u32, true), f.shown(&mut name)); }
        base += program.functions.len() as u32;
    }
    for (&address, &(slot, block)) in entries.into_iter().flatten() {
        metadata.extend((address as u32).to_le_bytes());
        metadata.extend(block.to_le_bytes());
        metadata.extend(slot.to_le_bytes());
    }
    let mut name_section = wasm_encoder::NameSection::new();
    name_section.functions(&names);
    let abi = CustomSection { name: Cow::Borrowed("sods.mapped-piece-v17"), data: Cow::Owned(metadata) };
    let start = if xmm_imports { 0 } else {
        let scalar = fragment_prefix(true, false);
        let start = full.len() - scalar.len();
        code.wasm[start..full.len()].copy_from_slice(scalar);
        start
    };
    let bytes = code.finish(None, &[&name_section, &abi]);
    (OutputBytes {bytes, start}, report)
}

fn registers_and_exports(mapped: bool, helpers: u32) -> (GlobalSection, ExportSection) {
    let mut globals = GlobalSection::new();
    let mut exports = ExportSection::new();
    for (k, name) in SHARED.iter().enumerate() { exports.export(name, ExportKind::Func, helpers + k as u32); }
    for n in core_globals(mapped) {
        let val_type = global_type(n);
        let initial = match val_type {
            ValType::I64 => ConstExpr::i64_const(if n == G_LOW { -1 } else { 0 }),
            ValType::I32 => ConstExpr::i32_const(match n { G_BUDGET => 1 << 20, G_MXCSR => MXCSR_RESET, _ => 0 }),
            ValType::V128 => ConstExpr::v128_const(0),
            _ => unreachable!(),
        };
        globals.global(GlobalType { val_type, mutable: true, shared: false }, &initial);
        exports.export(GLOBAL_NAMES[n as usize], ExportKind::Global, global_index(n, mapped));
    }
    exports.export("table", ExportKind::Table, 0);

    (globals, exports)
}

/// A CPU context lives outside both guest RAM and page permissions. Save and
/// restore XMM registers here because Wasm cannot pass v128 values to JS.
#[cfg(feature = "mapped-code")]
fn mapped_context(code: &mut Out, restore: bool) {
    let mut f = WasmFunction::new([]);
    let extra = [G_FLAGS, G_RF, G_MXCSR];
    let xmm_at = ((G_FS as usize + 1 + extra.len()) * 8).next_multiple_of(16) as u64;
    let scalars = (0..=G_FS).chain(extra);
    let layout = scalars.enumerate().map(|(i, reg)| (reg, (i * 8) as u64))
        .chain((0..16).map(|n| (g_xmm(n), xmm_at + (n * 16) as u64)));
    for (reg, offset) in layout {
        let ty = global_type(reg);
        let align = if ty == ValType::V128 { 4 } else if ty == ValType::I64 { 3 } else { 2 };
        let at = MemArg { offset, align, target: MemArgTarget::Memory(MAPPED_CONTEXT_MEMORY), ordering: None };
        f.instruction(&W::LocalGet(0));
        if restore {
            f.instruction(&match ty {
                ValType::I64 => W::I64Load(at),
                ValType::I32 => W::I32Load(at),
                ValType::V128 => W::V128Load(at),
                _ => unreachable!(),
            });
            f.instruction(&W::GlobalSet(global_index(reg, true)));
        } else {
            f.instruction(&W::GlobalGet(global_index(reg, true)));
            f.instruction(&match ty {
                ValType::I64 => W::I64Store(at),
                ValType::I32 => W::I32Store(at),
                ValType::V128 => W::V128Store(at),
                _ => unreachable!(),
            });
        }
    }
    f.instruction(&W::End);
    code.encoded(&f);
}

/// An address space's dispatcher with no guest image, data or preauthorized code.
#[cfg(feature = "mapped-code")]
pub(crate) fn mapped_core() -> Vec<u8> {
    let mut imports = ImportSection::new();
    imports.import("env", "memory", EntityType::Memory(MemoryType {
        minimum: 1, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None,
    }));
    imports.import("dispatcher", "entries", EntityType::Memory(MemoryType {
        minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None,
    }));
    imports.import("dispatcher", "access_pages", EntityType::Memory(MemoryType {
        minimum: 1, maximum: Some(1), memory64: false, shared: false, page_size_log2: None,
    }));
    imports.import("env", "trap", EntityType::Function(T_TRAP));
    imports.import("env", "miss", EntityType::Function(T_RESOLVE));
    imports.import("env", "mapped_access", EntityType::Function(T_MAPPED_ACCESS));
    let mut functions = FunctionSection::new();
    for ty in [T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN] { functions.function(ty); }
    let mut tables = TableSection::new();
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: 0, maximum: None, table64: false, shared: false });
    let mut types = types(true);
    const CONTEXT: u32 = T_MAPPED_FPU + 1;
    types.ty().function([ValType::I32], []);
    functions.function(T_MAPPED_ACCESS);
    functions.function(CONTEXT);
    functions.function(CONTEXT);
    let mut memories = wasm_encoder::MemorySection::new();
    memories.memory(MemoryType { minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None });
    let (globals, mut exports) = registers_and_exports(true, MAPPED_CORE_HELPERS);
    let address = MAPPED_CORE_HELPERS + HELPERS;
    exports.export("mapped_address", ExportKind::Func, address);
    exports.export("contexts", ExportKind::Memory, MAPPED_CONTEXT_MEMORY);
    exports.export("save_context", ExportKind::Func, address + 1);
    exports.export("restore_context", ExportKind::Func, address + 2);
    let mut code = Out::new(&[&types, &imports, &functions, &tables, &memories, &globals, &exports], HELPERS + 3, 2048);
    math_helpers(&mut code, MAPPED_CORE_HELPERS);
    mapped_lookup(&mut code);
    run_loop(&mut code, MAPPED_CORE_HELPERS + F_DISPATCH - F_MULHU);
    code.encoded(&mapped_address());
    mapped_context(&mut code, false);
    mapped_context(&mut code, true);
    let abi = CustomSection { name: Cow::Borrowed("sods.mapped-core-v17"), data: Cow::Borrowed(&[]) };
    code.finish(None, &[&abi])
}

pub fn translate(elf: &Elf, program: &Program, options: Options) -> Translation {
    assert!(!elf.mapped(), "mapped code must be emitted as checked fragments");
    let mut report = Report { functions: program.functions.len(), entries: program.entries.len(), ..Default::default() };

    let mut imports = ImportSection::new();
    // The entry table lives in guest memory just past the image (one memory
    // keeps every engine able to load the module); the loader treats it as
    // part of the image.
    let table_base = image_end(elf);
    // The dispatch cache follows the table, also part of the image (a forked child keeps it: its slots are the same).
    let cache = table_base + (program.entries.len() as u64 * 16).next_multiple_of(4096);
    let end = cache + DISPATCH_CACHE * 16;
    let pages = end.div_ceil(65536);
    imports.import("env", "memory", EntityType::Memory(MemoryType {
        minimum: pages, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None,
    }));
    imports.import("env", "syscall", EntityType::Function(T_SYSCALL));
    imports.import("env", "trap", EntityType::Function(T_TRAP));
    imports.import("env", "div128", EntityType::Function(T_DIV));
    imports.import("env", "clock", EntityType::Function(T_CLOCK));
    imports.import("env", "fpu", EntityType::Function(T_FPU));
    imports.import("env", "trace", EntityType::Function(T_TRACE));
    imports.import("env", "miss", EntityType::Function(T_RESOLVE));
    imports.import("env", "time", EntityType::Function(T_TIME));

    let mut functions = FunctionSection::new();
    for ty in [T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN] { functions.function(ty); }
    for _ in &program.functions { functions.function(T_FN); }

    let mut tables = TableSection::new();
    let count = program.functions.len() as u64;
    // It grows as code reached later is translated into modules of its own.
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count, maximum: None, table64: false, shared: false });

    let entries = program.entries.len() as u64;

    let (globals, exports) = registers_and_exports(false, F_MULHU);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));

    let data: usize = elf.segments.iter().map(|s| s.data.len()).sum();
    let mut code = Out::new(&[&types(false), &imports, &functions, &tables, &globals, &exports, &elements], HELPERS + program.functions.len() as u32, room(program, data));
    math_helpers(&mut code, F_MULHU);
    static_lookup(&mut code, entries as u32, table_base, cache);
    run_loop(&mut code, F_DISPATCH);
    lower_all(elf, program, 0, None, options, &mut report, &mut code, &mut Frame::default());

    let mut table = Vec::with_capacity(program.entries.len() * 16);
    for (&address, &(f, b)) in &program.entries {
        table.extend_from_slice(&address.to_le_bytes());
        table.extend_from_slice(&(((f as u64) << 32) | b as u64).to_le_bytes());
    }
    let mut image = Image(elf.segments.iter().filter(|s| !s.data.is_empty()).map(|s| (s.vaddr, &s.data[..])).collect());
    image.0.push((table_base, &table));

    let mut names = wasm_encoder::NameMap::new();
    for (k, n) in HOST_IMPORTS.iter().chain(SHARED.iter()).enumerate() {
        names.append(k as u32, n);
    }
    let mut name = String::new();
    for (k, f) in program.functions.iter().enumerate() { names.append(FIRST_GUEST + k as u32, f.shown(&mut name)); }
    let mut name_section = wasm_encoder::NameSection::new();
    name_section.functions(&names);

    // Loader facts for the host, as a small JSON custom section.
    let tls = elf.tls.as_ref().map(|t| format!(",\"tls\":{{\"vaddr\":{},\"filesz\":{},\"memsz\":{},\"align\":{}}}", t.vaddr, t.filesz, t.memsz, t.align)).unwrap_or_default();
    // The bytes no correct run can change (segments not writable): a memory that ran this program holds them still.
    let read_only: Vec<String> = elf.segments.iter().filter(|s| !s.writable && !s.data.is_empty())
        .map(|s| format!("[{},{}]", s.vaddr, s.vaddr + s.data.len() as u64)).collect();
    // What the translation itself keeps past the program's image, the entry table and the dispatch cache: the same for
    // every process of this translation (the cache holds only what is found the same way in each), so a memory that
    // ran this very translation holds it still.
    let facts = format!(
        "{{\"entry\":{},\"imageStart\":{},\"imageEnd\":{},\"phdr\":{},\"phnum\":{},\"phent\":56,\"readOnly\":[{}],\"derived\":[{},{}]{}}}",
        elf.entry, image_start(elf), end, elf.phdr_address().unwrap_or(0), elf.phnum, read_only.join(","), table_base, end, tls
    );
    let facts = CustomSection { name: Cow::Borrowed("sods.facts"), data: Cow::Owned(facts.into_bytes()) };
    let fpu = CustomSection { name: Cow::Borrowed("sods.fpu"), data: Cow::Owned(crate::x87::NAMES.join(",").into_bytes()) };
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    let starts = CustomSection { name: Cow::Borrowed("sods.starts"), data: Cow::Owned(starts) };

    let wasm = code.finish(Some(&image), &[&name_section, &facts, &fpu, &starts]);
    Translation { wasm, report }
}

#[cfg(all(test, feature = "mapped-code"))]
mod mapped_tests {
    use super::*;
    use wasmparser::{Operator, Parser, Payload};

    #[test]
    fn replay_links_calls_and_tail_jumps_to_the_latest_external_entry() {
        use std::collections::BTreeSet;

        let start = 0x10000;
        let mut bytes = vec![0x90; 16];
        bytes[0] = 0xc3; // ret
        bytes.extend([0xe8, 0xeb, 0xff, 0xff, 0xff, 0xe9, 0xe6, 0xff, 0xff, 0xff]);
        let mut elf = Elf::of_code(start, bytes);
        elf.mapped = true;
        let callee = || crate::find::discover_within(&elf, &[start], &BTreeSet::new(), 1000);
        let caller = crate::find::discover_within(&elf, &[start + 16], &BTreeSet::from([start]), 1000);
        let programs = [callee(), callee(), caller];
        assert!(programs.iter().all(|p| p.functions.len() == 1));

        let (wasm, _) = translate_mapped_in(&elf, &programs, Options::default(), &mut Frame::default());
        let wasm = wasm.into_vec();
        let body = Parser::new(0).parse_all(&wasm).filter_map(|p| match p.unwrap() {
            Payload::CodeSectionEntry(f) => Some(f),
            _ => None,
        }).nth(2).unwrap();
        let ops: Vec<_> = body.get_operators_reader().unwrap().into_iter().map(|o| o.unwrap()).collect();
        let target = guest_function(1, true);
        assert!(ops.iter().any(|o| matches!(o, Operator::Call { function_index } if *function_index == target)));
        assert!(ops.iter().any(|o| matches!(o, Operator::ReturnCall { function_index } if *function_index == target)));
        assert!(!ops.iter().any(|o| matches!(o, Operator::Call { function_index: F_DISPATCH } |
            Operator::ReturnCall { function_index: F_DISPATCH })));

        let entries = Parser::new(0).parse_all(&wasm).find_map(|payload| match payload.unwrap() {
            Payload::CustomSection(section) if section.name() == "sods.mapped-piece-v17" => Some(section.data()),
            _ => None,
        }).unwrap();
        let word = |bytes: &[u8]| u32::from_le_bytes(bytes.try_into().unwrap());
        let count = word(&entries[..4]) as usize;
        let slots: Vec<_> = entries[4 + count * 4..].chunks_exact(12)
            .filter(|record| word(&record[..4]) == start as u32)
            .map(|record| word(&record[8..])).collect();
        assert_eq!(slots, [1]);
    }

    #[test]
    fn unaudited_data_instructions_emit_refusals_not_memory_effects() {
        let forms: &[(&str, &[u8])] = &[
            ("Scasb", &[0xf3, 0xae]),               // repeat scan
            ("Movsb", &[0xf3, 0x67, 0xa4]),         // addr32 move
            ("Movsb", &[0x64, 0xf3, 0xa4]),         // segment-overridden move
            ("Movsb", &[0xf2, 0xa4]),               // non-profile repeat prefix
            ("Inc", &[0xf0, 0x48, 0xff, 0x07]),        // locked increment
            ("Bts", &[0x65, 0xf0, 0x48, 0x0f, 0xab, 0x07]), // locked memory bit string with GS
            ("Fld", &[0xdb, 0x2f]),                 // extended x87 memory operand
            ("Maskmovdqu", &[0x66, 0x0f, 0xf7, 0xc1]), // masked vector store
            ("Mov", &[0x65, 0x48, 0x8b, 0x07]),     // unsupported GS base
            ("Call", &[0x65, 0xff, 0x17]),         // same rule for indirect control
        ];
        for &(name, bytes) in forms {
            let mut code = bytes.to_vec();
            code.push(0xf4); // End discovery; compile only, do not execute.
            let mut elf = Elf::of_code(0x10000, code);
            elf.mapped = true;
            let program = crate::find::discover_seeded(&elf, &[elf.entry]);
            let translated = translate_more(&elf, &program, 0, Options::default());
            assert_eq!(translated.report.unsupported.get(name), Some(&1), "{name}");
            for payload in Parser::new(0).parse_all(&translated.wasm) {
                if let Payload::CodeSectionEntry(f) = payload.unwrap() {
                    for op in f.get_operators_reader().unwrap() {
                        assert!(!matches!(op.unwrap(),
                            Operator::MemoryCopy { .. } | Operator::MemoryFill { .. } |
                            Operator::I32Load { .. } | Operator::I32Load16U { .. } |
                            Operator::I64Load { .. } | Operator::I64Store { .. } |
                            Operator::V128Load { .. } | Operator::V128Store { .. }), "{name}");
                    }
                }
            }
        }
    }
}
