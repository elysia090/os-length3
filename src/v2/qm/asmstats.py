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


def analyze(text, function=None):
    """Count instructions in GAS-syntax assembly.

    When `function` is given, only that symbol's body is counted, from its
    label to the next `.size` directive or the next top-level label.
    """
    if not text:
        return {'available': False, 'reason': 'no assembly text'}

    lines = text.splitlines()
    if function:
        lines = _slice_function(lines, function)
        if lines is None:
            return {'available': False,
                    'reason': 'symbol %r not found in the assembly' % function}

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

    return {
        'available': True,
        'instructions': total,
        'distinct_mnemonics': len(histogram),
        'histogram': dict(sorted(histogram.items(), key=lambda kv: (-kv[1], kv[0]))),
        'note': 'standalone machine instructions in the emitted assembly; '
                'not a cycle estimate',
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
