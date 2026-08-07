"""Bit-level primitives shared by every stage.

Nothing here depends on an ISA.  These are the reference semantics that the
solvers synthesize against and that the verifier checks against.

Layer 0: imports nothing else in `qm`.
"""

M8 = 0xFF
M16 = 0xFFFF
M32 = 0xFFFFFFFF
M64 = (1 << 64) - 1
M128 = (1 << 128) - 1

ONES = 0x0101010101010101
HIGH = 0x8080808080808080
LOW7 = 0x7F7F7F7F7F7F7F7F
IOTA = 0x0706050403020100
SPREAD_MUL = 0x8040201008040201
GATHER_MUL = 0x0102040810204080

# x^128 = x^7 + x^2 + x + 1
P128 = 0x87


def mask_of(bits):
    """Low-`bits` all-ones mask."""
    return (1 << bits) - 1 if bits > 0 else 0


def popcnt(x):
    return bin(x).count('1')


def parity(x):
    return bin(x).count('1') & 1


def clmul(a, b, bits):
    """Carry-less multiplication over GF(2)[x], keeping the full product."""
    r = 0
    for i in range(bits):
        if (b >> i) & 1:
            r ^= a << i
    return r


def imul(a, b, bits):
    """Ordinary integer multiplication truncated to `bits` bits."""
    return (a * b) & mask_of(bits)


def gf128_reduce(p):
    """Reduce modulo x^128 + x^7 + x^2 + x + 1."""
    for i in range(255, 127, -1):
        if (p >> i) & 1:
            p ^= (1 << i) ^ (P128 << (i - 128))
    return p & M128


def gf128_mul(a, b):
    return gf128_reduce(clmul(a, b, 128))


def pdep(v, m, bits=64):
    """Reference PDEP: scatter the low bits of `v` into the set bits of `m`."""
    r = 0
    j = 0
    for i in range(bits):
        if (m >> i) & 1:
            if (v >> j) & 1:
                r |= 1 << i
            j += 1
    return r


def pext(v, m, bits=64):
    """Reference PEXT: gather the bits of `v` selected by `m` into low bits."""
    r = 0
    j = 0
    for i in range(bits):
        if (m >> i) & 1:
            if (v >> i) & 1:
                r |= 1 << j
            j += 1
    return r


def bswap64(x):
    return int.from_bytes((x & M64).to_bytes(8, 'little'), 'big')


def shift_signed(x, s, bits=64):
    """Signed shift amount: positive is left, negative is right."""
    if s >= 0:
        return (x << s) & mask_of(bits)
    return (x & mask_of(bits)) >> (-s)


def to_signed(x, bits):
    x &= mask_of(bits)
    if bits and (x >> (bits - 1)) & 1:
        return x - (1 << bits)
    return x


def xorshift_stream(seed, count, bits=64):
    """Deterministic probe stream.

    Determinism is a correctness property, not a convenience: a verification
    report that cannot be reproduced is not a verification report.
    """
    m = mask_of(bits)
    x = (seed & M64) or 0x9E3779B97F4A7C15
    out = []
    for _ in range(count):
        x ^= (x >> 12)
        x ^= (x << 25) & M64
        x ^= (x >> 27)
        x = (x * 0x2545F4914F6CDD1D) & M64
        out.append(x & m)
    return out
