"""SPEC §6 — the normalized abstract program.

Abstract operations are *semantic classes*, never instruction names.  A
`LIN_CONST` node carries the linear map, not a PDEP mask, so that every ISA can
search its own physical representatives in `isa.py`.

Layer 2: depends on `bits` only.
"""

from . import straightline
from .bits import (M64, bswap64, clmul, mask_of, pdep, pext,
                    popcnt)

# Semantic classes from SPEC §6, plus TABLE for the always-available
# finite-domain representative.
CLASSES = ('POINT', 'LIN_CONST', 'CONV', 'PERM_DYN', 'TABLE', 'IDENTITY')


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
            if key in ('basis', 'table'):
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


def point(steps, note=''):
    """Lane-local / locally nonlinear step.

    `steps` is a list of concrete primitive tuples (mnemonic, const, shift)
    because POINT is exactly where carry and comparison are created, and those
    have no shorter semantic description than the operations themselves.
    """
    return Op('POINT', {'steps': list(steps), 'note': note}, label='POINT')


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

    residual_freedom follows SPEC §9:
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
    if kind == 'POINT':
        name = 'steps%d' % index
        data[name] = op.detail['steps']
        return 'point(%s, %s)' % (name, source)
    if kind == 'TABLE':
        name = 'table%d' % index
        data[name] = op.detail['table']
        return '%s[%s & %d]' % (name, source, mask_of(op.detail['input_bits']))
    raise ValueError('cannot evaluate %r' % kind)


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

