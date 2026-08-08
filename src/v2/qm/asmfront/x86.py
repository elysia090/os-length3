"""Read an x86-64 function in AT&T syntax and evaluate it.

The 64-bit integer subset a small kernel uses: moves, the ALU, shifts, IMUL,
BSWAP, POPCNT, the BMI2 deposit/extract pair, and the carry-less multiply
through XMM. That covers everything QM emits, which is what lets a round trip
through assembly be checked for a fixed point.

This is not an x86 interpreter. It says so when it meets an instruction it does
not model, rather than guessing — a wrong evaluation here would be a wrong
semantics, and every claim downstream rests on it.

SysV: the argument arrives in %rdi and the result leaves in %rax.
"""

import re

from ..bits import M64, bswap64, clmul, mask_of, pdep, pext, popcnt
from ..cfront.errors import CFrontError, UnsupportedC

ARG_REGISTER = '%rdi'
RESULT_REGISTER = '%rax'

# A listing does not say how wide its input was meant to be — %rdi is 64 bits
# whatever the kernel intended — so QM writes the width down when it emits one.
INPUT_BITS = re.compile(r'qm-input-bits:\s*(\d+)')


def declared_input_bits(text):
    """The width QM recorded when it emitted this listing, if it did."""
    match = INPUT_BITS.search(text)
    return int(match.group(1)) if match else None

_LABEL = re.compile(r'^([\w.$]+):')
_GLOBL = re.compile(r'^\s*\.(?:globl|global)\s+([\w.$]+)')
_SIZES = {'q': 64, 'l': 32, 'w': 16, 'b': 8}

_SUB_REGISTERS = {
    '%eax': '%rax', '%ebx': '%rbx', '%ecx': '%rcx', '%edx': '%rdx',
    '%esi': '%rsi', '%edi': '%rdi', '%ebp': '%rbp', '%esp': '%rsp',
    '%r8d': '%r8', '%r9d': '%r9', '%r10d': '%r10', '%r11d': '%r11',
    '%r12d': '%r12', '%r13d': '%r13', '%r14d': '%r14', '%r15d': '%r15',
    '%ax': '%rax', '%cx': '%rcx', '%dx': '%rdx', '%si': '%rsi', '%di': '%rdi',
    '%al': '%rax', '%cl': '%rcx', '%dl': '%rdx',
}


class X86Function(object):
    __slots__ = ('name', 'instructions', '_steps')

    def __init__(self, name, instructions):
        self.name = name
        self.instructions = instructions
        self._steps = None

    def __call__(self, value):
        return evaluate(self, value)


def looks_like_x86(text):
    if '%rdi' in text or '%rax' in text or '%eax' in text:
        return True
    return bool(re.search(r'^\s*(mov|imul|and|or|xor|shl|shr|pdep|pext)[qlwb]?\s',
                          text, re.M))


def parse(text, requested=None):
    """Parse one function body out of an AT&T listing."""
    name = None
    wanted = requested
    collecting = False
    instructions = []
    declared = []

    for raw in text.splitlines():
        line = raw.split('#')[0].split('//')[0].rstrip()
        if not line.strip():
            continue

        exported = _GLOBL.match(line)
        if exported:
            declared.append(exported.group(1))
            continue

        label = _LABEL.match(line.strip())
        if label:
            candidate = label.group(1)
            if candidate.startswith('.L'):
                raise UnsupportedC(
                    'the listing branches (%s); this reader is straight-line'
                    % candidate,
                    hint='QM extracts semantics by evaluation, and a branch '
                         'needs a control-flow model this reader does not have')
            if collecting:
                break                       # the next symbol ends this one
            if wanted is None or candidate == wanted:
                name = candidate
                collecting = True
            continue

        stripped = line.strip()
        if stripped.startswith('.'):
            if collecting and stripped.startswith('.size'):
                break
            continue
        if not collecting:
            continue

        parts = stripped.split(None, 1)
        mnemonic = parts[0].lower()
        operands = _split_operands(parts[1]) if len(parts) > 1 else []
        if mnemonic in ('ret', 'retq'):
            break
        instructions.append((mnemonic, operands))

    if name is None:
        name = declared[0] if declared else None
    if name is None or not instructions:
        raise CFrontError('no x86-64 function body found',
                          hint='the listing needs a `name:` label followed by '
                               'instructions')
    return X86Function(name, instructions)


def _split_operands(text):
    out = []
    depth = 0
    current = ''
    for ch in text:
        if ch == ',' and depth == 0:
            out.append(current.strip())
            current = ''
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        current += ch
    if current.strip():
        out.append(current.strip())
    return out


# Operand text and mnemonic spelling do not change between inputs, but a
# domain sweep re-reads them once per input.  Both are pure functions of a
# string, so the answers are kept.
_IMMEDIATES = {}
_SUFFIXES = {}


def _immediate(token):
    value = _IMMEDIATES.get(token)
    if value is None:
        body = token[1:].strip()
        negative = body.startswith('-')
        if negative:
            body = body[1:]
        value = int(body, 16) if body[:2].lower() == '0x' else int(body, 10)
        value = _IMMEDIATES[token] = (-value if negative else value) & M64
    return value


def _canonical(register):
    return _SUB_REGISTERS.get(register, register)


# A listing is straight-line, so which registers an instruction touches and
# what its immediates are do not depend on the input — but a domain sweep asks
# 65,536 times.  Each instruction is resolved once, here, into a closure over
# the machine state, and the sweep runs the closures.  `evaluate` runs the same
# list, so there is one implementation and not a fast path beside a reference
# one.

XMM = mask_of(128)


def steps_of(function):
    """The compiled steps of `function`, built once and cached on it."""
    steps = function._steps
    if steps is None or len(steps) != len(function.instructions):
        steps = function._steps = [_compile_step(mnemonic, operands)
                                   for mnemonic, operands
                                   in function.instructions]
    return steps


def compile_function(function):
    """A callable `x -> y` for one parsed listing."""
    steps = steps_of(function)

    def evaluate_one(argument):
        registers = {ARG_REGISTER: argument & M64}
        xmm = {}
        for step in steps:
            step(registers, xmm)
        return registers.get(RESULT_REGISTER, 0) & M64

    return evaluate_one


def evaluate(function, argument):
    """Run the body with `argument` in %rdi, returning %rax."""
    registers = {ARG_REGISTER: argument & M64}
    xmm = {}
    for step in steps_of(function):
        step(registers, xmm)
    return registers.get(RESULT_REGISTER, 0) & M64


def _reader(token):
    """Resolve a source operand to `(registers, xmm) -> value`."""
    if token.startswith('$'):
        value = _immediate(token)
        return lambda registers, xmm: value
    if token.startswith('%xmm'):
        return lambda registers, xmm: xmm.get(token, 0)
    if token.startswith('%'):
        full = _canonical(token)
        return lambda registers, xmm: registers.get(full, 0)
    raise UnsupportedC('memory operand %r is not modelled' % token,
                       hint='this reader evaluates register-only code')


def _writer(token):
    """Resolve a destination operand to `(registers, xmm, value) -> None`."""
    if token.startswith('%xmm'):
        def to_xmm(registers, xmm, value):
            xmm[token] = value & XMM
        return to_xmm
    if not token.startswith('%'):
        raise UnsupportedC('memory operand %r is not modelled' % token)
    full = _canonical(token)
    # A 32-bit destination zero-extends, which is how these listings keep the
    # upper half clean; anything narrower merges.
    if token in _SUB_REGISTERS and token.endswith(('d', 'x', 'i', 'p')) \
            and token != full:
        width = 32 if (token.startswith('%e') or token.endswith('d')) else 16
        if width == 32:
            low = mask_of(32)

            def zero_extend(registers, xmm, value):
                registers[full] = value & low
            return zero_extend
        low = mask_of(width)
        keep = ~low

        def merge(registers, xmm, value):
            registers[full] = (registers.get(full, 0) & keep) | (value & low)
        return merge

    def to_register(registers, xmm, value):
        registers[full] = value & M64
    return to_register


_ALU = {'and': lambda a, b: a & b, 'or': lambda a, b: a | b,
        'xor': lambda a, b: a ^ b, 'add': lambda a, b: a + b,
        'sub': lambda a, b: a - b}


def _compile_step(mnemonic, operands):
    """Resolve one instruction to a `(registers, xmm) -> None` step."""
    base, width = _strip_suffix(mnemonic)
    mask = mask_of(width)

    if base in ('mov', 'movabs', 'movzx', 'movz'):
        src, dst = _reader(operands[0]), _writer(operands[1])
        return lambda r, x: dst(r, x, src(r, x) & mask)

    if base in _ALU:
        fn = _ALU[base]
        right, left = _reader(operands[0]), _reader(operands[1])
        dst = _writer(operands[1])
        return lambda r, x: dst(r, x, fn(left(r, x) & mask,
                                         right(r, x) & mask) & mask)

    if base == 'imul':
        if len(operands) == 3:
            a, b = _reader(operands[0]), _reader(operands[1])
            dst = _writer(operands[2])
        else:
            a, b = _reader(operands[1]), _reader(operands[0])
            dst = _writer(operands[1])
        return lambda r, x: dst(r, x, (a(r, x) * b(r, x)) & mask)

    if base == 'not':
        src, dst = _reader(operands[0]), _writer(operands[0])
        return lambda r, x: dst(r, x, (~src(r, x)) & mask)

    if base == 'neg':
        src, dst = _reader(operands[0]), _writer(operands[0])
        return lambda r, x: dst(r, x, (-src(r, x)) & mask)

    if base in ('shl', 'sal', 'shr', 'sar'):
        count = _reader(operands[0]) if len(operands) == 2 else None
        target = operands[-1]
        src, dst = _reader(target), _writer(target)
        if base in ('shl', 'sal'):
            def shift(r, x):
                n = count(r, x) % width if count else 1
                dst(r, x, ((src(r, x) & mask) << n) & mask)
        elif base == 'shr':
            def shift(r, x):
                n = count(r, x) % width if count else 1
                dst(r, x, ((src(r, x) & mask) >> n) & mask)
        else:
            top = 1 << (width - 1)
            modulus = 1 << width

            def shift(r, x):
                n = count(r, x) % width if count else 1
                value = src(r, x) & mask
                if value & top:
                    value -= modulus
                dst(r, x, (value >> n) & mask)
        return shift

    if base == 'bswap':
        src, dst = _reader(operands[0]), _writer(operands[0])
        if width == 64:
            return lambda r, x: dst(r, x, bswap64(src(r, x)))
        size = width // 8
        return lambda r, x: dst(r, x, int.from_bytes(
            (src(r, x) & mask).to_bytes(size, 'little'), 'big'))

    if base in ('popcnt', 'lzcnt', 'tzcnt'):
        src, dst = _reader(operands[0]), _writer(operands[1])
        if base == 'popcnt':
            return lambda r, x: dst(r, x, popcnt(src(r, x) & mask))
        if base == 'lzcnt':
            return lambda r, x: dst(r, x, width - (src(r, x) & mask).bit_length())

        def trailing(r, x):
            value = src(r, x) & mask
            dst(r, x, width if value == 0 else (value & -value).bit_length() - 1)
        return trailing

    if base in ('pdep', 'pext'):
        # AT&T reverses Intel: pdep mask, src, dst.
        select = _reader(operands[0])
        source = _reader(operands[1])
        dst = _writer(operands[2])
        fn = pdep if base == 'pdep' else pext
        return lambda r, x: dst(r, x, fn(source(r, x) & M64,
                                         select(r, x) & M64))

    if base == 'pclmulqdq':
        selector = (_immediate(operands[0])
                    if operands[0].startswith('$') else 0)
        left, right = _reader(operands[1]), _reader(operands[2])
        dst = _writer(operands[2])
        high_a = bool(selector & 1)
        high_b = bool(selector & 0x10)

        def carryless(r, x):
            lv, rv = left(r, x), right(r, x)
            a = (rv >> 64) if high_a else (rv & M64)
            b = (lv >> 64) if high_b else (lv & M64)
            dst(r, x, clmul(a, b, 64) & XMM)
        return carryless

    if base in ('nop', 'endbr64', 'hlt'):
        return lambda r, x: None

    raise UnsupportedC('x86 instruction %r is not modelled' % mnemonic,
                       hint='this reader covers the 64-bit integer subset a '
                            'small kernel compiles to')


def _strip_suffix(mnemonic):
    """Split `andq` into ('and', 64); default to 64 bits."""
    split = _SUFFIXES.get(mnemonic)
    if split is None:
        split = _SUFFIXES[mnemonic] = _split_suffix(mnemonic)
    return split


def _split_suffix(mnemonic):
    if mnemonic in ('pdep', 'pext', 'pclmulqdq', 'nop', 'endbr64', 'hlt'):
        return mnemonic, 64
    if len(mnemonic) > 2 and mnemonic[-1] in _SIZES:
        stem = mnemonic[:-1]
        if stem in ('mov', 'movabs', 'and', 'or', 'xor', 'add', 'sub', 'imul',
                    'not', 'neg', 'shl', 'sal', 'shr', 'sar', 'bswap',
                    'popcnt', 'lzcnt', 'tzcnt', 'movz', 'movzx', 'ret'):
            return stem, _SIZES[mnemonic[-1]]
    return mnemonic, 64
