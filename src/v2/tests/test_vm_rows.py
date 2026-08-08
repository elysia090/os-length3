"""Section 3.2 — the direct physical normal form, and what §3.7 counts.

Section 3.1 says what a transition means; 3.2 says what it is. They are not the
same object: 3.1 reads five cells per step, 3.2 keeps those reads resolved in a
row and repairs them by broadcast when memory changes. The specification
requires both — §8.4 asks for "one transactional rSUBLEQ instruction *and its
direct physical form*" — and names dropping an independent row component or
omitting a special-row repair as changes of semantics.

So the first thing here is that the two forms agree on outcomes, and the rest
is the falsification list: break one incidence, skip one repair, and require
the disagreement to show.
"""

import unittest

from vm import codec, image, machine, rows

from tests.test_vm import ECHO, artifact


def opened():
    return machine.open_payload(codec.unpack(artifact(ECHO)))


def physical_future(residual, history, budget=1 << 20):
    """`feed*` then `read`, entirely in the 3.2 form."""
    scratch = dict(residual.image.memory)
    for byte in history:
        if byte:
            scratch[0] = byte
        else:
            scratch.pop(0, None)
        event, _cost = rows.run(scratch, residual.image.pc_feed, budget)
        if event != machine.COMMIT:
            return None
    copy = dict(scratch)                       # a read commits nothing
    event, _cost = rows.run(copy, residual.image.pc_out, budget)
    if event != machine.EMIT:
        return None
    out = copy.get(1, 0)
    return out if 0 <= out < 256 else None


class TestTheTwoFormsAgree(unittest.TestCase):
    """Same outcomes, different machine. That is the whole obligation."""

    def test_every_single_byte_history(self):
        residual = opened()
        self.assertEqual([physical_future(residual, [b]) for b in range(256)],
                         [machine.future(residual, [b]) for b in range(256)])

    def test_multi_byte_histories(self):
        residual = opened()
        for history in ([], [0], [7, 200], [1, 2, 3], [255, 0, 255]):
            with self.subTest(history=history):
                self.assertEqual(physical_future(residual, history),
                                 machine.future(residual, history))

    def test_a_read_commits_nothing_here_either(self):
        residual = machine.feed(opened(), 77)
        before = dict(residual.image.memory)
        for _ in range(3):
            self.assertEqual(physical_future(residual, []), 77)
        self.assertEqual(residual.image.memory, before)

    def test_it_agrees_on_a_compiled_kernel(self):
        from qm.pipeline import solve
        from vm import lower
        from tests.support import read_example

        result = solve(read_example('starts8.c'), frontend='cfront')
        picture = lower.lower_program(result['program_object'], 8, 64)
        residual = machine.Residual(picture)
        for value in (0, 1, 5, 170, 255):
            with self.subTest(input=value):
                # One input byte, then the first output byte.
                self.assertEqual(physical_future(residual, [value]),
                                 machine.future(residual, [value]))


class TestWhatSectionThreeSevenCounts(unittest.TestCase):
    """The cost model is the incidence structure, not the instruction count."""

    def cost(self, history=(65,)):
        return rows.measure(opened(), history)

    def test_span_is_one_per_transition(self):
        cost = self.cost()
        self.assertEqual(cost.span, cost.transitions)

    def test_work_is_the_capture_plus_its_incidences(self):
        cost = self.cost()
        self.assertEqual(cost.work, cost.transitions + cost.incidences)

    def test_a_quiet_transition_costs_only_its_capture(self):
        # `change == 0` means no store, no propagation, no repair and no
        # barrier. Half the echo machine's transitions are quiet.
        cost = self.cost()
        self.assertGreater(cost.quiet, 0)
        self.assertLessEqual(cost.barriers, cost.transitions - cost.quiet)

    def test_a_shared_scratch_is_what_the_model_charges_for(self):
        """The finding this section exists to make visible.

        Every `add` used to go through one scratch cell, so writing it cost one
        incidence per row that read it — 98.9% of `ranks8`'s work sat on that
        single coordinate. A private scratch per add costs more L(z) and 40
        times less work, and work precedes L(z) in the objective.
        """
        from qm.pipeline import solve
        from vm import lower
        from tests.support import read_example

        result = solve(read_example('ranks8.c'), frontend='cfront')
        picture = lower.lower_program(result['program_object'], 8, 64)
        cost = rows.measure(machine.Residual(picture), [5])

        # No single coordinate may carry most of the work any more.
        charged = {}
        original = rows.Rows.propagate

        def traced(self, written, change, cost_):
            touched = original(self, written, change, cost_)
            charged[written] = charged.get(written, 0) + touched
            return touched

        rows.Rows.propagate = traced
        try:
            rows.measure(machine.Residual(picture), [5])
        finally:
            rows.Rows.propagate = original

        worst = max(charged.values()) if charged else 0
        self.assertLess(worst, cost.incidences * 0.5,
                        'one coordinate carries most of the work again')


class TestHowFarTheLoweringIsFromTheMachine(unittest.TestCase):
    """`vm/README.md` blames the gap on two decisions. This checks the claim.

    The measurement is `tools/measure_multiply.py`: one function — the
    `CONV(IMUL)` stage of `ranks8` — written three ways and run on the same 256
    inputs. The exact numbers are in the README and will move; what must not
    move without the README moving with it is which form beats which.
    """

    table = None

    @classmethod
    def setUpClass(cls):
        import os
        import sys
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if here not in sys.path:
            sys.path.insert(0, here)
        from tools import measure_multiply
        # One measurement for the three claims about it: it builds three
        # programs and runs each on 256 inputs, and doing that per test was
        # three quarters of this file's time.
        cls.table = measure_multiply.measure()

    def test_the_looped_word_level_form_wins_on_every_coordinate(self):
        """This is the whole claim: the gap is the lowering's, not the machine's.

        `(span, work, L(z), rank)` is lexicographic, so a form that loses on
        none of them is better outright — no trade to argue about.
        """
        today = self.table['bit-sliced, unrolled (today)']
        looped = self.table['word-level, looped']
        cells, length, span, work = looped
        self.assertLess(span, today[2])
        self.assertLess(work, today[3])
        self.assertLess(length, today[1])
        self.assertLess(cells, today[0])

    def test_unrolling_buys_span_and_sells_work(self):
        """Why "add loops" is not the whole answer.

        Unrolled has no loop counter to maintain, so it takes fewer
        transitions and therefore less span. It pays in work: every unrolled
        copy that reads a hot cell is another row §3.2 has to repair.
        """
        unrolled = self.table['word-level, unrolled']
        looped = self.table['word-level, looped']
        self.assertLess(unrolled[2], looped[2])          # span
        self.assertGreater(unrolled[3], looped[3])       # work

    def test_bit_slicing_costs_an_order_of_magnitude_of_length(self):
        today = self.table['bit-sliced, unrolled (today)']
        word = self.table['word-level, unrolled']
        self.assertGreater(today[1], 4 * word[1])


DIVERGED = 'diverged'


def looping_machine():
    """A machine that re-enters its rows: `acc += t; t += t`, three rounds.

    Propagation exists for exactly this. A straight-line program enters each
    row once, materializes it fresh on arrival and never reads a stale cache —
    so breaking (3.5) on the echo machine changes nothing and proves nothing.
    A row entered *again* after a cell it reads was written is the case.

    Both sides have to move, too. An earlier version accumulated a value that
    did not change between rounds, and a stale cache of an unchanging value is
    indistinguishable from a fresh one: only the destination-side rule
    falsified, and the source-side rule looked unnecessary.
    """
    from vm import asm as A

    a = A.Asm()
    t = a.cell('t')
    acc = a.cell('acc')
    i = a.cell('i')
    one = a.cell('one', 1)
    three = a.cell('three', 3)
    out_entry = a.label('out')
    feed_entry = a.label('feed')
    top = a.label('top')
    done = a.label('done')

    a.place(feed_entry)
    a.move(A.Asm.INPUT, t)
    a.clear(acc)
    a.move(three, i)
    a.place(top)
    a.if_le_zero(i, done)
    a.add(t, acc)                      # destination side: acc moves
    a.add(t, t)                        # source side: t moves
    a.sub(one, i)
    a.goto(top)
    a.place(done)
    a.halt(A.COMMIT)

    a.place(out_entry)
    a.move(acc, A.Asm.OUTPUT)
    a.halt(A.EMIT)
    return machine.Residual(a.build(out_entry, feed_entry))


def self_modifying_machine():
    """A loop that rewrites an operand word of an instruction it re-enters.

    Writing coordinate `d` moves the *descriptors* of the rows at `d`, `d-1`
    and `d-2` — §3.2 calls them special and rebuilds them whole. Repairing the
    cached operands and leaving the descriptors stale is the case this is for.
    """
    from vm import asm as A

    a = A.Asm()
    acc = a.cell('acc')
    i = a.cell('i')
    one = a.cell('one', 1)
    two = a.cell('two', 2)
    # Negative, so `acc -= M[first]` accumulates upward and the result is a
    # byte the read can actually emit.
    first = a.cell('first', -10)
    second = a.cell('second', -100)
    out_entry = a.label('out')
    feed_entry = a.label('feed')
    top = a.label('top')
    done = a.label('done')

    a.place(feed_entry)
    a.clear(acc)
    a.move(two, i)
    a.place(top)
    a.if_le_zero(i, done)
    patched = len(a)                    # `acc -= M[first]`, source rewritten
    a.subleq(first, acc)
    # Advance that instruction's source operand from `first` to `second`.
    a.subleq(one, 0)                    # placeholder, rewritten after build
    rewrite = len(a) - 1
    a.sub(one, i)
    a.goto(top)
    a.place(done)
    a.halt(A.COMMIT)

    a.place(out_entry)
    a.move(acc, A.Asm.OUTPUT)
    a.halt(A.EMIT)

    picture = a.build(out_entry, feed_entry)
    # `M[source_word] -= M[minus_one]` advances it by one address.
    source_word = a.code_address(patched)
    minus_one = a.cell('minus_one', -1)
    minus_one.address = max(picture.memory) + 1
    picture.memory[minus_one.address] = -1
    base = a.code_address(rewrite)
    picture.memory[base] = minus_one.address
    picture.memory[base + 1] = source_word
    return machine.Residual(picture), (first, second)


class TestTheFalsificationList(unittest.TestCase):
    """§3: dropping an independent row component, or omitting a special-row
    repair, changes semantics. Both must show."""

    INPUTS = (0, 1, 5, 30)

    def setUp(self):
        self.residual = looping_machine()
        self.want = [machine.future(self.residual, [b]) for b in self.INPUTS]
        # Three rounds of `acc += t; t += t`, so the answer is 7x.
        self.assertEqual(self.want, [7 * b for b in self.INPUTS])
        self.assertEqual([physical_future(self.residual, [b], self.BUDGET)
                          for b in self.INPUTS], self.want)

    # The whole answer takes 44 transitions, so anything past a few hundred is
    # a loop that is not going to end. Waiting out the default million-step
    # budget four times over cost 11 seconds -- more than every other vm test
    # put together -- to learn what 300 says.
    BUDGET = 300

    def broken(self, patch, residual=None, inputs=None):
        """Answers with 3.2 partly disabled.

        Diverging counts as a changed answer, and it is the usual one: a stale
        loop counter is a loop that does not end.
        """
        residual = residual or self.residual
        inputs = self.INPUTS if inputs is None else inputs
        original = rows.Rows.propagate
        rows.Rows.propagate = patch
        try:
            out = []
            for byte in inputs:
                try:
                    out.append(physical_future(residual, [byte], self.BUDGET))
                except machine.Unfinished:
                    out.append(DIVERGED)
            return out
        finally:
            rows.Rows.propagate = original

    def test_dropping_the_stale_old_component_changes_the_answer(self):
        """A row whose destination was written is holding an old `old`."""
        def no_old(self, written, change, cost):
            for at in self.by_source.get(written, ()):
                if self.destination[at] != written:
                    self.change[at] -= change
            for offset in (0, 1, 2):
                if self.resident(written - offset):
                    self.materialize(written - offset)
            return 0
        self.assertNotEqual(self.broken(no_old), self.want)

    def test_dropping_the_stale_change_component_changes_the_answer(self):
        """A row whose source was written is holding an old `change`."""
        def no_change(self, written, change, cost):
            special = {written, written - 1, written - 2}
            for at in self.by_destination.get(written, ()):
                if at not in special:
                    self.old[at] += change
            for offset in (0, 1, 2):
                if self.resident(written - offset):
                    self.materialize(written - offset)
            return 0
        self.assertNotEqual(self.broken(no_change), self.want)

    def test_dropping_the_whole_wave_changes_the_answer(self):
        def nothing(self, written, change, cost):
            return 0
        self.assertNotEqual(self.broken(nothing), self.want)

    def test_omitting_the_special_row_repair_changes_the_answer(self):
        """Rows d, d-1 and d-2 hold the written cell as a *descriptor*.

        Repairing the cached operands and not the descriptors is exactly the
        self-modification case, which is why §3.1 fetches all three operands
        before the write.
        """
        residual, _cells = self_modifying_machine()
        want = [machine.future(residual, [0])]

        def no_repair(self, written, change, cost):
            special = {written, written - 1, written - 2}
            touched = 0
            for at in self.by_destination.get(written, ()):
                if at not in special:
                    self.old[at] += change
                    touched += 1
            for at in self.by_source.get(written, ()):
                if at not in special and self.destination[at] != written:
                    self.change[at] -= change
                    touched += 1
            return touched                     # descriptors left stale

        self.assertNotEqual(self.broken(no_repair, residual, [0]), want)
