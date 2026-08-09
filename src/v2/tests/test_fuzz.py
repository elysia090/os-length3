"""Random programs, against the properties that have to hold for all of them.

The rest of the suite names cases. This one does not: it builds sequences out
of the instruction set at random and asks the questions whose answer must not
depend on which sequence it got —

    normalizing does not change the function
    the known-bits analysis never rules out a bit that appears
    every emitter's output reads back as the same function
    a lowered program agrees with the abstract program it came from

Deterministic, because a failure nobody can reproduce is not a failure report:
the seed is fixed and printed in every message. `QM_FUZZ` raises the number of
cases for a longer run, and `QM_FUZZ_SEED` moves the stream.
"""

import os
import random
import shutil
import subprocess
import tempfile
import unittest

from qm import isa as isa_mod
from qm.asmfront import compile_function as compile_listing
from qm.asmfront import parse as parse_listing
from qm.bits import M64, mask_of
from qm.cfront import CFrontError, compile_unit
from qm.cfront import parse as parse_c
from qm.program import compile_program
from qm.pipeline import solve

CASES = int(os.environ.get('QM_FUZZ', '120'))
SEED = int(os.environ.get('QM_FUZZ_SEED', '20260809'))

# Where a wrong rewrite shows up: the edges of every width, the values that
# make a carry cross one, and a spread of ordinary ones.
VALUES = [0, 1, 2, 3, 0x7F, 0x80, 0xFF, 0x100, 0x7FFF, 0x8000, 0xFFFF,
          0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 0x7FFFFFFFFFFFFFFF,
          0x8000000000000000, M64, 0x0123456789ABCDEF, 0xFEDCBA9876543210,
          0x5555555555555555, 0xAAAAAAAAAAAAAAAA]

UNARY = ['NOT', 'NEG', 'BSWAP', 'POPCNT', 'CLZ', 'CTZ']
WITH_CONST = ['AND', 'OR', 'XOR', 'ADD', 'SUB', 'IMUL', 'CLMUL',
              'PDEP', 'PEXT', 'PEXT_DYN', 'PDEP_DYN']
WITH_SHIFT = ['SHL', 'SHR', 'SAR', 'SCANXOR']
BINARY = ['XORR', 'ANDR', 'ORR', 'ADDR', 'SUBR', 'ANDNR']


def random_constant(rng):
    """A constant of the shapes these programs actually carry."""
    kind = rng.randrange(6)
    if kind == 0:
        return rng.getrandbits(64)
    if kind == 1:
        return mask_of(rng.randrange(1, 65))
    if kind == 2:
        return 1 << rng.randrange(64)
    if kind == 3:
        return rng.choice([0, 1, 2, 3, 0xFF, 0x0101010101010101,
                           0x8080808080808080, 0x5555555555555555])
    if kind == 4:
        return (-rng.randrange(1, 256)) & M64
    return rng.getrandbits(rng.randrange(1, 65))


def random_sequence(rng, length=None):
    seq = isa_mod.Seq()
    for _ in range(length or rng.randrange(1, 9)):
        pool = rng.randrange(4)
        available = list(range(len(seq.ins) + 1))
        a = rng.choice(available)
        if pool == 0:
            seq.emit(rng.choice(UNARY), [a])
        elif pool == 1:
            seq.emit(rng.choice(WITH_CONST), [a], const=random_constant(rng))
        elif pool == 2:
            if rng.randrange(4) == 0:
                seq.emit('SEXT', [a], shift=rng.choice(isa_mod.SEXT_WIDTHS))
            else:
                seq.emit(rng.choice(WITH_SHIFT), [a], shift=rng.randrange(64))
        else:
            seq.emit(rng.choice(BINARY), [a, rng.choice(available)])
    return seq


def table(function, values=VALUES):
    return [function(v) for v in values]


class TestNormalizationIsAnIdentity(unittest.TestCase):
    """The rewrites change the reported program, so they may not change it."""

    def test_random_sequences_survive_normalization(self):
        rng = random.Random(SEED)
        for case in range(CASES):
            seq = random_sequence(rng)
            normalized = isa_mod.normalize(seq)
            with self.subTest(case=case, seed=SEED):
                self.assertEqual(table(isa_mod.compile_seq(seq)),
                                 table(isa_mod.compile_seq(normalized)))

    def test_normalizing_is_a_fixed_point(self):
        rng = random.Random(SEED + 1)
        for case in range(CASES):
            once = isa_mod.normalize(random_sequence(rng))
            twice = isa_mod.normalize(once)
            with self.subTest(case=case, seed=SEED + 1):
                self.assertEqual(
                    [(i.op, i.args, i.const, i.shift) for i in once.ins],
                    [(i.op, i.args, i.const, i.shift) for i in twice.ins])

    def test_normalization_never_makes_a_sequence_longer(self):
        rng = random.Random(SEED + 2)
        for case in range(CASES):
            seq = random_sequence(rng)
            with self.subTest(case=case, seed=SEED + 2):
                self.assertLessEqual(len(isa_mod.normalize(seq).ins),
                                     len(seq.ins))


class TestKnownBitsIsSound(unittest.TestCase):
    """An over-approximation that is ever wrong drops a mask that mattered."""

    def test_no_value_sets_a_bit_the_analysis_ruled_out(self):
        rng = random.Random(SEED + 3)
        for case in range(CASES):
            seq = random_sequence(rng)
            known = isa_mod.known_bits(seq)
            evaluate = isa_mod.compile_seq(seq)
            with self.subTest(case=case, seed=SEED + 3):
                for value in VALUES:
                    self.assertEqual(
                        evaluate(value) & ~known[seq.result] & M64, 0,
                        'input 0x%X' % value)


class TestEveryEmitterReadsBack(unittest.TestCase):
    """Three languages for one sequence, and each has a reader for it."""

    def evaluate_c(self, text):
        unit = parse_c(text)
        return compile_unit(unit).function('f')

    def test_the_emitted_c_is_the_sequence(self):
        rng = random.Random(SEED + 4)
        checked = 0
        for case in range(CASES):
            seq = isa_mod.normalize(random_sequence(rng))
            text = isa_mod.emit_c(seq, 'f', 'uint64_t', 'uint64_t')
            with self.subTest(case=case, seed=SEED + 4):
                try:
                    back = self.evaluate_c(text)
                except CFrontError as exc:      # pragma: no cover - a gap
                    self.fail('cannot read back: %s\n%s' % (exc, text))
                self.assertEqual(table(back),
                                 table(isa_mod.compile_seq(seq)), text)
                checked += 1
        self.assertEqual(checked, CASES)

    def test_the_emitted_x86_is_the_sequence(self):
        rng = random.Random(SEED + 5)
        checked = 0
        for case in range(CASES):
            seq = isa_mod.normalize(random_sequence(rng))
            text = isa_mod.emit_asm(seq, 'f', 64)
            if text is None:
                continue            # an instruction this emitter refuses
            function, _dialect = parse_listing(text)
            with self.subTest(case=case, seed=SEED + 5):
                self.assertEqual(table(compile_listing(function)),
                                 table(isa_mod.compile_seq(seq)), text)
            checked += 1
        self.assertTrue(checked, 'no listing was produced at all')

    def test_the_emitted_wasm_is_the_sequence(self):
        rng = random.Random(SEED + 6)
        checked = 0
        for case in range(CASES):
            seq = isa_mod.normalize(random_sequence(rng))
            text = isa_mod.emit_wasm(seq, 'f', 64)
            if text is None:
                continue
            function, _dialect = parse_listing(text)
            with self.subTest(case=case, seed=SEED + 6):
                self.assertEqual(table(compile_listing(function)),
                                 table(isa_mod.compile_seq(seq)), text)
            checked += 1
        self.assertTrue(checked, 'no wasm was produced at all')


@unittest.skipUnless(shutil.which('cc') or shutil.which('gcc'),
                     'no assembler on this machine')
class TestTheEmittedListingAssembles(unittest.TestCase):
    """The reader is a model of x86. This is x86.

    Immediates, three-operand `imul`, the sign-extending moves and the 32-bit
    register names are each a way to write a listing that reads back correctly
    above and is rejected by an assembler.
    """

    def test_a_batch_of_random_listings_assembles(self):
        rng = random.Random(SEED + 8)
        listings = []
        while len(listings) < max(8, CASES // 4):
            text = isa_mod.emit_asm(isa_mod.normalize(random_sequence(rng)),
                                    'f%d' % len(listings), 64)
            if text is not None:
                listings.append(text)

        assembler = shutil.which('cc') or shutil.which('gcc')
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, 'batch.s')
            with open(source, 'w') as handle:
                handle.write('\n'.join(listings))
            done = subprocess.run(
                [assembler, '-c', source, '-o',
                 os.path.join(directory, 'batch.o')],
                capture_output=True, text=True)
            self.assertEqual(done.returncode, 0,
                             'seed %d\n%s' % (SEED + 8, done.stderr))


# Straight-line C the subset frontend reads, built out of the operators a
# small kernel uses. Nothing here is meant to be a good program: what is
# being fuzzed is the claim the pipeline makes about whatever it is given.
_OPS = ['+', '-', '*', '&', '|', '^']


def random_kernel(rng, width):
    lines = []
    terms = ['x']
    for index in range(rng.randrange(1, 6)):
        left = rng.choice(terms)
        kind = rng.randrange(5)
        if kind == 0:
            expr = '%s %s 0x%Xu' % (left, rng.choice(_OPS),
                                    rng.getrandbits(width))
        elif kind == 1:
            expr = '%s >> %d' % (left, rng.randrange(width))
        elif kind == 2:
            expr = '%s << %d' % (left, rng.randrange(width))
        elif kind == 3:
            expr = '%s %s %s' % (left, rng.choice(_OPS), rng.choice(terms))
        else:
            expr = '(%s > 0x%Xu) ? %s : 0x%Xu' % (
                left, rng.getrandbits(width), left, rng.getrandbits(width))
        name = 't%d' % index
        lines.append('    uint%d_t %s = (uint%d_t)(%s);' % (width, name, width,
                                                            expr))
        terms.append(name)
    return ('#include <stdint.h>\nuint%d_t f(uint%d_t x)\n{\n%s\n'
            '    return %s;\n}\n'
            % (width, width, '\n'.join(lines), terms[-1]))


class TestThePipelineKeepsItsWord(unittest.TestCase):
    """Whatever it answers, the answer has to be the function it was given.

    Every claim the report makes is checkable here: the abstract program, the
    lowered sequence for each target, and the C that target emits all have to
    agree with the kernel on the domain the report says was verified.
    """

    def test_random_kernels_are_answered_or_refused_but_never_wrong(self):
        rng = random.Random(SEED + 7)
        answered = 0
        for case in range(max(8, CASES // 6)):
            width = rng.choice([8, 8, 16])
            source = random_kernel(rng, width)
            result = solve(source, frontend='cfront')
            with self.subTest(case=case, seed=SEED + 7, source=source):
                self.assertTrue(result['ok'], result.get('error'))
                if not result.get('program'):
                    continue           # a refusal is an allowed answer
                answered += 1
                reference = compile_unit(parse_c(source)).function('f')
                domain = list(range(1 << width))
                abstract = compile_program(result['program_object'])
                self.assertEqual([abstract(v) for v in domain],
                                 [reference(v) for v in domain],
                                 'the abstract program is not the kernel')
                for target in result['targets']:
                    if not target.get('ok'):
                        continue
                    self.assertTrue(target['verification']['pass'])
                    lowered = isa_mod.compile_seq(target['seq'])
                    self.assertEqual([lowered(v) & mask_of(width)
                                      for v in domain],
                                     [reference(v) for v in domain],
                                     '%s does not compute the kernel'
                                     % target['name'])
        self.assertTrue(answered, 'nothing was answered at all')


if __name__ == '__main__':
    unittest.main()
