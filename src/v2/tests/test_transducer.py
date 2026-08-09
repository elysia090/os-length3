"""Exact stateful quotient compilation and its VM boundary."""

import unittest

from qm.transducer import (CoordinateCell, PhysicalMap, StateLimit,
                           compile_transducer)
from qm.vmquotient import (FutureMismatch, choose_equivalent, compile_residual,
                           dense_physical_key, same_future)
from vm import machine, seed


def padded_echo():
    """The echo future with deliberately redundant VM transitions."""
    from vm import asm

    build = asm.Asm()
    saved = build.cell('saved')
    padding = build.cell('padding')
    out_entry = build.label('read')
    feed_entry = build.label('feed')

    build.place(out_entry)
    build.clear(padding)
    build.move(saved, asm.Asm.OUTPUT)
    build.clear(padding)
    build.halt(asm.EMIT)

    build.place(feed_entry)
    build.clear(padding)
    build.move(asm.Asm.INPUT, saved)
    build.clear(padding)
    build.halt(asm.COMMIT)
    return machine.Residual(build.build(out_entry, feed_entry))


class TestFiniteTransducer(unittest.TestCase):

    def test_coordinate_cells_carry_ranks_until_observation(self):
        cell = CoordinateCell(5)
        self.assertEqual(cell.to_dict(), {
            'descriptor_word': 104,
            'ell': 4, 'capacity': 8, 'region': [0, 5]})
        self.assertEqual(cell.select(3), 11)
        self.assertEqual(cell.rank(11), 3)
        self.assertEqual(cell.cut(2), ((0, 2), (2, 5)))

    def test_descriptor_word_matches_the_kraft_cell_round_trip_anchor(self):
        # Cell(5) has 16 coordinate slots and the documented descriptor 106.
        cell = CoordinateCell(16)
        self.assertEqual((cell.ell, cell.word, cell.capacity), (5, 106, 16))

    def test_physical_maps_choose_closed_coordinate_forms(self):
        constant = PhysicalMap([7] * 8)
        affine = PhysicalMap([3 + 5 * rank for rank in range(8)])
        dense = PhysicalMap([0, 1, 4, 9])
        self.assertEqual((constant.kind, constant.storage_cells),
                         ('constant', 1))
        self.assertEqual((affine.kind, affine.storage_cells), ('affine', 2))
        self.assertEqual((dense.kind, dense.storage_cells), ('dense', 4))
        self.assertEqual([affine.at(rank) for rank in range(8)],
                         [3 + 5 * rank for rank in range(8)])

    def test_future_equivalent_reachable_states_are_merged(self):
        # The high bit is redundant: observations and successors depend only
        # on the low bit, so four reachable representations have two futures.
        compiled = compile_transducer(
            0,
            lambda state, letter: ((state << 1) | letter) & 3,
            lambda state: state & 1,
            alphabet=(0, 1),
            max_states=4,
        )
        self.assertEqual(compiled.reachable_states, 4)
        self.assertEqual(compiled.classes, 2)
        for history in ((), (0,), (1,), (1, 0, 1), (0, 1, 1, 0)):
            expected = 0
            for letter in history:
                expected = ((expected << 1) | letter) & 3
            _state, observed = compiled.run(history)
            self.assertEqual(observed, expected & 1)

    def test_an_open_graph_is_not_mistaken_for_a_finite_quotient(self):
        with self.assertRaises(StateLimit):
            compile_transducer(0, lambda state, _letter: state + 1,
                               lambda _state: 0, alphabet=(0,),
                               max_states=16)

    def test_unknown_letters_and_states_are_rejected(self):
        compiled = compile_transducer(
            0, lambda _state, letter: letter, lambda state: state,
            alphabet=(0, 1), max_states=2)
        with self.assertRaises(ValueError):
            compiled.step(compiled.initial, 2)
        with self.assertRaises(ValueError):
            compiled.out(99)


class TestTheVmCanBeQuotientCompiled(unittest.TestCase):
    """The generic VM becomes a table machine when its future closes."""

    @classmethod
    def setUpClass(cls):
        cls.start = seed.residual()
        cls.compiled = compile_residual(cls.start, max_states=256)

    def test_echo_closes_to_exactly_one_class_per_last_byte(self):
        self.assertEqual(self.compiled.reachable_states, 256)
        self.assertEqual(self.compiled.classes, 256)

    def test_table_execution_agrees_with_the_vm_on_histories(self):
        histories = ((), (0,), (7,), (255,), (1, 2),
                     (9, 0, 200), (255, 255, 0, 1))
        for history in histories:
            with self.subTest(history=history):
                _state, observed = self.compiled.run(history)
                self.assertEqual(observed,
                                 machine.future(self.start, history))

    def test_compiled_step_is_one_dense_lookup(self):
        state = self.compiled.initial
        state = self.compiled.step(state, 42)
        self.assertEqual(self.compiled.out(state), 42)
        self.assertEqual(self.compiled.transitions[state][7],
                         self.compiled.step(state, 7))

    def test_echo_is_the_letter_projection_not_a_square_table(self):
        report = self.compiled.to_dict()['build_form']
        transitions = report['transitions']
        self.assertEqual(transitions['unique_rows'], 1)
        self.assertEqual(transitions['row_selector']['kind'], 'constant')
        self.assertEqual(transitions['row_forms'][0]['kind'], 'affine')
        # output(rank)=rank, row(state)=0, delta(row,letter)=letter.
        self.assertEqual(report['outputs']['kind'], 'affine')
        self.assertEqual(report['storage_cells'], 5)

    def test_independently_opened_echoes_have_the_same_complete_future(self):
        from tests.test_vm import ECHO
        self.assertTrue(same_future(self.start, machine.Residual(ECHO),
                                    max_states=256))

    def test_future_proof_precedes_physical_candidate_selection(self):
        from tests.test_vm import ECHO
        candidates = [('built', self.start),
                      ('compact', machine.Residual(ECHO))]
        keys = {name: dense_physical_key(residual, max_states=256)
                for name, residual in candidates}
        chosen = choose_equivalent(
            candidates,
            objective=lambda candidate: keys[candidate[0]],
            max_states=256,
        )
        self.assertEqual(chosen[0], 'built')
        self.assertEqual(keys['compact'], keys['built'])

    def test_a_different_future_cannot_enter_the_physical_order(self):
        dead = machine.DEAD_RESIDUAL
        with self.assertRaises(FutureMismatch):
            choose_equivalent(
                [('echo', self.start), ('dead', dead)],
                objective=lambda candidate: (len(candidate[1].image.memory),),
                max_states=256,
            )

    def test_same_future_vm_replacement_reduces_the_hot_transition_chain(self):
        from tests.test_vm import ECHO
        compact = machine.Residual(ECHO)
        slow = padded_echo()
        keys = {
            'slow': dense_physical_key(slow, max_states=256),
            'compact': dense_physical_key(compact, max_states=256),
        }
        chosen = choose_equivalent(
            [('slow', slow), ('compact', compact)],
            objective=lambda candidate: keys[candidate[0]],
            max_states=256,
        )
        self.assertEqual(chosen[0], 'compact')
        self.assertLess(keys['compact'][0], keys['slow'][0])
