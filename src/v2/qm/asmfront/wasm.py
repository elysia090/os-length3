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

from .. import straightline
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
                 'local_count', '_steps')

    def __init__(self, name, param_types, result_type, instructions,
                 local_count):
        self.name = name
        self.param_types = param_types
        self.result_type = result_type
        self.instructions = instructions
        self.local_count = local_count
        self._steps = None

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
    """Parse the requested — or the usable — function out of a wasm listing.

    A listing with several functions in it is ordinary: `clang -S` for a file
    of kernels emits all of them, and QM's own output round-trips through here.
    So every function is read, and the choice is made afterwards, preferring
    one this prototype's unary solvers can actually take. Stopping at the first
    header meant a two-parameter helper at the top of a module hid every kernel
    below it.
    """
    if '(i64.' in text.replace(' ', '') or re.search(r'\(\s*i64\.\w+\s+\(', text):
        raise UnsupportedC(
            'folded s-expressions are not read',
            hint='paste the flat instruction form, which is what clang -S and '
                 'the wasm text format both produce for a function body')

    found = []

    def begin(name, params, result):
        # `clang -S` declares each `.functype` twice — once in the preamble and
        # once under the label — so a repeat of the name we are already on is
        # the same function, not a new one.
        if found and found[-1].name == name and not found[-1].instructions:
            found[-1].param_types = params
            found[-1].result_type = result
            return
        found.append(WasmFunction(name, params, result, [], 0))

    for raw in text.splitlines():
        line = raw.split(';;')[0].strip()
        if not line:
            continue

        match = _SIGNATURE.search(line)
        if match:
            results = [r.strip() for r in match.group('results').split(',')
                       if r.strip()]
            begin(match.group('name'),
                  [p.strip() for p in match.group('params').split(',')
                   if p.strip()],
                  results[0] if results else 'i64')
            continue

        match = _WAT_FUNC.search(line)
        if match:
            export = _EXPORT.search(line)
            params = re.findall(r'\(\s*param\s+([^)]*)\)', line)
            results = re.findall(r'\(\s*result\s+([^)]*)\)', line)
            begin(export.group('name') if export else match.group('name'),
                  [t for group in params for t in group.split()],
                  results[0].split()[0]
                  if results and results[0].split() else 'i64')
            continue

        if not found:
            continue           # preamble: nothing to attribute it to yet
        current = found[-1]

        declared = re.match(r'\(\s*local\s+([^)]*)\)', line)
        if declared:
            current.local_count += len(declared.group(1).split())
            continue
        if line.startswith('.') or line.endswith(':'):
            continue

        for token in _instructions_in(line):
            current.instructions.append(token)

    if not found:
        raise CFrontError('no wasm function found',
                          hint='the listing needs a .functype line or a '
                               '(func ...) header')

    def prefer(candidates):
        """A body beats a bare declaration: an import declares a `.functype`
        with nothing under it, and that is not the function anyone meant."""
        return ([fn for fn in candidates if fn.instructions] or candidates)

    if requested:
        named = prefer([fn for fn in found if fn.name == requested])
        if not named:
            raise CFrontError('function %r is not in this listing' % requested,
                              hint='found: %s'
                                   % ', '.join(f.name for f in found))
        if len(named[0].param_types) != 1:
            raise CFrontError('%s takes %d parameters; this prototype\'s '
                              'solver family takes one'
                              % (named[0].name, len(named[0].param_types)))
        return named[0]

    unary = [fn for fn in found if len(fn.param_types) == 1]
    if not unary:
        first = prefer(found)[0]
        raise CFrontError('%s takes %d parameters; this prototype\'s solver '
                          'family takes one'
                          % (first.name, len(first.param_types)))
    return prefer(unary)[0]


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
#
# A listing is straight-line, so which opcode an instruction is — and where the
# stack stands when it runs — do not depend on the input.  The domain sweep
# behind an idempotence check asks 65,536 times, so the stack is walked once at
# compile time and the listing is written out as one Python function with a
# variable per local and per intermediate.  `evaluate` calls the same function,
# so there is one implementation and not a fast path beside a reference one.
# ---------------------------------------------------------------------------

MAX_INSTRUCTIONS = straightline.MAX_LINES


def _rotate(value, amount, bits, left):
    if not amount:
        return value
    return ((value << amount) | (value >> (bits - amount))) if left \
        else ((value >> amount) | (value << (bits - amount)))


def _clz(value, bits):
    return bits - value.bit_length()


def _ctz(value, bits):
    return bits if value == 0 else (value & -value).bit_length() - 1


_ENV = {'popcnt': popcnt, 'signed': _to_signed, 'rot': _rotate, 'clz': _clz,
        'ctz': _ctz}


def _forms():
    """opcode -> (arity, expression template) over already-named operands."""
    table = {}
    for bits in (32, 64):
        p = 'i%d.' % bits
        m = '0x%X' % mask_of(bits)
        binary = {'add': '+', 'sub': '-', 'mul': '*', 'and': '&', 'or': '|',
                  'xor': '^'}
        for name, symbol in binary.items():
            table[p + name] = (2, '(({a} & %s) %s ({b} & %s)) & %s'
                               % (m, symbol, m, m))
        compare = {'eq': '==', 'ne': '!=', 'lt_u': '<', 'gt_u': '>',
                   'le_u': '<=', 'ge_u': '>='}
        for name, symbol in compare.items():
            table[p + name] = (2, '(1 if ({a} & %s) %s ({b} & %s) else 0)'
                               % (m, symbol, m))
        table[p + 'shl'] = (2, '(({a} & %s) << (({b}) %% %d)) & %s'
                            % (m, bits, m))
        table[p + 'shr_u'] = (2, '(({a} & %s) >> (({b}) %% %d)) & %s'
                              % (m, bits, m))
        table[p + 'shr_s'] = (2, '(signed({a} & %s, %d) >> (({b}) %% %d)) & %s'
                              % (m, bits, bits, m))
        table[p + 'rotl'] = (2, 'rot({a} & %s, ({b}) %% %d, %d, True) & %s'
                             % (m, bits, bits, m))
        table[p + 'rotr'] = (2, 'rot({a} & %s, ({b}) %% %d, %d, False) & %s'
                             % (m, bits, bits, m))
        table[p + 'div_u'] = (2, '((({a} & %s) // ({b} & %s)) & %s '
                                 'if ({b} & %s) else 0)' % (m, m, m, m))
        table[p + 'rem_u'] = (2, '((({a} & %s) %% ({b} & %s)) & %s '
                                 'if ({b} & %s) else 0)' % (m, m, m, m))
        table[p + 'popcnt'] = (1, 'popcnt({a} & %s)' % m)
        table[p + 'clz'] = (1, 'clz({a} & %s, %d)' % (m, bits))
        table[p + 'ctz'] = (1, 'ctz({a} & %s, %d)' % (m, bits))
        table[p + 'eqz'] = (1, '(1 if ({a} & %s) == 0 else 0)' % m)

    table['i64.extend_i32_u'] = (1, '{a} & 0x%X' % I32)
    table['i64.extend_i32_s'] = (1, 'signed({a}, 32) & 0x%X' % M64)
    table['i32.wrap_i64'] = (1, '{a} & 0x%X' % I32)
    return table


_FORMS = _forms()


def _build(function):
    """Walk the stack at compile time and emit one Python function."""
    if len(function.instructions) > MAX_INSTRUCTIONS:
        raise CFrontError('wasm listing exceeded the step budget')

    in_mask = I32 if function.param_types[0] == 'i32' else M64
    out_mask = I32 if function.result_type == 'i32' else M64
    slots = max([len(function.param_types) + function.local_count] +
                [immediate + 1
                 for opcode, immediate in function.instructions
                 if opcode.startswith('local.') and immediate is not None])

    body = [('l0', 'x & 0x%X' % in_mask)]
    body += [('l%d' % i, '0') for i in range(1, slots)]
    stack = []
    temp = 0

    def pop():
        if not stack:
            raise CFrontError('%s pops from an empty stack' % function.name,
                              hint='the listing is unbalanced, or it uses '
                                   'control flow this reader does not model')
        return stack.pop()

    for opcode, immediate in function.instructions:
        if opcode == 'local.get':
            stack.append('l%d' % immediate)
            continue
        if opcode == 'local.set':
            body.append(('l%d' % immediate, pop()))
            continue
        if opcode == 'local.tee':
            body.append(('l%d' % immediate, stack[-1] if stack else pop()))
            stack[-1] = 'l%d' % immediate
            continue
        if opcode in ('i32.const', 'i64.const'):
            stack.append('0x%X' % (immediate & (I32 if opcode[1] == '3'
                                                else M64)))
            continue
        if opcode == 'drop':
            pop()
            continue

        form = _FORMS.get(opcode)
        if form is None:
            raise UnsupportedC('wasm instruction %r is not modelled' % opcode,
                               hint='this reader covers the integer subset a '
                                    'small kernel compiles to')
        arity, template = form
        if arity == 2:
            b = pop()
            a = pop()
            expression = template.format(a=a, b=b)
        else:
            expression = template.format(a=pop())
        temp += 1
        name = 't%d' % temp
        body.append((name, expression))
        stack.append(name)

    if not stack:
        raise CFrontError('%s left no value on the stack' % function.name)
    return straightline.build('qm_wasm', ['x'], body,
                              '%s & 0x%X' % (stack[-1], out_mask), _ENV)


def compile_function(function):
    """A callable `x -> y` for one parsed function, compiled once."""
    compiled = function._steps
    if compiled is None or compiled[0] != len(function.instructions):
        compiled = function._steps = (len(function.instructions),
                                      _build(function))
    return compiled[1]


def evaluate(function, args):
    """Run the function as a stack machine over 32/64-bit integers."""
    return compile_function(function)(args[0])


def physical_sequence(function):
    """Recover the flat integer listing as the shared SSA instruction form.

    This is deliberately narrower than evaluation: it is an optional compact
    candidate, never the semantics oracle.  The caller still verifies it on
    the complete declared domain before it can outrank synthesized forms.
    """
    from ..isa import Seq, normalize_physical

    seq = Seq()
    locals_ = [0] + [('const', 0)] * function.local_count
    stack = []

    def is_const(value):
        return isinstance(value, tuple) and value[0] == 'const'

    def constant(value):
        return int(value[1]) & M64

    def materialize(value):
        if not is_const(value):
            return value
        result = seq.emit('AND', [0], const=0)
        if constant(value):
            result = seq.emit('OR', [result], const=constant(value))
        return result

    def binary(opcode, left, right):
        if is_const(left) and is_const(right):
            a, b = constant(left), constant(right)
            operations = {
                'i64.add': lambda: a + b,
                'i64.sub': lambda: a - b,
                'i64.mul': lambda: a * b,
                'i64.and': lambda: a & b,
                'i64.or': lambda: a | b,
                'i64.xor': lambda: a ^ b,
                'i64.shl': lambda: a << (b & 63),
                'i64.shr_u': lambda: a >> (b & 63),
                'i64.shr_s': lambda: _to_signed(a, 64) >> (b & 63),
            }
            if opcode not in operations:
                raise ValueError(opcode)
            return 'const', operations[opcode]() & M64

        immediate = {
            'i64.add': 'ADD', 'i64.sub': 'SUB', 'i64.mul': 'IMUL',
            'i64.and': 'AND', 'i64.or': 'OR', 'i64.xor': 'XOR',
        }
        commutative = {'i64.add', 'i64.mul', 'i64.and', 'i64.or', 'i64.xor'}
        if is_const(left) and opcode in commutative:
            left, right = right, left
        if (opcode == 'i64.sub' and is_const(left)
                and constant(left) == 0 and not is_const(right)):
            return seq.emit('NEG', [right])
        if is_const(right) and opcode in immediate:
            return seq.emit(immediate[opcode], [materialize(left)],
                            const=constant(right))
        if is_const(right) and opcode in ('i64.shl', 'i64.shr_u',
                                           'i64.shr_s'):
            name = {'i64.shl': 'SHL', 'i64.shr_u': 'SHR',
                    'i64.shr_s': 'SAR'}[opcode]
            return seq.emit(name, [materialize(left)],
                            shift=constant(right) & 63)
        registers = {'i64.add': 'ADDR', 'i64.sub': 'SUBR',
                     'i64.and': 'ANDR', 'i64.or': 'ORR',
                     'i64.xor': 'XORR', 'i64.shr_u': 'SHRR'}
        if opcode in registers and not is_const(left) and not is_const(right):
            return seq.emit(registers[opcode], [left, right])
        raise ValueError(opcode)

    try:
        for opcode, immediate in function.instructions:
            if opcode == 'local.get':
                stack.append(locals_[immediate])
            elif opcode == 'local.set':
                locals_[immediate] = stack.pop()
            elif opcode == 'local.tee':
                locals_[immediate] = stack[-1]
            elif opcode in ('i32.const', 'i64.const'):
                width = 32 if opcode.startswith('i32.') else 64
                stack.append(('const', immediate & mask_of(width)))
            elif opcode == 'drop':
                stack.pop()
            elif opcode in ('i64.add', 'i64.sub', 'i64.mul', 'i64.and',
                            'i64.or', 'i64.xor', 'i64.shl', 'i64.shr_u',
                            'i64.shr_s'):
                right, left = stack.pop(), stack.pop()
                stack.append(binary(opcode, left, right))
            elif opcode in ('i64.popcnt', 'i64.clz', 'i64.ctz'):
                value = materialize(stack.pop())
                stack.append(seq.emit(
                    {'i64.popcnt': 'POPCNT', 'i64.clz': 'CLZ',
                     'i64.ctz': 'CTZ'}[opcode], [value]))
            elif opcode in ('i64.extend_i32_u', 'i32.wrap_i64'):
                value = stack.pop()
                stack.append(('const', constant(value) & I32)
                             if is_const(value) else
                             seq.emit('AND', [value], const=I32))
            else:
                return None
        if not stack:
            return None
        seq.result = materialize(stack[-1])
        return normalize_physical(seq)
    except (IndexError, KeyError, TypeError, ValueError):
        return None
