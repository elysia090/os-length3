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
import subprocess
import tempfile
import unittest

from qm.clang import NATIVE, prepare_source
from tests.support import (example, example_names, example_path,
                           solved as solve, target)

ONES = '0101010101010101'
IOTA = '0706050403020100'
ALL_ONES = 'FFFFFFFFFFFFFFFF'
HIGH = '8080808080808080'
LOW7 = '7F7F7F7F7F7F7F7F'
BYTE = '00000000000000FF'


def minimized(name, **kwargs):
    result = solve(example(name), frontend='cfront', **kwargs)
    assert result['ok'], result.get('error')
    return result, target(result)


def constants(target):
    """The 64-bit constants in the emitted C, in order."""
    return re.findall(r'0x([0-9A-F]{16})ull', target['c'])


class TestMatchesHandWritten(unittest.TestCase):
    """Each case names the lanecode.h function QM has to arrive at."""

    CASES = [
        # example                 lanecode              instructions        constants
        ('ranks8', 'lc_ranks8', ['PDEP', 'IMUL'], [ONES, '0101010101010100']),
        ('inclusive_rank8', 'lc_inclusive_ranks8', ['PDEP', 'IMUL'], [ONES, ONES]),
        ('byte_mask8', 'lc_byte_mask8', ['PDEP', 'IMUL'], [ONES, BYTE]),
        # No deposit: the run-start mask is already in the bits the output
        # wants, so the family's LIN_CONST stage is the identity and goes.
        ('starts8', 'lc_starts', ['SHL', 'ANDNR'], []),
        ('ends8', 'lc_ends', ['SHR', 'ANDNR'], []),
        # MOVEMASK's integer half: gathering one flag per lane is a linear map,
        # and on BMI2 a linear map that gathers is one PEXT.
        ('mask_from_spread', 'lc_mask_from_spread', ['PEXT'], [HIGH]),
        # lanecode writes this `(s >> 7) * 0xFF`, which is exact only because
        # its caller guarantees the low seven bits of each lane are clear. QM
        # is given no such guarantee, so it keeps the mask and is exact on
        # every input — one instruction more, and a different claim.
        ('byte_mask_from_spread', 'lc_byte_mask_from_spread',
         ['AND', 'SHR', 'IMUL'], [HIGH, BYTE]),
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
        # Comparison.  lanecode.h has carried these three forms since before
        # anything could derive them; what QM is given is a loop with a `==`,
        # a `<` or a pair of bounds in it, and what it has to arrive at is the
        # branch-free lane arithmetic — including which of the three.
        ('zero_spread8', 'lc_zero_spread', ['AND', 'ADD', 'ORR', 'NOT', 'AND'],
         [LOW7, LOW7, HIGH]),
        ('eq_spread8', 'LC_EQ_SPREAD',
         ['XOR', 'AND', 'ADD', 'ORR', 'NOT', 'AND'],
         ['2C2C2C2C2C2C2C2C', LOW7, LOW7, HIGH]),
        ('lt_spread8', 'LC_LT_SPREAD',
         ['OR', 'SUB', 'XORR', 'XOR', 'ANDNR', 'XORR', 'NOT', 'AND'],
         [HIGH, '2020202020202020', '2020202020202020', HIGH]),
        # The two-sided form needs `K - (x & LOW7)`, and the grammar has no
        # reverse subtract, so QM reaches it as `~(x & LOW7) + (K + 1)` —
        # 0xB9..BA being 0x39-per-lane with the top bits set, plus one.
        ('range_spread8', 'LC_RANGE_SPREAD',
         ['OR', 'SUB', 'AND', 'NOT', 'ADD', 'ANDR', 'ANDNR', 'AND'],
         [HIGH, '3030303030303030', LOW7, 'B9B9B9B9B9B9B9BA', HIGH]),
    ]

    def test_reaches_the_hand_written_form(self):
        for name, reference, instructions, wanted in self.CASES:
            with self.subTest(example=name, lanecode=reference):
                _result, target = minimized(name)
                self.assertIsNotNone(target, 'nothing lowered for %s' % name)
                self.assertEqual(target['instructions'], instructions)
                self.assertEqual(constants(target), wanted)
                self.assertTrue(target['verification']['pass'])

    # A 64-bit input cannot be enumerated.  These are the cases where the
    # verification is a differential rather than a proof, and the report has to
    # say so in those words rather than quietly reporting a pass.
    SAMPLED = {'prefix_xor64', 'mask_from_spread', 'byte_mask_from_spread',
               'zero_spread8', 'eq_spread8', 'lt_spread8', 'range_spread8'}

    def test_every_case_verifies_exhaustively(self):
        for name, _reference, _instructions, _wanted in self.CASES:
            with self.subTest(example=name):
                _result, target = minimized(name)
                v = target['verification']
                if name in self.SAMPLED:
                    self.assertFalse(v['exhaustive'])
                    self.assertIn('not a proof', v['claim'])
                else:
                    self.assertTrue(v['exhaustive'])
                    self.assertEqual(v['matched'], v['total'])

    def test_lanecode_header_is_present_as_the_reference(self):
        path = example_path('lanecode.h')
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
        for name in example_names(('.c',)):
            if not name.endswith('.c'):
                continue
            stem = name[:-2]
            first = solve(example(stem), frontend='cfront')
            self.assertTrue(first['ok'], first.get('error'))
            if not first.get('program'):
                continue          # nothing to be idempotent about

            target = next(t for t in first['targets']
                          if t['name'] == first['primary_target'])
            if 'LUT' in target['instructions']:
                # A `LUT` emits its table as a file-scope array, and the subset
                # frontend does not model those — `tests/test_vm_closure.py`
                # says the same thing and reaches for a real Clang. The
                # emission is not the gap here; reading it back is.
                continue
            second = solve(target['c'], frontend='cfront')

            with self.subTest(example=stem):
                self.assertTrue(second['ok'],
                                'QM cannot read its own output: %s'
                                % (second.get('error') or {}).get('text'))
                again = next(t for t in second['targets']
                             if t['name'] == second['primary_target'])
                self.assertEqual(self.signature(first, target),
                                 self.signature(second, again))


class TestIdleStagesAreDropped(unittest.TestCase):
    """A stage that computes the identity is not part of the meaning.

    A solver searching `LIN_CONST[PDEP] ; CONV` has to fill in both stages, so
    on a kernel that needs neither it comes back with a deposit into the
    input's own bits and a convolution by 1. Both are real answers inside that
    family and both do nothing — leaving them in put a PDEP in the output to
    move eight bits to where they already were.
    """

    def test_starts8_needs_no_deposit(self):
        result, lowered = minimized('starts8')
        self.assertEqual(result['program']['classes'], ['POINT'])
        self.assertEqual(result['program']['core_ops'], 1)
        self.assertEqual(lowered['instructions'], ['SHL', 'ANDNR'])

    def test_the_drop_is_reported_not_silent(self):
        result, _lowered = minimized('starts8')
        notes = ' '.join(result['program']['notes'])
        self.assertIn('computing the identity', notes)
        self.assertIn('LIN_CONST', notes)
        self.assertIn('CONV', notes)

    def test_the_answer_is_the_kernel_itself(self):
        """Two ops in, two ops out: this one was already minimal."""
        _result, lowered = minimized('starts8')
        self.assertEqual((lowered['span'], lowered['work']), (2, 2))
        self.assertTrue(lowered['verification']['pass'])
        self.assertEqual(lowered['verification']['matched'], 256)


class TestEmittedCodeCompilesAsPasted(unittest.TestCase):
    """The C the page offers you must go back in through the Clang path.

    `clang.prepare_source` strips `#include <immintrin.h>` — a bit-vector
    kernel needs the fixed-width typedefs and nothing else — and the browser
    compiles for wasm32, where that header does not exist. So the emitted
    `_pdep_u64` was an undeclared function: QM was handing out code it could
    not read back, and the "C intrinsics" view was the one place you saw it.
    """

    CASES = ['ranks8', 'byte_mask8', 'select8', 'shuffle_control8', 'run_ids8',
             'quote_state_before8', 'prefix_parity_mask8', 'prefix_xor64',
             # The lane comparisons emit no intrinsic at all — plain operators
             # and five constants — so they are the case where a wrong
             # constant would compile perfectly and mean something else.
             'zero_spread8', 'eq_spread8', 'lt_spread8', 'range_spread8']

    @staticmethod
    def emitted(name):
        result = solve(example(name), frontend='cfront')
        return result, target(result)['c']

    @unittest.skipUnless(NATIVE.available(), 'no native Clang')
    def test_it_compiles_for_both_targets(self):
        for name in self.CASES:
            _result, source = self.emitted(name)
            prepared = prepare_source(source)
            for machine in ('wasm32', 'x86_64-unknown-linux-gnu'):
                with self.subTest(example=name, target=machine):
                    with tempfile.TemporaryDirectory() as tmp:
                        src = os.path.join(tmp, 'in.c')
                        with open(src, 'w') as handle:
                            handle.write(prepared)
                        built = subprocess.run(
                            [NATIVE.binary, '--target=%s' % machine, '-O2',
                             '-ffreestanding', '-nostdlib', '-c', src,
                             '-o', os.path.join(tmp, 'out.o')],
                            capture_output=True, text=True)
                        self.assertEqual(built.returncode, 0, built.stderr)

    @unittest.skipUnless(NATIVE.available(), 'no native Clang')
    def test_clang_reads_it_back_to_the_same_answer(self):
        """Compiling is not enough — the shims have to mean the same thing."""
        for name in self.CASES:
            first, source = self.emitted(name)
            with self.subTest(example=name):
                again = solve(source, frontend='clang')
                self.assertTrue(again['ok'],
                                (again.get('error') or {}).get('text'))
                self.assertEqual(
                    (tuple(first['program']['classes']),
                     tuple(target(first)['instructions']),
                     tuple(constants(target(first)))),
                    (tuple(again['program']['classes']),
                     tuple(target(again)['instructions']),
                     tuple(constants(target(again)))))


class TestIntrinsics(unittest.TestCase):
    """Bit kernels are written with intrinsics, so the frontend reads them.

    These are lanecode.h's own definitions, pasted as they are written there.
    Getting the same answer from the intrinsic form and from the portable form
    is the whole claim: QM works on what the function means, not on how it is
    spelled.
    """

    PRELUDE = '''#include <stdint.h>
#include <immintrin.h>
#define LC_ONES 0x0101010101010101ull
#define LC_LOW7 0x7f7f7f7f7f7f7f7full
#define LC_HIGH 0x8080808080808080ull
#define LC_IOTA 0x0706050403020100ull
'''

    BYTE_MASK = 'static inline uint64_t lc_byte_mask8(uint8_t m)\n' \
                '{ return _pdep_u64((uint64_t)m, LC_ONES) * 0xFFull; }\n'

    CASES = [
        ('lc_ranks8',
         'uint64_t lc_ranks8(uint8_t m)\n'
         '{ return _pdep_u64((uint64_t)m, LC_ONES) * 0x0101010101010100ull; }',
         ['PDEP', 'IMUL'], [ONES, '0101010101010100']),

        ('lc_select8',
         BYTE_MASK
         + 'uint64_t lc_select8(uint8_t m)\n'
           '{ return _pext_u64(LC_IOTA, lc_byte_mask8(m)); }',
         ['PDEP', 'IMUL', 'PEXT_DYN'], [ONES, '00000000000000FF', IOTA]),

        ('lc_shuffle_control8',
         BYTE_MASK
         + 'uint64_t lc_shuffle_control8(uint8_t m)\n'
           '{ return ~_pext_u64(~LC_IOTA, lc_byte_mask8(m)); }',
         ['PDEP', 'IMUL', 'PEXT_DYN', 'NOT'],
         [ONES, '00000000000000FF', 'F8F9FAFBFCFDFEFF']),

        # The SSE carry-less multiply idiom, __m128i and all.
        ('lc_prefix_parity_mask8',
         'uint64_t lc_prefix_parity_mask8(uint8_t m)\n'
         '{\n'
         '    const uint64_t a = _pdep_u64((uint64_t)m, LC_ONES);\n'
         '    return (uint64_t)_mm_cvtsi128_si64(\n'
         '        _mm_clmulepi64_si128(_mm_cvtsi64_si128((long long)a),\n'
         '                             _mm_set1_epi64x(-1), 0));\n'
         '}',
         ['PDEP', 'CLMUL'], [ONES, ALL_ONES]),

        ('lc_quote_state_before8',
         'uint64_t lc_quote_state_before8(uint8_t q)\n'
         '{\n'
         '    const uint64_t a = _pdep_u64((uint64_t)q, LC_ONES);\n'
         '    return (uint64_t)_mm_cvtsi128_si64(\n'
         '        _mm_clmulepi64_si128(_mm_cvtsi64_si128((long long)a),\n'
         '            _mm_set_epi64x(0, (long long)0xFFFFFFFFFFFFFF00ull), 0));\n'
         '}',
         ['PDEP', 'CLMUL'], [ONES, 'FFFFFFFFFFFFFF00']),

        ('lc_ranks16_nibble',
         'uint64_t lc_ranks16_nibble(uint16_t m)\n'
         '{ return _pdep_u64((uint64_t)m, 0x1111111111111111ull)\n'
         '       * 0x1111111111111110ull; }',
         ['PDEP', 'IMUL'], ['1111111111111111', '1111111111111110']),
    ]

    def test_intrinsic_kernels_reach_the_same_form(self):
        for name, body, instructions, wanted in self.CASES:
            with self.subTest(kernel=name):
                result = solve(self.PRELUDE + body, frontend='cfront')
                self.assertTrue(result['ok'], result.get('error'))
                target = next(t for t in result['targets']
                              if t['name'] == result['primary_target'])
                self.assertEqual(target['instructions'], instructions)
                self.assertEqual(constants(target), wanted)
                self.assertTrue(target['verification']['pass'])

    def test_bmi1_andn(self):
        source = self.PRELUDE + (
            'uint64_t f(uint8_t x)\n'
            '{\n'
            '    uint64_t v = (uint64_t)x * LC_ONES;\n'
            '    return _andn_u64(((v & LC_LOW7) + LC_LOW7) | v, LC_HIGH);\n'
            '}')
        result = solve(source, frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        # Every byte lane of a repeated byte is non-zero unless the byte is,
        # so this is the zero predicate and the answer is a constant-ish map.
        self.assertEqual(result['semantics']['input_bits'], 8)

    def test_a_128_bit_parameter_is_refused_rather_than_truncated(self):
        source = ('#include <immintrin.h>\n'
                  'unsigned long long f(__m128i x) { return 0; }')
        result = solve(source, frontend='cfront')
        self.assertFalse(result['ok'])
        self.assertIn('128', result['error']['message'])


class TestUnsupportedHelpersAreSkipped(unittest.TestCase):
    """A helper outside the subset must not sink the whole paste."""

    SOURCE = '''#include <stdint.h>

struct pair { uint32_t lo, hi; };

static inline struct pair split(uint64_t v)
{
    struct pair p = { (uint32_t)v, (uint32_t)(v >> 32) };
    return p;
}

uint64_t kernel(uint8_t m)
{
    return (uint64_t)__builtin_popcount(m);
}
'''

    def test_the_kernel_still_analyses(self):
        result = solve(self.SOURCE, frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['function']['name'], 'kernel')

    def test_the_skip_is_reported_not_silent(self):
        result = solve(self.SOURCE, frontend='cfront')
        skipped = result['frontend']['skipped_definitions']
        self.assertTrue(skipped, 'the unsupported helper was not reported')
        self.assertTrue(any(s['name'] == 'split' or 'struct' in (s['reason'] or '')
                            for s in skipped), skipped)


if __name__ == '__main__':
    unittest.main()
