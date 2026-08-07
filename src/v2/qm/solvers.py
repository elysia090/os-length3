"""SPEC §8 — Stage 2: synthesize candidate programs.

Search happens only after quotienting and normalization, and specialized solvers
are preferred over general search.  Every solver here is specialized; none of
them is a generic SMT fallback.

Contract for a solver:

    solve(sem, obs, options) -> list[Program]

Candidate *generation* may use exact output values even under a non-identity
observer — that is incomplete but never unsound, because acceptance always goes
through `verify` with the declared observer.  The report says so rather than
implying quotient-aware generation.

Layer 4: depends on `bits`, `program`, `semantics`, `observer`.
"""

from .bits import M64, mask_of, pdep, pext
from .program import (
    Program, conv, identity, lin_const, perm_dyn_gather, point, table,
)

MAX_CLOSED_FORM_BITS = 16


def verify(program, sem, obs):
    """Exhaustive-on-the-domain check of an abstract program."""
    try:
        return all(obs(program.evaluate(x)) == obs(y) for x, y in sem.pairs())
    except (ValueError, IndexError, KeyError):
        return False


# ---------------------------------------------------------------------------
# Trivial families
# ---------------------------------------------------------------------------

def solve_identity(sem, obs, options=None):
    prog = Program([identity()], 1, 1, 'identity', sem.input_bits,
                   sem.output_bits, ['output equals input on the whole domain'])
    return [prog] if verify(prog, sem, obs) else []


def solve_constant(sem, obs, options=None):
    values = set(obs(y) for y in sem.table())
    if len(values) != 1:
        return []
    const = sem.table()[0]
    prog = Program(
        [point([('AND', 0, None), ('OR', const, None)],
               note='constant output')],
        1, 1, 'constant', sem.input_bits, sem.output_bits,
        ['the observer cannot distinguish any two inputs'])
    return [prog] if verify(prog, sem, obs) else []


# ---------------------------------------------------------------------------
# LIN_CONST — constant GF(2)-linear maps
# ---------------------------------------------------------------------------

def linear_basis(sem):
    """Basis images, or None when the map is not GF(2)-linear on the domain."""
    if sem.value_at(0) != 0:
        return None
    return sem.basis_images()


def apply_basis(basis, x):
    acc = 0
    i = 0
    while x:
        if x & 1:
            acc ^= basis[i]
        x >>= 1
        i += 1
    return acc


def solve_linear(sem, obs, options=None):
    """Recognize a constant GF(2)-linear map from its basis images.

    LIN_CONST is a semantic class: this solver returns the linear map itself and
    lets `isa.lower_lin_const` search PDEP / PEXT / CLMUL / IMUL / shift-XOR
    representatives.  It is deliberately never identified with PDEP.
    """
    if obs(sem.value_at(0)) != obs(0):
        return []
    basis = sem.basis_images()
    if not any(basis):
        return []

    op = lin_const(basis, sem.input_bits,
                   note='constant GF(2)-linear map, forced by the basis images')
    prog = Program([op], 1, 1, 'linear-basis', sem.input_bits, sem.output_bits,
                   ['the linear map is forced by f(1<<i); only the physical '
                    'representative remains free'])
    return [prog] if verify(prog, sem, obs) else []


# ---------------------------------------------------------------------------
# LIN_CONST[PDEP] ; CONV(family) — the closed-form deposit/convolution family
# ---------------------------------------------------------------------------

def _deposit_table(deposit_mask, input_bits):
    positions = [i for i in range(64) if (deposit_mask >> i) & 1]
    if len(positions) < input_bits:
        raise ValueError('deposit mask has too few positions')
    basis = [1 << positions[i] for i in range(input_bits)]
    out = [0] * (1 << input_bits)
    for m in range(1, 1 << input_bits):
        low = m & -m
        j = low.bit_length() - 1
        out[m] = out[m ^ low] | basis[j]
    return out


def _apply_conv(value, const, family):
    if family == 'IMUL':
        return (value * const) & M64
    if family == 'CLMUL':
        from .bits import clmul
        return clmul(value, const, 64) & M64
    raise ValueError('unknown convolution family: %r' % (family,))


def solve_deposit_conv(target, input_bits, family='IMUL', domain=None,
                       accept=None, expected=None):
    """Closed-form solver for `LIN_CONST[PDEP(D)] ; CONV(family, M)`.

    On a singleton source bit both IMUL and CLMUL act as a shift of M, so
    candidate generation is identical for the two families:

        target(1 << lane) = (M << p_lane) mod 2^64

    Only full-domain verification is family-specific.  That shared geometry is
    why the same trailing-zero freedom shows up under both IMUL and CLMUL: it
    comes from the boundary condition, not from one ISA instruction.

    Returns (solutions, candidates, error).
    """
    if not 1 <= input_bits <= MAX_CLOSED_FORM_BITS:
        return [], 0, ('closed-form deposit/convolution supports 1..%d input '
                       'bits' % MAX_CLOSED_FORM_BITS)

    values = list(range(1 << input_bits)) if domain is None else list(domain)
    accept = accept or (lambda a, b: a == b)

    t0 = target(1) & M64
    if t0 == 0:
        return [], 0, 'lane 0 maps to zero; deposit+convolution has no solution'

    trailing = (t0 & -t0).bit_length() - 1
    lane_targets = [target(1 << lane) & M64 for lane in range(input_bits)]
    # `expected` is passed in by callers that already hold the evaluated table.
    # Re-evaluating a 2^16 domain per family is the difference between a
    # responsive page and a minute of dead air.
    if expected is None:
        expected = dict((m, target(m) & M64) for m in values)

    candidates = 0
    solutions = []

    for p0 in range(trailing + 1):
        base = t0 >> p0
        for high in range(1 << p0):
            const = ((base | (high << (64 - p0))) if p0 else base) & M64
            candidates += 1

            allowed = [
                [p for p in range(64) if ((const << p) & M64) == lane_targets[lane]]
                for lane in range(input_bits)
            ]
            if any(not slots for slots in allowed) or p0 not in allowed[0]:
                continue

            deposits = []

            def walk(lane, low, chosen):
                if lane == input_bits:
                    deposits.append(sum(1 << p for p in chosen))
                    return
                for p in allowed[lane]:
                    if p > low:
                        walk(lane + 1, p, chosen + [p])

            walk(1, p0, [p0])

            for deposit in deposits:
                dep = _deposit_table(deposit, input_bits)
                if all(accept(_apply_conv(dep[m], const, family), expected[m])
                       for m in values):
                    solutions.append((deposit, const))

    solutions.sort()
    return solutions, candidates, None


def solve_deposit_conv_family(sem, obs, options=None):
    """Wrap the closed-form solver into Programs, IMUL first then CLMUL."""
    options = options or {}
    families = options.get('families', ('IMUL', 'CLMUL'))
    if sem.input_bits > MAX_CLOSED_FORM_BITS or not sem.domain.finite_exact:
        return []

    out = []
    expected = dict(zip(sem.domain.values(), sem.table()))
    for family in families:
        sols, candidates, err = solve_deposit_conv(
            sem.target, sem.input_bits, family,
            domain=sem.domain.values(),
            accept=lambda a, b: obs(a) == obs(b),
            expected=expected,
        )
        if not sols:
            continue
        deposit, const = sols[0]
        basis = [1 << p for p in range(64) if (deposit >> p) & 1][:sem.input_bits]
        prog = Program(
            [lin_const(basis, sem.input_bits, note='PDEP-shaped deposit'),
             conv(family, const, lane_width=_lane_width(deposit, sem.input_bits))],
            len(sols), candidates, 'deposit+conv[%s]' % family,
            sem.input_bits, sem.output_bits,
            ['deposit mask 0x%016X' % deposit,
             'convolution constant 0x%016X' % const])
        if verify(prog, sem, obs):
            out.append(prog)
    return out


def _lane_width(deposit_mask, input_bits):
    positions = [i for i in range(64) if (deposit_mask >> i) & 1][:input_bits]
    if len(positions) < 2:
        return None
    gaps = set(b - a for a, b in zip(positions, positions[1:]))
    return gaps.pop() if len(gaps) == 1 else None


# ---------------------------------------------------------------------------
# POINT ; PERM_DYN — dynamic gather with a constant source
# ---------------------------------------------------------------------------

def solve_point_gather(sem, obs, options=None):
    """`LIN_CONST ; CONV ; PERM_DYN_G(K)`, optionally complemented.

    When the inner byte-mask expansion maps all-ones to all-ones, PEXT(K, ~0)
    == K forces K from a single probe; the forced K is then checked over the
    whole domain.
    """
    if sem.input_bits > 8 or not sem.domain.finite_exact:
        return []

    bytemask = _bytemask_program(sem.input_bits)
    if bytemask is None:
        return []
    inner_prog, inner_fn = bytemask

    if inner_fn(mask_of(sem.input_bits)) != M64:
        return []

    out = []
    for negate in (False, True):
        source = sem.value_at(mask_of(sem.input_bits))
        if negate:
            source = (~source) & M64

        ops = list(inner_prog) + [perm_dyn_gather(source)]
        if negate:
            ops.append(point([('NOT', None, None)], note='complement'))
        prog = Program(ops, 1, 2, 'point+gather', sem.input_bits,
                       sem.output_bits,
                       ['constant source forced by one probe, then verified '
                        'over the whole domain'])
        if verify(prog, sem, obs):
            out.append(prog)
            break
    return out


def _bytemask_program(input_bits):
    """Abstract program expanding a bit mask to 0x00/0xFF lanes."""
    if input_bits > 8:
        return None

    def bytemask(m):
        return sum(0xFF << (8 * k) for k in range(input_bits) if (m >> k) & 1)

    sols, _, _ = solve_deposit_conv(bytemask, input_bits, 'IMUL')
    if not sols:
        return None
    deposit, const = sols[0]
    basis = [1 << p for p in range(64) if (deposit >> p) & 1][:input_bits]
    ops = [lin_const(basis, input_bits, note='byte-lane deposit'),
           conv('IMUL', const, lane_width=8)]

    def evaluate(m):
        return (pdep(m, deposit) * const) & M64

    return ops, evaluate


# ---------------------------------------------------------------------------
# POINT prefilters — retry the whole family after one lane-local step
# ---------------------------------------------------------------------------

def point_prefilters(input_bits):
    """Small library of lane-local preprocessing steps."""
    m = mask_of(input_bits)
    return [
        ('run starts', [('ANDN_PREV_SHL', None, 1)],
         lambda x: x & (~((x << 1) & m)) & m),
        ('run ends', [('ANDN_PREV_SHR', None, 1)],
         lambda x: x & (~(x >> 1)) & m),
        ('edges', [('XOR_SHL', None, 1), ('AND', m, None)],
         lambda x: (x ^ (x << 1)) & m),
        ('complement', [('NOT', None, None), ('AND', m, None)],
         lambda x: (~x) & m),
    ]


def solve_with_prefilter(sem, obs, inner_solvers, options=None):
    """Try `POINT(p) ; <inner family>` for each prefilter in the library.

    A prefilter is only usable when it is *consistent* with the target: inputs
    that the prefilter merges must be indistinguishable to the observer, which
    is the same well-definedness condition the future quotient uses.
    """
    if not sem.domain.exhaustive or sem.input_bits > MAX_CLOSED_FORM_BITS:
        return []

    values = sem.domain.values()
    table = sem.table()
    out = []

    for name, steps, fn in point_prefilters(sem.input_bits):
        induced = {}
        consistent = True
        for x, y in zip(values, table):
            key = fn(x)
            observed = obs(y)
            if key in induced:
                if induced[key][0] != observed:
                    consistent = False
                    break
            else:
                induced[key] = (observed, y)
        if not consistent:
            continue

        image = sorted(induced)
        if not all((1 << i) in induced for i in range(sem.input_bits)):
            continue
        if len(image) == len(values):
            continue          # the prefilter is injective: nothing was gained

        quotient = sem.restricted(image)
        quotient.target = lambda v, _induced=induced: _induced[v][1]
        quotient._table = None

        for solver in inner_solvers:
            for prog in solver(quotient, obs, options):
                composed = Program(
                    [point(steps, note=name)] + prog.ops,
                    prog.residual_freedom, prog.candidates,
                    'POINT[%s] ; %s' % (name, prog.solver),
                    sem.input_bits, sem.output_bits,
                    prog.notes + ['prefilter %r merges inputs the observer '
                                  'cannot distinguish' % name])
                if verify(composed, sem, obs):
                    out.append(composed)
        if out:
            break
    return out


# ---------------------------------------------------------------------------
# TABLE — always available on a finite domain, deliberately expensive
# ---------------------------------------------------------------------------

def solve_table(sem, obs, options=None):
    """Finite-domain lookup.

    Always correct when the domain is exhaustive, and always last under the
    objective because L(z) counts the table.  Its value is that a "no solution"
    answer then means "no *compact* solution", not "QM gave up".
    """
    if not sem.domain.exhaustive or sem.input_bits > 16:
        return []
    prog = Program([table(sem.table(), sem.input_bits, sem.output_bits)],
                   1, 1, 'table', sem.input_bits, sem.output_bits,
                   ['%d-entry lookup table; correct by construction, and '
                    'ranked last because L(z) counts the table'
                    % (1 << sem.input_bits)])
    return [prog] if verify(prog, sem, obs) else []


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

COMPACT_SOLVERS = (
    solve_identity,
    solve_constant,
    solve_deposit_conv_family,
    solve_linear,
    solve_point_gather,
)


def solve_all(sem, obs, options=None):
    """Run every solver, returning all verified candidate programs."""
    options = options or {}
    found = []
    for solver in COMPACT_SOLVERS:
        found.extend(solver(sem, obs, options))

    if not found or options.get('always_try_prefilters'):
        found.extend(solve_with_prefilter(
            sem, obs, (solve_deposit_conv_family, solve_linear), options))

    if options.get('allow_table', True):
        found.extend(solve_table(sem, obs, options))

    return found
