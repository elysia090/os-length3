//! The module around the guest's code: its types, imports, globals, table and helpers (64x64 high products, entry
//! resolution and the dispatcher), the program's image and entry table, its names and the facts the loader reads;
//! the code itself written into one buffer as the kernel makes each function.

use crate::abi::*;
use crate::elf::Elf;
use crate::facts::{summarize, Liveness};
use crate::frame::Report;
use crate::lower::{lower_function, Frame, Lowering};
use crate::program::Program;
use crate::wasm::uleb;
use std::borrow::Cow;
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

/// The first module's own functions (mulhu to run), made before the guest's.
const HELPERS: u32 = FIRST_GUEST - F_MULHU;
/// Imported functions, in index order: the host's, then (in a module made later) the first module's.
const HOST_IMPORTS: [&str; 8] = ["syscall", "trap", "div128", "clock", "fpu", "trace", "miss", "time"];
const SHARED: [&str; 5] = ["mulhu", "mulhs", "resolve", "dispatch", "run"];
fn global_name(n: u32) -> String {
    match n { 0..=15 => format!("r{n}"), G_FS => "fs".into(), G_FLAGS => "fl".into(), G_BUDGET => "budget".into(), G_DEPTH => "depth".into(), G_LOW => "low".into(), G_X87 => "x87".into(), _ => format!("x{}", n - 17) }
}
fn global_type(n: u32) -> ValType { if n < 17 || n == G_FLAGS || n == G_LOW { ValType::I64 } else if n == G_BUDGET || n == G_DEPTH || n == G_X87 { ValType::I32 } else { ValType::V128 } }

fn mem_at(offset: u64, align: u32) -> MemArg { MemArg { offset, align, target: MemArgTarget::Memory(0), ordering: None } }


/// Slots in the dispatcher's cache of where addresses were found (16 bytes
/// each, past the entry table). One gcc building hello dispatched 1.8
/// million times to code made later, each a call out to the host before.
const DISPATCH_CACHE: u64 = 1 << 14;

/// Helpers: 64x64 high products, entry resolution and the dispatcher.
/// `table` is where the sorted entry table sits in guest memory, `cache`
/// where the dispatcher keeps what it found (DISPATCH_CACHE slots).
fn helpers(code: &mut Out, entries: u32, table: u64, cache: u64) {
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
        W::LocalGet(0), W::LocalGet(1), W::Call(F_MULHU),
        W::LocalGet(1), W::I64Const(0), W::LocalGet(0), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::LocalGet(0), W::I64Const(0), W::LocalGet(1), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

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

    // run(addr): follow returns that leave every translated frame.
    let mut f = WasmFunction::new([]);
    for i in [
        W::Loop(BlockType::Empty), W::LocalGet(0), W::Call(F_DISPATCH), W::LocalSet(0), W::Br(0), W::End, W::End,
    ] { f.instruction(&i); }
    code.encoded(&f);

}

/// Every function of `program`, lowered into `code` in order, as the table holds them from `base`. Each is lowered
/// on its own, so natively they share the cores; wasm has one thread and lowers in turn, each into the module as it
/// is made (a big program's functions are most of what the translator would otherwise hold at once).
fn lower_all(elf: &Elf, program: &Program, base: u32, options: Options, report: &mut Report, code: &mut Out) {
    let handed = Liveness::new(program);
    let summaries = summarize(elf, program);
    let cx = Lowering { elf, program, handed: &handed, summaries: &summaries, trace: options.trace };
    let n = program.functions.len();
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    // A few functions are not worth a thread.
    if threads == 1 || n < 64 {
        let mut frame = Frame::default();
        for f in 0..n { lower_function(&cx, f as u32, base, report, &mut frame, &mut code.wasm); }
        return;
    }
    let size = n.div_ceil(threads);
    // Each thread's functions in one buffer, each with its size before it, as the code section holds them.
    let parts: Vec<(Vec<u8>, Report)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..n).step_by(size).map(|at| {
            let cx = &cx;
            scope.spawn(move || {
                let mut r = Report::default();
                let (mut made, mut frame) = (Vec::new(), Frame::default());
                for f in at..(at + size).min(n) { lower_function(cx, f as u32, base, &mut r, &mut frame, &mut made); }
                (made, r)
            })
        }).collect();
        workers.into_iter().map(|w| w.join().expect("a lowering thread panicked")).collect()
    });
    for (functions, r) in parts {
        code.wasm.extend_from_slice(&functions);
        report.blocks += r.blocks;
        report.instructions += r.instructions;
        for (m, k) in r.unsupported { *report.unsupported.entry(m).or_default() += k; }
    }
}

/// A module written into one buffer as it is made: the sections before its code, then the code section as its
/// functions are lowered (its size, not known until they all are, written last in as few bytes as it takes), then the
/// sections after. A big program's translation is nearly all its code, held once: not in a section of its own and
/// then again in the module. (A module grown as it is written holds it a few times over at once, in a memory that
/// only grows, and each time it grows, an engine may collect its whole heap: room for it all is made at the start.)
struct Out {
    wasm: Vec<u8>,
    /// Where the code section's size goes: five bytes kept for it.
    size_at: usize,
}

impl Out {
    /// The header and `head`, then the code section's id, room for its size, and its count of `functions`; room in
    /// all for about `room` bytes more.
    fn new(head: &[&dyn Section], functions: u32, room: usize) -> Out {
        let mut wasm = Module::new().finish();
        for s in head { s.append_to(&mut wasm); }
        wasm.reserve(room);
        wasm.push(SectionId::Code as u8);
        let size_at = wasm.len();
        wasm.extend_from_slice(&[0; 5]);
        uleb(&mut wasm, functions as u64);
        Out { wasm, size_at }
    }

    /// A function wasm-encoder made.
    fn encoded(&mut self, f: &WasmFunction) { f.encode(&mut self.wasm); }

    /// The code section ends here: its size written in and the code moved up to it; then `image` and `tail`.
    fn finish(mut self, image: Option<&Image>, tail: &[&dyn Section]) -> Vec<u8> {
        let from = self.size_at + 5;
        let mut size = Vec::new();
        uleb(&mut size, (self.wasm.len() - from) as u64);
        let to = self.size_at + size.len();
        self.wasm[self.size_at..to].copy_from_slice(&size);
        self.wasm.copy_within(from.., to);
        self.wasm.truncate(self.wasm.len() - (from - to));
        if let Some(i) = image { i.append_to(&mut self.wasm); }
        for s in tail { s.append_to(&mut self.wasm); }
        self.wasm
    }
}

/// About how many bytes a module of `program` takes past its head: its code (35 or so for each instruction, every
/// program measured), `data` bytes of image, the names, starts and entries.
fn room(program: &Program, data: usize) -> usize {
    let instructions: usize = program.functions.iter().flat_map(|f| &f.blocks).map(|b| b.count as usize).sum();
    instructions * 40 + data + program.functions.len() * 48 + program.entries.len() * 16 + 4096
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

/// Where the lowest loaded segment starts, page aligned.
pub fn image_start(elf: &Elf) -> u64 {
    elf.segments.iter().map(|s| s.vaddr).min().unwrap_or(0) & !4095
}

/// Lowest address above every loaded segment, page aligned.
pub fn image_end(elf: &Elf) -> u64 {
    elf.segments.iter().map(|s| s.vaddr + s.memsz).max().unwrap_or(0).next_multiple_of(4096)
}

/// The function types every module of a program declares, in this order.
fn types() -> TypeSection {
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
    types
}

/// Code reached later, for a program already running: its functions as one
/// more module, which takes everything else from the first module (memory,
/// helpers and registers) and carries no data, so instantiating it changes
/// nothing in memory. It exports its functions as `table`, for the host to
/// put in the first module's table from `base`. Its entries, slots counted
/// from `base`, are in the `sods.entries` custom section as (address,
/// function << 32 | block) pairs.
pub fn translate_more(elf: &Elf, program: &Program, base: u32, options: Options) -> Translation {
    let mut report = Report { functions: program.functions.len(), entries: program.entries.len(), ..Default::default() };
    let mut imports = ImportSection::new();
    imports.import("env", "memory", EntityType::Memory(MemoryType { minimum: 1, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None }));
    let host_types = [T_SYSCALL, T_TRAP, T_DIV, T_CLOCK, T_FPU, T_TRACE, T_RESOLVE, T_TIME];
    for (name, ty) in HOST_IMPORTS.iter().zip(host_types) { imports.import("env", name, EntityType::Function(ty)); }
    for (name, ty) in SHARED.iter().zip([T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN]) { imports.import("main", name, EntityType::Function(ty)); }
    for n in 0..GLOBALS {
        imports.import("main", &global_name(n), EntityType::Global(GlobalType { val_type: global_type(n), mutable: true, shared: false }));
    }

    let mut functions = FunctionSection::new();
    for _ in &program.functions { functions.function(T_FN); }

    // Its functions go in a table of its own, which the host copies into the
    // first module's from `base`. It does not import that table: an engine
    // keeps each instance that imports a table up to date on every change to
    // it, so with every module importing it, each one made every later one
    // slower to make and the table slower to grow.
    let mut tables = TableSection::new();
    let count = program.functions.len() as u64;
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count, maximum: Some(count), table64: false, shared: false });
    let mut exports = ExportSection::new();
    exports.export("table", ExportKind::Table, 0);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));

    let mut code = Out::new(&[&types(), &imports, &functions, &tables, &exports, &elements], program.functions.len() as u32, room(program, 0));
    lower_all(elf, program, base, options, &mut report, &mut code);

    // Its functions by the guest's names, as in the first module: every module numbers its own from the
    // same index, so without them a profile or a trace cannot tell one module's function from another's.
    let mut names = wasm_encoder::NameMap::new();
    for (k, n) in HOST_IMPORTS.iter().chain(SHARED.iter()).enumerate() { names.append(k as u32, n); }
    for (k, f) in program.functions.iter().enumerate() { names.append(FIRST_GUEST + k as u32, &format!("{}@{:x}", f.name, f.start)); }
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

pub fn translate(elf: &Elf, program: &Program, options: Options) -> Translation {
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

    let mut globals = GlobalSection::new();
    for _ in 0..17 {
        globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(0));
    }
    for _ in 0..16 {
        globals.global(GlobalType { val_type: ValType::V128, mutable: true, shared: false }, &ConstExpr::v128_const(0));
    }
    globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(0));
    // The time slice and the frames in use (the kernel sets both each time it runs a thread).
    globals.global(GlobalType { val_type: ValType::I32, mutable: true, shared: false }, &ConstExpr::i32_const(1 << 20));
    globals.global(GlobalType { val_type: ValType::I32, mutable: true, shared: false }, &ConstExpr::i32_const(0));
    // How deep the stack has gone (G_LOW): not at all yet.
    globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(-1));
    // Its x87 registers (G_X87): no thread's until the kernel says.
    globals.global(GlobalType { val_type: ValType::I32, mutable: true, shared: false }, &ConstExpr::i32_const(0));

    let mut exports = ExportSection::new();
    // What a module made later for this program imports: the helpers, every register, the table.
    for (k, name) in SHARED.iter().enumerate() { exports.export(name, ExportKind::Func, F_MULHU + k as u32); }
    for n in 0..GLOBALS { exports.export(&global_name(n), ExportKind::Global, n); }
    exports.export("table", ExportKind::Table, 0);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));

    let data: usize = elf.segments.iter().map(|s| s.data.len()).sum();
    let mut code = Out::new(&[&types(), &imports, &functions, &tables, &globals, &exports, &elements], HELPERS + program.functions.len() as u32, room(program, data));
    helpers(&mut code, entries as u32, table_base, cache);
    lower_all(elf, program, 0, options, &mut report, &mut code);

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
    for (k, f) in program.functions.iter().enumerate() {
        names.append(FIRST_GUEST + k as u32, &format!("{}@{:x}", f.name, f.start));
    }
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
