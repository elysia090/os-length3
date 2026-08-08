"""Drive the byte ABI for a kernel-shaped artifact.

`lower.lower_seq` frames a function as a byte stream: the input little-endian,
then the output a byte at a time with one feed between each. This is the two
lines that say so, in one place, so the Python reference and `web/vm.js`
cannot drift on the framing itself.

Depends on `codec`, `image`, `vm` and `lower`.
"""

from . import codec, image, machine
from .lower import lower_seq


def artifact_for(seq, input_bits, output_bits):
    """The packed rSUBLEQ artifact for one lowered QM sequence."""
    return codec.pack(codec.code(image.serialize(
        lower_seq(seq, input_bits, output_bits))))


def _evaluate_from(start, value, input_bits, output_bits, budget):
    in_bytes = -(-input_bits // 8)
    out_bytes = -(-output_bits // 8)

    residual = machine.feed_all(start, [(value >> (8 * k)) & 0xFF
                                   for k in range(in_bytes)])
    out = 0
    for k in range(out_bytes):
        byte = machine.read(residual, budget=budget)
        if byte is None:
            return None
        out |= byte << (8 * k)
        if k + 1 < out_bytes:
            residual, _steps = machine.feed_with_budget(residual, 0, budget=budget)
    return out


def evaluate(blob, value, input_bits, output_bits, budget=1 << 24):
    """Run the artifact on one input, through `open`, `feed` and `read` only.

    Returns the output word, or None for bottom — the only two things the ABI
    can say.
    """
    return _evaluate_from(machine.open_payload(codec.unpack(blob)), value,
                          input_bits, output_bits, budget)


def evaluate_many(blob, values, input_bits, output_bits, budget=1 << 24):
    """The same, over several inputs, opening the artifact once.

    Opening parses the whole image, which for a program with a dynamic gather
    in it is most of the cost of a single evaluation. Each input still starts
    from the freshly opened residual, so nothing carries between them.
    """
    start = machine.open_payload(codec.unpack(blob))
    return [_evaluate_from(start, value, input_bits, output_bits, budget)
            for value in values]
