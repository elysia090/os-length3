"""Linux-in-Wasm host barriers and directly addressed block pages."""

import struct
import unittest

from qm.cfront.errors import UnsupportedC
from kernel.host import (DirectPageStore, LinuxHostState, NCCC_IMPORT,
                         allocate_thread_stack, decode_nccc,
                         prepare_linux_memory, resume_nccc, step_nccc)
from qm.wasmstate import (WasmStateError, decode_module, run_until_boundary,
                          start_state)


def _u(value):
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _name(value):
    encoded = value.encode('utf-8')
    return _u(len(encoded)) + encoded


def _section(kind, payload):
    return bytes([kind]) + _u(len(payload)) + payload


def nccc_time_module(group=4, operation=1, arguments=()):
    """A kernel-shaped call to ``nccc_call64`` followed by its output read."""
    input_pointer = 256
    output_pointer = 320
    types = (b'\x02'
             b'\x60\x02\x7f\x7f\x00'
             b'\x60\x00\x01\x7e')
    imports = (b'\x01' + _name('env') + _name('nccc_call64')
               + b'\x00\x00')
    functions = b'\x01\x01'
    memory = b'\x01\x00\x01'
    exports = b'\x01' + _name('main') + b'\x00\x01'
    instructions = (b'\x41' + _u(input_pointer)
                    + b'\x41' + _u(output_pointer)
                    + b'\x10\x00'
                    + b'\x41' + _u(output_pointer)
                    + b'\x29\x03\x00\x0b')
    body = b'\x00' + instructions
    code = b'\x01' + _u(len(body)) + body
    request = struct.pack('<%dQ' % (2 + len(arguments)),
                          group, operation, *arguments)
    data = (b'\x01\x00\x41' + _u(input_pointer) + b'\x0b'
            + _u(len(request)) + request)
    return (b'\x00asm\x01\x00\x00\x00'
            + _section(1, types) + _section(2, imports)
            + _section(3, functions) + _section(5, memory)
            + _section(7, exports) + _section(10, code)
            + _section(11, data))


class TestLinuxHostBarrier(unittest.TestCase):
    def setUp(self):
        self.module = decode_module(nccc_time_module())

    def test_unknown_host_imports_remain_refusals_by_default(self):
        state = start_state(self.module)
        with self.assertRaises(UnsupportedC):
            run_until_boundary(self.module, state)

    def test_lkl_time_request_suspends_and_resumes_explicitly(self):
        state = start_state(self.module, host_imports=(NCCC_IMPORT,))
        waiting = run_until_boundary(self.module, state)
        barrier = decode_nccc(waiting)

        self.assertEqual(barrier.coordinate, (4, 1))
        self.assertEqual(barrier.operation.name, 'time')
        self.assertEqual(barrier.arguments, ())
        self.assertEqual((barrier.input_pointer, barrier.output_pointer),
                         (256, 320))

        resumed = resume_nccc(waiting, (987654321,))
        final = run_until_boundary(self.module, resumed)
        self.assertTrue(final.halted)
        self.assertEqual(final.result, (987654321,))

    def test_host_result_shape_is_checked_before_memory_changes(self):
        waiting = run_until_boundary(
            self.module,
            start_state(self.module, host_imports=(NCCC_IMPORT,)))
        before = waiting.memory
        with self.assertRaises(WasmStateError):
            resume_nccc(waiting, ())
        self.assertIs(waiting.memory, before)

    def test_unknown_lkl_operations_are_named(self):
        module = decode_module(nccc_time_module(group=9, operation=7))
        waiting = run_until_boundary(
            module, start_state(module, host_imports=(NCCC_IMPORT,)))
        with self.assertRaisesRegex(WasmStateError, '9:7'):
            decode_nccc(waiting)

    def waiting(self, group, operation, arguments=()):
        module = decode_module(nccc_time_module(group, operation, arguments))
        state = start_state(module, host_imports=(NCCC_IMPORT,))
        return module, run_until_boundary(module, state)

    def test_immediate_host_state_is_explicit_and_directly_addressed(self):
        module, waiting = self.waiting(1, 1, (2,))
        transition = step_nccc(waiting)
        final = run_until_boundary(module, transition.machine)
        handle = final.result[0]
        self.assertEqual(handle, 2)
        self.assertEqual(transition.host.objects[handle].kind, 'semaphore')
        self.assertEqual(transition.host.objects[handle].values, (2,))

    def test_empty_semaphore_is_a_scheduler_boundary(self):
        module, allocate = self.waiting(1, 1, (0,))
        allocated = step_nccc(allocate)
        handle = run_until_boundary(module, allocated.machine).result[0]
        _module, down = self.waiting(1, 4, (handle,))
        blocked = step_nccc(down, allocated.host)
        self.assertTrue(blocked.blocked)
        self.assertIs(blocked.machine, down)
        self.assertEqual(blocked.event, ('semaphore', handle))

    def test_guest_allocator_grows_memory_without_ambient_allocation(self):
        module, waiting = self.waiting(3, 1, (70000,))
        before = len(waiting.memory)
        transition = step_nccc(waiting, LinuxHostState())
        final = run_until_boundary(module, transition.machine)
        pointer = final.result[0]
        self.assertGreaterEqual(pointer, before)
        self.assertGreaterEqual(len(final.memory), pointer + 70000)

    def test_clock_is_an_input_state_not_a_host_read(self):
        module, waiting = self.waiting(4, 1)
        transition = step_nccc(waiting, LinuxHostState(clock_ns=123456))
        final = run_until_boundary(module, transition.machine)
        self.assertEqual(final.result, (123456,))

    def test_kernel_regions_are_logical_until_touched(self):
        module, machine = self.waiting(4, 1)
        pages_before = machine.memory.pages
        prepared, host = prepare_linux_memory(
            machine, LinuxHostState(), pool_pages=2, stack_pages=3)
        self.assertEqual(len(prepared.memory), len(machine.memory) + 5 * 65536)
        self.assertEqual(prepared.memory.pages, pages_before)
        self.assertEqual(host.heap_pointer, len(machine.memory))
        self.assertEqual(host.heap_limit, len(machine.memory) + 2 * 65536)

        host, stack_pointer = allocate_thread_stack(host, pages=1)
        self.assertEqual(stack_pointer, host.heap_limit + 65536 - 256)
        self.assertEqual(prepared.memory.pages, pages_before)


class TestDirectPageStore(unittest.TestCase):
    def setUp(self):
        self.loaded = []
        self.written = []

        def load(offset, length):
            self.loaded.append((offset, length))
            return bytes((offset + index) & 255 for index in range(length))

        def write(offset, payload):
            self.written.append((offset, bytes(payload)))

        self.store = DirectPageStore(16 * 13 + 3, load, write,
                                     page_size=16, span_pages=4)

    def test_only_touched_pages_become_resident(self):
        self.assertEqual(self.store.read(15, 4), bytes((15, 16, 17, 18)))
        self.assertEqual(self.loaded, [(0, 16), (16, 16)])
        self.assertEqual(self.store.resident_pages, 2)
        self.assertEqual(self.store.resident_bytes, 32)

        self.store.evict_span(0)
        self.assertEqual(self.store.resident_pages, 0)

    def test_full_page_write_needs_no_backing_read(self):
        payload = b'x' * 16
        self.store.write(5 * 16, payload)
        self.assertEqual(self.loaded, [])
        self.assertEqual(self.store.dirty_pages, 1)
        self.assertEqual(self.store.read(5 * 16, 16), payload)

        self.assertEqual(self.store.flush_span(1, drop=True), 1)
        self.assertEqual(self.written, [(5 * 16, payload)])
        self.assertEqual(self.store.dirty_pages, 0)
        self.assertEqual(self.store.resident_pages, 0)

    def test_dirty_spans_must_be_flushed_before_eviction(self):
        self.store.write(1, b'changed')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            self.store.evict_span(0)
        self.store.flush_span(0)
        self.store.evict_span(0)
        self.assertEqual(self.store.resident_pages, 0)

    def test_last_partial_page_is_range_checked(self):
        self.assertEqual(len(self.store.page(13)), 16)
        self.assertEqual(self.store.read(self.store.length - 3, 3),
                         bytes((208, 209, 210)))
        with self.assertRaises(ValueError):
            self.store.read(self.store.length - 2, 3)


if __name__ == '__main__':
    unittest.main()
