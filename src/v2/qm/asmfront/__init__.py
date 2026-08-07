"""Assembly as an input, not only as an output.

SPEC §2 draws the arrow `optimized assembly -> Quotient Minimizer`. This is that
arrow: paste x86-64 or wasm32 and QM extracts the semantics by evaluating the
listing, then minimizes and lowers to whichever targets you asked for. Going in
one side and out the other is what makes x86 → wasm and wasm → x86 ordinary
uses of the same pipeline rather than separate features.

Neither reader is a full machine. Each covers the integer subset a small kernel
compiles to — which includes everything QM emits, so a round trip is a fixed
point and the suite checks that it is. Anything outside the subset is named and
refused; a wrong evaluation here would be a wrong semantics, and every claim
downstream rests on it.
"""

import re

from ..cfront.errors import CFrontError
from . import wasm, x86

__all__ = ['detect', 'parse', 'wasm', 'x86', 'CFrontError']

# C first: a paste that declares a function body is C even if a line of it
# happens to start with `or`.  Guessing wrong here would send C to a reader
# that cannot possibly parse it, and the error would point at the wrong thing.
_LOOKS_LIKE_C = re.compile(
    r'^\s*#\s*(include|define)\b'
    r'|\b(?:uint(?:8|16|32|64)_t|unsigned\s+long|int\b)[\s*]+\w+\s*\('
    r'|\breturn\b[^;\n]*;',
    re.M)


def detect(text):
    """'wasm32', 'x86-64', or None when it looks like neither."""
    if _LOOKS_LIKE_C.search(text):
        return None
    if wasm.looks_like_wasm(text):
        return 'wasm32'
    if x86.looks_like_x86(text):
        return 'x86-64'
    return None


def parse(text, requested=None, dialect=None):
    """Parse a listing into a callable, returning (function, dialect)."""
    dialect = dialect or detect(text)
    if dialect == 'wasm32':
        return wasm.parse(text, requested), 'wasm32'
    if dialect == 'x86-64':
        return x86.parse(text, requested), 'x86-64'
    raise CFrontError('this does not look like x86-64 or wasm32 assembly',
                      hint='paste a listing with a `name:` label and AT&T '
                           'instructions, or a wasm text function')
