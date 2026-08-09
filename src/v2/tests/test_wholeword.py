"""The whole-word half of the grammar: comparison, reduction, case analysis.

The lane predicates in `test_lanecode` answer eight questions about eight bytes
at once.  These are the ones that ask a single question about the whole word —
"is a below b", "how many bits are set", "which of these four programs is this
float's" — and until the classes here existed every one of them fell through to
a lookup table.

Each case names the instruction sequence QM has to arrive at, the same way
`test_lanecode` names a hand-written form, so a change that quietly makes an
answer longer fails here rather than being noticed a release later.
"""

import unittest

from qm import isa as isa_mod
from qm.bits import lane_values, mask_of
from qm.isa import reciprocal
from qm.program import compile_program
from qm.solvers import _modulus_of
from vm import codec, image, run

from tests.support import example, solved as solve, target, vm_picture


def minimized(name):
    result = solve(example(name), frontend='cfront')
    assert result['ok'], result.get('error')
    return result, target(result)


class TestWholeWordKernelsLand(unittest.TestCase):
    """Every one of these was a lookup table, or nothing at all, before."""

    CASES = [
        # example                solver          instructions
        ('logical_neg_i32', 'point-chain',
         ['NEG', 'ANDR', 'POPCNT', 'NEG', 'ADD']),
        ('least_bit_mask_u64', 'point-chain', ['NEG', 'ANDR']),
        ('popcount_u64', 'point-chain', ['POPCNT']),
        ('how_many_bits_i32', 'point-chain',
         ['SHL', 'SAR', 'XORR', 'AND', 'CLZ', 'SUB', 'NEG', 'ADD']),
        # `smear(x - 1) + 1`.  The cascade is six shifts and six ORs, and that
        # is the shortest this grammar has: there is no rounding instruction.
        ('round_up_pow2_u64', 'point-chain',
         ['SUB'] + ['SHR', 'ORR'] * 6 + ['ADD']),
        # One reduction of the concatenated word — which is what a Rabin-Karp
        # step *is*, once the radix and the modulus are looked at together.
        ('rabin_karp_roll', 'point-chain', ['IMUL', 'SHR', 'IMUL', 'SUBR']),
        # The threshold is zero, so the subtraction that would have made the
        # comparison is not there: the difference's own sign bit is it.
        ('is_less_or_equal_i32', 'split',
         ['SHL', 'SAR', 'SAR', 'SUBR', 'AND', 'XOR',
          'SAR', 'XORR', 'ANDNR', 'XORR']),
        # Both halves are read with a mask and a shift: a deposit into the low
        # thirty-two bits is a mask, and normalization says so.
        ('min_i32', 'split',
         ['SHL', 'SAR', 'SAR', 'SUBR', 'AND', 'SHR',
          'SUB', 'SAR', 'XORR', 'ANDNR', 'XORR']),
        # `x >> 32` has nothing above bit 31, so the mask after it is dropped.
        ('mod_add_u32', 'split',
         ['AND', 'SHR', 'ADDR', 'ADD',
          'SUB', 'SAR', 'XORR', 'ANDNR', 'XORR']),
        # A multiply by 2^23 is a shift, and a subtraction of -125 is an
        # addition of 125.
        ('float_power2_bits', 'split',
         ['SHL', 'SAR', 'AND', 'SHL', 'SHL', 'ADD',
          'ADD', 'SAR', 'XORR', 'ANDNR', 'XORR']),
    ]

    def test_reaches_the_named_sequence(self):
        for name, solver, instructions in self.CASES:
            with self.subTest(example=name):
                result, primary = minimized(name)
                self.assertEqual(result['program']['solver'], solver)
                self.assertEqual(primary['instructions'], instructions)
                self.assertTrue(primary['verification']['pass'])

    def test_none_of_them_is_a_lookup_table(self):
        # The point of the classes: "no compact program" now means something
        # different for this family than it did.
        for name, _solver, _instructions in self.CASES:
            with self.subTest(example=name):
                result, primary = minimized(name)
                self.assertNotIn('LUT', primary['instructions'])

    def test_a_reduction_answers_with_one_lane(self):
        result, primary = minimized('max_u8x8')
        self.assertEqual(result['program']['solver'], 'lane-reduction')
        self.assertEqual(result['program']['ops'][0]['detail']['steps'],
                         [('LANE_MAX', None, 8)])
        self.assertTrue(primary['verification']['pass'])


class TestTheSplitIsTheCaseAnalysis(unittest.TestCase):
    """A split has to have found the kernel's own cases, not the ordering's."""

    def test_a_comparison_between_halves_is_two_constant_pieces(self):
        result, _primary = minimized('is_less_or_equal_i32')
        detail = result['program']['ops'][0]['detail']
        self.assertEqual(detail['key']['label'], 'sx[31:0] - sx[63:32]')
        self.assertEqual(detail['breaks'], [0])
        self.assertEqual(len(detail['branches']), 2)

    def test_a_conditional_subtract_reads_the_key_it_compared(self):
        result, _primary = minimized('mod_add_u32')
        detail = result['program']['ops'][0]['detail']
        self.assertEqual(detail['key']['label'], 'x[31:0] + x[63:32]')
        self.assertEqual(len(detail['breaks']), 1)
        # The modulus itself is 0xFFFFFFFB, and the domain is probed: no probe
        # lands in the five-wide window between it and the threshold reported,
        # so nothing in the data distinguishes the two.  The report says as
        # much rather than presenting the constant as forced.
        self.assertGreaterEqual(detail['breaks'][0], 0xFFFFFFFB)
        self.assertTrue(any('pinned only' in note
                            for note in result['program']['notes']))

    def test_a_float_splits_on_its_magnitude_not_on_its_sign(self):
        # Reading the sign into the key would double every piece: the case
        # analysis of `2*f` is the same on both halves of it.
        result, _primary = minimized('float_scale2_bits')
        detail = result['program']['ops'][0]['detail']
        self.assertEqual(detail['key']['label'], 'x[14:0]')
        self.assertEqual(len(detail['branches']), 4)

    def test_no_branch_is_emitted_for_a_branch(self):
        # Every piece is computed and blended.  A conditional jump in the
        # listing would be a different cost model than the one reported.
        _result, primary = minimized('float_scale2_bits')
        self.assertIsNotNone(primary['asm'])
        for line in primary['asm'].splitlines():
            self.assertNotIn('\tj', line)
            self.assertFalse(line.strip().startswith('j'))


class TestTheSearchPrefersTheCheapIdiom(unittest.TestCase):
    """Depth counts moves; the objective counts instructions."""

    def test_a_logical_negation_does_not_reach_for_a_cascade(self):
        # `smear(x | -x) + 1` and `1 - popcount(x & -x)` are both two moves
        # deep.  One is thirteen instructions and the other is five.
        _result, primary = minimized('logical_neg_i32')
        self.assertEqual(primary['work'], 5)

    def test_the_reciprocal_is_exact_over_the_value_range(self):
        for modulus, bits in ((251, 16), (997, 16), (7, 8), (1000003, 20)):
            multiplier, shift = reciprocal(modulus, bits)
            with self.subTest(modulus=modulus, bits=bits):
                self.assertTrue(all((v * multiplier >> shift) == v // modulus
                                    for v in range(1 << bits)))

    def test_a_modulus_is_only_offered_when_the_outputs_say_so(self):
        # Every residue present and none above: anything else is a function
        # whose range happens to be small, which is not a reduction.
        self.assertEqual(_modulus_of(list(range(251)) * 4, 16), 251)
        self.assertIsNone(_modulus_of([0, 1, 2, 4], 16))        # 3 is missing
        self.assertIsNone(_modulus_of(list(range(16)), 16))     # a mask
        # A reduction the reciprocal cannot be lowered with is not offered.
        self.assertIsNone(_modulus_of(list(range(1000)), 60))


class TestCommonSubexpressions(unittest.TestCase):
    def test_removing_repeats_does_not_change_the_function(self):
        seq = isa_mod.Seq()
        a = seq.emit('SHR', [0], shift=8)
        b = seq.emit('SHR', [0], shift=8)
        seq.emit('ADDR', [a, b])
        cleaned = isa_mod.common_subexpressions(seq)
        self.assertEqual(len(cleaned.ins), 2)
        before, after = isa_mod.compile_seq(seq), isa_mod.compile_seq(cleaned)
        for value in (0, 1, 0x1234, 0xFFFFFFFF, (1 << 64) - 1):
            self.assertEqual(before(value), after(value))


class TestTheArtifactAgrees(unittest.TestCase):
    """The minimized wasm32 program and the VM image compute the same thing."""

    CASES = ['logical_neg_i32', 'least_bit_mask_u64', 'float_power2_bits',
             'rabin_karp_roll']

    def test_the_bit_sliced_form_computes_the_program(self):
        for name in self.CASES:
            result, _primary = minimized(name)
            program = result['program_object']
            input_bits = result['frontend']['input_bits']
            output_bits = result['frontend']['output_bits']
            picture = vm_picture(result)
            blob = codec.pack(codec.code(image.serialize(picture)))
            reference = compile_program(program)
            values = [v & mask_of(input_bits)
                      for v in (0, 1, 2, 127, 128, 255, mask_of(input_bits))]
            values = sorted(set(values))
            with self.subTest(example=name):
                self.assertEqual(
                    run.evaluate_many(blob, values, input_bits, output_bits),
                    [reference(v) for v in values])


class TestWhatIsStillOutOfReach(unittest.TestCase):
    """The honest half.  These kernels are in the corpus *because* they do not
    land, and the report has to keep saying which of the two it is."""

    def test_a_variable_shift_falls_back_to_the_table(self):
        result, primary = minimized('float_to_int_bits')
        self.assertEqual(result['program']['solver'], 'table')
        self.assertEqual(primary['instructions'], ['LUT'])
        self.assertTrue(primary['verification']['exhaustive'])

    def test_four_counts_of_one_word_have_no_program(self):
        # An abstract program is a chain, so there is no way to say "and these
        # four answers go in these four fields".
        result = solve(example('histogram4_u2x16'), frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertIsNone(result['program'])
        self.assertEqual(result['residual_freedom'], 0)
        self.assertIn('declared grammar', result['note'])

    def test_a_normalizing_shift_has_no_program(self):
        result = solve(example('strict_sum4_f64'), frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        self.assertIsNone(result['program'])

    def test_the_kernels_that_do_land_are_not_claimed_to_be_proofs(self):
        # The 64-bit ones are probed, not enumerated, and every one of them
        # says so in as many words.
        for name in ('least_bit_mask_u64', 'popcount_u64', 'max_u8x8',
                     'min_i32', 'is_less_or_equal_i32'):
            _result, primary = minimized(name)
            with self.subTest(example=name):
                self.assertFalse(primary['verification']['exhaustive'])
                self.assertIn('not a proof', primary['verification']['claim'])


class TestTheReductionIsTheFunction(unittest.TestCase):
    def test_the_lowered_maximum_is_the_maximum(self):
        from qm.program import point
        for lane_bits in (8, 16, 32):
            for mnemonic, want in (('LANE_MAX', max), ('LANE_MIN', min)):
                seq = isa_mod.lower_point(
                    point([(mnemonic, None, lane_bits)]),
                    isa_mod.get_isa('portable'))[0][1]
                evaluate = isa_mod.compile_seq(seq)
                with self.subTest(lane_bits=lane_bits, step=mnemonic):
                    for value in (0, 1, (1 << 64) - 1, 0x0123456789ABCDEF,
                                  0xFF00FF00FF00FF00, 0x8080808080808080):
                        self.assertEqual(evaluate(value),
                                         want(lane_values(value, lane_bits)))


if __name__ == '__main__':
    unittest.main()
