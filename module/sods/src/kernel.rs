//! The kernel: each function made a wasm function, straight into its bytes. Its blocks laid out loop by loop, each a
//! label the code before it breaks out to; a dispatch loop only where it may be entered within; each x86 instruction
//! decoded again and lowered by ops.rs on the kernel's Fx; registers in locals, moved through their globals only at
//! syncs, each moving no more than the dataflow through the function's blocks says it must; the bytes written onto the
//! module once the syncs are known.
//!
//! What it costs, an x86 instruction at a time: a decode (iced's, about 120 of the host's instructions), the operators
//! it lowers to written as their bytes, a note of each register it moves, and the flags needed after it. What making a
//! function needs is kept from one function to the next, so none allocates, and nothing is made twice.

use crate::facts::{has_loop, Liveness, Summary};
use crate::op::*;
use crate::ops::{Flags, Report, FLAG_BITS};
use crate::program::*;
use crate::elf::Elf;
use iced_x86::{Instruction, Mnemonic};


/// Imported functions (the host's, then in a module made later the first module's helpers), and where the guest's
/// functions start.
pub const F_SYSCALL: u32 = 0;
pub const F_TRAP: u32 = 1;
pub const F_DIV128: u32 = 2;
pub const F_CLOCK: u32 = 3;
pub const F_FPU: u32 = 4;
pub const F_TRACE: u32 = 5;
/// The host's answer for code not translated yet: the entry (function << 32 | block), or -1.
pub const F_MISS: u32 = 6;
/// A wall or steady clock's time in ms, as the host's kernel keeps it; NaN for any other clock.
pub const F_TIME: u32 = 7;
pub const F_MULHU: u32 = 8;
pub const F_MULHS: u32 = 9;
pub const F_RESOLVE: u32 = 10;
pub const F_DISPATCH: u32 = 11;
pub const FIRST_GUEST: u32 = 13;

/// Globals every module of a program shares: r0..r15, fs, x0..x15, then these.
pub const G_FS: u32 = 16;
pub const fn g_xmm(n: u32) -> u32 { 17 + n }
/// CF, ZF, SF, OF and PF as bits 0..4: what an entry that reads flags first is handed.
pub const G_FLAGS: u32 = 33;
/// Loops gone round and calls made before the thread goes back to the kernel (its time slice).
pub const G_BUDGET: u32 = 34;
/// Calls the thread is inside, in wasm frames: past DEPTH_LIMIT a call starts afresh from the kernel.
pub const G_DEPTH: u32 = 35;
pub const DEPTH_LIMIT: i32 = 400;
/// The least rsp has been (how deep the thread's stack has gone).
pub const G_LOW: u32 = 36;
/// The thread's x87 registers: their handle in the coprocessor (x87.rs).
pub const G_X87: u32 = 37;
pub const GLOBALS: u32 = 38;
/// A word below where anything may be mapped: nonzero when the kernel wants the thread to look in (a signal, another
/// thread's turn), read at each loop's head.
pub const INTERRUPT: u32 = 0x100;

/// Trap codes reported to the host with the guest address.
pub const TRAP_UNMAPPED_TARGET: i32 = 1;
pub const TRAP_UNDECODED: i32 = 2;
pub const TRAP_UNSUPPORTED: i32 = 3;
/// Not faults: the time slice is up (at a loop's head, the address named), or the calls are deep enough that the next
/// starts from the kernel. Registers and the flags the target reads are in globals.
pub const TRAP_YIELD: i32 = 5;
pub const TRAP_UNWIND: i32 = 6;
/// What the program itself traps with: ud2 (SIGILL), int3 (SIGTRAP), hlt (SIGSEGV).
pub const TRAP_UD2: i32 = 7;
pub const TRAP_INT3: i32 = 8;
pub const TRAP_HLT: i32 = 9;

// Locals: the parameter, r0..r15, the block, the flags held, the deferred operands, scratch, xmm, v128 and f64
// scratch, then these.
pub const L_ENTRY: u32 = 0;
pub const fn l_reg(n: u32) -> u32 { 1 + n }
pub const L_BLK: u32 = 17;
pub const L_CF: u32 = 18;
pub const L_ZF: u32 = 19;
pub const L_SF: u32 = 20;
pub const L_OF: u32 = 21;
pub const L_PF: u32 = 22;
pub const L_FA: u32 = 23;
pub const L_FB: u32 = 24;
pub const L_FR: u32 = 25;
pub const fn l_t(k: u32) -> u32 { 26 + k }
pub const fn l_u(k: u32) -> u32 { 32 + k }
pub const fn l_x(n: u32) -> u32 { 34 + n }
pub const fn l_v(k: u32) -> u32 { 50 + k }
pub const fn l_d(k: u32) -> u32 { 52 + k }
/// The stack pointer the function was entered with at its start (all ones elsewhere): an indirect jump leaving rsp
/// above it goes to a frame further out (a longjmp), handed up.
const L_SP0: u32 = 54;
/// The budget, counted down in a local while a function with a loop runs, moved with the registers.
const L_BUDGET: u32 = 55;
/// Where a loop entered past its head goes on: that block + 1, read at each loop's head, 0 once there.
const L_INTO: u32 = 56;
const LOCALS: usize = 57;
const RSP: u32 = 4;

/// Each local's type (a function declares only those it touches: V8's first tier zeroes them at every entry).
const fn kind(l: u32) -> u8 {
    match l {
        L_BLK | L_CF..=L_PF | L_BUDGET | L_INTO => I32,
        _ if l >= l_u(0) && l < l_x(0) => I32,
        _ if l >= l_x(0) && l < l_d(0) => V128,
        _ if l >= l_d(0) && l < L_SP0 => F64,
        _ => I64,
    }
}
const I32: u8 = 0x7f;
const I64: u8 = 0x7e;
const F64: u8 = 0x7c;
const V128: u8 = 0x7b;

/// A sync's scope when it may move any register.
pub const ALL: u32 = u32::MAX;

/// A label open in a function's code: the end of a block's (a jump forward to it), or a loop's (its head).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lab { Block(usize), Loop(usize) }

/// What a stretch of code between syncs and edges did to the registers (bits as Fx::used): read before surely
/// written in it, surely written (not inside a conditional), written at all; a sync (its index, `true` where not
/// inside a conditional); or a place the code may go on to this function's blocks.
#[derive(Clone, Copy)]
enum Ev { Run(Run), Sync(u32, bool), Edge }

/// A stretch's registers: [read before surely written, surely written, written].
type Run = [u32; 3];

/// What every function's lowering reads.
#[derive(Clone, Copy)]
pub struct Lowering<'p> {
    pub elf: &'p Elf,
    pub program: &'p Program,
    pub handed: &'p Liveness,
    pub summaries: &'p [Summary],
    pub trace: bool,
}

/// A function as it is made: its code (locals and syncs put in at the end), what it noted, and where it is.
pub struct Fx<'p> {
    pub f: Vec<u8>,
    /// Where it syncs registers with their globals (byte offset, save, the registers it may move at most).
    syncs: Vec<(usize, bool, u32)>,
    /// The registers it touches (bit n for r_n, 16 + n for xmm_n), and what each part noted: [0] the prologue,
    /// [k + 1] block k, part k's from `ev_at[k]`.
    used: u32,
    ev: Vec<Ev>,
    ev_at: Vec<usize>,
    /// The stretch since the last event.
    run: Run,
    /// Nesting of wasm blocks in the current block's code (a write inside one may not happen), and between the code
    /// and the dispatch loop.
    nest: u32,
    pub depth: u32,
    /// Each local's number in the function (0: not touched yet), numbered as first touched, and their types.
    slots: [u32; LOCALS],
    kinds: Vec<u8>,
    /// What ops keeps across instructions (ops.rs).
    pub flags: Flags,
    pub fr_pending: bool,
    pub fused: Option<Instruction>,
    pub rsp_up: bool,
    pub backward: bool,
    entry: Vec<bool>,
    /// Each block's successors within, by index (NO: none).
    succ: &'p [[u32; 2]],
    /// Whether there is a dispatch loop (a lean function has none).
    dispatch: bool,
    pub program: &'p Program,
    function: &'p Function,
    pub report: &'p mut Report,
    pub handed: &'p Liveness,
    /// The block being lowered; whether its budget is counted in L_BUDGET; what each function may do (summaries).
    at: usize,
    budget: bool,
    summaries: &'p [Summary],
    /// Its loops made wasm loops, the innermost each block lies within past its head, the loop each block heads,
    /// the labels open (outermost first), and where each block's and loop's label is among them while open.
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
}

/// A LEB128, unsigned and signed.
#[inline]
pub fn uleb(out: &mut Vec<u8>, v: u64) { if v < 0x80 { out.push(v as u8) } else { uleb_long(out, v) } }
#[cold]
fn uleb_long(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 { out.push(v as u8 | 0x80); v >>= 7; }
    out.push(v as u8);
}
pub fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0) { out.push(b); return; }
        out.push(b | 0x80);
    }
}

/// An access to memory 0: its operator, alignment and offset.
pub struct Mem(pub Op, pub u32, pub u64);
/// An operator with its lane.
pub const fn lane_op(o: Op, lane: u8) -> Op { Op(o.0 | (lane as u32) << (8 * o.1 as u32), o.1 + 1) }
/// What Fx::e writes: an operator, or an access to memory.
pub trait Emit { fn emit(self, fx: &mut Fx); }
impl Emit for Op { fn emit(self, fx: &mut Fx) { fx.op(self) } }
impl Emit for Mem { fn emit(self, fx: &mut Fx) { fx.mem(self.0, self.1, self.2) } }

/// The bit (as Fx::used) of each local that holds a register, or NOT_REG.
const NOT_REG: u8 = u8::MAX;
const REG_BIT: [u8; LOCALS] = {
    let mut t = [NOT_REG; LOCALS];
    let mut k = 0;
    while k < 16 { t[l_reg(k) as usize] = k as u8; t[l_x(k) as usize] = 16 + k as u8; k += 1; }
    t
};

impl Fx<'_> {
    // ---- Emit ----
    pub fn op(&mut self, o: Op) {
        if o.1 == 1 { self.f.push(o.0 as u8) } else { self.f.extend_from_slice(&o.0.to_le_bytes()[..o.1 as usize]) }
    }
    fn imm(&mut self, o: Op, v: u32) { self.op(o); uleb(&mut self.f, v as u64); }
    pub fn c32(&mut self, v: i32) { self.konst(0x41, v as i64) }
    pub fn c64(&mut self, v: i64) { self.konst(0x42, v) }
    fn konst(&mut self, opcode: u8, v: i64) {
        if (-64..64).contains(&v) { self.f.extend_from_slice(&[opcode, v as u8 & 0x7f]) } else { self.f.push(opcode); sleb(&mut self.f, v) }
    }
    pub fn f64c(&mut self, v: f64) { self.f.push(0x44); self.f.extend_from_slice(&v.to_le_bytes()); }
    pub fn v128c(&mut self, v: i128) { self.f.extend_from_slice(&[0xfd, 0x0c]); self.f.extend_from_slice(&v.to_le_bytes()); }
    pub fn shuffle(&mut self, lanes: [u8; 16]) { self.f.extend_from_slice(&[0xfd, 0x0d]); self.f.extend_from_slice(&lanes); }
    /// A load or store (its opcode) of memory 0 at `offset` past the address, aligned to 2^align.
    pub fn mem(&mut self, o: Op, align: u32, offset: u64) { self.op(o); uleb(&mut self.f, align as u64); uleb(&mut self.f, offset); }
    pub fn e(&mut self, x: impl Emit) { x.emit(self) }
    pub fn gget(&mut self, g: u32) { self.imm(Op(0x23, 1), g) }
    pub fn gset(&mut self, g: u32) { self.imm(Op(0x24, 1), g) }
    pub fn call(&mut self, f: u32) { self.imm(Op(0x10, 1), f) }
    pub fn return_call(&mut self, f: u32) { self.imm(Op(0x12, 1), f) }
    pub fn br(&mut self, d: u32) { self.imm(Op(0x0c, 1), d) }
    pub fn br_if(&mut self, d: u32) { self.imm(Op(0x0d, 1), d) }
    pub fn br_table(&mut self, targets: &[u32], default: u32) {
        self.imm(Op(0x0e, 1), targets.len() as u32);
        for &t in targets { uleb(&mut self.f, t as u64); }
        uleb(&mut self.f, default as u64);
    }
    pub fn block(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x02, 0x40]); }
    pub fn loop_(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x03, 0x40]); }
    pub fn if_(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x04, 0x40]); }
    pub fn if_v128(&mut self) { self.nest += 1; self.f.extend_from_slice(&[0x04, V128]); }
    pub fn else_(&mut self) { self.f.push(0x05); }
    pub fn end(&mut self) { self.nest = self.nest.saturating_sub(1); self.f.push(0x0b); }
    /// A local as the function numbers it: numbered as it is first touched.
    #[inline]
    fn slot(&mut self, l: u32) -> u32 {
        let s = self.slots[l as usize];
        if s == 0 && l != L_ENTRY { self.first_touch(l) } else { s }
    }
    #[cold]
    fn first_touch(&mut self, l: u32) -> u32 {
        self.kinds.push(kind(l));
        self.slots[l as usize] = self.kinds.len() as u32;
        self.kinds.len() as u32
    }
    /// A local moved, and the register it holds noted.
    #[inline]
    fn local(&mut self, opcode: u8, l: u32) {
        let b = REG_BIT[l as usize];
        if b != NOT_REG {
            let bit = 1 << b;
            self.used |= bit;
            if opcode == 0x20 { self.run[0] |= bit & !self.run[1] } else { self.run[2] |= bit; if self.nest == 0 { self.run[1] |= bit } }
        }
        let s = self.slot(l);
        if s < 0x80 { self.f.extend_from_slice(&[opcode, s as u8]) } else { self.wide(opcode, s) }
    }
    #[cold]
    fn wide(&mut self, opcode: u8, s: u32) { self.f.push(opcode); uleb(&mut self.f, s as u64) }
    pub fn get(&mut self, l: u32) { self.local(0x20, l) }
    pub fn set(&mut self, l: u32) { self.local(0x21, l) }
    pub fn tee(&mut self, l: u32) { self.local(0x22, l) }
    /// An event, after the stretch before it.
    fn note(&mut self, e: Ev) { self.end_run(); self.ev.push(e); }
    fn end_run(&mut self) { if self.run != [0; 3] { self.ev.push(Ev::Run(self.run)); self.run = [0; 3]; } }
    /// A local moved with nothing noted.
    fn raw(&mut self, opcode: u8, l: u32) { let s = self.slot(l); self.f.push(opcode); uleb(&mut self.f, s as u64); }
    pub fn get_raw(&mut self, l: u32) { self.raw(0x20, l) }
    pub fn set_raw(&mut self, l: u32) { self.raw(0x21, l) }
    pub fn tee_raw(&mut self, l: u32) { self.raw(0x22, l) }

    // ---- Registers and their globals ----
    pub fn save(&mut self) { self.sync_in(true, ALL); }
    pub fn load(&mut self) { self.sync_in(false, ALL); }
    /// A sync (put in by `finish`, once the whole function says what it moves) that moves at most `scope`.
    fn sync_in(&mut self, save: bool, scope: u32) {
        self.syncs.push((self.f.len(), save, scope));
        self.note(Ev::Sync(self.syncs.len() as u32 - 1, self.nest == 0));
    }

    // ---- Labels ----
    fn open(&mut self, l: Lab) {
        let at = Some(self.labels.len() as u32);
        match l { Lab::Block(b) => self.block_at[b] = at, Lab::Loop(i) => self.loop_at[i] = at }
        self.labels.push(l);
    }
    fn close(&mut self, l: Lab) {
        debug_assert_eq!(self.labels.last(), Some(&l), "labels closed out of order");
        self.labels.pop();
        match l { Lab::Block(b) => self.block_at[b] = None, Lab::Loop(i) => self.loop_at[i] = None }
    }
    /// The depth of a br from here to the label at `at` among those open.
    fn to(&self, at: u32) -> u32 { self.depth - 1 - at }
    /// The depth of a br to `address` when it is a block after this one whose label is open.
    fn forward(&self, target: u32) -> Option<u32> {
        let b = (target != NO && target as usize > self.at).then_some(target as usize)?;
        self.block_at[b].map(|at| self.to(at))
    }

    /// Into loop `l` at its head: its label and those of the blocks directly within it. Entered past its head (only
    /// ever from the dispatch: a call's continuation, a loop within, after the thread went to the kernel there), on to
    /// that block, or the head of the loop within this one that holds it, which sends it on in turn: a local tested
    /// every round, the rest only then.
    fn enter_loop(&mut self, l: usize) {
        let Loop { head, last, .. } = self.loops[l];
        self.loop_();
        self.open(Lab::Loop(l));
        let mine: Vec<usize> = (head + 1..=last).rev().filter(|&b| self.within[b] == Some(l)).collect();
        for b in mine { self.block(); self.open(Lab::Block(b)); }
        if !(head + 1..=last).any(|b| self.entry[b]) { return; }
        self.depth = self.labels.len() as u32;
        // Ok(its label) within this loop itself, Err(the label of the head of the loop within this one that holds it).
        let route: Vec<Result<u32, u32>> = (head + 1..=last).map(|b| {
            let (mut w, mut t) = (self.within[b], b);
            while let Some(c) = w { if c == l { break; } t = self.loops[c].head; w = self.loops[c].parent; }
            let at = self.block_at[t].unwrap_or_default();
            if t == b { Ok(at) } else { Err(at) }
        }).collect();
        self.get(L_INTO);
        self.if_();
        self.block();
        let outer: Vec<u32> = route.iter().map(|r| match *r { Ok(_) => 0, Err(at) => self.to(at) + 2 }).collect();
        self.get(L_INTO); self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&outer, 1);
        self.end();
        let inner: Vec<u32> = route.iter().map(|r| match *r { Ok(at) => self.to(at) + 1, Err(_) => 0 }).collect();
        self.get(L_INTO); self.c32(0); self.set(L_INTO);
        self.c32(head as i32 + 2); self.op(I32_SUB);
        self.br_table(&inner, 0);
        self.end();
    }

    /// On at `address`: falling through to the next block, out to a block after this one, round a loop it is in,
    /// round the dispatch loop, or out of the function.
    fn goto(&mut self, (address, target): (u64, u32), next: Option<u64>) {
        if Some(address) == next { self.note(Ev::Edge); return; }
        match (target != NO).then_some(target as usize) {
            Some(b) => {
                if b <= self.at { self.time_slice(address); }
                self.note(Ev::Edge);
                let label = if b > self.at { self.block_at[b] } else { self.heads[b].and_then(|l| self.loop_at[l]) };
                match label {
                    Some(at) => self.br(self.to(at)),
                    None => { debug_assert!(self.dispatch, "a lean function went round the dispatch"); self.c32(b as i32); self.set(L_BLK); self.br(self.depth); }
                }
            }
            None => {
                // Out to an address before this block's (another run of the same function) may go round a loop.
                if address <= self.function.blocks[self.at].start { self.time_slice(address); }
                self.tail(address)
            }
        }
    }

    /// Nonzero when the thread's budget is spent (one less now).
    fn spent(&mut self) {
        if self.budget { self.get(L_BUDGET); self.c32(1); self.op(I32_SUB); self.tee(L_BUDGET); self.op(I32_EQZ); }
        else { self.gget(G_BUDGET); self.c32(1); self.op(I32_SUB); self.gset(G_BUDGET); self.gget(G_BUDGET); self.op(I32_EQZ); }
    }

    /// At a loop's head: its turn is up when its budget is spent, or when it is asked to look in (a signal, taken at a
    /// loop as a CPU takes an interrupt, so `while (!got) pause();` takes it at the call).
    fn time_slice(&mut self, address: u64) {
        self.spent();
        self.c32(0); self.mem(I32_LOAD, 2, INTERRUPT as u64);
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save();
        self.save_flags(self.handed.handed_at(self.program.entries.index(address)));
        self.c64(address as i64); self.c32(TRAP_YIELD); self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
    }

    /// Before a call: past DEPTH_LIMIT frames, or when the budget is spent, made from the kernel instead (to the
    /// target `target` pushes); else one frame more.
    fn enter_call(&mut self, flags: u32, target: impl FnOnce(&mut Self)) {
        self.note_low();
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.spent();
        self.op(I32_OR);
        self.if_();
        self.depth += 1;
        self.save_flags(flags);
        target(self);
        self.c32(TRAP_UNWIND); self.c32(TRAP_YIELD);
        self.gget(G_DEPTH); self.c32(DEPTH_LIMIT); self.op(I32_GE_U);
        self.op(SELECT);
        self.call(F_TRAP); self.op(UNREACHABLE);
        self.depth -= 1;
        self.end();
        self.gget(G_DEPTH); self.c32(1); self.op(I32_ADD); self.gset(G_DEPTH);
    }
    fn leave_call(&mut self) { self.gget(G_DEPTH); self.c32(1); self.op(I32_SUB); self.gset(G_DEPTH); }

    /// To code outside this function without growing the stack.
    fn tail(&mut self, address: u64) {
        self.save();
        let e = self.program.entries.index(address);
        self.save_flags(self.handed.handed_at(e));
        match e.map(|e| self.program.entries.at(e)) {
            Some((f, b)) => { self.c32(b as i32); self.return_call(FIRST_GUEST + f); }
            None => { self.c64(address as i64); self.return_call(F_DISPATCH); }
        }
    }

    /// After a call: on at its return address (taking back `writes`, or all of them, from the globals), or, handed
    /// another (a longjmp out of the callee, in l_t(0)), to the function's resume (after what this frame holds is
    /// saved, where a quiet call left it in the locals).
    fn after_call(&mut self, ret: (u64, u32), next: Option<u64>, writes: Option<u32>) {
        self.get(l_t(0)); self.c64(ret.0 as i64); self.op(I64_NE);
        self.if_();
        if writes.is_some() { self.save(); }
        self.br(self.depth + 1 + self.dispatch as u32);
        self.end();
        self.sync_in(false, writes.unwrap_or(ALL));
        self.set_flags(Flags::Held);
        self.goto(ret, next);
    }
}

/// The function `target` (entry `e`) starts and its summary, when it is one of this program's that never goes out.
fn quiet(program: &Program, summaries: &[Summary], target: u64, e: Option<usize>) -> Option<(u32, Summary)> {
    let (f, b) = program.entries.at(e?);
    let s = *summaries.get(f as usize)?;
    (b == 0 && program.functions[f as usize].start == target && !s.exits).then_some((f, s))
}

/// What making a function needs, kept from one function to the next (cleared, not freed), so none allocates.
#[derive(Default)]
pub struct Frame {
    f: Vec<u8>,
    ev: Vec<Ev>,
    ev_at: Vec<usize>,
    syncs: Vec<(usize, bool, u32)>,
    kinds: Vec<u8>,
    entry: Vec<bool>,
    loops: Vec<Loop>,
    within: Vec<Option<usize>>,
    heads: Vec<Option<usize>>,
    labels: Vec<Lab>,
    block_at: Vec<Option<u32>>,
    loop_at: Vec<Option<u32>>,
    code: Vec<Instruction>,
    needed: Vec<u32>,
    /// clean_loops' and sync_masks' own.
    marks: (Vec<usize>, Vec<usize>),
    cold: Vec<bool>,
    entered: Vec<bool>,
    masks: Masks,
}

/// What sync_masks keeps: each block's flow, the syncs noted on the way and their masks, and the blocks an indirect
/// jump within may go to.
#[derive(Default)]
struct Masks { flow: Vec<Flow>, notes: Vec<(usize, usize, u32, u32)>, mask: Vec<u32>, starts: Vec<usize> }

/// A block as the sync masks see it: where it goes within (up to two, or INDIRECT: any entry), its forward and
/// backward transfers (`value & P | G`), and what is dirty into it and live into it.
#[derive(Clone, Copy, Default)]
struct Flow { to: [u32; 2], n: u8, edged: bool, forward: (u32, u32), backward: (u32, u32), dirty: u32, live: u32 }
const TO_ENTRIES: u8 = u8::MAX;

/// Entries the dispatch starts at only to go on after the thread went to the kernel there, or a longjmp: a call's
/// continuation, a loop's head, a system call's or the instruction after it. A loop entered past its head at one is
/// still a wasm loop (enter_loop routes it); one entered at others (a switch's cases, another run's code) is not.
fn cold_entries(function: &Function, succ: &[[u32; 2]], cold: &mut Vec<bool>) {
    cold.clear();
    cold.resize(function.blocks.len(), false);
    for (k, b) in function.blocks.iter().enumerate() {
        // (A call's return is its first successor.)
        if matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }) && succ[k][0] != NO { cold[succ[k][0] as usize] = true; }
        for &t in &succ[k] { if t != NO && t as usize <= k { cold[t as usize] = true; } }
        if b.resumes {
            if let Some(t) = function.block_index(b.end()) { cold[t] = true; }
            if b.count == 1 { cold[k] = true; }
        }
    }
}

/// Of the function's loops (into `s.loops`, with `s.within` and `s.heads`), those made wasm loops: the ones no jump
/// from outside enters past their head and no entry but a cold one lies in past their head, each within the nearest
/// such. Returns whether the function needs no dispatch loop beyond its entry: no jump back but a kept loop's round.
fn clean_loops(function: &Function, s: &mut Frame) -> bool {
    let n = function.blocks.len();
    loops_into(&function.succ, &mut s.loops, (&mut s.marks.0, &mut s.marks.1));
    cold_entries(function, &function.succ, &mut s.cold);
    loop {
        s.heads.clear();
        s.heads.resize(n, None);
        for (l, lp) in s.loops.iter().enumerate() { s.heads[lp.head] = Some(l); }
        s.entered.clear();
        s.entered.resize(s.loops.len(), false);
        let (loops, entered, heads) = (&s.loops, &mut s.entered, &s.heads);
        let mut rounds_only = true;
        let mut mark = |t: usize, from: Option<usize>| for (l, lp) in loops.iter().enumerate() {
            if t > lp.head && t <= lp.last && from.is_none_or(|k| k < lp.head || k > lp.last) { entered[l] = true; }
        };
        for (k, to) in function.succ.iter().enumerate() {
            if !s.cold[k] && s.entry[k] { mark(k, None); }
            for t in to.iter().filter(|&&t| t != NO).map(|&t| t as usize) {
                if t > k { mark(t, Some(k)); continue; }
                if !heads[t].is_some_and(|l| (loops[l].head..=loops[l].last).contains(&k)) { mark(t, None); rounds_only = false; }
            }
        }
        if !s.entered.contains(&true) {
            within_of(&s.loops, n, &mut s.within);
            return rounds_only;
        }
        // The loops kept, in place (a loop's parent comes before it), each within the nearest kept one: their parents
        // as they were read from `was`, the slots before a loop being written over as it is reached.
        let (now, was) = (&mut s.marks.0, &mut s.marks.1);
        now.clear();
        now.resize(s.loops.len(), usize::MAX);
        was.clear();
        was.extend(s.loops.iter().map(|lp| lp.parent.unwrap_or(usize::MAX)));
        let mut kept = 0;
        for l in 0..s.loops.len() {
            if s.entered[l] { continue; }
            let mut p = was[l];
            while p != usize::MAX && s.entered[p] { p = was[p]; }
            now[l] = kept;
            s.loops[kept] = Loop { parent: (p != usize::MAX).then(|| now[p]), ..s.loops[l] };
            kept += 1;
        }
        s.loops.truncate(kept);
    }
}

/// Function `index` (numbered in the table from `base`) made, its body with its size before it, onto `out`. Lean
/// when it may be (entered only at its start, with no indirect jump and no jump back but a loop's round: no dispatch
/// loop, no br_table, and with no call no resume either); V8's first tier checks the stack at each loop's head and
/// zeroes the locals of a function with more than a few.
pub fn lower_function(cx: &Lowering, index: u32, base: u32, report: &mut Report, frame: &mut Frame, out: &mut Vec<u8>) {
    let Lowering { elf, program, handed, summaries, trace } = *cx;
    let function = &program.functions[index as usize];
    let n = function.blocks.len();
    // Whether each block is an entry, found once here.
    frame.entry.clear();
    frame.entry.extend((0..n).map(|k| handed.is_entry(index, k)));
    let rounds_only = clean_loops(function, frame);
    let entered_within = function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) || frame.entry.iter().skip(1).any(|&e| e);
    let lean = !entered_within && rounds_only;
    let cases = handed.cases[index as usize] as u32;
    let mut s = std::mem::take(frame);
    s.loop_at.clear();
    s.loop_at.resize(s.loops.len(), None);
    s.block_at.clear();
    s.block_at.resize(n, None);
    s.ev_at.clear();
    s.ev_at.push(0);
    s.f.clear(); s.ev.clear(); s.syncs.clear(); s.kinds.clear(); s.labels.clear();
    let mut fx = Fx {
        f: s.f, syncs: s.syncs, used: 0, ev: s.ev, ev_at: s.ev_at, run: [0; 3], nest: 0, depth: 0,
        slots: [0; LOCALS], kinds: s.kinds, flags: Flags::Held, fr_pending: false, fused: None, rsp_up: false, backward: false,
        entry: s.entry, dispatch: !lean, program, function, report, handed, at: 0, budget: has_loop(function), summaries, succ: &function.succ,
        loop_at: s.loop_at, loops: s.loops, within: s.within, heads: s.heads, labels: s.labels, block_at: s.block_at,
    };
    let (mut code, mut needed) = (s.code, s.needed);
    // The stack pointer it began with, only where it is read: past a call (the resume) or an indirect jump.
    let calls = function.blocks.iter().any(|b| matches!(b.exit, Exit::Call { .. } | Exit::IndirectCall { .. }));
    if calls || function.blocks.iter().any(|b| b.exit == Exit::IndirectJump) {
        fx.gget(RSP); fx.c64(-1); fx.get(L_ENTRY); fx.op(I32_EQZ); fx.op(SELECT); fx.set(L_SP0);
    }
    // Entered at L_ENTRY: from outside, or again from the resume below, as from outside.
    let resume = !lean || calls;
    if resume { fx.loop_(); }
    if !lean { fx.get(L_ENTRY); fx.set(L_BLK); }
    fx.load();
    fx.load_flags(cases);
    if resume { fx.block(); }
    if !lean { fx.loop_(); }
    // A label for each block within no loop past its head, the last block's outermost: each ends where its code starts.
    let outside: Vec<usize> = (0..n).rev().filter(|&b| fx.within[b].is_none()).collect();
    for b in outside { fx.block(); fx.open(Lab::Block(b)); }
    fx.depth = fx.labels.len() as u32;
    if !lean {
        // Each entry to its label; one within a loop past its head to the head of the outermost loop it lies within,
        // with L_INTO saying where to go on. Block 0 (a call's way in) first: a br_table of n is log n compares.
        let outermost = |fx: &Fx, b: usize| {
            let (mut l, mut t) = (fx.within[b], b);
            while let Some(w) = l { t = fx.loops[w].head; l = fx.loops[w].parent; }
            fx.to(fx.block_at[t].unwrap_or_default())
        };
        let heads: Vec<u32> = (0..n).map(|b| outermost(&fx, b)).collect();
        if (0..n).any(|b| fx.entry[b] && fx.within[b].is_some()) {
            fx.block();
            let targets: Vec<u32> = (0..n).map(|b| if fx.within[b].is_some() { 0 } else { heads[b] + 1 }).collect();
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(targets[0]);
            fx.get(L_BLK);
            fx.br_table(&targets, 0);
            fx.end();
            fx.get(L_BLK); fx.c32(1); fx.op(I32_ADD); fx.set(L_INTO);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        } else {
            fx.get(L_BLK); fx.op(I32_EQZ); fx.br_if(heads[0]);
            fx.get(L_BLK);
            fx.br_table(&heads, 0);
        }
    }
    let mut decoder = Code::new(elf, function.span().map_or(function.start, |(lo, _)| lo));
    for (k, block) in function.blocks.iter().enumerate() {
        decoder.decode(elf, block, &mut code);
        // Block k's label closed so its code starts here; a loop it heads is gone round from here.
        fx.end();
        fx.close(Lab::Block(k));
        if let Some(l) = fx.heads[k] { fx.enter_loop(l); }
        fx.end_run();
        fx.ev_at.push(fx.ev.len());
        fx.nest = 0;
        fx.depth = fx.labels.len() as u32;
        fx.set_flags(Flags::Held);
        fx.backward = false;
        fx.at = k;
        fx.report.blocks += 1;
        if trace { fx.c64(block.start as i64); fx.call(F_TRACE); }
        let next = function.blocks.get(k + 1).map(|b| b.start);
        let (held, ext) = handed.live_out(index, k);
        // The flags needed after each instruction, from the end back.
        needed.clear();
        needed.resize(code.len(), 0);
        let mut live = held | ext;
        for (j, i) in code.iter().enumerate().rev() { needed[j] = live; let k = crate::program::kind(i); live = (live & !k.writes as u32) | k.reads as u32; }
        let last = code.len() - 1;
        for (j, i) in code.iter().enumerate() {
            fx.report.instructions += 1;
            if j == last && !runs_on(i) { break; }
            // A compare whose flags only the branch that ends the block reads is that branch's condition.
            if j + 1 == last && held | ext == 0 && matches!(block.exit, Exit::Branch { .. }) && Fx::fusable(i, code[last].condition_code()) {
                fx.fused = Some(*i);
                continue;
            }
            fx.instruction(i, needed[j] != 0);
        }
        let term = code[last];
        let to = fx.succ[k];
        if held != 0 && !matches!(block.exit, Exit::Branch { .. }) { fx.hold_flags(); }
        match block.exit {
            Exit::Fall(a) | Exit::Jump(a) => fx.goto((a, to[0]), next),
            Exit::TailJump(a) => fx.tail(a),
            Exit::Branch { taken, fall } => {
                fx.condition(term.condition_code());
                if held != 0 { fx.set(l_u(1)); fx.hold_flags(); fx.get(l_u(1)); }
                // A side going forward to a label open here is a br_if to it; where the taken side is the next block,
                // the condition turned round goes to the other.
                let (taken, fall) = ((taken, to[0]), (fall, to[1]));
                if let Some(d) = fx.forward(taken.1) {
                    fx.note(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(fall, next);
                } else if let Some(d) = fx.forward(fall.1).filter(|_| Some(taken.0) == next) {
                    fx.op(I32_EQZ);
                    fx.note(Ev::Edge);
                    fx.br_if(d);
                    fx.goto(taken, next);
                } else {
                    fx.if_();
                    fx.depth += 1;
                    fx.goto(taken, None);
                    fx.depth -= 1;
                    fx.end();
                    fx.goto(fall, next);
                }
            }
            Exit::IndirectJump => {
                fx.read(&term, 0, 8);
                fx.set(l_t(0));
                fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
                // This function's own (by the table's numbering, which a module made later starts at its base).
                fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
                fx.note(Ev::Edge);
                fx.if_();
                fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_BLK);
                fx.br(fx.depth + 1);
                fx.end();
                fx.save();
                // Elsewhere, it is handed what this function's own cases read: up to the frames further out when rsp
                // is above where this one began (a longjmp), else to the dispatcher.
                fx.save_flags(cases);
                fx.get(l_reg(RSP)); fx.get(L_SP0); fx.op(I64_GT_U);
                fx.if_();
                fx.get(l_t(0)); fx.op(RETURN);
                fx.end();
                fx.get(l_t(0)); fx.return_call(F_DISPATCH);
            }
            Exit::Call { target, ret } => {
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                let e = program.entries.index(target);
                if let Some((f, s)) = quiet(program, fx.summaries, target, e) {
                    // To a function that never goes out: only what it may touch is moved, and its depth not counted.
                    fx.note_low();
                    fx.sync_in(true, s.reads | s.writes);
                    fx.c32(0); fx.call(FIRST_GUEST + f);
                    fx.set(l_t(0));
                    fx.after_call((ret, to[0]), next, Some(s.writes));
                } else {
                    fx.save();
                    fx.enter_call(handed.handed_at(e), |fx| fx.c64(target as i64));
                    match e.map(|e| program.entries.at(e)) {
                        Some((f, b)) => { fx.c32(b as i32); fx.call(FIRST_GUEST + f); }
                        None => { fx.c64(target as i64); fx.call(F_DISPATCH); }
                    }
                    fx.set(l_t(0));
                    fx.leave_call();
                    fx.after_call((ret, to[0]), next, None);
                }
            }
            Exit::IndirectCall { ret } => {
                // The target is read before the return address is pushed.
                fx.read(&term, 0, 8);
                fx.set(l_t(2));
                fx.push_with(|fx| { fx.c64(ret as i64); true });
                fx.save();
                fx.enter_call(ALL_FLAGS, |fx| fx.get(l_t(2)));
                fx.get(l_t(2)); fx.call(F_DISPATCH);
                fx.set(l_t(0));
                fx.leave_call();
                fx.after_call((ret, to[0]), next, None);
            }
            Exit::Return => {
                fx.pop_value(l_t(0));
                if term.op_count() == 1 { fx.get(l_reg(RSP)); fx.c64(term.immediate16() as i64); fx.op(I64_ADD); fx.set(l_reg(RSP)); }
                fx.save();
                fx.get(l_t(0)); fx.op(RETURN);
            }
            Exit::Trap => {
                fx.c64(term.ip() as i64);
                fx.c32(match term.mnemonic() { Mnemonic::Ud2 => TRAP_UD2, Mnemonic::Int3 => TRAP_INT3, Mnemonic::Hlt => TRAP_HLT, _ => TRAP_UNDECODED });
                fx.call(F_TRAP);
                fx.op(UNREACHABLE);
            }
        }
        // The loops this is the last block of end here, the innermost first.
        while let Some(&Lab::Loop(l)) = fx.labels.last() {
            if fx.loops[l].last != k { break; }
            fx.end();
            fx.close(Lab::Loop(l));
        }
    }
    if !resume {
        fx.op(UNREACHABLE);
        fx.end();
        return finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out);
    }
    if !lean { fx.end(); }
    fx.op(UNREACHABLE);
    fx.end();
    // The resume: a call came back to an address not its own (after_call), in l_t(0). One of this function's entries
    // is entered again here, registers and flags from their globals, so a longjmp to a frame of this function's goes
    // on in it; anything else goes up, at once when rsp is above where this frame began.
    fx.gget(RSP); fx.get(L_SP0); fx.op(I64_GT_U);
    fx.if_();
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.get(l_t(0)); fx.call(F_RESOLVE); fx.set(l_t(1));
    if lean {
        fx.get(l_t(1)); fx.c64(((base + index) as i64) << 32); fx.op(I64_EQ);
        fx.br_if(0);
    } else {
        fx.get(l_t(1)); fx.c64(32); fx.op(I64_SHR_U); fx.c64((base + index) as i64); fx.op(I64_EQ);
        fx.if_();
        fx.get(l_t(1)); fx.op(I32_WRAP_I64); fx.set(L_ENTRY);
        fx.br(1);
        fx.end();
    }
    fx.get(l_t(0)); fx.op(RETURN);
    fx.end();
    fx.op(UNREACHABLE);
    fx.end();
    finish(fx, (code, needed, s.marks, s.cold, s.entered, s.masks), frame, out)
}

/// The rest of a frame, handed back with the function's own buffers.
type Rest = (Vec<Instruction>, Vec<u32>, (Vec<usize>, Vec<usize>), Vec<bool>, Vec<bool>, Masks);

/// Onto `out`: the function's size, its locals, then its code with each sync put in, only the registers it must move
/// (sync_masks: one the function never touches stays in its global, where code it calls and the host find it); and
/// every buffer back into `frame`.
fn finish(mut fx: Fx, rest: Rest, frame: &mut Frame, out: &mut Vec<u8>) {
    let (code, needed, marks, cold, entered, mut masks) = rest;
    fx.end_run();
    sync_masks(&fx, &mut masks);
    if fx.budget { fx.slot(L_BUDGET); }
    let (used, budget, slots) = (fx.used, fx.budget, fx.slots);
    // Room for the size (five bytes at most), then the body; the size written in at the end, and the body moved up
    // to it.
    let at = out.len();
    out.extend_from_slice(&[0; 5]);
    let groups = 1 + fx.kinds.windows(2).filter(|w| w[0] != w[1]).count() - fx.kinds.is_empty() as usize;
    uleb(out, groups as u64);
    let mut k = 0;
    while k < fx.kinds.len() {
        let run = fx.kinds[k..].iter().take_while(|&&t| t == fx.kinds[k]).count();
        uleb(out, run as u64);
        out.push(fx.kinds[k]);
        k += run;
    }
    // A move: local.get, global.set (a save), or global.get, local.set (a load).
    let pair = |f: &mut Vec<u8>, save: bool, local: u32, global: u32| {
        let (first, a, second, b) = if save { (0x20, local, 0x24, global) } else { (0x23, global, 0x21, local) };
        f.push(first); uleb(f, a as u64); f.push(second); uleb(f, b as u64);
    };
    let mut from = 0;
    for (&(offset, save, scope), &m) in fx.syncs.iter().zip(&masks.mask) {
        out.extend_from_slice(&fx.f[from..offset]);
        let mut moved = used & m;
        while moved != 0 {
            let n = moved.trailing_zeros();
            moved &= moved - 1;
            let (local, global) = if n < 16 { (l_reg(n), n) } else { (l_x(n - 16), g_xmm(n - 16)) };
            pair(out, save, slots[local as usize], global);
        }
        // (A call to a function that never goes out leaves the budget alone: it has no loop, and counts no call.)
        if budget && scope == ALL { pair(out, save, slots[L_BUDGET as usize], G_BUDGET); }
        from = offset;
    }
    out.extend_from_slice(&fx.f[from..]);
    let body = out.len() - at - 5;
    let mut size = [0u8; 5];
    let mut n = 0;
    let mut v = body;
    loop { size[n] = (v & 0x7f) as u8 | if v >= 0x80 { 0x80 } else { 0 }; n += 1; v >>= 7; if v == 0 { break; } }
    out[at..at + n].copy_from_slice(&size[..n]);
    out.copy_within(at + 5.., at + n);
    out.truncate(out.len() - (5 - n));
    *frame = Frame {
        f: fx.f, ev: fx.ev, ev_at: fx.ev_at, syncs: fx.syncs, kinds: fx.kinds, entry: fx.entry, loops: fx.loops, within: fx.within,
        heads: fx.heads, labels: fx.labels, block_at: fx.block_at, loop_at: fx.loop_at, code, needed, marks, cold, entered, masks,
    };
}

/// Which registers each sync must move (into `mask`, by sync). Between syncs a register lives in its local; its
/// global is what code outside reads and writes. A save stores only what was written since last stored or loaded on
/// some path here; a load takes in only what is read before it is surely written again; a save's stores count as
/// reads. Both flows through a block are `value & P | G` of the value coming in, so each block's events are gone
/// through once for its P and G, and the fixed points found block by block.
fn sync_masks(fx: &Fx, Masks { flow, notes, mask, starts }: &mut Masks) {
    let (function, syncs, events, ev_at) = (fx.function, &fx.syncs, &fx.ev, &fx.ev_at);
    let n = function.blocks.len();
    let ev = |k: usize| &events[ev_at[k]..ev_at.get(k + 1).copied().unwrap_or(events.len())];
    // Where the prologue's dispatch, and an indirect jump within, may go; each block's successors within.
    starts.clear();
    starts.extend((0..n).filter(|&k| k == 0 || fx.entry[k]));
    flow.clear();
    flow.extend(function.blocks.iter().zip(fx.succ).map(|(b, to)| {
        let mut f = Flow::default();
        if b.exit == Exit::IndirectJump { f.n = TO_ENTRIES; return f; }
        for &k in to.iter().filter(|&&k| k != NO) { f.to[f.n as usize] = k; f.n += 1; }
        f
    }));
    let to = |flow: &[Flow], k: usize, each: &mut dyn FnMut(usize)| {
        let f = &flow[k];
        if f.n == TO_ENTRIES { for &s in starts.iter() { each(s) } } else { for &s in &f.to[..f.n as usize] { each(s as usize) } }
    };
    mask.clear();
    mask.resize(syncs.len(), 0);
    notes.clear();
    // Forward: written since the last sync on some path. A save takes what is dirty where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g, mut out_p, mut out_g) = (ALL, 0, 0, 0);
        for e in ev(k + 1) {
            match *e {
                Ev::Run([_, _, w]) => g |= w,
                Ev::Sync(m, top) if syncs[m as usize].1 => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => { out_p |= p; out_g |= g; f.edged = true; }
                _ => {}
            }
        }
        if !f.edged { out_p |= p; out_g |= g; }
        f.forward = (out_p, out_g);
    }
    loop {
        let mut changed = false;
        for k in 0..n {
            let out = (flow[k].dirty & flow[k].forward.0) | flow[k].forward.1;
            let f = flow[k];
            let mut go = |s: usize| if flow[s].dirty | out != flow[s].dirty { flow[s].dirty |= out; changed = true; };
            if f.n == TO_ENTRIES { for &s in starts.iter() { go(s) } } else { for &s in &f.to[..f.n as usize] { go(s as usize) } }
        }
        if !changed { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((flow[k].dirty & p) | g) & syncs[m].2; }
    notes.clear();
    // Backward: read before surely written again. A load takes what is live where it is.
    for (k, f) in flow.iter_mut().enumerate() {
        let (mut p, mut g) = (if f.edged { 0 } else { ALL }, 0);
        for e in ev(k + 1).iter().rev() {
            match *e {
                Ev::Run([u, k, _]) => { p &= !k; g = (g & !k) | u; }
                Ev::Sync(m, _) if syncs[m as usize].1 => g |= mask[m as usize],
                Ev::Sync(m, top) => { let m = m as usize; notes.push((m, k, p, g)); if top { p &= !syncs[m].2; g &= !syncs[m].2; } }
                Ev::Edge => p = ALL,
            }
        }
        f.backward = (p, g);
    }
    let after = |flow: &[Flow], k: usize| { let mut a = 0; to(flow, k, &mut |s| a |= flow[s].live); a };
    loop {
        let mut changed = false;
        for k in (0..n).rev() {
            let l = (after(flow, k) & flow[k].backward.0) | flow[k].backward.1;
            if flow[k].live | l != flow[k].live { flow[k].live |= l; changed = true; }
        }
        if !changed { break; }
    }
    for &(m, k, p, g) in notes.iter() { mask[m] |= ((after(flow, k) & p) | g) & syncs[m].2; }
    // The prologue takes in what any block it may start at reads.
    let start = starts.iter().fold(0, |acc, &k| acc | flow[k].live);
    for e in ev(0) { if let Ev::Sync(m, _) = *e { if !syncs[m as usize].1 { mask[m as usize] |= start; } } }
}

impl Fx<'_> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// LEB128 as wasm-encoder writes it.
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
