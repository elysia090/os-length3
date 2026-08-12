"""The normalized abstract program.

Abstract operations are *semantic classes*, never instruction names.  A
`LIN_CONST` node carries the linear map, not a PDEP mask, so that every ISA can
search its own physical representatives in `isa.py`.

Layer 2: depends on `bits` only.
"""

from . import straightline
from .bits import (M64, bswap64, clmul, clz, ctz, lane_masks, lane_values,
                    mask_of, pdep, pext, popcnt, sar, smear, to_signed)

# Semantic classes, plus TABLE for the always-available finite-domain
# representative and SPLIT for the piecewise one.
CLASSES = ('POINT', 'LIN_CONST', 'CONV', 'PERM_DYN', 'BIT_QUERY',
           'FIELD_COMPARE', 'FORK', 'SPLIT', 'TABLE', 'IDENTITY')


class Key(object):
    """An ordered number read off the input, for a SPLIT to compare.

    A key is a signed integer combination of bit-fields:

        key(x) = SUM_i coeff_i * read(x, shift_i, width_i, signed_i)

    That is deliberately narrow.  One term is "the exponent field", "the top
    byte", "the word itself"; two terms with opposite signs is "a minus b",
    which is the only thing `isLessOrEqual`, `min` and a conditional subtract
    ever want.  Anything a key cannot say is something a SPLIT cannot split
    on, which is what keeps this from becoming a search over all of C.

    The magnitude is bounded so that `key - threshold` cannot wrap a signed
    64-bit register: that subtraction *is* the comparison in the lowered code,
    and a key that could wrap would make the sign bit answer a different
    question.
    """

    __slots__ = ('terms',)

    LIMIT = 1 << 62

    def __init__(self, terms):
        self.terms = tuple((int(s), int(w), bool(g), int(c))
                           for s, w, g, c in terms)
        if not self.terms:
            raise ValueError('a key needs at least one term')
        if self.bound >= self.LIMIT:
            raise ValueError('key range does not fit a signed comparison')

    @property
    def bound(self):
        """An upper bound on |key(x)|."""
        return sum(1 << width for _shift, width, _signed, _coeff in self.terms)

    def value(self, x):
        total = 0
        for shift, width, signed, coeff in self.terms:
            v = (x >> shift) & mask_of(width)
            if signed and (v >> (width - 1)) & 1:
                v -= 1 << width
            total += coeff * v
        return total

    def _term_label(self, term):
        shift, width, signed, coeff = term
        span = 'x' if shift == 0 and width >= 64 else (
            'x[%d]' % shift if width == 1 else 'x[%d:%d]' % (shift + width - 1,
                                                             shift))
        if signed:
            span = 's%s' % span
        return ('-' if coeff < 0 else '+'), span

    @property
    def label(self):
        out = ''
        for index, term in enumerate(self.terms):
            sign, span = self._term_label(term)
            if index == 0:
                out = span if sign == '+' else '-' + span
            else:
                out += ' %s %s' % (sign, span)
        return out

    def to_dict(self):
        return {
            'label': self.label,
            'terms': [{'shift': s, 'width': w, 'signed': g, 'coeff': c}
                      for s, w, g, c in self.terms],
        }

    def __eq__(self, other):
        return isinstance(other, Key) and self.terms == other.terms

    def __hash__(self):
        return hash(self.terms)

    def __repr__(self):
        return 'Key(%s)' % self.label


def field_key(shift, width, signed=False):
    return Key([(shift, width, signed, 1)])


class Op(object):
    """One abstract operation.

    kind      one of CLASSES
    detail    class-specific payload, documented per constructor below
    """

    __slots__ = ('kind', 'detail', 'label')

    def __init__(self, kind, detail=None, label=None):
        if kind not in CLASSES:
            raise ValueError('unknown semantic class: %r' % (kind,))
        self.kind = kind
        self.detail = detail or {}
        self.label = label or kind

    def __repr__(self):
        return 'Op(%s, %s)' % (self.kind, self.label)

    def to_dict(self):
        d = {'class': self.kind, 'label': self.label}
        detail = {}
        for key, value in self.detail.items():
            if key == 'key':
                detail[key] = value.to_dict()
            elif key == 'branches':
                detail[key] = [branch.to_dict() for branch in value]
            elif key in ('basis', 'table'):
                detail[key] = ['0x%X' % v for v in value[:8]]
                if len(value) > 8:
                    detail[key].append('... %d entries' % len(value))
            elif isinstance(value, int) and key.endswith(('mask', 'const', 'M', 'D')):
                detail[key] = '0x%016X' % value
            else:
                detail[key] = value
        d['detail'] = detail
        return d


def lin_const(basis, input_bits, note=''):
    """Constant GF(2)-linear map given by the images of the input basis.

    `basis[i]` is the output for input `1 << i`; the map is
    `y = XOR_i basis[i] * bit_i(x)`.
    """
    return Op('LIN_CONST', {'basis': list(basis), 'input_bits': input_bits,
                            'note': note}, label='LIN_CONST')


def conv(family, const, lane_width=None):
    """Convolution along lane indices, indexed by physical multiply family."""
    label = 'CONV(%s%s)' % (family, ', %d' % lane_width if lane_width else '')
    return Op('CONV', {'family': family, 'const': const,
                       'lane_width': lane_width}, label=label)


def perm_dyn_gather(source):
    """Data-dependent gather: constant source, dynamic mask."""
    return Op('PERM_DYN', {'direction': 'gather', 'source': source},
              label='PERM_DYN(gather)')


def perm_dyn_scatter(source):
    return Op('PERM_DYN', {'direction': 'scatter', 'source': source},
              label='PERM_DYN(scatter)')


def bit_query(value_shift, value_width, index_shift, index_width):
    """One dynamic bit query over two packed input fields."""
    return Op('BIT_QUERY', {
        'value_shift': int(value_shift),
        'value_width': int(value_width),
        'index_shift': int(index_shift),
        'index_width': int(index_width),
    }, label='BIT_QUERY(x[%d:%d], x[%d:%d])' % (
        value_shift + value_width - 1, value_shift,
        index_shift + index_width - 1, index_shift))


def field_compare(relation, left_shift, right_shift, width):
    """One unsigned comparison between equal-width packed fields."""
    if relation not in ('GT_U',):
        raise ValueError('unknown field comparison: %r' % relation)
    return Op('FIELD_COMPARE', {
        'relation': relation,
        'left_shift': int(left_shift),
        'right_shift': int(right_shift),
        'width': int(width),
    }, label='FIELD_COMPARE(%s, %d-bit)' % (relation, width))


def point(steps, note=''):
    """Locally nonlinear step: lane-local, or a reduction of the whole word.

    `steps` is a list of concrete primitive tuples (mnemonic, const, shift)
    because POINT is exactly where carry, comparison and counting are created,
    and those have no shorter semantic description than the operations
    themselves.

    Most steps are lane-local.  The reductions — POPCNT, CLZ, CTZ, LANE_MAX,
    LANE_MIN — are not: they read the whole word and answer with a number.
    They live here for the same reason the lane predicates do, which is that
    they are where the grammar stops being linear.
    """
    return Op('POINT', {'steps': list(steps), 'note': note}, label='POINT')


def fork(branches, merge, note=''):
    """Apply independent semantic programs to one value and merge their results.

    This is the semantic counterpart of an SSA fan-out.  It preserves sharing
    until physical lowering, where common prefixes from independently derived
    branches are removed once.  ``merge`` is a total word operation, not a
    control-flow branch.
    """
    if merge not in ('AND', 'OR', 'XOR', 'ADD'):
        raise ValueError('unknown fork merge: %r' % (merge,))
    branches = list(branches)
    if len(branches) < 2:
        raise ValueError('a fork needs at least two branches')
    return Op('FORK', {'branches': branches, 'merge': merge, 'note': note},
              label='FORK(%s, %d)' % (merge, len(branches)))


def split(key, breaks, branches, note=''):
    """Piecewise program: a whole-word key decides which branch computes `y`.

    `key` is a `Key` — a named, bounded way of reading an ordered number off
    the input — and `breaks` is an ascending list of thresholds on it, so
    branch `i` computes the answer for `breaks[i-1] <= key < breaks[i]`.

    This is where comparison *between* parts of a word enters the grammar.  A
    lane predicate answers "is this byte in range" for eight bytes at once; a
    SPLIT answers "which of these programs is this word's" once, and that is
    the difference between `lt_spread8` and `isLessOrEqual`.

    Nothing here is a branch in the emitted code.  `isa.lower_split` computes
    every branch and blends them under a mask derived from the key, which is
    why a SPLIT still has a span and a work count rather than a mispredict.
    """
    label = 'SPLIT(%s, %d ways)' % (key.label, len(branches))
    return Op('SPLIT', {'key': key, 'breaks': list(breaks),
                        'branches': list(branches), 'note': note}, label=label)


def table(values, input_bits, output_bits):
    """Finite-domain lookup: always correct, deliberately expensive in L(z)."""
    return Op('TABLE', {'table': list(values), 'input_bits': input_bits,
                        'output_bits': output_bits}, label='TABLE')


def identity():
    return Op('IDENTITY', {}, label='IDENTITY')


def computes_the_identity(op):
    """Does this op leave its input alone?

    A solver searching a family has to name every stage of it, so it can come
    back with a stage that happens to do nothing: a deposit into a mask that is
    just the input's own bits, or a convolution by 1.  Those are real answers
    within the family and useless as operations — counting them would put a
    PDEP in the emitted code to move eight bits to where they already are.
    """
    if op.kind == 'IDENTITY':
        return True
    if op.kind == 'LIN_CONST':
        basis = op.detail['basis']
        width = min(op.detail['input_bits'], len(basis))
        return all(basis[i] == (1 << i) for i in range(width))
    if op.kind == 'CONV':
        return op.detail['const'] == 1
    return False


class Program(object):
    """An abstract program plus how strongly it was forced.

    residual_freedom reports how many candidates remain before canonical rank:
        0    not representable in the declared grammar
        1    the physical parameters are uniquely forced
        n>1  n solutions remain tied before canonical rank selection

    Stages that compute the identity are dropped on the way in, and said so in
    the notes.  `core_ops` is meant to be how much of the meaning is left after
    normalization, and a step that does nothing is not part of the meaning.
    """

    __slots__ = ('ops', 'residual_freedom', 'candidates', 'solver', 'notes',
                 'input_bits', 'output_bits', '_steps')

    def __init__(self, ops, residual_freedom, candidates, solver,
                 input_bits, output_bits, notes=None):
        ops = list(ops)
        idle = [op for op in ops if computes_the_identity(op)]
        self.ops = [op for op in ops if op not in idle]
        notes = list(notes or [])
        if idle:
            notes.append('dropped, each computing the identity: %s'
                         % ' ; '.join(op.label for op in idle))
        self._steps = None
        self.residual_freedom = residual_freedom
        self.candidates = candidates
        self.solver = solver
        self.input_bits = input_bits
        self.output_bits = output_bits
        self.notes = notes

    @property
    def classes(self):
        return [op.kind for op in self.ops]

    # A program is data; the compiled function hanging off it is a cache, and
    # a cache does not travel.  Saying so is what lets a result be handed
    # between processes — the same reason `isa.Seq` says it.
    def __getstate__(self):
        return (self.ops, self.residual_freedom, self.candidates, self.solver,
                self.notes, self.input_bits, self.output_bits)

    def __setstate__(self, state):
        (self.ops, self.residual_freedom, self.candidates, self.solver,
         self.notes, self.input_bits, self.output_bits) = state
        self._steps = None

    @property
    def core_ops(self):
        return len(self.ops)

    def evaluate(self, x):
        """Reference evaluation of the abstract program (ISA-independent)."""
        return compile_program(self)(x)

    def to_dict(self):
        return {
            'ops': [op.to_dict() for op in self.ops],
            'classes': self.classes,
            'core_ops': self.core_ops,
            'residual_freedom': self.residual_freedom,
            'candidates': self.candidates,
            'solver': self.solver,
            'notes': self.notes,
        }


def _lane_interval(value, bounds, lane_bits):
    """`lo <= lane <= hi` on every lane, as the top bit of that lane.

    This is the *meaning* — a comparison, written as a comparison. The
    branch-free forms that compute it live in `isa.lower_point`, and the two
    are held to each other rather than assumed equal: this decides whether a
    candidate is accepted at all, and `isa.matches` then puts the lowered
    sequence against the same semantics over the same domain.
    """
    lo, hi = bounds
    _, _, high = lane_masks(lane_bits)
    lane_mask = mask_of(lane_bits)
    top = 1 << (lane_bits - 1)
    out = 0
    for i in range(64 // lane_bits):
        if lo <= ((value >> (lane_bits * i)) & lane_mask) <= hi:
            out |= top << (lane_bits * i)
    return out & high


def _gf256_multiply(packed):
    a = packed & 0xFF
    b = (packed >> 8) & 0xFF
    product = 0
    for _unused in range(8):
        if b & 1:
            product ^= a
        a = ((a << 1) ^ (0x1D if a & 0x80 else 0)) & 0xFF
        b >>= 1
    return product


def _rotate_left32(value, shift):
    value &= 0xFFFFFFFF
    return ((value << shift) | (value >> (32 - shift))) & 0xFFFFFFFF


def _rotate_right32(value, shift):
    value &= 0xFFFFFFFF
    return ((value >> shift) | (value << (32 - shift))) & 0xFFFFFFFF


def _arx32(value, key, rotations):
    right, left = rotations
    x = (value >> 32) & 0xFFFFFFFF
    y = value & 0xFFFFFFFF
    x = (_rotate_right32(x, right) + y) & 0xFFFFFFFF
    x ^= key
    y = _rotate_left32(y, left) ^ x
    return (x << 32) | y


def _eval_point(steps, value):
    v = value & M64
    for mnemonic, const, shift in steps:
        if mnemonic == 'AND':
            v &= const
        elif mnemonic == 'OR':
            v |= const
        elif mnemonic == 'XOR':
            v ^= const
        elif mnemonic == 'ADD':
            v = (v + const) & M64
        elif mnemonic == 'SUB':
            v = (v - const) & M64
        elif mnemonic == 'NOT':
            v = (~v) & M64
        elif mnemonic == 'SHL':
            v = (v << shift) & M64
        elif mnemonic == 'SHR':
            v >>= shift
        elif mnemonic == 'BSWAP':
            v = bswap64(v)
        elif mnemonic == 'ANDN_PREV_SHL':
            # x & ~(x << shift): run-start detection, one POINT step.
            v = v & (~((v << shift) & M64)) & M64
        elif mnemonic == 'ANDN_PREV_SHR':
            v = v & (~(v >> shift)) & M64
        elif mnemonic == 'XOR_SHL':
            v = (v ^ (v << shift)) & M64
        elif mnemonic == 'POPCNT':
            v = popcnt(v)
        elif mnemonic == 'NEG':
            v = (-v) & M64
        elif mnemonic == 'AND_NEG':
            v = v & ((-v) & M64)
        elif mnemonic == 'OR_NEG':
            v = (v | (-v)) & M64
        elif mnemonic == 'AND_DEC':
            v = v & ((v - 1) & M64)
        elif mnemonic == 'OR_SHR':
            v |= v >> shift
        elif mnemonic == 'SAR':
            v = sar(v, shift)
        elif mnemonic == 'XOR_SAR':
            # `x ^ (x >> w-1)` arithmetic: the two's-complement fold that makes
            # a negative number's magnitude readable by the same code as a
            # positive one's.  One step, because the two halves are useless
            # apart, and `const` carries the width because a word narrower than
            # the register has its sign bit somewhere else.
            width = const or 64
            v = (v ^ (to_signed(v & mask_of(width), width) >> shift)) \
                & mask_of(width)
        elif mnemonic == 'KEY':
            v = const.value(v) & M64
        elif mnemonic == 'MOD':
            v %= const
        elif mnemonic == 'SMEAR':
            v = smear(v, const or 64)
        elif mnemonic == 'CLZ':
            v = clz(v, const or 64)
        elif mnemonic == 'CTZ':
            v = ctz(v, const or 64)
        elif mnemonic in ('LANE_MAX', 'LANE_MIN'):
            values = lane_values(v, shift)
            v = max(values) if mnemonic == 'LANE_MAX' else min(values)
        elif mnemonic == 'LANE_INTERVAL':
            v = _lane_interval(v, const, shift)
        elif mnemonic == 'GF256_MUL':
            v = _gf256_multiply(v)
        elif mnemonic == 'ARX32':
            v = _arx32(v, const, shift)
        else:
            raise ValueError('unknown POINT step: %r' % mnemonic)
    return v


# ---------------------------------------------------------------------------
# Evaluation
#
# Accepting a candidate walks the whole declared domain, and residual freedom
# is the count of candidates that survive, so a 2^16 kernel is a few million
# evaluations of the same handful of ops.  Which class an op is does not depend
# on the input, so the program is written out as one Python function, once, and
# the walk calls that.  `Program.evaluate` calls the same function.
# ---------------------------------------------------------------------------

_ENV = {'M': M64, 'pdep': pdep, 'pext': pext, 'clmul': clmul,
        'bswap64': bswap64, 'popcnt': popcnt, 'point': _eval_point}


def _op_expression(op, index, data):
    """The right-hand side for one abstract op, over the previous value."""
    kind = op.kind
    source = 'v%d' % index
    if kind == 'IDENTITY':
        return source
    if kind == 'LIN_CONST':
        # Only basis vectors with a non-zero image contribute, and the map is
        # an XOR of them: writing it out beats looping over the basis.
        terms = [(1 << i, image)
                 for i, image in enumerate(op.detail['basis']) if image]
        if not terms:
            return '0'
        return ' ^ '.join('(%d if %s & %d else 0)' % (image, source, bit)
                          for bit, image in terms)
    if kind == 'CONV':
        const = op.detail['const']
        if op.detail['family'] == 'IMUL':
            return '(%s * %d) & M' % (source, const)
        return 'clmul(%s, %d, 64) & M' % (source, const)
    if kind == 'PERM_DYN':
        name = 'src%d' % index
        data[name] = op.detail['source']
        if op.detail['direction'] == 'gather':
            return 'pext(%s, %s)' % (name, source)
        return 'pdep(%s, %s)' % (name, source)
    if kind == 'BIT_QUERY':
        detail = op.detail
        value = '((%s >> %d) & %d)' % (
            source, detail['value_shift'], mask_of(detail['value_width']))
        index = '((%s >> %d) & %d)' % (
            source, detail['index_shift'], mask_of(detail['index_width']))
        return '((%s >> %s) & 1)' % (value, index)
    if kind == 'FIELD_COMPARE':
        detail = op.detail
        field = mask_of(detail['width'])
        left = '((%s >> %d) & %d)' % (
            source, detail['left_shift'], field)
        right = '((%s >> %d) & %d)' % (
            source, detail['right_shift'], field)
        if detail['relation'] == 'GT_U':
            return 'int(%s > %s)' % (left, right)
        raise ValueError('cannot evaluate field comparison %r'
                         % detail['relation'])
    if kind == 'POINT':
        name = 'steps%d' % index
        data[name] = op.detail['steps']
        return 'point(%s, %s)' % (name, source)
    if kind == 'FORK':
        name = 'fork%d' % index
        data[name] = _fork_evaluator(op)
        return '%s(%s)' % (name, source)
    if kind == 'SPLIT':
        name = 'split%d' % index
        data[name] = _split_evaluator(op)
        return '%s(%s)' % (name, source)
    if kind == 'TABLE':
        name = 'table%d' % index
        data[name] = op.detail['table']
        return '%s[%s & %d]' % (name, source, mask_of(op.detail['input_bits']))
    raise ValueError('cannot evaluate %r' % kind)


def _fork_evaluator(op):
    branches = [compile_program(branch) for branch in op.detail['branches']]
    merge = op.detail['merge']

    def evaluate(x):
        values = [branch(x) & M64 for branch in branches]
        result = values[0]
        for value in values[1:]:
            if merge == 'AND':
                result &= value
            elif merge == 'OR':
                result |= value
            elif merge == 'XOR':
                result ^= value
            else:
                result = (result + value) & M64
        return result & M64
    return evaluate


def _split_evaluator(op):
    """`x -> branch_i(x)` for the piece `x`'s key falls in.

    The branches are compiled once each, and the piece is found by walking the
    thresholds, because there are at most a handful of them.  This is the
    reference: `isa.lower_split` computes every branch and blends, and the two
    are held to each other by verification rather than assumed equal.
    """
    key = op.detail['key']
    breaks = op.detail['breaks']
    branches = [compile_program(branch) for branch in op.detail['branches']]
    key_value = key.value

    def evaluate(x):
        k = key_value(x)
        index = 0
        for threshold in breaks:
            if k < threshold:
                break
            index += 1
        return branches[index](x)
    return evaluate


def _build(program):
    data = {}
    body = [('v0', 'x & %d' % mask_of(program.input_bits))]
    for index, op in enumerate(program.ops):
        body.append(('v%d' % (index + 1), _op_expression(op, index, data)))
    return straightline.build(
        'qm_program', ['x'], body,
        'v%d & %d' % (len(program.ops), mask_of(program.output_bits)),
        dict(_ENV, **data))


def compile_program(program):
    """A callable `x -> y` for one abstract program, compiled once."""
    compiled = program._steps
    if compiled is None or compiled[0] != len(program.ops):
        compiled = program._steps = (len(program.ops), _build(program))
    return compiled[1]
