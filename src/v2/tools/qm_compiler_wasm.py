#!/usr/bin/env python3
"""Apply function-local QM to a YoWASP compiler core wasm module.

    python tools/qm_compiler_wasm.py llvm.core.wasm --out compiler.qm.wasm

The tool never models WASI as a constant. It substitutes and normalizes only
closed straight-line integer functions, preserving independent parameters as
independent SSA inputs, then rewrites only strict improvements. Every stateful
or host-observing body stays byte-for-byte intact.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from qm.wasmbinary import optimize_module


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('module')
    parser.add_argument('--out')
    parser.add_argument('--max-body', type=int, default=4096)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)

    with open(args.module, 'rb') as handle:
        optimized, report = optimize_module(handle.read(), args.max_body)
    if args.out:
        with open(args.out, 'wb') as handle:
            handle.write(optimized)

    public = dict((key, value) for key, value in report.items()
                  if key != 'replacements')
    public['replacements'] = [
        {
            'function_index': item.body.function_index,
            'body_bytes': [item.original_size, len(item.raw)],
            'wasm_ops': [item.original_work, item.replacement_work],
            'before': list(item.before_ops),
            'after': list(item.after_ops),
        }
        for item in report['replacements']
    ]
    if args.json:
        print(json.dumps(public, indent=2))
    else:
        print('%s: %d functions, %d pure integer expressions, %d replaced'
              % (os.path.basename(args.module), public['functions'],
                 public['decoded_pure_integer_expressions'], public['replaced']))
        print('  %d -> %d bytes (%d body bytes removed)'
              % (public['module_bytes'], public['output_bytes'],
                 public['saved_body_bytes']))
        for item in public['replacements'][:20]:
            print('  function %d: %d -> %d bytes, %d -> %d wasm ops'
                  % (item['function_index'], item['body_bytes'][0],
                     item['body_bytes'][1], item['wasm_ops'][0],
                     item['wasm_ops'][1]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
