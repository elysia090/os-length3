"""A canonical payload for one finite-support signed machine image.

    E(k) || E(pc_o) || E(pc_a) || (E(gap_i) || E(zigzag(value_i)))^k

with `a_-1 = -1` and `a_i = a_(i-1) + 1 + gap_i`, so addresses strictly
increase and every stored value is nonzero. That is one representation of every
finite-support signed memory and no representation of anything else: no
duplicate address, no zero-support record, no trailing-zero image.

Every finite bit payload therefore has exactly one meaning. A payload that does
not parse canonically is not an error to be reported to a user — it denotes one
fixed dead residual, which is what keeps the meaning total.

Depends only on `codec`.
"""

from .codec import Malformed, decode_scalar, encode_scalar


def zigzag(value):
    return 2 * value if value >= 0 else -2 * value - 1


def unzigzag(code_point):
    return code_point // 2 if code_point % 2 == 0 else -(code_point + 1) // 2


class Image(object):
    """A finite-support signed memory plus the two entry points."""

    __slots__ = ('memory', 'pc_out', 'pc_feed')

    def __init__(self, memory, pc_out, pc_feed):
        self.memory = dict(memory)
        self.pc_out = pc_out
        self.pc_feed = pc_feed

    def __eq__(self, other):
        return (isinstance(other, Image)
                and self.memory == other.memory
                and self.pc_out == other.pc_out
                and self.pc_feed == other.pc_feed)

    def __repr__(self):
        return 'Image(%d cells, out=%d, feed=%d)' % (
            len(self.memory), self.pc_out, self.pc_feed)


# One payload, one meaning: everything that is not a canonical image is this.
DEAD = Image({}, 0, 0)


def parse(payload):
    """The image a payload denotes, or `DEAD`.

    Increasing gap order is the wire normal form, not a runtime requirement. A
    loader may decode straight into whatever layout it likes as long as it
    round-trips.
    """
    try:
        return _parse(payload)
    except (Malformed, ValueError):
        return DEAD


def _parse(payload):
    count, at = decode_scalar(payload, 0)
    pc_out, at = decode_scalar(payload, at)
    pc_feed, at = decode_scalar(payload, at)

    memory = {}
    address = -1
    for _ in range(count):
        gap, at = decode_scalar(payload, at)
        point, at = decode_scalar(payload, at)
        address += 1 + gap
        value = unzigzag(point)
        if value == 0:
            raise Malformed('a zero support entry has no canonical image')
        memory[address] = value
    if at != len(payload):
        raise Malformed('%d payload bits past the image' % (len(payload) - at))
    return Image(memory, pc_out, pc_feed)


def serialize(image):
    """The canonical payload of an image. Strict inverse of `parse`."""
    out = [encode_scalar(len(image.memory)),
           encode_scalar(image.pc_out),
           encode_scalar(image.pc_feed)]
    address = -1
    for cell in sorted(image.memory):
        value = image.memory[cell]
        if value == 0:
            raise ValueError('cell %d holds zero; that has no image' % cell)
        if cell <= address:
            raise ValueError('addresses must strictly increase')
        out.append(encode_scalar(cell - address - 1))
        out.append(encode_scalar(zigzag(value)))
        address = cell
    return ''.join(out)
