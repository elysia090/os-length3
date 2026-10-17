#!/usr/bin/env python3
"""Execution-oracle backend for Quotient Minimizer x86-64 frontends.

Design goal
===========
Do not reimplement thousands of x86 instructions in Python.  For concrete
semantics, assemble/link the user's function and execute it in an isolated
helper process.  The processor (or an optional Intel SDE command prefix) is
the semantics engine.  This makes instruction coverage equal to the selected
execution backend rather than equal to a handwritten opcode switch.

The handwritten interpreter remains useful as a fast, inspectable path for
small compiler-generated integer/SIMD blocks.  This module is the completeness
fallback for application-level x86-64.

Boundary
========
The oracle models *function semantics*, not a whole operating system.  By
default it rejects explicitly environment-dependent/nondeterministic mnemonics
when they can be identified from disassembly, and it runs the helper with a
strict seccomp mode after startup.  Privileged instructions, syscalls, I/O,
and other machine/OS interactions are therefore outside the default QM pure-
function contract.

Supported ABI atoms
===================
Integers: u8/u16/u32/u64, i8/i16/i32/i64
Floating: f32/f64/f80 (x87 80-bit payload for f80)
Vectors:  v128/v256/v512
Pointers: in:N, out:N, inout:N  (N bytes)
Return:   any scalar/vector atom above, or void

The oracle supports SysV x86-64 and clang's ms_abi bridge on Linux.
"""
from __future__ import annotations

import os
import re
import resource
import select
import signal
import shlex
import shutil
import struct
import subprocess
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


# ---------------------------------------------------------------------------
# ABI description
# ---------------------------------------------------------------------------

_SCALAR = {
    'u8':  ('uint8_t', 1),
    'u16': ('uint16_t', 2),
    'u32': ('uint32_t', 4),
    'u64': ('uint64_t', 8),
    'u128': ('unsigned __int128', 16),
    'i8':  ('int8_t', 1),
    'i16': ('int16_t', 2),
    'i32': ('int32_t', 4),
    'i64': ('int64_t', 8),
    'i128': ('__int128', 16),
    'f16': ('_Float16', 2),
    'f32': ('float', 4),
    'f64': ('double', 8),
    # x86-64 SysV long double is the 80-bit x87 extended format in a
    # 16-byte C object.  The wire format intentionally carries only the
    # architecturally meaningful 10-byte payload, not indeterminate padding.
    'f80': ('long double', 10),
    'v128': ('qm_v128', 16),
    'v256': ('qm_v256', 32),
    'v512': ('qm_v512', 64),
}
_PTR_RE = re.compile(r'^(in|out|inout):(\d+)$')


@dataclass(frozen=True)
class ABIAtom:
    spec: str
    kind: str
    size: int
    ctype: str
    direction: str | None = None

    @property
    def input_size(self) -> int:
        if self.kind == 'ptr':
            return self.size if self.direction in ('in', 'inout') else 0
        return self.size

    @property
    def output_size(self) -> int:
        if self.kind == 'ptr':
            return self.size if self.direction in ('out', 'inout') else 0
        return 0


def parse_atom(spec: str) -> ABIAtom:
    s = spec.strip().lower()
    if s in _SCALAR:
        ctype, size = _SCALAR[s]
        return ABIAtom(s, 'value', size, ctype)
    m = _PTR_RE.match(s)
    if m:
        direction, n = m.groups()
        n = int(n)
        if n < 0 or n > (1 << 24):
            raise ValueError(f'unreasonable buffer size: {spec}')
        return ABIAtom(s, 'ptr', n, 'uint8_t *', direction)
    raise ValueError(f'unknown ABI atom: {spec}')


@dataclass(frozen=True)
class FunctionABI:
    args: tuple[str, ...] = ('u64',)
    ret: str = 'u64'
    callconv: str = 'sysv'   # sysv | ms

    def parsed_args(self) -> tuple[ABIAtom, ...]:
        return tuple(parse_atom(x) for x in self.args)

    def parsed_ret(self) -> ABIAtom | None:
        if self.ret.strip().lower() == 'void':
            return None
        a = parse_atom(self.ret)
        if a.kind != 'value':
            raise ValueError('return value cannot be a pointer-buffer ABI atom')
        return a

    @property
    def input_size(self) -> int:
        return sum(a.input_size for a in self.parsed_args())

    @property
    def output_size(self) -> int:
        r = self.parsed_ret()
        return (r.size if r else 0) + sum(a.output_size for a in self.parsed_args())

    def compiler_flags(self) -> list[str]:
        specs = set(self.args) | {self.ret}
        flags = []
        if 'v256' in specs:
            flags.append('-mavx')
        if 'v512' in specs:
            flags.append('-mavx512f')
        return flags


# ---------------------------------------------------------------------------
# Wire codec
# ---------------------------------------------------------------------------

_INT_FMT = {
    'u8':'<B', 'u16':'<H', 'u32':'<I', 'u64':'<Q',
    'i8':'<b', 'i16':'<h', 'i32':'<i', 'i64':'<q',
    'f16':'<e', 'f32':'<f', 'f64':'<d',
}


def _pack_value(atom: ABIAtom, value) -> bytes:
    if atom.spec in _INT_FMT:
        return struct.pack(_INT_FMT[atom.spec], value)
    if atom.spec in ('u128','i128'):
        signed_flag = atom.spec == 'i128'
        return int(value).to_bytes(16, 'little', signed=signed_flag)
    if atom.spec == 'f80':
        if isinstance(value, (bytes, bytearray, memoryview)):
            b = bytes(value)
            if len(b) != 10:
                raise ValueError('f80 wire value must be exactly 10 bytes')
            return b
        raise TypeError('f80 values use the exact 10-byte x87 payload')
    if atom.spec in ('v128','v256','v512'):
        b = bytes(value)
        if len(b) != atom.size:
            raise ValueError(f'{atom.spec} requires {atom.size} bytes')
        return b
    raise AssertionError(atom)


def _unpack_value(atom: ABIAtom, data: bytes):
    if atom.spec in _INT_FMT:
        return struct.unpack(_INT_FMT[atom.spec], data)[0]
    if atom.spec in ('u128','i128'):
        return int.from_bytes(data, 'little', signed=(atom.spec == 'i128'))
    if atom.spec == 'f80' or atom.spec in ('v128','v256','v512'):
        return bytes(data)
    raise AssertionError(atom)


def pack_call(abi: FunctionABI, args: Sequence) -> bytes:
    aa = abi.parsed_args()
    if len(args) != len(aa):
        raise ValueError(f'expected {len(aa)} args, got {len(args)}')
    out = bytearray()
    for atom, value in zip(aa, args):
        if atom.kind == 'value':
            out += _pack_value(atom, value)
        elif atom.direction in ('in','inout'):
            b = bytes(value)
            if len(b) != atom.size:
                raise ValueError(f'{atom.spec} requires {atom.size} input bytes')
            out += b
        else:
            # out:N has no input payload.  The caller may pass None for clarity.
            if value not in (None, b'', bytearray()):
                raise ValueError(f'{atom.spec} takes no input payload; pass None')
    assert len(out) == abi.input_size
    return bytes(out)


def unpack_result(abi: FunctionABI, data: bytes):
    if len(data) != abi.output_size:
        raise ValueError(f'bad output record size {len(data)} != {abi.output_size}')
    p = 0
    ret_atom = abi.parsed_ret()
    ret = None
    if ret_atom:
        ret = _unpack_value(ret_atom, data[p:p+ret_atom.size])
        p += ret_atom.size
    bufs = []
    for atom in abi.parsed_args():
        if atom.output_size:
            bufs.append(bytes(data[p:p+atom.size]))
            p += atom.size
    if bufs:
        return (ret, *bufs) if ret_atom else tuple(bufs)
    return ret


# ---------------------------------------------------------------------------
# C harness generation
# ---------------------------------------------------------------------------

_C_PROLOGUE = r'''
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <errno.h>

typedef long long qm_v128 __attribute__((vector_size(16)));
typedef long long qm_v256 __attribute__((vector_size(32)));
typedef long long qm_v512 __attribute__((vector_size(64)));

static int rdall(int fd, void *buf, size_t n) {
    unsigned char *p = (unsigned char *)buf;
    size_t k = 0;
    while (k < n) {
        ssize_t r = read(fd, p + k, n - k);
        if (r == 0) return k == 0 ? 0 : -1;
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        k += (size_t)r;
    }
    return 1;
}

static int wrall(int fd, const void *buf, size_t n) {
    const unsigned char *p = (const unsigned char *)buf;
    size_t k = 0;
    while (k < n) {
        ssize_t r = write(fd, p + k, n - k);
        if (r < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        k += (size_t)r;
    }
    return 0;
}
'''


def _decl_attr(callconv: str) -> str:
    cc = callconv.lower()
    if cc == 'sysv':
        return '__attribute__((sysv_abi))'
    if cc == 'ms':
        return '__attribute__((ms_abi))'
    raise ValueError(f'unsupported call convention: {callconv}')


def _c_load_value(atom: ABIAtom, name: str, pvar: str) -> list[str]:
    if atom.spec == 'f80':
        return [
            f'    {atom.ctype} {name} = 0;',
            f'    memcpy(&{name}, {pvar}, 10);',
            f'    {pvar} += 10;',
        ]
    return [
        f'    {atom.ctype} {name};',
        f'    memcpy(&{name}, {pvar}, {atom.size});',
        f'    {pvar} += {atom.size};',
    ]


def _c_store_value(atom: ABIAtom, name: str, qvar: str) -> list[str]:
    if atom.spec == 'f80':
        return [
            '    { unsigned char t80[sizeof(long double)] = {0};',
            f'      memcpy(t80, &{name}, sizeof(long double));',
            f'      memcpy({qvar}, t80, 10); {qvar} += 10; }}',
        ]
    return [
        f'    memcpy({qvar}, &{name}, {atom.size});',
        f'    {qvar} += {atom.size};',
    ]


def generate_harness(function: str, abi: FunctionABI, *, strict_seccomp=True) -> str:
    args = abi.parsed_args()
    ret = abi.parsed_ret()
    attr = _decl_attr(abi.callconv)

    decl_args = ', '.join(a.ctype for a in args) or 'void'
    ret_type = ret.ctype if ret else 'void'

    L = [_C_PROLOGUE]
    L.append(f'extern {ret_type} {attr} {function}({decl_args});\n')
    L.append(f'enum {{ QM_IN = {abi.input_size}, QM_OUT = {abi.output_size} }};\n')
    # ISO C forbids zero-length arrays, use one byte when the logical record is empty.
    L.append('static void qm_eval(const unsigned char *in, unsigned char *out) {')
    L.append('    const unsigned char *p = in;')
    L.append('    unsigned char *q = out;')

    arg_names = []
    for i, atom in enumerate(args):
        name = f'a{i}'
        arg_names.append(name)
        if atom.kind == 'value':
            L.extend(_c_load_value(atom, name, 'p'))
        else:
            # Alignment 64 is sufficient for all current x86 vector widths while
            # still allowing unaligned target accesses naturally.
            n = max(1, atom.size)
            L.append(f'    _Alignas(64) unsigned char {name}_buf[{n}];')
            if atom.direction in ('in','inout') and atom.size:
                L.append(f'    memcpy({name}_buf, p, {atom.size}); p += {atom.size};')
            else:
                L.append(f'    memset({name}_buf, 0, {n});')
            L.append(f'    uint8_t *{name} = {name}_buf;')

    call = f'{function}({", ".join(arg_names)})'
    if ret:
        L.append(f'    {ret.ctype} r = {call};')
        L.extend(_c_store_value(ret, 'r', 'q'))
    else:
        L.append(f'    {call};')

    for i, atom in enumerate(args):
        if atom.kind == 'ptr' and atom.direction in ('out','inout') and atom.size:
            L.append(f'    memcpy(q, a{i}_buf, {atom.size}); q += {atom.size};')

    L.append('}')
    L.append('')
    L.append('int main(void) {')
    L.append('    unsigned char inbuf[QM_IN ? QM_IN : 1];')
    L.append('    unsigned char outbuf[QM_OUT ? QM_OUT : 1];')
    if strict_seccomp:
        # Enter strict seccomp only after process startup and dynamic linking.
        # Strict mode permits read/write/_exit/sigreturn, exactly what the
        # record loop needs around the target call.  If the host/container
        # rejects strict mode we continue; the Python parent still applies
        # resource limits and a timeout.
        L.append('    (void)prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);')
        L.append('    (void)prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT);')
    if abi.input_size == 0:
        # With no input there is no natural EOF-delimited record.  Evaluate once.
        L.append('    qm_eval(inbuf, outbuf);')
        if abi.output_size:
            L.append('    if (wrall(STDOUT_FILENO, outbuf, QM_OUT) < 0) return 3;')
        L.append('    return 0;')
    else:
        L.append('    for (;;) {')
        L.append('        int rr = rdall(STDIN_FILENO, inbuf, QM_IN);')
        L.append('        if (rr == 0) return 0;')
        L.append('        if (rr < 0) return 2;')
        L.append('        qm_eval(inbuf, outbuf);')
        if abi.output_size:
            L.append('        if (wrall(STDOUT_FILENO, outbuf, QM_OUT) < 0) return 3;')
        L.append('    }')
    L.append('}')
    return '\n'.join(L)


# ---------------------------------------------------------------------------
# Disassembly policy / diagnostics
# ---------------------------------------------------------------------------

# These do not describe all of x86.  They are a *purity policy*: instructions
# whose result depends on time, RNG state, machine configuration, privilege,
# or an external OS/device are not ordinary deterministic function semantics.
_NONDETERMINISTIC = {
    'rdrand','rdseed','rdtsc','rdtscp','rdpmc',
}
_ENVIRONMENT = {
    'cpuid','xgetbv','rdpkru','rdpid','rdfsbase','rdgsbase',
}
_SYSTEM_PREFIXES = (
    'vmcall','vmlaunch','vmresume','vmxoff','vmxon','vmrun','vmmcall','stgi','clgi',
    'invept','invvpid','invlpga',
)
_SYSTEM = {
    'syscall','sysenter','sysexit','sysret','iret','iretd','iretq',
    'hlt','cli','sti','clac','stac','swapgs',
    'rdmsr','wrmsr','rdpmc','in','out','ins','outs',
    'lgdt','lidt','lldt','ltr','invlpg','invpcid','wbinvd','invd',
    'xsetbv','wrpkru',
}


def disassemble(path: str | os.PathLike, *, llvm_objdump=None, function=None) -> str:
    tool = llvm_objdump or shutil.which('llvm-objdump') or shutil.which('objdump')
    if not tool:
        return ''
    cmd = [tool, '-d']
    if function:
        if 'llvm-objdump' in os.path.basename(tool):
            cmd += [f'--disassemble-symbols={function}']
        else:
            cmd += [f'--disassemble={function}']
    if 'llvm-objdump' in os.path.basename(tool):
        cmd += ['--x86-asm-syntax=intel']
    cmd += [str(path)]
    p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, check=False)
    return p.stdout if p.returncode == 0 else ''


def extract_mnemonics(disasm: str) -> list[str]:
    out = []
    # LLVM: address: bytes mnemonic operands
    # GNU objdump: address:\tbytes\tmnemonic operands
    for line in disasm.splitlines():
        if ':' not in line:
            continue
        tail = line.split(':',1)[1].strip()
        if not tail:
            continue
        # Strip leading encoded bytes (2 hex chars each).
        toks = tail.replace('\t',' ').split()
        j = 0
        while j < len(toks) and re.fullmatch(r'[0-9a-fA-F]{2}', toks[j]):
            j += 1
        if j < len(toks):
            m = toks[j].lower()
            if re.fullmatch(r'[a-z][a-z0-9_.]*', m):
                out.append(m)
    return out


def purity_issues(mnemonics: Iterable[str]) -> list[str]:
    issues = []
    for m in mnemonics:
        base = m.split('.',1)[0]
        if base in _NONDETERMINISTIC:
            issues.append(f'nondeterministic:{base}')
        elif base in _ENVIRONMENT:
            issues.append(f'environment-dependent:{base}')
        elif base in _SYSTEM or any(base.startswith(p) for p in _SYSTEM_PREFIXES):
            issues.append(f'system/privileged:{base}')
    return sorted(set(issues))


# ---------------------------------------------------------------------------
# Persistent execution oracle
# ---------------------------------------------------------------------------

class OracleError(RuntimeError):
    pass


class X86ExecutionOracle:
    """Compile/link and execute one x86-64 function through a binary protocol.

    `source` may be a .s/.S assembly file or a relocatable .o object.
    For a host-missing ISA, set `runner_prefix`, e.g.

        runner_prefix=['/path/to/sde64', '-future', '--']

    Intel documents the generic SDE form as:

        sde [sde args] -- user-application [app args]
    """

    def __init__(self, source, function: str, abi: FunctionABI = FunctionABI(),
                 *, compiler=None, cflags=(), runner_prefix=(),
                 timeout=2.0, strict_seccomp=True, allow_impure=False,
                 keep_build=False, build_dir=None):
        self.source = Path(source).resolve()
        self.function = function
        self.abi = abi
        self.compiler = compiler or shutil.which('clang') or shutil.which('gcc')
        if not self.compiler:
            raise OracleError('clang/gcc not found')
        self.cflags = list(cflags)
        self.runner_prefix = list(runner_prefix)
        self.timeout = float(timeout)
        # Intel SDE/other process-level emulators need their own syscalls, so
        # strict seccomp is enabled only for direct native execution.
        self.strict_seccomp = bool(strict_seccomp and not runner_prefix)
        self.allow_impure = allow_impure
        self.keep_build = keep_build
        self._tmp = None
        self.build_dir = Path(build_dir).resolve() if build_dir else None
        self.exe = None
        self.proc = None
        self._cache = {}
        self._build()

    def _build(self):
        if not self.source.exists():
            raise OracleError(f'input not found: {self.source}')
        if self.build_dir:
            self.build_dir.mkdir(parents=True, exist_ok=True)
            bdir = self.build_dir
        else:
            self._tmp = tempfile.TemporaryDirectory(prefix='qm-x86-oracle-')
            bdir = Path(self._tmp.name)
        harness = bdir / 'qm_oracle_harness.c'
        exe = bdir / 'qm_oracle'
        harness.write_text(generate_harness(self.function, self.abi,
                                            strict_seccomp=self.strict_seccomp))
        cmd = [self.compiler, '-O2', '-fno-lto', '-fno-stack-protector',
               '-fno-omit-frame-pointer', '-Wl,-z,noexecstack']
        cmd += self.abi.compiler_flags()
        cmd += self.cflags
        cmd += ['-Wl,-z,now']
        cmd += [str(harness), str(self.source), '-o', str(exe)]
        p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, check=False)
        if p.returncode:
            raise OracleError('oracle build failed:\n' + p.stderr + '\ncommand: ' + shlex.join(cmd))
        self.exe = exe

        # Purity scan is advisory but default-enforced when disassembly works.
        d = disassemble(exe, function=self.function)
        issues = purity_issues(extract_mnemonics(d)) if d else []
        self.purity_issues = issues
        if issues and not self.allow_impure:
            raise OracleError('function/executable violates default pure-semantics policy: ' + ', '.join(issues))

    def _start(self):
        if self.proc and self.proc.poll() is None:
            return
        cmd = self.runner_prefix + [str(self.exe)]
        address_sanitized = any(
            'sanitize=address' in flag for flag in self.cflags)
        def sandbox_limits():
            # Defense in depth around the already-isolated helper.  CPU timeout
            # is also enforced by the parent per record.
            try:
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                # ASan reserves a large sparse shadow address range.  An
                # RLIMIT_AS that is sensible for an ordinary oracle prevents
                # the sanitizer runtime itself from starting; physical memory
                # remains bounded by the parent and the finite input stream.
                if not address_sanitized:
                    resource.setrlimit(
                        resource.RLIMIT_AS, (1 << 30, 1 << 30))
                resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))
                resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
            except Exception:
                pass
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0,
                                     start_new_session=True, preexec_fn=sandbox_limits)

    def _read_exact(self, n: int) -> bytes:
        if n == 0:
            return b''
        fd = self.proc.stdout.fileno()
        out = bytearray()
        deadline = None if self.timeout <= 0 else (__import__('time').monotonic() + self.timeout)
        while len(out) < n:
            wait = None if deadline is None else max(0.0, deadline - __import__('time').monotonic())
            r, _, _ = select.select([fd], [], [], wait)
            if not r:
                self.close(kill=True)
                raise OracleError(f'oracle timed out after {self.timeout}s')
            chunk = os.read(fd, n - len(out))
            if not chunk:
                rc = self.proc.poll()
                err = b''
                try:
                    err = self.proc.stderr.read() or b''
                except Exception:
                    pass
                raise OracleError(f'oracle exited before producing a record (rc={rc}): {err.decode(errors="replace")}')
            out += chunk
        return bytes(out)

    def eval_raw(self, record: bytes) -> bytes:
        if len(record) != self.abi.input_size:
            raise ValueError(f'input record {len(record)} != {self.abi.input_size}')
        if self.abi.input_size == 0:
            # One-shot no-input programs terminate after one evaluation.
            self.close()
        self._start()
        if record:
            try:
                self.proc.stdin.write(record)
                self.proc.stdin.flush()
            except BrokenPipeError:
                raise OracleError('oracle process died while writing input')
        out = self._read_exact(self.abi.output_size)
        if self.abi.input_size == 0:
            self.close()
        return out

    def __call__(self, *args):
        key = None
        try:
            key = tuple(args)
            if key in self._cache:
                return self._cache[key]
        except TypeError:
            pass
        rec = pack_call(self.abi, args)
        result = unpack_result(self.abi, self.eval_raw(rec))
        if key is not None:
            self._cache[key] = result
        return result

    def evaluate_many(self, calls: Iterable[Sequence]):
        # Keep the persistent process hot.  This is intentionally simple;
        # the public target wrapper below adds caching/prefetch for finite domains.
        return [self(*args) for args in calls]

    def target1(self):
        """Return a unary callable suitable for the current Stage-2 solvers."""
        if len(self.abi.args) != 1 or self.abi.parsed_args()[0].kind != 'value' or self.abi.parsed_ret() is None:
            raise ValueError('target1 requires one value argument and one value return')
        return lambda x: self(x)

    def prefetch_unary(self, domain: Iterable):
        if len(self.abi.args) != 1:
            raise ValueError('prefetch_unary requires unary ABI')
        for x in domain:
            self(x)
        return self.target1()

    def close(self, kill=False):
        if self.proc:
            p = self.proc
            self.proc = None
            try:
                if kill and p.poll() is None:
                    try: os.killpg(p.pid, signal.SIGKILL)
                    except Exception: p.kill()
                elif p.poll() is None and p.stdin:
                    p.stdin.close()
                p.wait(timeout=0.5)
            except Exception:
                try: p.kill()
                except Exception: pass
            try:
                if p.stdout: p.stdout.close()
                if p.stderr: p.stderr.close()
            except Exception:
                pass
        if self._tmp and self.keep_build:
            # TemporaryDirectory cannot be kept after object destruction; copy
            # artifacts explicitly when callers need persistence.
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close(kill=bool(exc[0]))

    def __del__(self):
        try: self.close(kill=True)
        except Exception: pass


# ---------------------------------------------------------------------------
# Convenience factory for the QM exact-output target API
# ---------------------------------------------------------------------------

def target_from_x86(source, function, *, arg='u8', ret='u64', callconv='sysv',
                    runner_prefix=(), compiler=None, cflags=(), timeout=2.0,
                    strict_seccomp=True, allow_impure=False, prefetch=None):
    abi = FunctionABI((arg,), ret, callconv)
    oracle = X86ExecutionOracle(
        source, function, abi, compiler=compiler, cflags=cflags,
        runner_prefix=runner_prefix, timeout=timeout,
        strict_seccomp=strict_seccomp, allow_impure=allow_impure,
    )
    if prefetch is not None:
        oracle.prefetch_unary(prefetch)
    return oracle, oracle.target1()


if __name__ == '__main__':
    print('x86_oracle.py: import this module from the Quotient Minimizer prototype')
