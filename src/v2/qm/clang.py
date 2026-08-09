"""Clang is the C entry point.

The compiler is not the minimizer.  It is the frontend normalizer that removes
ordinary source-level noise before QM extracts semantics, and it is what makes
"paste a small C function" mean real C rather than a subset.

Two artefacts come out of one compile:

    --target=x86_64 -O2 -S     the assembly the UI shows, and the instruction
                               count that answers "what did the compiler
                               generate?"

    execution of the same -O2 code   the concrete input/output semantics QM
                                     quotients and verifies against

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

from .cfront import CFrontError, NoEntry
from .cfront.ctypes_model import CType, type_from_keywords
from .cfront.intrinsics import c_shims_for

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

# Source-compilation presets.
MARCH = {
    'x86-64': ['-march=x86-64'],
    'x86-64-v2': ['-march=x86-64-v2'],
    'x86-64-v3': ['-march=x86-64-v3'],
    'x86-64-v4': ['-march=x86-64-v4'],
}
OPT_LEVELS = ('-O1', '-O2', '-O3')


# What a `main` gets instead of a C library. The module is compiled
# `-nostdlib`, so these are the only two things that cross out of it, and the
# page supplies them as imports. Everything else a driver usually reaches for
# is written here in terms of them, so the paste needs no headers and the
# browser needs no WASI.
STDIO = r'''
extern int qm_getchar(void);
extern void qm_putchar(int c);

static int getchar(void) { return qm_getchar(); }
static int putchar(int c) { qm_putchar(c); return c; }

static int puts(const char *s)
{
    while (*s) qm_putchar(*s++);
    qm_putchar('\n');
    return 0;
}

static void print_u64(uint64_t v)
{
    char buf[20];
    int n = 0;
    if (!v) { qm_putchar('0'); return; }
    while (v) { buf[n++] = (char)('0' + (int)(v % 10u)); v /= 10u; }
    while (n) qm_putchar(buf[--n]);
}

static void print_hex64(uint64_t v)
{
    qm_putchar('0'); qm_putchar('x');
    for (int shift = 60; shift >= 0; shift -= 4) {
        int d = (int)((v >> shift) & 15u);
        qm_putchar(d < 10 ? '0' + d : 'a' + d - 10);
    }
}
'''


def prepare_driver(source, signature=None):
    """The driver translation unit, with the selected kernel as an import.

    This is the half that makes Run mean something. Compiling the whole paste
    would run Clang's compilation of the kernel — the page would be testing the
    compiler, not the minimizer. Only the selected kernel definition is
    dropped. `main`, globals and every other helper stay in the translation
    unit, while an external declaration makes calls to the kernel resolve to
    the artifact. What executes is then

        paste -> QM -> codec -> run

    with the driver as the thing that drives it.

    `signature` is the kernel QM took, as `read_signature` returns it. Without
    one there is nothing to replace and the whole paste is compiled, which is
    the honest fallback when the minimizer found no kernel to begin with.
    """
    source = source or ''
    _kernel, span = split_main(source)
    if span is None:
        body = _INCLUDE.sub('', source)
        return PRELUDE + '\n' + STDIO + '\n' + c_shims_for(body) + body

    if signature:
        param = signature['params'][0][1].name
        declaration = 'extern %s %s(%s);\n' % (
            signature['ret'].name, signature['name'], param)
    else:
        body = _INCLUDE.sub('', source)
        return PRELUDE + '\n' + STDIO + '\n' + c_shims_for(body) + body

    kernel_span = _definition_span(source, signature['name'])
    if kernel_span is None:
        body = _INCLUDE.sub('', source)
        return PRELUDE + '\n' + STDIO + '\n' + c_shims_for(body) + body
    driver = _INCLUDE.sub('', source[:kernel_span[0]] + source[kernel_span[1]:])
    return (PRELUDE + '\n' + STDIO + '\n' + declaration + '\n'
            + c_shims_for(driver) + driver)


def prepare_source(source):
    """Strip standard includes and prepend the freestanding prelude.

    The includes are removed rather than resolved because a bit-vector kernel
    needs exactly the fixed-width typedefs, and requiring a sysroot is the
    difference between a 50 MB browser bundle and a 300 MB one.

    Stripping `<immintrin.h>` takes the intrinsics with it, and the browser
    compiles for wasm32 where that header does not exist at all — so whichever
    of them the paste uses are supplied here as portable C.  Without that, QM
    emits code it cannot read: paste back its own `_pdep_u64` output and Clang
    says the function is undeclared.
    """
    body = _INCLUDE.sub('', source)
    return PRELUDE + '\n' + c_shims_for(body) + body


# ---------------------------------------------------------------------------
# The driver, and the kernel underneath it
# ---------------------------------------------------------------------------

def _code_mask(source):
    """A byte per character: 1 where it is code, 0 in a comment or a literal.

    Brace matching that counts a `}` inside a string is a brace matcher that
    silently takes the wrong half of the file, so the scan happens once here
    and everything below reads the mask.
    """
    mask = bytearray(len(source))
    i, n = 0, len(source)
    while i < n:
        c = source[i]
        if c == '/' and i + 1 < n and source[i + 1] == '/':
            while i < n and source[i] != '\n':
                i += 1
            continue
        if c == '/' and i + 1 < n and source[i + 1] == '*':
            i += 2
            while i + 1 < n and not (source[i] == '*' and source[i + 1] == '/'):
                i += 1
            i = min(i + 2, n)
            continue
        if c in '"\'':
            quote = c
            i += 1
            while i < n:
                if source[i] == '\\':
                    i += 2
                    continue
                if source[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        mask[i] = 1
        i += 1
    return mask


def _match(source, mask, start, opener, closer):
    """Index just past the `closer` that matches the `opener` at `start`."""
    depth = 0
    for i in range(start, len(source)):
        if not mask[i]:
            continue
        if source[i] == opener:
            depth += 1
        elif source[i] == closer:
            depth -= 1
            if not depth:
                return i + 1
    return -1


def split_main(source):
    """`(kernel, main_span)` — the paste without its driver, and where it was.

    A paste may carry a `main` that exercises the kernel. The minimizer must
    not see it: `main` is a driver, its input is a stream rather than a domain,
    and analysing it would report the driver's function instead of the
    kernel's. Running the paste, on the other hand, needs exactly the whole
    thing. So the split happens once, here, where the browser and the native
    path share it.

    `main_span` is None when there is no file-scope `main`, and the caller can
    then say that pressing Run changes nothing.
    """
    source = source or ''
    span = _definition_span(source, 'main')
    if span is None:
        return source, None
    return source[:span[0]] + source[span[1]:], span


def _definition_span(source, name):
    """The source span of one file-scope function definition, if present."""
    mask = _code_mask(source)
    call = re.compile(r'\b%s\s*\(' % re.escape(name))
    for hit in call.finditer(source):
        at = hit.start()
        if not mask[at]:
            continue
        if _depth_at(source, mask, at):
            continue                        # a call inside a function body
        close = _match(source, mask, hit.end() - 1, '(', ')')
        if close < 0:
            continue
        rest = close
        while rest < len(source) and (not mask[rest] or source[rest].isspace()):
            rest += 1
        if rest >= len(source) or source[rest] != '{':
            continue                        # a declaration, not a definition
        end = _match(source, mask, rest, '{', '}')
        if end < 0:
            continue
        start = _definition_start(source, mask, at)
        return start, end
    return None


def _depth_at(source, mask, index):
    depth = 0
    for i in range(index):
        if not mask[i]:
            continue
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth = max(0, depth - 1)
    return depth


def _definition_start(source, mask, at):
    """Back up over a return type and storage classes at file scope."""
    i = at
    while i > 0:
        c = source[i - 1]
        if mask[i - 1] and c in ';}':
            break
        if c == '\n' and i >= 2 and source[i - 2] == '\n':
            break
        i -= 1
    while i < at and source[i].isspace():
        i += 1
    return i


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
        from .frontend import pick_function, rejections
        unit = parse(source)
        fn = pick_function(unit, requested)
        return {
            'name': fn.name,
            'ret': fn.ret,
            'params': [(p.name, p.ctype) for p in fn.params],
            'via': 'parser',
            'others': rejections(unit, fn),
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
        raise NoEntry()
    from .frontend import analysable

    def with_others(chosen):
        return dict(chosen, others=[
            {'name': e['name'],
             'reason': analysable(e['ret'], e['params']) or 'not the root'}
            for e in found if e is not chosen])

    if requested:
        for entry in found:
            if entry['name'] == requested:
                return with_others(entry)
        raise CFrontError('function %r is not defined in this source' % requested,
                          hint='found: %s' % ', '.join(e['name'] for e in found))

    # Same preference as the parser path: a paste of several functions should
    # not be refused because the last one happens to take two arguments.
    usable = [e for e in found if analysable(e['ret'], e['params']) is None]
    return with_others((usable or found)[-1])


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
