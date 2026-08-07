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
    __slots__ = ('name', 'instructions')

    def __init__(self, name, instructions):
        self.name = name
        self.instructions = instructions

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


def _immediate(token):
    body = token[1:].strip()
    negative = body.startswith('-')
    if negative:
        body = body[1:]
    value = int(body, 16) if body[:2].lower() == '0x' else int(body, 10)
    return (-value if negative else value) & M64


def _canonical(register):
    return _SUB_REGISTERS.get(register, register)


def evaluate(function, argument):
    """Run the body with `argument` in %rdi, returning %rax."""
    registers = {ARG_REGISTER: argument & M64}
    xmm = {}

    def read(token):
        if token.startswith('$'):
            return _immediate(token)
        if token.startswith('%xmm'):
            return xmm.get(token, 0)
        if token.startswith('%'):
            return registers.get(_canonical(token), 0)
        raise UnsupportedC('memory operand %r is not modelled' % token,
                           hint='this reader evaluates register-only code')

    def write(token, value):
        if token.startswith('%xmm'):
            xmm[token] = value & mask_of(128)
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
                registers[full] = value & mask_of(32)
                return
            registers[full] = (registers.get(full, 0) & ~mask_of(width)) \
                | (value & mask_of(width))
            return
        registers[full] = value & M64

    for mnemonic, operands in function.instructions:
        _execute(mnemonic, operands, read, write)

    return registers.get(RESULT_REGISTER, 0) & M64


def _execute(mnemonic, operands, read, write):
    base, width = _strip_suffix(mnemonic)
    mask = mask_of(width)

    if base in ('mov', 'movabs'):
        write(operands[1], read(operands[0]) & mask)
        return
    if base == 'movzx' or base == 'movz':
        write(operands[1], read(operands[0]) & mask)
        return
    if base in ('and', 'or', 'xor', 'add', 'sub'):
        left = read(operands[1]) & mask
        right = read(operands[0]) & mask
        value = {'and': left & right, 'or': left | right, 'xor': left ^ right,
                 'add': left + right, 'sub': left - right}[base]
        write(operands[1], value & mask)
        return
    if base == 'imul':
        if len(operands) == 3:
            write(operands[2], (read(operands[0]) * read(operands[1])) & mask)
        else:
            write(operands[1], (read(operands[1]) * read(operands[0])) & mask)
        return
    if base == 'not':
        write(operands[0], (~read(operands[0])) & mask)
        return
    if base == 'neg':
        write(operands[0], (-read(operands[0])) & mask)
        return
    if base in ('shl', 'sal', 'shr', 'sar'):
        amount = read(operands[0]) % width if len(operands) == 2 else 1
        target = operands[-1]
        value = read(target) & mask
        if base in ('shl', 'sal'):
            value <<= amount
        elif base == 'shr':
            value >>= amount
        else:
            top = 1 << (width - 1)
            signed = value - (1 << width) if value & top else value
            value = signed >> amount
        write(target, value & mask)
        return
    if base == 'bswap':
        write(operands[0], bswap64(read(operands[0])) if width == 64
              else int.from_bytes((read(operands[0]) & mask).to_bytes(
                  width // 8, 'little'), 'big'))
        return
    if base in ('popcnt', 'lzcnt', 'tzcnt'):
        value = read(operands[0]) & mask
        if base == 'popcnt':
            out = popcnt(value)
        elif base == 'lzcnt':
            out = width - value.bit_length()
        else:
            out = width if value == 0 else (value & -value).bit_length() - 1
        write(operands[1], out)
        return
    if base in ('pdep', 'pext'):
        # AT&T reverses Intel: pdep mask, src, dst.
        maskv = read(operands[0]) & M64
        source = read(operands[1]) & M64
        out = pdep(source, maskv) if base == 'pdep' else pext(source, maskv)
        write(operands[2], out)
        return
    if base == 'pclmulqdq':
        selector = _immediate(operands[0]) if operands[0].startswith('$') else 0
        left = read(operands[1])
        right = read(operands[2])
        a = (right >> 64) if (selector & 1) else (right & M64)
        b = (left >> 64) if (selector & 0x10) else (left & M64)
        write(operands[2], clmul(a, b, 64) & mask_of(128))
        return
    if base in ('nop', 'endbr64', 'hlt'):
        return

    raise UnsupportedC('x86 instruction %r is not modelled' % mnemonic,
                       hint='this reader covers the 64-bit integer subset a '
                            'small kernel compiles to')


def _strip_suffix(mnemonic):
    """Split `andq` into ('and', 64); default to 64 bits."""
    if mnemonic in ('pdep', 'pext', 'pclmulqdq', 'nop', 'endbr64', 'hlt'):
        return mnemonic, 64
    if len(mnemonic) > 2 and mnemonic[-1] in _SIZES:
        stem = mnemonic[:-1]
        if stem in ('mov', 'movabs', 'and', 'or', 'xor', 'add', 'sub', 'imul',
                    'not', 'neg', 'shl', 'sal', 'shr', 'sar', 'bswap',
                    'popcnt', 'lzcnt', 'tzcnt', 'movz', 'movzx', 'ret'):
            return stem, _SIZES[mnemonic[-1]]
    return mnemonic, 64
