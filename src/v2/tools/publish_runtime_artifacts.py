#!/usr/bin/env python3
"""Publish VM and compiler page bundles below the repository artifact tree."""

import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
DEFAULT_ARTIFACT_ROOT = REPOSITORY / 'artifact'
DEFAULT_COMPILER_VERSION = '22.0.0-git20542-10'
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.pagefabric import load_bundle


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def publish_component(entry, manifest_root, artifact_root, component):
    entry = deepcopy(entry)
    delivery = deepcopy(entry['delivery'])
    source = manifest_root / delivery['file']
    wire = source.read_bytes()
    if len(wire) != delivery['bytes'] or digest(wire) != delivery['sha256']:
        raise ValueError('%s delivery bytes do not match the manifest'
                         % component)
    prefix_bytes = int(delivery['prefix_bytes'])
    if digest(wire[:prefix_bytes]) != delivery['prefix_sha256']:
        raise ValueError('%s delivery prefix does not match the manifest'
                         % component)
    physical, _store = load_bundle(memoryview(wire))
    if (physical.object_digest.hex() != entry['sha256']
            or physical.length != int(entry['bytes'])):
        raise ValueError('%s delivery names another canonical object'
                         % component)

    component_root = artifact_root / component
    relative = Path('delivery') / (delivery['sha256'] + '.pages')
    output = component_root / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and digest(output.read_bytes()) != delivery['sha256']:
        raise ValueError('%s artifact path contains other bytes' % component)
    if not output.exists():
        shutil.copyfile(source, output)

    object_index = {
        'schema': 1,
        'identity': {
            'algorithm': 'sha256',
            'digest': entry['sha256'],
            'bytes': entry['bytes'],
        },
        'preferred': delivery['sha256'],
        'deliveries': {
            delivery['sha256']: {
                **delivery,
                'format': 'page-fabric-v1',
                'file': relative.as_posix(),
            },
        },
    }
    (component_root / 'index.json').write_text(
        json.dumps(object_index, indent=2, sort_keys=True) + '\n',
        encoding='utf-8', newline='\n')
    delivery['file'] = (Path(component) / relative).as_posix()
    entry['delivery'] = delivery
    return entry


def publish_vm(source, artifact_root):
    source = Path(source)
    manifest = json.loads(source.read_text(encoding='utf-8'))
    vm = deepcopy(manifest['vm'])
    vm['delivery'] = publish_component(
        vm, source.parent, artifact_root / 'vm', 'module')['delivery']
    vm['regions'] = publish_component(
        vm['regions'], source.parent, artifact_root / 'vm', 'regions')
    vm['steps'] = publish_component(
        vm['steps'], source.parent, artifact_root / 'vm', 'steps')
    category = deepcopy(manifest)
    category['vm'] = vm
    path = artifact_root / 'vm' / 'index.json'
    path.write_text(json.dumps(category, indent=2, sort_keys=True) + '\n',
                    encoding='utf-8', newline='\n')
    return vm


def publish_compiler(source, artifact_root,
                     version=DEFAULT_COMPILER_VERSION):
    source = Path(source)
    manifest = json.loads(source.read_text(encoding='utf-8'))
    compiler = deepcopy(manifest['compiler'])
    compiler['delivery'] = publish_component(
        compiler, source.parent, artifact_root / 'compiler',
        'module')['delivery']
    compiler['regions'] = publish_component(
        compiler['regions'], source.parent, artifact_root / 'compiler',
        'regions')
    compiler['steps'] = publish_component(
        compiler['steps'], source.parent, artifact_root / 'compiler',
        'steps')
    resources = publish_component(
        manifest['resources'], source.parent, artifact_root / 'compiler',
        'resources')
    category = deepcopy(manifest)
    category['version'] = version
    category['compiler'] = compiler
    category['resources'] = resources
    path = artifact_root / 'compiler' / 'index.json'
    path.write_text(json.dumps(category, indent=2, sort_keys=True) + '\n',
                    encoding='utf-8', newline='\n')
    return compiler


def update_catalog(artifact_root, vm, compiler):
    path = artifact_root / 'index.json'
    catalog = json.loads(path.read_text(encoding='utf-8')) \
        if path.exists() else {'schema': 1, 'artifacts': {}}
    if catalog.get('schema') != 1 \
            or not isinstance(catalog.get('artifacts'), dict):
        raise ValueError('artifact root catalog is invalid')
    catalog['artifacts'].update({
        'vm': {
            'format': 'webassembly-runtime-v1',
            'identity': vm['sha256'],
            'bytes': vm['bytes'],
            'path': 'vm/module/index.json',
            'components': 'vm/index.json',
        },
        'compiler': {
            'format': 'webassembly-compiler-v1',
            'identity': compiler['sha256'],
            'bytes': compiler['bytes'],
            'path': 'compiler/module/index.json',
            'components': 'compiler/index.json',
        },
    })
    catalog['artifacts'] = dict(sorted(catalog['artifacts'].items()))
    path.write_text(json.dumps(catalog, indent=2, sort_keys=True) + '\n',
                    encoding='utf-8', newline='\n')
    return catalog


def publish(vm_manifest, compiler_manifest, artifact_root,
            compiler_version=DEFAULT_COMPILER_VERSION):
    artifact_root = Path(artifact_root)
    artifact_root.mkdir(parents=True, exist_ok=True)
    vm = publish_vm(vm_manifest, artifact_root)
    compiler = publish_compiler(
        compiler_manifest, artifact_root, compiler_version)
    return update_catalog(artifact_root, vm, compiler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vm', type=Path,
                        default=DEFAULT_ARTIFACT_ROOT / 'vm' / 'index.json')
    parser.add_argument('--compiler', type=Path,
                        default=DEFAULT_ARTIFACT_ROOT / 'compiler'
                        / 'index.json')
    parser.add_argument('--out', type=Path, default=DEFAULT_ARTIFACT_ROOT)
    parser.add_argument('--compiler-version', default=DEFAULT_COMPILER_VERSION)
    args = parser.parse_args(argv)
    catalog = publish(
        args.vm, args.compiler, args.out, args.compiler_version)
    for name in ('vm', 'compiler'):
        entry = catalog['artifacts'][name]
        print('%s identity=%s bytes=%d'
              % (name, entry['identity'], entry['bytes']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
