"""Read a wasm32 function and evaluate it.

Enough of WebAssembly to read back what a compiler emits for a small integer
kernel, and what QM emits itself. That second part is the point: a minimizer
that cannot read its own output cannot be checked for idempotence.

Both text forms are accepted, because both are what a person has to hand:

    the text format          (module (func $f (param i64) (result i64) ...))
    clang -S for wasm32      .functype f (i64) -> (i64) / local.get 0 / ...

Only the flat instruction stream is read. A folded s-expression — one written
as `(i64.mul (local.get 0) (i64.const 5))` — is reported rather than guessed at.
"""

import re

from ..bits import M64, mask_of, popcnt
from ..cfront.errors import CFrontError, UnsupportedC

I32 = mask_of(32)

# `(param i64)` says the register is 64 bits wide, not that the kernel meant 64
# bits of input, so QM records the width it actually used when it emits.
INPUT_BITS = re.compile(r'qm-input-bits:\s*(\d+)')


def declared_input_bits(text):
    """The width QM recorded when it emitted this listing, if it did."""
    match = INPUT_BITS.search(text)
    return int(match.group(1)) if match else None

_SIGNATURE = re.compile(
    r'\.functype\s+(?P<name>[\w$.]+)\s*\((?P<params>[^)]*)\)\s*->\s*'
    r'\((?P<results>[^)]*)\)')
_WAT_FUNC = re.compile(r'\(\s*func\s+\$?(?P<name>[\w$.]+)')
_EXPORT = re.compile(r'\(\s*export\s+"(?P<name>[^"]+)"')


def _to_signed(value, bits):
    value &= mask_of(bits)
    top = 1 << (bits - 1)
    return value - (1 << bits) if value & top else value


def _parse_const(text):
    text = text.strip()
    negative = text.startswith('-')
    if negative:
        text = text[1:]
    value = int(text, 16) if text[:2].lower() == '0x' else int(text, 10)
    return -value if negative else value


class WasmFunction(object):
    """One parsed function: a flat instruction list over locals and a stack."""

    __slots__ = ('name', 'param_types', 'result_type', 'instructions',
                 'local_count')

    def __init__(self, name, param_types, result_type, instructions,
                 local_count):
        self.name = name
        self.param_types = param_types
        self.result_type = result_type
        self.instructions = instructions
        self.local_count = local_count

    @property
    def input_bits(self):
        return 32 if self.param_types and self.param_types[0] == 'i32' else 64

    @property
    def output_bits(self):
        return 32 if self.result_type == 'i32' else 64

    def __call__(self, value):
        return evaluate(self, [value])


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def looks_like_wasm(text):
    """Cheap discrimination against x86 assembly and C."""
    if 'local.get' in text or '.functype' in text:
        return True
    return bool(re.search(r'\bi(32|64)\.(const|add|mul|and|or|xor|shl)\b', text))


def parse(text, requested=None):
    """Parse the first (or requested) function out of a wasm text listing."""
    if '(i64.' in text.replace(' ', '') or re.search(r'\(\s*i64\.\w+\s+\(', text):
        raise UnsupportedC(
            'folded s-expressions are not read',
            hint='paste the flat instruction form, which is what clang -S and '
                 'the wasm text format both produce for a function body')

    name = None
    params = []
    result = 'i64'
    local_count = 0
    instructions = []
    seen_signature = False

    for raw in text.splitlines():
        line = raw.split(';;')[0].strip()
        if not line:
            continue

        match = _SIGNATURE.search(line)
        if match:
            if seen_signature and name is not None:
                break          # a second function; one is enough
            candidate = match.group('name')
            if requested and candidate != requested:
                continue
            name = candidate
            params = [p.strip() for p in match.group('params').split(',')
                      if p.strip()]
            results = [r.strip() for r in match.group('results').split(',')
                       if r.strip()]
            result = results[0] if results else 'i64'
            seen_signature = True
            continue

        match = _WAT_FUNC.search(line)
        if match:
            if seen_signature and name is not None:
                break
            export = _EXPORT.search(line)
            candidate = (export.group('name') if export else match.group('name'))
            if requested and candidate != requested:
                continue
            name = candidate
            params = re.findall(r'\(\s*param\s+([^)]*)\)', line)
            params = [t for group in params for t in group.split()]
            found = re.findall(r'\(\s*result\s+([^)]*)\)', line)
            result = found[0].split()[0] if found and found[0].split() else 'i64'
            seen_signature = True
            continue

        declared = re.match(r'\(\s*local\s+([^)]*)\)', line)
        if declared:
            local_count += len(declared.group(1).split())
            continue
        if line.startswith('.') or line.endswith(':'):
            continue

        for token in _instructions_in(line):
            instructions.append(token)

    if name is None:
        raise CFrontError('no wasm function found',
                          hint='the listing needs a .functype line or a '
                               '(func ...) header')
    if len(params) != 1:
        raise CFrontError('%s takes %d parameter(s); exactly one is required'
                          % (name, len(params)))
    return WasmFunction(name, params, result, instructions, local_count)


def _instructions_in(line):
    """Split one source line into (opcode, immediate) pairs."""
    cleaned = line.replace('(', ' ').replace(')', ' ').strip()
    if not cleaned:
        return
    tokens = cleaned.split()
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if token in ('module', 'func', 'export', 'param', 'result', 'local',
                     'end', 'end_function'):
            continue
        if token.startswith('$') or token.startswith('"'):
            continue
        if token in ('i32', 'i64'):
            continue
        immediate = None
        if index < len(tokens) and _is_number(tokens[index]):
            immediate = _parse_const(tokens[index])
            index += 1
        yield (token, immediate)


def _is_number(token):
    body = token[1:] if token.startswith('-') else token
    if body[:2].lower() == '0x':
        return all(c in '0123456789abcdefABCDEF' for c in body[2:]) and len(body) > 2
    return body.isdigit()


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(function, args, max_steps=200000):
    """Run the function as a stack machine over 32/64-bit integers."""
    locals_ = [0] * (len(function.param_types) + function.local_count + 1)
    for index, value in enumerate(args):
        locals_[index] = value & (I32 if function.param_types[index] == 'i32'
                                  else M64)
    stack = []
    steps = 0

    for opcode, immediate in function.instructions:
        steps += 1
        if steps > max_steps:
            raise CFrontError('wasm listing exceeded the step budget')
        _step(opcode, immediate, stack, locals_)

    if not stack:
        raise CFrontError('%s left no value on the stack' % function.name)
    out = stack[-1]
    return out & (I32 if function.result_type == 'i32' else M64)


def _step(opcode, immediate, stack, locals_):
    if opcode == 'local.get':
        stack.append(locals_[immediate])
        return
    if opcode == 'local.set':
        _grow(locals_, immediate)
        locals_[immediate] = stack.pop()
        return
    if opcode == 'local.tee':
        _grow(locals_, immediate)
        locals_[immediate] = stack[-1]
        return
    if opcode in ('i32.const', 'i64.const'):
        bits = 32 if opcode.startswith('i32') else 64
        stack.append(immediate & mask_of(bits))
        return
    if opcode == 'drop':
        stack.pop()
        return

    handler = _OPS.get(opcode)
    if handler is None:
        raise UnsupportedC('wasm instruction %r is not modelled' % opcode,
                           hint='this reader covers the integer subset a small '
                                'kernel compiles to')
    handler(stack)


def _grow(locals_, index):
    while len(locals_) <= index:
        locals_.append(0)


def _binary(bits, fn):
    mask = mask_of(bits)

    def op(stack):
        right = stack.pop() & mask
        left = stack.pop() & mask
        stack.append(fn(left, right) & mask)
    return op


def _unary(bits, fn):
    mask = mask_of(bits)

    def op(stack):
        stack.append(fn(stack.pop() & mask) & mask)
    return op


def _shift(bits, fn):
    mask = mask_of(bits)

    def op(stack):
        amount = stack.pop() % bits
        value = stack.pop() & mask
        stack.append(fn(value, amount) & mask)
    return op


def _rotate(bits, left):
    mask = mask_of(bits)

    def op(stack):
        amount = stack.pop() % bits
        value = stack.pop() & mask
        if amount:
            value = ((value << amount) | (value >> (bits - amount))) if left \
                else ((value >> amount) | (value << (bits - amount)))
        stack.append(value & mask)
    return op


def _build_ops():
    table = {}
    for bits in (32, 64):
        prefix = 'i%d.' % bits
        mask = mask_of(bits)
        table[prefix + 'add'] = _binary(bits, lambda a, b: a + b)
        table[prefix + 'sub'] = _binary(bits, lambda a, b: a - b)
        table[prefix + 'mul'] = _binary(bits, lambda a, b: a * b)
        table[prefix + 'and'] = _binary(bits, lambda a, b: a & b)
        table[prefix + 'or'] = _binary(bits, lambda a, b: a | b)
        table[prefix + 'xor'] = _binary(bits, lambda a, b: a ^ b)
        table[prefix + 'shl'] = _shift(bits, lambda v, n: v << n)
        table[prefix + 'shr_u'] = _shift(bits, lambda v, n: v >> n)
        table[prefix + 'shr_s'] = _shift(
            bits, lambda v, n, _b=bits: _to_signed(v, _b) >> n)
        table[prefix + 'rotl'] = _rotate(bits, True)
        table[prefix + 'rotr'] = _rotate(bits, False)
        table[prefix + 'popcnt'] = _unary(bits, popcnt)
        table[prefix + 'clz'] = _unary(
            bits, lambda v, _b=bits: _b - v.bit_length())
        table[prefix + 'ctz'] = _unary(
            bits, lambda v, _b=bits: _b if v == 0 else (v & -v).bit_length() - 1)
        table[prefix + 'eqz'] = _unary(bits, lambda v: 1 if v == 0 else 0)
        table[prefix + 'eq'] = _binary(bits, lambda a, b: 1 if a == b else 0)
        table[prefix + 'ne'] = _binary(bits, lambda a, b: 1 if a != b else 0)
        table[prefix + 'lt_u'] = _binary(bits, lambda a, b: 1 if a < b else 0)
        table[prefix + 'gt_u'] = _binary(bits, lambda a, b: 1 if a > b else 0)
        table[prefix + 'le_u'] = _binary(bits, lambda a, b: 1 if a <= b else 0)
        table[prefix + 'ge_u'] = _binary(bits, lambda a, b: 1 if a >= b else 0)
        table[prefix + 'div_u'] = _binary(bits, lambda a, b: a // b if b else 0)
        table[prefix + 'rem_u'] = _binary(bits, lambda a, b: a % b if b else 0)
        _ = mask

    table['i64.extend_i32_u'] = lambda stack: stack.append(stack.pop() & I32)
    table['i64.extend_i32_s'] = lambda stack: stack.append(
        _to_signed(stack.pop(), 32) & M64)
    table['i32.wrap_i64'] = lambda stack: stack.append(stack.pop() & I32)
    return table


_OPS = _build_ops()
