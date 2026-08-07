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
