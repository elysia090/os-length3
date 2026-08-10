"""Frontend-independent byte SSA between observable machine-state cuts.

A page carries two physical arrays: the final value of each byte coordinate
and a 256-bit domain mask saying which coordinates have a newer SSA version.
Loads select the newest coordinate directly.  Storage hidden by that mask is
not read, and complete pages are materialized only when the surrounding
machine reaches a persistent cut.
"""

from .bits import mask_of
from .wasmstate import (MEMORY_PAGE, MEMORY_REGION_SPANS, MEMORY_SPAN_PAGES,
                        WasmStateError)


class BytePage(object):
    """Final byte coordinates for one physical page before a persistent cut."""

    __slots__ = ('values', 'written')

    def __init__(self):
        self.values = bytearray(MEMORY_PAGE)
        self.written = 0

    def write(self, offset, payload):
        count = len(payload)
        selected = mask_of(count) << offset
        overwritten = (self.written & selected).bit_count()
        self.values[offset:offset + count] = payload
        self.written |= selected
        return overwritten

    @staticmethod
    def _runs(bits):
        """Yield maximal adjacent coordinates from one physical bit domain."""
        while bits:
            low = bits & -bits
            start = low.bit_length() - 1
            tail = bits >> start
            length = ((~tail) & (tail + 1)).bit_length() - 1
            yield start, start + length
            bits &= ~(mask_of(length) << start)

    def _overlay(self, target, page_offset, written):
        for start, end in self._runs(written):
            target[start:end] = self.values[
                page_offset + start:page_offset + end]

    def read(self, source, index, offset, count):
        selected = mask_of(count) << offset
        written = (self.written & selected) >> offset
        if written == mask_of(count):
            return bytes(self.values[offset:offset + count])
        base = source._page(index)
        if not written:
            return base[offset:offset + count]
        result = bytearray(base[offset:offset + count])
        self._overlay(result, offset, written)
        return bytes(result)

    def load(self, source, index, offset, count):
        """Observe an integer without touching storage hidden by byte SSA."""
        selected = mask_of(count) << offset
        written = (self.written & selected) >> offset
        if written == mask_of(count):
            return (int.from_bytes(self.values[offset:offset + count],
                                   'little'), 0)
        base = source._page(index)
        if not written:
            return int.from_bytes(base[offset:offset + count], 'little'), count
        result = bytearray(base[offset:offset + count])
        self._overlay(result, offset, written)
        missing = count - ((self.written & selected) >> offset).bit_count()
        return int.from_bytes(result, 'little'), missing

    def materialize(self, source, index):
        """Seal final coordinates, reading storage only for uncovered bytes."""
        if self.written == mask_of(MEMORY_PAGE):
            return bytes(self.values)
        result = bytearray(source._page(index))
        self._overlay(result, 0, self.written)
        return bytes(result)

    @property
    def segments(self):
        return sum(1 for _run in self._runs(self.written))


class MemoryCut(object):
    """Direct-coordinate byte SSA shared by Wasm and future machine frontends."""

    __slots__ = ('source', '_regions', 'dirty', 'loads', 'stores',
                 'load_bytes', 'store_bytes', 'overwritten_bytes',
                 'forwarded_loads',
                 'source_loads', 'merged_loads', 'source_bytes_loaded',
                 '_last_index', '_last_patch')

    def __init__(self, source):
        self.source = source
        self._regions = [None] * len(source._regions)
        self.dirty = []
        self.loads = 0
        self.load_bytes = 0
        self.stores = 0
        self.store_bytes = 0
        self.overwritten_bytes = 0
        self.forwarded_loads = 0
        self.source_loads = 0
        self.merged_loads = 0
        self.source_bytes_loaded = 0
        self._last_index = -1
        self._last_patch = None

    def __len__(self):
        return len(self.source)

    def _patch(self, index, create=False, dirty=False):
        if index == self._last_index:
            patch = self._last_patch
            if patch is not None or not create:
                if dirty and patch is not None and not patch.written:
                    self.dirty.append(index)
                return patch
        span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
        region_index, span_slot = divmod(span_index, MEMORY_REGION_SPANS)
        region = self._regions[region_index]
        if region is None:
            if not create:
                return None
            region = [None] * MEMORY_REGION_SPANS
            self._regions[region_index] = region
        span = region[span_slot]
        if span is None:
            if not create:
                return None
            span = [None] * MEMORY_SPAN_PAGES
            region[span_slot] = span
        patch = span[slot]
        if patch is None and create:
            patch = BytePage()
            span[slot] = patch
        if dirty and patch is not None and not patch.written:
            self.dirty.append(index)
        self._last_index = index
        self._last_patch = patch
        return patch

    def read(self, address, size):
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory access is out of bounds')
        self.loads += 1
        self.load_bytes += size
        if not size:
            return b''
        index, offset = divmod(address, MEMORY_PAGE)
        if offset + size <= MEMORY_PAGE:
            patch = self._patch(index)
            if patch is None:
                self.source_bytes_loaded += size
                return self.source._page(index)[offset:offset + size]
            raw = patch.read(self.source, index, offset, size)
            written = ((patch.written >> offset) & mask_of(size)).bit_count()
            self.source_bytes_loaded += size - written
            return raw
        chunks = []
        end = address + size
        while address < end:
            index, offset = divmod(address, MEMORY_PAGE)
            count = min(end - address, MEMORY_PAGE - offset)
            patch = self._patch(index)
            if patch is None:
                chunks.append(self.source._page(index)[offset:offset + count])
                self.source_bytes_loaded += count
            else:
                chunks.append(patch.read(self.source, index, offset, count))
                written = ((patch.written >> offset)
                           & mask_of(count)).bit_count()
                self.source_bytes_loaded += count - written
            address += count
        return b''.join(chunks)

    def load(self, address, size):
        """Return one unsigned integer from the current byte coordinates."""
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory access is out of bounds')
        index, offset = divmod(address, MEMORY_PAGE)
        if offset + size > MEMORY_PAGE:
            return int.from_bytes(self.read(address, size), 'little')
        self.loads += 1
        self.load_bytes += size
        patch = self._patch(index)
        if patch is None:
            self.source_loads += 1
            self.source_bytes_loaded += size
            return int.from_bytes(
                self.source._page(index)[offset:offset + size], 'little')
        value, missing = patch.load(self.source, index, offset, size)
        self.source_bytes_loaded += missing
        if not missing:
            self.forwarded_loads += 1
        elif missing == size:
            self.source_loads += 1
        else:
            self.merged_loads += 1
        return value

    def write(self, address, payload):
        payload = bytes(payload)
        if address < 0 or address + len(payload) > len(self.source):
            raise WasmStateError('machine memory access is out of bounds')
        if not payload:
            return self
        self.stores += 1
        self.store_bytes += len(payload)
        index, offset = divmod(address, MEMORY_PAGE)
        if offset + len(payload) <= MEMORY_PAGE:
            patch = self._patch(index, create=True, dirty=True)
            self.overwritten_bytes += patch.write(offset, payload)
            return self
        at = 0
        while at < len(payload):
            absolute = address + at
            index, offset = divmod(absolute, MEMORY_PAGE)
            count = min(len(payload) - at, MEMORY_PAGE - offset)
            patch = self._patch(index, create=True, dirty=True)
            self.overwritten_bytes += patch.write(
                offset, payload[at:at + count])
            at += count
        return self

    def commit(self):
        if not self.dirty:
            return self.source
        return self.source.replace_pages(
            (index, self._patch(index).materialize(self.source, index))
            for index in self.dirty)

    @property
    def final_store_bytes(self):
        return sum(self._patch(index).written.bit_count()
                   for index in self.dirty)

    @property
    def store_segments(self):
        return sum(self._patch(index).segments for index in self.dirty)
