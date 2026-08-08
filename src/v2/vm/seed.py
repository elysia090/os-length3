"""The physical minimal subset, and its initial object.

A machine in the subset is three things and nothing else:

    state_t                              the residual
    feed  : state_t -> Byte -> state_t   one committed input
    read  : state_t -> Byte              one observation, committing nothing

`machine.py` gives that interface over an artifact. This gives the one machine
in it you can write down *without* an artifact:

    typedef uint8_t state_t;
    state_t feed(state_t state, uint8_t byte) { return byte; }
    uint8_t read_state(state_t state)         { return state; }

It is the initial object, and the reason it matters is the future quotient. A
residual is a function of a *history* — an element of `Byte*` — and `Byte*` is
infinite. What makes the quotient finite is that histories collapse, and the
echo machine is where the collapse is immediate: after one byte, every history
ending in `b` is the same state, so `Byte*` falls to 256 classes on the first
move and never refines again. A subset without this object has nothing to
check that against, and the collapse becomes an assumption.

`ECHO` here is *built*, not typed out: an image asserted as a table of numbers
would be a claim about what those numbers do, and `tests/test_vm_seed.py`
requires it to agree with the hand-written one the codec tests use.

Depends on `asm`, `image` and `machine`.
"""

from . import asm as _asm
from . import machine


def echo_image():
    """The echo machine as a canonical image.

    Two straight-line entries: `feed` saves the input byte and commits, `read`
    copies it out and emits. Nothing else is in it, which is what makes it the
    smallest thing the subset can be shown on.
    """
    a = _asm.Asm()
    saved = a.cell('saved')
    out_entry = a.label('read')
    feed_entry = a.label('feed')

    a.place(out_entry)
    a.move(saved, _asm.Asm.OUTPUT)
    a.halt(_asm.EMIT)

    a.place(feed_entry)
    a.move(_asm.Asm.INPUT, saved)
    a.halt(_asm.COMMIT)

    return a.build(out_entry, feed_entry)


ECHO = echo_image()


def residual():
    """A fresh echo residual. The empty history's state."""
    return machine.Residual(echo_image())


# ---------------------------------------------------------------------------
# The future quotient over Byte*
# ---------------------------------------------------------------------------

def state_of(start, history):
    """The residual `history` leads to, or None if it led out of the subset."""
    at = start
    for byte in history:
        at = machine.feed(at, byte)
        if at.dead:
            return None
    return at


def signature(start, history, depth, alphabet):
    """What every continuation up to `depth` reads after `history`.

    Two histories are future-equivalent exactly when this agrees, which is the
    Myhill-Nerode condition written out. `depth` bounds it: the quotient is
    the limit, and a bounded probe can only ever *fail* to separate, never
    separate wrongly.
    """
    at = state_of(start, history)
    if at is None:
        return None
    out = [machine.read(at)]
    if depth:
        for byte in alphabet:
            out.append(signature(at, [byte], depth - 1, alphabet))
    return tuple(out)


def histories(length, alphabet):
    """Every element of `Byte^length`, in order."""
    if not length:
        yield ()
        return
    for head in histories(length - 1, alphabet):
        for byte in alphabet:
            yield head + (byte,)


def future_classes(start, upto, depth=1, alphabet=range(256)):
    """`{history: class id}` over every history up to length `upto`.

    The class id is the index of the history's signature in order of first
    appearance, so equal ids mean no continuation of this depth tells the two
    histories apart.
    """
    alphabet = list(alphabet)
    seen = {}
    classes = {}
    for length in range(upto + 1):
        for history in histories(length, alphabet):
            key = signature(start, history, depth, alphabet)
            if key not in seen:
                seen[key] = len(seen)
            classes[history] = seen[key]
    return classes
