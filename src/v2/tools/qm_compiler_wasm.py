#!/usr/bin/env python3
"""Apply function-local QM to a YoWASP compiler core wasm module.

    python tools/qm_compiler_wasm.py llvm.core.wasm --out compiler.qm.wasm

The tool never models WASI as a constant. Pure straight-line integer functions
are rewritten only on a strict typed-Wasm work and byte improvement. Stateful
straight-line functions are lowered through the ordinary persistent-cut and
physical state-step path, but typed-Wasm re-encoding is diagnostic only: the
physical page is the optimized form and the module body remains byte-for-byte
intact. Host-observing bodies also remain intact.
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
        print('%s: %d functions, %d pure and %d state integer expressions, '
              '%d replaced'
              % (os.path.basename(args.module), public['functions'],
                 public['decoded_pure_integer_expressions'],
                 public['decoded_state_integer_expressions'],
                 public['replaced']))
        print('  %d -> %d bytes (%d body bytes removed)'
              % (public['module_bytes'], public['output_bytes'],
                 public['saved_body_bytes']))
        print('  %d dominating memory loads substituted'
              % public['forwarded_memory_loads'])
        print('  state pages: %d physical operations total; %d have no '
              'typed-wasm diagnostic spelling'
              % (public['state_physical_work'],
                 public['unencodable_state_integer_expressions']))
        print('  reencodable state work %d physical -> %d typed wasm '
              '(%d publication/materialization operations)'
              % (public['reencodable_state_physical_work'],
                 public['state_reencoded_work'],
                 public['reencoded_materializations']))
        if public['rejected_typed_wasm_improvements']:
            print('  %d typed-wasm state rewrite(s) rejected; physical '
                  'state pages are the sole execution form'
                  % public['rejected_typed_wasm_improvements'])
        for item in public['replacements'][:20]:
            print('  function %d: %d -> %d bytes, %d -> %d wasm ops'
                  % (item['function_index'], item['body_bytes'][0],
                     item['body_bytes'][1], item['wasm_ops'][0],
                     item['wasm_ops'][1]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
