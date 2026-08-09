"""The compiler core is exported as standalone content-addressed assets."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_compiler_distribution import build
from tests.test_wasmbinary import module


class TestCompilerDistribution(unittest.TestCase):
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
                {'compiler.wasm', 'compiler-resources.tar', 'compiler.json'},
            )
            stored = json.loads((output / 'compiler.json').read_text())
            self.assertEqual(stored, manifest)
            self.assertEqual(stored['normalization']['replaced'], 1)
            for key in ('compiler', 'resources'):
                path = output / stored[key]['file']
                self.assertEqual(stored[key]['bytes'], path.stat().st_size)
                self.assertEqual(
                    stored[key]['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
