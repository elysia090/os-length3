//! An instruction's operands, read and written: registers with x86's partial-register rules, memory at guest
//! address = wasm address, the stack.

use crate::abi::*;
use crate::frame::*;
use crate::wasm::*;
use crate::x86::*;

/// All ones in `size` bytes.
pub(crate) fn mask(size: u8) -> i64 { if size >= 8 { -1 } else { (1i64 << (size as u32 * 8)) - 1 } }

fn sized_store(size: u8) -> (Op, i32) {
    match size {
        1 => (I64_STORE8, 1),
        2 => (I64_STORE16, 2),
        4 => (I64_STORE32, 4),
        _ => (I64_STORE, 8),
    }
}

fn sized_load(size: u8) -> Op {
    match size { 1 => I64_LOAD8_U, 2 => I64_LOAD16_U, 4 => I64_LOAD32_U, _ => I64_LOAD }
}

impl Fx<'_> {
    pub(crate) fn zext32(&mut self) { self.e(I32_WRAP_I64); self.e(I64_EXTEND_I32_U); }

    /// Push a register's value, zero-extended from its width.
    pub(crate) fn read_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        self.get(l_reg(n));
        match part {
            Part::Full => {}
            Part::Low32 => self.zext32(),
            Part::Low16 => { self.c64(0xffff); self.e(I64_AND); }
            Part::Low8 => { self.c64(0xff); self.e(I64_AND); }
            Part::High8 => { self.c64(8); self.e(I64_SHR_U); self.c64(0xff); self.e(I64_AND); }
        }
        true
    }

    /// Pop an i64 and write it with x86 partial-register rules: 32-bit
    /// writes zero the upper half, 8/16-bit writes merge.
    pub(crate) fn write_reg(&mut self, r: Register) -> bool {
        let Some((n, part)) = gpr(r) else { return false };
        let l = l_reg(n);
        match part {
            Part::Full => self.set(l),
            Part::Low32 => { self.zext32(); self.set(l); }
            Part::Low16 | Part::Low8 | Part::High8 => {
                let (m, shift) = match part { Part::Low16 => (0xffffi64, 0), Part::Low8 => (0xff, 0), _ => (0xff, 8) };
                self.c64(m); self.e(I64_AND);
                if shift > 0 { self.c64(shift); self.e(I64_SHL); }
                self.get(l); self.c64(!(m << shift)); self.e(I64_AND);
                self.e(I64_OR);
                self.set(l);
            }
        }
        if n == RSP && !std::mem::take(&mut self.rsp_up) { self.note_low(); }
        true
    }

    /// The static pool uses the stack's deepest address to clear reused memory.
    pub(crate) fn note_low(&mut self) {
        if self.checked_memory { return; }
        self.get(l_reg(RSP)); self.gget(G_LOW); self.e(I64_LT_U);
        self.if_();
        self.get(l_reg(RSP)); self.gset(G_LOW);
        self.end();
    }

    // ---- Memory ----

    /// Push the effective address as i64 (no segment base unless `segment`).
    pub(crate) fn effective(&mut self, i: &Instruction, segment: bool) {
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
    pub(crate) fn effective_from(&mut self, i: &Instruction, segment: bool, split: bool, narrow: bool) -> u64 {
        let base = i.memory_base();
        let disp = i.memory_displacement64() as i64;
        let mut offset = 0;
        let add = if narrow { I32_ADD } else { I64_ADD };
        let cst = |fx: &mut Self, v: i64| if narrow { fx.c32(v as i32) } else { fx.c64(v) };
        let term = |fx: &mut Self, r: Register| {
            match gpr(r) {
                Some((n, _)) if narrow => { fx.get(l_reg(n)); fx.e(I32_WRAP_I64); }
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
                if !first { self.e(add); }
                first = false;
            }
            if index != Register::None {
                term(self, index);
                let scale = i.memory_index_scale();
                if scale > 1 {
                    cst(self, scale.trailing_zeros() as i64);
                    self.e(if narrow { I32_SHL } else { I64_SHL });
                }
                if !first { self.e(add); }
            }
        }
        if segment && i.memory_segment() == Register::FS {
            self.gget(G_FS);
            if narrow { self.e(I32_WRAP_I64); }
            self.e(add);
        }
        offset
    }

    pub(crate) fn address(&mut self, i: &Instruction) {
        if self.checked_memory {
            self.mapped_address(i, None);
        } else {
            self.effective_from(i, true, false, true);
        }
    }

    /// An implicit address adjustment, such as the word of a bit string,
    /// belongs to the x86 offset before addr32 and the segment base.
    pub(crate) fn mapped_address(&mut self, i: &Instruction, extra: Option<u32>) {
        self.effective_from(i, false, false, false);
        if let Some(extra) = extra { self.get(extra); self.e(I64_ADD); }
        let (base, index) = (i.memory_base(), i.memory_index());
        if base == Register::EIP || base.size() == 4 || index.size() == 4
            || base == Register::None && index == Register::None && i.memory_displ_size() == 4 {
            self.zext32();
        }
        if i.memory_segment() == Register::FS { self.gget(G_FS); self.e(I64_ADD); }
    }

    /// The address for a load or store of operand memory, and the offset that load or store adds.
    pub(crate) fn place(&mut self, i: &Instruction) -> u64 {
        if self.checked_memory { self.address(i); 0 } else { self.effective_from(i, true, true, true) }
    }

    pub(crate) fn load_sized(&mut self, size: u8) { self.load_at(size, 0) }
    pub(crate) fn store_sized(&mut self, size: u8) { self.store_at(size, 0) }

    pub(crate) fn load_at(&mut self, size: u8, offset: u64) {
        self.e(Mem(sized_load(size), 0, offset));
    }

    pub(crate) fn store_at(&mut self, size: u8, offset: u64) {
        self.e(Mem(sized_store(size).0, 0, offset));
    }

    /// For a value that cannot fault, check before placing it on the Wasm
    /// stack. The address stays below the value, so neither needs a spill.
    fn store_value(&mut self, size: u8, align: u32, offset: u64, value: impl FnOnce(&mut Self) -> bool) -> bool {
        let (op, width) = sized_store(size);
        if self.checked_memory {
            debug_assert_eq!(offset, 0);
            self.check_address(width, MappedAccess::Write);
        }
        if !value(self) { return false; }
        self.raw_mem(op, align, offset);
        true
    }

    /// Keep the checked destination below the loaded value on the stack.
    /// Integer arithmetic between this and its store cannot call the host.
    pub(crate) fn load_update(&mut self, i: &Instruction, size: u8) -> u64 {
        let offset = self.place(i);
        if self.checked_memory { self.check_address(sized_store(size).1, MappedAccess::Update); }
        let address = l_u(0);
        self.tee_raw(address);
        self.get_raw(address);
        self.raw_mem(sized_load(size), 0, offset);
        offset
    }

    pub(crate) fn finish_update(&mut self, size: u8, offset: u64) {
        self.raw_mem(sized_store(size).0, 0, offset);
    }

    pub(crate) fn size(i: &Instruction, n: u32) -> u8 {
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
    pub(crate) fn read(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
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
    pub(crate) fn write(&mut self, i: &Instruction, n: u32, size: u8, from: u32) -> bool {
        match i.op_kind(n) {
            OpKind::Register => { self.get(from); self.write_reg(i.op_register(n)) }
            OpKind::Memory => { let at = self.place(i); self.store_value(size, 0, at, |fx| { fx.get(from); true }) }
            _ => false,
        }
    }

    pub(crate) fn sign_extend(&mut self, size: u8) {
        match size {
            1 => self.e(I64_EXTEND8_S),
            2 => self.e(I64_EXTEND16_S),
            4 => self.e(I64_EXTEND32_S),
            _ => {}
        }
    }

    pub(crate) fn mask_to(&mut self, size: u8) {
        if size < 8 {
            self.c64(mask(size));
            self.e(I64_AND);
        }
    }

    pub(crate) fn push_value(&mut self, from: u32) {
        self.push_with(|fx| { fx.get(from); true });
    }

    /// Push a value computed after RSP moves. Mapped operands that can fault
    /// or read the old RSP are evaluated by the caller first.
    pub(crate) fn push_with(&mut self, value: impl FnOnce(&mut Self) -> bool) -> bool {
        self.get(l_reg(RSP)); self.c64(8); self.e(I64_SUB); self.tee(l_reg(RSP));
        self.guest_address();
        self.store_value(8, 3, 0, value)
    }

    /// Write a value known now to a register: a full or 32-bit one takes it as it is.
    pub(crate) fn write_reg_known(&mut self, r: Register, value: i64) -> bool {
        match gpr(r) {
            Some((n, Part::Full)) => { self.c64(value); self.set(l_reg(n)); true }
            Some((n, Part::Low32)) => { self.c64(value & 0xffff_ffff); self.set(l_reg(n)); true }
            Some(_) => { self.c64(value); self.write_reg(r) }
            None => false,
        }
    }

    /// MOV and MOVNTI take the address first for memory destinations. Their
    /// store sources are immediates and general registers.
    pub(crate) fn assign(&mut self, i: &Instruction, size: u8) -> bool {
        match i.op0_kind() {
            OpKind::Register => self.read(i, 1, size) && self.write_reg(i.op0_register()),
            OpKind::Memory => {
                if i.op1_kind() == OpKind::Register && gpr(i.op1_register()).is_none() { return false; }
                let at = self.place(i);
                self.store_value(size, 0, at, |fx| fx.read(i, 1, size))
            }
            _ => false,
        }
    }

    /// Whether the instruction's operand `n` reads rsp (as the register or in its address).
    pub(crate) fn uses_rsp(i: &Instruction, n: u32) -> bool {
        let rsp = |r: Register| r.full_register() == Register::RSP;
        match i.op_kind(n) {
            OpKind::Register => rsp(i.op_register(n)),
            OpKind::Memory => rsp(i.memory_base()) || rsp(i.memory_index()),
            _ => false,
        }
    }

    fn pop_word(&mut self) {
        self.get(l_reg(RSP)); self.guest_address(); self.e(Mem(I64_LOAD, 3, 0));
    }

    fn advance_rsp(&mut self) {
        self.get(l_reg(RSP)); self.c64(8); self.e(I64_ADD); self.set(l_reg(RSP));
    }

    pub(crate) fn pop_value(&mut self, into: u32) {
        self.pop_word();
        self.set(into);
        self.advance_rsp();
    }

    /// RET carries the popped PC on the Wasm stack through register sync.
    pub(crate) fn pop_to_stack(&mut self) {
        self.pop_word();
        self.advance_rsp();
    }

    /// Operand `n` of `i` as an i32, zero-extended from `size` (4 bytes or fewer).
    pub(crate) fn read32(&mut self, i: &Instruction, n: u32, size: u8) -> bool {
        match i.op_kind(n) {
            OpKind::Register => match gpr(i.op_register(n)) {
                Some((k, Part::Full | Part::Low32)) => { self.get(l_reg(k)); self.e(I32_WRAP_I64); true }
                Some(_) => { self.read_reg(i.op_register(n)); self.e(I32_WRAP_I64); true }
                None => false,
            },
            OpKind::Memory => {
                let at = self.place(i);
                self.e(match size { 1 => Mem(I32_LOAD8_U, 0, at), 2 => Mem(I32_LOAD16_U, 0, at), _ => Mem(I32_LOAD, 0, at) });
                true
            }
            OpKind::Immediate8 | OpKind::Immediate16 | OpKind::Immediate32 | OpKind::Immediate8to16 | OpKind::Immediate8to32 => {
                self.c32((i.immediate(n) as i64 & mask(size)) as i32);
                true
            }
            _ => false,
        }
    }
}
