"""One transactional rSUBLEQ instruction and its residual call boundary.

At `pc`, read all three operands from the pre-step state:

    a = M[pc]; b = M[pc+1]; c = M[pc+2]
    M[b] <- M[b] - M[a]
    pc  <- pc+3         when M[b] > 0
    pc  <- c            when M[b] <= 0 and c >= 0

and when `M[b] <= 0` with `c < 0` the branch is an invocation event:
`-1` EMIT, `-2` COMMIT, `-3` and below FAIL.

Reading the three operands *before* the write is not a detail: it is what makes
a self-modifying instruction mean what it says. Cells 0 and 1 are the input and
output cells and are ordinary memory, not opcodes, so ordinary SUBLEQ programs
are the `c >= 0` subset unchanged.

All writes go through a private transaction. A read call discards them; a feed
call keeps them only on COMMIT. That is the whole reason a read cannot train
the machine by accident.

Divergence is divergence: this reference takes a step budget so a test can
finish, and reports exhausting it as `Unfinished`, which is deliberately *not*
an outcome. Timeout never becomes a byte and never becomes a failure.

Depends only on `codec` and `image`.
"""

from .image import DEAD, Image, parse

EMIT = -1
COMMIT = -2

# Outcomes of a call.  `bottom` covers finite no-byte and divergence alike; only
# the finite kind can ever be certified by a trace.
BOTTOM = None


class Unfinished(Exception):
    """The budget ran out. Verifier state, never a result."""

    def __init__(self, steps):
        Exception.__init__(self, 'unfinished after %d transitions' % steps)
        self.steps = steps


class Residual(object):
    """An opened artifact: the committed memory plus its entry points."""

    __slots__ = ('image', 'dead')

    def __init__(self, image, dead=False):
        self.image = image
        self.dead = dead or image is DEAD

    def __repr__(self):
        return 'Residual(dead)' if self.dead else 'Residual(%r)' % (self.image,)


DEAD_RESIDUAL = Residual(DEAD, dead=True)


def open_payload(payload):
    """`open` over a payload — the canonical image, or the dead residual."""
    picture = parse(payload)
    return DEAD_RESIDUAL if picture is DEAD else Residual(picture)


def _run(memory, pc, budget):
    """Execute from `pc` over a mutable dict. Returns (event, steps).

    `event` is the negative branch target that ended the run, or None for a
    finite failure.
    """
    steps = 0
    while True:
        if steps >= budget:
            raise Unfinished(steps)
        steps += 1

        a = memory.get(pc, 0)
        b = memory.get(pc + 1, 0)
        c = memory.get(pc + 2, 0)
        if a < 0 or b < 0:
            return None, steps

        value = memory.get(b, 0) - memory.get(a, 0)
        if value:
            memory[b] = value
        else:
            memory.pop(b, None)

        if value > 0:
            pc = pc + 3
            continue
        if c >= 0:
            pc = c
            continue
        return c, steps


def read(residual, budget=1 << 22):
    """One output call: a byte, or `BOTTOM`.

    Every write is discarded, including self-modification, so reading is
    observation and nothing else.
    """
    return read_with_budget(residual, budget=budget)[0]


def read_with_budget(residual, budget=1 << 22):
    """``(output, transitions)`` for one non-committing read call."""
    if residual.dead:
        return BOTTOM, 0
    scratch = dict(residual.image.memory)          # the private transaction
    event, steps = _run(scratch, residual.image.pc_out, budget)
    if event != EMIT:
        return BOTTOM, steps
    out = scratch.get(1, 0)
    return (out if 0 <= out < 256 else BOTTOM), steps


def feed(residual, byte):
    """One input call. Commits only on COMMIT; anything else is dead."""
    return feed_with_budget(residual, byte)[0]


def feed_with_budget(residual, byte, budget=1 << 22):
    """`(residual, transitions)` — the same call, with its exact work."""
    if residual.dead:
        return DEAD_RESIDUAL, 0
    if not 0 <= byte < 256:
        raise ValueError('feed takes one byte: %r' % (byte,))

    scratch = dict(residual.image.memory)
    if byte:
        scratch[0] = byte
    else:
        scratch.pop(0, None)
    event, steps = _run(scratch, residual.image.pc_feed, budget)
    if event != COMMIT:
        return DEAD_RESIDUAL, steps
    return Residual(Image(scratch, residual.image.pc_out,
                          residual.image.pc_feed)), steps


def feed_all(residual, data):
    """The normative left fold. Strictly left to right, never the other way."""
    for byte in data:
        residual = feed(residual, byte)
    return residual


def future(residual, history):
    """`read(feed*(r, history))` — the complete observable future at one point."""
    return read(feed_all(residual, history))
