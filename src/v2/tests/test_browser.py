"""The browser boundary.

These tests drive exactly what `web/worker.js` drives — `plan` then `finish` —
and they use the native Clang toolchain to stand in for clang.wasm.  The
compiler and the execution model differ between the two paths; the protocol
does not, so a break here is a break in the browser.
"""

import json
import os
import re
import subprocess
import tempfile
import unittest

from qm.browser import capabilities, fallback, finish, plan, prepare
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


class TestPreparedSource(unittest.TestCase):
    """What Clang is handed, and who decides it.

    The worker used to pass its raw text straight to clang.wasm, so the
    freestanding prelude and the intrinsic definitions in `clang.py` applied on
    the native path and nowhere else. `#include <immintrin.h>` reached a wasm32
    compile — where it declares nothing — and QM's own emitted `_pdep_u64` came
    back as an undeclared function. The Python was right the whole time; the
    wiring was not, which is why this checks both.
    """

    EMITTED = '''#include <stdint.h>
#include <immintrin.h>

uint64_t ranks8_qm(uint8_t x)
{
    uint64_t t1 = _pdep_u64((uint64_t)x, 0x0101010101010101ull);
    uint64_t t2 = t1 * 0x0101010101010100ull;
    return (uint64_t)t2;
}
'''

    def test_includes_go_and_the_intrinsic_arrives(self):
        prepared = prepare(self.EMITTED)
        self.assertNotIn('#include', prepared)
        self.assertIn('uint64_t;', prepared)          # the freestanding prelude
        self.assertIn('_pdep_u64(unsigned long long', prepared)
        self.assertNotIn('_pext_u64(unsigned', prepared)   # only what is used

    def test_a_paste_that_brings_its_own_keeps_it(self):
        own = ('unsigned long long _pdep_u64(unsigned long long v,'
               ' unsigned long long m) { return v & m; }\n'
               'unsigned long long f(unsigned char x)'
               ' { return _pdep_u64(x, 3ull); }\n')
        self.assertEqual(prepare(own).count('_pdep_u64(unsigned long long v'), 1)

    @unittest.skipUnless(NATIVE.available(), 'no native Clang')
    def test_it_compiles_where_the_browser_compiles(self):
        prepared = prepare(self.EMITTED)
        for machine in ('wasm32', 'x86_64-unknown-linux-gnu'):
            with self.subTest(target=machine):
                with tempfile.TemporaryDirectory() as tmp:
                    src = os.path.join(tmp, 'in.c')
                    with open(src, 'w') as handle:
                        handle.write(prepared)
                    built = subprocess.run(
                        [NATIVE.binary, '--target=%s' % machine, '-std=gnu11',
                         '-ffreestanding', '-O2', '-nostdlib', '-c', src,
                         '-o', os.path.join(tmp, 'out.o')],
                        capture_output=True, text=True)
                    self.assertEqual(built.returncode, 0, built.stderr)

    def test_the_worker_compiles_the_prepared_text(self):
        """The bug was here, not in Python: the worker never called it."""
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            worker = handle.read()
        self.assertIn("callPython('prepare'", worker)
        for call in re.findall(r'clang\.(?:assembly|wasm)\(\s*(\w+)', worker):
            self.assertEqual(call, 'prepared',
                             'clang is being handed %r rather than the '
                             'prepared source' % call)


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


class TestExamplesJson(unittest.TestCase):
    """The page's copy of the examples is generated, so it can go stale.

    An example that differs between `examples/` and the page would mean the
    tests measure one text and the user runs another.
    """

    PATH = os.path.join(ROOT, 'web', 'examples.json')

    def test_examples_json_matches_the_directory(self):
        import sys
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import gen_examples

        with open(self.PATH) as handle:
            stored = json.load(handle)
        self.assertEqual(stored, gen_examples.build(),
                         'web/examples.json is stale; run '
                         'python3 tools/gen_examples.py')

    def test_the_listing_examples_are_present(self):
        with open(self.PATH) as handle:
            stored = json.load(handle)
        languages = set(e['language'] for e in stored['examples'])
        self.assertEqual(languages, {'c', 'asm'})



class TestAssemblyListings(unittest.TestCase):
    """The listing's ISA is detected, never assumed.

    Which one a Clang bundle can emit depends on the targets it was built with:
    the bundled browser toolchain is WebAssembly-only, the native one here is
    x86-64. A count must never be labelled with the wrong architecture.
    """

    WASM_LISTING = '''\t.file\t"in.c"
\t.functype\tranks8 (i32) -> (i64)
\t.section\t.text.ranks8,"",@
\t.globl\tranks8
ranks8:
\t.functype\tranks8 (i32) -> (i64)
\tlocal.get\t0
\ti32.const\t127
\ti32.and
\ti32.popcnt
\ti64.extend_i32_u
\ti64.const\t56
\ti64.shl
\tend_function
'''

    X86_LISTING = '''\t.text
\t.globl\tranks8
ranks8:
\tmovl\t%edi, %ecx
\tandl\t$1, %ecx
\tshll\t$8, %ecx
\timulq\t%rax, %rdx
\tretq
'''

    def test_wasm_listing_is_named_wasm(self):
        from qm.asmstats import analyze
        stats = analyze(self.WASM_LISTING, 'ranks8')
        self.assertTrue(stats['available'])
        self.assertEqual(stats['isa'], 'wasm32')
        self.assertEqual(stats['instructions'], 8)
        self.assertIn('wasm32', stats['note'])

    def test_x86_listing_is_named_x86(self):
        from qm.asmstats import analyze
        stats = analyze(self.X86_LISTING, 'ranks8')
        self.assertEqual(stats['isa'], 'x86-64')
        self.assertEqual(stats['instructions'], 5)

    def test_declared_isa_wins_over_detection(self):
        from qm.asmstats import analyze
        stats = analyze(self.WASM_LISTING, 'ranks8', isa='wasm32-declared')
        self.assertEqual(stats['isa'], 'wasm32-declared')

    def test_finish_labels_the_baseline_with_the_listing_isa(self):
        planned = json.loads(plan(SOURCE, '{}'))

        def ref(m):
            return sum(bin(m & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))

        options = json.dumps({
            'function': 'ranks8', 'input_bits': 8, 'output_bits': 64,
            'compile': {'opt': '-O2', 'listing_isa': 'wasm32'},
        })
        result = json.loads(finish(
            SOURCE, options,
            [str(ref(v)) for v in planned['values']], self.WASM_LISTING))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['assembly_stats']['isa'], 'wasm32')
        self.assertIn('wasm32', result['frontend']['reference_ops']['metric'])
        # QM still lowers to x86-64: the compiler's target is not QM's target.
        self.assertIn('x86-64-bmi2-pclmul',
                      [t['name'] for t in result['targets']])

if __name__ == '__main__':
    unittest.main()
