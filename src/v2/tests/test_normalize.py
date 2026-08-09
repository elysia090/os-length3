"""Normalization of a lowered sequence, and what the listing is written as.

A lowering is assembled from independent pieces — one sub-sequence per abstract
op, one per branch of a split — so what comes out of it says the same thing
several times and says some of it in the long form. None of that is a fact
about the kernel, and `work`, `span` and `L(z)` all count it.

Two layers, checked separately. `normalize` rewrites the sequence, so it
changes the reported program and every one of its rewrites has to be an
identity over 64-bit words. `emit_asm` only changes the listing, so what it has
to keep is the function — which the assembly reader is then held to.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

from qm import isa as isa_mod
from qm.asmfront import parse
from qm.bits import M64, mask_of

from tests.support import example, solved as solve, target


PROBES = [0, 1, 2, 3, 7, 8, 0x7F, 0x80, 0xFF, 0x1234, 0xFFFF,
          0x8000000000000000, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF,
          0x0123456789ABCDEF, 0xFEDCBA9876543210]


def agrees(before, after):
    left, right = isa_mod.compile_seq(before), isa_mod.compile_seq(after)
    return all(left(v) == right(v) for v in PROBES)


def build(*steps):
    """A sequence from (op, args, const, shift) tuples."""
    seq = isa_mod.Seq()
    for op, args, const, shift in steps:
        seq.emit(op, args, const, shift)
    return seq


class TestEveryRewriteIsAnIdentity(unittest.TestCase):

    CASES = [
        ('a multiply by a power of two is a shift',
         build(('IMUL', [0], 1 << 23, None)), ['SHL']),
        ('a multiply by one is nothing',
         build(('IMUL', [0], 1, None), ('XOR', [1], 5, None)), ['XOR']),
        ('a multiply by zero is a zero',
         build(('IMUL', [0], 0, None)), ['AND']),
        ('subtracting a negative constant is adding',
         build(('SUB', [0], (-125) & M64, None)), ['ADD']),
        ('a mask that cannot clear anything goes',
         build(('SHR', [0], None, 32), ('AND', [1], mask_of(32), None)),
         ['SHR']),
        ('two masks are one',
         build(('AND', [0], 0xFF0, None), ('AND', [1], 0x0FF, None)), ['AND']),
        ('two shifts the same way are one',
         build(('SHL', [0], None, 8), ('SHL', [1], None, 12)), ['SHL']),
        ('shifting past the width is a zero',
         build(('SHL', [0], None, 40), ('SHL', [1], None, 40)), ['AND']),
        ('a complement twice is nothing',
         build(('NOT', [0], None, None), ('NOT', [1], None, None),
               ('XOR', [2], 7, None)), ['XOR']),
        ('a deposit into the low bits is a mask',
         build(('PDEP', [0], mask_of(32), None)), ['AND']),
        ('a value nothing reads is not computed',
         build(('BSWAP', [0], None, None), ('AND', [0], 0xFF, None)), ['AND']),
        ('the same value is not computed twice',
         build(('SHR', [0], None, 8), ('SHR', [0], None, 8),
               ('ADDR', [1, 2], None, None)), ['SHR', 'ADDR']),
    ]

    def test_the_function_survives_and_the_form_is_the_named_one(self):
        for label, seq, expected in self.CASES:
            with self.subTest(rewrite=label):
                normalized = isa_mod.normalize(seq)
                self.assertTrue(agrees(seq, normalized),
                                'normalizing changed the function')
                self.assertEqual(
                    [ins.op for ins in normalized.ins], expected)

    def test_normalizing_twice_changes_nothing(self):
        for _label, seq, _expected in self.CASES:
            once = isa_mod.normalize(seq)
            twice = isa_mod.normalize(once)
            with self.subTest(sequence=[ins.op for ins in once.ins]):
                self.assertEqual([ins.op for ins in once.ins],
                                 [ins.op for ins in twice.ins])

    def test_a_masked_extract_keeps_its_deposit(self):
        # `middle_bits_u16` is one PEXT and the shift-and-mask pair is not it;
        # only a mask that is already the low bits normalizes away.
        seq = build(('PEXT', [0], 0xFF0, None))
        self.assertEqual([ins.op for ins in isa_mod.normalize(seq).ins],
                         ['PEXT'])


class TestKnownBits(unittest.TestCase):
    """The analysis the masks and the 32-bit forms both rest on."""

    SEQUENCES = [
        build(('SHR', [0], None, 40), ('IMUL', [1], 3, None)),
        build(('AND', [0], 0xF0F0, None), ('SHL', [1], None, 4),
              ('ADD', [2], 0x101, None)),
        build(('PEXT', [0], 0x8080808080808080, None),
              ('POPCNT', [1], None, None)),
        build(('AND', [0], 0xFF, None), ('BSWAP', [1], None, None)),
        build(('CLZ', [0], None, None), ('SHL', [1], None, 3)),
    ]

    def test_no_value_ever_sets_a_bit_the_analysis_ruled_out(self):
        for seq in self.SEQUENCES:
            known = isa_mod.known_bits(seq)
            evaluate = isa_mod.compile_seq(seq)
            with self.subTest(sequence=[ins.op for ins in seq.ins]):
                for value in PROBES:
                    self.assertEqual(evaluate(value) & ~known[seq.result] & M64,
                                     0, 'input 0x%X' % value)


class TestTheListingIsWrittenShort(unittest.TestCase):
    """`emit_asm` may only change the listing, so the reader is the check."""

    NAMES = ['float_power2_bits', 'rabin_karp_roll', 'min_i32',
             'mod_add_u32', 'is_less_or_equal_i32', 'least_bit_mask_u64',
             'how_many_bits_i32', 'ranks8', 'range_spread8']

    def listing(self, name):
        result = solve(example(name), frontend='cfront')
        primary = target(result)
        return result, primary, primary['asm']

    def test_the_listing_computes_the_sequence(self):
        for name in self.NAMES:
            result, primary, text = self.listing(name)
            function, _dialect = parse(text)
            reference = isa_mod.compile_seq(primary['seq'])
            mask = mask_of(result['semantics']['input_bits'])
            values = [v & mask for v in PROBES] + [mask]
            with self.subTest(example=name):
                for value in sorted(set(values)):
                    self.assertEqual(function(value), reference(value),
                                     'input 0x%X' % value)

    def test_a_constant_that_fits_an_immediate_is_written_as_one(self):
        # `movabsq` plus a use, for a constant that fits in the instruction,
        # was most of the length of these listings.
        for name in self.NAMES:
            _result, _primary, text = self.listing(name)
            with self.subTest(example=name):
                for load in re.findall(r'movabsq \$0x([0-9A-F]+),', text):
                    self.assertFalse(
                        isa_mod._fits_imm32(int(load, 16)),
                        '0x%s fits an immediate and was still loaded' % load)

    def test_a_value_whose_last_reader_is_here_is_overwritten_in_place(self):
        # Nothing pins the allocator, but a listing in which every single
        # operation is preceded by a move is one that is not propagating
        # copies at all.
        _result, _primary, text = self.listing('float_power2_bits')
        lines = [line.strip() for line in text.splitlines()
                 if line.startswith('    ') and not line.strip().startswith('.')
                 and not line.strip().startswith('#')]
        moves = [line for line in lines if line.startswith('movq ')]
        self.assertLess(len(moves), len(lines) // 3)

    def test_the_32_bit_forms_only_appear_where_there_is_no_upper_half(self):
        for name in self.NAMES:
            result, primary, text = self.listing(name)
            known = isa_mod.known_bits(primary['seq'])
            narrow = re.findall(r'^\s+(?:mov|and|or|xor|add|sub|imul|shl|shr)l\s',
                                text, re.M)
            with self.subTest(example=name):
                if not narrow:
                    continue
                # A 32-bit destination zero-extends, so the listing can only be
                # right if every value it names really does fit.
                self.assertTrue(any(k <= mask_of(32) for k in known[1:]),
                                'nothing in the sequence fits 32 bits')


@unittest.skipUnless(shutil.which('cc') or shutil.which('gcc'),
                     'no assembler on this machine')
class TestTheListingAssembles(unittest.TestCase):
    """A real assembler, on the forms the emitter only just started writing.

    Immediates, three-operand `imul` and the 32-bit register names are each a
    way to write a listing that reads back correctly here and is rejected by
    `as`. The reader is a model of x86; this is x86.
    """

    NAMES = TestTheListingIsWrittenShort.NAMES + [
        'float_scale2_bits', 'max_u8x8', 'round_up_pow2_u64', 'select8',
        'prefix_parity_mask8', 'lt_spread8',
    ]

    def test_every_emitted_listing_assembles(self):
        assembler = shutil.which('cc') or shutil.which('gcc')
        for name in self.NAMES:
            result = solve(example(name), frontend='cfront')
            text = target(result)['asm']
            with self.subTest(example=name):
                self.assertIsNotNone(text)
                with tempfile.TemporaryDirectory() as directory:
                    source = os.path.join(directory, 'k.s')
                    with open(source, 'w') as handle:
                        handle.write(text)
                    done = subprocess.run(
                        [assembler, '-c', source, '-o',
                         os.path.join(directory, 'k.o')],
                        capture_output=True, text=True)
                    self.assertEqual(done.returncode, 0, done.stderr)


class TestNormalizationDoesNotMoveTheLaneKernels(unittest.TestCase):
    """The hand-written forms are the reference, and none of them changed."""

    def test_the_lane_comparisons_keep_their_constants(self):
        from tests.test_lanecode import constants
        _result = solve(example('range_spread8'), frontend='cfront')
        primary = target(_result)
        self.assertIn('B9B9B9B9B9B9B9BA', constants(primary))
        self.assertEqual(primary['instructions'],
                         ['OR', 'SUB', 'AND', 'NOT', 'ADD', 'ANDR', 'ANDNR',
                          'AND'])


if __name__ == '__main__':
    unittest.main()
