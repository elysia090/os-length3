"""Compile a wasm32 module to a clonable, pure machine-state transition.

The scalar wasm reader evaluates small flat functions.  This module has a
different job: retain the program counter, call frames, locals, globals and
linear memory so a whole compiled driver can be stopped at an imported input
call and resumed on each possible byte.  No C syntax is involved after Clang
has produced the module.

``instruction_step`` is the lightweight compiler's primitive:

    MachineState -> MachineState

``stream_step`` runs those pure steps to the next ``qm_getchar`` boundary.
The resulting ``state, byte -> state`` and ``observe(state)`` pair can be fed
to the exact finite-transducer quotient.  Unsupported instructions are named;
an incomplete decode is never used as program semantics.
"""

from dataclasses import dataclass, replace

from .bits import mask_of
from .cfront.errors import CFrontError, UnsupportedC


PAGE = 65536
MEMORY_PAGE = 256
MEMORY_SPAN_PAGES = 256
MEMORY_REGION_SPANS = 256
EOF = 256
I32 = mask_of(32)
I64 = mask_of(64)
VALTYPES = {0x7F: 'i32', 0x7E: 'i64', 0x7D: 'f32', 0x7C: 'f64',
            0x7B: 'v128', 0x70: 'funcref', 0x6F: 'externref'}


class WasmStateError(CFrontError):
    """A malformed module or an invalid machine transition."""


class PagedMemory(object):
    """Immutable linear memory with shared unchanged bytes.

    WebAssembly modules commonly reserve tens of MiB even when a transition
    writes only a handful of words.  Copying that reservation after every
    store changes the cost of the interpreter without changing its semantics.
    This value keeps the decoded module bytes as one shared base and records
    only complete 256-byte pages that differ from it. Changed pages live in a
    three-level direct array: eight page bits select a slot, eight more select
    a span, and the remaining bits select a region. A hot load therefore uses
    three indexes without hashing. Updating one page copies at most one fixed
    region and span rather than a directory proportional to logical memory.
    The base may be shorter than the logical memory; its absent tail is the
    implicit WebAssembly zero fill.
    """

    __slots__ = ('base', 'length', '_regions', '_hash')

    def __init__(self, base, length=None, pages=(), _regions=None):
        self.base = bytes(base)
        self.length = len(self.base) if length is None else int(length)
        if self.length < len(self.base):
            raise ValueError('linear memory cannot be shorter than its base')
        page_count = ((self.length + MEMORY_PAGE - 1) // MEMORY_PAGE)
        span_count = ((page_count + MEMORY_SPAN_PAGES - 1)
                      // MEMORY_SPAN_PAGES)
        region_count = ((span_count + MEMORY_REGION_SPANS - 1)
                        // MEMORY_REGION_SPANS)
        if _regions is None:
            regions = [None] * region_count
            mutable_regions = {}
            mutable_spans = {}
            for index, page in pages:
                index, page = int(index), bytes(page)
                if index < 0 or index >= page_count:
                    raise ValueError('changed memory page is outside memory')
                if len(page) != MEMORY_PAGE:
                    raise ValueError('changed memory page has the wrong size')
                span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
                region_index, span_slot = divmod(
                    span_index, MEMORY_REGION_SPANS)
                region = mutable_regions.get(region_index)
                if region is None:
                    region = [None] * MEMORY_REGION_SPANS
                    mutable_regions[region_index] = region
                key = (region_index, span_slot)
                span = mutable_spans.get(key)
                if span is None:
                    span = [None] * MEMORY_SPAN_PAGES
                    mutable_spans[key] = span
                span[slot] = page
            for (region_index, span_slot), span in mutable_spans.items():
                mutable_regions[region_index][span_slot] = tuple(span)
            for region_index, region in mutable_regions.items():
                regions[region_index] = tuple(region)
            self._regions = tuple(regions)
        else:
            regions = tuple(_regions)
            if len(regions) != region_count:
                raise ValueError('memory region directory has the wrong size')
            self._regions = regions
        self._hash = None

    @property
    def pages(self):
        """Changed pages as stable ``(index, bytes)`` pairs."""
        return tuple(
            (((region_index * MEMORY_REGION_SPANS + span_slot)
              * MEMORY_SPAN_PAGES + slot), page)
            for region_index, region in enumerate(self._regions)
            if region is not None
            for span_slot, span in enumerate(region)
            if span is not None
            for slot, page in enumerate(span)
            if page is not None
        )

    def __len__(self):
        return self.length

    def __eq__(self, other):
        return (isinstance(other, PagedMemory)
                and self.length == other.length
                and self._regions == other._regions
                and (self.base is other.base or self.base == other.base))

    def __hash__(self):
        value = self._hash
        if value is None:
            value = hash((self.base, self.length, self._regions))
            self._hash = value
        return value

    def _base_page(self, index):
        start = index * MEMORY_PAGE
        raw = self.base[start:start + MEMORY_PAGE]
        if len(raw) < MEMORY_PAGE:
            raw += bytes(MEMORY_PAGE - len(raw))
        return raw

    def read(self, address, size):
        if address < 0 or size < 0 or address + size > self.length:
            raise WasmStateError('wasm memory access is out of bounds')
        if not size:
            return b''
        out = bytearray()
        end = address + size
        while address < end:
            index, offset = divmod(address, MEMORY_PAGE)
            count = min(end - address, MEMORY_PAGE - offset)
            span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
            region_index, span_slot = divmod(span_index,
                                             MEMORY_REGION_SPANS)
            region = self._regions[region_index]
            span = None if region is None else region[span_slot]
            page = None if span is None else span[slot]
            if page is None:
                page = self._base_page(index)
            out.extend(page[offset:offset + count])
            address += count
        return bytes(out)

    def write(self, address, payload):
        payload = bytes(payload)
        if address < 0 or address + len(payload) > self.length:
            raise WasmStateError('wasm memory access is out of bounds')
        if not payload:
            return self
        regions = list(self._regions)
        changed_regions = {}
        changed_spans = {}
        at = 0
        while at < len(payload):
            absolute = address + at
            index, offset = divmod(absolute, MEMORY_PAGE)
            count = min(len(payload) - at, MEMORY_PAGE - offset)
            span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
            region_index, span_slot = divmod(span_index,
                                             MEMORY_REGION_SPANS)
            region = changed_regions.get(region_index)
            if region is None:
                old_region = regions[region_index]
                region = ([None] * MEMORY_REGION_SPANS
                          if old_region is None else list(old_region))
                changed_regions[region_index] = region
            key = (region_index, span_slot)
            span = changed_spans.get(key)
            if span is None:
                old_span = region[span_slot]
                span = ([None] * MEMORY_SPAN_PAGES if old_span is None
                        else list(old_span))
                changed_spans[key] = span
            current = span[slot]
            page = bytearray(self._base_page(index)
                             if current is None else current)
            page[offset:offset + count] = payload[at:at + count]
            page = bytes(page)
            if page == self._base_page(index):
                span[slot] = None
            else:
                span[slot] = page
            at += count
        for (region_index, span_slot), span in changed_spans.items():
            changed_regions[region_index][span_slot] = tuple(span) if any(
                page is not None for page in span) else None
        for region_index, region in changed_regions.items():
            regions[region_index] = tuple(region) if any(
                span is not None for span in region) else None
        return PagedMemory(self.base, self.length, _regions=tuple(regions))

    def grow(self, pages):
        if pages < 0:
            raise ValueError('page count must be nonnegative')
        if not pages:
            return self
        length = self.length + pages * PAGE
        page_count = ((length + MEMORY_PAGE - 1) // MEMORY_PAGE)
        span_count = ((page_count + MEMORY_SPAN_PAGES - 1)
                      // MEMORY_SPAN_PAGES)
        region_count = ((span_count + MEMORY_REGION_SPANS - 1)
                        // MEMORY_REGION_SPANS)
        regions = self._regions + (None,) * (
            region_count - len(self._regions))
        return PagedMemory(self.base, length, _regions=regions)

    def discard(self, address, length):
        """Drop complete changed pages and expose their backing bytes again.

        This is the sparse-memory equivalent of discarding a clean mmap
        range. Requiring physical-page alignment prevents a caller from
        accidentally erasing unrelated bytes that share an edge page.
        """
        address, length = int(address), int(length)
        if address < 0 or length < 0 or address + length > self.length:
            raise WasmStateError('discarded wasm memory range is out of bounds')
        if address % MEMORY_PAGE or length % MEMORY_PAGE:
            raise ValueError('discarded wasm memory range must be page aligned')
        if not length:
            return self
        regions = list(self._regions)
        changed_regions = {}
        changed_spans = {}
        first = address // MEMORY_PAGE
        last = (address + length) // MEMORY_PAGE
        for index in range(first, last):
            span_index, slot = divmod(index, MEMORY_SPAN_PAGES)
            region_index, span_slot = divmod(span_index,
                                             MEMORY_REGION_SPANS)
            region = changed_regions.get(region_index)
            if region is None:
                old_region = regions[region_index]
                if old_region is None:
                    continue
                region = list(old_region)
                changed_regions[region_index] = region
            key = (region_index, span_slot)
            span = changed_spans.get(key)
            if span is None:
                old_span = region[span_slot]
                if old_span is None:
                    continue
                span = list(old_span)
                changed_spans[key] = span
            span[slot] = None
        for (region_index, span_slot), span in changed_spans.items():
            changed_regions[region_index][span_slot] = tuple(span) if any(
                page is not None for page in span) else None
        for region_index, region in changed_regions.items():
            regions[region_index] = tuple(region) if any(
                span is not None for span in region) else None
        return PagedMemory(self.base, self.length, _regions=tuple(regions))


class _Reader(object):
    __slots__ = ('data', 'at', 'end')

    def __init__(self, data, start=0, end=None):
        self.data = memoryview(data)
        self.at = start
        self.end = len(self.data) if end is None else end

    def byte(self):
        if self.at >= self.end:
            raise WasmStateError('unexpected end of wasm binary')
        value = self.data[self.at]
        self.at += 1
        return int(value)

    def take(self, count):
        if count < 0 or self.at + count > self.end:
            raise WasmStateError('wasm field exceeds its section')
        value = bytes(self.data[self.at:self.at + count])
        self.at += count
        return value

    def uleb(self, bits=32):
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if value >= 1 << bits:
                    raise WasmStateError('unsigned LEB exceeds %d bits' % bits)
                return value
            shift += 7
            if shift >= bits + 7:
                raise WasmStateError('unterminated unsigned LEB')

    def sleb(self, bits=32):
        value = 0
        shift = 0
        while True:
            byte = self.byte()
            value |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                if shift < bits and byte & 0x40:
                    value |= -(1 << shift)
                return value
            if shift >= bits + 7:
                raise WasmStateError('unterminated signed LEB')

    def name(self):
        raw = self.take(self.uleb())
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            raise WasmStateError('wasm name is not UTF-8')

    def vector(self, read):
        return tuple(read() for _ in range(self.uleb()))

    def done(self):
        return self.at >= self.end


@dataclass(frozen=True)
class FunctionType:
    params: tuple
    results: tuple


@dataclass(frozen=True)
class Instruction:
    op: str
    args: tuple = ()


@dataclass(frozen=True)
class Function:
    type_index: int
    locals: tuple = ()
    code: tuple = ()
    imported: bool = False
    module: str = ''
    name: str = ''
    ends: tuple = ()
    elses: tuple = ()


class LazyFunction(object):
    """One defined body kept as byte coordinates until first execution.

    The module owns the shared input buffer.  A function carries only its
    ``(start, end)`` span and decodes its locals/control tables atomically on
    first observation.  Untouched functions therefore never become Python
    instruction objects.
    """

    __slots__ = ('type_index', 'imported', 'module', 'name', '_data',
                 '_start', '_end', '_decoded')

    def __init__(self, type_index, data, start, end):
        self.type_index = int(type_index)
        self.imported = False
        self.module = ''
        self.name = ''
        self._data = data
        self._start = int(start)
        self._end = int(end)
        self._decoded = None

    def _open(self):
        decoded = self._decoded
        if decoded is None:
            body = _Reader(self._data, self._start, self._end)
            locals_ = []
            for _ in range(body.uleb()):
                count, kind = body.uleb(), _valtype(body)
                if count > 1 << 20:
                    raise WasmStateError(
                        'wasm function declares too many locals')
                locals_.extend([kind] * count)
            code, ends, elses = _decode_code(body)
            decoded = (tuple(locals_), code, ends, elses)
            self._decoded = decoded
        return decoded

    @property
    def locals(self):
        return self._open()[0]

    @property
    def code(self):
        return self._open()[1]

    @property
    def ends(self):
        return self._open()[2]

    @property
    def elses(self):
        return self._open()[3]

    @property
    def decoded(self):
        return self._decoded is not None

    @property
    def encoded_size(self):
        return self._end - self._start

    @property
    def decoded_instructions(self):
        return 0 if self._decoded is None else len(self._decoded[1])


@dataclass(frozen=True)
class Module:
    types: tuple
    functions: tuple
    globals: tuple
    global_mutable: tuple
    memory: PagedMemory
    memory_max: object
    exports: tuple
    start: object = None
    tables: tuple = ()
    indirect_abi: str = 'strict'

    def export(self, name):
        for exported, kind, index in self.exports:
            if exported == name and kind == 0:
                return index
        available = [entry[0] for entry in self.exports if entry[1] == 0]
        raise WasmStateError('wasm function %r is not exported' % name,
                             hint='function exports: %s' %
                                  (', '.join(available) or 'none'))

    def code_layout(self):
        """Report byte spans versus bodies actually materialized so far."""
        defined = [function for function in self.functions
                   if isinstance(function, LazyFunction)]
        decoded = [function for function in defined if function.decoded]
        return {
            'defined_functions': len(defined),
            'encoded_body_bytes': sum(function.encoded_size
                                      for function in defined),
            'decoded_functions': len(decoded),
            'decoded_body_bytes': sum(function.encoded_size
                                      for function in decoded),
            'decoded_instructions': sum(function.decoded_instructions
                                        for function in decoded),
        }


def decode_module(data, imports=None, indirect_abi='strict'):
    """Decode and instantiate the integer/control/memory core of a module.

    Function imports remain resumable host barriers. Imported memories,
    tables, and globals are accepted only when ``imports`` supplies an
    explicit deterministic snapshot keyed by ``(module, name)``.
    """
    imports = {} if imports is None else imports
    if indirect_abi not in ('strict', 'c-extra-args'):
        raise ValueError('unknown indirect call ABI %r' % indirect_abi)

    def resource(module, name, kind):
        identity = (module, name)
        try:
            return imports[identity]
        except KeyError:
            raise UnsupportedC(
                'imported wasm %s %s.%s needs an explicit deterministic '
                'host snapshot' % (kind, module, name))

    reader = _Reader(data)
    if reader.take(4) != b'\x00asm' or reader.take(4) != b'\x01\x00\x00\x00':
        raise WasmStateError('input is not a WebAssembly 1.0 binary')

    types = []
    imported = []
    defined_types = []
    bodies = []
    globals_ = []
    exports = []
    memories = []
    table_limits = []
    element_segments = []
    data_segments = []
    start = None

    while not reader.done():
        section_id = reader.byte()
        size = reader.uleb()
        section = _Reader(reader.data, reader.at, reader.at + size)
        reader.at += size
        if section_id == 0:
            continue
        if section_id == 1:
            for _ in range(section.uleb()):
                if section.byte() != 0x60:
                    raise UnsupportedC('non-function wasm type is not modelled')
                params = section.vector(lambda: _valtype(section))
                results = section.vector(lambda: _valtype(section))
                types.append(FunctionType(params, results))
        elif section_id == 2:
            for _ in range(section.uleb()):
                mod, name, kind = section.name(), section.name(), section.byte()
                if kind == 0:
                    imported.append(Function(section.uleb(), imported=True,
                                             module=mod, name=name))
                elif kind == 1:
                    minimum, maximum = _table_type(section)
                    initial = tuple(resource(mod, name, 'table'))
                    if len(initial) < minimum \
                            or maximum is not None and len(initial) > maximum:
                        raise WasmStateError(
                            'imported wasm table %s.%s has %d slots, expected '
                            '%d..%s' % (mod, name, len(initial), minimum,
                                       maximum if maximum is not None else
                                       'unbounded'))
                    table_limits.append((minimum, maximum, initial))
                elif kind == 2:
                    minimum, maximum = _limits(section)
                    initial = resource(mod, name, 'memory')
                    if not isinstance(initial, PagedMemory):
                        raise TypeError('imported wasm memory %s.%s must be a '
                                        'PagedMemory snapshot' % (mod, name))
                    pages = len(initial) // PAGE
                    if len(initial) % PAGE or pages < minimum \
                            or maximum is not None and pages > maximum:
                        raise WasmStateError(
                            'imported wasm memory %s.%s has %d pages, expected '
                            '%d..%s' % (mod, name, pages, minimum,
                                       maximum if maximum is not None else
                                       'unbounded'))
                    memories.append((minimum, maximum, initial))
                elif kind == 3:
                    ctype = _valtype(section)
                    mutable = bool(section.byte())
                    value = int(resource(mod, name, 'global'))
                    if ctype == 'i32':
                        value &= I32
                    elif ctype == 'i64':
                        value &= I64
                    else:
                        raise UnsupportedC('imported wasm global type %s is '
                                           'not modelled' % ctype)
                    globals_.append((ctype, mutable, value, True))
                else:
                    raise UnsupportedC('wasm import kind %d is not modelled'
                                       % kind)
        elif section_id == 3:
            defined_types.extend(section.vector(lambda: section.uleb()))
        elif section_id == 4:
            for _ in range(section.uleb()):
                minimum, maximum = _table_type(section)
                table_limits.append((minimum, maximum, None))
        elif section_id == 5:
            memories.extend((minimum, maximum, None)
                            for minimum, maximum
                            in section.vector(lambda: _limits(section)))
        elif section_id == 6:
            for _ in range(section.uleb()):
                ctype = _valtype(section)
                mutable = bool(section.byte())
                value = _const_expr(section, globals_)
                globals_.append((ctype, mutable, value, False))
        elif section_id == 7:
            for _ in range(section.uleb()):
                exports.append((section.name(), section.byte(), section.uleb()))
        elif section_id == 8:
            start = section.uleb()
        elif section_id == 9:
            element_segments.extend(_read_elements(section, globals_))
        elif section_id == 10:
            for _ in range(section.uleb()):
                body_size = section.uleb()
                body_start = section.at
                body_end = body_start + body_size
                if body_end > section.end:
                    raise WasmStateError(
                        'wasm function body exceeds the code section')
                section.at += body_size
                bodies.append((section.data, body_start, body_end))
        elif section_id == 11:
            for _ in range(section.uleb()):
                flags = section.uleb()
                if flags == 0:
                    offset = _const_expr(section, globals_)
                    payload = section.take(section.uleb())
                    data_segments.append((0, offset, payload))
                elif flags == 1:
                    section.take(section.uleb())
                elif flags == 2:
                    memory_index = section.uleb()
                    offset = _const_expr(section, globals_)
                    payload = section.take(section.uleb())
                    data_segments.append((memory_index, offset, payload))
                else:
                    raise UnsupportedC('wasm data segment form %d is not '
                                       'modelled' % flags)
        else:
            continue
        if not section.done():
            raise WasmStateError('wasm section %d has trailing bytes' % section_id)

    if len(defined_types) != len(bodies):
        raise WasmStateError('wasm function and code section lengths disagree')
    functions = list(imported)
    for type_index, body in zip(defined_types, bodies):
        functions.append(LazyFunction(type_index, body[0], body[1], body[2]))

    minimum, maximum, imported_memory = (memories[0] if memories
                                         else (0, None, None))
    if len(memories) > 1:
        raise UnsupportedC('multiple wasm memories are not modelled')
    # The minimum is an address-space limit, not resident data.  WebAssembly
    # initializes it to zero, so represent that zero tail implicitly and keep
    # only active data-segment pages.  This is the state-machine equivalent of
    # a demand-zero mmap and is especially important for compiler/VM modules
    # that reserve tens of MiB before touching most of it.
    memory = (PagedMemory(b'', minimum * PAGE) if imported_memory is None
              else imported_memory)
    for memory_index, offset, payload in data_segments:
        if memory_index != 0:
            raise UnsupportedC('multiple wasm memories are not modelled')
        end = offset + len(payload)
        if offset < 0 or end > len(memory):
            raise WasmStateError('active data segment is outside memory')
        memory = memory.write(offset, payload)
    tables = [(list(initial) if initial is not None else [None] * minimum)
              for minimum, _maximum, initial in table_limits]
    for table_index, offset, elements in element_segments:
        if table_index < 0 or table_index >= len(tables):
            raise WasmStateError('active element segment names an unknown table')
        end = offset + len(elements)
        if offset < 0 or end > len(tables[table_index]):
            raise WasmStateError('active element segment is outside its table')
        tables[table_index][offset:end] = elements
    return Module(tuple(types), tuple(functions),
                  tuple(value for _kind, _mut, value, _imp in globals_),
                  tuple(mutable for _kind, mutable, _value, _imp in globals_),
                  memory, maximum, tuple(exports), start,
                  tuple(tuple(table) for table in tables), indirect_abi)


def _valtype(reader):
    code = reader.byte()
    if code not in VALTYPES:
        raise UnsupportedC('wasm value type 0x%02X is not modelled' % code)
    return VALTYPES[code]


def _limits(reader):
    flags = reader.uleb()
    if flags & 2:
        raise UnsupportedC('shared wasm memory is not modelled')
    minimum = reader.uleb()
    maximum = reader.uleb() if flags & 1 else None
    if flags & ~1:
        raise UnsupportedC('64-bit wasm memory is not modelled')
    return minimum, maximum


def _table_type(reader):
    kind = _valtype(reader)
    if kind != 'funcref':
        raise UnsupportedC('wasm table type %s is not callable' % kind)
    return _limits(reader)


def _const_expr(reader, globals_):
    op = reader.byte()
    if op == 0x41:
        value = reader.sleb(32) & I32
    elif op == 0x42:
        value = reader.sleb(64) & I64
    elif op == 0x23:
        index = reader.uleb()
        value = globals_[index][2]
    else:
        raise UnsupportedC('wasm constant expression opcode 0x%02X is not '
                           'modelled' % op)
    if reader.byte() != 0x0B:
        raise WasmStateError('wasm constant expression has no end')
    return value


def _element_expr(reader):
    opcode = reader.byte()
    if opcode == 0xD2:
        value = reader.uleb()
    elif opcode == 0xD0:
        _valtype(reader)
        value = None
    else:
        raise UnsupportedC('wasm element expression opcode 0x%02X is not '
                           'modelled' % opcode)
    if reader.byte() != 0x0B:
        raise WasmStateError('wasm element expression has no end')
    return value


def _read_elements(reader, globals_):
    """Decode active table initializers and consume passive segments."""
    active = []
    for _ in range(reader.uleb()):
        flags = reader.uleb()
        if flags == 0:
            offset = _const_expr(reader, globals_)
            active.append((0, offset,
                           reader.vector(lambda: reader.uleb())))
        elif flags == 1:
            if reader.byte() != 0:
                raise UnsupportedC('non-function wasm element kind is not '
                                   'modelled')
            reader.vector(lambda: reader.uleb())
        elif flags == 2:
            table_index = reader.uleb()
            offset = _const_expr(reader, globals_)
            if reader.byte() != 0:
                raise UnsupportedC('non-function wasm element kind is not '
                                   'modelled')
            active.append((table_index, offset,
                           reader.vector(lambda: reader.uleb())))
        elif flags == 3:
            if reader.byte() != 0:
                raise UnsupportedC('non-function wasm element kind is not '
                                   'modelled')
            reader.vector(lambda: reader.uleb())
        elif flags in (4, 5, 6, 7):
            table_index = 0
            offset = None
            if flags == 4:
                offset = _const_expr(reader, globals_)
            elif flags == 6:
                table_index = reader.uleb()
                offset = _const_expr(reader, globals_)
                if _valtype(reader) != 'funcref':
                    raise UnsupportedC('non-function wasm element type is '
                                       'not modelled')
            else:
                if _valtype(reader) != 'funcref':
                    raise UnsupportedC('non-function wasm element type is '
                                       'not modelled')
            values = reader.vector(lambda: _element_expr(reader))
            if offset is not None:
                active.append((table_index, offset, values))
        else:
            raise UnsupportedC('wasm element segment form %d is not modelled'
                               % flags)
    return active


_PLAIN = {
    0x00: 'unreachable', 0x01: 'nop', 0x05: 'else', 0x0B: 'end',
    0x0F: 'return', 0x1A: 'drop', 0x1B: 'select',
    0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne',
    0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4A: 'i32.gt_s',
    0x4B: 'i32.gt_u', 0x4C: 'i32.le_s', 0x4D: 'i32.le_u',
    0x4E: 'i32.ge_s', 0x4F: 'i32.ge_u',
    0x50: 'i64.eqz', 0x51: 'i64.eq', 0x52: 'i64.ne',
    0x53: 'i64.lt_s', 0x54: 'i64.lt_u', 0x55: 'i64.gt_s',
    0x56: 'i64.gt_u', 0x57: 'i64.le_s', 0x58: 'i64.le_u',
    0x59: 'i64.ge_s', 0x5A: 'i64.ge_u',
    0x5B: 'f32.eq', 0x5C: 'f32.ne', 0x5D: 'f32.lt',
    0x5E: 'f32.gt', 0x5F: 'f32.le', 0x60: 'f32.ge',
    0x61: 'f64.eq', 0x62: 'f64.ne', 0x63: 'f64.lt',
    0x64: 'f64.gt', 0x65: 'f64.le', 0x66: 'f64.ge',
    0x67: 'i32.clz', 0x68: 'i32.ctz', 0x69: 'i32.popcnt',
    0x6A: 'i32.add', 0x6B: 'i32.sub', 0x6C: 'i32.mul',
    0x6D: 'i32.div_s', 0x6E: 'i32.div_u', 0x6F: 'i32.rem_s',
    0x70: 'i32.rem_u', 0x71: 'i32.and', 0x72: 'i32.or',
    0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s',
    0x76: 'i32.shr_u', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
    0x79: 'i64.clz', 0x7A: 'i64.ctz', 0x7B: 'i64.popcnt',
    0x7C: 'i64.add', 0x7D: 'i64.sub', 0x7E: 'i64.mul',
    0x7F: 'i64.div_s', 0x80: 'i64.div_u', 0x81: 'i64.rem_s',
    0x82: 'i64.rem_u', 0x83: 'i64.and', 0x84: 'i64.or',
    0x85: 'i64.xor', 0x86: 'i64.shl', 0x87: 'i64.shr_s',
    0x88: 'i64.shr_u', 0x89: 'i64.rotl', 0x8A: 'i64.rotr',
    0x8B: 'f32.abs', 0x8C: 'f32.neg', 0x8D: 'f32.ceil',
    0x8E: 'f32.floor', 0x8F: 'f32.trunc', 0x90: 'f32.nearest',
    0x91: 'f32.sqrt', 0x92: 'f32.add', 0x93: 'f32.sub',
    0x94: 'f32.mul', 0x95: 'f32.div', 0x96: 'f32.min',
    0x97: 'f32.max', 0x98: 'f32.copysign',
    0x99: 'f64.abs', 0x9A: 'f64.neg', 0x9B: 'f64.ceil',
    0x9C: 'f64.floor', 0x9D: 'f64.trunc', 0x9E: 'f64.nearest',
    0x9F: 'f64.sqrt', 0xA0: 'f64.add', 0xA1: 'f64.sub',
    0xA2: 'f64.mul', 0xA3: 'f64.div', 0xA4: 'f64.min',
    0xA5: 'f64.max', 0xA6: 'f64.copysign',
    0xA7: 'i32.wrap_i64', 0xAC: 'i64.extend_i32_s',
    0xAD: 'i64.extend_i32_u',
    0xA8: 'i32.trunc_f32_s', 0xA9: 'i32.trunc_f32_u',
    0xAA: 'i32.trunc_f64_s', 0xAB: 'i32.trunc_f64_u',
    0xAE: 'i64.trunc_f32_s', 0xAF: 'i64.trunc_f32_u',
    0xB0: 'i64.trunc_f64_s', 0xB1: 'i64.trunc_f64_u',
    0xB2: 'f32.convert_i32_s', 0xB3: 'f32.convert_i32_u',
    0xB4: 'f32.convert_i64_s', 0xB5: 'f32.convert_i64_u',
    0xB6: 'f32.demote_f64',
    0xB7: 'f64.convert_i32_s', 0xB8: 'f64.convert_i32_u',
    0xB9: 'f64.convert_i64_s', 0xBA: 'f64.convert_i64_u',
    0xBB: 'f64.promote_f32', 0xBC: 'i32.reinterpret_f32',
    0xBD: 'i64.reinterpret_f64', 0xBE: 'f32.reinterpret_i32',
    0xBF: 'f64.reinterpret_i64',
    0xC0: 'i32.extend8_s', 0xC1: 'i32.extend16_s',
    0xC2: 'i64.extend8_s', 0xC3: 'i64.extend16_s',
    0xC4: 'i64.extend32_s',
}

_INDEXED = {0x0C: 'br', 0x0D: 'br_if', 0x10: 'call', 0x20: 'local.get',
            0x21: 'local.set', 0x22: 'local.tee', 0x23: 'global.get',
            0x24: 'global.set'}

_MEMORY = {
    0x28: ('i32.load', 4, False), 0x29: ('i64.load', 8, False),
    0x2A: ('f32.load', 4, False), 0x2B: ('f64.load', 8, False),
    0x2C: ('i32.load8_s', 1, True), 0x2D: ('i32.load8_u', 1, False),
    0x2E: ('i32.load16_s', 2, True), 0x2F: ('i32.load16_u', 2, False),
    0x30: ('i64.load8_s', 1, True), 0x31: ('i64.load8_u', 1, False),
    0x32: ('i64.load16_s', 2, True), 0x33: ('i64.load16_u', 2, False),
    0x34: ('i64.load32_s', 4, True), 0x35: ('i64.load32_u', 4, False),
    0x36: ('i32.store', 4, False), 0x37: ('i64.store', 8, False),
    0x38: ('f32.store', 4, False), 0x39: ('f64.store', 8, False),
    0x3A: ('i32.store8', 1, False), 0x3B: ('i32.store16', 2, False),
    0x3C: ('i64.store8', 1, False), 0x3D: ('i64.store16', 2, False),
    0x3E: ('i64.store32', 4, False),
}


_ATOMIC_MEMORY = {
    0: ('memory.atomic.notify', 4, 32),
    1: ('memory.atomic.wait32', 4, 32),
    2: ('memory.atomic.wait64', 8, 64),
    16: ('i32.atomic.load', 4, 32),
    17: ('i64.atomic.load', 8, 64),
    18: ('i32.atomic.load8_u', 1, 32),
    19: ('i32.atomic.load16_u', 2, 32),
    20: ('i64.atomic.load8_u', 1, 64),
    21: ('i64.atomic.load16_u', 2, 64),
    22: ('i64.atomic.load32_u', 4, 64),
    23: ('i32.atomic.store', 4, 32),
    24: ('i64.atomic.store', 8, 64),
    25: ('i32.atomic.store8', 1, 32),
    26: ('i32.atomic.store16', 2, 32),
    27: ('i64.atomic.store8', 1, 64),
    28: ('i64.atomic.store16', 2, 64),
    29: ('i64.atomic.store32', 4, 64),
}

_ATOMIC_WIDTHS = (
    ('i32', 4, 32), ('i64', 8, 64),
    ('i32', 1, 32), ('i32', 2, 32),
    ('i64', 1, 64), ('i64', 2, 64), ('i64', 4, 64),
)
for _base, _action in zip(range(30, 72, 7),
                          ('add', 'sub', 'and', 'or', 'xor', 'xchg')):
    for _slot, (_kind, _width, _bits) in enumerate(_ATOMIC_WIDTHS):
        _narrow = '' if _width == _bits // 8 else str(_width * 8)
        _suffix = '' if not _narrow else '_u'
        _ATOMIC_MEMORY[_base + _slot] = (
            '%s.atomic.rmw%s.%s%s' % (_kind, _narrow, _action, _suffix),
            _width, _bits,
        )
for _slot, (_kind, _width, _bits) in enumerate(_ATOMIC_WIDTHS):
    _narrow = '' if _width == _bits // 8 else str(_width * 8)
    _suffix = '' if not _narrow else '_u'
    _ATOMIC_MEMORY[72 + _slot] = (
        '%s.atomic.rmw%s.cmpxchg%s' % (_kind, _narrow, _suffix),
        _width, _bits,
    )


def _decode_code(reader):
    code = []
    openers = []
    ends = {}
    elses = {}
    while not reader.done():
        opcode = reader.byte()
        if opcode in (0x02, 0x03, 0x04):
            blocktype = _blocktype(reader)
            name = {0x02: 'block', 0x03: 'loop', 0x04: 'if'}[opcode]
            openers.append((len(code), name))
            code.append(Instruction(name, (blocktype,)))
        elif opcode == 0x05:
            if not openers or openers[-1][1] != 'if':
                raise WasmStateError('wasm else is outside an if')
            elses[openers[-1][0]] = len(code)
            code.append(Instruction('else'))
        elif opcode == 0x0B:
            code.append(Instruction('end'))
            if not openers:
                if not reader.done():
                    raise WasmStateError('bytes follow the function end')
                break
            opener, _kind = openers.pop()
            ends[opener] = len(code) - 1
        elif opcode in _INDEXED:
            code.append(Instruction(_INDEXED[opcode], (reader.uleb(),)))
        elif opcode == 0x0E:
            labels = reader.vector(lambda: reader.uleb())
            code.append(Instruction('br_table', (labels, reader.uleb())))
        elif opcode == 0x11:
            type_index, table_index = reader.uleb(), reader.uleb()
            code.append(Instruction('call_indirect', (type_index, table_index)))
        elif opcode in _MEMORY:
            name, width, signed = _MEMORY[opcode]
            code.append(Instruction(name, (reader.uleb(), reader.uleb(),
                                            width, signed)))
        elif opcode in (0x3F, 0x40):
            memory_index = reader.uleb()
            code.append(Instruction('memory.size' if opcode == 0x3F
                                    else 'memory.grow', (memory_index,)))
        elif opcode == 0x41:
            code.append(Instruction('i32.const', (reader.sleb(32) & I32,)))
        elif opcode == 0x42:
            code.append(Instruction('i64.const', (reader.sleb(64) & I64,)))
        elif opcode == 0x43:
            code.append(Instruction(
                'f32.const', (int.from_bytes(reader.take(4), 'little'),)))
        elif opcode == 0x44:
            code.append(Instruction(
                'f64.const', (int.from_bytes(reader.take(8), 'little'),)))
        elif opcode == 0xFC:
            sub = reader.uleb()
            if sub == 10:
                code.append(Instruction('memory.copy',
                                        (reader.uleb(), reader.uleb())))
            elif sub == 11:
                code.append(Instruction('memory.fill', (reader.uleb(),)))
            else:
                raise UnsupportedC('wasm 0xFC instruction %d is not modelled'
                                   % sub)
        elif opcode == 0xFE:
            sub = reader.uleb()
            if sub == 3:
                if reader.uleb() != 0:
                    raise WasmStateError('wasm atomic fence flag is not zero')
                code.append(Instruction('atomic.fence'))
            elif sub in _ATOMIC_MEMORY:
                name, width, bits = _ATOMIC_MEMORY[sub]
                code.append(Instruction(name, (reader.uleb(), reader.uleb(),
                                                width, bits)))
            else:
                raise UnsupportedC('wasm atomic instruction %d is not '
                                   'modelled' % sub)
        elif opcode in _PLAIN:
            code.append(Instruction(_PLAIN[opcode]))
        else:
            raise UnsupportedC('wasm binary instruction 0x%02X is not '
                               'modelled' % opcode)
    if openers:
        raise WasmStateError('unterminated wasm control block')
    if not code or code[-1].op != 'end':
        raise WasmStateError('wasm function body has no final end')
    end_table = tuple(ends.get(i, -1) for i in range(len(code)))
    else_table = tuple(elses.get(i, -1) for i in range(len(code)))
    return tuple(code), end_table, else_table


def _blocktype(reader):
    first = reader.byte()
    if first == 0x40:
        return ()
    if first in VALTYPES:
        return (VALTYPES[first],)
    reader.at -= 1
    return reader.sleb(33)


@dataclass(frozen=True)
class Control:
    kind: str
    start: int
    end: int
    height: int
    results: int


@dataclass(frozen=True)
class Frame:
    function: int
    pc: int
    locals: tuple
    stack: tuple
    controls: tuple = ()


@dataclass(frozen=True)
class HostRequest:
    module: str
    name: str
    result_count: int
    args: tuple = ()


@dataclass(frozen=True)
class MachineState:
    frames: tuple
    globals: tuple
    memory: PagedMemory
    waiting: object = None
    halted: bool = False
    result: tuple = ()
    output: bytes = b''
    host_imports: tuple = ()


def start_state(module, function='main', args=(), run_start=True,
                host_imports=()):
    """Instantiate the module and create one exported invocation."""
    allowed = tuple(sorted(set(tuple(entry) for entry in host_imports)))
    base = MachineState((), module.globals, module.memory, halted=True,
                        host_imports=allowed)
    if run_start and module.start is not None:
        started = _invoke(module, base, module.start, ())
        started = run_until_boundary(module, started)
        if started.waiting is not None:
            raise UnsupportedC('wasm start function waits for host input')
        base = started
    index = module.export(function) if isinstance(function, str) else int(function)
    return _invoke(module, base, index, args)


def invoke(module, base, function, args=(), budget=1 << 20, executor=None):
    """Run one exported call against an existing module snapshot.

    The returned value retains all global and memory changes.  Calling this
    function again starts a fresh wasm invocation over precisely that retained
    state; call frames, return values and output from the previous invocation
    are deliberately not carried into the next call.
    """
    index = module.export(function) if isinstance(function, str) else int(function)
    return run_until_boundary(module, _invoke(module, base, index, args),
                              budget=budget, executor=executor)


def write_memory(state, address, payload):
    """Return a snapshot with bytes copied into its linear memory."""
    return replace(state, memory=state.memory.write(address, payload))


def _invoke(module, base, index, args):
    """Invoke one function while retaining an instantiated memory snapshot."""
    fn = module.functions[index]
    ftype = module.types[fn.type_index]
    if fn.imported:
        raise WasmStateError('cannot start at an imported function')
    if len(args) != len(ftype.params):
        raise WasmStateError('function %d expects %d argument(s), got %d'
                             % (index, len(ftype.params), len(args)))
    locals_ = tuple(_coerce(value, kind)
                    for value, kind in zip(args, ftype.params))
    locals_ += tuple(0 for _ in fn.locals)
    frame = Frame(index, 0, locals_, ())
    return MachineState((frame,), base.globals, base.memory,
                        host_imports=base.host_imports)


def instruction_step(module, state):
    """Execute exactly one wasm or host-call instruction, purely."""
    if state.halted or state.waiting is not None:
        return state
    if not state.frames:
        return replace(state, halted=True)

    frames = list(state.frames)
    frame = frames[-1]
    fn = module.functions[frame.function]
    if frame.pc >= len(fn.code):
        raise WasmStateError('program counter is outside function %d'
                             % frame.function)
    inst = fn.code[frame.pc]
    stack = list(frame.stack)
    locals_ = list(frame.locals)
    controls = list(frame.controls)
    globals_ = list(state.globals)
    memory = state.memory
    pc = frame.pc + 1

    def pop():
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % inst.op)
        return stack.pop()

    def put_frame():
        frames[-1] = Frame(frame.function, pc, tuple(locals_), tuple(stack),
                           tuple(controls))

    op = inst.op
    if op == 'unreachable':
        raise WasmStateError('wasm unreachable executed')
    if op == 'nop':
        pass
    elif op in ('block', 'loop', 'if'):
        blocktype = inst.args[0]
        results = _block_results(module, blocktype)
        condition = pop() if op == 'if' else None
        control = Control(op, frame.pc, fn.ends[frame.pc], len(stack), results)
        controls.append(control)
        if op == 'if' and not condition:
            alternate = fn.elses[frame.pc]
            pc = (alternate + 1) if alternate >= 0 else control.end
    elif op == 'else':
        if not controls or controls[-1].kind != 'if':
            raise WasmStateError('runtime else is outside an if')
        target = controls.pop()
        values = stack[-target.results:] if target.results else []
        stack[:] = stack[:target.height] + values
        pc = target.end + 1
    elif op == 'end':
        if controls:
            target = controls.pop()
            values = stack[-target.results:] if target.results else []
            stack[:] = stack[:target.height] + values
        else:
            put_frame()
            return _return_from_frame(module, replace(state, frames=tuple(frames),
                                                      globals=tuple(globals_),
                                                      memory=memory))
    elif op in ('br', 'br_if'):
        take = True if op == 'br' else bool(pop())
        if take:
            depth = inst.args[0]
            if depth == len(controls):
                put_frame()
                return _return_from_frame(
                    module, replace(state, frames=tuple(frames),
                                    globals=tuple(globals_), memory=memory))
            pc, stack, controls = _branch(depth, stack, controls)
    elif op == 'br_table':
        labels, default = inst.args
        selector = pop()
        depth = labels[selector] if selector < len(labels) else default
        if depth == len(controls):
            put_frame()
            return _return_from_frame(
                module, replace(state, frames=tuple(frames),
                                globals=tuple(globals_), memory=memory))
        pc, stack, controls = _branch(depth, stack, controls)
    elif op == 'return':
        put_frame()
        return _return_from_frame(module, replace(state, frames=tuple(frames),
                                                  globals=tuple(globals_),
                                                  memory=memory))
    elif op in ('call', 'call_indirect'):
        call_type = None
        if op == 'call':
            callee_index = inst.args[0]
        else:
            type_index, table_index = inst.args
            selector = pop() & I32
            if table_index >= len(module.tables):
                raise WasmStateError('call_indirect table is outside the module')
            table = module.tables[table_index]
            if selector >= len(table) or table[selector] is None:
                raise WasmStateError('call_indirect selected an empty table slot')
            callee_index = table[selector]
            if callee_index >= len(module.functions):
                raise WasmStateError('call_indirect function is outside the module')
            actual_index = module.functions[callee_index].type_index
            expected = (module.types[type_index]
                        if type_index < len(module.types) else None)
            actual = (module.types[actual_index]
                      if actual_index < len(module.types) else None)
            compatible = expected == actual
            if not compatible and module.indirect_abi == 'c-extra-args' \
                    and expected is not None and actual is not None:
                compatible = (
                    expected.results == actual.results
                    and len(expected.params) >= len(actual.params)
                    and expected.params[:len(actual.params)] == actual.params)
                if compatible:
                    call_type = expected
            if not compatible:
                raise WasmStateError(
                    'call_indirect function type mismatch at function %d pc %d: '
                    'table %d slot %d selects function %d, expected type %d %r, '
                    'got type %d %r'
                    % (frame.function, frame.pc, table_index, selector,
                       callee_index, type_index, expected, actual_index, actual))
        callee = module.functions[callee_index]
        callee_type = module.types[callee.type_index]
        args = [pop() for _ in (call_type or callee_type).params][::-1]
        if call_type is not None:
            args = args[:len(callee_type.params)]
        put_frame()
        if callee.imported:
            return _host_call(module, replace(state, frames=tuple(frames),
                                              globals=tuple(globals_),
                                              memory=memory), callee,
                              callee_type, args)
        child_locals = tuple(_coerce(v, t) for v, t in zip(args,
                                                            callee_type.params))
        child_locals += tuple(0 for _ in callee.locals)
        frames.append(Frame(callee_index, 0, child_locals, ()))
        return replace(state, frames=tuple(frames), globals=tuple(globals_),
                       memory=memory)
    elif op == 'drop':
        pop()
    elif op == 'select':
        condition, right, left = pop(), pop(), pop()
        stack.append(left if condition else right)
    elif op.startswith('local.'):
        index = inst.args[0]
        if index >= len(locals_):
            raise WasmStateError('local index %d is outside the frame' % index)
        if op == 'local.get':
            stack.append(locals_[index])
        elif op == 'local.set':
            locals_[index] = pop()
        else:
            locals_[index] = stack[-1]
    elif op.startswith('global.'):
        index = inst.args[0]
        if index >= len(globals_):
            raise WasmStateError('global index %d is outside the module' % index)
        if op == 'global.get':
            stack.append(globals_[index])
        else:
            if not module.global_mutable[index]:
                raise WasmStateError('write to immutable global %d' % index)
            globals_[index] = pop()
    elif op.endswith('.const'):
        stack.append(inst.args[0])
    elif op == 'atomic.fence':
        pass
    elif '.atomic.' in op or op.startswith('memory.atomic.'):
        memory = _atomic_step(op, inst.args, stack, memory)
    elif '.load' in op:
        _align, offset, width, signed = inst.args
        address = (pop() & I32) + offset
        raw = _memory_read(memory, address, width)
        value = int.from_bytes(raw, 'little')
        bits = 32 if op.startswith('i32') else 64
        if signed and value & (1 << (width * 8 - 1)):
            value -= 1 << (width * 8)
        stack.append(value & mask_of(bits))
    elif '.store' in op:
        _align, offset, width, _signed = inst.args
        value, address = pop(), (pop() & I32) + offset
        memory = _memory_write(memory, address,
                               int(value & mask_of(width * 8))
                               .to_bytes(width, 'little'))
    elif op == 'memory.size':
        stack.append(len(memory) // PAGE)
    elif op == 'memory.grow':
        pages = pop() & I32
        old = len(memory) // PAGE
        maximum = module.memory_max
        if maximum is not None and old + pages > maximum:
            stack.append(I32)
        else:
            memory = memory.grow(pages)
            stack.append(old)
    elif op == 'memory.copy':
        count, source, target = pop() & I32, pop() & I32, pop() & I32
        payload = _memory_read(memory, source, count)
        memory = _memory_write(memory, target, payload)
    elif op == 'memory.fill':
        count, value, target = pop() & I32, pop() & 255, pop() & I32
        memory = _memory_write(memory, target, bytes([value]) * count)
    else:
        _numeric(op, stack)

    put_frame()
    return replace(state, frames=tuple(frames), globals=tuple(globals_),
                   memory=memory)


def _block_results(module, blocktype):
    if isinstance(blocktype, tuple):
        return len(blocktype)
    if blocktype < 0 or blocktype >= len(module.types):
        raise WasmStateError('block type index is outside the type section')
    return len(module.types[blocktype].results)


def _branch(depth, stack, controls):
    if depth >= len(controls):
        raise WasmStateError('branch depth %d exceeds control stack' % depth)
    index = len(controls) - 1 - depth
    target = controls[index]
    result_count = 0 if target.kind == 'loop' else target.results
    values = stack[-result_count:] if result_count else []
    stack = stack[:target.height] + values
    if target.kind == 'loop':
        return target.start + 1, stack, controls[:index + 1]
    return target.end + 1, stack, controls[:index]


def _return_from_frame(module, state):
    frames = list(state.frames)
    frame = frames.pop()
    ftype = module.types[module.functions[frame.function].type_index]
    count = len(ftype.results)
    values = frame.stack[-count:] if count else ()
    if not frames:
        return replace(state, frames=(), halted=True, result=tuple(values))
    parent = frames[-1]
    frames[-1] = replace(parent, stack=parent.stack + tuple(values))
    return replace(state, frames=tuple(frames))


_INPUT_NAMES = {'qm_getchar', 'getchar'}
_OUTPUT_NAMES = {'qm_putchar', 'putchar'}


def _host_call(module, state, function, ftype, args):
    name = function.name
    if name in _INPUT_NAMES:
        if args:
            raise WasmStateError('%s import unexpectedly takes arguments' % name)
        return replace(state, waiting=HostRequest(function.module, name,
                                                  len(ftype.results),
                                                  tuple(args)))
    if name in _OUTPUT_NAMES:
        if len(args) != 1:
            raise WasmStateError('%s import expects one byte' % name)
        output = state.output + bytes([args[0] & 255])
        if ftype.results:
            parent = state.frames[-1]
            frames = state.frames[:-1] + (replace(parent,
                                                   stack=parent.stack
                                                   + (args[0] & I32,)),)
            return replace(state, frames=frames, output=output)
        return replace(state, output=output)
    identity = (function.module, name)
    if identity in state.host_imports:
        return replace(state, waiting=HostRequest(function.module, name,
                                                  len(ftype.results),
                                                  tuple(args)))
    raise UnsupportedC('wasm host import %s.%s is not modelled'
                       % identity,
                       hint='make environment state an explicit input, or '
                            'provide a deterministic host adapter')


def resume_host(state, results=(), memory_writes=()):
    """Apply one deterministic host response to a suspended machine.

    Host adapters state their import names up front through ``start_state``.
    At the import boundary they may update explicit guest-memory ranges and
    return the declared Wasm results.  No ambient host operation is performed
    by the interpreter itself.
    """
    request = state.waiting
    if request is None:
        raise WasmStateError('machine is not waiting for a host response')
    results = tuple(results)
    if len(results) != request.result_count:
        raise WasmStateError('host import %s.%s expects %d result(s), got %d'
                             % (request.module, request.name,
                                request.result_count, len(results)))
    memory = state.memory
    for address, payload in memory_writes:
        memory = memory.write(int(address), bytes(payload))
    frames = state.frames
    if results:
        if not frames:
            raise WasmStateError('host response has no caller frame')
        parent = frames[-1]
        frames = frames[:-1] + (replace(parent,
                                        stack=parent.stack + results),)
    return replace(state, frames=frames, memory=memory, waiting=None)


def resume_input(module, state, byte):
    """Answer one suspended input import without mutating its snapshot."""
    if state.waiting is None or state.waiting.name not in _INPUT_NAMES:
        raise WasmStateError('machine is not waiting for an input byte')
    if byte != EOF and not 0 <= byte <= 255:
        raise ValueError('input letter must be a byte or EOF')
    value = I32 if byte == EOF else byte
    results = (value,) if state.waiting.result_count else ()
    return replace(resume_host(state, results), output=b'')


def run_until_boundary(module, state, budget=1 << 20, executor=None):
    """Run dependency waves and ordered barriers to input or termination."""
    if executor is None:
        from .wasmwave import WaveExecutor
        executor = WaveExecutor(module)
    return executor.run(state, budget)


def stream_initial(module, function='main', args=(), budget=1 << 20,
                   executor=None):
    return run_until_boundary(module, start_state(module, function, args),
                              budget=budget, executor=executor)


def stream_step(module, state, byte, budget=1 << 20, executor=None):
    """Pure ``state, byte -> state`` at imported input boundaries."""
    if state.halted:
        return replace(state, output=b'')
    return run_until_boundary(module, resume_input(module, state, byte),
                              budget=budget, executor=executor)


def observe(state):
    """The complete externally visible event attached to one machine state."""
    return (state.output, state.halted, state.result)


def compile_stream(module, function='main', alphabet=None, max_states=4096,
                   budget=1 << 20, args=(), executor=None):
    """Build the exact finite future quotient of a compiled wasm driver."""
    from .transducer import compile_transducer
    if executor is None:
        from .wasmwave import WaveExecutor
        executor = WaveExecutor(module)
    initial = stream_initial(module, function, args=args, budget=budget,
                             executor=executor)
    alphabet = tuple(range(257)) if alphabet is None else tuple(alphabet)
    return compile_transducer(
        initial,
        lambda state, letter: stream_step(module, state, letter, budget,
                                          executor=executor),
        observe,
        alphabet,
        max_states=max_states,
    )


def _coerce(value, kind):
    if kind in ('i32', 'f32'):
        return int(value) & I32
    if kind in ('i64', 'f64'):
        return int(value) & I64
    raise UnsupportedC('runtime value type %s is not modelled' % kind)


def _memory_read(memory, address, size):
    return memory.read(address, size)


def _memory_write(memory, address, payload):
    return memory.write(address, payload)


def _signed(value, bits):
    value &= mask_of(bits)
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


def _truncdiv(left, right):
    return abs(left) // abs(right) * (-1 if (left < 0) != (right < 0) else 1)


def _rot(value, count, bits, left):
    count %= bits
    mask = mask_of(bits)
    if not count:
        return value & mask
    if left:
        return ((value << count) | (value >> (bits - count))) & mask
    return ((value >> count) | (value << (bits - count))) & mask


def _numeric(op, stack):
    if not op.startswith(('i32.', 'i64.')):
        raise UnsupportedC('wasm instruction %r is not modelled' % op)
    bits = 32 if op.startswith('i32.') else 64
    mask = mask_of(bits)
    name = op.split('.', 1)[1]

    def pop():
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % op)
        return stack.pop() & mask

    if name == 'wrap_i64':
        stack.append(stack.pop() & I32)
        return
    if name in ('extend_i32_s', 'extend_i32_u'):
        value = stack.pop() & I32
        stack.append((_signed(value, 32) if name.endswith('_s') else value) & I64)
        return
    if name in ('extend8_s', 'extend16_s', 'extend32_s'):
        width = int(name[len('extend'):-len('_s')])
        stack.append(_signed(pop(), width) & mask)
        return
    if name == 'eqz':
        stack.append(1 if pop() == 0 else 0)
        return
    if name in ('clz', 'ctz', 'popcnt'):
        value = pop()
        if name == 'clz':
            result = bits - value.bit_length()
        elif name == 'ctz':
            result = bits if not value else (value & -value).bit_length() - 1
        else:
            result = value.bit_count()
        stack.append(result)
        return

    right, left = pop(), pop()
    if name in ('eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u',
                'le_s', 'le_u', 'ge_s', 'ge_u'):
        signed = name.endswith('_s')
        a = _signed(left, bits) if signed else left
        b = _signed(right, bits) if signed else right
        relation = name[:2]
        result = {'eq': a == b, 'ne': a != b, 'lt': a < b, 'gt': a > b,
                  'le': a <= b, 'ge': a >= b}[relation]
        stack.append(1 if result else 0)
        return
    if name == 'add': result = left + right
    elif name == 'sub': result = left - right
    elif name == 'mul': result = left * right
    elif name == 'and': result = left & right
    elif name == 'or': result = left | right
    elif name == 'xor': result = left ^ right
    elif name == 'shl': result = left << (right % bits)
    elif name == 'shr_u': result = left >> (right % bits)
    elif name == 'shr_s': result = _signed(left, bits) >> (right % bits)
    elif name == 'rotl': result = _rot(left, right, bits, True)
    elif name == 'rotr': result = _rot(left, right, bits, False)
    elif name in ('div_u', 'rem_u'):
        if not right:
            raise WasmStateError('integer division by zero')
        result = left // right if name == 'div_u' else left % right
    elif name in ('div_s', 'rem_s'):
        a, b = _signed(left, bits), _signed(right, bits)
        if not b:
            raise WasmStateError('integer division by zero')
        if name == 'div_s' and a == -(1 << (bits - 1)) and b == -1:
            raise WasmStateError('signed integer division overflow')
        quotient = _truncdiv(a, b)
        result = quotient if name == 'div_s' else a - quotient * b
    else:
        raise UnsupportedC('wasm integer instruction %r is not modelled' % op)
    stack.append(result & mask)


def _atomic_step(op, args, stack, memory):
    """Execute one atomic barrier in the single-machine reference state."""
    _align, offset, width, bits = args
    result_mask = mask_of(bits)
    storage_mask = mask_of(width * 8)

    def pop():
        if not stack:
            raise WasmStateError('%s pops an empty value stack' % op)
        return stack.pop()

    if op == 'memory.atomic.notify':
        _count = pop() & I32
        address = (pop() & I32) + offset
        if address % width:
            raise WasmStateError('unaligned atomic memory access')
        _memory_read(memory, address, width)
        stack.append(0)
        return memory
    if op in ('memory.atomic.wait32', 'memory.atomic.wait64'):
        raise UnsupportedC('%s requires an explicit scheduler barrier' % op)

    if '.load' in op:
        address = (pop() & I32) + offset
        if address % width:
            raise WasmStateError('unaligned atomic memory access')
        stack.append(int.from_bytes(_memory_read(memory, address, width),
                                    'little') & result_mask)
        return memory
    if '.store' in op:
        value = pop() & storage_mask
        address = (pop() & I32) + offset
        if address % width:
            raise WasmStateError('unaligned atomic memory access')
        return _memory_write(memory, address,
                             value.to_bytes(width, 'little'))

    replacement = pop() & storage_mask
    expected = None
    if '.cmpxchg' in op:
        expected = pop() & storage_mask
    address = (pop() & I32) + offset
    if address % width:
        raise WasmStateError('unaligned atomic memory access')
    old = int.from_bytes(_memory_read(memory, address, width), 'little')
    if expected is not None:
        changed = replacement if old == expected else old
    elif '.add' in op:
        changed = old + replacement
    elif '.sub' in op:
        changed = old - replacement
    elif '.and' in op:
        changed = old & replacement
    elif '.or' in op:
        changed = old | replacement
    elif '.xor' in op:
        changed = old ^ replacement
    elif '.xchg' in op:
        changed = replacement
    else:
        raise UnsupportedC('wasm atomic instruction %r is not modelled' % op)
    memory = _memory_write(memory, address,
                           int(changed & storage_mask).to_bytes(width, 'little'))
    stack.append(old & result_mask)
    return memory
