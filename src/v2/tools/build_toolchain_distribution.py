#!/usr/bin/env python3
"""Publish the native Linux system layer as a demand-paged VFS artifact."""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import write_artifact
from tools.build_compiler_distribution import resource_index


FORMAT = 'linux-x86-64-system-v1'

REQUIRED_VFS_PATHS = frozenset({
    'etc/ssl/certs/ca-certificates.crt',
    'usr/bin/as',
    'usr/bin/bzip2',
    'usr/bin/cc',
    'usr/bin/curl',
    'usr/bin/file',
    'usr/bin/gcc',
    'usr/bin/git',
    'usr/bin/gzip',
    'usr/bin/ld',
    'usr/bin/make',
    'usr/bin/patch',
    'usr/bin/pkg-config',
    'usr/bin/scp',
    'usr/bin/sftp',
    'usr/bin/ssh',
    'usr/bin/tar',
    'usr/bin/xz',
    'usr/include/asm/unistd.h',
    'usr/include/linux/version.h',
    'usr/include/stdio.h',
    'usr/libexec/git-core/git-remote-http',
    'usr/libexec/git-core/git-remote-https',
    'usr/share/misc/magic.mgc',
    'usr/share/qm/sources.env',
})


def update_catalog(output, name, index, version):
    output = Path(output)
    catalog_path = output / 'index.json'
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    else:
        catalog = {'schema': 1, 'artifacts': {}}
    identity = index['identity']
    entry = {
        'bytes': identity['bytes'],
        'format': FORMAT,
        'identity': identity['digest'],
        'path': f'{name}/index.json',
        'version': version,
        'vfs_entries': len(index['vfs']['entries']),
    }
    catalog.setdefault('artifacts', {})[name] = entry
    catalog['artifacts'] = dict(sorted(catalog['artifacts'].items()))
    catalog_path.write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + '\n',
        encoding='utf-8', newline='\n')
    return entry


def build(source, output, version, name='toolchain', replace=False):
    payload = Path(source).read_bytes()
    vfs = resource_index(payload, mount='/', include_mode=True)
    if not vfs['entries']:
        raise ValueError('toolchain input must be a non-empty tar archive')
    paths = set()
    previous = ''
    for entry in vfs['entries']:
        previous = previous[:entry[0]] + entry[1]
        paths.add(previous)
    missing = sorted(REQUIRED_VFS_PATHS - paths)
    if missing:
        raise ValueError(
            'system layer is incomplete: ' + ', '.join('/' + path
                                                        for path in missing))
    vfs.update({
        'availability': 'boot',
        'read_only': True,
        'residency': 'on-demand',
    })
    index = write_artifact(
        payload, output, name, page_bytes=1 << 16,
        data_shards=8, parity_shards=2, replace=replace)
    index.update({
        'format': FORMAT,
        'version': version,
        'vfs': vfs,
    })
    index_path = Path(output) / name / 'index.json'
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True) + '\n',
        encoding='utf-8', newline='\n')
    update_catalog(output, name, index, version)
    return index


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', type=Path,
                        default=ROOT.parents[1] / 'artifact')
    parser.add_argument('--version', required=True)
    parser.add_argument('--name', default='toolchain')
    parser.add_argument('--replace', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    index = build(
        args.source, args.out, args.version,
        name=args.name, replace=args.replace)
    if args.json:
        print(json.dumps(index, indent=2, sort_keys=True))
    else:
        identity = index['identity']
        delivery = index['deliveries'][index['preferred']]
        print('identity=%s canonical_bytes=%d delivery_bytes=%d entries=%d'
              % (identity['digest'], identity['bytes'], delivery['bytes'],
                 len(index['vfs']['entries'])))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
