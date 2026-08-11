"""Direct function-body regions for page-delivered WebAssembly modules."""

from dataclasses import dataclass
import hashlib
import struct


MAGIC = b'WREG'
VERSION = 1
_HEADER = struct.Struct('<4sHHQIIII32s')
_BODY = struct.Struct('<III')
HEADER_BYTES = _HEADER.size
BODY_BYTES = _BODY.size


class WasmRegionsError(ValueError):
    """A function-region view is malformed or names another module."""


@dataclass(frozen=True)
class FunctionBodyRegion:
    function_index: int
    body_ordinal: int
    start: int
    end: int
    type_index: int

    @property
    def size(self):
        return self.end - self.start


class MappedFunctionRegions(object):
    """Validated direct records kept as one mapped byte region."""

    __slots__ = ('data', 'module_bytes', 'imported_functions', 'body_count',
                 'module_digest')

    def __init__(self, data, module_bytes, imported_functions, body_count,
                 module_digest):
        self.data = data
        self.module_bytes = module_bytes
        self.imported_functions = imported_functions
        self.body_count = body_count
        self.module_digest = module_digest

    def body(self, function_index):
        function_index = int(function_index)
        ordinal = function_index - self.imported_functions
        if ordinal < 0 or ordinal >= self.body_count:
            return None
        at = HEADER_BYTES + ordinal * BODY_BYTES
        start, end, type_index = _BODY.unpack_from(self.data, at)
        return FunctionBodyRegion(
            function_index, ordinal, start, end, type_index)

    def layout(self):
        return {
            'kind': 'wasm-function-regions',
            'module_bytes': self.module_bytes,
            'imported_functions': self.imported_functions,
            'defined_functions': self.body_count,
            'record_bytes': BODY_BYTES,
            'mapped_bytes': len(self.data),
        }


def pack(index):
    """Encode one direct record per defined function in function-index order."""
    if len(index.data) > 0xFFFFFFFFFFFFFFFF:
        raise ValueError('WebAssembly module is too large for a region view')
    if len(index.bodies) > 0xFFFFFFFF:
        raise ValueError('WebAssembly module has too many function bodies')
    output = bytearray(HEADER_BYTES + len(index.bodies) * BODY_BYTES)
    _HEADER.pack_into(
        output, 0, MAGIC, VERSION, HEADER_BYTES, len(index.data),
        index.imported_functions, len(index.bodies), BODY_BYTES, 0,
        hashlib.sha256(index.data).digest())
    at = HEADER_BYTES
    for ordinal, body in enumerate(index.bodies):
        if (body.ordinal != ordinal
                or body.function_index != index.imported_functions + ordinal
                or not 0 <= body.start < body.end <= len(index.data)
                or body.start > 0xFFFFFFFF or body.end > 0xFFFFFFFF
                or body.type_index > 0xFFFFFFFF):
            raise ValueError('WebAssembly body regions are not direct')
        _BODY.pack_into(
            output, at, body.start, body.end, body.type_index)
        at += BODY_BYTES
    return output


def unpack(blob, module_digest=None):
    """Validate a direct region view without expanding its body records."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < HEADER_BYTES:
        raise WasmRegionsError('WebAssembly region header is truncated')
    (magic, version, header_bytes, module_bytes, imported_functions,
     body_count, record_bytes, reserved, digest) = _HEADER.unpack_from(data)
    if (magic != MAGIC or version != VERSION or header_bytes != HEADER_BYTES
            or record_bytes != BODY_BYTES or reserved):
        raise WasmRegionsError('WebAssembly region format is unknown')
    if len(data) != HEADER_BYTES + body_count * BODY_BYTES:
        raise WasmRegionsError('WebAssembly region table has the wrong extent')
    if module_digest is not None and bytes(digest) != bytes(module_digest):
        raise WasmRegionsError('WebAssembly region table names another module')
    previous = 0
    for ordinal in range(body_count):
        start, end, _type = _BODY.unpack_from(
            data, HEADER_BYTES + ordinal * BODY_BYTES)
        if not 0 <= start < end <= module_bytes or start < previous:
            raise WasmRegionsError('WebAssembly body regions are not ordered')
        previous = end
    return MappedFunctionRegions(
        data, module_bytes, imported_functions, body_count, bytes(digest))
