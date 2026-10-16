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
    Instruction as W, MemArg, MemorySection, MemoryType, Module, RefType, TableSection, TableType, TypeSection, ValType,
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

const F_SYSCALL: u32 = 0;
const F_TRAP: u32 = 1;
const F_DIV128: u32 = 2;
const F_CLOCK: u32 = 3;
const F_MULHU: u32 = 4;
const F_MULHS: u32 = 5;
const F_RESOLVE: u32 = 6;
const F_DISPATCH: u32 = 7;
const F_RUN: u32 = 8;
const FIRST_GUEST: u32 = 9;

const G_FS: u32 = 16;
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
    code: Vec<I>,
    flags: Flags,
    /// Nesting of wasm blocks between the current code and the dispatch loop.
    depth: u32,
    program: &'p Program,
    function: &'p Function,
    report: &'p mut Report,
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
    fn e(&mut self, i: I) { self.code.push(i); }
    fn get(&mut self, l: u32) { self.e(W::LocalGet(l)); }
    fn set(&mut self, l: u32) { self.e(W::LocalSet(l)); }
    fn c64(&mut self, v: i64) { self.e(W::I64Const(v)); }
    fn c32(&mut self, v: i32) { self.e(W::I32Const(v)); }

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
            self.e(W::GlobalSet(n));
        }
        if self.uses_xmm {
            for n in 0..16 {
                self.get(l_x(n));
                self.e(W::GlobalSet(g_xmm(n)));
            }
        }
    }

    fn load(&mut self) {
        for n in 0..16 {
            self.e(W::GlobalGet(n));
            self.set(l_reg(n));
        }
        if self.uses_xmm {
            for n in 0..16 {
                self.e(W::GlobalGet(g_xmm(n)));
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
        // A plain x86-64-v2 core: SSE through SSE4.2 and POPCNT, no AVX.
        self.get(l_reg(RAX)); self.c64(0xffff_ffff); self.e(W::I64And); self.e(W::I64Eqz);
        self.e(W::If(BlockType::Empty));
        self.c64(1); self.set(l_reg(RAX));
        self.c64(0x756e_6547); self.set(l_reg(3)); // "Genu"
        self.c64(0x4965_6e69); self.set(l_reg(RDX)); // "ineI"
        self.c64(0x6c65_746e); self.set(l_reg(RCX)); // "ntel"
        self.e(W::Else);
        self.c64(0x0006_06a6); self.set(l_reg(RAX));
        self.c64(0); self.set(l_reg(3));
        self.c64((1 << 0) | (1 << 9) | (1 << 13) | (1 << 19) | (1 << 20) | (1 << 23)); self.set(l_reg(RCX));
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
                if !(m == Movsd && i.op0_kind() == OpKind::Register) => self.string(i),
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
                for r in [RAX, RDI, RSI, RDX, 10, 8, 9] { self.get(l_reg(r)); }
                self.e(W::Call(F_SYSCALL));
                self.set(l_t(1));
                self.load();
                self.get(l_t(1)); self.set(l_reg(RAX));
                self.c64(i.next_ip() as i64); self.set(l_reg(RCX));
                self.flags = Flags::Held;
                true
            }
            Cpuid => { self.cpuid(); true }
            Rdtsc => {
                self.e(W::Call(F_CLOCK)); self.set(l_t(1));
                self.get(l_t(1)); self.c64(0xffff_ffff); self.e(W::I64And); self.set(l_reg(RAX));
                self.get(l_t(1)); self.c64(32); self.e(W::I64ShrU); self.set(l_reg(RDX));
                true
            }
            _ => self.vector(i),
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

    fn vector(&mut self, i: &Instruction) -> bool {
        use Mnemonic::*;
        let m = i.mnemonic();
        let is_x0 = i.op_count() > 0 && i.op0_kind() == OpKind::Register && xmm(i.op0_register()).is_some();
        let is_x1 = i.op_count() > 1 && i.op1_kind() == OpKind::Register && xmm(i.op1_register()).is_some();
        if !(is_x0 || is_x1) {
            return false;
        }
        self.uses_xmm = true;
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
            _ => false,
        }
    }
}

// ---- Flag liveness ----

fn flags_read(i: &Instruction) -> u32 { i.rflags_read() & ALL_FLAGS }
fn flags_written(i: &Instruction) -> u32 { i.rflags_modified() & ALL_FLAGS }

fn successors(f: &Function, b: &Block) -> (Vec<usize>, bool) {
    let mut out = Vec::new();
    let mut unknown = false;
    let mut add = |a: u64| match f.block_index(a) { Some(k) => out.push(k), None => {} };
    match b.exit {
        Exit::Fall(a) | Exit::Jump(a) => add(a),
        Exit::Branch { taken, fall } => { add(taken); add(fall); }
        Exit::IndirectJump => unknown = true,
        _ => {}
    }
    (out, unknown)
}

/// Flags live on entry to each block, as an RflagsBits mask.
fn live_flags(f: &Function) -> Vec<u32> {
    let n = f.blocks.len();
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
            let (succ, unknown) = successors(f, &f.blocks[k]);
            let out = if unknown { ALL_FLAGS } else { succ.iter().fold(0, |acc, &s| acc | live_in[s]) };
            let new = summary[k].0 | (out & !summary[k].1);
            if new != live_in[k] {
                live_in[k] = new;
                changed = true;
            }
        }
        if !changed {
            return live_in;
        }
    }
}

// ---- Functions ----

fn lower_function(program: &Program, index: u32, report: &mut Report) -> WasmFunction {
    let function = &program.functions[index as usize];
    let live = live_flags(function);
    let n = function.blocks.len() as u32;
    let mut fx = Fx { code: Vec::new(), flags: Flags::Held, depth: 0, program, function, report, uses_xmm: false, backward: false };

    // Body first so we know whether xmm state must be loaded and saved.
    let mut body: Vec<I> = Vec::new();
    std::mem::swap(&mut fx.code, &mut body);
    for (k, block) in function.blocks.iter().enumerate() {
        // Close block k's label so its code starts here; code k sits inside
        // the labels of blocks k+1..n-1 and then the loop.
        fx.e(W::End);
        fx.depth = n - 1 - k as u32;
        fx.flags = Flags::Held;
        fx.backward = false;
        fx.report.blocks += 1;
        let next = function.blocks.get(k + 1).map(|b| b.start);
        let (succ, unknown) = successors(function, block);
        let live_out = if unknown { ALL_FLAGS } else { succ.iter().fold(0, |acc, &s| acc | live[s]) };
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
        if live_out != 0 && !matches!(block.exit, Exit::Branch { .. }) {
            fx.hold_flags();
        }
        match block.exit {
            Exit::Fall(a) | Exit::Jump(a) => fx.goto(a, next),
            Exit::TailJump(a) => fx.tail(a),
            Exit::Branch { taken, fall } => {
                fx.condition(term.condition_code());
                if live_out != 0 { fx.set(l_u(1)); fx.hold_flags(); fx.get(l_u(1)); }
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
    std::mem::swap(&mut fx.code, &mut body);

    let mut f = WasmFunction::new([
        (16, ValType::I64), (1, ValType::I32), (5, ValType::I32), (3, ValType::I64), (6, ValType::I64),
        (2, ValType::I32), (16, ValType::V128), (2, ValType::V128),
    ]);
    fx.get(L_ENTRY); fx.set(L_BLK);
    fx.load();
    fx.e(W::Loop(BlockType::Empty));
    for _ in 0..n { fx.e(W::Block(BlockType::Empty)); }
    fx.get(L_BLK);
    let targets: Vec<u32> = (0..n).collect();
    fx.e(W::BrTable(Cow::Owned(targets), 0));
    for i in fx.code.drain(..) { f.instruction(&i); }
    for i in &body { f.instruction(i); }
    f.instruction(&W::End);
    f
}

/// Helpers: 64x64 high products, entry resolution and the dispatcher.
fn helpers(code: &mut CodeSection, entries: u32) {
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
    let m1 = |offset| MemArg { offset, align: 3, memory_index: 1 };
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

    // dispatch(addr): enter the function holding addr at that block.
    let mut f = WasmFunction::new([(1, ValType::I64)]);
    for i in [
        W::LocalGet(0), W::Call(F_RESOLVE), W::LocalTee(1), W::I64Const(0), W::I64LtS,
        W::If(BlockType::Empty), W::LocalGet(0), W::I32Const(TRAP_UNMAPPED_TARGET), W::Call(F_TRAP), W::Unreachable, W::End,
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

pub struct Translation {
    pub wasm: Vec<u8>,
    pub report: Report,
}

/// Lowest address above every loaded segment, page aligned.
pub fn image_end(elf: &Elf) -> u64 {
    elf.segments.iter().map(|s| s.vaddr + s.memsz).max().unwrap_or(0).next_multiple_of(4096)
}

pub fn translate(elf: &Elf, program: &Program) -> Translation {
    let mut report = Report { functions: program.functions.len(), entries: program.entries.len(), ..Default::default() };
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I64]);
    types.ty().function([ValType::I64; 7], [ValType::I64]);
    types.ty().function([ValType::I64, ValType::I32], []);
    types.ty().function([ValType::I64, ValType::I64, ValType::I64, ValType::I32], [ValType::I64, ValType::I64]);
    types.ty().function([], [ValType::I64]);
    types.ty().function([ValType::I64, ValType::I64], [ValType::I64]);
    types.ty().function([ValType::I64], [ValType::I64]);
    types.ty().function([ValType::I64], []);
    module.section(&types);

    let mut imports = ImportSection::new();
    let pages = image_end(elf).div_ceil(65536);
    imports.import("env", "memory", EntityType::Memory(MemoryType {
        minimum: pages, maximum: Some(65536), memory64: false, shared: false, page_size_log2: None,
    }));
    imports.import("env", "syscall", EntityType::Function(T_SYSCALL));
    imports.import("env", "trap", EntityType::Function(T_TRAP));
    imports.import("env", "div128", EntityType::Function(T_DIV));
    imports.import("env", "clock", EntityType::Function(T_CLOCK));
    module.section(&imports);

    let mut functions = FunctionSection::new();
    for ty in [T_PAIR, T_PAIR, T_RESOLVE, T_RESOLVE, T_RUN] { functions.function(ty); }
    for _ in &program.functions { functions.function(T_FN); }
    module.section(&functions);

    let mut tables = TableSection::new();
    let count = program.functions.len() as u64;
    tables.table(TableType { element_type: RefType::FUNCREF, minimum: count, maximum: Some(count), table64: false, shared: false });
    module.section(&tables);

    let entries = program.entries.len() as u64;
    let mut memories = MemorySection::new();
    memories.memory(MemoryType { minimum: (entries * 16).div_ceil(65536).max(1), maximum: None, memory64: false, shared: false, page_size_log2: None });
    module.section(&memories);

    let mut globals = GlobalSection::new();
    for _ in 0..17 {
        globals.global(GlobalType { val_type: ValType::I64, mutable: true, shared: false }, &ConstExpr::i64_const(0));
    }
    for _ in 0..16 {
        globals.global(GlobalType { val_type: ValType::V128, mutable: true, shared: false }, &ConstExpr::v128_const(0));
    }
    module.section(&globals);

    let mut exports = ExportSection::new();
    exports.export("run", ExportKind::Func, F_RUN);
    for n in 0..16u32 { exports.export(&format!("r{n}"), ExportKind::Global, n); }
    exports.export("fs", ExportKind::Global, G_FS);
    module.section(&exports);

    let mut elements = ElementSection::new();
    let indices: Vec<u32> = (0..program.functions.len() as u32).map(|f| FIRST_GUEST + f).collect();
    elements.active(Some(0), &ConstExpr::i32_const(0), Elements::Functions(Cow::Owned(indices)));
    module.section(&elements);

    let mut code = CodeSection::new();
    helpers(&mut code, entries as u32);
    for f in 0..program.functions.len() as u32 {
        code.function(&lower_function(program, f, &mut report));
    }
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
    data.active(1, &ConstExpr::i32_const(0), table);
    module.section(&data);

    let mut names = wasm_encoder::NameMap::new();
    for (k, n) in ["syscall", "trap", "div128", "clock", "mulhu", "mulhs", "resolve", "dispatch", "run"].iter().enumerate() {
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
        "{{\"entry\":{},\"imageEnd\":{},\"phdr\":{},\"phnum\":{},\"phent\":56{}}}",
        elf.entry, image_end(elf), elf.phdr_address().unwrap_or(0), elf.phnum, tls
    );
    module.section(&CustomSection { name: Cow::Borrowed("xlat.facts"), data: Cow::Owned(facts.into_bytes()) });

    Translation { wasm: module.finish(), report }
}
