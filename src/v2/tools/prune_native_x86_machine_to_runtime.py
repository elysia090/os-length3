#!/usr/bin/env python3
"""Prune a native x86 directory to code mapped by one runtime checkpoint."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import prune_native_x86_machine_to_state
from tools.close_native_x86_runtime import load_runtime_cut


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
    payload, report = prune_native_x86_machine_to_state(
        arguments.machine.read_bytes(), state.cpu)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(payload)
    report.update({
        'source_identity': source_identity,
        'dirty_pages': dirty_pages,
        'output': str(arguments.output),
    })
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
