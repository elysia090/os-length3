"""End-to-end behaviour, including the numbers SPEC quotes.

If the residual-freedom counts here change, either the grammar changed or
something is wrong; both cases need a human, so they are asserted exactly.
"""

import os
import subprocess
import unittest

from qm.clang import NATIVE
from qm import pipeline
from tests.support import read_example as example, solved as solve


class TestSpecNumbers(unittest.TestCase):
    """SPEC §9's residual-freedom table, reproduced from pasted C."""

    CASES = [
        ('ranks8.c', 502, ['LIN_CONST', 'CONV'], 'exclusive rank8'),
        ('inclusive_rank8.c', 1, ['LIN_CONST', 'CONV'], 'inclusive rank8'),
        ('quote_state_before8.c', 502, ['LIN_CONST', 'CONV'], 'quote-state-before'),
        ('select8.c', 1, ['LIN_CONST', 'CONV', 'PERM_DYN'],
         'select / compaction indices'),
        ('ranks16_nibble.c', 26, ['LIN_CONST', 'CONV'],
         'exclusive rank (nibble lanes)'),
    ]

    def test_residual_freedom_and_classes(self):
        for name, freedom, classes, recognized in self.CASES:
            with self.subTest(example=name):
                result = solve(example(name), frontend='cfront')
                self.assertTrue(result['ok'], result.get('error'))
                self.assertEqual(result['residual_freedom'], freedom)
                self.assertEqual(result['program']['classes'], classes)
                self.assertIn(recognized, result['recognition'])

    def test_ranks8_candidate_count(self):
        result = solve(example('ranks8.c'), frontend='cfront')
        self.assertEqual(result['program']['candidates'], 511)

    def test_run_ids_uses_a_point_prefilter(self):
        result = solve(example('run_ids8.c'), frontend='cfront')
        self.assertEqual(result['program']['classes'],
                         ['POINT', 'LIN_CONST', 'CONV'])
        self.assertIn('run IDs', result['recognition'])


class TestDeterminism(unittest.TestCase):
    """Solving the same source twice gives the same answer.

    The suite leans on this everywhere — a fixed-point test compares one solve
    against another, and `tests/support.solved` memoizes on that basis — so it
    is pinned here once, against the uncached entry point, instead of being
    assumed a hundred times.
    """

    SOURCES = ['ranks8.c', 'select8.c', 'run_ids8.c', 'prefix_xor64.c']

    def test_two_runs_agree(self):
        for name in self.SOURCES:
            with self.subTest(example=name):
                first = pipeline.to_json_safe(
                    pipeline.solve(example(name), frontend='cfront'))
                second = pipeline.to_json_safe(
                    pipeline.solve(example(name), frontend='cfront'))
                # Wall-clock is the one field allowed to differ.
                first.pop('elapsed_s'), second.pop('elapsed_s')
                self.assertEqual(first, second)


class TestVerification(unittest.TestCase):
    def test_every_reported_target_verifies_exhaustively(self):
        result = solve(example('ranks8.c'), frontend='cfront')
        for target in result['targets']:
            if not target['ok']:
                continue
            v = target['verification']
            self.assertTrue(v['pass'])
            self.assertTrue(v['exhaustive'])
            self.assertEqual((v['matched'], v['total']), (256, 256))

    def test_sampled_domains_are_never_called_exhaustive(self):
        source = '''#include <stdint.h>
        uint64_t f(uint64_t x) { return x ^ (x >> 7); }'''
        result = solve(source, frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertFalse(result['semantics']['domain']['kind'] == 'exhaustive')
        for target in result['targets']:
            if target['ok']:
                self.assertFalse(target['verification']['exhaustive'])
                self.assertIn('not a proof', target['verification']['claim'])

    def test_lookup_table_is_a_fallback_not_a_minimum(self):
        # A function with no compact form still gets an answer, but the table
        # must never outrank a real program on a kernel that has one.
        result = solve(example('ranks8.c'), frontend='cfront')
        self.assertNotEqual(result['program']['solver'], 'table')


class TestObserverChangesTheAnswer(unittest.TestCase):
    def test_low_bits_observer_collapses_outputs(self):
        result = solve(example('ranks8.c'), observer='low:8', frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        report = result['quotients']['observation']
        self.assertLess(report['distinct_observables'], report['distinct_outputs'])

    def test_exact_observer_keeps_every_bit(self):
        result = solve(example('ranks8.c'), frontend='cfront')
        self.assertTrue(result['quotients']['observation']['is_identity_on_domain'])


class TestErrors(unittest.TestCase):
    def test_bad_source_reports_a_located_diagnostic(self):
        result = solve('uint64_t f(uint8_t m) { return', frontend='cfront')
        self.assertFalse(result['ok'])
        self.assertEqual(result['stage'], 'frontend')
        self.assertIn('line', result['error'])

    def test_multi_argument_kernel_is_explained(self):
        result = solve('#include <stdint.h>\nuint64_t f(uint8_t a, uint8_t b)'
                       '{ return a + b; }', frontend='cfront')
        self.assertFalse(result['ok'])
        self.assertIn('takes 2 arguments', result['error']['message'])
        self.assertIn('takes one', result['error']['message'])


class TestSeveralFunctions(unittest.TestCase):
    """A paste of several functions is normal; one binary one is not a wall."""

    # `combine` is the call-graph root and takes two arguments.  Refusing the
    # paste over it would throw away the unary kernel sitting right beside it.
    SOURCE = ('#include <stdint.h>\n'
              'uint64_t starts8(uint8_t m) { uint64_t x = m;'
              ' return x & ~(x << 1); }\n'
              'uint64_t combine(uint8_t a, uint8_t b)'
              ' { return starts8(a) | starts8(b); }\n')

    def test_the_analysable_function_is_taken_not_the_binary_root(self):
        result = solve(self.SOURCE, frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['function']['name'], 'starts8')

    def test_the_report_says_why_the_others_were_not_taken(self):
        result = solve(self.SOURCE, frontend='cfront')
        others = dict((item['name'], item['reason'])
                      for item in result['frontend']['other_functions'])
        self.assertIn('takes 2 arguments', others['combine'])

    def test_an_explicit_request_still_answers_about_that_function(self):
        # Choosing `combine` by name and being told about `starts8` instead
        # would be answering a question nobody asked.
        result = solve(self.SOURCE, function='combine', frontend='cfront')
        self.assertFalse(result['ok'])
        self.assertIn('combine takes 2 arguments', result['error']['message'])
        self.assertIn('starts8', result['error']['hint'])

    def test_a_paste_with_no_analysable_function_is_still_an_error(self):
        result = solve('#include <stdint.h>\n'
                       'uint64_t f(uint8_t a, uint8_t b) { return a + b; }\n'
                       'uint64_t g(uint8_t a, uint8_t b) { return f(a, b); }\n',
                       frontend='cfront')
        self.assertFalse(result['ok'])
        self.assertIn('takes 2 arguments', result['error']['message'])


@unittest.skipUnless(NATIVE.available(), 'clang is not installed')
class TestClangFrontend(unittest.TestCase):
    """SPEC §2: Clang is the entry point, not a modelled substitute for it."""

    def test_clang_and_builtin_frontend_agree(self):
        for name in ('ranks8.c', 'select8.c', 'run_ids8.c'):
            with self.subTest(example=name):
                source = example(name)
                a = solve(source, frontend='clang')
                b = solve(source, frontend='cfront')
                self.assertTrue(a['ok'], a.get('error'))
                self.assertEqual(a['residual_freedom'], b['residual_freedom'])
                self.assertEqual(a['program']['classes'], b['program']['classes'])

    def test_assembly_and_instruction_count_are_real(self):
        result = solve(example('ranks8.c'), frontend='clang')
        stats = result['frontend']['assembly_stats']
        self.assertTrue(stats['available'])
        self.assertGreater(stats['instructions'], 10)
        self.assertIn('ranks8', result['frontend']['assembly'])

    def test_clang_accepts_c_the_builtin_subset_rejects(self):
        # Pointers are outside the built-in subset but ordinary C for Clang.
        source = '''#include <stdint.h>
        static uint64_t helper(const uint8_t *p, unsigned n)
        { uint64_t r = 0; for (unsigned i = 0; i < n; ++i) r += p[i]; return r; }
        uint64_t f(uint8_t m)
        { uint8_t buf[4] = { m, (uint8_t)(m >> 1), 3, 4 }; return helper(buf, 4); }'''
        clang_result = solve(source, frontend='clang')
        self.assertTrue(clang_result['ok'], clang_result.get('error'))
        self.assertFalse(solve(source, frontend='cfront')['ok'])


@unittest.skipUnless(NATIVE.available(), 'clang is not installed')
class TestEmittedCode(unittest.TestCase):
    """What QM emits has to compile and compute the right thing."""

    def _build_and_run(self, tmpdir, body, harness):
        csrc = os.path.join(tmpdir, 'check.c')
        exe = os.path.join(tmpdir, 'check')
        with open(csrc, 'w') as handle:
            handle.write(body)
            handle.write('\n')
            handle.write(harness)
        build = subprocess.run(
            [NATIVE.binary, '-O2', '-march=x86-64-v3', csrc, '-o', exe],
            capture_output=True, text=True)
        self.assertEqual(build.returncode, 0, build.stderr)
        run = subprocess.run([exe], capture_output=True, text=True)
        return run

    def test_emitted_c_matches_the_kernel(self):
        import tempfile
        result = solve(example('ranks8.c'), frontend='cfront',
                       targets=['x86-64-bmi2-pclmul'])
        target = result['targets'][0]
        harness = '''
#include <stdio.h>
static uint64_t ref(unsigned m) {
    uint64_t r = 0;
    for (unsigned k = 0; k < 8; ++k)
        r |= (uint64_t)__builtin_popcount(m & ((1u << k) - 1)) << (8 * k);
    return r;
}
int main(void) {
    for (unsigned m = 0; m < 256; ++m)
        if (ranks8_qm((uint8_t)m) != ref(m)) { puts("FAIL"); return 1; }
    puts("OK");
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            run = self._build_and_run(tmp, target['c'], harness)
        self.assertEqual(run.stdout.strip(), 'OK', run.stderr)

    def test_emitted_assembly_assembles_and_matches(self):
        import tempfile
        result = solve(example('ranks8.c'), frontend='cfront',
                       targets=['x86-64-bmi2-pclmul'])
        asm = result['targets'][0]['asm']
        self.assertIsNotNone(asm)
        harness = '''
#include <stdio.h>
#include <stdint.h>
uint64_t ranks8_qm(uint64_t);
static uint64_t ref(unsigned m) {
    uint64_t r = 0;
    for (unsigned k = 0; k < 8; ++k)
        r |= (uint64_t)__builtin_popcount(m & ((1u << k) - 1)) << (8 * k);
    return r;
}
int main(void) {
    for (unsigned m = 0; m < 256; ++m)
        if (ranks8_qm(m) != ref(m)) { puts("FAIL"); return 1; }
    puts("OK");
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as tmp:
            asm_path = os.path.join(tmp, 'kernel.s')
            with open(asm_path, 'w') as handle:
                handle.write(asm)
            main_path = os.path.join(tmp, 'main.c')
            with open(main_path, 'w') as handle:
                handle.write(harness)
            exe = os.path.join(tmp, 'check')
            build = subprocess.run(
                [NATIVE.binary, '-O2', '-march=x86-64-v3', main_path, asm_path,
                 '-o', exe], capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            run = subprocess.run([exe], capture_output=True, text=True)
        self.assertEqual(run.stdout.strip(), 'OK', run.stderr)


if __name__ == '__main__':
    unittest.main()
