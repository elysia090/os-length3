"""Compiler intrinsics, defined once for both frontends.

Bit-manipulation kernels are written with intrinsics, so a tool that asks you to
paste one had better read them. This is the table; `interp.py` and `compile.py`
both consume it, which is what keeps the reference path and the fast path from
drifting on what `_pdep_u64` means.

An intrinsic here is a pure function of fixed arity: each operand is masked to a
declared width, the body is ordinary Python on integers, and the result carries
a declared C type. That covers the scalar BMI/BMI2/ABM set and the parts of SSE
that move 64-bit values through an `__m128i`.

`__m128i` is modelled as a 128-bit unsigned integer. That is exactly what it is
for the carry-less multiply idiom QM itself emits, and it is why QM can read its
own CLMUL output back.
"""

from ..bits import M64, clmul, mask_of, pdep, pext, popcnt
from .ctypes_model import INT, U32, U64, U128
from .errors import CFrontError


class Intrinsic(object):
    """One intrinsic: operand widths in, one typed value out."""

    __slots__ = ('name', 'widths', 'result', 'fn', 'cost')

    def __init__(self, name, widths, result, fn, cost=1):
        self.name = name
        self.widths = tuple(widths)
        self.result = result
        self.fn = fn
        self.cost = cost

    @property
    def arity(self):
        return len(self.widths)

    def apply(self, values, line=None):
        masked = [v & mask_of(w) for v, w in zip(values, self.widths)]
        try:
            return self.fn(*masked)
        except CFrontError:
            raise
        except ZeroDivisionError:
            raise CFrontError('%s: division by zero' % self.name, line=line)


REGISTRY = {}


def _add(name, widths, result, fn, cost=1):
    REGISTRY[name] = Intrinsic(name, widths, result, fn, cost)


def _undefined_at_zero(name, fn):
    def guarded(x):
        if x == 0:
            raise CFrontError('%s(0) is undefined' % name,
                              hint='guard the zero case explicitly')
        return fn(x)
    return guarded


# --- BMI2: parallel bit deposit and extract --------------------------------

_add('_pdep_u64', (64, 64), U64, lambda v, m: pdep(v, m))
_add('_pext_u64', (64, 64), U64, lambda v, m: pext(v, m))
_add('_pdep_u32', (32, 32), U32, lambda v, m: pdep(v, m, 32))
_add('_pext_u32', (32, 32), U32, lambda v, m: pext(v, m, 32))

# --- BMI1 -------------------------------------------------------------------

_add('_andn_u64', (64, 64), U64, lambda a, b: (~a) & b & M64)
_add('_andn_u32', (32, 32), U32, lambda a, b: (~a) & b & mask_of(32))
_add('_blsi_u64', (64,), U64, lambda x: x & ((-x) & M64))
_add('_blsr_u64', (64,), U64, lambda x: (x & (x - 1)) & M64 if x else 0)
_add('_blsmsk_u64', (64,), U64, lambda x: (x ^ (x - 1)) & M64 if x else M64)
_add('_bzhi_u64', (64, 32), U64, lambda x, n: x & mask_of(min(n, 64)))
_add('_bzhi_u32', (32, 32), U32, lambda x, n: x & mask_of(min(n, 32)))
_add('_tzcnt_u64', (64,), U64, lambda x: 64 if x == 0 else (x & -x).bit_length() - 1)
_add('_tzcnt_u32', (32,), U32, lambda x: 32 if x == 0 else (x & -x).bit_length() - 1)
_add('_lzcnt_u64', (64,), U64, lambda x: 64 - x.bit_length())
_add('_lzcnt_u32', (32,), U32, lambda x: 32 - x.bit_length())

# --- ABM / popcount ---------------------------------------------------------

_add('_mm_popcnt_u64', (64,), INT, popcnt)
_add('_mm_popcnt_u32', (32,), INT, popcnt)
_add('__popcnt64', (64,), INT, popcnt)
_add('__popcnt', (32,), INT, popcnt)

# --- byte swap and rotate ---------------------------------------------------

_add('_bswap64', (64,), U64,
     lambda x: int.from_bytes(x.to_bytes(8, 'little'), 'big'))
_add('_bswap', (32,), U32,
     lambda x: int.from_bytes(x.to_bytes(4, 'little'), 'big'))


def _rotate(bits, left):
    m = mask_of(bits)

    def fn(x, n):
        k = n % bits
        if not left:
            k = (bits - k) % bits
        return ((x << k) | (x >> (bits - k))) & m if k else x
    return fn


_add('_rotl64', (64, 32), U64, _rotate(64, True))
_add('_rotr64', (64, 32), U64, _rotate(64, False))
_add('_rotl', (32, 32), U32, _rotate(32, True))
_add('_rotr', (32, 32), U32, _rotate(32, False))

# --- SSE: 64-bit values through an __m128i ---------------------------------
#
# Only the subset that moves scalars in and out and multiplies carry-lessly.
# That is the whole of the CLMUL idiom, including the one QM emits itself.

_add('_mm_cvtsi64_si128', (64,), U128, lambda a: a)
_add('_mm_cvtsi128_si64', (128,), U64, lambda x: x & M64)
_add('_mm_set1_epi64x', (64,), U128, lambda v: (v << 64) | v)
_add('_mm_set_epi64x', (64, 64), U128, lambda hi, lo: (hi << 64) | lo)
_add('_mm_setzero_si128', (), U128, lambda: 0)
_add('_mm_xor_si128', (128, 128), U128, lambda a, b: a ^ b)
_add('_mm_and_si128', (128, 128), U128, lambda a, b: a & b)
_add('_mm_or_si128', (128, 128), U128, lambda a, b: a | b)
_add('_mm_andnot_si128', (128, 128), U128, lambda a, b: (~a) & b & mask_of(128))


def _clmulepi64(a, b, imm):
    """PCLMULQDQ: bit 0 of imm selects a's half, bit 4 selects b's."""
    left = (a >> 64) if (imm & 1) else (a & M64)
    right = (b >> 64) if (imm & 0x10) else (b & M64)
    return clmul(left, right, 64) & mask_of(128)


_add('_mm_clmulepi64_si128', (128, 128, 32), U128, _clmulepi64)

# QM's own emitted helper, so that its output reads back without the wrapper.
_add('qm_clmul64', (64, 64), U64, lambda a, b: clmul(a, b, 64) & M64)


# --- builtins that are simplest to express here too -------------------------

_add('__builtin_popcount', (32,), INT, popcnt)
_add('__builtin_popcountl', (64,), INT, popcnt)
_add('__builtin_popcountll', (64,), INT, popcnt)
_add('__builtin_parity', (32,), INT, lambda x: popcnt(x) & 1, cost=2)
_add('__builtin_parityl', (64,), INT, lambda x: popcnt(x) & 1, cost=2)
_add('__builtin_parityll', (64,), INT, lambda x: popcnt(x) & 1, cost=2)
_add('__builtin_ctz', (32,), INT,
     _undefined_at_zero('__builtin_ctz', lambda x: (x & -x).bit_length() - 1))
_add('__builtin_ctzl', (64,), INT,
     _undefined_at_zero('__builtin_ctzl', lambda x: (x & -x).bit_length() - 1))
_add('__builtin_ctzll', (64,), INT,
     _undefined_at_zero('__builtin_ctzll', lambda x: (x & -x).bit_length() - 1))
_add('__builtin_clz', (32,), INT,
     _undefined_at_zero('__builtin_clz', lambda x: 32 - x.bit_length()))
_add('__builtin_clzl', (64,), INT,
     _undefined_at_zero('__builtin_clzl', lambda x: 64 - x.bit_length()))
_add('__builtin_clzll', (64,), INT,
     _undefined_at_zero('__builtin_clzll', lambda x: 64 - x.bit_length()))
_add('__builtin_bswap16', (16,), U32,
     lambda x: int.from_bytes(x.to_bytes(2, 'little'), 'big'))
_add('__builtin_bswap32', (32,), U32,
     lambda x: int.from_bytes(x.to_bytes(4, 'little'), 'big'))
_add('__builtin_bswap64', (64,), U64,
     lambda x: int.from_bytes(x.to_bytes(8, 'little'), 'big'))
_add('__builtin_rotateleft32', (32, 32), U32, _rotate(32, True))
_add('__builtin_rotateleft64', (64, 32), U64, _rotate(64, True))
_add('__builtin_rotateright32', (32, 32), U32, _rotate(32, False))
_add('__builtin_rotateright64', (64, 32), U64, _rotate(64, False))


NAMES = sorted(REGISTRY)


def get(name):
    return REGISTRY.get(name)


# ---------------------------------------------------------------------------
# The same intrinsics, in C, for the Clang path
#
# `clang.py` strips `#include <immintrin.h>` — a bit-vector kernel needs the
# fixed-width typedefs and nothing else, and requiring a sysroot is the
# difference between a 50 MB browser bundle and a 300 MB one — and the browser
# compiles for wasm32, where that header does not exist at all.  Without these
# QM emitted C it could not read back: paste its own `_pdep_u64` output and
# Clang says the function is undeclared.
#
# These are portable definitions, not the instructions.  That is the point: the
# Clang path needs source that computes the same function on whatever target it
# is aimed at, and it is the same function the table above describes.  Keeping
# the two here means they cannot drift into disagreeing about what `_pdep_u64`
# means.
# ---------------------------------------------------------------------------

_M128I = '''typedef struct { unsigned long long qm_lo, qm_hi; } __m128i;'''

C_SHIMS = [
    ('_pdep_u64', '''static inline unsigned long long
_pdep_u64(unsigned long long v, unsigned long long m) {
  unsigned long long r = 0, b = 1;
  while (m) { unsigned long long low = m & (0ULL - m);
              if (v & b) r |= low; b <<= 1; m ^= low; }
  return r;
}'''),
    ('_pext_u64', '''static inline unsigned long long
_pext_u64(unsigned long long v, unsigned long long m) {
  unsigned long long r = 0, b = 1;
  while (m) { unsigned long long low = m & (0ULL - m);
              if (v & low) r |= b; b <<= 1; m ^= low; }
  return r;
}'''),
    ('_pdep_u32', '''static inline unsigned int
_pdep_u32(unsigned int v, unsigned int m) {
  unsigned int r = 0, b = 1;
  while (m) { unsigned int low = m & (0u - m);
              if (v & b) r |= low; b <<= 1; m ^= low; }
  return r;
}'''),
    ('_pext_u32', '''static inline unsigned int
_pext_u32(unsigned int v, unsigned int m) {
  unsigned int r = 0, b = 1;
  while (m) { unsigned int low = m & (0u - m);
              if (v & low) r |= b; b <<= 1; m ^= low; }
  return r;
}'''),
    ('_andn_u64', '''static inline unsigned long long
_andn_u64(unsigned long long a, unsigned long long b) { return (~a) & b; }'''),
    ('_andn_u32', '''static inline unsigned int
_andn_u32(unsigned int a, unsigned int b) { return (~a) & b; }'''),
    ('_blsi_u64', '''static inline unsigned long long
_blsi_u64(unsigned long long a) { return a & (0ULL - a); }'''),
    ('_blsr_u64', '''static inline unsigned long long
_blsr_u64(unsigned long long a) { return a & (a - 1ULL); }'''),
    ('_blsmsk_u64', '''static inline unsigned long long
_blsmsk_u64(unsigned long long a) { return a ^ (a - 1ULL); }'''),
    ('_bzhi_u64', '''static inline unsigned long long
_bzhi_u64(unsigned long long a, unsigned int i) {
  return i >= 64u ? a : (a & ((1ULL << i) - 1ULL));
}'''),
    ('_bzhi_u32', '''static inline unsigned int
_bzhi_u32(unsigned int a, unsigned int i) {
  return i >= 32u ? a : (a & ((1u << i) - 1u));
}'''),
    ('_tzcnt_u64', '''static inline unsigned long long
_tzcnt_u64(unsigned long long a) { return a ? __builtin_ctzll(a) : 64ULL; }'''),
    ('_tzcnt_u32', '''static inline unsigned int
_tzcnt_u32(unsigned int a) { return a ? __builtin_ctz(a) : 32u; }'''),
    ('_lzcnt_u64', '''static inline unsigned long long
_lzcnt_u64(unsigned long long a) { return a ? __builtin_clzll(a) : 64ULL; }'''),
    ('_lzcnt_u32', '''static inline unsigned int
_lzcnt_u32(unsigned int a) { return a ? __builtin_clz(a) : 32u; }'''),
    ('_mm_popcnt_u64', '''static inline unsigned long long
_mm_popcnt_u64(unsigned long long a) { return __builtin_popcountll(a); }'''),
    ('_mm_popcnt_u32', '''static inline unsigned int
_mm_popcnt_u32(unsigned int a) { return __builtin_popcount(a); }'''),

    ('_mm_cvtsi64_si128', '''static inline __m128i
_mm_cvtsi64_si128(long long a) {
  __m128i r; r.qm_lo = (unsigned long long)a; r.qm_hi = 0; return r;
}'''),
    ('_mm_cvtsi128_si64', '''static inline long long
_mm_cvtsi128_si64(__m128i a) { return (long long)a.qm_lo; }'''),
    ('_mm_set1_epi64x', '''static inline __m128i
_mm_set1_epi64x(long long a) {
  __m128i r; r.qm_lo = r.qm_hi = (unsigned long long)a; return r;
}'''),
    ('_mm_set_epi64x', '''static inline __m128i
_mm_set_epi64x(long long hi, long long lo) {
  __m128i r; r.qm_lo = (unsigned long long)lo;
  r.qm_hi = (unsigned long long)hi; return r;
}'''),
    ('_mm_setzero_si128', '''static inline __m128i
_mm_setzero_si128(void) { __m128i r; r.qm_lo = r.qm_hi = 0; return r; }'''),
    ('_mm_xor_si128', '''static inline __m128i
_mm_xor_si128(__m128i a, __m128i b) {
  __m128i r; r.qm_lo = a.qm_lo ^ b.qm_lo; r.qm_hi = a.qm_hi ^ b.qm_hi;
  return r;
}'''),
    ('_mm_and_si128', '''static inline __m128i
_mm_and_si128(__m128i a, __m128i b) {
  __m128i r; r.qm_lo = a.qm_lo & b.qm_lo; r.qm_hi = a.qm_hi & b.qm_hi;
  return r;
}'''),
    ('_mm_or_si128', '''static inline __m128i
_mm_or_si128(__m128i a, __m128i b) {
  __m128i r; r.qm_lo = a.qm_lo | b.qm_lo; r.qm_hi = a.qm_hi | b.qm_hi;
  return r;
}'''),
    ('_mm_andnot_si128', '''static inline __m128i
_mm_andnot_si128(__m128i a, __m128i b) {
  __m128i r; r.qm_lo = (~a.qm_lo) & b.qm_lo; r.qm_hi = (~a.qm_hi) & b.qm_hi;
  return r;
}'''),
    # Bit 0 of `imm` selects a's half, bit 4 selects b's — the same convention
    # as `_clmulepi64` above.
    ('_mm_clmulepi64_si128', '''static inline __m128i
_mm_clmulepi64_si128(__m128i a, __m128i b, int imm) {
  unsigned long long x = (imm & 0x01) ? a.qm_hi : a.qm_lo;
  unsigned long long y = (imm & 0x10) ? b.qm_hi : b.qm_lo;
  __m128i r; r.qm_lo = 0; r.qm_hi = 0;
  for (int i = 0; i < 64; ++i)
    if ((y >> i) & 1ULL) {
      r.qm_lo ^= x << i;
      if (i) r.qm_hi ^= x >> (64 - i);
    }
  return r;
}'''),
]

_C_SHIM_NAMES = [name for name, _ in C_SHIMS]


def c_shims_for(source):
    """C definitions for the intrinsics `source` uses and does not define.

    A paste that brings its own `_pdep_u64` keeps it: defining it twice would
    be an error, and the point is to fill in what is missing, not to overrule
    what is there.
    """
    import re

    wanted = [(name, body) for name, body in C_SHIMS
              if re.search(r'\b%s\s*\(' % name, source)
              and not re.search(r'\b%s\s*\([^)]*\)\s*\{' % name, source)]
    if not wanted:
        return ''
    parts = []
    if any(name.startswith('_mm_') for name, _ in wanted) or '__m128i' in source:
        parts.append(_M128I)
    parts += [body for _, body in wanted]
    return '\n'.join(parts) + '\n'
