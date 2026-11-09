//! Lower recovered functions to one WebAssembly module.
//!
//! Guest memory is wasm memory 0 with guest address == wasm address, so a
//! guest load is one wasm load. Registers live in locals inside a function
//! and in globals across calls. Flags are deferred: producers record their
//! operands and consumers evaluate only the condition they need, so a
//! `cmp`/`jcc` pair becomes one comparison. Functions are wasm functions;
//! a return compares the popped address with the expected continuation and
//! hands anything unexpected (longjmp, tail tricks) to the dispatcher.

use crate::discover::{goes_to, loops_of, resumes_after, Exit, Function, Loop, Program};
use crate::elf::Elf;
use crate::summary::{summarize, Summary};
use iced_x86::{ConditionCode, Instruction, Mnemonic, OpKind, Register, RflagsBits};
use std::borrow::Cow;
use std::collections::BTreeMap;
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, ElementSection, Elements, Encode, EntityType, ExportKind,
    ExportSection, Function as WasmFunction, FunctionSection, GlobalSection, GlobalType, ImportSection,
    Instruction as W, MemArg, MemArgTarget, MemoryType, Module, RefType, Section, SectionId, TableSection, TableType, TypeSection, ValType,
};

type I = W<'static>;

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

const F_SYSCALL: u32 = 0;
const F_TRAP: u32 = 1;
const F_DIV128: u32 = 2;
const F_CLOCK: u32 = 3;
const F_FPU: u32 = 4;
const F_TRACE: u32 = 5;
/// The host's answer for code not translated yet: the entry (function << 32 | block), or -1.
const F_MISS: u32 = 6;
/// A wall or steady clock's time in ms, as the host's kernel keeps it (clock.ts); NaN for any other clock.
const F_TIME: u32 = 7;
const F_MULHU: u32 = 8;
const F_MULHS: u32 = 9;
const F_RESOLVE: u32 = 10;
const F_DISPATCH: u32 = 11;
#[allow(dead_code)] // run is exported with the shared helpers, as SHARED[4]
const F_RUN: u32 = 12;
const FIRST_GUEST: u32 = 13;
/// Imported functions, in index order: the host's, then (in a module made later) the first module's.
const HOST_IMPORTS: [&str; 8] = ["syscall", "trap", "div128", "clock", "fpu", "trace", "miss", "time"];
const SHARED: [&str; 5] = ["mulhu", "mulhs", "resolve", "dispatch", "run"];
/// Globals every module of a program shares: r0..r15, fs, x0..x15, the
/// flags handed from one function to another (fl), and the rest below.
const GLOBALS: u32 = 38;
fn global_name(n: u32) -> String {
    match n { 0..=15 => format!("r{n}"), G_FS => "fs".into(), G_FLAGS => "fl".into(), G_BUDGET => "budget".into(), G_DEPTH => "depth".into(), G_LOW => "low".into(), G_X87 => "x87".into(), _ => format!("x{}", n - 17) }
}
fn global_type(n: u32) -> ValType { if n < 17 || n == G_FLAGS || n == G_LOW { ValType::I64 } else if n == G_BUDGET || n == G_DEPTH || n == G_X87 { ValType::I32 } else { ValType::V128 } }
/// Loops gone round (backward gotos) and calls made before the thread is taken back to the kernel: its time slice,
/// where it makes no system call. The kernel sets it again each time it runs the thread (about a millisecond's).
const G_BUDGET: u32 = 34;
/// Calls the thread is inside, in wasm frames: past DEPTH_LIMIT a call starts afresh from the kernel, its caller's
/// frame let go (its return goes through the dispatcher), so a recursion as deep as the guest's stack allows never
/// runs out of the host's.
const G_DEPTH: u32 = 35;
const DEPTH_LIMIT: i32 = 400;
/// The least rsp has been (unsigned; all ones before it moves): how deep the thread's stack has gone, kept where rsp
/// goes down by more than a push (a write to rsp, as a frame is made; a call), so the kernel zeroes no more of a stack
/// than was used when its memory goes to another process (process.ts Process.written).
const G_LOW: u32 = 36;
/// The thread's x87 registers: their handle in the coprocessor (x87.rs), which the kernel sets for each thread its
/// instance runs.
const G_X87: u32 = 37;
/// A word of memory below where Linux lets anything be mapped (vm.mmap_min_addr): nonzero when the kernel wants the
/// thread to look in (a signal for it, another thread waiting for its turn). A host thread can write it while the
/// guest runs, as an interrupt is raised; the guest reads it at each loop's head.
pub const INTERRUPT: u32 = 0x100;

const G_FS: u32 = 16;
/// CF, ZF, SF, OF and PF as bits 0..4: what an entry that reads flags first is handed.
const G_FLAGS: u32 = 33;
/// Each flag with its RflagsBits mask, its local and its bit in G_FLAGS.
const FLAG_BITS: [(Flag, u32, u32); 5] = [
    (Flag::C, RflagsBits::CF, L_CF), (Flag::Z, RflagsBits::ZF, L_ZF), (Flag::S, RflagsBits::SF, L_SF),
    (Flag::O, RflagsBits::OF, L_OF), (Flag::P, RflagsBits::PF, L_PF),
];
const fn g_xmm(n: u32) -> u32 { 17 + n }

// ---- Function locals ----
const L_ENTRY: u32 = 0;
const fn l_reg(n: u32) -> u32 { 1 + n }
const L_BLK: u32 = 17;
const L_CF: u32 = 18;
const L_ZF: u32 = 19;
const L_SF: u32 = 20;
const L_OF: u32 = 21;
const L_PF: u32 = 22;
const L_FA: u32 = 23;
const L_FB: u32 = 24;
const L_FR: u32 = 25;
const fn l_t(k: u32) -> u32 { 26 + k }
const fn l_u(k: u32) -> u32 { 32 + k }
const fn l_x(n: u32) -> u32 { 34 + n }
const fn l_v(k: u32) -> u32 { 50 + k }
const fn l_d(k: u32) -> u32 { 52 + k }
/// The stack pointer the function was entered with at its start (all ones when it was entered at another block):
/// an indirect jump that leaves rsp above it goes to code of a frame further out (a longjmp), handed up to it.
const L_SP0: u32 = 54;
/// The thread's budget (G_BUDGET) while a function with a loop runs: counted down in a local, where a loop's turn is a
/// register's decrement, not a global's store and load again on every way round (each waiting on the one before);
/// moved to and from its global where the registers are (sync). A function with no loop counts it down in its global
/// at each call, as before: it would move it in and out at each.
const L_BUDGET: u32 = 55;
/// Where a loop entered past its head (from the dispatch, at an entry within it: a call's continuation, a loop within
/// it) goes on: that block's number + 1, read at each loop's head (enter_loop), 0 once there.
const L_INTO: u32 = 56;
/// How many locals there are in all (L_ENTRY the parameter, then the rest).
const LOCALS: usize = 57;

/// Each local's type. A function declares only those it touches, numbered in the order it first touches them
/// (Fx::slot): where a function declares more than a few, or any but i32 and i64, V8's first tier zeroes them at every
/// entry, a `rep stos` that costs about 10 ns a call, 15 with all of them (most functions touch no vector register).
const fn kind(l: u32) -> ValType {
    match l {
        L_BLK | L_CF..=L_PF | L_BUDGET | L_INTO => ValType::I32,
        _ if l >= l_u(0) && l < l_x(0) => ValType::I32,
        _ if l >= l_x(0) && l < l_d(0) => ValType::V128,
        _ if l >= l_d(0) && l < L_SP0 => ValType::F64,
        _ => ValType::I64,
    }
}

const RSP: u32 = 4;
const RAX: u32 = 0;
const RCX: u32 = 1;
const RDX: u32 = 2;
const RBP: u32 = 5;
const RSI: u32 = 6;
const RDI: u32 = 7;

/// Trap codes reported to the host with the guest address.
pub const TRAP_UNMAPPED_TARGET: i32 = 1;
pub const TRAP_UNDECODED: i32 = 2;
pub const TRAP_UNSUPPORTED: i32 = 3;
pub const TRAP_DIVIDE: i32 = 4;
/// Not faults: the thread's time slice is up (at a loop's head, the address named), or its calls are deep enough that
/// the next one starts from the kernel (the callee's address). Registers and the flags its target reads are in globals.
pub const TRAP_YIELD: i32 = 5;
pub const TRAP_UNWIND: i32 = 6;
/// What the program itself traps with, as the CPU does: ud2 (SIGILL), int3 (SIGTRAP), hlt (a #GP, SIGSEGV).
pub const TRAP_UD2: i32 = 7;
pub const TRAP_INT3: i32 = 8;
pub const TRAP_HLT: i32 = 9;

const ALL_FLAGS: u32 = RflagsBits::OF | RflagsBits::SF | RflagsBits::ZF | RflagsBits::CF | RflagsBits::PF;

fn mem(align: u32) -> MemArg {
    mem_at(0, align)
}

/// An access to the guest's memory (the module's only one, 0), at `offset` from its address, plain (not atomic).
fn mem_at(offset: u64, align: u32) -> MemArg {
    MemArg { offset, align, target: MemArgTarget::Memory(0), ordering: None }
}

fn mask(size: u8) -> i64 {
    if size >= 8 { -1 } else { (1i64 << (size as u32 * 8)) - 1 }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Flags {
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
enum Flag { C, Z, S, O, P }

#[derive(Default, Debug)]
pub struct Report {
    pub functions: usize,
    pub blocks: usize,
    pub instructions: usize,
    pub entries: usize,
    /// Mnemonics lowered to a trap, with how often they appear.
    pub unsupported: BTreeMap<String, usize>,
}

struct Fx<'p> {
    /// The function's code, without its locals: each instruction is encoded
    /// as it is emitted; lower_function puts the locals and the syncs in.
    f: Vec<u8>,
    /// Where the code syncs registers with their globals (save: true,
    /// load: false), as byte offsets into `f`, and which registers it may move
    /// at most (all, but around a call to a function that never goes out: what
    /// it may touch, summary.rs). What is synced is known only once the whole
    /// function is made: the registers it touches.
    syncs: Vec<(usize, bool, u32)>,
    /// The registers it touches: bit n for r_n, bit 16 + n for xmm_n.
    used: u32,
    /// What each part did with the registers, in order: [0] the prologue,
    /// [k + 1] block k. Which registers each sync moves is found from these
    /// once the whole function is made (sync_masks).
    ev: Vec<Vec<Ev>>,
    /// Nesting of wasm blocks inside the current block's code: a write
    /// inside one may not happen.
    nest: u32,
    flags: Flags,
    /// The deferred state is a compare whose result was never computed: it is
    /// L_FA - L_FB, made where a flag asks for it (most conditions read only
    /// the operands).
    fr_pending: bool,
    /// A compare (cmp or test) whose flags only the branch right after it reads: not lowered where it is, but
    /// as that branch's condition, from its operands (lower_function, condition).
    fused: Option<Instruction>,
    /// Each local's number in the function made (0 for one not touched yet, L_ENTRY being the parameter, 0), and the
    /// types of those numbered, in order.
    slots: [u32; LOCALS],
    kinds: Vec<ValType>,
    /// The rsp written next only goes up (add rsp, n; sub rsp, -n), so it is no new low (note_low).
    rsp_up: bool,
    /// Which blocks are entries (the dispatch may start at them).
    entry: Vec<bool>,
    /// Whether there is a dispatch loop (one made lean has none: lower_function), and whether a jump within went round
    /// it all the same.
    dispatch: bool,
    dispatched: bool,
    /// Nesting of wasm blocks between the current code and the dispatch loop.
    depth: u32,
    program: &'p Program,
    function: &'p Function,
    report: &'p mut Report,
    /// Flags each entry reads before writing them.
    handed: &'p Liveness,
    /// Direction flag, tracked statically within a block (std ... cld).
    backward: bool,
    /// The block being lowered: a goto to it or one before it closes a loop.
    at: usize,
    /// It has a loop: its budget is counted down in L_BUDGET, moved with the registers.
    budget: bool,
    /// What each of the program's functions may do to the registers (summary.rs).
    summaries: &'p [Summary],
    /// The function's loops made wasm loops (clean_loops), the innermost each block lies within past its head, and
    /// the loop each block heads.
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    /// The labels open between the code and the dispatch loop, outermost first, and where each block's label and
    /// each loop's is among them while it is open.
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
}

/// A label open in a function's code: the end of a block's (where that block's code starts: a jump forward to it),
/// or a loop's (its head: round it again).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lab { Block(usize), Loop(usize) }

/// A sync's scope when it may move any register.
const ALL: u32 = u32::MAX;

#[derive(Clone, Copy)]
enum Part { Full, Low32, Low16, Low8, High8 }

/// A register (bit as in Fx::used) read or written, a sync (its index; true
/// where it is not inside a conditional), or where the code may go on to
/// this function's own blocks (a goto, or an indirect jump found within):
/// what is dirty and live there is what those blocks see, whatever the rest
/// of the block does after (a branch's other side may leave the function,
/// with a save on the way).
#[derive(Clone, Copy)]
enum Ev { Read(u8), Write(u8, bool), Sync(usize, bool), Edge }

/// The bit of a register's local.
fn reg_bit(l: u32) -> Option<u8> {
    if (l_reg(0)..l_reg(16)).contains(&l) { Some((l - l_reg(0)) as u8) }
    else if (l_x(0)..l_x(16)).contains(&l) { Some((16 + l - l_x(0)) as u8) }
    else { None }
}

fn gpr(r: Register) -> Option<(u32, Part)> {
    let high = matches!(r, Register::AH | Register::CH | Register::DH | Register::BH);
    if high {
        let n = match r { Register::AH => 0, Register::CH => 1, Register::DH => 2, _ => 3 };
        return Some((n, Part::High8));
    }
    let full = r.full_register();
    if !(Register::RAX as u32..=Register::R15 as u32).contains(&(full as u32)) {
        return Option::None;
    }
    let n = full as u32 - Register::RAX as u32;
    let part = match r.size() { 8 => Part::Full, 4 => Part::Low32, 2 => Part::Low16, _ => Part::Low8 };
    Some((n, part))
}

fn xmm(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::XMM0 as u32..=Register::XMM15 as u32).contains(&n).then(|| n - Register::XMM0 as u32)
}

impl<'p> Fx<'p> {
    fn e(&mut self, i: I) {
        let i = match i {
            W::If(_) | W::Block(_) | W::Loop(_) => { self.nest += 1; i }
            W::End => { self.nest = self.nest.saturating_sub(1); i }
            W::LocalGet(l) => W::LocalGet(self.slot(l)),
            W::LocalSet(l) => W::LocalSet(self.slot(l)),
            W::LocalTee(l) => W::LocalTee(self.slot(l)),
            _ => i,
        };
        crate::emit::op(&mut self.f, &i);
    }
    /// A local's number in the function made: numbered as it is first touched.
    fn slot(&mut self, l: u32) -> u32 {
        let s = &mut self.slots[l as usize];
        if l != L_ENTRY && *s == 0 {
            self.kinds.push(kind(l));
            *s = self.kinds.len() as u32;
        }
        *s
    }
    fn note(&mut self, e: Ev) { if let Some(v) = self.ev.last_mut() { v.push(e); } }
    // The most frequent, straight to their bytes.
    fn get(&mut self, l: u32) {
        self.touch(l);
        if let Some(b) = reg_bit(l) { self.note(Ev::Read(b)); }
        let l = self.slot(l);
        self.f.push(0x20); crate::emit::uleb(&mut self.f, l as u64);
    }
    fn set(&mut self, l: u32) {
        self.touch(l);
        if let Some(b) = reg_bit(l) { let top = self.nest == 0; self.note(Ev::Write(b, top)); }
        let l = self.slot(l);
        self.f.push(0x21); crate::emit::uleb(&mut self.f, l as u64);
    }
    fn tee(&mut self, l: u32) {
        self.touch(l);
        if let Some(b) = reg_bit(l) { let top = self.nest == 0; self.note(Ev::Write(b, top)); }
        let l = self.slot(l);
        self.f.push(0x22); crate::emit::uleb(&mut self.f, l as u64);
    }
    /// Note a register's local in use (every access to one goes through get and set).
    fn touch(&mut self, l: u32) {
        if (l_reg(0)..l_reg(16)).contains(&l) { self.used |= 1 << (l - l_reg(0)); }
        else if (l_x(0)..l_x(16)).contains(&l) { self.used |= 1 << (16 + l - l_x(0)); }
    }
    fn c64(&mut self, v: i64) { self.f.push(0x42); crate::emit::sleb(&mut self.f, v); }
    fn c32(&mut self, v: i32) { self.f.push(0x41); crate::emit::sleb(&mut self.f, v as i64); }

    fn unsupported(&mut self, i: &Instruction) {
        *self.report.unsupported.entry(format!("{:?}", i.mnemonic())).or_default() += 1;
        self.c64(i.ip() as i64);
        self.c32(TRAP_UNSUPPORTED);
        self.e(W::Call(F_TRAP));
        self.e(W::Unreachable);
    }

    // ---- Register file ----

    /// Registers to their globals, for code outside this function (or the
    /// host) to read: those this function touches, the others being in their
    /// globals all along. Put in by lower_function.
    fn save(&mut self) { self.sync(true); }

    fn sync(&mut self, save: bool) { self.sync_in(save, ALL); }
    /// A sync that moves at most the registers in `scope`.
    fn sync_in(&mut self, save: bool, scope: u32) {
        self.syncs.push((self.f.len(), save, scope));
        let (at, top) = (self.syncs.len() - 1, self.nest == 0);
        self.note(Ev::Sync(at, top));
    }

    /// Hand the flags in `mask` to code outside this function, in G_FLAGS,
    /// each computed from the state as it is (nothing is held for it).
    fn save_flags(&mut self, mask: u32) {
        let mut first = true;
        for (k, &(f, bit, _)) in FLAG_BITS.iter().enumerate() {
            if mask & bit == 0 { continue; }
            self.flag(f);
            if k > 0 { self.c32(k as i32); self.e(W::I32Shl); }
            if !first { self.e(W::I32Or); }
            first = false;
        }
        if first { return; }
        self.e(W::I64ExtendI32U);
        self.e(W::GlobalSet(G_FLAGS));
    }

    /// Take the flags in `mask` that the code before left in G_FLAGS.
    fn load_flags(&mut self, mask: u32) {
        for (k, &(_, bit, l)) in FLAG_BITS.iter().enumerate() {
            if mask & bit == 0 { continue; }
            self.e(W::GlobalGet(G_FLAGS));
            self.e(W::I32WrapI64);
            if k > 0 { self.c32(k as i32); self.e(W::I32ShrU); }
            self.c32(1); self.e(W::I32And);
            self.set(l);
        }
        self.set_flags(Flags::Held);
    }

    /// Registers from their globals, after code outside this function ran.
    fn load(&mut self) { self.sync(false); }

    /// The i64 on top, its upper half zeroed: a wrap and an extend (2 bytes, one 32-bit move), not an and with
    /// 0xffffffff (7 bytes, a constant made and anded in V8's first tier).
    fn zext32(&mut self) { self.e(W::I32WrapI64); self.e(W::I64ExtendI32U); }

    /// Push a register's value, zero-extended from its width.
    fn read_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        self.get(l_reg(n));
        match part {
            Part::Full => {}
            Part::Low32 => self.zext32(),
            Part::Low16 => { self.c64(0xffff); self.e(W::I64And); }
            Part::Low8 => { self.c64(0xff); self.e(W::I64And); }
            Part::High8 => { self.c64(8); self.e(W::I64ShrU); self.c64(0xff); self.e(W::I64And); }
        }
        true
    }

    /// Pop an i64 and write it with x86 partial-register rules: 32-bit
    /// writes zero the upper half, 8/16-bit writes merge.
    fn write_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        let l = l_reg(n);
        match part {
            Part::Full => self.set(l),
            Part::Low32 => { self.zext32(); self.set(l); }
            Part::Low16 | Part::Low8 | Part::High8 => {
                let (m, shift) = match part { Part::Low16 => (0xffffi64, 0), Part::Low8 => (0xff, 0), _ => (0xff, 8) };
                self.c64(m); self.e(W::I64And);
                if shift > 0 { self.c64(shift); self.e(W::I64Shl); }
                self.get(l); self.c64(!(m << shift)); self.e(W::I64And);
                self.e(W::I64Or);
                self.set(l);
            }
        }
        if n == RSP && !std::mem::take(&mut self.rsp_up) { self.note_low(); }
        true
    }

    /// low = min(low, rsp) (G_LOW): a read and a compare, and a store only at a new low (rarely, once a thread's
    /// stack has been as deep once), not a select stored at every call.
    fn note_low(&mut self) {
        self.get(l_reg(RSP)); self.e(W::GlobalGet(G_LOW)); self.e(W::I64LtU);
        self.e(W::If(BlockType::Empty));
        self.get(l_reg(RSP)); self.e(W::GlobalSet(G_LOW));
        self.e(W::End);
    }

    // ---- Memory operands ----

    /// Push the effective address as i64 (no segment base unless `segment`).
    fn effective(&mut self, i: &Instruction, segment: bool) {
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
    fn effective_from(&mut self, i: &Instruction, segment: bool, split: bool, narrow: bool) -> u64 {
        let base = i.memory_base();
        let disp = i.memory_displacement64() as i64;
        let mut offset = 0;
        let add = if narrow { W::I32Add } else { W::I64Add };
        let cst = |fx: &mut Self, v: i64| if narrow { fx.c32(v as i32) } else { fx.c64(v) };
        let term = |fx: &mut Self, r: Register| {
            match gpr(r) {
                Some((n, _)) if narrow => { fx.get(l_reg(n)); fx.e(W::I32WrapI64); }
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
                if !first { self.e(add.clone()); }
                first = false;
            }
            if index != Register::None {
                term(self, index);
                let scale = i.memory_index_scale();
                if scale > 1 {
                    cst(self, scale.trailing_zeros() as i64);
                    self.e(if narrow { W::I32Shl } else { W::I64Shl });
                }
                if !first { self.e(add.clone()); }
            }
        }
        if segment && i.memory_segment() == Register::FS {
            self.e(W::GlobalGet(G_FS));
            if narrow { self.e(W::I32WrapI64); }
            self.e(add);
        }
        offset
    }

    fn address(&mut self, i: &Instruction) {
        self.effective_from(i, true, false, true);
    }

    /// The address for a load or store of operand memory, and the offset that load or store adds.
    fn place(&mut self, i: &Instruction) -> u64 {
        self.effective_from(i, true, true, true)
    }

    fn load_sized(&mut self, size: u8) { self.load_at(size, 0) }
    fn store_sized(&mut self, size: u8) { self.store_at(size, 0) }

    fn load_at(&mut self, size: u8, offset: u64) {
        let m = mem_at(offset, 0);
        self.e(match size {
            1 => W::I64Load8U(m),
            2 => W::I64Load16U(m),
            4 => W::I64Load32U(m),
            _ => W::I64Load(m),
        });
    }

    fn store_at(&mut self, size: u8, offset: u64) {
        let m = mem_at(offset, 0);
        self.e(match size {
            1 => W::I64Store8(m),
            2 => W::I64Store16(m),
            4 => W::I64Store32(m),
            _ => W::I64Store(m),
        });
    }

    fn size(i: &Instruction, n: u32) -> u8 {
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
    fn read(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
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
    fn write(&mut self, i: &Instruction, n: u32, size: u8, from: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => { self.get(from); self.write_reg(i.op_register(n)) }
            OpKind::Memory => { let at = self.place(i); self.get(from); self.store_at(size, at); true }
            _ => false,
        }
    }

    fn sign_extend(&mut self, size: u8) {
        match size {
            1 => self.e(W::I64Extend8S),
            2 => self.e(W::I64Extend16S),
            4 => self.e(W::I64Extend32S),
            _ => {}
        }
    }

    fn mask_to(&mut self, size: u8) {
        if size < 8 {
            self.c64(mask(size));
            self.e(W::I64And);
        }
    }

    fn push_value(&mut self, from: u32) {
        self.push_with(|fx| { fx.get(from); true });
    }

    /// Push what `value` puts on the stack, made after rsp moved (so it must not read rsp).
    fn push_with(&mut self, value: impl FnOnce(&mut Self) -> bool) -> bool {
        self.get(l_reg(RSP)); self.c64(8); self.e(W::I64Sub); self.tee(l_reg(RSP));
        self.e(W::I32WrapI64);
        if !value(self) { return false; }
        self.e(W::I64Store(mem(3)));
        true
    }

    /// Write a value known now to a register: a full or 32-bit one takes it as it is.
    fn write_reg_known(&mut self, r: Register, value: i64) -> bool {
        match gpr(r) {
            Some((n, Part::Full)) => { self.c64(value); self.set(l_reg(n)); true }
            Some((n, Part::Low32)) => { self.c64(value & 0xffff_ffff); self.set(l_reg(n)); true }
            Some(_) => { self.c64(value); self.write_reg(r) }
            None => false,
        }
    }

    /// Put what `value` pushes into operand 0 (a register, or memory whose address is taken first).
    fn assign(&mut self, i: &Instruction, size: u8, value: impl FnOnce(&mut Self) -> bool) -> bool {
        match i.op0_kind() {
            OpKind::Register => value(self) && self.write_reg(i.op0_register()),
            OpKind::Memory => { let at = self.place(i); value(self) && { self.store_at(size, at); true } }
            _ => false,
        }
    }

    /// Whether the instruction's operand `n` reads rsp (as the register or in its address).
    fn uses_rsp(i: &Instruction, n: u32) -> bool {
        let rsp = |r: Register| r.full_register() == Register::RSP;
        match i.op_kind(n) {
            OpKind::Register => rsp(i.op_register(n)),
            OpKind::Memory => rsp(i.memory_base()) || rsp(i.memory_index()),
            _ => false,
        }
    }

    fn pop_value(&mut self, into: u32) {
        self.get(l_reg(RSP)); self.e(W::I32WrapI64); self.e(W::I64Load(mem(3))); self.set(into);
        self.get(l_reg(RSP)); self.c64(8); self.e(W::I64Add); self.set(l_reg(RSP));
    }

    // ---- Flags ----

    /// Every change of the flag state goes through here, so a pending result never outlives its compare.
    fn set_flags(&mut self, state: Flags) {
        self.flags = state;
        self.fr_pending = false;
    }

    /// Push the deferred result (L_FR), making it from the operands if a compare left it unmade.
    fn fr(&mut self) {
        if let (true, Flags::Sub(size)) = (self.fr_pending, self.flags) {
            self.get(L_FA); self.get(L_FB); self.e(W::I64Sub); self.mask_to(size);
        } else {
            self.get(L_FR);
        }
    }

    fn sign_bit(&mut self, local: u32, size: u8) {
        if local == L_FR { self.fr(); } else { self.get(local); }
        self.c64(size as i64 * 8 - 1);
        self.e(W::I64ShrU);
        self.c64(1);
        self.e(W::I64And);
        self.e(W::I32WrapI64);
    }

    /// Push one flag of the current state as i32 0/1.
    fn flag(&mut self, f: Flag) {
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
            Flag::Z => { self.fr(); self.e(W::I64Eqz); }
            Flag::S => self.sign_bit(L_FR, size),
            Flag::P => {
                self.fr(); self.c64(0xff); self.e(W::I64And); self.e(W::I64Popcnt);
                self.c64(1); self.e(W::I64And); self.e(W::I64Eqz);
            }
            Flag::C => match kind {
                0 => { self.get(L_FA); self.get(L_FB); self.e(W::I64LtU); }
                1 => { self.fr(); self.get(L_FA); self.e(W::I64LtU); }
                2 => self.c32(0),
                _ => self.get(L_CF),
            },
            Flag::O => match kind {
                0 | 4 => {
                    // (a ^ b) & (a ^ r), sign bit
                    self.get(L_FA); self.get(L_FB); self.e(W::I64Xor);
                    self.get(L_FA); self.fr(); self.e(W::I64Xor);
                    self.e(W::I64And); self.set(l_t(4));
                    self.sign_bit(l_t(4), size);
                }
                1 | 3 => {
                    self.get(L_FA); self.get(L_FR); self.e(W::I64Xor);
                    self.get(L_FB); self.get(L_FR); self.e(W::I64Xor);
                    self.e(W::I64And); self.set(l_t(4));
                    self.sign_bit(l_t(4), size);
                }
                _ => self.c32(0),
            },
        }
    }

    fn hold_flags(&mut self) {
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
    fn read32(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match gpr(i.op_register(n)) {
                Some((k, Part::Full | Part::Low32)) => { self.get(l_reg(k)); self.e(W::I32WrapI64); true }
                Some(_) => { self.read_reg(i.op_register(n)); self.e(W::I32WrapI64); true }
                None => false,
            },
            OpKind::Memory => {
                let at = self.place(i);
                self.e(match size { 1 => W::I32Load8U(mem_at(at, 0)), 2 => W::I32Load16U(mem_at(at, 0)), _ => W::I32Load(mem_at(at, 0)) });
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
    fn fusable(i: &Instruction, cc: ConditionCode) -> bool {
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
    fn fused_condition(&mut self, i: &Instruction, cc: ConditionCode) {
        use ConditionCode as C;
        let size = Self::size(i, 0);
        let narrow = size <= 4;
        let signed = matches!(cc, C::l | C::ge | C::le | C::g | C::s | C::ns);
        let operand = |fx: &mut Self, n: u32| {
            if narrow {
                fx.read32(i, n, size);
                if signed && size < 4 { fx.e(if size == 1 { W::I32Extend8S } else { W::I32Extend16S }); }
            } else {
                fx.read(i, n, size);
            }
        };
        let (eq, ne, lt_u, ge_u, le_u, gt_u, lt_s, ge_s, le_s, gt_s) = if narrow {
            (W::I32Eq, W::I32Ne, W::I32LtU, W::I32GeU, W::I32LeU, W::I32GtU, W::I32LtS, W::I32GeS, W::I32LeS, W::I32GtS)
        } else {
            (W::I64Eq, W::I64Ne, W::I64LtU, W::I64GeU, W::I64LeU, W::I64GtU, W::I64LtS, W::I64GeS, W::I64LeS, W::I64GtS)
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
                    self.e(if narrow { W::I32Sub } else { W::I64Sub });
                    if signed && size < 4 { self.e(if size == 1 { W::I32Extend8S } else { W::I32Extend16S }); }
                    zero(self);
                    self.e(if cc == C::s { lt_s } else { ge_s });
                }
            }
            return;
        }
        // test: the and of its operands, with CF and OF clear.
        operand(self, 0);
        operand(self, 1);
        self.e(if narrow { W::I32And } else { W::I64And });
        match cc {
            C::e | C::be => { zero(self); self.e(eq); }
            C::ne | C::a => { zero(self); self.e(ne); }
            C::s | C::l => { zero(self); self.e(lt_s); }
            C::ns | C::ge => { zero(self); self.e(ge_s); }
            C::le => { zero(self); self.e(le_s); }
            C::g => { zero(self); self.e(gt_s); }
            C::b | C::o => { self.e(W::Drop); self.c32(0); }
            _ => { self.e(W::Drop); self.c32(1); }
        }
    }

    fn condition(&mut self, cc: ConditionCode) {
        use ConditionCode as C;
        if let Some(i) = self.fused.take() { self.fused_condition(&i, cc); return; }
        if let Flags::Sub(size) = self.flags {
            let signed = matches!(cc, C::l | C::ge | C::le | C::g);
            let op = match cc {
                C::e => Some(W::I64Eq), C::ne => Some(W::I64Ne),
                C::b => Some(W::I64LtU), C::ae => Some(W::I64GeU), C::be => Some(W::I64LeU), C::a => Some(W::I64GtU),
                C::l => Some(W::I64LtS), C::ge => Some(W::I64GeS), C::le => Some(W::I64LeS), C::g => Some(W::I64GtS),
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
                C::e => { self.fr(); self.e(W::I64Eqz); return; }
                C::ne => { self.fr(); self.c64(0); self.e(W::I64Ne); return; }
                C::s | C::l => { self.sign_bit(L_FR, size); return; }
                C::ns | C::ge => { self.sign_bit(L_FR, size); self.e(W::I32Eqz); return; }
                C::le | C::g => {
                    self.fr(); if size < 8 { self.sign_extend(size); } self.c64(0);
                    self.e(if cc == C::le { W::I64LeS } else { W::I64GtS });
                    return;
                }
                _ => {}
            }
        }
        match cc {
            C::o => self.flag(Flag::O),
            C::no => { self.flag(Flag::O); self.e(W::I32Eqz); }
            C::b => self.flag(Flag::C),
            C::ae => { self.flag(Flag::C); self.e(W::I32Eqz); }
            C::e => self.flag(Flag::Z),
            C::ne => { self.flag(Flag::Z); self.e(W::I32Eqz); }
            C::be => { self.flag(Flag::C); self.flag(Flag::Z); self.e(W::I32Or); }
            C::a => { self.flag(Flag::C); self.flag(Flag::Z); self.e(W::I32Or); self.e(W::I32Eqz); }
            C::s => self.flag(Flag::S),
            C::ns => { self.flag(Flag::S); self.e(W::I32Eqz); }
            C::p => self.flag(Flag::P),
            C::np => { self.flag(Flag::P); self.e(W::I32Eqz); }
            C::l => { self.flag(Flag::S); self.flag(Flag::O); self.e(W::I32Ne); }
            C::ge => { self.flag(Flag::S); self.flag(Flag::O); self.e(W::I32Eq); }
            C::le => { self.flag(Flag::Z); self.flag(Flag::S); self.flag(Flag::O); self.e(W::I32Ne); self.e(W::I32Or); }
            C::g => {
                self.flag(Flag::Z); self.e(W::I32Eqz);
                self.flag(Flag::S); self.flag(Flag::O); self.e(W::I32Eq);
                self.e(W::I32And);
            }
            C::None => self.c32(1),
        }
    }

    /// Record a deferred producer: a, b already in L_FA/L_FB, result in L_FR.
    fn defer(&mut self, state: Flags) {
        self.set_flags(state);
    }

    // ---- Control helpers ----

    /// Continue at `address`: fall through if it is the next block; a block
    /// after this one, straight to it; one before (a loop's round), through
    /// the dispatch loop; else leave the function.
    /// A label opened (its code emitted already), and where it is among those open.
    fn open(&mut self, l: Lab) {
        let at = Some(self.labels.len() as u32);
        match l { Lab::Block(b) => self.block_at[b] = at, Lab::Loop(i) => self.loop_at[i] = at }
        self.labels.push(l);
    }
    /// The innermost label closed (its end emitted already): it must be `l`.
    fn close(&mut self, l: Lab) {
        assert_eq!(self.labels.pop(), Some(l), "labels closed out of order");
        match l { Lab::Block(b) => self.block_at[b] = None, Lab::Loop(i) => self.loop_at[i] = None }
    }
    /// The depth of a br from here to the label at `at` among those open.
    fn to(&self, at: u32) -> u32 { self.depth - 1 - at }

    /// Into loop `l` at its head: the loop's label and the labels of the blocks within it (but those within a loop
    /// within it). Nothing comes to those from outside the loop (clean_loops).
    fn enter_loop(&mut self, l: usize) {
        let Loop { head, last, .. } = self.loops[l];
        self.e(W::Loop(BlockType::Empty));
        self.open(Lab::Loop(l));
        let mine: Vec<usize> = (head + 1..=last).rev().filter(|&b| self.within[b] == Some(l)).collect();
        for b in mine {
            self.e(W::Block(BlockType::Empty));
            self.open(Lab::Block(b));
        }
        // Entered past its head (only ever from the dispatch: a call's continuation, a loop within it, after the
        // thread was taken back to the kernel there): on to that block, or to the head of the loop within this one
        // that holds it, which sends it on in turn. A test of a local every time round, the rest only then.
        if !(head + 1..=last).any(|b| self.entry[b]) { return; }
        self.depth = self.labels.len() as u32;
        // Where each block from the head on is sent: Ok(its label) when within this loop itself (L_INTO spent),
        // Err(the label of the head of the loop within this one that holds it).
        let route: Vec<Result<u32, u32>> = (head + 1..=last).map(|b| {
            let mut w = self.within[b];
            let mut t = b;
            while let Some(c) = w {
                if c == l { break; }
                t = self.loops[c].head;
                w = self.loops[c].parent;
            }
            let at = self.block_at[t].unwrap_or_default();
            if t == b { Ok(at) } else { Err(at) }
        }).collect();
        self.get(L_INTO);
        self.e(W::If(BlockType::Empty));
        self.e(W::Block(BlockType::Empty));
        // Inside the if and this block: 2 deeper than the labels.
        let outer: Vec<u32> = route.iter().map(|r| match *r { Ok(_) => 0, Err(at) => self.to(at) + 2 }).collect();
        self.get(L_INTO); self.c32(head as i32 + 2); self.e(W::I32Sub);
        self.e(W::BrTable(Cow::Owned(outer), 1));
        self.e(W::End);
        // Within this loop itself: spent, and on to its block (inside the if: 1 deeper).
        let inner: Vec<u32> = route.iter().map(|r| match *r { Ok(at) => self.to(at) + 1, Err(_) => 0 }).collect();
        self.get(L_INTO); self.c32(0); self.set(L_INTO);
        self.c32(head as i32 + 2); self.e(W::I32Sub);
        self.e(W::BrTable(Cow::Owned(inner), 0));
        self.e(W::End);
    }

    /// The depth of a br to `address`, when it is a block after this one whose label is open here.
    fn forward(&self, address: u64) -> Option<u32> {
        let b = self.function.block_index(address).filter(|&b| b > self.at)?;
        self.block_at[b].map(|at| self.to(at))
    }

    fn goto(&mut self, address: u64, next: Option<u64>) {
        if Some(address) == next {
            self.note(Ev::Edge);
            return;
        }
        match self.function.block_index(address) {
            Some(b) if b > self.at => {
                self.note(Ev::Edge);
                match self.block_at[b] {
                    // Its label is open here (lower_function): out to it, with no round of the dispatch loop (its
                    // br_table an indirect jump, and every local merged at its head).
                    Some(at) => self.e(W::Br(self.to(at))),
                    // Its label is not open here: round the dispatch loop (a block within a loop is never one: nothing
                    // jumps into a loop from outside it but to its head, clean_loops).
                    None => { self.dispatched = true; self.c32(b as i32); self.set(L_BLK); self.e(W::Br(self.depth)); }
                }
            }
            Some(b) => {
                self.time_slice(address);
                self.note(Ev::Edge);
                match self.heads[b].and_then(|l| self.loop_at[l]) {
                    // Back to the head of a loop this code is in: round that loop.
                    Some(at) => self.e(W::Br(self.to(at))),
                    None => {
                        self.dispatched = true;
                        self.c32(b as i32);
                        self.set(L_BLK);
                        self.e(W::Br(self.depth));
                    }
                }
            }
            None => {
                // Out to an address before this block's (a run of the same function cut into runs: discover.rs RUN), a
                // loop may go round that way: it counts as a loop's round.
                if address <= self.function.blocks[self.at].start { self.time_slice(address); }
                self.tail(address)
            }
        }
    }

    /// Round a loop: one less of the time slice, and at its end back to the kernel, to go on at `address` (a loop's
    /// head, an entry) once the kernel has seen to timers, signals and other threads.
    /// Nonzero when the thread's budget is spent (one less now).
    fn spent(&mut self) {
        if self.budget {
            self.get(L_BUDGET); self.c32(1); self.e(W::I32Sub); self.tee(L_BUDGET); self.e(W::I32Eqz);
        } else {
            self.e(W::GlobalGet(G_BUDGET)); self.c32(1); self.e(W::I32Sub); self.e(W::GlobalSet(G_BUDGET));
            self.e(W::GlobalGet(G_BUDGET)); self.e(W::I32Eqz);
        }
    }

    /// At a loop's head: its turn is up when its budget is spent, or when it is asked to look in (a signal to take
    /// soon after it came, as a CPU takes an interrupt: at a loop, not a call, so a signal that comes just before a
    /// call that waits for one, as in `while (!got) pause();`, is taken there, by the call, as at a system call).
    fn time_slice(&mut self, address: u64) {
        self.spent();
        self.c32(0); self.e(W::I32Load(mem_at(INTERRUPT as u64, 2)));
        self.e(W::I32Or);
        self.e(W::If(BlockType::Empty));
        self.depth += 1;
        self.save();
        self.save_flags(self.handed.handed(address));
        self.c64(address as i64); self.c32(TRAP_YIELD); self.e(W::Call(F_TRAP)); self.e(W::Unreachable);
        self.depth -= 1;
        self.e(W::End);
    }

    /// Before a call (registers saved, the return address pushed): past DEPTH_LIMIT frames, or when the thread's
    /// budget is spent (a call counts as a loop does: recursion without loops has its turns too), it is made from the
    /// kernel instead, to the target in `target` (pushes its address); else it counts as one frame more.
    fn enter_call(&mut self, flags: u32, target: impl FnOnce(&mut Self)) {
        self.note_low();
        self.e(W::GlobalGet(G_DEPTH)); self.c32(DEPTH_LIMIT); self.e(W::I32GeU);
        self.spent();
        self.e(W::I32Or);
        self.e(W::If(BlockType::Empty));
        self.depth += 1;
        self.save_flags(flags);
        target(self);
        self.c32(TRAP_UNWIND); self.c32(TRAP_YIELD);
        self.e(W::GlobalGet(G_DEPTH)); self.c32(DEPTH_LIMIT); self.e(W::I32GeU);
        self.e(W::Select);
        self.e(W::Call(F_TRAP)); self.e(W::Unreachable);
        self.depth -= 1;
        self.e(W::End);
        self.e(W::GlobalGet(G_DEPTH)); self.c32(1); self.e(W::I32Add); self.e(W::GlobalSet(G_DEPTH));
    }
    fn leave_call(&mut self) { self.e(W::GlobalGet(G_DEPTH)); self.c32(1); self.e(W::I32Sub); self.e(W::GlobalSet(G_DEPTH)); }

    /// Transfer to code outside this function without growing the stack.
    fn tail(&mut self, address: u64) {
        self.save();
        self.save_flags(self.handed.handed(address));
        match self.program.entries.get(&address) {
            Some(&(f, b)) => {
                self.c32(b as i32);
                self.e(W::ReturnCall(FIRST_GUEST + f));
            }
            None => {
                self.c64(address as i64);
                self.e(W::ReturnCall(F_DISPATCH));
            }
        }
    }

    /// After a call: on at its return address, or, handed another (a longjmp out of the callee, handed up by each
    /// frame it left, in l_t(0)), to the function's resume (lower_function): on there in this frame when it is this
    /// function's own, else up to the caller.
    /// After a call to a function that never goes out (summary.rs), which may have written only `writes`: on at its
    /// return address with those taken back, the rest still in this frame's locals; handed another, all this frame
    /// holds goes to the globals first, where the resume reads it (after_call).
    fn after_call_in(&mut self, ret: u64, next: Option<u64>, writes: u32) {
        self.get(l_t(0)); self.c64(ret as i64); self.e(W::I64Ne);
        self.e(W::If(BlockType::Empty));
        self.save();
        self.e(W::Br(self.depth + 1 + self.dispatch as u32));
        self.e(W::End);
        self.sync_in(false, writes);
        self.set_flags(Flags::Held);
        self.goto(ret, next);
    }

    fn after_call(&mut self, ret: u64, next: Option<u64>) {
        self.get(l_t(0)); self.c64(ret as i64); self.e(W::I64Ne);
        self.e(W::If(BlockType::Empty));
        self.e(W::Br(self.depth + 1 + self.dispatch as u32));
        self.e(W::End);
        self.load();
        self.set_flags(Flags::Held);
        self.goto(ret, next);
    }
}

// ---- Instruction semantics ----

impl Fx<'_> {
    /// add, sub, cmp, and, test, or, xor. What is kept for the flags is only
    /// what a later instruction reads (`need`): nothing when none does; the
    /// result alone for a logic op, whose flags all come from it; the two
    /// operands for a compare, whose result most conditions never ask for.
    fn binary(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
        let size = Self::size(i, 0);
        let (wasm, state, write) = match op {
            Mnemonic::Add => (W::I64Add, Flags::Add(size), true),
            Mnemonic::Sub => (W::I64Sub, Flags::Sub(size), true),
            Mnemonic::Cmp => (W::I64Sub, Flags::Sub(size), false),
            Mnemonic::And => (W::I64And, Flags::Logic(size), true),
            Mnemonic::Test => (W::I64And, Flags::Logic(size), false),
            Mnemonic::Or => (W::I64Or, Flags::Logic(size), true),
            Mnemonic::Xor => (W::I64Xor, Flags::Logic(size), true),
            _ => return false,
        };
        let memory = i.op0_kind() == OpKind::Memory;
        if !need && !write {
            // Nothing reads what it sets; only a read that may fault is kept.
            if memory { let at = self.place(i); self.load_at(size, at); self.e(W::Drop); }
            return true;
        }
        // The destination's address once, kept for the store.
        let mut at = 0;
        if memory && write { at = self.place(i); self.e(W::LocalTee(l_u(0))); self.e(W::LocalGet(l_u(0))); self.load_at(size, at); } else if !self.read(i, 0, size) { return false; }
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
            if write { self.e(W::LocalTee(L_FR)); } else { self.set(L_FR); }
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

    fn carry(&mut self, i: &Instruction, subtract: bool) -> bool {
        let size = Self::size(i, 0);
        self.flag(Flag::C); self.e(W::I64ExtendI32U); self.set(l_t(1));
        if !self.read(i, 0, size) { return false; }
        self.set(L_FA);
        if !self.read(i, 1, size) { return false; }
        self.set(L_FB);
        self.get(L_FA); self.get(L_FB);
        self.e(if subtract { W::I64Sub } else { W::I64Add });
        self.get(l_t(1));
        self.e(if subtract { W::I64Sub } else { W::I64Add });
        self.mask_to(size); self.set(L_FR);
        // CF: with carry-in the comparison includes equality.
        if subtract {
            self.get(L_FA); self.get(L_FB); self.e(W::I64LeU);
            self.get(L_FA); self.get(L_FB); self.e(W::I64LtU);
        } else {
            self.get(L_FR); self.get(L_FA); self.e(W::I64LeU);
            self.get(L_FR); self.get(L_FA); self.e(W::I64LtU);
        }
        self.get(l_t(1)); self.e(W::I32WrapI64);
        self.e(W::Select);
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

    fn unary(&mut self, i: &Instruction, op: Mnemonic) -> bool {
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
                self.c64(mask(size)); self.e(W::I64Xor); self.set(l_t(1));
                return self.write(i, 0, size, l_t(1));
            }
            Mnemonic::Neg => {
                self.set(L_FB); self.c64(0); self.set(L_FA);
                self.c64(0); self.get(L_FB); self.e(W::I64Sub);
                self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Sub(size));
            }
            Mnemonic::Inc => {
                self.set(L_FA); self.c64(1); self.set(L_FB);
                self.get(L_FA); self.c64(1); self.e(W::I64Add); self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Inc(size));
            }
            Mnemonic::Dec => {
                self.set(L_FA); self.c64(1); self.set(L_FB);
                self.get(L_FA); self.c64(1); self.e(W::I64Sub); self.mask_to(size); self.set(L_FR);
                self.defer(Flags::Dec(size));
            }
            _ => return false,
        }
        self.write(i, 0, size, L_FR)
    }

    fn shift(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
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
        self.c64(count_mask); self.e(W::I64And); self.set(l_t(2));
        if constant == Some(0) {
            return true;
        }
        // Rotates of sub-64-bit values are done on a replicated value.
        match op {
            Mnemonic::Shl | Mnemonic::Sal => { self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64Shl); self.mask_to(size); }
            Mnemonic::Shr => { self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64ShrU); }
            Mnemonic::Sar => {
                self.get(l_t(1)); self.sign_extend(size); self.get(l_t(2)); self.e(W::I64ShrS); self.mask_to(size);
            }
            Mnemonic::Rol | Mnemonic::Ror => {
                if size == 8 {
                    self.get(l_t(1)); self.get(l_t(2));
                    self.e(if op == Mnemonic::Rol { W::I64Rotl } else { W::I64Rotr });
                } else {
                    // rotate within `bits`: (x << c | x >> (bits - c)) & mask, c taken mod bits
                    self.get(l_t(2)); self.c64(bits); self.e(W::I64RemU); self.set(l_t(2));
                    let (a, b) = if op == Mnemonic::Rol { (W::I64Shl, W::I64ShrU) } else { (W::I64ShrU, W::I64Shl) };
                    self.get(l_t(1)); self.get(l_t(2)); self.e(a);
                    self.get(l_t(1)); self.c64(bits); self.get(l_t(2)); self.e(W::I64Sub); self.e(b);
                    self.e(W::I64Or); self.mask_to(size);
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
                if variable { fx.get(local); fx.get(l_t(2)); fx.c64(0); fx.e(W::I64Ne); fx.e(W::Select); }
                fx.set(local);
            };
            put(self, L_CF, &|fx| {
                match op {
                    Mnemonic::Shl | Mnemonic::Sal => {
                        fx.get(l_t(1)); fx.c64(bits); fx.get(l_t(2)); fx.e(W::I64Sub); fx.e(W::I64ShrU);
                    }
                    Mnemonic::Sar => {
                        fx.get(l_t(1)); fx.sign_extend(size); fx.get(l_t(2)); fx.c64(1); fx.e(W::I64Sub); fx.e(W::I64ShrS);
                    }
                    _ => { fx.get(l_t(1)); fx.get(l_t(2)); fx.c64(1); fx.e(W::I64Sub); fx.e(W::I64ShrU); }
                }
                fx.c64(1); fx.e(W::I64And); fx.e(W::I32WrapI64);
            });
            put(self, L_ZF, &|fx| { fx.get(l_t(3)); fx.e(W::I64Eqz); });
            put(self, L_SF, &|fx| fx.sign_bit(l_t(3), size));
            put(self, L_PF, &|fx| {
                fx.get(l_t(3)); fx.c64(0xff); fx.e(W::I64And); fx.e(W::I64Popcnt); fx.c64(1); fx.e(W::I64And); fx.e(W::I64Eqz);
            });
            put(self, L_OF, &|fx| match op {
                Mnemonic::Shl | Mnemonic::Sal => {
                    fx.sign_bit(l_t(3), size); fx.get(L_CF); fx.e(W::I32Xor);
                }
                Mnemonic::Shr => fx.sign_bit(l_t(1), size),
                _ => fx.c32(0),
            });
        } else if need {
            self.hold_flags();
            // Rotates: CF is the bit that wrapped around.
            self.get(l_t(3));
            if op == Mnemonic::Rol { self.c64(1); self.e(W::I64And); } else { self.c64(bits - 1); self.e(W::I64ShrU); self.c64(1); self.e(W::I64And); }
            self.e(W::I32WrapI64);
            if constant.is_none() { self.get(L_CF); self.get(l_t(2)); self.c64(0); self.e(W::I64Ne); self.e(W::Select); }
            self.set(L_CF);
        }
        self.write(i, 0, size, l_t(3))
    }

    /// rcl/rcr: rotate through the carry, by a count the instruction holds (its immediate, or the 1 of its short
    /// form; a count in CL is not lowered). Go's compiler makes `rcr $1` for division by a constant (the carry of
    /// an add put back as the top bit). Only CF and OF change.
    fn rotate_carry(&mut self, i: &Instruction, op: Mnemonic, need: bool) -> bool {
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
        self.flag(Flag::C); self.e(W::I64ExtendI32U); self.set(l_t(2));
        let left = op == Mnemonic::Rcl;
        // rcr: x >> c | CF << (bits - c) | x << (bits + 1 - c); rcl: x << c | CF << (c - 1) | x >> (bits + 1 - c).
        // A term shifted by the whole width holds nothing (wasm would take the shift mod 64): it is left out.
        let (near, far) = if left { (W::I64Shl, W::I64ShrU) } else { (W::I64ShrU, W::I64Shl) };
        if c < bits { self.get(l_t(1)); self.c64(c); self.e(near); } else { self.c64(0); }
        self.get(l_t(2)); self.c64(if left { c - 1 } else { bits - c }); self.e(W::I64Shl); self.e(W::I64Or);
        if c > 1 { self.get(l_t(1)); self.c64(bits + 1 - c); self.e(far); self.e(W::I64Or); }
        self.mask_to(size); self.set(l_t(3));
        if need {
            self.hold_flags();
            // CF: the last bit rotated out of the value.
            self.get(l_t(1)); self.c64(if left { bits - c } else { c - 1 }); self.e(W::I64ShrU);
            self.c64(1); self.e(W::I64And); self.e(W::I32WrapI64); self.set(L_CF);
            // OF, defined for a count of 1: the result's top bit against CF after (rcl) or its next bit (rcr).
            if c == 1 {
                self.sign_bit(l_t(3), size);
                if left {
                    self.get(L_CF);
                } else {
                    self.get(l_t(3)); self.c64(bits - 2); self.e(W::I64ShrU); self.c64(1); self.e(W::I64And);
                    self.e(W::I32WrapI64);
                }
                self.e(W::I32Xor); self.set(L_OF);
            }
        }
        self.write(i, 0, size, l_t(3))
    }

    /// shld/shrd: shift `dst` filling from `src`.
    fn double_shift(&mut self, i: &Instruction, need: bool) -> bool {
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
        self.c64(if size == 8 { 63 } else { 31 }); self.e(W::I64And); self.set(l_t(3));
        // c == 0 leaves everything unchanged; wasm shifts by `bits` are
        // shifts by 0, so guard that case with a select.
        let (a, b) = if left { (W::I64Shl, W::I64ShrU) } else { (W::I64ShrU, W::I64Shl) };
        self.get(l_t(1)); self.get(l_t(3)); self.e(a.clone());
        self.get(l_t(2)); self.c64(bits); self.get(l_t(3)); self.e(W::I64Sub); self.e(b);
        self.e(W::I64Or); self.mask_to(size);
        self.get(l_t(1)); self.get(l_t(3)); self.c64(0); self.e(W::I64Ne); self.e(W::Select);
        self.set(l_t(4));
        if need {
            self.hold_flags();
            // CF: last bit shifted out of dst.
            self.get(l_t(1));
            if left { self.c64(bits); self.get(l_t(3)); self.e(W::I64Sub); self.e(W::I64ShrU); }
            else { self.get(l_t(3)); self.c64(1); self.e(W::I64Sub); self.e(W::I64ShrU); }
            self.c64(1); self.e(W::I64And); self.e(W::I32WrapI64);
            self.get(L_CF); self.get(l_t(3)); self.c64(0); self.e(W::I64Ne); self.e(W::Select); self.set(L_CF);
            self.get(l_t(4)); self.e(W::I64Eqz); self.get(L_ZF); self.get(l_t(3)); self.c64(0); self.e(W::I64Ne); self.e(W::Select); self.set(L_ZF);
            self.sign_bit(l_t(4), size); self.get(L_SF); self.get(l_t(3)); self.c64(0); self.e(W::I64Ne); self.e(W::Select); self.set(L_SF);
            self.c32(0); self.set(L_OF);
        }
        self.write(i, 0, size, l_t(4))
    }

    fn multiply(&mut self, i: &Instruction, need: bool) -> bool {
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
                self.get(l_t(1)); self.get(l_t(2)); self.e(W::Call(if signed { F_MULHS } else { F_MULHU })); self.set(l_t(3));
                self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64Mul); self.set(l_reg(RAX));
                self.get(l_t(3)); self.set(l_reg(RDX));
                if need {
                    // Overflow when the high half is not the extension of the low.
                    self.get(l_t(3));
                    if signed { self.get(l_reg(RAX)); self.c64(63); self.e(W::I64ShrS); } else { self.c64(0); }
                    self.e(W::I64Ne);
                    self.set(l_u(0));
                }
            } else {
                self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64Mul); self.set(l_t(3));
                let bits = size as i64 * 8;
                if size == 1 {
                    self.get(l_t(3)); self.c64(0xffff); self.e(W::I64And); self.set(l_t(4));
                    self.get(l_t(4)); self.write_reg(Register::AX);
                } else {
                    let (lo, hi) = match size { 2 => (Register::AX, Register::DX), _ => (Register::EAX, Register::EDX) };
                    self.get(l_t(3)); self.write_reg(lo);
                    self.get(l_t(3)); self.c64(bits); self.e(W::I64ShrU); self.write_reg(hi);
                }
                if need {
                    self.get(l_t(3));
                    if signed { self.get(l_t(3)); self.sign_extend(size); self.e(W::I64Ne); }
                    else { self.c64(bits); self.e(W::I64ShrU); self.c64(0); self.e(W::I64Ne); }
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
            self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64Mul); self.set(l_t(3));
            if need {
                if size == 8 {
                    self.get(l_t(1)); self.get(l_t(2)); self.e(W::Call(F_MULHS));
                    self.get(l_t(3)); self.c64(63); self.e(W::I64ShrS); self.e(W::I64Ne);
                } else {
                    self.get(l_t(3)); self.get(l_t(3)); self.sign_extend(size); self.e(W::I64Ne);
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

    fn divide(&mut self, i: &Instruction) -> bool {
        let signed = i.mnemonic() == Mnemonic::Idiv;
        let size = Self::size(i, 0);
        if !self.read(i, 0, size) { return false; }
        self.set(l_t(2));
        if size == 8 {
            // 128/64 in the host only when rdx is not the extension of rax.
            self.get(l_reg(RDX));
            if signed { self.get(l_reg(RAX)); self.c64(63); self.e(W::I64ShrS); } else { self.c64(0); }
            self.e(W::I64Eq);
            self.e(W::If(BlockType::Empty));
            self.depth += 1;
            self.get(l_reg(RAX)); self.get(l_t(2)); self.e(if signed { W::I64DivS } else { W::I64DivU }); self.set(l_t(3));
            self.get(l_reg(RAX)); self.get(l_t(2)); self.e(if signed { W::I64RemS } else { W::I64RemU }); self.set(l_reg(RDX));
            self.get(l_t(3)); self.set(l_reg(RAX));
            self.e(W::Else);
            self.get(l_reg(RDX)); self.get(l_reg(RAX)); self.get(l_t(2)); self.c32(signed as i32);
            self.e(W::Call(F_DIV128));
            self.set(l_reg(RDX)); self.set(l_reg(RAX));
            self.e(W::End);
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
            self.read_reg(hi); self.c64(bits); self.e(W::I64Shl);
            self.read_reg(lo); self.e(W::I64Or);
            if signed && size == 2 { self.e(W::I64Extend32S); }
        }
        self.set(l_t(1));
        if signed { self.get(l_t(2)); self.sign_extend(size); self.set(l_t(2)); }
        self.get(l_t(1)); self.get(l_t(2)); self.e(if signed { W::I64DivS } else { W::I64DivU }); self.set(l_t(3));
        self.get(l_t(1)); self.get(l_t(2)); self.e(if signed { W::I64RemS } else { W::I64RemU }); self.set(l_t(4));
        match size {
            1 => {
                self.get(l_t(4)); self.c64(0xff); self.e(W::I64And); self.c64(8); self.e(W::I64Shl);
                self.get(l_t(3)); self.c64(0xff); self.e(W::I64And); self.e(W::I64Or);
                self.write_reg(Register::AX);
            }
            2 => { self.get(l_t(3)); self.write_reg(Register::AX); self.get(l_t(4)); self.write_reg(Register::DX); }
            _ => { self.get(l_t(3)); self.write_reg(Register::EAX); self.get(l_t(4)); self.write_reg(Register::EDX); }
        }
        true
    }

    fn string(&mut self, i: &Instruction) -> bool {
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
            self.get(l_reg(RCX)); if size > 1 { self.c64(size.trailing_zeros() as i64); self.e(W::I64Shl); } self.set(l_t(1));
            self.get(l_reg(RDI)); self.get(l_t(1)); self.e(W::I64Sub); self.c64(size as i64); self.e(W::I64Add); self.e(W::I32WrapI64);
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(W::I64Sub); self.c64(size as i64); self.e(W::I64Add); self.e(W::I32WrapI64);
            self.get(l_t(1)); self.e(W::I32WrapI64);
            self.e(W::MemoryCopy { src_mem: 0, dst_mem: 0 });
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(W::I64Sub); self.set(l_reg(RSI));
            self.get(l_reg(RDI)); self.get(l_t(1)); self.e(W::I64Sub); self.set(l_reg(RDI));
            self.c64(0); self.set(l_reg(RCX));
            return true;
        }
        if rep {
            // count bytes = rcx * size
            self.get(l_reg(RCX)); if size > 1 { self.c64(size.trailing_zeros() as i64); self.e(W::I64Shl); } self.set(l_t(1));
        } else {
            self.c64(size as i64); self.set(l_t(1));
        }
        if store {
            if size == 1 || !rep {
                if size == 1 {
                    self.get(l_reg(RDI)); self.e(W::I32WrapI64);
                    self.get(l_reg(RAX)); self.e(W::I32WrapI64);
                    self.get(l_t(1)); self.e(W::I32WrapI64);
                    self.e(W::MemoryFill(0));
                } else {
                    self.get(l_reg(RDI)); self.e(W::I32WrapI64); self.get(l_reg(RAX)); self.store_sized(size);
                }
            } else {
                // Wider fills: loop over elements.
                self.get(l_reg(RDI)); self.set(l_t(2));
                self.get(l_reg(RCX)); self.set(l_t(3));
                self.e(W::Block(BlockType::Empty));
                self.e(W::Loop(BlockType::Empty));
                self.get(l_t(3)); self.e(W::I64Eqz); self.e(W::BrIf(1));
                self.get(l_t(2)); self.e(W::I32WrapI64); self.get(l_reg(RAX)); self.store_sized(size);
                self.get(l_t(2)); self.c64(size as i64); self.e(W::I64Add); self.set(l_t(2));
                self.get(l_t(3)); self.c64(1); self.e(W::I64Sub); self.set(l_t(3));
                self.e(W::Br(0));
                self.e(W::End);
                self.e(W::End);
            }
        } else {
            // x86 forward rep movs copies element by element, so overlapping
            // forward copies replicate; memory.copy is exact for the
            // non-overlapping and backward-safe cases compilers emit.
            self.get(l_reg(RDI)); self.e(W::I32WrapI64);
            self.get(l_reg(RSI)); self.e(W::I32WrapI64);
            self.get(l_t(1)); self.e(W::I32WrapI64);
            self.e(W::MemoryCopy { src_mem: 0, dst_mem: 0 });
            self.get(l_reg(RSI)); self.get(l_t(1)); self.e(W::I64Add); self.set(l_reg(RSI));
        }
        self.get(l_reg(RDI)); self.get(l_t(1)); self.e(W::I64Add); self.set(l_reg(RDI));
        if rep { self.c64(0); self.set(l_reg(RCX)); }
        true
    }

    fn bit_test(&mut self, i: &Instruction) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        // Bit offset, and the operand it addresses.
        if !self.read(i, 1, size) { return false; }
        self.set(l_t(2));
        let register_offset_into_memory = i.op0_kind() == OpKind::Memory && i.op1_kind() == OpKind::Register;
        if register_offset_into_memory {
            // The offset is signed and may select a different word.
            self.effective(i, true);
            self.get(l_t(2)); self.sign_extend(size); self.c64(3); self.e(W::I64ShrS);
            self.c64(-(size as i64)); self.e(W::I64And);
            self.e(W::I64Add); self.set(l_t(5));
            self.get(l_t(5)); self.e(W::I32WrapI64); self.load_sized(size); self.set(l_t(1));
        } else {
            if !self.read(i, 0, size) { return false; }
            self.set(l_t(1));
        }
        self.get(l_t(2)); self.c64(bits - 1); self.e(W::I64And); self.set(l_t(2));
        self.hold_flags();
        self.get(l_t(1)); self.get(l_t(2)); self.e(W::I64ShrU); self.c64(1); self.e(W::I64And); self.e(W::I32WrapI64);
        self.set(L_CF);
        let op = match i.mnemonic() {
            Mnemonic::Bt => return true,
            Mnemonic::Bts => 0, Mnemonic::Btr => 1, _ => 2,
        };
        self.c64(1); self.get(l_t(2)); self.e(W::I64Shl); self.set(l_t(3));
        self.get(l_t(1));
        match op {
            0 => { self.get(l_t(3)); self.e(W::I64Or); }
            1 => { self.get(l_t(3)); self.c64(-1); self.e(W::I64Xor); self.e(W::I64And); }
            _ => { self.get(l_t(3)); self.e(W::I64Xor); }
        }
        self.mask_to(size);
        self.set(l_t(1));
        if register_offset_into_memory {
            self.get(l_t(5)); self.e(W::I32WrapI64); self.get(l_t(1)); self.store_sized(size);
            true
        } else {
            self.write(i, 0, size, l_t(1))
        }
    }

    fn count_bits(&mut self, i: &Instruction, need: bool) -> bool {
        let size = Self::size(i, 0);
        let bits = size as i64 * 8;
        if !self.read(i, 1, size) { return false; }
        self.set(l_t(1));
        let m = i.mnemonic();
        // wasm `select(a, b, c)` is `c ? a : b`.
        match m {
            Mnemonic::Popcnt => { self.get(l_t(1)); self.e(W::I64Popcnt); }
            Mnemonic::Tzcnt | Mnemonic::Bsf => {
                // tzcnt of 0 is the operand width.
                self.c64(bits); self.get(l_t(1)); self.e(W::I64Ctz);
                self.get(l_t(1)); self.e(W::I64Eqz); self.e(W::Select);
            }
            Mnemonic::Lzcnt | Mnemonic::Bsr => {
                // Leading zeros within the operand width (0 gives the width).
                self.get(l_t(1)); self.e(W::I64Clz); self.c64(64 - bits); self.e(W::I64Sub);
                if m == Mnemonic::Bsr { self.set(l_t(3)); self.c64(bits - 1); self.get(l_t(3)); self.e(W::I64Sub); }
            }
            _ => return false,
        }
        self.set(l_t(3));
        if matches!(m, Mnemonic::Bsf | Mnemonic::Bsr) {
            // Source zero: destination unchanged, ZF set.
            if !self.read(i, 0, size) { return false; }
            self.set(l_t(4));
            self.get(l_t(4)); self.get(l_t(3)); self.get(l_t(1)); self.e(W::I64Eqz); self.e(W::Select); self.set(l_t(3));
        }
        if need {
            self.hold_flags();
            self.get(l_t(1)); self.e(W::I64Eqz);
            self.set(if m == Mnemonic::Tzcnt || m == Mnemonic::Lzcnt { L_CF } else { L_ZF });
            if m == Mnemonic::Popcnt {
                self.get(l_t(1)); self.e(W::I64Eqz); self.set(L_ZF);
                self.c32(0); self.set(L_CF);
            }
            if m == Mnemonic::Tzcnt || m == Mnemonic::Lzcnt {
                self.get(l_t(3)); self.e(W::I64Eqz); self.set(L_ZF);
            }
            self.c32(0); self.set(L_OF);
        }
        self.write(i, 0, size, l_t(3))
    }

    /// clock_gettime (228) of a wall or steady clock, answered here as Linux's vDSO answers it in the caller: its
    /// time asked of the host (F_TIME, a number: no 64-bit value crosses), the timespec written at rsi, 0 in l_t(1),
    /// and out of the two blocks around this. Any other call, a clock the kernel keeps (a CPU-time one), or rsi not
    /// a timespec in memory past the kernel's low page (the kernel says EFAULT): on, to the kernel.
    fn clock_gettime(&mut self) {
        self.get(l_reg(RAX)); self.c64(228); self.e(W::I64Ne); self.e(W::BrIf(0));
        self.get(l_reg(RSI)); self.c64(4096); self.e(W::I64Sub);
        self.e(W::MemorySize(0)); self.e(W::I64ExtendI32U); self.c64(16); self.e(W::I64Shl); self.c64(4096 + 16); self.e(W::I64Sub);
        self.e(W::I64GtU); self.e(W::BrIf(0));
        self.get(l_reg(RDI)); self.e(W::I32WrapI64); self.e(W::Call(F_TIME));
        self.e(W::LocalTee(l_d(0))); self.e(W::LocalGet(l_d(0))); self.e(W::F64Ne); self.e(W::BrIf(0));
        // Seconds, and the rest in nanoseconds rounded as Math.round does (clock.ts answerTime), at most 999999999.
        self.e(W::LocalGet(l_d(0))); self.e(W::F64Const(1000.0.into())); self.e(W::F64Div); self.e(W::F64Floor); self.e(W::LocalSet(l_d(1)));
        self.get(l_reg(RSI)); self.e(W::I32WrapI64); self.e(W::LocalGet(l_d(1))); self.e(W::I64TruncSatF64S); self.e(W::I64Store(mem(3)));
        self.get(l_reg(RSI)); self.e(W::I32WrapI64);
        self.e(W::LocalGet(l_d(0))); self.e(W::LocalGet(l_d(1))); self.e(W::F64Const(1000.0.into())); self.e(W::F64Mul); self.e(W::F64Sub);
        self.e(W::F64Const(1e6.into())); self.e(W::F64Mul); self.e(W::F64Const(0.5.into())); self.e(W::F64Add); self.e(W::F64Floor);
        self.e(W::F64Const(999_999_999.0.into())); self.e(W::F64Min); self.e(W::I64TruncSatF64S); self.e(W::I64Store(mem_at(8, 3)));
        self.c64(0); self.set(l_t(1));
        self.e(W::Br(1));
    }

    fn cpuid(&mut self) {
        // A plain core: SSE2 and SSE3, CMPXCHG16B and POPCNT; no SSSE3, SSE4 or AVX, so a
        // libc choosing its string routines by cpuid takes the SSE2 ones xlat translates.
        self.get(l_reg(RAX)); self.e(W::I32WrapI64); self.e(W::I32Eqz);
        self.e(W::If(BlockType::Empty));
        self.c64(1); self.set(l_reg(RAX));
        self.c64(0x756e_6547); self.set(l_reg(3)); // "Genu"
        self.c64(0x4965_6e69); self.set(l_reg(RDX)); // "ineI"
        self.c64(0x6c65_746e); self.set(l_reg(RCX)); // "ntel"
        self.e(W::Else);
        self.c64(0x0006_06a6); self.set(l_reg(RAX));
        self.c64(0); self.set(l_reg(3));
        self.c64((1 << 0) | (1 << 13) | (1 << 23)); self.set(l_reg(RCX));
        self.c64((1 << 0) | (1 << 4) | (1 << 8) | (1 << 15) | (1 << 23) | (1 << 25) | (1 << 26)); self.set(l_reg(RDX));
        self.e(W::End);
    }

    fn instruction(&mut self, i: &Instruction, need: bool) {
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
            Cwd => { self.read_reg(Register::AX); self.sign_extend(2); self.c64(16); self.e(W::I64ShrS); self.write_reg(Register::DX) }
            Cdq => { self.read_reg(Register::EAX); self.sign_extend(4); self.c64(32); self.e(W::I64ShrS); self.write_reg(Register::EDX) }
            Cqo => { self.get(l_reg(RAX)); self.c64(63); self.e(W::I64ShrS); self.set(l_reg(RDX)); true }
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
                    self.get(L_FA); self.get(L_FB); self.e(W::I64Add); self.mask_to(size); self.set(L_FR);
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
                    self.get(L_FA); self.get(L_FB); self.e(W::I64Sub); self.mask_to(size); self.set(L_FR);
                    self.defer(Flags::Sub(size));
                    self.get(L_FA); self.get(L_FB); self.e(W::I64Eq);
                    self.e(W::If(BlockType::Empty));
                    self.depth += 1;
                    let ok = self.read(i, 1, size) && { self.set(l_t(1)); self.write(i, 0, size, l_t(1)) };
                    self.e(W::Else);
                    self.get(L_FB); self.write_reg(acc);
                    self.e(W::End);
                    self.depth -= 1;
                    ok
                }
            }
            Bswap => {
                let size = Self::size(i, 0);
                self.read(i, 0, size) && {
                    self.set(l_t(1)); self.c64(0); self.set(l_t(2));
                    for k in 0..size as i64 {
                        self.get(l_t(1)); self.c64(k * 8); self.e(W::I64ShrU); self.c64(0xff); self.e(W::I64And);
                        self.c64((size as i64 - 1 - k) * 8); self.e(W::I64Shl);
                        self.get(l_t(2)); self.e(W::I64Or); self.set(l_t(2));
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
                self.condition(i.condition_code()); self.e(W::I64ExtendI32U); self.set(l_t(1));
                self.write(i, 0, 1, l_t(1))
            }
            Cmovo | Cmovno | Cmovb | Cmovae | Cmove | Cmovne | Cmovbe | Cmova | Cmovs | Cmovns | Cmovp | Cmovnp
            | Cmovl | Cmovge | Cmovle | Cmovg => {
                // A 32-bit cmov zero-extends even when the condition is false.
                let size = Self::size(i, 0);
                self.read(i, 1, size) && { self.read(i, 0, size) } && {
                    self.condition(i.condition_code());
                    self.e(W::Select); self.set(l_t(1));
                    self.write(i, 0, size, l_t(1))
                }
            }
            Syscall => {
                self.save();
                self.e(W::Block(BlockType::Empty));
                self.e(W::Block(BlockType::Empty));
                self.clock_gettime();
                self.e(W::End);
                // The last argument is where execution resumes; a forked
                // child starts there.
                for r in [RAX, RDI, RSI, RDX, 10, 8, 9] { self.get(l_reg(r)); }
                self.c64(i.next_ip() as i64);
                self.e(W::Call(F_SYSCALL));
                self.set(l_t(1));
                self.e(W::End);
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
                        fx.flag(f); fx.e(W::I64ExtendI32U);
                        if bit > 0 { fx.c64(bit); fx.e(W::I64Shl); }
                        fx.e(W::I64Or);
                    }
                    if let Flags::Add(_) | Flags::Sub(_) | Flags::Inc(_) | Flags::Dec(_) = fx.flags {
                        fx.get(L_FA); fx.get(L_FB); fx.e(W::I64Xor); fx.fr(); fx.e(W::I64Xor);
                        fx.c64(0x10); fx.e(W::I64And); fx.e(W::I64Or);
                    }
                    true
                })
            }
            // The flags back from the stack. DF is followed in the code as it is written (std, cld); a popped DF set
            // is a direction this translation does not follow, so it traps rather than copy the wrong way.
            Popfq => {
                self.pop_value(l_t(1));
                for (l, bit) in [(L_CF, 0), (L_PF, 2), (L_ZF, 6), (L_SF, 7), (L_OF, 11)] {
                    self.get(l_t(1)); if bit > 0 { self.c64(bit); self.e(W::I64ShrU); }
                    self.c64(1); self.e(W::I64And); self.e(W::I32WrapI64); self.set(l);
                }
                self.set_flags(Flags::Held);
                self.backward = false;
                self.get(l_t(1)); self.c64(0x400); self.e(W::I64And); self.e(W::I64Eqz); self.e(W::I32Eqz);
                self.e(W::If(BlockType::Empty));
                self.c64(i.ip() as i64); self.c32(TRAP_UNSUPPORTED); self.e(W::Call(F_TRAP)); self.e(W::Unreachable);
                self.e(W::End);
                true
            }
            Clc | Stc | Cmc => {
                // CF set, cleared or flipped; the other flags as they were (held first if a producer defers them).
                self.hold_flags();
                match i.mnemonic() { Clc => self.c32(0), Stc => self.c32(1), _ => { self.get(L_CF); self.c32(1); self.e(W::I32Xor); } }
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
                    self.c64(0xffc0); self.e(W::I64And); self.c64(0x1f80); self.e(W::I64Ne);
                    self.e(W::If(BlockType::Empty));
                    self.c64(i.ip() as i64); self.c32(TRAP_UNSUPPORTED); self.e(W::Call(F_TRAP)); self.e(W::Unreachable);
                    self.e(W::End);
                    true
                }
            }
            Cpuid => { self.cpuid(); true }
            Rdtsc => {
                self.e(W::Call(F_CLOCK)); self.set(l_t(1));
                self.get(l_t(1)); self.zext32(); self.set(l_reg(RAX));
                self.get(l_t(1)); self.c64(32); self.e(W::I64ShrU); self.set(l_reg(RDX));
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
    fn xread(&mut self, i: &Instruction, n: u32, bytes: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match xmm(i.op_register(n)) {
                Some(x) => { self.get(l_x(x)); true }
                None => false,
            },
            OpKind::Memory => {
                self.address(i);
                match bytes {
                    16 => self.e(W::V128Load(mem(0))),
                    8 => self.e(W::V128Load64Zero(mem(0))),
                    4 => self.e(W::V128Load32Zero(mem(0))),
                    _ => return false,
                }
                true
            }
            _ => false,
        }
    }

    fn xwrite(&mut self, i: &Instruction, n: u32, bytes: u32, from: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match xmm(i.op_register(n)) {
                Some(x) => { self.get(from); self.set(l_x(x)); true }
                None => false,
            },
            OpKind::Memory => {
                self.address(i);
                self.get(from);
                match bytes {
                    16 => self.e(W::V128Store(mem(0))),
                    8 => self.e(W::V128Store64Lane { memarg: mem(0), lane: 0 }),
                    4 => self.e(W::V128Store32Lane { memarg: mem(0), lane: 0 }),
                    _ => return false,
                }
                true
            }
            _ => false,
        }
    }

    /// Scalar SSE: lane 0 of the destination is replaced, the rest is kept.
    fn scalar(&mut self, i: &Instruction) -> Option<bool> {
        use Mnemonic::*;
        let m = i.mnemonic();
        let double = matches!(m, Addsd | Subsd | Mulsd | Divsd | Sqrtsd | Minsd | Maxsd | Movsd | Ucomisd | Comisd
            | Cvtsd2ss | Cvttsd2si | Cvtsd2si | Cvtsi2sd | Cmpsd);
        let bytes = if double { 8 } else { 4 };
        let (extract, replace) = if double { (W::F64x2ExtractLane(0), W::F64x2ReplaceLane(0)) } else { (W::F32x4ExtractLane(0), W::F32x4ReplaceLane(0)) };
        let arith = match m {
            Addsd => Some(W::F64Add), Subsd => Some(W::F64Sub), Mulsd => Some(W::F64Mul), Divsd => Some(W::F64Div),
            Addss => Some(W::F32Add), Subss => Some(W::F32Sub), Mulss => Some(W::F32Mul), Divss => Some(W::F32Div),
            _ => None,
        };
        let done = |fx: &mut Self| { fx.set(l_v(0)); fx.xwrite(i, 0, 16, l_v(0)) };
        Some(match m {
            _ if arith.is_some() => {
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.get(l_v(1)); self.get(l_v(1)); self.e(extract.clone());
                    self.xread(i, 1, bytes) } && { self.e(extract); self.e(arith.unwrap()); self.e(replace); done(self) }
            }
            Sqrtsd | Sqrtss => {
                self.xread(i, 0, 16) && { self.xread(i, 1, bytes) } && {
                    self.e(extract); self.e(if double { W::F64Sqrt } else { W::F32Sqrt }); self.e(replace); done(self)
                }
            }
            Minsd | Maxsd | Minss | Maxss => {
                // x86: if either is NaN or both zero, the second operand wins.
                let lt = matches!(m, Minsd | Minss);
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, bytes) } && {
                    self.set(l_v(0));
                    self.get(l_v(1));
                    self.get(l_v(1)); self.e(extract.clone());
                    self.get(l_v(0)); self.e(extract.clone());
                    self.get(l_v(1)); self.e(extract.clone());
                    self.get(l_v(0)); self.e(extract.clone());
                    self.e(match (double, lt) { (true, true) => W::F64Lt, (true, false) => W::F64Gt, (false, true) => W::F32Lt, _ => W::F32Gt });
                    self.e(W::Select);
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
                    if size == 4 { self.e(W::I32WrapI64); self.e(if double { W::F64ConvertI32S } else { W::F32ConvertI32S }); }
                    else { self.e(if double { W::F64ConvertI64S } else { W::F32ConvertI64S }); }
                    self.e(replace); done(self)
                }
            }
            Cvtss2sd | Cvtsd2ss => {
                self.xread(i, 0, 16) && { self.xread(i, 1, if m == Cvtss2sd { 4 } else { 8 }) } && {
                    if m == Cvtss2sd { self.e(W::F32x4ExtractLane(0)); self.e(W::F64PromoteF32); self.e(W::F64x2ReplaceLane(0)); }
                    else { self.e(W::F64x2ExtractLane(0)); self.e(W::F32DemoteF64); self.e(W::F32x4ReplaceLane(0)); }
                    done(self)
                }
            }
            Cvttsd2si | Cvtsd2si | Cvttss2si | Cvtss2si => {
                // Out of range and NaN give the "integer indefinite" value.
                let size = Self::size(i, 0);
                let round = matches!(m, Cvtsd2si | Cvtss2si);
                self.xread(i, 1, bytes) && {
                    self.e(extract);
                    if !double { self.e(W::F64PromoteF32); }
                    if round { self.e(W::F64Nearest); }
                    self.e(W::LocalSet(l_d(0)));
                    let limit = if size == 8 { (1u64 << 63) as f64 } else { 2147483648.0 };
                    self.e(W::LocalGet(l_d(0)));
                    self.e(if size == 8 { W::I64TruncSatF64S } else { W::I32TruncSatF64S });
                    if size != 8 { self.e(W::I64ExtendI32U); }
                    self.c64(if size == 8 { i64::MIN } else { 0x8000_0000 });
                    // in range: -limit <= v < limit (false for NaN)
                    self.get(l_d(0)); self.e(W::F64Const(limit.into())); self.e(W::F64Lt);
                    self.get(l_d(0)); self.e(W::F64Const((-limit).into())); self.e(W::F64Ge);
                    self.e(W::I32And);
                    self.e(W::Select);
                    self.write_reg(i.op0_register())
                }
            }
            Cmpsd | Cmpss if i.op_count() == 3 => {
                // Predicate mask in lane 0: all ones when true.
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.get(l_v(1)); self.e(extract.clone());
                    if !double { self.e(W::F64PromoteF32); } self.set(l_d(0)); self.xread(i, 1, bytes) } && {
                    self.e(extract); if !double { self.e(W::F64PromoteF32); } self.set(l_d(1));
                    self.predicate(i.immediate8());
                    self.get(l_v(1));
                    if double {
                        self.c64(-1); self.c64(0); self.get(l_u(0)); self.e(W::Select);
                        self.e(W::I64x2ReplaceLane(0));
                    } else {
                        self.c32(-1); self.c32(0); self.get(l_u(0)); self.e(W::Select);
                        self.e(W::I32x4ReplaceLane(0));
                    }
                    done(self)
                }
            }
            Ucomisd | Comisd | Ucomiss | Comiss => {
                self.xread(i, 0, 16) && { self.e(extract.clone()); if !double { self.e(W::F64PromoteF32); } self.e(W::LocalSet(l_d(0)));
                    self.xread(i, 1, bytes) } && {
                    self.e(extract); if !double { self.e(W::F64PromoteF32); } self.e(W::LocalSet(l_d(1)));
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
    fn predicate(&mut self, imm: u8) {
        let unordered = |fx: &mut Self| {
            fx.get(l_d(0)); fx.get(l_d(0)); fx.e(W::F64Ne); fx.get(l_d(1)); fx.get(l_d(1)); fx.e(W::F64Ne); fx.e(W::I32Or);
        };
        let pair = |fx: &mut Self, op: I| { fx.get(l_d(0)); fx.get(l_d(1)); fx.e(op); };
        match imm & 7 {
            0 => pair(self, W::F64Eq),
            1 => pair(self, W::F64Lt),
            2 => pair(self, W::F64Le),
            3 => unordered(self),
            4 => pair(self, W::F64Ne),
            5 => { pair(self, W::F64Lt); self.e(W::I32Eqz); }
            6 => { pair(self, W::F64Le); self.e(W::I32Eqz); }
            _ => { unordered(self); self.e(W::I32Eqz); }
        }
        self.set(l_u(0));
    }

    /// ucomisd/fucomi flags from l_d(0) against l_d(1):
    /// unordered sets ZF, PF and CF; less sets CF; equal sets ZF.
    fn compare_flags(&mut self) {
        self.get(l_d(0)); self.get(l_d(0)); self.e(W::F64Ne); self.get(l_d(1)); self.get(l_d(1)); self.e(W::F64Ne); self.e(W::I32Or);
        self.set(L_PF);
        self.get(l_d(0)); self.get(l_d(1)); self.e(W::F64Eq); self.get(L_PF); self.e(W::I32Or); self.set(L_ZF);
        self.get(l_d(0)); self.get(l_d(1)); self.e(W::F64Lt); self.get(L_PF); self.e(W::I32Or); self.set(L_CF);
    }

    fn vector(&mut self, i: &Instruction) -> bool {
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
        let binary = |fx: &mut Self, op: I| -> bool {
            fx.xread(i, 0, 16) && fx.xread(i, 1, 16) && { fx.e(op); fx.set(l_v(0)); fx.xwrite(i, 0, 16, l_v(0)) }
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
                    if bytes == 8 { self.e(W::I64x2Splat); self.c64(0); self.e(W::I64x2ReplaceLane(1)); }
                    else {
                        self.e(W::I32WrapI64); self.e(W::I32x4Splat);
                        self.c32(0); self.e(W::I32x4ReplaceLane(1));
                        self.e(W::I64x2ExtractLane(0)); self.zext32();
                        self.e(W::I64x2Splat); self.c64(0); self.e(W::I64x2ReplaceLane(1));
                    }
                    self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else if is_x1 && !is_x0 && i.op0_kind() == OpKind::Register {
                    self.xread(i, 1, 16);
                    self.e(W::I64x2ExtractLane(0));
                    if bytes == 4 { self.zext32(); }
                    self.write_reg(i.op0_register())
                } else if is_x0 && i.op1_kind() == OpKind::Memory {
                    self.xread(i, 1, bytes) && { self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) }
                } else if is_x1 && i.op0_kind() == OpKind::Memory {
                    self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, bytes, l_v(0)) }
                } else if is_x0 && is_x1 {
                    // movq xmm, xmm keeps the low qword and zeroes the high one.
                    self.xread(i, 1, 16); self.e(W::I64x2ExtractLane(0)); self.e(W::I64x2Splat);
                    self.c64(0); self.e(W::I64x2ReplaceLane(1)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else { false }
            }
            // Half moves: one qword of an xmm register from or to memory, the other kept.
            Movhps | Movhpd | Movlps | Movlpd => {
                let lane = if matches!(m, Movhps | Movhpd) { 1 } else { 0 };
                if is_x0 && i.op1_kind() == OpKind::Memory {
                    self.xread(i, 0, 16);
                    self.address(i); self.e(W::I64Load(mem(0)));
                    self.e(W::I64x2ReplaceLane(lane)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else if is_x1 && i.op0_kind() == OpKind::Memory {
                    self.address(i);
                    self.xread(i, 1, 16); self.e(W::I64x2ExtractLane(lane));
                    self.e(W::I64Store(mem(0)));
                    true
                } else { false }
            }
            // Between registers: movhlps puts the source's high qword low, movlhps its low qword high.
            Movhlps | Movlhps if is_x0 && is_x1 => {
                let (from, to) = if m == Movhlps { (1, 0) } else { (0, 1) };
                self.xread(i, 0, 16);
                self.xread(i, 1, 16); self.e(W::I64x2ExtractLane(from));
                self.e(W::I64x2ReplaceLane(to)); self.set(l_v(0));
                self.xwrite(i, 0, 16, l_v(0))
            }
            Pxor | Xorps | Xorpd => {
                if is_x1 && i.op0_register() == i.op1_register() {
                    self.e(W::V128Const(0)); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                } else { binary(self, W::V128Xor) }
            }
            Por | Orps | Orpd => binary(self, W::V128Or),
            Pand | Andps | Andpd => binary(self, W::V128And),
            Pandn | Andnps | Andnpd => {
                self.xread(i, 1, 16) && self.xread(i, 0, 16) && {
                    self.e(W::V128AndNot); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Paddb => binary(self, W::I8x16Add), Paddw => binary(self, W::I16x8Add),
            Paddd => binary(self, W::I32x4Add), Paddq => binary(self, W::I64x2Add),
            Psubb => binary(self, W::I8x16Sub), Psubw => binary(self, W::I16x8Sub),
            Psubd => binary(self, W::I32x4Sub), Psubq => binary(self, W::I64x2Sub),
            Pcmpeqb => binary(self, W::I8x16Eq), Pcmpeqw => binary(self, W::I16x8Eq),
            Pcmpeqd => binary(self, W::I32x4Eq), Pcmpeqq => binary(self, W::I64x2Eq),
            Pcmpgtb => binary(self, W::I8x16GtS), Pcmpgtw => binary(self, W::I16x8GtS),
            Pcmpgtd => binary(self, W::I32x4GtS), Pcmpgtq => binary(self, W::I64x2GtS),
            Addpd => binary(self, W::F64x2Add), Subpd => binary(self, W::F64x2Sub),
            Mulpd => binary(self, W::F64x2Mul), Divpd => binary(self, W::F64x2Div),
            Addps => binary(self, W::F32x4Add), Subps => binary(self, W::F32x4Sub),
            Mulps => binary(self, W::F32x4Mul), Divps => binary(self, W::F32x4Div),
            Unpcklpd => binary(self, W::I8x16Shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23])),
            Unpckhpd => binary(self, W::I8x16Shuffle([8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31])),
            // Packs narrow with saturation: the destination's lanes low, the source's high.
            Packuswb => binary(self, W::I8x16NarrowI16x8U), Packsswb => binary(self, W::I8x16NarrowI16x8S),
            Packssdw => binary(self, W::I16x8NarrowI32x4S), Packusdw => binary(self, W::I16x8NarrowI32x4U),
            Paddusb => binary(self, W::I8x16AddSatU), Paddusw => binary(self, W::I16x8AddSatU),
            Paddsb => binary(self, W::I8x16AddSatS), Paddsw => binary(self, W::I16x8AddSatS),
            Psubusb => binary(self, W::I8x16SubSatU), Psubusw => binary(self, W::I16x8SubSatU),
            Psubsb => binary(self, W::I8x16SubSatS), Psubsw => binary(self, W::I16x8SubSatS),
            Pavgb => binary(self, W::I8x16AvgrU), Pavgw => binary(self, W::I16x8AvgrU),
            Pmullw => binary(self, W::I16x8Mul), Pmulld => binary(self, W::I32x4Mul),
            Pminub => binary(self, W::I8x16MinU), Pmaxub => binary(self, W::I8x16MaxU),
            Pminsw => binary(self, W::I16x8MinS), Pmaxsw => binary(self, W::I16x8MaxS),
            Pminud => binary(self, W::I32x4MinU), Pmaxud => binary(self, W::I32x4MaxU),
            Pminsd => binary(self, W::I32x4MinS), Pmaxsd => binary(self, W::I32x4MaxS),
            Punpcklbw => binary(self, W::I8x16Shuffle([0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23])),
            Punpckhbw => binary(self, W::I8x16Shuffle([8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31])),
            Punpcklwd => binary(self, W::I8x16Shuffle([0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23])),
            Punpckhwd => binary(self, W::I8x16Shuffle([8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31])),
            Punpckldq => binary(self, W::I8x16Shuffle([0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23])),
            Punpckhdq => binary(self, W::I8x16Shuffle([8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31])),
            Punpcklqdq => binary(self, W::I8x16Shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23])),
            Punpckhqdq => binary(self, W::I8x16Shuffle([8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31])),
            Pmovmskb => {
                self.xread(i, 1, 16) && { self.e(W::I8x16Bitmask); self.e(W::I64ExtendI32U); self.write_reg(i.op0_register()) }
            }
            Movmskps => {
                self.xread(i, 1, 16) && { self.e(W::I32x4Bitmask); self.e(W::I64ExtendI32U); self.write_reg(i.op0_register()) }
            }
            Movmskpd => {
                self.xread(i, 1, 16) && { self.e(W::I64x2Bitmask); self.e(W::I64ExtendI32U); self.write_reg(i.op0_register()) }
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
                    self.get(l_v(1)); self.get(l_v(1)); self.e(W::I8x16Shuffle(lanes)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                }
            }
            // Insert a byte/word/dword/qword from a register or memory into one lane.
            Pinsrb | Pinsrw | Pinsrd | Pinsrq if is_x0 => {
                let lane = i.immediate8();
                let (size, op) = match m {
                    Pinsrb => (1, W::I8x16ReplaceLane(lane & 15)),
                    Pinsrw => (2, W::I16x8ReplaceLane(lane & 7)),
                    Pinsrd => (4, W::I32x4ReplaceLane(lane & 3)),
                    _ => (8, W::I64x2ReplaceLane(lane & 1)),
                };
                self.xread(i, 0, 16) && self.read(i, 1, size) && {
                    if size < 8 { self.e(W::I32WrapI64); }
                    self.e(op); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            // Take one lane out, zero-extended, to a register or memory.
            Pextrb | Pextrw | Pextrd | Pextrq if is_x1 => {
                let lane = i.immediate8();
                self.xread(i, 1, 16) && {
                    let size = match m {
                        Pextrb => { self.e(W::I8x16ExtractLaneU(lane & 15)); self.e(W::I64ExtendI32U); 1 }
                        Pextrw => { self.e(W::I16x8ExtractLaneU(lane & 7)); self.e(W::I64ExtendI32U); 2 }
                        Pextrd => { self.e(W::I32x4ExtractLane(lane & 3)); self.e(W::I64ExtendI32U); 4 }
                        _ => { self.e(W::I64x2ExtractLane(lane & 1)); 8 }
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
                binary(self, W::I8x16Shuffle(lanes))
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
                    self.get(l_v(1)); self.get(l_v(1)); self.e(W::I8x16Shuffle(lanes)); self.set(l_v(0));
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
                    self.get(l_v(1)); self.e(W::V128Const(0)); self.e(W::I8x16Shuffle(lanes)); self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Psllw | Pslld | Psllq | Psrlw | Psrld | Psrlq | Psraw | Psrad if i.op1_kind() == OpKind::Immediate8 => {
                let n = i.immediate8() as i32;
                let (op, width) = match m {
                    Psllw => (W::I16x8Shl, 16), Pslld => (W::I32x4Shl, 32), Psllq => (W::I64x2Shl, 64),
                    Psrlw => (W::I16x8ShrU, 16), Psrld => (W::I32x4ShrU, 32), Psrlq => (W::I64x2ShrU, 64),
                    Psraw => (W::I16x8ShrS, 16), _ => (W::I32x4ShrS, 32),
                };
                self.xread(i, 0, 16) && {
                    if n >= width && !matches!(m, Psraw | Psrad) {
                        self.e(W::Drop); self.e(W::V128Const(0));
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
                    Psllw => (W::I16x8Shl, 16), Pslld => (W::I32x4Shl, 32), Psllq => (W::I64x2Shl, 64),
                    Psrlw => (W::I16x8ShrU, 16), Psrld => (W::I32x4ShrU, 32), Psrlq => (W::I64x2ShrU, 64),
                    Psraw => (W::I16x8ShrS, 16), _ => (W::I32x4ShrS, 32),
                };
                let arith = matches!(m, Psraw | Psrad);
                self.xread(i, 1, 16) && {
                    self.e(W::I64x2ExtractLane(0)); self.set(l_t(0));
                    self.xread(i, 0, 16) && {
                        self.set(l_v(1));
                        self.get(l_t(0)); self.c64(width as i64); self.e(W::I64GeU);
                        self.e(W::If(BlockType::Result(ValType::V128)));
                        if arith { self.get(l_v(1)); self.c32(width - 1); self.e(op.clone()); } else { self.e(W::V128Const(0)); }
                        self.e(W::Else);
                        self.get(l_v(1)); self.get(l_t(0)); self.e(W::I32WrapI64); self.e(op);
                        self.e(W::End);
                        self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                    }
                }
            }
            // ---- The rest of SSE and SSE2: x86-64's baseline, every one of it ----
            Movntdq | Movntps | Movntpd | Movntdqa => self.xread(i, 1, 16) && { self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            Sqrtps => self.unary_v(i, 16, &[W::F32x4Sqrt]),
            Sqrtpd => self.unary_v(i, 16, &[W::F64x2Sqrt]),
            // Approximations x86 leaves to each CPU (within 1.5 * 2^-12): given exactly.
            Rcpps => self.xread(i, 1, 16) && { self.set(l_v(1)); self.e(W::V128Const(f32x4_splat(1.0))); self.get(l_v(1)); self.e(W::F32x4Div); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            Rsqrtps => self.xread(i, 1, 16) && { self.e(W::F32x4Sqrt); self.set(l_v(1)); self.e(W::V128Const(f32x4_splat(1.0))); self.get(l_v(1)); self.e(W::F32x4Div); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) },
            // max: a > b ? a : b, so the second operand wins on a NaN or two zeros, as wasm's pmax(b, a) does.
            Maxps | Minps | Maxpd | Minpd => {
                let op = match m { Maxps => W::F32x4PMax, Minps => W::F32x4PMin, Maxpd => W::F64x2PMax, _ => W::F64x2PMin };
                self.xread(i, 1, 16) && self.xread(i, 0, 16) && { self.e(op); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0)) }
            }
            Cmpps | Cmppd => {
                let ps = m == Cmpps;
                let (eq, lt, le, ne) = if ps { (W::F32x4Eq, W::F32x4Lt, W::F32x4Le, W::F32x4Ne) } else { (W::F64x2Eq, W::F64x2Lt, W::F64x2Le, W::F64x2Ne) };
                let pred = i.immediate8() & 7;
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                    self.set(l_v(0));
                    let unordered = |fx: &mut Self| { fx.get(l_v(1)); fx.get(l_v(1)); fx.e(ne.clone()); fx.get(l_v(0)); fx.get(l_v(0)); fx.e(ne.clone()); fx.e(W::V128Or); };
                    let pair = |fx: &mut Self, op: I| { fx.get(l_v(1)); fx.get(l_v(0)); fx.e(op); };
                    match pred {
                        0 => pair(self, eq.clone()), 1 => pair(self, lt.clone()), 2 => pair(self, le.clone()), 3 => unordered(self),
                        4 => pair(self, ne.clone()), 5 => { pair(self, lt.clone()); self.e(W::V128Not); }
                        6 => { pair(self, le.clone()); self.e(W::V128Not); } _ => { unordered(self); self.e(W::V128Not); }
                    }
                    self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Unpcklps => binary(self, W::I8x16Shuffle([0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23])),
            Unpckhps => binary(self, W::I8x16Shuffle([8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31])),
            Cvtdq2ps => self.unary_v(i, 16, &[W::F32x4ConvertI32x4S]),
            Cvtdq2pd => self.unary_v(i, 8, &[W::F64x2ConvertLowI32x4S]),
            Cvtps2pd => self.unary_v(i, 8, &[W::F64x2PromoteLowF32x4]),
            Cvtpd2ps => self.unary_v(i, 16, &[W::F32x4DemoteF64x2Zero]),
            // To integers: a lane out of range (or NaN) is the "integer indefinite" 0x80000000, where wasm saturates.
            Cvttps2dq | Cvtps2dq => self.xread(i, 1, 16) && {
                if m == Cvtps2dq { self.e(W::F32x4Nearest); }
                self.set(l_v(1));
                self.get(l_v(1)); self.e(W::I32x4TruncSatF32x4S);
                self.e(W::V128Const(i32x4_splat(i32::MIN)));
                self.get(l_v(1)); self.e(W::V128Const(f32x4_splat(2147483648.0))); self.e(W::F32x4Lt);
                self.get(l_v(1)); self.e(W::V128Const(f32x4_splat(-2147483648.0))); self.e(W::F32x4Ge);
                self.e(W::V128And);
                self.e(W::V128Bitselect); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            Cvttpd2dq | Cvtpd2dq => self.xread(i, 1, 16) && {
                if m == Cvtpd2dq { self.e(W::F64x2Nearest); }
                self.set(l_v(1));
                self.get(l_v(1)); self.e(W::I32x4TruncSatF64x2SZero);
                self.e(W::V128Const(i32x4_splat(i32::MIN)));
                // In range: -2^31 - 1 < v < 2^31 (those truncate into 32 bits); the two upper lanes are zero either way.
                self.get(l_v(1)); self.e(W::V128Const(f64x2_splat(2147483648.0))); self.e(W::F64x2Lt);
                self.get(l_v(1)); self.e(W::V128Const(f64x2_splat(-2147483649.0))); self.e(W::F64x2Gt);
                self.e(W::V128And);
                self.e(W::V128Const(-1));
                self.e(W::I8x16Shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]));
                self.e(W::V128Bitselect); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // Unsigned 32 x 32 -> 64 of each qword's low half.
            Pmuludq => self.xread(i, 0, 16) && { self.e(W::V128Const(LOW32)); self.e(W::V128And); self.xread(i, 1, 16) } && {
                self.e(W::V128Const(LOW32)); self.e(W::V128And); self.e(W::I64x2Mul); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // The high halves of the eight 16 x 16 products.
            Pmulhw | Pmulhuw => {
                let (lo, hi) = if m == Pmulhw { (W::I32x4ExtMulLowI16x8S, W::I32x4ExtMulHighI16x8S) } else { (W::I32x4ExtMulLowI16x8U, W::I32x4ExtMulHighI16x8U) };
                self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                    self.set(l_v(0));
                    self.get(l_v(1)); self.get(l_v(0)); self.e(lo);
                    self.get(l_v(1)); self.get(l_v(0)); self.e(hi);
                    self.e(W::I8x16Shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]));
                    self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
                }
            }
            Pmaddwd => binary(self, W::I32x4DotI16x8S),
            // Sums of the bytes' absolute differences, each half into its qword.
            Psadbw => self.xread(i, 0, 16) && { self.set(l_v(1)); self.xread(i, 1, 16) } && {
                self.set(l_v(0));
                self.get(l_v(1)); self.get(l_v(0)); self.e(W::I8x16MaxU);
                self.get(l_v(1)); self.get(l_v(0)); self.e(W::I8x16MinU);
                self.e(W::I8x16Sub);
                self.e(W::I16x8ExtAddPairwiseI8x16U); self.e(W::I32x4ExtAddPairwiseI16x8U);
                self.set(l_v(1));
                self.get(l_v(1)); self.e(W::V128Const(LOW32)); self.e(W::V128And);
                self.get(l_v(1)); self.c32(32); self.e(W::I64x2ShrU);
                self.e(W::I64x2Add); self.set(l_v(0)); self.xwrite(i, 0, 16, l_v(0))
            },
            // The bytes of the first whose mask byte (in the second) has its top bit, to [rdi] (operand 0, implied).
            Maskmovdqu => {
                self.get(l_reg(RDI)); self.e(W::I32WrapI64); self.set(l_u(1));
                self.xread(i, 1, 16) && {
                    self.get(l_u(1)); self.e(W::V128Load(mem(0)));
                    self.xread(i, 2, 16) && {
                        self.c32(7); self.e(W::I8x16ShrS);
                        self.e(W::V128Bitselect); self.set(l_v(0));
                        self.get(l_u(1)); self.get(l_v(0)); self.e(W::V128Store(mem(0)));
                        true
                    }
                }
            }
            _ => false,
        }
    }

    /// One operand in (operand 1, `bytes` of it from memory), `ops` on it, the result to operand 0.
    fn unary_v(&mut self, i: &Instruction, bytes: u32, ops: &[I]) -> bool {
        self.xread(i, 1, bytes) && {
            for op in ops { self.e(op.clone()); }
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

impl Fx<'_> {
    /// One x87 instruction: fpu(registers, op, memory size, st a, st b, operand, its top word) -> i64, called
    /// wasm to wasm, for the thread whose registers its instance names (G_X87). A memory operand read is loaded
    /// here and given as its bits (an 80-bit one's top word apart); one written is the call's value, stored here (an
    /// 80-bit one's top word asked for after, Op::High). The value is otherwise fcomi's flags (CF|ZF<<1|PF<<2), or
    /// the word fnstsw puts in AX.
    fn x87(&mut self, i: &Instruction) -> Option<bool> {
        let name = format!("{:?}", i.mnemonic()).to_ascii_lowercase();
        let name = if name == "wait" { "fwait".to_string() } else { name };
        let index = crate::x87::NAMES.iter().position(|&n| n == name)?;
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
        if stores { at = self.place(i); self.e(W::LocalTee(l_u(0))); }
        self.e(W::GlobalGet(G_X87));
        self.c32(index as i32);
        self.c32(if integer { -size } else { size });
        self.c32(a); self.c32(b);
        if memory && !stores {
            let at = self.place(i);
            if size == 10 {
                self.e(W::LocalTee(l_u(0)));
                self.load_at(8, at);
                self.e(W::LocalGet(l_u(0))); self.e(W::I32Load16U(mem_at(at + 8, 0)));
            } else {
                self.load_at(size as u8, at);
                self.c32(0);
            }
        } else {
            self.c64(0); self.c32(0);
        }
        self.e(W::Call(F_FPU));
        if stores {
            if size == 10 {
                self.store_at(8, at);
                self.e(W::LocalGet(l_u(0)));
                self.e(W::GlobalGet(G_X87));
                self.c32(crate::x87::Op::High as i32);
                self.c32(0); self.c32(0); self.c32(1); self.c64(0); self.c32(0);
                self.e(W::Call(F_FPU));
                self.store_at(2, at + 8);
            } else {
                self.store_at(size as u8, at);
            }
            return Some(true);
        }
        match name.as_str() {
            "fucomi" | "fcomi" | "fucomip" | "fcomip" => {
                self.e(W::I32WrapI64);
                self.set(l_u(0));
                for (bit, l) in [(0, L_CF), (1, L_ZF), (2, L_PF)] {
                    self.get(l_u(0)); if bit > 0 { self.c32(bit); self.e(W::I32ShrU); } self.c32(1); self.e(W::I32And); self.set(l);
                }
                self.c32(0); self.set(L_OF); self.c32(0); self.set(L_SF);
                self.set_flags(Flags::Held);
            }
            "fnstsw" => { self.write_reg(Register::AX); }
            _ => self.e(W::Drop),
        }
        Some(true)
    }
}

// ---- Flag liveness ----

// A system call keeps the flags here (r11 is not given them), so it neither reads nor writes them.
fn flags_read(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_read() & ALL_FLAGS } }
fn flags_written(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_modified() & ALL_FLAGS } }

/// Flag liveness over the whole program, in flat arrays: every function's blocks in turn (function f's from
/// `first[f]`), each with the flags it reads before it writes them and those it writes, where it goes on to (two
/// places at most: a block of its own function, an entry of another's, or other code, which is handed every flag),
/// and the flags live into it.
///
/// The post-link compiler gives states whose futures are equal one body, across functions too, so a compare can end
/// one function and the jump that reads it begin another: such an entry is handed what it reads, in G_FLAGS. Every
/// other entry reads none and costs nothing. Each entry starts reading nothing and grows to what its code reads (the
/// least fixed point), a function solved again only when an entry it goes on to grew.
pub(crate) struct Liveness {
    /// The program's entries (its `entries`, by address) and the flags each reads first.
    entries: Vec<u64>,
    reads: Vec<u8>,
    first: Vec<u32>,
    used: Vec<u8>,
    defined: Vec<u8>,
    /// A block of its own function, ENTRY and an entry, or NONE.
    to: Vec<[u32; 2]>,
    /// The flags handed to code outside that is no entry (every one), and INDIRECT where the block ends in an
    /// indirect jump: it keeps what its function's entries read, as it may land on any of them (a jump table's case).
    fixed: Vec<u8>,
    /// The entry a block is, or NONE.
    entry: Vec<u32>,
    live: Vec<u8>,
    /// What each function's entries read.
    cases: Vec<u8>,
}

const NONE: u32 = u32::MAX;
const ENTRY: u32 = 1 << 31;
const INDIRECT: u8 = 0x80;

impl Liveness {
    fn new(program: &Program) -> Liveness {
        let entries: Vec<u64> = program.entries.keys().copied().collect();
        let blocks: usize = program.functions.iter().map(|f| f.blocks.len()).sum();
        let mut l = Liveness {
            reads: vec![0; entries.len()], first: Vec::with_capacity(program.functions.len() + 1),
            used: Vec::with_capacity(blocks), defined: Vec::with_capacity(blocks), to: Vec::with_capacity(blocks),
            fixed: Vec::with_capacity(blocks), entry: vec![NONE; blocks], live: vec![0; blocks],
            cases: vec![0; program.functions.len()], entries,
        };
        for f in &program.functions {
            l.first.push(l.used.len() as u32);
            for b in &f.blocks {
                let (mut used, mut defined) = (0, 0);
                for i in &b.code {
                    used |= flags_read(i) & !defined;
                    defined |= flags_written(i);
                }
                let mut to = [NONE; 2];
                let mut fixed = if b.exit == Exit::IndirectJump { INDIRECT } else { 0 };
                let mut add = |a: u64| {
                    let t = match f.block_index(a) {
                        Some(k) => k as u32,
                        None => match l.entries.binary_search(&a) { Ok(e) => e as u32 | ENTRY, Err(_) => { fixed |= ALL_FLAGS as u8; return; } },
                    };
                    to[(to[0] != NONE) as usize] = t;
                };
                match b.exit {
                    Exit::Fall(a) | Exit::Jump(a) | Exit::TailJump(a) => add(a),
                    Exit::Branch { taken, fall } => { add(taken); add(fall); }
                    _ => {}
                }
                l.used.push(used as u8);
                l.defined.push(defined as u8);
                l.to.push(to);
                l.fixed.push(fixed);
            }
        }
        l.first.push(l.used.len() as u32);
        for (e, &(f, b)) in program.entries.values().enumerate() {
            l.entry[(l.first[f as usize] + b) as usize] = e as u32;
        }
        // The functions that go on to each entry, and each function once at first.
        let mut count = vec![0u32; l.entries.len() + 1];
        l.each_going(|e, _| count[e + 1] += 1);
        for e in 0..l.entries.len() { count[e + 1] += count[e]; }
        let mut by = vec![0u32; count[l.entries.len()] as usize];
        let mut at = count.clone();
        l.each_going(|e, f| { by[at[e] as usize] = f; at[e] += 1; });
        let mut queued = vec![true; program.functions.len()];
        let mut work: std::collections::VecDeque<u32> = (0..program.functions.len() as u32).collect();
        while let Some(f) = work.pop_front() {
            queued[f as usize] = false;
            l.solve(f as usize);
            for g in l.first[f as usize] as usize..l.first[f as usize + 1] as usize {
                let e = l.entry[g];
                if e == NONE || l.reads[e as usize] == l.live[g] { continue; }
                l.reads[e as usize] = l.live[g];
                for &d in &by[count[e as usize] as usize..count[e as usize + 1] as usize] {
                    if !queued[d as usize] { queued[d as usize] = true; work.push_back(d); }
                }
            }
        }
        l
    }

    /// Each entry another function goes on to, and that function.
    fn each_going(&self, mut on: impl FnMut(usize, u32)) {
        for f in 0..self.cases.len() {
            for g in self.first[f] as usize..self.first[f + 1] as usize {
                for t in self.to[g] {
                    if t != NONE && t & ENTRY != 0 { on((t & !ENTRY) as usize, f as u32); }
                }
            }
        }
    }

    /// The flags live into each block of function `f`, from nothing, as its entries now read.
    fn solve(&mut self, f: usize) {
        let (lo, hi) = (self.first[f] as usize, self.first[f + 1] as usize);
        self.live[lo..hi].fill(0);
        let mut cases = 0;
        loop {
            let mut changed = false;
            for g in (lo..hi).rev() {
                let (held, ext) = self.out(lo, g, cases);
                let new = self.used[g] | ((held | ext) & !self.defined[g]);
                if new != self.live[g] {
                    self.live[g] = new;
                    if self.entry[g] != NONE { cases |= new; }
                    changed = true;
                }
            }
            if !changed { break; }
        }
        self.cases[f] = cases;
    }

    /// The flags live out of block `g` (its function's from `lo`): into the blocks of its own function it goes on
    /// to, and handed to code outside.
    fn out(&self, lo: usize, g: usize, cases: u8) -> (u8, u8) {
        let mut held = if self.fixed[g] & INDIRECT != 0 { cases } else { 0 };
        let mut ext = self.fixed[g] & !INDIRECT;
        for t in self.to[g] {
            if t == NONE { continue; }
            if t & ENTRY != 0 { ext |= self.reads[(t & !ENTRY) as usize]; } else { held |= self.live[lo + t as usize]; }
        }
        (held, ext)
    }

    /// As `out`, for block `k` of function `f`, once solved.
    fn live_out(&self, f: u32, k: usize) -> (u32, u32) {
        let lo = self.first[f as usize] as usize;
        let (held, ext) = self.out(lo, lo + k, self.cases[f as usize]);
        (held as u32, ext as u32)
    }

    /// The flags code going on to `address`, outside its function, must hand over: those that entry reads first, or
    /// all of them where it is no entry (code found later).
    fn handed(&self, address: u64) -> u32 {
        self.entries.binary_search(&address).map_or(ALL_FLAGS, |e| self.reads[e] as u32)
    }

    /// Whether block `k` of function `f` is an entry of the program.
    fn is_entry(&self, f: u32, k: usize) -> bool { self.entry[self.first[f as usize] as usize + k] != NONE }
}

// ---- Functions ----

/// Whether `function` goes backward anywhere (a loop's head: Fx.goto, time_slice), within it or out to an address before
/// a block's (a run of the same function cut into runs).
pub(crate) fn has_loop(function: &Function) -> bool {
    function.blocks.iter().enumerate().any(|(k, b)| {
        let back = |a: u64| function.block_index(a).map_or(a <= b.start, |t| t <= k);
        match b.exit {
            Exit::Fall(a) | Exit::Jump(a) | Exit::Call { ret: a, .. } | Exit::IndirectCall { ret: a } => back(a),
            Exit::Branch { taken, fall } => back(taken) || back(fall),
            _ => false,
        }
    })
}

/// Whether each loop may be come to past its head other than by a jump straight to its label: as an entry (from the
/// dispatch), by a jump in from outside the loop, or by a jump back that is not a round of a loop it lies within.
/// Entries the dispatch starts at only to go on after the thread was taken back to the kernel there, or a longjmp: a
/// call's continuation, a loop's head (its time slice), a system call's or the instruction after it. A loop entered
/// past its head at such an entry is still made a wasm loop (enter_loop routes it), where one entered at others (a
/// switch's cases, a run's code reached from another run) goes round through the dispatch.
fn cold_entries(function: &Function) -> Vec<bool> {
    let blocks = &function.blocks;
    let mut cold = vec![false; blocks.len()];
    for (k, b) in blocks.iter().enumerate() {
        if let Exit::Call { ret, .. } | Exit::IndirectCall { ret } = b.exit {
            if let Some(t) = function.block_index(ret) { cold[t] = true; }
        }
        for t in goes_to(b).into_iter().flatten().filter_map(|a| function.block_index(a)) {
            if t <= k { cold[t] = true; }
        }
        if let Some(last) = b.code.last().filter(|i| resumes_after(i)) {
            if let Some(t) = function.block_index(last.next_ip()) { cold[t] = true; }
            if b.code.len() == 1 { cold[k] = true; }
        }
    }
    cold
}

fn entered_past_head(program: &Program, index: u32, function: &Function, loops: &[Loop], heads: &[Option<usize>]) -> Vec<bool> {
    let cold = cold_entries(function);
    let mut entered = vec![false; loops.len()];
    let mut mark = |t: usize, from: Option<usize>| {
        for (l, lp) in loops.iter().enumerate() {
            if t > lp.head && t <= lp.last && from.is_none_or(|k| k < lp.head || k > lp.last) { entered[l] = true; }
        }
    };
    for (k, b) in function.blocks.iter().enumerate() {
        if !cold[k] && program.entries.get(&b.start) == Some(&(index, k as u32)) { mark(k, None); }
        for t in goes_to(b).into_iter().flatten().filter_map(|a| function.block_index(a)) {
            if t > k { mark(t, Some(k)); continue; }
            let round = heads[t].is_some_and(|l| (loops[l].head..=loops[l].last).contains(&k));
            if !round { mark(t, None); }
        }
    }
    entered
}

/// Of `loops`, those made wasm loops: the ones no jump from outside enters past their head and no entry but a cold
/// one (cold_entries) lies in past their head (entered_past_head), each within the nearest such it lies within; with
/// the innermost each block lies within past its head. A wasm loop is entered at its top only: one entered at a cold
/// entry (a call's continuation after the thread was taken back to the kernel there, a loop within it) is entered at
/// its top with L_INTO saying where to go on (a local tested once a round, enter_loop). One entered at a switch's case
/// would be entered so at every case (asking at each round where, and more, made cc1 a sixth slower), and goes round
/// through the dispatch loop as before, as does one a jump enters past its head (discover.rs lays loops out so that
/// none from structured code is).
fn clean_loops(program: &Program, index: u32, function: &Function, mut loops: Vec<Loop>) -> (Vec<Loop>, Vec<Option<usize>>) {
    loop {
        let mut heads = vec![None; function.blocks.len()];
        for (l, lp) in loops.iter().enumerate() { heads[lp.head] = Some(l); }
        let entered = entered_past_head(program, index, function, &loops, &heads);
        if !entered.contains(&true) { break; }
        let mut now = vec![None; loops.len()];
        let mut kept = Vec::new();
        for (l, lp) in loops.iter().enumerate() {
            if entered[l] { continue; }
            let mut p = lp.parent;
            while let Some(q) = p { if !entered[q] { break; } p = loops[q].parent; }
            now[l] = Some(kept.len());
            kept.push(Loop { parent: p.and_then(|q| now[q]), ..*lp });
        }
        loops = kept;
    }
    let mut within = vec![None; function.blocks.len()];
    for (l, lp) in loops.iter().enumerate() {
        for w in &mut within[lp.head + 1..=lp.last] { *w = Some(l); }
    }
    (loops, within)
}

/// The function `target` starts and its summary, when it is one of this program's that never goes out (summary.rs).
fn quiet(program: &Program, summaries: &[Summary], target: u64) -> Option<(u32, Summary)> {
    let &(f, b) = program.entries.get(&target)?;
    let s = *summaries.get(f as usize)?;
    (b == 0 && program.functions[f as usize].start == target && !s.exits).then_some((f, s))
}

/// A function made lean when it may be: entered only at its start, with no indirect jump, it needs no dispatch loop
/// and br_table (a resume enters it again at its start: the loop round it does), and with no call no resume either,
/// unless a jump within it goes round the dispatch (one back to a block that heads no loop it is in), which only
/// making it tells; then it is made as any is. V8's first tier (where most of a compile's code runs) checks the stack
/// at each loop's head and keeps every local in memory across it, and zeroes the locals of a function that has more
/// than a few: a leaf made lean has neither.
fn lower_function(program: &Program, index: u32, base: u32, handed: &Liveness, summaries: &[Summary], options: Options, report: &mut Report) -> Vec<u8> {
    let function = &program.functions[index as usize];
    let entered_within = function.blocks.iter().any(|b| b.exit == Exit::IndirectJump)
        || function.blocks.iter().enumerate().skip(1).any(|(k, b)| program.entries.get(&b.start) == Some(&(index, k as u32)));
    if !entered_within {
        let mut lean = Report::default();
        if let Some(f) = lower_shaped(program, (index, base), handed, summaries, options, &mut lean, true) {
            report.blocks += lean.blocks;
            report.instructions += lean.instructions;
            for (m, k) in lean.unsupported { *report.unsupported.entry(m).or_default() += k; }
            return f;
        }
    }
    lower_shaped(program, (index, base), handed, summaries, options, report, false).unwrap_or_default()
}

/// lower_function's making of function `index` (numbered in the table from `base`), lean or not; None when made lean
/// and a jump within needed the dispatch loop.
fn lower_shaped(program: &Program, (index, base): (u32, u32), handed: &Liveness, summaries: &[Summary], options: Options, report: &mut Report, lean: bool) -> Option<Vec<u8>> {
    let function = &program.functions[index as usize];
    let cases = handed.cases[index as usize] as u32;
    let n = function.blocks.len() as u32;
    let handed_flags = handed;
    let mut fx = Fx { f: Vec::with_capacity(function.blocks.iter().map(|b| b.code.len()).sum::<usize>() * 24), syncs: Vec::new(), used: 0, ev: vec![Vec::new()], nest: 0, flags: Flags::Held, fr_pending: false, fused: None, slots: [0; LOCALS], kinds: Vec::new(), rsp_up: false, entry: Vec::new(), dispatch: !lean, dispatched: false, depth: 0, program, function, report, handed, backward: false, at: 0, budget: has_loop(function), summaries,
        loops: Vec::new(), within: Vec::new(), heads: Vec::new(), labels: Vec::new(), block_at: Vec::new(), loop_at: Vec::new() };
    let (loops, within) = clean_loops(program, index, function, loops_of(&function.blocks, |a| function.block_index(a)).0);
    fx.heads = vec![None; function.blocks.len()];
    for (l, lp) in loops.iter().enumerate() { fx.heads[lp.head] = Some(l); }
    fx.block_at = vec![None; function.blocks.len()];
    fx.loop_at = vec![None; loops.len()];
    (fx.loops, fx.within) = (loops, within);
    fx.entry = (0..function.blocks.len()).map(|k| handed.is_entry(index, k)).collect();

    // Everything the prologue depends on is known, so the function is made in order.
    // Only where it is read: past a call (the resume) or an indirect jump; a leaf pays nothing for it.
    let calls = function.blocks.iter().any(|b| matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }));
    if calls || function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) {
        fx.e(W::GlobalGet(RSP)); fx.c64(-1); fx.get(L_ENTRY); fx.e(W::I32Eqz); fx.e(W::Select); fx.set(L_SP0);
    }
    // Entered at L_ENTRY: from outside, or again from the resume below, as from outside.
    let resume = !lean || calls;
    if resume { fx.e(W::Loop(BlockType::Empty)); }
    if !lean { fx.get(L_ENTRY); fx.set(L_BLK); }
    fx.load();
    // What the entries handed flags read (almost always none).
    fx.load_flags(cases);
    if resume { fx.e(W::Block(BlockType::Empty)); }
    if !lean { fx.e(W::Loop(BlockType::Empty)); }
    // A label for each block within no loop past its head, the last block's outermost: each ends where its block's
    // code starts. Those within a loop open inside it (enter_loop).
    let outermost: Vec<usize> = (0..n as usize).rev().filter(|&b| fx.within[b].is_none()).collect();
    for b in outermost {
        fx.e(W::Block(BlockType::Empty));
        fx.open(Lab::Block(b));
    }
    fx.depth = fx.labels.len() as u32;
    // Each entry to its block's label; one within a loop past its head (a call's continuation in a loop, clean_loops)
    // to the head of the outermost loop it lies within, with L_INTO saying where to go on (enter_loop).
    let outermost_head = |fx: &Fx, b: usize| {
        let mut l = fx.within[b];
        let mut t = b;
        while let Some(w) = l { t = fx.loops[w].head; l = fx.loops[w].parent; }
        fx.to(fx.block_at[t].unwrap_or_default())
    };
    let into = (0..n as usize).any(|b| fx.entry[b] && fx.within[b].is_some());
    // Lean, the code goes straight on into block 0's. Else block 0 (a call's way in) is gone to first: a br_table of
    // n is a search of log n compares in V8's first tier.
    if !lean && into {
        let heads: Vec<u32> = (0..n as usize).map(|b| outermost_head(&fx, b)).collect();
        fx.e(W::Block(BlockType::Empty));
        // Inside that block: 1 deeper, and 0 is it (an entry within a loop).
        let targets: Vec<u32> = (0..n as usize).map(|b| if fx.within[b].is_some() { 0 } else { outermost_head(&fx, b) + 1 }).collect();
        fx.get(L_BLK); fx.e(W::I32Eqz); fx.e(W::BrIf(targets[0]));
        fx.get(L_BLK);
        fx.e(W::BrTable(Cow::Owned(targets), 0));
        fx.e(W::End);
        fx.get(L_BLK); fx.c32(1); fx.e(W::I32Add); fx.set(L_INTO);
        fx.get(L_BLK);
        fx.e(W::BrTable(Cow::Owned(heads), 0));
    } else if !lean {
        let targets: Vec<u32> = (0..n as usize).map(|b| outermost_head(&fx, b)).collect();
        fx.get(L_BLK); fx.e(W::I32Eqz); fx.e(W::BrIf(targets[0]));
        fx.get(L_BLK);
        fx.e(W::BrTable(Cow::Owned(targets), 0));
    }
    for (k, block) in function.blocks.iter().enumerate() {
        // Close block k's label so its code starts here, inside the labels of
        // the blocks after it and of the loops it lies within; a loop it heads
        // is gone round from here.
        fx.e(W::End);
        fx.close(Lab::Block(k));
        if let Some(l) = fx.heads[k] { fx.enter_loop(l); }
        fx.ev.push(Vec::with_capacity(block.code.len() * 6));
        fx.nest = 0;
        fx.depth = fx.labels.len() as u32;
        fx.set_flags(Flags::Held);
        fx.backward = false;
        fx.at = k;
        fx.report.blocks += 1;
        if options.trace {
            fx.c64(block.start as i64);
            fx.e(W::Call(F_TRACE));
        }
        let next = function.blocks.get(k + 1).map(|b| b.start);
        // An indirect jump may land on an entry of this function, whose flags stay in the locals.
        let (held, ext) = handed.live_out(index, k);
        let live_out = held | ext;
        // Flags needed after each instruction, from the end backward.
        let mut needed = vec![0u32; block.code.len()];
        let mut l = live_out;
        for (j, i) in block.code.iter().enumerate().rev() {
            needed[j] = l;
            l = (l & !flags_written(i)) | flags_read(i);
        }
        let last = block.code.len() - 1;
        for (j, i) in block.code.iter().enumerate() {
            fx.report.instructions += 1;
            if j == last && !matches!(crate::discover::flow(i), iced_x86::FlowControl::Next | iced_x86::FlowControl::Interrupt) {
                break;
            }
            if j == last && i.mnemonic() == Mnemonic::Int3 {
                break;
            }
            // A compare whose flags only the branch that ends the block reads is that branch's condition.
            if j + 1 == last && live_out == 0 && matches!(block.exit, Exit::Branch { .. }) && Fx::fusable(i, block.code[last].condition_code()) {
                fx.fused = Some(*i);
                continue;
            }
            fx.instruction(i, needed[j] != 0);
        }
        let term = block.code[last];
        // Flags for code outside are handed from the state as it is.
        if held != 0 && !matches!(block.exit, Exit::Branch { .. }) {
            fx.hold_flags();
        }
        match block.exit {
            Exit::Fall(a) | Exit::Jump(a) => fx.goto(a, next),
            Exit::TailJump(a) => fx.tail(a),
            Exit::Branch { taken, fall } => {
                fx.condition(term.condition_code());
                if held != 0 { fx.set(l_u(1)); fx.hold_flags(); fx.get(l_u(1)); }
                // A side going forward to a label open here is a br_if to it (not an if, a br and an end); where the
                // taken side is the next block, the condition turned round goes to the other.
                if let Some(d) = fx.forward(taken) {
                    fx.note(Ev::Edge);
                    fx.e(W::BrIf(d));
                    fx.goto(fall, next);
                } else if let Some(d) = fx.forward(fall).filter(|_| Some(taken) == next) {
                    fx.e(W::I32Eqz);
                    fx.note(Ev::Edge);
                    fx.e(W::BrIf(d));
                    fx.goto(taken, next);
                } else {
                    fx.e(W::If(BlockType::Empty));
                    fx.depth += 1;
                    fx.goto(taken, None);
                    fx.depth -= 1;
                    fx.e(W::End);
                    fx.goto(fall, next);
                }
            }
            Exit::IndirectJump => {
                fx.read(&term, 0, 8);
                fx.set(l_t(0));
                fx.get(l_t(0)); fx.e(W::Call(F_RESOLVE)); fx.set(l_t(1));
                // Found as this function's own (by the table's numbering, which a module made later starts at its base).
                fx.get(l_t(1)); fx.c64(32); fx.e(W::I64ShrU); fx.c64((base + index) as i64); fx.e(W::I64Eq);
                fx.note(Ev::Edge);
                fx.e(W::If(BlockType::Empty));
                fx.get(l_t(1)); fx.e(W::I32WrapI64); fx.set(L_BLK);
                fx.e(W::Br(fx.depth + 1));
                fx.e(W::End);
                fx.save();
                // Elsewhere, it is handed what this function's own cases read: up to the frames further out when rsp
                // is above where this one began (a longjmp; after_call), else to the dispatcher.
                fx.save_flags(cases);
                fx.get(l_reg(RSP)); fx.get(L_SP0); fx.e(W::I64GtU);
                fx.e(W::If(BlockType::Empty));
                fx.get(l_t(0)); fx.e(W::Return);
                fx.e(W::End);
                fx.get(l_t(0)); fx.e(W::ReturnCall(F_DISPATCH));
            }
            Exit::Call { target, ret } if quiet(program, fx.summaries, target).is_some() => {
                // To a function that never goes out (summary.rs): only what it may read or write is moved, and its
                // depth is not counted (it calls none that go out, and no more than QUIET_CHAIN deep).
                let (f, s) = quiet(program, fx.summaries, target).unwrap_or_default();
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.note_low();
                fx.sync_in(true, s.reads | s.writes);
                fx.c32(0); fx.e(W::Call(FIRST_GUEST + f));
                fx.set(l_t(0));
                fx.after_call_in(ret, next, s.writes);
            }
            Exit::Call { target, ret } => {
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.save();
                fx.enter_call(handed_flags.handed(target), |fx| fx.c64(target as i64));
                match program.entries.get(&target) {
                    Some(&(f, b)) => { fx.c32(b as i32); fx.e(W::Call(FIRST_GUEST + f)); }
                    None => { fx.c64(target as i64); fx.e(W::Call(F_DISPATCH)); }
                }
                fx.set(l_t(0));
                fx.leave_call();
                fx.after_call(ret, next);
            }
            Exit::IndirectCall { ret } => {
                // The target is read before the return address is pushed.
                fx.read(&term, 0, 8);
                fx.set(l_t(2));
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.save();
                fx.enter_call(ALL_FLAGS, |fx| fx.get(l_t(2)));
                fx.get(l_t(2)); fx.e(W::Call(F_DISPATCH));
                fx.set(l_t(0));
                fx.leave_call();
                fx.after_call(ret, next);
            }
            Exit::Return => {
                fx.pop_value(l_t(0));
                if term.op_count() == 1 {
                    fx.get(l_reg(RSP)); fx.c64(term.immediate16() as i64); fx.e(W::I64Add); fx.set(l_reg(RSP));
                }
                fx.save();
                fx.get(l_t(0)); fx.e(W::Return);
            }
            Exit::Trap => {
                fx.c64(term.ip() as i64);
                fx.c32(match term.mnemonic() { Mnemonic::Ud2 => TRAP_UD2, Mnemonic::Int3 => TRAP_INT3, Mnemonic::Hlt => TRAP_HLT, _ => TRAP_UNDECODED });
                fx.e(W::Call(F_TRAP));
                fx.e(W::Unreachable);
            }
        }
        // The loops this is the last block of end here, the innermost first.
        while let Some(&Lab::Loop(l)) = fx.labels.last() {
            if fx.loops[l].last != k { break; }
            fx.e(W::End);
            fx.close(Lab::Loop(l));
        }
    }
    if lean && fx.dispatched { return None; }
    if !resume {
        fx.e(W::Unreachable);
        fx.e(W::End);
        return Some(finish(program, index, fx));
    }
    // Leaving the last block falls out of the loop.
    if !lean { fx.e(W::End); }
    fx.e(W::Unreachable);
    fx.e(W::End);
    // The resume: a call came back to an address other than its own (after_call), in l_t(0). One of this function's
    // entries is entered again here, its registers and flags taken from their globals as from outside, so a longjmp
    // to a frame of this function's goes on in it; anything else goes up to the caller, at once when rsp is above
    // where this frame began (the code is a frame's further out).
    fx.e(W::GlobalGet(RSP)); fx.get(L_SP0); fx.e(W::I64GtU);
    fx.e(W::If(BlockType::Empty));
    fx.get(l_t(0)); fx.e(W::Return);
    fx.e(W::End);
    fx.get(l_t(0)); fx.e(W::Call(F_RESOLVE)); fx.set(l_t(1));
    if lean {
        // Entered only at its start: at that (block 0), nowhere else.
        fx.get(l_t(1)); fx.c64(((base + index) as i64) << 32); fx.e(W::I64Eq);
        fx.e(W::BrIf(0));
    } else {
        fx.get(l_t(1)); fx.c64(32); fx.e(W::I64ShrU); fx.c64((base + index) as i64); fx.e(W::I64Eq);
        fx.e(W::If(BlockType::Empty));
        fx.get(l_t(1)); fx.e(W::I32WrapI64); fx.set(L_ENTRY);
        fx.e(W::Br(1));
        fx.e(W::End);
    }
    fx.get(l_t(0)); fx.e(W::Return);
    fx.e(W::End);
    fx.e(W::Unreachable);
    fx.e(W::End);

    Some(finish(program, index, fx))
}

/// The locals, then the code with each sync put in: only the registers it
/// must move (sync_masks). One it never touches stays in its global, where
/// code it calls and the host find it.
fn finish(program: &Program, index: u32, mut fx: Fx) -> Vec<u8> {
    let masks = sync_masks(program, index, &fx.ev, &fx.syncs);
    // What the syncs move is touched by the code already (each register they may move, and the budget's local).
    if fx.budget { fx.slot(L_BUDGET); }
    let (used, budget, syncs, slots) = (fx.used, fx.budget, fx.syncs, fx.slots);
    let mut groups: Vec<(u32, ValType)> = Vec::new();
    for &k in &fx.kinds {
        match groups.last_mut() { Some((n, t)) if *t == k => *n += 1, _ => groups.push((1, k)) }
    }
    let code = std::mem::take(&mut fx.f);
    use crate::emit::uleb;
    let mut f = Vec::with_capacity(code.len() + 8 * syncs.len() + 2 * groups.len() + 8);
    uleb(&mut f, groups.len() as u64);
    for (n, t) in groups { uleb(&mut f, n as u64); crate::emit::val_type(&mut f, t); }
    // A move: local.get, global.set (a save), or global.get, local.set (a load).
    let pair = |f: &mut Vec<u8>, save: bool, local: u32, global: u32| {
        let (first, a, second, b) = if save { (0x20, local, 0x24, global) } else { (0x23, global, 0x21, local) };
        f.push(first); uleb(f, a as u64); f.push(second); uleb(f, b as u64);
    };
    let sync = |f: &mut Vec<u8>, save: bool, scope: u32, mask: u32| {
        for n in (0..32).filter(|n| used & mask & (1 << n) != 0) {
            let (local, global) = if n < 16 { (l_reg(n), n) } else { (l_x(n - 16), g_xmm(n - 16)) };
            pair(f, save, slots[local as usize], global);
        }
        // (A call to a function that never goes out leaves the budget alone: it has no loop, and counts no call.)
        if budget && scope == ALL { pair(f, save, slots[L_BUDGET as usize], G_BUDGET); }
    };
    let mut at = 0;
    for ((offset, save, scope), mask) in syncs.into_iter().zip(masks) {
        f.extend_from_slice(&code[at..offset]);
        sync(&mut f, save, scope, mask);
        at = offset;
    }
    f.extend_from_slice(&code[at..]);
    f
}

/// Which registers each sync must move. Between syncs a register lives in
/// its local; its global is what code outside (callees, the host) reads and
/// writes. A save stores only the registers written since they were last
/// stored or loaded on some path here (the others' globals hold their values
/// already), and a load takes in only those read before they are written
/// again (the others' locals are never read stale). The saves' own stores
/// count as reads, so a register a save may store is one a load took in;
/// and only a write that surely happens (not inside a conditional) ends a
/// register's life. Around every call this was most of a function's code.
fn sync_masks(program: &Program, index: u32, ev: &[Vec<Ev>], syncs: &[(usize, bool, u32)]) -> Vec<u32> {
    let function = &program.functions[index as usize];
    let n = function.blocks.len();
    let at = |a: u64| function.block_index(a);
    // Where the prologue's dispatch, and an indirect jump within, may go.
    let entries: Vec<usize> = (0..n).filter(|&k| k == 0 || program.entries.get(&function.blocks[k].start) == Some(&(index, k as u32))).collect();
    let succ: Vec<Vec<usize>> = function.blocks.iter().map(|b| match b.exit {
        Exit::Fall(a) | Exit::Jump(a) | Exit::Call { ret: a, .. } | Exit::IndirectCall { ret: a } => at(a).into_iter().collect(),
        Exit::Branch { taken, fall } => at(taken).into_iter().chain(at(fall)).collect(),
        Exit::IndirectJump => entries.clone(),
        Exit::TailJump(_) | Exit::Return | Exit::Trap => Vec::new(),
    }).collect();
    let mut mask = vec![0u32; syncs.len()];
    let edged: Vec<bool> = (0..n).map(|k| ev[k + 1].iter().any(|e| matches!(e, Ev::Edge))).collect();

    // Forward: written since the last sync on some path.
    let mut dirty = vec![0u32; n];
    loop {
        let mut changed = false;
        for k in 0..n {
            let mut d = dirty[k];
            let mut out = 0;
            for e in &ev[k + 1] {
                match *e {
                    Ev::Write(r, _) => d |= 1 << r,
                    Ev::Sync(m, top) if syncs[m].1 => { mask[m] |= d & syncs[m].2; if top { d &= !syncs[m].2; } }
                    Ev::Edge => out |= d,
                    _ => {}
                }
            }
            // Successors no goto was noted for (none should be) see the block's end.
            if !edged[k] { out |= d; }
            for &s in &succ[k] {
                if dirty[s] | out != dirty[s] { dirty[s] |= out; changed = true; }
            }
        }
        if !changed { break; }
    }

    // Backward: read before surely written again.
    let mut live = vec![0u32; n];
    loop {
        let mut changed = false;
        for k in (0..n).rev() {
            let after = succ[k].iter().fold(0, |acc, &s| acc | live[s]);
            let mut l = if edged[k] { 0 } else { after };
            for e in ev[k + 1].iter().rev() {
                match *e {
                    Ev::Read(r) => l |= 1 << r,
                    Ev::Write(r, true) => l &= !(1 << r),
                    Ev::Write(_, false) => {}
                    Ev::Sync(m, _) if syncs[m].1 => l |= mask[m],
                    Ev::Sync(m, top) => { mask[m] |= l & syncs[m].2; if top { l &= !syncs[m].2; } }
                    Ev::Edge => l |= after,
                }
            }
            if live[k] | l != live[k] { live[k] |= l; changed = true; }
        }
        if !changed { break; }
    }
    // The prologue takes in what any block it may start at reads.
    let start = entries.iter().fold(0, |acc, &k| acc | live[k]);
    for e in &ev[0] {
        if let Ev::Sync(m, _) = *e { if !syncs[m].1 { mask[m] |= start; } }
    }
    mask
}

/// Slots in the dispatcher's cache of where addresses were found (16 bytes
/// each, past the entry table). One gcc building hello dispatched 1.8
/// million times to code made later, each a call out to the host before.
const DISPATCH_CACHE: u64 = 1 << 14;

/// Helpers: 64x64 high products, entry resolution and the dispatcher.
/// `table` is where the sorted entry table sits in guest memory, `cache`
/// where the dispatcher keeps what it found (DISPATCH_CACHE slots).
fn helpers(code: &mut CodeSection, entries: u32, table: u64, cache: u64) {
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
    code.function(&f);

    // mulhs(a, b) = mulhu(a, b) - (a < 0 ? b : 0) - (b < 0 ? a : 0)
    let mut f = WasmFunction::new([]);
    for i in [
        W::LocalGet(0), W::LocalGet(1), W::Call(F_MULHU),
        W::LocalGet(1), W::I64Const(0), W::LocalGet(0), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::LocalGet(0), W::I64Const(0), W::LocalGet(1), W::I64Const(0), W::I64LtS, W::Select, W::I64Sub,
        W::End,
    ] { f.instruction(&i); }
    code.function(&f);

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
    code.function(&f);

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
    code.function(&f);

    // run(addr): follow returns that leave every translated frame.
    let mut f = WasmFunction::new([]);
    for i in [
        W::Loop(BlockType::Empty), W::LocalGet(0), W::Call(F_DISPATCH), W::LocalSet(0), W::Br(0), W::End, W::End,
    ] { f.instruction(&i); }
    code.function(&f);

}

/// Every function of `program`, lowered into `code` in order, as the table holds them from `base`. Each is lowered
/// on its own, so natively they share the cores; wasm has one thread and lowers in turn, each into the section as it
/// is made (a big program's functions are most of what the translator would otherwise hold at once).
fn lower_all(program: &Program, base: u32, options: Options, report: &mut Report, code: &mut CodeSection) {
    let handed = Liveness::new(program);
    let summaries = summarize(program);
    let n = program.functions.len();
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    // A few functions are not worth a thread.
    if threads == 1 || n < 64 {
        for f in 0..n { code.raw(&lower_function(program, f as u32, base, &handed, &summaries, options, report)); }
        return;
    }
    let size = n.div_ceil(threads);
    let parts: Vec<(Vec<Vec<u8>>, Report)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..n).step_by(size).map(|at| {
            let (handed, summaries) = (&handed, &summaries);
            scope.spawn(move || {
                let mut r = Report::default();
                let made = (at..(at + size).min(n)).map(|f| lower_function(program, f as u32, base, handed, summaries, options, &mut r)).collect();
                (made, r)
            })
        }).collect();
        workers.into_iter().map(|w| w.join().expect("a lowering thread panicked")).collect()
    });
    for (functions, r) in parts {
        for f in &functions { code.raw(f); }
        report.blocks += r.blocks;
        report.instructions += r.instructions;
        for (m, k) in r.unsupported { *report.unsupported.entry(m).or_default() += k; }
    }
}

/// A module of `head`, `code`, `image` and `tail` (sections, in that order), written once into room for all of it.
/// A big program's translation is nearly all its code and its own bytes; a module grown as it is written held them
/// a few times over at once, in a memory that only grows (and each time it grows, an engine may collect its whole
/// heap).
fn assemble(head: &[&dyn Section], code: &CodeSection, image: Option<&Image>, tail: &[&dyn Section]) -> Vec<u8> {
    let mut after = Vec::new();
    for s in tail { s.append_to(&mut after); }
    let mut wasm = Module::new().finish(); // the header
    for s in head { s.append_to(&mut wasm); }
    // Each section's id and two LEB128 u32s (its size, its count) at most, besides its contents.
    const FRAME: usize = 11;
    wasm.reserve_exact(FRAME + code.byte_len() + image.map_or(0, |i| FRAME + i.byte_len()) + after.len());
    code.append_to(&mut wasm);
    if let Some(i) = image { i.append_to(&mut wasm); }
    wasm.extend_from_slice(&after);
    wasm
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
/// from `base`, are in the `xlat.entries` custom section as (address,
/// function << 32 | block) pairs.
pub fn translate_more(program: &Program, base: u32, options: Options) -> Translation {
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

    let mut code = CodeSection::new();
    lower_all(program, base, options, &mut report, &mut code);

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
    let entries = CustomSection { name: Cow::Borrowed("xlat.entries"), data: Cow::Owned(table) };
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    let starts = CustomSection { name: Cow::Borrowed("xlat.starts"), data: Cow::Owned(starts) };

    let wasm = assemble(&[&types(), &imports, &functions, &tables, &exports, &elements], &code, None, &[&name_section, &entries, &starts]);
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

    let mut code = CodeSection::new();
    helpers(&mut code, entries as u32, table_base, cache);
    lower_all(program, 0, options, &mut report, &mut code);

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
    let facts = CustomSection { name: Cow::Borrowed("xlat.facts"), data: Cow::Owned(facts.into_bytes()) };
    let fpu = CustomSection { name: Cow::Borrowed("xlat.fpu"), data: Cow::Owned(crate::x87::NAMES.join(",").into_bytes()) };
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    let starts = CustomSection { name: Cow::Borrowed("xlat.starts"), data: Cow::Owned(starts) };

    let wasm = assemble(
        &[&types(), &imports, &functions, &tables, &globals, &exports, &elements], &code, Some(&image),
        &[&name_section, &facts, &fpu, &starts],
    );
    Translation { wasm, report }
}
