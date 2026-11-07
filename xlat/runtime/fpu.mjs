// The x87 coprocessor for translated programs, exact to the 64-bit
// mantissa. Arithmetic is done on BigInt so results round exactly as the
// hardware does for the control word's precision and rounding mode; libc
// printf and strtod depend on that. Transcendentals go through f64.

const ZERO = 0, NORMAL = 1, INF = 2, NAN = 3;
const BIAS = 16383;
const ONE = 1n << 63n;

// A register's value is kept two ways, each made from the other only when asked for: as a double (`f`) where it is one
// exactly, which most of what printf and strtod do keeps it (a number times ten, an integer loaded, a double stored), and
// as the 64-bit mantissa and exponent (`m`, `e`) the exact arithmetic below works in. An operation on two doubles is done
// on doubles and kept only where it was exact (an error-free sum or product: TwoSum, Dekker), which is then the x87's
// result too, whatever its rounding; anything else goes the exact way, as before.
const F64 = new Float64Array(1), U64 = new BigUint64Array(F64.buffer);
class X {
  constructor(kind, sign = 0, e = 0, m = 0n, f = undefined) {
    this.kind = kind; // ZERO | NORMAL | INF | NAN
    this.sign = sign;
    this._e = e; // value = m * 2^(e - 63)
    this._m = m; // 64-bit, top bit set when NORMAL; null until asked for, where `f` holds the value
    this._f = f; // the value as a double where it is one exactly; null where it is not; undefined until asked for
  }
  get e() { if (this._m === null) this.fill(); return this._e; }
  get m() { if (this._m === null) this.fill(); return this._m; }
  /** The mantissa and exponent, from the double. */
  fill() {
    F64[0] = Math.abs(this._f);
    const bits = U64[0], exp = Number(bits >> 52n), frac = bits & 0xfffffffffffffn;
    if (exp) { this._e = exp - 1023; this._m = (frac | 0x10000000000000n) << 11n; return; }
    const length = bitLength(frac);
    this._e = length - 1075;
    this._m = frac << BigInt(64 - length);
  }
  /** The value as a double where it is one exactly, else null. */
  get f() {
    if (this._f !== undefined) return this._f;
    if (this.kind === ZERO) return (this._f = this.sign ? -0 : 0);
    if (this.kind !== NORMAL) return (this._f = null);
    const e = this._e, m = this._m;
    // Within a double's exponents and its 53 bits (its last 11 of 64 clear): exactly that double.
    if (e < -1022 || e > 1023 || (m & 0x7ffn) !== 0n) return (this._f = null);
    return (this._f = (this.sign ? -1 : 1) * Number(m >> 11n) * 2 ** (e - 52));
  }
}

/** A finite double, as a register holds it (kept as the double; its mantissa made when asked for). */
const exactly = (v) => (v === 0 ? new X(ZERO, Object.is(v, -0) ? 1 : 0, 0, 0n, v) : new X(NORMAL, v < 0 ? 1 : 0, 0, null, v));

/** Whether a + b = s is exact: TwoSum's error is nothing. */
const sumExact = (a, b, s) => { const bb = s - a; return (a - (s - bb)) + (b - bb) === 0; };
/** Whether a * b = p is exact: Dekker's product's error is nothing (within the range his split holds: otherwise not
 * asked, the exact way taken). */
const SPLIT = 134217729;
function productExact(a, b, p) {
  const ta = SPLIT * a, ah = ta - (ta - a), al = a - ah;
  const tb = SPLIT * b, bh = tb - (tb - b), bl = b - bh;
  return ((ah * bh - p) + ah * bl + al * bh) + al * bl === 0;
}
/** Doubles the error-free checks hold for: far from overflow in the split, far above the subnormals. */
const safe = (v) => { const a = Math.abs(v); return a < 2 ** 995 && a > 2 ** -960; };

const zero = (sign = 0) => new X(ZERO, sign);
const inf = (sign = 0) => new X(INF, sign);
// The "real indefinite" NaN produced by invalid operations.
const indefinite = () => new X(NAN, 1, BIAS + 1, 0xc000000000000000n);

// How many bits `n` (>= 0) takes: by 64-bit pieces and clz32, never through its decimal or binary string (a string a
// rounding took most of the time printf spends in the x87).
const M64 = (1n << 64n) - 1n;
function bitLength(n) {
  if (n === 0n) return 0;
  let len = 0;
  while (n > M64) { n >>= 64n; len += 64; }
  const hi = Number(n >> 32n);
  return len + (hi ? 64 - Math.clz32(hi) : 32 - Math.clz32(Number(n)));
}

/** A view over guest memory, made again only for other bytes (another process's, or its memory grown). */
let viewOf = null, viewBytes = null;
const view = (bytes) => {
  if (bytes !== viewBytes) { viewBytes = bytes; viewOf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  return viewOf;
};

export class Fpu {
  constructor(bytes, names) {
    this.bytes = bytes; // () => Uint8Array over guest memory
    this.ops = names.map((n) => OPS[n] ?? (() => { throw new Error(`x87 ${n} not implemented`); }));
    this.st = Array.from({length: 8}, () => zero());
    this.top = 0;
    this.cw = 0x37f;
    this.sw = 0;
  }

  /** An independent copy for a forked process. */
  clone(bytes) {
    const c = new Fpu(bytes, []);
    c.ops = this.ops;
    c.st = this.st.slice();
    c.top = this.top; c.cw = this.cw; c.sw = this.sw;
    return c;
  }

  /** What a new thread or process starts from, plain as JSON carries it across Workers (cpu.mjs, remote.mjs). */
  saved() { return {top: this.top, cw: this.cw, sw: this.sw, st: this.st.map((x) => [x.kind, x.sign, x.e, String(x.m)])}; }
  /** Its registers as `saved` gave them. */
  restore(s) {
    this.top = s.top; this.cw = s.cw; this.sw = s.sw;
    this.st = s.st.map(([kind, sign, e, m]) => new X(kind, sign, e, BigInt(m)));
  }

  call(op, size, address, a, b) {
    return this.ops[op].call(this, size, address, a, b) ?? 0;
  }

  get(k) { return this.st[(this.top + k) & 7]; }
  set(k, x) { this.st[(this.top + k) & 7] = x; }
  push(x) { this.top = (this.top - 1) & 7; this.set(0, x); }
  pop() { this.top = (this.top + 1) & 7; }

  get rc() { return (this.cw >> 10) & 3; }
  get precision() { return [24, 64, 53, 64][(this.cw >> 8) & 3]; }

  /** Round sign * n * 2^exp to `bits` significant bits in mode `rc`. */
  round(sign, n, exp, bits = this.precision, rc = this.rc) {
    if (n === 0n) return zero(sign);
    const length = bitLength(n);
    let shift = length - bits;
    let q;
    if (shift > 0) {
      const s = BigInt(shift);
      q = n >> s;
      const rem = n & ((1n << s) - 1n), half = 1n << (s - 1n);
      let up;
      if (rc === 0) up = rem > half || (rem === half && (q & 1n) === 1n);
      else if (rc === 1) up = sign === 1 && rem !== 0n;
      else if (rc === 2) up = sign === 0 && rem !== 0n;
      else up = false;
      if (up) q += 1n;
      if (bitLength(q) > bits) { q >>= 1n; shift += 1; }
    } else {
      q = n << BigInt(-shift);
    }
    // q has exactly `bits` bits; widen to the 64-bit register mantissa.
    const m = q << BigInt(64 - bits);
    const e = exp + shift + bits - 1;
    if (e > BIAS) return inf(sign);
    if (e < -BIAS - 63) return zero(sign);
    return new X(NORMAL, sign, e, m);
  }

  // ---- conversions ----

  /** Whether results are kept at 53 bits or more (the precision control: not single's 24), where an exact double is the
   * x87's result as it is. */
  get wide() { return ((this.cw >> 8) & 3) !== 0; }

  fromInt(i) {
    if (i === 0n) return zero();
    if (i >= -9007199254740992n && i <= 9007199254740992n) return exactly(Number(i));
    const sign = i < 0n ? 1 : 0;
    return this.round(sign, sign ? -i : i, 0, 64, 0);
  }

  toInt(x, truncate) {
    if (x.kind === ZERO) return 0n;
    const f = x.f;
    if (f !== null && Number.isInteger(f)) return BigInt(f);
    if (x.kind !== NORMAL) return null;
    const exp = x.e - 63;
    let n;
    if (exp >= 0) n = x.m << BigInt(exp);
    else if (exp < -64) n = 0n; // only the rounding of a tiny value is left
    else n = x.m >> BigInt(-exp);
    if (exp < 0) {
      const lost = exp < -64 ? x.m : x.m & ((1n << BigInt(-exp)) - 1n);
      const half = exp < -64 ? -1n : 1n << BigInt(-exp - 1);
      const rc = truncate ? 3 : this.rc;
      let up;
      if (rc === 0) up = half > 0n && (lost > half || (lost === half && (n & 1n) === 1n));
      else if (rc === 1) up = x.sign === 1 && lost !== 0n;
      else if (rc === 2) up = x.sign === 0 && lost !== 0n;
      else up = false;
      if (up) n += 1n;
    }
    return x.sign ? -n : n;
  }

  fromBits(bits, size) {
    // A finite double or float is held as it is: nothing to round.
    if (size === 8 && ((bits >> 52n) & 0x7ffn) !== 0x7ffn) { U64[0] = bits; return exactly(F64[0]); }
    if (size === 4 && ((bits >> 23n) & 0xffn) !== 0xffn) {
      const n = Number(bits), exp = (n >>> 23) & 0xff, frac = n & 0x7fffff;
      const v = (exp ? (frac | 0x800000) * 2 ** (exp - 150) : frac * 2 ** -149) * (n >>> 31 ? -1 : 1);
      return exactly(n >>> 31 && v === 0 ? -0 : v);
    }
    const mantBits = size === 8 ? 52 : 23, expBits = size === 8 ? 11 : 8, bias = size === 8 ? 1023 : 127;
    const sign = Number(bits >> BigInt(mantBits + expBits)) & 1;
    const exp = Number((bits >> BigInt(mantBits)) & ((1n << BigInt(expBits)) - 1n));
    const frac = bits & ((1n << BigInt(mantBits)) - 1n);
    if (exp === (1 << expBits) - 1) return frac === 0n ? inf(sign) : new X(NAN, sign, BIAS + 1, ONE | (frac << BigInt(63 - mantBits)));
    if (exp === 0) return frac === 0n ? zero(sign) : this.round(sign, frac, 1 - bias - mantBits, 64, 0);
    return this.round(sign, frac | (1n << BigInt(mantBits)), exp - bias - mantBits, 64, 0);
  }

  toBits(x, size) {
    // A register that holds a double exactly: that double, or the float it is exactly.
    const f = x.f;
    if (f !== null) {
      if (size === 8) { F64[0] = f; return U64[0]; }
      if (Math.fround(f) === f) { const b = new Float32Array([f]); return BigInt(new Uint32Array(b.buffer)[0]); }
    }
    const mantBits = size === 8 ? 52 : 23, expBits = size === 8 ? 11 : 8, bias = size === 8 ? 1023 : 127;
    const s = BigInt(x.sign) << BigInt(mantBits + expBits);
    const maxExp = (1n << BigInt(expBits)) - 1n;
    if (x.kind === ZERO) return s;
    if (x.kind === INF) return s | (maxExp << BigInt(mantBits));
    if (x.kind === NAN) return s | (maxExp << BigInt(mantBits)) | ((x.m >> BigInt(63 - mantBits)) & ((1n << BigInt(mantBits)) - 1n)) | (1n << BigInt(mantBits - 1));
    let r = this.round(x.sign, x.m, x.e - 63, mantBits + 1);
    if (r.kind === INF || r.e > bias) return s | (maxExp << BigInt(mantBits));
    if (r.e < 1 - bias) {
      // Subnormal: round again at the fixed lowest exponent.
      const shift = BigInt(1 - bias - mantBits - (x.e - 63));
      let n = shift > 0n ? x.m >> shift : x.m << -shift;
      if (shift > 0n) {
        const rem = x.m & ((1n << shift) - 1n), half = 1n << (shift - 1n);
        if (rem > half || (rem === half && (n & 1n))) n += 1n;
      }
      return s | n;
    }
    const frac = (r.m >> BigInt(63 - mantBits)) & ((1n << BigInt(mantBits)) - 1n);
    return s | (BigInt(r.e + bias) << BigInt(mantBits)) | frac;
  }

  loadExtended(address) {
    const b = this.bytes(), v = view(b);
    const m = v.getBigUint64(address, true);
    const se = b[address + 8] | (b[address + 9] << 8);
    const sign = se >> 15, exp = se & 0x7fff;
    if (exp === 0x7fff) return (m << 1n) & M64 ? new X(NAN, sign, BIAS + 1, m) : inf(sign);
    if (m === 0n) return zero(sign);
    // Normal (its integer bit set): the register as it is, nothing to round.
    if (exp !== 0 && m >> 63n) return new X(NORMAL, sign, exp - BIAS, m);
    return this.round(sign, m, (exp === 0 ? 1 : exp) - BIAS - 63, 64, 0);
  }

  storeExtended(address, x) {
    const b = this.bytes(), v = view(b);
    let m = 0n, exp = 0;
    if (x.kind === NORMAL) {
      exp = x.e + BIAS;
      m = x.m;
      if (exp <= 0) { m >>= BigInt(1 - exp); exp = 0; }
    } else if (x.kind === INF) { exp = 0x7fff; m = ONE; }
    else if (x.kind === NAN) { exp = 0x7fff; m = x.m; }
    v.setBigUint64(address, m & M64, true);
    const se = (x.sign << 15) | exp;
    b[address + 8] = se & 0xff; b[address + 9] = se >> 8;
  }

  /** Read a memory operand: size > 0 float of that width, size < 0 integer. */
  load(size, address) {
    const v = view(this.bytes());
    switch (size) {
      case 4: return this.fromBits(BigInt(v.getUint32(address, true)), 4);
      case 8: return this.fromBits(v.getBigUint64(address, true), 8);
      case 10: return this.loadExtended(address);
      // (An integer of 32 bits or fewer is a double exactly: no BigInt made for it.)
      case -2: return exactly(v.getInt16(address, true));
      case -4: return exactly(v.getInt32(address, true));
      case -8: return this.fromInt(v.getBigInt64(address, true));
    }
    throw new Error(`x87 load size ${size}`);
  }

  store(size, address, x, truncate = false) {
    const v = view(this.bytes());
    switch (size) {
      case 4: v.setUint32(address, Number(this.toBits(x, 4)), true); return;
      case 8: v.setBigUint64(address, this.toBits(x, 8), true); return;
      case 10: this.storeExtended(address, x); return;
    }
    // Integers: out of range and NaN store the integer indefinite value.
    const bits = -size * 8;
    const i = this.toInt(x, truncate);
    const min = -(1n << BigInt(bits - 1)), max = (1n << BigInt(bits - 1)) - 1n;
    const n = i === null || i < min || i > max ? min : i;
    if (size === -2) v.setInt16(address, Number(n), true);
    else if (size === -4) v.setInt32(address, Number(n), true);
    else v.setBigInt64(address, n, true);
  }

  // ---- arithmetic ----

  add(a, b, negateB = false) {
    const fa = a.f, fb0 = b.f;
    if (fa !== null && fb0 !== null && this.wide) {
      const fb = negateB ? -fb0 : fb0, sum = fa + fb;
      // (A sum of nothing takes its sign from the rounding mode: the exact way.)
      if (sum !== 0 && Number.isFinite(sum) && sumExact(fa, fb, sum)) return exactly(sum);
    }
    const bs = negateB ? b.sign ^ 1 : b.sign;
    if (a.kind === NAN || b.kind === NAN) return a.kind === NAN ? a : b;
    if (a.kind === INF && b.kind === INF) return a.sign === bs ? a : indefinite();
    if (a.kind === INF) return a;
    if (b.kind === INF) return inf(bs);
    if (a.kind === ZERO && b.kind === ZERO) return zero(a.sign === bs ? a.sign : this.rc === 1 ? 1 : 0);
    if (a.kind === ZERO) return new X(b.kind, bs, b.e, b.m);
    if (b.kind === ZERO) return a;
    // Align to the smaller exponent; a far smaller operand only sticks.
    let [big, small, bigSign, smallSign] = a.e >= b.e ? [a, b, a.sign, bs] : [b, a, bs, a.sign];
    const gap = big.e - small.e;
    let nb, ns, exp;
    if (gap > 130) {
      nb = big.m << 131n; ns = 1n; exp = big.e - 63 - 131;
    } else {
      nb = big.m << BigInt(gap); ns = small.m; exp = small.e - 63;
    }
    let sum = (bigSign ? -nb : nb) + (smallSign ? -ns : ns);
    if (sum === 0n) return zero(this.rc === 1 ? 1 : 0);
    const sign = sum < 0n ? 1 : 0;
    return this.round(sign, sign ? -sum : sum, exp);
  }

  mul(a, b) {
    const fa = a.f, fb = b.f;
    if (fa !== null && fb !== null && fa !== 0 && fb !== 0 && this.wide && safe(fa) && safe(fb)) {
      const p = fa * fb;
      if (safe(p) && productExact(fa, fb, p)) return exactly(p);
    }
    const sign = a.sign ^ b.sign;
    if (a.kind === NAN || b.kind === NAN) return a.kind === NAN ? a : b;
    if ((a.kind === INF && b.kind === ZERO) || (a.kind === ZERO && b.kind === INF)) return indefinite();
    if (a.kind === INF || b.kind === INF) return inf(sign);
    if (a.kind === ZERO || b.kind === ZERO) return zero(sign);
    return this.round(sign, a.m * b.m, a.e - 63 + b.e - 63);
  }

  div(a, b) {
    const fa = a.f, fb = b.f;
    if (fa !== null && fb !== null && fa !== 0 && fb !== 0 && this.wide && safe(fa) && safe(fb)) {
      // Exact where the quotient times the divisor is the dividend, exactly.
      const q = fa / fb;
      if (safe(q) && q * fb === fa && productExact(q, fb, fa)) return exactly(q);
    }
    const sign = a.sign ^ b.sign;
    if (a.kind === NAN || b.kind === NAN) return a.kind === NAN ? a : b;
    if ((a.kind === INF && b.kind === INF) || (a.kind === ZERO && b.kind === ZERO)) return indefinite();
    if (a.kind === INF || b.kind === ZERO) return inf(sign);
    if (a.kind === ZERO || b.kind === INF) return zero(sign);
    const n = a.m << 130n, q = n / b.m, r = n % b.m;
    return this.round(sign, (q << 1n) | (r ? 1n : 0n), a.e - b.e - 130 - 1);
  }

  sqrt(a) {
    if (a.kind === ZERO || (a.kind === INF && !a.sign) || a.kind === NAN) return a;
    if (a.sign) return indefinite();
    let n = a.m, exp = a.e - 63;
    if (exp & 1) { n <<= 1n; exp -= 1; }
    n <<= 130n; exp -= 130;
    // Integer square root by Newton's method.
    let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
    for (;;) {
      const y = (x + n / x) >> 1n;
      if (y >= x) break;
      x = y;
    }
    const sticky = x * x !== n ? 1n : 0n;
    return this.round(0, (x << 1n) | sticky, exp / 2 - 1);
  }

  /** -1, 0, 1, or NaN for unordered. */
  compare(a, b) {
    const fa = a.f, fb = b.f;
    if (fa !== null && fb !== null) return fa < fb ? -1 : fa > fb ? 1 : 0;
    if (a.kind === NAN || b.kind === NAN) return NaN;
    const value = (x) => x.kind === ZERO ? 0 : x.sign ? -1 : 1;
    if (a.kind === ZERO && b.kind === ZERO) return 0;
    if (value(a) !== value(b)) return Math.sign(value(a) - value(b));
    const s = a.sign ? -1 : 1;
    if (a.kind === INF || b.kind === INF) return a.kind === b.kind ? 0 : (a.kind === INF ? s : -s);
    if (a.e !== b.e) return a.e > b.e ? s : -s;
    return a.m === b.m ? 0 : (a.m > b.m ? s : -s);
  }

  toNumber(x) {
    if (x.kind === ZERO) return x.sign ? -0 : 0;
    if (x.kind === INF) return x.sign ? -Infinity : Infinity;
    if (x.kind === NAN) return NaN;
    return (x.sign ? -1 : 1) * Number(x.m >> 11n) * 2 ** (x.e - 52);
  }

  fromNumber(v) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    return this.fromBits(view.getBigUint64(0), 8);
  }

  roundInteger(x) {
    if (x.kind !== NORMAL || x.e >= 63) return x;
    const i = this.toInt(x, false);
    return i === 0n ? zero(x.sign) : this.fromInt(i);
  }

  compareFlags(r) {
    // CF | ZF << 1 | PF << 2
    if (Number.isNaN(r)) return 7;
    return r < 0 ? 1 : r === 0 ? 2 : 0;
  }

  setStatus(r) {
    // C0 bit 8 less, C2 bit 10 unordered, C3 bit 14 equal
    this.sw &= ~0x4700;
    if (Number.isNaN(r)) this.sw |= 0x4500;
    else if (r < 0) this.sw |= 0x100;
    else if (r === 0) this.sw |= 0x4000;
  }
}

// Two-operand arithmetic. Register forms name ST(a) as the destination and
// ST(b) as the source; a single memory operand pairs with ST(0).
function arith(fn, reverse, pop) {
  return function (size, address, a, b) {
    const memory = size !== 0;
    const dst = memory ? 0 : a;
    const left = this.get(dst), right = memory ? this.load(size, address) : this.get(b);
    const [x, y] = reverse ? [right, left] : [left, right];
    this.set(dst, fn.call(this, x, y));
    if (pop) this.pop();
  };
}

const sub = function (x, y) { return this.add(x, y, true); };
const add = function (x, y) { return this.add(x, y); };

const constant = (v) => function () { this.push(this.fromNumber(v)); };

const OPS = {
  fld(size, address, a) { this.push(size ? this.load(size, address) : this.get(a)); },
  fild(size, address) { this.push(this.load(size, address)); },
  fst(size, address, a) { if (size) this.store(size, address, this.get(0)); else this.set(a, this.get(0)); },
  fstp(size, address, a) { OPS.fst.call(this, size, address, a); this.pop(); },
  fist(size, address) { this.store(size, address, this.get(0)); },
  fistp(size, address) { this.store(size, address, this.get(0)); this.pop(); },
  fisttp(size, address) { this.store(size, address, this.get(0), true); this.pop(); },
  fld1() { this.push(this.fromInt(1n)); },
  fldz() { this.push(zero()); },
  // Exact 64-bit mantissas of the hardware constants (round to nearest).
  fldpi() { this.push(new X(NORMAL, 0, 1, 0xc90fdaa22168c235n)); },
  fldl2e() { this.push(new X(NORMAL, 0, 0, 0xb8aa3b295c17f0bcn)); },
  fldln2() { this.push(new X(NORMAL, 0, -1, 0xb17217f7d1cf79acn)); },
  fldlg2() { this.push(new X(NORMAL, 0, -2, 0x9a209a84fbcff799n)); },
  fldl2t() { this.push(new X(NORMAL, 0, 1, 0xd49a784bcd1b8afen)); },
  fadd: arith(add, false, false), faddp: arith(add, false, true),
  fmul: arith(function (x, y) { return this.mul(x, y); }, false, false),
  fmulp: arith(function (x, y) { return this.mul(x, y); }, false, true),
  fsub: arith(sub, false, false), fsubp: arith(sub, false, true),
  fsubr: arith(sub, true, false), fsubrp: arith(sub, true, true),
  fdiv: arith(function (x, y) { return this.div(x, y); }, false, false),
  fdivp: arith(function (x, y) { return this.div(x, y); }, false, true),
  fdivr: arith(function (x, y) { return this.div(x, y); }, true, false),
  fdivrp: arith(function (x, y) { return this.div(x, y); }, true, true),
  fiadd: arith(add, false, false), fimul: arith(function (x, y) { return this.mul(x, y); }, false, false),
  fisub: arith(sub, false, false), fisubr: arith(sub, true, false),
  fidiv: arith(function (x, y) { return this.div(x, y); }, false, false),
  fidivr: arith(function (x, y) { return this.div(x, y); }, true, false),
  fchs() { const x = this.get(0), f = x.f; this.set(0, f !== null ? exactly(-f) : new X(x.kind, x.sign ^ 1, x.e, x.m)); },
  fabs() { const x = this.get(0), f = x.f; this.set(0, f !== null ? exactly(Math.abs(f)) : new X(x.kind, 0, x.e, x.m)); },
  fsqrt() { this.set(0, this.sqrt(this.get(0))); },
  frndint() { this.set(0, this.roundInteger(this.get(0))); },
  fxch(size, address, a, b) {
    const k = a === 0 ? b : a;
    const t = this.get(0); this.set(0, this.get(k)); this.set(k, t);
  },
  fucomi(size, address, a, b) { return this.compareFlags(this.compare(this.get(0), this.get(b))); },
  fcomi(size, address, a, b) { return this.compareFlags(this.compare(this.get(0), this.get(b))); },
  fucomip(size, address, a, b) { const r = this.compareFlags(this.compare(this.get(0), this.get(b))); this.pop(); return r; },
  fcomip(size, address, a, b) { const r = this.compareFlags(this.compare(this.get(0), this.get(b))); this.pop(); return r; },
  fucom(size, address, a, b) { this.setStatus(this.compare(this.get(0), size ? this.load(size, address) : this.get(a || 1))); },
  fcom(size, address, a, b) { OPS.fucom.call(this, size, address, a, b); },
  fucomp(size, address, a, b) { OPS.fucom.call(this, size, address, a, b); this.pop(); },
  fcomp(size, address, a, b) { OPS.fucom.call(this, size, address, a, b); this.pop(); },
  fucompp() { this.setStatus(this.compare(this.get(0), this.get(1))); this.pop(); this.pop(); },
  fcompp() { OPS.fucompp.call(this); },
  ftst() { this.setStatus(this.compare(this.get(0), zero())); },
  fxam() {
    const x = this.get(0);
    // C3 C2 C0 class codes; C1 is the sign.
    const code = {[ZERO]: 0x4000, [NORMAL]: 0x400, [INF]: 0x500, [NAN]: 0x100}[x.kind];
    this.sw = (this.sw & ~0x4700) | code | (x.sign << 9);
  },
  fnstsw(size, address) {
    const value = (this.sw & ~0x3800) | (this.top << 11);
    if (size) view(this.bytes()).setUint16(address, value, true);
    return value;
  },
  fnstcw(size, address) { view(this.bytes()).setUint16(address, this.cw, true); },
  fldcw(size, address) { this.cw = view(this.bytes()).getUint16(address, true); },
  fninit() { this.top = 0; this.cw = 0x37f; this.sw = 0; this.st = Array.from({length: 8}, () => zero()); },
  fnclex() { this.sw &= 0x7f00; },
  fwait() {}, fnop() {}, ffree() {},
  ffreep() { this.pop(); },
  fincstp() { this.pop(); },
  fdecstp() { this.top = (this.top - 1) & 7; },
  fprem() { OPS.fprem1.call(this, true); },
  fprem1(truncate = false) {
    // Exact partial remainder; one call always completes (C2 clear).
    const x = this.get(0), y = this.get(1);
    if (x.kind !== NORMAL || y.kind !== NORMAL) {
      if (x.kind === INF || y.kind === ZERO || x.kind === NAN || y.kind === NAN) this.set(0, indefinite());
      this.sw &= ~0x400;
      return;
    }
    const ex = x.e - 63, ey = y.e - 63, base = Math.min(ex, ey);
    const nx = x.m << BigInt(ex - base), ny = y.m << BigInt(ey - base);
    let q = nx / ny;
    let r = nx - q * ny;
    if (truncate !== true && 2n * r > ny || (truncate !== true && 2n * r === ny && (q & 1n))) { r -= ny; q += 1n; }
    let sign = x.sign;
    if (r < 0n) { r = -r; sign ^= 1; }
    this.set(0, r === 0n ? zero(x.sign) : this.round(sign, r, base, 64, 0));
    this.sw = (this.sw & ~0x4700) | (Number(q & 1n) << 9) | (Number((q >> 1n) & 1n) << 14) | (Number((q >> 2n) & 1n) << 8);
  },
  fscale() {
    const x = this.get(0), y = this.get(1);
    if (x.kind !== NORMAL || y.kind !== NORMAL) return;
    const n = Number(this.toInt(y, true));
    this.set(0, this.round(x.sign, x.m, x.e - 63 + n, 64, 0));
  },
  f2xm1() { this.set(0, this.fromNumber(2 ** this.toNumber(this.get(0)) - 1)); },
  fyl2x() { const v = this.toNumber(this.get(1)) * Math.log2(this.toNumber(this.get(0))); this.pop(); this.set(0, this.fromNumber(v)); },
  fyl2xp1() { const v = this.toNumber(this.get(1)) * Math.log2(1 + this.toNumber(this.get(0))); this.pop(); this.set(0, this.fromNumber(v)); },
  fpatan() { const v = Math.atan2(this.toNumber(this.get(1)), this.toNumber(this.get(0))); this.pop(); this.set(0, this.fromNumber(v)); },
  fsin() { this.set(0, this.fromNumber(Math.sin(this.toNumber(this.get(0))))); this.sw &= ~0x400; },
  fcos() { this.set(0, this.fromNumber(Math.cos(this.toNumber(this.get(0))))); this.sw &= ~0x400; },
  fptan() { this.set(0, this.fromNumber(Math.tan(this.toNumber(this.get(0))))); this.push(this.fromInt(1n)); this.sw &= ~0x400; },
  fxtract() {
    const x = this.get(0);
    if (x.kind !== NORMAL) return;
    this.set(0, this.fromInt(BigInt(x.e)));
    this.push(new X(NORMAL, x.sign, 0, x.m));
  },
};
