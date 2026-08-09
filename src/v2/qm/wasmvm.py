"""Run the shipped wasm VM as an exact finite byte transducer.

The artifact is copied through the module's public buffer and opened by
``vm_load``.  The resulting WebAssembly globals and linear memory are the
state.  ``vm_feed(byte)`` is the transition and ``vm_read()`` is the Moore
observation.  Reads are evaluated on a clone and their writes are discarded,
matching the VM ABI rather than relying on a second implementation of it.
"""

from dataclasses import dataclass

from .transducer import compile_transducer
from .wasmstate import (I32, WasmStateError, decode_module, invoke,
                        run_until_boundary, start_state, write_memory)


COMMITTED = 1
DEAD = 0
UNFINISHED = -2
CELL_BYTES = (1 << 20) * 8
MEMORY_PAGE = 256


@dataclass(frozen=True)
class VmState:
    """One retained wasm instance at a public VM call boundary."""

    snapshot: object
    cells_address: int
    dead: bool = False


def _result_i32(state, name):
    if not state.halted or len(state.result) != 1:
        raise WasmStateError('%s did not return one i32 value' % name)
    value = state.result[0] & I32
    return value - (1 << 32) if value & (1 << 31) else value


def load(module, artifact, budget=1 << 24):
    """Instantiate ``module`` and return its state after opening ``artifact``."""
    pointer_call = run_until_boundary(module, start_state(module, 'vm_buffer'),
                                      budget=budget)
    pointer = _result_i32(pointer_call, 'vm_buffer')
    if pointer < 0:
        raise WasmStateError('vm_buffer returned a negative address')
    copied = write_memory(pointer_call, pointer, artifact)
    cells_call = invoke(module, copied, 'vm_cells', (), budget=budget)
    cells_address = _result_i32(cells_call, 'vm_cells')
    if cells_address < 0 or cells_address + CELL_BYTES > len(cells_call.memory):
        raise WasmStateError('vm_cells returned an invalid arena address')
    opened = invoke(module, cells_call, 'vm_load', (len(artifact),), budget=budget)
    if _result_i32(opened, 'vm_load') != COMMITTED:
        raise WasmStateError('vm_load rejected the artifact')
    return VmState(opened, cells_address)


def load_file(path, artifact, budget=1 << 24):
    """Decode a wasm binary and open an artifact in one call."""
    with open(path, 'rb') as handle:
        module = decode_module(handle.read())
    return module, load(module, artifact, budget=budget)


def feed(module, state, byte, budget=1 << 24):
    """Pure wasm VM transition over one byte."""
    if not 0 <= byte <= 255:
        raise ValueError('vm_feed takes one byte: %r' % (byte,))
    after = invoke(module, state.snapshot, 'vm_feed', (byte,), budget=budget)
    status = _result_i32(after, 'vm_feed')
    if status == UNFINISHED:
        raise WasmStateError('vm_feed(%d) exhausted its transition budget'
                             % byte)
    if status not in (COMMITTED, DEAD):
        raise WasmStateError('vm_feed(%d) returned %d' % (byte, status))
    return VmState(after, state.cells_address, dead=(status == DEAD))


def read(module, state, budget=1 << 24):
    """Observe one byte through a non-committing wasm ``vm_read`` call."""
    observed = invoke(module, state.snapshot, 'vm_read', (), budget=budget)
    value = _result_i32(observed, 'vm_read')
    return value if 0 <= value <= 255 else None


def state_key(state):
    """Exact identity of the retained VM state between public calls.

    A successful feed can affect later calls only through ``cells``. The undo
    log is empty at the boundary, its old backing bytes are write-only until
    replaced, and decode buffers and telemetry are not read by feed/read.
    Dead states all have the same future. This is the C module's explicit
    state boundary, not a guessed range in the compiled binary.
    """
    if state.dead:
        return ('dead',)
    memory = state.snapshot.memory
    first = state.cells_address
    last = first + CELL_BYTES
    pages = []
    for index, page in memory.pages:
        page_first = index * MEMORY_PAGE
        page_last = page_first + MEMORY_PAGE
        lo, hi = max(first, page_first), min(last, page_last)
        if lo >= hi:
            continue
        part = page[lo - page_first:hi - page_first]
        base = memory.base[lo:hi]
        if len(base) < hi - lo:
            base += bytes(hi - lo - len(base))
        if part != base:
            pages.append((lo - first, part))
    return state.snapshot.globals, tuple(pages)


def compile_vm(module, initial, max_states=4096, budget=1 << 24):
    """Close and minimize the loaded ``vm.wasm`` byte future exactly."""
    mode = invoke(module, initial.snapshot, 'vm_direct_byte_state', (),
                  budget=budget)
    if _result_i32(mode, 'vm_direct_byte_state') == 1:
        states = [feed(module, initial, byte, budget=budget)
                  for byte in range(256)]
        identities = {state_key(state): byte
                      for byte, state in enumerate(states)}
        outputs = tuple(read(module, state, budget=budget) for state in states)
        initial_byte = identities.get(state_key(initial))
        if (len(identities) == 256 and initial_byte is not None
                and outputs == tuple(range(256))):
            # vm_load selected this mode only after executing the ordinary
            # transactional reader over all 256 byte states and proving that
            # feed changes no other persistent cell.  Substitute that proved
            # state step before graph closure; its transition rows normalize
            # to one affine map rather than 65,536 interpreted calls.
            return compile_transducer(
                initial_byte,
                lambda _state, byte: byte,
                lambda state: outputs[state],
                alphabet=range(256),
                max_states=max_states,
            )
    return compile_transducer(
        initial,
        lambda state, byte: feed(module, state, byte, budget=budget),
        lambda state: read(module, state, budget=budget),
        alphabet=range(256),
        key=state_key,
        max_states=max_states,
    )
