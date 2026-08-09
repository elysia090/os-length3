"""The external event boundary of the Linux-in-Wasm machine."""

import unittest

from kernel.host import (DirectPageStore, LinuxHostState, NCCC_IMPORT,
                         attach_block)
from kernel.machine import LinuxMachine, MachineEvent, machine_step
from qm.wasmstate import decode_module, start_state
from tests.test_linuxhost import nccc_time_module


class TestLinuxMachineStep(unittest.TestCase):
    def start(self, group, operation, arguments=(), host=None):
        module = decode_module(nccc_time_module(group, operation, arguments))
        machine = start_state(module, host_imports=(NCCC_IMPORT,))
        runtime = LinuxMachine(module)
        return runtime, runtime.start(machine, host)

    def test_clock_is_an_explicit_request_and_response(self):
        runtime, state = self.start(4, 1)

        state, request = machine_step(runtime, state)
        self.assertEqual((request.operation, request.coordinate), ('clock', ()))
        self.assertIs(state.pending, request)

        state, boundary = machine_step(
            runtime, state, MachineEvent('clock', data=123456))
        self.assertIsNone(boundary)
        self.assertTrue(state.stopped)
        self.assertEqual(state.scheduler.thread(1).result, 123456)

    def test_clock_response_is_monotonic(self):
        runtime, state = self.start(4, 1, host=LinuxHostState(clock_ns=9))
        state, _request = machine_step(runtime, state)
        with self.assertRaisesRegex(ValueError, 'backwards'):
            machine_step(runtime, state, MachineEvent('clock', data=8))

    def test_block_fault_names_exact_device_and_page(self):
        store = DirectPageStore(8192, page_size=4096, event_backed=True)
        host, device = attach_block(LinuxHostState(), store)
        runtime, state = self.start(6, 2, (device, 4090, 512, 24), host)

        state, first = machine_step(runtime, state)
        self.assertEqual((first.operation, first.coordinate),
                         ('block_read', (0, 0)))
        state, second = machine_step(
            runtime, state,
            MachineEvent('block_read', (0, 0), bytes(4096)))
        self.assertEqual((second.operation, second.coordinate),
                         ('block_read', (0, 1)))
        page = bytes((index & 255) for index in range(4096))
        state, boundary = machine_step(
            runtime, state, MachineEvent('block_read', (0, 1), page))

        self.assertIsNone(boundary)
        self.assertTrue(state.stopped)
        memory = state.scheduler.thread(1).machine.memory
        self.assertEqual(memory.read(512, 24), bytes(6) + page[:18])

    def test_internal_lkl_host_work_does_not_escape_machine_step(self):
        runtime, state = self.start(1, 1, (2,))
        state, boundary = machine_step(runtime, state)
        self.assertIsNone(boundary)
        self.assertTrue(state.stopped)
        self.assertEqual(state.scheduler.thread(1).result, 2)

    def test_full_page_guest_write_emits_one_cow_page_coordinate(self):
        store = DirectPageStore(4096, page_size=4096, event_backed=True)
        host, device = attach_block(LinuxHostState(), store, read_only=False)
        runtime, state = self.start(6, 3, (device, 0, 512, 4096), host)

        state, event = machine_step(runtime, state)

        self.assertEqual((event.operation, event.coordinate),
                         ('block_write', (0, 0)))
        self.assertEqual(event.data, bytes(4096))
        self.assertEqual((store.backing_pages, store.cow_pages,
                          store.dirty_pages), (0, 1, 1))
        state, event = machine_step(runtime, state)
        self.assertIsNone(event)
        self.assertTrue(state.stopped)


if __name__ == '__main__':
    unittest.main()
