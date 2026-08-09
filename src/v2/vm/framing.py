"""Compile a fixed-width function for a byte-stream interface.

This module owns only the boundary between a function and the ``feed``/``read``
interface. It does not depend on the operations or value representation used by
the function body. A different lowering can therefore reuse the same framing.

The stream convention is:

    feed(x0) .. feed(x_{n-1})   input bytes, little-endian
    read()                      output byte 0
    feed(anything); read()      output byte 1, and so on

``read`` never commits.  Only ``feed`` advances either stream.
"""

from . import asm as _asm
from .asm import Asm, COMMIT, EMIT


def _decode_byte(low, source, bits, one, pow2):
    """Split a byte in ``source`` into eight one-bit cells, high bit first."""
    scratch = low.temp('d')
    probe = low.temp('q')
    low.a.move(source, scratch)
    for index in range(7, -1, -1):
        set_here = low.a.label('set%d' % index)
        after = low.a.label('after%d' % index)
        low.a.move(pow2[index], probe)
        low.a.sub(scratch, probe)              # 2^i - value <= 0 iff set
        low.a.if_le_zero(probe, set_here)
        low.a.clear(bits[index])
        low.a.goto(after)
        low.a.place(set_here)
        low.a.move(one, bits[index])
        low.a.sub(pow2[index], scratch)
        low.a.place(after)


def _encode_byte(low, bits, target, pow2):
    """Recombine eight one-bit cells into a byte."""
    low.a.clear(target)
    for index in range(8):
        after = low.a.label('skip%d' % index)
        low.a.if_le_zero(bits[index], after)
        low.a.add(pow2[index], target)
        low.a.place(after)


def _decode_word(low, source, bits):
    """Split a known unsigned 64-bit cell into one-bit boundary cells."""
    scratch = low.temp('word')
    probe = low.temp('word_probe')
    low.a.move(source, scratch)
    for index in range(low.word_bits - 1, -1, -1):
        set_here = low.a.label('word_set%d' % index)
        after = low.a.label('word_after%d' % index)
        low.a.move(low.pow2[index], probe)
        low.a.sub(scratch, probe)          # 2^i - value <= 0 iff set
        low.a.if_le_zero(probe, set_here)
        low.a.goto(after)
        low.a.place(set_here)
        low.a.move(low.one, bits[index])
        low.a.sub(low.pow2[index], scratch)
        low.a.place(after)


def frame_function(low, compute, input_bits, output_bits, zero):
    """Build the byte-stream interface around a fixed-width function.

    ``low`` is intentionally structural: it provides an assembler, temporary
    cells, constants, and a way to obtain output cells. ``compute`` receives
    the current value representation and returns a value in that representation.
    """
    a = low.a

    in_bits = [a.cell('in%d' % i) for i in range(low.in_bytes * 8)]
    out_bytes = [a.cell('ob%d' % i) for i in range(low.out_bytes)]
    counter = a.cell('counter')
    index = a.cell('index')

    entry_out = a.label('read')
    entry_feed = a.label('feed')
    run_kernel = a.label('kernel')

    # read: emit the byte the stream is on.  The chain is an exact dispatch;
    # the first index reached branches away before any later case is tested.
    a.place(entry_out)
    probe = low.temp('r')
    emit_at = [a.label('emit%d' % i) for i in range(low.out_bytes)]
    skip_emit = [a.label('no_emit%d' % i) for i in range(low.out_bytes)]
    for which in range(low.out_bytes):
        a.move(index, probe)
        for _ in range(which):
            a.sub(low.one, probe)
        a.if_le_zero(probe, emit_at[which])
        a.goto(skip_emit[which])
        a.place(emit_at[which])
        a.move(out_bytes[which], Asm.OUTPUT)
        a.halt(EMIT)
        a.place(skip_emit[which])
    a.halt(_asm.FAIL)

    # feed: collect the fixed-width input, then advance the output stream.
    a.place(entry_feed)
    probe2 = low.temp('f')
    take_at = [a.label('take%d' % i) for i in range(low.in_bytes)]
    skip_take = [a.label('skip_take%d' % i) for i in range(low.in_bytes)]
    for which in range(low.in_bytes):
        a.move(counter, probe2)
        for _ in range(which):
            a.sub(low.one, probe2)
        a.if_le_zero(probe2, take_at[which])
        a.goto(skip_take[which])
        a.place(take_at[which])
        _decode_byte(low, Asm.INPUT, in_bits[which * 8:which * 8 + 8],
                     low.one, low.pow2)
        a.add(low.one, counter)
        if which == low.in_bytes - 1:
            a.goto(run_kernel)
        else:
            a.halt(COMMIT)
        a.place(skip_take[which])
    a.add(low.one, index)
    a.halt(COMMIT)

    # Values become cells only at the byte boundary. Rearranging references in
    # the function body remains free until bytes are requested here.
    a.place(run_kernel)
    word = [(in_bits[i], False) if i < input_bits else zero
            for i in range(low.word_bits)]
    result = compute(word)
    if (isinstance(result, tuple) and len(result) == 2
            and result[0] == 'bytes'):
        byte_cells = result[1]
        if len(byte_cells) != low.out_bytes:
            raise ValueError('direct byte result has the wrong width')
        for which, source in enumerate(byte_cells):
            low.a.move(source, out_bytes[which])
    else:
        result = [b if i < output_bits else zero
                  for i, b in enumerate(result)]
        for which in range(low.out_bytes):
            cells = [low.materialize(result[which * 8 + bit])
                     for bit in range(8)]
            _encode_byte(low, cells, out_bytes[which], low.pow2)
    a.halt(COMMIT)

    return low.a.build(entry_out, entry_feed)


def frame_word_function(low, compute, input_bits, output_bits):
    """Build the same stream ABI around a one-cell whole-word function.

    The representation conversion is explicit at both boundaries: input bytes
    are decoded to bits and summed into one word, while the result word is
    decomposed once for byte emission. The function body never observes those
    boundary bit cells.
    """
    if output_bits != low.word_bits:
        raise ValueError('whole-word framing currently requires a full word')
    a = low.a

    direct_byte_input = input_bits == 8
    in_bits = ([] if direct_byte_input else
               [a.cell('in%d' % i) for i in range(low.in_bytes * 8)])
    input_word = a.cell('input_word')
    counter = a.cell('counter')
    index = a.cell('index')

    entry_out = a.label('read')
    entry_feed = a.label('feed')
    run_kernel = a.label('kernel')

    # Emit feed and kernel first. The read entry is allowed to appear later,
    # which lets it reference the exact output cells chosen by `compute`
    # without copying them through representation-neutral placeholders.
    a.place(entry_feed)
    probe = low.temp('f')
    take_at = [a.label('take%d' % i) for i in range(low.in_bytes)]
    skip_take = [a.label('skip_take%d' % i) for i in range(low.in_bytes)]
    for which in range(low.in_bytes):
        a.move(counter, probe)
        for _ in range(which):
            a.sub(low.one, probe)
        a.if_le_zero(probe, take_at[which])
        a.goto(skip_take[which])
        a.place(take_at[which])
        if direct_byte_input:
            a.move(Asm.INPUT, input_word)
        else:
            _decode_byte(low, Asm.INPUT,
                         in_bits[which * 8:which * 8 + 8],
                         low.one, low.pow2)
        a.add(low.one, counter)
        if which == low.in_bytes - 1:
            a.goto(run_kernel)
        else:
            a.halt(COMMIT)
        a.place(skip_take[which])
    a.add(low.one, index)
    a.halt(COMMIT)

    a.place(run_kernel)
    if not direct_byte_input:
        for bit in range(input_bits):
            after = a.label('input_skip%d' % bit)
            a.if_le_zero(in_bits[bit], after)
            a.add(low.pow2[bit], input_word)
            a.place(after)

    kind, result = compute(input_word)
    if kind == 'bytes':
        out_bytes = result
        if len(out_bytes) != low.out_bytes:
            raise ValueError('byte result has the wrong width')
    elif kind == 'word':
        out_bytes = [a.cell('ob%d' % i) for i in range(low.out_bytes)]
        out_bits = a.cells('out_bit', low.word_bits)
        _decode_word(low, result, out_bits)
        for which in range(low.out_bytes):
            _encode_byte(low, out_bits[which * 8:which * 8 + 8],
                         out_bytes[which], low.pow2)
    else:
        raise ValueError('unknown whole-word boundary result %r' % (kind,))
    a.halt(COMMIT)

    a.place(entry_out)
    probe2 = low.temp('r')
    emit_at = [a.label('emit%d' % i) for i in range(low.out_bytes)]
    skip_emit = [a.label('no_emit%d' % i) for i in range(low.out_bytes)]
    for which in range(low.out_bytes):
        a.move(index, probe2)
        for _ in range(which):
            a.sub(low.one, probe2)
        a.if_le_zero(probe2, emit_at[which])
        a.goto(skip_emit[which])
        a.place(emit_at[which])
        a.move(out_bytes[which], Asm.OUTPUT)
        a.halt(EMIT)
        a.place(skip_emit[which])
    a.halt(_asm.FAIL)

    return a.build(entry_out, entry_feed)
