"""Mmap-shaped physical page for one normalized machine-state step.

The semantic input remains the decoded WebAssembly module.  This codec is a
deterministic, disposable execution cache derived from it.  One blob is one
maximal state-step slice: arithmetic and non-atomic memory nodes continue up
to an observable boundary.  A caller can fetch/map only the slice named by
the current ``(function, pc)``.  Its physical domains are::

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
from .bits import mask_of
from .laneops import OPS as LANE_OPS


MAGIC = b'STEP'
VERSION = 3
TEMPLATE_MAGIC = b'STQT'
TEMPLATE_VERSION = 1
I64 = (1 << 64) - 1

# Access shape is shared by every frontend.  The low byte is the physical
# width, the next five bits are a power-of-two address scale, and this bit
# selects an untruncated 64-bit machine coordinate.  Wasm leaves it clear;
# x86 sets it after its effective-address expression has entered the SSA cut.
MEMORY_SCALE_SHIFT = 8
MEMORY_SCALE_MASK = 0x1f
MEMORY_VIRTUAL64 = 1 << 16
MEMORY_SHAPE_MASK = 0xff | (MEMORY_SCALE_MASK << MEMORY_SCALE_SHIFT) \
    | MEMORY_VIRTUAL64

# This is a global physical vocabulary, not a per-file dictionary. Giving the
# same short code a different operation in another page would make cached state
# depend on an omitted decoder.
_MEMORY_LOADS = (
    'i32.load', 'i32.load8_s', 'i32.load8_u',
    'i32.load16_s', 'i32.load16_u',
    'i64.load', 'i64.load8_s', 'i64.load8_u',
    'i64.load16_s', 'i64.load16_u',
    'i64.load32_s', 'i64.load32_u',
)
_MEMORY_STORES = (
    'i32.store', 'i32.store8', 'i32.store16',
    'i64.store', 'i64.store8', 'i64.store16', 'i64.store32',
)
MEMORY_OPS = tuple('memory.' + name for name in (
    _MEMORY_LOADS + _MEMORY_STORES
    + tuple(name + '.' + observer for name in _MEMORY_LOADS
            for observer in ('eqz', 'nez'))
))
# Existing physical codes are immutable.  Architecture-wide state lanes are
# appended after the original lane and memory domains, never inserted into
# either, so an older cached page cannot acquire a different meaning.
STATE_OPS = (
    'lane64.X86_FLAGS', 'memory.i64.repeat', 'memory.i64.find2',
    'memory.i64.copy_until', 'lane64.X86_FLAGS_SELECT',
    'memory.i64.relative_exchange', 'memory.i64.relative_result',
    'memory.i64.relative_address',
    'lane64.X86_COMPARE', 'memory.i64.pre_store',
    'lane64.X86_SHIFT_FLAGS',
    'lane64.X86_CONDITION', 'lane64.X86_TEST',
    'lane64.ADD3_U32',
    'lane64.X86_BIT_FLAGS',
    'lane64.INSERT',
    'lane64.X86_TEST_CONDITION',
    'memory.i64.prefix_end',
    'lane32.INSERT',
    'lane64.SELECT_U32',
    'lane64.X86_ALU',
    'lane64.X86_AFFINE_ALU',
    'memory.i64.load_region',
    'memory.i64.copy',
    'lane64.MUL_HIGH',
    'lane64.X86_MUL_FLAGS',
    'lane64.BIT_ADDRESS',
    'lane64.X86_DIVIDE',
    'lane64.X86_ROTATE_CARRY',
    'memory.i64.store_if',
    'memory.i64.frame',
    'lane64.X86_BIT_SUMMARY',
    'lane64.X86_DOUBLE_SHIFT',
    'lane64.X86_CRC32',
    'lane64.X86_BZHI',
)
OPS = LANE_OPS + MEMORY_OPS + STATE_OPS
OP_TO_CODE = dict((name, code) for code, name in enumerate(OPS))

# These nodes publish the architectural RFLAGS word.  A terminal projection
# selector in [0, 16) is the matching x86 condition without another SSA lane.
# The flags word remains the primary result, so a Jcc observer and future
# architectural state share one physical computation.
ALU_PROJECTION_OPS = frozenset((
    'lane64.X86_ALU', 'lane64.X86_AFFINE_ALU',
    'lane64.X86_ROTATE_CARRY',
    'lane64.X86_BIT_SUMMARY',
    'lane64.X86_DOUBLE_SHIFT',
    'lane64.X86_BZHI',
))
ROTATE_PROJECTION_OPS = frozenset((
    'lane64.X86_ROTATE_CARRY', 'lane64.X86_DOUBLE_SHIFT',
))
REGION_PROJECTION_OPS = frozenset(('memory.i64.load_region',))
DIVIDE_PROJECTION_OPS = frozenset(('lane64.X86_DIVIDE',))
FLAG_PROJECTION_OPS = frozenset((
    'lane64.X86_FLAGS', 'lane64.X86_FLAGS_SELECT',
    'lane64.X86_COMPARE', 'lane64.X86_SHIFT_FLAGS',
    'lane64.X86_TEST', 'lane64.X86_BIT_FLAGS',
)) | ALU_PROJECTION_OPS

OPERAND_KINDS = ('const', 'stack', 'local', 'node', 'projection')
OPERAND_TO_TAG = dict((name, tag)
                      for tag, name in enumerate(OPERAND_KINDS))

# A terminal projection names one result lane of a multi-result physical
# node without allocating another scalar SSA node.  The low byte is the
# operation-specific selector and the remaining bits are the dense source
# coordinate.  Projection operands are legal only in state outputs; plan
# composition materializes one only when a later node actually consumes it.
PROJECTION_SELECTOR_BITS = 8
PROJECTION_SELECTOR_MASK = (1 << PROJECTION_SELECTOR_BITS) - 1


def projection_coordinate(source, selector):
    source, selector = int(source), int(selector)
    if source <= 0 or source > (I64 >> PROJECTION_SELECTOR_BITS):
        raise ValueError('projection source is outside the physical page')
    if selector < 0 or selector > PROJECTION_SELECTOR_MASK:
        raise ValueError('projection selector is outside one byte')
    return source << PROJECTION_SELECTOR_BITS | selector


def decode_projection_coordinate(coordinate):
    coordinate = int(coordinate)
    if coordinate < 0 or coordinate > I64:
        raise ValueError('projection coordinate is outside one word')
    source = coordinate >> PROJECTION_SELECTOR_BITS
    if not source:
        raise ValueError('projection source is zero')
    return source, coordinate & PROJECTION_SELECTOR_MASK


def load_region_descriptor(count, bits=64, signed=False):
    """Encode one same-width contiguous read and its end coordinate."""
    count, bits = int(count), int(bits)
    if not 1 <= count <= 8 or bits not in (32, 64):
        raise ValueError('load region shape is outside the physical limits')
    return count | (int(bool(signed)) << 8) | (int(bits == 32) << 9)


def decode_load_region_descriptor(descriptor):
    descriptor = int(descriptor)
    count = descriptor & 0xff
    bits = 32 if descriptor & (1 << 9) else 64
    signed = bool(descriptor & (1 << 8))
    if not 1 <= count <= 8 or descriptor & ~((1 << 10) - 1):
        raise ValueError('load region descriptor is invalid')
    return count, bits, signed

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


def _pack_values(header, values):
    """Encode already-normalized physical columns in canonical STEP layout."""
    directory = []
    cursor = HEADER_BYTES
    for name, width in _COLUMNS:
        cursor = _align(cursor)
        directory.append((cursor, len(values[name])))
        cursor += len(values[name]) * width

    blob = bytearray(cursor)
    _HEADER.pack_into(blob, 0, MAGIC, VERSION, HEADER_BYTES, *header)
    at = _HEADER.size
    for entry in directory:
        _DIRECTORY_ENTRY.pack_into(blob, at, *entry)
        at += _DIRECTORY_ENTRY.size
    for (name, width), (offset, _count) in zip(_COLUMNS, directory):
        _write_column(blob, offset, width, values[name])
    return blob


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


def memory_shape(width, scale=0, virtual64=False):
    width, scale = int(width), int(scale)
    if width <= 0 or width > 0xff or not 0 <= scale <= MEMORY_SCALE_MASK:
        raise ValueError('memory access shape is invalid')
    return (width | (scale << MEMORY_SCALE_SHIFT)
            | (MEMORY_VIRTUAL64 if virtual64 else 0))


def decode_memory_shape(shape):
    shape = int(shape)
    if shape & ~MEMORY_SHAPE_MASK:
        raise ValueError('memory access shape has unknown flags')
    return (shape & 0xff,
            (shape >> MEMORY_SCALE_SHIFT) & MEMORY_SCALE_MASK,
            bool(shape & MEMORY_VIRTUAL64))


def _address(address, offset, scale, virtual64=False):
    mask = I64 if virtual64 else (1 << 32) - 1
    base = ((int(address) & mask) << int(scale)) & mask
    effective = base + int(offset)
    return effective & I64 if virtual64 else effective


def _load(memory, address, offset, width, scale, signed, bits,
          virtual64=False):
    value = memory.load(
        _address(address, offset, scale, virtual64), width)
    if signed and value & (1 << (width * 8 - 1)):
        value -= 1 << (width * 8)
    return value & mask_of(bits)


def _store(memory, address, value, offset, width, scale, virtual64=False):
    memory.write(
        _address(address, offset, scale, virtual64),
        int(value & mask_of(width * 8)).to_bytes(width, 'little'))


def _repeat(memory, address, value, size, shape):
    """Repeat one fixed-width word without materializing the byte extent."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if width not in (1, 2, 4, 8):
        raise ValueError('memory repeat width is invalid')
    address = _address(address, 0, scale, virtual64)
    size = int(size)
    if size < 0 or address > I64 - size:
        raise ValueError('memory repeat extent is invalid')
    pattern = int(value & mask_of(width * 8)).to_bytes(width, 'little')
    memory.repeat(address, size, pattern)


def _copy(memory, source, target, size, shape):
    """Move one byte extent without materializing it in the state page."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if width != 1:
        raise ValueError('memory copy width is invalid')
    source = _address(source, 0, scale, virtual64)
    target = _address(target, 0, scale, virtual64)
    size = int(size)
    if (size < 0 or size and (source > I64 - (size - 1)
                             or target > I64 - (size - 1))):
        raise ValueError('memory copy extent is invalid')
    direct = getattr(memory, 'copy', None)
    if direct is not None:
        direct(source, target, size)
        return
    # Match a single immutable source extent even on overlap.  Page-size
    # staging is sufficient when traversal follows memmove's safe direction.
    backwards = source < target < source + size
    moved = 0
    while moved < size:
        count = min(4096, size - moved)
        at = size - moved - count if backwards else moved
        payload = memory.read(source + at, count)
        memory.write(target + at, payload)
        moved += count


def _frame(memory, frame, base, level, shape):
    """Build one nested stack frame without expanding its implicit pushes."""
    width, scale, virtual64 = decode_memory_shape(shape)
    frame, base, level = map(int, (frame, base, level))
    if width not in (2, 4, 8) or scale or not virtual64 or not 0 <= level <= 31:
        raise ValueError('memory frame geometry is invalid')
    count = level + 1 if level else 1
    mask = mask_of(width * 8)
    for index in range(count):
        if index == 0:
            value = base
        elif index < level:
            value = memory.load((base - width * index) & I64, width)
        else:
            value = frame
        memory.write(
            (frame - width * index) & I64,
            int(value & mask).to_bytes(width, 'little'))


def _find2(memory, address, first, second, shape):
    """Return ``distance << 8 | byte`` for the first matching byte."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if width != 1:
        raise ValueError('memory find width is invalid')
    address = _address(address, 0, scale, virtual64)
    first, second = int(first) & 0xff, int(second) & 0xff
    direct = getattr(memory, 'find2', None)
    if direct is not None:
        distance, value = direct(address, first, second)
        return (int(distance) << 8) | int(value)
    distance = 0
    values = (first,) if first == second else (first, second)
    while True:
        coordinate = address + distance
        if coordinate > I64:
            raise ValueError('memory find coordinate wrapped')
        count = 4096 - (coordinate & 4095)
        finder = getattr(memory, 'find', None)
        if finder is None:
            payload = memory.read(coordinate, count)
            found = min((position for value in values
                         for position in (payload.find(bytes((value,))),)
                         if position >= 0), default=None)
            value = None if found is None else payload[found]
        else:
            found = finder(coordinate, count, values)
            value = None if found is None else memory.load(
                coordinate + found, 1)
        if found is not None:
            total = distance + found
            if total >= 1 << 56:
                raise ValueError('memory find result is not encodable')
            return (total << 8) | value
        distance += count


def _prefix_end(memory, pointer, count, first_length, limit, shape):
    """Advance over a bounded variable-length byte directory."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if width != 1 or scale or not virtual64:
        raise ValueError('prefix directory needs virtual byte coordinates')
    pointer, count, limit = map(int, (pointer, count, limit))
    length = int(first_length) & 0xffffffff
    if count > limit or length >= 0x80:
        raise ValueError('prefix directory residual is outside its domain')
    remaining = limit - count + 1
    for _entry in range(remaining):
        pointer = (pointer + length + 1) & I64
        if _entry + 1 == remaining:
            break
        leading = memory.load(pointer, 1)
        if leading & 0x80:
            length = ((leading & 0x7f)
                      + (memory.load((pointer + 1) & I64, 1) << 7) + 1)
        else:
            length = leading
    return pointer


def _copy_until(memory, source, target, start, limit, target_end,
                sentinel, shape):
    """Copy an indexed byte span until its exclusive limit or sentinel.

    The packed result is ``byte << 32 | final_index``.  A terminal byte equal
    to the sentinel denotes the sentinel exit; any other byte denotes the
    exclusive-limit exit.  Keeping
    only this residual state lets the caller recover its live registers
    without materializing the visited byte coordinates.
    """
    width, scale, virtual64 = decode_memory_shape(shape)
    if width != 1:
        raise ValueError('memory copy-until width is invalid')
    source = _address(source, 0, scale, virtual64)
    target = _address(target, 0, scale, virtual64)
    start, limit = int(start), int(limit)
    target_end = int(target_end) & I64
    sentinel = int(sentinel) & 0xff
    if (not 0 <= start <= 0xffffffff
            or not start < limit <= 0xffffffff):
        raise ValueError('memory copy-until extent is invalid')
    direct = getattr(memory, 'copy_until', None)
    if direct is not None:
        final, byte, hit = direct(
            source, target, start, limit, target_end, sentinel)
        return ((int(byte) & 0xff) << 32) | (int(final) & 0xffffffff)

    index = start
    byte = 0
    while index < limit:
        source_at = (source + index) & I64
        byte = memory.load(source_at, 1)
        if byte == sentinel:
            return (byte << 32) | index
        coordinate = (target + index) & I64
        if coordinate < target_end:
            memory.write(coordinate, bytes((byte,)))
        index += 1
    return (byte << 32) | index


def relative_layout(widths):
    """Encode a small adjacent-lane layout in one physical constant."""
    widths = tuple(map(int, widths))
    if not widths or len(widths) > 7 or any(
            width not in (1, 2, 4, 8) for width in widths):
        raise ValueError('relative-exchange layout is invalid')
    return len(widths) | sum(
        width << (8 * (index + 1))
        for index, width in enumerate(widths))


def decode_relative_layout(layout):
    """Return the adjacent lane widths of a relative-exchange constant."""
    layout = int(layout)
    count = layout & 0xff
    if not 1 <= count <= 7 or layout >> (8 * (count + 1)):
        raise ValueError('relative-exchange layout is invalid')
    widths = tuple((layout >> (8 * (index + 1))) & 0xff
                   for index in range(count))
    if any(width not in (1, 2, 4, 8) for width in widths):
        raise ValueError('relative-exchange layout is invalid')
    return widths


RELATIVE_SAVE_CAP = 4


def relative_selector_index(selector, lane_count, save_count):
    selector = int(selector)
    lane_count, save_count = int(lane_count), int(save_count)
    if not 0 <= save_count <= RELATIVE_SAVE_CAP:
        raise ValueError('relative-exchange save count is invalid')
    if selector == 0xff:
        return lane_count * 2
    restore = 0xfe - selector
    if 0 <= restore < save_count:
        return lane_count * 2 + 1 + restore
    if 0 <= selector < lane_count * 2:
        return selector
    raise ValueError('relative-exchange selector is outside its layout')


def _relative_exchange(memory, left, right, delta, prior_flags, layout,
                       mode=0, *_tail):
    """Exchange adjacent relative coordinates without scalar lane state.

    For each lane ``i`` this publishes ``left[i] = right[i] - delta`` and
    ``right[i] = left[i] + delta`` modulo that lane's width.  Reads and writes
    retain their source order, so overlapping byte extents have one exact
    meaning instead of selecting a separate fallback implementation.
    """
    from .laneops import evaluate

    widths = decode_relative_layout(layout)
    mode = int(mode)
    if mode < 0 or mode > RELATIVE_SAVE_CAP or len(_tail) < mode * 3:
        raise ValueError('relative-exchange mode is invalid')
    left, right, delta = int(left), int(right), int(delta) & I64
    saves = tuple(
        ((int(_tail[index * 3]) + int(_tail[index * 3 + 1])) & I64,
         int(_tail[index * 3 + 2]) & I64)
        for index in range(mode))
    for save_address, saved_value in saves:
        memory.write(
            save_address, saved_value.to_bytes(8, 'little'))
    offset = 0
    results = []
    right_values = []
    last_left = last_right = 0
    for width in widths:
        mask = mask_of(width * 8)
        observed_right = memory.load((right + offset) & I64, width)
        next_left = (observed_right - delta) & mask
        observed_left = memory.load((left + offset) & I64, width)
        next_right = (observed_left + delta) & mask
        memory.write((left + offset) & I64,
                     next_left.to_bytes(width, 'little'))
        results.extend((next_left, next_right))
        right_values.append((offset, width, next_right))
        last_left, last_right = observed_left, next_right
        offset += width
    for offset, width, value in right_values:
        memory.write((right + offset) & I64,
                     value.to_bytes(width, 'little'))
    descriptor = widths[-1] * 8 | (1 << 8)
    flags = evaluate('lane64.X86_FLAGS', (
        int(prior_flags), delta, last_left, last_right, descriptor))
    restored = tuple(memory.load(save_address, 8)
                     for save_address, _saved_value in saves)
    return tuple(results) + (flags,) + restored


def _relative_select(results, selector, mode):
    mode = int(mode)
    lane_count = (len(results) - 1 - mode) // 2
    return results[relative_selector_index(selector, lane_count, mode)]


def _relative_address(memory, base, load_offset, mask, addend, shape):
    """Load one relative coordinate directly into its absolute address."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if width != 8 or scale or not virtual64:
        raise ValueError('relative-address load shape is invalid')
    base = int(base) & I64
    observed = _load(
        memory, base, int(load_offset), 8, 0, False, 64, virtual64)
    return (base + int(addend) + (observed & int(mask))) & I64


def _pre_store(memory, pointer, value, decrement, shape):
    """Store at a pre-decremented coordinate and publish that coordinate."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if scale or not virtual64:
        raise ValueError('pre-store shape is invalid')
    address = (int(pointer) - int(decrement)) & I64
    _store(memory, address, int(value), 0, width, 0, virtual64)
    return address


def _store_if(memory, address, value, predicate, offset, shape):
    """Publish one memory version only when its normalized predicate is set."""
    width, scale, virtual64 = decode_memory_shape(shape)
    if scale or not virtual64 or width not in (1, 2, 4, 8):
        raise ValueError('conditional store shape is invalid')
    if predicate:
        _store(memory, address, value, offset, width, 0, True)
    return 0


def _load_region(memory, base, offset, descriptor, shape):
    """Read one contiguous physical extent and publish its end coordinate."""
    count, bits, signed = decode_load_region_descriptor(descriptor)
    width, scale, virtual64 = decode_memory_shape(shape)
    if scale:
        raise ValueError('load region cannot carry an address scale')
    base, offset = int(base), int(offset)
    values = tuple(_load(
        memory, base, offset + index * width,
        width, 0, signed, bits, virtual64)
        for index in range(count))
    end = (base + offset + count * width) & I64
    return values + (end,)


def _x86_alu(prior, left, right, descriptor):
    """Return flags and result for one width-bounded integer ALU update."""
    from .laneops import evaluate

    prior, left, right, descriptor = map(
        int, (prior, left, right, descriptor))
    width = descriptor & 0x7f
    mode = (descriptor >> 8) & 7
    carry = prior & 1
    if mode == 0:
        result = left & right
    elif mode == 1:
        result = left + right
    elif mode == 2:
        result = left + right + carry
    elif mode == 3:
        result = left - right
    elif mode == 4:
        result = left - right - carry
    elif mode == 5:
        result = left | right
    elif mode == 6:
        result = left ^ right
    elif mode == 7:
        result = ~left & right
    else:
        raise ValueError('x86 ALU lane has an invalid mode')
    result &= mask_of(width)
    flags = evaluate('lane64.X86_FLAGS', (
        prior, left, right, result, descriptor))
    return flags, result


def _x86_affine_alu(prior, left_base, left_addend, right, descriptor):
    """Apply an x86 ALU update to a width-bounded two-term affine left."""
    descriptor = int(descriptor)
    width = descriptor & 0x7f
    if width not in (8, 16, 32, 64):
        raise ValueError('x86 affine ALU lane has an invalid width')
    left = (int(left_base) + int(left_addend)) & mask_of(width)
    return _x86_alu(prior, left, right, descriptor)


def relative_exchange_values(left_bytes, right_bytes, delta,
                             prior_flags, layout):
    """Reference outputs of one relative exchange over immutable snapshots."""
    from .laneops import evaluate

    widths = decode_relative_layout(layout)
    left_bytes, right_bytes = bytes(left_bytes), bytes(right_bytes)
    extent = sum(widths)
    if len(left_bytes) != extent or len(right_bytes) != extent:
        raise ValueError('relative-exchange snapshot has the wrong extent')
    delta = int(delta) & I64
    results = []
    offset = 0
    last_left = last_right = 0
    for width in widths:
        mask = mask_of(width * 8)
        old_left = int.from_bytes(left_bytes[offset:offset + width], 'little')
        old_right = int.from_bytes(
            right_bytes[offset:offset + width], 'little')
        next_left = (old_right - delta) & mask
        next_right = (old_left + delta) & mask
        results.extend((next_left, next_right))
        last_left, last_right = old_left, next_right
        offset += width
    descriptor = widths[-1] * 8 | (1 << 8)
    flags = evaluate('lane64.X86_FLAGS', (
        int(prior_flags), delta, last_left, last_right, descriptor))
    return tuple(results) + (flags,)


def _memory_name(name):
    """Return the source load spelling and its fused observer, if any."""
    for observer in ('eqz', 'nez'):
        suffix = '.' + observer
        if name.endswith(suffix):
            return name[:-len(suffix)], observer
    return name, None


def _memory_observe(value, observer):
    if observer == 'eqz':
        return int(value == 0)
    if observer == 'nez':
        return int(value != 0)
    return value


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

    return _pack_values((
        int(plan.function), int(plan.start), int(plan.end),
        int(plan.instructions), int(plan.waves.span), work, len(operands),
        stack_inputs, len(plan.stack), len(plan.locals), len(local_updates),
    ), values)


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


def project_step_template(blob):
    """Split one STEP into an operator template and typed state parameters.

    Constants remain tagged constants, but their 64-bit words move into the
    parameter projection.  Stack/local input coordinates and changed-local
    output coordinates are bounded frame indices and therefore use two bytes.
    Node and projection coordinates stay in the template because they are the
    normalized SSA graph itself.
    """
    mapped = unpack(blob)
    parameters = bytearray()
    template = bytearray(_HEADER.pack(
        TEMPLATE_MAGIC, TEMPLATE_VERSION, _HEADER.size,
        mapped.function, mapped.start, mapped.end, mapped.instructions,
        mapped.span, mapped.work, mapped.operands, mapped.stack_inputs,
        mapped.stack_count, mapped.local_extent, mapped.local_updates))

    for name in ('wave_offsets', 'lane_values'):
        for value in mapped.values(name):
            template.extend(struct.pack('<I', value))
    template.extend(mapped.column('opcodes'))
    for value in mapped.values('argument_offsets'):
        template.extend(struct.pack('<I', value))

    for tags_name, values_name in (
            ('operand_tags', 'operand_values'),
            ('stack_tags', 'stack_values'),
            ('local_tags', 'local_values')):
        tags = mapped.values(tags_name)
        values = mapped.values(values_name)
        template.extend(bytes(tags))
        for index, tag in enumerate(tags):
            kind = OPERAND_KINDS[tag]
            value = values[index]
            if kind == 'const':
                parameters.extend(struct.pack('<Q', value))
            elif kind in ('stack', 'local'):
                if value > 0xffff:
                    raise ValueError(
                        'state-step frame coordinate exceeds two bytes')
                parameters.extend(struct.pack('<H', value))
            else:
                template.extend(struct.pack('<Q', value))

    for value in mapped.values('local_indices'):
        if value > 0xffff:
            raise ValueError(
                'state-step output coordinate exceeds two bytes')
        parameters.extend(struct.pack('<H', value))
    return bytes(template), bytes(parameters)


def instantiate_step_template(template, parameters):
    """Apply a typed parameter projection and return one validated STEP."""
    data = template if isinstance(template, memoryview) else memoryview(template)
    if len(data) < _HEADER.size:
        raise StatePageError('state-step template header is truncated')
    magic, version, header_bytes, *header = _HEADER.unpack_from(data, 0)
    if (magic != TEMPLATE_MAGIC or version != TEMPLATE_VERSION
            or header_bytes != _HEADER.size):
        raise StatePageError('state-step template has an unknown format')
    (_function, _start, _end, _instructions, span, work, operands,
     _stack_inputs, stack_count, _local_extent, local_updates) = header
    cursor = _HEADER.size

    def structural(width, count):
        nonlocal cursor
        end = cursor + width * count
        if end > len(data):
            raise StatePageError('state-step template is truncated')
        raw = data[cursor:end]
        cursor = end
        if width == 1:
            return tuple(raw)
        code = '<I' if width == 4 else '<Q'
        return tuple(item[0] for item in struct.iter_unpack(code, raw))

    values = {
        'wave_offsets': structural(4, span + 1),
        'lane_values': structural(4, work),
        'opcodes': structural(1, work),
        'argument_offsets': structural(4, work + 1),
    }
    parameters = memoryview(parameters)
    parameter_cursor = 0

    def take(width):
        nonlocal parameter_cursor
        end = parameter_cursor + width
        if end > len(parameters):
            raise StatePageError('state-step parameter projection is truncated')
        value = int.from_bytes(parameters[parameter_cursor:end], 'little')
        parameter_cursor = end
        return value

    for tags_name, values_name, count in (
            ('operand_tags', 'operand_values', operands),
            ('stack_tags', 'stack_values', stack_count),
            ('local_tags', 'local_values', local_updates)):
        tags = structural(1, count)
        projected = []
        for tag in tags:
            if tag >= len(OPERAND_KINDS):
                raise StatePageError(
                    'state-step template has an unknown operand kind')
            kind = OPERAND_KINDS[tag]
            if kind == 'const':
                value = take(8)
            elif kind in ('stack', 'local'):
                value = take(2)
            else:
                raw = structural(8, 1)
                value = raw[0]
            projected.append(value)
        values[tags_name] = tags
        values[values_name] = tuple(projected)

    values['local_indices'] = tuple(take(2) for _ in range(local_updates))
    if cursor != len(data):
        raise StatePageError('state-step template has trailing bytes')
    if parameter_cursor != len(parameters):
        raise StatePageError('state-step parameter projection has trailing bytes')
    output = _pack_values(tuple(header), values)
    unpack(output)
    return bytes(output)


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
            if kind == 'projection':
                try:
                    source, selector = decode_projection_coordinate(value)
                except ValueError as error:
                    raise StatePageError(str(error))
                if (source < 1 or source > mapped.work
                        or depth[source] >= depth[node]):
                    raise StatePageError(
                        'a wave lane depends on its own/later projection')
                source_operation = OPS[
                    mapped.value('opcodes', source - 1)]
                region_projection = False
                if source_operation in REGION_PROJECTION_OPS:
                    source_begin = mapped.value(
                        'argument_offsets', source - 1)
                    try:
                        count, _bits, _signed = \
                            decode_load_region_descriptor(mapped.value(
                                'operand_values', source_begin + 2))
                        region_projection = selector <= count
                    except (IndexError, ValueError):
                        region_projection = False
                if not (source_operation in ALU_PROJECTION_OPS
                        and selector == 16
                        or source_operation in FLAG_PROJECTION_OPS
                        and selector < 16
                        or source_operation in DIVIDE_PROJECTION_OPS
                        and selector < 2
                        or region_projection):
                    raise StatePageError(
                        'an internal projection has no scalar value')
            if kind == 'stack' and value >= mapped.stack_inputs:
                raise StatePageError('stack operand is outside the frame region')
            if kind == 'local' and value >= mapped.local_extent:
                raise StatePageError('local operand is outside the frame region')
        if operation == 'memory.i64.repeat':
            if (end - begin < 4
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 3)] != 'const'):
                raise StatePageError(
                    'memory.i64.repeat has the wrong physical operands')
            try:
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 3))
            except ValueError as error:
                raise StatePageError(str(error))
            if width not in (1, 2, 4, 8) or scale >= 32:
                raise StatePageError('memory.i64.repeat shape is invalid')
            continue
        if operation == 'memory.i64.copy':
            if (end - begin < 4
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 3)] != 'const'):
                raise StatePageError(
                    'memory.i64.copy has the wrong physical operands')
            try:
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 3))
            except ValueError as error:
                raise StatePageError(str(error))
            if width != 1 or scale >= 32:
                raise StatePageError('memory.i64.copy shape is invalid')
            continue
        if operation == 'memory.i64.find2':
            if (end - begin < 4
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 3)] != 'const'):
                raise StatePageError(
                    'memory.i64.find2 has the wrong physical operands')
            try:
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 3))
            except ValueError as error:
                raise StatePageError(str(error))
            if width != 1 or scale >= 32:
                raise StatePageError('memory.i64.find2 shape is invalid')
            continue
        if operation == 'memory.i64.copy_until':
            if (end - begin < 7
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 6)] != 'const'):
                raise StatePageError(
                    'memory.i64.copy_until has the wrong physical operands')
            try:
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 6))
            except ValueError as error:
                raise StatePageError(str(error))
            if width != 1 or scale >= 32:
                raise StatePageError(
                    'memory.i64.copy_until shape is invalid')
            continue
        if operation == 'memory.i64.prefix_end':
            if (end - begin < 5
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 4)] != 'const'):
                raise StatePageError(
                    'memory prefix directory has the wrong operands')
            try:
                width, scale, virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 4))
            except ValueError as error:
                raise StatePageError(str(error))
            if width != 1 or scale or not virtual64:
                raise StatePageError(
                    'memory prefix directory shape is invalid')
            continue
        if operation == 'memory.i64.relative_exchange':
            if (end - begin < 7
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in (begin + 4, begin + 5, begin + 6))
                    or mapped.value('operand_values', begin + 6)
                       > RELATIVE_SAVE_CAP
                    or end - begin < 7 + 3 * mapped.value(
                        'operand_values', begin + 6)
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'node'
                           for at in range(
                               begin + 7 + 3 * mapped.value(
                                   'operand_values', begin + 6),
                               end))):
                raise StatePageError(
                    'memory.i64.relative_exchange has the wrong operands')
            try:
                widths = decode_relative_layout(
                    mapped.value('operand_values', begin + 4))
            except ValueError as error:
                raise StatePageError(str(error))
            selector = mapped.value('operand_values', begin + 5)
            mode = mapped.value('operand_values', begin + 6)
            try:
                relative_selector_index(selector, len(widths), mode)
            except ValueError as error:
                raise StatePageError(str(error))
            continue
        if operation == 'memory.i64.relative_result':
            if (end - begin != 2
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin)] != 'node'
                    or OPERAND_KINDS[
                        mapped.value('operand_tags', begin + 1)] != 'const'):
                raise StatePageError(
                    'memory.i64.relative_result has the wrong operands')
            continue
        if operation == 'memory.i64.relative_address':
            if (end - begin < 5
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in range(begin + 1, begin + 5))
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'node'
                           for at in range(begin + 5, end))):
                raise StatePageError(
                    'memory.i64.relative_address has the wrong operands')
            try:
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 4))
            except ValueError as error:
                raise StatePageError(str(error))
            if width != 8 or scale or not _virtual64:
                raise StatePageError(
                    'memory.i64.relative_address shape is invalid')
            continue
        if operation == 'memory.i64.pre_store':
            if (end - begin < 4
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in (begin + 2, begin + 3))
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] not in (
                            'node', 'projection')
                           for at in range(begin + 4, end))):
                raise StatePageError(
                    'memory.i64.pre_store has the wrong operands')
            try:
                width, scale, virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 3))
            except ValueError as error:
                raise StatePageError(str(error))
            if width not in (1, 2, 4, 8) or scale or not virtual64:
                raise StatePageError('memory.i64.pre_store shape is invalid')
            continue
        if operation == 'memory.i64.load_region':
            if (end - begin < 4
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in (begin + 1, begin + 2, begin + 3))
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] not in (
                            'node', 'projection')
                           for at in range(begin + 4, end))):
                raise StatePageError(
                    'memory.i64.load_region has the wrong operands %r' %
                    (tuple(OPERAND_KINDS[mapped.value(
                        'operand_tags', at)] for at in range(begin, end)),))
            try:
                count, bits, signed = decode_load_region_descriptor(
                    mapped.value('operand_values', begin + 2))
                width, scale, _virtual64 = decode_memory_shape(
                    mapped.value('operand_values', begin + 3))
            except ValueError as error:
                raise StatePageError(str(error))
            if (width not in (1, 2, 4, 8) or scale or width * 8 > bits
                    or signed and width * 8 >= bits):
                raise StatePageError('memory load region shape is invalid')
            continue
        if operation == 'memory.i64.store_if':
            if (end - begin < 5
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] != 'const'
                           for at in (begin + 3, begin + 4))
                    or any(OPERAND_KINDS[
                        mapped.value('operand_tags', at)] not in (
                            'node', 'projection')
                           for at in range(begin + 5, end))):
                raise StatePageError(
                    'memory.i64.store_if has the wrong operands')
            width, scale, virtual64 = decode_memory_shape(
                mapped.value('operand_values', begin + 4))
            if width not in (1, 2, 4, 8) or scale or not virtual64:
                raise StatePageError(
                    'memory.i64.store_if has an invalid shape')
            continue
        if operation.startswith('memory.'):
            name = operation.split('.', 1)[1]
            source_name, _observer = _memory_name(name)
            store = '.store' in source_name
            data_count = 2 if store else 1
            fixed = data_count + 2
            if end - begin < fixed:
                raise StatePageError(
                    '%s has the wrong physical operand count' % operation)
            if any(OPERAND_KINDS[mapped.value('operand_tags', at)] != 'const'
                   for at in range(begin + data_count, begin + fixed)):
                raise StatePageError(
                    '%s offset and access shape are not physical constants'
                    % operation)
            if any(OPERAND_KINDS[mapped.value(
                    'operand_tags', at)] not in ('node', 'projection')
                   for at in range(begin + fixed, end)):
                raise StatePageError(
                    '%s memory dependencies are not SSA nodes: %r %r' % (
                        operation, tuple(OPERAND_KINDS[mapped.value(
                            'operand_tags', at)]
                            for at in range(begin, end)),
                        tuple(mapped.value('operand_values', at)
                              for at in range(begin, end))))
            shape = mapped.value('operand_values', begin + data_count + 1)
            try:
                width, scale, _virtual64 = decode_memory_shape(shape)
            except ValueError as error:
                raise StatePageError(str(error))
            if scale >= 32:
                raise StatePageError('%s has an invalid address scale'
                                     % operation)
            suffix = source_name.split('.', 1)[1]
            natural = 4 if source_name.startswith('i32.') else 8
            expected = (1 if '8_' in suffix or suffix.endswith('store8')
                        else 2 if '16_' in suffix or suffix.endswith('store16')
                        else 4 if '32_' in suffix or suffix.endswith('store32')
                        else natural)
            if width != expected:
                raise StatePageError('%s has the wrong access width'
                                     % operation)
            continue
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

    last_relative_source = next((
        value for value in reversed(mapped.values('lane_values'))
        if OPS[mapped.value('opcodes', value - 1)]
        == 'memory.i64.relative_exchange'), None)

    def validate_projection(value):
        try:
            source, selector = decode_projection_coordinate(value)
        except ValueError as error:
            raise StatePageError(str(error))
        if source > mapped.work:
            raise StatePageError('state projection source is outside the step')
        operation = OPS[mapped.value('opcodes', source - 1)]
        if operation in REGION_PROJECTION_OPS:
            begin = mapped.value('argument_offsets', source - 1)
            count, _bits, _signed = decode_load_region_descriptor(
                mapped.value('operand_values', begin + 2))
            if selector > count:
                raise StatePageError(
                    'memory region projection is outside its extent')
            return
        if operation in DIVIDE_PROJECTION_OPS:
            if selector >= 2:
                raise StatePageError(
                    'x86 divide projection has an invalid result')
            return
        if operation in FLAG_PROJECTION_OPS:
            limit = (18 if operation in ROTATE_PROJECTION_OPS
                     else 17 if operation in ALU_PROJECTION_OPS else 16)
            if selector >= limit:
                raise StatePageError(
                    'x86 flag projection has an invalid condition')
            return
        if source != last_relative_source:
            raise StatePageError(
                'state projection does not name the final multi-result node')
        begin, end = (
            mapped.value('argument_offsets', source - 1),
            mapped.value('argument_offsets', source))
        if operation != 'memory.i64.relative_exchange' or end - begin < 7:
            raise StatePageError(
                'state projection source is not a relative exchange')
        widths = decode_relative_layout(
            mapped.value('operand_values', begin + 4))
        mode = mapped.value('operand_values', begin + 6)
        try:
            relative_selector_index(selector, len(widths), mode)
        except ValueError as error:
            raise StatePageError(str(error))

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
            if kind == 'projection':
                validate_projection(value)
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
    from .memorycut import MemoryCut
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
    memory = MemoryCut(state.memory)
    relative_results = {}
    alu_results = {}
    region_results = {}
    divide_results = {}

    def resolve(tag, value):
        kind = OPERAND_KINDS[tag]
        if kind == 'const':
            return value
        if kind == 'stack':
            return frame.stack[value]
        if kind == 'local':
            return frame.locals[value]
        if kind == 'projection':
            source, selector = decode_projection_coordinate(value)
            operation = OPS[mapped.value('opcodes', source - 1)]
            if operation in ALU_PROJECTION_OPS and selector == 16:
                return alu_results[source][1]
            if operation in ROTATE_PROJECTION_OPS and selector == 17:
                return alu_results[source][2]
            if operation in REGION_PROJECTION_OPS:
                return region_results[source][selector]
            if operation in DIVIDE_PROJECTION_OPS:
                return divide_results[source][selector]
            if operation in FLAG_PROJECTION_OPS:
                return evaluate('lane64.X86_CONDITION', (
                    values[source], selector))
            results, mode = relative_results[source]
            return _relative_select(results, selector, mode)
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
            if operation == 'memory.i64.repeat':
                _repeat(memory, *arguments[:4])
                produced.append((node, 0))
            elif operation == 'memory.i64.copy':
                _copy(memory, *arguments[:4])
                produced.append((node, 0))
            elif operation == 'memory.i64.find2':
                produced.append((node, _find2(memory, *arguments[:4])))
            elif operation == 'memory.i64.copy_until':
                produced.append((node, _copy_until(memory, *arguments[:7])))
            elif operation == 'memory.i64.prefix_end':
                produced.append((node, _prefix_end(memory, *arguments[:5])))
            elif operation == 'memory.i64.relative_exchange':
                mode = arguments[6]
                results = _relative_exchange(
                    memory, *arguments[:5], *arguments[6:])
                relative_results[node] = results, mode
                selector = arguments[5]
                produced.append((node, _relative_select(
                    results, selector, mode)))
            elif operation == 'memory.i64.relative_result':
                source = mapped.value('operand_values', begin)
                selector = arguments[1]
                results, mode = relative_results[source]
                produced.append((node, _relative_select(
                    results, selector, mode)))
            elif operation == 'memory.i64.relative_address':
                produced.append((node, _relative_address(
                    memory, *arguments[:5])))
            elif operation == 'lane64.X86_DIVIDE':
                from .laneops import x86_divide_results
                error, quotient, remainder = x86_divide_results(arguments)
                divide_results[node] = (quotient, remainder)
                produced.append((node, error))
            elif operation == 'memory.i64.pre_store':
                produced.append((node, _pre_store(
                    memory, *arguments[:4])))
            elif operation == 'memory.i64.load_region':
                region_results[node] = _load_region(
                    memory, *arguments[:4])
                produced.append((node, region_results[node][0]))
            elif operation == 'lane64.X86_ALU':
                alu_results[node] = _x86_alu(*arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'lane64.X86_AFFINE_ALU':
                alu_results[node] = _x86_affine_alu(*arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'lane64.X86_ROTATE_CARRY':
                from .laneops import x86_rotate_carry_results
                alu_results[node] = x86_rotate_carry_results(arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'lane64.X86_BIT_SUMMARY':
                from .laneops import x86_bit_summary_results
                alu_results[node] = x86_bit_summary_results(arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'lane64.X86_DOUBLE_SHIFT':
                from .laneops import x86_double_shift_results
                alu_results[node] = x86_double_shift_results(arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'lane64.X86_BZHI':
                from .laneops import x86_bzhi_results
                alu_results[node] = x86_bzhi_results(arguments)
                produced.append((node, alu_results[node][0]))
            elif operation == 'memory.i64.store_if':
                produced.append((node, _store_if(memory, *arguments[:5])))
            elif operation.startswith('memory.'):
                name = operation.split('.', 1)[1]
                source_name, observer = _memory_name(name)
                store = '.store' in source_name
                data_count = 2 if store else 1
                offset, shape = arguments[data_count:data_count + 2]
                width, scale, virtual64 = decode_memory_shape(shape)
                if store:
                    _store(memory, arguments[0], arguments[1], offset, width,
                           scale, virtual64)
                    value = 0
                else:
                    bits = 32 if source_name.startswith('i32.') else 64
                    signed = source_name.endswith('_s')
                    value = _memory_observe(_load(
                        memory, arguments[0], offset, width, scale,
                        signed, bits, virtual64), observer)
                produced.append((node, value))
            else:
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
    return replace(state, frames=state.frames[:-1] + (next_frame,),
                   memory=memory.commit())


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

        def execute_projection(locals_, stack, memory):
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

    lines = ['def execute(locals_, stack, memory):']
    namespace = {'memory_load': _load, 'memory_store': _store,
                 'memory_repeat': _repeat, 'memory_copy': _copy,
                 'memory_frame': _frame,
                 'memory_find2': _find2,
                 'memory_copy_until': _copy_until,
                 'memory_prefix_end': _prefix_end,
                 'memory_relative_exchange': _relative_exchange,
                 'memory_relative_select': _relative_select,
                 'memory_relative_address': _relative_address,
                 'memory_pre_store': _pre_store,
                 'memory_store_if': _store_if,
                 'memory_load_region': _load_region,
                 'x86_alu': _x86_alu,
                 'x86_affine_alu': _x86_affine_alu}
    from .laneops import x86_rotate_carry_results
    namespace['x86_rotate_carry'] = x86_rotate_carry_results
    from .laneops import x86_bit_summary_results
    namespace['x86_bit_summary'] = x86_bit_summary_results
    from .laneops import x86_double_shift_results
    namespace['x86_double_shift'] = x86_double_shift_results
    from .laneops import x86_bzhi_results
    namespace['x86_bzhi'] = x86_bzhi_results
    namespace['x86_condition'] = bind('lane64.X86_CONDITION')
    lines.append('    relative_results = {}')
    lines.append('    alu_results = {}')
    lines.append('    region_results = {}')

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
        if kind == 'projection':
            source, selector = decode_projection_coordinate(value)
            operation = OPS[mapped.value('opcodes', source - 1)]
            if operation in ALU_PROJECTION_OPS and selector == 16:
                return 'alu_results[%d][1]' % source
            if operation in ROTATE_PROJECTION_OPS and selector == 17:
                return 'alu_results[%d][2]' % source
            if operation in REGION_PROJECTION_OPS:
                return 'region_results[%d][%d]' % (source, selector)
            if operation in FLAG_PROJECTION_OPS:
                return 'x86_condition((value_%d, %d))' % (
                    source, selector)
            return ('memory_relative_select(relative_results[%d][0], %d, '
                    'relative_results[%d][1])'
                    % (source, selector, source))
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
            if operation == 'memory.i64.repeat':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append(
                    '    memory_repeat(memory, %s)' % call_arguments)
                lines.append('    value_%d = 0' % node)
                continue
            if operation == 'memory.i64.copy':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append(
                    '    memory_copy(memory, %s)' % call_arguments)
                lines.append('    value_%d = 0' % node)
                continue
            if operation == 'memory.i64.frame':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append(
                    '    memory_frame(memory, %s)' % call_arguments)
                lines.append('    value_%d = 0' % node)
                continue
            if operation == 'memory.i64.find2':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append('    value_%d = memory_find2(memory, %s)' %
                             (node, call_arguments))
                continue
            if operation == 'memory.i64.copy_until':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 7))
                lines.append('    value_%d = memory_copy_until(memory, %s)' %
                             (node, call_arguments))
                continue
            if operation == 'memory.i64.prefix_end':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 5))
                lines.append(
                    '    value_%d = memory_prefix_end(memory, %s)' %
                    (node, call_arguments))
                continue
            if operation == 'memory.i64.relative_exchange':
                leading = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 5))
                trailing = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first + 6, last))
                selector = mapped.value('operand_values', first + 5)
                mode = mapped.value('operand_values', first + 6)
                lines.append(
                    '    relative_results[%d] = ('
                    'memory_relative_exchange(memory, %s, %s), %d)' %
                    (node, leading, trailing, mode))
                lines.append(
                    '    value_%d = memory_relative_select('
                    'relative_results[%d][0], %d, %d)' %
                    (node, node, selector, mode))
                continue
            if operation == 'memory.i64.relative_result':
                source = mapped.value('operand_values', first)
                selector = mapped.value('operand_values', first + 1)
                lines.append(
                    '    value_%d = memory_relative_select('
                    'relative_results[%d][0], %d, '
                    'relative_results[%d][1])' %
                    (node, source, selector, source))
                continue
            if operation == 'memory.i64.relative_address':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 5))
                lines.append(
                    '    value_%d = memory_relative_address('
                    'memory, %s)' % (node, call_arguments))
                continue
            if operation == 'memory.i64.pre_store':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append(
                    '    value_%d = memory_pre_store('
                    'memory, %s)' % (node, call_arguments))
                continue
            if operation == 'memory.i64.load_region':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 4))
                lines.append(
                    '    region_results[%d] = memory_load_region('
                    'memory, %s)' % (node, call_arguments))
                lines.append('    value_%d = region_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_ALU':
                lines.append('    alu_results[%d] = x86_alu(%s)' %
                             (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_AFFINE_ALU':
                lines.append(
                    '    alu_results[%d] = x86_affine_alu(%s)' %
                    (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_ROTATE_CARRY':
                lines.append(
                    '    alu_results[%d] = x86_rotate_carry((%s))' %
                    (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_BIT_SUMMARY':
                lines.append(
                    '    alu_results[%d] = x86_bit_summary((%s))' %
                    (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_DOUBLE_SHIFT':
                lines.append(
                    '    alu_results[%d] = x86_double_shift((%s))' %
                    (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'lane64.X86_BZHI':
                lines.append(
                    '    alu_results[%d] = x86_bzhi((%s))' %
                    (node, arguments))
                lines.append('    value_%d = alu_results[%d][0]' %
                             (node, node))
                continue
            if operation == 'memory.i64.store_if':
                call_arguments = ', '.join(
                    expression('operand_tags', 'operand_values', index)
                    for index in range(first, first + 5))
                lines.append(
                    '    value_%d = memory_store_if(memory, %s)' %
                    (node, call_arguments))
                continue
            if operation.startswith('memory.'):
                name = operation.split('.', 1)[1]
                source_name, observer = _memory_name(name)
                store = '.store' in source_name
                data_count = 2 if store else 1
                data = [expression('operand_tags', 'operand_values', index)
                        for index in range(first, first + data_count)]
                offset = mapped.value('operand_values', first + data_count)
                shape = mapped.value(
                    'operand_values', first + data_count + 1)
                width, scale, virtual64 = decode_memory_shape(shape)
                if store:
                    lines.append(
                        '    memory_store(memory, %s, %s, %d, %d, %d, %r)' %
                        (data[0], data[1], offset, width, scale, virtual64))
                    lines.append('    value_%d = 0' % node)
                else:
                    bits = 32 if source_name.startswith('i32.') else 64
                    signed = source_name.endswith('_s')
                    loaded = ('memory_load(memory, %s, %d, %d, %d, %r, %d, %r)'
                              % (data[0], offset, width, scale, signed, bits,
                                 virtual64))
                    if observer == 'eqz':
                        loaded = 'int((%s) == 0)' % loaded
                    elif observer == 'nez':
                        loaded = 'int((%s) != 0)' % loaded
                    lines.append('    value_%d = %s' % (node, loaded))
                continue
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
