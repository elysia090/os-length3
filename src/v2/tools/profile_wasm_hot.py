#!/usr/bin/env python3
"""Profile dynamic QM work/span and barrier cost in a shipped wasm VM."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from qm import wasmvm
from qm.steppage import decode_plan
from qm.wasmstate import decode_module


def operand(value):
    return [value.kind, value.value]


def profile_vm(module_path, artifact_path=None):
    module = decode_module(Path(module_path).read_bytes())
    if artifact_path is None:
        from vm import codec, image, seed
        artifact = codec.pack(codec.code(image.serialize(seed.ECHO)))
    else:
        artifact = Path(artifact_path).read_bytes()
    state = wasmvm.load(module, artifact)
    for byte in range(256):
        after = wasmvm.feed(module, state, byte)
        wasmvm.read(module, after)
    layout = state.executor.normalization_layout()
    layout['direct_projection_calls'] = 512 if state.direct_byte_state else 0
    details = []
    for item in layout['dominant_residuals']:
        key = tuple(item['coordinate'])
        entry = state.executor.steps.get(key)
        plan = decode_plan(entry.mapped)
        details.append(dict(item, nodes=[
            {
                'value': node.value,
                'op': node.op,
                'arguments': [operand(value) for value in node.arguments],
            }
            for node in plan.nodes
        ], outputs={
            'stack': [operand(value) for value in plan.stack],
            'locals': [operand(value) for value in plan.locals],
        }))
    layout['dominant_residual_details'] = details
    return layout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--vm-artifact',
                        help='artifact to open; defaults to the built echo seed')
    args = parser.parse_args(argv)
    print(json.dumps(profile_vm(args.module, args.vm_artifact),
                     indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
