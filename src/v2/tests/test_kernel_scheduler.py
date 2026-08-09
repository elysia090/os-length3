"""Cooperative Linux-in-Wasm scheduler transitions."""

from dataclasses import replace
import struct
import unittest

from kernel.host import (HostObject, LinuxHostState, NCCC_IMPORT,
                         prepare_linux_memory)
from kernel.scheduler import KernelScheduler, start_scheduler
from qm.wasmstate import (Function, FunctionType, HostRequest, Instruction,
                          MachineState, Module, PagedMemory)


def thread_create_machine():
    types = (FunctionType(('i32',), ()),)
    functions = (
        Function(0, imported=True, module='env', name='nccc_call64'),
        Function(0, code=(Instruction('end'),), ends=(-1,), elses=(-1,)),
    )
    memory = PagedMemory(bytes(512), 65536)
    memory = memory.write(64, struct.pack('<4Q', 2, 1, 0, 7))
    module = Module(types, functions, (256,), (True,), memory, None, (),
                    tables=((1,),))
    machine = MachineState(
        (), module.globals, memory,
        waiting=HostRequest('env', 'nccc_call64', 0, (64, 128)),
        host_imports=(NCCC_IMPORT,))
    machine, host = prepare_linux_memory(
        machine, LinuxHostState(), pool_pages=1, stack_pages=20)
    return module, machine, host


class TestKernelScheduler(unittest.TestCase):
    def test_thread_create_copies_globals_but_gives_child_its_own_stack(self):
        module, machine, host = thread_create_machine()
        state = start_scheduler(machine, host)
        state, event = KernelScheduler(module).step(state)

        self.assertEqual((event.operation, event.action, event.detail),
                         ('thread_create', 'created', 2))
        self.assertEqual(state.ready, (1, 2))
        self.assertEqual(state.thread(1).machine.globals, (256,))
        self.assertEqual(state.thread(2).machine.frames[0].locals[0], 7)
        self.assertEqual(state.thread(2).machine.globals,
                         (host.heap_limit + 10 * 65536 - 256,))
        self.assertIs(state.thread(2).machine.memory, state.memory)
        self.assertEqual(state.host.objects[2].kind, 'thread')

    def test_ready_threads_finish_without_an_operating_system_thread(self):
        module, machine, host = thread_create_machine()
        scheduler = KernelScheduler(module)
        state, _event = scheduler.step(start_scheduler(machine, host))
        state, parent = scheduler.step(state)
        state, child = scheduler.step(state)

        self.assertEqual((parent.thread, parent.action), (1, 'halted'))
        self.assertEqual((child.thread, child.action), (2, 'halted'))
        self.assertTrue(state.stopped)
        self.assertEqual(state.thread(2).result, 0)

    def test_thread_handles_share_the_host_object_coordinate_space(self):
        module, machine, host = thread_create_machine()
        host = replace(host, objects=host.objects
                       + (HostObject('semaphore', (0,)),))
        state, event = KernelScheduler(module).step(
            start_scheduler(machine, host))

        self.assertEqual(event.detail, 3)
        self.assertEqual(state.thread(3).handle, 3)
        self.assertIsNone(state.threads[2])

    def test_budget_yields_a_resumable_quantum(self):
        module, machine, host = thread_create_machine()
        scheduler = KernelScheduler(module)
        state, _event = scheduler.step(start_scheduler(machine, host))
        state, _event = scheduler.step(state)
        before = state.thread(2).machine.frames[0].pc
        state, event = scheduler.step(state, budget=0)

        self.assertEqual((event.operation, event.action),
                         ('timeslice', 'yielded'))
        self.assertEqual(state.ready, (2,))
        self.assertEqual(state.thread(2).machine.frames[0].pc, before)


if __name__ == '__main__':
    unittest.main()
