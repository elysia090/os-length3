#!/usr/bin/env python3
"""Build a disposable directly mapped x86 Linux boot cache from a bzImage."""

import argparse
import json
from pathlib import Path
import sys
from time import perf_counter


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86 import load_bzimage_kernel
from kernel.x86snapshot import dump_x86_boot_cache, load_x86_boot_cache
from kernel.pagefabric import write_artifact


def update_catalog(artifact_root, name, artifact, memory_bytes, initrd_bytes):
    """Publish the selected boot object through the root artifact catalog."""
    artifact_root = Path(artifact_root)
    path = artifact_root / 'index.json'
    catalog = (json.loads(path.read_text(encoding='utf-8'))
               if path.exists() else {'schema': 1, 'artifacts': {}})
    if (catalog.get('schema') != 1
            or not isinstance(catalog.get('artifacts'), dict)):
        raise ValueError('artifact root catalog is invalid')
    identity = artifact['identity']
    catalog['artifacts'][str(name)] = {
        'bytes': int(identity['bytes']),
        'format': 'x86-boot-cache-v1',
        'identity': identity['digest'],
        'initrd_bytes': int(initrd_bytes),
        'memory_bytes': int(memory_bytes),
        'path': '%s/index.json' % name,
    }
    catalog['artifacts'] = dict(sorted(catalog['artifacts'].items()))
    path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + '\n',
                    encoding='utf-8', newline='\n')
    return catalog['artifacts'][str(name)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bzimage', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--memory-mib', type=int, default=128)
    parser.add_argument('--command-line')
    parser.add_argument('--initrd', type=Path)
    parser.add_argument('--shards', choices=('data', 'all'), default='data',
                        help='ship primary data only, or data plus parity')
    parser.add_argument('--artifact-root', type=Path,
                        help='also publish a chunked identity-addressed copy')
    parser.add_argument('--artifact-name', default='linux-x86-64')
    parser.add_argument('--delivery-page-bytes', type=int, default=1 << 16)
    parser.add_argument('--replace-artifact', action='store_true',
                        help='publish new canonical bytes at an existing name')
    arguments = parser.parse_args(argv)

    image = arguments.bzimage.read_bytes()
    initrd = (None if arguments.initrd is None
              else arguments.initrd.read_bytes())
    started = perf_counter()
    boot = load_bzimage_kernel(
        image, memory_bytes=arguments.memory_mib << 20,
        command_line=arguments.command_line, initrd=initrd)
    expanded_seconds = perf_counter() - started
    started = perf_counter()
    payload = dump_x86_boot_cache(boot, shards=arguments.shards)
    encoded_seconds = perf_counter() - started
    arguments.output.write_bytes(payload)
    started = perf_counter()
    restored = load_x86_boot_cache(payload)
    restored_seconds = perf_counter() - started
    restored_cpu = restored.state.__class__(**{
        field: getattr(restored.state, field)
        for field in restored.state.__dataclass_fields__
        if field != 'memory'
    }, memory=boot.state.memory)
    if restored_cpu != boot.state:
        raise RuntimeError('x86 boot cache changed the prepared CPU state')
    print('bzimage_bytes=%d' % len(image))
    print('initrd_bytes=%d' % (0 if initrd is None else len(initrd)))
    print('cache_bytes=%d' % len(payload))
    print('resident_pages=%d' % len(boot.state.memory.pages))
    print('expand_seconds=%.6f' % expanded_seconds)
    print('encode_seconds=%.6f' % encoded_seconds)
    print('restore_seconds=%.6f' % restored_seconds)
    print('restored_spans=%d' %
          restored.state.memory._backing.layout()['resident_spans'])
    if arguments.artifact_root is not None:
        artifact = write_artifact(
            payload, arguments.artifact_root, arguments.artifact_name,
            page_bytes=arguments.delivery_page_bytes,
            included_shards=arguments.shards,
            replace=arguments.replace_artifact)
        update_catalog(
            arguments.artifact_root, arguments.artifact_name, artifact,
            len(boot.state.memory), 0 if initrd is None else len(initrd))
        print('artifact_identity=%s' % artifact['identity']['digest'])
        print('artifact_delivery=%s' % artifact['preferred'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
