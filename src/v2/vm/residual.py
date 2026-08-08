"""Pinf-R Section 4 — the residual ABI, and the code-level path beside it.

Section 3 says how one call runs. This says what the released interface is, and
there are two ways through it that must not disagree.

The **open-state path** is `machine.py`: `open` once, then `feed` and `read` on
a residual that is never serialized again. It is the fast one, and it is the
one a caller uses.

The **code-level path** is here. A residual has a code, and the code is a
program in exactly the sense §1 measures:

    emit(code(z))    = read(open(pack(code(z))))
    next(code(z), a) = code(res(z, a))                          (4.7)

with `res` the s-m-n residualizer, fixed by

    [[res(z, a)]](h) = [[z]]([a] || h).                         (4.6)

That identity is the whole content: residualizing a byte and then running the
rest is running the whole history. It follows from (4.1) and transactional
commit, so it is derived rather than implemented — but only if the two paths
compute the same thing, and §4's falsification list names "make code-level
residualization disagree with the open-state path" as a failure. Nothing can
check that with one path, which is why this exists.

The sole semantic implementation obligation is

    future(feed*(R, p)) = after(future(R), p)                    (4.5)

and `after` is here so a test can write it down rather than paraphrase it.

Depends on `codec`, `image` and `machine`.
"""

from . import codec, image, machine

# Every parse failure denotes one fixed dead residual (§2), so the code-level
# path needs a payload that denotes it — and the empty one does, because a
# payload with no `E(k)` in it does not parse. It is also the least: rank 1, and
# `L('')` is one bit, so the dead residual is the cheapest thing to name.
#
# Not `serialize(image.DEAD)`. That is the *empty image*, which parses fine and
# is a live residual: a machine entered at zero over empty memory subtracts
# zero from zero and branches to zero forever. Divergence is not the dead
# residual, and giving them one payload would say it is.
DEAD_PAYLOAD = ''


# ---------------------------------------------------------------------------
# 4.1-4.2  Histories and futures
# ---------------------------------------------------------------------------

def after(future_fn, prefix):
    """`after(f, p)(s) = f(p || s)` — the future seen from behind `p`."""
    prefix = tuple(prefix)

    def shifted(suffix):
        return future_fn(prefix + tuple(suffix))
    return shifted


def future_of(residual):
    """`future(r)(h) = read(feed*(r, h))`, as a callable over histories."""
    def observe(history):
        return machine.future(residual, history)
    return observe


# ---------------------------------------------------------------------------
# 4.4-4.6  The code-level path
# ---------------------------------------------------------------------------

def meaning(payload, history=()):
    """`[[z]](h)` — the outcome of `z` after `h`, in `Byte union {bottom}`."""
    return machine.future(machine.open_payload(payload), history)


def res(payload, byte):
    """`res(z, a)` — the payload whose future is `z`'s, one byte in.

    A feed that does not COMMIT yields the one fixed dead residual, and
    `DEAD_PAYLOAD` is a payload that denotes it; returning that is what keeps
    the code-level path total instead of raising.
    """
    residual = machine.feed(machine.open_payload(payload), byte)
    if residual.dead:
        return DEAD_PAYLOAD
    return image.serialize(residual.image)


def res_all(payload, data):
    """The same left fold as `feed*`, one byte at a time and never reversed."""
    for byte in data:
        payload = res(payload, byte)
    return payload


# ---------------------------------------------------------------------------
# 4.7  The interface over global codewords
# ---------------------------------------------------------------------------

def emit(word):
    """`emit(code(z)) = read(open(pack(code(z))))`.

    Takes the global codeword, not the payload: `code(z) = E(|z|) || z` is the
    thing §1 gives a length and a rank, and the one a search hands around.
    """
    return machine.read(machine.open_payload(_payload_of(word)))


def next_code(word, byte):
    """`next(code(z), a) = code(res(z, a))`. Codeword in, codeword out."""
    return codec.code(res(_payload_of(word), byte))


def _payload_of(word):
    """The payload inside a global codeword, or the dead one."""
    try:
        size, at = codec.decode_scalar(word, 0)
    except codec.Malformed:
        return DEAD_PAYLOAD
    if at + size != len(word):
        return DEAD_PAYLOAD
    return word[at:at + size]


# ---------------------------------------------------------------------------
# The artifact, which is what actually travels
# ---------------------------------------------------------------------------

def open_artifact(blob):
    """`open(artifact)` — the residual, or the dead one for anything else."""
    try:
        payload = codec.unpack(blob)
    except codec.Malformed:
        return machine.DEAD_RESIDUAL
    return machine.open_payload(payload)


def artifact_of(payload):
    """`pack(code(z))` — the unique byte string for a payload."""
    return codec.pack(codec.code(payload))


def next_artifact(blob, byte):
    """One byte, artifact to artifact. `next_code` with the packing done."""
    try:
        payload = codec.unpack(blob)
    except codec.Malformed:
        payload = DEAD_PAYLOAD
    return artifact_of(res(payload, byte))


def length(payload):
    """`L(z)` of a payload — what (1.3) measures and (1.6) ranks."""
    return codec.length(payload)


def rank(payload):
    """`rank(z)` — the final tie-break for every minimum (1.5)."""
    return codec.rank(payload)
