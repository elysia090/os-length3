"""Browser-facing sessions for the Linux-in-WebAssembly state machine.

The JavaScript worker owns network and clock access. Python retains only the
decoded kernel, the current machine continuation, reached physical state-step
pages, and directly addressed root-device pages. Each call advances to one
external event, making block fetches and replay explicit.
"""

import base64
from dataclasses import dataclass
import json
import struct
import sys

from qm.wasmstate import decode_module, start_state
from qm.wasmwave import WaveExecutor

from .host import (DirectPageStore, LinuxHostState, NCCC_IMPORT, attach_block,
                   prepare_linux_memory)
from .machine import LinuxMachine, MachineEvent, MachineState


@dataclass
class BrowserSession:
    runtime: LinuxMachine
    state: MachineState
    executor: WaveExecutor

    def step(self, event=None, budget=1 << 21, max_internal=1024):
        self.state, boundary = self.runtime.machine_step(
            self.state, event, budget=budget, max_internal=max_internal)
        return boundary

    def invoke(self, export, arguments=()):
        if not self.state.stopped:
            raise ValueError('Linux must stop before invoking another entry')
        scheduler = self.runtime.scheduler.invoke(
            self.state.scheduler, str(export), tuple(map(int, arguments)))
        self.state = MachineState(scheduler)

    def layout(self):
        scheduler = self.state.scheduler
        result = None
        if len(scheduler.threads) > 1 and scheduler.threads[1] is not None:
            thread = scheduler.thread(1)
            if thread.status == 'halted':
                result = int(thread.result)
        return {
            'stopped': self.state.stopped,
            'pending': (None if self.state.pending is None
                        else self.state.pending.operation),
            'result': result,
            'execution': self.executor.total_cost.layout(),
            'normalization': self.executor.normalization_layout(),
            'physical_pages': len(self.executor.module._physical_pages),
        }


@dataclass
class X86BrowserSession:
    runtime: object
    state: object
    clock_step: int = 1024
    clock_variation_bits: int = 12

    def step(self, event=None, budget=1 << 21, max_internal=1024):
        self.state, boundary = self.runtime.machine_step(
            self.state, event, budget=budget, max_internal=max_internal,
            clock_step=self.clock_step,
            clock_variation_bits=self.clock_variation_bits)
        if boundary is not None and not isinstance(boundary, MachineEvent):
            raise ValueError('x86 stopped at %s: %r'
                             % (boundary.operation, boundary.detail))
        return boundary

    def layout(self):
        physical = self.runtime.dbt.layout()
        return {
            'stopped': self.state.stopped,
            'pending': (None if self.state.pending is None
                        else self.state.pending.operation),
            'result': None,
            'execution': physical,
            'normalization': physical,
            'physical_pages': physical['resident_basic_blocks'],
            'console_input_bytes': len(self.state.console_input),
        }

    def console_input(self, payload):
        self.state = self.runtime.queue_console(self.state, payload)


_SESSIONS = []


def _wasm_sponge_records(
        lanes, tail, seed, records, rounds, rate_bytes, digest_bytes):
    if rate_bytes != 136 or digest_bytes != 32:
        raise ValueError('vm.wasm supports the SHA3-256 record cut')
    from js import mixSpongeRecords

    record_bytes = b''.join(
        bytes(additional) + struct.pack('<Q', int(time_value))
        for additional, time_value in records)
    result = json.loads(str(mixSpongeRecords(
        base64.b64encode(struct.pack('<25Q', *lanes)).decode('ascii'),
        base64.b64encode(bytes(tail)).decode('ascii'),
        base64.b64encode(bytes(seed)).decode('ascii'),
        base64.b64encode(record_bytes).decode('ascii'),
        int(rounds))))
    lane_bytes = base64.b64decode(result['lanes'], validate=True)
    tail_bytes = base64.b64decode(result['tail'], validate=True)
    if len(lane_bytes) != 200 or len(tail_bytes) >= rate_bytes:
        raise ValueError('vm.wasm returned an invalid sponge residual')
    return struct.unpack('<25Q', lane_bytes), tail_bytes


def _wasm_x86_step_executor(packed):
    """Bind one decoded x86 pure slice to the resident vm.wasm executor."""
    from js import installX86StateStep, executeX86StateStep

    page = base64.b64encode(bytes(packed)).decode('ascii')
    token = int(installX86StateStep(page))
    if token <= 0:
        raise ValueError('vm.wasm rejected the decoded x86 state page')

    def execute(inputs, stack, memory):
        if stack:
            raise ValueError('x86 pure state page cannot carry a value stack')
        values = tuple(int(value) & 0xffffffffffffffff for value in inputs)
        entry = struct.pack('<%dQ' % len(values), *values)
        encoded = str(executeX86StateStep(
            token, base64.b64encode(entry).decode('ascii')))
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) != len(entry):
            raise ValueError('vm.wasm returned an invalid x86 state cut')
        outputs = struct.unpack('<%dQ' % len(values), raw)
        return outputs, ()

    return execute


def _session(handle):
    handle = int(handle)
    if handle < 0 or handle >= len(_SESSIONS) or _SESSIONS[handle] is None:
        raise ValueError('Linux browser session is not live')
    return _SESSIONS[handle]


def boot_bytes(kernel, rootfs_bytes=0, entry='init'):
    """Decode a compact LKL module and create one event-backed boot session."""
    module = decode_module(bytes(kernel), indirect_abi='c-extra-args')
    machine = start_state(module, str(entry), host_imports=(NCCC_IMPORT,))
    machine, host = prepare_linux_memory(machine, LinuxHostState())
    store = DirectPageStore(int(rootfs_bytes), event_backed=True)
    host, device = attach_block(host, store, read_only=True)
    if device != 0:
        raise RuntimeError('the root filesystem must be block device zero')
    executor = WaveExecutor(module)
    runtime = LinuxMachine(module, executor=executor)
    session = BrowserSession(runtime, runtime.start(machine, host), executor)
    handle = len(_SESSIONS)
    _SESSIONS.append(session)
    return handle


def boot_file(path, rootfs_bytes=0, entry='init'):
    """Open a temporary worker file and create a browser boot session."""
    with open(path, 'rb') as source:
        return boot_bytes(source.read(), rootfs_bytes, entry)


def boot_x86_bytes(image, options=None):
    """Create an x86-64 Linux session from a bzImage or disposable boot cache."""
    from .x86 import X86DBT, X86Machine, load_bzimage_kernel
    from .x86snapshot import BOOT_CACHE_MAGIC, load_x86_boot_cache

    if isinstance(options, str):
        options = json.loads(options)
    options = {} if options is None else dict(options)
    initrd_path = options.pop('initrd_path', None)
    initrd = None
    if initrd_path is not None:
        with open(str(initrd_path), 'rb') as source:
            initrd = source.read()
    image = bytes(image)
    if image.startswith(BOOT_CACHE_MAGIC):
        if initrd is not None:
            raise ValueError('an x86 boot cache already contains its initrd')
        boot = load_x86_boot_cache(image)
    else:
        boot = load_bzimage_kernel(
            image,
            memory_bytes=options.get('memory_bytes'),
            command_line=options.get('command_line'),
            load_address=options.get('load_address'),
            initrd=initrd,
        )
    sponge_records = None
    step_executor_factory = None
    if sys.platform == 'emscripten':
        try:
            from js import mixSpongeRecords as _present
            from js import installX86StateStep as _install_present
            from js import executeX86StateStep as _step_present
        except ImportError as error:
            raise RuntimeError(
                'x86 browser boot requires the vm.wasm state kernels') from error
        if (_present is None or _install_present is None
                or _step_present is None):
            raise RuntimeError('x86 browser boot has no vm.wasm state kernels')
        sponge_records = _wasm_sponge_records
        step_executor_factory = _wasm_x86_step_executor
    runtime = X86Machine(X86DBT(
        sponge_records=sponge_records,
        step_executor_factory=step_executor_factory,
        allow_reference_executor=sys.platform != 'emscripten'))
    clock_step = int(options.get('clock_step', 1024))
    clock_variation_bits = int(options.get('clock_variation_bits', 12))
    if clock_step <= 0:
        raise ValueError('x86 clock_step must be positive')
    if not 0 <= clock_variation_bits <= 32:
        raise ValueError('x86 clock_variation_bits must be in [0, 32]')
    session = X86BrowserSession(
        runtime, runtime.start(boot.state),
        clock_step, clock_variation_bits)
    handle = len(_SESSIONS)
    _SESSIONS.append(session)
    return handle


def boot_x86_file(path, options=None):
    with open(path, 'rb') as source:
        return boot_x86_bytes(source.read(), options)


def _event(raw):
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = json.loads(raw)
    if raw is None:
        return None
    payload = raw.get('data')
    if raw.get('data_base64') is not None:
        payload = base64.b64decode(raw['data_base64'], validate=True)
    return MachineEvent(
        str(raw['operation']), tuple(map(int, raw.get('coordinate', ()))),
        payload)


def _event_layout(event):
    if event is None:
        return None
    result = {
        'operation': event.operation,
        'coordinate': list(event.coordinate),
        'thread': event.thread,
        'cost': event.cost.layout(),
    }
    if event.data is not None:
        if isinstance(event.data, (bytes, bytearray, memoryview)):
            result['data_base64'] = base64.b64encode(
                bytes(event.data)).decode('ascii')
        else:
            result['data'] = event.data
    return result


def step(handle, event=None, budget=1 << 21, max_internal=1024):
    """Advance a session to one external event and return JSON."""
    session = _session(handle)
    boundary = session.step(_event(event), int(budget), int(max_internal))
    return json.dumps({
        'ok': True,
        'handle': int(handle),
        'event': _event_layout(boundary),
        'state': session.layout(),
    })


def invoke(handle, export, arguments=()):
    """Start another exported LKL stage over the retained kernel state."""
    session = _session(handle)
    if not isinstance(session, BrowserSession):
        raise ValueError('x86 sessions do not export LKL stages')
    session.invoke(export, arguments)
    return json.dumps({'ok': True, 'handle': int(handle),
                       'state': session.layout()})


def layout(handle):
    return json.dumps({'ok': True, 'handle': int(handle),
                       'state': _session(handle).layout()})


def console_input(handle, data=None, data_base64=None):
    """Queue terminal bytes in the x86 UART owned by one worker session."""
    session = _session(handle)
    if not isinstance(session, X86BrowserSession):
        raise ValueError('console input is only available to x86 sessions')
    if data_base64 is not None:
        payload = base64.b64decode(data_base64, validate=True)
    elif isinstance(data, str):
        payload = data.encode('utf-8')
    else:
        payload = bytes(b'' if data is None else data)
    session.console_input(payload)
    return json.dumps({'ok': True, 'handle': int(handle),
                       'state': session.layout()})


def release(handle):
    """Drop every Python reference owned by one disposable worker session."""
    _session(handle)
    _SESSIONS[int(handle)] = None
    return json.dumps({'ok': True, 'handle': int(handle)})
