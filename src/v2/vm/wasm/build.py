#!/usr/bin/env python3
"""Compile `vm.c` to a freestanding wasm32 module.

    python3 vm/wasm/build.py [--out path] [--check]

An ordinary build writes canonical Wasm plus its replaceable page deliveries.
The browser does not fetch that output path directly; publication places the
verified result below `artifact/vm` and updates the repository catalog.  The
test suite also rebuilds it in a temporary directory and requires the source
fixture and published delivery to match byte for byte.

`--check` only verifies that it compiles warning-free, which is what a CI step
wants.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'vm.c')
TRIG_SOURCE = os.path.join(HERE, 'trig.c')
ROOT = os.path.dirname(os.path.dirname(HERE))
POSTLINK_RUNTIME_SOURCES = [
    os.path.join(ROOT, 'postlink-compiler', 'src', 'format.c'),
    os.path.join(ROOT, 'postlink-compiler', 'src', 'sha256.c'),
    os.path.join(ROOT, 'postlink-compiler', 'src', 'index.c'),
    os.path.join(ROOT, 'postlink-compiler', 'src', 'executable.c'),
    os.path.join(ROOT, 'postlink-compiler', 'src', 'residual.c'),
    os.path.join(ROOT, 'postlink-compiler', 'src', 'instantiation.c'),
]
EMITTER_CHECK = os.path.join(
    ROOT, 'postlink-compiler', 'check', 'emitter_vm.mjs')
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# -O2 for the same reason the browser compiles the paste at -O2: this is the
# execution substrate a search runs on, and its constant factor is the search's
# constant factor.  32 MB of linear memory holds the table, the undo log and
# the artifact buffer with room to spare.
FLAGS = [
    '--target=wasm32', '-O2', '-ffreestanding', '-nostdlib',
    '-I' + os.path.join(ROOT, 'postlink-compiler', 'include'),
    '-Wl,--no-entry', '-Wl,--export-dynamic', '-Wl,--export-table',
    '-Wl,--growable-table',
    '-Wl,--initial-memory=33554432',
    '-Wall', '-Wextra',
]

DELIVERY_PAGE_BYTES = 1 << 16
DELIVERY_DATA_SHARDS = 8
DELIVERY_PARITY_SHARDS = 2


def compile_source(source, out_path, flags, binary='clang'):
    compiler = binary
    probe = subprocess.run([binary, '-print-prog-name=clang'],
                           capture_output=True, text=True)
    resolved = probe.stdout.strip() if probe.returncode == 0 else ''
    if os.path.isabs(resolved) and os.path.isfile(resolved):
        # Nix's native cc-wrapper injects host linker flags even when clang is
        # explicitly targeting wasm32.  Clang names its unwrapped executable
        # through this standard query, so use that compiler for cross-targets.
        compiler = resolved
    flags = list(flags)
    linker = shutil.which('wasm-ld')
    if compiler != binary and linker is None:
        candidates = glob.glob('/nix/store/*-lld-*/bin/wasm-ld')
        version = re.search(r'clang-(\d+)', compiler)
        if version is not None:
            same = [path for path in candidates
                    if '-lld-%s.' % version.group(1) in path
                    or '-lld-%s-' % version.group(1) in path]
            candidates = same or candidates
        linker = sorted(candidates)[-1] if candidates else None
    if compiler != binary and linker:
        flags.append('-fuse-ld=' + linker)
    sources = list(source) if isinstance(source, (list, tuple)) else [source]
    result = subprocess.run([compiler] + flags + sources + ['-o', out_path],
                            capture_output=True, text=True)
    return result


def build(out_path, binary='clang'):
    return compile_source([SOURCE, TRIG_SOURCE] + POSTLINK_RUNTIME_SOURCES,
                          out_path, FLAGS, binary)


def normalize(out_path):
    """Apply the proof-preserving Wasm-body normalization used by drivers."""
    from qm.wasmbinary import optimize_module

    with open(out_path, 'rb') as handle:
        raw = handle.read()
    optimized, report = optimize_module(raw)
    if optimized != raw:
        with open(out_path, 'wb') as handle:
            handle.write(optimized)
    return report


def write_distribution(out_path, report):
    """Write the same authenticated physical-page delivery used by LLVM."""
    from kernel.pagefabric import write_artifact_delivery
    from qm.pagearchive import pack_wasm_steps, unpack as unpack_pages
    from qm.wasmbinary import function_exports, index_module
    from qm.wasmregions import pack as pack_regions

    with open(out_path, 'rb') as handle:
        payload = handle.read()
    indexed = index_module(payload)
    by_function = dict((body.function_index, body)
                       for body in indexed.bodies)
    exports = {}
    for name, function_index in function_exports(payload):
        body = by_function.get(function_index)
        if body is not None:
            exports[name] = {
                'function_index': body.function_index,
                'body_ordinal': body.ordinal,
                'body_start': body.start,
                'body_end': body.end,
                'type_index': body.type_index,
            }
    base, _extension = os.path.splitext(out_path)
    pages_path = base + '.pages'
    regions_path = base + '-regions.pages'
    manifest_path = base + '.json'
    main_delivery = write_artifact_delivery(
        payload, pages_path, page_bytes=DELIVERY_PAGE_BYTES,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    region_payload = pack_regions(indexed)
    region_delivery = write_artifact_delivery(
        region_payload, regions_path, page_bytes=4096,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    step_payload = pack_wasm_steps(indexed)
    step_archive = unpack_pages(step_payload)
    steps_path = base + '-steps.pages'
    step_delivery = write_artifact_delivery(
        step_payload, steps_path, page_bytes=4096,
        data_shards=DELIVERY_DATA_SHARDS,
        parity_shards=DELIVERY_PARITY_SHARDS)
    metadata = {
        'schema': 1,
        'vm': {
            'file': os.path.basename(out_path),
            'bytes': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(),
            'exports': exports,
            'regions': {
                'bytes': len(region_payload),
                'sha256': hashlib.sha256(region_payload).hexdigest(),
                'delivery': region_delivery,
            },
            'steps': {
                'bytes': len(step_payload),
                'sha256': hashlib.sha256(step_payload).hexdigest(),
                'pages': len(step_archive.entries),
                'directory_bytes': step_archive.directory_bytes,
                'delivery': step_delivery,
            },
            'delivery': main_delivery,
        },
        'normalization': {
            'pure_bodies': report['decoded_pure_integer_expressions'],
            'state_bodies': report['decoded_state_integer_expressions'],
            'replaced': report['replaced'],
            'forwarded_memory_loads': report['forwarded_memory_loads'],
            'grammar_misses': report.get('grammar_misses', {}),
        },
    }
    with open(manifest_path, 'w', newline='\n') as handle:
        json.dump(metadata, handle, indent=2, sort_keys=True)
        handle.write('\n')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=os.path.join(HERE, 'vm.wasm'))
    parser.add_argument('--check', action='store_true',
                        help='compile to a scratch file and discard it')
    parser.add_argument('--direct-check', action='store_true',
                        help='also run the compiler-to-shared-table VM check')
    parser.add_argument('--completeness-check', action='store_true',
                        help='require precise direct-MMU fault observation')
    parser.add_argument('--emitted-module',
                        help='C-emitted block module checked with --direct-check')
    parser.add_argument('--emitted-cold-module',
                        help='cold C-emitted block module checked with --direct-check')
    parser.add_argument('--executable-root',
                        help='C-emitted executable root checked with --direct-check')
    parser.add_argument('--residual-root',
                        help='successor-free residual root checked with --direct-check')
    parser.add_argument('--executable-node', action='append', default=[],
                        help='content-addressed index node checked with --direct-check')
    parser.add_argument('--executable-resource', action='append', default=[],
                        help='content-addressed resource checked with --direct-check')
    args = parser.parse_args()

    if args.completeness_check:
        args.direct_check = True

    if (args.emitted_module or args.emitted_cold_module
            or args.executable_root or args.residual_root
            or args.executable_node
            or args.executable_resource) \
            and not args.direct_check:
        parser.error('emitted executable inputs require --direct-check')
    if bool(args.emitted_module) != bool(args.executable_root):
        parser.error('--emitted-module and --executable-root must be supplied together')
    if args.emitted_module and not args.residual_root:
        parser.error('the fixture requires --residual-root')
    if args.emitted_module and not args.emitted_cold_module:
        parser.error('the fixture requires --emitted-cold-module')
    if args.emitted_module and len(args.executable_node) != 3:
        parser.error('the fixture requires three --executable-node inputs')
    if args.executable_node and not args.emitted_module:
        parser.error('--executable-node requires --emitted-module')
    if args.emitted_module and len(args.executable_resource) != 7:
        parser.error('the fixture requires seven --executable-resource inputs')
    if args.executable_resource and not args.emitted_module:
        parser.error('--executable-resource requires --emitted-module')

    binary = shutil.which('clang')
    if not binary:
        print('no clang on PATH', file=sys.stderr)
        return 2

    out = args.out
    if args.check or args.direct_check:
        out = os.path.join(HERE, '.check.wasm')

    result = build(out, binary)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return 1
    # A warning here is a defect: this module has no libc to blame.
    if result.stderr.strip():
        sys.stderr.write(result.stderr)
        return 1

    report = normalize(out)

    size = os.path.getsize(out)
    if args.direct_check:
        node = shutil.which('node')
        if not node:
            print('no node on PATH', file=sys.stderr)
            os.unlink(out)
            return 2
        if args.emitted_module:
            checked = subprocess.run(
                [node, EMITTER_CHECK, out, args.emitted_module,
                 args.emitted_cold_module,
                 args.executable_root, args.residual_root]
                + args.executable_node
                + args.executable_resource
                + (['--require-completeness']
                   if args.completeness_check else []),
                capture_output=True, text=True)
            if checked.returncode != 0:
                sys.stderr.write(checked.stderr)
                os.unlink(out)
                return 1
            sys.stdout.write(checked.stdout)
    if args.check or args.direct_check:
        os.unlink(out)
        print('vm.c compiles clean (%d bytes)' % size)
    else:
        distribution = write_distribution(out, report)
        print('wrote %s (%d bytes)' % (out, size))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '.pages',
                 distribution['vm']['delivery']['bytes'],
                 distribution['vm']['delivery']['prefix_bytes']))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '-regions.pages',
                 distribution['vm']['regions']['delivery']['bytes'],
                 distribution['vm']['regions']['delivery']['prefix_bytes']))
        print('wrote %s (%d bytes, %d-byte authenticated prefix)'
              % (os.path.splitext(out)[0] + '-steps.pages',
                 distribution['vm']['steps']['delivery']['bytes'],
                 distribution['vm']['steps']['delivery']['prefix_bytes']))
    print('post-link normalization checked %d pure and %d state Wasm bodies; '
          '%d replaced, '
          '%d memory loads substituted'
          % (report['decoded_pure_integer_expressions'],
             report['decoded_state_integer_expressions'],
             report['replaced'], report['forwarded_memory_loads']))
    print('state pages: %d physical operations total; %d have no typed-wasm '
          'diagnostic spelling'
          % (report['state_physical_work'],
             report['unencodable_state_integer_expressions']))
    print('reencodable state work %d physical -> %d typed wasm '
          '(%d publication/materialization operations)'
          % (report['reencodable_state_physical_work'],
             report['state_reencoded_work'],
             report['reencoded_materializations']))
    if report['rejected_typed_wasm_improvements']:
        print('%d typed-wasm state rewrite(s) rejected; state pages remain '
              'physical'
              % report['rejected_typed_wasm_improvements'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
