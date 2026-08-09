"""Cross-module state steps between a user continuation and LKL."""

from dataclasses import replace
import struct
from types import SimpleNamespace
import unittest

from kernel.process import (ProcessCoordinator, ProcessState, USER_IMPORTS,
                            environment_image)
from kernel.scheduler import KernelScheduler, start_scheduler
from kernel.run import _process_stopped
from qm.wasmstate import (Function, FunctionType, HostRequest, Instruction, Module,
                          PagedMemory, start_state)


def function(type_index, *instructions, **imported):
    code = tuple(Instruction(op, args) for op, args in instructions)
    return Function(type_index, code=code, ends=(-1,) * len(code),
                    elses=(-1,) * len(code), **imported)


def machines():
    memory = PagedMemory(b'', 65536).write(400, struct.pack('<I', 77))
    kernel_types = (
        FunctionType((), ()),
        FunctionType(('i32', 'i32', 'i32'), ('i32',)),
    )
    kernel_functions = (
        function(0, ('end', ())),
        function(1, ('local.get', (2,)),
                 ('i32.load', (2, 0, 4, False)), ('end', ())),
    )
    kernel_module = Module(
        kernel_types, kernel_functions, (), (), memory, None,
        (('init', 0, 0), ('syscall', 0, 1)))
    scheduler = KernelScheduler(kernel_module)
    kernel = start_scheduler(start_state(kernel_module, 'init'))
    kernel, _event = scheduler.step(kernel)

    user_types = (
        FunctionType(('i32', 'i32'), ('i32',)),
        FunctionType(('i32', 'i32', 'i32'), ('i32',)),
        FunctionType((), ('i32',)),
    )
    user_functions = (
        Function(0, imported=True, module='env', name='wasmlinux_tlsrw32'),
        Function(1, imported=True, module='env', name='wasmlinux_syscall32'),
        function(2,
                 ('i32.const', (0,)), ('i32.const', (123,)),
                 ('call', (0,)), ('drop', ()),
                 ('i32.const', (1,)), ('i32.const', (96,)),
                 ('i32.const', (400,)), ('call', (1,)), ('end', ())),
    )
    user_module = Module(user_types, user_functions, (), (), memory, None,
                         (('main', 0, 2),))
    user = start_state(user_module, host_imports=USER_IMPORTS)
    return scheduler, kernel, user_module, user


class TestProcessCoordinator(unittest.TestCase):
    def test_a_blocked_kernel_thread_does_not_stop_the_process(self):
        process = SimpleNamespace(user=SimpleNamespace(halted=False))
        mutex = SimpleNamespace(
            domain='kernel', operation='mutex_lock', action='blocked')
        stalled = SimpleNamespace(
            domain='kernel', operation='scheduler', action='stalled')
        user_hook = SimpleNamespace(
            domain='user', operation='wasmlinux_hooks.vfork',
            action='blocked')

        self.assertFalse(_process_stopped(process, mutex))
        self.assertTrue(_process_stopped(process, stalled))
        self.assertTrue(_process_stopped(process, user_hook))

    def test_environment_image_is_musls_absolute_pointer_layout(self):
        pointer = 0x1000
        payload = environment_image(
            pointer, ('/init', '-s'), ('PATH=/bin', 'TERM=dumb'))
        words = struct.unpack_from('<7I', payload)

        self.assertEqual(words[0], 2)
        self.assertEqual(words[3], 0)
        self.assertEqual(words[6], 0)
        self.assertEqual(payload[words[1] - pointer:].split(b'\0', 1)[0],
                         b'/init')
        self.assertEqual(payload[words[2] - pointer:].split(b'\0', 1)[0],
                         b'-s')
        self.assertEqual(payload[words[4] - pointer:].split(b'\0', 1)[0],
                         b'PATH=/bin')
        self.assertEqual(payload[words[5] - pointer:].split(b'\0', 1)[0],
                         b'TERM=dumb')

    def test_tls_and_syscall_are_explicit_cross_module_boundaries(self):
        scheduler, kernel, user_module, user = machines()
        coordinator = ProcessCoordinator(scheduler, user_module)
        state = ProcessState(kernel, user)

        state, event = coordinator.step(state)
        self.assertEqual((event.domain, event.operation, event.action,
                          event.detail), ('user', 'tls', 'set', 123))
        self.assertEqual(state.tls, 123)

        state, event = coordinator.step(state)
        self.assertEqual((event.domain, event.operation, event.action),
                         ('user', 'syscall', 'entered'))
        self.assertEqual(state.syscall, (1, 96, 400))

        state, event = coordinator.step(state)
        self.assertEqual((event.domain, event.operation, event.action,
                          event.detail),
                         ('kernel', 'syscall', 'returned', (96, 77)))
        self.assertIsNone(state.syscall)

        state, event = coordinator.step(state)
        self.assertEqual((event.operation, event.action), ('return', 'halted'))
        self.assertEqual(state.user.result, (77,))

    def test_an_unimplemented_hook_retains_the_user_continuation(self):
        scheduler, kernel, user_module, user = machines()
        coordinator = ProcessCoordinator(scheduler, user_module)
        waiting = HostRequest('wasmlinux_hooks', 'vfork', 0, (17,))
        user = replace(user, waiting=waiting)
        state = ProcessState(kernel, user)

        same, event = coordinator.step(state)

        self.assertEqual(event.action, 'blocked')
        self.assertIs(same.user.waiting, waiting)

    def test_setjmp_and_longjmp_are_reversible_user_state_steps(self):
        scheduler, kernel, _old_module, _old_user = machines()
        types = (
            FunctionType(('i32',), ('i32',)),
            FunctionType((), ('i32',)),
        )
        functions = (
            Function(0, imported=True, module='wasmlinux_hooks',
                     name='setjmp'),
            function(1, ('i32.const', (128,)), ('call', (0,)),
                     ('end', ())),
        )
        module = Module(types, functions, (), (), kernel.memory, None,
                        (('main', 0, 1),))
        user = start_state(module, host_imports=USER_IMPORTS)
        coordinator = ProcessCoordinator(scheduler, module)
        state = ProcessState(kernel, user)

        state, event = coordinator.step(state)
        self.assertEqual((event.operation, event.action, event.detail),
                         ('setjmp', 'saved', (128, 1)))
        self.assertEqual(struct.unpack('<I', state.user.memory.read(128, 4)),
                         (1,))

        state = replace(
            state,
            user=replace(
                state.user,
                waiting=HostRequest(
                    'wasmlinux_hooks', 'longjmp', 0, (128, 7))))
        state, event = coordinator.step(state)
        self.assertEqual((event.operation, event.action, event.detail),
                         ('longjmp', 'jumped', (128, 1, 7)))

        state, event = coordinator.step(state)
        self.assertEqual((event.operation, event.action), ('return', 'halted'))
        self.assertEqual(state.user.result, (7,))


if __name__ == '__main__':
    unittest.main()
