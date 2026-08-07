"""SPEC §7 — representation guards are derived, not declared.

    quotient/truncation is trivial   -> guard cost 0
    escape correction is linear      -> guard may be deferred and amortized
    escape correction is nonlinear   -> guard must be paid before accumulation

Layer 1: depends on `bits` only.
"""

from .bits import M64, M128, ONES, clmul, gf128_reduce, imul

MULS = {
    'IMUL': {'escape': 'carry', 'linear': False},
    'CLMUL': {'escape': 'degree overflow', 'linear': True},
}


def derive_guard(mul, lane_width=None, modulus_trivial=False):
    """Derive the guard for CONV(mul, lane_width) as a reportable record."""
    if mul not in MULS:
        raise ValueError('unknown multiplication family: %r' % (mul,))

    if mul == 'IMUL':
        # Carry crosses lanes and is nonlinear, so isolation has to happen
        # before accumulation; it cannot be hoisted out afterwards.
        name, linear, cost = 'widen lane in advance', False, 1
    elif modulus_trivial:
        # e.g. GF(2)[x] multiplication followed by truncation mod x^64.
        name, linear, cost = None, True, 0
    else:
        name, linear, cost = 'reduce afterward', True, 2

    if name is None:
        payment = 'none'
    elif linear:
        payment = 'deferable / amortizable'
    else:
        payment = 'prepay on every operand'

    return {'name': name, 'linear': linear, 'cost': cost, 'payment': payment,
            'escape': MULS[mul]['escape']}


def lane_rule_Z(n_lanes, lane_width):
    """CONV(IMUL, w) lane rule for exclusive prefix counts.

    The largest exclusive prefix count over n binary lanes is n-1, so
    w >= ceil(log2 n) is exactly the width that keeps every lane accumulator
    inside its own lane.
    """
    return lane_width >= max(1, (n_lanes - 1).bit_length())


def guard_evidence(probe_count=40):
    """Measure the claims the guard rules rest on.

    These are tested properties, not assertions: IMUL is expected to come out
    *non*-linear, and that failure is exactly why its guard must be prepaid.
    """
    xs = [(i * 0x9E3779B97F4A7C15) & M64 for i in range(probe_count)]

    conv_z_linear = all(
        imul(a ^ b, ONES << 8, 64) == (imul(a, ONES << 8, 64) ^ imul(b, ONES << 8, 64))
        for a in xs for b in xs
    )
    conv_gf2_linear = all(
        (clmul(a ^ b, M64, 64) & M64)
        == ((clmul(a, M64, 64) ^ clmul(b, M64, 64)) & M64)
        for a in xs for b in xs
    )
    ps = [clmul(x, (x * 3) & M128, 128) for x in xs[:20]]
    reduction_linear = all(
        gf128_reduce(p ^ q) == (gf128_reduce(p) ^ gf128_reduce(q))
        for p in ps for q in ps
    )

    return [
        {'claim': 'CONV(IMUL) distributes over XOR',
         'measured': conv_z_linear,
         'implication': 'carry is nonlinear across lanes, so the guard must be '
                        'paid before accumulation'},
        {'claim': 'CONV(CLMUL) distributes over XOR',
         'measured': conv_gf2_linear,
         'implication': 'the carry-less product is GF(2)-linear, so a guard may '
                        'be deferred past an XOR fold'},
        {'claim': 'GF(2^128) reduction distributes over XOR',
         'measured': reduction_linear,
         'implication': 'reduction can be amortized over a chunk instead of '
                        'once per block'},
    ]
