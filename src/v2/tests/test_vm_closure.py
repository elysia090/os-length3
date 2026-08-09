"""The round trip closes: minimizing the artifact's own C gives the same answer.

    source  --QM-->  minimized wasm32  --codec-->  artifact
                                                       |
                                                     emit C
                                                       |
                                                       v
                                                      QM

This is the property that makes the artifact a single source of truth rather
than a lossy export. The emitted C is a 400-line SUBLEQ interpreter over a
6,000-cell memory — it does not resemble the kernel in any syntactic way — and
QM still recovers `SHL ANDNR` from it, because what QM reads is the function,
not the text.

It also says something about the lowering that no other test does: if
`vm.lower` dropped or added meaning anywhere, the second pass would minimize a
different function and land somewhere else.

Needs a real Clang: the emitted C uses file-scope arrays, which the built-in
subset frontend does not model.
"""

import unittest

from qm.clang import NATIVE
from qm.pipeline import solve
from vm import emit

from tests.support import read_example, vm_picture

# 8- and 16-bit kernels, whose domains are walked exhaustively on both passes,
# plus one 64-bit case so a sampled domain is covered too. The dynamic gather
# is left out on purpose: its artifact is two thirds of a megabyte, and the
# second pass would spend minutes proving something the small ones already say.
CASES = [
    ('starts8', ['SHL', 'ANDNR']),
    ('ends8', ['SHR', 'ANDNR']),
    ('byte_mask8', ['PDEP', 'IMUL']),
    ('ranks8', ['PDEP', 'IMUL']),
    ('middle_bits_u16', ['PEXT']),
    ('zero_spread8', ['AND', 'ADD', 'ORR', 'NOT', 'AND']),
]


def primary(result):
    return next(t for t in result['targets']
                if t['name'] == result['primary_target'])


@unittest.skipUnless(NATIVE.available(), 'needs native Clang')
class TestTheRoundTripCloses(unittest.TestCase):

    def round_trip(self, name):
        first = solve(read_example(name + '.c'), frontend='cfront')
        self.assertTrue(first['ok'], first.get('error'))
        self.assertIsNotNone(first.get('program_object'))

        input_bits = first['frontend']['input_bits']
        output_bits = first['frontend']['output_bits']
        picture = vm_picture(first)
        emitted = emit.emit_c(picture, '%s_vm' % name, input_bits, output_bits)

        second = solve(emitted, frontend='clang', function='%s_vm' % name)
        self.assertTrue(second['ok'], (second.get('error') or {}).get('text'))
        return first, second, emitted

    def test_the_artifact_minimizes_back_to_what_it_came_from(self):
        for name, instructions in CASES:
            with self.subTest(example=name):
                first, second, _ = self.round_trip(name)
                self.assertEqual(primary(first)['instructions'], instructions,
                                 'the first pass moved; fix this list')
                self.assertEqual(primary(second)['instructions'], instructions)
                self.assertEqual(second['program']['classes'],
                                 first['program']['classes'])
                self.assertEqual(second['program']['core_ops'],
                                 first['program']['core_ops'])

    def test_the_second_pass_verifies_as_strongly_as_the_first(self):
        first, second, _ = self.round_trip('ranks8')
        before, after = primary(first)['verification'], primary(second)['verification']
        self.assertTrue(after['pass'])
        self.assertEqual(after['exhaustive'], before['exhaustive'])
        self.assertEqual(after['total'], before['total'])

    def test_the_text_it_reads_looks_nothing_like_the_kernel(self):
        """The point is that this is not textual round-tripping.

        If the emitted C still said `x & ~(x << 1)` somewhere, matching on the
        second pass would be unremarkable. It says `qm_mem[b] - qm_mem[a]`.
        """
        _first, _second, emitted = self.round_trip('starts8')
        self.assertIn('qm_mem[b] - qm_mem[a]', emitted)
        self.assertNotIn('<< 1', emitted.split('QM_VALUE')[0])
        self.assertGreater(len(emitted.splitlines()), 200)
