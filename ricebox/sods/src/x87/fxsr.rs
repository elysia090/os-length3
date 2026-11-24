//! Architectural x87 state images. The mapped CPU handles SIMD and MXCSR.

use super::{store_extended, Fpu, Op, Register, FX87_BYTES};

const STACK: usize = 32;
const SLOT: usize = 16;
pub const X87_ENV_BYTES: usize = 28;

impl Register {
    fn image(self) -> (u64, u16) {
        match self {
            Register::Value(value) => { let (lo, hi) = store_extended(value); (lo, hi as u16) }
            Register::Image(lo, hi) => (lo, hi),
        }
    }

    fn tag(self) -> u16 {
        let (mantissa, word) = self.image();
        let exponent = word & 0x7fff;
        if exponent == 0 && mantissa == 0 { 1 }
        else if exponent > 0 && exponent < 0x7fff && mantissa >> 63 != 0 { 0 }
        else { 2 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Environment {
    instruction: u64,
    data: u64,
    code_selector: u16,
    data_selector: u16,
    opcode: u16,
}

impl Fpu {
    /// Register operations update FIP/FOP and leave the last data operand.
    /// The control and status instructions leave the saved pointers alone.
    pub fn note_mapped_instruction(&mut self, operation: i32, pc: u64, opcode: u16) {
        use Op::*;
        match Op::at(operation as usize) {
            None | Some(Fnstsw | Fnstcw | Fldcw | Fninit | Fnclex | Fwait | High) => {}
            _ => {
                self.environment.instruction = pc;
                self.environment.code_selector = 0x33; // Linux user code in long mode.
                self.environment.opcode = opcode & 0x7ff;
            }
        }
    }

    /// The 32-bit protected-mode FNSTENV layout used in long mode.
    /// Storing it masks exceptions in the live control word.
    pub fn fnstenv(&mut self) -> [u8; X87_ENV_BYTES] {
        let mut area = [0xff; X87_ENV_BYTES];
        let tags = self.st.iter().enumerate().fold(0u16, |tags, (i, reg)| {
            let tag = if self.occupied & (1 << i) == 0 { 3 } else { reg.tag() };
            tags | (tag << (2 * i))
        });
        let env = self.environment;
        for (at, word) in [(0, self.cw as u16), (4, self.status()), (8, tags), (16, env.code_selector),
                           (18, env.opcode), (24, env.data_selector)] {
            area[at..at + 2].copy_from_slice(&word.to_le_bytes());
        }
        area[12..16].copy_from_slice(&(env.instruction as u32).to_le_bytes());
        area[20..24].copy_from_slice(&(env.data as u32).to_le_bytes());
        self.cw |= 0x3f;
        area
    }

    pub fn fxsave(&self, wide: bool) -> [u8; FX87_BYTES] {
        let mut area = [0; FX87_BYTES];
        area[0..2].copy_from_slice(&(self.cw as u16).to_le_bytes());
        area[2..4].copy_from_slice(&self.status().to_le_bytes());
        area[4] = self.occupied; // Physical R0–R7, even though the slots below are logical ST0–ST7.
        let env = self.environment;
        area[6..8].copy_from_slice(&env.opcode.to_le_bytes());
        if wide {
            area[8..16].copy_from_slice(&env.instruction.to_le_bytes());
            area[16..24].copy_from_slice(&env.data.to_le_bytes());
        } else {
            area[8..12].copy_from_slice(&(env.instruction as u32).to_le_bytes());
            area[12..14].copy_from_slice(&env.code_selector.to_le_bytes());
            area[16..20].copy_from_slice(&(env.data as u32).to_le_bytes());
            area[20..22].copy_from_slice(&env.data_selector.to_le_bytes());
        }
        for k in 0..8 {
            let (mantissa, exponent) = self.st[self.slot(k)].image();
            let at = STACK + k as usize * SLOT;
            area[at..at + 8].copy_from_slice(&mantissa.to_le_bytes());
            area[at + 8..at + 10].copy_from_slice(&exponent.to_le_bytes());
        }
        area
    }

    pub fn fxrestore(&mut self, area: &[u8; FX87_BYTES], wide: bool) {
        let word = |at| u16::from_le_bytes(area[at..at + 2].try_into().unwrap());
        let dword = |at| u32::from_le_bytes(area[at..at + 4].try_into().unwrap());
        let qword = |at| u64::from_le_bytes(area[at..at + 8].try_into().unwrap());
        self.cw = u32::from(word(0));
        let status = u32::from(word(2));
        self.top = (status >> 11) & 7;
        self.sw = status & !0x3800;
        self.occupied = area[4];
        self.environment.opcode = word(6) & 0x7ff;
        if wide {
            self.environment.instruction = qword(8);
            self.environment.data = qword(16);
        } else {
            self.environment.instruction = u64::from(dword(8));
            self.environment.code_selector = word(12);
            self.environment.data = u64::from(dword(16));
            self.environment.data_selector = word(20);
        }
        for k in 0..8 {
            let at = STACK + k as usize * SLOT;
            let index = self.slot(k);
            self.st[index] = Register::Image(qword(at), word(at + 8));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnstenv_stores_the_original_control_and_physical_tags() {
        let mut fpu = Fpu { cw: 0x0340, ..Fpu::default() };
        fpu.push_register(Register::Image(1 << 63, 0x3fff));
        fpu.push_register(Register::Image(0, 0));
        let area = fpu.fnstenv();
        assert_eq!(&area[..12], &[0x40, 3, 0xff, 0xff, 0, 0x30, 0xff, 0xff, 0xff, 0x1f, 0xff, 0xff]);
        assert_eq!(&area[24..], &[0, 0, 0xff, 0xff]);
        assert_eq!(fpu.cw, 0x037f);
        assert_eq!(fpu.occupied, 0xc0);
    }

    #[test]
    fn fxsr_preserves_raw_stack_bits_and_the_physical_tag_mask() {
        let mut area = [0; FX87_BYTES];
        area[0..2].copy_from_slice(&0x077fu16.to_le_bytes());
        area[2..4].copy_from_slice(&0x2800u16.to_le_bytes()); // TOP = 5.
        area[4] = 0x21;
        area[6..8].copy_from_slice(&0x0365u16.to_le_bytes());
        area[8..16].copy_from_slice(&0x1234_5678_9abc_def0u64.to_le_bytes());
        area[16..24].copy_from_slice(&0xfedc_ba98_7654_3210u64.to_le_bytes());
        for k in 0..8 { area[STACK + k * SLOT..STACK + k * SLOT + 10].fill(k as u8 + 1); }
        let mut fpu = Fpu::default();
        fpu.fxrestore(&area, true);
        assert_eq!(fpu.fxsave(true), area);
        let legacy = fpu.fxsave(false);
        assert_eq!(&legacy[8..12], &area[8..12]);
        assert_eq!(&legacy[16..20], &area[16..20]);
        fpu.fxrestore(&legacy, false);
        assert_eq!(fpu.fxsave(false), legacy);
        fpu.pop();
        let popped = fpu.fxsave(true);
        assert_eq!(popped[4], 1);
        assert_eq!(&popped[STACK..STACK + 10], &[2; 10]);
    }
}
