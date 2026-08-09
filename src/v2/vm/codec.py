"""One complete scalar code, one program code, and one canonical rank.

This is the dependency root. It knows nothing about images, machines, residuals
or proofs, and nothing later may reach back into it for anything but bits.

The code is Elias-gamma shaped and complete:

    E(0) = 0
    E(n) = 1 || 0^k || bin(n),   k = floor(log2 n)

so |E(n)| = 2k+2 for 2^k <= n < 2^(k+1), and

    sum_n 2^-|E(n)| = 1/2 + sum_k 2^k 2^-(2k+2) = 1.

Completeness is the whole point: it is what makes `sum_z 2^-L(z)` exactly one
over all payloads, and therefore what lets a Kraft mass be a probability rather
than a bound.

Bits are `str` of '0'/'1' here. This module is the definition, not the fast
path; the wasm build is where speed lives, and the two are held to each other.
"""

MAX_SCALAR_BITS = 1 << 20


class Malformed(Exception):
    """The bits are not a canonical word. Never a value, never a timeout."""


def encode_scalar(n):
    """`E(n)` for a natural number."""
    if n < 0:
        raise ValueError('the scalar code is over naturals: %r' % (n,))
    if n == 0:
        return '0'
    body = bin(n)[2:]
    return '1' + '0' * (len(body) - 1) + body


def decode_scalar(bits, at=0):
    """(value, next index), or raise `Malformed`.

    The decoder is what makes the code prefix-free: it stops when it has read
    the bits the leading run announced, so no word is a prefix of another and
    no lookahead is needed.
    """
    if at >= len(bits):
        raise Malformed('scalar word runs off the end')
    if bits[at] == '0':
        return 0, at + 1

    k = 0
    i = at + 1
    while i < len(bits) and bits[i] == '0':
        k += 1
        i += 1
        if k > MAX_SCALAR_BITS:
            raise Malformed('scalar word is absurdly long')
    if i >= len(bits):
        raise Malformed('scalar word has no payload')
    # The bit that ended the zero run is the leading payload bit, so `i` is the
    # last index consumed so far and the remaining k bits are i+1 .. i+k.
    if i + 1 + k > len(bits):
        raise Malformed('scalar payload runs off the end')
    return int('1' + bits[i + 1:i + 1 + k], 2), i + 1 + k


def code(payload):
    """`code(z) = E(|z|) || z` — the one global word for a payload."""
    return encode_scalar(len(payload)) + payload


def length(payload):
    """`L(z)`, in bits."""
    return len(encode_scalar(len(payload))) + len(payload)


def weight_exponent(payload):
    """`-log2 w(z)`, which is `L(z)`; the mass itself is `2 ** -L(z)`."""
    return length(payload)


def rank(payload):
    """Length-lexicographic rank, `2^|z| + value(z)`.

    Rank is the final tie-break for every minimum, so it has to be total and
    fixed once. `value('')` is zero.
    """
    return (1 << len(payload)) + (int(payload, 2) if payload else 0)


def pack(bits):
    """Byte artifact: the bits, then the unique short all-zero pad."""
    pad = (-len(bits)) % 8
    padded = bits + '0' * pad
    return bytes(int(padded[i:i + 8], 2) for i in range(0, len(padded), 8))


def unpack(blob):
    """The payload of a byte artifact, or raise `Malformed`.

    Strict on purpose. Accepting a nonzero pad bit, or a whole trailing zero
    byte, would give one payload two artifacts and break the identity the whole
    construction rests on.
    """
    bits = ''.join(format(byte, '08b') for byte in blob)
    size, at = decode_scalar(bits, 0)
    end = at + size
    if end > len(bits):
        raise Malformed('payload runs off the end of the artifact')
    tail = bits[end:]
    if len(tail) >= 8:
        raise Malformed('artifact has %d spare bits; at most 7 may be pad'
                        % len(tail))
    if tail.strip('0'):
        raise Malformed('pad is not all zero')
    return bits[at:end]
