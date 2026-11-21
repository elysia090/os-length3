//! What a walk needs of an instruction, from its bytes alone, in 16 bits: its length, its flow, where its target is,
//! its class by the flags, and whether it is a system call. Read off tables made ahead (scan_table.rs: every opcode
//! of the four legacy maps, each way it may be prefixed and each way its ModRM may read, asked of the decoder once,
//! by examples/scan_table.rs), with no instruction built: a quarter of what decoding one takes. What the tables do
//! not say (VEX, EVEX, XOP and 3DNow, and the few opcodes whose length or flags turn on more than the tables are
//! keyed by) is asked of the decoder as before (seven instructions in a thousand of a C program's); and every answer here is checked against the decoder's (the tests).

use crate::scan_table::{CELLS, L1, L2, L3, L4};
use crate::x86::{kinds, Decoder, DecoderOptions, OpKind, SYSCALL};

// An entry: its length (4 bits), its flow (3), where its target is (2: it has none; its last byte; its last four;
// or asked of the decoder again), its class (6: x86.rs), and whether it is a system call. INVALID: no instruction.
pub const INVALID: u16 = 1 << 15;
pub const SYSTEM: u16 = 1 << 15;
pub const REL8: u16 = 1;
pub const REL32: u16 = 2;
pub const ASKED: u16 = 3;

/// An instruction scanned: its entry; where the four bytes are that its memory operand adds to rip, if it has one
/// (they end `relative` bytes from its start; 0: none); and how its immediate is a number, when it is four bytes
/// or eight (IMM_ZERO, IMM_SIGN, IMM_WIDE; 0: it is none): a number that may be an address.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Scan { pub entry: u16, pub relative: u8, pub number: u8 }

const NONE: Scan = Scan { entry: INVALID, relative: 0, number: 0 };

impl Scan {
    fn four(bytes: &[u8], end: usize) -> u32 { bytes.get(end.wrapping_sub(4)..end).map_or(0, |x| u32::from_le_bytes([x[0], x[1], x[2], x[3]])) }
    /// The address the memory operand of the instruction at `at` (its bytes at the start of `bytes`) names from rip
    /// (from eip, where an address-size prefix stands before it).
    pub fn rip(&self, bytes: &[u8], at: u64) -> Option<u64> {
        if self.relative == 0 { return None; }
        let len = (self.entry & 15) as usize;
        let (next, add) = (at.wrapping_add(len as u64), Scan::four(bytes, self.relative as usize));
        let short = bytes.iter().take(len).take_while(|&&c| PREFIX[c as usize] != 0).any(|&c| c == 0x67);
        Some(if short { (next as u32).wrapping_add(add) as u64 } else { next.wrapping_add(add as i32 as u64) })
    }
    /// Its immediate, as the decoder gives it.
    pub fn imm(&self, bytes: &[u8]) -> Option<u64> {
        let len = (self.entry & 15) as usize;
        match self.number as u32 {
            IMM_ZERO => Some(Scan::four(bytes, len) as u64),
            IMM_SIGN => Some(Scan::four(bytes, len) as i32 as u64),
            IMM_WIDE => Some((Scan::four(bytes, len) as u64) << 32 | Scan::four(bytes, len.wrapping_sub(4)) as u64),
            _ => None,
        }
    }
}

// A cell of the tables: what an opcode is, prefixed one way and its ModRM read one way. Its low half is its entry
// but for the length (flow, target, class, system call). Above: the size of its immediate (IMM: 0, 1, 2, 3, 4, 8
// bytes, or MOFFS: 8, or 4 where the address size is 32 bits); whether it has a ModRM; its immediate as a number
// (IMM_ZERO: 4 bytes, the rest zero; IMM_SIGN: 4 bytes, sign-extended; IMM_WIDE: 8); whether LOCK may stand before
// it when it writes memory; that it is an instruction at all; and that the tables do not say it (ASK).
pub const IMM: u32 = 7 << 16;
pub const IMM_AT: u32 = 16;
pub const MOFFS: u32 = 6;
pub const MODRM: u32 = 1 << 19;
pub const NUMBER: u32 = 20;
pub const IMM_ZERO: u32 = 1;
pub const IMM_SIGN: u32 = 2;
pub const IMM_WIDE: u32 = 3;
pub const LOCKS: u32 = 1 << 22;
pub const VALID: u32 = 1 << 23;
pub const ASK: u32 = 1 << 24;
/// Its flags are its class's only where the count in its last byte is not nothing (a shift by an immediate; the
/// count is the byte's low five bits, or six with COUNT_WIDE): else it reads and writes none.
pub const COUNTED: u32 = 1 << 25;
pub const COUNT_WIDE: u32 = 1 << 26;
/// (In L1: the opcode is one cell however it is prefixed and whatever its ModRM. In L3: the cell is one of eight
/// by the ModRM's rm, in L4.)
pub const ONE: u16 = 1 << 15;
pub const BY_RM: u16 = 1 << 15;

/// What each byte is before an opcode: nothing (0), a prefix that takes REX away (1), REX (2).
static PREFIX: [u8; 256] = {
    let mut t = [0u8; 256];
    let mut k = 0x40;
    while k < 0x50 { t[k] = 2; k += 1; }
    let legacy = [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3];
    let mut k = 0;
    while k < legacy.len() { t[legacy[k]] = 1; k += 1; }
    t
};

/// The instruction at the start of `bytes`, at address `at`, as the decoder has it.
pub fn asked(bytes: &[u8], at: u64) -> Scan {
    let bytes = &bytes[..bytes.len().min(15)];
    let mut decoder = Decoder::with_ip(64, bytes, at, DecoderOptions::NONE);
    let i = decoder.decode();
    if i.is_invalid() { return NONE; }
    let (k, class) = kinds().kind_class(&i);
    let len = i.len();
    let mut entry = len as u16 | (k.flow as u16) << 4 | (class as u16) << 9 | if k.bits & SYSCALL != 0 { SYSTEM } else { 0 };
    let offsets = decoder.get_constant_offsets(&i);
    if matches!(i.op0_kind(), OpKind::NearBranch64 | OpKind::NearBranch32 | OpKind::NearBranch16) {
        // Where it goes is where it ends plus its last byte, or its last four: kept as which, and read there again
        // (asked again where reading it so would not give what the decoder gives).
        let (to, next) = (i.near_branch_target(), i.next_ip());
        let last = |n: usize| bytes.get(len.wrapping_sub(n)..len).filter(|_| len > n);
        let short = last(1).is_some_and(|b| next.wrapping_add(b[0] as i8 as u64) == to);
        let long = last(4).is_some_and(|b| next.wrapping_add(i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u64) == to);
        entry |= (match offsets.immediate_size() { 1 if short => REL8, 4 if long => REL32, _ => ASKED }) << 7;
    }
    let number = (0..i.op_count()).find_map(|k| match i.op_kind(k) { OpKind::Immediate32 => Some(IMM_ZERO), OpKind::Immediate32to64 => Some(IMM_SIGN), OpKind::Immediate64 => Some(IMM_WIDE), _ => None }).unwrap_or(0);
    let relative = if i.is_ip_rel_memory_operand() { offsets.displacement_offset() + 4 } else { 0 };
    Scan { entry, relative: relative as u8, number: number as u8 }
}

/// The address the decoder says the instruction at `at` names from rip, and its immediate where that is a number
/// of four bytes or eight: what Scan::rip and Scan::imm are checked against.
pub fn asked_values(bytes: &[u8], at: u64) -> (Option<u64>, Option<u64>) {
    let i = Decoder::with_ip(64, &bytes[..bytes.len().min(15)], at, DecoderOptions::NONE).decode();
    if i.is_invalid() { return (None, None); }
    let number = |k: &u32| matches!(i.op_kind(*k), OpKind::Immediate32 | OpKind::Immediate32to64 | OpKind::Immediate64);
    (i.is_ip_rel_memory_operand().then(|| i.ip_rel_memory_address()), (0..i.op_count()).find(number).map(|k| i.immediate(k)))
}

/// The instruction at the start of `bytes`, at address `at`.
#[inline]
pub fn scan(bytes: &[u8], at: u64) -> Scan {
    let b = &bytes[..bytes.len().min(15)];
    // Its prefixes: the last of F2 and F3, whether 66 and 67 are among them, LOCK, and REX.W where REX is the last.
    let (mut p, mut key, mut short, mut lock) = (0, 0usize, false, false);
    let op = loop {
        let Some(&c) = b.get(p) else { return NONE };
        p += 1;
        match PREFIX[c as usize] {
            0 => break c,
            2 => { key = key & !1 | (c >> 3 & 1) as usize; continue; }
            _ => match c { 0x66 => key |= 2, 0x67 => short = true, 0xf3 => key = key & 3 | 4, 0xf2 => key = key & 3 | 8, 0xf0 => lock = true, _ => {} },
        }
        key &= !1;
    };
    // Its map, and what is asked: VEX (C4, C5), EVEX (62), XOP (8F, where what follows is no ModRM of POP), 3DNow.
    let (map, op) = match op {
        0x0f => {
            let Some(&c) = b.get(p) else { return NONE };
            p += 1;
            match c {
                0x38 | 0x3a => { let Some(&d) = b.get(p) else { return NONE }; p += 1; (if c == 0x38 { 0x200 } else { 0x300 }, d) }
                0x0f => return asked(bytes, at),
                _ => (0x100, c),
            }
        }
        0xc4 | 0xc5 | 0x62 => return asked(bytes, at),
        0x8f if b.get(p).is_some_and(|m| m & 0x1f >= 8) => return asked(bytes, at),
        _ => (0, op),
    };
    let m = b.get(p).copied().unwrap_or(0);
    let mut c = L1[map | op as usize];
    if c & ONE == 0 {
        c = L3[(L2[c as usize * 16 + key] as usize) << 4 | (m >> 3 & 7) as usize | if m >= 0xc0 { 8 } else { 0 }];
        if c & BY_RM != 0 { c = L4[((c & !BY_RM) as usize) << 3 | (m & 7) as usize]; }
    }
    let cell = CELLS[(c & !ONE) as usize];
    if cell & (VALID | ASK) != VALID { return if cell & ASK != 0 { asked(bytes, at) } else { NONE }; }
    // Its length: the ModRM, the SIB and the displacement they ask for, then the immediate.
    let (mut len, mut relative) = (p, 0);
    let mut memory = false;
    if cell & MODRM != 0 {
        len += 1;
        if m < 0xc0 {
            memory = true;
            let (mode, rm) = (m >> 6, m & 7);
            let mut base = rm;
            if rm == 4 { base = b.get(len).copied().unwrap_or(0) & 7; len += 1; }
            match mode { 1 => len += 1, 2 => len += 4, _ if base == 5 => { len += 4; if rm == 5 { relative = len; } } _ => {} }
        }
    }
    if lock && !(memory && cell & LOCKS != 0) { return NONE; }
    len += match cell >> IMM_AT & 7 { MOFFS => if short { 4 } else { 8 }, 5 => 8, n => n as usize };
    if len > b.len() { return NONE; }
    let mut entry = cell as u16 | len as u16;
    if cell & COUNTED != 0 && b[len - 1] & (if cell & COUNT_WIDE != 0 { 0x3f } else { 0x1f }) == 0 { entry &= !(63 << 9); }
    Scan { entry, relative: relative as u8, number: (cell >> NUMBER & 3) as u8 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stream of numbers, the same each run.
    struct Stream(u64);
    impl Stream {
        fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    }

    fn same(bytes: &[u8]) {
        let at = 0x40_1000;
        let scanned = scan(bytes, at);
        assert_eq!(scanned, asked(bytes, at), "{bytes:02x?}");
        if scanned.entry != INVALID { assert_eq!((scanned.rip(bytes, at), scanned.imm(bytes)), asked_values(bytes, at), "{bytes:02x?}"); }
    }

    /// Every opcode of every map, each way it may be prefixed, with every ModRM and what follows it filled three
    /// ways: scanned as the decoder decodes it.
    #[test]
    fn every_opcode_as_the_decoder_has_it() {
        let fills: [u8; 3] = [0x00, 0x01, 0xff];
        let prefixes: &[&[u8]] = &[&[], &[0x66], &[0xf3], &[0xf2], &[0x48], &[0x66, 0x48], &[0xf3, 0x48], &[0xf2, 0x66], &[0x67], &[0xf0], &[0x2e, 0x66], &[0x48, 0x66], &[0x66, 0xf3, 0x41], &[0xf0, 0x66, 0x4c], &[0x65, 0x67, 0x44]];
        let maps: &[&[u8]] = &[&[], &[0x0f], &[0x0f, 0x38], &[0x0f, 0x3a]];
        for prefix in prefixes {
            for map in maps {
                for op in 0..=255u8 {
                    for m in 0..=255u8 {
                        for fill in fills {
                            let mut bytes: Vec<u8> = prefix.iter().chain(map.iter()).copied().collect();
                            bytes.extend([op, m]);
                            bytes.resize(20, fill);
                            same(&bytes);
                        }
                    }
                }
            }
        }
    }

    /// Bytes of no meaning, a million and a half of them at each place they may start; and each cut short.
    #[test]
    fn any_bytes_as_the_decoder_has_them() {
        let mut stream = Stream(0x9e37_79b9_7f4a_7c15);
        let common = [0x48, 0x0f, 0x66, 0x89, 0x8b, 0xe8, 0xff, 0xc1, 0x83, 0xf3, 0x44, 0x24, 0x05, 0x80, 0x67, 0xf0];
        for round in 0..1_500_000 {
            let mut bytes = [0u8; 18];
            for b in bytes.iter_mut() { let r = stream.next(); *b = if r & 3 == 0 { common[(r >> 8) as usize % common.len()] } else { (r >> 16) as u8 }; }
            same(&bytes);
            if round % 16 == 0 { for cut in 0..bytes.len() { same(&bytes[..cut]); } }
        }
    }
}
