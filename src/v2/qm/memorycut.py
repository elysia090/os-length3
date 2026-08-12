"""Frontend-independent byte SSA between observable machine-state cuts.

A page carries two physical arrays: the final value of each byte coordinate
and a 256-bit domain mask saying which coordinates have a newer SSA version.
Loads select the newest coordinate directly.  Storage hidden by that mask is
not read, and complete pages are materialized only when the surrounding
machine reaches a persistent cut.
"""

from .bits import mask_of
from .wasmstate import (MEMORY_PAGE, MEMORY_REGION_SPANS, MEMORY_SPAN_PAGES,
                        CanonicalPage, WasmStateError)


class BytePage(object):
    """Final byte coordinates for one physical page before a persistent cut."""

    __slots__ = ('values', 'written', 'revision')

    def __init__(self):
        self.values = bytearray(MEMORY_PAGE)
        self.written = 0
        self.revision = 0

    def write(self, offset, payload):
        if not isinstance(self.values, bytearray):
            self.values = bytearray(self.values)
        count = len(payload)
        selected = mask_of(count) << offset
        overwritten = (self.written & selected).bit_count()
        self.values[offset:offset + count] = payload
        self.written |= selected
        self.revision += 1
        return overwritten

    def alias(self, page):
        """Publish one already-canonical complete physical page by reference."""
        page = bytes(page)
        if len(page) != MEMORY_PAGE:
            raise ValueError('aliased memory page has the wrong size')
        overwritten = self.written.bit_count()
        self.values = page
        self.written = mask_of(MEMORY_PAGE)
        self.revision += 1
        return overwritten

    def fork(self):
        """Copy one page only when a newer cut first writes it."""
        page = BytePage()
        page.values = (bytearray(self.values)
                       if isinstance(self.values, bytearray)
                       else self.values)
        page.written = self.written
        page.revision = self.revision
        return page

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
        if not written:
            return source._page_slice(index, offset, count)
        result = bytearray(count)
        missing = mask_of(count) ^ written
        for start, end in self._runs(missing):
            result[start:end] = source._page_slice(
                index, offset + start, end - start)
        self._overlay(result, offset, written)
        return bytes(result)

    def load(self, source, index, offset, count):
        """Observe an integer without touching storage hidden by byte SSA."""
        selected = mask_of(count) << offset
        written = (self.written & selected) >> offset
        if written == mask_of(count):
            return (int.from_bytes(self.values[offset:offset + count],
                                   'little'), 0)
        if not written:
            base = source._page_slice(index, offset, count)
            return int.from_bytes(base, 'little'), count
        result = bytearray(count)
        missing_bits = mask_of(count) ^ written
        for start, end in self._runs(missing_bits):
            result[start:end] = source._page_slice(
                index, offset + start, end - start)
        self._overlay(result, offset, written)
        missing = missing_bits.bit_count()
        return int.from_bytes(result, 'little'), missing

    def find(self, source, index, offset, count, values):
        """Return ``(coordinate, source bytes observed)`` inside one page."""
        end = offset + count
        written_found = []
        for value in values:
            coordinate = self.values.find(bytes((value,)), offset, end)
            while coordinate >= 0 and not self.written & (1 << coordinate):
                coordinate = self.values.find(
                    bytes((value,)), coordinate + 1, end)
            if coordinate >= 0:
                written_found.append(coordinate)
        written_stop = min(written_found) if written_found else None
        source_end = end if written_stop is None else written_stop + 1
        source_stop = source._page_find(
            index, offset, source_end - offset, values)
        while (source_stop is not None
               and self.written & (1 << source_stop)):
            next_offset = source_stop + 1
            if next_offset >= source_end:
                source_stop = None
                break
            source_stop = source._page_find(
                index, next_offset, source_end - next_offset, values)
        stops = [coordinate for coordinate in (written_stop, source_stop)
                 if coordinate is not None]
        found = min(stops) if stops else None
        examined = count if found is None else found - offset + 1
        selected = mask_of(examined) << offset
        missing = examined - (self.written & selected).bit_count()
        return found, missing

    def find_not(self, source, index, offset, count, value):
        """Return the first coordinate unequal to one byte value."""
        end = offset + count
        written_stop = next((
            coordinate for coordinate in range(offset, end)
            if self.written & (1 << coordinate)
            and self.values[coordinate] != value), None)
        source_end = end if written_stop is None else written_stop + 1
        source_stop = source._page_find_not(
            index, offset, source_end - offset, value)
        while (source_stop is not None
               and self.written & (1 << source_stop)):
            next_offset = source_stop + 1
            if next_offset >= source_end:
                source_stop = None
                break
            source_stop = source._page_find_not(
                index, next_offset, source_end - next_offset, value)
        stops = [coordinate for coordinate in (written_stop, source_stop)
                 if coordinate is not None]
        found = min(stops) if stops else None
        examined = count if found is None else found - offset + 1
        selected = mask_of(examined) << offset
        missing = examined - (self.written & selected).bit_count()
        return found, missing

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
                 'aliased_pages', 'elided_pages',
                 '_last_index', '_last_patch', '_page_changes',
                 '_proof_tokens', '_sealed', '_owned_regions',
                 '_owned_spans', '_owned_patches')

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
        self.aliased_pages = 0
        self.elided_pages = 0
        self._last_index = -1
        self._last_patch = None
        self._page_changes = []
        self._proof_tokens = {}
        self._sealed = False
        self._owned_regions = set()
        self._owned_spans = set()
        self._owned_patches = set()

    def __len__(self):
        return len(self.source)

    @property
    def sealed(self):
        return self._sealed

    def seal(self):
        """Freeze this generation without resolving untouched coordinates.

        Only the directory nodes owned by this generation are converted to
        immutable tuples.  Byte pages then remain valid structural proofs for
        an observable machine state; no page is compared with or copied from
        the backing memory.
        """
        if self._sealed:
            return self
        for region_index, span_slot in self._owned_spans:
            region = self._regions[region_index]
            region[span_slot] = tuple(region[span_slot])
        for region_index in self._owned_regions:
            self._regions[region_index] = tuple(self._regions[region_index])
        self._regions = tuple(self._regions)
        if isinstance(self.dirty, list):
            self.dirty = tuple(self.dirty)
        self._sealed = True
        self._last_index = -1
        self._last_patch = None
        return self

    def fork(self):
        """Open a writable SSA generation over this sealed physical root.

        Region, span, page, and dirty-coordinate arrays are shared.  A later
        store copies only its region path and selected BytePage, so an event
        boundary does not materialize RAM or add a second memory route.
        """
        self.seal()
        cut = MemoryCut(self.source)
        cut._regions = list(self._regions)
        cut.dirty = self.dirty
        return cut

    def _append_dirty(self, index):
        if not isinstance(self.dirty, list):
            self.dirty = list(self.dirty)
        self.dirty.append(index)

    def _patch(self, index, create=False, dirty=False):
        if dirty and self._sealed:
            raise WasmStateError('sealed memory cut cannot be written')
        if index == self._last_index:
            patch = self._last_patch
            if (patch is not None or not create) and (
                    not dirty or index in self._owned_patches):
                if dirty and patch is not None and not patch.written:
                    self._append_dirty(index)
                return patch
        span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
        region_index, span_slot = divmod(span_index, MEMORY_REGION_SPANS)
        region = self._regions[region_index]
        if region is None:
            if not create:
                return None
            region = [None] * MEMORY_REGION_SPANS
            self._regions[region_index] = region
            self._owned_regions.add(region_index)
        elif create and region_index not in self._owned_regions:
            region = list(region)
            self._regions[region_index] = region
            self._owned_regions.add(region_index)
        span = region[span_slot]
        if span is None:
            if not create:
                return None
            span = [None] * MEMORY_SPAN_PAGES
            region[span_slot] = span
            self._owned_spans.add((region_index, span_slot))
        elif create and (region_index, span_slot) not in self._owned_spans:
            span = list(span)
            region[span_slot] = span
            self._owned_spans.add((region_index, span_slot))
        patch = span[slot]
        if patch is None and create:
            patch = BytePage()
            span[slot] = patch
            self._owned_patches.add(index)
        elif dirty and index not in self._owned_patches:
            patch = patch.fork()
            span[slot] = patch
            self._owned_patches.add(index)
        if dirty and patch is not None and not patch.written:
            self._append_dirty(index)
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
                return self.source._page_slice(index, offset, size)
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
                chunks.append(self.source._page_slice(index, offset, count))
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
                self.source._page_slice(index, offset, size), 'little')
        value, missing = patch.load(self.source, index, offset, size)
        self.source_bytes_loaded += missing
        if not missing:
            self.forwarded_loads += 1
        elif missing == size:
            self.source_loads += 1
        else:
            self.merged_loads += 1
        return value

    def find(self, address, size, values):
        """Find one of several bytes and observe no coordinate after it."""
        address, size = int(address), int(size)
        values = tuple(sorted(set(int(value) for value in values)))
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory find is out of bounds')
        if not values or values[0] < 0 or values[-1] > 255:
            raise ValueError('memory find values must be bytes')
        if not size:
            return None
        start = address
        end = address + size
        while address < end:
            index, offset = divmod(address, MEMORY_PAGE)
            count = min(end - address, MEMORY_PAGE - offset)
            patch = self._patch(index)
            if patch is None:
                found = self.source._page_find(
                    index, offset, count, values)
                examined = count if found is None else found - offset + 1
                missing = examined
            else:
                found, missing = patch.find(
                    self.source, index, offset, count, values)
                examined = count if found is None else found - offset + 1
            self.loads += 1
            self.load_bytes += examined
            self.source_bytes_loaded += missing
            if not missing:
                self.forwarded_loads += 1
            elif missing == examined:
                self.source_loads += 1
            else:
                self.merged_loads += 1
            if found is not None:
                return address - start + found - offset
            address += count
        return None

    def find_not(self, address, size, value):
        """Find the first byte unequal to ``value`` without reading its tail."""
        address, size, value = int(address), int(size), int(value)
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory find is out of bounds')
        if not 0 <= value <= 255:
            raise ValueError('memory complement value must be a byte')
        if not size:
            return None
        start = address
        end = address + size
        while address < end:
            index, offset = divmod(address, MEMORY_PAGE)
            count = min(end - address, MEMORY_PAGE - offset)
            patch = self._patch(index)
            if patch is None:
                found = self.source._page_find_not(
                    index, offset, count, value)
                examined = count if found is None else found - offset + 1
                missing = examined
            else:
                found, missing = patch.find_not(
                    self.source, index, offset, count, value)
                examined = count if found is None else found - offset + 1
            self.loads += 1
            self.load_bytes += examined
            self.source_bytes_loaded += missing
            if not missing:
                self.forwarded_loads += 1
            elif missing == examined:
                self.source_loads += 1
            else:
                self.merged_loads += 1
            if found is not None:
                return address - start + found - offset
            address += count
        return None

    def proof_token(self, index, offset=0, count=MEMORY_PAGE):
        """Return the source-page proof when this cut did not touch a range."""
        index, offset, count = int(index), int(offset), int(count)
        if offset < 0 or count < 0 or offset + count > MEMORY_PAGE:
            raise WasmStateError('memory proof extent is out of bounds')
        key = offset, count
        page_tokens = self._proof_tokens.get(index)
        if page_tokens is not None and key in page_tokens:
            return page_tokens[key]
        patch = self._patch(index)
        selected = mask_of(count) << offset
        if patch is not None and patch.written & selected:
            token = patch, patch.revision
        else:
            token = self.source.proof_token(index, offset, count)
        if page_tokens is None:
            page_tokens = self._proof_tokens[index] = {}
        page_tokens[key] = token
        return token

    def _changed(self, index):
        """Invalidate direct proof entries for one newly written page."""
        self._proof_tokens.pop(index, None)
        self._page_changes.append(index)

    def changed_pages_since(self, revision):
        """Return page writes after a direct cache revision."""
        revision = int(revision)
        current = len(self._page_changes)
        if revision < 0 or revision > current:
            raise ValueError('memory cut revision is out of range')
        return current, iter(self._page_changes[revision:current])

    @property
    def change_revision(self):
        return len(self._page_changes)

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
            self._changed(index)
            return self
        at = 0
        while at < len(payload):
            absolute = address + at
            index, offset = divmod(absolute, MEMORY_PAGE)
            count = min(len(payload) - at, MEMORY_PAGE - offset)
            patch = self._patch(index, create=True, dirty=True)
            self.overwritten_bytes += patch.write(
                offset, payload[at:at + count])
            self._changed(index)
            at += count
        return self

    def increment_bytes(self, increments):
        """Add byte deltas through one direct-coordinate SSA projection.

        Repeated affine walks often revisit a small byte domain.  Combining
        those visits before this operation avoids returning to scalar loads
        and stores after the walk has already been normalized.  Only touched
        source coordinates are observed, and each affected physical page
        receives one new proof revision.
        """
        combined = {}
        for address, delta in increments:
            address = int(address)
            if address < 0 or address >= len(self.source):
                raise WasmStateError(
                    'machine byte increment is out of bounds')
            combined[address] = (
                combined.get(address, 0) + int(delta)) & 0xff
        combined = {address: delta for address, delta in combined.items()
                    if delta}
        if not combined:
            return self

        pages = {}
        for address, delta in combined.items():
            index, offset = divmod(address, MEMORY_PAGE)
            pages.setdefault(index, []).append((offset, delta))
        for index, entries in pages.items():
            patch = self._patch(index, create=True, dirty=True)
            if not isinstance(patch.values, bytearray):
                patch.values = bytearray(patch.values)
            selected = 0
            source_bytes = 0
            forwarded = 0
            for offset, delta in entries:
                bit = 1 << offset
                if patch.written & bit:
                    value = patch.values[offset]
                    forwarded += 1
                else:
                    value = self.source._page_slice(index, offset, 1)[0]
                    source_bytes += 1
                patch.values[offset] = (value + delta) & 0xff
                selected |= bit
            self.overwritten_bytes += (patch.written & selected).bit_count()
            patch.written |= selected
            patch.revision += 1
            self._changed(index)
            self.forwarded_loads += forwarded
            self.source_loads += source_bytes
            self.source_bytes_loaded += source_bytes
        coordinates = len(combined)
        self.loads += coordinates
        self.load_bytes += coordinates
        self.stores += coordinates
        self.store_bytes += coordinates
        return self

    def project_records(self, records, lanes):
        """Project selected word lanes without materializing whole records.

        ``records`` are direct physical base coordinates.  Each lane is
        ``(offset, width, and_mask, or_mask[, addend])`` and publishes
        ``((old & and_mask) | or_mask) + addend`` modulo the lane width.  A
        zero ``and_mask`` is a constant store and therefore never observes
        its old coordinate.  All lanes on one physical page are joined into
        one byte-SSA revision.
        """
        records = tuple(int(address) for address in records)
        lanes = tuple(tuple(int(value) for value in lane) for lane in lanes)
        if not records or not lanes:
            return self
        if any(len(lane) not in (4, 5) for lane in lanes):
            raise ValueError(
                'record projection lanes must have four or five fields')

        normalized = []
        occupied = 0
        for lane in lanes:
            offset, width, and_mask, or_mask = lane[:4]
            addend = 0 if len(lane) == 4 else lane[4]
            if offset < 0 or width <= 0:
                raise ValueError('record projection lane is invalid')
            bits = width * 8
            mask = (1 << bits) - 1
            if (and_mask < 0 or or_mask < 0 or addend < 0
                    or and_mask & ~mask or or_mask & ~mask
                    or addend & ~mask):
                raise ValueError('record projection mask exceeds its lane')
            selected = mask_of(width) << offset
            if occupied & selected:
                raise ValueError('record projection lanes overlap')
            occupied |= selected
            normalized.append(
                (offset, width, and_mask, or_mask, addend, mask))

        pages = {}
        for record in records:
            if record < 0:
                raise WasmStateError(
                    'record projection coordinate is out of bounds')
            for offset, width, and_mask, or_mask, addend, mask in normalized:
                address = record + offset
                if address + width > len(self.source):
                    raise WasmStateError(
                        'record projection coordinate is out of bounds')
                index, page_offset = divmod(address, MEMORY_PAGE)
                if page_offset + width > MEMORY_PAGE:
                    raise WasmStateError(
                        'record projection lane crosses a physical page')
                pages.setdefault(index, []).append(
                    (page_offset, width, and_mask, or_mask, addend, mask))

        total_loads = 0
        total_load_bytes = 0
        total_stores = 0
        total_store_bytes = 0
        for index, entries in pages.items():
            patch = self._patch(index, create=True, dirty=True)
            if not isinstance(patch.values, bytearray):
                patch.values = bytearray(patch.values)
            selected = 0
            page_loads = 0
            page_load_bytes = 0
            page_source_bytes = 0
            page_forwarded = 0
            page_merged = 0
            for offset, width, and_mask, or_mask, addend, mask in entries:
                lane_bits = mask_of(width) << offset
                if selected & lane_bits:
                    raise ValueError(
                        'record projection coordinates overlap')
                selected |= lane_bits
                if and_mask:
                    old, missing = patch.load(
                        self.source, index, offset, width)
                    page_loads += 1
                    page_load_bytes += width
                    page_source_bytes += missing
                    if not missing:
                        page_forwarded += 1
                    elif missing != width:
                        page_merged += 1
                    value = (((old & and_mask) | or_mask) + addend) & mask
                else:
                    value = (or_mask + addend) & mask
                patch.values[offset:offset + width] = value.to_bytes(
                    width, 'little')
                total_stores += 1
                total_store_bytes += width
            self.overwritten_bytes += (patch.written & selected).bit_count()
            patch.written |= selected
            patch.revision += 1
            self._changed(index)
            total_loads += page_loads
            total_load_bytes += page_load_bytes
            self.source_bytes_loaded += page_source_bytes
            self.forwarded_loads += page_forwarded
            self.source_loads += page_loads - page_forwarded - page_merged
            self.merged_loads += page_merged
        self.loads += total_loads
        self.load_bytes += total_load_bytes
        self.stores += total_stores
        self.store_bytes += total_store_bytes
        return self

    def multiply_records(self, records, offset, width, multiplier):
        """Multiply one fixed-width lane across direct physical records.

        The record directory is already the physical SSA domain.  Loads and
        final stores are therefore joined page-by-page; no record payload or
        complete page is materialized between the two operations.
        """
        records = tuple(int(address) for address in records)
        offset, width, multiplier = (
            int(offset), int(width), int(multiplier))
        if offset < 0 or width <= 0:
            raise ValueError('record multiply lane is invalid')
        if not records:
            return self
        mask = mask_of(width * 8)
        multiplier &= mask
        pages = {}
        for record in records:
            address = record + offset
            if record < 0 or address + width > len(self.source):
                raise WasmStateError(
                    'record multiply coordinate is out of bounds')
            index, page_offset = divmod(address, MEMORY_PAGE)
            if page_offset + width > MEMORY_PAGE:
                raise WasmStateError(
                    'record multiply lane crosses a physical page')
            pages.setdefault(index, []).append(page_offset)

        for index, offsets in pages.items():
            patch = self._patch(index, create=True, dirty=True)
            if not isinstance(patch.values, bytearray):
                patch.values = bytearray(patch.values)
            selected = 0
            source_bytes = 0
            forwarded = 0
            merged = 0
            for page_offset in offsets:
                lane = mask_of(width) << page_offset
                if selected & lane:
                    raise ValueError(
                        'record multiply coordinates overlap')
                selected |= lane
                value, missing = patch.load(
                    self.source, index, page_offset, width)
                source_bytes += missing
                if not missing:
                    forwarded += 1
                elif missing != width:
                    merged += 1
                product = (value * multiplier) & mask
                patch.values[page_offset:page_offset + width] = \
                    product.to_bytes(width, 'little')
            self.overwritten_bytes += (patch.written & selected).bit_count()
            patch.written |= selected
            patch.revision += 1
            self._changed(index)
            self.source_bytes_loaded += source_bytes
            self.forwarded_loads += forwarded
            self.source_loads += len(offsets) - forwarded - merged
            self.merged_loads += merged
        coordinates = len(records)
        self.loads += coordinates
        self.load_bytes += coordinates * width
        self.stores += coordinates
        self.store_bytes += coordinates * width
        return self

    def store_record_values(self, records, offset, width, values):
        """Publish one computed value per physical record lane."""
        records = tuple(int(address) for address in records)
        values = tuple(int(value) for value in values)
        offset, width = int(offset), int(width)
        if offset < 0 or width <= 0:
            raise ValueError('record value lane is invalid')
        if len(records) != len(values):
            raise ValueError('record coordinates and values disagree')
        if not records:
            return self
        mask = mask_of(width * 8)
        pages = {}
        for record, value in zip(records, values):
            address = record + offset
            if record < 0 or address + width > len(self.source):
                raise WasmStateError(
                    'record value coordinate is out of bounds')
            index, page_offset = divmod(address, MEMORY_PAGE)
            if page_offset + width > MEMORY_PAGE:
                raise WasmStateError(
                    'record value lane crosses a physical page')
            pages.setdefault(index, []).append((page_offset, value & mask))

        for index, entries in pages.items():
            patch = self._patch(index, create=True, dirty=True)
            if not isinstance(patch.values, bytearray):
                patch.values = bytearray(patch.values)
            selected = 0
            for page_offset, value in entries:
                lane = mask_of(width) << page_offset
                if selected & lane:
                    raise ValueError('record value coordinates overlap')
                selected |= lane
                patch.values[page_offset:page_offset + width] = \
                    value.to_bytes(width, 'little')
            self.overwritten_bytes += (patch.written & selected).bit_count()
            patch.written |= selected
            patch.revision += 1
            self._changed(index)
        coordinates = len(records)
        self.stores += coordinates
        self.store_bytes += coordinates * width
        return self

    def matching_record_prefix(self, records, predicates):
        """Return the leading records satisfying selected word predicates.

        ``records`` are direct physical base coordinates.  Predicates are
        ``(offset, width, and_mask, expected, equal)`` tuples.  Only the
        named lanes are observed; an ``equal`` value of false excludes the
        masked value.  This is the read-side dual of :meth:`project_records`
        and keeps record validation in the same direct-coordinate byte SSA.
        """
        records = tuple(int(address) for address in records)
        predicates = tuple(
            tuple(predicate) for predicate in predicates)
        normalized = []
        for predicate in predicates:
            if len(predicate) != 5:
                raise ValueError(
                    'record predicate must have five fields')
            offset, width, and_mask, expected, equal = predicate
            offset, width = int(offset), int(width)
            and_mask, expected = int(and_mask), int(expected)
            if offset < 0 or width <= 0:
                raise ValueError('record predicate lane is invalid')
            mask = mask_of(width * 8)
            if (and_mask < 0 or expected < 0
                    or and_mask & ~mask or expected & ~mask):
                raise ValueError(
                    'record predicate mask exceeds its lane')
            normalized.append(
                (offset, width, and_mask, expected, bool(equal)))

        for index, record in enumerate(records):
            if record < 0:
                raise WasmStateError(
                    'record predicate coordinate is out of bounds')
            for offset, width, and_mask, expected, equal in normalized:
                value = self.load(record + offset, width) & and_mask
                if (value == expected) != equal:
                    return index
        return len(records)

    def copy(self, source_address, target_address, size):
        """Copy bytes, retaining complete aligned physical pages by reference."""
        source_address = int(source_address)
        target_address = int(target_address)
        size = int(size)
        if (min(source_address, target_address, size) < 0
                or source_address + size > len(self.source)
                or target_address + size > len(self.source)):
            raise WasmStateError('machine memory copy is out of bounds')
        if not size or source_address == target_address:
            return self
        if source_address % MEMORY_PAGE != target_address % MEMORY_PAGE:
            return self.write(target_address,
                              self.read(source_address, size))

        head = (-target_address) % MEMORY_PAGE
        head = min(head, size)
        if head:
            self.write(target_address,
                       self.read(source_address, head))
            source_address += head
            target_address += head
            size -= head

        pages = size // MEMORY_PAGE
        if pages:
            source_index = source_address // MEMORY_PAGE
            retained = []
            for offset in range(pages):
                index = source_index + offset
                patch = self._patch(index)
                if patch is None:
                    page = self.source._page(index)
                elif patch.written == mask_of(MEMORY_PAGE):
                    page = bytes(patch.values)
                else:
                    page = patch.materialize(self.source, index)
                retained.append(page)
            target_index = target_address // MEMORY_PAGE
            for offset, page in enumerate(retained):
                index = target_index + offset
                patch = self._patch(
                    index, create=True, dirty=True)
                self.overwritten_bytes += patch.alias(page)
                self._changed(index)
            copied = pages * MEMORY_PAGE
            self.stores += 1
            self.store_bytes += copied
            self.aliased_pages += pages
            source_address += copied
            target_address += copied
            size -= copied

        if size:
            self.write(target_address,
                       self.read(source_address, size))
        return self

    def fill(self, address, size, value=0):
        """Fill a byte range, skipping canonical pages already at that value."""
        address = int(address)
        size = int(size)
        value = int(value)
        if value < 0 or value > 255:
            raise ValueError('memory fill byte is outside 0..255')
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory fill is out of bounds')
        if not size:
            return self
        page_value = bytes((value,)) * MEMORY_PAGE
        head = min((-address) % MEMORY_PAGE, size)
        if head:
            self.write(address, bytes((value,)) * head)
            address += head
            size -= head
        pages = size // MEMORY_PAGE
        for offset in range(pages):
            index = address // MEMORY_PAGE + offset
            patch = self._patch(index)
            current = (self.source._page(index) if patch is None
                       else patch.materialize(self.source, index))
            if current == page_value:
                self.elided_pages += 1
                continue
            patch = self._patch(index, create=True, dirty=True)
            self.overwritten_bytes += patch.alias(page_value)
            self._changed(index)
            self.aliased_pages += 1
        if pages:
            filled = pages * MEMORY_PAGE
            self.stores += 1
            self.store_bytes += filled
            address += filled
            size -= filled
        if size:
            self.write(address, bytes((value,)) * size)
        return self

    def repeat(self, address, size, pattern):
        """Repeat one small physical pattern without scalar materialization."""
        address = int(address)
        size = int(size)
        pattern = bytes(pattern)
        if not pattern:
            raise ValueError('memory repeat pattern cannot be empty')
        if address < 0 or size < 0 or address + size > len(self.source):
            raise WasmStateError('machine memory repeat is out of bounds')
        if not size:
            return self
        if len(pattern) == 1:
            return self.fill(address, size, pattern[0])

        def payload(phase, count):
            repeats = (phase + count + len(pattern) - 1) // len(pattern)
            return (pattern * repeats)[phase:phase + count]

        consumed = 0
        head = min((-address) % MEMORY_PAGE, size)
        if head:
            self.write(address, payload(0, head))
            address += head
            size -= head
            consumed += head
        pages = size // MEMORY_PAGE
        for offset in range(pages):
            phase = consumed % len(pattern)
            page_value = payload(phase, MEMORY_PAGE)
            index = address // MEMORY_PAGE + offset
            patch = self._patch(index)
            current = (self.source._page(index) if patch is None
                       else patch.materialize(self.source, index))
            if current == page_value:
                self.elided_pages += 1
            else:
                patch = self._patch(index, create=True, dirty=True)
                self.overwritten_bytes += patch.alias(page_value)
                self._changed(index)
                self.aliased_pages += 1
            consumed += MEMORY_PAGE
        if pages:
            repeated = pages * MEMORY_PAGE
            self.stores += 1
            self.store_bytes += repeated
            address += repeated
            size -= repeated
        if size:
            self.write(address, payload(consumed % len(pattern), size))
        return self

    def commit(self):
        if not self.dirty:
            return self.source

        def normalized(index):
            patch = self._patch(index)
            previous = self.source._page_entry(index)
            page = CanonicalPage.compose(
                lambda offset, count: self.source._base_page_slice(
                    index, offset, count),
                previous, patch.written, patch.values)
            return index, page

        return self.source.replace_canonical_pages(
            normalized(index) for index in self.dirty)

    @property
    def final_store_bytes(self):
        return sum(self._patch(index).written.bit_count()
                   for index in self.dirty)

    @property
    def materialized_pages(self):
        """Dirty pages whose final bytes are not a retained canonical page."""
        return sum(isinstance(self._patch(index).values, bytearray)
                   for index in self.dirty)

    @property
    def generation_pages(self):
        """Physical pages first written by the current cut generation."""
        return len(self._owned_patches)

    @property
    def generation_materialized_pages(self):
        return sum(isinstance(self._patch(index).values, bytearray)
                   for index in self._owned_patches)

    @property
    def store_segments(self):
        return sum(self._patch(index).segments for index in self.dirty)
