#!/usr/bin/env python3
"""Command-line front door for the same pipeline the browser runs.

    python3 -m qm.cli corpus/lanes/ranks8.c
    python3 -m qm.cli corpus/lanes/ranks8.c --observer low:8 --json
    python3 -m qm.cli --frontend cfront kernel.c
    python3 -m qm.cli web/vm.wasm --vm-artifact echo.qm --json

This is a local interactive command. It runs entirely on this machine and has
no account, network dependency, or quota.
"""

import argparse
import json
import sys

from .cfront.errors import CFrontError
from .isa import DEFAULT_PROFILES, PROFILE_BY_NAME
from .pipeline import solve, to_json_safe


def build_parser():
    parser = argparse.ArgumentParser(
        prog='qm', description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source', nargs='?', default='-',
                        help='C source file, or - for stdin')
    parser.add_argument('--function', help='which function to analyse')
    parser.add_argument('--observer', default='exact',
                        help='exact | low:N | high:N | mask:0x... | byte:K | '
                             'nonzero')
    parser.add_argument('--target', action='append', dest='targets',
                        choices=sorted(PROFILE_BY_NAME),
                        help='target ISA (repeatable)')
    parser.add_argument('--frontend', default=None,
                        choices=['clang', 'cfront'],
                        help='default: clang when available, else cfront')
    parser.add_argument('--opt', default='-O2', choices=['-O1', '-O2', '-O3'])
    parser.add_argument('--source-target', default='x86-64',
                        choices=['x86-64', 'x86-64-v2', 'x86-64-v3', 'x86-64-v4'])
    parser.add_argument('--json', action='store_true',
                        help='machine-readable output')
    parser.add_argument('--asm', action='store_true',
                        help='print the compiler assembly as well')
    parser.add_argument('--state-main', action='store_true',
                        help='treat a linked .wasm main as an imported-I/O '
                             'state machine')
    parser.add_argument('--vm-artifact',
                        help='open this codec artifact in a vm.wasm input and '
                             'minimize its exact feed/read state machine')
    parser.add_argument('--state-max-states', type=int, default=4096,
                        help='exact reachable-state limit (default: 4096)')
    parser.add_argument('--state-step-budget', type=int, default=1 << 20,
                        help='wasm instructions allowed between I/O boundaries')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.vm_artifact:
        return state_vm(args)
    if args.state_main:
        return state_main(args)

    if args.source == '-':
        source = sys.stdin.read()
    else:
        with open(args.source) as handle:
            source = handle.read()

    result = solve(
        source,
        function=args.function,
        observer=args.observer,
        targets=args.targets or DEFAULT_PROFILES,
        frontend=args.frontend,
        options={'opt': args.opt, 'source_target': args.source_target},
    )

    if args.json:
        json.dump(to_json_safe(result), sys.stdout, indent=2, default=str)
        sys.stdout.write('\n')
        return 0 if result.get('ok') else 1

    return report(result, show_asm=args.asm)


def state_main(args):
    """Exact whole-program path for an already linked wasm module."""
    if args.source == '-':
        raw = sys.stdin.buffer.read()
    else:
        with open(args.source, 'rb') as handle:
            raw = handle.read()
    from .transducer import StateLimit
    from .wasmstate import compile_stream, decode_module
    try:
        module = decode_module(raw)
        compiled = compile_stream(
            module,
            function=args.function or 'main',
            max_states=args.state_max_states,
            budget=args.state_step_budget,
        )
    except (CFrontError, StateLimit, ValueError) as exc:
        print('state-frontend: %s' % exc, file=sys.stderr)
        return 1
    result = compiled.to_dict()
    result.update({'ok': True, 'exact': True,
                   'state_bits': max(0, (compiled.classes - 1).bit_length())})
    if args.json:
        json.dump(result, sys.stdout, indent=2, default=str)
        sys.stdout.write('\n')
    else:
        print('main state machine')
        print('  reachable states %d' % compiled.reachable_states)
        print('  future classes   %d' % compiled.classes)
        print('  state bits       %d' % result['state_bits'])
        print('  alphabet         byte + EOF')
    return 0


def state_vm(args):
    """Put a compiled VM and one opened artifact through stateful QM."""
    if args.source == '-':
        raw = sys.stdin.buffer.read()
    else:
        with open(args.source, 'rb') as handle:
            raw = handle.read()
    with open(args.vm_artifact, 'rb') as handle:
        artifact = handle.read()

    from .transducer import StateLimit
    from .wasmstate import decode_module, invoke
    from .wasmvm import compile_vm, load
    try:
        module = decode_module(raw)
        initial = load(module, artifact, budget=args.state_step_budget)
        mode = invoke(module, initial.snapshot, 'vm_direct_byte_state', (),
                      budget=args.state_step_budget).result[0]
        compiled = compile_vm(
            module, initial,
            max_states=args.state_max_states,
            budget=args.state_step_budget,
        )
    except (CFrontError, StateLimit, ValueError, OSError) as exc:
        print('vm-state-frontend: %s' % exc, file=sys.stderr)
        return 1

    result = compiled.to_dict()
    result.update({
        'ok': True,
        'exact': True,
        'state_bits': max(0, (compiled.classes - 1).bit_length()),
        'vm_bytes': len(raw),
        'artifact_bytes': len(artifact),
        'state_step': ('direct-byte-register' if mode == 1 else 'generic'),
    })
    if args.json:
        json.dump(result, sys.stdout, indent=2, default=str)
        sys.stdout.write('\n')
    else:
        print('wasm VM state machine')
        print('  reachable states %d' % compiled.reachable_states)
        print('  future classes   %d' % compiled.classes)
        print('  state bits       %d' % result['state_bits'])
        print('  state step       %s' % result['state_step'])
        print('  build cells      %d' % result['build_form']['storage_cells'])
    return 0


def report(result, show_asm=False):
    if not result.get('ok'):
        error = result['error']
        print('%s: %s' % (result.get('stage', 'error'),
                          error.get('text') or error.get('message')),
              file=sys.stderr)
        return 1

    front = result['frontend']
    print('%s' % front['function']['signature'])
    print('  frontend        %s' % front['frontend']['title'])
    baseline = front['reference_ops'].get('mean')
    print('  compiler output %s' % (
        '%s (%s)' % (baseline, front['reference_ops']['metric'])
        if baseline is not None else 'unavailable'))
    print('  observer        %s' % result['observer']['description'])
    print('  domain          2^%d, %s'
          % (result['semantics']['input_bits'],
             result['semantics']['domain']['strength']))

    obs = result['quotients']['observation']
    print('  observation     %d outputs -> %d observables'
          % (obs['distinct_outputs'], obs['distinct_observables']))
    future = result['quotients']['future']
    print('  future quotient %s' % (
        '%d bits of streaming state (was %d)'
        % (future['state_bits'], future['naive_state_bits'])
        if future.get('computed') else future.get('reason')))

    if not result.get('program'):
        print('\nno program in the declared grammar')
        print('  %s' % result.get('note', ''))
        return 2

    program = result['program']
    print('\nQuotient Minimizer')
    print('  normalized      %s' % ' ; '.join(
        op['label'] for op in program['ops']))
    print('  core ops        %d' % program['core_ops'])
    print('  residual freedom %d  (family %s, %s candidates)'
          % (program['residual_freedom'], program['solver'],
             program['candidates']))
    if result.get('recognition'):
        print('  recognized as   %s' % ', '.join(result['recognition']))

    print('\ntargets')
    for target in result['targets']:
        if not target.get('ok'):
            print('  %-22s cannot lower: %s' % (target['name'], target['reason']))
            continue
        v = target['verification']
        print('  %-22s span %-3d work %-3d L=%d bit  %s %d/%d %s'
              % (target['name'], target['span'], target['work'],
                 target['L_bits'], v['mode'], v['matched'], v['total'],
                 'PASS' if v['pass'] else 'FAIL'))
        print('  %-22s %s' % ('', ' '.join(target['instructions'])))

    primary = next((t for t in result['targets']
                    if t['name'] == result['primary_target']), None)
    if primary:
        print('\n%s' % primary['c'])
        if show_asm and primary.get('asm'):
            print(primary['asm'])

    print('derivation')
    for step in result['derivation']:
        print('  %-24s %s' % (step['step'], step['value']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
