"""Range-readable archive for immutable direct-page memory baselines."""

from dataclasses import dataclass
import hashlib
import struct
import zlib

from .wasmstate import (MEMORY_PAGE, MEMORY_SPAN_PAGES, PagedMemory,
                        WasmStateError)


MAGIC = b'MEMA'
VERSION = 1
ALIGNMENT = 8
SPAN_BYTES = MEMORY_PAGE * MEMORY_SPAN_PAGES

_HEADER = struct.Struct('<4sHHQIIII')
# span coordinate, payload offset, compressed bytes, raw bytes, SHA-256.
_ENTRY = struct.Struct('<IQII32s')


class MemoryArchiveError(WasmStateError):
    """An immutable memory archive or selected span is malformed."""


def _align(value):
    return (int(value) + ALIGNMENT - 1) & -ALIGNMENT


def _compress(raw):
    stream = zlib.compressobj(9, zlib.DEFLATED, -15)
    return stream.compress(raw) + stream.flush()


@dataclass(frozen=True)
class MemorySpan:
    index: int
    offset: int
    length: int
    raw_bytes: int
    digest: bytes


def pack(memory):
    """Encode nonzero 64 KiB spans with a small coordinate directory."""
    if not isinstance(memory, PagedMemory):
        raise TypeError('memory archive needs a PagedMemory')
    if memory.base:
        raise ValueError('memory archive needs an implicit-zero baseline')
    spans = {}
    for page_index, page in memory.pages:
        if not any(page):
            raise ValueError('memory archive contains a redundant zero page')
        span_index, slot = divmod(page_index, MEMORY_SPAN_PAGES)
        raw = spans.get(span_index)
        if raw is None:
            start = span_index * SPAN_BYTES
            raw = bytearray(min(SPAN_BYTES, len(memory) - start))
            spans[span_index] = raw
        offset = slot * MEMORY_PAGE
        if offset + MEMORY_PAGE > len(raw):
            raise ValueError('memory archive page exceeds its final span')
        raw[offset:offset + MEMORY_PAGE] = page

    encoded = []
    page_count = 0
    for index, raw in sorted(spans.items()):
        raw = bytes(raw)
        pages = sum(
            any(raw[offset:offset + MEMORY_PAGE])
            for offset in range(0, len(raw), MEMORY_PAGE))
        if not pages:
            raise ValueError('memory archive contains an empty span')
        page_count += pages
        encoded.append((index, _compress(raw), len(raw),
                        hashlib.sha256(raw).digest()))

    count = len(encoded)
    header_bytes = _align(_HEADER.size + count * _ENTRY.size)
    cursor = header_bytes
    entries = []
    for index, payload, raw_bytes, digest in encoded:
        cursor = _align(cursor)
        entries.append(MemorySpan(
            index, cursor, len(payload), raw_bytes, digest))
        cursor += len(payload)
    output = bytearray(cursor)
    _HEADER.pack_into(
        output, 0, MAGIC, VERSION, header_bytes, len(memory),
        MEMORY_PAGE, MEMORY_SPAN_PAGES, count, page_count)
    at = _HEADER.size
    for entry in entries:
        _ENTRY.pack_into(
            output, at, entry.index, entry.offset, entry.length,
            entry.raw_bytes, entry.digest)
        at += _ENTRY.size
    for entry, (_index, payload, _raw_bytes, _digest) in zip(
            entries, encoded):
        output[entry.offset:entry.offset + entry.length] = payload
    return bytes(output)


class MappedMemoryArchive(object):
    """Resident span directory with independently decoded payloads."""

    __slots__ = ('data', 'memory_bytes', 'entries', 'page_count', '_spans')

    def __init__(self, data, memory_bytes, entries, page_count):
        self.data = data
        self.memory_bytes = int(memory_bytes)
        self.entries = tuple(entries)
        self.page_count = int(page_count)
        logical_spans = ((self.memory_bytes + SPAN_BYTES - 1)
                         // SPAN_BYTES)
        self._spans = [None] * logical_spans

    def entry(self, span_index):
        span_index = int(span_index)
        lo, hi = 0, len(self.entries)
        while lo < hi:
            middle = (lo + hi) // 2
            if self.entries[middle].index < span_index:
                lo = middle + 1
            else:
                hi = middle
        if lo < len(self.entries) \
                and self.entries[lo].index == span_index:
            return self.entries[lo]
        raise KeyError('memory span coordinate is not in the archive')

    def span(self, span_index):
        """Decode and verify one independently range-readable span."""
        entry = self.entry(span_index)
        cached = self._spans[entry.index]
        if cached is not None:
            return cached
        payload = self.data[entry.offset:entry.offset + entry.length]
        try:
            raw = zlib.decompress(payload, -15)
        except zlib.error as error:
            raise MemoryArchiveError(
                'compressed memory span is invalid') from error
        if len(raw) != entry.raw_bytes:
            raise MemoryArchiveError('memory span extent is invalid')
        if hashlib.sha256(raw).digest() != entry.digest:
            raise MemoryArchiveError('memory span integrity check failed')
        self._spans[entry.index] = raw
        return raw

    def proof_token(self, page_index, offset=0, count=MEMORY_PAGE):
        """Name immutable backing bytes without decoding their span."""
        page_index, offset, count = int(page_index), int(offset), int(count)
        if (page_index < 0 or page_index * MEMORY_PAGE >= self.memory_bytes
                or offset < 0 or count < 0
                or offset + count > MEMORY_PAGE):
            raise IndexError('memory proof coordinate is outside the archive')
        return self, page_index

    def page(self, page_index):
        """Read one 256-byte physical coordinate from its containing span."""
        page_index = int(page_index)
        if page_index < 0 or page_index * MEMORY_PAGE >= self.memory_bytes:
            raise IndexError('memory page coordinate is outside the archive')
        span_index, slot = divmod(page_index, MEMORY_SPAN_PAGES)
        try:
            raw = self.span(span_index)
        except KeyError:
            return bytes(MEMORY_PAGE)
        offset = slot * MEMORY_PAGE
        page = raw[offset:offset + MEMORY_PAGE]
        return page + bytes(MEMORY_PAGE - len(page))

    def materialize(self):
        """Build the persistent directory while retaining only nonzero pages."""
        pages = []
        for entry in self.entries:
            raw = self.span(entry.index)
            for slot, offset in enumerate(
                    range(0, len(raw), MEMORY_PAGE)):
                page = raw[offset:offset + MEMORY_PAGE]
                if len(page) < MEMORY_PAGE:
                    page += bytes(MEMORY_PAGE - len(page))
                if any(page):
                    pages.append((
                        entry.index * MEMORY_SPAN_PAGES + slot, page))
        if len(pages) != self.page_count:
            raise MemoryArchiveError('memory archive page count is invalid')
        return PagedMemory(b'', self.memory_bytes, pages)

    def paged_memory(self):
        """Open the archive as a lazy immutable PagedMemory backing."""
        return PagedMemory(
            b'', self.memory_bytes, _backing=self)

    def layout(self):
        return {
            'kind': 'memory-page-archive',
            'memory_bytes': self.memory_bytes,
            'page_bytes': MEMORY_PAGE,
            'span_bytes': SPAN_BYTES,
            'spans': len(self.entries),
            'pages': self.page_count,
            'directory_bytes': _HEADER.size + len(self.entries) * _ENTRY.size,
            'archive_bytes': len(self.data),
            'resident_spans': sum(span is not None for span in self._spans),
        }


def unpack(blob):
    """Map the directory without decoding any compressed memory span."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < _HEADER.size:
        raise MemoryArchiveError('memory archive header is truncated')
    (magic, version, header_bytes, memory_bytes, page_bytes, span_pages,
     count, page_count) = _HEADER.unpack_from(data)
    expected_header = _align(_HEADER.size + count * _ENTRY.size)
    if (magic != MAGIC or version != VERSION
            or page_bytes != MEMORY_PAGE
            or span_pages != MEMORY_SPAN_PAGES
            or header_bytes != expected_header
            or header_bytes > len(data)):
        raise MemoryArchiveError('memory archive has an unknown format')
    if not memory_bytes or page_count > (
            memory_bytes + MEMORY_PAGE - 1) // MEMORY_PAGE:
        raise MemoryArchiveError('memory archive extent is invalid')
    directory_end = _HEADER.size + count * _ENTRY.size
    if any(data[directory_end:header_bytes]):
        raise MemoryArchiveError('memory archive header padding is nonzero')

    entries = []
    at = _HEADER.size
    cursor = header_bytes
    previous = -1
    for _unused in range(count):
        raw = _ENTRY.unpack_from(data, at)
        at += _ENTRY.size
        entry = MemorySpan(*raw)
        if entry.index <= previous:
            raise MemoryArchiveError(
                'memory span directory is not coordinate ordered')
        previous = entry.index
        start = entry.index * SPAN_BYTES
        expected_raw = min(SPAN_BYTES, memory_bytes - start)
        aligned = _align(cursor)
        end = entry.offset + entry.length
        if (start < 0 or expected_raw <= 0
                or entry.raw_bytes != expected_raw
                or not entry.length or entry.offset != aligned
                or any(data[cursor:aligned]) or end > len(data)):
            raise MemoryArchiveError('memory span extent is not canonical')
        entries.append(entry)
        cursor = end
    if cursor != len(data):
        raise MemoryArchiveError('memory archive has trailing bytes')
    return MappedMemoryArchive(data, memory_bytes, entries, page_count)
