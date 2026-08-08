"""Shared helpers for the suite.

`solve` is a pure function of its arguments — the fixed-point tests only mean
something because it is — so solving the same source twice is not a second
measurement, it is the first one paid for again. The suite did that a lot: five
test methods in `test_asmfront` each derived the same fifteen listings from the
same fifteen sources, and a 2^16 kernel costs seconds a time.

So it is memoized here, once, instead of being repeated everywhere. The
property that makes this sound is checked directly by
`test_pipeline.TestDeterminism` rather than being assumed by accident.

The cached result is shared, not copied. Nothing in the suite mutates a result,
and a test that needs to should copy what it changes.
"""

import os

from qm.pipeline import solve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES = os.path.join(ROOT, 'examples')

_CACHE = {}


def read_example(name):
    """The text of `examples/<name>`, with the suffix included."""
    with open(os.path.join(EXAMPLES, name)) as handle:
        return handle.read()


def example(name):
    """The kernel in `examples/<name>.c` — what QM is given.

    An example may carry a `main` that drives it, and the product splits that
    off before minimizing: `main` reads a stream rather than a domain, so
    minimizing it would report the driver's function. The sweeps here apply the
    same split, for the same reason. `read_example` still returns the whole
    file, which is what running it needs.
    """
    from qm.clang import split_main
    kernel, _span = split_main(read_example(name + '.c'))
    return kernel


def _key(source, kwargs):
    return (source, tuple(sorted(
        (k, repr(v)) for k, v in kwargs.items() if v is not None)))


def solved(source, **kwargs):
    """`pipeline.solve(source, **kwargs)`, computed at most once per input."""
    key = _key(source, kwargs)
    if key not in _CACHE:
        _CACHE[key] = solve(source, **kwargs)
    return _CACHE[key]


def target(result, name=None):
    """One target record: the named one, or the primary one."""
    name = name or result.get('primary_target')
    return next((t for t in result.get('targets') or [] if t['name'] == name),
                None)


# ---------------------------------------------------------------------------
# Warming
# ---------------------------------------------------------------------------

def _solve_one(item):
    key, source, kwargs = item
    return key, solve(source, **kwargs)


def _absorb(pool, work):
    """Solve `work` across the pool and keep the answers in this process."""
    pending = [item for item in work if item[0] not in _CACHE]
    for key, result in pool.imap_unordered(_solve_one, pending, chunksize=1):
        _CACHE[key] = result


def _pair(source, **kwargs):
    return (_key(source, kwargs), source, kwargs)


def warm(pool):
    """Precompute the solves the suite shares, across `pool`.

    `solve` is a pure function, and the suite calls it about a hundred times on
    a couple of dozen distinct inputs that do not depend on each other. They
    are evaluated in parallel here so the answers are already in the cache when
    the first assertion runs, and — since the test workers are forked
    afterwards — every one of them inherits the same answers instead of
    recomputing the ones it happens to need.

    Nothing has to be warmed. A source that is not listed here is solved on
    demand, exactly as before; this only decides when the work happens.
    """
    sources = [name for name in sorted(os.listdir(EXAMPLES))
               if name.endswith(('.c', '.s', '.wat'))]
    first = [_pair(read_example(name),
                   **({'frontend': 'cfront'} if name.endswith('.c') else {}))
             for name in sources]
    _absorb(pool, first)

    # What the round trips and the idempotence check ask next: QM's own output,
    # in all three languages, fed back in.
    second = []
    for key, source, kwargs in first:
        result = _CACHE.get(key)
        if not result or not result.get('ok') or not result.get('program'):
            continue
        primary = target(result)
        if primary and primary.get('c'):
            second.append(_pair(primary['c'], frontend='cfront'))
        for name in (result.get('primary_target'), 'wasm32'):
            listing = target(result, name)
            if listing and listing.get('asm'):
                second.append(_pair(listing['asm']))
    _absorb(pool, second)
