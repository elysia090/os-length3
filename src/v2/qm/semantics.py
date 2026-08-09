"""Extract finite-domain semantics behind a frontend-independent boundary.

`Semantics` is the boundary between the frontend (which knows about C, assembly
or a native oracle) and the solvers (which only ever see a function on a
declared finite domain).

The domain records its own verification strength, so a report can never claim
"exhaustive" for a sampled domain.

Layer 1: depends on `bits` only.
"""

from .bits import mask_of, xorshift_stream


class Domain(object):
    """The finite set of inputs on which semantics are extracted and verified."""

    __slots__ = ('input_bits', 'kind', '_values', 'strength', 'note')

    def __init__(self, input_bits, kind, values, strength, note=''):
        self.input_bits = input_bits
        self.kind = kind
        self._values = values
        self.strength = strength
        self.note = note

    def values(self):
        return self._values

    def __len__(self):
        return len(self._values)

    @property
    def exhaustive(self):
        """True only for the complete declared input domain."""
        return self.kind == 'exhaustive'

    @property
    def finite_exact(self):
        """True when every listed input is checked exactly.

        A derived subset (for example the image of a POINT prefilter) is
        checked exactly, but it is not the whole declared domain, so it must
        never be reported as exhaustive verification.
        """
        return self.kind in ('exhaustive', 'subset')

    def to_dict(self):
        return {
            'input_bits': self.input_bits,
            'kind': self.kind,
            'size': len(self._values),
            'strength': self.strength,
            'note': self.note,
            'total_inputs': 1 << self.input_bits,
        }


def choose_domain(input_bits, exhaustive_limit=16, probes=4096):
    """Exhaustive when tractable, structured probes otherwise.

    Random testing alone is not a proof of global equivalence, so a sampled
    domain is labelled as such and carries basis and boundary probes rather
    than random values only.
    """
    if input_bits <= exhaustive_limit:
        n = 1 << input_bits
        return Domain(
            input_bits, 'exhaustive', list(range(n)),
            'exact exhaustive',
            'all %d inputs of the declared %d-bit domain' % (n, input_bits),
        )

    m = mask_of(input_bits)
    vals = [0, m]
    vals.extend(1 << i for i in range(input_bits))           # basis
    vals.extend((1 << i) - 1 for i in range(1, input_bits))  # low runs
    vals.extend(m ^ (1 << i) for i in range(input_bits))     # boundary
    vals.extend(xorshift_stream(0x9E3779B97F4A7C15, probes, input_bits))

    seen = set()
    uniq = []
    for v in vals:
        if v not in seen:
            seen.add(v)
            uniq.append(v)

    return Domain(
        input_bits, 'probe', uniq,
        'basis + boundary + deterministic differential',
        'basis, boundary and %d deterministic probes; NOT a proof of global '
        'equivalence' % probes,
    )


class Semantics(object):
    """A concrete function on a finite domain, plus its declared widths."""

    __slots__ = ('target', 'input_bits', 'output_bits', 'domain', '_table', 'meta')

    def __init__(self, target, input_bits, output_bits, domain=None, meta=None):
        self.target = target
        self.input_bits = input_bits
        self.output_bits = output_bits
        self.domain = domain or choose_domain(input_bits)
        self.meta = meta or {}
        self._table = None

    def table(self):
        """Outputs aligned with `domain.values()`, evaluated once."""
        if self._table is None:
            om = mask_of(self.output_bits)
            self._table = [self.target(x) & om for x in self.domain.values()]
        return self._table

    def pairs(self):
        return zip(self.domain.values(), self.table())

    def value_at(self, x):
        return self.target(x) & mask_of(self.output_bits)

    def basis_images(self):
        """f(1<<i) for i in range(input_bits) — the GF(2)-linear signature."""
        return [self.value_at(1 << i) for i in range(self.input_bits)]

    def restricted(self, values):
        """Same function, restricted to an explicit subset of inputs."""
        d = Domain(
            self.input_bits, 'subset', list(values),
            'exhaustive over a derived subset',
            'derived subset of %d inputs' % len(values),
        )
        return Semantics(self.target, self.input_bits, self.output_bits, d,
                         dict(self.meta))

    def to_dict(self):
        return {
            'input_bits': self.input_bits,
            'output_bits': self.output_bits,
            'domain': self.domain.to_dict(),
            'meta': self.meta,
        }


def from_callable(fn, input_bits, output_bits, exhaustive_limit=16, meta=None):
    return Semantics(
        fn, input_bits, output_bits,
        choose_domain(input_bits, exhaustive_limit=exhaustive_limit),
        meta,
    )
