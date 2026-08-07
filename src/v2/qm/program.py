"""SPEC §6 — the normalized abstract program.

Abstract operations are *semantic classes*, never instruction names.  A
`LIN_CONST` node carries the linear map, not a PDEP mask, so that every ISA can
search its own physical representatives in `isa.py`.

Layer 2: depends on `bits` only.
"""

from .bits import mask_of

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


class Program(object):
    """An abstract program plus how strongly it was forced.

    residual_freedom follows SPEC §9:
        0    not representable in the declared grammar
        1    the physical parameters are uniquely forced
        n>1  n solutions remain tied before canonical rank selection
    """

    __slots__ = ('ops', 'residual_freedom', 'candidates', 'solver', 'notes',
                 'input_bits', 'output_bits')

    def __init__(self, ops, residual_freedom, candidates, solver,
                 input_bits, output_bits, notes=None):
        self.ops = list(ops)
        self.residual_freedom = residual_freedom
        self.candidates = candidates
        self.solver = solver
        self.input_bits = input_bits
        self.output_bits = output_bits
        self.notes = list(notes or [])

    @property
    def classes(self):
        return [op.kind for op in self.ops]

    @property
    def core_ops(self):
        return len(self.ops)

    def evaluate(self, x):
        """Reference evaluation of the abstract program (ISA-independent)."""
        from .bits import clmul, pdep, pext
        value = x & mask_of(self.input_bits)
        for op in self.ops:
            if op.kind == 'IDENTITY':
                continue
            if op.kind == 'LIN_CONST':
                basis = op.detail['basis']
                acc = 0
                for i, image in enumerate(basis):
                    if (value >> i) & 1:
                        acc ^= image
                value = acc
            elif op.kind == 'CONV':
                const = op.detail['const']
                if op.detail['family'] == 'IMUL':
                    value = (value * const) & mask_of(64)
                else:
                    value = clmul(value, const, 64) & mask_of(64)
            elif op.kind == 'PERM_DYN':
                src = op.detail['source']
                value = (pext(src, value) if op.detail['direction'] == 'gather'
                         else pdep(src, value))
            elif op.kind == 'POINT':
                value = _eval_point(op.detail['steps'], value)
            elif op.kind == 'TABLE':
                value = op.detail['table'][value & mask_of(op.detail['input_bits'])]
            else:
                raise ValueError('cannot evaluate %r' % op.kind)
        return value & mask_of(self.output_bits)

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
    from .bits import M64, bswap64, popcnt
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
