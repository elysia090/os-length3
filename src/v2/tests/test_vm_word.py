"""Whole-expression extraction into the VM's native word arithmetic."""

import unittest

from qm import isa
from qm.pipeline import solve
from vm import codec, image, lower, planner, run, word
from vm.framing import frame_function
from tests.support import read_example, target


M64 = (1 << 64) - 1
SPREAD = 0x0101010101010101


def artifact(picture):
    return codec.pack(codec.code(image.serialize(picture)))


class TestTheFinalFormIsExtractedOnce(unittest.TestCase):

    def test_only_the_requested_affine_result_crosses_to_the_word_lowerer(self):
        seq = isa.Seq()
        a = seq.emit('ADD', [0], const=1)
        b = seq.emit('ADD', [0], const=2)
        c = seq.emit('ADDR', [a, b])
        d = seq.emit('IMUL', [c], const=3)
        seq.emit('SUB', [d], const=4)

        self.assertEqual(word.extract_affine(seq), (6, 5))
        self.assertEqual(word.extract_affine(seq),
                         isa._extract_integer_affine(seq))

    def test_one_non_affine_dependency_rejects_the_whole_form(self):
        seq = isa.Seq()
        masked = seq.emit('AND', [0], const=0xFF)
        seq.emit('ADD', [masked], const=1)
        self.assertIsNone(word.extract_affine(seq))


class TestTheWholeWordRepresentative(unittest.TestCase):

    def spread_sequence(self):
        seq = isa.Seq()
        seq.emit('IMUL', [0], const=SPREAD)
        return seq

    def test_the_whole_word_form_beats_the_bit_vector_on_the_full_artifact(self):
        seq = self.spread_sequence()
        bit_picture = lower._lower_bit_seq(seq, 8, 64)
        word_picture = lower._lower_word_seq(seq, 8, 64)
        bit_key = planner.physical_key(bit_picture, 8, 64)
        word_key = planner.physical_key(word_picture, 8, 64)

        self.assertLess(word_key[:3], bit_key[:3])
        lower._SELECTION.clear()
        self.assertEqual(lower.lower_seq(seq, 8, 64), word_picture)

    def test_the_selected_form_computes_the_whole_byte_domain(self):
        seq = self.spread_sequence()
        blob = run.artifact_for(seq, 8, 64)
        expected = [(value * SPREAD) & M64 for value in range(256)]
        self.assertEqual(run.evaluate_many(blob, range(256), 8, 64), expected)

    def test_negative_scale_and_offset_wrap_exactly(self):
        seq = isa.Seq()
        negated = seq.emit('NEG', [0])
        seq.emit('ADD', [negated], const=123)
        picture = lower._lower_word_seq(seq, 8, 64)
        values = (0, 1, 2, 122, 123, 127, 128, 255)
        got = run.evaluate_many(artifact(picture), values, 8, 64)
        self.assertEqual(got, [(123 - value) & M64 for value in values])

    def test_pure_rewiring_stays_in_the_bit_vector_form(self):
        seq = isa.Seq()
        seq.emit('SHL', [0], shift=8)
        self.assertFalse(word.is_candidate(seq, 64))
        self.assertEqual(lower.lower_seq(seq, 8, 64),
                         lower._lower_bit_seq(seq, 8, 64))


class TestCarryFreeLaneCoordinates(unittest.TestCase):
    """A bit-structural prefix may feed a direct byte-coordinate island."""

    @classmethod
    def setUpClass(cls):
        result = solve(read_example('ranks8.c'), frontend='cfront')
        cls.seq = target(result, 'wasm32')['seq']

    def legacy_picture(self):
        low = lower.BitVectorLowering(8, 64)

        def compute(input_word):
            values = {0: input_word}
            for position, instruction in enumerate(self.seq.ins, start=1):
                args = [values[index] for index in instruction.args]
                values[position] = low.apply(
                    instruction.op, args,
                    instruction.const, instruction.shift)
            return values[self.seq.result]

        return frame_function(low, compute, 8, 64, lower.ZERO)

    def test_ranks_are_emitted_as_eight_bounded_lane_coordinates(self):
        legacy = self.legacy_picture()
        compact = lower._lower_bit_seq(self.seq, 8, 64)
        self.assertLess(planner.physical_key(compact, 8, 64)[:3],
                        planner.physical_key(legacy, 8, 64)[:3])
        self.assertLess(len(compact.memory), len(legacy.memory))

        blob = artifact(compact)
        reference = isa.compile_seq(self.seq)
        self.assertEqual(run.evaluate_many(blob, range(256), 8, 64),
                         [reference(value) for value in range(256)])


if __name__ == '__main__':
    unittest.main()
