"""How much of the artifact's cost is the lowering's choice, not the machine's.

`vm/README.md` says the artifact is far from minimal and blames two decisions:
bit-slicing an arithmetic machine, and unrolling everything. This is where
those numbers come from, so they can be re-derived rather than believed.

One function, three ways of writing it:

    y = x * 0x0101010101010101  mod 2^64,   x a byte-spread 8-bit value

which is exactly the `CONV(IMUL)` stage of `ranks8`. All three are measured on
the same 256 inputs and on the scale the product reports — cells, `L(z)`, and
the section 3.7 span and work of one run — with no byte framing around them, so
what is compared is the multiply and nothing else.

    python3 tools/measure_multiply.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vm import asm as A, codec, image, lower, machine, rows       # noqa: E402

K = 0x0101010101010101
MASK = (1 << 64) - 1
LIMIT = 1 << 64

# The operand `ranks8` actually multiplies: one free bit per byte lane.
SPREAD = [sum(((v >> i) & 1) << (8 * i) for i in range(8)) for v in range(256)]


def bit_sliced():
    """What `lower.py` builds today: one cell per bit, gates and adders."""
    low = lower.Lowering(64, 64)
    a = low.a
    inputs = {p: a.cell('in%d' % p) for p in range(0, 64, 8)}
    bits = [(inputs[i], False) if i in inputs else lower.ZERO
            for i in range(64)]
    feed, out = a.label('feed'), a.label('out')
    a.place(feed)
    a.halt(A.COMMIT)
    a.place(out)
    outputs = [low.materialize(bit) for bit in low.multiply(bits, K)]
    a.halt(A.EMIT)
    picture = a.build(out, feed)

    worst = None
    for value in SPREAD:
        memory = dict(picture.memory)
        for position, cell in inputs.items():
            if (value >> position) & 1:
                memory[cell.address] = 1
        cost = rows.Cost()
        event, _ = rows.run(memory, picture.pc_out, 1 << 24, cost)
        assert event == machine.EMIT, event
        got = sum(1 << i for i, cell in enumerate(outputs)
                  if memory.get(cell.address, 0))
        assert got == (value * K) & MASK, '%#x -> %#x' % (value, got)
        if worst is None or cost.work > worst.work:
            worst = cost
    return picture, worst


def word_level(looped):
    """Shift and add on whole words, which is what the machine subtracts.

    Every modular reduction gets its own temporary. A shared one would be read
    by every unrolled copy, and section 3.2 charges a write one incidence per
    row that reads the cell — the same trap `asm.add` avoids.
    """
    a = A.Asm()
    x, y, t = a.cell('x'), a.cell('y'), a.cell('t')
    ff1 = a.cell('mod_m1', MASK)
    modulus = a.cell('modulus', LIMIT)
    one, eight = a.cell('one', 1), a.cell('eight', 8)
    i, j = a.cell('i'), a.cell('j')

    def reduce_mod(cell):
        """cell -= 2^64 when it no longer fits in 64 bits."""
        tmp = a.cell('tmp%d' % len(a))
        skip = a.label('r%d' % len(a))
        a.move(cell, tmp)
        a.sub(ff1, tmp)                     # tmp = cell - (2^64 - 1)
        a.if_le_zero(tmp, skip)             # <= 0, so cell already fits
        a.sub(modulus, cell)
        a.place(skip)

    feed, out = a.label('feed'), a.label('out')
    a.place(feed)
    a.halt(A.COMMIT)                        # no framing: x is set directly
    a.place(out)
    a.clear(y)
    a.move(x, t)
    if not looped:
        for round_ in range(8):
            a.add(t, y)
            reduce_mod(y)
            if round_ != 7:
                for _ in range(8):
                    a.add(t, t)
                    reduce_mod(t)
    else:
        mtop, mdone = a.label('mtop'), a.label('mdone')
        stop, sdone = a.label('stop'), a.label('sdone')
        a.move(eight, i)
        a.place(mtop)
        a.if_le_zero(i, mdone)
        a.add(t, y)
        reduce_mod(y)
        a.move(eight, j)
        a.place(stop)
        a.if_le_zero(j, sdone)
        a.add(t, t)
        reduce_mod(t)
        a.sub(one, j)
        a.goto(stop)
        a.place(sdone)
        a.sub(one, i)
        a.goto(mtop)
        a.place(mdone)
    a.halt(A.EMIT)
    picture = a.build(out, feed)

    worst = None
    for value in SPREAD:
        memory = dict(picture.memory)
        if value:
            memory[x.address] = value
        cost = rows.Cost()
        event, _ = rows.run(memory, picture.pc_out, 1 << 24, cost)
        assert event == machine.EMIT, event
        got = memory.get(y.address, 0)
        assert got == (value * K) & MASK, '%#x -> %#x' % (value, got)
        if worst is None or cost.work > worst.work:
            worst = cost
    return picture, worst


def measure():
    """`{form: (cells, L_bits, span, work)}` for the three forms."""
    forms = [('bit-sliced, unrolled (today)', bit_sliced()),
             ('word-level, unrolled', word_level(False)),
             ('word-level, looped', word_level(True))]
    return dict((name, (len(picture.memory),
                        codec.length(image.serialize(picture)),
                        cost.span, cost.work))
                for name, (picture, cost) in forms)


def main():
    table = measure()
    head = ('form', 'cells', 'L(z) bits', 'span', 'work')
    print('| %-28s | %6s | %9s | %5s | %5s |' % head)
    print('| %s | %s | %s | %s | %s |'
          % ('-' * 28, '-' * 6, '-' * 9, '-' * 5, '-' * 5))
    for name, row in table.items():
        print('| %-28s | %6d | %9d | %5d | %5d |' % ((name,) + row))


if __name__ == '__main__':
    main()
