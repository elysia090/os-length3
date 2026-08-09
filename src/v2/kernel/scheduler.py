"""Deterministic cooperative threads for a Linux kernel in WebAssembly.

Every thread owns its call frames and mutable globals. Linear memory and host
objects are shared explicitly by the scheduler. A scheduling step runs one
thread to its next host boundary, resolves an immediate request, or records the
continuation that must wait. No operating-system thread or ambient event loop
is involved.
"""

from dataclasses import dataclass, replace
import struct

from qm.wasmstate import WasmStateError, start_state
from qm.wasmwave import WaveCost, WaveExecutor

from .host import (HostObject, LinuxHostState, allocate_thread_stack,
                   decode_nccc, resume_nccc, step_nccc)


@dataclass(frozen=True)
class KernelThread:
    handle: int
    machine: object
    status: str = 'ready'
    wait: object = None
    detached: bool = False
    result: int = 0


@dataclass(frozen=True)
class KernelContext:
    owner: int
    continuation: object


@dataclass(frozen=True)
class SchedulerState:
    threads: tuple
    ready: tuple
    memory: object
    host: LinuxHostState
    contexts: tuple = (None,)

    def thread(self, handle):
        handle = int(handle)
        if handle <= 0 or handle >= len(self.threads):
            raise WasmStateError('kernel thread %d is not allocated' % handle)
        thread = self.threads[handle]
        if thread is None:
            raise WasmStateError('kernel thread %d is not live' % handle)
        return thread

    @property
    def stopped(self):
        return not self.ready


@dataclass(frozen=True)
class SchedulerEvent:
    thread: int
    operation: str
    action: str
    cost: WaveCost = WaveCost()
    detail: object = None


def start_scheduler(machine, host=None):
    """Create a scheduler around the thread that entered the kernel."""
    host = LinuxHostState() if host is None else host
    if len(host.objects) <= 1 or host.objects[1] is None:
        raise WasmStateError('kernel host has no initial thread object')
    if host.objects[1].kind != 'thread':
        raise WasmStateError('kernel host object 1 is not a thread')
    host = replace(host, current_thread=1)
    thread = KernelThread(1, machine)
    return SchedulerState((None, thread), (1,), machine.memory, host)


class KernelScheduler(object):
    """Round-robin state machine over Wasm continuations."""

    def __init__(self, module, executor=None, stack_global=None):
        self.module = module
        self.executor = WaveExecutor(module) if executor is None else executor
        if stack_global is None:
            mutable = tuple(index for index, enabled
                            in enumerate(module.global_mutable) if enabled)
            stack_global = mutable[0] if len(mutable) == 1 else None
        self.stack_global = stack_global

    @staticmethod
    def _replace_thread(state, thread):
        threads = list(state.threads)
        threads[thread.handle] = thread
        return replace(state, threads=tuple(threads))

    @staticmethod
    def _queue(state, *handles):
        ready = list(state.ready)
        for handle in handles:
            if handle not in ready:
                ready.append(handle)
        return replace(state, ready=tuple(ready))

    @staticmethod
    def _host_for(state, handle):
        return replace(state.host, current_thread=handle)

    def _spawn_thread(self, state, template, slot, argument, detached=False):
        """Create one cooperative continuation over the shared memory."""
        slot, argument = int(slot), int(argument)
        if not self.module.tables or slot < 0 or slot >= len(self.module.tables[0]):
            raise WasmStateError('thread_create table slot %d is outside table 0'
                                 % slot)
        function = self.module.tables[0][slot]
        if function is None:
            raise WasmStateError('thread_create selected an empty table slot')
        ftype = self.module.types[self.module.functions[function].type_index]
        if ftype.params != ('i32',) or ftype.results:
            raise WasmStateError('thread_create target must have type (i32) -> ()')
        if self.stack_global is None:
            raise WasmStateError('thread_create needs one explicit stack global')

        host, stack_pointer = allocate_thread_stack(
            self._host_for(state, template.handle))
        handle = len(host.objects)
        host = replace(host, objects=host.objects + (HostObject('thread'),))
        child = start_state(
            self.module, function, (argument,), run_start=False,
            host_imports=template.machine.host_imports)
        globals_ = list(template.machine.globals)
        globals_[self.stack_global] = stack_pointer
        child = replace(child, globals=tuple(globals_), memory=state.memory)
        state = replace(state, host=host)
        threads = list(state.threads)
        threads.extend([None] * (handle + 1 - len(threads)))
        threads[handle] = KernelThread(handle, child, detached=detached)
        state = replace(state, threads=tuple(threads))
        return state, handle

    def _create_thread(self, state, parent, arguments):
        if len(arguments) != 2:
            raise WasmStateError('thread_create expects a table slot and argument')
        state, handle = self._spawn_thread(
            state, parent, arguments[0], arguments[1])
        parent = replace(
            parent,
            machine=resume_nccc(parent.machine, (handle,)),
            status='ready', wait=None)
        state = self._replace_thread(state, parent)
        child = state.thread(handle)
        child = replace(child, machine=replace(
            child.machine, memory=parent.machine.memory))
        state = replace(self._replace_thread(state, child),
                        memory=parent.machine.memory)
        return self._queue(state, parent.handle, handle), handle

    def _fire_next_timer(self, state):
        armed = []
        for handle, obj in enumerate(state.host.objects):
            if obj is None or obj.kind != 'timer':
                continue
            function, argument, deadline = obj.values
            if deadline is not None:
                armed.append((int(deadline), handle,
                              int(function), int(argument)))
        if not armed:
            return state, None

        deadline, timer, function, argument = min(armed)
        objects = list(state.host.objects)
        objects[timer] = HostObject('timer', (function, argument, None))
        host = replace(state.host, objects=tuple(objects),
                       clock_ns=max(state.host.clock_ns, deadline))
        state = replace(state, host=host)
        state, handle = self._spawn_thread(
            state, state.thread(1), function, argument, detached=True)
        return self._queue(state, handle), SchedulerEvent(
            handle, 'timer_fire', 'created',
            detail=(timer, deadline))

    def _thread_boundary(self, state, thread, barrier):
        operation = barrier.operation.name
        arguments = barrier.arguments
        if operation == 'thread_create':
            state, handle = self._create_thread(state, thread, arguments)
            return state, SchedulerEvent(thread.handle, operation, 'created',
                                         detail=handle)
        if operation == 'thread_detach':
            machine = resume_nccc(thread.machine)
            thread = replace(thread, machine=machine, detached=True,
                             status='ready', wait=None)
            state = self._replace_thread(state, thread)
            return self._queue(state, thread.handle), SchedulerEvent(
                thread.handle, operation, 'resumed')
        if operation == 'thread_exit':
            thread = replace(thread, status='halted', wait=None, result=0)
            return self._replace_thread(state, thread), SchedulerEvent(
                thread.handle, operation, 'halted')
        if operation == 'thread_join':
            target = state.thread(arguments[0])
            if target.status == 'halted':
                machine = resume_nccc(thread.machine, (target.result,))
                thread = replace(thread, machine=machine, status='ready',
                                 wait=None)
                state = self._replace_thread(state, thread)
                return self._queue(state, thread.handle), SchedulerEvent(
                    thread.handle, operation, 'resumed', detail=target.handle)
        thread = replace(thread, status='blocked',
                         wait=('thread', operation, arguments))
        return self._replace_thread(state, thread), SchedulerEvent(
            thread.handle, operation, 'blocked', detail=arguments)

    def _context_boundary(self, state, thread, barrier):
        operation = barrier.operation.name
        arguments = tuple(map(int, barrier.arguments))
        if operation == 'jmp_buf_set':
            pointer, slot, size = arguments
            if size < 8:
                raise WasmStateError('LKL jump buffer is smaller than its token')
            if not self.module.tables or slot < 0 \
                    or slot >= len(self.module.tables[0]):
                raise WasmStateError('jmp_buf_set table slot %d is outside table 0'
                                     % slot)
            function = self.module.tables[0][slot]
            if function is None:
                raise WasmStateError('jmp_buf_set selected an empty table slot')
            ftype = self.module.types[self.module.functions[function].type_index]
            if ftype.params or ftype.results:
                raise WasmStateError('jmp_buf_set target must have type () -> ()')

            token = len(state.contexts)
            continuation = resume_nccc(
                thread.machine,
                memory_writes=((pointer, struct.pack('<Q', token)),))
            called = start_state(
                self.module, function, (), run_start=False,
                host_imports=thread.machine.host_imports)
            called = replace(called, globals=continuation.globals,
                             memory=continuation.memory)
            context = KernelContext(thread.handle, continuation)
            thread = replace(thread, machine=called, status='ready', wait=None)
            state = replace(self._replace_thread(state, thread),
                            memory=called.memory,
                            contexts=state.contexts + (context,))
            return self._queue(state, thread.handle), SchedulerEvent(
                thread.handle, operation, 'entered', detail=token)

        pointer, value = arguments
        raw = thread.machine.memory.read(pointer, 8)
        token = struct.unpack('<Q', raw)[0]
        if token <= 0 or token >= len(state.contexts) \
                or state.contexts[token] is None:
            raise WasmStateError('jmp_buf_longjmp has an unknown context token')
        context = state.contexts[token]
        if context.owner != thread.handle:
            raise WasmStateError('jmp_buf_longjmp crosses scheduler threads')
        machine = replace(context.continuation, memory=thread.machine.memory)
        thread = replace(thread, machine=machine, status='ready', wait=None)
        contexts = list(state.contexts)
        contexts[token] = None
        state = replace(self._replace_thread(state, thread),
                        memory=machine.memory, contexts=tuple(contexts))
        return self._queue(state, thread.handle), SchedulerEvent(
            thread.handle, operation, 'jumped', detail=(token, value))

    def _wake_waiters(self, state):
        for thread in state.threads[1:]:
            if thread is None or thread.status != 'blocked':
                continue
            machine = replace(thread.machine, memory=state.memory)
            thread = replace(thread, machine=machine)
            wait = thread.wait or ()
            if wait[:2] == ('thread', 'thread_join'):
                target = state.thread(wait[2][0])
                if target.status != 'halted':
                    continue
                machine = resume_nccc(machine, (target.result,))
                thread = replace(thread, machine=machine, status='ready',
                                 wait=None)
                state = self._replace_thread(state, thread)
                state = self._queue(state, thread.handle)
                continue
            if wait and wait[0] in ('semaphore', 'mutex'):
                transition = step_nccc(machine,
                                       self._host_for(state, thread.handle))
                if transition.blocked:
                    continue
                thread = replace(thread, machine=transition.machine,
                                 status='ready', wait=None)
                state = replace(state, host=transition.host,
                                memory=transition.machine.memory)
                state = self._replace_thread(state, thread)
                state = self._queue(state, thread.handle)
        return state

    def invoke(self, state, function, arguments=(), handle=1):
        """Enter an exported kernel function using the existing VM snapshot.

        This is the state-machine equivalent of calling a second C entry point:
        globals, sparse linear memory, host objects, and sleeping kernel threads
        survive, while the selected thread receives a fresh Wasm call stack.
        """
        previous = state.thread(handle)
        if previous.status != 'halted':
            raise WasmStateError('kernel thread %d is not halted' % handle)
        machine = start_state(
            self.module, function, tuple(arguments), run_start=False,
            host_imports=previous.machine.host_imports)
        machine = replace(machine, globals=previous.machine.globals,
                          memory=state.memory)
        thread = replace(previous, machine=machine, status='ready', wait=None,
                         result=0)
        state = self._replace_thread(state, thread)
        return self._queue(state, handle)

    def step(self, state, budget=1 << 21):
        """Advance one ready thread through one externally visible boundary."""
        state = self._wake_waiters(state)
        if not state.ready:
            state, event = self._fire_next_timer(state)
            if event is not None:
                return state, event
            return state, SchedulerEvent(0, 'scheduler', 'stalled')

        handle, ready = state.ready[0], state.ready[1:]
        thread = state.thread(handle)
        machine = replace(thread.machine, memory=state.memory)
        thread = replace(thread, machine=machine, status='running', wait=None)
        state = replace(self._replace_thread(state, thread), ready=ready,
                        host=self._host_for(state, handle))

        cost = WaveCost()
        if machine.waiting is None and not machine.halted:
            machine, cost, reached = self.executor.run_quantum_with_report(
                machine, budget)
            thread = replace(thread, machine=machine)
            state = replace(self._replace_thread(state, thread),
                            memory=machine.memory)
            if not reached:
                thread = replace(thread, status='ready')
                state = self._queue(self._replace_thread(state, thread), handle)
                frame = machine.frames[-1]
                return state, SchedulerEvent(handle, 'timeslice', 'yielded',
                                             cost,
                                             (frame.function, frame.pc))

        if machine.halted:
            result = int(machine.result[0]) if machine.result else 0
            thread = replace(thread, status='halted', result=result)
            state = self._replace_thread(state, thread)
            state = self._wake_waiters(state)
            return state, SchedulerEvent(handle, 'return', 'halted', cost,
                                         result)

        barrier = decode_nccc(machine)
        transition = step_nccc(machine, self._host_for(state, handle))
        if transition.blocked and transition.event \
                and transition.event[0] == 'thread':
            state, event = self._thread_boundary(state, thread, barrier)
            state = replace(state, memory=state.thread(handle).machine.memory)
            return self._wake_waiters(state), replace(event, cost=cost)
        if transition.blocked and transition.event \
                and transition.event[0] == 'context':
            state, event = self._context_boundary(state, thread, barrier)
            return self._wake_waiters(state), replace(event, cost=cost)
        if transition.blocked:
            thread = replace(thread, status='blocked', wait=transition.event)
            state = replace(self._replace_thread(state, thread),
                            host=transition.host, memory=machine.memory)
            return state, SchedulerEvent(handle, barrier.operation.name,
                                         'blocked', cost, transition.event)

        thread = replace(thread, machine=transition.machine, status='ready')
        state = replace(self._replace_thread(state, thread),
                        host=transition.host,
                        memory=transition.machine.memory)
        state = self._queue(state, handle)
        state = self._wake_waiters(state)
        return state, SchedulerEvent(handle, barrier.operation.name,
                                     'resumed', cost, transition.event)
