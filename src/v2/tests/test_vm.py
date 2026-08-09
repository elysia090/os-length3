"""Pinf-R codec -> image -> vm, and the wasm build held to the same laws.

The specification names, for each layer, exactly what must be made false. This
module does that: every test here breaks one invariant on purpose and requires
the implementation to reject rather than to guess.

`vm/*.py` is the definition and `vm/wasm/vm.c` is the fast path. They are
two independent statements of the same machine, so the last class runs the
compiled module against the reference rather than assuming they agree.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from vm import codec, image, machine

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WASM_SOURCE = os.path.join(ROOT, 'vm', 'wasm', 'vm.c')

# An echo machine, written by hand.  Cells 0 and 1 are the input and output
# cells and cell 2 is scratch; cell 9 is absent, which reads as the zero the
# instruction at pc 9 wants.
#
#   read:  M[1] -= M[1]      -> 0
#          M[2] -= M[2]      -> 0
#          M[2] -= M[0]      -> -input
#          M[1] -= M[2]      -> input
#          M[2] -= M[2] <= 0 -> EMIT
#   feed:  M[2] -= M[2] <= 0 -> COMMIT, keeping the byte already in cell 0
ECHO = image.Image({
    3: 1,  4: 1,  5: 6,
    6: 2,  7: 2,  8: 9,
           10: 2, 11: 12,
    12: 2, 13: 1, 14: 15,
    15: 2, 16: 2, 17: -1,
    18: 2, 19: 2, 20: -2,
}, pc_out=3, pc_feed=18)


def artifact(picture):
    return codec.pack(codec.code(image.serialize(picture)))


def opened(picture=ECHO):
    return machine.open_payload(codec.unpack(artifact(picture)))


class TestScalarCode(unittest.TestCase):
    """Completeness is the property, not a nicety."""

    def test_the_code_is_complete(self):
        # sum 2^-|E(n)| = 1.  Out to 2^k the tail left over is exactly 2^-(k+1),
        # which is the statement that nothing is wasted and nothing is claimed
        # twice.
        for width in (4, 8, 12, 16):
            with self.subTest(width=width):
                total = sum(2 ** -len(codec.encode_scalar(n))
                            for n in range(1 << width))
                self.assertEqual(total, 1 - 2 ** -(width + 1))

    def test_words_decode_back_out_of_a_concatenation(self):
        # Prefix-freedom, stated as the thing it exists for: a stream of words
        # needs no separator and no lookahead.
        bits = ''.join(codec.encode_scalar(n) for n in range(500))
        at, out = 0, []
        for _ in range(500):
            value, at = codec.decode_scalar(bits, at)
            out.append(value)
        self.assertEqual(out, list(range(500)))
        self.assertEqual(at, len(bits))

    def test_a_truncated_word_is_rejected(self):
        full = codec.encode_scalar(1000)
        for cut in range(1, len(full)):
            with self.subTest(cut=cut):
                with self.assertRaises(codec.Malformed):
                    codec.decode_scalar(full[:cut], 0)

    def test_rank_is_length_then_lexicographic(self):
        payloads = ['', '0', '1', '00', '01', '10', '11', '000']
        self.assertEqual([codec.rank(p) for p in payloads],
                         [1, 2, 3, 4, 5, 6, 7, 8])

    def test_one_payload_has_one_word(self):
        seen = {}
        for payload in ('', '0', '1', '01', '10', '111', '0000'):
            word = codec.code(payload)
            self.assertNotIn(word, seen)
            seen[word] = payload
            self.assertEqual(codec.length(payload), len(word))


class TestArtifactPacking(unittest.TestCase):
    """One payload has one byte artifact, or canonical identity is lost."""

    def test_round_trip(self):
        for payload in ('', '0', '1', '0110', '1' * 33, '01' * 100):
            with self.subTest(payload=payload[:12]):
                self.assertEqual(codec.unpack(codec.pack(codec.code(payload))),
                                 payload)

    def test_model_bits_and_file_bytes_are_what_the_codec_says(self):
        payload = '0110100'
        blob = codec.pack(codec.code(payload))
        self.assertEqual(len(blob), -(-codec.length(payload) // 8))

    def test_a_nonzero_pad_bit_is_rejected(self):
        payload = '011'
        bits = codec.code(payload)
        pad = (-len(bits)) % 8
        self.assertTrue(pad, 'pick a payload that actually needs padding')
        broken = codec.pack(bits + '1' + '0' * (pad - 1))
        with self.assertRaises(codec.Malformed):
            codec.unpack(broken)

    def test_a_whole_trailing_zero_byte_is_rejected(self):
        # Otherwise one payload has two artifacts, and artifact identity — the
        # thing every later claim is about — stops meaning anything.
        blob = codec.pack(codec.code('0110'))
        with self.assertRaises(codec.Malformed):
            codec.unpack(blob + b'\x00')

    def test_a_payload_longer_than_the_file_is_rejected(self):
        bits = codec.encode_scalar(4096) + '0' * 8
        with self.assertRaises(codec.Malformed):
            codec.unpack(codec.pack(bits))


class TestCanonicalImage(unittest.TestCase):
    """Every finite payload has one meaning; every malformed one is dead."""

    def test_round_trip(self):
        self.assertEqual(image.parse(image.serialize(ECHO)), ECHO)

    def test_zigzag_covers_the_signed_integers(self):
        values = list(range(-500, 500))
        self.assertEqual([image.unzigzag(image.zigzag(v)) for v in values],
                         values)
        self.assertTrue(all(image.zigzag(v) >= 0 for v in values))

    def test_a_zero_support_entry_has_no_image(self):
        # Zero is the default, so storing it would be a second way to say the
        # same memory.
        with self.assertRaises(ValueError):
            image.serialize(image.Image({5: 0}, 0, 0))

    def test_a_zero_valued_record_parses_as_dead(self):
        bits = (codec.encode_scalar(1) + codec.encode_scalar(0)
                + codec.encode_scalar(0)
                + codec.encode_scalar(5) + codec.encode_scalar(0))
        self.assertIs(image.parse(bits), image.DEAD)

    def test_trailing_payload_bits_are_dead(self):
        self.assertIs(image.parse(image.serialize(ECHO) + '0'), image.DEAD)
        self.assertIs(image.parse(image.serialize(ECHO) + '1'), image.DEAD)

    def test_a_truncated_image_is_dead(self):
        bits = image.serialize(ECHO)
        for cut in (1, 5, len(bits) // 2, len(bits) - 1):
            with self.subTest(cut=cut):
                self.assertIs(image.parse(bits[:cut]), image.DEAD)

    def test_gaps_are_strictly_increasing_addresses(self):
        picture = image.Image({0: 1, 1: 2, 40: 3}, 0, 0)
        self.assertEqual(image.parse(image.serialize(picture)).memory,
                         {0: 1, 1: 2, 40: 3})

    def test_a_dead_payload_still_denotes_something(self):
        # Not an error to report: one fixed residual, which is what keeps the
        # meaning of a payload total.
        self.assertIs(machine.open_payload('1').image, image.DEAD)
        self.assertIsNone(machine.read(machine.open_payload('1')))


class TestTransactionalMachine(unittest.TestCase):
    """One instruction, three return targets, and two transactional call modes."""

    def test_the_echo_machine_echoes(self):
        residual = opened()
        self.assertEqual(machine.read(residual), 0)
        for byte in (0, 1, 65, 128, 255):
            with self.subTest(byte=byte):
                self.assertEqual(machine.future(residual, [byte]), byte)

    def test_a_history_is_folded_left_to_right(self):
        # Residualizing the final byte first reverses the history, and this is
        # the machine where that is visible: the last byte is the answer.
        residual = opened()
        self.assertEqual(machine.future(residual, [1, 2, 3]), 3)
        self.assertEqual(machine.future(residual, [3, 2, 1]), 1)

    def test_the_residual_law_holds(self):
        # future(feed*(r,p)) = after(future(r),p), which is the whole reason a
        # residual can be carried instead of a history.
        residual = opened()
        prefix = [65, 66]
        for suffix in ([], [0], [9], [255]):
            with self.subTest(suffix=suffix):
                self.assertEqual(machine.future(machine.feed_all(residual, prefix), suffix),
                                 machine.future(residual, prefix + suffix))

    def test_a_read_commits_nothing(self):
        # The read path writes to cells 1 and 2 every time it runs.  If any of
        # it survived, reading would train the machine.
        residual = machine.feed(opened(), 77)
        before = dict(residual.image.memory)
        for _ in range(5):
            self.assertEqual(machine.read(residual), 77)
        self.assertEqual(residual.image.memory, before)

    def test_operands_are_read_before_the_write(self):
        # `M[pc] -= M[pc]` is the case that separates the two orders: fetched
        # first, c is the original branch target; fetched after, it is whatever
        # the write left behind.
        picture = image.Image({0: 4, 1: 4, 2: 6,
                               6: 9, 7: 9, 8: -2}, pc_out=0, pc_feed=0)
        memory = dict(picture.memory)
        event, _steps = machine._run(memory, 0, 1000)
        self.assertEqual(event, machine.COMMIT)

    def test_a_negative_operand_fails_finitely(self):
        picture = image.Image({0: -1, 1: 5, 2: 9}, pc_out=0, pc_feed=0)
        memory = dict(picture.memory)
        self.assertEqual(machine._run(memory, 0, 100), (None, 1))

    def test_a_feed_that_does_not_commit_is_dead(self):
        # EMIT on the feed entry: a real event, and the wrong one.
        picture = image.Image(dict(ECHO.memory), pc_out=3, pc_feed=15)
        residual = machine.feed(opened(picture), 5)
        self.assertTrue(residual.dead)
        self.assertIsNone(machine.read(residual))

    def test_a_dead_residual_stays_dead(self):
        residual = machine.feed_all(machine.DEAD_RESIDUAL, [1, 2, 3])
        self.assertTrue(residual.dead)
        self.assertIsNone(machine.read(residual))

    def test_a_read_that_never_emits_is_bottom(self):
        picture = image.Image(dict(ECHO.memory), pc_out=18, pc_feed=18)
        self.assertIsNone(machine.read(opened(picture)))

    def test_divergence_is_not_an_outcome(self):
        # A budget exists so a test can finish.  Exhausting it is verifier
        # state: not a byte, not a failure, and never quietly either.
        picture = image.Image({0: 5, 1: 5, 5: -1}, pc_out=0, pc_feed=0)
        with self.assertRaises(machine.Unfinished):
            machine.read(machine.Residual(picture), budget=500)

    def test_work_is_counted_exactly(self):
        _residual, steps = machine.feed_with_budget(opened(), 42)
        self.assertEqual(steps, 1)          # the feed program is one COMMIT


@unittest.skipUnless(shutil.which('clang') and shutil.which('node'),
                     'needs clang and node')
class TestWasmAgreesWithTheReference(unittest.TestCase):
    """The compiled module and the reference are two statements of one machine.

    Neither is checked against a description of the other; they are run side by
    side on the same artifacts and required to answer identically.
    """

    module = None

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp()
        cls.module = os.path.join(cls._tmp, 'vm.wasm')
        build = subprocess.run(
            ['clang', '--target=wasm32', '-O2', '-ffreestanding', '-nostdlib',
             '-Wl,--no-entry', '-Wl,--export-dynamic',
             '-Wl,--initial-memory=33554432', '-Wall', '-Wextra',
             WASM_SOURCE, '-o', cls.module],
            capture_output=True, text=True)
        assert build.returncode == 0, build.stderr
        assert not build.stderr.strip(), build.stderr
        cls.driver = os.path.join(cls._tmp, 'drive.mjs')
        with open(cls.driver, 'w') as handle:
            handle.write(DRIVER)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def drive(self, ops):
        run = subprocess.run(['node', self.driver, self.module],
                             input=json.dumps({'ops': ops}),
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def both(self, blob, history):
        """(wasm answers, reference answers) for load/read over a history."""
        ops = [{'op': 'load', 'bytes': list(blob)}, {'op': 'read'}]
        for byte in history:
            ops += [{'op': 'feed', 'byte': byte}, {'op': 'read'}]

        try:
            residual = machine.open_payload(codec.unpack(blob))
        except codec.Malformed:
            residual = machine.DEAD_RESIDUAL
        want = [{'load': 0 if residual.dead else 1},
                {'read': _as_wasm(machine.read(residual))}]
        for byte in history:
            residual = machine.feed(residual, byte)
            want += [{'feed': 0 if residual.dead else 1},
                     {'read': _as_wasm(machine.read(residual))}]
        return self.drive(ops), want

    def test_the_echo_machine_agrees_over_every_byte(self):
        blob = artifact(ECHO)
        got, want = self.both(blob, list(range(256)))
        self.assertEqual(got, want)

    def test_a_dead_payload_is_dead_on_both_sides(self):
        # `\x80` is a bare leading 1 with nothing after it.  It is not E(1), and
        # the two decoders have to agree that it is not.
        for blob in (b'\x00', b'\xff', b'\x80', b'\x80\x00',
                     b'\xc0', artifact(ECHO) + b'\x00'):
            with self.subTest(blob=blob[:4]):
                got, want = self.both(blob, [1, 2])
                self.assertEqual(got, want)

    def test_a_word_truncated_at_the_payload_end_is_dead_on_both_sides(self):
        """The case where the two decoders used to disagree.

        A payload does not end on a byte boundary, so the final scalar word can
        run out of payload while bytes remain. The C loop counted its zero run
        with `while (at < len && !bit())`, which falls out of the loop when the
        payload ends and then reads a bare leading `1` as the value 1. The
        reference calls that malformed, so one side had a live image and the
        other had the dead residual for the same file.
        """
        payload = (codec.encode_scalar(1) + codec.encode_scalar(0)
                   + codec.encode_scalar(0) + codec.encode_scalar(0) + '1')
        blob = codec.pack(codec.code(payload))
        self.assertIs(image.parse(payload), image.DEAD)
        got, want = self.both(blob, [1])
        self.assertEqual(got, want)
        self.assertEqual(got[0], {'load': 0})

    def test_a_failed_feed_kills_both(self):
        picture = image.Image(dict(ECHO.memory), pc_out=3, pc_feed=15)
        got, want = self.both(artifact(picture), [5, 6])
        self.assertEqual(got, want)
        self.assertEqual(got[2], {'feed': 0})

    def test_reads_do_not_accumulate_on_either_side(self):
        ops = [{'op': 'load', 'bytes': list(artifact(ECHO))},
               {'op': 'feed', 'byte': 200}]
        ops += [{'op': 'read'}] * 20
        self.assertEqual(self.drive(ops)[2:],
                         [{'read': 200}] * 20)

    def test_kernel_abi_stays_in_wasm_and_caches_the_complete_byte_domain(self):
        blob = artifact(ECHO)
        out = self.drive([
            {'op': 'prepare', 'bytes': list(blob),
             'input_bits': 8, 'input_bytes': 1, 'output_bytes': 1},
            {'op': 'eval32', 'value': 42},
            {'op': 'eval32', 'value': 255},
            {'op': 'eval32', 'value': 42},
            {'op': 'eval_stats'},
        ])
        self.assertEqual(out[:4], [
            {'prepare': 1}, {'eval': 42}, {'eval': 255}, {'eval': 42},
        ])
        self.assertEqual(out[4], {'calls': 3, 'misses': 2, 'ok': 1})

    def test_the_wasm_reports_a_budget_it_could_not_finish(self):
        # Not a byte and not a failure: the caller is told the run is
        # unfinished, which is the only honest thing to say about it.
        spin = image.Image({0: 5, 1: 5, 5: -1}, pc_out=0, pc_feed=0)
        out = self.drive([{'op': 'budget', 'value': 500},
                          {'op': 'load', 'bytes': list(artifact(spin))},
                          {'op': 'read'},
                          {'op': 'flags'}])
        self.assertEqual(out[1], {'read': -2})
        self.assertEqual(out[2]['exhausted'], 1)

    def test_overflow_is_reported_rather_than_wrapped(self):
        # The specification forbids an integer wrapping into a second image.
        # i64 is a departure from unbounded, so the departure has to be loud.
        big = (1 << 62)
        picture = image.Image({0: 6, 1: 7,
                               6: -big, 7: big, 8: 1,
                               9: 2, 10: 2, 11: -1}, pc_out=0, pc_feed=0)
        out = self.drive([{'op': 'load', 'bytes': list(artifact(picture))},
                          {'op': 'read'},
                          {'op': 'flags'}])
        self.assertEqual(out[1], {'read': -1})
        self.assertEqual(out[2]['overflowed'], 1)


def _as_wasm(outcome):
    return -1 if outcome is None else outcome


DRIVER = '''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const job = JSON.parse(readFileSync(0, 'utf8'));
const mem = new Uint8Array(E.memory.buffer);
const out = [];
for (const step of job.ops) {
  if (step.op === 'load') {
    mem.set(step.bytes, E.vm_buffer());
    out.push({ load: E.vm_load(step.bytes.length) });
  } else if (step.op === 'read') {
    out.push({ read: E.vm_read() });
  } else if (step.op === 'feed') {
    out.push({ feed: E.vm_feed(step.byte) });
  } else if (step.op === 'prepare') {
    mem.set(step.bytes, E.vm_buffer());
    out.push({ prepare: E.vm_prepare_eval(
      step.bytes.length, step.input_bits, step.input_bytes, step.output_bytes) });
  } else if (step.op === 'eval32') {
    out.push({ eval: E.vm_eval_i32_i32(step.value) >>> 0 });
  } else if (step.op === 'eval_stats') {
    out.push({ calls: E.vm_eval_calls(), misses: E.vm_eval_misses(),
               ok: E.vm_eval_ok() });
  } else if (step.op === 'budget') {
    E.vm_set_budget(0, step.value);
  } else if (step.op === 'flags') {
    out.push({ dead: E.vm_dead(), overflowed: E.vm_overflowed(),
               exhausted: E.vm_exhausted() });
  }
}
process.stdout.write(JSON.stringify(out));
'''
