"""QM against hand-written optima, and against itself.

`examples/lanecode.h` is a header of kernels somebody wrote by hand, already in
their best known form. `examples/*.c` states the same functions the obvious way.
These tests require QM to get from the second to the first — the same physical
representative, the same constants — without being told either.

The second class checks a property that has to hold if the search means
anything: minimizing an already-minimal program returns it unchanged.
"""

import os
import re
import unittest

from qm.pipeline import solve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = os.path.join(ROOT, 'examples')

ONES = '0101010101010101'
IOTA = '0706050403020100'
ALL_ONES = 'FFFFFFFFFFFFFFFF'


def example(name):
    with open(os.path.join(EXAMPLES, name + '.c')) as handle:
        return handle.read()


def minimized(name, **kwargs):
    result = solve(example(name), frontend='cfront', **kwargs)
    assert result['ok'], result.get('error')
    target = next((t for t in result['targets']
                   if t['name'] == result['primary_target']), None)
    return result, target


def constants(target):
    """The 64-bit constants in the emitted C, in order."""
    return re.findall(r'0x([0-9A-F]{16})ull', target['c'])


class TestMatchesHandWritten(unittest.TestCase):
    """Each case names the lanecode.h function QM has to arrive at."""

    CASES = [
        # example                 lanecode              instructions        constants
        ('ranks8', 'lc_ranks8', ['PDEP', 'IMUL'], [ONES, '0101010101010100']),
        ('inclusive_rank8', 'lc_inclusive_ranks8', ['PDEP', 'IMUL'], [ONES, ONES]),
        ('byte_mask8', 'lc_byte_mask8', ['PDEP', 'IMUL'], [ONES, '00000000000000FF']),
        ('ranks16_nibble', 'lc_ranks16_nibble', ['PDEP', 'IMUL'],
         ['1111111111111111', '1111111111111110']),
        ('morton_dilate16', 'lc_morton_dilate32', ['PDEP'], ['0000000055555555']),
        ('morton_compact_even16', 'lc_morton_compact_even', ['PEXT'],
         ['0000000000005555']),
        ('prefix_parity_mask8', 'lc_prefix_parity_mask8', ['PDEP', 'CLMUL'],
         [ONES, ALL_ONES]),
        ('quote_state_before8', 'lc_quote_state_before8', ['PDEP', 'CLMUL'],
         [ONES, 'FFFFFFFFFFFFFF00']),
        ('prefix_xor64', 'lc_prefix_xor64', ['CLMUL'], [ALL_ONES]),
        ('select8', 'lc_select8', ['PDEP', 'IMUL', 'PEXT_DYN'],
         [ONES, '00000000000000FF', IOTA]),
        # ~IOTA, then the complement: lanecode spells it ~PEXT(~IOTA, mask).
        ('shuffle_control8', 'lc_shuffle_control8',
         ['PDEP', 'IMUL', 'PEXT_DYN', 'NOT'],
         [ONES, '00000000000000FF', 'F8F9FAFBFCFDFEFF']),
        ('run_ids8', 'lc_run_ids8', ['SHL', 'ANDNR', 'PDEP', 'IMUL'],
         [ONES, ONES]),
    ]

    def test_reaches_the_hand_written_form(self):
        for name, reference, instructions, wanted in self.CASES:
            with self.subTest(example=name, lanecode=reference):
                _result, target = minimized(name)
                self.assertIsNotNone(target, 'nothing lowered for %s' % name)
                self.assertEqual(target['instructions'], instructions)
                self.assertEqual(constants(target), wanted)
                self.assertTrue(target['verification']['pass'])

    def test_every_case_verifies_exhaustively(self):
        for name, _reference, _instructions, _wanted in self.CASES:
            with self.subTest(example=name):
                _result, target = minimized(name)
                v = target['verification']
                if name == 'prefix_xor64':
                    # A 64-bit input cannot be exhausted; the report says so.
                    self.assertFalse(v['exhaustive'])
                    self.assertIn('not a proof', v['claim'])
                else:
                    self.assertTrue(v['exhaustive'])
                    self.assertEqual(v['matched'], v['total'])

    def test_lanecode_header_is_present_as_the_reference(self):
        path = os.path.join(EXAMPLES, 'lanecode.h')
        self.assertTrue(os.path.exists(path))
        with open(path) as handle:
            text = handle.read()
        for _name, reference, _instructions, _wanted in self.CASES:
            self.assertIn(reference, text)


class TestIdempotence(unittest.TestCase):
    """Minimizing a minimal program returns it unchanged.

    This only means anything because QM can read its own output: the emitted C
    uses `_pdep_u64`, `_pext_u64` and `qm_clmul64`, and the frontend models all
    three. A search that moved on the second pass would be telling us the first
    answer was not a fixed point.
    """

    @staticmethod
    def signature(result, target):
        return (tuple(result['program']['classes']),
                tuple(target['instructions']),
                tuple(constants(target)),
                result['residual_freedom'])

    def test_every_example_is_a_fixed_point(self):
        for name in sorted(os.listdir(EXAMPLES)):
            if not name.endswith('.c'):
                continue
            stem = name[:-2]
            first = solve(example(stem), frontend='cfront')
            self.assertTrue(first['ok'], first.get('error'))
            if not first.get('program'):
                continue          # nothing to be idempotent about

            target = next(t for t in first['targets']
                          if t['name'] == first['primary_target'])
            second = solve(target['c'], frontend='cfront')

            with self.subTest(example=stem):
                self.assertTrue(second['ok'],
                                'QM cannot read its own output: %s'
                                % (second.get('error') or {}).get('text'))
                again = next(t for t in second['targets']
                             if t['name'] == second['primary_target'])
                self.assertEqual(self.signature(first, target),
                                 self.signature(second, again))


class TestUnparseableHelpersAreSkipped(unittest.TestCase):
    """A helper outside the subset must not sink the whole paste."""

    SOURCE = '''#include <stdint.h>
#include <immintrin.h>

static inline uint64_t qm_clmul64(uint64_t a, uint64_t b)
{
    __m128i r = _mm_clmulepi64_si128(_mm_cvtsi64_si128((long long)a),
                                     _mm_cvtsi64_si128((long long)b), 0x00);
    return (uint64_t)_mm_cvtsi128_si64(r);
}

uint64_t parity_mask(uint8_t m)
{
    uint64_t t = _pdep_u64((uint64_t)m, 0x0101010101010101ull);
    return qm_clmul64(t, 0xFFFFFFFFFFFFFFFFull);
}
'''

    def test_the_kernel_still_analyses(self):
        result = solve(self.SOURCE, frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['function']['name'], 'parity_mask')

    def test_the_skip_is_reported_not_silent(self):
        result = solve(self.SOURCE, frontend='cfront')
        skipped = result['frontend']['skipped_definitions']
        self.assertTrue(skipped, 'the unparseable helper was not reported')
        self.assertTrue(any('m128i' in (s['reason'] or '').lower()
                            or s['name'] == 'qm_clmul64' for s in skipped),
                        skipped)


if __name__ == '__main__':
    unittest.main()
