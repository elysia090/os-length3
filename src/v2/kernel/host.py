"""Deterministic host boundaries for a Linux kernel compiled to wasm32.

The Linux syscall and VFS implementations remain inside the guest kernel.
Only operations that require an external scheduler, clock, allocator or device
cross the Wasm import boundary.  The LKL Wasm port concentrates those requests
in ``env.nccc_call64(in_pointer, out_pointer)``; this module decodes that one
call without performing any ambient host operation.

Block data uses a two-level direct page coordinate.  The low byte selects one
of 256 pages in a span and the remaining bits select the span.  Empty spans and
clean pages can be discarded without hashing or scanning the backing image.
"""

from dataclasses import dataclass, replace
import struct

from qm.wasmstate import I32, PAGE, WasmStateError, resume_host


NCCC_IMPORT = ('env', 'nccc_call64')
BLOCK_PAGE_SIZE = 4096
SPAN_PAGES = 256
KERNEL_POOL_PAGES = 2048
KERNEL_STACK_PAGES = 2048
THREAD_STACK_PAGES = 10
_U64 = struct.Struct('<Q')


@dataclass(frozen=True)
class HostOperation:
    group: int
    code: int
    name: str
    input_words: int
    output_words: int = 0

    @property
    def coordinate(self):
        return (self.group, self.code)


def _operation(group, code, name, input_words, output_words=0):
    return HostOperation(group, code, name, input_words, output_words)


_OPERATIONS = (
    _operation(0, 1, 'print', 4),
    _operation(0, 2, 'panic', 2),

    _operation(1, 1, 'sem_alloc', 3, 1),
    _operation(1, 2, 'sem_free', 3),
    _operation(1, 3, 'sem_up', 3),
    _operation(1, 4, 'sem_down', 3),
    _operation(1, 5, 'mutex_alloc', 3, 1),
    _operation(1, 6, 'mutex_free', 3),
    _operation(1, 7, 'mutex_lock', 3),
    _operation(1, 8, 'mutex_unlock', 3),

    _operation(2, 1, 'thread_create', 4, 1),
    _operation(2, 2, 'thread_detach', 2),
    _operation(2, 3, 'thread_exit', 2),
    _operation(2, 4, 'thread_join', 3, 1),
    _operation(2, 5, 'thread_self', 2, 1),
    _operation(2, 6, 'thread_equal', 4, 1),
    _operation(2, 7, 'gettid', 2, 1),
    _operation(2, 8, 'tls_alloc', 3, 1),
    _operation(2, 9, 'tls_free', 3),
    _operation(2, 10, 'tls_set', 4, 1),
    _operation(2, 11, 'tls_get', 3, 1),

    _operation(3, 1, 'mem_alloc', 3, 1),
    _operation(3, 2, 'mem_free', 3),

    _operation(4, 1, 'time', 2, 1),
    _operation(4, 2, 'timer_alloc', 4, 1),
    _operation(4, 3, 'timer_set_oneshot', 4, 1),
    _operation(4, 4, 'timer_free', 3),

    _operation(5, 1, 'jmp_buf_set', 5),
    _operation(5, 2, 'jmp_buf_longjmp', 4),
)

OPERATIONS = dict((operation.coordinate, operation)
                  for operation in _OPERATIONS)


@dataclass(frozen=True)
class NcccBarrier:
    operation: HostOperation
    arguments: tuple
    input_pointer: int
    output_pointer: int

    @property
    def coordinate(self):
        return self.operation.coordinate


def _read_words(memory, pointer, count):
    raw = memory.read(pointer, count * _U64.size)
    return tuple(_U64.unpack_from(raw, index * _U64.size)[0]
                 for index in range(count))


def decode_nccc(state):
    """Decode the LKL host request at the current Wasm import barrier."""
    request = state.waiting
    if request is None or (request.module, request.name) != NCCC_IMPORT:
        raise WasmStateError('machine is not waiting at env.nccc_call64')
    if request.result_count:
        raise WasmStateError('env.nccc_call64 must not return a Wasm value')
    if len(request.args) != 2:
        raise WasmStateError('env.nccc_call64 expects two pointer arguments')
    input_pointer, output_pointer = (int(value) & I32
                                     for value in request.args)
    group, code = _read_words(state.memory, input_pointer, 2)
    operation = OPERATIONS.get((group, code))
    if operation is None:
        raise WasmStateError('unknown LKL host operation %d:%d'
                             % (group, code))
    words = _read_words(state.memory, input_pointer,
                        operation.input_words)
    return NcccBarrier(operation, words[2:], input_pointer, output_pointer)


def resume_nccc(state, outputs=(), memory_writes=()):
    """Apply an explicit response and resume after one LKL host barrier."""
    barrier = decode_nccc(state)
    outputs = tuple(int(value) & ((1 << 64) - 1) for value in outputs)
    expected = barrier.operation.output_words
    if len(outputs) != expected:
        raise WasmStateError('LKL host operation %s expects %d output word(s), '
                             'got %d' % (barrier.operation.name, expected,
                                        len(outputs)))
    writes = list(memory_writes)
    if outputs:
        payload = b''.join(_U64.pack(value) for value in outputs)
        writes.insert(0, (barrier.output_pointer, payload))
    return resume_host(state, memory_writes=writes)


@dataclass(frozen=True)
class HostObject:
    kind: str
    values: tuple = ()


@dataclass(frozen=True)
class LinuxHostState:
    """Explicit state for immediate LKL host operations.

    Slot zero is permanently invalid. Slot one represents the thread that
    entered the kernel. New synchronization, TLS and timer objects append to
    this direct table, so handles are stable integer coordinates.
    """

    objects: tuple = (None, HostObject('thread'))
    current_thread: int = 1
    clock_ns: int = 0
    heap_pointer: int = 0
    heap_limit: int = 0
    stack_pointer: int = 0
    stack_limit: int = 0


@dataclass(frozen=True)
class HostTransition:
    machine: object
    host: LinuxHostState
    blocked: bool = False
    event: object = None


def prepare_linux_memory(machine, host=None, pool_pages=KERNEL_POOL_PAGES,
                         stack_pages=KERNEL_STACK_PAGES):
    """Reserve the reference LKL host address regions without committing pages."""
    host = LinuxHostState() if host is None else host
    if host.heap_pointer or host.heap_limit or host.stack_pointer:
        raise WasmStateError('LKL host memory is already prepared')
    pool_pages, stack_pages = int(pool_pages), int(stack_pages)
    if pool_pages < 0 or stack_pages < 0:
        raise ValueError('LKL host memory page counts must be nonnegative')
    first = len(machine.memory)
    memory = machine.memory.grow(pool_pages + stack_pages)
    heap_limit = first + pool_pages * PAGE
    host = replace(host, heap_pointer=first, heap_limit=heap_limit,
                   stack_pointer=heap_limit,
                   stack_limit=heap_limit + stack_pages * PAGE)
    return replace(machine, memory=memory), host


def allocate_thread_stack(host, pages=THREAD_STACK_PAGES):
    """Allocate one downward-growing stack and return its initial pointer."""
    pages = int(pages)
    if pages <= 0:
        raise ValueError('thread stack page count must be positive')
    first = host.stack_pointer
    end = first + pages * PAGE
    if not first or end > host.stack_limit:
        raise WasmStateError('LKL thread stack region is exhausted')
    return replace(host, stack_pointer=end), end - 256


def _object(host, handle, kind=None):
    handle = int(handle)
    if handle <= 0 or handle >= len(host.objects):
        raise WasmStateError('LKL host object %d is not allocated' % handle)
    value = host.objects[handle]
    if value is None or (kind is not None and value.kind != kind):
        raise WasmStateError('LKL host object %d is not a %s'
                             % (handle, kind or 'live object'))
    return value


def _allocate(host, value):
    handle = len(host.objects)
    return replace(host, objects=host.objects + (value,)), handle


def _replace_object(host, handle, value):
    _object(host, handle)
    objects = list(host.objects)
    objects[int(handle)] = value
    return replace(host, objects=tuple(objects))


def _free_object(host, handle, kind):
    _object(host, handle, kind)
    return _replace_object(host, handle, None)


def _finish(machine, host, outputs=(), event=None):
    return HostTransition(resume_nccc(machine, outputs), host, event=event)


def step_nccc(machine, host=None):
    """Resolve one nonblocking kernel host request as a pure transition.

    Thread creation, joins, context jumps, an empty semaphore, and a contended
    mutex return ``blocked=True``. A scheduler can then retain the unchanged
    machine snapshot and choose another runnable continuation. Clock values
    come from ``LinuxHostState.clock_ns``; this function never reads a host
    clock, filesystem, or random source.
    """
    host = LinuxHostState() if host is None else host
    barrier = decode_nccc(machine)
    group, code = barrier.coordinate
    args = barrier.arguments

    if group == 0:
        if code == 1:
            pointer, length = map(int, args)
            payload = machine.memory.read(pointer & I32, length & I32)
            return _finish(machine, host, event=('print', payload))
        return HostTransition(machine, host, blocked=True,
                              event=('panic',))

    if group == 1:
        if code == 1:
            host, handle = _allocate(host, HostObject('semaphore',
                                                       (int(args[0]),)))
            return _finish(machine, host, (handle,))
        if code == 2:
            return _finish(machine, _free_object(host, args[0], 'semaphore'))
        if code in (3, 4):
            handle = int(args[0])
            obj = _object(host, handle, 'semaphore')
            count = obj.values[0]
            if code == 4 and count <= 0:
                return HostTransition(machine, host, blocked=True,
                                      event=('semaphore', handle))
            count += 1 if code == 3 else -1
            host = _replace_object(host, handle,
                                   HostObject('semaphore', (count,)))
            return _finish(machine, host)
        if code == 5:
            recursive = bool(args[0])
            host, handle = _allocate(
                host, HostObject('mutex', (recursive, 0, 0)))
            return _finish(machine, host, (handle,))
        if code == 6:
            return _finish(machine, _free_object(host, args[0], 'mutex'))
        if code in (7, 8):
            handle = int(args[0])
            obj = _object(host, handle, 'mutex')
            recursive, owner, depth = obj.values
            if code == 7:
                if owner not in (0, host.current_thread):
                    return HostTransition(machine, host, blocked=True,
                                          event=('mutex', handle))
                if owner == host.current_thread and depth and not recursive:
                    return HostTransition(machine, host, blocked=True,
                                          event=('mutex', handle))
                owner, depth = host.current_thread, depth + 1
            else:
                if owner != host.current_thread or not depth:
                    raise WasmStateError('unlock of an unowned LKL mutex')
                depth -= 1
                if not depth:
                    owner = 0
            host = _replace_object(
                host, handle, HostObject('mutex', (recursive, owner, depth)))
            return _finish(machine, host)

    if group == 2:
        if code in (1, 2, 3, 4):
            return HostTransition(machine, host, blocked=True,
                                  event=('thread', barrier.operation.name,
                                         args))
        if code in (5, 7):
            _object(host, host.current_thread, 'thread')
            return _finish(machine, host, (host.current_thread,))
        if code == 6:
            _object(host, args[0], 'thread')
            _object(host, args[1], 'thread')
            return _finish(machine, host, (int(args[0]) == int(args[1]),))
        if code == 8:
            host, handle = _allocate(host, HostObject('tls',
                                                       (int(args[0]), 0)))
            return _finish(machine, host, (handle,))
        if code == 9:
            return _finish(machine, _free_object(host, args[0], 'tls'))
        if code in (10, 11):
            handle = int(args[0])
            obj = _object(host, handle, 'tls')
            destructor, value = obj.values
            if code == 10:
                host = _replace_object(
                    host, handle, HostObject('tls', (destructor, int(args[1]))))
                return _finish(machine, host, (0,))
            return _finish(machine, host, (value,))

    if group == 3:
        if code == 1:
            size = int(args[0])
            pointer = host.heap_pointer or ((len(machine.memory) + 15) & -16)
            end = pointer + size
            memory = machine.memory
            if host.heap_limit and end > host.heap_limit:
                raise WasmStateError('LKL host allocation region is exhausted')
            if not host.heap_limit and end > len(memory):
                memory = memory.grow((end - len(memory) + PAGE - 1) // PAGE)
                machine = replace(machine, memory=memory)
            host = replace(host, heap_pointer=(end + 15) & -16)
            return _finish(machine, host, (pointer,))
        if code == 2:
            return _finish(machine, host)

    if group == 4:
        if code == 1:
            return _finish(machine, host, (host.clock_ns,))
        if code == 2:
            host, handle = _allocate(
                host, HostObject('timer', (int(args[0]), int(args[1]), None)))
            return _finish(machine, host, (handle,))
        if code == 3:
            handle = int(args[0])
            obj = _object(host, handle, 'timer')
            function, argument, _deadline = obj.values
            deadline = host.clock_ns + int(args[1])
            host = _replace_object(
                host, handle, HostObject('timer',
                                         (function, argument, deadline)))
            return _finish(machine, host, (0,))
        if code == 4:
            return _finish(machine, _free_object(host, args[0], 'timer'))

    if group == 5:
        return HostTransition(machine, host, blocked=True,
                              event=('context', barrier.operation.name, args))
    raise WasmStateError('no LKL host transition for %d:%d' % (group, code))


class _PageSpan(object):
    __slots__ = ('pages', 'dirty')

    def __init__(self, span_pages):
        self.pages = [None] * span_pages
        self.dirty = 0


class DirectPageStore(object):
    """Lazy fixed-size block image with direct, disposable page spans.

    ``loader(offset, length)`` is called only when a page is first touched.
    ``writer(offset, bytes)`` is optional and is called by ``flush_span`` for
    dirty pages.  The directory and every allocated span are arrays, so a page
    lookup performs two integer indexes and never needs a hash table.
    """

    def __init__(self, length, loader=None, writer=None,
                 page_size=BLOCK_PAGE_SIZE, span_pages=SPAN_PAGES):
        self.length = int(length)
        self.page_size = int(page_size)
        self.span_pages = int(span_pages)
        if self.length < 0:
            raise ValueError('block image length must be nonnegative')
        if self.page_size <= 0 or self.span_pages <= 0:
            raise ValueError('page and span sizes must be positive')
        self.page_count = ((self.length + self.page_size - 1)
                           // self.page_size)
        spans = ((self.page_count + self.span_pages - 1)
                 // self.span_pages)
        self.directory = [None] * spans
        self.loader = loader
        self.writer = writer

    def _check_page(self, page):
        page = int(page)
        if page < 0 or page >= self.page_count:
            raise ValueError('block page %d is outside the image' % page)
        return page

    def _coordinates(self, page):
        page = self._check_page(page)
        return divmod(page, self.span_pages)

    def _valid_bytes(self, page):
        return min(self.page_size, self.length - page * self.page_size)

    def _span(self, span_index, create=False):
        span = self.directory[span_index]
        if span is None and create:
            span = _PageSpan(self.span_pages)
            self.directory[span_index] = span
        return span

    def _load(self, page):
        span_index, slot = self._coordinates(page)
        span = self._span(span_index, True)
        payload = span.pages[slot]
        if payload is None:
            count = self._valid_bytes(page)
            if self.loader is None:
                raw = bytes(count)
            else:
                raw = bytes(self.loader(page * self.page_size, count))
                if len(raw) != count:
                    raise ValueError('block loader returned %d bytes, expected %d'
                                     % (len(raw), count))
            payload = raw + bytes(self.page_size - count)
            span.pages[slot] = payload
        return span, slot, payload

    def page(self, page):
        """Return a zero-copy read-only view of one resident page."""
        _span, _slot, payload = self._load(page)
        return memoryview(payload)

    def read(self, offset, length):
        offset, length = int(offset), int(length)
        if offset < 0 or length < 0 or offset + length > self.length:
            raise ValueError('block read is outside the image')
        out = bytearray()
        while length:
            page, within = divmod(offset, self.page_size)
            count = min(length, self.page_size - within)
            out.extend(self.page(page)[within:within + count])
            offset += count
            length -= count
        return bytes(out)

    def write(self, offset, payload):
        offset, payload = int(offset), bytes(payload)
        if offset < 0 or offset + len(payload) > self.length:
            raise ValueError('block write is outside the image')
        cursor = 0
        while cursor < len(payload):
            page, within = divmod(offset, self.page_size)
            count = min(len(payload) - cursor, self.page_size - within)
            span_index, slot = self._coordinates(page)
            span = self._span(span_index, True)
            if within == 0 and count == self.page_size:
                changed = payload[cursor:cursor + count]
            else:
                _loaded, _slot, old = self._load(page)
                changed = bytearray(old)
                changed[within:within + count] = payload[cursor:cursor + count]
                changed = bytes(changed)
            span.pages[slot] = changed
            span.dirty |= 1 << slot
            offset += count
            cursor += count

    def flush_span(self, span_index, drop=False):
        span_index = int(span_index)
        if span_index < 0 or span_index >= len(self.directory):
            raise ValueError('block span is outside the image')
        span = self.directory[span_index]
        if span is None:
            return 0
        if span.dirty and self.writer is None:
            raise ValueError('dirty block pages have no writer')
        dirty = span.dirty
        written = 0
        while dirty:
            low = dirty & -dirty
            slot = low.bit_length() - 1
            page = span_index * self.span_pages + slot
            count = self._valid_bytes(page)
            self.writer(page * self.page_size, span.pages[slot][:count])
            dirty ^= low
            written += 1
        span.dirty = 0
        if drop:
            self.directory[span_index] = None
        return written

    def evict_span(self, span_index):
        span_index = int(span_index)
        if span_index < 0 or span_index >= len(self.directory):
            raise ValueError('block span is outside the image')
        span = self.directory[span_index]
        if span is not None and span.dirty:
            raise ValueError('cannot evict a dirty block span')
        self.directory[span_index] = None

    @property
    def resident_pages(self):
        return sum(sum(page is not None for page in span.pages)
                   for span in self.directory if span is not None)

    @property
    def dirty_pages(self):
        return sum(span.dirty.bit_count()
                   for span in self.directory if span is not None)

    @property
    def resident_bytes(self):
        return self.resident_pages * self.page_size
