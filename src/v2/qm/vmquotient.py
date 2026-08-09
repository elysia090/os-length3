"""Compile an opened finite VM residual into its exact future quotient.

This is the stateful counterpart of minimizing a scalar kernel. The returned
quotient is a build-side closure witness used to prove complete-future equality
between candidate artifacts. It is not serialized and it is not an inference
shortcut: the selected canonical artifact still runs through the transactional
VM and its runtime-derived physical rows.

Not every VM program has a finite reachable quotient. ``max_states`` is a
falsification bound, never a truncation rule; exceeding it raises ``StateLimit``
and leaves the generic VM as the execution path.
"""

from .transducer import compile_transducer


class FutureMismatch(Exception):
    """Candidate artifacts do not denote the same complete byte future."""


def residual_key(residual):
    """Canonical identity of one committed opened residual."""
    if residual.dead:
        return ('dead',)
    picture = residual.image
    return (picture.pc_out, picture.pc_feed,
            tuple(sorted(picture.memory.items())))


def compile_residual(residual, max_states=4096, budget=1 << 22):
    """Return an exact finite closure witness for one VM future."""
    from vm import machine

    def delta(state, byte):
        return machine.feed_with_budget(state, byte, budget=budget)[0]

    return compile_transducer(
        residual,
        delta,
        machine.read,
        alphabet=range(256),
        key=residual_key,
        max_states=max_states,
    )


def same_future(left, right, max_states=4096, budget=1 << 22):
    """Whether two finite VM residuals have the same complete byte future."""
    left_witness = compile_residual(left, max_states=max_states, budget=budget)
    right_witness = compile_residual(right, max_states=max_states, budget=budget)
    return left_witness.semantic_key() == right_witness.semantic_key()


def choose_equivalent(candidates, objective, max_states=4096,
                      budget=1 << 22):
    """Choose the best candidate only after exact future equality is proved.

    ``candidates`` may contain any caller-owned records for which ``record[1]``
    is an opened residual. ``objective(record)`` supplies the already checked
    physical tuple, normally ``(span, work, L, rank)``. Closure witnesses are
    local to this call and are not returned or attached to the winner.
    """
    candidates = list(candidates)
    if not candidates:
        raise ValueError('at least one candidate is required')

    expected = None
    for candidate in candidates:
        witness = compile_residual(candidate[1], max_states=max_states,
                                   budget=budget)
        future = witness.semantic_key()
        if expected is None:
            expected = future
        elif future != expected:
            raise FutureMismatch('candidate futures differ')
    return min(candidates, key=objective)


def dense_physical_key(residual, max_states=4096, budget=1 << 22):
    """Exact finite-closure key for the shipped sequential dense VM.

    Every reachable read and every reachable state/byte feed is included.
    Dense execution has one causal transition chain, so its span and work are
    both the worst transition count. The remaining coordinates are the length
    and canonical rank of the original artifact payload.
    """
    from vm import codec, image, machine

    if residual.dead:
        raise ValueError('the fixed dead residual has no canonical image')

    states = [residual]
    identities = {residual_key(residual): 0}
    worst = 0
    at = 0
    while at < len(states):
        state = states[at]
        at += 1
        _output, steps = machine.read_with_budget(state, budget=budget)
        worst = max(worst, steps)
        for byte in range(256):
            after, steps = machine.feed_with_budget(state, byte, budget=budget)
            worst = max(worst, steps)
            identity = residual_key(after)
            if identity in identities:
                continue
            if len(states) >= max_states:
                from .transducer import StateLimit
                raise StateLimit(max_states)
            identities[identity] = len(states)
            states.append(after)

    payload = image.serialize(residual.image)
    return (worst, worst, codec.length(payload), codec.rank(payload))
