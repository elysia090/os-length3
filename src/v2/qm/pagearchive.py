"""Range-readable index over independent physical execution pages.

The directory is resident; page payloads are not decoded until selected by a
machine coordinate.  A payload can live as an independent OPFS object, an HTTP
range, or a view into this packed archive.  Rebuilding or evicting these pages
never changes the source program.
"""

from dataclasses import dataclass
import struct

from .cfront.errors import CFrontError


MAGIC = b'PAGE'
VERSION = 1
ALIGNMENT = 8

SCALAR = 1
STATE_STEP = 2
KINDS = {'scalar': SCALAR, 'state-step': STATE_STEP}
KIND_NAMES = dict((value, key) for key, value in KINDS.items())

_HEADER = struct.Struct('<4sHHII')
# kind, function, start pc, frame/input extent, payload offset, byte length,
# span, work, required feature bits.
_ENTRY = struct.Struct('<IIIIQIIII')


class PageArchiveError(CFrontError):
    """A physical page archive or selected page is malformed."""


def _align(value):
    return (value + ALIGNMENT - 1) & -ALIGNMENT


@dataclass(frozen=True)
class ArchivePage:
    kind: str
    function: int
    start: int
    frame_extent: int
    blob: bytes

    @property
    def key(self):
        return (KINDS[self.kind], self.function, self.start, self.frame_extent)


@dataclass(frozen=True)
class ArchiveEntry:
    kind: int
    function: int
    start: int
    frame_extent: int
    offset: int
    length: int
    span: int
    work: int
    required_features: int

    @property
    def key(self):
        return (self.kind, self.function, self.start, self.frame_extent)

    def layout(self):
        return {
            'kind': KIND_NAMES[self.kind],
            'function': self.function,
            'start_pc': self.start,
            'frame_extent': self.frame_extent,
            'offset': self.offset,
            'bytes': self.length,
            'span': self.span,
            'work': self.work,
            'required_features': self.required_features,
        }


def _inspect(page):
    try:
        kind = KINDS[page.kind]
    except KeyError:
        raise ValueError('unknown physical page kind %r' % page.kind)
    if min(page.function, page.start, page.frame_extent) < 0:
        raise ValueError('physical page coordinates must be nonnegative')
    blob = bytes(page.blob)
    if kind == SCALAR:
        from . import scalarpage
        mapped = scalarpage.unpack(blob)
        if page.frame_extent != mapped.inputs:
            raise ValueError('scalar input extent does not match its key')
        features = mapped.required_features
    else:
        from . import steppage
        mapped = steppage.unpack(blob)
        if (page.function != mapped.function or page.start != mapped.start
                or page.frame_extent != mapped.stack_inputs):
            raise ValueError('state-step coordinate does not match its key')
        features = 0
    return kind, blob, mapped.span, mapped.work, features


def pack(pages):
    """Pack pages in coordinate order with a deterministic front directory."""
    inspected = []
    for page in pages:
        kind, blob, span, work, features = _inspect(page)
        key = (kind, page.function, page.start, page.frame_extent)
        inspected.append((key, blob, span, work, features))
    inspected.sort(key=lambda item: item[0])
    if any(left[0] == right[0]
           for left, right in zip(inspected, inspected[1:])):
        raise ValueError('page archive has a duplicate coordinate')

    count = len(inspected)
    header_bytes = _align(_HEADER.size + count * _ENTRY.size)
    cursor = header_bytes
    entries = []
    for key, blob, span, work, features in inspected:
        cursor = _align(cursor)
        entries.append(ArchiveEntry(
            key[0], key[1], key[2], key[3], cursor, len(blob), span, work,
            features,
        ))
        cursor += len(blob)

    out = bytearray(cursor)
    _HEADER.pack_into(out, 0, MAGIC, VERSION, header_bytes, count, _ENTRY.size)
    at = _HEADER.size
    for entry in entries:
        _ENTRY.pack_into(
            out, at, entry.kind, entry.function, entry.start,
            entry.frame_extent, entry.offset, entry.length, entry.span,
            entry.work, entry.required_features,
        )
        at += _ENTRY.size
    for entry, (_key, blob, _span, _work, _features) in zip(entries, inspected):
        out[entry.offset:entry.offset + entry.length] = blob
    return bytes(out)


class MappedPageArchive(object):
    """Resident directory with demand decoding of selected page payloads."""

    __slots__ = ('data', 'entries')

    def __init__(self, data, entries):
        self.data = data
        self.entries = entries

    def entry(self, kind, function, start=0, frame_extent=1):
        try:
            kind_code = KINDS[kind]
        except KeyError:
            raise KeyError('unknown physical page kind %r' % kind)
        key = (kind_code, function, start, frame_extent)
        # The canonical directory is already coordinate ordered. Search that
        # resident range directly instead of retaining a second hash index;
        # opening a page then touches only its directory entry and payload.
        lo, hi = 0, len(self.entries)
        while lo < hi:
            middle = (lo + hi) // 2
            if self.entries[middle].key < key:
                lo = middle + 1
            else:
                hi = middle
        if lo < len(self.entries) and self.entries[lo].key == key:
            return self.entries[lo]
        raise KeyError('physical page coordinate is not in the archive')

    def page(self, kind, function, start=0, frame_extent=1):
        """Return one memoryview without copying or scanning its payload."""
        entry = self.entry(kind, function, start, frame_extent)
        return self.data[entry.offset:entry.offset + entry.length]

    def open(self, kind, function, start=0, frame_extent=1):
        payload = self.page(kind, function, start, frame_extent)
        if kind == 'scalar':
            from . import scalarpage
            return scalarpage.unpack(payload)
        from . import steppage
        return steppage.unpack(payload)

    def layout(self):
        return {
            'kind': 'physical-page-archive',
            'pages': len(self.entries),
            'directory_bytes': (_HEADER.size + len(self.entries) * _ENTRY.size),
            'mapped_bytes': len(self.data),
            'entries': [entry.layout() for entry in self.entries],
        }


def unpack(blob):
    """Map only the directory; selected payloads validate in :meth:`open`."""
    data = blob if isinstance(blob, memoryview) else memoryview(blob)
    if len(data) < _HEADER.size:
        raise PageArchiveError('page archive header is truncated')
    magic, version, header_bytes, count, entry_bytes = _HEADER.unpack_from(data)
    expected_header = _align(_HEADER.size + count * _ENTRY.size)
    if (magic != MAGIC or version != VERSION or entry_bytes != _ENTRY.size
            or header_bytes != expected_header or header_bytes > len(data)):
        raise PageArchiveError('page archive has an unknown format')
    directory_end = _HEADER.size + count * _ENTRY.size
    if any(data[directory_end:header_bytes]):
        raise PageArchiveError('page archive header padding is nonzero')

    entries = []
    at = _HEADER.size
    cursor = header_bytes
    for _index in range(count):
        raw = _ENTRY.unpack_from(data, at)
        at += _ENTRY.size
        entry = ArchiveEntry(*raw)
        if entry.kind not in KIND_NAMES:
            raise PageArchiveError('page archive has an unknown page kind')
        aligned = _align(cursor)
        if entry.offset != aligned or any(data[cursor:aligned]):
            raise PageArchiveError('page offset is not canonical')
        end = entry.offset + entry.length
        if end > len(data):
            raise PageArchiveError('page archive payload is truncated')
        entries.append(entry)
        cursor = end
    if entries != sorted(entries, key=lambda entry: entry.key):
        raise PageArchiveError('page directory is not coordinate ordered')
    if len({entry.key for entry in entries}) != len(entries):
        raise PageArchiveError('page archive has a duplicate coordinate')
    if cursor != len(data):
        raise PageArchiveError('page archive has trailing bytes')
    return MappedPageArchive(data, tuple(entries))
