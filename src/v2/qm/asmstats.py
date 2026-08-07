"""Statistics over emitted x86-64 assembly.

SPEC §11 insists that three numbers stay distinct:

    core operations
    standalone machine instructions
    estimated microarchitectural cost

This module produces the middle one, from the assembler text the compiler
actually emitted.  It never estimates cycles.

Layer 1: no dependencies inside `qm`.
"""

import re

_LABEL = re.compile(r'^[.\w$]+:\s*$')
_DIRECTIVE = re.compile(r'^\s*\.')
_MNEMONIC = re.compile(r'^\s+([a-z][a-z0-9._]*)\b')

# Assembler mnemonics that do not correspond to a retired instruction.
_PSEUDO = {'nop', 'hlt'}


# WebAssembly mnemonics are dotted (`i32.add`, `local.get`); no x86 mnemonic
# is.  That is enough to name the listing rather than assume one.
def detect_isa(histogram):
    if not histogram:
        return 'unknown'
    dotted = sum(n for m, n in histogram.items() if '.' in m)
    total = sum(histogram.values())
    if dotted * 2 > total:
        return 'wasm32'
    return 'x86-64'


def analyze(text, function=None, isa=None):
    """Count instructions in a GAS-syntax assembly listing.

    Works for both x86-64 and WebAssembly listings, because which one a Clang
    bundle can emit depends on the targets it was built with.  The ISA is
    detected from the mnemonics and reported, so a count is never presented as
    being for an architecture it is not.

    When `function` is given, only that symbol's body is counted, from its
    label to the next `.size` directive or the next top-level label.
    """
    if not text:
        return {'available': False, 'reason': 'no assembly text'}

    lines = text.splitlines()
    if function:
        sliced = _slice_function(lines, function)
        # A listing may name the symbol differently (or not at all); counting
        # the whole listing is better than reporting nothing, as long as the
        # report says which happened.
        lines = sliced if sliced is not None else lines

    histogram = {}
    total = 0
    for line in lines:
        if _DIRECTIVE.match(line) or _LABEL.match(line.strip()) or not line.strip():
            continue
        if line.lstrip().startswith(('#', '//', '/*')):
            continue
        match = _MNEMONIC.match(line)
        if not match:
            continue
        mnemonic = match.group(1)
        if mnemonic in _PSEUDO:
            continue
        histogram[mnemonic] = histogram.get(mnemonic, 0) + 1
        total += 1

    histogram = dict(sorted(histogram.items(), key=lambda kv: (-kv[1], kv[0])))
    detected = isa or detect_isa(histogram)
    return {
        'available': True,
        'isa': detected,
        'instructions': total,
        'distinct_mnemonics': len(histogram),
        'histogram': histogram,
        'note': 'standalone %s instructions in the emitted listing; '
                'not a cycle estimate' % detected,
    }


def _slice_function(lines, function):
    start = None
    label = function + ':'
    for index, line in enumerate(lines):
        if line.strip().startswith(label):
            start = index + 1
            break
    if start is None:
        return None

    out = []
    for line in lines[start:]:
        stripped = line.strip()
        if stripped.startswith('.size') and function in stripped:
            break
        if _LABEL.match(stripped) and not stripped.startswith('.L'):
            break
        out.append(line)
    return out
