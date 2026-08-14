#!/usr/bin/env python3
"""Measure dispatch redundancy in one delivered native x86 machine."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import PageFabric, open_artifact
from kernel.x86snapshot import (load_native_x86_machine,
                                NATIVE_BLOCK_HEADER,
                                split_native_x86_record)
from qm.steppage import (OPERAND_KINDS, project_step_template,
                         unpack as unpack_step)


BLOCK = NATIVE_BLOCK_HEADER
BLOCK_INSTANCE_BYTES = 20       # RIP + STEP/control/proof ranks
CONTROL_TEMPLATE_BYTES = 40     # control + four exact u64 projections
STEP_INSTANCE_BYTES = 16
EXTENT_BYTES = 8
DIRECT_CACHE_SLOTS = 2048
DIRECT_CACHE_BYTES = 1024
CONTROL_NAMES = (
    'next', 'branch', 'conditional', 'dynamic', 'halt', 'timeslice',
    'write_msr', 'read_msr', 'cpuid', 'register', 'segment', 'descriptor',
    'far_return', 'divide', 'interrupt_return', 'internal', 'read_segment',
    'port_read', 'port_write', 'invalidate_page', 'clock',
    'debug_register', 'exception', 'wide_divide', 'recurrence', 'entropy',
    'store_descriptor', 'system_segment',
)


def _direct_cache_slot(rip):
    return (int(rip) ^ (int(rip) >> 12) ^ (int(rip) >> 24)) \
        & (DIRECT_CACHE_SLOTS - 1)


def _continuation_quotient(fields):
    """Project one control row relative to its block coordinate.

    RIP itself is the block-directory coordinate.  Every statically named
    successor is therefore a displacement; local/register descriptors remain
    exact words.  The boundary coordinate is projected as a displacement as
    well so reconstruction retains diagnostic identity without splitting the
    continuation class by load address.
    """
    rip = int(fields[3]) & ((1 << 64) - 1)
    boundary = (int(fields[4]) - rip) & ((1 << 64) - 1)
    control = int(fields[6])
    first, second, third = map(int, fields[7:10])
    if control == 2:
        first = (first - rip) & ((1 << 64) - 1)
        second = (second - rip) & ((1 << 64) - 1)
    elif control not in (0, 3, 4, 5, 12, 14, 22):
        first = (first - rip) & ((1 << 64) - 1)
    return control, boundary, first, second, third


def _signed_residual_width(value):
    """Return the shortest fixed signed width preserving one u64 residual."""
    value = int(value) & ((1 << 64) - 1)
    signed = value if value < (1 << 63) else value - (1 << 64)
    for width in (1, 2, 4):
        limit = 1 << (width * 8 - 1)
        if -limit <= signed < limit:
            return width
    return 8


def _compact_continuation_bytes(continuation):
    """Size a lossless field-residual row for one control continuation.

    A three-byte tag names the control and one of eight projections for each
    word.  Zero, the boundary residual, and the first argument need no payload;
    every other word uses its shortest signed 1/2/4/8-byte representation.
    The table itself is addressed by a u32 prefix-offset array, so a rank does
    not require a materialized object or a fixed 40-byte row.
    """
    _control, boundary, first, second, third = continuation
    prior = (boundary, first)
    payload = 0
    shapes = []
    for index, value in enumerate((boundary, first, second, third)):
        if not value:
            shape = 'zero'
        elif index and value == prior[0]:
            shape = 'boundary'
        elif index > 1 and value == prior[1]:
            shape = 'first'
        else:
            width = _signed_residual_width(value)
            shape = 'i%d' % (width * 8)
            payload += width
        shapes.append(shape)
    return 3 + payload, tuple(shapes)


def _block_quotient(page, state_coordinates=False):
    """Return a STEP template after projecting block-specific coordinates.

    Literal words are always parameters.  The stronger quotient also moves
    input/output frame coordinates into the descriptor: their identity is a
    property of the block admission, not of its SSA operator graph.
    """
    mapped = unpack_step(page)
    shape = [
        mapped.instructions, mapped.work, mapped.span, mapped.local_extent,
        mapped.stack_inputs, mapped.stack_count, mapped.local_updates,
        mapped.values('wave_offsets'), mapped.values('lane_values'),
        mapped.values('opcodes'), mapped.values('argument_offsets'),
    ]
    word_parameters = 0
    value_coordinate_parameters = 0
    for tags_name, values_name in (
            ('operand_tags', 'operand_values'),
            ('stack_tags', 'stack_values'),
            ('local_tags', 'local_values')):
        tags = mapped.values(tags_name)
        values = mapped.values(values_name)
        projected = []
        for tag, value in zip(tags, values):
            kind = OPERAND_KINDS[tag]
            parameter = kind == 'const' or (
                state_coordinates and kind in ('stack', 'local'))
            projected.append(0 if parameter else value)
            word_parameters += kind == 'const'
            value_coordinate_parameters += parameter and kind != 'const'
        shape.extend((
            tags,
            tuple(projected),
        ))
    local_indices = mapped.values('local_indices')
    shape.append(tuple(0 for _ in local_indices)
                 if state_coordinates else local_indices)
    index_parameters = len(local_indices) if state_coordinates else 0
    removed = (word_parameters * 8
               + value_coordinate_parameters * 8
               + index_parameters * 4)
    # Frame coordinates are bounded by STEP_VALUE_CAP and need two bytes in
    # the parameter projection. Literal parameters remain full machine words.
    parameter_bytes = (word_parameters * 8
                       + (value_coordinate_parameters
                          + index_parameters) * 2)
    return tuple(shape), len(page) - removed, parameter_bytes


def profile(artifact_root, name='linux-x86-64-machine', output=None,
            input_path=None):
    artifact_root = Path(artifact_root)
    if input_path is None:
        catalog = json.loads(
            (artifact_root / 'index.json').read_text(encoding='utf-8'))
        entry = catalog['artifacts'][name]
        index = json.loads(
            (artifact_root / entry['path']).read_text(encoding='utf-8'))
        manifest, store = open_artifact(index, artifact_root, name)
        fabric = PageFabric(manifest, (store,))
        payload = fabric.read(0, fabric.length)
    else:
        payload = Path(input_path).read_bytes()
    if output is not None:
        Path(output).write_bytes(payload)

    header, _memory, native_records = load_native_x86_machine(payload)

    controls = Counter()
    slots = Counter()
    step_pages = {}
    quotient_shapes = {}
    quotient_parameter_bytes = 0
    state_shapes = {}
    state_parameter_bytes = 0
    coordinates = set()
    guards = set()
    continuation_templates = set()
    continuation_rows = Counter()
    continuation_shapes = Counter()
    exact_block_templates = set()
    structural_block_templates = set()
    records = 0
    record_bytes = 0
    cacheable = 0
    for rip, record in native_records:
        length = len(record)
        if len(record) != length or length < BLOCK.size:
            raise ValueError('native record extent is invalid')
        unpacked = BLOCK.unpack_from(record)
        if unpacked[0] != b'X86B' or unpacked[3] != rip:
            raise ValueError('native record identity is invalid')
        control = int(unpacked[6])
        name_key = (CONTROL_NAMES[control] if control < len(CONTROL_NAMES)
                    else 'unknown:%d' % control)
        controls[name_key] += 1
        slots[_direct_cache_slot(rip)] += 1
        fields, guard, page = split_native_x86_record(record)
        identity = hashlib.sha256(page).hexdigest()
        if identity not in step_pages:
            step_pages[identity] = len(page)
            shape, template_bytes, parameter_bytes = _block_quotient(page)
            quotient_shapes.setdefault(shape, template_bytes)
            quotient_parameter_bytes += parameter_bytes
            template, parameters = project_step_template(page)
            state_shapes.setdefault(template, len(template))
            state_parameter_bytes += len(parameters)
        else:
            template, _parameters = project_step_template(page)
        continuation = _continuation_quotient(fields)
        continuation_templates.add(continuation)
        continuation_rows[control] += 1
        exact_block_templates.add((identity, continuation))
        structural_block_templates.add((template, continuation))
        if guard:
            guards.add(guard)
        coordinates.add(rip)
        records += 1
        record_bytes += length
        cacheable += int(length <= DIRECT_CACHE_BYTES)

    unique_step_bytes = sum(step_pages.values())
    compact_continuation_bytes = 0
    for continuation in continuation_templates:
        encoded_bytes, shapes = _compact_continuation_bytes(continuation)
        compact_continuation_bytes += encoded_bytes
        continuation_shapes[(continuation[0], shapes)] += 1
    compact_continuation_directory_bytes = (
        len(continuation_templates) + 1) * 4
    compact_descriptor_bytes = (
        records * BLOCK_INSTANCE_BYTES
        + len(step_pages) * STEP_INSTANCE_BYTES
        + (len(state_shapes) + len(guards)) * EXTENT_BYTES
        + compact_continuation_directory_bytes
        + compact_continuation_bytes)
    return {
        'artifact': name,
        'records': records,
        'coordinates': len(coordinates),
        'code_variants': records - len(coordinates),
        'record_bytes': record_bytes,
        'artifact_schema': int(header['schema']),
        'stored_native_bytes': (
            int(header.get('descriptor_bytes', 0))
            + int(header.get('execution_bytes', record_bytes))),
        'step_pages': {
            'unique': len(step_pages),
            'duplicate_records': records - len(step_pages),
            'unique_bytes': unique_step_bytes,
            'record_payload_bytes': record_bytes - records * BLOCK.size,
        },
        'constant_quotient': {
            'templates': len(quotient_shapes),
            'shared_records': records - len(quotient_shapes),
            'template_bytes': sum(quotient_shapes.values()),
            'parameter_bytes': quotient_parameter_bytes,
            'projected_execution_bytes': (
                sum(quotient_shapes.values()) + quotient_parameter_bytes),
            'projected_saving_bytes': unique_step_bytes - (
                sum(quotient_shapes.values()) + quotient_parameter_bytes),
        },
        'state_coordinate_quotient': {
            'templates': len(state_shapes),
            'shared_records': records - len(state_shapes),
            'template_bytes': sum(state_shapes.values()),
            'parameter_bytes': state_parameter_bytes,
            'projected_execution_bytes': (
                sum(state_shapes.values()) + state_parameter_bytes),
            'projected_saving_bytes': unique_step_bytes - (
                sum(state_shapes.values()) + state_parameter_bytes),
        },
        'continuation_quotient': {
            'templates': len(continuation_templates),
            'shared_records': records - len(continuation_templates),
            'exact_step_control_classes': len(exact_block_templates),
            'ssa_control_classes': len(structural_block_templates),
            'projected_descriptor_bytes': (
                records * BLOCK_INSTANCE_BYTES
                + len(continuation_templates) * CONTROL_TEMPLATE_BYTES
                + len(step_pages) * STEP_INSTANCE_BYTES
                + (len(state_shapes) + len(guards)) * EXTENT_BYTES),
            'projected_saving_bytes': int(header.get(
                'descriptor_bytes', 0)) - (
                    records * BLOCK_INSTANCE_BYTES
                    + len(continuation_templates) * CONTROL_TEMPLATE_BYTES
                    + len(step_pages) * STEP_INSTANCE_BYTES
                    + (len(state_shapes) + len(guards)) * EXTENT_BYTES),
            'field_residual_projection': {
                'kind': 'control-tag-tail-offset-csr',
                'offset_bytes': compact_continuation_directory_bytes,
                'payload_bytes': compact_continuation_bytes,
                'projected_descriptor_bytes': compact_descriptor_bytes,
                'projected_saving_bytes': int(header.get(
                    'descriptor_bytes', 0)) - compact_descriptor_bytes,
                'shapes': {
                    '%s:%s' % (
                        CONTROL_NAMES[control]
                        if control < len(CONTROL_NAMES)
                        else 'unknown:%d' % control,
                        ','.join(shape)):
                    count
                    for (control, shape), count
                    in continuation_shapes.most_common()
                },
            },
        },
        'controls': dict(controls.most_common()),
        'direct_cache': {
            'slots': DIRECT_CACHE_SLOTS,
            'used_slots': len(slots),
            'static_collisions': records - len(slots),
            'largest_bucket': max(slots.values(), default=0),
            'cacheable_records': cacheable,
            'oversized_records': records - cacheable,
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--name', default='linux-x86-64-machine')
    parser.add_argument('--output', type=Path,
                        help='optionally materialize the verified raw machine')
    parser.add_argument('--input', type=Path,
                        help='profile these canonical machine bytes directly')
    args = parser.parse_args(argv)
    print(json.dumps(profile(
        args.artifact_root, args.name, args.output, args.input), indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
