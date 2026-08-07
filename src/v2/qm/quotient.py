"""SPEC §5 — the two quotients, kept deliberately separate.

Observation quotient
    Can the caller distinguish these outputs?

Future quotient
    Can any continuation distinguish these states?

They answer different questions and are computed by different code paths here so
that a report can never silently substitute one for the other.

Layer 2: depends on `bits`, `observer`, `semantics`.
"""

from .observer import exact


# ---------------------------------------------------------------------------
# 5.1  Observation quotient
# ---------------------------------------------------------------------------

def observation_classes(values, obs=None):
    """Equivalence-class ids aligned with `values`.

    This function never inspects which output bits vary.  Exact output is the
    default because `obs` defaults to the identity.
    """
    obs = obs or exact()
    key_to_class = {}
    classes = []
    for v in values:
        key = obs(v)
        if key not in key_to_class:
            key_to_class[key] = len(key_to_class)
        classes.append(key_to_class[key])
    return classes


def observation_report(sem, obs):
    """How much the declared observer actually collapses on this domain."""
    table = sem.table()
    exact_classes = len(set(table))
    observed_classes = len(set(obs(y) for y in table))
    return {
        'domain_size': len(table),
        'distinct_outputs': exact_classes,
        'distinct_observables': observed_classes,
        'collapsed': exact_classes - observed_classes,
        'is_identity_on_domain': exact_classes == observed_classes,
        'observer': obs.to_dict(),
    }


# ---------------------------------------------------------------------------
# 5.2  Future quotient
# ---------------------------------------------------------------------------

def future_quotient(delta, out, states, alphabet):
    """Myhill-Nerode partition refinement over an explicit transition system.

    Two states are equivalent when no future continuation distinguishes them
    through `out`.
    """
    part = {}
    for s in states:
        part.setdefault(out(s), set()).add(s)

    cls = {}
    for i, (_, group) in enumerate(sorted(part.items(), key=lambda kv: repr(kv[0]))):
        for s in group:
            cls[s] = i

    while True:
        sig = {s: (cls[s], tuple(cls[delta(s, a)] for a in alphabet)) for s in states}
        nxt = {}
        new = {}
        for s in states:
            nxt.setdefault(sig[s], len(nxt))
            new[s] = nxt[sig[s]]
        if new == cls:
            return cls
        cls = new


def streaming_future_quotient(sem, obs=None, max_input_bits=13):
    """Future quotient of the input-bit stream automaton.

    Read the input LSB-first.  The state after k bits is the residual map from
    the remaining bits to the observable.  Two prefixes are future-equivalent
    exactly when their residual maps agree, so the number of classes at level k
    is how much state a streaming implementation must still carry.

    This is the concrete answer to "can any continuation distinguish these
    states?" on a finite input domain, and it is what justifies removing state
    handoff, history and intermediate rank arrays.
    """
    obs = obs or exact(sem.output_bits)
    n = sem.input_bits

    if not sem.domain.exhaustive:
        return {'computed': False,
                'reason': 'future quotient needs an exhaustive input domain'}
    if n > max_input_bits:
        return {'computed': False,
                'reason': 'input domain 2^%d exceeds the interactive budget (2^%d)'
                          % (n, max_input_bits)}

    table = [obs(y) for y in sem.table()]

    levels = []
    total_states = 0
    for k in range(n + 1):
        suffix_count = 1 << (n - k)
        residuals = set()
        for prefix in range(1 << k):
            residuals.add(tuple(table[prefix | (s << k)] for s in range(suffix_count)))
        levels.append(len(residuals))
        total_states += len(residuals)

    peak = max(levels)
    return {
        'computed': True,
        'levels': levels,
        'minimal_states': total_states,
        'peak_classes': peak,
        'state_bits': max(0, (peak - 1).bit_length()),
        'naive_state_bits': n,
        'note': 'states after k input bits, merged when no continuation of the '
                'remaining bits can distinguish them',
    }
