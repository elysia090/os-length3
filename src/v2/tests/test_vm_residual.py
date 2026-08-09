"""The two paths through the residual ABI, held to each other.

`machine.py` is the open-state path: open once, then feed and read a residual
that is never serialized again. `residual.py` is the code-level one: a byte
takes a payload to another payload, and the interface is over global codewords.

The interface requires both paths to agree, which no suite with only one path
can check. The port originally had one path.

The obligations, written out rather than paraphrased:

    future(feed*(R, p)) = after(future(R), p)
    [[res(z, a)]](h)    = [[z]]([a] || h)
    emit(code(z))       = read(open(pack(code(z))))
    next(code(z), a)    = code(res(z, a))
"""

import unittest

from vm import codec, image, machine, residual, seed

from tests.test_vm import ECHO

HISTORIES = [(), (0,), (7,), (255,), (1, 2), (9, 0, 200), (255, 255, 0, 1)]


def payload_of(picture):
    return image.serialize(picture)


class TestTheSoleSemanticObligation(unittest.TestCase):
    """Moving a prefix into the state must preserve every suffix result."""

    def check(self, start):
        observe = residual.future_of(start)
        for prefix in HISTORIES:
            with self.subTest(prefix=prefix):
                moved = residual.future_of(machine.feed_all(start, prefix))
                shifted = residual.after(observe, prefix)
                for suffix in HISTORIES:
                    self.assertEqual(moved(suffix), shifted(suffix),
                                     'prefix %r suffix %r' % (prefix, suffix))

    def test_on_the_initial_object(self):
        self.check(seed.residual())

    def test_on_a_compiled_kernel(self):
        from qm.pipeline import solve
        from tests.support import read_example, vm_picture

        result = solve(read_example('starts8.c'), frontend='cfront')
        picture = vm_picture(result)
        self.check(machine.Residual(picture))


class TestResidualizationIsSubstitution(unittest.TestCase):
    """Running the residual is running the whole history."""

    def check(self, payload, alphabet=(0, 1, 5, 128, 255)):
        for byte in alphabet:
            shorter = residual.res(payload, byte)
            for history in HISTORIES:
                with self.subTest(byte=byte, history=history):
                    self.assertEqual(residual.meaning(shorter, history),
                                     residual.meaning(payload,
                                                      (byte,) + history))

    def test_on_the_initial_object(self):
        self.check(payload_of(seed.ECHO))

    def test_on_the_hand_written_echo(self):
        self.check(payload_of(ECHO))

    def test_a_multi_byte_history_is_never_reversed(self):
        """Residualizing the final byte first changes the history order.

        It is also the mistake that looks right: for the echo machine only the
        last byte survives, so folding from the wrong end still answers
        correctly on single bytes and fails only from two on.
        """
        payload = payload_of(seed.ECHO)
        for data in ((1, 2), (7, 0, 200), (255, 3, 3, 9)):
            with self.subTest(data=data):
                forward = residual.res_all(payload, data)
                backward = residual.res_all(payload, tuple(reversed(data)))
                self.assertEqual(residual.meaning(forward, ()),
                                 residual.meaning(payload, data))
                self.assertNotEqual(residual.meaning(backward, ()),
                                    residual.meaning(forward, ()))


class TestTheTwoPathsAgree(unittest.TestCase):
    """The open-state and code-level paths must remain observationally equal."""

    def setUp(self):
        self.payload = payload_of(seed.ECHO)
        self.start = machine.open_payload(self.payload)

    def test_code_level_and_open_state_read_the_same_byte(self):
        for data in HISTORIES:
            with self.subTest(data=data):
                code_side = residual.emit(
                    codec.code(residual.res_all(self.payload, data)))
                open_side = machine.read(machine.feed_all(self.start, data))
                self.assertEqual(code_side, open_side)

    def test_next_over_codewords_is_code_of_res(self):
        """The codeword successor is the code of the residualized payload."""
        word = codec.code(self.payload)
        for byte in (0, 1, 42, 255):
            with self.subTest(byte=byte):
                self.assertEqual(residual.next_code(word, byte),
                                 codec.code(residual.res(self.payload, byte)))

    def test_the_artifact_survives_the_round_trip_each_time(self):
        """A byte at a time, packed and unpacked, still tracks the fast path."""
        blob = residual.artifact_of(self.payload)
        start = self.start
        for byte in (3, 0, 200, 17):
            blob = residual.next_artifact(blob, byte)
            start = machine.feed(start, byte)
            with self.subTest(byte=byte):
                self.assertEqual(machine.read(residual.open_artifact(blob)),
                                 machine.read(start))

    def test_it_agrees_on_a_compiled_kernel(self):
        from qm.pipeline import solve
        from tests.support import read_example, vm_picture

        result = solve(read_example('starts8.c'), frontend='cfront')
        picture = vm_picture(result)
        payload = payload_of(picture)
        start = machine.Residual(picture)
        for byte in (0, 1, 5, 170, 255):
            with self.subTest(byte=byte):
                self.assertEqual(
                    residual.emit(codec.code(residual.res(payload, byte))),
                    machine.read(machine.feed(start, byte)))


class TestNothingEscapesTheCode(unittest.TestCase):
    """The code path is total and maps every malformed input to one dead state."""

    def test_a_malformed_codeword_is_the_dead_residual(self):
        for word in ('', '0', '1', '10', codec.code('0101') + '1'):
            with self.subTest(word=word):
                self.assertIs(residual.emit(word), machine.BOTTOM)

    def test_a_failed_feed_gives_the_one_dead_payload(self):
        # `pc_feed` at a cell whose branch is FAIL: the feed cannot commit.
        picture = image.Image({3: 2, 4: 2, 5: -3}, pc_out=3, pc_feed=3)
        self.assertEqual(residual.res(payload_of(picture), 7),
                         residual.DEAD_PAYLOAD)

    def test_the_dead_payload_stays_dead_and_reads_nothing(self):
        dead = residual.DEAD_PAYLOAD
        self.assertIs(residual.meaning(dead, ()), machine.BOTTOM)
        self.assertEqual(residual.res(dead, 5), dead)

    def test_a_malformed_artifact_opens_dead_rather_than_raising(self):
        self.assertTrue(residual.open_artifact(b'\xff\xff').dead)
        self.assertTrue(residual.open_artifact(b'').dead)


class TestWhatTheCodeCosts(unittest.TestCase):
    """Residuals expose the same length and rank as their global codewords."""

    def test_length_and_rank_are_the_codec_s(self):
        payload = payload_of(seed.ECHO)
        self.assertEqual(residual.length(payload), codec.length(payload))
        self.assertEqual(residual.rank(payload), codec.rank(payload))

    def test_feeding_a_byte_does_not_shrink_this_lowering(self):
        """The finding, stated as a test so it cannot quietly stop being true.

        `res` is a residualizer, and residuals rank by `L` and `rank`. This
        lowering's `feed` only stores the byte — it folds nothing through the
        computation — so the residual comes out *longer* than what it came
        from. When the lowering learns to specialize, this test is what says
        so, and it should then be inverted rather than deleted.
        """
        from qm.pipeline import solve
        from tests.support import read_example, vm_picture

        result = solve(read_example('starts8.c'), frontend='cfront')
        payload = payload_of(vm_picture(result))
        shorter = residual.res(payload, 5)
        self.assertGreater(residual.length(shorter), residual.length(payload))
