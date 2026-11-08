//! The x87 coprocessor for translated programs, exact to its 64-bit mantissa: arithmetic on the integers a register
//! is made of, so a result rounds as the hardware's does for the control word's precision and rounding mode (libc's
//! printf and strtod depend on that); the transcendentals go through f64. Translated code calls it for each x87
//! instruction (lower.rs `x87`), wasm to wasm: an instance of the translator's own module (runtime/x87.ts) holds each
//! thread's registers, named by a handle in the thread's instance (wasm.rs `xlat_fpu`). A memory operand is the
//! translated code's to read and write: one read comes in as its bits, one written goes back as the call's value.

use std::cmp::Ordering;

const ZERO: u8 = 0;
const NORMAL: u8 = 1;
const INF: u8 = 2;
const NAN: u8 = 3;
const BIAS: i32 = 16383;
const ONE: u64 = 1 << 63;

/// A register: its value is m * 2^(e - 63), m's top bit set where it is NORMAL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct X {
    kind: u8,
    sign: u8,
    e: i32,
    m: u64,
}

const fn zero(sign: u8) -> X { X { kind: ZERO, sign, e: 0, m: 0 } }
const fn inf(sign: u8) -> X { X { kind: INF, sign, e: 0, m: 0 } }
const fn normal(sign: u8, e: i32, m: u64) -> X { X { kind: NORMAL, sign, e, m } }
/// The "real indefinite" NaN an invalid operation makes.
const INDEFINITE: X = X { kind: NAN, sign: 1, e: BIAS + 1, m: 0xc000_0000_0000_0000 };

/// How many bits `n` takes.
fn length(n: u128) -> u32 { 128 - n.leading_zeros() }

/// The ones in the low `n` bits (n < 128).
fn low(n: u32) -> u128 { (1u128 << n) - 1 }

/// sign * (n + a nonzero part below its last bit, where `sticky`) * 2^exp, rounded to `bits` significant bits in mode
/// `rc`. Where `sticky`, n has at least two bits more than `bits`, so the part below is below its guard bit too.
fn round(sign: u8, n: u128, sticky: bool, exp: i32, bits: u32, rc: u32) -> X {
    if n == 0 { return zero(sign); }
    let mut shift = length(n) as i32 - bits as i32;
    let mut q;
    if shift > 0 {
        let s = shift as u32;
        q = n >> s;
        let rem = n & low(s);
        let half = 1u128 << (s - 1);
        let up = match rc {
            0 => rem > half || (rem == half && (sticky || q & 1 == 1)),
            1 => sign == 1 && (rem != 0 || sticky),
            2 => sign == 0 && (rem != 0 || sticky),
            _ => false,
        };
        if up { q += 1; }
        if length(q) > bits { q >>= 1; shift += 1; }
    } else {
        q = n << (-shift) as u32;
    }
    // q has exactly `bits` bits: widened to the register's 64.
    let m = (q << (64 - bits)) as u64;
    let e = exp + shift + bits as i32 - 1;
    if e > BIAS { return inf(sign); }
    if e < -BIAS - 63 { return zero(sign); }
    normal(sign, e, m)
}

/// An integer, exactly (64 bits hold any the x87 loads or makes).
fn from_int(i: i128) -> X {
    if i == 0 { return zero(0); }
    round((i < 0) as u8, i.unsigned_abs(), false, 0, 64, 0)
}

/// A float (`size` 4) or a double (8), from its bits: nothing to round but a subnormal's normalizing.
fn from_bits(bits: u64, size: i32) -> X {
    let (mant, expb, bias) = if size == 8 { (52, 11, 1023) } else { (23, 8, 127) };
    let sign = ((bits >> (mant + expb)) & 1) as u8;
    let exp = ((bits >> mant) & ((1 << expb) - 1)) as i32;
    let frac = bits & ((1 << mant) - 1);
    if exp == (1 << expb) - 1 {
        return if frac == 0 { inf(sign) } else { X { kind: NAN, sign, e: BIAS + 1, m: ONE | frac << (63 - mant) } };
    }
    if exp == 0 {
        return if frac == 0 { zero(sign) } else { round(sign, frac as u128, false, 1 - bias - mant, 64, 0) };
    }
    round(sign, (frac | 1 << mant) as u128, false, exp - bias - mant, 64, 0)
}

/// An 80-bit extended value from memory: its mantissa and its sign-and-exponent word.
fn load_extended(m: u64, se: u16) -> X {
    let sign = (se >> 15) as u8;
    let exp = (se & 0x7fff) as i32;
    if exp == 0x7fff { return if m << 1 != 0 { X { kind: NAN, sign, e: BIAS + 1, m } } else { inf(sign) }; }
    if m == 0 { return zero(sign); }
    // Normal (its integer bit set): the register as it is, nothing to round.
    if exp != 0 && m >> 63 == 1 { return normal(sign, exp - BIAS, m); }
    round(sign, m as u128, false, (if exp == 0 { 1 } else { exp }) - BIAS - 63, 64, 0)
}

/// A register as 80 bits in memory: its mantissa, and its sign-and-exponent word.
fn store_extended(x: X) -> (u64, u32) {
    let (m, exp) = match x.kind {
        NORMAL => {
            let exp = x.e + BIAS;
            if exp <= 0 { (if 1 - exp >= 64 { 0 } else { x.m >> (1 - exp) }, 0) } else { (x.m, exp) }
        }
        INF => (ONE, 0x7fff),
        NAN => (x.m, 0x7fff),
        _ => (0, 0),
    };
    (m, (x.sign as u32) << 15 | exp as u32)
}

/// The value as a double: its mantissa cut (not rounded) to the double's 53 bits, as the transcendentals take it.
fn to_number(x: X) -> f64 {
    let sign = if x.sign == 1 { -1.0 } else { 1.0 };
    match x.kind {
        ZERO => sign * 0.0,
        INF => sign * f64::INFINITY,
        NAN => f64::NAN,
        _ if (-1022..=1023).contains(&x.e) => f64::from_bits((x.sign as u64) << 63 | ((x.e + 1023) as u64) << 52 | (x.m >> 11) & ((1 << 52) - 1)),
        _ => sign * (x.m >> 11) as f64 * 2f64.powi(x.e - 52),
    }
}

fn from_number(v: f64) -> X { from_bits(v.to_bits(), 8) }

macro_rules! ops {
    ($($op:ident $name:literal,)*) => {
        /// An x87 instruction the translator calls the coprocessor for.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Op { $($op,)* }
        /// Their names, as the translator finds an instruction's (lower.rs) and in the order of the index it calls by.
        pub const NAMES: &[&str] = &[$($name,)*];
        const ALL: &[Op] = &[$(Op::$op,)*];
    };
}

ops! {
    Fld "fld", Fild "fild", Fst "fst", Fstp "fstp", Fist "fist", Fistp "fistp", Fisttp "fisttp",
    Fld1 "fld1", Fldz "fldz", Fldpi "fldpi", Fldl2e "fldl2e", Fldln2 "fldln2", Fldlg2 "fldlg2", Fldl2t "fldl2t",
    Fadd "fadd", Faddp "faddp", Fmul "fmul", Fmulp "fmulp", Fsub "fsub", Fsubp "fsubp", Fsubr "fsubr", Fsubrp "fsubrp",
    Fdiv "fdiv", Fdivp "fdivp", Fdivr "fdivr", Fdivrp "fdivrp",
    Fiadd "fiadd", Fimul "fimul", Fisub "fisub", Fisubr "fisubr", Fidiv "fidiv", Fidivr "fidivr",
    Fchs "fchs", Fabs "fabs", Fsqrt "fsqrt", Frndint "frndint", Fxch "fxch",
    Fucomi "fucomi", Fcomi "fcomi", Fucomip "fucomip", Fcomip "fcomip",
    Fucom "fucom", Fcom "fcom", Fucomp "fucomp", Fcomp "fcomp", Fucompp "fucompp", Fcompp "fcompp", Ftst "ftst",
    Fnstsw "fnstsw", Fnstcw "fnstcw", Fldcw "fldcw", Fninit "fninit", Fnclex "fnclex", Fwait "fwait", Fnop "fnop",
    Ffree "ffree", Ffreep "ffreep", Fincstp "fincstp", Fdecstp "fdecstp",
    Fprem "fprem", Fprem1 "fprem1", Fscale "fscale", F2xm1 "f2xm1", Fyl2x "fyl2x", Fyl2xp1 "fyl2xp1", Fpatan "fpatan",
    Fsin "fsin", Fcos "fcos", Fptan "fptan", Fxam "fxam", Fxtract "fxtract",
    High "high",
}

impl Op {
    /// The operation the translator calls by index `n`, if any.
    pub fn at(n: usize) -> Option<Op> { ALL.get(n).copied() }
    /// Whether its memory operand, where it has one, is written (its value the call's), not read (its bits given).
    pub fn stores(self) -> bool { matches!(self, Op::Fst | Op::Fstp | Op::Fist | Op::Fistp | Op::Fisttp | Op::Fnstsw | Op::Fnstcw) }
}

/// One thread's registers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fpu {
    st: [X; 8],
    top: u32,
    cw: u32,
    sw: u32,
    /// The sign-and-exponent word of the 80-bit value stored last, for the translated code's second store (Op::High).
    high: u32,
}

impl Default for Fpu {
    fn default() -> Fpu { Fpu { st: [zero(0); 8], top: 0, cw: 0x37f, sw: 0, high: 0 } }
}

/// The bytes `save` gives: each register's mantissa, exponent, kind and sign; then top, cw and sw.
pub const SAVED: usize = 8 * 14 + 12;

/// Two-operand arithmetic: ST(a) the destination and ST(b) the source in the register forms; a memory operand
/// pairs with ST(0).
type Arith = fn(&Fpu, X, X) -> X;
/// An instruction's operands, as `Fpu::call` is given them.
#[derive(Clone, Copy)]
struct Operands { size: i32, a: i32, b: i32, lo: u64, hi: u32 }
fn add(f: &Fpu, x: X, y: X) -> X { f.add(x, y, false) }
fn sub(f: &Fpu, x: X, y: X) -> X { f.add(x, y, true) }
fn mul(f: &Fpu, x: X, y: X) -> X { f.mul(x, y) }
fn div(f: &Fpu, x: X, y: X) -> X { f.div(x, y) }

impl Fpu {
    /// Its registers as bytes, as a new thread or process in another Worker starts from them.
    pub fn save(&self) -> [u8; SAVED] {
        let mut out = [0u8; SAVED];
        for (k, x) in self.st.iter().enumerate() {
            let at = k * 14;
            out[at..at + 8].copy_from_slice(&x.m.to_le_bytes());
            out[at + 8..at + 12].copy_from_slice(&x.e.to_le_bytes());
            out[at + 12] = x.kind;
            out[at + 13] = x.sign;
        }
        for (k, v) in [self.top, self.cw, self.sw].into_iter().enumerate() {
            out[8 * 14 + 4 * k..8 * 14 + 4 * k + 4].copy_from_slice(&v.to_le_bytes());
        }
        out
    }

    /// Registers as `save` gave them; none where the bytes are not as many.
    pub fn restore(bytes: &[u8]) -> Option<Fpu> {
        if bytes.len() != SAVED { return None; }
        let word = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
        let mut f = Fpu::default();
        for (k, x) in f.st.iter_mut().enumerate() {
            let at = k * 14;
            let mut m = [0u8; 8];
            m.copy_from_slice(&bytes[at..at + 8]);
            *x = X { kind: bytes[at + 12] & 3, sign: bytes[at + 13] & 1, e: word(at + 8) as i32, m: u64::from_le_bytes(m) };
        }
        f.top = word(8 * 14) & 7;
        f.cw = word(8 * 14 + 4) & 0xffff;
        f.sw = word(8 * 14 + 8) & 0xffff;
        Some(f)
    }

    fn get(&self, k: i32) -> X { self.st[((self.top as i32 + k) & 7) as usize] }
    fn set(&mut self, k: i32, x: X) { self.st[((self.top as i32 + k) & 7) as usize] = x; }
    fn push(&mut self, x: X) { self.top = self.top.wrapping_sub(1) & 7; self.set(0, x); }
    fn pop(&mut self) { self.top = (self.top + 1) & 7; }

    fn rc(&self) -> u32 { (self.cw >> 10) & 3 }
    fn precision(&self) -> u32 { [24, 64, 53, 64][((self.cw >> 8) & 3) as usize] }
    fn rounded(&self, sign: u8, n: u128, sticky: bool, exp: i32) -> X { round(sign, n, sticky, exp, self.precision(), self.rc()) }

    // ---- conversions ----

    /// The integer nearest the value in the rounding mode (toward zero where `truncate`); none for an infinity or a
    /// NaN, and one past any 64-bit integer for a value too large for one.
    fn int_of(&self, x: X, truncate: bool) -> Option<i128> {
        if x.kind == ZERO { return Some(0); }
        if x.kind != NORMAL { return None; }
        let exp = x.e - 63;
        if exp >= 64 { return Some(if x.sign == 1 { i128::MIN } else { i128::MAX }); }
        let m = x.m as u128;
        let n = if exp >= 0 { m << exp } else {
            // Only the rounding of a tiny value is left below 2^-64: under a half, whatever it is.
            let (q, lost, half) = if exp < -64 { (0, m, None) } else { let s = (-exp) as u32; (m >> s, m & low(s), Some(1u128 << (s - 1))) };
            let up = match if truncate { 3 } else { self.rc() } {
                0 => half.is_some_and(|h| lost > h || (lost == h && q & 1 == 1)),
                1 => x.sign == 1 && lost != 0,
                2 => x.sign == 0 && lost != 0,
                _ => false,
            };
            q + up as u128
        };
        Some(if x.sign == 1 { -(n as i128) } else { n as i128 })
    }

    /// The value as a float (`size` 4) or a double (8), rounded in the rounding mode.
    fn bits_of(&self, x: X, size: i32) -> u64 {
        let (mant, expb, bias): (u32, u32, i32) = if size == 8 { (52, 11, 1023) } else { (23, 8, 127) };
        let s = (x.sign as u64) << (mant + expb);
        let max_exp = (1u64 << expb) - 1;
        match x.kind {
            ZERO => return s,
            INF => return s | max_exp << mant,
            NAN => return s | max_exp << mant | ((x.m >> (63 - mant)) & ((1 << mant) - 1)) | 1 << (mant - 1),
            _ => {}
        }
        let r = round(x.sign, x.m as u128, false, x.e - 63, mant + 1, self.rc());
        if r.kind == INF || r.e > bias { return s | max_exp << mant; }
        if r.e < 1 - bias {
            // Subnormal: rounded again at the fixed lowest exponent, to nearest.
            let shift = 1 - bias - mant as i32 - (x.e - 63);
            if shift >= 65 { return s; }
            let m = x.m as u128;
            let mut n = if shift > 0 { m >> shift } else { m << -shift };
            if shift > 0 {
                let rem = m & low(shift as u32);
                let half = 1u128 << (shift - 1);
                if rem > half || (rem == half && n & 1 == 1) { n += 1; }
            }
            return s | n as u64;
        }
        let frac = (r.m >> (63 - mant)) & ((1 << mant) - 1);
        s | ((r.e + bias) as u64) << mant | frac
    }

    /// A memory operand's value: a float of `size` bytes where it is positive, an integer of -size where negative.
    fn read(&self, size: i32, lo: u64, hi: u32) -> X {
        match size {
            4 => from_bits(lo & 0xffff_ffff, 4),
            8 => from_bits(lo, 8),
            10 => load_extended(lo, hi as u16),
            -2 => from_int(lo as u16 as i16 as i128),
            -4 => from_int(lo as u32 as i32 as i128),
            _ => from_int(lo as i64 as i128),
        }
    }

    /// The bits to store of `x` as a memory operand of `size` (as `read` reads it); the top word of an 80-bit one kept
    /// in `high`. An integer out of range, or a NaN, stores the integer indefinite value.
    fn store(&mut self, size: i32, x: X, truncate: bool) -> u64 {
        match size {
            4 | 8 => self.bits_of(x, size),
            10 => { let (m, se) = store_extended(x); self.high = se; m }
            _ => {
                let bits = -size * 8;
                let (min, max) = (-(1i128 << (bits - 1)), (1i128 << (bits - 1)) - 1);
                (match self.int_of(x, truncate) { Some(i) if (min..=max).contains(&i) => i, _ => min }) as u64
            }
        }
    }

    // ---- arithmetic ----

    fn add(&self, a: X, b: X, negate_b: bool) -> X {
        let bs = if negate_b { b.sign ^ 1 } else { b.sign };
        if a.kind == NAN { return a; }
        if b.kind == NAN { return b; }
        if a.kind == INF && b.kind == INF { return if a.sign == bs { a } else { INDEFINITE }; }
        if a.kind == INF { return a; }
        if b.kind == INF { return inf(bs); }
        if a.kind == ZERO && b.kind == ZERO { return zero(if a.sign == bs { a.sign } else { (self.rc() == 1) as u8 }); }
        if a.kind == ZERO { return X { sign: bs, ..b }; }
        if b.kind == ZERO { return a; }
        let (big, small, big_sign, small_sign) = if a.e >= b.e { (a, b, a.sign, bs) } else { (b, a, bs, a.sign) };
        let gap = big.e - small.e;
        // Aligned exactly where 128 bits hold both; past that, the smaller's bits below what can round the sum are
        // one sticky bit, far under its guard bit.
        let (nb, ns, exp) = if gap <= 63 {
            ((big.m as u128) << gap, small.m as u128, small.e - 63)
        } else {
            let s = gap - 63;
            let ns = if s >= 64 { 1 } else { (small.m >> s) as u128 | (small.m & ((1 << s) - 1) != 0) as u128 };
            ((big.m as u128) << 63, ns, small.e - 63 + s)
        };
        let (sign, n) = if big_sign == small_sign { (big_sign, nb + ns) } else if nb >= ns { (big_sign, nb - ns) } else { (small_sign, ns - nb) };
        if n == 0 { return zero((self.rc() == 1) as u8); }
        self.rounded(sign, n, false, exp)
    }

    fn mul(&self, a: X, b: X) -> X {
        let sign = a.sign ^ b.sign;
        if a.kind == NAN { return a; }
        if b.kind == NAN { return b; }
        if (a.kind == INF && b.kind == ZERO) || (a.kind == ZERO && b.kind == INF) { return INDEFINITE; }
        if a.kind == INF || b.kind == INF { return inf(sign); }
        if a.kind == ZERO || b.kind == ZERO { return zero(sign); }
        self.rounded(sign, a.m as u128 * b.m as u128, false, a.e - 63 + b.e - 63)
    }

    fn div(&self, a: X, b: X) -> X {
        let sign = a.sign ^ b.sign;
        if a.kind == NAN { return a; }
        if b.kind == NAN { return b; }
        if (a.kind == INF && b.kind == INF) || (a.kind == ZERO && b.kind == ZERO) { return INDEFINITE; }
        if a.kind == INF || b.kind == ZERO { return inf(sign); }
        if a.kind == ZERO || b.kind == INF { return zero(sign); }
        // floor(a.m * 2^127 / b.m), 127 or 128 bits, in two steps of 64; what is left over sticks.
        let d = b.m as u128;
        let n = (a.m as u128) << 63;
        let (q1, r1) = (n / d, n % d);
        let (q2, r2) = ((r1 << 64) / d, (r1 << 64) % d);
        self.rounded(sign, q1 << 64 | q2, r2 != 0, a.e - b.e - 127)
    }

    fn sqrt(&self, a: X) -> X {
        if a.kind == ZERO || (a.kind == INF && a.sign == 0) || a.kind == NAN { return a; }
        if a.sign == 1 { return INDEFINITE; }
        // m * 2^e with e made even, m widened to 127 or 128 bits: its root has 64.
        let e = a.e - 63;
        let (n, e) = if e & 1 != 0 { ((a.m as u128) << 63, e - 63) } else { ((a.m as u128) << 64, e - 64) };
        let x = isqrt(n);
        let rem = n - (x as u128) * (x as u128);
        // Its guard bit (the root at least x + 1/2: n - x^2 > x), and below it a part never exactly nothing unless the
        // root is exact (a half is never an integer's root).
        let guard = rem > x as u128;
        self.rounded(0, (x as u128) << 2 | (guard as u128) << 1 | (rem != 0) as u128, false, e / 2 - 2)
    }

    /// The order of two values; none where either is a NaN.
    fn compare(&self, a: X, b: X) -> Option<Ordering> {
        if a.kind == NAN || b.kind == NAN { return None; }
        let value = |x: X| if x.kind == ZERO { 0 } else if x.sign == 1 { -1 } else { 1 };
        if a.kind == ZERO && b.kind == ZERO { return Some(Ordering::Equal); }
        if value(a) != value(b) { return Some(value(a).cmp(&value(b))); }
        let toward = |o: Ordering| if a.sign == 1 { o.reverse() } else { o };
        if a.kind == INF || b.kind == INF {
            return Some(if a.kind == b.kind { Ordering::Equal } else { toward(if a.kind == INF { Ordering::Greater } else { Ordering::Less }) });
        }
        Some(toward(a.e.cmp(&b.e).then(a.m.cmp(&b.m))))
    }

    fn round_integer(&self, x: X) -> X {
        if x.kind != NORMAL || x.e >= 63 { return x; }
        match self.int_of(x, false) { Some(0) | None => zero(x.sign), Some(i) => from_int(i) }
    }

    /// fcomi's flags: CF | ZF << 1 | PF << 2.
    fn compare_flags(r: Option<Ordering>) -> u64 {
        match r { None => 7, Some(Ordering::Less) => 1, Some(Ordering::Equal) => 2, Some(Ordering::Greater) => 0 }
    }

    /// fcom's: C0 (bit 8) less, C2 (10) unordered, C3 (14) equal.
    fn set_status(&mut self, r: Option<Ordering>) {
        self.sw &= !0x4700;
        self.sw |= match r { None => 0x4500, Some(Ordering::Less) => 0x100, Some(Ordering::Equal) => 0x4000, Some(Ordering::Greater) => 0 };
    }

    /// fprem and fprem1: the exact partial remainder of ST(0) by ST(1) (`truncate`: fprem's, toward zero); one call
    /// always completes (C2 clear), the quotient's low three bits in C0, C3 and C1.
    fn remainder(&mut self, truncate: bool) {
        let (x, y) = (self.get(0), self.get(1));
        if x.kind != NORMAL || y.kind != NORMAL {
            if x.kind == INF || y.kind == ZERO || x.kind == NAN || y.kind == NAN { self.set(0, INDEFINITE); }
            self.sw &= !0x400;
            return;
        }
        let (ex, ey) = (x.e - 63, y.e - 63);
        let base = ex.min(ey);
        let d = y.m as u128;
        // x.m * 2^(ex - base) divided by y.m * 2^(ey - base): the remainder, and the quotient's low bits.
        let (mut q, mut r, ny): (u64, u128, u128) = if ex >= ey {
            let (mut q, mut r) = ((x.m as u128 / d) as u64, x.m as u128 % d);
            for _ in 0..ex - ey {
                r <<= 1;
                let bit = r >= d;
                if bit { r -= d; }
                q = q << 1 | bit as u64;
            }
            (q, r, d)
        } else {
            // Its divisor at least twice it: no quotient. Past twice, nothing to round to either.
            (0, x.m as u128, if ey - ex == 1 { d << 1 } else { u128::MAX })
        };
        let mut sign = x.sign;
        if !truncate && (2 * r > ny || (2 * r == ny && q & 1 == 1)) {
            r = ny - r;
            q = q.wrapping_add(1);
            sign ^= 1;
        }
        self.set(0, if r == 0 { zero(x.sign) } else { round(sign, r, false, base, 64, 0) });
        self.sw = (self.sw & !0x4700) | ((q & 1) as u32) << 9 | (((q >> 1) & 1) as u32) << 14 | (((q >> 2) & 1) as u32) << 8;
    }

    fn arith(&mut self, on: Operands, reverse: bool, pop: bool, f: Arith) {
        let dst = if on.size != 0 { 0 } else { on.a };
        let left = self.get(dst);
        let right = if on.size != 0 { self.read(on.size, on.lo, on.hi) } else { self.get(on.b) };
        let (x, y) = if reverse { (right, left) } else { (left, right) };
        let r = f(self, x, y);
        self.set(dst, r);
        if pop { self.pop(); }
    }

    /// The result of a transcendental, in a double, as ST(0).
    fn set_number(&mut self, v: f64) { self.set(0, from_number(v)); }

    /// One x87 instruction: operation `op` (an index of NAMES), its memory operand's `size` (0: none; negative: an
    /// integer's), its registers ST(`a`) and ST(`b`), and the operand's bits read from memory (`lo`, and an 80-bit
    /// one's top word `hi`). Returns what a store writes, fcomi's flags, or fnstsw's word.
    pub fn call(&mut self, op: i32, size: i32, a: i32, b: i32, lo: u64, hi: u32) -> u64 {
        let Some(op) = Op::at(op as usize) else { return 0 };
        let on = Operands { size, a, b, lo, hi };
        match op {
            Op::Fld => { let x = if size != 0 { self.read(size, lo, hi) } else { self.get(a) }; self.push(x); }
            Op::Fild => { let x = self.read(size, lo, hi); self.push(x); }
            Op::Fst | Op::Fstp => {
                let x = self.get(0);
                let out = if size != 0 { self.store(size, x, false) } else { self.set(a, x); 0 };
                if op == Op::Fstp { self.pop(); }
                return out;
            }
            Op::Fist => return self.store(size, self.get(0), false),
            Op::Fistp | Op::Fisttp => { let out = self.store(size, self.get(0), op == Op::Fisttp); self.pop(); return out; }
            Op::Fld1 => self.push(from_int(1)),
            Op::Fldz => self.push(zero(0)),
            // Exact 64-bit mantissas of the hardware's constants (round to nearest).
            Op::Fldpi => self.push(normal(0, 1, 0xc90f_daa2_2168_c235)),
            Op::Fldl2e => self.push(normal(0, 0, 0xb8aa_3b29_5c17_f0bc)),
            Op::Fldln2 => self.push(normal(0, -1, 0xb172_17f7_d1cf_79ac)),
            Op::Fldlg2 => self.push(normal(0, -2, 0x9a20_9a84_fbcf_f799)),
            Op::Fldl2t => self.push(normal(0, 1, 0xd49a_784b_cd1b_8afe)),
            Op::Fadd | Op::Fiadd => self.arith(on, false, false, add),
            Op::Faddp => self.arith(on, false, true, add),
            Op::Fmul | Op::Fimul => self.arith(on, false, false, mul),
            Op::Fmulp => self.arith(on, false, true, mul),
            Op::Fsub | Op::Fisub => self.arith(on, false, false, sub),
            Op::Fsubp => self.arith(on, false, true, sub),
            Op::Fsubr | Op::Fisubr => self.arith(on, true, false, sub),
            Op::Fsubrp => self.arith(on, true, true, sub),
            Op::Fdiv | Op::Fidiv => self.arith(on, false, false, div),
            Op::Fdivp => self.arith(on, false, true, div),
            Op::Fdivr | Op::Fidivr => self.arith(on, true, false, div),
            Op::Fdivrp => self.arith(on, true, true, div),
            Op::Fchs => { let x = self.get(0); self.set(0, X { sign: x.sign ^ 1, ..x }); }
            Op::Fabs => { let x = self.get(0); self.set(0, X { sign: 0, ..x }); }
            Op::Fsqrt => { let x = self.sqrt(self.get(0)); self.set(0, x); }
            Op::Frndint => { let x = self.round_integer(self.get(0)); self.set(0, x); }
            Op::Fxch => {
                let k = if a == 0 { b } else { a };
                let t = self.get(0);
                self.set(0, self.get(k));
                self.set(k, t);
            }
            Op::Fucomi | Op::Fcomi => return Fpu::compare_flags(self.compare(self.get(0), self.get(b))),
            Op::Fucomip | Op::Fcomip => { let r = Fpu::compare_flags(self.compare(self.get(0), self.get(b))); self.pop(); return r; }
            Op::Fucom | Op::Fcom | Op::Fucomp | Op::Fcomp => {
                let y = if size != 0 { self.read(size, lo, hi) } else { self.get(if a == 0 { 1 } else { a }) };
                self.set_status(self.compare(self.get(0), y));
                if matches!(op, Op::Fucomp | Op::Fcomp) { self.pop(); }
            }
            Op::Fucompp | Op::Fcompp => { self.set_status(self.compare(self.get(0), self.get(1))); self.pop(); self.pop(); }
            Op::Ftst => self.set_status(self.compare(self.get(0), zero(0))),
            Op::Fxam => {
                let x = self.get(0);
                // C3 C2 C0 the class; C1 the sign.
                let code = match x.kind { ZERO => 0x4000, NORMAL => 0x400, INF => 0x500, _ => 0x100 };
                self.sw = (self.sw & !0x4700) | code | (x.sign as u32) << 9;
            }
            Op::Fnstsw => return ((self.sw & !0x3800) | self.top << 11) as u64,
            Op::Fnstcw => return self.cw as u64,
            Op::Fldcw => self.cw = (lo & 0xffff) as u32,
            Op::Fninit => *self = Fpu::default(),
            Op::Fnclex => self.sw &= 0x7f00,
            Op::Fwait | Op::Fnop | Op::Ffree => {}
            Op::Ffreep | Op::Fincstp => self.pop(),
            Op::Fdecstp => self.top = self.top.wrapping_sub(1) & 7,
            Op::Fprem => self.remainder(true),
            Op::Fprem1 => self.remainder(false),
            Op::Fscale => {
                let (x, y) = (self.get(0), self.get(1));
                if x.kind != NORMAL || y.kind != NORMAL { return 0; }
                // Past 2^20 either way the result is an infinity or nothing, as it is for any scale that large.
                let n = self.int_of(y, true).map_or(0, |n| n.clamp(-(1 << 20), 1 << 20)) as i32;
                self.set(0, round(x.sign, x.m as u128, false, x.e - 63 + n, 64, 0));
            }
            Op::F2xm1 => self.set_number(2f64.powf(to_number(self.get(0))) - 1.0),
            Op::Fyl2x => { let v = to_number(self.get(1)) * to_number(self.get(0)).log2(); self.pop(); self.set_number(v); }
            Op::Fyl2xp1 => { let v = to_number(self.get(1)) * (1.0 + to_number(self.get(0))).log2(); self.pop(); self.set_number(v); }
            Op::Fpatan => { let v = to_number(self.get(1)).atan2(to_number(self.get(0))); self.pop(); self.set_number(v); }
            Op::Fsin => { self.set_number(to_number(self.get(0)).sin()); self.sw &= !0x400; }
            Op::Fcos => { self.set_number(to_number(self.get(0)).cos()); self.sw &= !0x400; }
            Op::Fptan => { self.set_number(to_number(self.get(0)).tan()); self.push(from_int(1)); self.sw &= !0x400; }
            Op::Fxtract => {
                let x = self.get(0);
                if x.kind != NORMAL { return 0; }
                self.set(0, from_int(x.e as i128));
                self.push(normal(x.sign, 0, x.m));
            }
            Op::High => return self.high as u64,
        }
        0
    }
}

/// The integer square root of `n` (below 2^128): Newton's method from above a double's estimate.
fn isqrt(n: u128) -> u64 {
    let mut x = ((n as f64).sqrt() as u128 + (1 << 13)).min(1 << 64);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x { return x as u64; }
        x = y;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(name: &str) -> i32 { NAMES.iter().position(|&n| n == name).unwrap() as i32 }

    /// A double into ST(0), as `fld m64` loads one.
    fn fld(f: &mut Fpu, v: f64) { f.call(op("fld"), 8, 0, 1, v.to_bits(), 0); }
    /// ST(0) as a double, as `fstp m64` stores it.
    fn fstp(f: &mut Fpu) -> f64 { f64::from_bits(f.call(op("fstp"), 8, 0, 1, 0, 0)) }
    /// ST(0) as 80 bits, as `fstp m80` stores it.
    fn fstp80(f: &mut Fpu) -> (u64, u32) {
        let m = f.call(op("fstp"), 10, 0, 1, 0, 0);
        (m, f.call(op("high"), 0, 0, 1, 0, 0) as u32)
    }

    #[test]
    fn doubles_round_as_the_hardware_does() {
        let mut f = Fpu::default();
        for (a, b) in [(1.0, 3.0), (2.0, 7.0), (1e300, 1e-300), (0.1, 0.2), (-5.5, 1e-17)] {
            fld(&mut f, a); fld(&mut f, b);
            f.call(op("fdivp"), 0, 1, 0, 0, 0);
            // At the double's precision (the control word's 53 bits), the quotient is the double's, as SSE gives it.
            let mut g = Fpu { cw: 0x27f, ..f };
            fld(&mut g, a); fld(&mut g, b);
            g.call(op("fdivp"), 0, 1, 0, 0, 0);
            assert_eq!(fstp(&mut g), a / b, "{a} / {b}");
            fstp(&mut f);
        }
        let mut g = Fpu { cw: 0x27f, ..Fpu::default() };
        for (a, b) in [(0.1, 0.2), (1e16, 1.0), (-3.25, 3.25), (1.0, -1e-30)] {
            fld(&mut g, a); fld(&mut g, b);
            g.call(op("faddp"), 0, 1, 0, 0, 0);
            assert_eq!(fstp(&mut g), a + b, "{a} + {b}");
            fld(&mut g, a); fld(&mut g, b);
            g.call(op("fmulp"), 0, 1, 0, 0, 0);
            assert_eq!(fstp(&mut g), a * b, "{a} * {b}");
        }
        fld(&mut g, 2.0);
        g.call(op("fsqrt"), 0, 0, 1, 0, 0);
        assert_eq!(fstp(&mut g), 2f64.sqrt());
    }

    #[test]
    fn the_extended_precision_is_kept() {
        // 1/3 to 64 bits: 0xaaaa...ab (round to nearest), exponent -2.
        let mut f = Fpu::default();
        fld(&mut f, 1.0); fld(&mut f, 3.0);
        f.call(op("fdivp"), 0, 1, 0, 0, 0);
        assert_eq!(fstp80(&mut f), (0xaaaa_aaaa_aaaa_aaab, 0x3ffd));
        // Toward zero, the last bit is not rounded up.
        let mut f = Fpu { cw: 0xf7f, ..Fpu::default() };
        fld(&mut f, 1.0); fld(&mut f, 3.0);
        f.call(op("fdivp"), 0, 1, 0, 0, 0);
        assert_eq!(fstp80(&mut f), (0xaaaa_aaaa_aaaa_aaaa, 0x3ffd));
        // sqrt(2) to 64 bits.
        let mut f = Fpu::default();
        fld(&mut f, 2.0);
        f.call(op("fsqrt"), 0, 0, 1, 0, 0);
        assert_eq!(fstp80(&mut f), (0xb504_f333_f9de_6484, 0x3fff));
        // An 80-bit value goes in and out as it is.
        let mut f = Fpu::default();
        f.call(op("fld"), 10, 0, 1, 0x8000_0000_0000_0001, 0xc005);
        assert_eq!(fstp80(&mut f), (0x8000_0000_0000_0001, 0xc005));
    }

    #[test]
    fn far_apart_sums_stick() {
        // 1 + 2^-70 rounds to 1 to nearest, up past 1 toward +infinity, and 1 - 2^-70 just under 1 toward zero.
        let tiny = (0x8000_0000_0000_0000u64, (0x3fff - 70) as u32);
        let mut f = Fpu { cw: 0xb7f, ..Fpu::default() };
        fld(&mut f, 1.0);
        f.call(op("fld"), 10, 0, 1, tiny.0, tiny.1);
        f.call(op("faddp"), 0, 1, 0, 0, 0);
        assert_eq!(fstp80(&mut f), (0x8000_0000_0000_0001, 0x3fff));
        let mut f = Fpu::default();
        fld(&mut f, 1.0);
        f.call(op("fld"), 10, 0, 1, tiny.0, tiny.1);
        f.call(op("faddp"), 0, 1, 0, 0, 0);
        assert_eq!(fstp80(&mut f), (0x8000_0000_0000_0000, 0x3fff));
        let mut f = Fpu { cw: 0xf7f, ..Fpu::default() };
        fld(&mut f, 1.0);
        f.call(op("fld"), 10, 0, 1, tiny.0, tiny.1);
        f.call(op("fsubp"), 0, 1, 0, 0, 0);
        assert_eq!(fstp80(&mut f), (0xffff_ffff_ffff_ffff, 0x3ffe));
    }

    #[test]
    fn integers_store_rounded_and_indefinite_past_range() {
        let mut f = Fpu::default();
        for (v, want) in [(2.5, 2i64), (3.5, 4), (-2.5, -2), (1e10, 10_000_000_000)] {
            fld(&mut f, v);
            assert_eq!(f.call(op("fistp"), -8, 0, 1, 0, 0) as i64, want, "{v}");
        }
        fld(&mut f, 1e10);
        assert_eq!(f.call(op("fistp"), -4, 0, 1, 0, 0) as u32, 0x8000_0000);
        fld(&mut f, -2.7);
        assert_eq!(f.call(op("fisttp"), -2, 0, 1, 0, 0) as u16 as i16, -2);
        f.call(op("fild"), -8, 0, 1, i64::MIN as u64, 0);
        assert_eq!(fstp(&mut f), -(2f64.powi(63)));
    }

    #[test]
    fn compares_flag_as_fcomi_and_fcom_do() {
        let mut f = Fpu::default();
        fld(&mut f, 2.0); fld(&mut f, 1.0);
        assert_eq!(f.call(op("fcomi"), 0, 0, 1, 0, 0), 1);
        fld(&mut f, f64::NAN);
        assert_eq!(f.call(op("fucomi"), 0, 0, 1, 0, 0), 7);
        f.call(op("fucomp"), 0, 1, 0, 0, 0);
        assert_eq!(f.call(op("fnstsw"), 0, 0, 1, 0, 0) & 0x4500, 0x4500);
    }

    #[test]
    fn remainders_complete_in_one_call() {
        let mut f = Fpu::default();
        fld(&mut f, 3.0); fld(&mut f, 1e300);
        f.call(op("fprem"), 0, 0, 1, 0, 0);
        assert_eq!(fstp(&mut f), 1e300 % 3.0);
        fld(&mut f, 7.0); fld(&mut f, 5.5);
        f.call(op("fprem1"), 0, 0, 1, 0, 0);
        assert_eq!(fstp(&mut f), -1.5);
    }

    #[test]
    fn saved_registers_come_back_as_they_were() {
        let mut f = Fpu::default();
        fld(&mut f, 1.0); fld(&mut f, 3.0);
        f.call(op("fdivp"), 0, 1, 0, 0, 0);
        f.call(op("fldcw"), 2, 0, 1, 0xf7f, 0);
        assert_eq!(Fpu::restore(&f.save()), Some(f));
    }
}
