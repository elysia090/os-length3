"""The observation quotient comes from an explicit observer.

    obs : Output -> Observable
    y ~ y'   iff   obs(y) == obs(y')

The default observer is the identity on the declared return width.  A bit that
happens to be constant over the current test domain is still part of the output
contract; QM never infers don't-care bits from the target image.
"""

from .bits import mask_of


class Observer(object):
    __slots__ = ('spec', 'kind', 'description', '_fn', 'mask')

    def __init__(self, spec, kind, description, fn, mask=None):
        self.spec = spec
        self.kind = kind
        self.description = description
        self._fn = fn
        self.mask = mask

    def __call__(self, y):
        return self._fn(y)

    @property
    def is_identity(self):
        return self.kind == 'exact'

    def to_dict(self):
        d = {'spec': self.spec, 'kind': self.kind, 'description': self.description}
        if self.mask is not None:
            d['mask'] = '0x%016X' % (self.mask,)
        return d


def exact(output_bits=64):
    m = mask_of(output_bits)
    return Observer(
        'exact', 'exact', 'exact %d-bit output; no don\'t-care bits' % output_bits,
        lambda y: y & m, m,
    )


def bit_mask(mask, output_bits=64):
    m = mask & mask_of(output_bits)
    return Observer(
        'mask:0x%X' % (m,), 'mask',
        'bits selected by 0x%X are observable; every other bit is a declared '
        'don\'t-care' % (m,),
        lambda y: y & m, m,
    )


def low_bits(n, output_bits=64):
    m = mask_of(min(n, output_bits))
    return Observer(
        'low:%d' % n, 'low', 'only the low %d bits are observable' % n,
        lambda y: y & m, m,
    )


def high_bits(n, output_bits=64):
    n = min(n, output_bits)
    m = mask_of(output_bits) ^ mask_of(output_bits - n)
    return Observer(
        'high:%d' % n, 'high', 'only the high %d bits are observable' % n,
        lambda y: y & m, m,
    )


def nonzero(output_bits=64):
    m = mask_of(output_bits)
    return Observer(
        'nonzero', 'nonzero', 'only zero / nonzero is observable',
        lambda y: 1 if (y & m) else 0, None,
    )


def byte_lane(index, output_bits=64):
    m = 0xFF << (8 * index)
    m &= mask_of(output_bits)
    return Observer(
        'byte:%d' % index, 'mask', 'only byte lane %d is observable' % index,
        lambda y: y & m, m,
    )


def parse(spec, output_bits=64):
    """Parse an observer spec string.

    Accepted:
        exact
        low:N          high:N
        mask:0xFFFF    byte:K
        nonzero
    """
    s = (spec or 'exact').strip().lower()
    if s in ('exact', 'identity', ''):
        return exact(output_bits)
    if s == 'nonzero':
        return nonzero(output_bits)
    if ':' in s:
        head, tail = s.split(':', 1)
        tail = tail.strip()
        try:
            value = int(tail, 0)
        except ValueError:
            raise ValueError('observer %r: %r is not an integer' % (spec, tail))
        if head == 'low':
            return low_bits(value, output_bits)
        if head == 'high':
            return high_bits(value, output_bits)
        if head == 'mask':
            return bit_mask(value, output_bits)
        if head == 'byte':
            return byte_lane(value, output_bits)
    raise ValueError('unknown observer spec: %r' % (spec,))


def equivalent(y, y_prime, obs):
    return obs(y) == obs(y_prime)
