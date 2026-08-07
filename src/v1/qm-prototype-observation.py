#!/usr/bin/env python3
"""qm-prototype-observation.py — Quotient Minimizer prototype

    QM(ISA, spec) -> (abstract program, residual freedom)
    lower(ISA, abstract) -> instruction sequence -> C

The normalized search space contains four kinds of operators:

    POINT      Lane-local operations.
               The only place where carry and comparison are created.

    LIN_CONST  Constant GF(2)-linear maps.
               This is a semantic class, not a synonym for PDEP.
               Physical representatives may include constant-mask PDEP,
               constant-mask PEXT, shift/XOR networks, CLMUL, GFNI, ...

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

An ISA declaration contains lowering candidates for each abstract operation.
A semantic class may have multiple physical representatives; Stage 2 chooses
among them with the same span / work / L(z) / rank objective. In particular,
LIN_CONST is no longer hard-wired to PDEP after constant-mask PEXT appeared
as the unique representative of Morton compaction.

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
outputs. The observation-quotient machinery is correct and explicit, but
quotient-aware Stage 2 search for arbitrary non-identity observers is left as
a separate search problem rather than silently approximated.

Later experiments add three constraints to the model:

  * exclusive prefix leaves the same residual-freedom pattern under IMUL and
    CLMUL (502 solutions for the 8-lane byte case);
  * LIN_CONST searches physical representatives rather than mapping directly
    to one instruction;
  * deposit-then-convolution solving is parameterized by multiplication family
    and input width (for example 16 lanes / 4-bit rank).

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

def _lin_const_rep(op):
    """Return (physical_kind, constant) for a LIN_CONST node.

    New representation:
        ('LIN_CONST', 'PDEP', mask)
        ('LIN_CONST', 'PEXT', mask)

    The old two-tuple form is accepted as PDEP for compatibility only.
    """
    if len(op) == 2:
        return 'PDEP', op[1]
    return op[1], op[2]


def lower_x86(op):
    """Lower one abstract operation to x86-64 BMI2/PCLMUL primitives.

    LIN_CONST is a semantic class.  The representative tag records the
    physical realization selected by Stage 2; it is deliberately not fixed
    to PDEP.
    """
    k = op[0]

    if k == 'LIN_CONST':
        rep, c = _lin_const_rep(op)
        if rep == 'PDEP':
            return [('PDEP', c, None)]
        if rep == 'PEXT':
            return [('PEXT_MASK', c, None)]
        return None

    return {
        'CONV_Z':     [('IMUL', op[-1], None)],
        'CONV_GF2':   [('CLMUL', op[-1], None)],
        'CONV_GF128': [('CLMUL', None, None)] * 3
                    + [('CLMUL', None, None)] * 2,
        # Constant source, dynamic mask: a PERM_DYN gather.
        'PERM_DYN_G': [('PEXT', op[-1], None)],
        'PERM_DYN_S': [('PDEP', op[-1], None)],
        'NOT':        [('NOT', None, None)],
        'SHR':        [('SHR', None, op[-1])],
    }.get(k)


def lower_portable(op):
    """Portable lowering with no BMI2 and no PCLMUL.

    Only the constant PDEP pattern used by byte-spread kernels has a short
    portable representative in this tiny grammar.  A constant PEXT map is
    still LIN_CONST semantically, but has no short lowering here.
    """
    k = op[0]

    if k == 'LIN_CONST':
        rep, c = _lin_const_rep(op)
        if rep == 'PDEP' and c == ONES:
            return [
                ('IMUL', SPREAD_MUL, None),
                ('AND', HIGH, None),
                ('BSWAP', None, None),
                ('SHR', None, 7),
            ]
        return None

    if k == 'CONV_GF2':
        # Shift-fold implements exactly multiplication by the all-ones kernel.
        if op[-1] == M64:
            return [('SCANXOR', None, 1 << i) for i in range(6)]
        return None

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


def _apply_conv(a, M, family):
    if family == 'IMUL':
        return (a * M) & M64
    if family == 'CLMUL':
        return clmul(a, M, 64) & M64
    raise ValueError(f'unknown convolution family: {family}')


def _deposit_table(D, input_bits):
    """Generate PDEP(m,D) for every m in a small finite input domain."""
    pos = [i for i in range(64) if (D >> i) & 1]
    if len(pos) < input_bits:
        raise ValueError('deposit mask does not have enough positions')
    basis = [1 << pos[i] for i in range(input_bits)]
    out = [0] * (1 << input_bits)
    for m in range(1, 1 << input_bits):
        b = m & -m
        j = b.bit_length() - 1
        out[m] = out[m ^ b] | basis[j]
    return out


def solve_deposit_then_conv(target, input_bits=8, family='IMUL'):
    """Solve constant PDEP followed by IMUL or CLMUL.

        LIN_CONST[PDEP(D)] ; CONV(family, M)

    On a singleton source bit, both IMUL and CLMUL act as a shift of M, so
    candidate generation is identical:

        target(1 << lane) = (M << p_lane) mod 2^64.

    Full-domain verification is family-specific.  The shared candidate geometry
    explains why the same trailing-zero freedom can appear across IMUL and
    CLMUL: it comes from the boundary condition, not from one ISA instruction.

    input_bits=16 reproduces the 16-lane / 4-bit exclusive-rank result.
    """
    if not (1 <= input_bits <= 16):
        raise ValueError('closed-form finite solver supports 1..16 input bits')

    t0 = target(1) & M64
    if t0 == 0:
        return [], 0, 'lane 0 maps to zero; deposit+convolution has no solution'

    tz = (t0 & -t0).bit_length() - 1
    tg = [(target(1 << lane) & M64) for lane in range(input_bits)]
    targets = [(target(m) & M64) for m in range(1 << input_bits)]

    cand, sols = 0, []

    for p0 in range(tz + 1):
        base = t0 >> p0
        for high in range(1 << p0):
            M = (base | (high << (64 - p0))) if p0 else base
            M &= M64
            cand += 1

            allowed = [
                [p for p in range(64) if ((M << p) & M64) == tg[lane]]
                for lane in range(input_bits)
            ]
            if any(not positions for positions in allowed) or p0 not in allowed[0]:
                continue

            deposits = []

            def dfs(lane, lo, positions):
                if lane == input_bits:
                    deposits.append(sum(1 << p for p in positions))
                    return
                for p in allowed[lane]:
                    if p > lo:
                        dfs(lane + 1, p, positions + [p])

            dfs(1, p0, [p0])

            for D in deposits:
                dep = _deposit_table(D, input_bits)
                if all(
                    _apply_conv(dep[m], M, family) == targets[m]
                    for m in range(1 << input_bits)
                ):
                    sols.append((D, M))

    sols.sort()
    return sols, cand, None


def solve_lin_then_conv(target):
    """Compatibility alias for the original 8-lane IMUL solver."""
    return solve_deposit_then_conv(target, input_bits=8, family='IMUL')


def _verification_inputs(input_bits, trials=20000):
    """Exact small domain or deterministic wide-domain probes."""
    if input_bits <= 16:
        return range(1 << input_bits)

    mask = (1 << input_bits) - 1 if input_bits < 64 else M64
    xs = [0, mask]
    xs.extend(1 << i for i in range(input_bits))
    x = 0x9E3779B97F4A7C15 & mask
    for _ in range(trials):
        x ^= x >> 12
        x ^= (x << 25) & M64
        x ^= x >> 27
        x = (x * 0x2545F4914F6CDD1D) & M64
        xs.append(x & mask)
    return xs


def solve_lin_const_representatives(target, input_bits, trials=20000):
    """Infer constant-mask PDEP/PEXT representatives from basis images.

    PDEP and PEXT are both members of LIN_CONST.  This function returns
    physical representatives instead of identifying LIN_CONST with PDEP.

    <=16 input bits are verified exhaustively.  Wider cases use zero/all-ones,
    all basis vectors, and deterministic random probes after basis inference.
    """
    if not (1 <= input_bits <= 64):
        raise ValueError('input_bits must be in 1..64')
    if target(0) & M64:
        return []

    images = [(target(1 << i) & M64) for i in range(input_bits)]
    reps = []

    # PDEP: increasing one-hot outputs, followed only by zeros if the mask ends.
    pos, zero_tail, ok = [], False, True
    for img in images:
        if img == 0:
            zero_tail = True
            continue
        if zero_tail or (img & (img - 1)):
            ok = False
            break
        p = img.bit_length() - 1
        if pos and p <= pos[-1]:
            ok = False
            break
        pos.append(p)
    if ok:
        D = sum(1 << p for p in pos)
        if all(pdep(x, D) == (target(x) & M64)
               for x in _verification_inputs(input_bits, trials)):
            reps.append(('PDEP', D))

    # PEXT: selected source positions map densely to output bits 0,1,2,...
    selected, next_out, ok = [], 0, True
    for i, img in enumerate(images):
        if img == 0:
            continue
        if img != (1 << next_out):
            ok = False
            break
        selected.append(i)
        next_out += 1
    if ok:
        K = sum(1 << i for i in selected)
        if all(pext(x, K) == (target(x) & M64)
               for x in _verification_inputs(input_bits, trials)):
            reps.append(('PEXT', K))

    return reps


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
            # Constant source, dynamic mask (PERM_DYN_G).
            cur = pext(c, cur)

        elif instr == 'PEXT_MASK':
            # Dynamic source, constant mask (LIN_CONST representative).
            cur = pext(cur, c)

        elif instr == 'IMUL':
            cur = (cur * c) & M64

        elif instr == 'CLMUL':
            cur = clmul(cur, c, 64) & M64

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

    'PEXT_MASK':
        lambda d, c, s, a:
            f'uint64_t {d} = _pext_u64({a}, 0x{c:016X}ull);',

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
    """8 byte lanes, exclusive prefix count."""
    return sum(popcnt(m & ((1 << k) - 1)) << (8 * k) for k in range(8))


def inclusive_ranks8(m):
    """8 byte lanes, inclusive prefix count."""
    return sum(popcnt(m & ((1 << (k + 1)) - 1)) << (8 * k) for k in range(8))


def ranks16_nibble(m):
    """16 nibble lanes, exclusive prefix count."""
    return sum(popcnt(m & ((1 << k) - 1)) << (4 * k) for k in range(16))


def prefix_parity_mask8(m):
    """Inclusive running parity expanded to 00/FF byte lanes."""
    return sum(
        ((popcnt(m & ((1 << (k + 1)) - 1)) & 1) * 0xFF) << (8 * k)
        for k in range(8)
    )


def quote_state_before8(m):
    """Exclusive running parity: state entering each byte lane."""
    return sum(
        ((popcnt(m & ((1 << k) - 1)) & 1) * 0xFF) << (8 * k)
        for k in range(8)
    )


def bytemask8(m):
    return sum(0xFF << (8 * k) for k in range(8) if (m >> k) & 1)


def select8(m):
    r = j = 0
    for i in range(8):
        if (m >> i) & 1:
            r |= i << (8 * j)
            j += 1
    return r


def shufctl8(m):
    r = j = 0
    for i in range(8):
        if (m >> i) & 1:
            r |= i << (8 * j)
            j += 1
    while j < 8:
        r |= 0xFF << (8 * j)
        j += 1
    return r


def morton_dilate32_ref(x):
    r = 0
    for i in range(32):
        if (x >> i) & 1:
            r |= 1 << (2 * i)
    return r


def morton_compact_even_ref(x):
    r = 0
    for i in range(32):
        if (x >> (2 * i)) & 1:
            r |= 1 << i
    return r


def starts8(m):
    return m & (~((m << 1) & 0xFF) & 0xFF)


def run_ids8(m):
    return inclusive_ranks8(starts8(m))


def nonzero_spread8_word(x):
    return (((x & LOW7) + LOW7) | x) & HIGH


def compact_nonzero8_formula(x):
    s = nonzero_spread8_word(x)
    bm = ((s >> 7) * 0xFF) & M64
    return pext(x, bm)


TARGETS = [
    ('ranks8', ranks8),
    ('inclusive_ranks8', inclusive_ranks8),
    ('prefix_parity_mask8', prefix_parity_mask8),
    ('quote_state_before8', quote_state_before8),
    ('bytemask8', bytemask8),
    ('select8', select8),
    ('shufctl8', shufctl8),
]


def synth_conv(target, input_bits=8, families=('IMUL', 'CLMUL')):
    """Search the closed-form constant-deposit + convolution grammar."""
    last_err = None
    for family in families:
        sols, cand, err = solve_deposit_then_conv(
            target, input_bits=input_bits, family=family
        )
        if sols:
            D, M = sols[0]
            conv_op = 'CONV_Z' if family == 'IMUL' else 'CONV_GF2'
            return [
                ('LIN_CONST', 'PDEP', D),
                (conv_op, M),
            ], len(sols), cand, family, None
        last_err = err
    return None, 0, 0, None, last_err


def synth(target, obs=None):
    """Synthesize an exact 8-bit-input target.

    Search order:
      1. constant PDEP + IMUL
      2. constant PDEP + CLMUL
      3. unique byte-mask suffix + dynamic gather
    """
    if obs is not None:
        raise NotImplementedError(
            'quotient-aware Stage 2 synthesis for non-identity observers '
            'is not implemented in this specialized prototype; use '
            'quotient_observation()/verify_observed() explicitly'
        )

    program, freedom, _, _, err = synth_conv(target, input_bits=8)
    if program is not None:
        return program, freedom, None

    bs, _, _ = solve_deposit_then_conv(bytemask8, input_bits=8, family='IMUL')
    Db, Mb = bs[0]

    def inner(m):
        return (pdep(m, Db) * Mb) & M64

    for neg in (False, True):
        ks, dyn_err = solve_dyn_const(target, inner, neg)
        if ks:
            K = ks[0]
            program = [
                ('LIN_CONST', 'PDEP', Db),
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
    # Later discoveries
    # -----------------------------------------------------------------
    hr('§6  Later discoveries — boundary freedom and LIN_CONST representatives')

    print('  inclusive/exclusive boundary condition:')
    for name, target, family in [
        ('rank8 inclusive', inclusive_ranks8, 'IMUL'),
        ('rank8 exclusive', ranks8, 'IMUL'),
        ('parity inclusive', prefix_parity_mask8, 'CLMUL'),
        ('parity exclusive', quote_state_before8, 'CLMUL'),
    ]:
        sols, cand, err = solve_deposit_then_conv(target, 8, family)
        if not sols:
            print(f'    {name:18s}  no solution: {err}')
            continue
        D, M = sols[0]
        print(
            f'    {name:18s}  {family:5s}  candidates={cand:3d}  '
            f'solutions={len(sols):3d}  D=0x{D:016X} M=0x{M:016X}'
        )

    r16, c16, e16 = solve_deposit_then_conv(ranks16_nibble, 16, 'IMUL')
    if r16:
        D16, M16 = r16[0]
        print(
            '\n  ranks16_nibble: '
            f'candidates={c16}, solutions={len(r16)}, '
            f'D=0x{D16:016X}, M=0x{M16:016X}'
        )
    else:
        print(f'\n  ranks16_nibble: no solution: {e16}')

    print('\n  LIN_CONST physical representative search:')
    for name, target, bits in [
        ('Morton dilate32', morton_dilate32_ref, 32),
        ('Morton compact even', morton_compact_even_ref, 64),
    ]:
        reps = solve_lin_const_representatives(target, bits)
        text = ', '.join(f'{kind}(0x{c:016X})' for kind, c in reps) or 'none'
        print(f'    {name:20s} -> {text}')

    run_ok = all(run_ids8(m) == inclusive_ranks8(starts8(m)) for m in range(256))
    print(
        '\n  run_ids8: POINT(starts=(m<<1) ANDN m) ; '
        'LIN_CONST[PDEP] ; CONV_IMUL'
    )
    print(f'    core ops = 4, all-256 verification = {"OK" if run_ok else "FAIL"}')

    cn_ok = True
    for mask in range(256):
        x = expected = 0
        j = 0
        for i in range(8):
            if (mask >> i) & 1:
                byte = i + 1
                x |= byte << (8 * i)
                expected |= byte << (8 * j)
                j += 1
        if compact_nonzero8_formula(x) != expected:
            cn_ok = False
            break
    print(
        '  compact_nonzero8: POINT(nonzero) -> byte mask -> PERM_DYN_G/PEXT, '
        f'7 core ops, tagged-256 verification = {"OK" if cn_ok else "FAIL"}'
    )

    # -----------------------------------------------------------------
    # Guard-hoisting normalization
    # -----------------------------------------------------------------
    hr('§7  Normalization — hoist a linear guard outside an XOR fold')

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


if __name__ == '__main__':
    main()
