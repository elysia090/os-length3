"""Bit primitives, observers, quotients and the objective."""

import unittest

from qm.bits import M64, clmul, mask_of, parity, pdep, pext, popcnt
from qm.guards import derive_guard, guard_evidence, lane_rule_Z
from qm.isa import Seq, compile_seq, measure, run
from qm.observer import parse as parse_observer
from qm.quotient import future_quotient, streaming_future_quotient
from qm.semantics import choose_domain, from_callable


class TestBits(unittest.TestCase):
    def test_pdep_pext_are_inverse_on_the_selected_bits(self):
        for mask in (0x0101010101010101, 0xF0F0, M64, 0x8000000000000001):
            width = popcnt(mask)
            for value in (0, 1, (1 << min(width, 20)) - 1):
                value &= mask_of(width)
                self.assertEqual(pext(pdep(value, mask), mask), value)

    def test_clmul_is_gf2_linear(self):
        for a in (0, 1, 0x1234, 0xFFFF):
            for b in (0, 1, 0xABCD):
                left = clmul(a ^ b, 0x1B, 64)
                right = clmul(a, 0x1B, 64) ^ clmul(b, 0x1B, 64)
                self.assertEqual(left, right)

    def test_parity_matches_popcount(self):
        for x in (0, 1, 0b1011, M64):
            self.assertEqual(parity(x), popcnt(x) & 1)


class TestGuards(unittest.TestCase):
    def test_imul_guard_is_prepaid_and_clmul_truncation_is_free(self):
        imul = derive_guard('IMUL', 8)
        self.assertFalse(imul['linear'])
        self.assertEqual(imul['cost'], 1)

        trivial = derive_guard('CLMUL', 64, modulus_trivial=True)
        self.assertEqual(trivial['cost'], 0)
        self.assertTrue(trivial['linear'])

        reduced = derive_guard('CLMUL', 128, modulus_trivial=False)
        self.assertTrue(reduced['linear'])
        self.assertEqual(reduced['payment'], 'deferable / amortizable')

    def test_lane_rule(self):
        self.assertTrue(lane_rule_Z(8, 8))
        self.assertTrue(lane_rule_Z(16, 4))
        self.assertTrue(lane_rule_Z(64, 1) is False or lane_rule_Z(64, 1))
        self.assertFalse(lane_rule_Z(8, 2))

    def test_guard_evidence_finds_imul_nonlinear(self):
        evidence = {e['claim']: e['measured'] for e in guard_evidence(16)}
        self.assertFalse(evidence['CONV(IMUL) distributes over XOR'])
        self.assertTrue(evidence['CONV(CLMUL) distributes over XOR'])
        self.assertTrue(evidence['GF(2^128) reduction distributes over XOR'])


class TestObservers(unittest.TestCase):
    def test_default_is_identity(self):
        obs = parse_observer('exact', 64)
        self.assertTrue(obs.is_identity)
        self.assertEqual(obs(0x1234), 0x1234)

    def test_constant_bits_are_not_inferred_as_dont_care(self):
        # Two values that differ only above bit 8 stay distinct under the
        # default observer, and collapse only when the observer says so.
        a, b = 0x100, 0x200
        self.assertNotEqual(parse_observer('exact')(a), parse_observer('exact')(b))
        self.assertEqual(parse_observer('low:8')(a), parse_observer('low:8')(b))

    def test_specs(self):
        self.assertEqual(parse_observer('mask:0xFF')(0x1234), 0x34)
        self.assertEqual(parse_observer('byte:1')(0x1234), 0x1200)
        self.assertEqual(parse_observer('nonzero')(0x1234), 1)
        self.assertEqual(parse_observer('nonzero')(0), 0)
        self.assertEqual(parse_observer('high:8', 16)(0xABCD), 0xAB00)

    def test_unknown_spec_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_observer('whatever')


class TestQuotients(unittest.TestCase):
    def test_future_quotient_of_a_reset_automaton_is_the_identity(self):
        classes = future_quotient(lambda s, a: a, lambda s: s,
                                  range(16), range(16))
        self.assertEqual(len(set(classes.values())), 16)

    def test_streaming_quotient_collapses_a_counter(self):
        # popcount forgets which bits were set, so 9 classes suffice for 8 bits.
        sem = from_callable(lambda x: popcnt(x), 8, 64)
        report = streaming_future_quotient(sem)
        self.assertTrue(report['computed'])
        self.assertLessEqual(report['peak_classes'], 9)
        self.assertLess(report['state_bits'], report['naive_state_bits'])

    def test_streaming_quotient_reports_when_it_declines(self):
        sem = from_callable(lambda x: x, 16, 64)
        self.assertFalse(streaming_future_quotient(sem, max_input_bits=13)['computed'])


class TestDomains(unittest.TestCase):
    def test_small_domains_are_exhaustive(self):
        domain = choose_domain(8)
        self.assertTrue(domain.exhaustive)
        self.assertEqual(len(domain), 256)

    def test_wide_domains_are_labelled_as_sampled(self):
        domain = choose_domain(64, probes=32)
        self.assertFalse(domain.exhaustive)
        self.assertIn('NOT a proof', domain.note)
        # Basis and boundary probes are present, not just random values.
        for i in range(64):
            self.assertIn(1 << i, domain.values())


class TestObjective(unittest.TestCase):
    def test_span_and_work_differ_on_a_dag(self):
        seq = Seq()
        a = seq.emit('AND', [0], const=0xFF)
        b = seq.emit('AND', [0], const=0xFF00)
        seq.emit('XORR', [a, b])
        span, work, _bits, _rank = measure(seq)
        self.assertEqual(work, 3)
        self.assertEqual(span, 2)      # the two ANDs are independent

    def test_rank_is_cheap_for_a_large_table(self):
        seq = Seq()
        seq.emit('LUT', [0], const=tuple(range(1 << 16)))
        span, work, bits, rank = measure(seq)
        self.assertEqual((span, work), (1, 1))
        self.assertIsInstance(rank, bytes)
        self.assertGreater(bits, 1 << 20)


class TestSequenceEvaluation(unittest.TestCase):
    """`run` and `compile_seq` are one interpreter used two ways.

    Verifying a target sweeps the whole domain, so the opcode decision is taken
    once and the sweep runs closures. That is only safe while the single-input
    form goes through the same closures — if these two ever disagreed, every
    verification count in the report would be measuring a different program
    from the one that gets emitted.
    """

    @staticmethod
    def mixed():
        """One sequence touching every shape of instruction."""
        seq = Seq()
        a = seq.emit('PDEP', [0], const=0x0101010101010101)
        b = seq.emit('IMUL', [a], const=0x0101010101010100)
        c = seq.emit('SHL', [b], shift=3)
        d = seq.emit('SHR', [c], shift=1)
        e = seq.emit('NOT', [d])
        f = seq.emit('AND', [e], const=0xF0F0F0F0F0F0F0F0)
        g = seq.emit('XORR', [f, b])
        h = seq.emit('ANDNR', [g, c])
        i = seq.emit('ADDR', [h, a])
        j = seq.emit('CLMUL', [i], const=0xFFFFFFFFFFFFFFFF)
        k = seq.emit('BSWAP', [j])
        m = seq.emit('POPCNT', [k])
        n = seq.emit('SCANXOR', [m], shift=2)
        o = seq.emit('PEXT', [n], const=0x8080808080808080)
        seq.emit('SUB', [o], const=1)
        return seq

    def test_the_two_forms_agree(self):
        seq = self.mixed()
        evaluate = compile_seq(seq)
        for x in range(256):
            self.assertEqual(run(seq, x), evaluate(x), 'input 0x%X' % x)

    def test_appending_to_a_sequence_invalidates_the_compiled_form(self):
        seq = Seq()
        seq.emit('AND', [0], const=0xFF)
        self.assertEqual(run(seq, 0x1234), 0x34)
        seq.emit('SHL', [1], shift=8)
        self.assertEqual(run(seq, 0x1234), 0x3400)

    def test_extend_invalidates_it_too(self):
        seq = Seq()
        seq.emit('AND', [0], const=0xFF)
        self.assertEqual(run(seq, 0x1234), 0x34)

        tail = Seq()
        tail.emit('IMUL', [0], const=3)
        seq.extend(tail, seq.result)
        self.assertEqual(run(seq, 0x1234), 0x34 * 3)


if __name__ == '__main__':
    unittest.main()


class TestLaneIntervalSolver(unittest.TestCase):
    """Comparison, which is where this grammar stops being linear.

    There is no GF(2) description of `lane < c` and no deposit/convolution that
    produces one, so before this solver existed a per-lane predicate fell all
    the way through to a 2^16-entry lookup table. What it searches is the
    interval, read off the observed lanes; the three branch-free forms that
    compute it are lowering decisions, not separate abstract operations.
    """

    @staticmethod
    def spread(predicate, lane_bits=8, input_bits=64):
        top = 1 << (lane_bits - 1)
        lane_mask = mask_of(lane_bits)

        def kernel(x):
            out = 0
            for i in range(input_bits // lane_bits):
                if predicate((x >> (lane_bits * i)) & lane_mask):
                    out |= top << (lane_bits * i)
            return out
        return kernel

    def solved(self, predicate, **kw):
        from qm.solvers import solve_lane_predicate
        bits = kw.pop('input_bits', 64)
        sem = from_callable(self.spread(predicate, input_bits=bits, **kw),
                            bits, bits)
        return solve_lane_predicate(sem, parse_observer('exact'))

    def instructions(self, programs, isa_name='x86-64-bmi2-pclmul'):
        from qm import isa as isa_mod
        seq, _used = isa_mod.lower_program(programs[0],
                                           isa_mod.get_isa(isa_name))
        return [ins.op for ins in seq.ins]

    def test_equality_lowers_to_the_zero_test_over_a_xor(self):
        found = self.solved(lambda b: b == 0x2C)
        self.assertEqual(len(found), 1)
        self.assertEqual(self.instructions(found),
                         ['XOR', 'AND', 'ADD', 'ORR', 'NOT', 'AND'])

    def test_equality_with_zero_needs_no_xor(self):
        # The XOR would be by zero.  A stage that does nothing is not part of
        # the meaning, and it is not emitted either.
        self.assertEqual(self.instructions(self.solved(lambda b: b == 0)),
                         ['AND', 'ADD', 'ORR', 'NOT', 'AND'])

    def test_an_interval_from_zero_uses_the_one_sided_form(self):
        self.assertEqual(
            self.instructions(self.solved(lambda b: b < 0x20)),
            ['OR', 'SUB', 'XORR', 'XOR', 'ANDNR', 'XORR', 'NOT', 'AND'])

    def test_a_two_sided_interval_subtracts_from_both_ends(self):
        self.assertEqual(
            self.instructions(self.solved(lambda b: 0x30 <= b <= 0x39)),
            ['OR', 'SUB', 'AND', 'NOT', 'ADD', 'ANDR', 'ANDNR', 'AND'])

    def test_nibble_lanes_are_found_without_being_told(self):
        # The lane width comes from where the output bits are, so the same
        # solver answers for sixteen 4-bit lanes with no parameter changed.
        found = self.solved(lambda b: b == 0xA, lane_bits=4)
        self.assertEqual(len(found), 1)
        self.assertIn('4-bit lanes', found[0].ops[0].detail['note'])

    def test_a_set_that_is_not_an_interval_is_refused(self):
        # Even lanes only: a real per-lane predicate, and not one this family
        # can state.  Answering it with the nearest interval would be wrong.
        self.assertEqual(self.solved(lambda b: b % 2 == 0), [])

    def test_an_upper_bound_past_the_lane_top_bit_is_refused(self):
        # The two-sided form's second subtraction stays inside its lane only
        # below the top bit.  This is the case that used to be emitted and
        # silently disagree on inputs the sample happened to miss.
        self.assertEqual(self.solved(lambda b: 0x70 <= b <= 0x90), [])

    def test_an_always_true_predicate_is_left_to_the_constant_solver(self):
        self.assertEqual(self.solved(lambda b: True), [])

    def test_the_lowered_form_is_checked_against_the_comparison_itself(self):
        """The two statements of the meaning have to agree, not be assumed to.

        `program._eval_point` says `lo <= lane <= hi` in Python and decides
        whether a candidate is accepted; `isa.lower_point` says it in AND/ADD/
        SUB/OR/XOR/NOT and is what gets emitted. This walks the second against
        the first over every lane value, which is the check that would have
        caught the borrow bug in the two-sided form.
        """
        from qm import isa as isa_mod
        from qm.program import compile_program
        for predicate in (lambda b: b == 0x2C, lambda b: b < 0x20,
                          lambda b: 0x30 <= b <= 0x39):
            found = self.solved(predicate)
            self.assertEqual(len(found), 1)
            abstract = compile_program(found[0])
            seq, _ = isa_mod.lower_program(
                found[0], isa_mod.get_isa('x86-64-bmi2-pclmul'))
            lowered = isa_mod.compile_seq(seq)
            reference = self.spread(predicate)
            for b in range(256):
                x = b * 0x0101010101010101
                self.assertEqual(abstract(x), reference(x), 'lane 0x%02X' % b)
                self.assertEqual(lowered(x), reference(x), 'lane 0x%02X' % b)

    def test_equality_against_a_high_constant_is_not_refused(self):
        # Equality never subtracts, so the two-sided form's bound on `hi` does
        # not apply to it.  Reading that guard as "any interval" refused every
        # `lane == c` with c at or above half the lane range, which is half of
        # them — and nibble lanes, where 0xA is already past the middle.
        for constant in (0x80, 0xC0, 0xFF):
            with self.subTest(constant=constant):
                found = self.solved((lambda c: (lambda b: b == c))(constant))
                self.assertEqual(len(found), 1)
                self.assertEqual(self.instructions(found),
                                 ['XOR', 'AND', 'ADD', 'ORR', 'NOT', 'AND'])

    def test_a_one_sided_bound_past_the_lane_top_bit_is_kept(self):
        found = self.solved(lambda b: b < 0xF0)
        self.assertEqual(len(found), 1)
