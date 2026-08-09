"""Fixed physical lane vocabulary shared by state-step frontends."""

from . import isa
from .bits import mask_of


GENERIC_ARITY = {
    'SELECT': 3,
    'WRAP_I64': 1,
    'EXTEND_I32_S': 1,
    'EXTEND_I32_U': 1,
    'EXTEND8_S': 1,
    'EXTEND16_S': 1,
    'EXTEND32_S': 1,
    'EQZ': 1,
    'EQ': 2,
    'NE': 2,
    'LT_S': 2,
    'LT_U': 2,
    'GT_S': 2,
    'GT_U': 2,
    'LE_S': 2,
    'LE_U': 2,
    'GE_S': 2,
    'GE_U': 2,
    'MULR': 2,
    'SHLR': 2,
    'SARR': 2,
    'SHRR': 2,
    'ROTL': 2,
    'ROTR': 2,
    'DIV_S': 2,
    'DIV_U': 2,
    'REM_S': 2,
    'REM_U': 2,
    # Terminal physical forms selected while recomposing a residual SSA cut.
    # BIT/BITZ are the value and zero-observer of one dynamic bit coordinate;
    # ADD3 is the three-input form normally implemented by an address lane.
    'BIT': 2,
    'BITZ': 2,
    'BIT_MSB8': 2,
    'BIT_MSB8Z': 2,
    'ADD3': 3,
    'BEXTR': 3,
    'UMIN': 2,
    'UMAX': 2,
    'SMIN': 2,
    'SMAX': 2,
}

ISA_BINARY = {'XORR', 'ANDR', 'ORR', 'ADDR', 'ANDNR', 'SUBR'}
ISA_SHIFT = {'SHL', 'SHR', 'SCANXOR', 'SAR'}
LANE_NAMES = tuple(isa.OPCODES) + tuple(GENERIC_ARITY)
OPS = tuple('lane%d.%s' % (bits, name)
            for bits in (32, 64) for name in LANE_NAMES)


def split(operation):
    if not operation.startswith(('lane32.', 'lane64.')):
        raise ValueError('%r is not a physical lane operation' % operation)
    width, name = operation[4:].split('.', 1)
    return int(width), name


def shape(operation):
    """Return ``(SSA arity, constant count, is_shift)`` for validation."""
    bits, name = split(operation)
    if name in GENERIC_ARITY:
        return GENERIC_ARITY[name], 0, False
    from .scalarpage import (_ONE_ARGUMENT, _ONE_CONSTANT, _ONE_SHIFT,
                             _TWO_ARGUMENTS)
    arity = 1 if name in _ONE_ARGUMENT else 2 if name in _TWO_ARGUMENTS else 0
    if not arity:
        raise ValueError('%s has no physical argument shape' % operation)
    constants = -1 if name == 'LUT' else int(name in _ONE_CONSTANT)
    return arity, constants, name in _ONE_SHIFT


def select(wasm_operation, arguments):
    """Choose one physical lane primitive for a normalized Wasm node."""
    if wasm_operation == 'select':
        return 'lane64.SELECT', arguments
    kind, name = wasm_operation.split('.', 1)
    bits = 32 if kind == 'i32' else 64
    lane = 'lane%d.' % bits

    unary = {'clz': 'CLZ', 'ctz': 'CTZ', 'popcnt': 'POPCNT'}
    if name in unary:
        return lane + unary[name], arguments
    if name == 'eqz':
        return lane + 'EQZ', arguments

    immediate = {
        'add': 'ADD', 'sub': 'SUB', 'mul': 'IMUL',
        'and': 'AND', 'or': 'OR', 'xor': 'XOR',
    }
    register = {
        'add': 'ADDR', 'sub': 'SUBR', 'mul': 'MULR',
        'and': 'ANDR', 'or': 'ORR', 'xor': 'XORR',
    }
    if name in immediate:
        left, right = arguments
        if right.kind == 'const':
            return lane + immediate[name], arguments
        if name != 'sub' and left.kind == 'const':
            return lane + immediate[name], (right, left)
        return lane + register[name], arguments

    shifts = {'shl': ('SHL', 'SHLR'),
              'shr_u': ('SHR', 'SHRR'),
              'shr_s': ('SAR', 'SARR')}
    if name in shifts:
        fixed, dynamic = shifts[name]
        return lane + (fixed if arguments[1].kind == 'const' else dynamic), \
            arguments

    generic = {
        'eq': 'EQ', 'ne': 'NE',
        'lt_s': 'LT_S', 'lt_u': 'LT_U',
        'gt_s': 'GT_S', 'gt_u': 'GT_U',
        'le_s': 'LE_S', 'le_u': 'LE_U',
        'ge_s': 'GE_S', 'ge_u': 'GE_U',
        'rotl': 'ROTL', 'rotr': 'ROTR',
        'div_s': 'DIV_S', 'div_u': 'DIV_U',
        'rem_s': 'REM_S', 'rem_u': 'REM_U',
        'wrap_i64': 'WRAP_I64',
        'extend_i32_s': 'EXTEND_I32_S',
        'extend_i32_u': 'EXTEND_I32_U',
        'extend8_s': 'EXTEND8_S',
        'extend16_s': 'EXTEND16_S',
        'extend32_s': 'EXTEND32_S',
    }
    try:
        return lane + generic[name], arguments
    except KeyError:
        raise ValueError('no physical lane primitive for %s' % wasm_operation)


def evaluate(operation, arguments):
    """Execute one lane primitive with its declared publication width."""
    bits, name = split(operation)
    if name in isa.OPCODES:
        arity = 2 if name in ISA_BINARY else 1
        # A lane boundary is also its publication-width projection.  This is
        # important when QM removes an otherwise redundant i64->i32 materialize
        # node before a 32-bit consumer.
        values = tuple(value & mask_of(bits)
                       for value in arguments[:arity])
        tail = arguments[arity:]
        shift = tail[0] if name in ISA_SHIFT else 255
        constants = () if name in ISA_SHIFT else tail
        from .scalarpage import _apply
        return _apply(name, values, constants, shift, mask_of(bits)) \
            & mask_of(bits)
    if name == 'SELECT':
        left, right, condition = arguments
        return left if condition else right
    if name in ('BIT', 'BITZ'):
        value, coordinate = arguments
        bit = ((value & mask_of(bits)) >> (coordinate % bits)) & 1
        return bit if name == 'BIT' else bit ^ 1
    if name in ('BIT_MSB8', 'BIT_MSB8Z'):
        value, coordinate = arguments
        bit = ((value & mask_of(bits)) >> ((~coordinate) & 7)) & 1
        return bit if name == 'BIT_MSB8' else bit ^ 1
    if name == 'ADD3':
        return sum(value & mask_of(bits) for value in arguments) & mask_of(bits)
    if name == 'BEXTR':
        value, offset, width = arguments
        count = width % bits
        return ((value & mask_of(bits)) >> (offset % bits)) & mask_of(count)
    if name in ('UMIN', 'UMAX', 'SMIN', 'SMAX'):
        mask = mask_of(bits)
        left, right = (value & mask for value in arguments)
        if name.startswith('S'):
            sign = 1 << (bits - 1)
            left_key = left - (1 << bits) if left & sign else left
            right_key = right - (1 << bits) if right & sign else right
        else:
            left_key, right_key = left, right
        choose_left = (left_key < right_key if name.endswith('MIN')
                       else left_key > right_key)
        return left if choose_left else right

    wasm_name = {
        'WRAP_I64': 'wrap_i64',
        'EXTEND_I32_S': 'extend_i32_s',
        'EXTEND_I32_U': 'extend_i32_u',
        'EXTEND8_S': 'extend8_s',
        'EXTEND16_S': 'extend16_s',
        'EXTEND32_S': 'extend32_s',
        'EQZ': 'eqz', 'EQ': 'eq', 'NE': 'ne',
        'LT_S': 'lt_s', 'LT_U': 'lt_u',
        'GT_S': 'gt_s', 'GT_U': 'gt_u',
        'LE_S': 'le_s', 'LE_U': 'le_u',
        'GE_S': 'ge_s', 'GE_U': 'ge_u',
        'MULR': 'mul', 'SHLR': 'shl', 'SHRR': 'shr_u', 'SARR': 'shr_s',
        'ROTL': 'rotl', 'ROTR': 'rotr',
        'DIV_S': 'div_s', 'DIV_U': 'div_u',
        'REM_S': 'rem_s', 'REM_U': 'rem_u',
    }[name]
    from .wasmstate import _numeric
    stack = list(arguments)
    _numeric('i%d.%s' % (bits, wasm_name), stack)
    return stack[0]
