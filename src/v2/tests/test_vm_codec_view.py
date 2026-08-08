"""The target called `codec` shows the codec, and shows it of what QM produced.

Two claims, and neither is obvious from the screen:

**It is the codeword.** A view named after §1 has to be `pack(code(z))` — the
bytes whose length is `L(z)` and whose rank is the objective's last tie-break —
not a disassembly of what those bytes decode to. So the hex in the view is
compared against the artifact byte for byte, and the field table against a
second decode of the same bits.

**It is downstream of the minimizer.** The artifact is built from
`result['program_object']`, which is the program the search ranked first, not
the pasted function. Two sources that say the same thing in different words
therefore have to produce the *same bytes* — that is what "the codec is the
canonical form" means, and it is false the moment anything lowers the paste
instead of the program.
"""

import unittest

from qm.pipeline import solve
from vm import codec, emit, image, lower

from tests.support import read_example


def artifact_of(source, **kw):
    result = solve(source, frontend='cfront', **kw)
    assert result['ok'], result.get('error')
    picture = lower.lower_program(result['program_object'],
                                  result['frontend']['input_bits'],
                                  result['frontend']['output_bits'])
    payload = image.serialize(picture)
    return picture, payload, codec.pack(codec.code(payload))


def hex_bytes(text):
    """The bytes the dump in `text` names, in order."""
    out = bytearray()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(';'):
            continue
        offset, _, rest = line.partition('  ')
        if len(offset) != 8:
            break                          # past the dump, into the listing
        try:
            int(offset, 16)
        except ValueError:
            break
        out += bytes(int(b, 16) for b in rest.split())
    return bytes(out)


class TestTheViewIsTheCodeword(unittest.TestCase):

    def setUp(self):
        self.picture, self.payload, self.blob = artifact_of(
            read_example('starts8.c'))
        self.text = emit.emit_code(self.picture, 'starts8', 8, 64)

    def test_the_dump_is_the_artifact_byte_for_byte(self):
        self.assertEqual(hex_bytes(self.text), self.blob)

    def test_the_dump_is_what_run_would_execute(self):
        """Not a re-encoding that happens to look similar."""
        self.assertEqual(codec.unpack(hex_bytes(self.text)), self.payload)
        self.assertEqual(image.parse(codec.unpack(hex_bytes(self.text))),
                         self.picture)

    def fields(self):
        """`[(start, label, value, width)]` from the header table."""
        out = []
        for line in self.text.splitlines():
            if not line.startswith(';;  '):
                continue
            parts = line[3:].split()
            if not parts or not parts[0].isdigit():
                continue
            out.append((int(parts[0]), ' '.join(parts[1:-2]),
                        int(parts[-2]), int(parts[-1])))
        return out

    def test_the_fields_tile_the_codeword_with_no_gap_and_no_overlap(self):
        """A self-delimiting code has no slack in it; the table must show that."""
        at = 0
        for start, _label, _value, width in self.fields():
            self.assertEqual(start, at)
            at += width
        self.assertEqual(at, len(self.blob) * 8)

    def test_each_named_field_decodes_to_the_value_beside_it(self):
        word = codec.code(self.payload)
        want = {'E(|z|)': len(self.payload), 'E(k)': len(self.picture.memory),
                'E(pc_o)': self.picture.pc_out, 'E(pc_a)': self.picture.pc_feed}
        seen = 0
        for start, label, value, width in self.fields():
            if label not in want:
                continue
            seen += 1
            decoded, end = codec.decode_scalar(word, start)
            self.assertEqual(decoded, value, label)
            self.assertEqual(decoded, want[label], label)
            self.assertEqual(end - start, width, label)
        self.assertEqual(seen, len(want))

    def test_the_pad_is_the_only_thing_after_the_word(self):
        pad = [f for f in self.fields() if f[1].startswith('pad')][0]
        self.assertLess(pad[3], 8)
        self.assertEqual(pad[0] + pad[3], len(self.blob) * 8)

    def test_the_listing_comes_after_the_bits_and_not_instead_of_them(self):
        bits = self.text.index('00000000  ')
        self.assertIn('subleq', self.text)
        self.assertLess(bits, self.text.index('subleq'))

    def test_the_listing_can_be_left_off_for_a_large_image(self):
        short = emit.emit_code(self.picture, 'starts8', 8, 64, listing=False)
        self.assertNotIn('subleq', short)
        self.assertEqual(hex_bytes(short), self.blob)


class TestTheCodecIsOfTheMinimizedProgram(unittest.TestCase):
    """Same function, different words: the bytes have to come out identical."""

    # `starts8` is `x & ~(x << 1)`: a set bit whose left neighbour is clear.
    # Three spellings — the example, the same thing with the complement moved
    # and two redundant temporaries, and a bit-at-a-time loop that shares no
    # expression with either and does not name a shift of the whole word.
    PLAIN = read_example('starts8.c')

    COMMUTED = '''
    #include <stdint.h>

    uint64_t starts8(uint8_t m)
    {
        uint64_t x = m;
        uint64_t shifted = x << 1;
        uint64_t kept = (~shifted) & x;
        return kept;
    }
    '''

    LONGHAND = '''
    #include <stdint.h>

    uint64_t starts8(uint8_t m)
    {
        uint64_t out = 0;
        for (int i = 0; i < 8; ++i) {
            uint64_t here = (uint64_t)((m >> i) & 1u);
            uint64_t before = (i == 0) ? 0u : (uint64_t)((m >> (i - 1)) & 1u);
            if (here && !before) out |= (uint64_t)1 << i;
        }
        return out;
    }
    '''

    def test_three_spellings_of_one_function_give_one_artifact(self):
        blobs = [artifact_of(src)[2]
                 for src in (self.PLAIN, self.COMMUTED, self.LONGHAND)]
        self.assertEqual(blobs[1], blobs[0],
                         'commuting the operands moved the artifact')
        self.assertEqual(blobs[2], blobs[0],
                         'the loop form moved the artifact')

    def test_it_is_not_that_the_sources_are_the_same(self):
        """The guard on the test above: these really are different programs."""
        self.assertNotEqual(self.COMMUTED.split(), self.PLAIN.split())
        self.assertNotIn('for (', self.PLAIN)

    def test_a_different_function_gives_a_different_artifact(self):
        """And the guard on *that*: the artifact is not constant."""
        mine = artifact_of(self.PLAIN)[2]
        other = artifact_of(read_example('ends8.c'))[2]
        self.assertNotEqual(mine, other)
