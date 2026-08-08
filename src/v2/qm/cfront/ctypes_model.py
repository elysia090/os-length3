"""Fixed-width integer type model for the C subset (LP64, two's complement).

The frontend has to agree with the target machine about widths, promotion and
wrapping, otherwise the extracted semantics are not the semantics of the pasted
function.  All of that lives here, in one place.

Documented choices:
    * LP64: long and long long are 64-bit, int is 32-bit, pointers are absent.
    * plain `char` is signed (x86-64 SysV).
    * signed overflow wraps two's complement.  Real C leaves it undefined; QM
      records the choice in the report instead of pretending the question does
      not exist.
    * shifting by >= the promoted width is rejected, not silently masked.
"""

from ..bits import mask_of, to_signed
from .errors import CFrontError, UnsupportedC


class CType(object):
    __slots__ = ('name', 'bits', 'signed', 'kind')

    def __init__(self, name, bits, signed, kind='int'):
        self.name = name
        self.bits = bits
        self.signed = signed
        self.kind = kind      # 'int' | 'bool' | 'void'

    def __repr__(self):
        return 'CType(%s)' % self.name

    def __eq__(self, other):
        return (isinstance(other, CType) and self.bits == other.bits
                and self.signed == other.signed and self.kind == other.kind)

    def __hash__(self):
        return hash((self.bits, self.signed, self.kind))

    @property
    def rank(self):
        return self.bits

    def to_dict(self):
        return {'name': self.name, 'bits': self.bits, 'signed': self.signed,
                'kind': self.kind}


VOID = CType('void', 0, False, 'void')
BOOL = CType('_Bool', 1, False, 'bool')
S8 = CType('int8_t', 8, True)
U8 = CType('uint8_t', 8, False)
S16 = CType('int16_t', 16, True)
U16 = CType('uint16_t', 16, False)
S32 = CType('int32_t', 32, True)
U32 = CType('uint32_t', 32, False)
S64 = CType('int64_t', 64, True)
U64 = CType('uint64_t', 64, False)
S128 = CType('__int128', 128, True)
U128 = CType('unsigned __int128', 128, False)

INT = S32

# Multiset of declaration keywords -> type.  Order-insensitive by construction.
_SPELLINGS = {
    ('void',): VOID,
    ('_Bool',): BOOL, ('bool',): BOOL,
    ('char',): CType('char', 8, True),
    ('char', 'signed'): S8, ('char', 'unsigned'): U8,
    ('short',): S16, ('int', 'short'): S16, ('short', 'signed'): S16,
    ('int', 'short', 'signed'): S16,
    ('short', 'unsigned'): U16, ('int', 'short', 'unsigned'): U16,
    ('int',): S32, ('signed',): S32, ('int', 'signed'): S32,
    ('unsigned',): U32, ('int', 'unsigned'): U32,
    ('long',): S64, ('int', 'long'): S64, ('long', 'signed'): S64,
    ('int', 'long', 'signed'): S64,
    ('long', 'unsigned'): U64, ('int', 'long', 'unsigned'): U64,
    ('long', 'long'): S64, ('int', 'long', 'long'): S64,
    ('long', 'long', 'signed'): S64, ('int', 'long', 'long', 'signed'): S64,
    ('long', 'long', 'unsigned'): U64, ('int', 'long', 'long', 'unsigned'): U64,
    ('__int128',): S128, ('__int128', 'signed'): S128,
    ('__int128', 'unsigned'): U128,
}

_TYPEDEFS = {
    'int8_t': S8, 'uint8_t': U8,
    'int16_t': S16, 'uint16_t': U16,
    'int32_t': S32, 'uint32_t': U32,
    'int64_t': S64, 'uint64_t': U64,
    'int_fast8_t': S8, 'uint_fast8_t': U8,
    'int_fast16_t': S64, 'uint_fast16_t': U64,
    'int_fast32_t': S64, 'uint_fast32_t': U64,
    'int_fast64_t': S64, 'uint_fast64_t': U64,
    'int_least8_t': S8, 'uint_least8_t': U8,
    'int_least16_t': S16, 'uint_least16_t': U16,
    'int_least32_t': S32, 'uint_least32_t': U32,
    'int_least64_t': S64, 'uint_least64_t': U64,
    'intmax_t': S64, 'uintmax_t': U64,
    'intptr_t': S64, 'uintptr_t': U64,
    'size_t': U64, 'ssize_t': S64, 'ptrdiff_t': S64,
    '__uint128_t': U128, '__int128_t': S128,
    # An __m128i is a 128-bit value here.  That is exactly what it is for the
    # carry-less multiply idiom, which is the part of SSE this subset models.
    '__m128i': U128,
    'u8': U8, 'u16': U16, 'u32': U32, 'u64': U64,
    'i8': S8, 'i16': S16, 'i32': S32, 'i64': S64,
}

REJECTED_TYPES = {'float', 'double', 'struct', 'union', 'enum'}


def is_type_name(word):
    return word in _TYPEDEFS or (word,) in _SPELLINGS or word in (
        'signed', 'unsigned', 'long', 'short', 'int', 'char', 'void',
        '_Bool', 'bool', '__int128',
    )


def type_from_keywords(words, line=None):
    """Resolve a declaration specifier list to a CType."""
    for w in words:
        if w in REJECTED_TYPES:
            raise UnsupportedC(
                'type %r is outside the bit-vector subset' % w, line=line,
                hint='QM models fixed-width integer and bit-vector kernels')
    named = [w for w in words if w in _TYPEDEFS]
    if named:
        if len(words) != len(named):
            extra = [w for w in words if w not in _TYPEDEFS]
            raise CFrontError('cannot combine %r with %r' % (named[0], extra),
                              line=line)
        if len(named) > 1:
            raise CFrontError('conflicting type names %r' % (named,), line=line)
        return _TYPEDEFS[named[0]]

    key = tuple(sorted(words))
    if key in _SPELLINGS:
        return _SPELLINGS[key]
    raise CFrontError('unknown type specifier %r' % (' '.join(words),), line=line)


# ---------------------------------------------------------------------------
# Value conversion and arithmetic
# ---------------------------------------------------------------------------

def convert(value, ctype):
    """Convert an integer to `ctype`, wrapping two's complement."""
    if ctype.kind == 'bool':
        return 1 if value else 0
    if ctype.kind == 'void':
        return 0
    v = value & mask_of(ctype.bits)
    return to_signed(v, ctype.bits) if ctype.signed else v


def promote(ctype):
    """Integer promotion: anything narrower than int becomes int."""
    if ctype.kind == 'void':
        return ctype
    if ctype.bits < 32:
        return INT
    return ctype


def usual_arithmetic(a, b):
    """Usual arithmetic conversions on two promoted operand types."""
    a = promote(a)
    b = promote(b)
    if a == b:
        return a
    if a.signed == b.signed:
        return a if a.bits >= b.bits else b
    us, sg = (a, b) if not a.signed else (b, a)
    if us.bits >= sg.bits:
        return us
    if sg.bits > us.bits:
        return sg
    return CType('unsigned ' + sg.name, sg.bits, False)


def truncdiv(a, b):
    """C division truncates toward zero."""
    q = abs(a) // abs(b)
    return -q if (a < 0) != (b < 0) else q


def binary_op(op, lhs, lt, rhs, rt, line=None):
    """Evaluate a binary operator, returning (value, type)."""
    if op in ('<<', '>>'):
        rtype = promote(lt)
        count = rhs
        if count < 0 or count >= rtype.bits:
            raise CFrontError(
                'shift count %d is undefined for a %d-bit operand'
                % (count, rtype.bits), line=line,
                hint='mask or widen the operand so the shift stays in range')
        value = convert(lhs, rtype)
        if op == '<<':
            return convert(value << count, rtype), rtype
        if rtype.signed and value < 0:
            return convert(value >> count, rtype), rtype   # arithmetic shift
        return convert((value & mask_of(rtype.bits)) >> count, rtype), rtype

    if op in ('==', '!=', '<', '<=', '>', '>='):
        ct = usual_arithmetic(lt, rt)
        a = convert(lhs, ct)
        b = convert(rhs, ct)
        res = {
            '==': a == b, '!=': a != b, '<': a < b,
            '<=': a <= b, '>': a > b, '>=': a >= b,
        }[op]
        return (1 if res else 0), INT

    ct = usual_arithmetic(lt, rt)
    a = convert(lhs, ct)
    b = convert(rhs, ct)

    if op == '+':
        r = a + b
    elif op == '-':
        r = a - b
    elif op == '*':
        r = a * b
    elif op == '/':
        if b == 0:
            raise CFrontError('division by zero', line=line)
        r = truncdiv(a, b)
    elif op == '%':
        if b == 0:
            raise CFrontError('remainder by zero', line=line)
        r = a - truncdiv(a, b) * b
    elif op == '&':
        r = (a & mask_of(ct.bits)) & (b & mask_of(ct.bits))
    elif op == '|':
        r = (a & mask_of(ct.bits)) | (b & mask_of(ct.bits))
    elif op == '^':
        r = (a & mask_of(ct.bits)) ^ (b & mask_of(ct.bits))
    else:
        raise CFrontError('unsupported binary operator %r' % op, line=line)

    return convert(r, ct), ct


def unary_op(op, value, vtype, line=None):
    if op == '-':
        t = promote(vtype)
        return convert(-convert(value, t), t), t
    if op == '+':
        t = promote(vtype)
        return convert(value, t), t
    if op == '~':
        t = promote(vtype)
        return convert(~convert(value, t), t), t
    if op == '!':
        return (0 if value else 1), INT
    raise CFrontError('unsupported unary operator %r' % op, line=line)
