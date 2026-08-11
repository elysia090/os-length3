"""One deterministic Linux-in-Wasm machine-step boundary.

The Linux kernel owns syscalls, VFS, dcache, page cache, threads and timers.
This layer does not mirror any of them in the browser.  It runs internal LKL
host calls until the machine reaches a genuinely external operation and names
block data only by ``(device, page)``.
"""

from dataclasses import dataclass, replace

from qm.wasmwave import WaveCost

from .host import resume_nccc
from .scheduler import KernelScheduler, start_scheduler


EXTERNAL_OPERATIONS = (
    'block_read',
    'block_write',
    'console_read',
    'console_write',
    'clock',
    'entropy',
    'interrupt',
    'network_poll',
)


@dataclass(frozen=True)
class MachineEvent:
    operation: str
    coordinate: tuple = ()
    data: object = None
    thread: int = 0
    cost: WaveCost = WaveCost()

    def __post_init__(self):
        if self.operation not in EXTERNAL_OPERATIONS:
            raise ValueError('unknown machine event %r' % self.operation)


@dataclass(frozen=True)
class MachineState:
    scheduler: object
    pending: object = None
    queued: tuple = ()

    @property
    def stopped(self):
        return self.scheduler.stopped and self.pending is None


def _replace_thread(state, thread, ready=False):
    threads = list(state.threads)
    threads[thread.handle] = thread
    queue = state.ready
    if ready and thread.handle not in queue:
        queue += (thread.handle,)
    return replace(state, threads=tuple(threads), ready=queue,
                   memory=thread.machine.memory)


class LinuxMachine(object):
    """Drive LKL to the next external event using one state-step route."""

    def __init__(self, module, executor=None, stack_global=None):
        self.scheduler = KernelScheduler(
            module, executor=executor, stack_global=stack_global,
            defer_clock=True)

    def start(self, machine, host=None):
        return MachineState(start_scheduler(machine, host))

    @staticmethod
    def _answer(state, event):
        pending = state.pending
        if pending is None:
            if event is not None:
                raise ValueError('machine has no external request to answer')
            return state
        if event is None:
            raise ValueError('machine event %s needs a response'
                             % pending.operation)
        if (event.operation != pending.operation
                or tuple(event.coordinate) != pending.coordinate):
            raise ValueError('machine response does not match pending request')

        scheduler = state.scheduler
        thread = scheduler.thread(pending.thread)
        if pending.operation == 'clock':
            value = int(event.data)
            if value < scheduler.host.clock_ns:
                raise ValueError('machine clock cannot move backwards')
            host = replace(scheduler.host, clock_ns=value)
            machine = resume_nccc(thread.machine, (value,))
            thread = replace(thread, machine=machine, status='ready', wait=None)
            scheduler = replace(scheduler, host=host)
            scheduler = _replace_thread(scheduler, thread, ready=True)
        elif pending.operation == 'block_read':
            device, page = pending.coordinate
            block = scheduler.host.blocks[device]
            block.store.install_backing(page, event.data)
            thread = replace(thread, status='ready', wait=None)
            scheduler = _replace_thread(scheduler, thread, ready=True)
        else:
            raise ValueError('machine event %s is output-only'
                             % pending.operation)
        return MachineState(scheduler, queued=state.queued)

    @staticmethod
    def _external(state, boundary):
        detail = boundary.detail or ()
        if (boundary.operation in ('block_read', 'block_write')
                and boundary.action == 'blocked'
                and detail[:2] == ('block', 'page-read')):
            return (MachineEvent(
                'block_read', (int(detail[2]), int(detail[3])),
                thread=boundary.thread, cost=boundary.cost),)
        if boundary.operation == 'clock' and boundary.action == 'blocked':
            return (MachineEvent('clock', thread=boundary.thread,
                                 cost=boundary.cost),)
        if boundary.operation == 'print' and detail[:1] == ('print',):
            return (MachineEvent('console_write', data=bytes(detail[1]),
                                 thread=boundary.thread,
                                 cost=boundary.cost),)
        if (boundary.operation == 'block_write'
                and boundary.action == 'resumed'
                and detail[:2] == ('block', 'write')):
            device = int(detail[2])
            store = state.scheduler.host.blocks[device].store
            return tuple(
                MachineEvent('block_write', (device, int(page)),
                             data=bytes(store.page(page)),
                             thread=boundary.thread, cost=boundary.cost)
                for page in detail[5]
            )
        return ()

    def machine_step(self, state, event=None, budget=1 << 21,
                     max_internal=1024):
        """Apply one input event and run to one external machine boundary.

        Returning ``None`` means the bounded quantum ended or the machine
        stopped without external I/O. Internal synchronization, allocation,
        VFS and page-cache work never become browser-side operations.
        """
        state = self._answer(state, event)
        if state.queued:
            first, queued = state.queued[0], state.queued[1:]
            return replace(state, queued=queued), first

        scheduler = state.scheduler
        for _unused in range(int(max_internal)):
            scheduler, boundary = self.scheduler.step(scheduler, budget=budget)
            next_state = MachineState(scheduler)
            external = self._external(next_state, boundary)
            if external:
                first, queued = external[0], external[1:]
                pending = first if first.operation in ('clock', 'block_read') \
                    and boundary.action == 'blocked' else None
                return MachineState(scheduler, pending, queued), first
            if boundary.operation == 'timeslice' or scheduler.stopped:
                return next_state, None
        return MachineState(scheduler), None


def machine_step(runtime, state, event=None, **options):
    """Functional spelling of :meth:`LinuxMachine.machine_step`."""
    return runtime.machine_step(state, event, **options)
