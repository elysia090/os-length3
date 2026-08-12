"""Fixed physical lane vocabulary shared by state-step frontends."""

from . import isa
from .bits import clz, ctz, mask_of, popcnt, sar, to_signed


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

ISA_BINARY = {'XORR', 'ANDR', 'ORR', 'ADDR', 'ANDNR', 'SUBR', 'CLMULR'}
ISA_SHIFT = {'SHL', 'SHR', 'SCANXOR', 'SAR', 'ROL32', 'ROR32'}
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
    if name == 'X86_FLAGS':
        return 5, 0, False
    if name == 'X86_COMPARE':
        return 4, 0, False
    if name == 'X86_SHIFT_FLAGS':
        return 5, 0, False
    if name == 'X86_CONDITION':
        return 2, 0, False
    if name == 'X86_TEST':
        return 4, 0, False
    if name == 'X86_TEST_CONDITION':
        return 3, 0, False
    if name == 'ADD3_U32':
        return 3, 0, False
    if name == 'X86_BIT_FLAGS':
        return 4, 0, False
    if name == 'INSERT':
        return 3, 0, False
    if name == 'X86_FLAGS_SELECT':
        return 11, 0, False
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

    unary = {
        'clz': 'CLZ', 'ctz': 'CTZ', 'popcnt': 'POPCNT',
        'bswap': 'BSWAP',
    }
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
    if name == 'ADD3_U32':
        left, unsigned32, right = arguments
        return (int(left) + (int(unsigned32) & 0xffffffff)
                + int(right)) & mask_of(bits)
    if name == 'INSERT':
        base, value, descriptor = map(int, arguments)
        width = descriptor & 0xff
        offset = (descriptor >> 8) & 0xff
        if not width or width > bits or offset + width > bits:
            raise ValueError('insert lane has an invalid bit field')
        field = mask_of(width)
        selected = field << offset
        return ((base & ~selected) | ((value & field) << offset)) \
            & mask_of(bits)
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
    if name == 'X86_FLAGS_SELECT':
        selected = arguments[:5] if arguments[10] else arguments[5:10]
        return evaluate('lane64.X86_FLAGS', selected)
    if name == 'X86_COMPARE':
        prior, left, right, descriptor = arguments
        width = int(descriptor) & 0x7f
        result = (int(left) - int(right)) & mask_of(width)
        return evaluate('lane64.X86_FLAGS', (
            prior, left, right, result, descriptor))
    if name == 'X86_SHIFT_FLAGS':
        prior, source, result, amount, descriptor = map(int, arguments)
        width = descriptor & 0x7f
        if width not in (8, 16, 32, 64):
            raise ValueError('x86 shift flag lane has an invalid width')
        group = (descriptor >> 8) & 7
        if group not in (0, 1, 4, 5, 7):
            raise ValueError('x86 shift flag lane has an invalid group')
        amount &= width - 1
        if not amount:
            return prior & mask_of(bits)
        lane_mask = mask_of(width)
        source &= lane_mask
        result &= lane_mask
        if group == 0:
            carry = result & 1
        elif group == 1:
            carry = (result >> (width - 1)) & 1
        elif group == 4:
            carry = (source >> (width - amount)) & 1
        else:
            carry = (source >> (amount - 1)) & 1
        flags = (prior if group in (0, 1) else
                 evaluate('lane64.X86_FLAGS', (
                     prior, result, 0, result, width)))
        flags = (flags & ~1) | carry
        overflow = 0
        if amount == 1:
            if group in (0, 4):
                overflow = ((result >> (width - 1)) ^ carry) & 1
            elif group == 1:
                overflow = ((result >> (width - 1))
                            ^ (result >> (width - 2))) & 1
            elif group == 5:
                overflow = (source >> (width - 1)) & 1
        flags = (flags & ~(1 << 11)) | (overflow << 11)
        return flags & mask_of(bits)
    if name == 'X86_CONDITION':
        flags, code = map(int, arguments)
        carry = (flags >> 0) & 1
        parity = (flags >> 2) & 1
        zero = (flags >> 6) & 1
        sign = (flags >> 7) & 1
        overflow = (flags >> 11) & 1
        signed_less = sign ^ overflow
        return (
            overflow, overflow ^ 1, carry, carry ^ 1,
            zero, zero ^ 1, carry | zero, (carry | zero) ^ 1,
            sign, sign ^ 1, parity, parity ^ 1,
            signed_less, signed_less ^ 1, zero | signed_less,
            (zero | signed_less) ^ 1,
        )[code & 15]
    if name == 'X86_TEST':
        prior, left, right, descriptor = arguments
        width = int(descriptor) & 0x7f
        if width not in (8, 16, 32, 64) or int(descriptor) != width:
            raise ValueError('x86 test lane has an invalid width')
        result = (int(left) & int(right)) & mask_of(width)
        return evaluate('lane64.X86_FLAGS', (
            prior, left, right, result, descriptor))
    if name == 'X86_TEST_CONDITION':
        left, right, descriptor = map(int, arguments)
        width = descriptor & 0x7f
        condition = (descriptor >> 8) & 15
        if (width not in (8, 16, 32, 64)
                or descriptor != width | (condition << 8)):
            raise ValueError('x86 test condition lane has an invalid descriptor')
        flags = evaluate('lane64.X86_TEST', (0, left, right, width))
        return evaluate('lane64.X86_CONDITION', (flags, condition))
    if name == 'X86_BIT_FLAGS':
        prior, value, index, descriptor = map(int, arguments)
        width = descriptor & 0x7f
        if width not in (16, 32, 64) or descriptor != width:
            raise ValueError('x86 bit flag lane has an invalid width')
        carry = ((value & mask_of(width)) >> (index & (width - 1))) & 1
        return ((prior & ~1) | carry | 2) & mask_of(bits)
    if name == 'X86_FLAGS':
        prior, left, right, result, descriptor = arguments
        width = int(descriptor) & 0x7f
        if width not in (8, 16, 32, 64):
            raise ValueError('x86 flag lane has an invalid width')
        mode = (int(descriptor) >> 8) & 7
        preserve_carry = bool(int(descriptor) & (1 << 11))
        lane_mask = mask_of(width)
        sign = 1 << (width - 1)
        left, right, result = (value & lane_mask
                               for value in (left, right, result))
        carry_in = int(bool(prior & 1)) if mode in (2, 4) else 0
        flags = prior & ~0x8c5
        carry = bool(prior & 1) if preserve_carry else False
        if not preserve_carry:
            if mode in (1, 2):
                carry = left + right + carry_in > lane_mask
            elif mode in (3, 4):
                carry = left < right + carry_in
        if carry:
            flags |= 1
        if (result & 0xff).bit_count() % 2 == 0:
            flags |= 1 << 2
        if result == 0:
            flags |= 1 << 6
        if result & sign:
            flags |= 1 << 7
        if mode in (1, 2):
            overflow = not ((left ^ right) & sign) \
                and bool((left ^ result) & sign)
        elif mode in (3, 4):
            overflow = bool((left ^ right) & sign) \
                and bool((left ^ result) & sign)
        else:
            overflow = False
        if overflow:
            flags |= 1 << 11
        return (flags | 2) & mask_of(bits)

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


def bind(operation):
    """Bind a physical opcode and publication width once per mapped page.

    The returned lane has the same semantics as :func:`evaluate`, but common
    normalized forms do not re-enter the string decoder or Wasm operand-stack
    interpreter on every execution.  Trap-bearing and uncommon primitives
    deliberately retain the reference evaluator.
    """
    bits, name = split(operation)
    mask = mask_of(bits)

    if name == 'ADD':
        return lambda values: (values[0] + values[1]) & mask
    if name == 'SUB':
        return lambda values: (values[0] - values[1]) & mask
    if name == 'IMUL':
        return lambda values: (values[0] * values[1]) & mask
    if name == 'AND':
        return lambda values: (values[0] & values[1]) & mask
    if name == 'OR':
        return lambda values: (values[0] | values[1]) & mask
    if name == 'XOR':
        return lambda values: (values[0] ^ values[1]) & mask
    if name == 'NOT':
        return lambda values: ~values[0] & mask
    if name == 'NEG':
        return lambda values: -values[0] & mask
    if name == 'SHL':
        return lambda values: (values[0] << values[1]) & mask
    if name == 'SHR':
        return lambda values: (values[0] & mask) >> values[1]
    if name == 'SAR':
        return lambda values: sar(values[0], values[1], bits)
    if name == 'SCANXOR':
        return lambda values: (values[0] ^ (values[0] << values[1])) & mask
    if name == 'CLMULR':
        from .bits import clmul
        return lambda values: clmul(values[0], values[1], bits) & mask
    if name == 'ROL32':
        return lambda values: (((values[0] & 0xFFFFFFFF) << values[1]) |
                               ((values[0] & 0xFFFFFFFF) >>
                                (32 - values[1]))) & 0xFFFFFFFF
    if name == 'ROR32':
        return lambda values: (((values[0] & 0xFFFFFFFF) >> values[1]) |
                               ((values[0] & 0xFFFFFFFF) <<
                                (32 - values[1]))) & 0xFFFFFFFF
    if name == 'CLZ':
        return lambda values: clz(values[0], bits)
    if name == 'CTZ':
        return lambda values: ctz(values[0], bits)
    if name == 'POPCNT':
        return lambda values: popcnt(values[0] & mask)

    if name == 'ADDR':
        return lambda values: (values[0] + values[1]) & mask
    if name == 'SUBR':
        return lambda values: (values[0] - values[1]) & mask
    if name == 'ANDR':
        return lambda values: (values[0] & values[1]) & mask
    if name == 'ORR':
        return lambda values: (values[0] | values[1]) & mask
    if name == 'XORR':
        return lambda values: (values[0] ^ values[1]) & mask
    if name == 'ANDNR':
        return lambda values: (~values[0] & values[1]) & mask

    if name == 'SELECT':
        return lambda values: values[0] if values[2] else values[1]
    if name == 'WRAP_I64':
        return lambda values: values[0] & mask_of(32)
    if name == 'EXTEND_I32_U':
        return lambda values: values[0] & mask_of(32)
    if name == 'EXTEND_I32_S':
        return lambda values: to_signed(values[0], 32) & mask
    if name in ('EXTEND8_S', 'EXTEND16_S', 'EXTEND32_S'):
        width = int(name[len('EXTEND'):-len('_S')])
        return lambda values: to_signed(values[0], width) & mask
    if name == 'EQZ':
        return lambda values: int((values[0] & mask) == 0)

    relations = {
        'EQ': lambda left, right: left == right,
        'NE': lambda left, right: left != right,
        'LT_U': lambda left, right: left < right,
        'GT_U': lambda left, right: left > right,
        'LE_U': lambda left, right: left <= right,
        'GE_U': lambda left, right: left >= right,
    }
    if name in relations:
        relation = relations[name]
        return lambda values: int(relation(values[0] & mask,
                                           values[1] & mask))
    signed_relations = {
        'LT_S': lambda left, right: left < right,
        'GT_S': lambda left, right: left > right,
        'LE_S': lambda left, right: left <= right,
        'GE_S': lambda left, right: left >= right,
    }
    if name in signed_relations:
        relation = signed_relations[name]
        return lambda values: int(relation(to_signed(values[0], bits),
                                           to_signed(values[1], bits)))

    if name == 'MULR':
        return lambda values: (values[0] * values[1]) & mask
    if name == 'SHLR':
        return lambda values: ((values[0] & mask)
                               << ((values[1] & mask) % bits)) & mask
    if name == 'SHRR':
        return lambda values: ((values[0] & mask)
                               >> ((values[1] & mask) % bits))
    if name == 'SARR':
        return lambda values: sar(values[0],
                                  (values[1] & mask) % bits, bits)
    if name in ('ROTL', 'ROTR'):
        left = name == 'ROTL'

        def rotate(values):
            value = values[0] & mask
            count = (values[1] & mask) % bits
            if not count:
                return value
            if left:
                return ((value << count) | (value >> (bits - count))) & mask
            return ((value >> count) | (value << (bits - count))) & mask

        return rotate

    if name in ('BIT', 'BITZ'):
        invert = name == 'BITZ'
        return lambda values: ((((values[0] & mask)
                                 >> (values[1] % bits)) & 1) ^ invert)
    if name in ('BIT_MSB8', 'BIT_MSB8Z'):
        invert = name == 'BIT_MSB8Z'
        return lambda values: ((((values[0] & mask)
                                 >> ((~values[1]) & 7)) & 1) ^ invert)
    if name == 'ADD3':
        return lambda values: sum(value & mask for value in values) & mask
    if name == 'BEXTR':
        return lambda values: (((values[0] & mask)
                                >> (values[1] % bits))
                               & mask_of(values[2] % bits))
    if name in ('UMIN', 'UMAX'):
        choose = min if name == 'UMIN' else max
        return lambda values: choose(values[0] & mask, values[1] & mask)
    if name in ('SMIN', 'SMAX'):
        choose = min if name == 'SMIN' else max
        return lambda values: choose(to_signed(values[0], bits),
                                     to_signed(values[1], bits)) & mask
    if name in ('X86_FLAGS', 'X86_FLAGS_SELECT', 'X86_COMPARE',
                'X86_SHIFT_FLAGS', 'X86_CONDITION', 'X86_TEST',
                'X86_BIT_FLAGS'):
        return lambda values: evaluate(operation, values)

    return lambda values: evaluate(operation, values)
