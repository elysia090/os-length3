"""Browser-facing sessions for the Linux-in-WebAssembly state machine.

The JavaScript worker owns network and clock access. Python retains only the
decoded kernel, the current machine continuation, reached physical state-step
pages, and directly addressed root-device pages. Each call advances to one
external event, making block fetches and replay explicit.
"""

import base64
from dataclasses import dataclass
import json

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


_SESSIONS = []


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
    session.invoke(export, arguments)
    return json.dumps({'ok': True, 'handle': int(handle),
                       'state': session.layout()})


def layout(handle):
    return json.dumps({'ok': True, 'handle': int(handle),
                       'state': _session(handle).layout()})


def release(handle):
    """Drop every Python reference owned by one disposable worker session."""
    _session(handle)
    _SESSIONS[int(handle)] = None
    return json.dumps({'ok': True, 'handle': int(handle)})
