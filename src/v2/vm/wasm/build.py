#!/usr/bin/env python3
"""Compile `vm.c` to a freestanding wasm32 module.

    python3 vm/wasm/build.py [--out path] [--check]

The module is built, not committed: a checked-in binary is a claim nobody can
read, and the C is 300 lines that any clang can turn into the same thing. The
test suite builds it into a temporary directory for the same reason.

`--check` only verifies that it compiles warning-free, which is what a CI step
wants.
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, 'vm.c')

# -O2 for the same reason the browser compiles the paste at -O2: this is the
# execution substrate a search runs on, and its constant factor is the search's
# constant factor.  32 MB of linear memory holds the table, the undo log and
# the artifact buffer with room to spare.
FLAGS = [
    '--target=wasm32', '-O2', '-ffreestanding', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--export-dynamic',
    '-Wl,--initial-memory=33554432',
    '-Wall', '-Wextra',
]


def build(out_path, binary='clang'):
    result = subprocess.run([binary] + FLAGS + [SOURCE, '-o', out_path],
                            capture_output=True, text=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=os.path.join(HERE, 'vm.wasm'))
    parser.add_argument('--check', action='store_true',
                        help='compile to a scratch file and discard it')
    args = parser.parse_args()

    binary = shutil.which('clang')
    if not binary:
        print('no clang on PATH', file=sys.stderr)
        return 2

    out = args.out
    if args.check:
        out = os.path.join(HERE, '.check.wasm')

    result = build(out, binary)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return 1
    # A warning here is a defect: this module has no libc to blame.
    if result.stderr.strip():
        sys.stderr.write(result.stderr)
        return 1

    size = os.path.getsize(out)
    if args.check:
        os.unlink(out)
        print('vm.c compiles clean (%d bytes)' % size)
    else:
        print('wrote %s (%d bytes)' % (out, size))
    return 0


if __name__ == '__main__':
    sys.exit(main())
