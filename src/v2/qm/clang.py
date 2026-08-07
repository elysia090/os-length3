"""SPEC §2 — Clang is the entry point.

The compiler is not the minimizer.  It is the frontend normalizer that removes
ordinary source-level noise before QM extracts semantics, and it is what makes
"paste a small C function" mean real C rather than a subset.

Two artefacts come out of one compile:

    --target=x86_64 -O2 -S     the assembly the UI shows, and the instruction
                               count that answers "what did the compiler
                               generate?"  (SPEC §2, §13)

    execution of the same -O2 code   the concrete input/output semantics QM
                                     quotients and verifies against (SPEC §4)

In the browser the second artefact comes from compiling to wasm32 and calling
the exported function; `web/worker.js` does that and hands the table to
`frontend.PrecompiledFrontend`.  In the CLI and the tests it comes from this
module: a native shared object driven through a streaming harness.

Both paths compile the *same* source with the *same* -O2, so the semantics QM
verifies are the semantics of the optimized program either way.
"""

import os
import re
import shutil
import struct
import subprocess
import tempfile

from .cfront import CFrontError
from .cfront.ctypes_model import CType, type_from_keywords

# Freestanding prelude: clang predefines these, so no sysroot header is needed.
# This is what lets the browser bundle run with -nostdlib and no include tree.
PRELUDE = r'''
typedef __UINT8_TYPE__ uint8_t;   typedef __INT8_TYPE__ int8_t;
typedef __UINT16_TYPE__ uint16_t; typedef __INT16_TYPE__ int16_t;
typedef __UINT32_TYPE__ uint32_t; typedef __INT32_TYPE__ int32_t;
typedef __UINT64_TYPE__ uint64_t; typedef __INT64_TYPE__ int64_t;
typedef __UINTPTR_TYPE__ uintptr_t; typedef __INTPTR_TYPE__ intptr_t;
typedef __SIZE_TYPE__ size_t;     typedef __PTRDIFF_TYPE__ ptrdiff_t;
typedef __UINT64_TYPE__ uint_fast64_t; typedef __UINT32_TYPE__ uint_fast32_t;
'''

_INCLUDE = re.compile(r'^\s*#\s*include\s*[<"][^>"]*[>"]\s*$', re.M)

# SPEC §2: source-compilation presets.
MARCH = {
    'x86-64': ['-march=x86-64'],
    'x86-64-v2': ['-march=x86-64-v2'],
    'x86-64-v3': ['-march=x86-64-v3'],
    'x86-64-v4': ['-march=x86-64-v4'],
}
OPT_LEVELS = ('-O1', '-O2', '-O3')


def prepare_source(source):
    """Strip standard includes and prepend the freestanding prelude.

    The includes are removed rather than resolved because a bit-vector kernel
    needs exactly the fixed-width typedefs, and requiring a sysroot is the
    difference between a 50 MB browser bundle and a 300 MB one.
    """
    return PRELUDE + '\n' + _INCLUDE.sub('', source)


# ---------------------------------------------------------------------------
# Signature reading
# ---------------------------------------------------------------------------

_SIGNATURE = re.compile(
    r'(?P<ret>(?:[A-Za-z_][A-Za-z_0-9]*\s+)+)'
    r'(?P<name>[A-Za-z_][A-Za-z_0-9]*)\s*'
    r'\(\s*(?P<params>[^)]*)\)\s*\{',
)
_STORAGE = {'static', 'inline', 'extern', '__inline', '__inline__', 'const'}


def read_signature(source, requested=None):
    """Find the kernel's name and its argument/return types.

    Tries the v2 parser first, since it also validates the subset.  Falls back
    to a textual scan so the Clang path stays usable for C the built-in parser
    does not model — which is the whole point of having Clang.
    """
    try:
        from .cfront import parse
        from .frontend import pick_function
        unit = parse(source)
        fn = pick_function(unit, requested)
        return {
            'name': fn.name,
            'ret': fn.ret,
            'params': [(p.name, p.ctype) for p in fn.params],
            'via': 'parser',
        }
    except CFrontError:
        pass

    found = []
    for match in _SIGNATURE.finditer(source):
        words = [w for w in match.group('ret').split() if w not in _STORAGE]
        if not words:
            continue
        try:
            ret = type_from_keywords(words)
        except CFrontError:
            continue
        params = []
        raw = match.group('params').strip()
        if raw and raw != 'void':
            ok = True
            for part in raw.split(','):
                tokens = [w for w in part.split() if w not in _STORAGE]
                if len(tokens) < 2:
                    ok = False
                    break
                try:
                    params.append((tokens[-1], type_from_keywords(tokens[:-1])))
                except CFrontError:
                    ok = False
                    break
            if not ok:
                continue
        found.append({'name': match.group('name'), 'ret': ret,
                      'params': params, 'via': 'scan'})

    if not found:
        raise CFrontError('no function definition found',
                          hint='paste a complete C function, e.g. '
                               'uint64_t f(uint8_t m) { ... }')
    if requested:
        for entry in found:
            if entry['name'] == requested:
                return entry
        raise CFrontError('function %r is not defined in this source' % requested,
                          hint='found: %s' % ', '.join(e['name'] for e in found))
    return found[-1]


# ---------------------------------------------------------------------------
# Native toolchain
# ---------------------------------------------------------------------------

_HARNESS = r'''
#include <stdio.h>
int main(void)
{
    unsigned long long in, out;
    while (fread(&in, sizeof in, 1, stdin) == 1) {
        out = (unsigned long long)(QM_CAST)%(NAME)s((QM_ARG)in);
        if (fwrite(&out, sizeof out, 1, stdout) != 1) return 2;
    }
    return 0;
}
'''


class ClangError(CFrontError):
    """A compile or execution failure, carrying the compiler's own message."""


class NativeClang(object):
    """Clang on the host, used by the CLI and the tests.

    The browser uses clang compiled to WebAssembly with the same flags; keeping
    both behind one interface is what stops the two from drifting.
    """

    name = 'clang-native'

    def __init__(self, binary=None, timeout=60.0):
        self.binary = binary or shutil.which('clang') or shutil.which('cc')
        self.timeout = timeout

    def available(self):
        return bool(self.binary)

    def version(self):
        if not self.available():
            return None
        out = subprocess.run([self.binary, '--version'], capture_output=True,
                             text=True)
        return out.stdout.splitlines()[0] if out.stdout else None

    def _base_flags(self, opt='-O2', target='x86-64'):
        if opt not in OPT_LEVELS:
            raise ClangError('unsupported optimization level %r' % opt)
        if target not in MARCH:
            raise ClangError('unsupported source target %r' % target)
        return ['-std=gnu11', '-ffreestanding', '-fno-builtin-memcpy',
                opt] + MARCH[target]

    def assembly(self, source, opt='-O2', target='x86-64'):
        """Emit x86-64 assembly for the pasted source."""
        if not self.available():
            raise ClangError('clang was not found on PATH')
        cmd = [self.binary] + self._base_flags(opt, target) + [
            '-S', '-fno-asynchronous-unwind-tables', '-fno-ident',
            '-x', 'c', '-', '-o', '-']
        proc = subprocess.run(cmd, input=prepare_source(source),
                              capture_output=True, text=True,
                              timeout=self.timeout)
        if proc.returncode:
            raise ClangError('clang failed to compile the source',
                             hint=_first_error(proc.stderr))
        return proc.stdout

    def evaluate(self, source, signature, values, opt='-O2', target='x86-64'):
        """Run the -O2 code over `values`, returning the outputs.

        The kernel runs in a separate process: a pasted function that faults
        must not take the tool down with it.
        """
        if not self.available():
            raise ClangError('clang was not found on PATH')
        arg_ctype = signature['params'][0][1]
        harness = (_HARNESS % {'NAME': signature['name']}) \
            .replace('QM_CAST', signature['ret'].name) \
            .replace('QM_ARG', arg_ctype.name)

        with tempfile.TemporaryDirectory(prefix='qm-clang-') as tmp:
            csrc = os.path.join(tmp, 'kernel.c')
            exe = os.path.join(tmp, 'kernel')
            with open(csrc, 'w') as handle:
                handle.write(prepare_source(source))
                handle.write('\n')
                handle.write(harness)

            cmd = [self.binary] + self._base_flags(opt, target) + [
                csrc, '-o', exe]
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=self.timeout)
            if proc.returncode:
                raise ClangError('clang failed to build the execution oracle',
                                 hint=_first_error(proc.stderr))

            payload = b''.join(struct.pack('<Q', v & ((1 << 64) - 1))
                               for v in values)
            run = subprocess.run([exe], input=payload, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=self.timeout)
            if run.returncode:
                raise ClangError('the compiled kernel exited with status %d'
                                 % run.returncode,
                                 hint=run.stderr.decode('utf-8', 'replace')[:400])
            expected = 8 * len(values)
            if len(run.stdout) != expected:
                raise ClangError('execution oracle produced %d bytes, expected '
                                 '%d' % (len(run.stdout), expected))
            return list(struct.unpack('<%dQ' % len(values), run.stdout))


def _first_error(stderr):
    for line in (stderr or '').splitlines():
        if 'error:' in line:
            return line.strip()
    return (stderr or '').strip().splitlines()[-1] if stderr else None


NATIVE = NativeClang()
