"""Portable x86 CPU and direct-page memory checkpoints."""

from dataclasses import replace
import hashlib
import json
import struct

from qm.memorycut import MemoryCut
from qm.bits import mask_of
from qm.wasmstate import CanonicalPage, MEMORY_PAGE, PagedMemory

from qm.wasmphysical import DependencyWaves
from qm.wasmwave import Operand, PureSlice, WaveCost
from qm.stepnormalize import compose_plans

from .machine import MachineEvent
from .pagefabric import (PageFabric, SubpageBacking, bundle_prefix_size,
                         dump_bundle, load_bundle, project_sparse)
from .x86 import (BzImageBoot, BzImageHeader, DecodedBlock,
                  HighByteRegister, MASK64, MemoryOperand, X86DBT, X86Error,
                  X86Boundary, X86MachineState, X86State, _execution_proof,
                  read_virtual)
from qm.steppage import (decode_plan, pack as pack_step, StatePageError,
                         unpack as unpack_step)


MAGIC = b'x86-state-v1\n'
MACHINE_MAGIC = b'x86-machine-v1\n'
BOOT_CACHE_MAGIC = b'x86-boot-cache-v1\n'
CODE_MAGIC = b'x86-code-v1\n'
NATIVE_BLOCK_MAGIC = b'X86B'
NATIVE_MACHINE_MAGIC = b'x86-native-machine-v1\n'
RECORD = struct.Struct('<QB')
PAGE_BASE = 0
PAGE_DOMAIN = 1
PAGE_RAW = 2
CODE_RECORD = struct.Struct('<QQIIIII')
NATIVE_BLOCK_HEADER = struct.Struct('<4sHHQQIIQQQ8x')
_COST_FIELDS = (
    'instructions', 'work', 'span', 'slices', 'barriers',
    'max_parallel_width',
)

BOOT_SPAN_BYTES = 1 << 16
BOOT_SPAN_PAGES = BOOT_SPAN_BYTES // MEMORY_PAGE


def _dump_boot_memory(memory, shards):
    if not isinstance(memory, PagedMemory) or memory.base \
            or memory._backing is not None:
        raise TypeError('x86 boot cache needs an opened implicit-zero memory')
    spans = {}
    for page, payload in memory.pages:
        span, slot = divmod(page, BOOT_SPAN_PAGES)
        raw = spans.get(span)
        if raw is None:
            raw = spans[span] = bytearray(BOOT_SPAN_BYTES)
        offset = slot * MEMORY_PAGE
        raw[offset:offset + MEMORY_PAGE] = payload
    records = tuple((span, bytes(raw)) for span, raw in sorted(spans.items())
                    if any(raw))
    manifest, store = project_sparse(
        len(memory), BOOT_SPAN_BYTES, records,
        data_shards=8, parity_shards=2)
    return dump_bundle(manifest, store, shards)


def _load_boot_memory(payload):
    manifest, store = load_bundle(payload)
    fabric = PageFabric(manifest, (store,))
    backing = SubpageBacking(fabric, MEMORY_PAGE)
    return PagedMemory(b'', manifest.length, _backing=backing)


def dump_x86_boot_cache(boot, shards='data'):
    """Encode a disposable expanded boot cache without retaining its bzImage."""
    if not isinstance(boot, BzImageBoot):
        raise TypeError('x86 boot cache needs a BzImageBoot')
    empty = PagedMemory(b'', len(boot.state.memory))
    cpu = dump_x86_state(replace(boot.state, memory=empty))
    memory = _dump_boot_memory(boot.state.memory, shards)
    header = json.dumps({
        'cpu_bytes': len(cpu),
        'memory_bytes': len(memory),
        'header': {
            name: int(getattr(boot.header, name))
            for name in BzImageHeader.__dataclass_fields__
        },
        'load_address': int(boot.load_address),
        'boot_params_address': int(boot.boot_params_address),
        'command_line_address': int(boot.command_line_address),
        'initrd_address': (None if boot.initrd_address is None
                           else int(boot.initrd_address)),
        'initrd_bytes': int(boot.initrd_bytes),
    }, sort_keys=True, separators=(',', ':')).encode('ascii')
    return b''.join((
        BOOT_CACHE_MAGIC, struct.pack('<I', len(header)), header, cpu, memory,
    ))


def load_x86_boot_cache(payload):
    """Map one expanded boot baseline directly into persistent pages."""
    payload = payload if isinstance(payload, memoryview) else memoryview(payload)
    prefix = len(BOOT_CACHE_MAGIC)
    if len(payload) < prefix + 4 \
            or bytes(payload[:prefix]) != BOOT_CACHE_MAGIC:
        raise X86Error('x86 boot cache header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    cursor = prefix + 4
    header_end = cursor + header_bytes
    if header_end > len(payload):
        raise X86Error('x86 boot cache metadata is truncated')
    try:
        header = json.loads(bytes(payload[cursor:header_end]).decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise X86Error('x86 boot cache metadata is invalid') from error
    cpu_bytes = int(header.get('cpu_bytes', -1))
    memory_bytes = int(header.get('memory_bytes', -1))
    if min(cpu_bytes, memory_bytes) < 0 \
            or cpu_bytes + memory_bytes != len(payload) - header_end:
        raise X86Error('x86 boot cache state extent is invalid')
    raw_header = header.get('header')
    if not isinstance(raw_header, dict) \
            or set(raw_header) != set(BzImageHeader.__dataclass_fields__):
        raise X86Error('x86 boot cache setup header is invalid')
    try:
        image_header = BzImageHeader(**{
            name: (bool(value) if name == 'relocatable' else int(value))
            for name, value in raw_header.items()
        })
        initrd_address = header.get('initrd_address')
        cpu_end = header_end + cpu_bytes
        # CPU metadata is small and parsed eagerly.  The large boot baseline
        # remains one mapped view and is admitted span by span by PageFabric.
        cpu = load_x86_state(bytes(payload[header_end:cpu_end]))
        memory = _load_boot_memory(payload[cpu_end:])
        if len(cpu.memory) != len(memory) or cpu.memory.pages:
            raise X86Error('x86 boot cache CPU memory is invalid')
        boot = BzImageBoot(
            replace(cpu, memory=memory), image_header,
            int(header['load_address']), int(header['boot_params_address']),
            int(header['command_line_address']),
            None if initrd_address is None else int(initrd_address),
            int(header.get('initrd_bytes', 0)),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise X86Error('x86 boot cache metadata is invalid') from error
    if min(boot.load_address, boot.boot_params_address,
           boot.command_line_address, boot.initrd_bytes) < 0:
        raise X86Error('x86 boot cache coordinates are invalid')
    return boot


def _boot_cache_memory_bytes(payload):
    payload = memoryview(payload)
    prefix = len(BOOT_CACHE_MAGIC)
    if len(payload) < prefix + 4 or bytes(payload[:prefix]) != BOOT_CACHE_MAGIC:
        raise X86Error('native machine needs an x86 boot cache')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    header_start = prefix + 4
    header_end = header_start + header_bytes
    if header_end > len(payload):
        raise X86Error('x86 boot cache metadata is truncated')
    try:
        header = json.loads(bytes(payload[header_start:header_end]))
        cpu_bytes = int(header['cpu_bytes'])
        memory_bytes = int(header['memory_bytes'])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise X86Error('x86 boot cache metadata is invalid') from error
    start = header_end + cpu_bytes
    end = start + memory_bytes
    if min(cpu_bytes, memory_bytes) < 0 or end != len(payload):
        raise X86Error('x86 boot cache state extent is invalid')
    return bytes(payload[start:end])


def canonical_native_x86_records(blocks):
    """Choose the one strongest portable record at every native coordinate."""
    by_rip = {}
    internal_coordinates = set()
    for block in blocks:
        for rip, record in pack_native_x86_records(block):
            prior = by_rip.get(rip)
            if prior is not None and prior != record:
                internal = rip != int(block.rip) & MASK64
                prior_internal = rip in internal_coordinates
                # A faultable terminal is deliberately split from its pure
                # prefix.  If normal control also reached that instruction,
                # its primary cut starts at the same architectural retry
                # coordinate and may safely subsume the smaller terminal.
                # Prefer it so native and reference quanta retain the same
                # maximal-cut boundary.
                if prior_internal and not internal:
                    by_rip[rip] = record
                    internal_coordinates.discard(rip)
                    continue
                if not prior_internal and internal:
                    continue
                raise ValueError(
                    'native x86 coordinate %#x has distinct %s records'
                    % (rip, 'internal' if internal else 'primary'))
            by_rip[rip] = record
            if rip != int(block.rip) & MASK64:
                internal_coordinates.add(rip)
    return tuple(sorted(by_rip.items()))


def dump_native_x86_machine(boot_cache, state, blocks):
    """Join boot state, sparse physical RAM, and reached native STEP records."""
    if not isinstance(state, X86State):
        raise TypeError('native x86 machine needs an X86State')
    memory = _boot_cache_memory_bytes(boot_cache)
    prefix_bytes = bundle_prefix_size(memory)
    records = []
    directory = []
    offset = 0
    for rip, record in canonical_native_x86_records(blocks):
        directory.append(('%016x' % rip, offset, len(record)))
        records.append(record)
        offset += len(record)

    def word(value):
        return '%016x' % (int(value) & MASK64)

    system = (
        state.cr2, state.cr8,
        state.gdtr[0], state.gdtr[1], state.idtr[0], state.idtr[1],
        state.es, state.cs, state.ss, state.ds, state.fs, state.gs,
        state.ldtr, state.tr,
    ) + tuple(state.debug)
    header = json.dumps({
        'schema': 1,
        'state': {
            'registers': [word(value) for value in state.registers],
            'rip': word(state.rip), 'rflags': word(state.rflags),
            'cr0': word(state.cr0), 'cr3': word(state.cr3),
            'cr4': word(state.cr4), 'efer': word(state.efer),
            'system': [word(value) for value in system],
            'msrs': [[word(key), word(value)] for key, value in state.msrs],
        },
        'memory': {
            'bytes': len(memory),
            'length': len(state.memory),
            'prefix_bytes': prefix_bytes,
            'prefix_sha256': hashlib.sha256(
                memory[:prefix_bytes]).hexdigest(),
        },
        'blocks': directory,
        'block_bytes': offset,
    }, sort_keys=True, separators=(',', ':')).encode('ascii')
    return b''.join((
        NATIVE_MACHINE_MAGIC, struct.pack('<I', len(header)), header,
        memory, *records,
    ))


def extend_native_x86_machine(payload, records, reject_conflicts=True):
    """Add proved X86B records without decoding or rewriting physical RAM."""
    payload = memoryview(payload)
    prefix = len(NATIVE_MACHINE_MAGIC)
    if (len(payload) < prefix + 4
            or bytes(payload[:prefix]) != NATIVE_MACHINE_MAGIC):
        raise X86Error('native x86 machine header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    header_start = prefix + 4
    header_end = header_start + header_bytes
    if header_end > len(payload):
        raise X86Error('native x86 machine metadata is truncated')
    try:
        header = json.loads(bytes(payload[header_start:header_end]))
        memory_bytes = int(header['memory']['bytes'])
        block_bytes = int(header['block_bytes'])
        directory = tuple(header['blocks'])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise X86Error('native x86 machine metadata is invalid') from error
    memory_end = header_end + memory_bytes
    if (min(memory_bytes, block_bytes) < 0
            or memory_end + block_bytes != len(payload)):
        raise X86Error('native x86 machine extents are invalid')
    block_base = memory_end
    by_rip = {}
    for raw_rip, raw_offset, raw_length in directory:
        try:
            rip = int(str(raw_rip), 16) & MASK64
            offset = int(raw_offset)
            length = int(raw_length)
        except (TypeError, ValueError) as error:
            raise X86Error('native x86 block directory is invalid') from error
        if min(offset, length) < 0 or offset + length > block_bytes:
            raise X86Error('native x86 block directory is invalid')
        record = bytes(payload[
            block_base + offset:block_base + offset + length])
        try:
            validate_native_x86_record(record, rip)
        except (StatePageError, ValueError):
            # Extension is also a canonical scrub: a malformed speculative
            # record is removed so the resident runtime reports a missing cut
            # instead of trapping after accepting its coordinate.
            continue
        by_rip[rip] = record
    for rip, record in records:
        rip = int(rip) & MASK64
        record = bytes(record)
        validate_native_x86_record(record, rip)
        prior = by_rip.get(rip)
        if prior is not None and prior != record:
            if reject_conflicts:
                raise ValueError(
                    'native x86 extension changes coordinate %#x' % rip)
            # Runtime closure is append-only.  A resident coordinate already
            # proved itself along the vm.wasm prefix and is never replaced by
            # a later oracle variant.
            continue
        by_rip[rip] = record

    packed = []
    next_directory = []
    offset = 0
    for rip, record in sorted(by_rip.items()):
        next_directory.append(('%016x' % rip, offset, len(record)))
        packed.append(record)
        offset += len(record)
    header['blocks'] = next_directory
    header['block_bytes'] = offset
    encoded = json.dumps(
        header, sort_keys=True, separators=(',', ':')).encode('ascii')
    return b''.join((
        NATIVE_MACHINE_MAGIC, struct.pack('<I', len(encoded)), encoded,
        bytes(payload[header_end:memory_end]), *packed,
    ))


def _dump_code_value(value):
    if value is None:
        return ['none']
    if isinstance(value, bool):
        return ['bool', value]
    if isinstance(value, int):
        return ['int', value]
    if isinstance(value, str):
        return ['str', value]
    if isinstance(value, bytes):
        return ['bytes', value.hex()]
    if isinstance(value, tuple):
        return ['tuple', [_dump_code_value(item) for item in value]]
    if isinstance(value, HighByteRegister):
        return ['high-byte-register', int(value.index)]
    if isinstance(value, MemoryOperand):
        return ['memory-operand', [
            _dump_code_value(value.base), _dump_code_value(value.index),
            int(value.scale), int(value.displacement),
            bool(value.rip_relative), _dump_code_value(value.segment_msr),
        ]]
    raise TypeError('x86 code page contains unsupported boundary data %r'
                    % (type(value).__name__,))


def _load_code_value(record):
    if not isinstance(record, list) or not record:
        raise X86Error('x86 code page boundary data is invalid')
    kind = record[0]
    if kind == 'none' and len(record) == 1:
        return None
    if kind == 'bool' and len(record) == 2 \
            and isinstance(record[1], bool):
        return record[1]
    if kind == 'int' and len(record) == 2 \
            and isinstance(record[1], int) \
            and not isinstance(record[1], bool):
        return record[1]
    if kind == 'str' and len(record) == 2 \
            and isinstance(record[1], str):
        return record[1]
    if kind == 'bytes' and len(record) == 2 \
            and isinstance(record[1], str):
        try:
            return bytes.fromhex(record[1])
        except ValueError as error:
            raise X86Error('x86 code page boundary bytes are invalid') \
                from error
    if kind == 'tuple' and len(record) == 2 \
            and isinstance(record[1], list):
        return tuple(_load_code_value(item) for item in record[1])
    if kind == 'high-byte-register' and len(record) == 2:
        index = int(record[1])
        if not 0 <= index < 4:
            raise X86Error('x86 code page high-byte register is invalid')
        return HighByteRegister(index)
    if kind == 'memory-operand' and len(record) == 2 \
            and isinstance(record[1], list) and len(record[1]) == 6:
        fields = record[1]
        scale = int(fields[2])
        if scale not in (1, 2, 4, 8):
            raise X86Error('x86 code page memory scale is invalid')
        return MemoryOperand(
            _load_code_value(fields[0]), _load_code_value(fields[1]),
            scale, int(fields[3]), bool(fields[4]),
            _load_code_value(fields[5]))
    raise X86Error('x86 code page boundary data kind is unsupported')


def dump_x86_code_pages(dbt):
    """Encode reached x86 blocks as ordered mapped physical state pages."""
    if not isinstance(dbt, X86DBT):
        raise TypeError('x86 code page archive needs an X86DBT')
    blocks = tuple(sorted(dbt.blocks.values(), key=lambda block: block.rip))
    if len({block.rip for block in blocks}) != len(blocks):
        raise ValueError('x86 code page coordinates are not unique')
    header = json.dumps({
        'blocks': len(blocks),
    }, sort_keys=True, separators=(',', ':')).encode('ascii')
    output = bytearray(CODE_MAGIC)
    output.extend(struct.pack('<I', len(header)))
    output.extend(header)
    for block in blocks:
        source = bytes(block.source)
        mapped = bytes(block.mapped.data)
        boundary = json.dumps({
            'operation': block.boundary.operation,
            'detail': _dump_code_value(block.boundary.detail),
        }, sort_keys=True, separators=(',', ':')).encode('ascii')
        output.extend(CODE_RECORD.pack(
            int(block.rip) & MASK64,
            int(block.boundary_rip) & MASK64,
            int(block.instructions), int(block.scratch_count),
            len(source), len(mapped), len(boundary)))
        output.extend(source)
        output.extend(mapped)
        output.extend(boundary)
    return bytes(output)


def pack_native_x86_block(block):
    """Pack one complete register/flags cut for the resident native VM."""
    if not isinstance(block, DecodedBlock):
        raise TypeError('native x86 block needs a decoded state cut')
    if block.cut_inputs:
        raise ValueError('native x86 block must own all memory inputs')
    plan = block.plan
    if not block.state_flags:
        plan = X86DBT._carry_flags_plan(plan)
        if plan is None:
            raise ValueError('native x86 block cannot publish flags')
    operation = block.boundary.operation
    detail = block.boundary.detail
    lowered = X86DBT._lower_flag_boundary(plan, block.boundary)
    if lowered is not None:
        plan, following = lowered
        operation = 'branch'
        detail = following
    lowered = None if operation == 'branch' else \
        X86DBT._register_plan(block.boundary)
    if lowered is not None:
        register_plan, following = lowered
        register_plan = X86DBT._carry_flags_plan(register_plan)
        if register_plan is None:
            raise ValueError('native x86 register cut cannot publish flags')
        plan = compose_plans(plan, register_plan)
        operation = 'branch'
        detail = following
    else:
        value_local = len(plan.locals)
        lowered = None if operation == 'branch' else \
            X86DBT._read_segment_memory_plan(
                block.boundary, value_local)
        if lowered is not None:
            segment_plan, following, segment, value_local = lowered
            plan = replace(
                plan, locals=tuple(plan.locals)
                + (Operand('local', value_local),))
            plan = compose_plans(plan, segment_plan)
            operation = 'native_store_segment'
            detail = following, segment, value_local
        else:
            lowered = None if operation == 'branch' else \
                X86DBT._stack_plan(block.boundary)
        if lowered is not None:
            if operation != 'native_store_segment':
                stack_plan, stack_boundary, _scratch_count = lowered
                plan = compose_plans(plan, stack_plan)
                operation = stack_boundary.operation
                detail = stack_boundary.detail
        if lowered is None:
            lowered = X86DBT._memory_plan(block.boundary)
            if lowered is not None:
                memory_plan, following = lowered
                plan = compose_plans(plan, memory_plan)
                operation = 'branch'
                detail = following
            else:
                lowered = X86DBT._descriptor_plan(block.boundary)
                if lowered is not None:
                    descriptor_plan, following, name = lowered
                    plan = compose_plans(plan, descriptor_plan)
                    operation = 'descriptor'
                    detail = following, name
                else:
                    lowered = X86DBT._indirect_control_plan(block.boundary)
                    if lowered is not None:
                        plan = compose_plans(plan, lowered)
                        operation = 'dynamic_branch'
                        detail = None
                    else:
                        lowered = X86DBT._divide_plan(block.boundary)
                        if lowered is not None:
                            divide_plan, following = lowered
                            plan = compose_plans(plan, divide_plan)
                            operation = 'native_divide'
                            detail = following
                        else:
                            lowered = X86DBT._invalidate_plan(block.boundary)
                            if lowered is not None:
                                invalidate_plan, following = lowered
                                plan = compose_plans(plan, invalidate_plan)
                                operation = 'native_invalidate_page'
                                detail = following
    control = 0
    arguments = [int(block.boundary_rip) & MASK64, 0, 0]
    if operation == 'branch':
        control = 1
        arguments[0] = int(detail) & MASK64
    elif operation == 'conditional_branch':
        control = 2
        following, target, condition = detail
        arguments = [int(following) & MASK64, int(target) & MASK64,
                     int(condition)]
    elif operation == 'dynamic_branch':
        control = 3
        arguments[0] = 16 + 1
    elif operation == 'halt':
        control = 4
        arguments[0] = int(detail) & MASK64
    elif operation == 'timeslice':
        control = 5
        arguments[0] = int(detail) & MASK64
    elif operation == 'write_msr':
        control = 6
        arguments[0] = int(detail) & MASK64
    elif operation == 'read_msr':
        control = 7
        arguments[0] = int(detail) & MASK64
    elif operation == 'cpuid':
        control = 8
        arguments[0] = int(detail) & MASK64
    elif operation == 'control_register':
        following, opcode, coordinate, register = detail
        if opcode not in (0x20, 0x22) or not 0 <= register < 16:
            raise ValueError('native x86 control-register shape is invalid')
        control = 9
        arguments[0] = int(following) & MASK64
        arguments[1] = (int(opcode) | (int(coordinate) << 8)
                        | (int(register) << 16))
    elif operation == 'segment':
        following, segment, source = detail
        if not isinstance(source, int) or not 0 <= source < 16:
            raise ValueError('native x86 segment source is not a register')
        control = 10
        arguments = [int(following) & MASK64,
                     int(segment) & MASK64, int(source) & MASK64]
    elif operation == 'descriptor':
        following, name = detail
        control = 11
        arguments = [int(following) & MASK64,
                     int(name == 'idtr'), 0]
    elif operation == 'native_far_return':
        control = 12
        arguments = [17, 18, 0]
    elif operation == 'native_divide':
        control = 13
        arguments = [int(detail) & MASK64, 17, 0]
    elif operation == 'native_interrupt_return':
        control = 14
        arguments = [17, 18, 19]
    elif operation == 'native_internal_branch':
        control = 15
        arguments[0] = int(detail) & MASK64
    elif operation == 'read_segment':
        following, segment, target, bits = detail
        if (not isinstance(target, int) or not 0 <= target < 16
                or not 0 <= int(segment) < 6
                or int(bits) not in (16, 32, 64)):
            raise ValueError('native x86 segment-read shape is invalid')
        control = 16
        arguments = [int(following) & MASK64,
                     int(segment) & MASK64,
                     int(target) | (int(bits) << 8)]
    elif operation == 'native_store_segment':
        following, segment, value_local = detail
        if (not 0 <= int(segment) < 6
                or not 17 <= int(value_local) < 256):
            raise ValueError('native x86 segment-store shape is invalid')
        control = 16
        arguments = [int(following) & MASK64,
                     int(segment) & MASK64,
                     int(value_local) | (16 << 8) | (1 << 16)]
    elif operation in ('port_read', 'port_read_dx',
                       'port_write', 'port_write_dx'):
        dynamic = operation.endswith('_dx')
        if dynamic:
            following, width = detail
            port = 0
        else:
            following, port, width = detail
        if int(width) not in (1, 2, 4) or not 0 <= int(port) <= 0xffff:
            raise ValueError('native x86 port shape is invalid')
        control = 17 if operation.startswith('port_read') else 18
        arguments = [int(following) & MASK64, int(port),
                     int(width) | (int(dynamic) << 8)]
    elif operation == 'native_invalidate_page':
        control = 19
        arguments = [int(detail) & MASK64, 17, 0]
    elif operation == 'clock':
        control = 20
        arguments = [int(detail) & MASK64, 0, 0]
    else:
        raise ValueError(
            'native x86 control is not normalized: %s' % operation)
    page = bytes(pack_step(plan))
    # The resident VM is deliberately stricter than the Python executor.
    # Validate the physical columns at artifact construction time so no
    # malformed record can become a browser-only fallback or late trap.
    header = NATIVE_BLOCK_HEADER.pack(
        NATIVE_BLOCK_MAGIC, 1, NATIVE_BLOCK_HEADER.size,
        int(block.rip) & MASK64, int(block.boundary_rip) & MASK64,
        len(page), control, *arguments)
    record = header + page
    validate_native_x86_record(record, block.rip)
    return record


def native_x86_static_successors(record):
    """Return every control successor named directly by one native record."""
    record = bytes(record)
    if len(record) < NATIVE_BLOCK_HEADER.size:
        raise ValueError('native x86 record is truncated')
    (magic, version, header_bytes, _rip, boundary_rip, page_bytes,
     control, first, second, _third) = NATIVE_BLOCK_HEADER.unpack_from(record)
    if (magic != NATIVE_BLOCK_MAGIC or version != 1
            or header_bytes != NATIVE_BLOCK_HEADER.size
            or page_bytes != len(record) - header_bytes
            or control > 20):
        raise ValueError('native x86 record header is invalid')
    if control == 2:
        return tuple(dict.fromkeys((first & MASK64, second & MASK64)))
    if control in (3, 4, 12, 14):
        return ()
    if control in (0, 5):
        return (boundary_rip & MASK64,)
    return (first & MASK64,)


def validate_native_x86_record(record, coordinate=None):
    """Validate one complete X86B record exactly as the resident VM will."""
    record = bytes(record)
    if len(record) < NATIVE_BLOCK_HEADER.size:
        raise ValueError('native x86 record is truncated')
    (magic, version, header_bytes, rip, _boundary_rip, page_bytes,
     control, _first, _second, _third) = \
        NATIVE_BLOCK_HEADER.unpack_from(record)
    if (magic != NATIVE_BLOCK_MAGIC or version != 1
            or header_bytes != NATIVE_BLOCK_HEADER.size
            or page_bytes != len(record) - header_bytes
            or control > 20
            or (coordinate is not None
                and rip != int(coordinate) & MASK64)):
        raise ValueError('native x86 record header is invalid')
    mapped = unpack_step(record[header_bytes:])
    if mapped.local_extent < 17:
        # The resident ABI needs the sixteen GPRs plus RFLAGS.  Spell the
        # constant directly in the error because X86State has non-frame fields.
        raise ValueError('native x86 record has fewer than seventeen locals')
    return mapped


def _identity_register_plan():
    return PureSlice(
        0, 0, 0, 0, 0, (), DependencyWaves((0,), (), (0,)), (),
        tuple(Operand('local', index) for index in range(16)))


def _lowered_boundary_memory(boundary):
    """Return whether a boundary's physical lowering can architecturally fault."""
    lowered = X86DBT._stack_plan(boundary)
    plan = None if lowered is None else lowered[0]
    if plan is None:
        lowered = X86DBT._memory_plan(boundary)
        plan = None if lowered is None else lowered[0]
    if plan is None:
        lowered = X86DBT._descriptor_plan(boundary)
        plan = None if lowered is None else lowered[0]
    if plan is None:
        plan = X86DBT._indirect_control_plan(boundary)
    if plan is None:
        identity = X86DBT._carry_flags_plan(_identity_register_plan())
        lowered = X86DBT._lower_flag_boundary(identity, boundary)
        plan = None if lowered is None else lowered[0]
    return bool(plan is not None and any(
        node.op.startswith('memory.') for node in plan.nodes))


def pack_native_x86_records(block):
    """Split a faultable terminal instruction at its architectural cut.

    Pure prefix state must be visible when the following memory instruction
    faults.  The internal record boundary is not a host quantum: vm.wasm loads
    the second record immediately and only then publishes one completed x86
    block to its caller.
    """
    if (block.boundary_rip == block.rip
            or not _lowered_boundary_memory(block.boundary)):
        record = pack_native_x86_block(block)
        return ((int(block.rip) & MASK64, record),)
    prefix = replace(
        block,
        boundary=X86Boundary(
            'native_internal_branch', int(block.boundary_rip) & MASK64))
    terminal = replace(
        block, rip=int(block.boundary_rip) & MASK64,
        source=b'', instructions=0,
        plan=_identity_register_plan(), scratch_count=0,
        flag_cut=None, control_block=None, cut_inputs=(), state_flags=False,
        virtual_memory=False, indirect_register=None, tail_return=None,
        inlined_call_target=None)
    return (
        (int(prefix.rip) & MASK64, pack_native_x86_block(prefix)),
        (int(terminal.rip) & MASK64, pack_native_x86_block(terminal)),
    )


def select_physical_cut(dbt, rip):
    """Select the strongest reached physical cut published at one entry.

    Residual recurrence and scan cuts replace their scalar basic-block entry;
    choosing an older register cut here would silently reintroduce work that
    the runtime proof has already removed.
    """
    rip = int(rip) & MASK64
    residuals = []
    for _branch, entry in dbt._recurrence_cuts.values():
        if entry is not None:
            residuals.append(entry[0])
    for _branch, _config, _proof, cut in dbt._prefix_cuts.values():
        residuals.append(cut)
    for _branch, entry in dbt._find_cuts.values():
        residuals.append(entry[1])
    for _branch, entry in dbt._copy_cuts.values():
        residuals.append(entry[1])
    for cut in residuals:
        if cut.rip == rip:
            return cut
    for cache in (dbt._register_cuts, dbt._stack_cuts,
                  dbt._predicate_cuts):
        cached = cache.get(rip)
        if cached is not None:
            return cached[1]
    return dbt.blocks.get(rip)


def load_x86_code_pages(payload, state, dbt=None):
    """Restore authenticated mapped pages whose current x86 bytes still match.

    The caller authenticates the archive itself. Direct page proofs established
    here only decide whether later guest writes invalidate a restored block.
    """
    if not isinstance(state, X86State):
        raise TypeError('x86 code page restore needs an X86State')
    dbt = X86DBT() if dbt is None else dbt
    if not isinstance(dbt, X86DBT):
        raise TypeError('x86 code page restore needs an X86DBT')
    if dbt.blocks:
        raise ValueError('x86 code pages can only restore into an empty DBT')
    payload = memoryview(payload)
    prefix = len(CODE_MAGIC)
    if len(payload) < prefix + 4 or bytes(payload[:prefix]) != CODE_MAGIC:
        raise X86Error('x86 code page archive header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    cursor = prefix + 4
    header_end = cursor + header_bytes
    if header_end > len(payload):
        raise X86Error('x86 code page archive metadata is truncated')
    try:
        header = json.loads(bytes(payload[cursor:header_end]).decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise X86Error('x86 code page archive metadata is invalid') from error
    block_count = int(header.get('blocks', -1))
    if block_count < 0:
        raise X86Error('x86 code page archive count is invalid')
    cursor = header_end
    previous = -1
    from .x86 import X86Boundary
    for _unused in range(block_count):
        record_end = cursor + CODE_RECORD.size
        if record_end > len(payload):
            raise X86Error('x86 code page record is truncated')
        (rip, boundary_rip, instructions, scratch_count,
         source_bytes, mapped_bytes, boundary_bytes) = CODE_RECORD.unpack_from(
             payload, cursor)
        cursor = record_end
        if rip <= previous:
            raise X86Error('x86 code pages are not coordinate ordered')
        previous = rip
        extent = source_bytes + mapped_bytes + boundary_bytes
        if not source_bytes or cursor + extent > len(payload):
            raise X86Error('x86 code page payload is truncated')
        source = bytes(payload[cursor:cursor + source_bytes])
        cursor += source_bytes
        mapped = unpack_step(payload[cursor:cursor + mapped_bytes])
        cursor += mapped_bytes
        try:
            boundary_record = json.loads(
                bytes(payload[cursor:cursor + boundary_bytes])
                .decode('ascii'))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise X86Error('x86 code page boundary is invalid') from error
        cursor += boundary_bytes
        if (mapped.function != 0 or mapped.start != 0
                or mapped.end != instructions
                or mapped.instructions != instructions
                or mapped.stack_inputs or mapped.stack_count
                or mapped.local_extent != 16 + scratch_count):
            raise X86Error('x86 mapped code page shape is invalid')
        try:
            operation = str(boundary_record['operation'])
            detail = _load_code_value(boundary_record['detail'])
        except (KeyError, TypeError, ValueError) as error:
            raise X86Error('x86 code page boundary is invalid') from error
        try:
            matches = read_virtual(
                state, rip, len(source), 'execute') == source
        except Exception as error:
            from .x86 import PageFault
            if not isinstance(error, PageFault):
                raise
            matches = False
        if not matches:
            dbt.rejected_code_blocks += 1
            continue
        proof_config, proof = _execution_proof(
            state, rip, len(source))
        block = DecodedBlock(
            rip, boundary_rip, source, instructions,
            decode_plan(mapped), mapped, dbt._bind_state_page(mapped),
            scratch_count, X86Boundary(operation, detail),
            proof_config, proof)
        dbt._remember_block(block)
        dbt.restored_code_blocks += 1
        dbt.source_instructions += instructions
        dbt.physical_work += mapped.work
        dbt.physical_span += mapped.span
    if cursor != len(payload):
        raise X86Error('x86 code page archive has trailing bytes')
    return dbt


def dump_x86_state(state, baseline=None):
    """Encode one persistent state without materializing untouched RAM."""
    memory = state.memory.commit() if isinstance(
        state.memory, MemoryCut) else state.memory
    if not isinstance(memory, PagedMemory):
        raise TypeError('x86 snapshot memory must be directly paged')
    if isinstance(baseline, MemoryCut):
        baseline = baseline.commit()
    if baseline is not None and not isinstance(baseline, PagedMemory):
        raise TypeError('x86 snapshot baseline must be directly paged')
    pages = (memory.canonical_pages if baseline is None
             else memory.canonical_difference(baseline))
    base = memory.base if baseline is None else b''
    header = json.dumps({
        'registers': list(state.registers),
        'rip': int(state.rip),
        'rflags': int(state.rflags),
        'cr0': int(state.cr0),
        'cr2': int(state.cr2),
        'cr3': int(state.cr3),
        'cr4': int(state.cr4),
        'cr8': int(state.cr8),
        'efer': int(state.efer),
        'gdtr': list(state.gdtr),
        'idtr': list(state.idtr),
        'segments': [state.cs, state.ds, state.es, state.ss,
                     state.fs, state.gs],
        'ldtr': int(state.ldtr),
        'tr': int(state.tr),
        'debug': list(state.debug),
        'msrs': [list(item) for item in state.msrs],
        'halted': bool(state.halted),
        'interrupts': list(state.interrupts),
        'memory_length': len(memory),
        'base_bytes': len(base),
        'baseline': baseline is not None,
        'page_bytes': MEMORY_PAGE,
        'page_encoding': 'canonical-region-v1',
        'pages': len(pages),
    }, sort_keys=True, separators=(',', ':')).encode('ascii')
    output = bytearray(MAGIC)
    output.extend(struct.pack('<I', len(header)))
    output.extend(header)
    output.extend(base)
    for index, page in pages:
        if page is None:
            output.extend(RECORD.pack(index, PAGE_BASE))
        elif 32 + len(page.values) <= MEMORY_PAGE:
            output.extend(RECORD.pack(index, PAGE_DOMAIN))
            output.extend(page.domain.to_bytes(32, 'little'))
            output.extend(page.values)
        else:
            output.extend(RECORD.pack(index, PAGE_RAW))
            output.extend(memory._page(index))
    return bytes(output)


def load_x86_state(payload, baseline=None):
    """Decode a checkpoint and reject non-canonical page coordinates."""
    payload = memoryview(payload)
    prefix = len(MAGIC)
    if len(payload) < prefix + 4 or bytes(payload[:prefix]) != MAGIC:
        raise X86Error('x86 snapshot header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    cursor = prefix + 4
    header_end = cursor + header_bytes
    if header_end > len(payload):
        raise X86Error('x86 snapshot metadata is truncated')
    try:
        header = json.loads(bytes(payload[cursor:header_end]).decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise X86Error('x86 snapshot metadata is invalid') from error
    if int(header.get('page_bytes', 0)) != MEMORY_PAGE:
        raise X86Error('x86 snapshot page size is unsupported')
    memory_length = int(header['memory_length'])
    base_bytes = int(header['base_bytes'])
    page_count = int(header['pages'])
    if min(memory_length, base_bytes, page_count) < 0 \
            or base_bytes > memory_length:
        raise X86Error('x86 snapshot memory extent is invalid')
    cursor = header_end
    base_end = cursor + base_bytes
    if (base_end > len(payload)
            or header.get('page_encoding') != 'canonical-region-v1'):
        raise X86Error('x86 snapshot page records are truncated')
    base = bytes(payload[cursor:base_end])
    cursor = base_end
    pages = []
    previous = -1
    for _unused in range(page_count):
        if cursor + RECORD.size > len(payload):
            raise X86Error('x86 snapshot page record is truncated')
        index, kind = RECORD.unpack_from(payload, cursor)
        cursor += RECORD.size
        if index <= previous:
            raise X86Error('x86 snapshot pages are not coordinate ordered')
        previous = index
        if kind == PAGE_BASE:
            page = None
        elif kind == PAGE_DOMAIN:
            if cursor + 32 > len(payload):
                raise X86Error('x86 snapshot page domain is truncated')
            domain = int.from_bytes(payload[cursor:cursor + 32], 'little')
            cursor += 32
            count = domain.bit_count()
            if not domain or cursor + count > len(payload):
                raise X86Error('x86 snapshot page difference is invalid')
            page = CanonicalPage(domain,
                                 bytes(payload[cursor:cursor + count]))
            cursor += count
        elif kind == PAGE_RAW:
            if cursor + MEMORY_PAGE > len(payload):
                raise X86Error('x86 snapshot raw page is truncated')
            page = bytes(payload[cursor:cursor + MEMORY_PAGE])
            cursor += MEMORY_PAGE
        else:
            raise X86Error('x86 snapshot page encoding is invalid')
        pages.append((index, page))
    if cursor != len(payload):
        raise X86Error('x86 snapshot has trailing page data')
    if header.get('baseline', False):
        if not isinstance(baseline, PagedMemory):
            raise X86Error('x86 delta snapshot needs its boot memory')
        if len(baseline) != memory_length or base:
            raise X86Error('x86 snapshot baseline extent is invalid')
        memory = baseline
    else:
        memory = PagedMemory(base, memory_length)
    normalized = []
    for index, page in pages:
        if isinstance(page, bytes):
            page = CanonicalPage.compose(
                lambda offset, count, coordinate=index:
                    memory._base_page_slice(coordinate, offset, count),
                None, mask_of(MEMORY_PAGE), page)
        normalized.append((index, page))
    memory = memory.replace_canonical_pages(normalized)

    def integers(name, count):
        values = tuple(int(value) & MASK64 for value in header[name])
        if len(values) != count:
            raise X86Error('x86 snapshot %s has the wrong size' % name)
        return values

    registers = integers('registers', 16)
    gdtr = integers('gdtr', 2)
    idtr = integers('idtr', 2)
    segments = integers('segments', 6)
    msrs = tuple(
        tuple(int(value) & MASK64 for value in pair)
        for pair in header.get('msrs', ()))
    if any(len(pair) != 2 for pair in msrs):
        raise X86Error('x86 snapshot MSR record has the wrong size')
    debug = tuple(int(value) & MASK64
                  for value in header.get('debug', (0,) * 8))
    if len(debug) != 8:
        raise X86Error('x86 snapshot debug-register bank has the wrong size')
    interrupts = tuple(int(value) & 0xff
                       for value in header.get('interrupts', ()))
    return X86State(
        registers, int(header['rip']) & MASK64, memory,
        rflags=int(header['rflags']) & MASK64,
        cr0=int(header['cr0']) & MASK64,
        cr2=int(header['cr2']) & MASK64,
        cr3=int(header['cr3']) & MASK64,
        cr4=int(header['cr4']) & MASK64,
        cr8=int(header['cr8']) & MASK64,
        efer=int(header['efer']) & MASK64,
        gdtr=gdtr, idtr=idtr,
        cs=segments[0], ds=segments[1], es=segments[2],
        ss=segments[3], fs=segments[4], gs=segments[5],
        ldtr=int(header.get('ldtr', 0)) & 0xffff,
        tr=int(header.get('tr', 0)) & 0xffff,
        debug=debug, msrs=msrs, halted=bool(header.get('halted', False)),
        interrupts=interrupts)


def _event_record(event):
    if event is None:
        return None
    data = event.data
    if data is None:
        encoded = None
    elif isinstance(data, int):
        encoded = {'kind': 'integer', 'value': int(data)}
    elif isinstance(data, (bytes, bytearray, memoryview)):
        encoded = {'kind': 'bytes', 'value': bytes(data).hex()}
    else:
        raise TypeError('x86 pending event data is not serializable')
    return {
        'operation': event.operation,
        'coordinate': [int(value) for value in event.coordinate],
        'data': encoded,
        'thread': int(event.thread),
        'cost': [int(getattr(event.cost, name)) for name in _COST_FIELDS],
    }


def _load_event(record):
    if record is None:
        return None
    encoded = record.get('data')
    if encoded is None:
        data = None
    elif encoded.get('kind') == 'integer':
        data = int(encoded['value'])
    elif encoded.get('kind') == 'bytes':
        try:
            data = bytes.fromhex(encoded['value'])
        except (TypeError, ValueError) as error:
            raise X86Error('x86 pending event bytes are invalid') from error
    else:
        raise X86Error('x86 pending event data kind is unsupported')
    costs = tuple(int(value) for value in record.get('cost', ()))
    if len(costs) != len(_COST_FIELDS) or min(costs, default=0) < 0:
        raise X86Error('x86 pending event cost has the wrong size')
    try:
        return MachineEvent(
            str(record['operation']),
            tuple(int(value) for value in record.get('coordinate', ())),
            data, int(record.get('thread', 0)), WaveCost(*costs))
    except (KeyError, TypeError, ValueError) as error:
        raise X86Error('x86 pending event is invalid') from error


def dump_x86_machine_state(state, baseline=None):
    """Encode CPU pages together with the resumable device boundary state."""
    if not isinstance(state, X86MachineState):
        raise TypeError('x86 machine snapshot needs an X86MachineState')
    cpu = dump_x86_state(state.cpu, baseline)
    console = bytes(state.console_input)
    output = bytes(state.console_output)
    ports = tuple((int(port), int(value)) for port, value in state.io_ports)
    if ports != tuple(sorted(ports)) or len({port for port, _ in ports}) \
            != len(ports) or any(port < 0 or value < 0 for port, value in ports):
        raise ValueError('x86 I/O ports must be unique ordered coordinates')
    header = json.dumps({
        'cpu_bytes': len(cpu),
        'console_bytes': len(console),
        'console_output_bytes': len(output),
        'io_ports': [list(item) for item in ports],
        'pending': _event_record(state.pending),
    }, sort_keys=True, separators=(',', ':')).encode('ascii')
    return b''.join((
        MACHINE_MAGIC, struct.pack('<I', len(header)), header,
        console, output, cpu,
    ))


def load_x86_machine_state(payload, baseline=None):
    """Restore a machine snapshot, accepting legacy CPU-only checkpoints."""
    payload = bytes(payload)
    if payload.startswith(MAGIC):
        return X86MachineState(load_x86_state(payload, baseline))
    prefix = len(MACHINE_MAGIC)
    if len(payload) < prefix + 4 or not payload.startswith(MACHINE_MAGIC):
        raise X86Error('x86 machine snapshot header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    cursor = prefix + 4
    header_end = cursor + header_bytes
    if header_end > len(payload):
        raise X86Error('x86 machine snapshot metadata is truncated')
    try:
        header = json.loads(payload[cursor:header_end].decode('ascii'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise X86Error('x86 machine snapshot metadata is invalid') from error
    console_bytes = int(header.get('console_bytes', -1))
    output_bytes = int(header.get('console_output_bytes', 0))
    cpu_bytes = int(header.get('cpu_bytes', -1))
    if min(console_bytes, output_bytes, cpu_bytes) < 0 \
            or (header_end + console_bytes + output_bytes + cpu_bytes
                != len(payload)):
        raise X86Error('x86 machine snapshot extents are invalid')
    console_end = header_end + console_bytes
    output_end = console_end + output_bytes
    console = payload[header_end:console_end]
    output = payload[console_end:output_end]
    cpu = load_x86_state(payload[output_end:], baseline)
    try:
        ports = tuple((int(port), int(value))
                      for port, value in header.get('io_ports', ()))
    except (TypeError, ValueError) as error:
        raise X86Error('x86 machine I/O state is invalid') from error
    if ports != tuple(sorted(ports)) or len({port for port, _ in ports}) \
            != len(ports) or any(port < 0 or value < 0 for port, value in ports):
        raise X86Error('x86 machine I/O state is not canonical')
    return X86MachineState(
        cpu, pending=_load_event(header.get('pending')),
        io_ports=ports, console_input=console, console_output=output)
