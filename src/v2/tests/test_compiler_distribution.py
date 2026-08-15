"""The compiler core is exported as standalone content-addressed assets."""

import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_compiler_distribution import build, resource_index
from kernel.pagefabric import PageFabric, load_bundle
from qm.pagearchive import unpack as unpack_pages
from qm.wasmregions import unpack as unpack_regions
from tests.test_wasmbinary import module


class TestCompilerDistribution(unittest.TestCase):
    def test_resource_index_is_a_prefix_coded_direct_tar_cut(self):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w') as archive:
            for name, contents in (
                    ('include/stdint.h', b'typedef unsigned u32;\n'),
                    ('include/stddef.h', b'typedef unsigned usize;\n')):
                item = tarfile.TarInfo(name)
                item.size = len(contents)
                archive.addfile(item, io.BytesIO(contents))
            alias = tarfile.TarInfo('include/types.h')
            alias.type = tarfile.LNKTYPE
            alias.linkname = './include/stdint.h'
            archive.addfile(alias)
        raw = payload.getvalue()
        index = resource_index(raw)
        self.assertEqual(index['format'], 'tar-cut-v1')
        self.assertEqual(index['mount'], '/usr')
        self.assertEqual(resource_index(raw, mount='/')['mount'], '/')

        previous = ''
        observed = {}
        hardlinks = {}
        for entry in index['entries']:
            shared, suffix, kind = entry[:3]
            name = previous[:shared] + suffix
            if kind == 'f':
                offset, size = entry[3:]
                observed[name] = raw[offset:offset + size]
            elif kind == 'h':
                hardlinks[name] = entry[3]
            else:
                self.fail('unexpected resource entry %r' % (entry,))
            previous = name
        self.assertEqual(observed, {
            'include/stddef.h': b'typedef unsigned usize;\n',
            'include/stdint.h': b'typedef unsigned u32;\n',
        })
        self.assertEqual(hardlinks, {
            'include/types.h': 'include/stdint.h',
        })

    def test_distribution_has_no_runtime_package_layout(self):
        # locals=0; get 0; i64.const 3; add; i64.const 4; add; end
        raw = module(b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / 'llvm.core.wasm'
            resources = root / 'llvm-resources.tar'
            output = root / 'dist'
            core.write_bytes(raw)
            resources.write_bytes(b'resource archive fixture')

            manifest = build(core, resources, output, 'test-version')
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {'compiler.wasm', 'compiler.pages', 'compiler-regions.pages',
                 'compiler-steps.pages',
                 'compiler-resources.tar', 'compiler-resources.pages',
                 'compiler.json'},
            )
            stored = json.loads((output / 'compiler.json').read_text())
            self.assertEqual(stored, manifest)
            self.assertEqual(stored['normalization']['replaced'], 1)
            for key in ('compiler', 'resources'):
                path = output / stored[key]['file']
                self.assertEqual(stored[key]['bytes'], path.stat().st_size)
                self.assertEqual(
                    stored[key]['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                delivery = stored[key]['delivery']
                wire = (output / delivery['file']).read_bytes()
                manifest, store = load_bundle(memoryview(wire))
                opened = PageFabric(manifest, (store,))
                self.assertEqual(
                    opened.read(0, opened.length), path.read_bytes())
                self.assertEqual(delivery['page_bytes'], 1 << 16)
                self.assertEqual(store.materialized_records,
                                 delivery['unique_pages'])

            region_delivery = stored['compiler']['regions']['delivery']
            wire = (output / region_delivery['file']).read_bytes()
            region_manifest, store = load_bundle(memoryview(wire))
            region_bytes = PageFabric(region_manifest, (store,)).read(
                0, region_manifest.length)
            regions = unpack_regions(
                region_bytes, bytes.fromhex(stored['compiler']['sha256']))
            self.assertEqual(regions.layout()['defined_functions'], 1)
            self.assertEqual(region_delivery['page_bytes'], 4096)

            step_entry = stored['compiler']['steps']
            step_delivery = step_entry['delivery']
            wire = (output / step_delivery['file']).read_bytes()
            step_manifest, store = load_bundle(memoryview(wire))
            step_bytes = PageFabric(step_manifest, (store,)).read(
                0, step_manifest.length)
            archive = unpack_pages(step_bytes)
            self.assertEqual(len(archive.entries), 1)
            self.assertEqual(archive.open(
                'state-step', 0, 0, 0).layout()['work'], 1)
            self.assertEqual(step_delivery['page_bytes'], 4096)

    def test_delivery_only_has_no_second_canonical_route(self):
        raw = module(b'\x00\x20\x00\x42\x01\x7c\x0b')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = root / 'llvm.core.wasm'
            resources = root / 'llvm-resources.tar'
            output = root / 'dist'
            core.write_bytes(raw)
            resources.write_bytes(b'fixture')
            build(core, resources, output, 'test-version',
                  include_canonical=False)
            self.assertEqual(
                {path.name for path in output.iterdir()},
                {'compiler.pages', 'compiler-regions.pages',
                 'compiler-steps.pages',
                 'compiler-resources.pages',
                 'compiler.json'})


if __name__ == '__main__':
    unittest.main()
