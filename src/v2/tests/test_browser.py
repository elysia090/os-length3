"""The browser boundary.

These tests drive exactly what `web/worker.js` drives — `plan` then `finish` —
and they use the native Clang toolchain to stand in for clang.wasm.  The
compiler and the execution model differ between the two paths; the protocol
does not, so a break here is a break in the browser.
"""

import json
import os
import unittest

from qm.browser import capabilities, fallback, finish, plan
from qm.clang import NATIVE, read_signature

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'web', 'qm-manifest.json')

SOURCE = '''#include <stdint.h>
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;
    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(m & ((1u << i) - 1)) << (8 * i);
    return r;
}
'''


class TestCapabilities(unittest.TestCase):
    def test_capabilities_are_json_and_complete(self):
        caps = json.loads(capabilities())
        names = [f['name'] for f in caps['frontends']]
        self.assertIn('clang', names)
        self.assertIn('cfront', names)
        self.assertIn('precompiled', names)
        self.assertTrue(caps['targets'])
        self.assertTrue(any(o['spec'] == 'exact' for o in caps['observers']))


class TestPlan(unittest.TestCase):
    def test_plan_returns_the_domain_the_worker_must_evaluate(self):
        result = json.loads(plan(SOURCE, '{}'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['function'], 'ranks8')
        self.assertEqual(result['input_bits'], 8)
        self.assertEqual(result['output_bits'], 64)
        self.assertEqual(len(result['values']), 256)

    def test_plan_reports_errors_as_data_not_exceptions(self):
        result = json.loads(plan('not C at all', '{}'))
        self.assertFalse(result['ok'])
        self.assertIn('text', result['error'])


class TestFinish(unittest.TestCase):
    def _table(self, values):
        """Stand in for the wasm oracle with a Python evaluation."""
        def ref(m):
            return sum(bin(m & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))
        return [str(ref(v)) for v in values]

    def test_finish_accepts_decimal_strings(self):
        # A JSON number cannot carry 64 bits, so the worker sends strings.
        planned = json.loads(plan(SOURCE, '{}'))
        options = json.dumps({'function': 'ranks8', 'input_bits': 8,
                              'output_bits': 64})
        result = json.loads(finish(SOURCE, options,
                                   self._table(planned['values']), ''))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)

    def test_finish_rejects_a_table_of_the_wrong_length(self):
        options = json.dumps({'function': 'ranks8', 'input_bits': 8,
                              'output_bits': 64})
        result = json.loads(finish(SOURCE, options, ['0', '1'], ''))
        self.assertFalse(result['ok'])

    def test_fallback_runs_without_a_compiler(self):
        result = json.loads(fallback(SOURCE, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)


@unittest.skipUnless(NATIVE.available(), 'clang is not installed')
class TestWorkerProtocolWithRealClang(unittest.TestCase):
    def test_plan_then_compile_then_finish(self):
        planned = json.loads(plan(SOURCE, '{}'))
        signature = read_signature(SOURCE)
        table = NATIVE.evaluate(SOURCE, signature, planned['values'])
        assembly = NATIVE.assembly(SOURCE)

        options = json.dumps({
            'function': planned['function'],
            'input_bits': planned['input_bits'],
            'output_bits': planned['output_bits'],
        })
        result = json.loads(finish(SOURCE, options,
                                   [str(v) for v in table], assembly))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)
        self.assertTrue(result['frontend']['assembly_stats']['available'])
        primary = next(t for t in result['targets']
                       if t['name'] == result['primary_target'])
        self.assertEqual(primary['instructions'], ['PDEP', 'IMUL'])
        self.assertTrue(primary['verification']['pass'])

    def test_wasm32_target_compiles_and_exports_the_kernel(self):
        # The browser's oracle is this compile plus WebAssembly.instantiate.
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            from qm.clang import prepare_source
            csrc = os.path.join(tmp, 'k.c')
            out = os.path.join(tmp, 'k.wasm')
            with open(csrc, 'w') as handle:
                handle.write(prepare_source(SOURCE))
            build = subprocess.run(
                [NATIVE.binary, '--target=wasm32', '-O2', '-ffreestanding',
                 '-nostdlib', '-Wl,--no-entry', '-Wl,--export-all',
                 csrc, '-o', out],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            with open(out, 'rb') as handle:
                blob = handle.read()
        self.assertEqual(blob[:4], b'\x00asm')
        self.assertIn(b'ranks8', blob)


class TestManifest(unittest.TestCase):
    def test_manifest_matches_the_package_on_disk(self):
        import sys
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import gen_manifest

        with open(MANIFEST) as handle:
            stored = json.load(handle)
        self.assertEqual(stored, gen_manifest.build(),
                         'web/qm-manifest.json is stale; run '
                         'python3 tools/gen_manifest.py')

    def test_every_listed_file_exists(self):
        with open(MANIFEST) as handle:
            stored = json.load(handle)
        for rel in stored['files']:
            self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), rel)


if __name__ == '__main__':
    unittest.main()
