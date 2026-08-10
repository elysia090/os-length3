"""Function-local QM for large linked WebAssembly modules.

A compiler module is not a finite scalar function: its arguments, virtual
filesystem, clocks and output files are part of the state.  It still contains
many internal functions that are closed integer expressions.  This module
indexes code bodies without expanding the rest of a large binary. Pure scalar
functions use whole-expression QM. Straight-line state functions additionally
admit ordinary linear-memory operations into the same SSA cut, so dominating
stores can replace later loads. Stateful results remain physical pages; their
typed-Wasm re-encoding is measured but never installed as a second runtime.

Every replacement is constructed from exact WebAssembly integer and memory
identities. Anything with a host observation, trap-sensitive division,
indirect call, atomic operation or observable control boundary remains
byte-for-byte unchanged.
"""

from dataclasses import dataclass

from . import isa
from .bits import mask_of
from .cfront.errors import CFrontError, UnsupportedC
from .wasmstate import (_MEMORY, _PLAIN, _Reader, _decode_code, _valtype)


I32 = mask_of(32)
I64 = mask_of(64)
VALTYPE = {'i32': 0x7F, 'i64': 0x7E}


def _uleb(data, at):
    value = 0
    shift = 0
    while True:
        if at >= len(data):
            raise ValueError('unexpected end of wasm unsigned LEB')
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, at
        shift += 7
        if shift > 70:
            raise ValueError('unterminated wasm unsigned LEB')


def encode_uleb(value):
    if value < 0:
        raise ValueError('unsigned LEB cannot encode a negative value')
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def encode_sleb(value, bits=64):
    out = bytearray()
    more = True
    while more:
        byte = value & 0x7F
        value >>= 7
        sign = bool(byte & 0x40)
        more = not ((value == 0 and not sign) or (value == -1 and sign))
        out.append(byte | (0x80 if more else 0))
        if len(out) > (bits + 6) // 7 + 1:
            raise ValueError('signed LEB exceeds %d bits' % bits)
    return bytes(out)


SECTION_NAMES = {
    0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table',
    5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element',
    10: 'code', 11: 'data', 12: 'data-count', 13: 'tag',
}


@dataclass(frozen=True)
class Section:
    kind: int
    name: str
    start: int
    payload: int
    end: int

    @property
    def size(self):
        return self.end - self.start

    @property
    def payload_size(self):
        return self.end - self.payload


def module_sections(data):
    """Return exact byte regions for a core WebAssembly module."""
    if bytes(data[:8]) != b'\x00asm\x01\x00\x00\x00':
        raise ValueError('input is not a WebAssembly 1.0 binary')
    out = []
    at = 8
    while at < len(data):
        start = at
        kind = data[at]
        size, payload = _uleb(data, at + 1)
        end = payload + size
        if end > len(data):
            raise ValueError('wasm section exceeds the file')
        name = SECTION_NAMES.get(kind, 'section-%d' % kind)
        if kind == 0:
            length, cursor = _uleb(data, payload)
            name_end = cursor + length
            if name_end > end:
                raise ValueError('wasm custom section name is truncated')
            name = bytes(data[cursor:name_end]).decode('utf-8', 'replace')
        out.append(Section(kind, name, start, payload, end))
        at = end
    return tuple(out)


def section_layout(data):
    """Summarize semantic and removable custom section bytes."""
    sections = module_sections(data)
    return {
        'module_bytes': len(data),
        'semantic_section_bytes': 8 + sum(
            section.size for section in sections if section.kind),
        'custom_section_bytes': sum(
            section.size for section in sections if not section.kind),
        'sections': [
            {'kind': section.kind, 'name': section.name,
             'bytes': section.size, 'payload_bytes': section.payload_size}
            for section in sections
        ],
    }


def strip_custom_sections(data, keep=()):
    """Copy only the retained ranges of a linked runtime module once.

    ``data`` may be an mmap or memoryview.  Custom payloads are never copied
    into a temporary list: the returned bytearray is the one dense semantic
    artifact that a caller explicitly asked to produce.
    """
    keep = frozenset(keep)
    sections = module_sections(data)
    retained_size = 8 + sum(
        section.size for section in sections
        if section.kind or section.name in keep)
    kept = bytearray(retained_size)
    kept[:8] = data[:8]
    cursor = 8
    removed = []
    for section in sections:
        if section.kind or section.name in keep:
            following = cursor + section.size
            kept[cursor:following] = data[section.start:section.end]
            cursor = following
        else:
            removed.append(section)
    assert cursor == retained_size
    return kept, tuple(removed)


def _name(data, at):
    size, at = _uleb(data, at)
    return at + size


def _limits(data, at):
    flags, at = _uleb(data, at)
    _minimum, at = _uleb(data, at)
    if flags & 1:
        _maximum, at = _uleb(data, at)
    return at


@dataclass(frozen=True)
class FunctionType:
    params: tuple
    results: tuple


@dataclass(frozen=True)
class Body:
    ordinal: int
    function_index: int
    type_index: int
    start: int
    end: int

    @property
    def size(self):
        return self.end - self.start


class ModuleIndex(object):
    """Offsets and signatures needed to inspect or replace code bodies."""

    __slots__ = ('data', 'types', 'imported_functions', 'bodies',
                 'code_start', 'code_end')

    def __init__(self, data, types, imported_functions, bodies,
                 code_start, code_end):
        self.data = data
        self.types = tuple(types)
        self.imported_functions = imported_functions
        self.bodies = tuple(bodies)
        self.code_start = code_start
        self.code_end = code_end

    def decode(self, body):
        reader = _Reader(self.data, body.start, body.end)
        locals_ = []
        for _ in range(reader.uleb()):
            count, kind = reader.uleb(), _valtype(reader)
            if count > 1 << 20:
                raise ValueError('wasm function declares too many locals')
            locals_.extend([kind] * count)
        code, ends, elses = _decode_code(reader)
        if not reader.done():
            raise ValueError('wasm function body has trailing bytes')
        return tuple(locals_), code, ends, elses

    def rewrite(self, replacements):
        """Return the module with selected ordinal bodies replaced."""
        if self.code_start is None:
            if replacements:
                raise ValueError('cannot replace a body without a code section')
            return self.data
        replacements = dict(replacements)
        if not replacements:
            return self.data
        payload = bytearray(encode_uleb(len(self.bodies)))
        for body in self.bodies:
            raw = replacements.get(body.ordinal,
                                   self.data[body.start:body.end])
            payload += encode_uleb(len(raw))
            payload += raw
        section = b'\x0a' + encode_uleb(len(payload)) + bytes(payload)
        rewritten = bytearray(
            len(self.data) - (self.code_end - self.code_start) + len(section))
        first = self.code_start
        second = first + len(section)
        rewritten[:first] = self.data[:first]
        rewritten[first:second] = section
        rewritten[second:] = self.data[self.code_end:]
        return rewritten


def index_module(data):
    """Index a wasm binary without decoding every instruction in it."""
    if bytes(data[:8]) != b'\x00asm\x01\x00\x00\x00':
        raise ValueError('input is not a WebAssembly 1.0 binary')
    at = 8
    types = []
    imported_functions = 0
    defined_types = []
    code_payload = None
    code_start = code_end = None

    while at < len(data):
        section_start = at
        section_id = data[at]
        size, payload = _uleb(data, at + 1)
        end = payload + size
        if end > len(data):
            raise ValueError('wasm section exceeds the file')

        if section_id == 1:
            count, cursor = _uleb(data, payload)
            for _ in range(count):
                if data[cursor] != 0x60:
                    raise UnsupportedC('non-function wasm type is not modelled')
                cursor += 1
                pcount, cursor = _uleb(data, cursor)
                params = []
                for _ in range(pcount):
                    code = data[cursor]
                    cursor += 1
                    params.append({0x7F: 'i32', 0x7E: 'i64',
                                   0x7D: 'f32', 0x7C: 'f64',
                                   0x7B: 'v128', 0x70: 'funcref',
                                   0x6F: 'externref'}.get(code, 'other'))
                rcount, cursor = _uleb(data, cursor)
                results = []
                for _ in range(rcount):
                    code = data[cursor]
                    cursor += 1
                    results.append({0x7F: 'i32', 0x7E: 'i64',
                                    0x7D: 'f32', 0x7C: 'f64',
                                    0x7B: 'v128', 0x70: 'funcref',
                                    0x6F: 'externref'}.get(code, 'other'))
                types.append(FunctionType(tuple(params), tuple(results)))
            if cursor != end:
                raise ValueError('wasm type section has trailing bytes')
        elif section_id == 2:
            count, cursor = _uleb(data, payload)
            for _ in range(count):
                cursor = _name(data, cursor)
                cursor = _name(data, cursor)
                kind = data[cursor]
                cursor += 1
                if kind == 0:
                    _type_index, cursor = _uleb(data, cursor)
                    imported_functions += 1
                elif kind == 1:
                    cursor += 1
                    cursor = _limits(data, cursor)
                elif kind == 2:
                    cursor = _limits(data, cursor)
                elif kind == 3:
                    cursor += 2
                elif kind == 4:
                    cursor += 1
                    _type_index, cursor = _uleb(data, cursor)
                else:
                    raise UnsupportedC('wasm import kind %d is not modelled'
                                       % kind)
            if cursor != end:
                raise ValueError('wasm import section has trailing bytes')
        elif section_id == 3:
            count, cursor = _uleb(data, payload)
            defined_types = []
            for _ in range(count):
                type_index, cursor = _uleb(data, cursor)
                defined_types.append(type_index)
            if cursor != end:
                raise ValueError('wasm function section has trailing bytes')
        elif section_id == 10:
            code_payload = payload
            code_start, code_end = section_start, end
        at = end

    if code_payload is None:
        if defined_types:
            raise ValueError('wasm module has functions but no code section')
        return ModuleIndex(data, types, imported_functions, (), None, None)
    count, cursor = _uleb(data, code_payload)
    if count != len(defined_types):
        raise ValueError('wasm function and code section lengths disagree')
    bodies = []
    for ordinal, type_index in enumerate(defined_types):
        size, cursor = _uleb(data, cursor)
        start, end = cursor, cursor + size
        if end > code_end:
            raise ValueError('wasm function body exceeds the code section')
        bodies.append(Body(ordinal, imported_functions + ordinal,
                           type_index, start, end))
        cursor = end
    if cursor != code_end:
        raise ValueError('wasm code section has trailing bytes')
    return ModuleIndex(data, types, imported_functions, bodies,
                       code_start, code_end)


_ALLOWED = {
    'local.get', 'local.set', 'local.tee', 'drop', 'end',
    'i32.const', 'i64.const',
    'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
    'i32.shl', 'i32.shr_u', 'i32.shr_s',
    'i32.clz', 'i32.ctz', 'i32.popcnt',
    'i32.eqz', 'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u',
    'i32.gt_s', 'i32.gt_u', 'i32.le_s', 'i32.le_u',
    'i32.ge_s', 'i32.ge_u', 'select',
    'i64.add', 'i64.sub', 'i64.mul', 'i64.and', 'i64.or', 'i64.xor',
    'i64.shl', 'i64.shr_u', 'i64.shr_s',
    'i64.clz', 'i64.ctz', 'i64.popcnt',
}


def pure_integer_expression(index, body, max_body=4096):
    """Decode a closed, straight-line integer function body."""
    if body.size > max_body or body.type_index >= len(index.types):
        return None
    ftype = index.types[body.type_index]
    if (len(ftype.results) != 1
            or ftype.results[0] not in ('i32', 'i64')
            or any(param != ftype.results[0] for param in ftype.params)):
        return None
    try:
        locals_, code, _ends, _elses = index.decode(body)
    except (CFrontError, ValueError, IndexError):
        return None
    kind = ftype.results[0]
    if any(local != kind for local in locals_):
        return None
    if any(inst.op not in _ALLOWED for inst in code):
        return None
    if any(inst.op.startswith(('i32.', 'i64.'))
           and not inst.op.startswith(kind + '.') for inst in code):
        return None
    parameter_count = len(ftype.params)
    roots = {inst.args[0] for inst in code
             if inst.op == 'local.get' and inst.args[0] < parameter_count}
    writes_parameter = any(
        inst.op in ('local.set', 'local.tee')
        and inst.args[0] < parameter_count for inst in code)
    # Keeping the single-root representation lets whole-expression affine
    # extraction operate exactly as before. Multiple roots (and mutable wasm
    # parameters) use explicit SSA leaves and still receive fixed-point local
    # substitution, common-subexpression elimination, and dead-code removal.
    root_local = (next(iter(roots)) if roots else 0)
    if not ftype.params or len(roots) > 1 or writes_parameter:
        root_local = None
    return ftype, locals_, code, root_local


def pure_single_input(index, body, max_body=4096):
    """Compatibility name for the now multi-input admission pass."""
    return pure_integer_expression(index, body, max_body=max_body)


# Kept as a source-compatible name for callers that used the first version.
pure_unary = pure_single_input


class _StateModule(object):
    __slots__ = ('functions',)

    def __init__(self, function):
        self.functions = (function,)


def state_integer_expression(index, body, max_body=4096):
    """Return one complete straight-line integer/memory state-step plan."""
    if body.size > max_body or body.type_index >= len(index.types):
        return None
    ftype = index.types[body.type_index]
    if (len(ftype.results) > 1
            or any(kind not in ('i32', 'i64')
                   for kind in ftype.params + ftype.results)):
        return None
    try:
        locals_, code, _ends, _elses = index.decode(body)
    except (CFrontError, ValueError, IndexError):
        return None
    if any(kind not in ('i32', 'i64') for kind in locals_):
        return None
    if not code or code[-1].op != 'end':
        return None

    from .wasmstate import Frame, Function
    from .wasmwave import compile_slice, is_barrier

    if any(is_barrier(instruction.op) for instruction in code[:-1]):
        return None

    function = Function(body.type_index, locals_, code)
    frame = Frame(0, 0, tuple(0 for _ in ftype.params + locals_), ())
    try:
        plan = compile_slice(_StateModule(function), frame)
    except (CFrontError, ValueError, IndexError):
        return None
    if (plan is None or plan.start != 0 or plan.end != len(code) - 1
            or plan.stack_inputs or len(plan.stack) != len(ftype.results)):
        return None
    return ftype, locals_, code, plan


class _NotLowerable(Exception):
    pass


def lower_sequence(ftype, locals_, code, root_local=0):
    """Translate one accepted wasm stack expression into exact SSA."""
    kind = ftype.results[0]
    bits = 32 if kind == 'i32' else 64
    mask = mask_of(bits)
    seq = isa.Seq()
    if root_local is None:
        local_values = []
        for index in range(len(ftype.params)):
            input_value = seq.emit('WASM_PARAM', [], const=index)
            if bits == 32:
                input_value = seq.emit('AND', [input_value], const=mask)
            local_values.append(('value', input_value))
        local_values += [('const', 0)] * len(locals_)
    else:
        input_value = 0
        if bits == 32:
            input_value = seq.emit('AND', [0], const=mask)
        local_values = [None] * len(ftype.params) + [('const', 0)] * len(locals_)
        local_values[root_local] = ('value', input_value)
    stack = []

    def pop():
        if not stack:
            raise _NotLowerable('empty wasm value stack')
        return stack.pop()

    def constant(item):
        return item[1] if item[0] == 'const' else None

    def value(item):
        if item[0] == 'value':
            return item[1]
        zero = seq.emit('WASM_ZERO', [])
        if item[1]:
            zero = seq.emit('OR', [zero], const=item[1] & mask)
        return zero

    def wrap(result, needed):
        if bits == 32 and needed:
            result = seq.emit('AND', [result], const=mask)
        return ('value', result)

    def fold_binary(name, left, right):
        a, b = constant(left), constant(right)
        if a is not None and b is not None:
            shift = b % bits
            if name == 'add': out = a + b
            elif name == 'sub': out = a - b
            elif name == 'mul': out = a * b
            elif name == 'and': out = a & b
            elif name == 'or': out = a | b
            elif name == 'xor': out = a ^ b
            elif name == 'shl': out = a << shift
            elif name == 'shr_u': out = a >> shift
            elif name == 'shr_s':
                sign = 1 << (bits - 1)
                signed = a - (1 << bits) if a & sign else a
                out = signed >> shift
            else: raise _NotLowerable(name)
            return ('const', out & mask)

        if name in ('shl', 'shr_u', 'shr_s'):
            if b is None:
                raise _NotLowerable('dynamic shift')
            op = {'shl': 'SHL', 'shr_u': 'SHR', 'shr_s': 'SAR'}[name]
            return wrap(seq.emit(op, [value(left)], shift=b % bits),
                        name in ('shl', 'shr_s'))

        if name in ('and', 'or', 'xor'):
            op = {'and': 'AND', 'or': 'OR', 'xor': 'XOR'}[name]
            rr = {'and': 'ANDR', 'or': 'ORR', 'xor': 'XORR'}[name]
            if b is not None:
                return ('value', seq.emit(op, [value(left)], const=b & mask))
            if a is not None:
                return ('value', seq.emit(op, [value(right)], const=a & mask))
            return ('value', seq.emit(rr, [value(left), value(right)]))

        if name == 'add':
            if b is not None:
                out = seq.emit('ADD', [value(left)], const=b & mask)
            elif a is not None:
                out = seq.emit('ADD', [value(right)], const=a & mask)
            else:
                out = seq.emit('ADDR', [value(left), value(right)])
            return wrap(out, True)
        if name == 'sub':
            if b is not None:
                out = seq.emit('SUB', [value(left)], const=b & mask)
            elif a is not None:
                out = seq.emit('NEG', [value(right)])
                out = seq.emit('ADD', [out], const=a & mask)
            else:
                out = seq.emit('SUBR', [value(left), value(right)])
            return wrap(out, True)
        if name == 'mul':
            if b is not None:
                out = seq.emit('IMUL', [value(left)], const=b & mask)
            elif a is not None:
                out = seq.emit('IMUL', [value(right)], const=a & mask)
            else:
                raise _NotLowerable('variable multiply')
            return wrap(out, True)
        raise _NotLowerable(name)

    def fold_comparison(name, left, right):
        a, b = constant(left), constant(right)
        if a is not None and b is not None:
            sign = 1 << (bits - 1)
            signed_a = a - (1 << bits) if a & sign else a
            signed_b = b - (1 << bits) if b & sign else b
            if name == 'eq': out = a == b
            elif name == 'ne': out = a != b
            elif name == 'lt_u': out = a < b
            elif name == 'gt_u': out = a > b
            elif name == 'le_u': out = a <= b
            elif name == 'ge_u': out = a >= b
            elif name == 'lt_s': out = signed_a < signed_b
            elif name == 'gt_s': out = signed_a > signed_b
            elif name == 'le_s': out = signed_a <= signed_b
            elif name == 'ge_s': out = signed_a >= signed_b
            else: raise _NotLowerable(name)
            return ('const', int(out))
        op = 'WASM_' + name.upper()
        return ('value', seq.emit(op, [value(left), value(right)]))

    for inst in code:
        op = inst.op
        if op == 'end':
            continue
        if op == 'local.get':
            item = local_values[inst.args[0]]
            if item is None:
                raise _NotLowerable('function depends on another parameter')
            stack.append(item)
        elif op == 'local.set':
            local_values[inst.args[0]] = pop()
        elif op == 'local.tee':
            item = pop()
            local_values[inst.args[0]] = item
            stack.append(item)
        elif op == 'drop':
            pop()
        elif op in ('i32.const', 'i64.const'):
            stack.append(('const', inst.args[0] & mask))
        elif op == 'select':
            condition, false_value, true_value = pop(), pop(), pop()
            known = constant(condition)
            if known is not None:
                stack.append(true_value if known else false_value)
            else:
                stack.append(('value', seq.emit(
                    'WASM_SELECT',
                    [value(true_value), value(false_value), value(condition)])))
        elif op == 'i32.eqz':
            item = pop()
            number = constant(item)
            stack.append(('const', int(number == 0)) if number is not None
                         else ('value', seq.emit('WASM_EQZ', [value(item)])))
        elif op.split('.', 1)[1] in ('clz', 'ctz', 'popcnt'):
            item = pop()
            number = constant(item)
            name = op.split('.', 1)[1]
            if number is not None:
                if name == 'clz': out = bits - number.bit_length()
                elif name == 'ctz':
                    out = bits if not number else (number & -number).bit_length() - 1
                else: out = number.bit_count()
                stack.append(('const', out))
            else:
                stack.append(('value', seq.emit(
                    {'clz': 'CLZ', 'ctz': 'CTZ', 'popcnt': 'POPCNT'}[name],
                    [value(item)])))
        else:
            name = op.split('.', 1)[1]
            right, left = pop(), pop()
            if name in ('eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
                        'le_s', 'le_u', 'ge_s', 'ge_u'):
                stack.append(fold_comparison(name, left, right))
            else:
                stack.append(fold_binary(name, left, right))

    if not stack:
        raise _NotLowerable('function produced no result')
    result = stack[-1]
    seq.result = value(result)
    return isa.dead_code(seq)


_WASM_OPCODE = dict((name, opcode) for opcode, name in _PLAIN.items())
_WASM_MEMORY_OPCODE = dict(
    (shape[0], opcode) for opcode, shape in _MEMORY.items())


def _encode_local_groups(locals_):
    groups = []
    for kind in locals_:
        if groups and groups[-1][1] == kind:
            groups[-1] = (groups[-1][0] + 1, kind)
        else:
            groups.append((1, kind))
    raw = bytearray(encode_uleb(len(groups)))
    for count, kind in groups:
        raw += encode_uleb(count)
        raw.append(VALTYPE[kind])
    return raw


def _state_node_type(operation):
    name = operation.removeprefix('memory.')
    if '.store' in name:
        return None
    kind, suffix = name.split('.', 1)
    if suffix in ('eqz', 'eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
                  'le_s', 'le_u', 'ge_s', 'ge_u'):
        return 'i32'
    return kind


def _state_argument_types(operation):
    name = operation.removeprefix('memory.')
    kind, suffix = name.split('.', 1)
    if '.load' in name:
        return ('i32',)
    if '.store' in name:
        return 'i32', kind
    if suffix == 'wrap_i64':
        return ('i64',)
    if suffix in ('extend_i32_s', 'extend_i32_u'):
        return ('i32',)
    if suffix in ('eqz', 'clz', 'ctz', 'popcnt',
                  'extend8_s', 'extend16_s', 'extend32_s'):
        return (kind,)
    return kind, kind


def encode_state_plan(ftype, locals_, plan):
    """Encode one normalized integer/memory cut back to a Wasm function."""
    from .stepnormalize import _semantic_cut

    plan = _semantic_cut(plan)
    nodes = dict((node.value, node) for node in plan.nodes)
    if any(not node.op.startswith(('i32.', 'i64.', 'memory.'))
           for node in plan.nodes):
        raise _NotLowerable('physical lane has no direct wasm spelling')

    def data_arguments(node):
        if node.op.startswith('memory.'):
            return node.arguments[:2 if '.store' in node.op else 1]
        return node.arguments

    uses = dict((value, 0) for value in nodes)
    for node in plan.nodes:
        for operand in data_arguments(node):
            if operand.kind == 'node':
                uses[operand.value] += 1
    for operand in plan.stack:
        if operand.kind == 'node':
            uses[operand.value] += 1
    # Memory observations are roots even when their value feeds another node:
    # this preserves their source order relative to stores and traps.
    for node in plan.nodes:
        if node.op.startswith('memory.') and '.store' not in node.op:
            uses[node.value] += 1

    original_local_types = tuple(ftype.params) + tuple(locals_)
    shared = {}
    temp_types = []
    for node in plan.nodes:
        kind = _state_node_type(node.op)
        if kind is not None and uses[node.value] > 1:
            shared[node.value] = len(original_local_types) + len(temp_types)
            temp_types.append(kind)

    emitted = set()
    wasm_work = 0

    def constant(value, kind):
        bits = 32 if kind == 'i32' else 64
        sign = 1 << (bits - 1)
        value &= mask_of(bits)
        value = value - (1 << bits) if value & sign else value
        opcode = 0x41 if kind == 'i32' else 0x42
        return bytes([opcode]) + encode_sleb(value, bits)

    def operand_bytes(operand, kind):
        def coerce(raw, actual):
            nonlocal wasm_work
            if actual == kind:
                return raw
            if actual == 'i32' and kind == 'i64':
                wasm_work += 1
                return raw + bytes([_WASM_OPCODE['i64.extend_i32_u']])
            if actual == 'i64' and kind == 'i32':
                wasm_work += 1
                return raw + bytes([_WASM_OPCODE['i32.wrap_i64']])
            raise _NotLowerable('cannot restore a wasm publication type')

        if operand.kind == 'const':
            return constant(operand.value, kind)
        if operand.kind == 'local':
            if operand.value >= len(original_local_types):
                raise _NotLowerable('state plan names an unknown local')
            raw = b'\x20' + encode_uleb(operand.value)
            return coerce(raw, original_local_types[operand.value])
        if operand.kind != 'node' or operand.value not in nodes:
            raise _NotLowerable('state plan has an unknown operand')
        raw = node_bytes(nodes[operand.value])
        return coerce(raw, _state_node_type(nodes[operand.value].op))

    def memory_bytes(node):
        nonlocal wasm_work
        name = node.op.removeprefix('memory.')
        arguments = data_arguments(node)
        kinds = _state_argument_types(node.op)
        raw = operand_bytes(arguments[0], kinds[0])
        shape = node.arguments[3 if '.store' in name else 2]
        offset = node.arguments[2 if '.store' in name else 1]
        if shape.kind != 'const' or offset.kind != 'const':
            raise _NotLowerable('memory shape is not a physical constant')
        width, scale = shape.value & 0xff, shape.value >> 8
        if scale:
            raw += constant(scale, 'i32')
            raw += bytes([_WASM_OPCODE['i32.shl']])
            wasm_work += 1
        if '.store' in name:
            raw += operand_bytes(arguments[1], kinds[1])
        alignment = max(0, int(width).bit_length() - 1)
        try:
            opcode = _WASM_MEMORY_OPCODE[name]
        except KeyError:
            raise _NotLowerable('cannot emit %s to wasm' % name)
        return (raw + bytes([opcode]) + encode_uleb(alignment)
                + encode_uleb(offset.value))

    def node_bytes(node):
        nonlocal wasm_work
        if node.value in emitted:
            return b'\x20' + encode_uleb(shared[node.value])
        if node.op.startswith('memory.'):
            raw = memory_bytes(node)
        else:
            argument_types = _state_argument_types(node.op)
            if len(argument_types) != len(node.arguments):
                raise _NotLowerable('cannot emit %s argument shape'
                                    % node.op)
            raw = b''.join(
                operand_bytes(operand, kind)
                for operand, kind in zip(node.arguments, argument_types))
            try:
                raw += bytes([_WASM_OPCODE[node.op]])
            except KeyError:
                raise _NotLowerable('cannot emit %s to wasm' % node.op)
        wasm_work += 1
        if node.value in shared:
            emitted.add(node.value)
            raw += b'\x22' + encode_uleb(shared[node.value])
        return raw

    body = _encode_local_groups(tuple(locals_) + tuple(temp_types))
    for node in plan.nodes:
        if not node.op.startswith('memory.'):
            continue
        if '.store' in node.op:
            body += node_bytes(node)
        else:
            body += node_bytes(node) + b'\x1a'
    for operand, kind in zip(plan.stack, ftype.results):
        body += operand_bytes(operand, kind)
    body += b'\x0b'
    return bytes(body), wasm_work


def _instruction_bytes(seq, index, kind, root_local, memo):
    if index == 0:
        if root_local is None:
            raise _NotLowerable('multi-input expression retained an implicit root')
        return b'\x20' + encode_uleb(root_local), 0
    if index in memo:
        return memo[index]
    ins = seq.ins[index - 1]
    if ins.op == 'WASM_PARAM':
        raw = b'\x20' + encode_uleb(ins.const)
        memo[index] = raw, 0
        return raw, 0
    if ins.op == 'WASM_ZERO':
        raw = bytes([0x41 if kind == 'i32' else 0x42, 0])
        memo[index] = raw, 0
        return raw, 0
    args = [_instruction_bytes(seq, arg, kind, root_local, memo)
            for arg in ins.args]
    if kind == 'i32' and ins.op == 'AND' and ins.const == I32:
        memo[index] = args[0]
        return args[0]
    prefix = b''.join(item[0] for item in args)
    work = sum(item[1] for item in args)
    bits = 32 if kind == 'i32' else 64
    const_op = 0x41 if bits == 32 else 0x42

    def const(value):
        sign = 1 << (bits - 1)
        value &= mask_of(bits)
        value = value - (1 << bits) if value & sign else value
        return bytes([const_op]) + encode_sleb(value, bits)

    binary = {
        'IMUL': 'mul', 'AND': 'and', 'OR': 'or', 'XOR': 'xor',
        'ADD': 'add', 'SUB': 'sub', 'SHL': 'shl', 'SHR': 'shr_u',
        'SAR': 'shr_s',
    }
    rr = {'XORR': 'xor', 'ANDR': 'and', 'ORR': 'or',
          'ADDR': 'add', 'SUBR': 'sub'}
    wasm_opaque = {
        'WASM_EQZ': 'eqz', 'WASM_EQ': 'eq', 'WASM_NE': 'ne',
        'WASM_LT_S': 'lt_s', 'WASM_LT_U': 'lt_u',
        'WASM_GT_S': 'gt_s', 'WASM_GT_U': 'gt_u',
        'WASM_LE_S': 'le_s', 'WASM_LE_U': 'le_u',
        'WASM_GE_S': 'ge_s', 'WASM_GE_U': 'ge_u',
        'WASM_SELECT': None,
    }
    if ins.op in binary:
        immediate = ins.shift if ins.shift is not None else ins.const
        raw = prefix + const(immediate)
        raw += bytes([_WASM_OPCODE[kind + '.' + binary[ins.op]]])
        work += 1
    elif ins.op in rr:
        raw = prefix + bytes([_WASM_OPCODE[kind + '.' + rr[ins.op]]])
        work += 1
    elif ins.op in wasm_opaque:
        name = wasm_opaque[ins.op]
        opcode = _WASM_OPCODE['select' if name is None else kind + '.' + name]
        raw = prefix + bytes([opcode])
        work += 1
    elif ins.op == 'NOT':
        raw = prefix + const(-1) + bytes([_WASM_OPCODE[kind + '.xor']])
        work += 1
    elif ins.op == 'NEG':
        raw = const(0) + prefix + bytes([_WASM_OPCODE[kind + '.sub']])
        work += 1
    elif ins.op in ('POPCNT', 'CLZ', 'CTZ'):
        name = {'POPCNT': 'popcnt', 'CLZ': 'clz', 'CTZ': 'ctz'}[ins.op]
        raw = prefix + bytes([_WASM_OPCODE[kind + '.' + name]])
        work += 1
    elif ins.op == 'ANDNR':
        left, right = args
        raw = (left[0] + const(-1)
               + bytes([_WASM_OPCODE[kind + '.xor']])
               + right[0] + bytes([_WASM_OPCODE[kind + '.and']]))
        work = left[1] + right[1] + 2
    elif ins.op == 'SCANXOR':
        source = args[0]
        raw = (source[0] + source[0] + const(ins.shift)
               + bytes([_WASM_OPCODE[kind + '.shl']])
               + bytes([_WASM_OPCODE[kind + '.xor']]))
        work = source[1] * 2 + 2
    else:
        raise _NotLowerable('cannot emit %s to wasm' % ins.op)
    memo[index] = raw, work
    return raw, work


def encode_sequence(seq, kind, root_local=0):
    """Encode a normalized SSA result as one stack expression body."""
    expression, work = _instruction_bytes(seq, seq.result, kind,
                                          root_local, {})
    return b'\x00' + expression + b'\x0b', work


@dataclass(frozen=True)
class Replacement:
    body: Body
    raw: bytes
    original_size: int
    original_work: int
    replacement_work: int
    before_ops: tuple
    after_ops: tuple

    @property
    def saved_bytes(self):
        return self.original_size - len(self.raw)


def optimize_module(data, max_body=4096):
    """Return rewritten bytes and the report for every improving body."""
    index = index_module(data)
    replacements = []
    failures = []
    decoded = 0
    lowerable = 0
    decoded_state = 0
    lowerable_state = 0
    unencodable_state = 0
    forwarded_memory_loads = 0
    state_physical_work = 0
    reencodable_state_physical_work = 0
    state_reencoded_work = 0
    reencoded_materializations = 0
    rejected_typed_wasm_improvements = 0
    parallel_slices = 0
    physical_work = 0
    physical_span = 0
    max_wave_width = 0
    max_slice_span = 0
    for body in index.bodies:
        pure = pure_integer_expression(index, body, max_body=max_body)
        state_route = pure is None
        if pure is not None:
            decoded += 1
            ftype, locals_, code, root_local = pure
            try:
                before = lower_sequence(ftype, locals_, code, root_local)
                after = isa.normalize(before)
                raw, work = encode_sequence(
                    after, ftype.results[0], root_local)
            except (_NotLowerable, ValueError, IndexError) as error:
                failures.append({
                    'function_index': body.function_index,
                    'reason': str(error),
                })
                continue
            lowerable += 1
            from .wasmphysical import schedule_sequence
            waves = schedule_sequence(after)
            before_ops = tuple(ins.op for ins in before.ins)
            after_ops = tuple(ins.op for ins in after.ins)
        else:
            state = state_integer_expression(
                index, body, max_body=max_body)
            if state is None:
                continue
            decoded_state += 1
            ftype, locals_, code, plan = state
            waves = plan.waves
            state_physical_work += waves.work
            raw = None
            work = None
            try:
                raw, work = encode_state_plan(ftype, locals_, plan)
            except (_NotLowerable, ValueError, IndexError):
                # Typed Wasm is only a diagnostic publication format. A lane
                # without that spelling is still a valid physical state page
                # and must not disappear from state-route accounting.
                unencodable_state += 1
            else:
                lowerable_state += 1
                reencodable_state_physical_work += waves.work
                state_reencoded_work += work
                reencoded_materializations += max(0, work - waves.work)
            source_loads = sum(
                '.load' in instruction.op for instruction in code)
            remaining_loads = sum(
                node.op.startswith('memory.') and '.load' in node.op
                for node in plan.nodes)
            forwarded_memory_loads += max(0, source_loads - remaining_loads)
            before_ops = tuple(instruction.op for instruction in code
                               if instruction.op != 'end')
            after_ops = tuple(node.op for node in plan.nodes)
        wave_layout = waves.layout()
        physical_work += waves.work
        physical_span += waves.span
        max_wave_width = max(max_wave_width,
                             wave_layout['max_parallel_width'])
        max_slice_span = max(max_slice_span, waves.span)
        if wave_layout['max_parallel_width'] > 1:
            parallel_slices += 1
        original_work = sum(1 for inst in code
                            if inst.op not in ('local.get', 'local.set',
                                               'local.tee', 'drop', 'end')
                            and not inst.op.endswith('.const'))
        if state_route:
            if (raw is not None and work < original_work
                    and len(raw) < body.size):
                rejected_typed_wasm_improvements += 1
            continue
        if work >= original_work or len(raw) >= body.size:
            continue
        replacements.append(Replacement(
            body, raw, body.size, original_work, work,
            before_ops, after_ops,
        ))

    rewritten = index.rewrite({item.body.ordinal: item.raw
                               for item in replacements})
    report = {
        'module_bytes': len(index.data),
        'functions': len(index.bodies),
        'imported_functions': index.imported_functions,
        'decoded_pure_integer_expressions': decoded,
        # Retained for scripts that consumed the first report schema.
        'decoded_pure_single_coordinate': decoded,
        'lowerable': lowerable,
        'decoded_state_integer_expressions': decoded_state,
        'lowerable_state_integer_expressions': lowerable_state,
        'unencodable_state_integer_expressions': unencodable_state,
        'forwarded_memory_loads': forwarded_memory_loads,
        'state_physical_work': state_physical_work,
        'reencodable_state_physical_work':
            reencodable_state_physical_work,
        'state_reencoded_work': state_reencoded_work,
        'reencoded_materializations': reencoded_materializations,
        'rejected_typed_wasm_improvements':
            rejected_typed_wasm_improvements,
        'lowering_failures': failures,
        'physical_work': physical_work,
        'physical_span_sum': physical_span,
        'parallel_slices': parallel_slices,
        'max_wave_width': max_wave_width,
        'max_slice_span': max_slice_span,
        'replaced': len(replacements),
        'saved_body_bytes': sum(item.saved_bytes for item in replacements),
        'output_bytes': len(rewritten),
        'replacements': replacements,
    }
    return rewritten, report
