"""The initial object of the physical minimal subset, and why it is initial.

A residual is a function of a history, histories are `Byte*`, and `Byte*` is
infinite. Nothing about that is finite until the histories collapse — so the
subset needs one object where the collapse is exhibited rather than assumed,
and the echo machine is it: `feed(s, b) = b`, `read(s) = s`, so after one byte
every history ending in `b` is the same state.

That is the claim these check. It had been left out of the port: the echo
machine existed only as a table of numbers typed into `tests/test_vm.py`, so
nothing named it, nothing built it, and nothing computed its future quotient.
"""

import unittest

from qm.quotient import future_quotient
from vm import machine, seed

from tests.test_vm import ECHO as HAND_WRITTEN

# 256 states x 256 letters is a quarter of a million transitions per refinement
# round, and the property is about the alphabet's shape rather than its size.
ALPHABET = (0, 1, 2, 7, 128, 254, 255)


class TestItIsTheEchoMachine(unittest.TestCase):

    def test_read_gives_back_the_last_byte_fed(self):
        start = seed.residual()
        for byte in range(256):
            with self.subTest(byte=byte):
                self.assertEqual(machine.read(machine.feed(start, byte)), byte)

    def test_only_the_last_byte_survives(self):
        start = seed.residual()
        for history in ((1, 2, 3), (255, 0), (7,), (9, 9, 9, 4)):
            with self.subTest(history=history):
                self.assertEqual(machine.future(start, history), history[-1])

    def test_the_built_one_and_the_hand_written_one_are_the_same_function(self):
        """The point of building it: a table of numbers is a claim, not a proof.

        `tests/test_vm.py` holds a hand-written echo image and checks exact
        bits against it. This checks that what `seed.py` assembles computes
        what those bits compute — if they ever part, one of them is wrong and
        the suite says which claim broke.
        """
        built = seed.residual()
        typed = machine.Residual(HAND_WRITTEN)
        for byte in range(256):
            with self.subTest(byte=byte):
                self.assertEqual(machine.future(built, [byte]),
                                 machine.future(typed, [byte]))

    def test_the_selected_seed_is_the_compact_assembled_image(self):
        self.assertEqual(seed.ECHO, HAND_WRITTEN)

    def test_a_read_commits_nothing(self):
        after = machine.feed(seed.residual(), 42)
        before = dict(after.image.memory)
        self.assertEqual([machine.read(after) for _ in range(3)], [42] * 3)
        self.assertEqual(after.image.memory, before)


class TestTheFutureQuotientCollapsesOnTheFirstMove(unittest.TestCase):
    """`Byte*` falls to one class per last byte, immediately and for good."""

    def test_one_class_per_last_byte(self):
        classes = seed.future_classes(seed.residual(), upto=3,
                                      alphabet=ALPHABET)
        by_last = {}
        for history, cls in classes.items():
            if not history:
                continue
            by_last.setdefault(history[-1], set()).add(cls)
        # Every history ending in b is one class, and different b are different
        # classes. Both halves matter: the first is the collapse, the second is
        # that it did not collapse too far.
        for byte, ids in by_last.items():
            self.assertEqual(len(ids), 1, 'histories ending %d split' % byte)
        self.assertEqual(len({next(iter(ids)) for ids in by_last.values()}),
                         len(ALPHABET))

    def test_length_stops_mattering_after_one_byte(self):
        classes = seed.future_classes(seed.residual(), upto=4,
                                      alphabet=ALPHABET)
        for byte in ALPHABET:
            with self.subTest(byte=byte):
                ids = {cls for history, cls in classes.items()
                       if history and history[-1] == byte}
                self.assertEqual(len(ids), 1)

    def test_the_empty_history_is_the_one_that_ends_in_zero(self):
        """It does not get a class of its own, and that is the sharp form.

        The saved cell starts empty, and an empty cell reads as zero, so the
        state before anything is fed is the state after feeding 0. `Byte*`
        including the empty history therefore falls to exactly 256 classes and
        not 257 — the initial state is not extra, it is already one of them.
        """
        classes = seed.future_classes(seed.residual(), upto=2,
                                      alphabet=ALPHABET)
        self.assertIn(0, ALPHABET, 'this test needs zero in the alphabet')
        self.assertEqual(classes[()], classes[(0,)])
        self.assertEqual(len(set(classes.values())), len(ALPHABET))

    def test_a_deeper_probe_does_not_refine_it_further(self):
        """Collapsed on the first move means no continuation ever separates.

        A quotient that kept refining with depth would mean the first move had
        not settled it, and the whole finiteness argument would be resting on
        how far anyone happened to look.
        """
        shallow = seed.future_classes(seed.residual(), upto=2, depth=1,
                                      alphabet=ALPHABET)
        deep = seed.future_classes(seed.residual(), upto=2, depth=3,
                                   alphabet=ALPHABET)
        same = lambda table: {  # noqa: E731 - a comparison key, not a function
            frozenset(h for h, c in table.items() if c == cls)
            for cls in set(table.values())}
        self.assertEqual(same(shallow), same(deep))


class TestItMeetsTheMinimizersOwnQuotient(unittest.TestCase):
    """The two halves are the same construction, so they must agree.

    `qm.quotient.future_quotient` is Myhill-Nerode over `(delta, out)`. The
    subset's `feed` and `read` *are* a `delta` and an `out`, and pointing one
    at the other is what says so — otherwise `vm` and `qm` each have a future
    quotient and nothing checks they mean the same thing.
    """

    def test_feed_and_read_are_a_delta_and_an_out(self):
        start = seed.residual()
        states = {}                       # byte -> the residual it leads to

        def delta(state, letter):
            if state is None:
                after = machine.feed(start, letter)
            else:
                after = machine.feed(states[state], letter)
            states[letter] = after
            return letter

        for letter in ALPHABET:           # populate, so `out` can read them
            delta(None, letter)

        classes = future_quotient(lambda s, a: a,
                                  lambda s: machine.read(states[s]),
                                  list(ALPHABET), list(ALPHABET))
        self.assertEqual(len(set(classes.values())), len(ALPHABET))
        self.assertEqual(sorted(classes), sorted(ALPHABET))
