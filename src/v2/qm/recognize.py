"""SPEC §16 — known primitive recognition.

Recognition is informational.  Correctness comes from semantics and
verification, never from a matched name, so nothing downstream branches on the
result of this module.

Each reference is a function of (input value, input width), so one definition
covers 8-bit and 16-bit variants of the same primitive.

Layer 4: depends on `bits`, `semantics`.
"""

from .bits import mask_of, popcnt


def _exclusive_rank(lane_bits):
    def fn(m, n):
        return sum(popcnt(m & ((1 << k) - 1)) << (lane_bits * k) for k in range(n))
    return fn


def _inclusive_rank(lane_bits):
    def fn(m, n):
        return sum(popcnt(m & ((1 << (k + 1)) - 1)) << (lane_bits * k)
                   for k in range(n))
    return fn


def _prefix_parity_mask(m, n):
    return sum(((popcnt(m & ((1 << (k + 1)) - 1)) & 1) * 0xFF) << (8 * k)
               for k in range(n))


def _quote_state_before(m, n):
    return sum(((popcnt(m & ((1 << k) - 1)) & 1) * 0xFF) << (8 * k)
               for k in range(n))


def _bytemask(m, n):
    return sum(0xFF << (8 * k) for k in range(n) if (m >> k) & 1)


def _select(m, n):
    out = 0
    j = 0
    for i in range(n):
        if (m >> i) & 1:
            out |= i << (8 * j)
            j += 1
    return out


def _shufctl(m, n):
    out = 0
    j = 0
    for i in range(n):
        if (m >> i) & 1:
            out |= i << (8 * j)
            j += 1
    while j < 8:
        out |= 0xFF << (8 * j)
        j += 1
    return out


def _run_starts(m, n):
    mask = mask_of(n)
    return m & (~((m << 1) & mask)) & mask


def _run_ids(m, n):
    return _inclusive_rank(8)(_run_starts(m, n), n)


def _morton_dilate(x, n):
    out = 0
    for i in range(min(n, 32)):
        if (x >> i) & 1:
            out |= 1 << (2 * i)
    return out


def _morton_compact_even(x, n):
    out = 0
    for i in range(min(n // 2, 32)):
        if (x >> (2 * i)) & 1:
            out |= 1 << i
    return out


PRIMITIVES = [
    ('exclusive rank8', _exclusive_rank(8)),
    ('inclusive rank8', _inclusive_rank(8)),
    ('exclusive rank (nibble lanes)', _exclusive_rank(4)),
    ('inclusive rank (nibble lanes)', _inclusive_rank(4)),
    ('prefix parity mask', _prefix_parity_mask),
    ('quote-state-before', _quote_state_before),
    ('byte mask expand', _bytemask),
    ('select / compaction indices', _select),
    ('shuffle control word', _shufctl),
    ('run starts', _run_starts),
    ('run IDs', _run_ids),
    ('Morton dilate', _morton_dilate),
    ('Morton compact (even bits)', _morton_compact_even),
]


def _screen_values(input_bits):
    """Zero, all-ones and the basis: a primitive that disagrees here cannot
    agree everywhere, and screening keeps the full comparison off the hot path.
    """
    return [0, mask_of(input_bits)] + [1 << i for i in range(input_bits)]


def recognize(sem, obs, max_input_bits=16):
    """Names of reference primitives that agree with the target on the domain."""
    if not sem.domain.exhaustive or sem.input_bits > max_input_bits:
        return []

    out_mask = mask_of(sem.output_bits)
    values = sem.domain.values()
    observed = [obs(y) for y in sem.table()]
    by_input = dict(zip(values, observed))
    screen = [v for v in _screen_values(sem.input_bits) if v in by_input]
    n = sem.input_bits

    hits = []
    for name, ref in PRIMITIVES:
        try:
            if any(obs(ref(x, n) & out_mask) != by_input[x] for x in screen):
                continue
            if all(obs(ref(x, n) & out_mask) == want
                   for x, want in zip(values, observed)):
                hits.append(name)
        except (ValueError, TypeError, OverflowError, IndexError):
            continue
    return hits
