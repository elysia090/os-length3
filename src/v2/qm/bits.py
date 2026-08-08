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


if hasattr(0, 'bit_count'):          # Python 3.10 and later
    def popcnt(x):
        return x.bit_count()
else:                                # pragma: no cover - older interpreters
    def popcnt(x):
        return bin(x).count('1')


def parity(x):
    return popcnt(x) & 1


def clmul(a, b, bits):
    """Carry-less multiplication over GF(2)[x], keeping the full product.

    Only set bits contribute a shift, so only those are visited, and the
    sparser operand is the one walked — the product is symmetric, and the
    constants these kernels multiply by are often dense (all-ones is a prefix
    XOR) while the values going through them are not.  This is the most-called
    primitive in the package; scanning all 64 positions to find the eight that
    matter was most of the cost of a CLMUL family search.
    """
    limit = 1 << bits
    b &= limit - 1
    if a < limit and popcnt(a) < popcnt(b):
        a, b = b, a
    r = 0
    while b:
        low = b & -b
        r ^= a << (low.bit_length() - 1)
        b ^= low
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
    """Reference PDEP: scatter the low bits of `v` into the set bits of `m`.

    Only the set bits of the mask do anything, so only those are visited.  The
    masks these kernels use are sparse — one bit per byte lane, one per nibble
    — and walking all 64 positions to find eight of them is most of the cost of
    a domain sweep.
    """
    m &= mask_of(bits)
    r = 0
    j = 0
    while m:
        low = m & -m
        if (v >> j) & 1:
            r |= low
        j += 1
        m ^= low
    return r


def pext(v, m, bits=64):
    """Reference PEXT: gather the bits of `v` selected by `m` into low bits."""
    m &= mask_of(bits)
    r = 0
    j = 0
    while m:
        low = m & -m
        if v & low:
            r |= 1 << j
        j += 1
        m ^= low
    return r


def bswap64(x):
    return int.from_bytes((x & M64).to_bytes(8, 'little'), 'big')


def clz(x, bits=64):
    """Leading zeros of `x` read as a `bits`-wide word; `bits` when it is zero."""
    return bits - (x & mask_of(bits)).bit_length()


def ctz(x, bits=64):
    """Trailing zeros of `x` read as a `bits`-wide word; `bits` when it is zero."""
    x &= mask_of(bits)
    return bits if x == 0 else (x & -x).bit_length() - 1


def sar(x, s, bits=64):
    """Arithmetic shift right: the sign bit is copied down, not zeroed.

    This is the one shift the rest of the package did without, and every
    comparison rests on it: `sar(a - b, 63)` is the whole of "is a below b"
    once the difference is known not to have wrapped.
    """
    return to_signed(x, bits) >> s & mask_of(bits)


def smear(x, bits=64):
    """Fill every bit below the highest set one — `x | x>>1 | x>>2 | ...`.

    A doubling cascade, so it is six steps and not sixty-three, and it is one
    step of the grammar rather than six because the cascade is what a reader
    recognizes: the whole of "round up to a power of two" is `smear(x-1) + 1`.
    """
    x &= mask_of(bits)
    shift = 1
    while shift < bits:
        x |= x >> shift
        shift <<= 1
    return x


def lane_values(x, lane_bits, bits=64):
    return [(x >> (lane_bits * i)) & mask_of(lane_bits)
            for i in range(bits // lane_bits)]


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


def lane_masks(lane_bits):
    """(ones, low, high) for lanes of `lane_bits`, replicated across 64 bits.

    `low` is every bit of a lane but its top one and `high` is that top bit, so
    the two partition the word and `~low == high`. That is the property the
    lane-comparison forms rest on: a borrow started in a lane cannot leave it
    once every top bit is accounted for.
    """
    lanes = 64 // lane_bits
    ones = sum(1 << (lane_bits * i) for i in range(lanes))
    high = (ones << (lane_bits - 1)) & M64
    return ones, (~high) & M64, high
