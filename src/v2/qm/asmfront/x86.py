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

from .. import straightline
from ..bits import M64, bswap64, clmul, mask_of, pdep, pext, popcnt


def _to_signed(value, bits):
    top = 1 << (bits - 1)
    return value - (1 << bits) if value & top else value


def _trailing_zeros(value, bits):
    return bits if value == 0 else (value & -value).bit_length() - 1
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
                if candidate.startswith('.Lfunc_end') and collecting:
                    break
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

        parts = stripped.split(None, 2)
        mnemonic = parts[0].lower()
        operand_text = ' '.join(parts[1:])
        # Clang writes the TZCNT encoding as `rep bsf` when it wants assembly
        # accepted by older assemblers.  It is one instruction and the
        # frontend candidate is still verified on the declared domain.
        if mnemonic in ('rep', 'repz') and len(parts) > 1:
            mnemonic = parts[1].lower()
            operand_text = parts[2] if len(parts) > 2 else ''
            base, width = _strip_suffix(mnemonic)
            if base == 'bsf':
                mnemonic = 'tzcnt' + ({8: 'b', 16: 'w', 32: 'l', 64: 'q'}[width])
        operands = _split_operands(operand_text) if operand_text else []
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


# A listing is straight-line, so which registers an instruction touches and what
# its immediates are do not depend on the input — but a domain sweep asks 65,536
# times.  The registers are traced once at compile time and the listing comes
# out as one Python function in SSA form, with a variable per written value.
# `evaluate` calls the same function, so there is one implementation and not a
# fast path beside a reference one.

XMM = mask_of(128)

_ENV = {'M': M64, 'pdep': pdep, 'pext': pext, 'clmul': clmul,
        'popcnt': popcnt, 'bswap64': bswap64, 'signed': _to_signed,
        'ctz': _trailing_zeros}

_ALU = {'and': '&', 'or': '|', 'xor': '^', 'add': '+', 'sub': '-'}


class _State(object):
    """Where each register's current value lives, as source text."""

    def __init__(self, body):
        self.body = body
        self.names = {ARG_REGISTER: 'x & M'}
        self.temp = 0
        body.append(('r_arg', 'x & M'))
        self.names[ARG_REGISTER] = 'r_arg'

    def read(self, token):
        if token.startswith('$'):
            return '0x%X' % _immediate(token)
        if token.startswith('%xmm'):
            return self.names.get(token, '0')
        if token.startswith('%'):
            return self.names.get(_canonical(token), '0')
        raise UnsupportedC('memory operand %r is not modelled' % token,
                           hint='this reader evaluates register-only code')

    def emit(self, expression):
        self.temp += 1
        name = 't%d' % self.temp
        self.body.append((name, expression))
        return name

    def write(self, token, expression):
        if token.startswith('%xmm'):
            self.names[token] = self.emit('(%s) & 0x%X' % (expression, XMM))
            return
        if not token.startswith('%'):
            raise UnsupportedC('memory operand %r is not modelled' % token)
        full = _canonical(token)
        # A 32-bit destination zero-extends, which is how these listings keep
        # the upper half clean; anything narrower merges.
        if token in _SUB_REGISTERS and token.endswith(('d', 'x', 'i', 'p')) \
                and token != full:
            width = 32 if (token.startswith('%e') or token.endswith('d')) else 16
            if width == 32:
                self.names[full] = self.emit('(%s) & 0x%X'
                                             % (expression, mask_of(32)))
                return
            low = mask_of(width)
            previous = self.names.get(full, '0')
            self.names[full] = self.emit(
                '((%s) & ~0x%X) | ((%s) & 0x%X)'
                % (previous, low, expression, low))
            return
        self.names[full] = self.emit('(%s) & M' % expression)


def _build(function):
    body = []
    state = _State(body)
    for mnemonic, operands in function.instructions:
        _emit_instruction(state, mnemonic, operands)
    result = state.names.get(RESULT_REGISTER, '0')
    return straightline.build('qm_x86', ['x'], body,
                              '(%s) & M' % result, _ENV)


def _emit_instruction(state, mnemonic, operands):
    base, width = _strip_suffix(mnemonic)
    mask = '0x%X' % mask_of(width)
    read = state.read

    if base in ('mov', 'movabs', 'movzx', 'movz'):
        state.write(operands[1], '(%s) & %s' % (read(operands[0]), mask))
        return
    if base in _ALU:
        state.write(operands[1], '(((%s) & %s) %s ((%s) & %s)) & %s'
                    % (read(operands[1]), mask, _ALU[base],
                       read(operands[0]), mask, mask))
        return
    if base == 'imul':
        if len(operands) == 3:
            state.write(operands[2], '((%s) * (%s)) & %s'
                        % (read(operands[0]), read(operands[1]), mask))
        else:
            state.write(operands[1], '((%s) * (%s)) & %s'
                        % (read(operands[1]), read(operands[0]), mask))
        return
    if base == 'not':
        state.write(operands[0], '(~(%s)) & %s' % (read(operands[0]), mask))
        return
    if base == 'neg':
        state.write(operands[0], '(-(%s)) & %s' % (read(operands[0]), mask))
        return
    if base in ('shl', 'sal', 'shr', 'sar'):
        count = ('((%s) %% %d)' % (read(operands[0]), width)
                 if len(operands) == 2 else '1')
        target = operands[-1]
        value = '((%s) & %s)' % (read(target), mask)
        if base in ('shl', 'sal'):
            state.write(target, '(%s << %s) & %s' % (value, count, mask))
        elif base == 'shr':
            state.write(target, '(%s >> %s) & %s' % (value, count, mask))
        else:
            state.write(target, '(signed(%s, %d) >> %s) & %s'
                        % (value, width, count, mask))
        return
    if base == 'bswap':
        if width == 64:
            state.write(operands[0], 'bswap64(%s)' % read(operands[0]))
        else:
            state.write(operands[0],
                        "int.from_bytes((((%s) & %s)).to_bytes(%d, 'little'), "
                        "'big')" % (read(operands[0]), mask, width // 8))
        return
    if base in ('popcnt', 'lzcnt', 'tzcnt'):
        value = '((%s) & %s)' % (read(operands[0]), mask)
        if base == 'popcnt':
            state.write(operands[1], 'popcnt(%s)' % value)
        elif base == 'lzcnt':
            state.write(operands[1], '%d - (%s).bit_length()' % (width, value))
        else:
            state.write(operands[1], 'ctz(%s, %d)' % (value, width))
        return
    if base in ('pdep', 'pext'):
        # AT&T reverses Intel: pdep mask, src, dst.
        state.write(operands[2], '%s((%s) & M, (%s) & M)'
                    % (base, read(operands[1]), read(operands[0])))
        return
    if base == 'pclmulqdq':
        selector = (_immediate(operands[0])
                    if operands[0].startswith('$') else 0)
        left, right = read(operands[1]), read(operands[2])
        a = '((%s) >> 64)' % right if selector & 1 else '((%s) & M)' % right
        b = '((%s) >> 64)' % left if selector & 0x10 else '((%s) & M)' % left
        state.write(operands[2], 'clmul(%s, %s, 64) & 0x%X' % (a, b, XMM))
        return
    if base in ('nop', 'endbr64', 'hlt'):
        return

    raise UnsupportedC('x86 instruction %r is not modelled' % mnemonic,
                       hint='this reader covers the 64-bit integer subset a '
                            'small kernel compiles to')


def compile_function(function):
    """A callable `x -> y` for one parsed listing, compiled once."""
    compiled = function._steps
    if compiled is None or compiled[0] != len(function.instructions):
        compiled = function._steps = (len(function.instructions),
                                      _build(function))
    return compiled[1]


def evaluate(function, argument):
    """Run the body with `argument` in %rdi, returning %rax."""
    return compile_function(function)(argument)


def physical_sequence(function):
    """Recover a register-only integer body as the shared SSA form.

    Unknown ABI bookkeeping may remain dead.  If it reaches ``%rax`` the
    candidate is rejected; otherwise the main pipeline still verifies the
    recovered function against executed semantics before it can be selected.
    """
    from ..isa import Seq, normalize_physical

    seq = Seq()
    registers = {ARG_REGISTER: 0}

    def is_const(value):
        return isinstance(value, tuple) and value[0] == 'const'

    def constant(value):
        return int(value[1]) & M64

    def read(token):
        if token.startswith('$'):
            return 'const', _immediate(token)
        if token.startswith('%'):
            return registers.get(_canonical(token))
        return None

    def write(token, value):
        registers[_canonical(token)] = value

    def materialize(value):
        if value is None or not is_const(value):
            return value
        result = seq.emit('AND', [0], const=0)
        if constant(value):
            result = seq.emit('OR', [result], const=constant(value))
        return result

    def narrow(value, width):
        if value is None or width >= 64:
            return value
        if is_const(value):
            return 'const', constant(value) & mask_of(width)
        return seq.emit('AND', [value], const=mask_of(width))

    def binary(name, left, right):
        if left is None or right is None:
            return None
        if is_const(left) and is_const(right):
            a, b = constant(left), constant(right)
            functions = {
                'add': lambda: a + b, 'sub': lambda: a - b,
                'imul': lambda: a * b, 'and': lambda: a & b,
                'or': lambda: a | b, 'xor': lambda: a ^ b,
            }
            return 'const', functions[name]() & M64
        if is_const(left) and name in {'add', 'imul', 'and', 'or', 'xor'}:
            left, right = right, left
        immediate = {'add': 'ADD', 'sub': 'SUB', 'imul': 'IMUL',
                     'and': 'AND', 'or': 'OR', 'xor': 'XOR'}
        if is_const(right):
            return seq.emit(immediate[name], [materialize(left)],
                            const=constant(right))
        register = {'add': 'ADDR', 'sub': 'SUBR', 'and': 'ANDR',
                    'or': 'ORR', 'xor': 'XORR'}.get(name)
        if register:
            return seq.emit(register, [materialize(left), materialize(right)])
        return None

    try:
        for mnemonic, operands in function.instructions:
            base, width = _strip_suffix(mnemonic)
            if base in ('nop', 'endbr64', 'hlt'):
                continue
            if base in ('push', 'pop', 'leave'):
                if base == 'pop' and operands:
                    write(operands[-1], None)
                continue
            if base in ('mov', 'movabs', 'movzx', 'movz'):
                write(operands[1], narrow(read(operands[0]), width))
                continue
            if base in _ALU:
                left = narrow(read(operands[1]), width)
                right = narrow(read(operands[0]), width)
                write(operands[1], narrow(binary(base, left, right), width))
                continue
            if base == 'imul':
                if len(operands) == 3:
                    left, right, target = (read(operands[1]),
                                           read(operands[0]), operands[2])
                else:
                    left, right, target = (read(operands[1]),
                                           read(operands[0]), operands[1])
                write(target, narrow(binary(
                    'imul', narrow(left, width), narrow(right, width)), width))
                continue
            if base in ('not', 'neg'):
                value = narrow(read(operands[0]), width)
                if value is None:
                    result = None
                elif is_const(value):
                    result = ('const', ((~constant(value)) if base == 'not'
                                        else -constant(value)) & mask_of(width))
                else:
                    result = seq.emit('NOT' if base == 'not' else 'NEG',
                                      [value])
                write(operands[0], narrow(result, width))
                continue
            if base in ('shl', 'sal', 'shr', 'sar'):
                if len(operands) != 2 or not operands[0].startswith('$'):
                    return None
                value = narrow(read(operands[1]), width)
                result = (None if value is None else seq.emit(
                    {'shl': 'SHL', 'sal': 'SHL', 'shr': 'SHR',
                     'sar': 'SAR'}[base], [materialize(value)],
                    shift=_immediate(operands[0]) % width))
                write(operands[1], narrow(result, width))
                continue
            if base in ('popcnt', 'lzcnt', 'tzcnt'):
                value = narrow(read(operands[0]), width)
                result = (None if value is None else seq.emit(
                    {'popcnt': 'POPCNT', 'lzcnt': 'CLZ',
                     'tzcnt': 'CTZ'}[base], [materialize(value)]))
                write(operands[1], result)
                continue
            if base in ('pdep', 'pext'):
                mask, value = read(operands[0]), read(operands[1])
                if value is None or not is_const(mask):
                    return None
                write(operands[2], seq.emit(base.upper(),
                                            [materialize(value)],
                                            const=constant(mask)))
                continue
            if base == 'bswap':
                value = read(operands[0])
                write(operands[0], None if value is None else
                      seq.emit('BSWAP', [materialize(value)]))
                continue
            return None
        result = registers.get(RESULT_REGISTER)
        if result is None:
            return None
        seq.result = materialize(result)
        return normalize_physical(seq)
    except (IndexError, KeyError, TypeError, ValueError):
        return None


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
                    'popcnt', 'lzcnt', 'tzcnt', 'bsf', 'movz', 'movzx', 'push',
                    'pop', 'leave', 'ret'):
            return stem, _SIZES[mnemonic[-1]]
    return mnemonic, 64
