"""SPEC §10 / §11 — target ISAs and physical lowering.

A lowered program is an SSA DAG, not a chain, so `span` (critical path) and
`work` (instruction count) are genuinely different numbers instead of two names
for `len(seq)`.

Each semantic class offers several physical representatives; `lower_program`
searches them with the same lexicographic objective used everywhere else:

    span, work, L(z), rank
"""

from . import straightline
from .bits import (M64, bswap64, clmul, lane_masks, mask_of, pdep, pext,
                    popcnt)

# Description-code widths for the L(z) model.  Toy but consistent, and the same
# model ranks every candidate, which is what the objective needs.
OPCODE_BITS = 6
SHIFT_BITS = 6
CONST_BITS = 64

# Stable opcode numbering for the description code.  Order is arbitrary but
# must not change without bumping OBJECTIVE_VERSION, since it decides which of
# two otherwise-tied programs is canonical.
_OPCODE = dict((name, index + 1) for index, name in enumerate([
    'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'IMUL', 'CLMUL', 'AND', 'OR',
    'XOR', 'ADD', 'SUB', 'NOT', 'SHL', 'SHR', 'BSWAP', 'POPCNT', 'XORR',
    'ANDR', 'ORR', 'ADDR', 'ANDNR', 'LUT', 'LOOP8', 'SCANXOR',
]))


class Ins(object):
    """One SSA instruction.  Value 0 is the function input."""

    __slots__ = ('op', 'args', 'const', 'shift')

    def __init__(self, op, args, const=None, shift=None):
        self.op = op
        self.args = tuple(args)
        self.const = const
        self.shift = shift

    def __repr__(self):
        return 'Ins(%s, %r, const=%s, shift=%s)' % (
            self.op, self.args, self.const, self.shift)


class Seq(object):
    """A lowered instruction sequence in SSA form."""

    __slots__ = ('ins', 'result', 'notes', '_steps')

    def __init__(self, ins=None, result=0, notes=None):
        self.ins = list(ins or [])
        self.result = result
        self.notes = list(notes or [])
        self._steps = None

    def emit(self, op, args, const=None, shift=None):
        self.ins.append(Ins(op, args, const, shift))
        self._steps = None
        self.result = len(self.ins)          # values are 1-based after input 0
        return self.result

    def extend(self, other, input_value):
        """Append `other`, remapping its input to `input_value`."""
        base = len(self.ins)
        remap = {0: input_value}
        for k, ins in enumerate(other.ins, start=1):
            remap[k] = base + k
        for ins in other.ins:
            self.ins.append(Ins(ins.op, [remap[a] for a in ins.args],
                                ins.const, ins.shift))
        self._steps = None
        self.result = remap[other.result]
        self.notes.extend(other.notes)
        return self.result

    def __len__(self):
        return len(self.ins)

    # A sequence is data; the compiled function hanging off it is a cache, and
    # a cache does not travel.  Saying so is what lets a result be handed
    # between processes.
    def __getstate__(self):
        return self.ins, self.result, self.notes

    def __setstate__(self, state):
        self.ins, self.result, self.notes = state
        self._steps = None


# ---------------------------------------------------------------------------
# Interpretation of a lowered sequence
#
# Verifying one target over a 2^16 domain is 65,536 evaluations of the same
# five instructions, and every candidate on every target pays it again.  Doing
# that by walking `ins` and testing the opcode makes the opcode test the
# dominant cost of the whole pipeline.  The decision is identical on every
# input, so the sequence is written out as one Python function instead, once,
# and the sweep calls that.
#
# There is one implementation, not a fast path beside a reference one — `run`
# calls the same compiled function — so the two cannot disagree.
# ---------------------------------------------------------------------------

# `v0` is the input; `v1..` are the SSA values, in order.  Every line is masked
# to 64 bits, so no expression has to remember to do it and none can forget.
_EXPR = {
    'PDEP': 'pdep(v{a}, {k})',
    'PEXT': 'pext(v{a}, {k})',
    'PEXT_DYN': 'pext({k}, v{a})',
    'PDEP_DYN': 'pdep({k}, v{a})',
    'IMUL': 'v{a} * {k}',
    'CLMUL': 'clmul(v{a}, {k}, 64)',
    'AND': 'v{a} & {k}',
    'OR': 'v{a} | {k}',
    'XOR': 'v{a} ^ {k}',
    'ADD': 'v{a} + {k}',
    'SUB': 'v{a} - {k}',
    'NOT': '~v{a}',
    'SHL': 'v{a} << {n}',
    'SHR': 'v{a} >> {n}',
    'BSWAP': 'bswap64(v{a})',
    'POPCNT': 'popcnt(v{a})',
    'XORR': 'v{a} ^ v{b}',
    'ANDR': 'v{a} & v{b}',
    'ORR': 'v{a} | v{b}',
    'ADDR': 'v{a} + v{b}',
    'ANDNR': '~v{a} & v{b}',
    'LOOP8': 'pext({k}, v{a})',
    'SCANXOR': 'v{a} ^ (v{a} << {n})',
}

_ENV = {'M': M64, 'pdep': pdep, 'pext': pext, 'clmul': clmul,
        'popcnt': popcnt, 'bswap64': bswap64}


def _expression(ins, tables):
    """The right-hand side for one instruction, as source text."""
    a = ins.args[0] if ins.args else 0
    b = ins.args[1] if len(ins.args) > 1 else 0
    if ins.op == 'LUT':
        # A lookup table is data, not text: it goes into the environment under
        # a generated name and the source refers to it.
        key = 'lut%d' % len(tables)
        tables[key] = ins.const
        return '%s[v%d & %d]' % (key, a, len(ins.const) - 1)
    form = _EXPR.get(ins.op)
    if form is None:
        raise ValueError('unknown instruction %r' % ins.op)
    return form.format(a=a, b=b, k=ins.const, n=ins.shift)


def _build(seq):
    tables = {}
    body = [('v%d' % k, '(%s) & M' % _expression(ins, tables))
            for k, ins in enumerate(seq.ins, start=1)]
    env = dict(_ENV, **tables)
    return straightline.build('qm_seq', ['x'], [('v0', 'x & M')] + body,
                              'v%d' % seq.result, env)


def compile_seq(seq):
    """A callable `x -> y` for `seq`, compiled once and cached on it.

    Use this for a domain sweep; `run` is the same function for a single input.
    """
    compiled = seq._steps
    if compiled is None or compiled[0] != (len(seq.ins), seq.result):
        compiled = seq._steps = ((len(seq.ins), seq.result), _build(seq))
    return compiled[1]


def run(seq, x):
    return compile_seq(seq)(x)


def matches(seq, sem, obs):
    """(agreeing points, domain size) for `seq` against `sem` under `obs`.

    Every observer that declares a `mask` is `y & mask` and nothing else, so
    the comparison becomes two integer ands instead of two calls — worth
    saying out loud because it is 2 * 65,536 calls per target otherwise.
    """
    evaluate = compile_seq(seq)
    values = sem.domain.values()
    expected = sem.table()
    m = obs.mask
    if m is None:
        matched = sum(1 for x, y in zip(values, expected)
                      if obs(evaluate(x)) == obs(y))
    else:
        matched = sum(1 for x, y in zip(values, expected)
                      if evaluate(x) & m == y & m)
    return matched, len(values)


def agrees(seq, sem, obs):
    """True when `seq` reproduces `sem` on every point of its domain."""
    evaluate = compile_seq(seq)
    expected = sem.table()
    m = obs.mask
    if m is None:
        return all(obs(evaluate(x)) == obs(y)
                   for x, y in zip(sem.domain.values(), expected))
    return all(evaluate(x) & m == y & m
               for x, y in zip(sem.domain.values(), expected))


# ---------------------------------------------------------------------------
# Measurement: SPEC §8 objective (span, work, L(z), rank)
# ---------------------------------------------------------------------------

def _elias_len(n):
    return 1 if n == 0 else 2 * (n.bit_length() - 1) + 2


def measure(seq):
    """(span, work, L, rank) for a lowered sequence."""
    depth = [0]
    for ins in seq.ins:
        d = max((depth[a] for a in ins.args), default=0) + 1
        depth.append(d)

    span = depth[seq.result]
    work = len(seq.ins)

    # The description code is accumulated as bytes, not as one integer.  A
    # 2^16-entry lookup table encodes to ~4 million bits, and materializing
    # `1 << bits` for it costs more than the entire rest of the pipeline.
    # Lexicographic comparison of the encoding is the canonical order anyway.
    bits = 0
    code = bytearray()
    for ins in seq.ins:
        bits += OPCODE_BITS
        code.append(_OPCODE.get(ins.op, 0))
        if ins.const is not None:
            constants = (ins.const if isinstance(ins.const, (list, tuple))
                         else (ins.const,))
            bits += CONST_BITS * len(constants)
            for entry in constants:
                code += int(entry).to_bytes(8, 'big')
        if ins.shift is not None:
            bits += SHIFT_BITS
            code.append(ins.shift & 0xFF)

    return span, work, _elias_len(bits) + bits, bytes(code)


def objective_key(seq):
    return measure(seq)


# ---------------------------------------------------------------------------
# ISA profiles
# ---------------------------------------------------------------------------

class ISA(object):
    __slots__ = ('name', 'title', 'features', 'note')

    def __init__(self, name, title, features, note=''):
        self.name = name
        self.title = title
        self.features = set(features)
        self.note = note

    def has(self, feature):
        return feature in self.features

    def to_dict(self):
        return {'name': self.name, 'title': self.title,
                'features': sorted(self.features), 'note': self.note}


BASE = {'alu', 'imul', 'shift', 'bswap', 'lut'}

PROFILES = [
    ISA('x86-64', 'x86-64 baseline', BASE | {'popcnt_none'},
        'integer ALU, IMUL, shifts; no BMI2, no PCLMUL'),
    ISA('x86-64-bmi2', 'x86-64 + BMI2', BASE | {'pdep', 'pext', 'popcnt'},
        'adds PDEP/PEXT'),
    ISA('x86-64-bmi2-pclmul', 'x86-64 + BMI2 + PCLMUL',
        BASE | {'pdep', 'pext', 'popcnt', 'clmul'},
        'adds carry-less multiply'),
    ISA('x86-64-v3', 'x86-64-v3 (AVX2)',
        BASE | {'pdep', 'pext', 'popcnt', 'clmul', 'avx2'},
        'BMI2 + PCLMUL + AVX2 feature level'),
    ISA('portable', 'portable scalar', BASE,
        'C without intrinsics: no PDEP/PEXT/CLMUL'),
    # wasm32 has i64 arithmetic, shifts, rotates and popcount, and nothing
    # else on this list: no deposit/extract, no carry-less multiply, and no
    # byte swap instruction.
    ISA('wasm32', 'wasm32 (i64 only)', {'alu', 'imul', 'shift', 'lut', 'popcnt', 'rotate'},
        'WebAssembly: i64 arithmetic and shifts only'),
]

PROFILE_BY_NAME = dict((p.name, p) for p in PROFILES)
DEFAULT_PROFILES = ['x86-64-bmi2-pclmul', 'x86-64-bmi2', 'x86-64', 'wasm32',
                    'portable']


def get_isa(name):
    if name not in PROFILE_BY_NAME:
        raise KeyError('unknown ISA profile %r (have: %s)'
                       % (name, ', '.join(sorted(PROFILE_BY_NAME))))
    return PROFILE_BY_NAME[name]


# ---------------------------------------------------------------------------
# Physical representatives per semantic class
# ---------------------------------------------------------------------------

def _lin_pdep_mask(basis):
    """PDEP mask when the basis images are strictly increasing one-hot bits."""
    positions = []
    tail_zero = False
    for image in basis:
        if image == 0:
            tail_zero = True
            continue
        if tail_zero or (image & (image - 1)):
            return None
        p = image.bit_length() - 1
        if positions and p <= positions[-1]:
            return None
        positions.append(p)
    if not positions:
        return None
    return sum(1 << p for p in positions)


def _lin_pext_mask(basis):
    """PEXT mask when the images are one-hot at output bits 0,1,2,..."""
    selected = []
    next_out = 0
    for i, image in enumerate(basis):
        if image == 0:
            continue
        if image != (1 << next_out):
            return None
        selected.append(i)
        next_out += 1
    if not selected:
        return None
    return sum(1 << i for i in selected)


def _lin_toeplitz_const(basis):
    """Constant M with basis[i] == M << i — a convolution by a constant."""
    if not basis or basis[0] == 0:
        return None
    m = basis[0]
    for i, image in enumerate(basis):
        if image != ((m << i) & M64):
            return None
    return m


def _lin_select_shift_conv(basis, input_bits):
    """Is this map "keep some bits, slide them down, convolve"?

    Every spread consumer in a bit-lane library is written that way: `(s >> 7)
    * K` reads one flag out of each byte lane and fans it back out.  As a
    linear map that is not a convolution — the six dead bits between the flags
    break the Toeplitz condition — so without this it decomposes into a
    twenty-instruction XOR network, which describes the lowering table rather
    than the map.

    Returns (mask, shift, const), where `mask` is None when no bits need
    clearing.  Masking first is what makes the multiply exact rather than
    merely exact on the inputs that happen to be probed: the positions the
    convolution would fill wrongly are the positions the mask has zeroed.
    """
    width = min(input_bits, len(basis))
    support = [i for i in range(width) if basis[i]]
    if len(support) < 2:
        return None                 # a single bit is a shift, already covered
    lead = support[0]
    const = basis[lead]
    for i in support:
        if basis[i] != ((const << (i - lead)) & M64):
            return None
    contiguous = support == list(range(lead, lead + len(support)))
    if lead == 0 and contiguous and len(support) == width:
        return None                 # a plain convolution; already offered above
    # The mask is unnecessary only when every input bit above the shift is one
    # the convolution fills correctly; the shift discards the ones below it.
    mask = None if (contiguous and width == input_bits
                    and support[-1] == width - 1) \
        else sum(1 << i for i in support)
    return mask, lead, const


def _lin_shift_terms(basis, input_bits):
    """Decompose a GF(2)-linear map into XOR of ((x & mask) shifted by s).

    Every GF(2)-linear map has such a decomposition: bit j of the output takes a
    contribution from input bit i exactly when basis[i] has bit j set, and the
    pair (i, j) belongs to the shift s = j - i.  The number of distinct shifts
    is the width of the resulting XOR network.
    """
    terms = {}
    for i, image in enumerate(basis[:input_bits]):
        j = 0
        img = image
        while img:
            if img & 1:
                terms.setdefault(j - i, 0)
                terms[j - i] |= 1 << i
            img >>= 1
            j += 1
    return sorted(terms.items(), key=lambda kv: (-bin(kv[1]).count('1'), kv[0]))


def _seq_shift_network(terms):
    """Emit XOR_s ((x & mask_s) << s) as an SSA balanced XOR tree."""
    seq = Seq()
    partials = []
    for shift, mask in terms:
        # A full-width mask is a no-op: every value in `run` is already 64-bit.
        v = 0 if mask == M64 else seq.emit('AND', [0], const=mask)
        if shift > 0:
            v = seq.emit('SHL', [v], shift=shift)
        elif shift < 0:
            v = seq.emit('SHR', [v], shift=-shift)
        partials.append(v)
    if not partials:
        seq.emit('AND', [0], const=0)
        return seq
    # Balanced tree keeps the span logarithmic instead of linear.
    while len(partials) > 1:
        nxt = []
        for k in range(0, len(partials) - 1, 2):
            nxt.append(seq.emit('XORR', [partials[k], partials[k + 1]]))
        if len(partials) % 2:
            nxt.append(partials[-1])
        partials = nxt
    seq.result = partials[0]
    return seq


def lower_lin_const(op, isa):
    """All physical representatives of a constant GF(2)-linear map on `isa`."""
    basis = op.detail['basis']
    input_bits = op.detail['input_bits']
    out = []

    if isa.has('pdep'):
        mask = _lin_pdep_mask(basis)
        if mask is not None:
            s = Seq()
            s.emit('PDEP', [0], const=mask)
            out.append(('PDEP', s))

    if isa.has('pext'):
        mask = _lin_pext_mask(basis)
        if mask is not None:
            s = Seq()
            s.emit('PEXT', [0], const=mask)
            out.append(('PEXT', s))

    const = _lin_toeplitz_const(basis)
    if const is not None:
        if isa.has('clmul'):
            s = Seq()
            s.emit('CLMUL', [0], const=const)
            out.append(('CLMUL', s))
        # An IMUL is a valid representative only when no carry is generated;
        # the caller verifies over the domain, so offer it as a candidate.
        s = Seq()
        s.emit('IMUL', [0], const=const)
        out.append(('IMUL', s))

    selected = _lin_select_shift_conv(basis, input_bits)
    if selected is not None:
        mask, lead, const = selected
        for family, label in (('CLMUL', 'mask + shift + CLMUL'),
                              ('IMUL', 'mask + shift + IMUL')):
            if family == 'CLMUL' and not isa.has('clmul'):
                continue
            s = Seq()
            v = 0
            if mask is not None:
                v = s.emit('AND', [v], const=mask)
            if lead:
                v = s.emit('SHR', [v], shift=lead)
            s.emit(family, [v], const=const)
            out.append((label, s))

    if isa.has('bswap'):
        spread = _seq_byte_spread(basis, input_bits)
        if spread is not None:
            out.append(('multiply/mask/bswap spread', spread))

    terms = _lin_shift_terms(basis, input_bits)
    if terms and len(terms) <= 24:
        out.append(('shift/XOR network', _seq_shift_network(terms)))

    return out


def _seq_byte_spread(basis, input_bits):
    """Portable representative of "one input bit per byte lane".

    The BMI2-free way to compute PDEP(x, 0x0101..01): one multiply gathers the
    bits into the high bit of each byte, BSWAP puts them back in order.  This
    exists so that LIN_CONST does not silently become "PDEP or nothing" on a
    target without BMI2.
    """
    if input_bits > 8:
        return None
    if any(image != (1 << (8 * i)) for i, image in enumerate(basis[:input_bits])):
        return None
    seq = Seq()
    v = seq.emit('IMUL', [0], const=0x8040201008040201)
    v = seq.emit('AND', [v], const=0x8080808080808080)
    v = seq.emit('BSWAP', [v])
    seq.emit('SHR', [v], shift=7)
    return seq


def lower_conv(op, isa):
    family = op.detail['family']
    const = op.detail['const']
    out = []
    if family == 'IMUL':
        s = Seq()
        s.emit('IMUL', [0], const=const)
        out.append(('IMUL', s))
    elif family == 'CLMUL':
        if isa.has('clmul'):
            s = Seq()
            s.emit('CLMUL', [0], const=const)
            out.append(('PCLMULQDQ', s))
        if const == M64:
            # Multiplication by the all-ones kernel is exactly a prefix XOR
            # scan, which every ISA can do with six shift/XOR steps.
            s = Seq()
            v = 0
            for k in range(6):
                v = s.emit('SCANXOR', [v], shift=1 << k)
            out.append(('shift/XOR scan', s))
        else:
            # A carry-less product by a constant is GF(2)-linear, so it is an
            # XOR of shifts.  Without this, CONV(CLMUL) would look impossible
            # on any target without PCLMUL, which is a statement about the
            # lowering table rather than about the semantics.
            shifts = [i for i in range(64) if (const >> i) & 1]
            if shifts:
                out.append(('shift/XOR fold', _seq_shift_network(
                    [(i, M64) for i in shifts])))
    return out


def lower_perm_dyn(op, isa):
    source = op.detail['source']
    gather = op.detail['direction'] == 'gather'
    out = []
    if gather and isa.has('pext'):
        s = Seq()
        s.emit('PEXT_DYN', [0], const=source)
        out.append(('PEXT', s))
    if not gather and isa.has('pdep'):
        s = Seq()
        s.emit('PDEP_DYN', [0], const=source)
        out.append(('PDEP', s))
    if not out:
        # Portable fallback: an 8-step loop, modelled as its own primitive so
        # the cost model does not pretend it is free.
        s = Seq()
        s.emit('LOOP8', [0], const=source)
        out.append(('software loop', s))
    return out


def _lane_interval_seq(seq, v, bounds, lane_bits):
    """`lo <= lane <= hi` on every lane, branch-free, as `examples/lanecode.h`.

    Three physical forms for one semantic step, picked by the shape of the
    interval: a point is an equality test, an interval starting at zero is a
    one-sided compare, and anything else needs both bounds. The abstract
    program says only which interval; which of these computes it is a lowering
    decision, the same way LIN_CONST does not mean PDEP.

    Nothing here is a new primitive. Each form expands to AND/ADD/SUB/OR/XOR/
    NOT over whole registers, which every target in this file already has — the
    lane structure lives in the constants, not in the instruction set.

    These are fused rather than a chain of POINT steps because each of them
    uses its input twice, and a step list has no way to say "and also the value
    before this one".
    """
    lo, hi = bounds
    ones, low, high = lane_masks(lane_bits)

    if lo == hi:
        # lane == c.  `(t & low) + low` carries into a lane's top bit exactly
        # when the rest of that lane is nonzero, so OR-ing the value back in
        # and complementing leaves the top bit set only for an all-zero lane —
        # and the lane is zero exactly where the input equalled c.
        t = seq.emit('XOR', [v], const=(lo * ones) & M64) if lo else v
        a = seq.emit('AND', [t], const=low)
        a = seq.emit('ADD', [a], const=low)
        a = seq.emit('ORR', [a, t])
        a = seq.emit('NOT', [a])
        return seq.emit('AND', [a], const=high)

    if lo == 0:
        # lane < hi+1, unsigned.  Setting every top bit before subtracting the
        # low part of the bound stops a borrow from leaving its lane; what is
        # left is a small Boolean function of the three top bits.
        c = ((hi + 1) * ones) & M64
        h = seq.emit('OR', [v], const=high)
        z = seq.emit('SUB', [h], const=c & low)
        u = seq.emit('XORR', [v, z])
        e = seq.emit('XOR', [v], const=c)
        a = seq.emit('ANDNR', [e, u])
        a = seq.emit('XORR', [v, a])
        a = seq.emit('NOT', [a])
        return seq.emit('AND', [a], const=high)

    # Both bounds at once.  `hi` below the lane's top bit is what keeps the
    # second subtraction inside its lane; the solver does not offer an interval
    # that reaches past it, and `verify` would reject one anyway.
    h = seq.emit('OR', [v], const=high)
    z1 = seq.emit('SUB', [h], const=(lo * ones) & M64)
    xl = seq.emit('AND', [v], const=low)
    # `K - xl` with no reverse-subtract in the grammar: ~xl + (K + 1).
    n = seq.emit('NOT', [xl])
    z2 = seq.emit('ADD', [n], const=(((hi * ones) | high) + 1) & M64)
    g = seq.emit('ANDR', [z1, z2])
    a = seq.emit('ANDNR', [v, g])
    return seq.emit('AND', [a], const=high)


def lower_point(op, isa):
    seq = Seq()
    v = 0
    for mnemonic, const, shift in op.detail['steps']:
        if mnemonic == 'LANE_INTERVAL':
            v = _lane_interval_seq(seq, v, const, shift)
        elif mnemonic == 'ANDN_PREV_SHL':
            shifted = seq.emit('SHL', [v], shift=shift)
            v = seq.emit('ANDNR', [shifted, v])
        elif mnemonic == 'ANDN_PREV_SHR':
            shifted = seq.emit('SHR', [v], shift=shift)
            v = seq.emit('ANDNR', [shifted, v])
        elif mnemonic == 'XOR_SHL':
            shifted = seq.emit('SHL', [v], shift=shift)
            v = seq.emit('XORR', [shifted, v])
        elif mnemonic in ('SHL', 'SHR'):
            v = seq.emit(mnemonic, [v], shift=shift)
        elif mnemonic == 'NOT':
            v = seq.emit('NOT', [v])
        elif mnemonic == 'BSWAP':
            v = seq.emit('BSWAP', [v])
        elif mnemonic == 'POPCNT':
            v = seq.emit('POPCNT', [v])
        else:
            v = seq.emit(mnemonic, [v], const=const)
    seq.result = v
    return [('POINT', seq)]


def lower_table(op, isa):
    s = Seq()
    s.emit('LUT', [0], const=tuple(op.detail['table']))
    return [('lookup table', s)]


def lower_identity(op, isa):
    return [('identity', Seq())]


LOWERERS = {
    'LIN_CONST': lower_lin_const,
    'CONV': lower_conv,
    'PERM_DYN': lower_perm_dyn,
    'POINT': lower_point,
    'TABLE': lower_table,
    'IDENTITY': lower_identity,
}


class LoweringFailure(Exception):
    def __init__(self, op, isa):
        Exception.__init__(self, 'no representative of %s on %s'
                           % (op.label, isa.title))
        self.op = op
        self.isa = isa


def lower_program(program, isa, verify_against=None):
    """Lower every abstract op, choosing the best representative per op.

    `verify_against` is an optional (semantics, observer) pair.  When given, a
    candidate whose composition fails on the domain is discarded instead of
    ranked, which is what keeps IMUL from being offered where carry escapes.
    """
    chosen = []
    seq = Seq()
    current = 0

    for op in program.ops:
        options = LOWERERS[op.kind](op, isa)
        if not options:
            raise LoweringFailure(op, isa)
        options = sorted(options, key=lambda pair: objective_key(pair[1]))
        chosen.append((op, options))

    # Independent per-op choices: try the cheapest combination first, then fall
    # back one op at a time if verification rejects it.
    picks = [0] * len(chosen)
    for attempt in range(1 + sum(len(o) for _, o in chosen)):
        seq = Seq()
        current = 0
        used = []
        for (op, options), index in zip(chosen, picks):
            name, sub = options[index]
            current = seq.extend(sub, current)
            used.append((op, name))
        seq.result = current

        if verify_against is None:
            return seq, used
        sem, obs = verify_against
        if agrees(seq, sem, obs):
            return seq, used

        # Advance the first op that still has an untried representative.
        for k in range(len(picks)):
            if picks[k] + 1 < len(chosen[k][1]):
                picks[k] += 1
                break
            picks[k] = 0
        else:
            break

    raise LoweringFailure(program.ops[0] if program.ops else None, isa)


# ---------------------------------------------------------------------------
# Emission
# ---------------------------------------------------------------------------

C_FORMS = {
    'PDEP': lambda a, ins: '_pdep_u64(%s, 0x%016Xull)' % (a[0], ins.const),
    'PEXT': lambda a, ins: '_pext_u64(%s, 0x%016Xull)' % (a[0], ins.const),
    'PEXT_DYN': lambda a, ins: '_pext_u64(0x%016Xull, %s)' % (ins.const, a[0]),
    'PDEP_DYN': lambda a, ins: '_pdep_u64(0x%016Xull, %s)' % (ins.const, a[0]),
    'IMUL': lambda a, ins: '%s * 0x%016Xull' % (a[0], ins.const),
    'CLMUL': lambda a, ins: 'qm_clmul64(%s, 0x%016Xull)' % (a[0], ins.const),
    'AND': lambda a, ins: '%s & 0x%016Xull' % (a[0], ins.const),
    'OR': lambda a, ins: '%s | 0x%016Xull' % (a[0], ins.const),
    'XOR': lambda a, ins: '%s ^ 0x%016Xull' % (a[0], ins.const),
    'ADD': lambda a, ins: '%s + 0x%016Xull' % (a[0], ins.const),
    'SUB': lambda a, ins: '%s - 0x%016Xull' % (a[0], ins.const),
    'NOT': lambda a, ins: '~%s' % a[0],
    'SHL': lambda a, ins: '%s << %d' % (a[0], ins.shift),
    'SHR': lambda a, ins: '%s >> %d' % (a[0], ins.shift),
    'BSWAP': lambda a, ins: '__builtin_bswap64(%s)' % a[0],
    'POPCNT': lambda a, ins: '(uint64_t)__builtin_popcountll(%s)' % a[0],
    'XORR': lambda a, ins: '%s ^ %s' % (a[0], a[1]),
    'ANDR': lambda a, ins: '%s & %s' % (a[0], a[1]),
    'ORR': lambda a, ins: '%s | %s' % (a[0], a[1]),
    'ADDR': lambda a, ins: '%s + %s' % (a[0], a[1]),
    'ANDNR': lambda a, ins: '~%s & %s' % (a[0], a[1]),
    'SCANXOR': lambda a, ins: '%s ^ (%s << %d)' % (a[0], a[0], ins.shift),
    'LOOP8': lambda a, ins: 'qm_gather_loop(0x%016Xull, %s)' % (ins.const, a[0]),
    'LUT': lambda a, ins: 'qm_lut[%s]' % a[0],
}

NEEDS_BMI2 = {'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN'}
NEEDS_PCLMUL = {'CLMUL'}


def emit_c(seq, name, input_ctype='uint8_t', output_ctype='uint64_t'):
    """Emit a self-contained C function for a lowered sequence."""
    uses = set(ins.op for ins in seq.ins)
    lines = ['#include <stdint.h>']
    if uses & (NEEDS_BMI2 | NEEDS_PCLMUL):
        lines.append('#include <immintrin.h>')
    lines.append('')

    if uses & NEEDS_PCLMUL:
        lines += [
            'static inline uint64_t qm_clmul64(uint64_t a, uint64_t b)',
            '{',
            '    __m128i r = _mm_clmulepi64_si128(_mm_cvtsi64_si128((long long)a),',
            '                                     _mm_cvtsi64_si128((long long)b), 0x00);',
            '    return (uint64_t)_mm_cvtsi128_si64(r);',
            '}',
            '',
        ]
    if 'LOOP8' in uses:
        lines += [
            'static inline uint64_t qm_gather_loop(uint64_t src, uint64_t mask)',
            '{',
            '    uint64_t r = 0;',
            '    for (unsigned i = 0, j = 0; i < 64; ++i)',
            '        if ((mask >> i) & 1u)',
            '            r |= ((src >> i) & 1ull) << j++;',
            '    return r;',
            '}',
            '',
        ]
    for ins in seq.ins:
        if ins.op == 'LUT':
            entries = ', '.join('0x%016XULL' % v for v in ins.const)
            lines += ['static const uint64_t qm_lut[%d] = { %s };'
                      % (len(ins.const), entries), '']
            break

    lines.append('%s %s(%s x)' % (output_ctype, name, input_ctype))
    lines.append('{')
    names = ['(uint64_t)x']
    for k, ins in enumerate(seq.ins, start=1):
        args = [names[a] for a in ins.args]
        expr = C_FORMS[ins.op](args, ins)
        lines.append('    uint64_t t%d = %s;' % (k, expr))
        names.append('t%d' % k)
    lines.append('    return (%s)%s;' % (output_ctype, names[seq.result]))
    lines.append('}')
    return '\n'.join(lines)


# %r11 is reserved as the constant scratch, %rdi holds the incoming argument.
_ASM_POOL = ['%rax', '%rcx', '%rdx', '%rsi', '%r8', '%r9', '%r10']
_ASM_SCRATCH = '%r11'

_ASM_RR = {'XORR': 'xorq', 'ANDR': 'andq', 'ORR': 'orq', 'ADDR': 'addq'}
_ASM_RI = {'AND': 'andq', 'OR': 'orq', 'XOR': 'xorq', 'ADD': 'addq',
           'SUB': 'subq'}


def emit_asm(seq, name, input_bits=None):
    """Emit AT&T x86-64 assembly (SysV: argument in %rdi, result in %rax).

    Returns None when the sequence contains something this small emitter does
    not encode, or needs more live values than the register pool holds — a
    listing that does not assemble would be worse than no listing.
    """
    unsupported = {'LUT', 'LOOP8', 'POPCNT', 'SCANXOR'}
    if any(ins.op in unsupported for ins in seq.ins):
        return None

    last_use = {0: 0}
    for k, ins in enumerate(seq.ins, start=1):
        for a in ins.args:
            last_use[a] = k
    last_use[seq.result] = len(seq.ins) + 1

    free = list(_ASM_POOL)
    reg = {0: '%rdi'}
    body = []
    uses_xmm = False

    def load_const(value, target):
        body.append('    movabsq $0x%X, %s' % (value, target))

    for k, ins in enumerate(seq.ins, start=1):
        src = [reg[a] for a in ins.args]

        # Free registers whose last use is this instruction, before allocating.
        for a in ins.args:
            r = reg.get(a)
            if r and r != '%rdi' and last_use.get(a, 0) <= k and r not in free:
                free.append(r)
        if not free:
            return None
        dst = free.pop(0)
        reg[k] = dst

        if ins.op == 'IMUL':
            load_const(ins.const, dst)
            body.append('    imulq %s, %s' % (src[0], dst))
        elif ins.op in ('PDEP', 'PEXT'):
            load_const(ins.const, _ASM_SCRATCH)
            # AT&T reverses Intel's operand order:
            #   Intel  PDEP dst, src, mask
            #   AT&T   pdep mask, src, dst
            body.append('    %s %s, %s, %s'
                        % (ins.op.lower(), _ASM_SCRATCH, src[0], dst))
        elif ins.op in ('PEXT_DYN', 'PDEP_DYN'):
            load_const(ins.const, _ASM_SCRATCH)
            mnemonic = 'pext' if ins.op == 'PEXT_DYN' else 'pdep'
            body.append('    %s %s, %s, %s'
                        % (mnemonic, src[0], _ASM_SCRATCH, dst))
        elif ins.op == 'CLMUL':
            uses_xmm = True
            load_const(ins.const, _ASM_SCRATCH)
            body.append('    movq %s, %%xmm0' % src[0])
            body.append('    movq %s, %%xmm1' % _ASM_SCRATCH)
            body.append('    pclmulqdq $0x00, %xmm1, %xmm0')
            body.append('    movq %%xmm0, %s' % dst)
        elif ins.op in _ASM_RI:
            load_const(ins.const, _ASM_SCRATCH)
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    %s %s, %s' % (_ASM_RI[ins.op], _ASM_SCRATCH, dst))
        elif ins.op == 'NOT':
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    notq %s' % dst)
        elif ins.op == 'ANDNR':
            # BMI1 has ANDN, but its operand order is the easiest thing in this
            # emitter to get silently backwards; NOT+AND is one instruction
            # longer and assembles the same everywhere.
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    notq %s' % dst)
            body.append('    andq %s, %s' % (src[1], dst))
        elif ins.op in ('SHL', 'SHR'):
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    %s $%d, %s'
                        % ('shlq' if ins.op == 'SHL' else 'shrq', ins.shift, dst))
        elif ins.op == 'BSWAP':
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    bswapq %s' % dst)
        elif ins.op in _ASM_RR:
            body.append('    movq %s, %s' % (src[0], dst))
            body.append('    %s %s, %s' % (_ASM_RR[ins.op], src[1], dst))
        else:
            return None

    header = ['    .text', '    .globl %s' % name,
              '    .type %s, @function' % name]
    if input_bits:
        # A listing does not say how wide its input is; %rdi is 64 bits whatever
        # the kernel meant. Recording it keeps a round trip through assembly on
        # the same domain it started from.
        header.insert(0, '    # qm-input-bits: %d' % input_bits)
    header.append('%s:' % name)
    if uses_xmm:
        header.insert(0, '    # requires PCLMUL')
    tail = []
    if reg[seq.result] != '%rax':
        tail.append('    movq %s, %%rax' % reg[seq.result])
    tail += ['    ret',
             '    .size %s, .-%s' % (name, name),
             '    .section .note.GNU-stack,"",@progbits']
    return '\n'.join(header + body + tail) + '\n'


# ---------------------------------------------------------------------------
# WebAssembly emission
# ---------------------------------------------------------------------------

# Every value becomes a local, and every instruction is on its own line.  A
# folded s-expression would be shorter to read and harder to read *back*, and
# reading its own output is what lets QM be idempotent on wasm.
_WASM_BINOP = {
    'IMUL': 'i64.mul', 'AND': 'i64.and', 'OR': 'i64.or', 'XOR': 'i64.xor',
    'ADD': 'i64.add', 'SUB': 'i64.sub', 'SHL': 'i64.shl', 'SHR': 'i64.shr_u',
}
_WASM_RR = {'XORR': 'i64.xor', 'ANDR': 'i64.and', 'ORR': 'i64.or',
            'ADDR': 'i64.add'}


def emit_wasm(seq, name, input_bits=None):
    """Emit a wasm32 function in the text format.

    Returns None when the sequence uses something wasm has no instruction for
    — a deposit, a carry-less multiply, a lookup table — rather than inventing
    an encoding for it.
    """
    unsupported = {'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'CLMUL', 'LUT',
                   'LOOP8', 'BSWAP'}
    if any(ins.op in unsupported for ins in seq.ins):
        return None

    body = []
    for index, ins in enumerate(seq.ins, start=1):
        op = ins.op
        if op in _WASM_BINOP:
            body.append('    local.get %d' % ins.args[0])
            value = ins.shift if ins.shift is not None else ins.const
            body.append('    i64.const 0x%X' % (value & M64))
            body.append('    ' + _WASM_BINOP[op])
        elif op in _WASM_RR:
            body.append('    local.get %d' % ins.args[0])
            body.append('    local.get %d' % ins.args[1])
            body.append('    ' + _WASM_RR[op])
        elif op == 'NOT':
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.const -1')
            body.append('    i64.xor')
        elif op == 'ANDNR':
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.const -1')
            body.append('    i64.xor')
            body.append('    local.get %d' % ins.args[1])
            body.append('    i64.and')
        elif op == 'POPCNT':
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.popcnt')
        elif op == 'SCANXOR':
            body.append('    local.get %d' % ins.args[0])
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.const 0x%X' % ins.shift)
            body.append('    i64.shl')
            body.append('    i64.xor')
        else:
            return None
        body.append('    local.set %d' % index)

    locals_count = len(seq.ins)
    lines = []
    if input_bits:
        lines.append(';; qm-input-bits: %d' % input_bits)
    lines += ['(module',
             '  (func $%s (export "%s") (param i64) (result i64)' % (name, name)]
    if locals_count:
        lines.append('    (local%s)' % (' i64' * locals_count))
    lines.extend(body)
    lines.append('    local.get %d' % seq.result)
    lines.append('  )')
    lines.append(')')
    return '\n'.join(lines) + '\n'


def instruction_names(seq):
    return [ins.op for ins in seq.ins]
