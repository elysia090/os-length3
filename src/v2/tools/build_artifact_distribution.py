#!/usr/bin/env python3
"""Publish canonical bytes as a named physical-page delivery.

The canonical input is not copied into the output tree.  The generated bundle
can be replaced by another page, compression, or erasure geometry without
changing the identity recorded below ``artifact/<name>``.
"""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import write_artifact


def build(source, output, name, page_bytes=1 << 16, data_shards=8,
          parity_shards=2, included_shards='data'):
    return write_artifact(
        Path(source).read_bytes(), output, name, page_bytes=page_bytes,
        data_shards=data_shards, parity_shards=parity_shards,
        included_shards=included_shards)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', type=Path,
                        default=ROOT.parents[1] / 'artifact')
    parser.add_argument('--name',
                        help='one portable locator; defaults to the file stem')
    parser.add_argument('--page-bytes', type=int, default=1 << 16)
    parser.add_argument('--data-shards', type=int, default=8)
    parser.add_argument('--parity-shards', type=int, default=2)
    parser.add_argument('--include-parity', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    name = args.name or args.source.stem
    index = build(
        args.source, args.out, name, page_bytes=args.page_bytes,
        data_shards=args.data_shards, parity_shards=args.parity_shards,
        included_shards='all' if args.include_parity else 'data')
    if args.json:
        print(json.dumps(index, indent=2, sort_keys=True))
    else:
        identity = index['identity']
        selected = index['deliveries'][index['preferred']]
        print('identity=%s canonical_bytes=%d'
              % (identity['digest'], identity['bytes']))
        print('delivery=%s bytes=%d pages=%d/%d'
              % (index['preferred'], selected['bytes'],
                 selected['unique_pages'], selected['logical_pages']))
        print('wrote %s'
              % (args.out / name / 'index.json'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
