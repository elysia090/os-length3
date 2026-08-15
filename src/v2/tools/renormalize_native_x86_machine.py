#!/usr/bin/env python3
"""Rebuild resident-state records whose physical grammar has changed.

The executable proof remains the authority.  A runtime snapshot supplies the
current page tables and code bytes, while every replacement is decoded and
packed by the same x86/QM path used for new closure records.
"""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86 import X86DBT
from kernel.x86snapshot import (
    extend_loaded_native_x86_physical_machine,
    load_native_x86_machine,
    load_native_x86_physical_machine,
    pack_native_x86_records,
    split_native_x86_record,
    _native_code_guard_extents,
)
from tools.close_native_x86_runtime import load_runtime_cut


def _may_contain_fpu_state(record):
    _fields, guard, _step = split_native_x86_record(record)
    return any(b'\x0f\xae' in payload
               for _address, payload in _native_code_guard_extents(guard))


def renormalize(machine_payload, state):
    metadata, memory, resident = load_native_x86_physical_machine(
        machine_payload)
    _header, _memory, records = load_native_x86_machine(machine_payload)
    candidates = sorted(set(
        rip for rip, record in records if _may_contain_fpu_state(record)))
    dbt = X86DBT(profile_controls=True)
    replacements = []
    decoded = []
    rejected = []
    for rip in candidates:
        try:
            cut = dbt.physical_block(replace(state.cpu, rip=rip))
            packed = pack_native_x86_records(cut)
        except Exception as error:
            rejected.append({
                'rip': '%016x' % rip,
                'reason': '%s: %s' % (type(error).__name__, error),
            })
            continue
        controls = []
        for coordinate, record in packed:
            control = int(split_native_x86_record(record)[0][6])
            controls.append(control)
            if control in (41, 42):
                replacements.append((coordinate, record))
        decoded.append({
            'rip': '%016x' % rip,
            'boundary': cut.boundary.operation,
            'controls': controls,
        })
    if not replacements:
        raise RuntimeError('no resident FPU state record was reconstructed')
    output = extend_loaded_native_x86_physical_machine(
        metadata, memory, resident, replacements,
        reject_conflicts=False, replace_proved=True)
    return output, {
        'candidates': len(candidates),
        'replacements': len(replacements),
        'decoded': decoded,
        'rejected': rejected,
        'input_bytes': len(machine_payload),
        'output_bytes': len(output),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('machine', type=Path)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    arguments = parser.parse_args(argv)

    state, source_identity, dirty_pages = load_runtime_cut(
        arguments.artifact_root, arguments.source, arguments.snapshot)
    output, report = renormalize(arguments.machine.read_bytes(), state)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(output)
    report.update({
        'source_identity': source_identity,
        'dirty_pages': dirty_pages,
    })
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
