"""Fixed-width ordered state transitions between physical STEP pages."""

from dataclasses import dataclass
import struct

from .cfront.errors import CFrontError


MAGIC = b'BARR'
VERSION = 1
HEADER_BYTES = 48
_HEADER = struct.Struct('<4sHHIIIIIIIIII')

GLOBAL_GET = 1
GLOBAL_SET = 2
CALL = 3
RETURN = 4

OPERATIONS = {
    'global.get': GLOBAL_GET,
    'global.set': GLOBAL_SET,
    'call': CALL,
    'return': RETURN,
}
OPERATION_NAMES = dict((value, key) for key, value in OPERATIONS.items())


class BarrierPageError(CFrontError):
    """A fixed barrier transition is malformed."""


@dataclass(frozen=True)
class BarrierPage:
    function: int
    start: int
    end: int
    operation: str
    stack_extent: int
    arguments: tuple = ()

    def __post_init__(self):
        if min(self.function, self.start, self.end, self.stack_extent) < 0:
            raise ValueError('barrier coordinates must be nonnegative')
        if self.end < self.start:
            raise ValueError('barrier end precedes its start')
        if self.operation not in OPERATIONS:
            raise ValueError('unknown barrier operation %r' % self.operation)
        expected = {
            'global.get': 1,
            'global.set': 1,
            'call': 4,
            'return': 1,
        }[self.operation]
        if len(self.arguments) != expected \
                or any(int(value) < 0 or int(value) > 0xffffffff
                       for value in self.arguments):
            raise ValueError('barrier arguments have the wrong extent')

    def layout(self):
        return {
            'function': self.function,
            'start_pc': self.start,
            'end_pc': self.end,
            'operation': self.operation,
            'stack_extent': self.stack_extent,
            'arguments': list(self.arguments),
        }


def pack(page):
    """Encode one ordered transition without a decoded Wasm object graph."""
    if not isinstance(page, BarrierPage):
        raise TypeError('barrier encoder needs a BarrierPage')
    arguments = tuple(map(int, page.arguments)) + (0,) * (4 - len(page.arguments))
    return _HEADER.pack(
        MAGIC, VERSION, HEADER_BYTES,
        page.function, page.start, page.end, OPERATIONS[page.operation],
        page.stack_extent, *arguments, 0)


def unpack(blob):
    """Validate and map one fixed transition."""
    data = bytes(blob)
    if len(data) != HEADER_BYTES:
        raise BarrierPageError('barrier page has the wrong extent')
    (magic, version, header_bytes, function, start, end, operation,
     stack_extent, a, b, c, d, reserved) = _HEADER.unpack(data)
    if (magic != MAGIC or version != VERSION or header_bytes != HEADER_BYTES
            or reserved):
        raise BarrierPageError('barrier page format is unknown')
    name = OPERATION_NAMES.get(operation)
    if name is None:
        raise BarrierPageError('barrier operation is unknown')
    count = {'global.get': 1, 'global.set': 1,
             'call': 4, 'return': 1}[name]
    raw = (a, b, c, d)
    if any(raw[count:]):
        raise BarrierPageError('barrier page has nonzero unused arguments')
    try:
        return BarrierPage(
            function, start, end, name, stack_extent, raw[:count])
    except ValueError as error:
        raise BarrierPageError(str(error)) from error
