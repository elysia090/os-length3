"""Coordinate a user Wasm continuation with a retained LKL kernel state.

The user module and kernel have separate globals, tables, and call frames, but
share one immutable linear-memory snapshot. User syscalls suspend at an import,
enter the kernel's exported syscall state machine, and resume with its result.
The same boundary can front an x86 state-step engine because no Wasm frame is
part of the syscall ABI.
"""

from dataclasses import dataclass, replace
import struct

from qm.wasmstate import (I32, WasmStateError, decode_module, resume_host,
                          start_state)
from qm.wasmwave import WaveCost, WaveExecutor

from .host import allocate_host_memory


TLS_IMPORT = ('env', 'wasmlinux_tlsrw32')
SYSCALL_IMPORT = ('env', 'wasmlinux_syscall32')
CLONE_IMPORT = ('env', 'wasmlinux_clone32')
SETJMP_IMPORTS = (
    ('wasmlinux_hooks', 'setjmp'),
    ('wasmlinux_hooks', 'sigsetjmp'),
)
LONGJMP_IMPORT = ('wasmlinux_hooks', 'longjmp')
USER_IMPORTS = (
    TLS_IMPORT,
    SYSCALL_IMPORT,
    CLONE_IMPORT,
    ('wasmlinux_hooks', 'vfork'),
    ('wasmlinux_hooks', 'setjmp'),
    ('wasmlinux_hooks', 'longjmp'),
    ('wasmlinux_hooks', 'sigsetjmp'),
)

USER_DATA_BYTES = 199980
USER_STACK_BYTES = 1 << 20
USER_TABLE_SLOTS = 1024
DEFAULT_ENV = ('PATH=/bin:/sbin:/usr/bin:/usr/sbin',)
_U32 = struct.Struct('<I')


@dataclass(frozen=True)
class ProcessState:
    kernel: object
    user: object
    tls: int = 0
    syscall: object = None
    contexts: tuple = (None,)


@dataclass(frozen=True)
class ProcessEvent:
    domain: str
    operation: str
    action: str
    cost: WaveCost = WaveCost()
    detail: object = None
    thread: int = 0


@dataclass(frozen=True)
class UserLayout:
    data_pointer: int
    data_bytes: int
    stack_pointer: int
    stack_bytes: int
    environment_pointer: int
    environment_bytes: int
    table_slots: int


@dataclass(frozen=True)
class UserLaunch:
    coordinator: object
    state: ProcessState
    module: object
    layout: UserLayout
    relocation_cost: WaveCost


def environment_image(pointer, argv, envp=DEFAULT_ENV):
    """Build musl's argc/argv/envp block using absolute wasm32 pointers."""
    pointer = int(pointer)
    argv = tuple(str(value).encode('utf-8') for value in argv)
    envp = tuple(str(value).encode('utf-8') for value in envp)
    if any(b'\0' in value for value in argv + envp):
        raise ValueError('argv and envp entries cannot contain NUL bytes')

    words = 1 + len(argv) + 1 + len(envp) + 1
    strings_at = pointer + words * _U32.size
    values = [len(argv)]
    strings = bytearray()
    for value in argv:
        values.append(strings_at + len(strings))
        strings.extend(value + b'\0')
    values.append(0)
    for value in envp:
        values.append(strings_at + len(strings))
        strings.extend(value + b'\0')
    values.append(0)
    return b''.join(_U32.pack(value & I32) for value in values) + bytes(strings)


def prepare_user_process(kernel_scheduler, kernel_state, wasm,
                         argv=('/init',), envp=DEFAULT_ENV,
                         data_bytes=USER_DATA_BYTES,
                         stack_bytes=USER_STACK_BYTES,
                         table_slots=USER_TABLE_SLOTS,
                         relocation_budget=1 << 20):
    """Instantiate a WasmLinux side module over the retained kernel memory.

    The reference runner gives each user image a private data allocation,
    stack global and function table while sharing the kernel linear memory.
    Data relocations run once as ordinary dependency waves; ``_start_c`` then
    remains a resumable user continuation in front of the kernel syscall ABI.
    """
    data_bytes = int(data_bytes)
    stack_bytes = int(stack_bytes)
    table_slots = int(table_slots)
    if data_bytes <= 0 or stack_bytes <= 0 or table_slots <= 0:
        raise ValueError('user data, stack, and table sizes must be positive')

    host, data_pointer = allocate_host_memory(
        kernel_state.host, data_bytes, alignment=16)
    host, stack_base = allocate_host_memory(
        host, stack_bytes, alignment=16)
    environment_bytes = len(environment_image(0, argv, envp))
    host, environment_pointer = allocate_host_memory(
        host, environment_bytes, alignment=16)
    kernel_state = replace(kernel_state, host=host)

    imports = {
        ('env', 'memory'): kernel_state.memory,
        ('env', '__indirect_function_table'): (None,) * table_slots,
        ('env', '__memory_base'): data_pointer,
        ('env', '__stack_pointer'): stack_base + stack_bytes,
        ('env', '__table_base'): 0,
    }
    module = decode_module(bytes(wasm), imports)
    memory = module.memory.write(
        environment_pointer,
        environment_image(environment_pointer, argv, envp))

    executor = WaveExecutor(module)
    relocated = start_state(
        module, '__wasm_apply_data_relocs', host_imports=USER_IMPORTS)
    relocated = replace(relocated, memory=memory)
    relocated, relocation_cost = executor.run_with_report(
        relocated, budget=int(relocation_budget))
    if not relocated.halted:
        request = relocated.waiting
        identity = ((request.module, request.name) if request is not None
                    else ('unknown', 'boundary'))
        raise WasmStateError('user data relocation stopped at %s.%s'
                             % identity)

    user = start_state(
        module, '_start_c', (environment_pointer,), run_start=False,
        host_imports=USER_IMPORTS)
    user = replace(user, globals=relocated.globals,
                   memory=relocated.memory)
    kernel_state = replace(kernel_state, memory=relocated.memory)
    coordinator = ProcessCoordinator(kernel_scheduler, module, executor)
    layout = UserLayout(
        data_pointer, data_bytes, stack_base + stack_bytes, stack_bytes,
        environment_pointer, environment_bytes, table_slots)
    return UserLaunch(
        coordinator, ProcessState(kernel_state, user), module, layout,
        relocation_cost)


class ProcessCoordinator(object):
    """One user continuation in front of one cooperative kernel scheduler."""

    def __init__(self, kernel_scheduler, user_module, user_executor=None):
        self.kernel_scheduler = kernel_scheduler
        self.user_module = user_module
        self.user_executor = (WaveExecutor(user_module)
                              if user_executor is None else user_executor)

    def _user_boundary(self, state, cost):
        request = state.user.waiting
        if request is None:
            raise WasmStateError('user machine has no import barrier')
        identity = (request.module, request.name)
        arguments = tuple(map(int, request.args))

        if identity == TLS_IMPORT:
            if len(arguments) != 2:
                raise WasmStateError('wasmlinux_tlsrw32 expects op and value')
            operation, value = arguments
            if operation == 0:
                tls = value & I32
                user = resume_host(state.user, (0,))
                action, detail = 'set', tls
            elif operation == 1:
                tls = state.tls
                user = resume_host(state.user, (tls,))
                action, detail = 'read', tls
            else:
                raise WasmStateError('unknown wasmlinux_tlsrw32 operation %d'
                                     % operation)
            return replace(state, user=user, tls=tls), ProcessEvent(
                'user', 'tls', action, cost, detail)

        if identity == SYSCALL_IMPORT:
            if len(arguments) != 3:
                raise WasmStateError(
                    'wasmlinux_syscall32 expects argc, number, and args pointer')
            argc, number, pointer = arguments
            kernel = replace(state.kernel, memory=state.user.memory)
            kernel = self.kernel_scheduler.invoke(
                kernel, 'syscall', (number & I32, argc & I32, pointer & I32))
            pending = (argc & I32, number & I32, pointer & I32)
            return replace(state, kernel=kernel, syscall=pending), ProcessEvent(
                'user', 'syscall', 'entered', cost, pending)

        if identity in SETJMP_IMPORTS:
            expected = 1 if identity[1] == 'setjmp' else 2
            if len(arguments) != expected:
                raise WasmStateError('%s expects %d argument(s)'
                                     % (identity[1], expected))
            pointer = arguments[0] & I32
            token = len(state.contexts)
            waiting = state.user
            memory = waiting.memory.write(pointer, _U32.pack(token))
            waiting = replace(waiting, memory=memory)
            user = resume_host(waiting, (0,))
            kernel = replace(state.kernel, memory=memory)
            contexts = state.contexts + (waiting,)
            return replace(state, kernel=kernel, user=user,
                           contexts=contexts), ProcessEvent(
                               'user', identity[1], 'saved', cost,
                               (pointer, token))

        if identity == LONGJMP_IMPORT:
            if len(arguments) != 2:
                raise WasmStateError('longjmp expects buffer and value')
            pointer, value = arguments
            token = _U32.unpack(state.user.memory.read(pointer & I32, 4))[0]
            if token <= 0 or token >= len(state.contexts) \
                    or state.contexts[token] is None:
                raise WasmStateError('longjmp has an unknown context token')
            waiting = replace(state.contexts[token], memory=state.user.memory)
            result = (value & I32) or 1
            user = resume_host(waiting, (result,))
            kernel = replace(state.kernel, memory=user.memory)
            return replace(state, kernel=kernel, user=user), ProcessEvent(
                'user', 'longjmp', 'jumped', cost,
                (pointer & I32, token, result))

        return state, ProcessEvent('user', '%s.%s' % identity, 'blocked',
                                   cost, arguments)

    def _kernel_step(self, state, budget):
        kernel, boundary = self.kernel_scheduler.step(state.kernel,
                                                       budget=budget)
        user = replace(state.user, memory=kernel.memory)
        thread = kernel.thread(1)
        if thread.status != 'halted':
            return replace(state, kernel=kernel, user=user), ProcessEvent(
                'kernel', boundary.operation, boundary.action,
                boundary.cost, boundary.detail, boundary.thread)

        _argc, number, _pointer = state.syscall
        result = int(thread.result) & I32
        user = resume_host(user, (result,))
        next_state = replace(state, kernel=kernel, user=user, syscall=None)
        return next_state, ProcessEvent(
            'kernel', 'syscall', 'returned', boundary.cost, (number, result),
            boundary.thread)

    def step(self, state, budget=1 << 20):
        """Advance user or kernel to one visible cross-module boundary."""
        if state.syscall is not None:
            return self._kernel_step(state, budget)
        if state.user.waiting is not None:
            return self._user_boundary(state, WaveCost())
        if state.user.halted:
            return state, ProcessEvent('user', 'return', 'halted',
                                       detail=state.user.result)

        user, cost, reached = self.user_executor.run_quantum_with_report(
            state.user, budget)
        kernel = replace(state.kernel, memory=user.memory)
        state = replace(state, kernel=kernel, user=user)
        if not reached:
            frame = user.frames[-1]
            return state, ProcessEvent('user', 'timeslice', 'yielded', cost,
                                       (frame.function, frame.pc))
        if user.halted:
            return state, ProcessEvent('user', 'return', 'halted', cost,
                                       user.result)
        return self._user_boundary(state, cost)
