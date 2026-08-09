"""Mmap-shaped physical page for one normalized machine-state step.

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
from .laneops import OPS


MAGIC = b'STEP'
VERSION = 2
I64 = (1 << 64) - 1

# This is a global physical vocabulary, not a per-file dictionary. Giving the
# same short code a different operation in another page would make cached state
# depend on an omitted decoder.
OP_TO_CODE = dict((name, code) for code, name in enumerate(OPS))

OPERAND_KINDS = ('const', 'stack', 'local', 'node')
OPERAND_TO_TAG = dict((name, tag)
                      for tag, name in enumerate(OPERAND_KINDS))

# magic, version, header bytes, then:
# function, start, end, source instructions, span, work, operand values,
# input stack extent, stack outputs, local extent, changed local outputs.
_HEADER = struct.Struct('<4sHH11I')
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
    ('local_indices', 4),
    ('local_tags', 1),
    ('local_values', 8),
)


class StatePageError(CFrontError):
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


def _write_column(blob, offset, width, values):
    """Write a column into its final allocation without an intermediate blob."""
    if width == 1:
        blob[offset:offset + len(values)] = bytes(values)
        return
    code = '<I' if width == 4 else '<Q'
    for index, value in enumerate(values):
        struct.pack_into(code, blob, offset + index * width, int(value))


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
    local_updates = tuple(
        (index, operand)
        for index, operand in enumerate(plan.locals)
        if operand.kind != 'local' or operand.value != index
    )
    local_indices = tuple(index for index, _operand in local_updates)
    local_tags, local_values = _operand_columns(
        tuple(operand for _index, operand in local_updates))
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
        'local_indices': local_indices,
        'local_tags': local_tags,
        'local_values': local_values,
    }

    directory = []
    cursor = HEADER_BYTES
    for name, width in _COLUMNS:
        cursor = _align(cursor)
        directory.append((cursor, len(values[name])))
        cursor += len(values[name]) * width

    blob = bytearray(cursor)
    _HEADER.pack_into(
        blob, 0, MAGIC, VERSION, HEADER_BYTES,
        int(plan.function), int(plan.start), int(plan.end),
        int(plan.instructions), int(plan.waves.span), work, len(operands),
        stack_inputs, len(plan.stack), len(plan.locals), len(local_updates),
    )
    at = _HEADER.size
    for entry in directory:
        _DIRECTORY_ENTRY.pack_into(blob, at, *entry)
        at += _DIRECTORY_ENTRY.size
    for (name, width), (offset, _count) in zip(_COLUMNS, directory):
        _write_column(blob, offset, width, values[name])
    return blob


@dataclass(frozen=True)
class _Column:
    offset: int
    count: int
    width: int


class MappedStatePage(object):
    """A validated zero-copy view of one physical slice blob."""

    __slots__ = ('data', 'function', 'start', 'end', 'instructions',
                 'span', 'work', 'operands', 'stack_inputs',
                 'stack_count', 'local_extent', 'local_updates',
                 '_columns')

    def __init__(self, data, header, columns):
        self.data = data
        (self.function, self.start, self.end, self.instructions,
         self.span, self.work, self.operands,
         self.stack_inputs, self.stack_count, self.local_extent,
         self.local_updates) = header
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
            'kind': 'state-step-page',
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
            'local_slots': self.local_extent,
            'local_updates': self.local_updates,
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


def _expected_counts(span, work, operands, stack_count, local_updates):
    return {
        'wave_offsets': span + 1,
        'lane_values': work,
        'opcodes': work,
        'argument_offsets': work + 1,
        'operand_tags': operands,
        'operand_values': operands,
        'stack_tags': stack_count,
        'stack_values': stack_count,
        'local_indices': local_updates,
        'local_tags': local_updates,
        'local_values': local_updates,
    }


def unpack(blob):
    """Validate and map one slice without expanding its physical columns."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < HEADER_BYTES:
        raise StatePageError('state-step page header is truncated')
    magic, version, header_bytes, *header = _HEADER.unpack_from(data, 0)
    if magic != MAGIC or version != VERSION or header_bytes != HEADER_BYTES:
        raise StatePageError('state-step page has an unknown format')
    (function, start, end, instructions, span, work, operands,
     stack_inputs, stack_count, local_extent, local_updates) = header
    if end < start or instructions != end - start:
        raise StatePageError('state-step instruction region is inconsistent')

    expected_counts = _expected_counts(
        span, work, operands, stack_count, local_updates)
    columns = {}
    cursor = HEADER_BYTES
    directory_at = _HEADER.size
    directory_end = _HEADER.size + len(_COLUMNS) * _DIRECTORY_ENTRY.size
    if any(data[directory_end:HEADER_BYTES]):
        raise StatePageError('state-step header padding is not canonical')
    for name, width in _COLUMNS:
        offset, count = _DIRECTORY_ENTRY.unpack_from(data, directory_at)
        directory_at += _DIRECTORY_ENTRY.size
        aligned = _align(cursor)
        if any(data[cursor:aligned]):
            raise StatePageError('state-step column padding is not canonical')
        cursor = aligned
        if count != expected_counts[name] or offset != cursor:
            raise StatePageError('state-step %s column is not canonical' % name)
        end_offset = offset + count * width
        if end_offset > len(data):
            raise StatePageError('state-step %s column is truncated' % name)
        columns[name] = _Column(offset, count, width)
        cursor = end_offset
    if cursor != len(data):
        raise StatePageError('state-step page has trailing bytes')

    mapped = MappedStatePage(data, tuple(header), columns)
    _validate(mapped)
    return mapped


def _validate(mapped):
    if (mapped.value('wave_offsets', 0) != 0
            or mapped.value('wave_offsets', mapped.span) != mapped.work):
        raise StatePageError('wave boundaries are not a segmented region')
    for index in range(mapped.span):
        if (mapped.value('wave_offsets', index)
                > mapped.value('wave_offsets', index + 1)):
            raise StatePageError('wave boundaries are not a segmented region')
    if (mapped.value('argument_offsets', 0) != 0
            or mapped.value('argument_offsets', mapped.work)
            != mapped.operands):
        raise StatePageError('argument boundaries are not a segmented region')
    for index in range(mapped.work):
        if (mapped.value('argument_offsets', index)
                > mapped.value('argument_offsets', index + 1)):
            raise StatePageError(
                'argument boundaries are not a segmented region')

    # Validation uses one compact coordinate array, then releases it.  No
    # decoded node/operand graph survives beside the mapped physical page.
    depth = [0] * (mapped.work + 1)
    for wave in range(1, mapped.span + 1):
        begin = mapped.value('wave_offsets', wave - 1)
        end = mapped.value('wave_offsets', wave)
        for lane in range(begin, end):
            value = mapped.value('lane_values', lane)
            if value < 1 or value > mapped.work or depth[value]:
                raise StatePageError('wave lanes do not form the node domain')
            depth[value] = wave
    if any(value == 0 for value in depth[1:]):
        raise StatePageError('wave lanes do not form the node domain')
    for node in range(1, mapped.work + 1):
        begin = mapped.value('argument_offsets', node - 1)
        end = mapped.value('argument_offsets', node)
        opcode = mapped.value('opcodes', node - 1)
        if opcode >= len(OPS):
            raise StatePageError(
                'state-step page contains an unknown operation')
        operation = OPS[opcode]
        for at in range(begin, end):
            tag = mapped.value('operand_tags', at)
            value = mapped.value('operand_values', at)
            if tag >= len(OPERAND_KINDS):
                raise StatePageError(
                    'state-step page has an unknown operand kind')
            kind = OPERAND_KINDS[tag]
            if kind == 'node' and (value < 1 or value > mapped.work
                                   or depth[value] >= depth[node]):
                raise StatePageError('a wave lane depends on its own/later wave')
            if kind == 'stack' and value >= mapped.stack_inputs:
                raise StatePageError('stack operand is outside the frame region')
            if kind == 'local' and value >= mapped.local_extent:
                raise StatePageError('local operand is outside the frame region')
        if operation.startswith(('lane32.', 'lane64.')):
            from .laneops import GENERIC_ARITY, shape, split
            try:
                arity, constant_count, is_shift = shape(operation)
            except ValueError as error:
                raise StatePageError(str(error))
            _bits, name = split(operation)
            if name in GENERIC_ARITY:
                if end - begin != arity:
                    raise StatePageError(
                        '%s has the wrong operand count' % operation)
                continue
            if (end - begin < arity
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in range(begin + arity, end))):
                raise StatePageError('%s mixes inputs and constants'
                                     % operation)
            carried = end - begin - arity
            if constant_count < 0:
                if not carried or carried & (carried - 1):
                    raise StatePageError(
                        'physical LUT size is not a power of two')
            elif carried != constant_count + int(is_shift):
                raise StatePageError(
                    '%s has the wrong physical constant count' % operation)
            if is_shift and mapped.value(
                    'operand_values', begin + arity) >= int(
                    operation[4:].split('.', 1)[0]):
                raise StatePageError('%s has an invalid physical shift'
                                     % operation)

    previous = -1
    for index in range(mapped.local_updates):
        coordinate = mapped.value('local_indices', index)
        if coordinate <= previous or coordinate >= mapped.local_extent:
            raise StatePageError(
                'changed local coordinates are not strictly increasing')
        previous = coordinate

    for tag_name, value_name, count in (
            ('stack_tags', 'stack_values', mapped.stack_count),
            ('local_tags', 'local_values', mapped.local_updates)):
        for index in range(count):
            tag = mapped.value(tag_name, index)
            value = mapped.value(value_name, index)
            if tag >= len(OPERAND_KINDS):
                raise StatePageError('state output has an unknown operand kind')
            kind = OPERAND_KINDS[tag]
            if kind == 'node' and not 1 <= value <= mapped.work:
                raise StatePageError('state output node is outside the step')
            if kind == 'stack' and value >= mapped.stack_inputs:
                raise StatePageError(
                    'state output stack slot is outside the frame')
            if kind == 'local' and value >= mapped.local_extent:
                raise StatePageError(
                    'state output local slot is outside the frame')


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
    locals_ = [Operand('local', index)
               for index in range(mapped.local_extent)]
    local_indices = mapped.values('local_indices')
    local_outputs = operands('local_tags', 'local_values')
    for index, operand in zip(local_indices, local_outputs):
        locals_[index] = operand
    return PureSlice(
        mapped.function, mapped.start, mapped.end, mapped.instructions,
        mapped.stack_inputs,
        tuple(nodes), waves,
        operands('stack_tags', 'stack_values'),
        tuple(locals_),
    )


def execute_mapped(mapped, state):
    """Execute mapped columns directly without rebuilding the SSA objects."""
    from dataclasses import replace
    from .wasmstate import Frame
    from .laneops import evaluate

    frame = state.frames[-1]
    if frame.function != mapped.function or frame.pc != mapped.start:
        raise StatePageError('state-step page does not name the current frame')
    if len(frame.stack) != mapped.stack_inputs:
        raise StatePageError('state-step input stack extent does not match')
    if len(frame.locals) != mapped.local_extent:
        raise StatePageError('state-step local extent does not match')

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
            produced.append((node, evaluate(operation, arguments)))
        for node, value in produced:
            values[node] = value

    def output(tags, raw, index):
        return resolve(mapped.value(tags, index), mapped.value(raw, index))

    locals_ = list(frame.locals)
    for index in range(mapped.local_updates):
        coordinate = mapped.value('local_indices', index)
        locals_[coordinate] = output(
            'local_tags', 'local_values', index)
    next_frame = Frame(
        frame.function,
        mapped.end,
        tuple(locals_),
        tuple(output('stack_tags', 'stack_values', index)
              for index in range(mapped.stack_count)),
        frame.controls,
    )
    return replace(state, frames=state.frames[:-1] + (next_frame,))


def compile_mapped_executor(mapped):
    """Specialize one physical page without reconstructing scalar SSA nodes."""
    from .laneops import bind

    if not mapped.work:
        # A projection page has no SSA to compile.  Its terminal cut is just a
        # few physical coordinates, so generating and compiling Python source
        # would cost more than every future execution of the page.
        def coordinates(tag_name, value_name, count):
            return tuple((mapped.value(tag_name, index),
                          mapped.value(value_name, index))
                         for index in range(count))

        local_indices = mapped.values('local_indices')
        local_values = coordinates(
            'local_tags', 'local_values', mapped.local_updates)
        stack_values = coordinates(
            'stack_tags', 'stack_values', mapped.stack_count)

        def execute_projection(locals_, stack):
            sources = (None, stack, locals_)

            def resolve(spec):
                tag, value = spec
                return value if tag == 0 else sources[tag][value]

            if local_indices:
                next_locals = list(locals_)
                for coordinate, spec in zip(local_indices, local_values):
                    next_locals[coordinate] = resolve(spec)
                next_locals = tuple(next_locals)
            else:
                next_locals = locals_
            return next_locals, tuple(map(resolve, stack_values))

        return execute_projection

    lines = ['def execute(locals_, stack):']
    namespace = {}

    def expression(tag_name, value_name, index):
        tag = mapped.value(tag_name, index)
        value = mapped.value(value_name, index)
        kind = OPERAND_KINDS[tag]
        if kind == 'const':
            return repr(value)
        if kind == 'stack':
            return 'stack[%d]' % value
        if kind == 'local':
            return 'locals_[%d]' % value
        return 'value_%d' % value

    for depth in range(mapped.span):
        begin = mapped.value('wave_offsets', depth)
        end = mapped.value('wave_offsets', depth + 1)
        for lane in range(begin, end):
            node = mapped.value('lane_values', lane)
            first = mapped.value('argument_offsets', node - 1)
            last = mapped.value('argument_offsets', node)
            arguments = ', '.join(
                expression('operand_tags', 'operand_values', index)
                for index in range(first, last))
            if last - first == 1:
                arguments += ','
            opcode = mapped.value('opcodes', node - 1)
            operation = OPS[opcode]
            lane = 'lane_%d' % opcode
            namespace.setdefault(lane, bind(operation))
            lines.append("    value_%d = %s((%s))" %
                         (node, lane, arguments))

    if mapped.local_updates:
        lines.append('    next_locals = list(locals_)')
        for index in range(mapped.local_updates):
            coordinate = mapped.value('local_indices', index)
            value = expression('local_tags', 'local_values', index)
            lines.append('    next_locals[%d] = %s' % (coordinate, value))
        lines.append('    next_locals = tuple(next_locals)')
    else:
        lines.append('    next_locals = locals_')
    stack_values = ', '.join(
        expression('stack_tags', 'stack_values', index)
        for index in range(mapped.stack_count))
    if mapped.stack_count == 1:
        stack_values += ','
    lines.append('    return next_locals, (%s)' % stack_values)
    exec(compile('\n'.join(lines), '<qm-state-page>', 'exec'),
         namespace, namespace)
    return namespace['execute']
