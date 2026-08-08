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
    """The C source of `examples/<name>.c`."""
    return read_example(name + '.c')


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
