"""Compare physical lowering candidates at the complete byte ABI.

Algebra decides whether a candidate is correct. This module decides only which
correct candidate to keep. It runs dominant boundary inputs through feed,
every output read, and the direct row-wave cost model, then ranks by

    worst span, worst work, L(z), canonical payload.

The probes are a planner sample, not an equivalence argument; every candidate
offered here already has an exact construction.
"""

from . import codec, image, machine, rows


def dominant_inputs(input_bits):
    mask = (1 << input_bits) - 1
    alternating = int('AA' * 8, 16) & mask
    values = (0, 1, 2, mask, mask >> 1, 1 << (input_bits - 1), alternating,
              (~alternating) & mask)
    return tuple(dict.fromkeys(value & mask for value in values))


def _interaction_cost(picture, value, input_bits, output_bits,
                      budget=1 << 24):
    memory = dict(picture.memory)
    cost = rows.Cost()
    for byte_index in range(-(-input_bits // 8)):
        byte = (value >> (8 * byte_index)) & 0xFF
        if byte:
            memory[0] = byte
        else:
            memory.pop(0, None)
        event, _ = rows.run(memory, picture.pc_feed, budget, cost)
        if event != machine.COMMIT:
            raise ValueError('candidate did not commit its input')

    for byte_index in range(-(-output_bits // 8)):
        speculative = dict(memory)
        event, _ = rows.run(speculative, picture.pc_out, budget, cost)
        if event != machine.EMIT:
            raise ValueError('candidate did not emit an output byte')
        if byte_index + 1 < -(-output_bits // 8):
            memory.pop(0, None)
            event, _ = rows.run(memory, picture.pc_feed, budget, cost)
            if event != machine.COMMIT:
                raise ValueError('candidate did not advance its output')
    return cost


def physical_key(picture, input_bits, output_bits):
    """Sampled physical objective for a complete framed artifact."""
    costs = [_interaction_cost(picture, value, input_bits, output_bits)
             for value in dominant_inputs(input_bits)]
    payload = image.serialize(picture)
    return (max(cost.span for cost in costs),
            max(cost.work for cost in costs),
            codec.length(payload), payload)


def choose(candidates, input_bits, output_bits):
    """Return `(name, picture)` for the best exact candidate."""
    return min(candidates,
               key=lambda item: physical_key(item[1], input_bits,
                                              output_bits))
