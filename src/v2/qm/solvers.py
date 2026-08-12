"""Synthesize candidate programs after quotienting and normalization.

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

from .bits import (M64, clmul, clz, ctz, lane_masks, lane_values, mask_of,
                    pdep, pext, popcnt, smear, to_signed)
from .program import (
    Key, Program, bit_query, compile_program, conv, field_compare, field_key,
    fork, identity, lin_const, perm_dyn_gather, point, split, table,
)

# The deposit/convolution search enumerates the constant's free high bits, and
# there are 2^p0 of them at shift p0. Bounded, because the alternative is a
# solve that does not return: a kernel whose first lane lands in a float's
# exponent field has thirty trailing zeros and therefore a billion candidates.
MAX_CONSTANT_CANDIDATES = 1 << 14

MAX_CLOSED_FORM_BITS = 16


# How many points a candidate has to survive before the whole domain is asked.
PREFILTER = 256


def _agrees(evaluate, values, expected, obs, mask):
    if mask is None:
        return all(obs(evaluate(x)) == obs(y) for x, y in zip(values, expected))
    return all(evaluate(x) & mask == y & mask
               for x, y in zip(values, expected))


def verify(program, sem, obs):
    """Exhaustive-on-the-domain check of an abstract program.

    Most candidates offered here are wrong, and a wrong candidate is almost
    never wrong only in some far corner of the domain — so a spread-out sample
    is asked first, and a rejection costs 256 evaluations instead of 65,536.
    Anything that survives is still checked on every point, so what `verify`
    means is unchanged: it accepts a program only after seeing the whole
    declared domain.
    """
    evaluate = compile_program(program)
    values = sem.domain.values()
    expected = sem.table()
    mask = obs.mask
    try:
        if len(values) > PREFILTER:
            step = len(values) // PREFILTER
            if not _agrees(evaluate, values[::step], expected[::step],
                           obs, mask):
                return False
        return _agrees(evaluate, values, expected, obs, mask)
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


def solve_conv_only(sem, obs, options=None):
    """`CONV(family, M)` with no deposit in front of it.

    A kernel whose lanes are already in place — a prefix sum over byte lanes,
    say — is one multiply, and the deposit/convolution solver cannot express it
    because that family always begins with a PDEP.  The constant is forced by
    a single probe: if the program is x*M then M = f(1).
    """
    if obs(sem.value_at(0)) != obs(0):
        return []
    const = sem.value_at(1)
    if const == 0:
        return []

    out = []
    for family in (options or {}).get('families', ('IMUL', 'CLMUL')):
        prog = Program([conv(family, const)], 1, 1, 'conv[%s]' % family,
                       sem.input_bits, sem.output_bits,
                       ['constant forced by f(1); the lanes need no deposit'])
        if verify(prog, sem, obs):
            out.append(prog)
            break
    return out


def solve_ceil_shift(sem, obs, options=None):
    """Recognize ceiling division by a power of two.

    For a nonnegative integer and ``q = 2**shift``, substitution gives the
    unique smallest containing class directly:

        ceil(x / q) = (x + q - 1) >> shift

    Every proposed shift is verified on the complete declared domain, so an
    addition that can wrap at the source width is rejected rather than hidden
    behind the identity.
    """
    if sem.input_bits < 2 or not obs.is_identity:
        return []
    for shift in range(1, min(63, sem.input_bits) + 1):
        program = Program(
            [point([('ADD', mask_of(shift), None),
                    ('SHR', None, shift)],
                   note='ceiling division by 2^%d' % shift)],
            1, shift, 'ceil-power-two-division',
            sem.input_bits, sem.output_bits,
            ['(x + %d) >> %d is verified over the declared domain'
             % (mask_of(shift), shift)])
        if verify(program, sem, obs):
            return [program]
    return []


def solve_field_boundary(sem, obs, options=None):
    """Recognize zero/nonzero and all-zero/all-one contiguous fields.

    Once a field is range-proved, its boundary predicates have closed forms:

        [z != 0]   = (z + (2**w - 1)) >> w
        [z == 0]   = (z - 1) >> 63
        [z == max] = (z + 1) >> w

    The last identity is especially useful for packed publication conditions:
    it says all required facts are true without branching or scalarizing the
    facts. Candidate fields are inferred from semantics and then exhaustively
    verified; function names and source expressions are not inspected.
    """
    if (sem.input_bits < 1 or not sem.domain.finite_exact
            or not obs.is_identity or not set(sem.table()) <= {0, 1}):
        return []
    values = sem.domain.values()
    expected = sem.table()
    probe_step = max(1, len(values) // PREFILTER)
    probes = values[::probe_step][:PREFILTER]
    wanted = expected[::probe_step][:PREFILTER]
    maximum_width = min(32, sem.input_bits)
    for width in range(1, maximum_width + 1):
        field = mask_of(width)
        for offset in range(0, sem.input_bits - width + 1):
            def extracted(x, shift=offset, mask=field):
                return (x >> shift) & mask

            predicates = (
                ('field-all-one', lambda z, m=field: int(z == m),
                 [('ADD', 1, None), ('SHR', None, width)]),
                ('field-nonzero', lambda z: int(z != 0),
                 [('ADD', field, None), ('SHR', None, width)]),
                ('field-zero', lambda z: int(z == 0),
                 [('SUB', 1, None), ('SHR', None, 63)]),
            )
            prefix = []
            if offset:
                prefix.append(('SHR', None, offset))
            if offset or width < sem.input_bits:
                prefix.append(('AND', field, None))
            for name, predicate, suffix in predicates:
                for complement in (False, True):
                    if not all((predicate(extracted(x)) ^ complement) == y
                               for x, y in zip(probes, wanted)):
                        continue
                    steps = prefix + suffix
                    if complement:
                        steps += [('XOR', 1, None)]
                    program = Program(
                        [point(steps, note='%d-bit field at %d is %s' % (
                            width, offset, name.replace('field-', '')))],
                        1, 1, name + ('-complement' if complement else ''),
                        sem.input_bits, sem.output_bits,
                        ['the field range forces a boundary predicate; the '
                         'complete declared domain verifies the candidate'])
                    if verify(program, sem, obs):
                        return [program]
    return []


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
        return clmul(value, const, 64) & M64
    raise ValueError('unknown convolution family: %r' % (family,))


def solve_deposit_conv(target, input_bits, family='IMUL', domain=None,
                       accept=None, expected=None, mask=None, tables=None,
                       geometry_mask=None):
    """Closed-form solver for `LIN_CONST[PDEP(D)] ; CONV(family, M)`.

    On a singleton source bit both IMUL and CLMUL act as a shift of M, so
    candidate generation is identical for the two families:

        target(1 << lane) = (M << p_lane) mod 2^64

    Only full-domain verification is family-specific.  That shared geometry is
    why the same trailing-zero freedom shows up under both IMUL and CLMUL: it
    comes from the boundary condition, not from one ISA instruction.

    `mask` is the observer's mask when it has one — every observer that
    declares one is `y & mask` and nothing else, and saying so lets the
    full-domain check below run without a call per point.  `tables` is a shared
    deposit-table cache: the two families propose the same deposits, and
    building a 2^16-entry table twice for one of them is the same work twice.

    Returns (solutions, candidates, error).
    """
    if not 1 <= input_bits <= MAX_CLOSED_FORM_BITS:
        return [], 0, ('closed-form deposit/convolution supports 1..%d input '
                       'bits' % MAX_CLOSED_FORM_BITS)

    values = list(range(1 << input_bits)) if domain is None else list(domain)
    accept = accept or (lambda a, b: a == b)
    if tables is None:
        tables = {}

    # Candidate geometry historically uses the complete word even when final
    # acceptance observes fewer bits.  ``geometry_mask`` is explicit for the
    # one case that needs truncation during generation: inactive coordinates
    # have already been substituted out of a narrower C result.
    visible = M64 if geometry_mask is None else geometry_mask & M64
    t0 = target(1) & visible
    if t0 == 0:
        return [], 0, 'lane 0 maps to zero; deposit+convolution has no solution'

    trailing = (t0 & -t0).bit_length() - 1
    lane_targets = [target(1 << lane) & visible
                    for lane in range(input_bits)]
    # `expected` is passed in by callers that already hold the evaluated table.
    # Re-evaluating a 2^16 domain per family is the difference between a
    # responsive page and a minute of dead air.
    if expected is None:
        expected = dict((m, target(m) & M64) for m in values)

    # Confirming one candidate walks the whole domain, and there are as many
    # walks as there are solutions to count — residual freedom is a reported
    # number, so none of them can be skipped.  What can go is the work inside
    # the walk: the family branch, the observer call and the dictionary lookup
    # are all the same on every point, so they are lifted out of it.
    if mask is not None:
        wanted = [expected[m] & mask for m in values]
    else:
        wanted = [expected[m] for m in values]
    contiguous = values == list(range(len(values)))

    candidates = 0
    solutions = []
    exhausted = False

    for p0 in range(trailing + 1):
        base = t0 >> p0
        if candidates + (1 << p0) > MAX_CONSTANT_CANDIDATES:
            # The high bits of the constant are shifted out and are therefore
            # free, so there are 2^p0 of them to enumerate — and `p0` runs to
            # the trailing zeros of `target(1)`, which is 30 for a kernel whose
            # first lane lands in a float's exponent field. That is a billion
            # candidates, and the search simply never came back.
            #
            # Enumerating fewer would silently undercount residual freedom, and
            # that number is reported. So the search stops instead and says it
            # did: no program from this family, rather than a program with a
            # freedom nobody counted.
            exhausted = True
            break
        for high in range(1 << p0):
            const = ((base | (high << (64 - p0))) if p0 else base) & M64
            candidates += 1

            # Which shifts of this constant hit each lane's target.  Asking
            # that lane by lane rescans all 64 shifts once per lane; the shifts
            # do not depend on the lane, so they are indexed once and each lane
            # is a lookup.  Ascending `p` order is preserved, which `walk`
            # below relies on.
            shifts = {}
            for p in range(64):
                shifts.setdefault(((const << p) & M64) & visible, []).append(p)
            allowed = [shifts.get(image) for image in lane_targets]
            if None in allowed or p0 not in allowed[0]:
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
                dep = tables.get(deposit)
                if dep is None:
                    dep = tables[deposit] = _deposit_table(deposit, input_bits)
                if _confirms(dep, const, family, values, wanted, mask,
                             contiguous, accept, expected):
                    solutions.append((deposit, const))

    solutions.sort()
    if exhausted:
        return [], candidates, (
            'deposit/convolution search stopped after %d constants: the first '
            'lane has %d trailing zeros, so the free high bits do not fit a '
            'bounded search' % (candidates, trailing))
    return solutions, candidates, None


def _confirms(dep, const, family, values, wanted, mask, contiguous, accept,
              expected):
    """Does `dep` composed with `const` reproduce the target on every point?"""
    if mask is None:
        return all(accept(_apply_conv(dep[m], const, family), expected[m])
                   for m in values)
    if family == 'IMUL':
        if contiguous:
            return all((d * const) & mask == y for d, y in zip(dep, wanted))
        return all((dep[m] * const) & mask == y
                   for m, y in zip(values, wanted))
    if contiguous:
        return all(clmul(d, const, 64) & mask == y
                   for d, y in zip(dep, wanted))
    return all(clmul(dep[m], const, 64) & mask == y
               for m, y in zip(values, wanted))


def solve_deposit_conv_family(sem, obs, options=None):
    """Wrap the closed-form solver into Programs, IMUL first then CLMUL."""
    options = options or {}
    families = options.get('families', ('IMUL', 'CLMUL'))
    if not sem.domain.finite_exact or obs(sem.value_at(0)) != obs(0):
        return []

    values = list(sem.domain.values())
    full_cube = (len(values) == (1 << sem.input_bits)
                 and values == list(range(1 << sem.input_bits)))

    # C parameter packing often leaves padding or a final field that cannot
    # affect an exclusive prefix.  Solving as if those zero-basis coordinates
    # needed PDEP destinations makes the real closed form disappear and lets a
    # large LUT win by default.  Substitute them out first, solve the active
    # coordinates, then put zero columns back.  Whole-domain verification below
    # is the converse: an allegedly inactive nonlinear coordinate cannot slip
    # through merely because its singleton basis image was zero.
    active = ([bit for bit in range(sem.input_bits)
               if obs(sem.value_at(1 << bit)) != obs(0)]
              if full_cube else list(range(sem.input_bits)))
    reduced = full_cube and len(active) < sem.input_bits
    if not active or len(active) > MAX_CLOSED_FORM_BITS:
        return []

    if reduced:
        def expand(value):
            return sum(((value >> lane) & 1) << source
                       for lane, source in enumerate(active))

        solve_values = range(1 << len(active))
        solve_expected = dict(
            (value, sem.value_at(expand(value))) for value in solve_values)
        solve_target = lambda value: solve_expected[value]
        geometry_mask = obs.mask
    else:
        solve_values = values
        solve_expected = dict(zip(values, sem.table()))
        solve_target = sem.target
        geometry_mask = None

    out = []
    tables = {}
    for family in families:
        sols, candidates, err = solve_deposit_conv(
            solve_target, len(active), family,
            domain=solve_values,
            accept=lambda a, b: obs(a) == obs(b),
            expected=solve_expected, mask=obs.mask, tables=tables,
            geometry_mask=geometry_mask,
        )
        if not sols:
            continue
        deposit, const = sols[0]
        positions = [position for position in range(64)
                     if (deposit >> position) & 1]
        basis = [0] * sem.input_bits
        for source, position in zip(active, positions):
            basis[source] = 1 << position
        prog = Program(
            [lin_const(basis, sem.input_bits, note='PDEP-shaped deposit'),
             conv(family, const,
                  lane_width=_lane_width(deposit, len(active)))],
            len(sols), candidates, 'deposit+conv[%s]' % family,
            sem.input_bits, sem.output_bits,
            (['%d inactive input coordinate(s) substituted out' %
              (sem.input_bits - len(active))] if reduced else []) + [
             'deposit mask 0x%016X' % deposit,
             'convolution constant 0x%016X' % const])
        if verify(prog, sem, obs):
            out.append(prog)
    return out


# ---------------------------------------------------------------------------
# FORK — support mask and value convolution from one shared deposit
# ---------------------------------------------------------------------------

def _lane_support(value, lane_bits):
    lane = mask_of(lane_bits)
    out = 0
    for shift in range(0, 64, lane_bits):
        if (value >> shift) & lane:
            out |= lane << shift
    return out & M64


def solve_support_masked_conv(sem, obs, options=None):
    """Factor ``f(x)`` as ``support(x) & convolution(deposit(x))``.

    The support is forced directly by the nonzero output lanes.  Its
    deposit/convolution form is solved exactly.  If some full-support input has
    an odd deposited word, multiplication by that word is invertible modulo
    2^64, so the value convolution constant is uniquely forced.  Exhaustive
    verification supplies the converse: the factorization is accepted only if
    those forced branches reproduce every output in the declared domain.

    Keeping the two branches explicit is essential.  Both consume the same
    deposit, and physical lowering can therefore share it as one SSA node
    instead of scalarizing either branch or falling back to a table.
    """
    if (sem.input_bits > MAX_CLOSED_FORM_BITS or sem.output_bits != 64
            or not sem.domain.finite_exact or not obs.is_identity):
        return []
    values = list(sem.domain.values())
    expected = list(sem.table())
    modulus = 1 << 64

    for lane_bits in (2, 4, 8, 16, 32):
        supports = [_lane_support(y, lane_bits) for y in expected]
        if not any(supports) or all(mask == M64 for mask in supports):
            continue
        support_by_input = dict(zip(values, supports))
        support_target = support_by_input.__getitem__
        tables = {}
        solutions, candidates, _error = solve_deposit_conv(
            support_target, sem.input_bits, 'IMUL', domain=values,
            expected=support_by_input, tables=tables,
        )
        accepted = []
        for deposit, support_const in solutions:
            deposited = tables.get(deposit)
            if deposited is None:
                deposited = tables[deposit] = _deposit_table(
                    deposit, sem.input_bits)
            anchors = [x for x, support in zip(values, supports)
                       if support == M64 and deposited[x] & 1]
            if not anchors:
                continue
            anchor = anchors[0]
            value_const = (expected[values.index(anchor)]
                           * pow(deposited[anchor], -1, modulus)) & M64
            if not all(((deposited[x] * value_const) & M64) & support == y
                       for x, support, y in zip(values, supports, expected)):
                continue

            basis = [1 << position for position in range(64)
                     if (deposit >> position) & 1][:sem.input_bits]
            value_branch = Program(
                [lin_const(basis, sem.input_bits,
                           note='shared deposit for supported values'),
                 conv('IMUL', value_const,
                      lane_width=_lane_width(deposit, sem.input_bits))],
                1, 1, 'support-value-branch', sem.input_bits, 64)
            support_branch = Program(
                [lin_const(basis, sem.input_bits,
                           note='shared deposit for lane support'),
                 conv('IMUL', support_const,
                      lane_width=_lane_width(deposit, sem.input_bits))],
                1, 1, 'support-mask-branch', sem.input_bits, 64)
            program = Program(
                [fork((value_branch, support_branch), 'AND',
                      note='support-gated shared convolution')],
                len(solutions), candidates, 'support-masked-conv',
                sem.input_bits, sem.output_bits,
                ['%d-bit lane support is forced by nonzero outputs' % lane_bits,
                 'full-support odd anchor forces value constant 0x%016X'
                 % value_const])
            if verify(program, sem, obs):
                accepted.append(program)
        if accepted:
            return accepted[:1]
    return []


def _lane_width(deposit_mask, input_bits):
    positions = [i for i in range(64) if (deposit_mask >> i) & 1][:input_bits]
    if len(positions) < 2:
        return None
    gaps = set(b - a for a, b in zip(positions, positions[1:]))
    return gaps.pop() if len(gaps) == 1 else None


# ---------------------------------------------------------------------------
# POINT — per-lane comparison against a constant
# ---------------------------------------------------------------------------

# Lane widths worth testing: a divisor of 64 wide enough to hold a comparison,
# and narrow enough that the domain can show every value a lane can take.
LANE_WIDTHS = (2, 4, 8, 16)


def _lane_bits_of(outputs, input_bits):
    """The lane width implied by where the output bits are, or None.

    A per-lane predicate writes one bit per lane and nothing else, so the union
    of every output is a subset of "the top bit of each lane". That pins the
    width without having to be told it.
    """
    union = 0
    for y in outputs:
        union |= y
    if not union:
        return None                     # a constant, and not this family's job
    for lane_bits in LANE_WIDTHS:
        if lane_bits > input_bits or input_bits % lane_bits:
            continue
        _, _, high = lane_masks(lane_bits)
        high &= mask_of(input_bits)
        if union & ~high:
            continue
        # The lowest bit that ever fires has to be a lane's top bit; otherwise
        # a wider lane would explain the same outputs and be wrong about which.
        if (union & -union) == (1 << (lane_bits - 1)):
            return lane_bits
    return None


def _lane_truth_table(sem, lane_bits):
    """Which lane values set their lane's bit, read off the observed data.

    Every input carries `64 / lane_bits` independent observations of the same
    lane-local predicate, so a domain far too sparse to characterise a 64-bit
    function still sees each of the 256 byte values a few hundred times. The
    answer is only accepted when *every* value has been seen and every sighting
    agreed: a predicate guessed at the values that happened to show up is not
    forced by anything.
    """
    lanes = sem.input_bits // lane_bits
    lane_mask = mask_of(lane_bits)
    top = 1 << (lane_bits - 1)
    truth = {}
    for x, y in sem.pairs():
        for i in range(lanes):
            value = (x >> (lane_bits * i)) & lane_mask
            fired = bool((y >> (lane_bits * i)) & top)
            seen = truth.get(value)
            if seen is None:
                truth[value] = fired
            elif seen != fired:
                return None             # not lane-local, or not uniform
    if len(truth) != (1 << lane_bits):
        return None
    return truth


def _lane_interval(truth, lane_bits):
    """The accepted set as (lo, hi), or None when it is not an interval."""
    accepted = sorted(value for value, fired in truth.items() if fired)
    if not accepted or len(accepted) == len(truth):
        return None                     # constant; `solve_constant` owns those
    if accepted != list(range(accepted[0], accepted[-1] + 1)):
        return None                     # not an interval, so not this family
    lo, hi = accepted[0], accepted[-1]
    # Only the two-sided form has the second subtraction, and only it needs the
    # upper bound to stay below the lane's top bit.  Equality does not subtract
    # at all and the one-sided form subtracts once, so neither is restricted —
    # `lane == 0xC0` is as answerable as `lane == 0x2C`.
    two_sided = lo != 0 and lo != hi
    if two_sided and hi >= (1 << (lane_bits - 1)):
        return None
    return lo, hi


def _describe_interval(lo, hi, lane_bits):
    if lo == hi:
        return 'lane == %d' % lo
    if lo == 0:
        return 'lane < %d' % (hi + 1)
    return '%d <= lane <= %d' % (lo, hi)


def solve_lane_predicate(sem, obs, options=None):
    """`POINT` — one interval test applied to every lane, as in the lane corpus.

    Comparison is where this grammar stops being linear: there is no GF(2)
    description of `lane < c`, and a deposit/convolution cannot produce one, so
    without this a per-lane predicate falls all the way through to a 2^16-entry
    lookup table. What is searched here is the interval, read off the data; the
    equality, one-sided and two-sided forms that compute it are three physical
    representatives of the same abstract step, chosen in `isa.lower_point`.
    """
    if sem.input_bits < 4 or sem.output_bits < sem.input_bits:
        return []

    lane_bits = _lane_bits_of(sem.table(), sem.input_bits)
    if lane_bits is None:
        return []
    truth = _lane_truth_table(sem, lane_bits)
    if truth is None:
        return []
    bounds = _lane_interval(truth, lane_bits)
    if bounds is None:
        return []

    lo, hi = bounds
    op = point([('LANE_INTERVAL', (lo, hi), lane_bits)],
               note='%d-bit lanes, %s'
                    % (lane_bits, _describe_interval(lo, hi, lane_bits)))
    prog = Program([op], 1, 1, 'lane-interval', sem.input_bits, sem.output_bits,
                   ['the accepted set is forced by the observed lanes: every '
                    'one of the %d values a %d-bit lane can take was seen, and '
                    'they form the interval [%d, %d]'
                    % (1 << lane_bits, lane_bits, lo, hi)])
    return [prog] if verify(prog, sem, obs) else []


def solve_gf256_multiply(sem, obs, options=None):
    """Recognize a packed GF(2^8) product instead of materializing its table."""
    if sem.input_bits != 16 or sem.output_bits > 8:
        return []
    prog = Program(
        [point([('GF256_MUL', 0x11D, 8)],
               note='two packed coefficients, reduced by x^8+x^4+x^3+x^2+1')],
        1, 1, 'gf256-product', sem.input_bits, sem.output_bits,
        ['bilinear erasure arithmetic is retained as arithmetic, not a '
         '65536-entry materialized table'])
    return [prog] if verify(prog, sem, obs) else []


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
# POINT — whole-word reductions
# ---------------------------------------------------------------------------

# Lane widths a cross-lane maximum is looked for at.  A reduction is only a
# reduction when the word holds several lanes, so 64 is not on the list.
REDUCE_LANE_WIDTHS = (8, 16, 32)


def solve_lane_reduction(sem, obs, options=None):
    """`POINT[LANE_MAX]` / `POINT[LANE_MIN]` — the extreme of the lanes.

    Proposed and verified, not searched: there are six candidates and each one
    is either the function or it is not.  What makes it worth having is that
    the answer is a *reduction* — the output is one lane wide however wide the
    input is — and no amount of deposit, convolution or lane predicate can
    produce one, so without this `max` of eight packed bytes has no program at
    all rather than an expensive one.
    """
    if sem.input_bits < 16:
        return []
    # How wide the answer is, read off the answers.  The declared output width
    # is not it: a listing does not declare one, and a kernel whose C says
    # `uint64_t` can still be answering with a byte.
    reach = 0
    for y in sem.table():
        reach |= y
    out = []
    for lane_bits in REDUCE_LANE_WIDTHS:
        if lane_bits >= sem.input_bits or reach > mask_of(lane_bits):
            continue
        for mnemonic in ('LANE_MAX', 'LANE_MIN'):
            op = point([(mnemonic, None, lane_bits)],
                       note='%s over %d-bit lanes' % (mnemonic, lane_bits))
            prog = Program([op], 1, 1, 'lane-reduction', sem.input_bits,
                           sem.output_bits,
                           ['the %s of the %d lanes, verified on the whole '
                            'domain' % (mnemonic, 64 // lane_bits)])
            if verify(prog, sem, obs):
                out.append(prog)
                return out
    return out


# ---------------------------------------------------------------------------
# POINT — short chains of whole-word steps, wrapped in an affine
# ---------------------------------------------------------------------------

# How deep the chain search goes.  Three is not a tuning knob: it is how many
# steps the whole-word idioms in the teaching literature actually are once the
# cascades they are built from — smear, popcount, the sign fold — are single
# steps rather than six shifts each.
CHAIN_DEPTH = 3

# Probes the search discriminates on before a candidate is put to the whole
# domain.  Small enough that a few thousand chains cost nothing, spread enough
# that a wrong chain almost never survives.
CHAIN_PROBES = 40


def _cascade_cost(width):
    steps = 0
    shift = 1
    while shift < width:
        steps += 2
        shift <<= 1
    return steps


def chain_steps(width, modulus=None):
    """The alphabet of whole-word steps, as (label, POINT steps, function, cost).

    Each entry is one recognizable move, not one instruction: `SMEAR` is the
    doubling cascade and `XOR_SAR` is the two's-complement fold, because those
    are the units a reader of `round_up_pow2` or `howManyBits` sees.  A search
    over shifts and ORs instead would need eight levels to reach the same place
    and would call the answer eight things.
    """
    m = mask_of(width)
    # A mask that keeps every bit of the register is not an instruction, so it
    # is not emitted; a narrower word needs it after anything that can carry or
    # complement into the bits above it.
    trim = [('AND', m, None)] if width < 64 else []
    narrow = 1 if width < 64 else 0
    steps = [
        ('NOT', [('NOT', None, None)] + trim, lambda v: (~v) & m, 1 + narrow),
        ('NEG', [('NEG', None, None)] + trim, lambda v: (-v) & m, 1 + narrow),
        ('lowest set bit', [('AND_NEG', None, None)], lambda v: v & ((-v) & m),
         2),
        # `x | -x` puts "is anything set" in the top bit, which is the whole of
        # a logical negation once the bit is shifted down and complemented.
        ('any bit set', [('OR_NEG', None, None)], lambda v: (v | (-v)) & m, 2),
        ('clear lowest set bit', [('AND_DEC', None, None)],
         lambda v: v & ((v - 1) & m), 2),
        ('smear', [('SMEAR', width, None)], lambda v: smear(v, width),
         _cascade_cost(width)),
        ('popcount', [('POPCNT', None, None)], popcnt, 1),
        ('leading zeros', [('CLZ', width, None)], lambda v: clz(v, width),
         1 + 2 * narrow),
        ('trailing zeros', [('CTZ', width, None)], lambda v: ctz(v, width),
         1 + narrow),
        ('sign fold', [('XOR_SAR', width, width - 1)],
         lambda v: (v ^ (to_signed(v, width) >> (width - 1))) & m,
         2 + 2 * narrow),
    ]
    # Doubling shifts, plus the one that reads a word's top bit: a sign or a
    # "did anything survive" flag lives at `width - 1` and nowhere near a power
    # of two.
    if modulus is not None:
        # The modulus is read off the observed outputs, the way a lane
        # interval is read off the observed lanes: a function whose values
        # stop at Q-1 and cover it has said what it is reduced by.
        steps.append(('mod %d' % modulus, [('MOD', modulus, width)],
                      lambda v, q=modulus: v % q, 4))
    for shift in sorted(set([s for s in (1, 2, 4, 8, 16, 32) if s < width]
                            + [width - 1])):
        if shift >= width:
            break
        steps.append(('>> %d' % shift, [('SHR', None, shift)],
                      lambda v, s=shift: v >> s, 1))
        steps.append(('<< %d' % shift, [('SHL', None, shift)] + trim,
                      lambda v, s=shift: (v << s) & m, 1 + narrow))
    return steps


# What the chain is allowed to be fed: the word, or the word one either side.
# `round_up_pow2` is `smear(x - 1) + 1` and nothing shorter, so a search that
# could not subtract before starting would miss it by one.
CHAIN_ENTRIES = (
    ('x', 0), ('x - 1', -1), ('x + 1', 1),
)


# What leaving the chain costs in instructions: an add is one, and `c - v` is
# a negate and an add.
EXIT_COST = {'ADD': 1, 'SUB': 2}


def _affine_exit(values, wanted, output_bits):
    """`(kind, c)` when `wanted` is `values + c` or `c - values`, else None."""
    out = mask_of(output_bits)
    c = (wanted[0] - values[0]) & out
    if all((v + c) & out == w for v, w in zip(values, wanted)):
        return ('ADD', c)
    c = (wanted[0] + values[0]) & out
    if all((c - v) & out == w for v, w in zip(values, wanted)):
        return ('SUB', c)
    return None


def _chain_probe_values(sem):
    values = sem.domain.values()
    if len(values) <= CHAIN_PROBES:
        return list(values)
    step = len(values) // CHAIN_PROBES
    picked = list(values[::step][:CHAIN_PROBES])
    picked += [1 << i for i in range(min(sem.input_bits, 8))]
    return list(dict.fromkeys(v for v in picked if v <= mask_of(sem.input_bits)))


# A reduction's reciprocal has to fit a 64-bit multiply, which bounds the
# value's width plus the modulus's.  Wider than this and there is no lowering,
# so there is no point offering the step.
MAX_MOD_PRODUCT_BITS = 62


def _modulus_of(outputs, width):
    """The modulus the outputs imply, or None.

    `Q` when the observed values are exactly `0 .. Q-1`: a function that never
    reaches Q-1, or that skips a residue below it, is one whose range happens
    to be small rather than one that was reduced.  A power of two is a mask,
    and `AND` already has that.
    """
    modulus = max(outputs) + 1
    if modulus < 3 or modulus >= (1 << width):
        return None
    if modulus & (modulus - 1) == 0:
        return None
    if width + modulus.bit_length() > MAX_MOD_PRODUCT_BITS:
        return None
    if len(set(outputs)) != modulus:
        return None
    return modulus


def solve_point_chain(sem, obs, options=None):
    """`POINT` — a short chain of whole-word steps, entered and left affinely.

    Breadth-first over the alphabet above, de-duplicated by what a chain *does*
    to the probes rather than by how it is spelled, so the thousands of ways to
    write "shift right by three" collapse to one state.  A surviving chain is
    then put to the whole declared domain like every other candidate.

    This is the family that contains the exercises whose answer is one idiom:
    `x & -x`, `popcount`, `smear(x-1) + 1`.  It is a search and not a table of
    names — nothing here knows what `round_up_pow2` is called.
    """
    if sem.input_bits < 2:
        return []
    width = sem.input_bits
    probes = _chain_probe_values(sem)
    wanted = [sem.value_at(x) for x in probes]
    alphabet = chain_steps(width, _modulus_of(sem.table(), width))

    m = mask_of(width)
    # Depth is the outer loop and the entry is the inner one, so the shortest
    # chain wins rather than whichever entry happened to be tried first.  Left
    # to itself the search would answer `x - 1 ; smear ; + 1` with
    # `NEG ; NOT ; smear ; + 1`, which is the same function three steps long.
    searches = []
    for entry_label, delta in CHAIN_ENTRIES:
        start = tuple((x + delta) & m for x in probes)
        searches.append([entry_label, delta, {start: None},
                         [(start, [], 1 if delta else 0)]])

    for depth in range(CHAIN_DEPTH + 1):
        # Every chain that reaches the target at this depth, cheapest first.
        # Depth counts moves and the objective counts instructions, and the two
        # disagree: `smear` is one move and twelve instructions, so a search
        # that returned the first match would answer a logical negation with a
        # cascade where a shift would do.
        matched = []
        for entry_label, delta, seen, frontier in searches:
            for values, chain, cost in frontier:
                exit_form = _affine_exit(values, wanted, sem.output_bits)
                if exit_form is None:
                    continue
                if not chain and not delta and exit_form[1] == 0:
                    continue            # the identity; `solve_identity` owns it
                matched.append((cost + EXIT_COST[exit_form[0]], entry_label,
                                delta, chain, exit_form))
        matched.sort(key=lambda item: (item[0], item[1]))
        for _cost, entry_label, delta, chain, exit_form in matched:
            prog = _chain_program(sem, entry_label, delta, chain, exit_form)
            if verify(prog, sem, obs):
                return [prog]
        if depth == CHAIN_DEPTH:
            break
        for search in searches:
            seen, frontier = search[2], search[3]
            nxt = []
            for values, chain, cost in frontier:
                for label, steps, fn, weight in alphabet:
                    moved = tuple(fn(v) for v in values)
                    if moved in seen:
                        continue
                    seen[moved] = None
                    nxt.append((moved, chain + [(label, steps)], cost + weight))
            search[3] = nxt
    return []


# ---------------------------------------------------------------------------
# POINT / SPLIT — field inequality and one-bit semantic selection
# ---------------------------------------------------------------------------

def solve_field_neq(sem, obs, options=None):
    """Recognize equality or inequality between two packed integer fields.

    The two fields are first XORed by one GF(2)-linear map.  Its proved finite
    range then reduces nonzero to ``(x + (2**width - 1)) >> width``.  This is
    the closed form of field inequality; it is not inferred from a function
    name or a C branch.
    """
    if (sem.input_bits < 2 or sem.output_bits != 1
            or not sem.domain.finite_exact or not obs.is_identity):
        return []
    values = sem.domain.values()
    expected = sem.table()
    probe_step = max(1, len(values) // PREFILTER)
    probes = values[::probe_step][:PREFILTER]
    wanted = expected[::probe_step][:PREFILTER]

    for width in range(1, min(32, sem.input_bits // 2) + 1):
        field = mask_of(width)
        shifts = range(0, sem.input_bits - width + 1, width)
        for left in shifts:
            for right in shifts:
                if right <= left or right < left + width:
                    continue

                def neq(x, a=left, b=right, m=field):
                    return int((((x >> a) ^ (x >> b)) & m) != 0)

                for complement in (False, True):
                    if not all((neq(x) ^ complement) == y
                               for x, y in zip(probes, wanted)):
                        continue
                    basis = [0] * sem.input_bits
                    for bit in range(width):
                        basis[left + bit] = 1 << bit
                        basis[right + bit] = 1 << bit
                    # The XOR difference is proved to be a ``width``-bit
                    # word.  For 0 <= z < 2**width,
                    #
                    #   [z != 0] = (z + (2**width - 1)) >> width
                    #   [z == 0] = (z - 1) >> 63
                    #
                    # so a range-aware two-op reduction replaces the generic
                    # ``z | -z`` reduction and its third shift/XOR step.
                    if width == 1:
                        steps = ([('XOR', 1, None)] if complement else [])
                    elif complement:
                        steps = [('SUB', 1, None), ('SHR', None, 63)]
                    else:
                        steps = [('ADD', field, None),
                                 ('SHR', None, width)]
                    ops = [lin_const(
                        basis, sem.input_bits,
                        note='difference of equal-width fields')]
                    if steps:
                        ops.append(point(
                            steps, note='%s field difference' % (
                                'zero' if complement else 'nonzero')))
                    program = Program(
                        ops,
                        1, 1, 'field-%s' % ('eq' if complement else 'neq'),
                        sem.input_bits, sem.output_bits,
                        ['%d-bit fields at %d and %d are compared by their '
                         'complete XOR difference' % (width, left, right)])
                    if verify(program, sem, obs):
                        return [program]
    return []


def solve_residual_bit_query(sem, obs, options=None):
    """Recognize a dynamic bit query over a packed residual and selector.

    This is the finite-predicate residual decoder from the two-phase model:
    the answer vector has already crossed the temporal cut, so the future
    query is one indexed bit observation rather than a table over both fields.
    """
    if (sem.input_bits < 3 or not sem.domain.finite_exact
            or not obs.is_identity):
        return []
    values = sem.domain.values()
    expected = sem.table()
    if any(value not in (0, 1) for value in expected):
        return []
    step = max(1, len(values) // PREFILTER)
    probes = values[::step][:PREFILTER]
    wanted = expected[::step][:PREFILTER]
    widths = tuple(width for width in (64, 32, 16, 8, 4, 2)
                   if width <= sem.input_bits)
    for value_width in widths:
        index_width = (value_width - 1).bit_length()
        if value_width + index_width > sem.input_bits:
            continue
        for value_shift in range(
                0, sem.input_bits - value_width + 1, value_width):
            value_mask = mask_of(value_width) << value_shift
            for index_shift in range(sem.input_bits - index_width + 1):
                index_mask = mask_of(index_width) << index_shift
                if value_mask & index_mask:
                    continue

                def evaluate(x, vs=value_shift, vw=value_width,
                             is_=index_shift, iw=index_width):
                    value = (x >> vs) & mask_of(vw)
                    index = (x >> is_) & mask_of(iw)
                    return (value >> index) & 1

                if not all(evaluate(x) == y
                           for x, y in zip(probes, wanted)):
                    continue
                program = Program(
                    [bit_query(value_shift, value_width,
                               index_shift, index_width)],
                    1, 1, 'residual-bit-query', sem.input_bits,
                    sem.output_bits,
                    ['the future selector observes one bit of a sealed '
                     '%d-bit answer residual' % value_width])
                if verify(program, sem, obs):
                    return [program]
    return []


def solve_rank_token_query(sem, obs, options=None):
    """Recognize ``rank > query`` between equal-width unsigned fields."""
    if (sem.input_bits < 2 or not sem.domain.finite_exact
            or not obs.is_identity):
        return []
    values = sem.domain.values()
    expected = sem.table()
    if any(value not in (0, 1) for value in expected):
        return []
    step = max(1, len(values) // PREFILTER)
    probes = values[::step][:PREFILTER]
    wanted = expected[::step][:PREFILTER]
    maximum = min(32, sem.input_bits // 2)
    for width in range(maximum, 0, -1):
        field = mask_of(width)
        shifts = range(0, sem.input_bits - width + 1, width)
        for left_shift in shifts:
            left_mask = field << left_shift
            for right_shift in shifts:
                if right_shift == left_shift \
                        or left_mask & (field << right_shift):
                    continue

                def evaluate(x, ls=left_shift, rs=right_shift, m=field):
                    return int(((x >> ls) & m) > ((x >> rs) & m))

                if not all(evaluate(x) == y
                           for x, y in zip(probes, wanted)):
                    continue
                program = Program(
                    [field_compare('GT_U', left_shift,
                                   right_shift, width)],
                    1, 1, 'rank-token-query', sem.input_bits,
                    sem.output_bits,
                    ['an ordered threshold family has already been reduced '
                     'to one %d-bit rank token' % width])
                if verify(program, sem, obs):
                    return [program]
    return []


def _compact_select_branch(sem, obs, options):
    """Cheapest closed branch used by :func:`solve_bit_select`."""
    fitted = _fit_affine_map(
        sem.domain.values(), sem.table(), sem.input_bits, sem.output_bits)
    if fitted is not None:
        basis, constant = fitted
        ops = [lin_const(basis, sem.input_bits,
                         note='GF(2)-affine selector branch')]
        if constant:
            ops.append(point([('XOR', constant, None)],
                             note='selector branch constant'))
        program = Program(ops, 1, 1, 'selector-affine-branch',
                          sem.input_bits, sem.output_bits)
        if verify(program, sem, obs):
            return program
    for solver in (solve_identity, solve_constant, solve_linear,
                   solve_field_neq):
        programs = solver(sem, obs, options)
        if programs:
            return programs[0]
    return None


def solve_bit_select(sem, obs, options=None):
    """Derive ``selector ? branch1(x) : branch0(x)`` on one input bit.

    Conditioning on a candidate bit is necessary for a one-bit selector, and
    two independently verified branch programs plus the final whole-domain
    verification are sufficient.  Bits are tried from high to low because C
    parameter packing places narrow control fields after their data fields;
    the order only affects search time, never acceptance.
    """
    options = options or {}
    if (sem.input_bits < 2 or not sem.domain.finite_exact
            or not obs.is_identity):
        return []
    values = sem.domain.values()
    for selector in range(sem.input_bits - 1, -1, -1):
        domains = ([x for x in values if not (x >> selector) & 1],
                   [x for x in values if (x >> selector) & 1])
        if not domains[0] or not domains[1]:
            continue
        branches = []
        for domain in domains:
            branch = _compact_select_branch(sem.restricted(domain), obs,
                                            options)
            if branch is None:
                break
            branches.append(branch)
        if len(branches) != 2:
            continue
        selector_basis = [0] * sem.input_bits
        selector_basis[selector] = 1
        selector_ops = [lin_const(
            selector_basis, sem.input_bits, note='one-bit selector')]
        if sem.output_bits > 1:
            selector_ops.append(point(
                [('NEG', None, None)], note='selector word mask'))
        selector_program = Program(
            selector_ops, 1, 1, 'selector-mask', sem.input_bits,
            sem.output_bits)
        difference = Program(
            [fork(branches, 'XOR', note='difference of selected branches')],
            1, 1, 'selector-difference', sem.input_bits, sem.output_bits)
        selected = Program(
            [fork((selector_program, difference), 'AND',
                  note='selector gates only the branch difference')],
            1, 1, 'selector-gate', sem.input_bits, sem.output_bits)
        program = Program(
            [fork((branches[0], selected), 'XOR',
                  note='base branch plus gated difference')],
            1, 2, 'bit-select-ssa', sem.input_bits, sem.output_bits,
            ['bit %d forces f0 XOR (selector AND (f0 XOR f1)); both '
             'directions are verified on the complete domain' % selector])
        if verify(program, sem, obs):
            return [program]
    return []


def _chain_program(sem, entry_label, delta, chain, exit_form):
    width = sem.input_bits
    steps = []
    if delta:
        steps.append(('ADD' if delta > 0 else 'SUB', abs(delta), None))
        if width < 64:
            steps.append(('AND', mask_of(width), None))
    labels = []
    for label, sub in chain:
        steps.extend(sub)
        labels.append(label)
    kind, const = exit_form
    if kind == 'SUB':
        # `c - v`, and the grammar has no reverse subtract: negate, then add.
        # The result is masked to the output width either way, so a narrower
        # word needs no trim of its own.
        steps.append(('NEG', None, None))
        if const:
            steps.append(('ADD', const, None))
    elif const:
        steps.append(('ADD', const, None))
    description = ' ; '.join([entry_label] + labels)
    if kind == 'SUB':
        description += ' ; %d - it' % const
    elif const:
        description += ' ; + %d' % const
    return Program(
        [point(steps, note=description)], 1, len(chain) + 1,
        'point-chain', sem.input_bits, sem.output_bits,
        ['whole-word chain: %s' % description,
         'the chain is forced by the domain, not by a name: nothing in the '
         'search knows what this function is called'])


# ---------------------------------------------------------------------------
# SPLIT — piecewise, on a whole-word key
# ---------------------------------------------------------------------------

# How many pieces a split may have.  A split with as many pieces as the domain
# has points is a lookup table with extra steps, and the point of the class is
# that the answer is *few* cases; eight is where a teaching kernel's case
# analysis stops and a table begins.
MAX_SPLIT_PIECES = 8

# On a sampled domain a piece seen only once or twice is not evidence of
# anything — an affine map through two points is not a fit, it is a definition.
MIN_SAMPLED_PIECE = 8


class _Gf2AffineFit(object):
    """`y = c XOR (XOR_j basis[j] . x_j)` fitted incrementally over GF(2).

    Constant, identity, "keep these bits", "shift that field into place" and
    every combination of them are this one family, which is why a piece does
    not need to be told which of those it is.
    """

    label = 'GF(2)-affine'

    def __init__(self, input_bits, output_bits):
        self.input_bits = input_bits
        self.mask = mask_of(output_bits)
        self.pivots = {}
        self.solution = None
        self.alive = True

    def clone(self):
        copy = _Gf2AffineFit.__new__(_Gf2AffineFit)
        copy.input_bits = self.input_bits
        copy.mask = self.mask
        copy.pivots = dict(self.pivots)
        copy.solution = self.solution
        copy.alive = self.alive
        return copy

    def _values(self):
        """The unknowns, with free ones pinned to zero."""
        return [self.pivots[i][1] if i in self.pivots else 0
                for i in range(self.input_bits + 1)]

    def predict(self, x):
        values = self.solution
        out = values[self.input_bits]
        index = 0
        while x:
            if x & 1:
                out ^= values[index]
            x >>= 1
            index += 1
        return out & self.mask

    def add(self, x, y):
        if not self.alive:
            return False
        # Once every unknown has a pivot the system is determined, and a new
        # point is a check rather than a constraint.  Before that it is not:
        # a point that happens to agree with the currently pinned solution can
        # still rule out the solution a later point would force, so it has to
        # go through the elimination like any other.
        if self.solution is not None:
            self.alive = self.predict(x) == (y & self.mask)
            return self.alive
        vector = (x & mask_of(self.input_bits)) | (1 << self.input_bits)
        rhs = y & self.mask
        # Pivots are chosen from the highest column.  Reduce in that same
        # order; insertion order is not an echelon order after existing rows
        # have been rewritten by a later pivot.
        for position in sorted(self.pivots, reverse=True):
            pv, pr = self.pivots[position]
            if (vector >> position) & 1:
                vector ^= pv
                rhs ^= pr
        if vector == 0:
            self.alive = rhs == 0
            return self.alive
        # The highest column first, which puts the constant — its column is the
        # top one — ahead of every input bit.  A piece where some bits never
        # move leaves the system underdetermined, and pivoting low attributes
        # the whole constant to whichever low bit happened to appear in the
        # first row: a correct map, spelled as a fourteen-instruction XOR
        # network instead of a mask and a constant.
        position = vector.bit_length() - 1
        for other, (ov, orhs) in list(self.pivots.items()):
            if (ov >> position) & 1:
                self.pivots[other] = (ov ^ vector, orhs ^ rhs)
        self.pivots[position] = (vector, rhs)
        if len(self.pivots) == self.input_bits + 1:
            self.solution = self._values()
        return True

    @property
    def settled(self):
        return self.alive

    def program(self, sem):
        values = self.solution or self._values()
        basis = values[:self.input_bits]
        constant = values[self.input_bits]
        ops = [lin_const(basis, self.input_bits, note='branch, GF(2)-linear')]
        if constant:
            ops.append(point([('XOR', constant, None)], note='branch constant'))
        return Program(ops, 1, 1, 'split-branch', sem.input_bits,
                       sem.output_bits)


def solve_linear_lane_affine(sem, obs, options=None):
    """Linear neighbour map, uniform zero predicate, then affine publication.

    Run directories and byte-difference indexes have exactly this shape.  The
    source may spell the zero test as scalar branches, but the selected form
    evaluates every lane together and keeps the publication map separate.
    """
    if sem.input_bits != 64 or sem.output_bits > 64:
        return []
    values = sem.domain.values()
    expected = sem.table()
    high_by_width = dict((width, lane_masks(width)[2])
                         for width in (8, 16, 32))
    for direction in ('left', 'right'):
        for shift in (1, 2, 4, 8, 16, 32):
            if shift >= sem.input_bits:
                continue
            basis = []
            for bit in range(sem.input_bits):
                source = 1 << bit
                moved = ((source << shift) & M64 if direction == 'left'
                         else source >> shift)
                basis.append(source ^ moved)
            for lane_bits, high in high_by_width.items():
                transformed = [
                    x ^ (((x << shift) & M64) if direction == 'left'
                         else (x >> shift))
                    for x in values]
                predicate = []
                lane_mask = mask_of(lane_bits)
                top = 1 << (lane_bits - 1)
                for word in transformed:
                    spread = 0
                    for lane in range(64 // lane_bits):
                        if ((word >> (lane * lane_bits)) & lane_mask) == 0:
                            spread |= top << (lane * lane_bits)
                    predicate.append(spread & high)

                fitted = _fit_affine_map(
                    predicate, expected, 64, sem.output_bits)
                if fitted is None:
                    continue
                post_basis, post_constant = fitted
                tail = [lin_const(post_basis, 64,
                                  note='affine publication')]
                if post_constant:
                    tail.append(point([('XOR', post_constant, None)],
                                      note='affine publication constant'))
                prog = Program(
                    [lin_const(basis, sem.input_bits,
                               note='neighbour XOR, %s %d'
                               % (direction, shift)),
                     point([('LANE_INTERVAL', (0, 0), lane_bits)],
                           note='uniform zero predicate')] + tail,
                    1, 1, 'linear-lane-affine', sem.input_bits,
                    sem.output_bits,
                    ['GF(2)-linear neighbour map; %d-bit zero lanes; affine '
                     'publication' % lane_bits])
                if verify(prog, sem, obs):
                    return [prog]
    return []


def _fit_affine_map(inputs, outputs, input_bits, output_bits):
    """Solve all output bits together over GF(2), with free terms set to zero."""
    mask = mask_of(output_bits)
    pivots = {}
    rows = []
    for x, y in zip(inputs, outputs):
        vector = (x & mask_of(input_bits)) | (1 << input_bits)
        rhs = y & mask
        while vector:
            position = vector.bit_length() - 1
            previous = pivots.get(position)
            if previous is None:
                pivots[position] = (vector, rhs)
                rows.append(position)
                break
            vector ^= previous[0]
            rhs ^= previous[1]
        if not vector and rhs:
            return None

    coefficients = [0] * (input_bits + 1)
    for position in sorted(rows):
        vector, rhs = pivots[position]
        lower = vector & ((1 << position) - 1)
        while lower:
            bit = lower & -lower
            rhs ^= coefficients[bit.bit_length() - 1]
            lower ^= bit
        coefficients[position] = rhs & mask
    constant = coefficients[input_bits]
    basis = coefficients[:input_bits]

    def evaluate(value):
        result = constant
        while value:
            bit = value & -value
            index = bit.bit_length() - 1
            if index < input_bits:
                result ^= basis[index]
            value ^= bit
        return result & mask

    if not all(evaluate(x) == (y & mask)
               for x, y in zip(inputs, outputs)):
        return None
    return basis, constant


def solve_arx32(sem, obs, options=None):
    """Infer a two-word add/rotate/xor round and its fixed round key."""
    if sem.input_bits != 64 or sem.output_bits != 64:
        return []
    at_zero = sem.value_at(0)
    key = at_zero & 0xFFFFFFFF
    if at_zero != (key << 32) | key:
        return []
    values = sem.domain.values()
    expected = sem.table()

    def rotate_left(value, shift):
        return ((value << shift) | (value >> (32 - shift))) & 0xFFFFFFFF

    def rotate_right(value, shift):
        return ((value >> shift) | (value << (32 - shift))) & 0xFFFFFFFF

    probes = min(64, len(values))
    for right in range(1, 32):
        for left in range(1, 32):
            def evaluate(state, r=right, l=left):
                x, y = (state >> 32) & 0xFFFFFFFF, state & 0xFFFFFFFF
                x = (rotate_right(x, r) + y) & 0xFFFFFFFF
                x ^= key
                y = rotate_left(y, l) ^ x
                return (x << 32) | y

            if not _agrees(evaluate, values[:probes], expected[:probes],
                           obs, obs.mask):
                continue
            prog = Program(
                [point([('ARX32', key, (right, left))],
                       note='32-bit add/rotate/xor round')],
                1, 1, 'arx32', sem.input_bits, sem.output_bits,
                ['round key and both rotations are forced by the observed '
                 'state transition'])
            if verify(prog, sem, obs):
                return [prog]
    return []


# How many points a scaled fit may see before it has to have pinned its slope.
# Consecutive inputs differ by one, so in practice the second point settles it;
# a run whose base never moves by an odd step is one this family cannot claim.
SCALE_PATIENCE = 16


class _ScaledAffineFit(object):
    """`y = a * base(x) + c` over the integers, modulo the output width.

    `base` is either the word itself or the split's own key.  Both are needed
    and neither subsumes the other: `2.0^x` scales the *word* into an exponent
    field, and `(a + b) mod m` subtracts a constant from the *key* the
    comparison was already made on.

    The slope is not searched.  Two points whose bases differ by an odd number
    determine it, and everything after that is a check — which is why a piece
    of three points cannot be talked into fitting.
    """

    def __init__(self, output_bits, key=None):
        self.mask = mask_of(output_bits)
        self.modulus = self.mask + 1
        self.key = key
        self.base = key.value if key is not None else (lambda x: x)
        self.label = ('integer-affine in the key' if key is not None
                      else 'integer-affine in the word')
        self.anchor = None
        self.slope = None
        self.constant = None
        self.seen = 0
        self.alive = True

    def clone(self):
        copy = _ScaledAffineFit.__new__(_ScaledAffineFit)
        for name in ('mask', 'modulus', 'key', 'base', 'label', 'anchor',
                     'slope', 'constant', 'seen', 'alive'):
            setattr(copy, name, getattr(self, name))
        return copy

    def add(self, x, y):
        if not self.alive:
            return False
        b = self.base(x) & self.mask
        y &= self.mask
        if self.slope is not None:
            self.alive = (self.slope * b + self.constant) & self.mask == y
            return self.alive
        self.seen += 1
        if self.anchor is None:
            self.anchor = (b, y)
            return True
        b0, y0 = self.anchor
        step = (b - b0) & self.mask
        if step & 1:
            inverse = pow(step, -1, self.modulus)
            self.slope = ((y - y0) * inverse) & self.mask
            self.constant = (y0 - self.slope * b0) & self.mask
            return True
        if self.seen >= SCALE_PATIENCE:
            self.alive = False          # nothing here pins a slope
        return self.alive

    @property
    def settled(self):
        return self.alive and self.slope is not None

    def program(self, sem):
        ops = []
        if self.key is not None:
            ops.append(point([('KEY', self.key, None)],
                             note='branch reads %s' % self.key.label))
        if self.slope != 1:
            ops.append(conv('IMUL', self.slope))
        if self.constant:
            ops.append(point([('ADD', self.constant, None)],
                             note='branch, + 0x%X' % self.constant))
        return Program(ops or [identity()], 1, 1, 'split-branch',
                       sem.input_bits, sem.output_bits)


def _fits_for(sem, key):
    return [_Gf2AffineFit(sem.input_bits, sem.output_bits),
            _ScaledAffineFit(sem.output_bits),
            _ScaledAffineFit(sem.output_bits, key)]


def split_keys(input_bits):
    """The keys a split is allowed to compare, in the order they are tried.

    Deliberately a short list.  The word itself, read either way, is every
    case analysis on a value; the difference of two halves is every comparison
    between two arguments packed into one; their sum is every conditional
    subtract.  A key outside this list is a comparison this grammar does not
    claim to find.
    """
    keys = []
    if input_bits <= 61:
        keys.append(field_key(0, input_bits, False))
        keys.append(field_key(0, input_bits, True))
        # The word without its top bit.  A float's case analysis is the same on
        # both halves of the sign, so reading the sign into the key would split
        # every piece in two and answer with eight where there are four.  The
        # branches still see the whole word; only the comparison does not.
        keys.append(field_key(0, input_bits - 1, False))
    if input_bits >= 8 and input_bits % 2 == 0:
        half = input_bits // 2
        for signed in (True, False):
            keys.append(Key([(0, half, signed, 1), (half, half, signed, -1)]))
            keys.append(Key([(half, half, signed, 1), (0, half, signed, -1)]))
        keys.append(Key([(0, half, False, 1), (half, half, False, 1)]))
    return keys


def narrow_keys(input_bits):
    """Fields near the top of the word, for a split the plain keys missed.

    A float's exponent is the case this exists for: the answer depends on a
    field, the field is not the word, and reading the word instead would put a
    piece boundary at every mantissa wrap.
    """
    keys = []
    for width in range(2, 13):
        for top in (input_bits, input_bits - 1):
            shift = top - width
            if shift < 0:
                continue
            keys.append(field_key(shift, width, False))
    return keys


def _pieces(sem, obs, key):
    """Maximal runs, in key order, on which one branch family fits.

    Greedy and left to right, which makes it deterministic; a run is closed the
    moment no family can still explain it, and reopened at the point that broke
    it.  The families are refitted over the closed run afterwards rather than
    carried along, so the walk costs one pass over the domain however many
    pieces come out of it.
    """
    order = sorted(zip((key.value(x) for x in sem.domain.values()),
                       sem.domain.values(), sem.table()))
    groups = []
    for value, x, y in order:
        if groups and groups[-1][0] == value:
            groups[-1][1].append((x, y))
        else:
            groups.append((value, [(x, y)]))

    minimum = 1 if sem.domain.exhaustive else MIN_SAMPLED_PIECE
    pieces = []
    start = 0
    fits = _fits_for(sem, key)
    for index, (_value, points) in enumerate(groups):
        alive = []
        for fit in fits:
            if all(fit.add(x, y) for x, y in points):
                alive.append(fit)
        if alive:
            fits = alive
            continue
        if index == start:
            return None                 # a single key value nothing explains
        pieces.append((start, index))
        if len(pieces) >= MAX_SPLIT_PIECES:
            return None
        start = index
        fits = _fits_for(sem, key)
        for x, y in points:
            for fit in fits:
                fit.add(x, y)
        fits = [fit for fit in fits if fit.alive]
        if not fits:
            return None
    pieces.append((start, len(groups)))

    if len(pieces) < 2 or len(pieces) > MAX_SPLIT_PIECES:
        return None
    if any(sum(len(groups[k][1]) for k in range(a, b)) < minimum
           for a, b in pieces):
        return None
    return groups, pieces


def _piece_program(sem, key, groups, span):
    """Refit the families over one closed run and hand back the cheapest."""
    a, b = span
    fits = _fits_for(sem, key)
    for index in range(a, b):
        for x, y in groups[index][1]:
            for fit in fits:
                fit.add(x, y)
    for fit in fits:
        if fit.settled:
            return fit.program(sem), fit.label
    return None, None


def _split_from_key(sem, obs, key):
    found = _pieces(sem, obs, key)
    if found is None:
        return None
    groups, spans = found

    branches = []
    labels = []
    for span in spans:
        branch, label = _piece_program(sem, key, groups, span)
        if branch is None:
            return None
        branches.append(branch)
        labels.append(label)

    breaks = [groups[a][0] for a, _b in spans[1:]]
    op = split(key, breaks, branches,
               note='%d pieces on %s' % (len(branches), key.label))
    notes = ['key %s, thresholds %s'
             % (key.label, ', '.join(str(t) for t in breaks))]
    if not sem.domain.exhaustive:
        notes.append('the domain is probed, so each threshold is pinned only '
                     'to within the gap between the keys either side of it: '
                     'the smallest key that was seen to behave differently is '
                     'the one reported')
    notes += ['piece %d: %s' % (index, label)
              for index, label in enumerate(labels)]
    prog = Program([op], 1, len(branches), 'split', sem.input_bits,
                   sem.output_bits, notes)
    return prog if verify(prog, sem, obs) else None


def solve_split(sem, obs, options=None):
    """The piecewise family: one comparison per boundary, no branches emitted.

    Every key is tried and the one with the fewest pieces wins, because pieces
    are what a split costs — one comparison and one blend each — and because
    the fewest of them is the one that found the real case analysis rather than
    a coincidence of the ordering.
    """
    if sem.input_bits < 4:
        return []
    candidates = []
    for key in split_keys(sem.input_bits):
        prog = _split_from_key(sem, obs, key)
        if prog is not None:
            candidates.append(prog)
    if not candidates:
        for key in narrow_keys(sem.input_bits):
            prog = _split_from_key(sem, obs, key)
            if prog is not None:
                candidates.append(prog)
                break
    if not candidates:
        return []
    candidates.sort(key=lambda p: len(p.ops[0].detail['branches']))
    return [candidates[0]]


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
    values = sem.table()
    index_bits = sem.input_bits
    while index_bits and values[:1 << (index_bits - 1)] == \
            values[1 << (index_bits - 1):1 << index_bits]:
        index_bits -= 1
        values = values[:1 << index_bits]

    if index_bits < sem.input_bits:
        description = ('%d-entry lookup table selected by the low %d bits; '
                       'the full input domain has %d entries'
                       % (len(values), index_bits, 1 << sem.input_bits))
    else:
        description = ('%d-entry lookup table; correct by construction, and '
                       'ranked last because L(z) counts the table'
                       % len(values))

    prog = Program([table(values, index_bits, sem.output_bits)],
                   1, 1, 'table', sem.input_bits, sem.output_bits,
                   [description])
    return [prog] if verify(prog, sem, obs) else []


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

COMPACT_SOLVERS = (
    solve_identity,
    solve_constant,
    solve_conv_only,
    solve_field_boundary,
    solve_ceil_shift,
    solve_deposit_conv_family,
    solve_support_masked_conv,
    solve_linear,
    solve_gf256_multiply,
    solve_lane_predicate,
    solve_residual_bit_query,
    solve_rank_token_query,
    solve_linear_lane_affine,
    solve_point_gather,
    solve_lane_reduction,
    solve_arx32,
)

# Run only when nothing above answered.  Both walk the domain many times over
# — a chain search re-evaluates the probes for every state it reaches, and a
# split sorts the domain once per candidate key — and neither can beat a
# deposit-and-convolution on a kernel that has one.  Ordering them after the
# closed forms is what keeps a `ranks8` costing milliseconds.
FALLBACK_SOLVERS_ORDER = (
    solve_point_chain,
    solve_field_neq,
    solve_bit_select,
    solve_split,
)

SEARCH_ORDER = COMPACT_SOLVERS + FALLBACK_SOLVERS_ORDER


def solve_all(sem, obs, options=None):
    """Run every solver, returning all verified candidate programs."""
    options = options or {}
    found = []
    for solver in COMPACT_SOLVERS:
        found.extend(solver(sem, obs, options))

    if not found or options.get('always_try_prefilters'):
        found.extend(solve_with_prefilter(
            sem, obs, (solve_deposit_conv_family, solve_linear), options))

    if not found:
        for solver in FALLBACK_SOLVERS_ORDER:
            found.extend(solver(sem, obs, options))
            if found:
                break

    if options.get('allow_table', True):
        found.extend(solve_table(sem, obs, options))

    return found
