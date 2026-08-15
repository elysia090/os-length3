#!/usr/bin/env python3
"""Attach an existing physical x86 block quotient to a new boot artifact."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import (load_native_x86_physical_machine,
                                load_x86_boot_cache,
                                rebase_native_x86_physical_machine)
from tools.build_native_x86_machine import _open_boot


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('machine', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--artifact-root', type=Path,
                        default=REPOSITORY / 'artifact')
    parser.add_argument('--source', default='linux-x86-64')
    arguments = parser.parse_args(argv)

    boot_payload, source_identity = _open_boot(
        arguments.artifact_root, arguments.source)
    source = arguments.machine.read_bytes()
    before, _memory, variants = load_native_x86_physical_machine(source)
    boot = load_x86_boot_cache(boot_payload)
    rebased = rebase_native_x86_physical_machine(
        source, boot_payload, boot.state)
    after, _memory, rebased_variants = \
        load_native_x86_physical_machine(rebased)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(rebased)
    print(json.dumps({
        'source_identity': source_identity,
        'input_bytes': len(source),
        'output_bytes': len(rebased),
        'blocks': int(after['block_count']),
        'physical_variants': len(rebased_variants),
        'retained_physical_variants': len(variants),
        'old_memory_prefix_sha256': before['memory']['prefix_sha256'],
        'new_memory_prefix_sha256': after['memory']['prefix_sha256'],
    }, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
