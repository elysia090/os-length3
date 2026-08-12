"""Identity-addressed artifacts with replaceable page delivery."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

from kernel.pagefabric import PageFabric, open_artifact, write_artifact
from tools.build_x86_boot_cache import update_catalog


ROOT = Path(__file__).resolve().parents[1]


class TestArtifactDelivery(unittest.TestCase):
    def test_x86_publication_updates_the_root_catalog(self):
        artifact = {
            'identity': {
                'algorithm': 'sha256', 'digest': '12' * 32, 'bytes': 4096,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            entry = update_catalog(
                directory, 'linux-test', artifact, 128 << 20, 8192)
            catalog = json.loads(
                (Path(directory) / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(entry, catalog['artifacts']['linux-test'])
        self.assertEqual(entry, {
            'bytes': 4096,
            'format': 'x86-boot-cache-v1',
            'identity': '12' * 32,
            'initrd_bytes': 8192,
            'memory_bytes': 128 << 20,
            'path': 'linux-test/index.json',
        })

    def test_identity_does_not_contain_delivery_granularity(self):
        payload = (bytes(range(251)) * 7) + b'canonical tail'
        digest = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'
            first = write_artifact(
                payload, root, 'fixture', page_bytes=64,
                data_shards=2, parity_shards=1)
            first_delivery = first['preferred']
            second = write_artifact(
                payload, root, 'fixture', page_bytes=128,
                data_shards=3, parity_shards=2)

            self.assertEqual(second['identity'], {
                'algorithm': 'sha256',
                'digest': digest,
                'bytes': len(payload),
            })
            self.assertNotEqual(first_delivery, second['preferred'])
            self.assertEqual(len(second['deliveries']), 2)

            object_root = root / 'fixture'
            self.assertEqual(
                {path.name for path in object_root.iterdir()},
                {'delivery', 'index.json'})
            self.assertFalse(any(
                path.name in ('object', 'canonical', digest)
                for path in object_root.rglob('*') if path.is_file()))

            stored = json.loads(
                (object_root / 'index.json').read_text(encoding='utf-8'))
            for delivery_digest in stored['deliveries']:
                manifest, store = open_artifact(
                    stored, root, 'fixture', delivery_digest)
                opened = PageFabric(manifest, (store,))
                self.assertEqual(opened.read(0, opened.length), payload)

    def test_replacing_a_named_artifact_starts_a_fresh_identity_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'
            first = write_artifact(b'first', root, 'role', page_bytes=64)
            with self.assertRaises(ValueError):
                write_artifact(b'second', root, 'role', page_bytes=64)
            second = write_artifact(
                b'second', root, 'role', page_bytes=64, replace=True)
        self.assertNotEqual(first['identity'], second['identity'])
        self.assertEqual(len(second['deliveries']), 1)

    def test_a_tampered_projection_cannot_claim_the_identity(self):
        payload = b'page identity' * 100
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'
            index = write_artifact(
                payload, root, 'fixture', page_bytes=128)
            descriptor = index['deliveries'][index['preferred']]
            path = root / 'fixture' / descriptor['file']
            wire = bytearray(path.read_bytes())
            wire[-1] ^= 1
            path.write_bytes(wire)
            with self.assertRaisesRegex(ValueError,
                                        'delivery bytes are invalid'):
                open_artifact(index, root, 'fixture')

    def test_an_index_cannot_redirect_a_delivery_outside_its_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'
            index = write_artifact(
                b'bounded path', root, 'fixture', page_bytes=64)
            index['deliveries'][index['preferred']]['file'] = '../../other'
            with self.assertRaisesRegex(ValueError,
                                        'delivery path is invalid'):
                open_artifact(index, root, 'fixture')

    def test_the_site_build_keeps_the_repository_artifact_mount(self):
        import sys
        tools = Path(__file__).resolve().parents[1] / 'tools'
        sys.path.insert(0, str(tools))
        import build_site

        catalog = Path(build_site.ARTIFACT_ROOT) / 'index.json'
        if not catalog.exists():
            self.skipTest('repository has no prebuilt artifact catalog')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(build_site.build(Path(directory) / 'dist'))
            stored = json.loads(catalog.read_text(encoding='utf-8'))
            copied = output / 'artifact' / 'linux-x86-64'
            self.assertTrue((output / 'artifact' / 'index.json').is_file())
            self.assertTrue((copied / 'index.json').is_file())
            self.assertEqual(
                len(list((copied / 'delivery').glob('*.pages'))), 1)

    def test_local_server_preserves_direct_artifact_ranges(self):
        import sys
        tools = Path(__file__).resolve().parents[1] / 'tools'
        sys.path.insert(0, str(tools))
        import build_site
        import serve

        catalog_path = Path(build_site.ARTIFACT_ROOT) / 'index.json'
        if not catalog_path.exists():
            self.skipTest('repository has no prebuilt artifact catalog')
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
        entry = catalog['artifacts']['linux-x86-64']
        object_index = json.loads(
            (catalog_path.parent / entry['path']).read_text(encoding='utf-8'))
        delivery = object_index['deliveries'][object_index['preferred']]
        relative = ('/artifact/linux-x86-64/' + delivery['file'])
        source = catalog_path.parent / 'linux-x86-64' / delivery['file']

        server = serve.http.server.ThreadingHTTPServer(
            ('127.0.0.1', 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                'http://127.0.0.1:%d%s' % (server.server_port, relative),
                headers={'Range': 'bytes=0-171'})
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'],
                                 'bytes 0-171/%d' % source.stat().st_size)
                self.assertEqual(response.read(), source.read_bytes()[:172])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_repository_catalog_uses_a_readable_locator(self):
        repository = ROOT.parents[1]
        catalog_path = repository / 'artifact' / 'index.json'
        if not catalog_path.exists():
            self.skipTest('repository has no prebuilt artifact catalog')
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
        entry = catalog['artifacts']['linux-x86-64']
        self.assertEqual(entry['path'], 'linux-x86-64/index.json')
        self.assertNotEqual(entry['path'].split('/')[0], entry['identity'])
        index_path = catalog_path.parent / entry['path']
        index = json.loads(index_path.read_text(encoding='utf-8'))
        self.assertEqual(index['identity']['digest'], entry['identity'])
        self.assertEqual(index['identity']['bytes'], entry['bytes'])
        delivery = index['deliveries'][index['preferred']]
        self.assertTrue((index_path.parent / delivery['file']).is_file())
        self.assertFalse(any(
            child.is_dir() and len(child.name) == 64
            for child in catalog_path.parent.iterdir()))
        self.assertEqual(
            {'compiler', 'linux-x86-64', 'linux-x86-64-machine', 'vm'},
            set(catalog['artifacts']))

    def test_published_vm_is_the_shipped_x86_runtime(self):
        repository = ROOT.parents[1]
        artifact_root = repository / 'artifact'
        catalog = json.loads(
            (artifact_root / 'index.json').read_text(encoding='utf-8'))
        entry = catalog['artifacts']['vm']
        index = json.loads(
            (artifact_root / entry['path']).read_text(encoding='utf-8'))
        manifest, store = open_artifact(
            index, artifact_root / 'vm', 'module')
        opened = PageFabric(manifest, (store,))
        self.assertEqual(
            opened.read(0, opened.length),
            (ROOT / 'web' / 'vm.wasm').read_bytes())
        category = json.loads(
            (artifact_root / 'vm' / 'index.json').read_text(encoding='utf-8'))
        self.assertIn('vm_x86_open', category['vm']['exports'])

    def test_browser_resolves_the_locator_and_verifies_canonical_bytes(self):
        node = os.environ.get('NODE_BINARY') or shutil.which('node')
        if not node:
            self.skipTest('node is required')
        payload = (b'direct artifact page\0' * 37) + bytes(range(64))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'artifact'
            index = write_artifact(
                payload, root, 'fixture', page_bytes=128,
                data_shards=2, parity_shards=1)
            (root / 'index.json').write_text(json.dumps({
                'schema': 1,
                'artifacts': {
                    'fixture': {
                        'identity': index['identity']['digest'],
                        'path': 'fixture/index.json',
                    },
                },
            }), encoding='utf-8')
            driver = Path(directory) / 'read-artifact.mjs'
            driver.write_text('''\
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
globalThis.fetch = async (url, options = {}) => {
  const raw = new Uint8Array(readFileSync(fileURLToPath(url)));
  const requested = options.headers?.Range;
  if (!requested) return new Response(raw, { status: 200 });
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(requested);
  if (!match) return new Response(null, { status: 416 });
  const start = Number(match[1]);
  const end = Number(match[2]) + 1;
  return new Response(raw.slice(start, end), { status: 206 });
};
const { readArtifact } = await import(process.argv[2]);
const opened = await readArtifact('fixture', { root: process.argv[3] });
process.stdout.write(Buffer.from(opened.bytes).toString('hex'));
''', encoding='utf-8')
            result = subprocess.run([
                node, driver,
                (ROOT / 'web' / 'artifact.js').as_uri(),
                root.as_uri() + '/',
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, payload.hex())


if __name__ == '__main__':
    unittest.main()
