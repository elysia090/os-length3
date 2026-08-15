"""The native compiler is a page-delivered root VFS projection."""

import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))

from build_toolchain_distribution import REQUIRED_VFS_PATHS, build
from kernel.pagefabric import PageFabric, open_artifact


class TestToolchainDistribution(unittest.TestCase):
    def test_distribution_keeps_identity_separate_from_vfs_delivery(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            contents = b'system fixture\n'
            for path in sorted(REQUIRED_VFS_PATHS):
                member = tarfile.TarInfo('./' + path)
                member.mode = (0o755 if path.startswith(
                    ('usr/bin/', 'usr/libexec/')) else 0o644)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
        payload = buffer.getvalue()

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'artifact'
            source = Path(directory) / 'toolchain.tar'
            source.write_bytes(payload)
            index = build(source, output, '2026.08.13')
            stored = json.loads(
                (output / 'toolchain' / 'index.json').read_text())
            catalog = json.loads((output / 'index.json').read_text())
            manifest, page_store = open_artifact(
                stored, output, 'toolchain')

        self.assertEqual(stored, index)
        self.assertEqual(index['format'], 'linux-x86-64-system-v1')
        self.assertEqual(index['vfs']['mount'], '/')
        self.assertEqual(index['vfs']['format'], 'tar-cut-v2')
        self.assertEqual(index['vfs']['availability'], 'boot')
        self.assertTrue(index['vfs']['read_only'])
        self.assertEqual(index['vfs']['residency'], 'on-demand')
        entries = {}
        previous = ''
        for entry in index['vfs']['entries']:
            previous = previous[:entry[0]] + entry[1]
            entries[previous] = entry
        self.assertEqual(entries['usr/bin/gcc'][2], 'f')
        self.assertEqual(entries['usr/bin/gcc'][-1], 0o755)
        self.assertEqual(
            PageFabric(manifest, (page_store,)).read(0, manifest.length),
            payload)
        self.assertEqual(catalog['artifacts']['toolchain']['version'],
                         '2026.08.13')

    def test_incomplete_system_layer_is_rejected(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            member = tarfile.TarInfo('./usr/bin/gcc')
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'incomplete.tar'
            source.write_bytes(buffer.getvalue())
            with self.assertRaisesRegex(ValueError, '/usr/bin/git'):
                build(source, Path(directory) / 'artifact', 'test')


if __name__ == '__main__':
    unittest.main()
