"""Mmap-shaped physical codec for one pure WebAssembly slice.

The semantic input remains the decoded WebAssembly module.  This codec is a
deterministic, disposable execution cache derived from it.  One blob is one
maximal pure slice, so a caller can fetch/map only the slice named by the
current ``(function, pc)``.  Its physical domains are::

    slice instructions  Region(start_pc, end_pc)
    waves               Region(0, span)
    lanes               Segment(wave_offsets[d], wave_offsets[d + 1])
    operands            Segment(argument_offsets[v], argument_offsets[v + 1])

Nodes in one lane segment have no mutual dependency.  The runtime therefore
orders wave segments, not source instructions.  All columns are little-endian,
fixed-width, and 8-byte aligned; :func:`unpack` keeps memoryviews into the
caller's bytes rather than expanding an object graph.
"""

from dataclasses import dataclass
import struct

from .cfront.errors import CFrontError


MAGIC = b'QMW1'
VERSION = 1
I64 = (1 << 64) - 1

# This is a global physical vocabulary, not a per-file dictionary.  Giving the
# same short code a different operation in another slice would make a cached
# page depend on an omitted decoder.
_COMMON_UNARY = ('eqz', 'clz', 'ctz', 'popcnt')
_BINARY = ('eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
           'le_s', 'le_u', 'ge_s', 'ge_u',
           'add', 'sub', 'mul', 'and', 'or', 'xor',
           'shl', 'shr_s', 'shr_u', 'rotl', 'rotr',
           'div_s', 'div_u', 'rem_s', 'rem_u')
OPS = (
    'select',
    'i32.wrap_i64',
) + tuple('i32.%s' % name for name in _COMMON_UNARY + _BINARY) + (
    'i64.extend_i32_s',
    'i64.extend_i32_u',
) + tuple('i64.%s' % name for name in _COMMON_UNARY + _BINARY)
OP_TO_CODE = dict((name, code) for code, name in enumerate(OPS))

OPERAND_KINDS = ('const', 'stack', 'local', 'node')
OPERAND_TO_TAG = dict((name, tag)
                      for tag, name in enumerate(OPERAND_KINDS))

# magic, version, header bytes, then:
# function, start, end, source instructions, span, work, operand values,
# input stack extent, stack outputs, local outputs.
_HEADER = struct.Struct('<4sHH10I')
_DIRECTORY_ENTRY = struct.Struct('<II')       # byte offset, element count

_COLUMNS = (
    ('wave_offsets', 4),
    ('lane_values', 4),
    ('opcodes', 1),
    ('argument_offsets', 4),
    ('operand_tags', 1),
    ('operand_values', 8),
    ('stack_tags', 1),
    ('stack_values', 8),
    ('local_tags', 1),
    ('local_values', 8),
)


class WaveCodecError(CFrontError):
    """The physical slice is malformed or not canonical."""


def _align(value, alignment=8):
    return (value + alignment - 1) & -alignment


HEADER_BYTES = _align(_HEADER.size + len(_COLUMNS) * _DIRECTORY_ENTRY.size)


def _operand_columns(operands):
    tags = []
    values = []
    for operand in operands:
        try:
            tags.append(OPERAND_TO_TAG[operand.kind])
        except KeyError:
            raise ValueError('unknown wave operand kind %r' % operand.kind)
        value = int(operand.value)
        if operand.kind != 'const' and value < 0:
            raise ValueError('%s coordinate must be nonnegative' % operand.kind)
        values.append(value & I64)
    return tags, values


def _column_bytes(width, values):
    if width == 1:
        return bytes(values)
    code = '<I' if width == 4 else '<Q'
    return b''.join(struct.pack(code, int(value)) for value in values)


def pack(plan):
    """Encode one :class:`qm.wasmwave.PureSlice` into its physical cache."""
    nodes = tuple(plan.nodes)
    work = len(nodes)
    lane_values = tuple(plan.waves.values)
    if plan.waves.work != work or sorted(lane_values) != list(range(1, work + 1)):
        raise ValueError('wave lanes must contain every node exactly once')

    opcodes = []
    argument_offsets = [0]
    operands = []
    for expected, node in enumerate(nodes, start=1):
        if node.value != expected:
            raise ValueError('wave node values must be dense from one')
        try:
            opcodes.append(OP_TO_CODE[node.op])
        except KeyError:
            raise ValueError('wave operation %r has no physical code' % node.op)
        operands.extend(node.arguments)
        argument_offsets.append(len(operands))

    operand_tags, operand_values = _operand_columns(operands)
    stack_tags, stack_values = _operand_columns(plan.stack)
    local_tags, local_values = _operand_columns(plan.locals)
    stack_inputs = int(plan.stack_inputs)
    if stack_inputs < 0:
        raise ValueError('input stack extent must be nonnegative')
    values = {
        'wave_offsets': tuple(plan.waves.offsets),
        'lane_values': lane_values,
        'opcodes': opcodes,
        'argument_offsets': argument_offsets,
        'operand_tags': operand_tags,
        'operand_values': operand_values,
        'stack_tags': stack_tags,
        'stack_values': stack_values,
        'local_tags': local_tags,
        'local_values': local_values,
    }

    encoded = {}
    directory = []
    cursor = HEADER_BYTES
    for name, width in _COLUMNS:
        cursor = _align(cursor)
        raw = _column_bytes(width, values[name])
        encoded[name] = raw
        directory.append((cursor, len(values[name])))
        cursor += len(raw)

    blob = bytearray(cursor)
    _HEADER.pack_into(
        blob, 0, MAGIC, VERSION, HEADER_BYTES,
        int(plan.function), int(plan.start), int(plan.end),
        int(plan.instructions), int(plan.waves.span), work, len(operands),
        stack_inputs, len(plan.stack), len(plan.locals),
    )
    at = _HEADER.size
    for entry in directory:
        _DIRECTORY_ENTRY.pack_into(blob, at, *entry)
        at += _DIRECTORY_ENTRY.size
    for (name, _width), (offset, _count) in zip(_COLUMNS, directory):
        blob[offset:offset + len(encoded[name])] = encoded[name]
    return bytes(blob)


@dataclass(frozen=True)
class _Column:
    offset: int
    count: int
    width: int


class MappedWaveSlice(object):
    """A validated zero-copy view of one physical slice blob."""

    __slots__ = ('data', 'function', 'start', 'end', 'instructions',
                 'span', 'work', 'operands', 'stack_inputs',
                 'stack_count', 'local_count',
                 '_columns')

    def __init__(self, data, header, columns):
        self.data = data
        (self.function, self.start, self.end, self.instructions,
         self.span, self.work, self.operands,
         self.stack_inputs, self.stack_count, self.local_count) = header
        self._columns = columns

    def column(self, name):
        """Raw mapped bytes for a physical column, without a copy."""
        column = self._columns[name]
        end = column.offset + column.count * column.width
        return self.data[column.offset:end]

    def values(self, name):
        column = self._columns[name]
        raw = self.column(name)
        if column.width == 1:
            return tuple(raw)
        code = '<I' if column.width == 4 else '<Q'
        return tuple(item[0] for item in struct.iter_unpack(code, raw))

    def value(self, name, index):
        """Read one physical coordinate without decoding its whole column."""
        column = self._columns[name]
        if index < 0 or index >= column.count:
            raise IndexError('%s coordinate is outside its region' % name)
        offset = column.offset + index * column.width
        if column.width == 1:
            return self.data[offset]
        code = '<I' if column.width == 4 else '<Q'
        return struct.unpack_from(code, self.data, offset)[0]

    def wave(self, depth):
        if depth < 1 or depth > self.span:
            raise IndexError('wave depth is outside the slice')
        offsets = self.values('wave_offsets')
        lanes = self.values('lane_values')
        return lanes[offsets[depth - 1]:offsets[depth]]

    def layout(self):
        offsets = self.values('wave_offsets')
        widths = [offsets[index + 1] - offsets[index]
                  for index in range(self.span)]
        return {
            'kind': 'wasm-wave-slice',
            'function': self.function,
            'slice_region': [self.start, self.end],
            'wasm_instructions': self.instructions,
            'work': self.work,
            'span': self.span,
            'wave_offsets': list(offsets),
            'wave_widths': widths,
            'max_parallel_width': max(widths, default=0),
            'input_stack_slots': self.stack_inputs,
            'output_stack_slots': self.stack_count,
            'local_slots': self.local_count,
            'mapped_bytes': len(self.data),
            'columns': {
                name: {
                    'offset': column.offset,
                    'count': column.count,
                    'width': column.width,
                }
                for name, column in self._columns.items()
            },
        }


def _expected_counts(span, work, operands, stack_count, local_count):
    return {
        'wave_offsets': span + 1,
        'lane_values': work,
        'opcodes': work,
        'argument_offsets': work + 1,
        'operand_tags': operands,
        'operand_values': operands,
        'stack_tags': stack_count,
        'stack_values': stack_count,
        'local_tags': local_count,
        'local_values': local_count,
    }


def unpack(blob):
    """Validate and map one slice without expanding its physical columns."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < HEADER_BYTES:
        raise WaveCodecError('wave slice header is truncated')
    magic, version, header_bytes, *header = _HEADER.unpack_from(data, 0)
    if magic != MAGIC or version != VERSION or header_bytes != HEADER_BYTES:
        raise WaveCodecError('wave slice has an unknown physical format')
    (function, start, end, instructions, span, work, operands,
     stack_inputs, stack_count, local_count) = header
    if end < start or instructions != end - start:
        raise WaveCodecError('wave slice instruction region is inconsistent')

    expected_counts = _expected_counts(
        span, work, operands, stack_count, local_count)
    columns = {}
    cursor = HEADER_BYTES
    directory_at = _HEADER.size
    directory_end = _HEADER.size + len(_COLUMNS) * _DIRECTORY_ENTRY.size
    if any(data[directory_end:HEADER_BYTES]):
        raise WaveCodecError('wave slice header padding is not canonical')
    for name, width in _COLUMNS:
        offset, count = _DIRECTORY_ENTRY.unpack_from(data, directory_at)
        directory_at += _DIRECTORY_ENTRY.size
        aligned = _align(cursor)
        if any(data[cursor:aligned]):
            raise WaveCodecError('wave slice column padding is not canonical')
        cursor = aligned
        if count != expected_counts[name] or offset != cursor:
            raise WaveCodecError('wave slice %s column is not canonical' % name)
        end_offset = offset + count * width
        if end_offset > len(data):
            raise WaveCodecError('wave slice %s column is truncated' % name)
        columns[name] = _Column(offset, count, width)
        cursor = end_offset
    if cursor != len(data):
        raise WaveCodecError('wave slice has trailing bytes')

    mapped = MappedWaveSlice(data, tuple(header), columns)
    _validate(mapped)
    return mapped


def _validate(mapped):
    wave_offsets = mapped.values('wave_offsets')
    lanes = mapped.values('lane_values')
    argument_offsets = mapped.values('argument_offsets')
    tags = mapped.values('operand_tags')
    values = mapped.values('operand_values')
    opcodes = mapped.values('opcodes')
    if (not wave_offsets or wave_offsets[0] != 0
            or wave_offsets[-1] != mapped.work
            or any(a > b for a, b in zip(wave_offsets, wave_offsets[1:]))):
        raise WaveCodecError('wave boundaries are not a segmented region')
    if sorted(lanes) != list(range(1, mapped.work + 1)):
        raise WaveCodecError('wave lanes do not form the node domain')
    if (not argument_offsets or argument_offsets[0] != 0
            or argument_offsets[-1] != mapped.operands
            or any(a > b for a, b in zip(argument_offsets,
                                         argument_offsets[1:]))):
        raise WaveCodecError('argument boundaries are not a segmented region')
    if any(code >= len(OPS) for code in opcodes):
        raise WaveCodecError('wave slice contains an unknown operation')
    if any(tag >= len(OPERAND_KINDS) for tag in tags):
        raise WaveCodecError('wave slice contains an unknown operand kind')

    depth = [0] * (mapped.work + 1)
    for wave in range(1, mapped.span + 1):
        for value in mapped.wave(wave):
            depth[value] = wave
    for node in range(1, mapped.work + 1):
        begin, end = argument_offsets[node - 1:node + 1]
        for tag, value in zip(tags[begin:end], values[begin:end]):
            kind = OPERAND_KINDS[tag]
            if kind == 'node' and (value < 1 or value > mapped.work
                                   or depth[value] >= depth[node]):
                raise WaveCodecError('a wave lane depends on its own/later wave')
            if kind == 'stack' and value >= mapped.stack_inputs:
                raise WaveCodecError('stack operand is outside the frame region')
            if kind == 'local' and value >= mapped.local_count:
                raise WaveCodecError('local operand is outside the frame region')
    for tag_name, value_name, count in (
            ('stack_tags', 'stack_values', mapped.stack_count),
            ('local_tags', 'local_values', mapped.local_count)):
        for tag, value in zip(mapped.values(tag_name), mapped.values(value_name)):
            if tag >= len(OPERAND_KINDS):
                raise WaveCodecError('wave output has an unknown operand kind')
            kind = OPERAND_KINDS[tag]
            if kind == 'node' and not 1 <= value <= mapped.work:
                raise WaveCodecError('wave output node is outside the slice')
            if kind == 'stack' and value >= mapped.stack_inputs:
                raise WaveCodecError('wave output stack slot is outside the frame')
            if kind == 'local' and value >= mapped.local_count:
                raise WaveCodecError('wave output local slot is outside the frame')


def decode_plan(mapped):
    """Reconstruct the reference plan for equivalence tests and diagnostics."""
    from .wasmphysical import DependencyWaves
    from .wasmwave import Operand, PureSlice, WaveNode

    def operands(tags_name, values_name):
        return tuple(Operand(OPERAND_KINDS[tag], value)
                     for tag, value in zip(mapped.values(tags_name),
                                           mapped.values(values_name)))

    tags = mapped.values('operand_tags')
    values = mapped.values('operand_values')
    offsets = mapped.values('argument_offsets')
    opcodes = mapped.values('opcodes')
    nodes = []
    for value, opcode in enumerate(opcodes, start=1):
        begin, end = offsets[value - 1:value + 1]
        arguments = tuple(Operand(OPERAND_KINDS[tag], raw)
                          for tag, raw in zip(tags[begin:end],
                                              values[begin:end]))
        nodes.append(WaveNode(value, OPS[opcode], arguments))
    depth = [0] * (mapped.work + 1)
    for wave in range(1, mapped.span + 1):
        for value in mapped.wave(wave):
            depth[value] = wave
    waves = DependencyWaves(mapped.values('wave_offsets'),
                            mapped.values('lane_values'), tuple(depth))
    return PureSlice(
        mapped.function, mapped.start, mapped.end, mapped.instructions,
        mapped.stack_inputs,
        tuple(nodes), waves,
        operands('stack_tags', 'stack_values'),
        operands('local_tags', 'local_values'),
    )


def execute_mapped(mapped, state):
    """Execute mapped columns directly without rebuilding the SSA objects."""
    from dataclasses import replace
    from .wasmstate import Frame
    from .wasmwave import _evaluate

    frame = state.frames[-1]
    if frame.function != mapped.function or frame.pc != mapped.start:
        raise WaveCodecError('wave slice does not name the current frame')
    if len(frame.stack) != mapped.stack_inputs:
        raise WaveCodecError('wave slice input stack extent does not match')
    if len(frame.locals) != mapped.local_count:
        raise WaveCodecError('wave slice local extent does not match')

    values = [0] * (mapped.work + 1)

    def resolve(tag, value):
        kind = OPERAND_KINDS[tag]
        if kind == 'const':
            return value
        if kind == 'stack':
            return frame.stack[value]
        if kind == 'local':
            return frame.locals[value]
        return values[value]

    wave_offsets = mapped.values('wave_offsets')
    lanes = mapped.values('lane_values')
    argument_offsets = mapped.values('argument_offsets')
    for depth in range(mapped.span):
        produced = []
        for lane in range(wave_offsets[depth], wave_offsets[depth + 1]):
            node = lanes[lane]
            begin, end = argument_offsets[node - 1:node + 1]
            arguments = tuple(
                resolve(mapped.value('operand_tags', at),
                        mapped.value('operand_values', at))
                for at in range(begin, end)
            )
            operation = OPS[mapped.value('opcodes', node - 1)]
            produced.append((node, _evaluate(operation, arguments)))
        for node, value in produced:
            values[node] = value

    def output(tags, raw, index):
        return resolve(mapped.value(tags, index), mapped.value(raw, index))

    next_frame = Frame(
        frame.function,
        mapped.end,
        tuple(output('local_tags', 'local_values', index)
              for index in range(mapped.local_count)),
        tuple(output('stack_tags', 'stack_values', index)
              for index in range(mapped.stack_count)),
        frame.controls,
    )
    return replace(state, frames=state.frames[:-1] + (next_frame,))
