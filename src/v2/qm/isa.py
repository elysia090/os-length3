"""Target ISAs, exact normalization, and physical lowering.

A lowered program is an SSA DAG, not a chain, so `span` (critical path) and
`work` (instruction count) are genuinely different numbers instead of two names
for `len(seq)`.

Each semantic class offers several physical representatives; `lower_program`
searches them with the same lexicographic objective used everywhere else:

    span, work, L(z), rank
"""

from . import straightline
from .bits import (M64, bswap64, clmul, clz, ctz, lane_masks, mask_of, pdep,
                    pext, popcnt, sar)

# Description-code widths for the L(z) model.  Toy but consistent, and the same
# model ranks every candidate, which is what the objective needs.
OPCODE_BITS = 6
SHIFT_BITS = 6
CONST_BITS = 64

# Stable opcode numbering for the description code.  Order is arbitrary but
# must not change without bumping OBJECTIVE_VERSION, since it decides which of
# two otherwise-tied programs is canonical.
OPCODES = (
    'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'IMUL', 'CLMUL', 'AND', 'OR',
    'XOR', 'ADD', 'SUB', 'NOT', 'SHL', 'SHR', 'BSWAP', 'POPCNT', 'XORR',
    'ANDR', 'ORR', 'ADDR', 'ANDNR', 'LUT', 'LOOP8', 'SCANXOR',
    # Appended, never inserted: an existing opcode's number is part of the
    # canonical rank, so moving one would silently rewrite which of two tied
    # programs is the answer.
    'SAR', 'NEG', 'SUBR', 'CLZ', 'CTZ',
    'CLMULR', 'ROL32', 'ROR32',
    'SHRR', 'GT_U',
)
_OPCODE = dict((name, index + 1) for index, name in enumerate(OPCODES))


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
    'CLMULR': 'clmul(v{a}, v{b}, 64)',
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
    'SAR': 'sar(v{a}, {n})',
    'NEG': '-v{a}',
    'SUBR': 'v{a} - v{b}',
    'CLZ': 'clz(v{a})',
    'CTZ': 'ctz(v{a})',
    'ROL32': 'rol32(v{a}, {n})',
    'ROR32': 'ror32(v{a}, {n})',
    'SHRR': 'v{a} >> (v{b} & 63)',
    'GT_U': 'int(v{a} > v{b})',
}


def _rol32(value, shift):
    value &= 0xFFFFFFFF
    return ((value << shift) | (value >> (32 - shift))) & 0xFFFFFFFF


def _ror32(value, shift):
    value &= 0xFFFFFFFF
    return ((value >> shift) | (value << (32 - shift))) & 0xFFFFFFFF

_ENV = {'M': M64, 'pdep': pdep, 'pext': pext, 'clmul': clmul,
        'popcnt': popcnt, 'bswap64': bswap64, 'sar': sar, 'clz': clz,
        'ctz': ctz, 'rol32': _rol32, 'ror32': _ror32}


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
# Measurement objective: (span, work, L(z), rank)
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
# Normalization of a lowered sequence
#
# A lowering is assembled from independent pieces — one sub-sequence per
# abstract op, and one per branch of a split — so what comes out of it is
# correct and says the same thing several times: a multiply by a power of two,
# a mask that cannot clear anything, the same field extracted once per branch.
# None of that is a fact about the kernel, and all of it is counted by `work`,
# `span` and `L(z)`.  It is removed here, once, rather than in every lowerer.
#
# Everything below is an identity over 64-bit words.  The composed sequence is
# still verified over the declared domain afterwards, so a rewrite that was
# wrong would be caught rather than shipped.
# ---------------------------------------------------------------------------

def _sum_bits(a, b):
    return mask_of(min(64, (a + b).bit_length()))


def _product_bits(a, b):
    if not a or not b:
        return 0
    return mask_of(min(64, (a * b).bit_length()))


def _clmul_bits(a, const):
    out = 0
    for position in range(64):
        if (const >> position) & 1:
            out |= a << position
    return out & M64


def known_bits(seq, input_bits=None):
    """Which bits of each value can be set, over-approximated.

    Forward only, and deliberately conservative: an operation whose result this
    cannot bound gets all 64 bits.  What it is for is the masks — a shift down
    by 32 leaves nothing above bit 31, so an `AND` with the low half after one
    is not clearing anything — and the 32-bit forms in the listing, which are
    sound exactly when the value provably has no upper half.

    The input is unknown by default, even though the domain declares a width:
    a listing takes its argument in a 64-bit register, and a caller with
    something else in the top of it should still get the answer the C would.
    """
    known = [mask_of(input_bits) if input_bits else M64]
    for ins in seq.ins:
        a = known[ins.args[0]] if ins.args else 0
        b = known[ins.args[1]] if len(ins.args) > 1 else 0
        op, const, shift = ins.op, ins.const, ins.shift
        if op == 'AND':
            value = a & const
        elif op in ('OR', 'XOR'):
            value = a | const
        elif op == 'ANDR':
            value = a & b
        elif op in ('ORR', 'XORR'):
            value = a | b
        elif op in ('GT_U',):
            value = 1
        elif op == 'SHRR':
            value = M64
        elif op == 'ANDNR':
            value = b
        elif op == 'SHL':
            value = (a << shift) & M64
        elif op == 'SHR':
            value = a >> shift
        elif op == 'SAR':
            value = M64 if a >> 63 else a >> shift
        elif op == 'ADD':
            value = _sum_bits(a, const)
        elif op == 'ADDR':
            value = _sum_bits(a, b)
        elif op == 'IMUL':
            value = _product_bits(a, const)
        elif op == 'CLMUL':
            value = _clmul_bits(a, const)
        elif op == 'CLMULR':
            value = _clmul_bits(a, b)
        elif op == 'SCANXOR':
            value = a | ((a << shift) & M64)
        elif op == 'BSWAP':
            value = bswap64(a)
        elif op in ('ROL32', 'ROR32'):
            value = mask_of(32)
        elif op == 'PDEP':
            value = const
        elif op == 'PEXT':
            value = mask_of(popcnt(const))
        elif op in ('POPCNT', 'CLZ', 'CTZ'):
            value = 0x7F               # never more than 64
        elif op == 'LUT':
            value = 0
            for entry in const:
                value |= entry
        else:
            value = M64                # SUB, SUBR, NEG, NOT, the dynamic pair
        known.append(value & M64)
    return known


def _rewrite_one(op, const, shift, incoming):
    """One instruction's canonical form, or None when it is a copy.

    `incoming` is what the first argument's bits can be.  Returning None means
    the instruction computes its own argument and the uses of it are remapped.
    """
    if op == 'IMUL':
        if const == 0:
            return 'AND', 0, None
        if const == 1:
            return None
        if const & (const - 1) == 0:
            # A multiply by a power of two is a shift, and the difference is
            # not cosmetic: `L(z)` charges sixty-four bits for the constant and
            # six for the shift amount, so the two are not the same program.
            return 'SHL', None, const.bit_length() - 1
    if op == 'CLMUL' and const == 1:
        return None
    if op in ('PDEP', 'PEXT') and const == mask_of(popcnt(const)):
        # Depositing into the low `n` bits, or gathering them, moves nothing:
        # it is a mask, and saying so keeps the answer the same on a target
        # without BMI2 as on one with it.  A mask anywhere else is a real
        # deposit and stays one — `middle_bits_u16` is a PEXT and not a shift
        # and an AND.
        return 'AND', const, None
    if op == 'SUB' and const is not None and const >> 63:
        # Subtracting a negative constant is adding its magnitude, and the
        # magnitude is the shorter of the two to write.  The mirror rewrite is
        # deliberately not made: an addition whose constant is large is usually
        # one a lane form put there, and `0xB9B9B9B9B9B9B9BA` says what it is.
        return 'ADD', (-const) & M64, None
    if op in ('SHL', 'SHR', 'SAR') and shift == 0:
        return None
    if op == 'AND' and const is not None and incoming & ~const & M64 == 0:
        return None
    if op in ('OR', 'XOR', 'ADD', 'SUB') and const == 0:
        return None
    return op, const, shift


def _merge(producer, op, const, shift):
    """One instruction folded into the single-use one that produced its input."""
    previous = producer.op
    if previous == op and op in ('AND', 'OR', 'XOR'):
        combined = {'AND': producer.const & const,
                    'OR': producer.const | const,
                    'XOR': producer.const ^ const}[op]
        return op, combined, None
    if previous == 'ADD' and op == 'ADD':
        return 'ADD', (producer.const + const) & M64, None
    if previous == op and op in ('SHL', 'SHR'):
        total = producer.shift + shift
        if total >= 64:
            return 'AND', 0, None
        return op, None, total
    if previous == 'NOT' and op == 'NOT':
        return 'AND', M64, None        # dropped on the next rewrite pass
    return None


def _rewrite(seq):
    known = known_bits(seq)
    out = Seq()
    remap = {0: 0}
    for index, ins in enumerate(seq.ins, start=1):
        args = [remap[a] for a in ins.args]
        form = _rewrite_one(ins.op, ins.const, ins.shift,
                            known[ins.args[0]] if ins.args else M64)
        if form is None:
            remap[index] = args[0]
            continue
        op, const, shift = form
        remap[index] = out.emit(op, args, const, shift)
    out.result = remap[seq.result]
    out.notes = list(seq.notes)
    return out


def _fold(seq):
    uses = [0] * (len(seq.ins) + 1)
    for ins in seq.ins:
        for a in ins.args:
            uses[a] += 1
    uses[seq.result] += 1

    out = Seq()
    remap = {0: 0}
    defined = {}
    for index, ins in enumerate(seq.ins, start=1):
        args = [remap[a] for a in ins.args]
        op, const, shift = ins.op, ins.const, ins.shift
        if len(ins.args) == 1 and uses[ins.args[0]] == 1:
            producer = defined.get(args[0])
            if producer is not None and len(producer.args) == 1:
                merged = _merge(producer, op, const, shift)
                if merged is not None:
                    op, const, shift = merged
                    args = list(producer.args)
        value = out.emit(op, args, const, shift)
        defined[value] = out.ins[-1]
        remap[index] = value
    out.result = remap[seq.result]
    out.notes = list(seq.notes)
    return out


def dead_code(seq):
    """`seq` with every value no other value and no result reads removed."""
    live = set([seq.result])
    for index in range(len(seq.ins), 0, -1):
        if index in live:
            live.update(seq.ins[index - 1].args)

    out = Seq()
    remap = {0: 0}
    for index, ins in enumerate(seq.ins, start=1):
        if index not in live:
            continue
        remap[index] = out.emit(ins.op, [remap[a] for a in ins.args],
                                ins.const, ins.shift)
    out.result = remap[seq.result]
    out.notes = list(seq.notes)
    return out


def _shape(seq):
    return (seq.result, [(ins.op, ins.args, ins.const, ins.shift)
                         for ins in seq.ins])


# Each round can expose the next one's work — folding two masks into one can
# make the result a mask that clears nothing, which removes it, which makes
# another pair adjacent — and each round strictly removes or shortens, so the
# fixed point arrives quickly and the bound is a guard rather than a policy.
NORMALIZE_ROUNDS = 8


def _normalize_local(seq):
    """Apply instruction-local identities to a fixed point."""
    current = seq
    for _round in range(NORMALIZE_ROUNDS):
        stepped = dead_code(common_subexpressions(_fold(_rewrite(current))))
        if _shape(stepped) == _shape(current):
            return current
        current = stepped
    return current


def _extract_integer_affine(seq):
    """Extract the final `(scale, offset)` from an integer-affine SSA DAG.

    The accepted operations are exactly affine over integers modulo 2^64.
    No rewritten intermediate program is produced: each SSA value is mapped
    to its exact coefficients and only the requested result is returned.
    Rejecting any non-affine dependency keeps this independent of probes and
    of the finite verification domain.
    """
    forms = [(1, 0)]
    for ins in seq.ins:
        args = [forms[arg] for arg in ins.args]
        if any(value is None for value in args):
            forms.append(None)
            continue
        op = ins.op
        if op == 'IMUL':
            scale, offset = args[0]
            value = (scale * ins.const, offset * ins.const)
        elif op == 'SHL':
            scale, offset = args[0]
            factor = 1 << ins.shift
            value = (scale * factor, offset * factor)
        elif op == 'ADD':
            scale, offset = args[0]
            value = (scale, offset + ins.const)
        elif op == 'SUB':
            scale, offset = args[0]
            value = (scale, offset - ins.const)
        elif op == 'NEG':
            scale, offset = args[0]
            value = (-scale, -offset)
        elif op in ('ADDR', 'SUBR'):
            left, right = args
            sign = 1 if op == 'ADDR' else -1
            value = (left[0] + sign * right[0],
                     left[1] + sign * right[1])
        else:
            value = None
        forms.append(None if value is None
                     else (value[0] & M64, value[1] & M64))

    return forms[seq.result]


def _seq_integer_affine(form, notes=()):
    """Emit the canonical program for one extracted affine form."""
    scale, offset = form
    out = Seq(notes=list(notes))
    value = 0
    if scale == 0:
        value = out.emit('AND', [0], const=0)
    elif scale != 1:
        if scale & (scale - 1) == 0:
            value = out.emit('SHL', [0], shift=scale.bit_length() - 1)
        else:
            value = out.emit('IMUL', [0], const=scale)
    if offset:
        value = out.emit('ADD', [value], const=offset)
    out.result = value
    return out


def _extract_gf2_affine(seq):
    """Extract the final GF(2) basis and constant from an SSA DAG."""
    identity = tuple(1 << bit for bit in range(64))
    forms = [(identity, 0)]

    def map_bits(form, function):
        basis, constant = form
        return tuple(function(value) & M64 for value in basis), \
            function(constant) & M64

    for ins in seq.ins:
        args = [forms[arg] for arg in ins.args]
        if any(value is None for value in args):
            forms.append(None)
            continue
        op = ins.op
        if op == 'AND':
            value = map_bits(args[0], lambda word: word & ins.const)
        elif op == 'XOR':
            basis, constant = args[0]
            value = basis, constant ^ ins.const
        elif op == 'NOT':
            basis, constant = args[0]
            value = basis, constant ^ M64
        elif op == 'SHL':
            value = map_bits(args[0], lambda word: word << ins.shift)
        elif op == 'SHR':
            value = map_bits(args[0], lambda word: word >> ins.shift)
        elif op == 'BSWAP':
            value = map_bits(args[0], bswap64)
        elif op == 'SCANXOR':
            value = map_bits(args[0],
                             lambda word: word ^ (word << ins.shift))
        elif op == 'XORR':
            left, right = args
            value = (tuple(a ^ b for a, b in zip(left[0], right[0])),
                     left[1] ^ right[1])
        else:
            value = None
        forms.append(value)

    return forms[seq.result]


def _seq_gf2_affine(form, notes=()):
    """Emit a factored shift network from one extracted GF(2) map."""
    identity = tuple(1 << bit for bit in range(64))
    basis, constant = form
    if basis == identity:
        out = Seq(notes=list(notes))
        if constant:
            out.emit('XOR', [0], const=constant)
        return out

    out = _seq_shift_network(_lin_shift_terms(basis, 64))
    if constant:
        out.emit('XOR', [out.result], const=constant)
    out.notes = list(notes)
    return out


def normalize(seq):
    """Rewrite locally, then extract and directly emit exact whole forms."""
    current = _normalize_local(seq)
    candidates = [current]
    forms = (
        (_extract_integer_affine, _seq_integer_affine),
        (_extract_gf2_affine, _seq_gf2_affine),
    )
    for extract, emit in forms:
        form = extract(current)
        if form is not None:
            candidates.append(_normalize_local(emit(form, current.notes)))
    return min(candidates, key=objective_key)


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


def _lin_pdep_groups(basis):
    """Partition a one-hot map into monotone constant-deposit groups.

    One PDEP can only preserve the order of its packed input bits. A map such
    as Morton interleaving has two ordered runs in the packed coordinate: the
    low input word maps to even output bits and the high word maps to odd bits.
    Splitting at the order reversal gives two exact deposits whose outputs can
    be XORed.
    """
    groups = []
    for input_bit, image in enumerate(basis):
        if not image:
            continue
        if image & (image - 1):
            return None
        output_bit = image.bit_length() - 1
        if groups and groups[-1][-1][1] < output_bit:
            groups[-1].append((input_bit, output_bit))
        else:
            groups.append([(input_bit, output_bit)])
    return groups or None


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


def _pdep_expand_levels(mask):
    """Masks for a constant deposit, from compact bits to `mask` positions.

    Compressing the mask moves selected positions right by powers of two.
    Replaying those levels backwards expands the low packed bits.  Each level
    is therefore the exact identity

        x = (x | (x << shift)) & expanded_mask

    on the current selected positions.  The returned data is constant for one
    deposit mask; none of the planning work is emitted into the program.
    """
    current = mask & M64
    moving = ((~current) & M64) << 1 & M64
    levels = []
    for bit in range(6):
        prefix = moving ^ ((moving << 1) & M64)
        for shift in (2, 4, 8, 16, 32):
            prefix ^= (prefix << shift) & M64
        moved = prefix & current
        before = current
        current = ((current ^ moved) | (moved >> (1 << bit))) & M64
        levels.append((1 << bit, before, moved))
        moving &= ~prefix & M64
    return levels


def _seq_pdep_expand(mask):
    """Portable constant deposit as a logarithmic shift/OR/mask network."""
    seq = Seq()
    packed = mask_of(popcnt(mask))
    value = 0 if packed == M64 else seq.emit('AND', [0], const=packed)
    for shift, expanded, moved in reversed(_pdep_expand_levels(mask)):
        if not moved:
            continue
        shifted = seq.emit('SHL', [value], shift=shift)
        value = seq.emit('ORR', [value, shifted])
        value = seq.emit('AND', [value], const=expanded)
    seq.result = value
    return seq


def _seq_partitioned_deposits(groups, isa):
    """Lower ordered input/output groups to deposits over one packed word."""
    seq = Seq()
    partials = []
    for group in groups:
        inputs = [item[0] for item in group]
        input_mask = sum(1 << bit for bit in inputs)
        output_mask = sum(1 << item[1] for item in group)
        packed_output = output_mask == mask_of(len(inputs))
        contiguous = inputs == list(range(inputs[0], inputs[0] + len(inputs)))
        value = 0
        if packed_output and isa.has('pext'):
            # PEXT performs both the source selection and the low packed
            # publication.  Spelling this as shift/mask/PDEP would re-create
            # two operations after the closed linear map was already known.
            value = seq.emit('PEXT', [value], const=input_mask)
        elif contiguous:
            if inputs[0]:
                value = seq.emit('SHR', [value], shift=inputs[0])
            if packed_output and (inputs[0] or len(inputs) < 64):
                value = seq.emit('AND', [value], const=mask_of(len(inputs)))
        elif isa.has('pext'):
            value = seq.emit('PEXT', [value], const=input_mask)
        else:
            return None

        if packed_output:
            pass
        elif isa.has('pdep'):
            value = seq.emit('PDEP', [value], const=output_mask)
        else:
            value = seq.extend(_seq_pdep_expand(output_mask), value)
        partials.append(value)

    while len(partials) > 1:
        combined = []
        for index in range(0, len(partials) - 1, 2):
            combined.append(seq.emit(
                'XORR', [partials[index], partials[index + 1]]))
        if len(partials) % 2:
            combined.append(partials[-1])
        partials = combined
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

    pdep_mask = _lin_pdep_mask(basis)
    if pdep_mask is not None and not isa.has('pdep'):
        out.append(('shift/OR deposit network', _seq_pdep_expand(pdep_mask)))

    groups = _lin_pdep_groups(basis)
    if groups is not None and len(groups) > 1:
        deposits = _seq_partitioned_deposits(groups, isa)
        if deposits is not None:
            out.append(('partitioned deposit network', deposits))

    terms = _lin_shift_terms(basis, input_bits)
    if terms and len(terms) <= 24:
        out.append(('shift/XOR network', _seq_shift_network(terms)))

    if not out:
        # The zero map is a linear map, and every target can compute it.  A
        # SPLIT whose branch is a constant arrives here with an empty basis and
        # a constant beside it, and "no representative of LIN_CONST" would be a
        # statement about this table rather than about the map.
        s = Seq()
        s.emit('AND', [0], const=0)
        out.append(('zero', s))

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


def _packed_field(seq, source, shift, width):
    value = source
    if shift:
        value = seq.emit('SHR', [value], shift=shift)
    if width < 64:
        value = seq.emit('AND', [value], const=mask_of(width))
    return value


def lower_bit_query(op, isa):
    detail = op.detail
    seq = Seq()
    value = _packed_field(
        seq, 0, detail['value_shift'], detail['value_width'])
    index = _packed_field(
        seq, 0, detail['index_shift'], detail['index_width'])
    selected = seq.emit('SHRR', [value, index])
    seq.result = seq.emit('AND', [selected], const=1)
    return [('dynamic bit coordinate', seq)]


def lower_field_compare(op, isa):
    detail = op.detail
    seq = Seq()
    left = _packed_field(
        seq, 0, detail['left_shift'], detail['width'])
    right = _packed_field(
        seq, 0, detail['right_shift'], detail['width'])
    seq.result = seq.emit(detail['relation'], [left, right])
    return [('scalar field comparison', seq)]


def _lane_interval_seq(seq, v, bounds, lane_bits):
    """`lo <= lane <= hi` on every lane, as `corpus/lanes/lanecode.h`.

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


def _lane_less_seq(seq, x, y, lane_bits):
    """Per-lane unsigned `x < y`, as that lane's top bit.

    The same arithmetic as the one-sided `_lane_interval_seq` form, with the
    bound in a register instead of in a constant.  Setting every top bit of `x`
    before subtracting the low part of `y` is what stops a borrow leaving its
    lane; what is left is a Boolean function of the three top bits.
    """
    _ones, low, high = lane_masks(lane_bits)
    h = seq.emit('OR', [x], const=high)
    yl = seq.emit('AND', [y], const=low)
    z = seq.emit('SUBR', [h, yl])
    u = seq.emit('XORR', [x, z])
    e = seq.emit('XORR', [x, y])
    a = seq.emit('ANDNR', [e, u])
    a = seq.emit('XORR', [x, a])
    a = seq.emit('NOT', [a])
    return seq.emit('AND', [a], const=high), e


def _lane_reduce_seq(seq, v, lane_bits, want_max):
    """Maximum or minimum over the lanes of one word, in the low lane.

    A halving tournament: compare the word against itself shifted down by half
    the remaining width, keep the winner per lane, repeat.  Nothing here is a
    branch and nothing is a new primitive — the comparison is the lane
    arithmetic above, and the winner is chosen by XOR-blending under the mask
    that comparison produced.
    """
    shift = 32
    while shift >= lane_bits:
        y = seq.emit('SHR', [v], shift=shift)
        if want_max:
            flag, diff = _lane_less_seq(seq, v, y, lane_bits)
        else:
            flag, diff = _lane_less_seq(seq, y, v, lane_bits)
        bit = seq.emit('SHR', [flag], shift=lane_bits - 1)
        mask = seq.emit('IMUL', [bit], const=mask_of(lane_bits))
        take = seq.emit('ANDR', [diff, mask])
        v = seq.emit('XORR', [v, take])
        shift >>= 1
    return seq.emit('AND', [v], const=mask_of(lane_bits))


def _xor_tree(seq, values):
    values = list(values)
    while len(values) > 1:
        combined = [seq.emit('XORR', values[index:index + 2])
                    for index in range(0, len(values) - 1, 2)]
        if len(values) & 1:
            combined.append(values[-1])
        values = combined
    return values[0]


def _gf256_product_seq(seq, v, isa):
    """Eight independent partial products followed by one linear reduction."""
    a = seq.emit('AND', [v], const=0xFF)
    b = seq.emit('SHR', [v], shift=8)
    if isa.has('clmul'):
        product = seq.emit('CLMULR', [a, b])
    else:
        terms = []
        for bit in range(8):
            flag = b if bit == 0 else seq.emit('SHR', [b], shift=bit)
            flag = seq.emit('AND', [flag], const=1)
            flag = seq.emit('NEG', [flag])
            shifted = a if bit == 0 else seq.emit('SHL', [a], shift=bit)
            terms.append(seq.emit('ANDR', [shifted, flag]))
        product = _xor_tree(seq, terms)

    # With P(x)=x^8+0x1d, write product=low+x^8*high and substitute
    # x^8=0x1d.  high has degree at most six, so q=high*0x1d reaches only
    # degree ten; its remaining high part has at most three bits and the same
    # substitution finishes the reduction.  This is two fixed convolutions,
    # not a fifteen-bit matrix materialized as masks and gathers.
    def multiply_1d(value):
        if isa.has('clmul'):
            return seq.emit('CLMUL', [value], const=0x1D)
        shifted = [value]
        shifted.extend(seq.emit('SHL', [value], shift=amount)
                       for amount in (2, 3, 4))
        return _xor_tree(seq, shifted)

    low = seq.emit('AND', [product], const=0xFF)
    high = seq.emit('SHR', [product], shift=8)
    first = multiply_1d(high)
    first_low = seq.emit('AND', [first], const=0xFF)
    overflow = seq.emit('SHR', [first], shift=8)
    second = multiply_1d(overflow)
    return _xor_tree(seq, (low, first_low, second))


def _arx32_seq(seq, v, key, rotations):
    right, left = rotations
    low = mask_of(32)
    x = seq.emit('SHR', [v], shift=32)
    y = seq.emit('AND', [v], const=low)
    x = seq.emit('ROR32', [x], shift=right)
    x = seq.emit('ADDR', [x, y])
    x = seq.emit('AND', [x], const=low)
    x = seq.emit('XOR', [x], const=key)
    y = seq.emit('ROL32', [y], shift=left)
    y = seq.emit('XORR', [y, x])
    high = seq.emit('SHL', [x], shift=32)
    return seq.emit('ORR', [high, y])


def reciprocal(modulus, value_bits):
    """(M, s) with `(v * M) >> s == v // modulus` for every `v < 2^value_bits`.

    The remainder is then `v - modulus * (v // modulus)`, so a division nobody
    wants to issue becomes two multiplies, a shift and a subtract.  `s` is the
    value's width plus the modulus's, which is what makes the rounding error of
    `ceil(2^s / modulus)` too small to reach the next integer over the whole
    range — and the lowered sequence is verified over the domain regardless.
    """
    s = value_bits + modulus.bit_length()
    return -((-1 << s) // modulus), s


def _mod_seq(seq, v, modulus, value_bits):
    multiplier, s = reciprocal(modulus, value_bits or 64)
    q = seq.emit('IMUL', [v], const=multiplier)
    q = seq.emit('SHR', [q], shift=s)
    q = seq.emit('IMUL', [q], const=modulus)
    return seq.emit('SUBR', [v, q])


def _smear_seq(seq, v, width):
    """`x | x>>1 | x>>2 | ...`, as the doubling cascade it is."""
    shift = 1
    while shift < width:
        s = seq.emit('SHR', [v], shift=shift)
        v = seq.emit('ORR', [v, s])
        shift <<= 1
    return v


def lower_point(op, isa):
    seq = Seq()
    v = 0
    for mnemonic, const, shift in op.detail['steps']:
        if mnemonic == 'LANE_INTERVAL':
            v = _lane_interval_seq(seq, v, const, shift)
        elif mnemonic == 'GF256_MUL':
            v = _gf256_product_seq(seq, v, isa)
        elif mnemonic == 'ARX32':
            v = _arx32_seq(seq, v, const, shift)
        elif mnemonic == 'NEG':
            v = seq.emit('NEG', [v])
        elif mnemonic == 'AND_NEG':
            n = seq.emit('NEG', [v])
            v = seq.emit('ANDR', [v, n])
        elif mnemonic == 'OR_NEG':
            n = seq.emit('NEG', [v])
            v = seq.emit('ORR', [v, n])
        elif mnemonic == 'AND_DEC':
            d = seq.emit('SUB', [v], const=1)
            v = seq.emit('ANDR', [v, d])
        elif mnemonic == 'OR_SHR':
            s = seq.emit('SHR', [v], shift=shift)
            v = seq.emit('ORR', [v, s])
        elif mnemonic == 'SAR':
            v = seq.emit('SAR', [v], shift=shift)
        elif mnemonic == 'XOR_SAR':
            width = const or 64
            if width < 64:
                # The sign bit of a narrow word is not the register's, so it
                # is slid up to bit 63 before the arithmetic shift reads it.
                top = seq.emit('SHL', [v], shift=64 - width)
                s = seq.emit('SAR', [top], shift=64 - width + shift)
                v = seq.emit('XORR', [v, s])
                v = seq.emit('AND', [v], const=mask_of(width))
            else:
                s = seq.emit('SAR', [v], shift=shift)
                v = seq.emit('XORR', [v, s])
        elif mnemonic == 'KEY':
            v = _key_seq(seq, v, const)
        elif mnemonic == 'MOD':
            v = _mod_seq(seq, v, const, shift)
        elif mnemonic == 'SMEAR':
            v = _smear_seq(seq, v, const or 64)
        elif mnemonic == 'CLZ':
            width = const or 64
            if width < 64:
                v = seq.emit('AND', [v], const=mask_of(width))
            v = seq.emit('CLZ', [v])
            if width < 64:
                v = seq.emit('SUB', [v], const=64 - width)
        elif mnemonic == 'CTZ':
            width = const or 64
            if width < 64:
                # The count of a zero word is the width, and `x | 2^width` is
                # how a 64-bit instruction is told what the width was.
                v = seq.emit('OR', [v], const=1 << width)
            v = seq.emit('CTZ', [v])
        elif mnemonic in ('LANE_MAX', 'LANE_MIN'):
            v = _lane_reduce_seq(seq, v, shift, mnemonic == 'LANE_MAX')
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


def common_subexpressions(seq):
    """`seq` with every repeated instruction computed once.

    A split computes its key for the comparison and again inside any branch
    that reads it, and two branches of a case analysis usually agree about
    most of what they read off the word.  None of that is a fact about the
    grammar — it is what happens when independent sub-programs are pasted into
    one straight line — so it is removed here rather than worked around in
    three solvers.
    """
    remap = {0: 0}
    seen = {}
    out = Seq()
    for index, ins in enumerate(seq.ins, start=1):
        args = tuple(remap[a] for a in ins.args)
        const = (tuple(ins.const) if isinstance(ins.const, (list, tuple))
                 else ins.const)
        signature = (ins.op, args, const, ins.shift)
        if signature in seen:
            remap[index] = seen[signature]
            continue
        seen[signature] = remap[index] = out.emit(ins.op, args, ins.const,
                                                  ins.shift)
    out.result = remap[seq.result]
    out.notes = list(seq.notes)
    return out


def _key_seq(seq, x, key):
    """The SSA value holding `key(x)`, as a signed 64-bit number."""
    parts = []
    for shift, width, signed, coeff in key.terms:
        v = x
        if signed:
            # Slide the field's top bit to bit 63 and come back down
            # arithmetically: that is sign extension, spelled in two shifts.
            high = 64 - shift - width
            if high:
                v = seq.emit('SHL', [v], shift=high)
            if 64 - width:
                v = seq.emit('SAR', [v], shift=64 - width)
        else:
            if shift:
                v = seq.emit('SHR', [v], shift=shift)
            if width < 64:
                v = seq.emit('AND', [v], const=mask_of(width))
        parts.append((coeff, v))

    coeff, total = parts[0]
    if coeff < 0:
        total = seq.emit('NEG', [total])
    for coeff, v in parts[1:]:
        total = seq.emit('SUBR' if coeff < 0 else 'ADDR', [total, v])
    return total


def lower_split(op, isa):
    """Every branch, computed, and then blended under the key's comparisons.

    There is no branch instruction here and there is no lookup: each threshold
    becomes one subtraction whose sign bit *is* the comparison, spread to a
    mask by an arithmetic shift.  Applying the thresholds in ascending order is
    what makes the last one that fires the right one, so a k-way split costs
    k-1 blends rather than k-1 nested selects.

    A branch is an abstract program in its own right, so it is lowered by the
    same search — and checked against its own meaning, not against the split's,
    because a branch is only ever asked about the piece it owns.
    """
    key = op.detail['key']
    breaks = op.detail['breaks']
    branches = op.detail['branches']

    subs = [lower_program(branch, isa, accept=_branch_check(branch))[0]
            for branch in branches]

    out = []
    if (len(branches) == 2 and breaks == [1]
            and len(key.terms) == 1
            and key.terms[0][1:] == (1, False, 1)):
        # A one-bit key is already the complete selection predicate.  Turning
        # it into an all-bit mask needs no ordered comparison: extract the bit
        # and negate it, then use the standard XOR blend.  This is exactly
        # selector ? right : left after substituting selector in {0,1}.
        shift = key.terms[0][0]
        direct = Seq()
        left = direct.extend(subs[0], 0)
        right = direct.extend(subs[1], 0)
        if isa.has('pext'):
            selector = direct.emit('PEXT', [0], const=1 << shift)
        else:
            selector = (0 if not shift
                        else direct.emit('SHR', [0], shift=shift))
            selector = direct.emit('AND', [selector], const=1)
        mask = direct.emit('NEG', [selector])
        difference = direct.emit('XORR', [left, right])
        selected = direct.emit('ANDR', [difference, mask])
        direct.result = direct.emit('XORR', [left, selected])
        out.append(('one-bit XOR blend', common_subexpressions(direct)))

    seq = Seq()
    k = _key_seq(seq, 0, key)
    result = seq.extend(subs[0], 0)
    for threshold, sub in zip(breaks, subs[1:]):
        alternative = seq.extend(sub, 0)
        d = seq.emit('SUB', [k], const=threshold & M64)
        below = seq.emit('SAR', [d], shift=63)
        diff = seq.emit('XORR', [result, alternative])
        take = seq.emit('ANDNR', [below, diff])
        result = seq.emit('XORR', [result, take])
    seq.result = result
    out.append(('ordered split blend', seq))
    return out


def lower_fork(op, isa):
    """Lower independent semantic branches from one input into one SSA DAG."""
    branches = op.detail['branches']
    merge = op.detail['merge']
    physical = {
        'AND': 'ANDR',
        'OR': 'ORR',
        'XOR': 'XORR',
        'ADD': 'ADDR',
    }[merge]
    subs = [lower_program(branch, isa, accept=_branch_check(branch))[0]
            for branch in branches]
    seq = Seq()
    values = [seq.extend(sub, 0) for sub in subs]
    result = values[0]
    for value in values[1:]:
        result = seq.emit(physical, [result, value])
    seq.result = result
    return [('shared SSA fan-out', common_subexpressions(seq))]


# How many inputs a lowered branch is checked on against the branch it lowers.
# The composed program is verified over the whole declared domain afterwards;
# this only decides which representative of each branch is tried first.
BRANCH_PROBES = 192


def _branch_check(branch):
    """`seq -> bool`: does `seq` compute the same function as `branch`?

    A branch is lowered against its own meaning rather than against the split's
    semantics, because the split never asks a branch about a point outside its
    piece — and a representative rejected for disagreeing off-piece would be
    rejected for the wrong reason.
    """
    from .bits import xorshift_stream
    from .program import compile_program

    width = branch.input_bits
    m = mask_of(width)
    values = [0, m]
    values += [1 << i for i in range(width)]
    values += [(1 << i) - 1 for i in range(1, width)]
    values += xorshift_stream(0x243F6A8885A308D3, BRANCH_PROBES, width)
    values = list(dict.fromkeys(values))
    reference = compile_program(branch)
    expected = [reference(v) for v in values]

    def check(seq):
        evaluate = compile_seq(seq)
        out = mask_of(branch.output_bits)
        return all(evaluate(v) & out == y for v, y in zip(values, expected))
    return check


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
    'BIT_QUERY': lower_bit_query,
    'FIELD_COMPARE': lower_field_compare,
    'POINT': lower_point,
    'FORK': lower_fork,
    'SPLIT': lower_split,
    'TABLE': lower_table,
    'IDENTITY': lower_identity,
}


class LoweringFailure(Exception):
    def __init__(self, op, isa):
        Exception.__init__(self, 'no representative of %s on %s'
                           % (op.label, isa.title))
        self.op = op
        self.isa = isa


def lower_program(program, isa, verify_against=None, accept=None):
    """Lower every abstract op, choosing the best representative per op.

    `verify_against` is an optional (semantics, observer) pair.  When given, a
    candidate whose composition fails on the domain is discarded instead of
    ranked, which is what keeps IMUL from being offered where carry escapes.

    `accept` is the same gate stated as a predicate on the sequence, for a
    caller that has no semantics to offer — a SPLIT lowering its own branches
    holds each one to the branch program it came from.
    """
    chosen = []
    seq = Seq()
    current = 0

    for op in program.ops:
        options = LOWERERS[op.kind](op, isa)
        if not options:
            raise LoweringFailure(op, isa)
        # Rank the representatives by what they cost after normalization, not
        # by what the lowerer happened to write: a multiply by a power of two
        # and the shift it becomes are not two candidates.
        options = sorted(((name, normalize(sub)) for name, sub in options),
                         key=lambda pair: objective_key(pair[1]))
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
        # Pieces that were lowered independently say the same thing several
        # times over; what is asked of them is the whole sequence, so that is
        # what is normalized and what is then verified and measured.
        seq = normalize(seq)

        if verify_against is None and accept is None:
            return seq, used
        if accept is not None:
            if accept(seq):
                return seq, used
        else:
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
    'CLMULR': lambda a, ins: 'qm_clmul64(%s, %s)' % (a[0], a[1]),
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
    'SAR': lambda a, ins: '(uint64_t)((int64_t)%s >> %d)' % (a[0], ins.shift),
    'NEG': lambda a, ins: '-%s' % a[0],
    'SUBR': lambda a, ins: '%s - %s' % (a[0], a[1]),
    # `clz`/`ctz` of zero is undefined in C and defined here, so the guard is
    # part of the program rather than a note about it.
    'CLZ': lambda a, ins: ('%s ? (uint64_t)__builtin_clzll(%s) : 64'
                           % (a[0], a[0])),
    'CTZ': lambda a, ins: ('%s ? (uint64_t)__builtin_ctzll(%s) : 64'
                           % (a[0], a[0])),
    'ROL32': lambda a, ins: ('(uint32_t)(((uint32_t)%s << %d) | '
                                  '((uint32_t)%s >> %d))'
                                 % (a[0], ins.shift, a[0], 32 - ins.shift)),
    'ROR32': lambda a, ins: ('(uint32_t)(((uint32_t)%s >> %d) | '
                                  '((uint32_t)%s << %d))'
                                 % (a[0], ins.shift, a[0], 32 - ins.shift)),
    'SHRR': lambda a, ins: '%s >> (%s & 63)' % (a[0], a[1]),
    'GT_U': lambda a, ins: '(uint64_t)(%s > %s)' % (a[0], a[1]),
    'LOOP8': lambda a, ins: 'qm_gather_loop(0x%016Xull, %s)' % (ins.const, a[0]),
    'LUT': lambda a, ins: 'qm_lut[%s & %d]'
    % (a[0], len(ins.const) - 1),
}

NEEDS_BMI2 = {'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN'}
NEEDS_PCLMUL = {'CLMUL', 'CLMULR'}


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

_ASM_RR = {'XORR': 'xorq', 'ANDR': 'andq', 'ORR': 'orq', 'ADDR': 'addq',
           'SUBR': 'subq'}
_ASM_RI = {'AND': 'andq', 'OR': 'orq', 'XOR': 'xorq', 'ADD': 'addq',
           'SUB': 'subq'}


def _fits_imm32(value):
    """Does this 64-bit constant survive as a sign-extended 32-bit immediate?

    Every operand form below writes `q`, so an immediate is sign-extended from
    32 bits to 64. A constant inside that range is one instruction; anything
    else needs `movabsq` into a scratch register and a second instruction to
    use it, which is where the listings were spending most of their length.
    """
    return value < (1 << 31) or value >= (M64 + 1) - (1 << 31)


def _imm(value):
    """A constant as AT&T immediate text, in the shorter of the two spellings."""
    if value >= (M64 + 1) - (1 << 31):
        return '$-%d' % ((M64 + 1) - value)
    return '$0x%X' % value


# Instructions whose 32-bit form computes the 64-bit one, given that every
# value involved provably has no upper half. A 32-bit destination zero-extends,
# so nothing above bit 31 survives to be wrong; `NOT`, `NEG` and `SAR` are not
# on the list because each of them reads or writes the upper half by
# definition.
_NARROWABLE = {'AND', 'OR', 'XOR', 'ADD', 'SUB', 'IMUL', 'SHL', 'SHR',
               'ANDR', 'ORR', 'XORR', 'ADDR', 'SUBR', 'ANDNR'}

_ASM_32 = {
    '%rax': '%eax', '%rcx': '%ecx', '%rdx': '%edx', '%rsi': '%esi',
    '%rdi': '%edi', '%r8': '%r8d', '%r9': '%r9d', '%r10': '%r10d',
    '%r11': '%r11d',
}


def emit_asm(seq, name, input_bits=None):
    """Emit AT&T x86-64 assembly (SysV: argument in %rdi, result in %rax).

    Three things keep the listing close to what an assembly programmer would
    have written for the same sequence, none of which changes the program:

    * a constant that fits a sign-extended 32-bit immediate is written as one,
      so most instructions stop being a `movabsq` and a use;
    * a value whose last reader is this instruction is overwritten in place,
      which is what removes the `movq` in front of nearly every operation;
    * an instruction all of whose values provably fit in 32 bits is written in
      the 32-bit form, because a 32-bit destination zero-extends and the two
      compute the same thing.

    Returns None when the sequence contains something this small emitter does
    not encode, or needs more live values than the register pool holds — a
    listing that does not assemble would be worse than no listing.
    """
    unsupported = {'LUT', 'LOOP8', 'POPCNT', 'SCANXOR', 'SHRR', 'GT_U'}
    if any(ins.op in unsupported for ins in seq.ins):
        return None

    known = known_bits(seq)
    last_use = {0: 0}
    for k, ins in enumerate(seq.ins, start=1):
        for a in ins.args:
            last_use[a] = k
    last_use[seq.result] = len(seq.ins) + 1

    free = list(_ASM_POOL)
    reg = {0: '%rdi'}
    body = []
    uses_xmm = False
    uses_countbits = False

    def load_const(value, target):
        body.append('    movabsq $0x%X, %s' % (value, target))

    for k, ins in enumerate(seq.ins, start=1):
        src = [reg[a] for a in ins.args]
        narrow = (ins.op in _NARROWABLE
                  and known[k] <= mask_of(32)
                  and all(known[a] <= mask_of(32) for a in ins.args)
                  # x86 masks a 32-bit shift count modulo 32 and a 64-bit
                  # count modulo 64. A count in 32..63 therefore cannot be
                  # narrowed even when both the input and result fit in 32 bits.
                  and not (ins.op in ('SHL', 'SHR') and ins.shift >= 32))
        suffix = 'l' if narrow else 'q'

        def name_of(register):
            return _ASM_32[register] if narrow else register

        # A value nothing reads after this instruction is a register this
        # instruction may have: writing into it is what makes the `movq` in
        # front of a two-address operation unnecessary.
        recycled = [a for a in dict.fromkeys(ins.args) if last_use.get(a, 0) <= k]
        dst = reg[ins.args[0]] if (ins.args and last_use.get(ins.args[0], 0) <= k) \
            else None
        for a in recycled:
            r = reg.get(a)
            if r and r != dst and r != '%rdi' and r not in free:
                free.append(r)
        if dst is None:
            if not free:
                return None
            dst = free.pop(0)
        reg[k] = dst

        in_place = bool(ins.args) and dst == src[0]

        def carry_in():
            """Put the first argument in `dst`, unless it is already there."""
            if not in_place:
                body.append('    mov%s %s, %s'
                            % (suffix, name_of(src[0]), name_of(dst)))

        if ins.op == 'IMUL':
            if _fits_imm32(ins.const):
                body.append('    imul%s %s, %s, %s'
                            % (suffix, _imm(ins.const), name_of(src[0]),
                               name_of(dst)))
            else:
                # The constant cannot land in `dst` first: `dst` may be the
                # register the multiplicand is already in.
                load_const(ins.const, _ASM_SCRATCH)
                carry_in()
                body.append('    imulq %s, %s' % (_ASM_SCRATCH, dst))
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
        elif ins.op in ('CLMUL', 'CLMULR'):
            uses_xmm = True
            body.append('    movq %s, %%xmm0' % src[0])
            if ins.op == 'CLMUL':
                load_const(ins.const, _ASM_SCRATCH)
                body.append('    movq %s, %%xmm1' % _ASM_SCRATCH)
            else:
                body.append('    movq %s, %%xmm1' % src[1])
            body.append('    pclmulqdq $0x00, %xmm1, %xmm0')
            body.append('    movq %%xmm0, %s' % dst)
        elif ins.op in ('ROL32', 'ROR32'):
            carry_in()
            body.append('    %sl $%d, %s'
                        % ('rol' if ins.op == 'ROL32' else 'ror', ins.shift,
                           _ASM_32[dst]))
        elif ins.op in _ASM_RI:
            mnemonic = _ASM_RI[ins.op][:-1] + suffix
            if _fits_imm32(ins.const):
                carry_in()
                body.append('    %s %s, %s'
                            % (mnemonic, _imm(ins.const), name_of(dst)))
            else:
                load_const(ins.const, _ASM_SCRATCH)
                carry_in()
                body.append('    %s %s, %s' % (_ASM_RI[ins.op], _ASM_SCRATCH,
                                               dst))
        elif ins.op == 'NOT':
            carry_in()
            body.append('    notq %s' % dst)
        elif ins.op == 'ANDNR':
            # BMI1 has ANDN, but its operand order is the easiest thing in this
            # emitter to get silently backwards; NOT+AND is one instruction
            # longer and assembles the same everywhere.
            if ins.args[0] == ins.args[1]:
                # ~x & x is zero. Destructively complementing the shared
                # register first would also overwrite the second operand and
                # incorrectly turn this into ~x & ~x.
                body.append('    xor%s %s, %s'
                            % (suffix, name_of(dst), name_of(dst)))
            elif in_place:
                body.append('    notq %s' % dst)
                body.append('    and%s %s, %s' % (suffix, name_of(src[1]),
                                                  name_of(dst)))
            else:
                body.append('    movq %s, %s' % (src[0], dst))
                body.append('    notq %s' % dst)
                body.append('    and%s %s, %s' % (suffix, name_of(src[1]),
                                                  name_of(dst)))
        elif ins.op in ('SHL', 'SHR', 'SAR'):
            carry_in()
            body.append('    %s $%d, %s'
                        % ({'SHL': 'shl', 'SHR': 'shr', 'SAR': 'sar'}[ins.op]
                           + suffix, ins.shift, name_of(dst)))
        elif ins.op == 'NEG':
            carry_in()
            body.append('    negq %s' % dst)
        elif ins.op in ('CLZ', 'CTZ'):
            uses_countbits = True
            body.append('    %s %s, %s'
                        % ('lzcntq' if ins.op == 'CLZ' else 'tzcntq',
                           src[0], dst))
        elif ins.op == 'BSWAP':
            carry_in()
            body.append('    bswapq %s' % dst)
        elif ins.op in _ASM_RR:
            carry_in()
            body.append('    %s %s, %s'
                        % (_ASM_RR[ins.op][:-1] + suffix, name_of(src[1]),
                           name_of(dst)))
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
    if uses_countbits:
        header.insert(0, '    # requires LZCNT/TZCNT')
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
    'SAR': 'i64.shr_s',
}
_WASM_RR = {'XORR': 'i64.xor', 'ANDR': 'i64.and', 'ORR': 'i64.or',
            'ADDR': 'i64.add', 'SUBR': 'i64.sub', 'SHRR': 'i64.shr_u',
            'GT_U': 'i64.gt_u'}
# wasm counts leading and trailing zeros of a zero word as 64, which is the
# definition this grammar uses, so no guard has to be emitted around them.
_WASM_UNARY = {'POPCNT': 'i64.popcnt', 'CLZ': 'i64.clz', 'CTZ': 'i64.ctz'}


def emit_wasm(seq, name, input_bits=None):
    """Emit a wasm32 function in the text format.

    Returns None when the sequence uses something wasm has no instruction for
    — a deposit, a carry-less multiply, a lookup table — rather than inventing
    an encoding for it.
    """
    unsupported = {'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'CLMUL', 'CLMULR', 'LUT',
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
            if op == 'GT_U':
                body.append('    i64.extend_i32_u')
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
        elif op in _WASM_UNARY:
            body.append('    local.get %d' % ins.args[0])
            body.append('    ' + _WASM_UNARY[op])
        elif op == 'NEG':
            body.append('    i64.const 0')
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.sub')
        elif op == 'SCANXOR':
            body.append('    local.get %d' % ins.args[0])
            body.append('    local.get %d' % ins.args[0])
            body.append('    i64.const 0x%X' % ins.shift)
            body.append('    i64.shl')
            body.append('    i64.xor')
        elif op in ('ROL32', 'ROR32'):
            body.append('    local.get %d' % ins.args[0])
            body.append('    i32.wrap_i64')
            body.append('    i32.const %d' % ins.shift)
            body.append('    i32.%s' % ('rotl' if op == 'ROL32' else 'rotr'))
            body.append('    i64.extend_i32_u')
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
