#!/usr/bin/env python3
"""qm-prototype-observation.py — Quotient Minimizer prototype

    QM(ISA, spec) -> (abstract program, residual freedom)
    lower(ISA, abstract) -> instruction sequence -> C

The normalized search space contains four kinds of operators:

    POINT      Lane-local operations.
               The only place where carry and comparison are created.

    LIN_CONST  Constant GF(2)-linear maps.

    CONV(mul,w)
               Convolution along lane indices.
               The Toeplitz subset of LIN_CONST.

    PERM_DYN   Data-dependent lane permutations.
               Gather and scatter are paired dynamic permutations.

CONV is indexed by the physical multiplication family and lane width,
not by a separately declared semiring:

    CONV(IMUL, w)
    CONV(CLMUL, w)

Guards are derived rather than declared:

    mul     escape           linear   guard                  payment
    IMUL    carry            no       widen lanes            prepay
    CLMUL   degree overflow  yes      reduce afterward       defer/amortize

If the quotient modulus is trivial, as with truncation modulo x^64,
the guard costs zero instructions.

An ISA declaration contains only a lowering table: how each abstract
operation maps to physical instructions. span / work / L(z) / rank are
derived from the lowered sequence.

Stage 1 has TWO different quotients:

    future quotient
        State equivalence under all future continuations.

    observation quotient
        Output equivalence induced by an EXPLICIT observer

            obs : Output -> Observable

        with

            y ~ y'    iff    obs(y) == obs(y').

IMPORTANT:
    The observation quotient is NOT inferred by looking for output bits
    that happen to be constant on the current target image. A bit that is
    always zero is still part of the exact output contract when the caller
    observes the full uint64_t.

    Therefore the default observer is identity: exact 64-bit output.
    Nontrivial observation quotients must be supplied explicitly.

Stage 2 returns not just a program, but

    (program, residual freedom)

Residual freedom has a direct interpretation:

    0    Not representable in the declared grammar.
    1    Constants are forced by the specification.
    n>1  n implementation choices remain; the fourth key is required.

This prototype's specialized Stage 2 solvers currently synthesize exact
64-bit outputs. The observation-quotient machinery is correct and explicit,
but quotient-aware Stage 2 search for arbitrary non-identity observers is
left as a separate search problem rather than silently approximated.

Run:

    python3 qm-prototype-observation.py
"""

from itertools import product


# =====================================================================
# Global constants
# =====================================================================

M64 = (1 << 64) - 1
M128 = (1 << 128) - 1
ONES = 0x0101010101010101
HIGH = 0x8080808080808080
LOW7 = 0x7F7F7F7F7F7F7F7F
IOTA = 0x0706050403020100
SPREAD_MUL = 0x8040201008040201
GATHER_MUL = 0x0102040810204080
P128 = 0x87                     # x^128 = x^7 + x^2 + x + 1

# Toy description-code widths used by the prototype measurement model.
OPC, SHB = 2, 6


# =====================================================================
# §1  Multiplication families and guard derivation
# =====================================================================

def clmul(a, b, bits):
    """Carry-less multiplication over GF(2)."""
    r = 0
    for i in range(bits):
        if (b >> i) & 1:
            r ^= a << i
    return r


def imul(a, b, bits):
    """Ordinary integer multiplication truncated to `bits` bits."""
    return (a * b) & ((1 << bits) - 1)


def gf128_reduce(p):
    """Reduce modulo x^128 + x^7 + x^2 + x + 1."""
    for i in range(255, 127, -1):
        if (p >> i) & 1:
            p ^= (1 << i) ^ (P128 << (i - 128))
    return p & M128


def gf128_mul(a, b):
    return gf128_reduce(clmul(a, b, 128))


MULS = {
    'IMUL': dict(escape='carry',           linear=False),
    'CLMUL': dict(escape='degree overflow', linear=True),
}


def derive_guard(mul, w, modulus_trivial=False):
    """Derive the guard rather than declaring one.

    Returns:
        (guard_name, is_linear, instruction_cost)
    """
    _ = w
    m = MULS[mul]

    if mul == 'IMUL':
        # Carry is nonlinear across lanes, so isolation must happen before
        # accumulation rather than being hoisted afterward.
        return 'widen lane in advance', False, 1

    if modulus_trivial:
        # Example: multiplication in GF(2)[x] followed by truncation mod x^64.
        return None, True, 0

    # Polynomial reduction is GF(2)-linear, so it may be deferred.
    return 'reduce afterward', m['linear'], 2


def lane_rule_Z(n, w):
    """Lane rule for exclusive prefix counts.

    The largest exclusive prefix count among n binary lanes is n-1, so

        w >= ceil(log2 n)

    is exactly the width needed to represent all lane-local accumulators.
    """
    return w >= max(1, (n - 1).bit_length())


# =====================================================================
# §2  ISA declaration = lowering tables
# =====================================================================

def lower_x86(op):
    """Lower one abstract operation to x86-64 BMI2/PCLMUL primitives."""
    k = op[0]

    return {
        'LIN_CONST':  [('PDEP', op[-1], None)],
        'CONV_Z':     [('IMUL', op[-1], None)],
        'CONV_GF2':   [('CLMUL', op[-1], None)],
        'CONV_GF128': [('CLMUL', None, None)] * 3
                    + [('CLMUL', None, None)] * 2,
        'PERM_DYN_G': [('PEXT', op[-1], None)],
        'PERM_DYN_S': [('PDEP', op[-1], None)],
        'NOT':        [('NOT', None, None)],
        'SHR':        [('SHR', None, op[-1])],
    }.get(k)


def lower_portable(op):
    """Portable lowering with no BMI2 and no PCLMUL."""
    k = op[0]

    if k == 'LIN_CONST':
        if op[-1] == ONES:
            # Portable implementation of the constant deposit used here.
            return [
                ('IMUL', SPREAD_MUL, None),
                ('AND', HIGH, None),
                ('BSWAP', None, None),
                ('SHR', None, 7),
            ]
        return None

    if k == 'CONV_GF2':
        return [('SCANXOR', None, 1 << i) for i in range(6)]

    if k in ('PERM_DYN_G', 'PERM_DYN_S'):
        return [('LOOP8', op[-1], None)] * 8

    return lower_x86(op)


ISAS = [
    ('x86-64 BMI2 + PCLMUL', lower_x86),
    ('portable (no BMI2, no PCLMUL)', lower_portable),
]


# =====================================================================
# §3  Stage 1 — quotienting
# =====================================================================

def quotient_future(delta, out, states, alphabet=range(256)):
    """Future quotient / Myhill-Nerode-style partition refinement.

    Two states are equivalent when no future continuation can distinguish
    them through `out`.
    """
    part = {}
    for s in states:
        part.setdefault(out(s), set()).add(s)

    cls = {
        s: i
        for i, (_, group) in enumerate(sorted(part.items(), key=lambda kv: repr(kv[0])))
        for s in group
    }

    while True:
        sig = {
            s: (
                cls[s],
                tuple(cls[delta(s, a)] for a in alphabet),
            )
            for s in states
        }

        nxt = {}
        new = {}

        for s in states:
            nxt.setdefault(sig[s], len(nxt))
            new[s] = nxt[sig[s]]

        if new == cls:
            return cls

        cls = new


def obs_identity(y):
    """Exact uint64_t observation: every output bit is observable."""
    return y & M64


def obs_bits(mask):
    """Construct an explicit bit-projection observer.

    Example:
        obs = obs_bits(0xFF)

    means callers observe only the low byte. Bits outside `mask` are true
    don't-cares because the observer explicitly discards them.
    """
    mask &= M64
    return lambda y: y & mask


def observation_equivalent(y, y_prime, obs=obs_identity):
    """Kernel equivalence of the observer.

        y ~ y'    iff    obs(y) == obs(y')
    """
    return obs(y) == obs(y_prime)


def quotient_observation(vals, obs=obs_identity):
    """Observation quotient induced by an explicit observer.

    Args:
        vals: iterable of output values.
        obs:  Output -> Observable. The observable must be hashable.

    Returns:
        A list of equivalence-class IDs aligned with `vals`.

    This function intentionally does NOT inspect which output bits vary.
    Exact output is the default because obs defaults to identity.
    """
    key_to_class = {}
    classes = []

    for v in vals:
        key = obs(v)
        if key not in key_to_class:
            key_to_class[key] = len(key_to_class)
        classes.append(key_to_class[key])

    return classes


def num_observation_classes(vals, obs=obs_identity):
    cls = quotient_observation(vals, obs)
    return len(set(cls))


# =====================================================================
# §4  Stage 2 — solve inside the declared grammar
# =====================================================================

def pdep(v, m):
    """Reference PDEP."""
    r = 0
    j = 0

    for i in range(64):
        if (m >> i) & 1:
            if (v >> j) & 1:
                r |= 1 << i
            j += 1

    return r


def pext(v, m):
    """Reference PEXT."""
    r = 0
    j = 0

    for i in range(64):
        if (m >> i) & 1:
            if (v >> i) & 1:
                r |= 1 << j
            j += 1

    return r


def solve_lin_then_conv(target):
    """Solve

        LIN_CONST(D) ; CONV_Z(M)

    for an exact 8-lane target.

    The specialized solver is exact-output. CONV is linear, so the map is
    determined by the basis {1 << lane}:

        target(1 << lane) = (M << p_lane) mod 2^64

    Lane 0 forces the low part of M; high bits shifted beyond the word are
    residual freedom.
    """
    t0 = target(1)

    if t0 == 0:
        return [], 0, 'lane 0 maps to zero; exact LIN_CONST;CONV_Z has no solution'

    tz = (t0 & -t0).bit_length() - 1
    tg = [target(1 << lane) for lane in range(8)]

    cand = 0
    sols = []

    for p0 in range(tz + 1):
        base = t0 >> p0

        for high in range(1 << p0):
            if p0:
                M = base | (high << (64 - p0))
            else:
                M = base

            M &= M64
            cand += 1

            allowed = [
                [
                    p
                    for p in range(64)
                    if ((M << p) & M64) == tg[lane]
                ]
                for lane in range(8)
            ]

            if any(not positions for positions in allowed):
                continue

            if p0 not in allowed[0]:
                continue

            deposits = []

            def dfs(lane, lower_bound, positions):
                if lane == 8:
                    deposits.append(sum(1 << p for p in positions))
                    return

                for p in allowed[lane]:
                    if p > lower_bound:
                        dfs(lane + 1, p, positions + [p])

            dfs(1, p0, [p0])

            for D in deposits:
                if all(
                    ((pdep(m, D) * M) & M64) == target(m)
                    for m in range(256)
                ):
                    sols.append((D, M))

    sols.sort()
    return sols, cand, None


def solve_dyn_const(target, inner, negate):
    """Solve a dynamic gather with a constant source.

    Forms:
        PERM_DYN_G(K, inner(m))
    or
        NOT PERM_DYN_G(NOT K, inner(m))

    If inner(0xFF) == ~0, then PEXT(K, ~0) == K, so K is forced by one
    input point and can then be checked over the full 256-mask domain.
    """
    if inner(0xFF) != M64:
        return [], 'inner(0xFF) != ~0; K is not forced by one probe'

    K = target(0xFF)

    def f(m):
        src = ((~K) & M64) if negate else K
        v = pext(src, inner(m))
        return ((~v) & M64) if negate else v

    if all(f(m) == target(m) for m in range(256)):
        return [K], None

    return [], 'the forced K fails exact full-domain verification'


# ---------------------------------------------------------------------
# POINT nonlinear search
# ---------------------------------------------------------------------

def enumerate_byte_repeated(pred, probe, shapes):
    """Enumerate repeated-byte constants for small POINT templates."""
    found = []

    for name, build in shapes:
        for cb in range(256):
            C = (cb * ONES) & M64
            if all(build(w, C) == pred(w) for w in probe):
                found.append((name, C))

    return found


BOOLOPS = [
    ('&',    lambda a, b: a & b),
    ('|',    lambda a, b: a | b),
    ('^',    lambda a, b: a ^ b),
    ('andn', lambda a, b: (~a & b) & 0xFF),
]


def shortest_straightline(inputs, names, T, maxlen=5):
    """Find the shortest straight-line Boolean program.

    Once only one bit per lane matters, a three-input Boolean function is
    an 8-bit truth table, so exhaustive search is exact and cheap.
    """

    def rec(vals, nms, k, seen):
        if vals[-1] == T:
            return nms[-1]
        if k == 0:
            return None

        # Feasibility depends only on the set of truth tables already
        # available, not on the particular expressions that produced them.
        # Memoizing that state keeps the exhaustive search exact while
        # avoiding a huge number of equivalent derivation orders.
        key = (frozenset(vals), k)
        if key in seen:
            return None
        seen.add(key)

        for i, j in product(range(len(vals)), repeat=2):
            for opname, f in BOOLOPS:
                v = f(vals[i], vals[j])

                if v in vals:
                    continue

                expr = f'({nms[i]} {opname} {nms[j]})'
                r = rec(vals + [v], nms + [expr], k - 1, seen)

                if r:
                    return r

        return None

    for length in range(1, maxlen + 1):
        r = rec(list(inputs), list(names), length, set())
        if r:
            return length, r

    return None, None


def interpret(seq, m):
    """Interpret one lowered unary instruction chain."""
    cur = m
    loop_done = False

    for instr, c, sh in seq:
        if instr == 'PDEP':
            cur = pdep(cur, c)

        elif instr == 'PEXT':
            cur = pext(c, cur)

        elif instr == 'IMUL':
            cur = (cur * c) & M64

        elif instr == 'AND':
            cur &= c

        elif instr == 'BSWAP':
            cur = int.from_bytes(cur.to_bytes(8, 'little'), 'big')

        elif instr == 'SHR':
            cur >>= sh

        elif instr == 'NOT':
            cur = (~cur) & M64

        elif instr == 'SCANXOR':
            cur = (cur ^ (cur << sh)) & M64

        elif instr == 'LOOP8':
            if loop_done:
                continue
            loop_done = True
            cur = pext(c, cur)

        else:
            raise ValueError(f'unsupported interpreted instruction: {instr}')

    return cur


def verify_exact(seq, target, domain=range(256)):
    """Exact-output verification used by the current Stage 2 prototype."""
    return all(interpret(seq, m) == target(m) for m in domain)


def verify_observed(seq, target, obs, domain=range(256)):
    """Verification modulo an explicit observation quotient.

    This helper is sound for arbitrary observers even though the specialized
    synthesizers above currently derive candidates only for exact outputs.
    """
    return all(
        observation_equivalent(interpret(seq, m), target(m), obs)
        for m in domain
    )


# =====================================================================
# §5  Measurement
# =====================================================================

def E_len(n):
    return 1 if n == 0 else 2 * (n.bit_length() - 1) + 2


def measure(seq):
    """Measure one lowered serialized chain.

    In this prototype the lowering representation is a chain, so

        span == work == len(seq).

    A full version should derive span from an explicit dependency DAG.
    """
    work = len(seq)
    span = len(seq)

    bits = 0
    val = 0

    for _, c, sh in seq:
        bits += OPC
        val = (val << OPC) | 1

        if c is not None:
            bits += 64
            val = (val << 64) | c

        if sh is not None:
            bits += SHB
            val = (val << SHB) | sh

    L = E_len(bits) + bits
    rank = (1 << bits) + val

    return span, work, L, rank


# =====================================================================
# §6  C emission
# =====================================================================

CFORM = {
    'PDEP':
        lambda d, c, s, a:
            f'uint64_t {d} = _pdep_u64({a}, 0x{c:016X}ull);',

    'PEXT':
        lambda d, c, s, a:
            f'uint64_t {d} = _pext_u64(0x{c:016X}ull, {a});',

    'IMUL':
        lambda d, c, s, a:
            f'uint64_t {d} = {a} * 0x{c:016X}ull;',

    'CLMUL':
        lambda d, c, s, a:
            f'uint64_t {d} = clmul64({a}, 0x{c:016X}ull);',

    'AND':
        lambda d, c, s, a:
            f'uint64_t {d} = {a} & 0x{c:016X}ull;',

    'BSWAP':
        lambda d, c, s, a:
            f'uint64_t {d} = __builtin_bswap64({a});',

    'SHR':
        lambda d, c, s, a:
            f'uint64_t {d} = {a} >> {s};',

    'NOT':
        lambda d, c, s, a:
            f'uint64_t {d} = ~{a};',

    'LOOP8':
        lambda d, c, s, a:
            f'uint64_t {d} = qm_perm_loop8(0x{c:016X}ull, {a});',

    'SCANXOR':
        lambda d, c, s, a:
            f'uint64_t {d} = {a} ^ ({a} << {s});',
}


def emit(name, seq):
    """Emit a simple C intrinsic implementation."""
    out = [
        f'static inline uint64_t {name}(uint8_t m)',
        '{',
    ]

    cur = '(uint64_t)m'
    loop_done = False

    for i, (instr, c, sh) in enumerate(seq):
        if instr == 'LOOP8':
            if loop_done:
                continue
            loop_done = True

        v = f't{i}'
        out.append('    ' + CFORM[instr](v, c, sh, cur))
        cur = v

    out += [
        f'    return {cur};',
        '}',
    ]

    return '\n'.join(out)


def emit_absorb_chunk(chunk=8):
    """Emit deferred-reduction GF(2^128) code."""
    lines = [
        'static inline __m128i af_absorb_chunk(const __m128i pw[9],',
        '                                      __m128i h, const uint8_t *m)',
        '{',
        '    __m128i lo, hi, l2, h2;',
        '    af_mul_wide(_mm_xor_si128(h, _mm_loadu_si128('
        '(const __m128i *)m)),',
        f'                pw[{chunk}], &lo, &hi);',
    ]

    for j in range(1, chunk):
        lines += [
            '    af_mul_wide('
            f'_mm_loadu_si128((const __m128i *)(m + {16 * j})),'
            f' pw[{chunk - j}], &l2, &h2);',
            '    lo = _mm_xor_si128(lo, l2);'
            '  hi = _mm_xor_si128(hi, h2);',
        ]

    lines += [
        '    return af_reduce(lo, hi);'
        '   /* linear guard: one reduction per chunk */',
        '}',
    ]

    return '\n'.join(lines)


# =====================================================================
# §7  Target specifications
# =====================================================================

def popcnt(x):
    return bin(x).count('1')


def ranks8(m):
    return sum(
        popcnt(m & ((1 << k) - 1)) << (8 * k)
        for k in range(8)
    )


def bytemask8(m):
    return sum(
        0xFF << (8 * k)
        for k in range(8)
        if (m >> k) & 1
    )


def select8(m):
    r = 0
    j = 0

    for i in range(8):
        if (m >> i) & 1:
            r |= i << (8 * j)
            j += 1

    return r


def shufctl8(m):
    r = 0
    j = 0

    for i in range(8):
        if (m >> i) & 1:
            r |= i << (8 * j)
            j += 1

    while j < 8:
        r |= 0xFF << (8 * j)
        j += 1

    return r


TARGETS = [
    ('ranks8', ranks8),
    ('bytemask8', bytemask8),
    ('select8', select8),
    ('shufctl8', shufctl8),
]


def synth(target, obs=None):
    """Synthesize an abstract program plus residual freedom.

    Current specialized solver contract:
        obs is None  -> exact uint64_t output.

    A non-identity observation quotient changes the search problem because
    candidates only need to satisfy

        obs(candidate(x)) == obs(target(x)).

    The Stage 1 representation and verifier support this exactly, but the
    specialized closed-form Stage 2 solver below intentionally refuses to
    pretend it has searched that larger quotient space.
    """
    if obs is not None:
        raise NotImplementedError(
            'quotient-aware Stage 2 synthesis for non-identity observers '
            'is not implemented in this specialized prototype; use '
            'quotient_observation()/verify_observed() explicitly'
        )

    sols, cand, err = solve_lin_then_conv(target)

    if sols:
        D, M = sols[0]
        return [
            ('LIN_CONST', D),
            ('CONV_Z', M),
        ], len(sols), None

    # Use the uniquely forced bytemask construction as the dynamic mask
    # representation for the next grammar level.
    bs, _, _ = solve_lin_then_conv(bytemask8)
    Db, Mb = bs[0]

    def inner(m):
        return (pdep(m, Db) * Mb) & M64

    for neg in (False, True):
        ks, dyn_err = solve_dyn_const(target, inner, neg)

        if ks:
            K = ks[0]
            program = [
                ('LIN_CONST', Db),
                ('CONV_Z', Mb),
                ('PERM_DYN_G', ((~K) & M64) if neg else K),
            ]

            if neg:
                program.append(('NOT', None))

            return program, 1, None

        err = dyn_err

    return None, 0, err


# =====================================================================
# Main
# =====================================================================

def hr(title):
    print('\n' + '=' * 72 + f'\n{title}\n' + '=' * 72)


def main():
    # -----------------------------------------------------------------
    # Guard derivation
    # -----------------------------------------------------------------
    hr('§1  Guard derivation — guards are derived, not declared')

    print(
        f'  {"mul":6} {"w":>5} {"escape":17} '
        f'{"linear":>7} {"ops":>5}  payment'
    )

    for mul, w, trivial in [
        ('IMUL', 8, False),
        ('CLMUL', 64, True),
        ('CLMUL', 128, False),
    ]:
        guard, linear, n = derive_guard(mul, w, trivial)

        if guard is None:
            payment = '---'
        elif linear:
            payment = 'deferable / amortizable'
        else:
            payment = 'prepay on every operand'

        print(
            f'  {mul:6} {w:>5} {MULS[mul]["escape"]:17} '
            f'{str(linear):>7} {n:>5}  {payment}'
        )

    print('\n  Can the guard move after accumulation?')

    xs = [
        (i * 0x9E3779B97F4A7C15) & M64
        for i in range(60)
    ]

    linz = all(
        imul(a ^ b, ONES << 8, 64)
        == (
            imul(a, ONES << 8, 64)
            ^ imul(b, ONES << 8, 64)
        )
        for a in xs
        for b in xs
    )

    ling = all(
        (clmul(a ^ b, M64, 64) & M64)
        == (
            clmul(a, M64, 64)
            ^ clmul(b, M64, 64)
        ) & M64
        for a in xs
        for b in xs
    )

    ps = [
        clmul(x, (x * 3) & M128, 128)
        for x in xs[:30]
    ]

    linr = all(
        gf128_reduce(p ^ q)
        == (
            gf128_reduce(p)
            ^ gf128_reduce(q)
        )
        for p in ps
        for q in ps
    )

    before = sum(
        1
        for m in range(256)
        if imul(
            sum(
                1 << (8 * i)
                for i in range(8)
                if (m >> i) & 1
            ),
            0x0101010101010100,
            64,
        ) == ranks8(m)
    )

    after = sum(
        1
        for m in range(1, 256)
        if imul(
            m,
            0x0101010101010100,
            64,
        ) == ranks8(m)
    )

    print(f'    CONV_Z is GF(2)-linear       : {linz}')
    print(f'    CONV_GF2 is GF(2)-linear     : {ling}')
    print(f'    reduction is GF(2)-linear    : {linr}')
    print(f'    IMUL guard before convolution: {before} / 256 match')
    print(
        f'    IMUL guard after convolution : {after} / 255 match'
        '   -> carry cannot be moved'
    )

    print('\n  CONV(IMUL, w) lane rule: w >= ceil(log2 n)')

    for n, w in [
        (8, 8),
        (16, 4),
        (32, 2),
        (64, 1),
        (4, 2),
    ]:
        predicted = lane_rule_Z(n, w)

        multiplier = sum(
            1 << (w * i)
            for i in range(1, n)
        )

        measured = all(
            (
                (
                    sum(
                        1 << (w * i)
                        for i in range(n)
                        if (m >> i) & 1
                    )
                    * multiplier
                )
                & ((1 << (w * n)) - 1)
            )
            == sum(
                popcnt(m & ((1 << k) - 1)) << (w * k)
                for k in range(n)
            )
            for m in range(min(1 << n, 2048))
        )

        print(
            f'    n={n:3d} w={w:3d}   '
            f'rule {"OK" if predicted else "FAIL"}   '
            f'measured {"OK" if measured else "FAIL"}   '
            f'{"agree" if predicted == measured else "DISAGREE"}'
        )

    print('\n  Nonzero kernel choices = 2^w - 1')
    for w in (1, 2, 8, 128):
        print(f'    w={w:4d}  nonzero kernels = {2 ** w - 1}')

    # -----------------------------------------------------------------
    # Stage 1: two distinct quotients
    # -----------------------------------------------------------------
    hr('§3  Stage 1 — future quotient and observation quotient are distinct')

    cls = quotient_future(
        lambda s, a: a,
        lambda s: s,
        range(256),
    )

    print('  future quotient example: feed(s,b)=b, read_state(s)=s')
    print(f'    classes = {len(set(cls.values()))}')
    print(f'    quotient map is identity = {all(cls[s] == s for s in range(256))}')

    print('\n  observation quotient: y ~ y\' iff obs(y) == obs(y\')')

    vals = [0x0000000000000100, 0x0000000000000200]
    exact_classes = quotient_observation(vals)
    low8_classes = quotient_observation(vals, obs_bits(0xFF))

    print(f'    values                 = {[hex(v) for v in vals]}')
    print(
        '    exact obs(y)=y         -> '
        f'{len(set(exact_classes))} classes'
    )
    print(
        '    explicit obs(y)=y&0xFF -> '
        f'{len(set(low8_classes))} class'
    )
    print(
        '    constant bits are NOT inferred as don\'t-care; '
        'the observer must say so.'
    )

    # -----------------------------------------------------------------
    # POINT nonlinear enumeration
    # -----------------------------------------------------------------
    hr('§4  POINT nonlinear search — exhaust small constant spaces')

    import random
    random.seed(7)

    probe = [
        random.getrandbits(64)
        for _ in range(2000)
    ] + [0]

    for i in range(8):
        for v in (0x00, 0x01, 0x7F, 0x80, 0xFF):
            probe.append(v << (8 * i))

    def zero_ref(w):
        return sum(
            0x80 << (8 * i)
            for i in range(8)
            if ((w >> (8 * i)) & 0xFF) == 0
        )

    shapes = [
        (
            '(v - C) & ~v & HIGH',
            lambda w, C: (w - C) & (~w & M64) & HIGH,
        ),
        (
            '~(((v & C) + C) | v) & HIGH',
            lambda w, C: (~(((w & C) + C) | w) & M64) & HIGH,
        ),
    ]

    found = enumerate_byte_repeated(zero_ref, probe, shapes)

    print(
        f'  zero-byte spread templates surviving '
        f'{len(probe)} probes:'
    )

    for name, C in found:
        print(f'    {name:32s}  C = 0x{C:016x}')

    bad = next(
        (
            (
                w,
                (w - ONES) & (~w & M64) & HIGH,
                zero_ref(w),
            )
            for w in probe
            if (w - ONES) & (~w & M64) & HIGH != zero_ref(w)
        ),
        None,
    )

    if bad:
        print(
            '  counterexample to (v-ONES)&~v&HIGH as a per-lane mask: '
            f'0x{bad[0]:016x} -> 0x{bad[1]:016x}, '
            f'expected 0x{bad[2]:016x}'
        )

    # -----------------------------------------------------------------
    # POINT Boolean superoptimization
    # -----------------------------------------------------------------
    hr('§4b  POINT superoptimization — exhaust the projected truth table')

    X = 0xF0
    Y = 0xCC
    Z = 0xAA
    H1 = 0xFF

    def truth_table(f):
        return sum(
            f(
                (i >> 2) & 1,
                (i >> 1) & 1,
                i & 1,
            ) << i
            for i in range(8)
        )

    T_lt = truth_table(
        lambda a, b, z:
            ((1 - a) & b)
            | ((1 - (a ^ b)) & (1 - z))
    )

    T_range = truth_table(
        lambda p, q, a:
            p & q & (1 - a)
    )

    for name, target, names in [
        ('lt', T_lt, ('x', 'c', 'z', 'H')),
        ('range', T_range, ('z1', 'z2', 'x', 'H')),
    ]:
        length, expr = shortest_straightline(
            (X, Y, Z, H1),
            names,
            target,
        )

        print(
            f'  {name:6} target 0x{target:02X}   '
            f'shortest {length} ops   {expr}'
        )

    print('  lt: 2 ops to build z + 5 Boolean ops = 7.')
    print('  range: z1/z2 + Boolean tail = 7 in the declared POINT grammar.')

    # -----------------------------------------------------------------
    # Stage 2 synthesis and lowering
    # -----------------------------------------------------------------
    hr('§5  Stage 2 — exact-output synthesis, then ISA lowering')

    for name, target in TARGETS:
        program, freedom, err = synth(target)

        if program is None:
            print(f'\n### {name}   no solution — {err}')
            continue

        if freedom == 1:
            note = '(constant forced by the exact specification)'
        elif freedom > 1:
            note = '(fourth key required)'
        else:
            note = ''

        print(
            f'\n### {name}   residual freedom = {freedom}   {note}'
        )

        print(
            '  abstract: '
            + ' ; '.join(op[0] for op in program)
        )

        for isa_name, lower in ISAS:
            seq = []
            failed = False

            for op in program:
                lowered = lower(op)

                if lowered is None:
                    failed = True
                    break

                seq += lowered

            if failed:
                print(f'  {isa_name:32s}  cannot lower')
                continue

            span, work, L, _ = measure(seq)
            ok = verify_exact(seq, target)

            print(
                f'  {isa_name:32s}  '
                f'span {span:2d} / work {work:2d}   '
                f'L={L:4d} bit = {-(-L // 8):3d} byte   '
                f'verification {"OK" if ok else "FAIL"}'
            )

            print('    ' + ' '.join(instr for instr, _, _ in seq))

        seq = []
        for op in program:
            seq += lower_x86(op)

        print(emit(name, seq))

    # -----------------------------------------------------------------
    # Guard-hoisting normalization
    # -----------------------------------------------------------------
    hr('§6  Normalization — hoist a linear guard outside an XOR fold')

    CH = 8
    naive = CH * (3 + 2)
    deferred = CH * 3 + 2

    print(f'  abstract:       CONV(CLMUL,128) x {CH}')
    print(f'  naive:          {naive} ops  ({naive / CH:.2f} / block)')
    print(
        f'  normalized:     {deferred} ops  '
        f'({deferred / CH:.2f} / block)   '
        f'{naive / deferred:.2f}x'
    )

    k = 0x0123456789ABCDEFFEDCBA9876543210

    pw = [1]
    for _ in range(CH):
        pw.append(gf128_mul(pw[-1], k))

    blocks = [
        (0x9E3779B97F4A7C15 * (i + 3)) & M128
        for i in range(CH)
    ]

    h = 0
    for block in blocks:
        h = gf128_mul(h ^ block, k)

    acc = clmul(blocks[0], pw[CH], 128)
    for j in range(1, CH):
        acc ^= clmul(blocks[j], pw[CH - j], 128)

    print(
        '  semantics preserved: '
        f'{"OK" if h == gf128_reduce(acc) else "FAIL"}'
    )

    print()
    print(emit_absorb_chunk(CH))



# =====================================================================
# §8  x86-64 assembly semantic frontend
#
# Supports the compiler-output subset used by QM experiments:
# GPR integer/flags, all Jcc/SETcc/CMOVcc conditions, BMI1/BMI2,
# scalar memory, stack/direct internal calls, SSE/SSSE3/PCLMUL, AVX2.
# =====================================================================

import re
from dataclasses import dataclass

M64 = (1 << 64) - 1

# ---------------------------------------------------------------------------
# Register model
# ---------------------------------------------------------------------------

BASE_REGS = ['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp'] + [f'r{i}' for i in range(8,16)]
ALIAS = {}
for b in BASE_REGS:
    if b.startswith('r') and b[1:].isdigit():
        n = b[1:]
        ALIAS[b] = (b,64,0); ALIAS[b+'d'] = (b,32,0); ALIAS[b+'w'] = (b,16,0); ALIAS[b+'b'] = (b,8,0)
    else:
        names = {
            'rax':('eax','ax','al','ah'), 'rbx':('ebx','bx','bl','bh'),
            'rcx':('ecx','cx','cl','ch'), 'rdx':('edx','dx','dl','dh'),
            'rsi':('esi','si','sil',None), 'rdi':('edi','di','dil',None),
            'rbp':('ebp','bp','bpl',None), 'rsp':('esp','sp','spl',None),
        }
        e,w,l,h = names[b]
        ALIAS[b]=(b,64,0); ALIAS[e]=(b,32,0); ALIAS[w]=(b,16,0); ALIAS[l]=(b,8,0)
        if h: ALIAS[h]=(b,8,8)

VEC_RE = re.compile(r'^(xmm|ymm)(\d+)$')
MEM_RE = re.compile(r'^(?:(byte|word|dword|qword|xmmword|ymmword)\s+ptr\s+)?(\[.*\])$', re.I)
MEM_BITS = {'byte':8,'word':16,'dword':32,'qword':64,'xmmword':128,'ymmword':256}


def maskw(w: int) -> int:
    return (1 << w) - 1 if w < 256 else (1 << w) - 1


def sign_extend(v: int, srcw: int, dstw: int) -> int:
    v &= maskw(srcw)
    if v >> (srcw - 1):
        v -= 1 << srcw
    return v & maskw(dstw)


def signed(v: int, w: int) -> int:
    v &= maskw(w)
    return v - (1 << w) if v >> (w - 1) else v


def parity8(v: int) -> int:
    return int(((v & 0xff).bit_count() & 1) == 0)


def read_reg(regs, name):
    b,w,off = ALIAS[name]
    return (regs[b] >> off) & maskw(w)


def write_reg(regs, name, v):
    b,w,off = ALIAS[name]; v &= maskw(w)
    if w == 64:
        regs[b] = v
    elif w == 32 and off == 0:
        # x86-64 32-bit GPR write zero-extends to 64 bits.
        regs[b] = v
    else:
        m = maskw(w) << off
        regs[b] = (regs[b] & ~m) | (v << off)
    regs[b] &= M64


def width_of_reg(name):
    if name in ALIAS:
        return ALIAS[name][1]
    m = VEC_RE.match(name)
    if m:
        return 128 if m.group(1) == 'xmm' else 256
    raise KeyError(name)


def vec_index(name):
    m = VEC_RE.match(name)
    if not m:
        raise KeyError(name)
    return int(m.group(2)), (128 if m.group(1) == 'xmm' else 256)


def read_vec(vregs, name):
    i,w = vec_index(name)
    return vregs[i] & maskw(w)


def write_vec(vregs, name, v, vex=False):
    i,w = vec_index(name)
    v &= maskw(w)
    if w == 256:
        vregs[i] = v
    else:
        # Legacy SSE preserves upper 128 of YMM; VEX-encoded 128-bit writes zero it.
        if vex:
            vregs[i] = v
        else:
            vregs[i] = (vregs[i] & (maskw(128) << 128)) | v


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------

class Memory:
    """Sparse little-endian byte-addressed memory."""
    def __init__(self):
        self.bytes = {}

    def clone(self):
        m = Memory(); m.bytes = dict(self.bytes); return m

    def store(self, addr, value, bits):
        n = bits // 8
        for i in range(n):
            self.bytes[(addr + i) & M64] = (value >> (8*i)) & 0xff

    def load(self, addr, bits):
        n = bits // 8
        r = 0
        for i in range(n):
            r |= self.bytes.get((addr + i) & M64, 0) << (8*i)
        return r

    def store_bytes(self, addr, data: bytes):
        for i,b in enumerate(data):
            self.bytes[(addr+i)&M64] = b


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def split_ops(s):
    out=[]; cur=''; depth=0
    for ch in s:
        if ch=='[': depth += 1
        elif ch==']': depth -= 1
        if ch==',' and depth==0:
            out.append(cur.strip()); cur=''
        else:
            cur += ch
    if cur.strip(): out.append(cur.strip())
    return out


def parse_imm(x):
    x = x.strip()
    # Clang Intel syntax occasionally uses bare negative hex.
    if x.startswith('-0x'): return -int(x[3:],16)
    if x.startswith('0x'): return int(x,16)
    # Single character immediates are not expected from compiler output.
    return int(x,10)


def parse_mem(op):
    m = MEM_RE.match(op.strip())
    if not m: return None
    sz, expr = m.groups()
    return (MEM_BITS[sz.lower()] if sz else None, expr)


def eval_addr(regs, expr, symbols=None, rip=0):
    assert expr.startswith('[') and expr.endswith(']')
    e = expr[1:-1].replace(' ','')
    # Turn subtraction into +(-term), preserving leading '-'.
    e = re.sub(r'(?<!^)-', '+-', e)
    total = 0
    symbols = symbols or {}
    for term in e.split('+'):
        if not term: continue
        if '*' in term:
            a,b = term.split('*',1)
            if a in ALIAS:
                total += read_reg(regs,a) * parse_imm(b)
            elif b in ALIAS:
                total += parse_imm(a) * read_reg(regs,b)
            else:
                av = symbols.get(a, None); bv = symbols.get(b, None)
                if av is not None and bv is not None: total += av*bv
                else: total += parse_imm(a)*parse_imm(b)
        elif term in ALIAS:
            total += read_reg(regs,term)
        elif term == 'rip':
            total += rip
        elif term in symbols:
            total += symbols[term]
        elif term.startswith('-') and term[1:] in symbols:
            total -= symbols[term[1:]]
        else:
            total += parse_imm(term)
    return total & M64


def parse_asm(path):
    """Parse compiler-generated Intel syntax into per-function instruction lists."""
    funcs={}; current=None
    for raw in open(path):
        line = raw.split('#',1)[0].strip()
        if not line: continue
        if line.startswith('.') and not line.startswith('.L'): continue
        if line.endswith(':'):
            lab=line[:-1]
            if not lab.startswith('.L'):
                current=lab; funcs[current]=[]
            elif current:
                funcs[current].append(('LABEL',lab,raw.rstrip()))
            continue
        if current:
            if line.startswith('.'): continue
            parts=line.split(None,1)
            op=parts[0].lower(); ops=split_ops(parts[1]) if len(parts)>1 else []
            funcs[current].append((op,ops,raw.rstrip()))
    return funcs


# ---------------------------------------------------------------------------
# Flags and conditions
# ---------------------------------------------------------------------------

def set_logic_flags(flags, r, w):
    r &= maskw(w)
    flags.update(ZF=int(r==0), SF=(r>>(w-1))&1, PF=parity8(r), CF=0, OF=0)


def set_add_flags(flags, a, b, carry, r, w):
    m=maskw(w); full=a+b+carry
    sa=(a>>(w-1))&1; sb=(b>>(w-1))&1; sr=(r>>(w-1))&1
    flags.update(
        ZF=int((r&m)==0), SF=sr, PF=parity8(r),
        CF=int(full>m), OF=int(sa==sb and sr!=sa)
    )


def set_sub_flags(flags, a, b, borrow, r, w):
    bb=b+borrow; sa=(a>>(w-1))&1; sb=(b>>(w-1))&1; sr=(r>>(w-1))&1
    flags.update(
        ZF=int((r&maskw(w))==0), SF=sr, PF=parity8(r),
        CF=int(a<bb), OF=int(sa!=sb and sr!=sa)
    )


def cond_true(cc, f):
    cc=cc.lower()
    aliases = {
        'e':'z','ne':'nz','c':'b','nae':'b','nb':'ae','nc':'ae',
        'na':'be','nbe':'a','pe':'p','po':'np','nge':'l','nl':'ge',
        'ng':'le','nle':'g'
    }
    cc=aliases.get(cc,cc)
    z,s,c,o,p=f['ZF'],f['SF'],f['CF'],f['OF'],f['PF']
    table={
        'o':o==1, 'no':o==0,
        'b':c==1, 'ae':c==0,
        'z':z==1, 'nz':z==0,
        'be':c==1 or z==1, 'a':c==0 and z==0,
        's':s==1, 'ns':s==0,
        'p':p==1, 'np':p==0,
        'l':s!=o, 'ge':s==o,
        'le':z==1 or s!=o, 'g':z==0 and s==o,
    }
    if cc not in table: raise NotImplementedError(f'condition {cc}')
    return table[cc]


# ---------------------------------------------------------------------------
# Generic operand access
# ---------------------------------------------------------------------------

def infer_mem_bits(other_op):
    if other_op in ALIAS or VEC_RE.match(other_op):
        return width_of_reg(other_op)
    return None


def read_operand(regs, vregs, mem, op, bits=None, symbols=None, rip=0):
    op=op.strip()
    if op in ALIAS: return read_reg(regs,op)
    if VEC_RE.match(op): return read_vec(vregs,op)
    mo=parse_mem(op)
    if mo:
        mbits,expr=mo; w=mbits or bits
        if w is None: raise ValueError(f'cannot infer memory width: {op}')
        return mem.load(eval_addr(regs,expr,symbols,rip),w)
    return parse_imm(op)


def write_operand(regs, vregs, mem, op, value, bits=None, symbols=None, rip=0, vex=False):
    op=op.strip()
    if op in ALIAS:
        write_reg(regs,op,value); return
    if VEC_RE.match(op):
        write_vec(vregs,op,value,vex=vex); return
    mo=parse_mem(op)
    if mo:
        mbits,expr=mo; w=mbits or bits
        if w is None: raise ValueError(f'cannot infer memory width: {op}')
        mem.store(eval_addr(regs,expr,symbols,rip),value,w); return
    raise ValueError(f'not writable: {op}')


# ---------------------------------------------------------------------------
# Bit-manipulation and SIMD helpers
# ---------------------------------------------------------------------------

def pdep(v,m,w=64):
    r=j=0
    for i in range(w):
        if (m>>i)&1:
            if (v>>j)&1: r |= 1<<i
            j += 1
    return r


def pext(v,m,w=64):
    r=j=0
    for i in range(w):
        if (m>>i)&1:
            if (v>>i)&1: r |= 1<<j
            j += 1
    return r


def clmul64(a,b):
    r=0
    for i in range(64):
        if (b>>i)&1: r ^= a<<i
    return r & maskw(128)


def lane_map1(v,total,lane_bits,fn):
    r=0; lm=maskw(lane_bits)
    for off in range(0,total,lane_bits):
        r |= (fn((v>>off)&lm)&lm)<<off
    return r


def lane_map2(a,b,total,lane_bits,fn):
    r=0; lm=maskw(lane_bits)
    for off in range(0,total,lane_bits):
        r |= (fn((a>>off)&lm,(b>>off)&lm)&lm)<<off
    return r


def pshufb(src,ctl,total):
    r=0
    # AVX2 PSHUFB operates independently in each 128-bit lane.
    for block in range(0,total,128):
        for j in range(16):
            c=(ctl>>(block+8*j))&0xff
            if c&0x80: b=0
            else:
                idx=c&0x0f
                b=(src>>(block+8*idx))&0xff
            r |= b<<(block+8*j)
    return r


def pmovmskb(v,total):
    r=0
    for j in range(total//8):
        r |= ((v>>(8*j+7))&1)<<j
    return r


# ---------------------------------------------------------------------------
# Interpreter
# ---------------------------------------------------------------------------

def run_func(code, args=(), *, memory=None, symbols=None, maxsteps=100000,
             initial_regs=None, initial_vec=None, initial_flags=None, return_state=False,
             functions=None):
    regs={b:0 for b in BASE_REGS}
    if initial_regs: regs.update({k:v&M64 for k,v in initial_regs.items()})
    vregs={i:0 for i in range(32)}
    if initial_vec:
        for k,v in initial_vec.items():
            i,_=vec_index(k) if isinstance(k,str) else (k,256)
            vregs[i]=v&maskw(256)
    # Share an explicitly supplied Memory object so direct calls observe the same heap/stack.
    mem = memory if isinstance(memory,Memory) else Memory()
    symbols=symbols or {}

    aregs=['rdi','rsi','rdx','rcx','r8','r9']
    for r,v in zip(aregs,args): regs[r]=v&M64
    # Give stack operations a harmless sparse address range.
    if regs['rsp']==0: regs['rsp']=0x7fff00000000

    flags={'ZF':0,'SF':0,'CF':0,'OF':0,'PF':0}
    if initial_flags: flags.update(initial_flags)
    labels={ins[1]:i for i,ins in enumerate(code) if ins[0]=='LABEL'}
    pc=0; steps=0

    def get(op,bits=None): return read_operand(regs,vregs,mem,op,bits,symbols,pc)
    def put(op,v,bits=None,vex=False): return write_operand(regs,vregs,mem,op,v,bits,symbols,pc,vex=vex)

    while pc < len(code):
        steps += 1
        if steps>maxsteps: raise RuntimeError('step limit')
        op,ops,raw=code[pc]
        if op=='LABEL': pc+=1; continue
        jump=None

        # ----- data movement ------------------------------------------------
        if op in ('mov','movabs'):
            dbits = width_of_reg(ops[0]) if (ops[0] in ALIAS or VEC_RE.match(ops[0])) else (parse_mem(ops[0]) or (None,None))[0]
            sbits = dbits or infer_mem_bits(ops[0])
            put(ops[0],get(ops[1],sbits),dbits)
        elif op in ('movzx','movsx','movsxd'):
            dst=ops[0]; src=ops[1]; dw=width_of_reg(dst)
            if src in ALIAS: sw=width_of_reg(src)
            else:
                mo=parse_mem(src); sw=(mo[0] if mo else None)
                if op=='movsxd' and sw is None: sw=32
                if sw is None: raise ValueError(f'need explicit source width: {raw}')
            x=get(src,sw)
            put(dst, x if op=='movzx' else sign_extend(x,sw,dw), dw)
        elif op in ('movd','movq','vmovd','vmovq'):
            baseop=op[1:] if op.startswith('v') else op
            vex=op.startswith('v')
            w=32 if baseop=='movd' else 64
            if VEC_RE.match(ops[0]): put(ops[0],get(ops[1],w),128,vex=vex)
            else: put(ops[0],get(ops[1],128)&maskw(w),w)
        elif op in ('movdqa','movdqu','movaps','movups','vmovdqa','vmovdqu','vmovaps','vmovups'):
            vex=op.startswith('v')
            dbits=width_of_reg(ops[0]) if VEC_RE.match(ops[0]) else (parse_mem(ops[0]) or (None,None))[0]
            if dbits is None and VEC_RE.match(ops[1]): dbits=width_of_reg(ops[1])
            put(ops[0],get(ops[1],dbits),dbits,vex=vex)

        # ----- scalar integer/bitwise ---------------------------------------
        elif op in ('and','or','xor'):
            w=width_of_reg(ops[0]); a=get(ops[0]); b=get(ops[1],w)
            r={'and':a&b,'or':a|b,'xor':a^b}[op]&maskw(w)
            put(ops[0],r,w); set_logic_flags(flags,r,w)
        elif op=='not':
            w=width_of_reg(ops[0]); put(ops[0],(~get(ops[0]))&maskw(w),w)
        elif op=='neg':
            w=width_of_reg(ops[0]); a=get(ops[0]); r=(-a)&maskw(w); put(ops[0],r,w)
            set_sub_flags(flags,0,a,0,r,w); flags['CF']=int(a!=0)
        elif op in ('add','sub','adc','sbb'):
            w=width_of_reg(ops[0]); a=get(ops[0]); b=get(ops[1],w)
            if op in ('add','adc'):
                c=flags['CF'] if op=='adc' else 0; r=(a+b+c)&maskw(w); put(ops[0],r,w); set_add_flags(flags,a,b,c,r,w)
            else:
                c=flags['CF'] if op=='sbb' else 0; r=(a-b-c)&maskw(w); put(ops[0],r,w); set_sub_flags(flags,a,b,c,r,w)
        elif op in ('inc','dec'):
            w=width_of_reg(ops[0]); a=get(ops[0]); oldcf=flags['CF']
            if op=='inc': r=(a+1)&maskw(w); set_add_flags(flags,a,1,0,r,w)
            else: r=(a-1)&maskw(w); set_sub_flags(flags,a,1,0,r,w)
            flags['CF']=oldcf; put(ops[0],r,w)
        elif op=='imul':
            if len(ops)==1:
                src=ops[0]; w=width_of_reg(src) if src in ALIAS else 64
                a=signed(read_reg(regs,'rax' if w==64 else 'eax'),w); b=signed(get(src,w),w)
                full=a*b; lo=full&maskw(w); hi=(full>>w)&maskw(w)
                write_reg(regs,'rax' if w==64 else 'eax',lo); write_reg(regs,'rdx' if w==64 else 'edx',hi)
                fits=(signed(lo,w)==full); flags['CF']=flags['OF']=int(not fits)
            elif len(ops)==2:
                dst,src=ops; w=width_of_reg(dst); a=signed(get(dst),w); b=signed(get(src,w),w); full=a*b; r=full&maskw(w); put(dst,r,w)
                flags['CF']=flags['OF']=int(signed(r,w)!=full)
            elif len(ops)==3:
                dst,aop,bop=ops; w=width_of_reg(dst); full=signed(get(aop,w),w)*signed(get(bop,w),w); r=full&maskw(w); put(dst,r,w)
                flags['CF']=flags['OF']=int(signed(r,w)!=full)
            else: raise NotImplementedError(raw)
        elif op=='mul':
            src=ops[0]; w=width_of_reg(src) if src in ALIAS else 64
            a=read_reg(regs,'rax' if w==64 else 'eax'); b=get(src,w); full=a*b
            lo=full&maskw(w); hi=(full>>w)&maskw(w)
            write_reg(regs,'rax' if w==64 else 'eax',lo); write_reg(regs,'rdx' if w==64 else 'edx',hi)
            flags['CF']=flags['OF']=int(hi!=0)
        elif op in ('div','idiv'):
            src=ops[0]; w=width_of_reg(src) if src in ALIAS else 64; d=get(src,w)
            if d==0: raise ZeroDivisionError('x86 division by zero')
            hi=read_reg(regs,'rdx' if w==64 else 'edx'); lo=read_reg(regs,'rax' if w==64 else 'eax'); dividend=(hi<<w)|lo
            if op=='div': q,r=divmod(dividend,d)
            else:
                sd=signed(d,w); sdiv=signed(dividend,2*w); q=abs(sdiv)//abs(sd); q = -q if (sdiv<0)^(sd<0) else q; r=sdiv-q*sd
            if not (0<=q<=maskw(w)) and op=='div': raise OverflowError('x86 div quotient overflow')
            if op=='idiv' and not (-(1<<(w-1))<=q<(1<<(w-1))): raise OverflowError('x86 idiv quotient overflow')
            write_reg(regs,'rax' if w==64 else 'eax',q); write_reg(regs,'rdx' if w==64 else 'edx',r)
        elif op in ('shl','sal','shr','sar'):
            w=width_of_reg(ops[0]); a=get(ops[0]); rawc=get(ops[1]) if len(ops)>1 else 1; c=rawc & (0x3f if w==64 else 0x1f)
            if c==0: r=a
            elif op in ('shl','sal'):
                flags['CF']=(a>>(w-c))&1 if c<=w else 0; r=(a<<c)&maskw(w)
                if c==1: flags['OF']=((r>>(w-1))&1)^flags['CF']
            elif op=='shr':
                flags['CF']=(a>>(c-1))&1 if c<=w else 0; r=(a>>c)&maskw(w)
                if c==1: flags['OF']=(a>>(w-1))&1
            else:
                flags['CF']=(a>>(c-1))&1 if c<=w else 0; r=(signed(a,w)>>c)&maskw(w)
                if c==1: flags['OF']=0
            put(ops[0],r,w); flags['ZF']=int(r==0); flags['SF']=(r>>(w-1))&1; flags['PF']=parity8(r)
        elif op in ('shlx','shrx','sarx'):
            dst,src,cnt=ops; w=width_of_reg(dst); c=get(cnt)&(w-1); a=get(src,w)
            if op=='shlx': r=(a<<c)&maskw(w)
            elif op=='shrx': r=(a>>c)&maskw(w)
            else: r=(signed(a,w)>>c)&maskw(w)
            put(dst,r,w)
        elif op in ('rol','ror'):
            w=width_of_reg(ops[0]); a=get(ops[0]); c=get(ops[1])%w
            if c:
                if op=='rol': r=((a<<c)|(a>>(w-c)))&maskw(w); flags['CF']=r&1
                else: r=((a>>c)|(a<<(w-c)))&maskw(w); flags['CF']=(r>>(w-1))&1
                put(ops[0],r,w)
        elif op=='lea':
            put(ops[0],eval_addr(regs,ops[1],symbols,pc),width_of_reg(ops[0]))
        elif op in ('test','cmp'):
            w=width_of_reg(ops[0]) if ops[0] in ALIAS else ((parse_mem(ops[0]) or (None,None))[0] or width_of_reg(ops[1]))
            a=get(ops[0],w); b=get(ops[1],w)
            if op=='test': set_logic_flags(flags,a&b,w)
            else:
                r=(a-b)&maskw(w); set_sub_flags(flags,a,b,0,r,w)
        elif op=='bt':
            w=width_of_reg(ops[0]); a=get(ops[0]); c=get(ops[1])&(w-1); flags['CF']=(a>>c)&1
        elif op in ('popcnt','tzcnt','lzcnt'):
            dst,src=ops; w=width_of_reg(dst); a=get(src,w)
            if op=='popcnt': r=a.bit_count(); flags['ZF']=int(a==0); flags['CF']=flags['OF']=0
            elif op=='tzcnt': r=w if a==0 else (a&-a).bit_length()-1; flags['CF']=int(a==0); flags['ZF']=int(r==0)
            else: r=w if a==0 else w-a.bit_length(); flags['CF']=int(a==0); flags['ZF']=int(r==0)
            put(dst,r,w)
        elif op in ('pdep','pext'):
            dst,src,msk=ops; w=width_of_reg(dst); a=get(src,w); m=get(msk,w); put(dst,pdep(a,m,w) if op=='pdep' else pext(a,m,w),w)
        elif op=='andn':
            dst,aop,bop=ops; w=width_of_reg(dst); put(dst,(~get(aop,w))&get(bop,w)&maskw(w),w)
        elif op in ('blsi','blsr','blsmsk'):
            dst,src=ops; w=width_of_reg(dst); a=get(src,w)
            if op=='blsi': r=a & (-a & maskw(w))
            elif op=='blsr': r=a & ((a-1)&maskw(w))
            else: r=a ^ ((a-1)&maskw(w))
            put(dst,r,w); flags['ZF']=int(r==0); flags['CF']=int(a==0)
        elif op=='bzhi':
            dst,src,idx=ops; w=width_of_reg(dst); a=get(src,w); i=get(idx)&0xff
            r=a if i>=w else a&maskw(i); put(dst,r,w); flags['CF']=int(i>=w); flags['ZF']=int(r==0)
        elif op=='bextr':
            dst,src,ctl=ops; w=width_of_reg(dst); a=get(src,w); c=get(ctl,w); start=c&0xff; ln=(c>>8)&0xff
            r=0 if start>=w or ln==0 else (a>>start)&maskw(min(ln,w-start)); put(dst,r,w); flags['ZF']=int(r==0); flags['CF']=flags['OF']=0

        # ----- conditions ----------------------------------------------------
        elif op.startswith('set'):
            cc=op[3:]; put(ops[0],1 if cond_true(cc,flags) else 0,8)
        elif op.startswith('cmov'):
            cc=op[4:]
            if cond_true(cc,flags): put(ops[0],get(ops[1],width_of_reg(ops[0])),width_of_reg(ops[0]))
        elif op.startswith('j') and op!='jmp':
            cc=op[1:]
            if cond_true(cc,flags): jump=labels[ops[0]]
        elif op=='jmp':
            jump=labels[ops[0]]

        # ----- stack ---------------------------------------------------------
        elif op=='push':
            regs['rsp']=(regs['rsp']-8)&M64; mem.store(regs['rsp'],get(ops[0],64),64)
        elif op=='pop':
            put(ops[0],mem.load(regs['rsp'],64),64); regs['rsp']=(regs['rsp']+8)&M64
        elif op=='leave':
            regs['rsp']=regs['rbp']; regs['rbp']=mem.load(regs['rsp'],64); regs['rsp']=(regs['rsp']+8)&M64
        elif op=='call':
            target=ops[0].split('@',1)[0]
            if functions is None or target not in functions:
                raise NotImplementedError(f'external/unknown call {ops[0]}: {raw}')
            # Model the architectural return-address push so stack-frame offsets match.
            regs['rsp']=(regs['rsp']-8)&M64
            mem.store(regs['rsp'],0xC011CA11C011CA11,64)
            vec_init={f'ymm{i}':v for i,v in vregs.items()}
            _,substeps,st=run_func(
                functions[target], (), memory=mem, symbols=symbols,
                maxsteps=maxsteps-steps, initial_regs=regs, initial_vec=vec_init,
                initial_flags=flags, return_state=True, functions=functions)
            steps += substeps
            regs=st['regs']; vregs=st['vregs']; flags=st['flags']; mem=st['memory']
            # RET in the recursive interpreter does not pop; complete CALL/RET here.
            regs['rsp']=(regs['rsp']+8)&M64

        # ----- legacy SIMD ---------------------------------------------------
        elif op in ('pxor','pand','por','pandn','paddb','psubb','pminub','pcmpeqb','pcmpgtb','paddw','psubw','pcmpeqw','pcmpeqd'):
            dst,src=ops; total=width_of_reg(dst); a=get(dst,total); b=get(src,total)
            if op=='pxor': r=a^b
            elif op=='pand': r=a&b
            elif op=='por': r=a|b
            elif op=='pandn': r=(~a)&b&maskw(total)
            elif op in ('paddb','psubb','pminub','pcmpeqb','pcmpgtb'):
                if op=='paddb': fn=lambda x,y:x+y
                elif op=='psubb': fn=lambda x,y:x-y
                elif op=='pminub': fn=min
                elif op=='pcmpeqb': fn=lambda x,y:0xff if x==y else 0
                else: fn=lambda x,y:0xff if signed(x,8)>signed(y,8) else 0
                r=lane_map2(a,b,total,8,fn)
            elif op in ('paddw','psubw','pcmpeqw'):
                fn=(lambda x,y:x+y) if op=='paddw' else ((lambda x,y:x-y) if op=='psubw' else (lambda x,y:0xffff if x==y else 0))
                r=lane_map2(a,b,total,16,fn)
            else:
                r=lane_map2(a,b,total,32,lambda x,y:0xffffffff if x==y else 0)
            put(dst,r,total)
        elif op=='pshufb':
            dst,ctl=ops; total=width_of_reg(dst); put(dst,pshufb(get(dst,total),get(ctl,total),total),total)
        elif op=='pmovmskb':
            dst,src=ops; total=width_of_reg(src); put(dst,pmovmskb(get(src,total),total),width_of_reg(dst))
        elif op in ('psllq','psrlq','pslld','psrld','psllw','psrlw'):
            dst,cnt=ops; total=width_of_reg(dst); c=get(cnt); lane={'q':64,'d':32,'w':16}[op[-1]]; a=get(dst,total)
            if op.startswith('psll'): fn=lambda x,_:(x<<c) if c<lane else 0
            else: fn=lambda x,_:(x>>c) if c<lane else 0
            put(dst,lane_map1(a,total,lane,lambda x:fn(x,0)),total)
        elif op in ('pslldq','psrldq'):
            dst,cnt=ops; total=width_of_reg(dst); c=get(cnt); a=get(dst,total); r=0
            # Per 128-bit lane.
            for block in range(0,total,128):
                q=(a>>block)&maskw(128)
                q=((q<<(8*c)) if op=='pslldq' else (q>>(8*c)))&maskw(128)
                r|=q<<block
            put(dst,r,total)
        elif op=='pclmulqdq':
            dst,src,imm=ops; a=get(dst,128); b=get(src,128); c=get(imm)&0xff
            aa=(a>>(64 if c&1 else 0))&M64; bb=(b>>(64 if c&0x10 else 0))&M64
            put(dst,clmul64(aa,bb),128)

        # ----- AVX / AVX2 ----------------------------------------------------
        elif op in ('vpxor','vpand','vpor','vpandn','vpaddb','vpsubb','vpminub','vpcmpeqb','vpcmpgtb','vpaddw','vpsubw','vpcmpeqw','vpcmpeqd'):
            dst,aop,bop=ops; total=width_of_reg(dst); a=get(aop,total); b=get(bop,total)
            base=op[1:]
            if base=='pxor': r=a^b
            elif base=='pand': r=a&b
            elif base=='por': r=a|b
            elif base=='pandn': r=(~a)&b&maskw(total)
            elif base in ('paddb','psubb','pminub','pcmpeqb','pcmpgtb'):
                if base=='paddb': fn=lambda x,y:x+y
                elif base=='psubb': fn=lambda x,y:x-y
                elif base=='pminub': fn=min
                elif base=='pcmpeqb': fn=lambda x,y:0xff if x==y else 0
                else: fn=lambda x,y:0xff if signed(x,8)>signed(y,8) else 0
                r=lane_map2(a,b,total,8,fn)
            elif base in ('paddw','psubw','pcmpeqw'):
                fn=(lambda x,y:x+y) if base=='paddw' else ((lambda x,y:x-y) if base=='psubw' else (lambda x,y:0xffff if x==y else 0))
                r=lane_map2(a,b,total,16,fn)
            else: r=lane_map2(a,b,total,32,lambda x,y:0xffffffff if x==y else 0)
            put(dst,r,total,vex=True)
        elif op=='vpshufb':
            dst,src,ctl=ops; total=width_of_reg(dst); put(dst,pshufb(get(src,total),get(ctl,total),total),total,vex=True)
        elif op=='vpmovmskb':
            dst,src=ops; total=width_of_reg(src); put(dst,pmovmskb(get(src,total),total),width_of_reg(dst))
        elif op=='vpbroadcastb':
            dst,src=ops; total=width_of_reg(dst); b=get(src,8)&0xff; r=sum(b<<(8*i) for i in range(total//8)); put(dst,r,total,vex=True)
        elif op in ('vpsllq','vpsrlq','vpslld','vpsrld','vpsllw','vpsrlw'):
            dst,src,cnt=ops; total=width_of_reg(dst); c=get(cnt); lane={'q':64,'d':32,'w':16}[op[-1]]; a=get(src,total)
            if op.startswith('vpsll'): fn=lambda x:(x<<c) if c<lane else 0
            else: fn=lambda x:(x>>c) if c<lane else 0
            put(dst,lane_map1(a,total,lane,fn),total,vex=True)
        elif op=='vpclmulqdq':
            dst,aop,bop,imm=ops; a=get(aop,128); b=get(bop,128); c=get(imm)&0xff
            aa=(a>>(64 if c&1 else 0))&M64; bb=(b>>(64 if c&0x10 else 0))&M64
            put(dst,clmul64(aa,bb),128,vex=True)
        elif op=='vextracti128':
            dst,src,imm=ops; lane=(get(imm)&1); put(dst,(get(src,256)>>(128*lane))&maskw(128),128)
        elif op=='vinserti128':
            dst,aop,bop,imm=ops; lane=get(imm)&1; a=get(aop,256); b=get(bop,128); m=maskw(128)<<(128*lane); r=(a&~m)|(b<<(128*lane)); put(dst,r,256,vex=True)
        elif op=='vzeroupper':
            for i in vregs: vregs[i] &= maskw(128)

        elif op=='ret':
            if return_state:
                return regs['rax'],steps,{'regs':regs,'vregs':vregs,'flags':flags,'memory':mem}
            return regs['rax'],steps
        elif op in ('nop','endbr64'):
            pass
        else:
            raise NotImplementedError(f'{op}: {raw}')

        pc = jump if jump is not None else pc+1

    raise RuntimeError('fell off')


# =====================================================================
# §9  Complete application-level x86-64 execution oracle
# =====================================================================
#
# The handwritten interpreter above remains a fast, inspectable path for
# common compiler output, but it is NOT the instruction-coverage boundary.
# Unknown instructions fall back to executing the original function in an
# isolated helper process. Native hardware (or an optional emulator such as
# Intel SDE) supplies concrete instruction semantics.
#
# Consequences:
#   * AVX-512, x87, AES/SHA, FMA, GFNI, AMX, APX, etc. do not require a new
#     Python opcode case to become concrete-semantic inputs.
#   * .o input bypasses the local assembler vocabulary entirely.
#   * privileged/system I/O and nondeterministic/environment-dependent
#     instructions remain outside the default pure-function QM contract.

import os as _qm_os
import resource as _qm_resource
import select as _qm_select
import shlex as _qm_shlex
import shutil as _qm_shutil
import signal as _qm_signal
import struct as _qm_struct
import subprocess as _qm_subprocess
import tempfile as _qm_tempfile
from pathlib import Path as _QmPath
from typing import Iterable as _QmIterable, Sequence as _QmSequence

os = _qm_os
resource = _qm_resource
select = _qm_select
shlex = _qm_shlex
shutil = _qm_shutil
signal = _qm_signal
struct = _qm_struct
subprocess = _qm_subprocess
tempfile = _qm_tempfile
Path = _QmPath
Iterable = _QmIterable
Sequence = _QmSequence

_SCALAR = {
    'u8':  ('uint8_t', 1),
    'u16': ('uint16_t', 2),
    'u32': ('uint32_t', 4),
    'u64': ('uint64_t', 8),
    'u128': ('unsigned __int128', 16),
    'i8':  ('int8_t', 1),
    'i16': ('int16_t', 2),
    'i32': ('int32_t', 4),
    'i64': ('int64_t', 8),
    'i128': ('__int128', 16),
    'f16': ('_Float16', 2),
    'f32': ('float', 4),
    'f64': ('double', 8),
    # x86-64 SysV long double is the 80-bit x87 extended format in a
    # 16-byte C object.  The wire format intentionally carries only the
    # architecturally meaningful 10-byte payload, not indeterminate padding.
    'f80': ('long double', 10),
    'v128': ('qm_v128', 16),
    'v256': ('qm_v256', 32),
    'v512': ('qm_v512', 64),
}
_PTR_RE = re.compile(r'^(in|out|inout):(\d+)$')


@dataclass(frozen=True)
class ABIAtom:
    spec: str
    kind: str
    size: int
    ctype: str
    direction: str | None = None

    @property
    def input_size(self) -> int:
        if self.kind == 'ptr':
            return self.size if self.direction in ('in', 'inout') else 0
        return self.size

    @property
    def output_size(self) -> int:
        if self.kind == 'ptr':
            return self.size if self.direction in ('out', 'inout') else 0
        return 0


def parse_atom(spec: str) -> ABIAtom:
    s = spec.strip().lower()
    if s in _SCALAR:
        ctype, size = _SCALAR[s]
        return ABIAtom(s, 'value', size, ctype)
    m = _PTR_RE.match(s)
    if m:
        direction, n = m.groups()
        n = int(n)
        if n < 0 or n > (1 << 24):
            raise ValueError(f'unreasonable buffer size: {spec}')
        return ABIAtom(s, 'ptr', n, 'uint8_t *', direction)
    raise ValueError(f'unknown ABI atom: {spec}')


@dataclass(frozen=True)
class FunctionABI:
    args: tuple[str, ...] = ('u64',)
    ret: str = 'u64'
    callconv: str = 'sysv'   # sysv | ms

    def parsed_args(self) -> tuple[ABIAtom, ...]:
        return tuple(parse_atom(x) for x in self.args)

    def parsed_ret(self) -> ABIAtom | None:
        if self.ret.strip().lower() == 'void':
            return None
        a = parse_atom(self.ret)
        if a.kind != 'value':
            raise ValueError('return value cannot be a pointer-buffer ABI atom')
        return a

    @property
    def input_size(self) -> int:
        return sum(a.input_size for a in self.parsed_args())

    @property
    def output_size(self) -> int:
        r = self.parsed_ret()
        return (r.size if r else 0) + sum(a.output_size for a in self.parsed_args())

    def compiler_flags(self) -> list[str]:
        specs = set(self.args) | {self.ret}
        flags = []
        if 'v256' in specs:
            flags.append('-mavx')
        if 'v512' in specs:
            flags.append('-mavx512f')
        return flags


# ---------------------------------------------------------------------------
# Wire codec
# ---------------------------------------------------------------------------

_INT_FMT = {
    'u8':'<B', 'u16':'<H', 'u32':'<I', 'u64':'<Q',
    'i8':'<b', 'i16':'<h', 'i32':'<i', 'i64':'<q',
    'f16':'<e', 'f32':'<f', 'f64':'<d',
}


def _pack_value(atom: ABIAtom, value) -> bytes:
    if atom.spec in _INT_FMT:
        return struct.pack(_INT_FMT[atom.spec], value)
    if atom.spec in ('u128','i128'):
        signed_flag = atom.spec == 'i128'
        return int(value).to_bytes(16, 'little', signed=signed_flag)
    if atom.spec == 'f80':
        if isinstance(value, (bytes, bytearray, memoryview)):
            b = bytes(value)
            if len(b) != 10:
                raise ValueError('f80 wire value must be exactly 10 bytes')
            return b
        raise TypeError('f80 values use the exact 10-byte x87 payload')
    if atom.spec in ('v128','v256','v512'):
        b = bytes(value)
        if len(b) != atom.size:
            raise ValueError(f'{atom.spec} requires {atom.size} bytes')
        return b
    raise AssertionError(atom)


def _unpack_value(atom: ABIAtom, data: bytes):
    if atom.spec in _INT_FMT:
        return struct.unpack(_INT_FMT[atom.spec], data)[0]
    if atom.spec in ('u128','i128'):
        return int.from_bytes(data, 'little', signed=(atom.spec == 'i128'))
    if atom.spec == 'f80' or atom.spec in ('v128','v256','v512'):
        return bytes(data)
    raise AssertionError(atom)


def pack_call(abi: FunctionABI, args: Sequence) -> bytes:
    aa = abi.parsed_args()
    if len(args) != len(aa):
        raise ValueError(f'expected {len(aa)} args, got {len(args)}')
    out = bytearray()
    for atom, value in zip(aa, args):
        if atom.kind == 'value':
            out += _pack_value(atom, value)
        elif atom.direction in ('in','inout'):
            b = bytes(value)
            if len(b) != atom.size:
                raise ValueError(f'{atom.spec} requires {atom.size} input bytes')
            out += b
        else:
            # out:N has no input payload.  The caller may pass None for clarity.
            if value not in (None, b'', bytearray()):
                raise ValueError(f'{atom.spec} takes no input payload; pass None')
    assert len(out) == abi.input_size
    return bytes(out)


def unpack_result(abi: FunctionABI, data: bytes):
    if len(data) != abi.output_size:
        raise ValueError(f'bad output record size {len(data)} != {abi.output_size}')
    p = 0
    ret_atom = abi.parsed_ret()
    ret = None
    if ret_atom:
        ret = _unpack_value(ret_atom, data[p:p+ret_atom.size])
        p += ret_atom.size
    bufs = []
    for atom in abi.parsed_args():
        if atom.output_size:
            bufs.append(bytes(data[p:p+atom.size]))
            p += atom.size
    if bufs:
        return (ret, *bufs) if ret_atom else tuple(bufs)
    return ret


# ---------------------------------------------------------------------------
# C harness generation
# ---------------------------------------------------------------------------

_C_PROLOGUE = r'''
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <errno.h>

typedef long long qm_v128 __attribute__((vector_size(16)));
typedef long long qm_v256 __attribute__((vector_size(32)));
typedef long long qm_v512 __attribute__((vector_size(64)));

static int rdall(int fd, void *buf, size_t n) {
    unsigned char *p = (unsigned char *)buf;
    size_t k = 0;
    while (k < n) {
        ssize_t r = read(fd, p + k, n - k);
        if (r == 0) return k == 0 ? 0 : -1;
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        k += (size_t)r;
    }
    return 1;
}

static int wrall(int fd, const void *buf, size_t n) {
    const unsigned char *p = (const unsigned char *)buf;
    size_t k = 0;
    while (k < n) {
        ssize_t r = write(fd, p + k, n - k);
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        k += (size_t)r;
    }
    return 0;
}
'''


def _decl_attr(callconv: str) -> str:
    cc = callconv.lower()
    if cc == 'sysv':
        return '__attribute__((sysv_abi))'
    if cc == 'ms':
        return '__attribute__((ms_abi))'
    raise ValueError(f'unsupported call convention: {callconv}')


def _c_load_value(atom: ABIAtom, name: str, pvar: str) -> list[str]:
    if atom.spec == 'f80':
        return [
            f'    {atom.ctype} {name} = 0;',
            f'    memcpy(&{name}, {pvar}, 10);',
            f'    {pvar} += 10;',
        ]
    return [
        f'    {atom.ctype} {name};',
        f'    memcpy(&{name}, {pvar}, {atom.size});',
        f'    {pvar} += {atom.size};',
    ]


def _c_store_value(atom: ABIAtom, name: str, qvar: str) -> list[str]:
    if atom.spec == 'f80':
        return [
            '    { unsigned char t80[sizeof(long double)] = {0};',
            f'      memcpy(t80, &{name}, sizeof(long double));',
            f'      memcpy({qvar}, t80, 10); {qvar} += 10; }}',
        ]
    return [
        f'    memcpy({qvar}, &{name}, {atom.size});',
        f'    {qvar} += {atom.size};',
    ]


def generate_harness(function: str, abi: FunctionABI, *, strict_seccomp=True) -> str:
    args = abi.parsed_args()
    ret = abi.parsed_ret()
    attr = _decl_attr(abi.callconv)

    decl_args = ', '.join(a.ctype for a in args) or 'void'
    ret_type = ret.ctype if ret else 'void'

    L = [_C_PROLOGUE]
    L.append(f'extern {ret_type} {attr} {function}({decl_args});\n')
    L.append(f'enum {{ QM_IN = {abi.input_size}, QM_OUT = {abi.output_size} }};\n')
    # ISO C forbids zero-length arrays, use one byte when the logical record is empty.
    L.append('static void qm_eval(const unsigned char *in, unsigned char *out) {')
    L.append('    const unsigned char *p = in;')
    L.append('    unsigned char *q = out;')

    arg_names = []
    for i, atom in enumerate(args):
        name = f'a{i}'
        arg_names.append(name)
        if atom.kind == 'value':
            L.extend(_c_load_value(atom, name, 'p'))
        else:
            # Alignment 64 is sufficient for all current x86 vector widths while
            # still allowing unaligned target accesses naturally.
            n = max(1, atom.size)
            L.append(f'    _Alignas(64) unsigned char {name}_buf[{n}];')
            if atom.direction in ('in','inout') and atom.size:
                L.append(f'    memcpy({name}_buf, p, {atom.size}); p += {atom.size};')
            else:
                L.append(f'    memset({name}_buf, 0, {n});')
            L.append(f'    uint8_t *{name} = {name}_buf;')

    call = f'{function}({", ".join(arg_names)})'
    if ret:
        L.append(f'    {ret.ctype} r = {call};')
        L.extend(_c_store_value(ret, 'r', 'q'))
    else:
        L.append(f'    {call};')

    for i, atom in enumerate(args):
        if atom.kind == 'ptr' and atom.direction in ('out','inout') and atom.size:
            L.append(f'    memcpy(q, a{i}_buf, {atom.size}); q += {atom.size};')

    L.append('}')
    L.append('')
    L.append('int main(void) {')
    L.append('    unsigned char inbuf[QM_IN ? QM_IN : 1];')
    L.append('    unsigned char outbuf[QM_OUT ? QM_OUT : 1];')
    if strict_seccomp:
        # Enter strict seccomp only after process startup and dynamic linking.
        # Strict mode permits read/write/_exit/sigreturn, exactly what the
        # record loop needs around the target call.  If the host/container
        # rejects strict mode we continue; the Python parent still applies
        # resource limits and a timeout.
        L.append('    (void)prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);')
        L.append('    (void)prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT);')
    if abi.input_size == 0:
        # With no input there is no natural EOF-delimited record.  Evaluate once.
        L.append('    qm_eval(inbuf, outbuf);')
        if abi.output_size:
            L.append('    if (wrall(STDOUT_FILENO, outbuf, QM_OUT) < 0) return 3;')
        L.append('    return 0;')
    else:
        L.append('    for (;;) {')
        L.append('        int rr = rdall(STDIN_FILENO, inbuf, QM_IN);')
        L.append('        if (rr == 0) return 0;')
        L.append('        if (rr < 0) return 2;')
        L.append('        qm_eval(inbuf, outbuf);')
        if abi.output_size:
            L.append('        if (wrall(STDOUT_FILENO, outbuf, QM_OUT) < 0) return 3;')
        L.append('    }')
    L.append('}')
    return '\n'.join(L)


# ---------------------------------------------------------------------------
# Disassembly policy / diagnostics
# ---------------------------------------------------------------------------

# These do not describe all of x86.  They are a *purity policy*: instructions
# whose result depends on time, RNG state, machine configuration, privilege,
# or an external OS/device are not ordinary deterministic function semantics.
_NONDETERMINISTIC = {
    'rdrand','rdseed','rdtsc','rdtscp','rdpmc',
}
_ENVIRONMENT = {
    'cpuid','xgetbv','rdpkru','rdpid','rdfsbase','rdgsbase',
}
_SYSTEM_PREFIXES = (
    'vmcall','vmlaunch','vmresume','vmxoff','vmxon','vmrun','vmmcall','stgi','clgi',
    'invept','invvpid','invlpga',
)
_SYSTEM = {
    'syscall','sysenter','sysexit','sysret','iret','iretd','iretq',
    'hlt','cli','sti','clac','stac','swapgs',
    'rdmsr','wrmsr','rdpmc','in','out','ins','outs',
    'lgdt','lidt','lldt','ltr','invlpg','invpcid','wbinvd','invd',
    'xsetbv','wrpkru',
}


def disassemble(path: str | os.PathLike, *, llvm_objdump=None, function=None) -> str:
    tool = llvm_objdump or shutil.which('llvm-objdump') or shutil.which('objdump')
    if not tool:
        return ''
    cmd = [tool, '-d']
    if function:
        if 'llvm-objdump' in os.path.basename(tool):
            cmd += [f'--disassemble-symbols={function}']
        else:
            cmd += [f'--disassemble={function}']
    if 'llvm-objdump' in os.path.basename(tool):
        cmd += ['--x86-asm-syntax=intel']
    cmd += [str(path)]
    p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, check=False)
    return p.stdout if p.returncode == 0 else ''


def extract_mnemonics(disasm: str) -> list[str]:
    out = []
    # LLVM: address: bytes mnemonic operands
    # GNU objdump: address:\tbytes\tmnemonic operands
    for line in disasm.splitlines():
        if ':' not in line:
            continue
        tail = line.split(':',1)[1].strip()
        if not tail:
            continue
        # Strip leading encoded bytes (2 hex chars each).
        toks = tail.replace('\t',' ').split()
        j = 0
        while j < len(toks) and re.fullmatch(r'[0-9a-fA-F]{2}', toks[j]):
            j += 1
        if j < len(toks):
            m = toks[j].lower()
            if re.fullmatch(r'[a-z][a-z0-9_.]*', m):
                out.append(m)
    return out


def purity_issues(mnemonics: Iterable[str]) -> list[str]:
    issues = []
    for m in mnemonics:
        base = m.split('.',1)[0]
        if base in _NONDETERMINISTIC:
            issues.append(f'nondeterministic:{base}')
        elif base in _ENVIRONMENT:
            issues.append(f'environment-dependent:{base}')
        elif base in _SYSTEM or any(base.startswith(p) for p in _SYSTEM_PREFIXES):
            issues.append(f'system/privileged:{base}')
    return sorted(set(issues))


# ---------------------------------------------------------------------------
# Persistent execution oracle
# ---------------------------------------------------------------------------

class OracleError(RuntimeError):
    pass


class X86ExecutionOracle:
    """Compile/link and execute one x86-64 function through a binary protocol.

    `source` may be a .s/.S assembly file or a relocatable .o object.
    For a host-missing ISA, set `runner_prefix`, e.g.

        runner_prefix=['/path/to/sde64', '-future', '--']

    Intel documents the generic SDE form as:

        sde [sde args] -- user-application [app args]
    """

    def __init__(self, source, function: str, abi: FunctionABI = FunctionABI(),
                 *, compiler=None, cflags=(), runner_prefix=(),
                 timeout=2.0, strict_seccomp=True, allow_impure=False,
                 keep_build=False, build_dir=None):
        self.source = Path(source).resolve()
        self.function = function
        self.abi = abi
        self.compiler = compiler or shutil.which('clang') or shutil.which('gcc')
        if not self.compiler:
            raise OracleError('clang/gcc not found')
        self.cflags = list(cflags)
        self.runner_prefix = list(runner_prefix)
        self.timeout = float(timeout)
        # Intel SDE/other process-level emulators need their own syscalls, so
        # strict seccomp is enabled only for direct native execution.
        self.strict_seccomp = bool(strict_seccomp and not runner_prefix)
        self.allow_impure = allow_impure
        self.keep_build = keep_build
        self._tmp = None
        self.build_dir = Path(build_dir).resolve() if build_dir else None
        self.exe = None
        self.proc = None
        self._cache = {}
        self._build()

    def _build(self):
        if not self.source.exists():
            raise OracleError(f'input not found: {self.source}')
        if self.build_dir:
            self.build_dir.mkdir(parents=True, exist_ok=True)
            bdir = self.build_dir
        else:
            self._tmp = tempfile.TemporaryDirectory(prefix='qm-x86-oracle-')
            bdir = Path(self._tmp.name)
        harness = bdir / 'qm_oracle_harness.c'
        exe = bdir / 'qm_oracle'
        harness.write_text(generate_harness(self.function, self.abi,
                                            strict_seccomp=self.strict_seccomp))
        cmd = [self.compiler, '-O2', '-fno-lto', '-fno-stack-protector',
               '-fno-omit-frame-pointer', '-Wl,-z,noexecstack']
        cmd += self.abi.compiler_flags()
        cmd += self.cflags
        cmd += ['-Wl,-z,now']
        cmd += [str(harness), str(self.source), '-o', str(exe)]
        p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, check=False)
        if p.returncode:
            raise OracleError('oracle build failed:\n' + p.stderr + '\ncommand: ' + shlex.join(cmd))
        self.exe = exe

        # Purity scan is advisory but default-enforced when disassembly works.
        d = disassemble(exe, function=self.function)
        issues = purity_issues(extract_mnemonics(d)) if d else []
        self.purity_issues = issues
        if issues and not self.allow_impure:
            raise OracleError('function/executable violates default pure-semantics policy: ' + ', '.join(issues))

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        cmd = self.runner_prefix + [str(self.exe)]
        def sandbox_limits():
            # Defense in depth around the already-isolated helper.  CPU timeout
            # is also enforced by the parent per record.
            try:
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))
                resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))
                resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
            except Exception:
                pass
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0,
                                     start_new_session=True, preexec_fn=sandbox_limits)

    def _read_exact(self, n: int) -> bytes:
        if n == 0:
            return b''
        fd = self.proc.stdout.fileno()
        out = bytearray()
        deadline = None if self.timeout <= 0 else (__import__('time').monotonic() + self.timeout)
        while len(out) < n:
            wait = None if deadline is None else max(0.0, deadline - __import__('time').monotonic())
            r, _, _ = select.select([fd], [], [], wait)
            if not r:
                self.close(kill=True)
                raise OracleError(f'oracle timed out after {self.timeout}s')
            chunk = os.read(fd, n - len(out))
            if not chunk:
                rc = self.proc.poll()
                err = b''
                try:
                    err = self.proc.stderr.read() or b''
                except Exception:
                    pass
                raise OracleError(f'oracle exited before producing a record (rc={rc}): {err.decode(errors="replace")}')
            out += chunk
        return bytes(out)

    def eval_raw(self, record: bytes) -> bytes:
        if len(record) != self.abi.input_size:
            raise ValueError(f'input record {len(record)} != {self.abi.input_size}')
        if self.abi.input_size == 0:
            # One-shot no-input programs terminate after one evaluation.
            self.close()
        self._start()
        if record:
            try:
                self.proc.stdin.write(record)
                self.proc.stdin.flush()
            except BrokenPipeError:
                raise OracleError('oracle process died while writing input')
        out = self._read_exact(self.abi.output_size)
        if self.abi.input_size == 0:
            self.close()
        return out

    def __call__(self, *args):
        key = None
        try:
            key = tuple(args)
            if key in self._cache:
                return self._cache[key]
        except TypeError:
            pass
        rec = pack_call(self.abi, args)
        result = unpack_result(self.abi, self.eval_raw(rec))
        if key is not None:
            self._cache[key] = result
        return result

    def evaluate_many(self, calls: Iterable[Sequence]):
        # Keep the persistent process hot.  This is intentionally simple;
        # the public target wrapper below adds caching/prefetch for finite domains.
        return [self(*args) for args in calls]

    def target1(self):
        """Return a unary callable suitable for the current Stage-2 solvers."""
        if len(self.abi.args) != 1 or self.abi.parsed_args()[0].kind != 'value' or self.abi.parsed_ret() is None:
            raise ValueError('target1 requires one value argument and one value return')
        return lambda x: self(x)

    def prefetch_unary(self, domain: Iterable):
        if len(self.abi.args) != 1:
            raise ValueError('prefetch_unary requires unary ABI')
        for x in domain:
            self(x)
        return self.target1()

    def close(self, kill=False):
        if self.proc:
            p = self.proc
            self.proc = None
            try:
                if kill and p.poll() is None:
                    try: os.killpg(p.pid, signal.SIGKILL)
                    except Exception: p.kill()
                elif p.poll() is None and p.stdin:
                    p.stdin.close()
                p.wait(timeout=0.5)
            except Exception:
                try: p.kill()
                except Exception: pass
            try:
                if p.stdout: p.stdout.close()
                if p.stderr: p.stderr.close()
            except Exception:
                pass
        if self._tmp and self.keep_build:
            # TemporaryDirectory cannot be kept after object destruction; copy
            # artifacts explicitly when callers need persistence.
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close(kill=bool(exc[0]))

    def __del__(self):
        try: self.close(kill=True)
        except Exception: pass


# ---------------------------------------------------------------------------
# Convenience factory for the QM exact-output target API
# ---------------------------------------------------------------------------

def target_from_x86(source, function, *, arg='u8', ret='u64', callconv='sysv',
                    runner_prefix=(), compiler=None, cflags=(), timeout=2.0,
                    strict_seccomp=True, allow_impure=False, prefetch=None):
    abi = FunctionABI((arg,), ret, callconv)
    oracle = X86ExecutionOracle(
        source, function, abi, compiler=compiler, cflags=cflags,
        runner_prefix=runner_prefix, timeout=timeout,
        strict_seccomp=strict_seccomp, allow_impure=allow_impure,
    )
    if prefetch is not None:
        oracle.prefetch_unary(prefetch)
    return oracle, oracle.target1()



@dataclass(frozen=True)
class FiniteX86Semantics:
    """A frozen finite semantic table extracted from x86 execution."""
    table: dict
    backend: str
    purity_issues: tuple = ()

    def __call__(self, x):
        return self.table[x]

    def items(self):
        return self.table.items()


def extract_unary_x86_semantics(source, function, domain=range(256), *,
                                 arg='u8', ret='u64', callconv='sysv',
                                 backend='auto', runner_prefix=(),
                                 compiler=None, cflags=(), timeout=2.0,
                                 strict_seccomp=True, allow_impure=False):
    """Extract a finite unary function from real x86-64 code.

    backend='auto': try the handwritten interpreter first for simple SysV
    integer functions; on any unsupported instruction, fall back to the
    execution oracle.

    backend='oracle': execute the original machine code directly (or under
    runner_prefix). This path is the application-level x86-64 instruction
    coverage boundary.
    """
    source = str(source)
    vals = list(domain)
    backend = backend.lower()
    if backend not in ('auto', 'python', 'oracle'):
        raise ValueError('backend must be auto, python, or oracle')

    if backend in ('auto', 'python') and callconv == 'sysv' and arg in (
        'u8','u16','u32','u64','i8','i16','i32','i64') and ret in (
        'u8','u16','u32','u64','i8','i16','i32','i64') and source.endswith(('.s','.S')):
        try:
            funcs = parse_asm(source)
            code = funcs[function]
            rb = parse_atom(ret).size * 8
            table = {}
            for x in vals:
                y, _ = run_func(code, [x], functions=funcs)
                table[x] = y & maskw(rb)
            return FiniteX86Semantics(table, 'python-interpreter', ())
        except (NotImplementedError, KeyError, ValueError, RuntimeError, AssertionError):
            if backend == 'python':
                raise

    abi = FunctionABI((arg,), ret, callconv)
    with X86ExecutionOracle(
        source, function, abi, compiler=compiler, cflags=cflags,
        runner_prefix=runner_prefix, timeout=timeout,
        strict_seccomp=strict_seccomp, allow_impure=allow_impure,
    ) as oracle:
        table = {x: oracle(x) for x in vals}
        issues = tuple(oracle.purity_issues)
    return FiniteX86Semantics(table, 'execution-oracle', issues)


def synth_from_x86(source, function, domain=range(256), *,
                   arg='u8', ret='u64', callconv='sysv', backend='auto',
                   runner_prefix=(), compiler=None, cflags=(), timeout=2.0,
                   strict_seccomp=True, allow_impure=False, obs=None):
    """End-to-end: x86 asm/object -> finite semantics -> QM Stage 2."""
    sem = extract_unary_x86_semantics(
        source, function, domain, arg=arg, ret=ret, callconv=callconv,
        backend=backend, runner_prefix=runner_prefix, compiler=compiler,
        cflags=cflags, timeout=timeout, strict_seccomp=strict_seccomp,
        allow_impure=allow_impure,
    )
    return synth(sem, obs=obs), sem


def sde_future_prefix(sde_path):
    """Intel SDE runner prefix for current/future Intel ISA extensions."""
    return [str(sde_path), '-future', '--']


if __name__ == '__main__':
    main()
