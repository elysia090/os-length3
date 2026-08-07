#!/usr/bin/env python3
"""Command-line front door for the same pipeline the browser runs.

    python3 -m qm.cli examples/ranks8.c
    python3 -m qm.cli examples/ranks8.c --observer low:8 --json
    python3 -m qm.cli --frontend cfront kernel.c

This is the local, interactive product from SPEC §21, not the paid automation
API of SPEC §22-§23: it runs entirely on this machine, and it has no account,
no network and no quota.
"""

import argparse
import json
import sys

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
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

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
