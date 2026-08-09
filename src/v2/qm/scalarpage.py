"""Mapped physical page for one normalized scalar SSA program.

The minimized program remains the source of truth.  This file derives a
target-shaped execution cache which can be discarded and rebuilt.  Nodes are
stored in structure-of-arrays columns and grouped by dependency depth, so the
runtime orders waves while every lane inside one wave is independent.

The opcode domain deliberately contains the physical operations selected by
QM.  A carry-less prefix is therefore one CLMUL lane and an eight-lane rank is
one PDEP lane followed by one IMUL lane; neither is expanded back into the
source-level expression that the optimizer already removed.
"""

from dataclasses import dataclass
import struct

from . import isa
from .bits import (M64, bswap64, clmul, clz, ctz, mask_of, pdep, pext,
                   popcnt, sar)
from .cfront.errors import CFrontError
from .wasmphysical import schedule_sequence


MAGIC = b'SCAL'
VERSION = 1
OPS = tuple(isa.OPCODES)
OP_TO_CODE = dict((name, code) for code, name in enumerate(OPS))
NO_SHIFT = 255

FEATURES = ('pdep', 'pext', 'clmul', 'popcnt')
FEATURE_TO_BIT = dict((name, 1 << bit) for bit, name in enumerate(FEATURES))

_HEADER = struct.Struct('<4sHH8I')
_DIRECTORY_ENTRY = struct.Struct('<II')
_COLUMNS = (
    ('wave_offsets', 4),
    ('lane_values', 4),
    ('opcodes', 1),
    ('argument_offsets', 4),
    ('argument_values', 4),
    ('constant_offsets', 4),
    ('constant_values', 8),
    ('shifts', 1),
)


class ScalarPageError(CFrontError):
    """A minimized-program execution cache is malformed."""


def _align(value, alignment=8):
    return (value + alignment - 1) & -alignment


HEADER_BYTES = _align(_HEADER.size + len(_COLUMNS) * _DIRECTORY_ENTRY.size)


def _column_bytes(width, values):
    if width == 1:
        return bytes(values)
    code = '<I' if width == 4 else '<Q'
    return b''.join(struct.pack(code, int(value)) for value in values)


def pack(seq, value_bits=64, inputs=1):
    """Encode a normalized :class:`qm.isa.Seq` as one mapped scalar page."""
    if value_bits not in (32, 64):
        raise ValueError('physical sequence values must be i32 or i64')
    if inputs != 1:
        raise ValueError('the minimized scalar sequence has one input')
    waves = schedule_sequence(seq)
    work = len(seq.ins)
    if waves.work != work:
        raise ValueError('dependency waves do not cover the SSA node domain')
    if seq.result < 0 or seq.result > work:
        raise ValueError('result is outside the SSA value domain')

    opcodes = []
    argument_offsets = [0]
    argument_values = []
    constant_offsets = [0]
    constant_values = []
    shifts = []
    required_features = 0
    for value, instruction in enumerate(seq.ins, start=1):
        try:
            opcodes.append(OP_TO_CODE[instruction.op])
        except KeyError:
            raise ValueError('operation %r has no physical code'
                             % instruction.op)
        if instruction.op in ('PDEP', 'PDEP_DYN'):
            required_features |= FEATURE_TO_BIT['pdep']
        if instruction.op in ('PEXT', 'PEXT_DYN', 'LOOP8'):
            required_features |= FEATURE_TO_BIT['pext']
        if instruction.op == 'CLMUL':
            required_features |= FEATURE_TO_BIT['clmul']
        if instruction.op == 'POPCNT':
            required_features |= FEATURE_TO_BIT['popcnt']
        arguments = tuple(int(item) for item in instruction.args)
        if any(item < 0 or item >= value for item in arguments):
            raise ValueError('SSA arguments must name an input or earlier node')
        argument_values.extend(arguments)
        argument_offsets.append(len(argument_values))

        constants = instruction.const
        if constants is None:
            constants = ()
        elif not isinstance(constants, (tuple, list)):
            constants = (constants,)
        constant_values.extend(int(item) & M64 for item in constants)
        constant_offsets.append(len(constant_values))
        shift = NO_SHIFT if instruction.shift is None else int(instruction.shift)
        if shift != NO_SHIFT and not 0 <= shift < value_bits:
            raise ValueError('shift is outside the physical value width')
        shifts.append(shift)

    values = {
        'wave_offsets': tuple(waves.offsets),
        'lane_values': tuple(waves.values),
        'opcodes': opcodes,
        'argument_offsets': argument_offsets,
        'argument_values': argument_values,
        'constant_offsets': constant_offsets,
        'constant_values': constant_values,
        'shifts': shifts,
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
        value_bits, inputs, seq.result, waves.span, work,
        len(argument_values), len(constant_values), required_features,
    )
    at = _HEADER.size
    for entry in directory:
        _DIRECTORY_ENTRY.pack_into(blob, at, *entry)
        at += _DIRECTORY_ENTRY.size
    for (name, _width), (offset, _count) in zip(_COLUMNS, directory):
        raw = encoded[name]
        blob[offset:offset + len(raw)] = raw
    return bytes(blob)


@dataclass(frozen=True)
class _Column:
    offset: int
    count: int
    width: int


class MappedScalarPage(object):
    """Validated zero-copy columns for one minimized physical program."""

    __slots__ = ('data', 'value_bits', 'inputs', 'result', 'span', 'work',
                 'arguments', 'constants', 'required_features', '_columns')

    def __init__(self, data, header, columns):
        self.data = data
        (self.value_bits, self.inputs, self.result, self.span, self.work,
         self.arguments, self.constants, self.required_features) = header
        self._columns = columns

    def column(self, name):
        column = self._columns[name]
        end = column.offset + column.count * column.width
        return self.data[column.offset:end]

    def value(self, name, index):
        column = self._columns[name]
        if index < 0 or index >= column.count:
            raise IndexError('%s coordinate is outside its region' % name)
        offset = column.offset + index * column.width
        if column.width == 1:
            return self.data[offset]
        code = '<I' if column.width == 4 else '<Q'
        return struct.unpack_from(code, self.data, offset)[0]

    def values(self, name):
        return tuple(self.value(name, index)
                     for index in range(self._columns[name].count))

    def wave(self, depth):
        if depth < 1 or depth > self.span:
            raise IndexError('wave depth is outside the program')
        begin = self.value('wave_offsets', depth - 1)
        end = self.value('wave_offsets', depth)
        return tuple(self.value('lane_values', index)
                     for index in range(begin, end))

    def layout(self):
        offsets = self.values('wave_offsets')
        widths = [offsets[index + 1] - offsets[index]
                  for index in range(self.span)]
        return {
            'kind': 'scalar-ssa-page',
            'value_bits': self.value_bits,
            'input_values': self.inputs,
            'result_value': self.result,
            'work': self.work,
            'span': self.span,
            'wave_offsets': list(offsets),
            'wave_widths': widths,
            'max_parallel_width': max(widths, default=0),
            'required_features': [
                name for name in FEATURES
                if self.required_features & FEATURE_TO_BIT[name]
            ],
            'mapped_bytes': len(self.data),
            'columns': {
                name: {'offset': column.offset,
                       'count': column.count,
                       'width': column.width}
                for name, column in self._columns.items()
            },
        }


def _expected_counts(span, work, arguments, constants):
    return {
        'wave_offsets': span + 1,
        'lane_values': work,
        'opcodes': work,
        'argument_offsets': work + 1,
        'argument_values': arguments,
        'constant_offsets': work + 1,
        'constant_values': constants,
        'shifts': work,
    }


def unpack(blob):
    """Validate and map a physical sequence without rebuilding SSA objects."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < HEADER_BYTES:
        raise ScalarPageError('scalar page header is truncated')
    magic, version, header_bytes, *header = _HEADER.unpack_from(data, 0)
    if magic != MAGIC or version != VERSION or header_bytes != HEADER_BYTES:
        raise ScalarPageError('scalar page has an unknown format')
    (value_bits, inputs, result, span, work, arguments, constants,
     required_features) = header
    if value_bits not in (32, 64) or inputs != 1 or result > work:
        raise ScalarPageError('scalar page header is inconsistent')
    if required_features & ~sum(FEATURE_TO_BIT.values()):
        raise ScalarPageError('scalar page requires unknown features')

    expected = _expected_counts(span, work, arguments, constants)
    columns = {}
    cursor = HEADER_BYTES
    directory_at = _HEADER.size
    directory_end = _HEADER.size + len(_COLUMNS) * _DIRECTORY_ENTRY.size
    if any(data[directory_end:HEADER_BYTES]):
        raise ScalarPageError('scalar page header padding is nonzero')
    for name, width in _COLUMNS:
        offset, count = _DIRECTORY_ENTRY.unpack_from(data, directory_at)
        directory_at += _DIRECTORY_ENTRY.size
        aligned = _align(cursor)
        if any(data[cursor:aligned]):
            raise ScalarPageError('scalar page padding is nonzero')
        cursor = aligned
        if offset != cursor or count != expected[name]:
            raise ScalarPageError('%s column is not canonical' % name)
        end = offset + count * width
        if end > len(data):
            raise ScalarPageError('%s column is truncated' % name)
        columns[name] = _Column(offset, count, width)
        cursor = end
    if cursor != len(data):
        raise ScalarPageError('scalar page has trailing bytes')

    mapped = MappedScalarPage(data, tuple(header), columns)
    _validate(mapped)
    return mapped


_ONE_ARGUMENT = {
    'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'IMUL', 'CLMUL', 'AND',
    'OR', 'XOR', 'ADD', 'SUB', 'NOT', 'SHL', 'SHR', 'BSWAP', 'POPCNT',
    'LOOP8', 'SCANXOR', 'SAR', 'NEG', 'CLZ', 'CTZ', 'LUT',
}
_TWO_ARGUMENTS = {'XORR', 'ANDR', 'ORR', 'ADDR', 'ANDNR', 'SUBR'}
_ONE_CONSTANT = {
    'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN', 'IMUL', 'CLMUL', 'AND',
    'OR', 'XOR', 'ADD', 'SUB', 'LOOP8',
}
_ONE_SHIFT = {'SHL', 'SHR', 'SCANXOR', 'SAR'}


def _validate(mapped):
    offsets = mapped.values('wave_offsets')
    lanes = mapped.values('lane_values')
    if (not offsets or offsets[0] != 0 or offsets[-1] != mapped.work
            or any(a > b for a, b in zip(offsets, offsets[1:]))):
        raise ScalarPageError('waves are not a segmented region')
    if sorted(lanes) != list(range(1, mapped.work + 1)):
        raise ScalarPageError('wave lanes do not cover the SSA domain')

    arguments = mapped.values('argument_offsets')
    constants = mapped.values('constant_offsets')
    if (arguments[0] != 0 or arguments[-1] != mapped.arguments
            or any(a > b for a, b in zip(arguments, arguments[1:]))):
        raise ScalarPageError('arguments are not a segmented region')
    if (constants[0] != 0 or constants[-1] != mapped.constants
            or any(a > b for a, b in zip(constants, constants[1:]))):
        raise ScalarPageError('constants are not a segmented region')

    depth = [0] * (mapped.work + 1)
    required_features = 0
    for wave in range(1, mapped.span + 1):
        for value in mapped.wave(wave):
            depth[value] = wave
    for value in range(1, mapped.work + 1):
        code = mapped.value('opcodes', value - 1)
        if code >= len(OPS):
            raise ScalarPageError('scalar page has an unknown opcode')
        op = OPS[code]
        if op in ('PDEP', 'PDEP_DYN'):
            required_features |= FEATURE_TO_BIT['pdep']
        if op in ('PEXT', 'PEXT_DYN', 'LOOP8'):
            required_features |= FEATURE_TO_BIT['pext']
        if op == 'CLMUL':
            required_features |= FEATURE_TO_BIT['clmul']
        if op == 'POPCNT':
            required_features |= FEATURE_TO_BIT['popcnt']
        begin, end = arguments[value - 1:value + 1]
        args = mapped.values('argument_values')[begin:end]
        if any(arg >= value or (arg and depth[arg] >= depth[value])
               for arg in args):
            raise ScalarPageError('a lane depends on its own/later wave')
        arity = end - begin
        if op in _ONE_ARGUMENT:
            expected_arity = 1
        elif op in _TWO_ARGUMENTS:
            expected_arity = 2
        else:  # guarded by the fixed OPS table, kept explicit for extensions
            raise ScalarPageError('%s has no declared argument shape' % op)
        if arity != expected_arity:
            raise ScalarPageError('%s has the wrong argument count' % op)

        cbegin, cend = constants[value - 1:value + 1]
        count = cend - cbegin
        if op == 'LUT':
            if not count or count & (count - 1):
                raise ScalarPageError('LUT size must be a power of two')
        elif count != (1 if op in _ONE_CONSTANT else 0):
            raise ScalarPageError('%s has the wrong constant count' % op)
        shift = mapped.value('shifts', value - 1)
        if op in _ONE_SHIFT:
            if shift >= mapped.value_bits:
                raise ScalarPageError('%s has an invalid shift' % op)
        elif shift != NO_SHIFT:
            raise ScalarPageError('%s unexpectedly carries a shift' % op)
    if required_features != mapped.required_features:
        raise ScalarPageError('physical feature requirements are not exact')


def execute(mapped, input_value):
    """Execute mapped waves directly; this is the portable reference VM."""
    mask = mask_of(mapped.value_bits)
    values = [int(input_value) & mask] + [0] * mapped.work
    arguments = mapped.values('argument_offsets')
    constants = mapped.values('constant_offsets')

    for wave in range(1, mapped.span + 1):
        produced = []
        for value in mapped.wave(wave):
            begin, end = arguments[value - 1:value + 1]
            args = tuple(values[mapped.value('argument_values', index)]
                         for index in range(begin, end))
            cbegin, cend = constants[value - 1:value + 1]
            consts = tuple(mapped.value('constant_values', index)
                           for index in range(cbegin, cend))
            op = OPS[mapped.value('opcodes', value - 1)]
            shift = mapped.value('shifts', value - 1)
            produced.append((value, _apply(op, args, consts, shift, mask)))
        for value, result in produced:
            values[value] = result & mask
    return values[mapped.result]


def _apply(op, args, constants, shift, mask):
    a = args[0]
    b = args[1] if len(args) > 1 else 0
    k = constants[0] if constants else 0
    bits = mask.bit_length()
    if op == 'PDEP': return pdep(a, k, bits)
    if op == 'PEXT': return pext(a, k, bits)
    if op == 'PEXT_DYN': return pext(k, a, bits)
    if op == 'PDEP_DYN': return pdep(k, a, bits)
    if op == 'IMUL': return a * k
    if op == 'CLMUL': return clmul(a, k, bits)
    if op == 'AND': return a & k
    if op == 'OR': return a | k
    if op == 'XOR': return a ^ k
    if op == 'ADD': return a + k
    if op == 'SUB': return a - k
    if op == 'NOT': return ~a
    if op == 'SHL': return a << shift
    if op == 'SHR': return a >> shift
    if op == 'SAR': return sar(a, shift, bits)
    if op == 'BSWAP':
        return (bswap64(a) if bits == 64 else
                int.from_bytes(a.to_bytes(4, 'little'), 'big'))
    if op == 'POPCNT': return popcnt(a)
    if op == 'XORR': return a ^ b
    if op == 'ANDR': return a & b
    if op == 'ORR': return a | b
    if op == 'ADDR': return a + b
    if op == 'ANDNR': return ~a & b
    if op == 'SUBR': return a - b
    if op == 'LOOP8': return pext(k, a, bits)
    if op == 'SCANXOR': return a ^ (a << shift)
    if op == 'NEG': return -a
    if op == 'CLZ': return clz(a, bits)
    if op == 'CTZ': return ctz(a, bits)
    if op == 'LUT': return constants[a & (len(constants) - 1)]
    raise ScalarPageError('no executor for %s' % op)
