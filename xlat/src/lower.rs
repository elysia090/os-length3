//! Lower recovered functions to one WebAssembly module.
//!
//! Guest memory is wasm memory 0 with guest address == wasm address, so a
//! guest load is one wasm load. Registers live in locals inside a function
//! and in globals across calls. Flags are deferred: producers record their
//! operands and consumers evaluate only the condition they need, so a
//! `cmp`/`jcc` pair becomes one comparison. Functions are wasm functions;
//! a return compares the popped address with the expected continuation and
//! hands anything unexpected (longjmp, tail tricks) to the dispatcher.

use crate::discover::{Block, Exit, Function, Program};
use crate::elf::Elf;
use iced_x86::{ConditionCode, Instruction, Mnemonic, OpKind, Register, RflagsBits};
use std::borrow::Cow;
use std::collections::BTreeMap;
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, CustomSection, DataSection, ElementSection, Elements, EntityType, ExportKind,
    ExportSection, Function as WasmFunction, FunctionSection, GlobalSection, GlobalType, ImportSection,
    Instruction as W, MemArg, MemoryType, Module, RefType, TableSection, TableType, TypeSection, ValType,
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
const T_FPU: u32 = 8; // (op, size, address, st a, st b) -> i32
const T_TRACE: u32 = 9; // (i64) -> ()

const F_SYSCALL: u32 = 0;
const F_TRAP: u32 = 1;
const F_DIV128: u32 = 2;
const F_CLOCK: u32 = 3;
const F_FPU: u32 = 4;
const F_TRACE: u32 = 5;
/// The host's answer for code not translated yet: the entry (function << 32 | block), or -1.
const F_MISS: u32 = 6;
const F_MULHU: u32 = 7;
const F_MULHS: u32 = 8;
const F_RESOLVE: u32 = 9;
const F_DISPATCH: u32 = 10;
#[allow(dead_code)] // run is exported with the shared helpers, as SHARED[4]
const F_RUN: u32 = 11;
const FIRST_GUEST: u32 = 12;
/// Imported functions, in index order: the host's, then (in a module made later) the first module's.
const HOST_IMPORTS: [&str; 7] = ["syscall", "trap", "div128", "clock", "fpu", "trace", "miss"];
const SHARED: [&str; 5] = ["mulhu", "mulhs", "resolve", "dispatch", "run"];
/// Globals every module of a program shares: r0..r15, fs, x0..x15, and the
/// flags handed from one function to another (fl).
const GLOBALS: u32 = 34;
fn global_name(n: u32) -> String { if n < 16 { format!("r{n}") } else if n == G_FS { "fs".into() } else if n == G_FLAGS { "fl".into() } else { format!("x{}", n - 17) } }
fn global_type(n: u32) -> ValType { if n < 17 || n == G_FLAGS { ValType::I64 } else { ValType::V128 } }

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

const ALL_FLAGS: u32 = RflagsBits::OF | RflagsBits::SF | RflagsBits::ZF | RflagsBits::CF | RflagsBits::PF;

fn mem(align: u32) -> MemArg {
    MemArg { offset: 0, align, memory_index: 0 }
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
    /// The function being made: each instruction is encoded as it is emitted.
    f: WasmFunction,
    flags: Flags,
    /// Nesting of wasm blocks between the current code and the dispatch loop.
    depth: u32,
    program: &'p Program,
    function: &'p Function,
    report: &'p mut Report,
    /// Flags each entry reads before writing them (entry_flags).
    handed: &'p BTreeMap<u64, u32>,
    uses_xmm: bool,
    /// Direction flag, tracked statically within a block (std ... cld).
    backward: bool,
}

#[derive(Clone, Copy)]
enum Part { Full, Low32, Low16, Low8, High8 }

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
    fn e(&mut self, i: I) { self.f.instruction(&i); }
    // The most frequent, straight to their bytes.
    fn get(&mut self, l: u32) { self.f.instructions().local_get(l); }
    fn set(&mut self, l: u32) { self.f.instructions().local_set(l); }
    fn c64(&mut self, v: i64) { self.f.instructions().i64_const(v); }
    fn c32(&mut self, v: i32) { self.f.instructions().i32_const(v); }
    fn gget(&mut self, g: u32) { self.f.instructions().global_get(g); }
    fn gset(&mut self, g: u32) { self.f.instructions().global_set(g); }

    fn unsupported(&mut self, i: &Instruction) {
        *self.report.unsupported.entry(format!("{:?}", i.mnemonic())).or_default() += 1;
        self.c64(i.ip() as i64);
        self.c32(TRAP_UNSUPPORTED);
        self.e(W::Call(F_TRAP));
        self.e(W::Unreachable);
    }

    // ---- Register file ----

    fn save(&mut self) {
        for n in 0..16 {
            self.get(l_reg(n));
            self.gset(n);
        }
        if self.uses_xmm {
            for n in 0..16 {
                self.get(l_x(n));
                self.gset(g_xmm(n));
            }
        }
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
        self.flags = Flags::Held;
    }

    fn load(&mut self) {
        for n in 0..16 {
            self.gget(n);
            self.set(l_reg(n));
        }
        if self.uses_xmm {
            for n in 0..16 {
                self.gget(g_xmm(n));
                self.set(l_x(n));
            }
        }
    }

    /// Push a register's value, zero-extended from its width.
    fn read_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        self.get(l_reg(n));
        match part {
            Part::Full => {}
            Part::Low32 => { self.c64(0xffff_ffff); self.e(W::I64And); }
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
            Part::Low32 => { self.c64(0xffff_ffff); self.e(W::I64And); self.set(l); }
            Part::Low16 | Part::Low8 | Part::High8 => {
                let (m, shift) = match part { Part::Low16 => (0xffffi64, 0), Part::Low8 => (0xff, 0), _ => (0xff, 8) };
                self.c64(m); self.e(W::I64And);
                if shift > 0 { self.c64(shift); self.e(W::I64Shl); }
                self.get(l); self.c64(!(m << shift)); self.e(W::I64And);
                self.e(W::I64Or);
                self.set(l);
            }
        }
        true
    }

    // ---- Memory operands ----

    /// Push the effective address as i64 (no segment base unless `segment`).
    fn effective(&mut self, i: &Instruction, segment: bool) {
        let base = i.memory_base();
        if base == Register::RIP || base == Register::EIP {
            self.c64(i.memory_displacement64() as i64);
        } else {
            self.c64(i.memory_displacement64() as i64);
            if base != Register::None {
                self.read_reg(base);
                self.e(W::I64Add);
            }
            let index = i.memory_index();
            if index != Register::None {
                self.read_reg(index);
                let scale = i.memory_index_scale();
                if scale > 1 {
                    self.c64(scale.trailing_zeros() as i64);
                    self.e(W::I64Shl);
                }
                self.e(W::I64Add);
            }
        }
        if segment && i.memory_segment() == Register::FS {
            self.e(W::GlobalGet(G_FS));
            self.e(W::I64Add);
        }
    }

    fn address(&mut self, i: &Instruction) {
        self.effective(i, true);
        self.e(W::I32WrapI64);
    }

    fn load_sized(&mut self, size: u8) {
        self.e(match size {
            1 => W::I64Load8U(mem(0)),
            2 => W::I64Load16U(mem(0)),
            4 => W::I64Load32U(mem(0)),
            _ => W::I64Load(mem(0)),
        });
    }

    fn store_sized(&mut self, size: u8) {
        self.e(match size {
            1 => W::I64Store8(mem(0)),
            2 => W::I64Store16(mem(0)),
            4 => W::I64Store32(mem(0)),
            _ => W::I64Store(mem(0)),
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
            OpKind::Memory => { self.address(i); self.load_sized(size); true }
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
            OpKind::Memory => { self.address(i); self.get(from); self.store_sized(size); true }
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
        self.get(l_reg(RSP)); self.c64(8); self.e(W::I64Sub); self.set(l_reg(RSP));
        self.get(l_reg(RSP)); self.e(W::I32WrapI64); self.get(from); self.e(W::I64Store(mem(3)));
    }

    fn pop_value(&mut self, into: u32) {
        self.get(l_reg(RSP)); self.e(W::I32WrapI64); self.e(W::I64Load(mem(3))); self.set(into);
        self.get(l_reg(RSP)); self.c64(8); self.e(W::I64Add); self.set(l_reg(RSP));
    }

    // ---- Flags ----

    fn sign_bit(&mut self, local: u32, size: u8) {
        self.get(local);
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
            Flag::Z => { self.get(L_FR); self.e(W::I64Eqz); }
            Flag::S => self.sign_bit(L_FR, size),
            Flag::P => {
                self.get(L_FR); self.c64(0xff); self.e(W::I64And); self.e(W::I64Popcnt);
                self.c64(1); self.e(W::I64And); self.e(W::I64Eqz);
            }
            Flag::C => match kind {
                0 => { self.get(L_FA); self.get(L_FB); self.e(W::I64LtU); }
                1 => { self.get(L_FR); self.get(L_FA); self.e(W::I64LtU); }
                2 => self.c32(0),
                _ => self.get(L_CF),
            },
            Flag::O => match kind {
                0 | 4 => {
                    // (a ^ b) & (a ^ r), sign bit
                    self.get(L_FA); self.get(L_FB); self.e(W::I64Xor);
                    self.get(L_FA); self.get(L_FR); self.e(W::I64Xor);
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
        self.flags = Flags::Held;
    }

    /// Push the truth of condition `cc` as i32.
    fn condition(&mut self, cc: ConditionCode) {
        use ConditionCode as C;
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
                C::e => { self.get(L_FR); self.e(W::I64Eqz); return; }
                C::ne => { self.get(L_FR); self.c64(0); self.e(W::I64Ne); return; }
                C::s | C::l => { self.sign_bit(L_FR, size); return; }
                C::ns | C::ge => { self.sign_bit(L_FR, size); self.e(W::I32Eqz); return; }
                C::le | C::g => {
                    self.get(L_FR); if size < 8 { self.sign_extend(size); } self.c64(0);
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
        self.flags = state;
    }

    // ---- Control helpers ----

    /// Continue at `address`: fall through if it is the next block, else
    /// jump through the dispatch loop, else leave the function.
    fn goto(&mut self, address: u64, next: Option<u64>) {
        if Some(address) == next {
            return;
        }
        match self.function.block_index(address) {
            Some(b) => {
                self.c32(b as i32);
                self.set(L_BLK);
                self.e(W::Br(self.depth));
            }
            None => self.tail(address),
        }
    }

    /// Transfer to code outside this function without growing the stack.
    fn tail(&mut self, address: u64) {
        self.save();
        self.save_flags(handed(self.handed, address));
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

    /// After a call returned `next address` in l_t(0): continue at `ret`
    /// if that is where the callee returned, else propagate upward.
    fn after_call(&mut self, ret: u64, next: Option<u64>) {
        self.get(l_t(0)); self.c64(ret as i64); self.e(W::I64Ne);
        self.e(W::If(BlockType::Empty));
        self.get(l_t(0)); self.e(W::Return);
        self.e(W::End);
        self.load();
        self.flags = Flags::Held;
        self.goto(ret, next);
    }
}

// ---- Instruction semantics ----

impl Fx<'_> {
    fn binary(&mut self, i: &Instruction, op: Mnemonic) -> bool {
        let size = Self::size(i, 0);
        if !self.read(i, 0, size) { return false; }
        self.set(L_FA);
        if !self.read(i, 1, size) { return false; }
        self.set(L_FB);
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
        self.get(L_FA); self.get(L_FB); self.e(wasm); self.mask_to(size); self.set(L_FR);
        self.defer(state);
        !write || self.write(i, 0, size, L_FR)
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
        self.flags = if subtract { Flags::Sub(size) } else { Flags::Add(size) };
        for (f, l) in [(Flag::Z, L_ZF), (Flag::S, L_SF), (Flag::O, L_OF), (Flag::P, L_PF)] {
            self.flag(f);
            self.set(l);
        }
        self.get(l_u(0)); self.set(L_CF);
        self.flags = Flags::Held;
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
            self.flags = Flags::Held;
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

    fn cpuid(&mut self) {
        // A plain core: SSE2 and SSE3, CMPXCHG16B and POPCNT; no SSSE3, SSE4 or AVX, so a
        // libc choosing its string routines by cpuid takes the SSE2 ones xlat translates.
        self.get(l_reg(RAX)); self.c64(0xffff_ffff); self.e(W::I64And); self.e(W::I64Eqz);
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
            Mov => {
                let size = Self::size(i, 0);
                if xmm(i.op0_register()).is_some() || xmm(i.op1_register()).is_some() { false } else {
                    self.read(i, 1, size) && { self.set(l_t(1)); self.write(i, 0, size, l_t(1)) }
                }
            }
            Movzx => {
                let (src, dst) = (Self::size(i, 1), Self::size(i, 0));
                self.read(i, 1, src) && { self.set(l_t(1)); self.write(i, 0, dst, l_t(1)) }
            }
            Movsx | Movsxd => {
                let (src, dst) = (Self::size(i, 1), Self::size(i, 0));
                self.read(i, 1, src) && {
                    self.sign_extend(src); self.mask_to(dst); self.set(l_t(1)); self.write(i, 0, dst, l_t(1))
                }
            }
            Lea => {
                let size = Self::size(i, 0);
                self.effective(i, false); self.mask_to(size); self.set(l_t(1));
                self.write(i, 0, size, l_t(1))
            }
            Add | Sub | Cmp | And | Test | Or | Xor => {
                // xor r, r is the idiom for zero: skip the read.
                if m == Xor && i.op0_kind() == OpKind::Register && i.op1_kind() == OpKind::Register
                    && i.op0_register() == i.op1_register() && !need {
                    self.c64(0); self.set(l_t(1));
                    self.write(i, 0, Self::size(i, 0), l_t(1))
                } else {
                    self.binary(i, m)
                }
            }
            Adc => self.carry(i, false),
            Sbb => self.carry(i, true),
            Inc | Dec | Neg | Not => self.unary(i, m),
            Shl | Sal | Shr | Sar | Rol | Ror => self.shift(i, m, need),
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
                self.read(i, 0, size) && {
                    if i.op0_kind() != OpKind::Register && i.op0_kind() != OpKind::Memory { self.sign_extend(size); }
                    self.set(l_t(1)); self.push_value(l_t(1)); true
                }
            }
            Pop => {
                // The destination address uses rsp after the increment.
                self.pop_value(l_t(1));
                self.write(i, 0, 8, l_t(1))
            }
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
                // The last argument is where execution resumes; a forked
                // child starts there.
                for r in [RAX, RDI, RSI, RDX, 10, 8, 9] { self.get(l_reg(r)); }
                self.c64(i.next_ip() as i64);
                self.e(W::Call(F_SYSCALL));
                self.set(l_t(1));
                self.load();
                self.get(l_t(1)); self.set(l_reg(RAX));
                self.c64(i.next_ip() as i64); self.set(l_reg(RCX));
                // The flags come back as they were, held or not.
                true
            }
            Cpuid => { self.cpuid(); true }
            Rdtsc => {
                self.e(W::Call(F_CLOCK)); self.set(l_t(1));
                self.get(l_t(1)); self.c64(0xffff_ffff); self.e(W::I64And); self.set(l_reg(RAX));
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
                    let limit = if size == 8 { 9.223372036854775808e18 } else { 2147483648.0 };
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
                    self.flags = Flags::Held;
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
                        self.e(W::I64x2ExtractLane(0)); self.c64(0xffff_ffff); self.e(W::I64And);
                        self.e(W::I64x2Splat); self.c64(0); self.e(W::I64x2ReplaceLane(1));
                    }
                    self.set(l_v(0));
                    self.xwrite(i, 0, 16, l_v(0))
                } else if is_x1 && !is_x0 && i.op0_kind() == OpKind::Register {
                    self.xread(i, 1, 16);
                    self.e(W::I64x2ExtractLane(0));
                    if bytes == 4 { self.c64(0xffff_ffff); self.e(W::I64And); }
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
            _ => false,
        }
    }
}

// ---- x87: an exact 80-bit coprocessor in the host ----

/// x87 operations the host implements, in the order of the `fpu` op index.
/// The list is embedded in the module so host and translator cannot drift.
const X87_OPS: &[&str] = &[
    "fld", "fild", "fst", "fstp", "fist", "fistp", "fisttp",
    "fld1", "fldz", "fldpi", "fldl2e", "fldln2", "fldlg2", "fldl2t",
    "fadd", "faddp", "fmul", "fmulp", "fsub", "fsubp", "fsubr", "fsubrp", "fdiv", "fdivp", "fdivr", "fdivrp",
    "fiadd", "fimul", "fisub", "fisubr", "fidiv", "fidivr",
    "fchs", "fabs", "fsqrt", "frndint", "fxch",
    "fucomi", "fcomi", "fucomip", "fcomip",
    "fucom", "fcom", "fucomp", "fcomp", "fucompp", "fcompp", "ftst",
    "fnstsw", "fnstcw", "fldcw", "fninit", "fnclex", "fwait", "fnop", "ffree", "ffreep", "fincstp", "fdecstp",
    "fprem", "fprem1", "fscale", "f2xm1", "fyl2x", "fyl2xp1", "fpatan", "fsin", "fcos", "fptan", "fxam", "fxtract",
];

fn st(r: Register) -> Option<u32> {
    let n = r as u32;
    (Register::ST0 as u32..=Register::ST7 as u32).contains(&n).then(|| n - Register::ST0 as u32)
}

impl Fx<'_> {
    /// One x87 instruction: fpu(op, memory size, address, st a, st b) -> i32.
    /// The result carries flags for fcomi (CF|ZF<<1|PF<<2) or a 16-bit
    /// value for fnstsw/fnstcw; memory operands are read and written by the
    /// host directly.
    fn x87(&mut self, i: &Instruction) -> Option<bool> {
        let name = format!("{:?}", i.mnemonic()).to_ascii_lowercase();
        let name = if name == "wait" { "fwait".to_string() } else { name };
        let op = X87_OPS.iter().position(|&n| n == name)?;
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
        // Integer forms tell the host the memory holds an integer.
        let integer = name.starts_with("fi") && name != "fincstp";
        self.c32(op as i32);
        self.c32(if integer { -size } else { size });
        if memory { self.address(i); } else { self.c32(0); }
        self.c32(a); self.c32(b);
        self.e(W::Call(F_FPU));
        match name.as_str() {
            "fucomi" | "fcomi" | "fucomip" | "fcomip" => {
                self.set(l_u(0));
                for (bit, l) in [(0, L_CF), (1, L_ZF), (2, L_PF)] {
                    self.get(l_u(0)); if bit > 0 { self.c32(bit); self.e(W::I32ShrU); } self.c32(1); self.e(W::I32And); self.set(l);
                }
                self.c32(0); self.set(L_OF); self.c32(0); self.set(L_SF);
                self.flags = Flags::Held;
            }
            "fnstsw" if !memory => {
                self.e(W::I64ExtendI32U); self.write_reg(Register::AX);
            }
            _ => self.e(W::Drop),
        }
        Some(true)
    }
}

// ---- Flag liveness ----

// A system call keeps the flags here (r11 is not given them), so it neither reads nor writes them.
fn flags_read(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_read() & ALL_FLAGS } }
fn flags_written(i: &Instruction) -> u32 { if i.mnemonic() == Mnemonic::Syscall { 0 } else { i.rflags_modified() & ALL_FLAGS } }

/// The flags code going on to `address`, outside the function, must hand
/// over: those its entry reads first, or all of them where it is not known
/// (code found later).
fn handed(handed: &BTreeMap<u64, u32>, address: u64) -> u32 {
    handed.get(&address).copied().unwrap_or(ALL_FLAGS)
}

/// The blocks of `f` that `b` goes on to by a fall or a jump, and the flags
/// code it goes on to outside them reads first.
fn successors(f: &Function, b: &Block, outside: &BTreeMap<u64, u32>) -> (Vec<usize>, u32) {
    let mut out = Vec::new();
    let mut ext = 0;
    let mut add = |a: u64| match f.block_index(a) { Some(k) => out.push(k), None => ext |= handed(outside, a) };
    match b.exit {
        Exit::Fall(a) | Exit::Jump(a) | Exit::TailJump(a) => add(a),
        Exit::Branch { taken, fall } => { add(taken); add(fall); }
        _ => {}
    }
    (out, ext)
}

/// The flags each entry of the program reads before it writes them. The
/// post-link compiler gives states whose futures are equal one body, across
/// functions too, so a compare can end one function and the jump that reads
/// it begin another; such an entry is handed what it reads in G_FLAGS.
/// Every other entry reads none and costs nothing. The least fixed point:
/// each entry starts reading nothing and grows to what its code reads.
fn entry_flags(program: &Program) -> BTreeMap<u64, u32> {
    let mut map: BTreeMap<u64, u32> = program.entries.keys().map(|&a| (a, 0)).collect();
    let mut todo: Vec<usize> = (0..program.functions.len()).collect();
    while !todo.is_empty() {
        let mut changed = false;
        let mut again = Vec::new();
        for &fi in &todo {
            let f = &program.functions[fi];
            let (live, _) = live_flags(program, fi as u32, &map);
            // Only a function that goes on to code outside it can change again.
            let mut leaves = false;
            for (k, b) in f.blocks.iter().enumerate() {
                let outside = |a: u64| f.block_index(a).is_none();
                leaves |= match b.exit {
                    Exit::Fall(a) | Exit::Jump(a) | Exit::TailJump(a) => outside(a),
                    Exit::Branch { taken, fall } => outside(taken) || outside(fall),
                    _ => false,
                };
                if program.entries.get(&b.start) == Some(&(fi as u32, k as u32)) && map[&b.start] != live[k] {
                    map.insert(b.start, live[k]);
                    changed = true;
                }
            }
            if leaves { again.push(fi); }
        }
        if !changed { break; }
        todo = again;
    }
    map
}

/// Flags live on entry to each block, as an RflagsBits mask, and those the
/// function's entries read: an indirect jump lands on one of them (a case of
/// a jump table), so it keeps those.
fn live_flags(program: &Program, index: u32, outside: &BTreeMap<u64, u32>) -> (Vec<u32>, u32) {
    let f = &program.functions[index as usize];
    let n = f.blocks.len();
    let entry: Vec<bool> = f.blocks.iter().enumerate().map(|(k, b)| program.entries.get(&b.start) == Some(&(index, k as u32))).collect();
    let mut cases = 0;
    let summary: Vec<(u32, u32)> = f.blocks.iter().map(|b| {
        let (mut used, mut defined) = (0, 0);
        for i in &b.code {
            used |= flags_read(i) & !defined;
            defined |= flags_written(i);
        }
        (used, defined)
    }).collect();
    let mut live_in = vec![0u32; n];
    loop {
        let mut changed = false;
        for k in (0..n).rev() {
            let (succ, ext) = successors(f, &f.blocks[k], outside);
            let ext = if f.blocks[k].exit == Exit::IndirectJump { cases } else { ext };
            let out = succ.iter().fold(ext, |acc, &s| acc | live_in[s]);
            let new = summary[k].0 | (out & !summary[k].1);
            if new != live_in[k] {
                live_in[k] = new;
                if entry[k] { cases |= new; }
                changed = true;
            }
        }
        if !changed {
            return (live_in, cases);
        }
    }
}

// ---- Functions ----

fn lower_function(program: &Program, index: u32, handed: &BTreeMap<u64, u32>, options: Options, report: &mut Report) -> WasmFunction {
    let function = &program.functions[index as usize];
    let (live, cases) = live_flags(program, index, handed);
    let n = function.blocks.len() as u32;
    // Decide before lowering whether xmm state travels with this function,
    // so saves and reloads around every call agree with the prologue.
    let uses_xmm = function.blocks.iter().flat_map(|b| &b.code).any(|i| {
        (0..i.op_count()).any(|n| i.op_kind(n) == OpKind::Register && xmm(i.op_register(n)).is_some())
    });
    let f = WasmFunction::new([
        (16, ValType::I64), (1, ValType::I32), (5, ValType::I32), (3, ValType::I64), (6, ValType::I64),
        (2, ValType::I32), (16, ValType::V128), (2, ValType::V128), (2, ValType::F64),
    ]);
    let mut fx = Fx { f, flags: Flags::Held, depth: 0, program, function, report, handed, uses_xmm, backward: false };

    // Everything the prologue depends on is known, so the function is made in order.
    fx.get(L_ENTRY); fx.set(L_BLK);
    fx.load();
    // What the entries handed flags read (almost always none).
    fx.load_flags(cases);
    fx.e(W::Loop(BlockType::Empty));
    for _ in 0..n { fx.e(W::Block(BlockType::Empty)); }
    fx.get(L_BLK);
    let targets: Vec<u32> = (0..n).collect();
    fx.e(W::BrTable(Cow::Owned(targets), 0));
    for (k, block) in function.blocks.iter().enumerate() {
        // Close block k's label so its code starts here; code k sits inside
        // the labels of blocks k+1..n-1 and then the loop.
        fx.e(W::End);
        fx.depth = n - 1 - k as u32;
        fx.flags = Flags::Held;
        fx.backward = false;
        fx.report.blocks += 1;
        if options.trace {
            fx.c64(block.start as i64);
            fx.e(W::Call(F_TRACE));
        }
        let next = function.blocks.get(k + 1).map(|b| b.start);
        let (succ, ext) = successors(function, block, handed);
        // An indirect jump may land on an entry of this function, whose flags stay in the locals.
        let held = succ.iter().fold(0, |acc, &s| acc | live[s]) | if block.exit == Exit::IndirectJump { cases } else { 0 };
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
                fx.e(W::If(BlockType::Empty));
                fx.depth += 1;
                fx.goto(taken, None);
                fx.depth -= 1;
                fx.e(W::End);
                fx.goto(fall, next);
            }
            Exit::IndirectJump => {
                fx.read(&term, 0, 8);
                fx.set(l_t(0));
                fx.get(l_t(0)); fx.e(W::Call(F_RESOLVE)); fx.set(l_t(1));
                fx.get(l_t(1)); fx.c64(32); fx.e(W::I64ShrU); fx.c64(index as i64); fx.e(W::I64Eq);
                fx.e(W::If(BlockType::Empty));
                fx.get(l_t(1)); fx.e(W::I32WrapI64); fx.set(L_BLK);
                fx.e(W::Br(fx.depth + 1));
                fx.e(W::End);
                fx.save();
                // Elsewhere, it is handed what this function's own cases read.
                fx.save_flags(cases);
                fx.get(l_t(0)); fx.e(W::ReturnCall(F_DISPATCH));
            }
            Exit::Call { target, ret } => {
                fx.c64(ret as i64); fx.set(l_t(1)); fx.push_value(l_t(1));
                fx.save();
                match program.entries.get(&target) {
                    Some(&(f, b)) => { fx.c32(b as i32); fx.e(W::Call(FIRST_GUEST + f)); }
                    None => { fx.c64(target as i64); fx.e(W::Call(F_DISPATCH)); }
                }
                fx.set(l_t(0));
                fx.after_call(ret, next);
            }
            Exit::IndirectCall { ret } => {
                // The target is read before the return address is pushed.
                fx.read(&term, 0, 8);
                fx.set(l_t(2));
                fx.c64(ret as i64); fx.set(l_t(1)); fx.push_value(l_t(1));
                fx.save();
                fx.get(l_t(2)); fx.e(W::Call(F_DISPATCH));
                fx.set(l_t(0));
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
                fx.c32(if term.mnemonic() == Mnemonic::Ud2 || term.mnemonic() == Mnemonic::Hlt || term.mnemonic() == Mnemonic::Int3 { TRAP_UNSUPPORTED } else { TRAP_UNDECODED });
                fx.e(W::Call(F_TRAP));
                fx.e(W::Unreachable);
            }
        }
    }
    // Leaving the last block falls out of the loop.
    fx.e(W::End);
    fx.e(W::Unreachable);
    fx.e(W::End);
    fx.f
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

    // resolve(addr): binary search the sorted 16-byte entries in memory 1.
    let m1 = |offset| MemArg { offset: table + offset, align: 3, memory_index: 0 };
    let mut f = WasmFunction::new([(3, ValType::I32), (1, ValType::I64)]);
    let (addr, lo, hi, mid, key) = (0, 1, 2, 3, 4);
    for i in [
        W::I32Const(0), W::LocalSet(lo), W::I32Const(entries as i32), W::LocalSet(hi),
        W::Block(BlockType::Empty), W::Loop(BlockType::Empty),
        W::LocalGet(lo), W::LocalGet(hi), W::I32GeU, W::BrIf(1),
        W::LocalGet(lo), W::LocalGet(hi), W::I32Add, W::I32Const(1), W::I32ShrU, W::LocalSet(mid),
        W::LocalGet(mid), W::I32Const(4), W::I32Shl, W::I64Load(m1(0)), W::LocalTee(key),
        W::LocalGet(addr), W::I64Eq,
        W::If(BlockType::Empty),
        W::LocalGet(mid), W::I32Const(4), W::I32Shl, W::I64Load(m1(8)), W::Return,
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
    let mc = |offset| MemArg { offset: cache + offset, align: 3, memory_index: 0 };
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

/// Every function of `program`, in order. Each is lowered on its own, so
/// natively they share the cores; wasm has one thread and lowers in turn.
fn lower_all(program: &Program, options: Options, report: &mut Report) -> Vec<WasmFunction> {
    let handed = entry_flags(program);
    let n = program.functions.len();
    let one = |range: std::ops::Range<usize>, report: &mut Report| -> Vec<WasmFunction> {
        range.map(|f| lower_function(program, f as u32, &handed, options, report)).collect()
    };
    let threads = if cfg!(target_family = "wasm") { 1 } else { std::thread::available_parallelism().map_or(1, |t| t.get()) };
    // A few functions are not worth a thread.
    if threads == 1 || n < 64 {
        return one(0..n, report);
    }
    let size = n.div_ceil(threads);
    let parts: Vec<(Vec<WasmFunction>, Report)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..n).step_by(size).map(|at| {
            let one = &one;
            scope.spawn(move || { let mut r = Report::default(); (one(at..(at + size).min(n), &mut r), r) })
        }).collect();
        workers.into_iter().map(|w| w.join().expect("a lowering thread panicked")).collect()
    });
    let mut out = Vec::with_capacity(n);
    for (functions, r) in parts {
        out.extend(functions);
        report.blocks += r.blocks;
        report.instructions += r.instructions;
        for (m, k) in r.unsupported { *report.unsupported.entry(m).or_default() += k; }
    }
    out
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
    types.ty().function([ValType::I32; 5], [ValType::I32]);
    types.ty().function([ValType::I64], []);
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
    let mut module = Module::new();
    module.section(&types());
    let mut imports = ImportSection::new();
    imports.import("env", "memory", EntityType::Memory(MemoryType { minimum: 1, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None }));
    let host_types = [T_SYSCALL, T_TRAP, T_DIV, T_CLOCK, T_FPU, T_TRACE, T_RESOLVE];
    for (name, ty) in HOST_IMPORTS.iter().zip(host_types) { imports.import("env", name, EntityType::Function(ty)); }
    for (name, ty) in SHARED.iter().zip([T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN]) { imports.import("main", name, EntityType::Function(ty)); }
    for n in 0..GLOBALS {
        imports.import("main", &global_name(n), EntityType::Global(GlobalType { val_type: global_type(n), mutable: true, shared: false }));
    }
    module.section(&imports);

    let mut functions = FunctionSection::new();
    for _ in &program.functions { functions.function(T_FN); }
    module.section(&functions);

    // Its functions go in a table of its own, which the host copies into the
    // first module's from `base`. It does not import that table: an engine
    // keeps each instance that imports a table up to date on every change to
    // it, so with every module importing it, each one made every later one
    // slower to make and the table slower to grow.
    let mut tables = TableSection::new();
    let count = program.functions.len() as u64;
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count, maximum: Some(count), table64: false, shared: false });
    module.section(&tables);
    let mut exports = ExportSection::new();
    exports.export("table", ExportKind::Table, 0);
    module.section(&exports);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));
    module.section(&elements);

    let mut code = CodeSection::new();
    for f in lower_all(program, options, &mut report) { code.function(&f); }
    module.section(&code);

    let mut table = Vec::with_capacity(program.entries.len() * 16);
    for (&address, &(f, b)) in &program.entries {
        table.extend_from_slice(&address.to_le_bytes());
        table.extend_from_slice(&((((f + base) as u64) << 32) | b as u64).to_le_bytes());
    }
    module.section(&CustomSection { name: Cow::Borrowed("xlat.entries"), data: Cow::Owned(table) });
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    module.section(&CustomSection { name: Cow::Borrowed("xlat.starts"), data: Cow::Owned(starts) });

    Translation { wasm: module.finish(), report }
}

pub fn translate(elf: &Elf, program: &Program, options: Options) -> Translation {
    let mut report = Report { functions: program.functions.len(), entries: program.entries.len(), ..Default::default() };
    let mut module = Module::new();

    module.section(&types());

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
    module.section(&imports);

    let mut functions = FunctionSection::new();
    for ty in [T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN] { functions.function(ty); }
    for _ in &program.functions { functions.function(T_FN); }
    module.section(&functions);

    let mut tables = TableSection::new();
    let count = program.functions.len() as u64;
    // It grows as code reached later is translated into modules of its own.
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count, maximum: None, table64: false, shared: false });
    module.section(&tables);

    let entries = program.entries.len() as u64;

    let mut globals = GlobalSection::new();
    for _ in 0..17 {
        globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(0));
    }
    for _ in 0..16 {
        globals.global(GlobalType { val_type: ValType::V128, mutable: true, shared: false }, &ConstExpr::v128_const(0));
    }
    globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(0));
    module.section(&globals);

    let mut exports = ExportSection::new();
    // What a module made later for this program imports: the helpers, every register, the table.
    for (k, name) in SHARED.iter().enumerate() { exports.export(name, ExportKind::Func, F_MULHU + k as u32); }
    for n in 0..GLOBALS { exports.export(&global_name(n), ExportKind::Global, n); }
    exports.export("table", ExportKind::Table, 0);
    module.section(&exports);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));
    module.section(&elements);

    let mut code = CodeSection::new();
    helpers(&mut code, entries as u32, table_base, cache);
    for f in lower_all(program, options, &mut report) { code.function(&f); }
    module.section(&code);

    let mut data = DataSection::new();
    for s in &elf.segments {
        if !s.data.is_empty() {
            data.active(0, &ConstExpr::i32_const(s.vaddr as i32), s.data.iter().copied());
        }
    }
    let mut table = Vec::with_capacity(program.entries.len() * 16);
    for (&address, &(f, b)) in &program.entries {
        table.extend_from_slice(&address.to_le_bytes());
        table.extend_from_slice(&(((f as u64) << 32) | b as u64).to_le_bytes());
    }
    data.active(0, &ConstExpr::i32_const(table_base as i32), table);
    module.section(&data);

    let mut names = wasm_encoder::NameMap::new();
    for (k, n) in HOST_IMPORTS.iter().chain(SHARED.iter()).enumerate() {
        names.append(k as u32, n);
    }
    for (k, f) in program.functions.iter().enumerate() {
        names.append(FIRST_GUEST + k as u32, &format!("{}@{:x}", f.name, f.start));
    }
    let mut name_section = wasm_encoder::NameSection::new();
    name_section.functions(&names);
    module.section(&name_section);

    // Loader facts for the host, as a small JSON custom section.
    let tls = elf.tls.as_ref().map(|t| format!(",\"tls\":{{\"vaddr\":{},\"filesz\":{},\"memsz\":{},\"align\":{}}}", t.vaddr, t.filesz, t.memsz, t.align)).unwrap_or_default();
    let facts = format!(
        "{{\"entry\":{},\"imageStart\":{},\"imageEnd\":{},\"phdr\":{},\"phnum\":{},\"phent\":56{}}}",
        elf.entry, image_start(elf), end, elf.phdr_address().unwrap_or(0), elf.phnum, tls
    );
    module.section(&CustomSection { name: Cow::Borrowed("xlat.facts"), data: Cow::Owned(facts.into_bytes()) });
    module.section(&CustomSection { name: Cow::Borrowed("xlat.fpu"), data: Cow::Owned(X87_OPS.join(",").into_bytes()) });
    // Where each function starts, so code translated later stops there instead of repeating it.
    let starts: Vec<u8> = program.functions.iter().flat_map(|f| f.start.to_le_bytes()).collect();
    module.section(&CustomSection { name: Cow::Borrowed("xlat.starts"), data: Cow::Owned(starts) });


    Translation { wasm: module.finish(), report }
}
