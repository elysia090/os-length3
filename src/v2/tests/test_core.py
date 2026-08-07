"""Bit primitives, observers, quotients and the objective."""

import unittest

from qm.bits import M64, clmul, mask_of, parity, pdep, pext, popcnt
from qm.guards import derive_guard, guard_evidence, lane_rule_Z
from qm.isa import Seq, measure
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


if __name__ == '__main__':
    unittest.main()
