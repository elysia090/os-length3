"""Portable x86 CPU and direct-page memory checkpoints."""

from dataclasses import replace
import hashlib
from heapq import merge
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
                  X86Boundary, X86MachineState, X86State,
                  _block_code_extents, _block_source_instructions,
                  _execution_proof,
                  read_virtual)
from qm.steppage import (decode_plan, instantiate_step_template,
                         pack as pack_step, project_step_template,
                         StatePageError, unpack as unpack_step)


MAGIC = b'x86-state-v1\n'
MACHINE_MAGIC = b'x86-machine-v1\n'
BOOT_CACHE_MAGIC = b'x86-boot-cache-v1\n'
CODE_MAGIC = b'x86-code-v1\n'
NATIVE_BLOCK_MAGIC = b'X86B'
NATIVE_DESCRIPTOR_MAGIC = b'X86D'
NATIVE_MACHINE_V1_MAGIC = b'x86-native-machine-v1\n'
NATIVE_MACHINE_V2_MAGIC = b'x86-native-machine-v2\n'
NATIVE_MACHINE_V3_MAGIC = b'x86-native-machine-v3\n'
NATIVE_MACHINE_V4_MAGIC = b'x86-native-machine-v4\n'
NATIVE_MACHINE_MAGIC = b'x86-native-machine-v5\n'
RECORD = struct.Struct('<QB')
PAGE_BASE = 0
PAGE_DOMAIN = 1
PAGE_RAW = 2
CODE_RECORD = struct.Struct('<QQIIIII')
NATIVE_BLOCK_HEADER = struct.Struct('<4sHHQQIIQQQ8x')
NATIVE_DESCRIPTOR_HEADER = struct.Struct('<4sHHQQIIQQQII')
NATIVE_BLOCK_INSTANCE = struct.Struct('<QIII')
NATIVE_CONTROL_TEMPLATE = struct.Struct('<IIQQQQ')
NATIVE_CONTINUATION_OFFSET = struct.Struct('<I')
NATIVE_STEP_EXTENT = struct.Struct('<II')
NATIVE_STEP_INSTANCE = struct.Struct('<IIII')
NATIVE_STEP_HASH_EXTENT = struct.Struct('<32sII')
NATIVE_CODE_GUARD_EXTENT = struct.Struct('<QH')
NATIVE_REGION_BYTES = 1 << 16
_COST_FIELDS = (
    'instructions', 'work', 'span', 'slices', 'barriers',
    'max_parallel_width',
)

BOOT_SPAN_BYTES = 1 << 16
BOOT_SPAN_PAGES = BOOT_SPAN_BYTES // MEMORY_PAGE


def _project_native_x86_continuation(fields):
    """Return the RIP-relative control residual of one native block.

    The block coordinate already identifies RIP.  Static successors are
    therefore displacements, while local/register/control descriptors remain
    exact words.  Boundary RIP is retained as a displacement even where the
    current executor does not observe it, so loading an artifact reconstructs
    the exact canonical X86B record.
    """
    rip = int(fields[3]) & MASK64
    boundary = (int(fields[4]) - rip) & MASK64
    control = int(fields[6])
    first, second, third = (int(value) & MASK64 for value in fields[7:10])
    if control == 2:
        first = (first - rip) & MASK64
        second = (second - rip) & MASK64
    elif control not in (0, 3, 4, 5, 12, 14, 22):
        first = (first - rip) & MASK64
    return control, boundary, first, second, third


def _instantiate_native_x86_continuation(rip, continuation):
    control, boundary, first, second, third = continuation
    rip = int(rip) & MASK64
    boundary = (rip + int(boundary)) & MASK64
    if control == 2:
        first = (rip + int(first)) & MASK64
        second = (rip + int(second)) & MASK64
    elif control not in (0, 3, 4, 5, 12, 14, 22):
        first = (rip + int(first)) & MASK64
    return boundary, int(control), int(first), int(second), int(third)


def _native_signed_residual(value):
    value = int(value) & MASK64
    signed = value if value < (1 << 63) else value - (1 << 64)
    for code, width in ((3, 1), (4, 2), (5, 4)):
        limit = 1 << (width * 8 - 1)
        if -limit <= signed < limit:
            return code, width, signed
    return 6, 8, signed


def _encode_native_x86_continuation(continuation):
    """Encode one continuation as canonical residual fields.

    Four three-bit tags select zero, a prior field, or the shortest signed
    scalar.  Static targets have already been projected relative to RIP, so
    the common branch row is only a tag plus one small displacement.
    """
    control, boundary, first, second, third = map(int, continuation)
    if not 0 <= control <= 42:
        raise ValueError('native x86 continuation control is invalid')
    values = tuple(value & MASK64 for value in (
        boundary, first, second, third))
    tags = 0
    payload = bytearray()
    for index, value in enumerate(values):
        if not value:
            code = 0
        elif index and value == values[0]:
            code = 1
        elif index > 1 and value == values[1]:
            code = 2
        else:
            code, width, signed = _native_signed_residual(value)
            payload.extend(int(signed).to_bytes(
                width, 'little', signed=True))
        tags |= code << (index * 3)
    return bytes((control, tags & 0xff, tags >> 8)) + bytes(payload)


def _decode_native_x86_continuation(payload):
    """Decode and prove the unique minimal continuation representation."""
    payload = bytes(payload)
    if len(payload) < 3:
        raise ValueError('native x86 continuation is truncated')
    control = payload[0]
    tags = payload[1] | payload[2] << 8
    if control > 42 or tags >> 12:
        raise ValueError('native x86 continuation tag is invalid')
    cursor = 3
    values = []
    widths = {3: 1, 4: 2, 5: 4, 6: 8}
    for index in range(4):
        code = (tags >> (index * 3)) & 7
        if code == 0:
            value = 0
        elif code == 1 and index:
            value = values[0]
        elif code == 2 and index > 1:
            value = values[1]
        elif code in widths:
            width = widths[code]
            if cursor + width > len(payload):
                raise ValueError('native x86 continuation is truncated')
            value = int.from_bytes(
                payload[cursor:cursor + width], 'little', signed=True) \
                & MASK64
            cursor += width
        else:
            raise ValueError('native x86 continuation field is invalid')
        values.append(value)
    continuation = (control, *values)
    if cursor != len(payload) \
            or _encode_native_x86_continuation(continuation) != payload:
        raise ValueError('native x86 continuation is not canonical')
    return continuation


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


def canonical_native_x86_packed_records(packed_blocks):
    """Canonicalize blocks that were already projected to portable records."""
    variants = {}
    internal_variants = set()
    for primary_rip, packed_records in packed_blocks:
        primary_rip = int(primary_rip) & MASK64
        for rip, record in packed_records:
            _fields, guard, _step = split_native_x86_record(record)
            key = int(rip) & MASK64, guard
            prior = variants.get(key)
            if prior is not None and prior != record:
                internal = rip != primary_rip
                prior_internal = key in internal_variants
                # A faultable terminal is deliberately split from its pure
                # prefix.  If normal control also reached that instruction,
                # its primary cut starts at the same architectural retry
                # coordinate and may safely subsume the smaller terminal.
                # Prefer it so native and reference quanta retain the same
                # maximal-cut boundary.
                if prior_internal and not internal:
                    variants[key] = record
                    internal_variants.discard(key)
                    continue
                if not prior_internal and internal:
                    continue
                raise ValueError(
                    'native x86 coordinate %#x has distinct %s records'
                    % (rip, 'internal' if internal else 'primary'))
            variants[key] = record
            if rip != primary_rip:
                internal_variants.add(key)
    return tuple((rip, record)
                 for (rip, _guard), record in sorted(variants.items()))


def canonical_native_x86_records(blocks):
    """Choose the one strongest portable record at every native coordinate."""
    def packed():
        for block in blocks:
            try:
                records = pack_native_x86_records(block)
            except (StatePageError, TypeError, ValueError) as error:
                raise ValueError(
                    'native x86 cut %#x cannot be packed: %s'
                    % (int(block.rip) & MASK64, error)) from error
            yield int(block.rip) & MASK64, records

    return canonical_native_x86_packed_records(packed())


def dump_native_x86_machine(boot_cache, state, blocks):
    """Join boot state, sparse RAM, descriptors, and shared STEP identities."""
    if not isinstance(state, X86State):
        raise TypeError('native x86 machine needs an X86State')
    memory = _boot_cache_memory_bytes(boot_cache)
    prefix_bytes = bundle_prefix_size(memory)
    def word(value):
        return '%016x' % (int(value) & MASK64)

    system = (
        state.cr2, state.cr8,
        state.gdtr[0], state.gdtr[1], state.idtr[0], state.idtr[1],
        state.es, state.cs, state.ss, state.ds, state.fs, state.gs,
        state.ldtr, state.tr,
    ) + tuple(state.debug)
    header = {
        'state': {
            'registers': [word(value) for value in state.registers],
            'rip': word(state.rip), 'rflags': word(state.rflags),
            'cr0': word(state.cr0), 'cr3': word(state.cr3),
            'cr4': word(state.cr4), 'efer': word(state.efer),
            'system': [word(value) for value in system],
            'msrs': [[word(key), word(value)] for key, value in state.msrs],
            'xmm': [word(value) for value in state.xmm],
        },
        'memory': {
            'bytes': len(memory),
            'length': len(state.memory),
            'prefix_bytes': prefix_bytes,
            'prefix_sha256': hashlib.sha256(
                memory[:prefix_bytes]).hexdigest(),
        },
    }
    return _encode_native_x86_machine(
        header, memory, canonical_native_x86_records(blocks))


def _align_native_region(value):
    return (int(value) + NATIVE_REGION_BYTES - 1) \
        & -NATIVE_REGION_BYTES


def _encode_native_x86_machine(header, memory, records):
    """Encode block descriptors over shared SSA templates and parameters."""
    variants = {}
    for raw_rip, raw_record in records:
        rip = int(raw_rip) & MASK64
        _fields, guard, physical = physical_native_x86_record(
            raw_record, rip)
        key = rip, guard
        prior = variants.get(key)
        if prior is not None and prior != physical:
            raise ValueError(
                'native x86 coordinate %#x has distinct records for one proof'
                % rip)
        variants[key] = physical

    return _encode_native_x86_physical(header, memory, variants)


def physical_native_x86_record(record, coordinate):
    """Return one validated record in the rank-native physical identity."""
    rip = int(coordinate) & MASK64
    record = bytes(record)
    validate_native_x86_record(record, rip)
    fields, guard, step = split_native_x86_record(record)
    template, parameters = project_step_template(step)
    return fields, guard, (
        guard, (template, parameters, len(step)),
        _project_native_x86_continuation(fields))


def _encode_native_x86_physical(
        header, memory, variants, sorted_prefix=0):
    """Encode canonical rank directories from already projected STEP rows."""
    memory = bytes(memory)

    # First-coordinate ranking is canonical because block coordinates are
    # sorted. It also preserves execution locality; sorting by a random-looking
    # digest would destroy the delivery codec's compression neighborhoods.
    steps = {}
    guards = {}
    continuations = {}
    record_fields = {}
    # Admission is first-match.  A closed recurrence has an explicit entry
    # contract and therefore outranks its scalar prefixes; ordinary composed
    # cuts keep lexical order until their residual-state proof is encoded.
    order_key = lambda key: _native_variant_order(key, variants[key])
    keys = tuple(variants)
    sorted_prefix = int(sorted_prefix)
    if (sorted_prefix > 0
            and header.get('candidate_order') == 'closed-recurrence-first'
            and sorted_prefix <= len(keys)):
        # A loaded schema-5 directory is already canonical. Extension keeps
        # that insertion order and appends only newly proved identities, so
        # sort the small suffix and merge the two runs instead of sorting the
        # complete resident kernel graph after every checkpoint.
        ordered_keys = tuple(merge(
            keys[:sorted_prefix],
            sorted(keys[sorted_prefix:], key=order_key),
            key=order_key))
    else:
        ordered_keys = tuple(sorted(keys, key=order_key))
    for key in ordered_keys:
        guard, step, continuation = variants[key]
        steps.setdefault(step, None)
        if guard:
            guards.setdefault(guard, None)
        continuations.setdefault(continuation, None)
        record_fields[key] = (guard, step, continuation)

    ordered_steps = tuple(steps)
    ordered_guards = tuple(guards)
    guard_rank_by_identity = {
        guard: rank for rank, guard in enumerate(ordered_guards, 1)
    }
    ordered_continuations = tuple(continuations)
    continuation_rank = {
        continuation: rank
        for rank, continuation in enumerate(ordered_continuations, 1)
    }
    templates = {}
    for step in ordered_steps:
        template, _parameters, _step_bytes = step
        templates.setdefault(template, None)
    ordered_templates = tuple(templates)
    template_rank = {
        template: rank for rank, template in enumerate(ordered_templates, 1)
    }
    step_rank = {
        step: rank for rank, step in enumerate(ordered_steps, 1)
    }

    template_directory = []
    step_directory = []
    guard_directory = []
    execution = bytearray()
    for template in ordered_templates:
        template_directory.append((len(execution), len(template)))
        execution.extend(template)
    template_execution_bytes = len(execution)
    for step in ordered_steps:
        template, parameters, step_bytes = step
        step_directory.append((
            template_rank[template], len(execution),
            len(parameters), step_bytes))
        execution.extend(parameters)
    parameter_execution_bytes = len(execution) - template_execution_bytes
    for guard in ordered_guards:
        guard_directory.append((len(execution), len(guard)))
        execution.extend(guard)

    descriptors = bytearray()
    block_directory = []
    for key in ordered_keys:
        rip, _identity = key
        guard, step, continuation = record_fields[key]
        descriptors.extend(NATIVE_BLOCK_INSTANCE.pack(
            rip, step_rank[step], continuation_rank[continuation],
            0 if not guard else guard_rank_by_identity[guard]))
        block_directory.append('%016x' % rip)
    for instance in step_directory:
        descriptors.extend(NATIVE_STEP_INSTANCE.pack(*instance))
    for offset, length in template_directory:
        descriptors.extend(NATIVE_STEP_EXTENT.pack(offset, length))
    for offset, length in guard_directory:
        descriptors.extend(NATIVE_STEP_EXTENT.pack(offset, length))
    continuation_payload = bytearray()
    continuation_offsets = [0]
    for continuation in ordered_continuations:
        continuation_payload.extend(
            _encode_native_x86_continuation(continuation))
        continuation_offsets.append(len(continuation_payload))
    for offset in continuation_offsets:
        descriptors.extend(NATIVE_CONTINUATION_OFFSET.pack(offset))
    descriptors.extend(continuation_payload)

    encoded_header = dict(header)
    encoded_header.update({
        'schema': 5,
        'candidate_order': 'closed-recurrence-first',
        'block_count': len(block_directory),
        'step_count': len(step_directory),
        'template_count': len(template_directory),
        'guard_count': len(guard_directory),
        'continuation_count': len(ordered_continuations),
        'continuation_bytes': len(continuation_payload),
        'descriptor_bytes': len(descriptors),
        'execution_bytes': len(execution),
        'template_execution_bytes': template_execution_bytes,
        'parameter_execution_bytes': parameter_execution_bytes,
        'guard_execution_bytes': (
            len(execution) - template_execution_bytes
            - parameter_execution_bytes),
        'step_identity': {
            'kind': 'template-parameter-rank',
            'order': 'first-rip',
            'records': len(block_directory),
            'unique': len(ordered_steps),
            'shared': len(block_directory) - len(ordered_steps),
        },
        'step_template_identity': {
            'kind': 'normalized-ssa-frame-projection',
            'order': 'first-rip',
            'instances': len(ordered_steps),
            'unique': len(ordered_templates),
            'shared': len(ordered_steps) - len(ordered_templates),
        },
        'code_identity': {
            'kind': 'exact-byte-extents',
            'order': 'first-rip',
            'records': len(block_directory),
            'unique': len(ordered_guards),
            'shared': len(block_directory) - len(ordered_guards),
        },
        'continuation_identity': {
            'kind': 'field-residual-tail-offset-csr',
            'order': 'first-rip',
            'records': len(block_directory),
            'unique': len(ordered_continuations),
            'shared': len(block_directory) - len(ordered_continuations),
        },
        'regions': {
            'page_bytes': NATIVE_REGION_BYTES,
            'memory': [0, len(memory)],
            'descriptors': [0, len(descriptors)],
            'execution': [0, len(execution)],
        },
    })
    # Region coordinates are absolute artifact offsets. Iterate because the
    # decimal coordinates live in the JSON whose own length sets the first
    # aligned coordinate.
    for _ in range(8):
        encoded = json.dumps(
            encoded_header, sort_keys=True,
            separators=(',', ':')).encode('ascii')
        memory_offset = _align_native_region(
            len(NATIVE_MACHINE_MAGIC) + 4 + len(encoded))
        descriptor_offset = _align_native_region(
            memory_offset + len(memory))
        execution_offset = _align_native_region(
            descriptor_offset + len(descriptors))
        regions = {
            'page_bytes': NATIVE_REGION_BYTES,
            'memory': [memory_offset, len(memory)],
            'descriptors': [descriptor_offset, len(descriptors)],
            'execution': [execution_offset, len(execution)],
        }
        if encoded_header['regions'] == regions:
            break
        encoded_header['regions'] = regions
    else:
        raise AssertionError('native x86 region directory did not converge')
    encoded = json.dumps(
        encoded_header, sort_keys=True, separators=(',', ':')).encode('ascii')
    end = execution_offset + len(execution)
    payload = bytearray(end)
    cursor = len(NATIVE_MACHINE_MAGIC)
    payload[:cursor] = NATIVE_MACHINE_MAGIC
    struct.pack_into('<I', payload, cursor, len(encoded))
    payload[cursor + 4:cursor + 4 + len(encoded)] = encoded
    payload[memory_offset:memory_offset + len(memory)] = memory
    payload[descriptor_offset:descriptor_offset + len(descriptors)] = \
        descriptors
    payload[execution_offset:end] = execution
    return bytes(payload)


def load_native_x86_machine(payload, scrub_invalid=False):
    """Return ``(metadata, memory bundle, full records)`` from any schema."""
    payload = payload if isinstance(payload, memoryview) else memoryview(payload)
    if bytes(payload[:len(NATIVE_MACHINE_MAGIC)]) == NATIVE_MACHINE_MAGIC:
        magic, schema = NATIVE_MACHINE_MAGIC, 5
    elif bytes(payload[:len(NATIVE_MACHINE_V4_MAGIC)]) == \
            NATIVE_MACHINE_V4_MAGIC:
        magic, schema = NATIVE_MACHINE_V4_MAGIC, 4
    elif bytes(payload[:len(NATIVE_MACHINE_V3_MAGIC)]) == \
            NATIVE_MACHINE_V3_MAGIC:
        magic, schema = NATIVE_MACHINE_V3_MAGIC, 3
    elif bytes(payload[:len(NATIVE_MACHINE_V2_MAGIC)]) == \
            NATIVE_MACHINE_V2_MAGIC:
        magic, schema = NATIVE_MACHINE_V2_MAGIC, 2
    elif bytes(payload[:len(NATIVE_MACHINE_V1_MAGIC)]) == \
            NATIVE_MACHINE_V1_MAGIC:
        magic, schema = NATIVE_MACHINE_V1_MAGIC, 1
    else:
        raise X86Error('native x86 machine header is invalid')
    prefix = len(magic)
    if len(payload) < prefix + 4:
        raise X86Error('native x86 machine header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    header_start = prefix + 4
    header_end = header_start + header_bytes
    if header_end > len(payload):
        raise X86Error('native x86 machine metadata is truncated')
    try:
        header = json.loads(bytes(payload[header_start:header_end]))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise X86Error('native x86 machine metadata is invalid') from error
    if int(header.get('schema', -1)) != schema:
        raise X86Error('native x86 machine schema is invalid')

    records = []
    try:
        memory_bytes = int(header['memory']['bytes'])
        if schema == 1:
            directory = tuple(header['blocks'])
            block_bytes = int(header['block_bytes'])
            memory_offset = header_end
            descriptor_offset = memory_offset + memory_bytes
            if (min(memory_bytes, block_bytes) < 0
                    or descriptor_offset + block_bytes != len(payload)):
                raise X86Error('native x86 machine extents are invalid')
            for raw_rip, raw_offset, raw_length in directory:
                rip = int(str(raw_rip), 16) & MASK64
                offset, length = int(raw_offset), int(raw_length)
                if min(offset, length) < 0 or offset + length > block_bytes:
                    raise X86Error('native x86 block directory is invalid')
                record = bytes(payload[
                    descriptor_offset + offset:
                    descriptor_offset + offset + length])
                try:
                    validate_native_x86_record(record, rip)
                except (StatePageError, ValueError):
                    if scrub_invalid:
                        continue
                    raise X86Error('native x86 block record is invalid')
                records.append((rip, record))
        elif schema in (4, 5):
            block_count = int(header['block_count'])
            step_count = int(header['step_count'])
            template_count = int(header['template_count'])
            guard_count = int(header['guard_count'])
            continuation_count = int(header['continuation_count'])
            continuation_bytes = (int(header['continuation_bytes'])
                                  if schema == 5 else 0)
            template_bytes = int(header['template_execution_bytes'])
            parameter_bytes = int(header['parameter_execution_bytes'])
            regions = header['regions']
            if int(regions['page_bytes']) != NATIVE_REGION_BYTES:
                raise X86Error('native x86 region geometry is invalid')
            memory_offset, memory_extent = map(int, regions['memory'])
            descriptor_offset, descriptor_bytes = map(
                int, regions['descriptors'])
            execution_offset, execution_bytes = map(
                int, regions['execution'])
            expected_descriptors = (
                block_count * NATIVE_BLOCK_INSTANCE.size
                + step_count * NATIVE_STEP_INSTANCE.size
                + (template_count + guard_count) * NATIVE_STEP_EXTENT.size
                + (continuation_count * NATIVE_CONTROL_TEMPLATE.size
                   if schema == 4 else
                   (continuation_count + 1)
                   * NATIVE_CONTINUATION_OFFSET.size
                   + continuation_bytes))
            if (memory_extent != memory_bytes
                    or descriptor_bytes != int(header['descriptor_bytes'])
                    or descriptor_bytes != expected_descriptors
                    or execution_bytes != int(header['execution_bytes'])
                    or min(block_count, step_count, template_count,
                           guard_count, continuation_count, template_bytes,
                           parameter_bytes, continuation_bytes) < 0
                    or (block_count and not continuation_count)
                    or template_bytes + parameter_bytes > execution_bytes
                    or memory_offset % NATIVE_REGION_BYTES
                    or descriptor_offset % NATIVE_REGION_BYTES
                    or execution_offset % NATIVE_REGION_BYTES
                    or not (header_end <= memory_offset
                            <= memory_offset + memory_bytes
                            <= descriptor_offset
                            <= descriptor_offset + descriptor_bytes
                            <= execution_offset
                            <= execution_offset + execution_bytes
                            == len(payload))):
                raise X86Error('native x86 machine extents are invalid')

            step_base = (descriptor_offset
                         + block_count * NATIVE_BLOCK_INSTANCE.size)
            template_base = step_base + step_count * NATIVE_STEP_INSTANCE.size
            guard_base = template_base + template_count * NATIVE_STEP_EXTENT.size
            continuation_base = guard_base \
                + guard_count * NATIVE_STEP_EXTENT.size
            templates = []
            expected_offset = 0
            identities = set()
            for index in range(template_count):
                offset, length = NATIVE_STEP_EXTENT.unpack_from(
                    payload, template_base + index * NATIVE_STEP_EXTENT.size)
                if (offset != expected_offset or length <= 0
                        or offset + length > template_bytes):
                    raise X86Error('native STEP template directory is invalid')
                template = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                if template in identities:
                    raise X86Error('native STEP template rank is not minimal')
                identities.add(template)
                templates.append(template)
                expected_offset += length
            if expected_offset != template_bytes:
                raise X86Error('native STEP template extent is invalid')

            steps = []
            identities = set()
            expected_offset = template_bytes
            for index in range(step_count):
                rank, offset, length, step_bytes = \
                    NATIVE_STEP_INSTANCE.unpack_from(
                        payload, step_base
                        + index * NATIVE_STEP_INSTANCE.size)
                if (rank <= 0 or rank > len(templates)
                        or offset != expected_offset or length < 0
                        or offset + length > template_bytes + parameter_bytes
                        or step_bytes <= 0):
                    raise X86Error('native STEP instance directory is invalid')
                parameters = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                step = instantiate_step_template(
                    templates[rank - 1], parameters)
                if step in identities:
                    raise X86Error('native STEP instance rank is not minimal')
                identities.add(step)
                steps.append(step)
                expected_offset += length
            if expected_offset != template_bytes + parameter_bytes:
                raise X86Error('native STEP parameter extent is invalid')

            guards = []
            guard_identities = set()
            expected_offset = template_bytes + parameter_bytes
            for index in range(guard_count):
                offset, length = NATIVE_STEP_EXTENT.unpack_from(
                    payload, guard_base + index * NATIVE_STEP_EXTENT.size)
                if (offset != expected_offset or length <= 0
                        or offset + length > execution_bytes):
                    raise X86Error('native code proof directory is invalid')
                guard = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                if guard in guard_identities:
                    raise X86Error('native code proof rank is not minimal')
                guards.append(guard)
                guard_identities.add(guard)
                expected_offset += length
            if expected_offset != execution_bytes:
                raise X86Error('native code proof extent is invalid')

            continuations = []
            identities = set()
            if schema == 5:
                offset_bytes = (continuation_count + 1) \
                    * NATIVE_CONTINUATION_OFFSET.size
                payload_base = continuation_base + offset_bytes
                offsets = [NATIVE_CONTINUATION_OFFSET.unpack_from(
                    payload, continuation_base
                    + index * NATIVE_CONTINUATION_OFFSET.size)[0]
                           for index in range(continuation_count + 1)]
                if (not offsets or offsets[0]
                        or offsets[-1] != continuation_bytes
                        or any(first >= second for first, second
                               in zip(offsets, offsets[1:]))):
                    raise X86Error(
                        'native x86 continuation directory is invalid')
                for start, end in zip(offsets, offsets[1:]):
                    try:
                        continuation = _decode_native_x86_continuation(
                            payload[payload_base + start:payload_base + end])
                    except ValueError as error:
                        raise X86Error(
                            'native x86 continuation is invalid') from error
                    if continuation in identities:
                        raise X86Error(
                            'native x86 continuation rank is not minimal')
                    identities.add(continuation)
                    continuations.append(continuation)
            else:
                for index in range(continuation_count):
                    fields = NATIVE_CONTROL_TEMPLATE.unpack_from(
                        payload, continuation_base
                        + index * NATIVE_CONTROL_TEMPLATE.size)
                    control, reserved, boundary, first, second, third = fields
                    continuation = control, boundary, first, second, third
                    if (reserved or control > 42
                            or continuation in identities):
                        raise X86Error(
                            'native x86 continuation rank is not minimal')
                    identities.add(continuation)
                    continuations.append(continuation)

            candidate_order = header.get(
                'candidate_order', 'guard-lexicographic')
            if candidate_order not in (
                    'guard-lexicographic', 'proved-bytes-descending',
                    'closed-recurrence-first'):
                raise X86Error('native x86 candidate order is invalid')
            prior_rip = -1
            prior_candidate = None
            for index in range(block_count):
                fields = NATIVE_BLOCK_INSTANCE.unpack_from(
                    payload, descriptor_offset
                    + index * NATIVE_BLOCK_INSTANCE.size)
                rip, rank, continuation_rank, guard_rank = map(int, fields)
                guard = (b'' if not guard_rank else
                         guards[guard_rank - 1]
                         if guard_rank <= len(guards) else None)
                continuation = (
                    continuations[continuation_rank - 1]
                    if 0 < continuation_rank <= len(continuations) else None)
                candidate = (_native_variant_order(
                    (rip, guard), continuation=continuation,
                    order=candidate_order)
                    if guard is not None else None)
                if (rip < prior_rip or guard is None or continuation is None
                        or rank <= 0 or rank > len(steps)
                        or (prior_candidate is not None
                            and candidate <= prior_candidate)):
                    raise X86Error(
                        'native x86 block instance %d at %#x is invalid'
                        % (index, rip))
                boundary, control, first, second, third = \
                    _instantiate_native_x86_continuation(rip, continuation)
                record = NATIVE_BLOCK_HEADER.pack(
                    NATIVE_BLOCK_MAGIC, 2 if guard else 1,
                    NATIVE_BLOCK_HEADER.size, rip, boundary,
                    len(steps[rank - 1]), control, first, second, third) \
                    + guard + steps[rank - 1]
                try:
                    validate_native_x86_record(record, rip)
                except (StatePageError, ValueError):
                    if scrub_invalid:
                        continue
                    raise X86Error('native x86 block record is invalid')
                records.append((rip, record))
                prior_rip = rip
                prior_candidate = candidate
        elif schema == 3:
            block_count = int(header['block_count'])
            step_count = int(header['step_count'])
            template_count = int(header['template_count'])
            guard_count = int(header['guard_count'])
            template_bytes = int(header['template_execution_bytes'])
            parameter_bytes = int(header['parameter_execution_bytes'])
            regions = header['regions']
            if int(regions['page_bytes']) != NATIVE_REGION_BYTES:
                raise X86Error('native x86 region geometry is invalid')
            memory_offset, memory_extent = map(int, regions['memory'])
            descriptor_offset, descriptor_bytes = map(
                int, regions['descriptors'])
            execution_offset, execution_bytes = map(
                int, regions['execution'])
            expected_descriptors = (
                block_count * NATIVE_DESCRIPTOR_HEADER.size
                + step_count * NATIVE_STEP_INSTANCE.size
                + (template_count + guard_count) * NATIVE_STEP_EXTENT.size)
            if (memory_extent != memory_bytes
                    or descriptor_bytes != int(header['descriptor_bytes'])
                    or descriptor_bytes != expected_descriptors
                    or execution_bytes != int(header['execution_bytes'])
                    or min(block_count, step_count, template_count,
                           guard_count, template_bytes,
                           parameter_bytes) < 0
                    or template_bytes + parameter_bytes > execution_bytes
                    or memory_offset % NATIVE_REGION_BYTES
                    or descriptor_offset % NATIVE_REGION_BYTES
                    or execution_offset % NATIVE_REGION_BYTES
                    or not (header_end <= memory_offset
                            <= memory_offset + memory_bytes
                            <= descriptor_offset
                            <= descriptor_offset + descriptor_bytes
                            <= execution_offset
                            <= execution_offset + execution_bytes
                            == len(payload))):
                raise X86Error('native x86 machine extents are invalid')

            step_base = (descriptor_offset
                         + block_count * NATIVE_DESCRIPTOR_HEADER.size)
            template_base = step_base + step_count * NATIVE_STEP_INSTANCE.size
            guard_base = template_base + template_count * NATIVE_STEP_EXTENT.size
            templates = []
            expected_offset = 0
            identities = set()
            for index in range(template_count):
                offset, length = NATIVE_STEP_EXTENT.unpack_from(
                    payload, template_base + index * NATIVE_STEP_EXTENT.size)
                if (offset != expected_offset or length <= 0
                        or offset + length > template_bytes):
                    raise X86Error('native STEP template directory is invalid')
                template = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                if template in identities:
                    raise X86Error('native STEP template rank is not minimal')
                identities.add(template)
                templates.append(template)
                expected_offset += length
            if expected_offset != template_bytes:
                raise X86Error('native STEP template extent is invalid')

            steps = []
            identities = set()
            expected_offset = template_bytes
            for index in range(step_count):
                rank, offset, length, step_bytes = \
                    NATIVE_STEP_INSTANCE.unpack_from(
                        payload, step_base
                        + index * NATIVE_STEP_INSTANCE.size)
                if (rank <= 0 or rank > len(templates)
                        or offset != expected_offset or length < 0
                        or offset + length > template_bytes + parameter_bytes
                        or step_bytes <= 0):
                    raise X86Error('native STEP instance directory is invalid')
                parameters = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                step = instantiate_step_template(
                    templates[rank - 1], parameters)
                if step in identities:
                    raise X86Error('native STEP instance rank is not minimal')
                identities.add(step)
                steps.append(step)
                expected_offset += length
            if expected_offset != template_bytes + parameter_bytes:
                raise X86Error('native STEP parameter extent is invalid')

            guards = []
            expected_offset = template_bytes + parameter_bytes
            for index in range(guard_count):
                offset, length = NATIVE_STEP_EXTENT.unpack_from(
                    payload, guard_base + index * NATIVE_STEP_EXTENT.size)
                if (offset != expected_offset or length <= 0
                        or offset + length > execution_bytes):
                    raise X86Error('native code proof directory is invalid')
                guards.append(bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length]))
                expected_offset += length
            if expected_offset != execution_bytes:
                raise X86Error('native code proof extent is invalid')

            prior_rip = -1
            prior_guard = None
            for index in range(block_count):
                start = descriptor_offset + index * NATIVE_DESCRIPTOR_HEADER.size
                fields = NATIVE_DESCRIPTOR_HEADER.unpack_from(payload, start)
                rip = int(fields[3]) & MASK64
                rank = int(fields[10])
                guard_rank = int(fields[11])
                guard = (b'' if not guard_rank else
                         guards[guard_rank - 1]
                         if guard_rank <= len(guards) else None)
                if (rip < prior_rip or fields[0] != NATIVE_DESCRIPTOR_MAGIC
                        or fields[1] != 3
                        or fields[2] != NATIVE_DESCRIPTOR_HEADER.size
                        or fields[3] != rip or guard is None
                        or rank <= 0 or rank > len(steps)
                        or fields[5] != len(steps[rank - 1])
                        or (rip == prior_rip and guard <= prior_guard)):
                    raise X86Error(
                        'native x86 descriptor %d at %#x is invalid: %r'
                        % (index, rip, fields))
                record = NATIVE_BLOCK_HEADER.pack(
                    NATIVE_BLOCK_MAGIC, 2 if guard else 1,
                    NATIVE_BLOCK_HEADER.size,
                    *fields[3:10]) + guard + steps[rank - 1]
                try:
                    validate_native_x86_record(record, rip)
                except (StatePageError, ValueError):
                    if scrub_invalid:
                        continue
                    raise X86Error('native x86 block record is invalid')
                records.append((rip, record))
                prior_rip = rip
                prior_guard = guard
        else:
            legacy_blocks = header.get('blocks')
            legacy_steps = header.get('steps')
            legacy_directory = isinstance(legacy_blocks, list) \
                and isinstance(legacy_steps, list)
            hashed_directory = (not legacy_directory
                                and header.get('step_identity', {}).get(
                                    'algorithm') == 'sha256')
            block_count = (len(legacy_blocks) if legacy_directory
                           else int(header['block_count']))
            step_count = (len(legacy_steps) if legacy_directory
                          else int(header['step_count']))
            guard_count = (0 if legacy_directory or hashed_directory
                           else int(header.get('guard_count', 0)))
            step_execution_bytes = int(header.get(
                'step_execution_bytes', header['execution_bytes']))
            regions = header['regions']
            if int(regions['page_bytes']) != NATIVE_REGION_BYTES:
                raise X86Error('native x86 region geometry is invalid')
            memory_offset, memory_extent = map(int, regions['memory'])
            descriptor_offset, descriptor_bytes = map(
                int, regions['descriptors'])
            execution_offset, execution_bytes = map(
                int, regions['execution'])
            if (memory_extent != memory_bytes
                    or descriptor_bytes != int(header['descriptor_bytes'])
                    or execution_bytes != int(header['execution_bytes'])
                    or memory_offset % NATIVE_REGION_BYTES
                    or descriptor_offset % NATIVE_REGION_BYTES
                    or execution_offset % NATIVE_REGION_BYTES
                    or not (header_end <= memory_offset
                            <= memory_offset + memory_bytes
                            <= descriptor_offset
                            <= descriptor_offset + descriptor_bytes
                            <= execution_offset
                            <= execution_offset + execution_bytes
                            == len(payload))
                    or min(block_count, step_count, guard_count,
                           step_execution_bytes) < 0
                    or step_execution_bytes > execution_bytes
                    or descriptor_bytes != (
                        block_count * NATIVE_DESCRIPTOR_HEADER.size
                        + (0 if legacy_directory else
                           step_count * (NATIVE_STEP_HASH_EXTENT.size
                                         if hashed_directory else
                                         NATIVE_STEP_EXTENT.size)
                           + guard_count * NATIVE_STEP_EXTENT.size))):
                raise X86Error('native x86 machine extents are invalid')
            steps = []
            identities = set()
            expected_offset = 0
            for index in range(step_count):
                if legacy_directory:
                    identity, offset, length = legacy_steps[index]
                    identity = str(identity)
                    offset, length = int(offset), int(length)
                else:
                    step_base = (descriptor_offset + block_count
                                 * NATIVE_DESCRIPTOR_HEADER.size)
                    if hashed_directory:
                        raw_identity, offset, length = \
                            NATIVE_STEP_HASH_EXTENT.unpack_from(
                                payload, step_base
                                + index * NATIVE_STEP_HASH_EXTENT.size)
                        identity = raw_identity.hex()
                    else:
                        offset, length = NATIVE_STEP_EXTENT.unpack_from(
                            payload, step_base
                            + index * NATIVE_STEP_EXTENT.size)
                        identity = None
                if ((identity is not None and identity in identities)
                        or offset != expected_offset or length < 0
                        or offset + length > step_execution_bytes):
                    raise X86Error('native STEP directory is invalid')
                step = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                if identity is not None \
                        and hashlib.sha256(step).hexdigest() != identity:
                    raise X86Error('native STEP identity is invalid')
                if step in identities:
                    raise X86Error('native STEP rank is not minimal')
                steps.append(step)
                identities.add(step if identity is None else identity)
                expected_offset += length
            if expected_offset != step_execution_bytes:
                raise X86Error('native STEP extent is invalid')
            guards = []
            guard_base = (descriptor_offset
                          + block_count * NATIVE_DESCRIPTOR_HEADER.size
                          + step_count * (NATIVE_STEP_HASH_EXTENT.size
                                          if hashed_directory else
                                          NATIVE_STEP_EXTENT.size))
            expected_offset = step_execution_bytes
            for index in range(guard_count):
                offset, length = NATIVE_STEP_EXTENT.unpack_from(
                    payload, guard_base + index * NATIVE_STEP_EXTENT.size)
                if (offset != expected_offset or length <= 0
                        or offset + length > execution_bytes):
                    raise X86Error('native code proof directory is invalid')
                guard = bytes(payload[
                    execution_offset + offset:
                    execution_offset + offset + length])
                guards.append(guard)
                expected_offset += length
            if expected_offset != execution_bytes:
                raise X86Error('native code proof extent is invalid')
            prior_rip = -1
            prior_guard = None
            for index in range(block_count):
                start = descriptor_offset + index * NATIVE_DESCRIPTOR_HEADER.size
                fields = NATIVE_DESCRIPTOR_HEADER.unpack_from(payload, start)
                rip = int(fields[3]) & MASK64
                if legacy_directory:
                    named = int(str(legacy_blocks[index]), 16) & MASK64
                    if named != rip:
                        raise X86Error('native x86 descriptor is invalid')
                version = int(fields[1])
                guard_rank = int(fields[11])
                guard = (b'' if not guard_rank else
                         guards[guard_rank - 1]
                         if guard_rank <= len(guards) else None)
                if (rip < prior_rip or fields[0] != NATIVE_DESCRIPTOR_MAGIC
                        or version not in (1, 2)
                        or fields[2] != NATIVE_DESCRIPTOR_HEADER.size
                        or fields[3] != rip or guard is None
                        or (version == 1 and guard)
                        or (version == 2 and not guard)
                        or (rip == prior_rip and guard <= prior_guard)):
                    raise X86Error('native x86 descriptor is invalid')
                rank = int(fields[10])
                if rank <= 0 or rank > len(steps) \
                        or fields[5] != len(steps[rank - 1]):
                    raise X86Error('native x86 descriptor rank is invalid')
                record = NATIVE_BLOCK_HEADER.pack(
                    NATIVE_BLOCK_MAGIC, version, NATIVE_BLOCK_HEADER.size,
                    *fields[3:10]) + guard + steps[rank - 1]
                try:
                    validate_native_x86_record(record, rip)
                except (StatePageError, ValueError):
                    if scrub_invalid:
                        continue
                    raise X86Error('native x86 block record is invalid')
                records.append((rip, record))
                prior_rip = rip
                prior_guard = guard
    except (KeyError, TypeError, ValueError, struct.error) as error:
        if isinstance(error, X86Error):
            raise
        raise X86Error('native x86 machine metadata is invalid') from error
    memory = bytes(payload[memory_offset:memory_offset + memory_bytes])
    return header, memory, tuple(records)


def repack_native_x86_machine(payload):
    """Canonicalize any machine into the current block quotient schema."""
    view = payload if isinstance(payload, memoryview) else memoryview(payload)
    if bytes(view[:len(NATIVE_MACHINE_MAGIC)]) == NATIVE_MACHINE_MAGIC:
        # Schema 5 already stores shared templates, parameter rows, guards,
        # and continuations as ranked physical directories.  Re-encoding those
        # directories is sufficient to canonicalize their order; expanding
        # every STEP into an executable record and projecting it again only
        # repeats validation and materializes the scalar representation.
        header, memory, variants = load_native_x86_physical_machine(view)
        return _encode_native_x86_physical(header, memory, variants)
    header, memory, records = load_native_x86_machine(
        view, scrub_invalid=True)
    base = {'state': header['state'], 'memory': header['memory']}
    return _encode_native_x86_machine(base, memory, records)


def rebase_native_x86_physical_machine(payload, boot_cache, state):
    """Retain proved physical blocks while replacing boot RAM and CPU state.

    The executable directory is already guarded by the exact source bytes it
    proves, so unchanged kernel blocks remain valid across an initramfs-only
    rebuild.  Blocks whose bytes moved or changed fail that guard and are
    admitted again by the ordinary runtime closure path.  Keeping the rank
    directory physical avoids expanding shared STEP templates into scalar
    records merely to attach a new boot image.
    """
    _old_header, _old_memory, variants = \
        load_native_x86_physical_machine(payload)
    empty = dump_native_x86_machine(boot_cache, state, ())
    header, memory, _empty_variants = \
        load_native_x86_physical_machine(empty)
    return _encode_native_x86_physical(header, memory, variants)


def merge_native_x86_physical_machines(base_payload, *overlay_payloads,
                                       replace_conflicts=True):
    """Union proved physical block quotients without expanding STEP rows.

    The base owns the cold-boot CPU state and RAM image.  Every overlay must
    come from that exact boot object; only its guarded block directory is
    admitted.  Later overlays replace an older lowering for the same
    ``(rip, code-proof)`` coordinate, which lets a stronger QM result win
    without creating a second execution path.
    """
    header, memory, merged = load_native_x86_physical_machine(base_payload)
    merged = dict(merged)
    added = 0
    replaced = 0
    retained = 0
    overlay_blocks = 0
    for payload in overlay_payloads:
        overlay_header, overlay_memory, overlay = \
            load_native_x86_physical_machine(payload)
        overlay_blocks += int(overlay_header['block_count'])
        if overlay_memory != memory:
            raise X86Error('native x86 machine overlays name different RAM')
        if overlay_header.get('state') != header.get('state'):
            raise X86Error('native x86 machine overlays name different CPU state')
        for coordinate, physical in overlay.items():
            prior = merged.get(coordinate)
            if prior is None:
                added += 1
            elif prior != physical:
                if not replace_conflicts:
                    retained += 1
                    continue
                replaced += 1
            merged[coordinate] = physical
    return _encode_native_x86_physical(header, memory, merged), {
        'base_blocks': int(header['block_count']),
        'overlay_blocks': overlay_blocks,
        'added_blocks': added,
        'replaced_blocks': replaced,
        'retained_conflicts': retained,
        'blocks': len(merged),
    }


def load_native_x86_physical_machine(payload):
    """Load schema 5 rank identities without materializing scalar STEP rows."""
    payload = payload if isinstance(payload, memoryview) else memoryview(payload)
    if bytes(payload[:len(NATIVE_MACHINE_MAGIC)]) != NATIVE_MACHINE_MAGIC:
        header, memory, records = load_native_x86_machine(
            payload, scrub_invalid=True)
        variants = {}
        for rip, record in records:
            _fields, guard, physical = physical_native_x86_record(record, rip)
            variants[int(rip) & MASK64, guard] = physical
        return header, memory, variants
    prefix = len(NATIVE_MACHINE_MAGIC)
    if len(payload) < prefix + 4:
        raise X86Error('native x86 machine header is invalid')
    header_bytes = struct.unpack_from('<I', payload, prefix)[0]
    header_start = prefix + 4
    header_end = header_start + header_bytes
    if header_end > len(payload):
        raise X86Error('native x86 machine metadata is truncated')
    try:
        header = json.loads(bytes(payload[header_start:header_end]))
        if int(header.get('schema', -1)) != 5:
            raise X86Error('native x86 machine schema is invalid')
        memory_bytes = int(header['memory']['bytes'])
        block_count = int(header['block_count'])
        step_count = int(header['step_count'])
        template_count = int(header['template_count'])
        guard_count = int(header['guard_count'])
        continuation_count = int(header['continuation_count'])
        continuation_bytes = int(header['continuation_bytes'])
        template_bytes = int(header['template_execution_bytes'])
        parameter_bytes = int(header['parameter_execution_bytes'])
        regions = header['regions']
        if int(regions['page_bytes']) != NATIVE_REGION_BYTES:
            raise X86Error('native x86 region geometry is invalid')
        memory_offset, memory_extent = map(int, regions['memory'])
        descriptor_offset, descriptor_bytes = map(
            int, regions['descriptors'])
        execution_offset, execution_bytes = map(int, regions['execution'])
        expected_descriptors = (
            block_count * NATIVE_BLOCK_INSTANCE.size
            + step_count * NATIVE_STEP_INSTANCE.size
            + (template_count + guard_count) * NATIVE_STEP_EXTENT.size
            + (continuation_count + 1) * NATIVE_CONTINUATION_OFFSET.size
            + continuation_bytes)
        if (memory_extent != memory_bytes
                or descriptor_bytes != int(header['descriptor_bytes'])
                or descriptor_bytes != expected_descriptors
                or execution_bytes != int(header['execution_bytes'])
                or min(memory_bytes, block_count, step_count, template_count,
                       guard_count, continuation_count, continuation_bytes,
                       template_bytes, parameter_bytes) < 0
                or (block_count and not continuation_count)
                or template_bytes + parameter_bytes > execution_bytes
                or memory_offset % NATIVE_REGION_BYTES
                or descriptor_offset % NATIVE_REGION_BYTES
                or execution_offset % NATIVE_REGION_BYTES
                or not (header_end <= memory_offset
                        <= memory_offset + memory_bytes
                        <= descriptor_offset
                        <= descriptor_offset + descriptor_bytes
                        <= execution_offset
                        <= execution_offset + execution_bytes == len(payload))):
            raise X86Error('native x86 machine extents are invalid')

        step_base = (descriptor_offset
                     + block_count * NATIVE_BLOCK_INSTANCE.size)
        template_base = step_base + step_count * NATIVE_STEP_INSTANCE.size
        guard_base = template_base + template_count * NATIVE_STEP_EXTENT.size
        continuation_base = guard_base + guard_count * NATIVE_STEP_EXTENT.size

        templates = []
        identities = set()
        expected_offset = 0
        for index in range(template_count):
            offset, length = NATIVE_STEP_EXTENT.unpack_from(
                payload, template_base + index * NATIVE_STEP_EXTENT.size)
            if (offset != expected_offset or length <= 0
                    or offset + length > template_bytes):
                raise X86Error('native STEP template directory is invalid')
            template = bytes(payload[
                execution_offset + offset:execution_offset + offset + length])
            if template in identities:
                raise X86Error('native STEP template rank is not minimal')
            identities.add(template)
            templates.append(template)
            expected_offset += length
        if expected_offset != template_bytes:
            raise X86Error('native STEP template extent is invalid')

        steps = []
        identities = set()
        expected_offset = template_bytes
        for index in range(step_count):
            rank, offset, length, step_bytes = NATIVE_STEP_INSTANCE.unpack_from(
                payload, step_base + index * NATIVE_STEP_INSTANCE.size)
            if (rank <= 0 or rank > len(templates)
                    or offset != expected_offset or length < 0
                    or offset + length > template_bytes + parameter_bytes
                    or step_bytes <= 0):
                raise X86Error('native STEP instance directory is invalid')
            identity = (
                templates[rank - 1],
                bytes(payload[execution_offset + offset:
                              execution_offset + offset + length]),
                int(step_bytes))
            if identity in identities:
                raise X86Error('native STEP instance rank is not minimal')
            identities.add(identity)
            steps.append(identity)
            expected_offset += length
        if expected_offset != template_bytes + parameter_bytes:
            raise X86Error('native STEP parameter extent is invalid')

        guards = []
        identities = set()
        expected_offset = template_bytes + parameter_bytes
        for index in range(guard_count):
            offset, length = NATIVE_STEP_EXTENT.unpack_from(
                payload, guard_base + index * NATIVE_STEP_EXTENT.size)
            if (offset != expected_offset or length <= 0
                    or offset + length > execution_bytes):
                raise X86Error('native code proof directory is invalid')
            guard = bytes(payload[
                execution_offset + offset:execution_offset + offset + length])
            if guard in identities:
                raise X86Error('native code proof rank is not minimal')
            identities.add(guard)
            guards.append(guard)
            expected_offset += length
        if expected_offset != execution_bytes:
            raise X86Error('native code proof extent is invalid')

        offset_count = continuation_count + 1
        payload_base = (continuation_base
                        + offset_count * NATIVE_CONTINUATION_OFFSET.size)
        offsets = [NATIVE_CONTINUATION_OFFSET.unpack_from(
            payload, continuation_base
            + index * NATIVE_CONTINUATION_OFFSET.size)[0]
                   for index in range(offset_count)]
        if (not offsets or offsets[0] or offsets[-1] != continuation_bytes
                or any(first >= second
                       for first, second in zip(offsets, offsets[1:]))):
            raise X86Error('native x86 continuation directory is invalid')
        continuations = []
        identities = set()
        for start, end in zip(offsets, offsets[1:]):
            continuation = _decode_native_x86_continuation(
                payload[payload_base + start:payload_base + end])
            if continuation in identities:
                raise X86Error('native x86 continuation rank is not minimal')
            identities.add(continuation)
            continuations.append(continuation)

        candidate_order = header.get(
            'candidate_order', 'guard-lexicographic')
        if candidate_order not in (
                'guard-lexicographic', 'proved-bytes-descending',
                'closed-recurrence-first'):
            raise X86Error('native x86 candidate order is invalid')
        variants = {}
        prior_candidate = None
        for index in range(block_count):
            rip, step_rank, continuation_rank, guard_rank = map(
                int, NATIVE_BLOCK_INSTANCE.unpack_from(
                    payload, descriptor_offset
                    + index * NATIVE_BLOCK_INSTANCE.size))
            guard = (b'' if not guard_rank else
                     guards[guard_rank - 1]
                     if guard_rank <= len(guards) else None)
            continuation = (
                continuations[continuation_rank - 1]
                if 0 < continuation_rank <= len(continuations) else None)
            candidate = (_native_variant_order(
                (rip, guard), continuation=continuation,
                order=candidate_order)
                if guard is not None else None)
            if (guard is None or continuation is None
                    or not 0 < step_rank <= len(steps)
                    or (prior_candidate is not None
                        and candidate <= prior_candidate)):
                raise X86Error(
                    'native x86 block instance %d at %#x is invalid'
                    % (index, rip))
            variants[rip, guard] = (guard, steps[step_rank - 1], continuation)
            prior_candidate = candidate
    except (KeyError, TypeError, ValueError, struct.error) as error:
        if isinstance(error, X86Error):
            raise
        raise X86Error('native x86 machine metadata is invalid') from error
    memory = bytes(payload[memory_offset:memory_offset + memory_bytes])
    return header, memory, variants


def _extend_native_x86_physical(payload, records, reject_conflicts,
                                replace_proved):
    header, memory, variants = load_native_x86_physical_machine(payload)
    return extend_loaded_native_x86_physical_machine(
        header, memory, variants, records, reject_conflicts, replace_proved)


def extend_loaded_native_x86_physical_machine(
        header, memory, variants, records, reject_conflicts=True,
        replace_proved=False):
    """Merge records into a loaded physical rank directory."""
    incoming = []
    dynamic_entries = {}
    for raw_rip, raw_record in records:
        rip = int(raw_rip) & MASK64
        fields, guard, physical = physical_native_x86_record(raw_record, rip)
        incoming.append((rip, guard, physical))
        extents = _native_code_guard_extents(guard)
        if int(fields[6]) == 3 and len(extents) == 1 \
                and int(extents[0][0]) == rip:
            dynamic_entries.setdefault(rip, []).append((extents[0], guard))

    guard_extents = {}
    retained = {}
    for (rip, guard), physical in variants.items():
        extents = guard_extents.get(guard)
        if extents is None:
            extents = guard_extents[guard] = _native_code_guard_extents(guard)
        if extents and any(
                extents[0] == entry and guard != general_guard
                for entry, general_guard in dynamic_entries.get(rip, ())):
            continue
        retained[rip, guard] = physical
    variants = retained
    sorted_prefix = len(variants)
    reordered_existing = False
    for rip, guard, physical in incoming:
        key = rip, guard
        prior = variants.get(key)
        if prior is not None and prior != physical:
            if reject_conflicts:
                raise ValueError(
                    'native x86 extension changes proved coordinate %#x'
                    % rip)
            if not replace_proved:
                continue
            reordered_existing = True
        variants[key] = physical
    return _encode_native_x86_physical(
        header, memory, variants,
        sorted_prefix=0 if reordered_existing else sorted_prefix)


def extend_native_x86_machine(payload, records, reject_conflicts=True,
                              replace_proved=False):
    """Add proved X86B records without rewriting physical RAM.

    ``replace_proved`` is the optimizer-closure mode: an incoming record with
    the exact same executable guard replaces the resident lowering.  This is
    how a newly discovered stronger block quotient supersedes a scalar record
    without creating a second coordinate or weakening its code proof.
    """
    records = tuple(records)
    return _extend_native_x86_physical(
        payload, records, reject_conflicts, replace_proved)


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


def _pack_native_code_guard(block):
    extents = tuple((int(address) & MASK64, bytes(payload))
                    for address, payload in _block_code_extents(block)
                    if payload)
    if not extents or len(extents) > 0xffff:
        raise ValueError('native x86 block needs finite executable proof')
    output = bytearray(struct.pack('<H', len(extents)))
    prior_end = None
    for address, payload in extents:
        if len(payload) > 0xffff:
            raise ValueError('native x86 executable proof extent is too large')
        if prior_end is not None and address < prior_end:
            raise ValueError('native x86 executable proof extents overlap')
        output.extend(NATIVE_CODE_GUARD_EXTENT.pack(address, len(payload)))
        output.extend(payload)
        prior_end = address + len(payload)
    return bytes(output)


def split_native_x86_record(record):
    """Return ``(header fields, code guard, STEP)`` for one portable record."""
    record = bytes(record)
    if len(record) < NATIVE_BLOCK_HEADER.size:
        raise ValueError('native x86 record is truncated')
    fields = NATIVE_BLOCK_HEADER.unpack_from(record)
    version = int(fields[1])
    step_bytes = int(fields[5])
    if fields[2] != NATIVE_BLOCK_HEADER.size or step_bytes <= 0:
        raise ValueError('native x86 record extent is invalid')
    guard_bytes = len(record) - NATIVE_BLOCK_HEADER.size - step_bytes
    if guard_bytes < 0 or (version == 1 and guard_bytes):
        raise ValueError('native x86 record extent is invalid')
    if version not in (1, 2):
        raise ValueError('native x86 record version is unsupported')
    guard = record[NATIVE_BLOCK_HEADER.size:
                   NATIVE_BLOCK_HEADER.size + guard_bytes]
    if version == 2:
        if len(guard) < 2:
            raise ValueError('native x86 executable proof is truncated')
        count = struct.unpack_from('<H', guard)[0]
        cursor = 2
        prior_end = None
        for _unused in range(count):
            if cursor + NATIVE_CODE_GUARD_EXTENT.size > len(guard):
                raise ValueError('native x86 executable proof is truncated')
            address, length = NATIVE_CODE_GUARD_EXTENT.unpack_from(
                guard, cursor)
            cursor += NATIVE_CODE_GUARD_EXTENT.size
            if (not length or cursor + length > len(guard)
                    or (prior_end is not None and address < prior_end)):
                raise ValueError('native x86 executable proof is invalid')
            cursor += length
            prior_end = address + length
        if not count or cursor != len(guard):
            raise ValueError('native x86 executable proof is invalid')
    step = record[len(record) - step_bytes:]
    return fields, guard, step


def _native_code_guard_extents(guard):
    """Decode an already-validated executable proof into exact extents."""
    guard = bytes(guard)
    if len(guard) < 2:
        return ()
    count = struct.unpack_from('<H', guard)[0]
    cursor = 2
    extents = []
    for _unused in range(count):
        if cursor + NATIVE_CODE_GUARD_EXTENT.size > len(guard):
            return ()
        address, length = NATIVE_CODE_GUARD_EXTENT.unpack_from(guard, cursor)
        cursor += NATIVE_CODE_GUARD_EXTENT.size
        end = cursor + length
        if not length or end > len(guard):
            return ()
        extents.append((address, guard[cursor:end]))
        cursor = end
    return tuple(extents) if cursor == len(guard) else ()


def _native_variant_order(key, physical=None, continuation=None,
                          order='closed-recurrence-first'):
    """Return the canonical first-match order for one block candidate.

    An ordinary composed cut can still carry an entry residual learned from a
    concrete state; exact code bytes alone do not prove that residual.  Only
    the recurrence control has an explicit closed-form entry contract in the
    shared VM grammar, so it may safely outrank scalar prefixes today.  Other
    controls retain lexical proof order until their residual cut is encoded.
    """
    rip, guard = key
    if order == 'guard-lexicographic':
        return int(rip) & MASK64, bytes(guard)
    extents = _native_code_guard_extents(guard)
    if order == 'proved-bytes-descending':
        return (int(rip) & MASK64,
                -sum(len(payload) for _address, payload in extents),
                -len(extents), bytes(guard))
    if order != 'closed-recurrence-first':
        raise ValueError('native x86 candidate order is invalid')
    if continuation is None and physical is not None:
        continuation = physical[2]
    control = None if continuation is None else int(continuation[0])
    recurrence = control == 24
    return (int(rip) & MASK64,
            0 if recurrence else 1,
            -sum(len(payload) for _address, payload in extents)
            if recurrence else 0,
            -len(extents) if recurrence else 0,
            bytes(guard))


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
    if operation in ('save_fpu', 'restore_fpu'):
        first_local = len(plan.locals)
        lowered = X86DBT._fpu_state_plan(block.boundary, first_local)
        if lowered is None:
            raise ValueError('native x86 FPU state is not normalized')
        fpu_plan, following, first_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals) + tuple(
                Operand('local', first_local + lane)
                for lane in range(32)))
        plan = compose_plans(plan, fpu_plan)
        operation = ('native_fpu_save' if operation == 'save_fpu'
                     else 'native_fpu_restore')
        detail = following, first_local
    elif operation == 'fpu_init':
        operation = 'branch'
    elif operation == 'memory_fence':
        # The record boundary already prevents composition across the fence.
        # Its architectural transition is therefore exactly the ordinary
        # next-instruction continuation.
        operation = 'branch'
    elif operation == 'simd_store':
        low_local = len(plan.locals)
        lowered = X86DBT._simd_store_plan(
            block.boundary, low_local, low_local + 1)
        if lowered is None:
            raise ValueError('native x86 SIMD store is not normalized')
        simd_plan, following, vector, low_local, high_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', low_local), Operand('local', high_local)))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_store'
        detail = following, vector, low_local, high_local
    elif operation == 'simd_load':
        low_local = len(plan.locals)
        lowered = X86DBT._simd_load_plan(
            block.boundary, low_local, low_local + 1)
        if lowered is None:
            raise ValueError('native x86 SIMD load is not normalized')
        simd_plan, following, vector, low_local, high_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', low_local), Operand('local', high_local)))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_load'
        detail = following, vector, low_local, high_local
    elif (operation == 'simd_move_to'
          and isinstance(detail[2], MemoryOperand)):
        value_local = len(plan.locals)
        lowered = X86DBT._simd_load_low_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD low load is not normalized')
        simd_plan, following, vector, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_move_to'
        detail = following, vector, value_local
    elif operation == 'simd_load_lane':
        value_local = len(plan.locals)
        lowered = X86DBT._simd_load_lane_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD lane load is not normalized')
        simd_plan, following, vector, lane, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_load_lane'
        detail = following, vector, lane, value_local
    elif operation == 'simd_load32':
        value_local = len(plan.locals)
        lowered = X86DBT._simd_load32_plan(block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD dword load is not normalized')
        simd_plan, following, vector, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_load32'
        detail = following, vector, value_local
    elif operation == 'simd_store32':
        value_local = len(plan.locals)
        lowered = X86DBT._simd_store32_plan(block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD dword store is not normalized')
        simd_plan, following, vector, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_store32'
        detail = following, vector, value_local
    elif (operation == 'simd_compare_scalar'
          and isinstance(detail[2], MemoryOperand)):
        value_local = len(plan.locals)
        lowered = X86DBT._simd_compare_plan(block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD compare is not normalized')
        simd_plan, following, vector, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_compare_scalar'
        detail = following, vector, value_local
    elif (operation == 'simd_convert_integer'
          and isinstance(detail[2], MemoryOperand)):
        value_local = len(plan.locals)
        lowered = X86DBT._simd_convert_integer_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD conversion is not normalized')
        (simd_plan, following, vector,
         value_local, bits) = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_convert_integer'
        detail = following, vector, value_local, bits
    elif (operation == 'simd_scalar_binary'
          and isinstance(detail[3], MemoryOperand)):
        value_local = len(plan.locals)
        lowered = X86DBT._simd_scalar_binary_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD scalar ALU is not normalized')
        (simd_plan, following, scalar_operation,
         vector, value_local) = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_scalar_binary'
        detail = following, scalar_operation, vector, value_local
    elif (operation == 'simd_convert_truncate'
          and isinstance(detail[2], MemoryOperand)):
        value_local = len(plan.locals)
        lowered = X86DBT._simd_convert_truncate_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError(
                'native x86 SIMD truncate conversion is not normalized')
        (simd_plan, following, register,
         value_local, bits) = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_convert_truncate'
        detail = following, register, value_local, bits
    elif operation in ('simd_packed_equal', 'simd_unpack_dwords'):
        low_local = len(plan.locals)
        lowered = X86DBT._simd_packed_equal_plan(
            block.boundary, low_local, low_local + 1)
        if lowered is None:
            raise ValueError('native x86 packed compare is not normalized')
        (simd_plan, following, vector,
         low_local, high_local) = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', low_local), Operand('local', high_local)))
        plan = compose_plans(plan, simd_plan)
        packed_operation = 11 if operation == 'simd_packed_equal' else 12
        operation = 'native_simd_register'
        detail = following, packed_operation, vector, low_local, 1 << 8
    elif operation == 'simd_shuffle_dwords':
        following, vector, operand, immediate = detail
        low_local = len(plan.locals)
        lowered = X86DBT._simd_load_plan(
            X86Boundary('simd_load', (following, vector, operand)),
            low_local, low_local + 1)
        if lowered is None:
            raise ValueError('native x86 packed shuffle is not normalized')
        simd_plan, following, vector, low_local, high_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', low_local), Operand('local', high_local)))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_register'
        detail = (following, 13, vector, low_local,
                  int(immediate) | (1 << 8))
    elif operation == 'simd_store_lane':
        value_local = len(plan.locals)
        lowered = X86DBT._simd_store_low_plan(
            block.boundary, value_local)
        if lowered is None:
            raise ValueError('native x86 SIMD qword store is not normalized')
        simd_plan, following, vector, value_local = lowered
        plan = replace(
            plan, locals=tuple(plan.locals)
            + (Operand('local', value_local),))
        plan = compose_plans(plan, simd_plan)
        operation = 'native_simd_store_lane'
        detail = following, vector, value_local
    if not operation.startswith('native_'):
        segment_local = len(plan.locals)
        segment_lowered = X86DBT._segment_memory_plan(
            block.boundary, segment_local)
        if segment_lowered is not None:
            (segment_plan, following, segment,
             segment_local) = segment_lowered
            plan = replace(
                plan, locals=tuple(plan.locals)
                + (Operand('local', segment_local),))
            plan = compose_plans(plan, segment_plan)
            operation = 'native_segment_memory'
            detail = following, segment, segment_local
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
                    limit_local = len(plan.locals)
                    lowered = X86DBT._store_descriptor_plan(
                        block.boundary, limit_local, limit_local + 1)
                    if lowered is not None:
                        (descriptor_plan, following, name,
                         limit_local, base_local) = lowered
                        plan = replace(
                            plan, locals=tuple(plan.locals)
                            + (Operand('local', limit_local),
                               Operand('local', base_local)))
                        plan = compose_plans(plan, descriptor_plan)
                        operation = 'native_store_descriptor'
                        detail = (following, name,
                                  limit_local, base_local)
                    else:
                        lowered = X86DBT._load_system_segment_plan(
                            block.boundary)
                        if lowered is not None:
                            (segment_plan, following, name,
                             value_local) = lowered
                            plan = compose_plans(plan, segment_plan)
                            operation = 'native_load_system_segment'
                            detail = following, name, value_local
                    lowered = None if lowered is not None else \
                        X86DBT._indirect_control_plan(block.boundary)
                    if lowered is not None:
                        plan = compose_plans(plan, lowered)
                        operation = 'dynamic_branch'
                        detail = None
                    else:
                        lowered = X86DBT._divide_plan(block.boundary)
                        if lowered is not None:
                                divide_plan, following, instruction = lowered
                                plan = compose_plans(plan, divide_plan)
                                operation = 'native_divide'
                                detail = following, instruction
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
        following, instruction = detail
        arguments = [int(following) & MASK64, 17,
                     int(instruction) & MASK64]
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
    elif operation == 'debug_register':
        following, opcode, debug, register = detail
        if (opcode not in (0x21, 0x23)
                or not 0 <= int(debug) < 8
                or not 0 <= int(register) < 16):
            raise ValueError('native x86 debug-register shape is invalid')
        control = 21
        arguments = [int(following) & MASK64,
                     int(opcode) | (int(debug) << 8)
                     | (int(register) << 16), 0]
    elif operation == 'exception':
        following, vector, error_code = detail
        if (not 0 <= int(vector) <= 0xff
                or (error_code is not None
                    and not 0 <= int(error_code) <= 0xffffffff)):
            raise ValueError('native x86 exception shape is invalid')
        control = 22
        arguments = [int(following) & MASK64, int(vector),
                     MASK64 if error_code is None else int(error_code)]
    elif operation == 'unary':
        following, group, operand, bits, instruction = detail
        if (group not in (6, 7) or int(bits) != 64
                or not isinstance(operand, int)
                or not 0 <= operand < 16):
            raise ValueError('native x86 wide-divide shape is invalid')
        control = 23
        arguments = [int(following) & MASK64,
                     int(instruction) & MASK64,
                     int(operand) | (int(group == 7) << 8)]
    elif operation == 'native_recurrence':
        following, counter_local, source_instructions, counter_bits = detail
        if (not 17 <= int(counter_local) < 256
                or int(source_instructions) <= 0
                or int(source_instructions) > MASK64
                or int(counter_bits) not in (32, 64)):
            raise ValueError('native x86 recurrence shape is invalid')
        control = 24
        arguments = [int(following) & MASK64,
                     int(counter_local) | (int(counter_bits) << 8),
                     int(source_instructions)]
    elif operation == 'random':
        following, register, bits, source = detail
        if (not isinstance(register, int)
                or not 0 <= register < 16
                or int(bits) not in (32, 64)
                or int(source) not in (0, 1)):
            raise ValueError('native x86 entropy shape is invalid')
        control = 25
        arguments = [int(following) & MASK64,
                     int(register) | (int(bits) << 8)
                     | (int(source) << 16), 0]
    elif operation == 'native_store_descriptor':
        following, name, limit_local, base_local = detail
        if (name not in ('gdtr', 'idtr')
                or not 17 <= int(limit_local) < 256
                or int(base_local) != int(limit_local) + 1
                or int(base_local) >= 256):
            raise ValueError('native x86 descriptor-store shape is invalid')
        control = 26
        arguments = [int(following) & MASK64, int(name == 'idtr'),
                     int(limit_local) | (int(base_local) << 8)]
    elif operation in ('load_system_segment',
                       'native_load_system_segment'):
        following, name, source = detail
        memory = operation == 'native_load_system_segment'
        if (name not in ('ldtr', 'tr')
                or not isinstance(source, int)
                or not 0 <= source < 256
                or (memory and source < 17)
                or (not memory and source >= 16)):
            raise ValueError('native x86 system-segment shape is invalid')
        control = 27
        arguments = [int(following) & MASK64, int(name == 'tr'),
                     int(source) | (int(memory) << 8)]
    elif operation == 'swap_gs':
        control = 28
        arguments = [int(detail) & MASK64, 0, 0]
    elif operation == 'syscall':
        control = 29
        arguments = [int(detail) & MASK64, 0, 0]
    elif operation == 'sysret':
        control = 30
        arguments = [int(detail) & MASK64, 0, 0]
    elif operation in ('simd_move_to', 'native_simd_move_to'):
        following, vector, source = detail
        memory = operation == 'native_simd_move_to'
        if (not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= source < 256
                or (memory and source < 17)
                or (not memory and source >= 16)):
            raise ValueError('native x86 SIMD move shape is invalid')
        control = 31
        arguments = [int(following) & MASK64,
                     int(vector) | (int(source) << 8)
                     | (int(memory) << 16), 0]
    elif operation == 'simd_unpack_low':
        following, vector, source = detail
        if (not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= source < 16):
            raise ValueError('native x86 SIMD unpack shape is invalid')
        control = 32
        arguments = [int(following) & MASK64,
                     int(vector) | (int(source) << 8), 0]
    elif operation == 'native_simd_store':
        following, vector, low_local, high_local = detail
        if (not 0 <= int(vector) < 16
                or not 17 <= int(low_local) < 256
                or int(high_local) != int(low_local) + 1
                or int(high_local) >= 256):
            raise ValueError('native x86 SIMD store shape is invalid')
        control = 33
        arguments = [int(following) & MASK64, int(vector),
                     int(low_local) | (int(high_local) << 8)]
    elif operation == 'native_simd_store32':
        following, vector, value_local = detail
        if (not 0 <= int(vector) < 16
                or not 17 <= int(value_local) < 256):
            raise ValueError('native x86 SIMD dword store shape is invalid')
        control = 33
        arguments = [int(following) & MASK64, int(vector),
                     int(value_local) | (1 << 16)]
    elif operation == 'native_simd_store_lane':
        following, vector, value_local = detail
        if (not 0 <= int(vector) < 16
                or not 17 <= int(value_local) < 256):
            raise ValueError('native x86 SIMD qword store shape is invalid')
        control = 33
        arguments = [int(following) & MASK64, int(vector),
                     int(value_local) | (1 << 16)]
    elif operation == 'native_segment_memory':
        following, segment, segment_local = detail
        if (int(segment) not in (0, 1)
                or not 17 <= int(segment_local) < 256):
            raise ValueError('native x86 segment memory shape is invalid')
        control = 34
        arguments = [int(following) & MASK64,
                     int(segment), int(segment_local)]
    elif operation == 'simd_xor':
        following, vector, source = detail
        if (not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= source < 16):
            raise ValueError('native x86 SIMD xor shape is invalid')
        control = 35
        arguments = [int(following) & MASK64,
                     int(vector) | (int(source) << 8), 0]
    elif operation == 'native_simd_load':
        following, vector, low_local, high_local = detail
        if (not 0 <= int(vector) < 16
                or not 17 <= int(low_local) < 256
                or int(high_local) != int(low_local) + 1
                or int(high_local) >= 256):
            raise ValueError('native x86 SIMD load shape is invalid')
        control = 36
        arguments = [int(following) & MASK64, int(vector),
                     int(low_local) | (int(high_local) << 8)]
    elif operation == 'native_simd_load_lane':
        following, vector, lane, value_local = detail
        if (not 0 <= int(vector) < 16 or int(lane) not in (0, 1)
                or not 17 <= int(value_local) < 256):
            raise ValueError('native x86 SIMD lane load shape is invalid')
        control = 36
        arguments = [int(following) & MASK64,
                     int(vector) | (int(lane) << 8),
                     int(value_local) | (1 << 16)]
    elif operation == 'native_simd_load32':
        following, vector, value_local = detail
        if (not 0 <= int(vector) < 16
                or not 17 <= int(value_local) < 256):
            raise ValueError('native x86 SIMD dword load shape is invalid')
        control = 36
        arguments = [int(following) & MASK64, int(vector),
                     int(value_local) | (1 << 16) | (1 << 17)]
    elif operation in ('simd_register', 'native_simd_register'):
        following, opcode, target, source, immediate = detail
        memory = operation == 'native_simd_register'
        if (not 0 <= int(opcode) <= 13
                or not 0 <= int(target) < 16
                or not 0 <= int(source) < 256
                or (memory and (int(opcode) not in (11, 12, 13)
                                or int(source) < 17
                                or int(source) + 1 >= 256
                                or (int(opcode) in (11, 12)
                                    and int(immediate) != 1 << 8)
                                or (int(opcode) == 13
                                    and not 1 << 8 <= int(immediate) < 1 << 9)))
                or (not memory and int(source) >= 16)
                or (not memory and int(opcode) in (1, 5, 10, 13)
                    and not 0 <= int(immediate) < 256)
                or (not memory and int(opcode) in (11, 12)
                    and int(immediate) not in (0, 1 << 8))
                or (not memory and int(opcode)
                    not in (1, 5, 10, 11, 12, 13)
                    and int(immediate))):
            raise ValueError('native x86 SIMD register shape is invalid')
        control = 37
        arguments = [int(following) & MASK64,
                     int(opcode) | (int(target) << 8)
                     | (int(source) << 16), int(immediate)]
    elif operation in ('simd_compare_scalar',
                       'native_simd_compare_scalar'):
        following, vector, source = detail
        memory = operation == 'native_simd_compare_scalar'
        if (not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= int(source) < 256
                or (memory and int(source) < 17)
                or (not memory and int(source) >= 16)):
            raise ValueError('native x86 SIMD compare shape is invalid')
        control = 38
        arguments = [int(following) & MASK64,
                     int(vector) | (int(source) << 8)
                     | (int(memory) << 16), 0]
    elif operation in ('simd_convert_integer',
                       'native_simd_convert_integer'):
        following, vector, source, bits = detail
        memory = operation == 'native_simd_convert_integer'
        if (not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= int(source) < 256
                or int(bits) not in (32, 64)
                or (memory and int(source) < 17)
                or (not memory and int(source) >= 16)):
            raise ValueError('native x86 SIMD conversion shape is invalid')
        control = 39
        arguments = [int(following) & MASK64,
                     int(vector) | (int(source) << 8)
                     | (int(memory) << 16)
                     | (int(bits == 64) << 17), 0]
    elif operation in ('simd_convert_truncate',
                       'native_simd_convert_truncate'):
        following, register, source, bits = detail
        memory = operation == 'native_simd_convert_truncate'
        if (not 0 <= int(register) < 16
                or not isinstance(source, int)
                or not 0 <= int(source) < 256
                or int(bits) not in (32, 64)
                or (memory and int(source) < 17)
                or (not memory and int(source) >= 16)):
            raise ValueError(
                'native x86 SIMD truncate conversion shape is invalid')
        control = 39
        arguments = [int(following) & MASK64,
                     int(register) | (int(source) << 8)
                     | (int(memory) << 16)
                     | (int(bits == 64) << 17) | (1 << 18), 0]
    elif operation in ('simd_scalar_binary',
                       'native_simd_scalar_binary'):
        following, scalar_operation, vector, source = detail
        memory = operation == 'native_simd_scalar_binary'
        if (not 0 <= int(scalar_operation) <= 3
                or not 0 <= int(vector) < 16
                or not isinstance(source, int)
                or not 0 <= int(source) < 256
                or (memory and int(source) < 17)
                or (not memory and int(source) >= 16)):
            raise ValueError('native x86 SIMD scalar ALU shape is invalid')
        control = 40
        arguments = [int(following) & MASK64,
                     int(scalar_operation) | (int(vector) << 8)
                     | (int(source) << 16) | (int(memory) << 24), 0]
    elif operation in ('native_fpu_save', 'native_fpu_restore'):
        following, first_local = detail
        if (not 17 <= int(first_local) < 256
                or int(first_local) + 32 > 256):
            raise ValueError('native x86 FPU state shape is invalid')
        control = 41 if operation == 'native_fpu_save' else 42
        arguments = [int(following) & MASK64, int(first_local), 0]
    else:
        raise ValueError(
            'native x86 control is not normalized: %s %r'
            % (operation, detail))
    # The decoded prefix excludes a boundary-only instruction.  A raw cut
    # therefore retires that final instruction here; a predicate cut likewise
    # retains its Jcc after folding the flag producer.  Other composed cuts
    # already counted the lowered terminal instruction and expose only a
    # synthetic resident control.  This count drives both architectural
    # retirement and the deterministic timer cut in vm.wasm.
    retired = (0 if control == 24
               else _block_source_instructions(block))
    if control != 24 and retired <= 0:
        raise ValueError('native x86 block retires no source instruction')
    plan = replace(
        plan, function=0, start=0, end=retired, instructions=retired)
    page = bytes(pack_step(plan))
    guard = _pack_native_code_guard(block)
    # The resident VM is deliberately stricter than the Python executor.
    # Validate the physical columns at artifact construction time so no
    # malformed record can become a browser-only fallback or late trap.
    header = NATIVE_BLOCK_HEADER.pack(
        NATIVE_BLOCK_MAGIC, 2, NATIVE_BLOCK_HEADER.size,
        int(block.rip) & MASK64, int(block.boundary_rip) & MASK64,
        len(page), control, *arguments)
    record = header + guard + page
    validate_native_x86_record(record, block.rip)
    return record


def native_x86_static_successors(record):
    """Return every control successor named directly by one native record."""
    record = bytes(record)
    if len(record) < NATIVE_BLOCK_HEADER.size:
        raise ValueError('native x86 record is truncated')
    (magic, version, header_bytes, _rip, boundary_rip, page_bytes,
     control, first, second, _third) = NATIVE_BLOCK_HEADER.unpack_from(record)
    if (magic != NATIVE_BLOCK_MAGIC or version not in (1, 2)
            or header_bytes != NATIVE_BLOCK_HEADER.size
            or page_bytes <= 0 or page_bytes > len(record) - header_bytes
            or control > 42):
        raise ValueError('native x86 record header is invalid')
    if control == 2:
        return tuple(dict.fromkeys((first & MASK64, second & MASK64)))
    if control in (3, 4, 12, 14, 22, 29, 30):
        return ()
    if control in (0, 5):
        return (boundary_rip & MASK64,)
    return (first & MASK64,)


def validate_native_x86_record(record, coordinate=None):
    """Validate one complete X86B record exactly as the resident VM will."""
    record = bytes(record)
    fields, _guard, step = split_native_x86_record(record)
    (magic, version, header_bytes, rip, _boundary_rip, page_bytes,
     control, _first, _second, _third) = fields
    if (magic != NATIVE_BLOCK_MAGIC or version not in (1, 2)
            or header_bytes != NATIVE_BLOCK_HEADER.size
            or page_bytes != len(step)
            or control > 42
            or (coordinate is not None
                and rip != int(coordinate) & MASK64)):
        raise ValueError('native x86 record header is invalid')
    mapped = unpack_step(step)
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
        lowered = X86DBT._simd_store_plan(boundary, 17, 18)
        if lowered is None:
            lowered = X86DBT._simd_load_plan(boundary, 17, 18)
        if lowered is None:
            lowered = X86DBT._simd_load_low_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_load_lane_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_load32_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_store32_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_compare_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_convert_integer_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_scalar_binary_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_convert_truncate_plan(boundary, 17)
        if lowered is None:
            lowered = X86DBT._simd_packed_equal_plan(boundary, 17, 18)
        if lowered is None:
            lowered = X86DBT._simd_store_low_plan(boundary, 17)
        plan = None if lowered is None else lowered[0]
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
    source_instructions = _block_source_instructions(block)
    if source_instructions < 2:
        raise ValueError(
            'faultable terminal split has no retiring pure prefix')
    prefix = replace(
        block,
        boundary=X86Boundary(
            'native_internal_branch', int(block.boundary_rip) & MASK64),
        source_instructions=source_instructions - 1)
    terminal_coordinate = int(block.boundary_rip) & MASK64
    terminal_extent = next((
        (terminal_coordinate,
         payload[terminal_coordinate - address:])
        for address, payload in _block_code_extents(block)
        if address <= terminal_coordinate < address + len(payload)
    ), None)
    if terminal_extent is None:
        raise ValueError('faultable terminal has no executable proof')
    terminal = replace(
        block, rip=terminal_coordinate,
        source=b'', instructions=0,
        plan=_identity_register_plan(), scratch_count=0,
        flag_cut=None, control_block=None, cut_inputs=(), state_flags=False,
        virtual_memory=False, indirect_register=None, tail_return=None,
        inlined_call_target=None,
        code_extents=(terminal_extent,), source_instructions=1)
    return (
        (int(prefix.rip) & MASK64, pack_native_x86_block(prefix)),
        (int(terminal.rip) & MASK64, pack_native_x86_block(terminal)),
    )


def native_x86_cut_coordinates(dbt):
    """Return every decoded entry whose strongest physical cut is resident.

    A residual can execute directly from a predecessor's conditional control,
    so its own entry need not appear in the ordinary block execution profile.
    Likewise, threaded physical execution can compose several decoded basic
    blocks into one larger cut.  Which interior coordinate is exposed later
    depends on the resident artifact's grouping and page/barrier boundary, so
    publishing only sampled physical boundaries creates an avoidable N+1
    admission loop.  Every already-decoded basic block is part of the same
    proved control-flow closure and is cheap after STEP/template deduplication.
    """
    coordinates = set(int(rip) & MASK64 for rip in dbt.blocks)
    if dbt._physical_profile is not None:
        coordinates.update(int(rip) & MASK64
                           for rip in dbt._physical_profile)
    for _branch, entry in dbt._recurrence_cuts.values():
        if entry is not None:
            coordinates.add(int(entry[0].rip) & MASK64)
    for _branch, entry in dbt._scan_cuts.values():
        if entry is not None:
            coordinates.add(int(entry[0].rip) & MASK64)
    for _branch, _config, _proof, cut in dbt._prefix_cuts.values():
        coordinates.add(int(cut.rip) & MASK64)
    for cache in (dbt._find_cuts, dbt._copy_cuts,
                  dbt._wide_copy_cuts):
        for _branch, entry in cache.values():
            coordinates.add(int(entry[1].rip) & MASK64)
    return tuple(sorted(coordinates))


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
            (cut, counter, _iteration_bytes,
             source_instructions, counter_bits) = entry
            if cut.rip == rip:
                plan = replace(
                    cut.plan, start=0, end=0, instructions=0,
                    locals=tuple(cut.plan.locals)
                    + (Operand('local', int(counter)),))
                return replace(
                    cut, plan=plan,
                    boundary=X86Boundary('native_recurrence', (
                        int(cut.boundary.detail) & MASK64,
                        len(plan.locals) - 1,
                        int(source_instructions),
                        int(counter_bits))))
    for _branch, entry in dbt._scan_cuts.values():
        if entry is not None:
            cut, _counter, source_instructions, counter_bits = entry
            if cut.rip == rip:
                plan = replace(
                    cut.plan, start=0, end=0, instructions=0)
                return replace(
                    cut, plan=plan,
                    boundary=X86Boundary('native_recurrence', (
                        int(cut.boundary.detail) & MASK64,
                        len(plan.locals) - 1,
                        int(source_instructions),
                        int(counter_bits))))
    for _branch, entry in dbt._wide_copy_cuts.values():
        proof_blocks, cut, source_instructions, _chunk_bytes = entry
        if cut.rip == rip:
            plan = replace(
                cut.plan, start=0, end=0, instructions=0)
            return replace(
                cut, plan=plan,
                boundary=X86Boundary('native_recurrence', (
                    int(cut.boundary.detail) & MASK64,
                    len(plan.locals) - 1,
                    int(source_instructions), 64)))
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
            proof_config, proof, code_extents=((rip, source),))
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
        'xmm': list(state.xmm),
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
    xmm = tuple(int(value) & MASK64
                for value in header.get('xmm', (0,) * 32))
    if len(xmm) != 32:
        raise X86Error('x86 snapshot vector-register bank has the wrong size')
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
        debug=debug, msrs=msrs, xmm=xmm,
        halted=bool(header.get('halted', False)),
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
