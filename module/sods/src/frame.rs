//! A function as it is made, a wasm function written straight into its bytes: its locals (numbered as they are first
//! touched), the operators as they are written, the labels open, and what is noted on the way of the registers
//! moved (sync.rs decides from it what each sync moves). What each x86 instruction means is written on it by
//! operand.rs, flags.rs, integer.rs, sse.rs and fpu.rs; its control flow by lower.rs.

use crate::facts::{Liveness, Summary};
use crate::flags::Flags;
use crate::layout::Loop;
use crate::program::*;
use crate::wasm::*;
use crate::x86::Instruction;
use std::collections::BTreeMap;

/// What a translation says of itself.
#[derive(Default, Debug)]
pub struct Report {
    pub functions: usize,
    pub blocks: usize,
    pub instructions: usize,
    pub entries: usize,
    /// Mnemonics lowered to a trap, with how often they appear.
    pub unsupported: BTreeMap<String, usize>,
}

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
pub(crate) const L_SP0: u32 = 54;
/// The budget, counted down in a local while a function with a loop runs, moved with the registers.
pub(crate) const L_BUDGET: u32 = 55;
/// Where a loop entered past its head goes on: that block + 1, read at each loop's head, 0 once there.
pub(crate) const L_INTO: u32 = 56;
pub(crate) const LOCALS: usize = 57;

/// Each local's type (a function declares only those it touches: V8's first tier zeroes them at every entry).
const fn local_type(l: u32) -> u8 {
    match l {
        L_BLK | L_CF..=L_PF | L_BUDGET | L_INTO => I32,
        _ if l >= l_u(0) && l < l_x(0) => I32,
        _ if l >= l_x(0) && l < l_d(0) => V128,
        _ if l >= l_d(0) && l < L_SP0 => F64,
        _ => I64,
    }
}

/// A sync's scope when it may move any register.
pub const ALL: u32 = u32::MAX;

/// A label open in a function's code: the end of a block's (a jump forward to it), or a loop's (its head).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Lab { Block(usize), Loop(usize) }

/// What a stretch of code between syncs and edges did to the registers (bits as Fx::used): read before surely
/// written in it, surely written (not inside a conditional), written at all; a sync (its index, `true` where not
/// inside a conditional); or a place the code may go on to this function's blocks.
#[derive(Clone, Copy)]
pub(crate) enum Ev { Run(Run), Sync(u32, bool), Edge }

/// A stretch's registers: [read before surely written, surely written, written].
pub(crate) type Run = [u32; 3];

/// A function as it is made: its code (locals and syncs put in at the end), what it noted, and where it is.
pub struct Fx<'p> {
    pub f: Vec<u8>,
    /// Where it syncs registers with their globals (byte offset, save, the registers it may move at most).
    pub(crate) syncs: Vec<(usize, bool, u32)>,
    /// The registers it touches (bit n for r_n, 16 + n for xmm_n), and what each part noted: [0] the prologue,
    /// [k + 1] block k, part k's from `ev_at[k]`.
    pub(crate) used: u32,
    pub(crate) ev: Vec<Ev>,
    pub(crate) ev_at: Vec<usize>,
    /// The stretch since the last event.
    pub(crate) run: Run,
    /// Nesting of wasm blocks in the current block's code (a write inside one may not happen), and between the code
    /// and the dispatch loop.
    pub(crate) nest: u32,
    pub depth: u32,
    /// Each local's number in the function (0: not touched yet), numbered as first touched, and their types.
    pub(crate) slots: [u32; LOCALS],
    pub(crate) kinds: Vec<u8>,
    /// What the lowering of instructions keeps across them (flags.rs, integer.rs).
    pub flags: Flags,
    pub fr_pending: bool,
    pub fused: Option<Instruction>,
    pub rsp_up: bool,
    pub backward: bool,
    pub(crate) entry: Vec<bool>,
    /// Each block's successors within, by index (NO: none).
    pub(crate) succ: &'p [[u32; 2]],
    /// Whether there is a dispatch loop (a lean function has none).
    pub(crate) dispatch: bool,
    pub program: &'p Program,
    pub(crate) function: &'p Function,
    pub report: &'p mut Report,
    pub handed: &'p Liveness,
    /// The block being lowered; whether its budget is counted in L_BUDGET; what each function may do (summaries).
    pub(crate) at: usize,
    pub(crate) budget: bool,
    pub(crate) summaries: &'p [Summary],
    /// Its loops made wasm loops, the innermost each block lies within past its head, the loop each block heads,
    /// the labels open (outermost first), and where each block's and loop's label is among them while open.
    pub(crate) loops: Vec<Loop>,
    pub(crate) within: Vec<Option<usize>>,
    pub(crate) heads: Vec<Option<usize>>,
    pub(crate) labels: Vec<Lab>,
    pub(crate) block_at: Vec<Option<u32>>,
    pub(crate) loop_at: Vec<Option<u32>>,
    /// Two lists of labels, for the tables its dispatch and its loops branch by.
    pub(crate) tables: [Vec<u32>; 2],
}

/// An access to memory 0: its operator, alignment and offset.
pub struct Mem(pub Op, pub u32, pub u64);
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
    pub(crate) fn slot(&mut self, l: u32) -> u32 {
        let s = self.slots[l as usize];
        if s == 0 && l != L_ENTRY { self.first_touch(l) } else { s }
    }
    #[cold]
    fn first_touch(&mut self, l: u32) -> u32 {
        self.kinds.push(local_type(l));
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
    pub(crate) fn note(&mut self, e: Ev) { self.end_run(); self.ev.push(e); }
    pub(crate) fn end_run(&mut self) { if self.run != [0; 3] { self.ev.push(Ev::Run(self.run)); self.run = [0; 3]; } }
    /// A local moved with nothing noted.
    fn raw(&mut self, opcode: u8, l: u32) { let s = self.slot(l); self.f.push(opcode); uleb(&mut self.f, s as u64); }
    pub fn get_raw(&mut self, l: u32) { self.raw(0x20, l) }
    pub fn set_raw(&mut self, l: u32) { self.raw(0x21, l) }
    pub fn tee_raw(&mut self, l: u32) { self.raw(0x22, l) }

    // ---- Registers and their globals ----
    pub fn save(&mut self) { self.sync_in(true, ALL); }
    pub fn load(&mut self) { self.sync_in(false, ALL); }
    /// A sync (put in by `finish`, once the whole function says what it moves) that moves at most `scope`.
    pub(crate) fn sync_in(&mut self, save: bool, scope: u32) {
        self.syncs.push((self.f.len(), save, scope));
        self.note(Ev::Sync(self.syncs.len() as u32 - 1, self.nest == 0));
    }

    // ---- Labels ----
    pub(crate) fn open(&mut self, l: Lab) {
        let at = Some(self.labels.len() as u32);
        match l { Lab::Block(b) => self.block_at[b] = at, Lab::Loop(i) => self.loop_at[i] = at }
        self.labels.push(l);
    }
    pub(crate) fn close(&mut self, l: Lab) {
        debug_assert_eq!(self.labels.last(), Some(&l), "labels closed out of order");
        self.labels.pop();
        match l { Lab::Block(b) => self.block_at[b] = None, Lab::Loop(i) => self.loop_at[i] = None }
    }
    /// The depth of a br from here to the label at `at` among those open.
    pub(crate) fn to(&self, at: u32) -> u32 { self.depth - 1 - at }
    /// The depth of a br to `address` when it is a block after this one whose label is open.
    pub(crate) fn forward(&self, target: u32) -> Option<u32> {
        let b = (target != NO && target as usize > self.at).then_some(target as usize)?;
        self.block_at[b].map(|at| self.to(at))
    }
}
