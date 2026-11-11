//! The x87's instructions, each a call of the coprocessor (x87.rs: exact, 80 bits, the translator's own, beside the
//! program). The operations it does are crate::x87::NAMES, in the order of the `fpu` op index; the list is embedded
//! in the module (sods.fpu), so the host runs it only with a coprocessor that numbers them the same.

use crate::abi::*;
use crate::flags::*;
use crate::frame::*;
use crate::wasm::*;
use crate::x86::*;

/// The x87 runtime's number (x87::NAMES) of what `m` names, if it does one: by mnemonic, found once for all of them
/// (not by name, formatted and searched for, at each instruction that comes this way).
fn x87_index(m: Mnemonic) -> Option<usize> {
    static INDEX: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    let index = INDEX.get_or_init(|| Mnemonic::values().map(|m| {
        let name = format!("{m:?}").to_ascii_lowercase();
        let name = if name == "wait" { "fwait".to_string() } else { name };
        crate::x87::NAMES.iter().position(|&n| n == name).map_or(u8::MAX, |k| k as u8)
    }).collect());
    let k = index[m as usize];
    (k != u8::MAX).then_some(k as usize)
}

impl Fx<'_> {
    /// One x87 instruction: fpu(registers, op, memory size, st a, st b, operand, its top word) -> i64, called
    /// wasm to wasm, for the thread whose registers its instance names (G_X87). A memory operand read is loaded
    /// here and given as its bits (an 80-bit one's top word apart); one written is the call's value, stored here (an
    /// 80-bit one's top word asked for after, Op::High). The value is otherwise fcomi's flags (CF|ZF<<1|PF<<2), or
    /// the word fnstsw puts in AX.
    pub(crate) fn x87(&mut self, i: &Instruction) -> Option<bool> {
        let index = x87_index(i.mnemonic())?;
        let name = crate::x87::NAMES[index];
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
        if stores { at = self.place(i); self.tee_raw(l_u(0)); }
        self.gget(G_X87);
        self.c32(index as i32);
        self.c32(if integer { -size } else { size });
        self.c32(a); self.c32(b);
        if memory && !stores {
            let at = self.place(i);
            if size == 10 {
                self.tee_raw(l_u(0));
                self.load_at(8, at);
                self.get_raw(l_u(0)); self.e(Mem(I32_LOAD16_U, 0, at + 8));
            } else {
                self.load_at(size as u8, at);
                self.c32(0);
            }
        } else {
            self.c64(0); self.c32(0);
        }
        self.call(F_FPU);
        if stores {
            if size == 10 {
                self.store_at(8, at);
                self.get_raw(l_u(0));
                self.gget(G_X87);
                self.c32(crate::x87::Op::High as i32);
                self.c32(0); self.c32(0); self.c32(1); self.c64(0); self.c32(0);
                self.call(F_FPU);
                self.store_at(2, at + 8);
            } else {
                self.store_at(size as u8, at);
            }
            return Some(true);
        }
        match name {
            "fucomi" | "fcomi" | "fucomip" | "fcomip" => {
                self.e(I32_WRAP_I64);
                self.set(l_u(0));
                for (bit, l) in [(0, L_CF), (1, L_ZF), (2, L_PF)] {
                    self.get(l_u(0)); if bit > 0 { self.c32(bit); self.e(I32_SHR_U); } self.c32(1); self.e(I32_AND); self.set(l);
                }
                self.c32(0); self.set(L_OF); self.c32(0); self.set(L_SF);
                self.set_flags(Flags::Held);
            }
            "fnstsw" => { self.write_reg(Register::AX); }
            _ => self.e(DROP),
        }
        Some(true)
    }
}
