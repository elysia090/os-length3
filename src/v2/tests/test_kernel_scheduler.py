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


def context_machine():
    types = (FunctionType(('i32', 'i32'), ()), FunctionType((), ()))
    functions = (
        Function(0, imported=True, module='env', name='nccc_call64'),
        Function(1, code=(Instruction('end'),), ends=(-1,), elses=(-1,)),
    )
    memory = PagedMemory(bytes(512), 65536)
    memory = memory.write(64, struct.pack('<5Q', 5, 1, 200, 0, 512))
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

    def test_idle_scheduler_advances_to_the_next_timer_callback(self):
        module, machine, host = thread_create_machine()
        host = replace(
            host,
            objects=host.objects + (HostObject('timer', (0, 7, 100)),))
        state = start_scheduler(machine, host)
        parent = replace(state.thread(1), status='blocked', wait=('idle',))
        state = replace(state, threads=(None, parent), ready=())
        scheduler = KernelScheduler(module)

        state, event = scheduler.step(state)

        self.assertEqual((event.operation, event.action, event.detail),
                         ('timer_fire', 'created', (2, 100)))
        self.assertEqual(state.host.clock_ns, 100)
        self.assertEqual(state.host.objects[2].values, (0, 7, None))
        self.assertEqual(state.thread(3).machine.frames[0].locals[0], 7)
        self.assertTrue(state.thread(3).detached)
        self.assertEqual(state.ready, (3,))

    def test_invoke_reuses_memory_and_globals_after_return(self):
        module, machine, host = thread_create_machine()
        scheduler = KernelScheduler(module)
        state, _event = scheduler.step(start_scheduler(machine, host))
        state, _event = scheduler.step(state)
        self.assertEqual(state.thread(1).status, 'halted')
        memory = state.memory.write(7, b'kernel')
        state = replace(state, memory=memory)

        state = scheduler.invoke(state, 1, (0,))

        self.assertIn(1, state.ready)
        self.assertEqual(state.thread(1).status, 'ready')
        self.assertEqual(state.thread(1).machine.globals, (256,))
        self.assertEqual(state.thread(1).machine.memory.read(7, 6), b'kernel')

    def test_context_barrier_enters_callback_and_longjmp_restores_caller(self):
        module, machine, host = context_machine()
        scheduler = KernelScheduler(module)
        state, event = scheduler.step(start_scheduler(machine, host))

        self.assertEqual((event.operation, event.action),
                         ('jmp_buf_set', 'entered'))
        self.assertEqual(state.thread(1).machine.frames[-1].function, 1)
        token = state.memory.read(200, 8)
        self.assertEqual(struct.unpack('<Q', token)[0], 1)
        continuation = state.contexts[1].continuation

        memory = state.memory.write(300, token)
        memory = memory.write(64, struct.pack('<4Q', 5, 2, 300, 7))
        request = HostRequest('env', 'nccc_call64', 0, (64, 128))
        thread = replace(state.thread(1),
                         machine=replace(state.thread(1).machine,
                                         memory=memory, waiting=request,
                                         halted=False),
                         status='ready')
        state = replace(state, threads=(None, thread), ready=(1,),
                        memory=memory)
        state, event = scheduler.step(state)

        self.assertEqual((event.operation, event.action, event.detail),
                         ('jmp_buf_longjmp', 'jumped', (1, 7)))
        self.assertIsNone(state.contexts[1])
        self.assertEqual(state.thread(1).machine.frames, continuation.frames)


if __name__ == '__main__':
    unittest.main()
