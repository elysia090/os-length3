"""Complete x86-64 semantics fallback through an isolated native helper.

The handwritten assembly reader is the inspectable fast path.  It is not the
instruction-set boundary.  On a Linux x86-64 host this module assembles the
original function, scans the resulting object for environment-dependent
instructions, links a fixed unary ABI harness, enters a strict syscall filter,
and evaluates the finite QM domain in one persistent child process.

This backend intentionally stays unavailable on hosts where that sandbox
cannot be established.  Refusing is preferable to executing pasted machine
code with ambient process authority.
"""

import os
import platform
import re
import shutil
import struct
import subprocess
import tempfile

from .cfront.errors import CFrontError

try:
    import resource
except ImportError:                         # Windows has no POSIX rlimits.
    resource = None


class OracleUnavailable(CFrontError):
    pass


class OracleError(CFrontError):
    pass


_GLOBL = re.compile(r'^\s*\.(?:globl|global)\s+([A-Za-z_][\w.]*)', re.M)
_LABEL = re.compile(r'^([A-Za-z_][\w.]*)\s*:', re.M)
_IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z_0-9]*$')

_IMPURE = {
    'rdrand', 'rdseed', 'rdtsc', 'rdtscp', 'rdpmc', 'cpuid', 'xgetbv',
    'rdpkru', 'rdpid', 'rdfsbase', 'rdgsbase', 'syscall', 'sysenter',
    'sysexit', 'sysret', 'int', 'int3', 'in', 'out', 'ins', 'outs', 'hlt',
    'cli', 'sti', 'rdmsr', 'wrmsr', 'vmcall', 'vmmcall',
}


def available(compiler=None, objdump=None):
    """Whether the strict native execution boundary exists on this host."""
    return (resource is not None and platform.system() == 'Linux' and
            platform.machine().lower() in
            ('x86_64', 'amd64') and
            bool(compiler or shutil.which('clang') or shutil.which('gcc')) and
            bool(objdump or shutil.which('llvm-objdump') or
                 shutil.which('objdump')))


def function_name(source, requested=None):
    if requested:
        return requested
    names = _GLOBL.findall(source or '')
    if names:
        return names[0]
    labels = [name for name in _LABEL.findall(source or '')
              if not name.startswith('.L')]
    if labels:
        return labels[0]
    raise OracleError('no exported x86-64 function label was found')


def _mnemonics(disassembly):
    result = []
    for line in disassembly.splitlines():
        if ':' not in line:
            continue
        tokens = line.split(':', 1)[1].replace('\t', ' ').split()
        at = 0
        while at < len(tokens) and re.fullmatch(r'[0-9a-fA-F]{2}', tokens[at]):
            at += 1
        if at < len(tokens) and re.fullmatch(r'[a-z][a-z0-9_.]*',
                                             tokens[at].lower()):
            result.append(tokens[at].lower().split('.', 1)[0])
    return result


def purity_issues(disassembly):
    return sorted(set(op for op in _mnemonics(disassembly) if op in _IMPURE))


_HARNESS = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/syscall.h>

extern uint64_t QM_FUNCTION(uint64_t);

static int install_filter(void)
{
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned)offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned)offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 5, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 4, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit, 3, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_rt_sigreturn, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        (unsigned short)(sizeof(code) / sizeof(code[0])), code
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

static int read_all(void *buffer, size_t count)
{
    unsigned char *at = (unsigned char *)buffer;
    size_t done = 0;
    while (done < count) {
        ssize_t got = read(STDIN_FILENO, at + done, count - done);
        if (got == 0) return done ? -1 : 0;
        if (got < 0) { if (errno == EINTR) continue; return -1; }
        done += (size_t)got;
    }
    return 1;
}

static int write_all(const void *buffer, size_t count)
{
    const unsigned char *at = (const unsigned char *)buffer;
    size_t done = 0;
    while (done < count) {
        ssize_t put = write(STDOUT_FILENO, at + done, count - done);
        if (put < 0) { if (errno == EINTR) continue; return -1; }
        done += (size_t)put;
    }
    return 0;
}

int main(void)
{
    uint64_t input, output;
    if (install_filter()) return 70;
    for (;;) {
        int status = read_all(&input, sizeof input);
        if (status == 0) return 0;
        if (status < 0) return 71;
        output = QM_FUNCTION(input);
        if (write_all(&output, sizeof output)) return 72;
    }
}
'''


class NativeX86Oracle(object):
    """Build once and evaluate a unary SysV function over a finite domain."""

    def __init__(self, source, function=None, compiler=None, objdump=None,
                 timeout=30.0):
        if not available(compiler, objdump):
            raise OracleUnavailable('strict native x86-64 oracle is unavailable')
        self.source = source or ''
        self.function = function_name(self.source, function)
        if not _IDENTIFIER.match(self.function):
            raise OracleError('function %r cannot be named by the C ABI harness'
                              % self.function)
        self.compiler = compiler or shutil.which('clang') or shutil.which('gcc')
        self.objdump = objdump or shutil.which('llvm-objdump') or \
            shutil.which('objdump')
        self.timeout = float(timeout)

    def evaluate(self, values):
        values = list(values)
        with tempfile.TemporaryDirectory(prefix='qm-x86-oracle-') as tmp:
            assembly = os.path.join(tmp, 'input.s')
            object_file = os.path.join(tmp, 'input.o')
            harness = os.path.join(tmp, 'harness.c')
            executable = os.path.join(tmp, 'oracle')
            with open(assembly, 'w') as handle:
                handle.write(self.source)
            with open(harness, 'w') as handle:
                handle.write(_HARNESS.replace('QM_FUNCTION', self.function))

            built = subprocess.run([self.compiler, '-c', assembly, '-o',
                                    object_file], capture_output=True, text=True)
            if built.returncode:
                raise OracleError('x86 assembler rejected the input',
                                  hint=_last_error(built.stderr))
            dump = subprocess.run([self.objdump, '-d', object_file],
                                  capture_output=True, text=True)
            if dump.returncode:
                raise OracleError('x86 object could not be disassembled')
            issues = purity_issues(dump.stdout)
            if issues:
                raise OracleError('x86 function observes external machine '
                                  'state: %s' % ', '.join(issues))
            nm = shutil.which('llvm-nm') or shutil.which('nm')
            if not nm:
                raise OracleUnavailable('x86 oracle needs nm to reject '
                                        'external symbol calls')
            undefined = subprocess.run([nm, '-u', object_file],
                                       capture_output=True, text=True)
            names = [line.strip() for line in undefined.stdout.splitlines()
                     if line.strip()]
            if undefined.returncode or names:
                raise OracleError('x86 input has external symbol references: '
                                  '%s' % (', '.join(names) or 'unknown'))

            linked = subprocess.run([
                self.compiler, '-O2', '-fno-lto', '-fno-stack-protector',
                '-no-pie', harness, object_file, '-o', executable,
            ], capture_output=True, text=True)
            if linked.returncode:
                raise OracleError('x86 oracle harness did not link',
                                  hint=_last_error(linked.stderr))

            payload = b''.join(struct.pack('<Q', int(value) & ((1 << 64) - 1))
                               for value in values)

            def limits():
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                resource.setrlimit(resource.RLIMIT_AS, (1 << 30, 1 << 30))
                resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))
                resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))

            run = subprocess.run([executable], input=payload,
                                 stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE,
                                 timeout=self.timeout, preexec_fn=limits)
            expected = len(values) * 8
            if run.returncode or len(run.stdout) != expected:
                raise OracleError('x86 oracle stopped with status %d and %d/%d '
                                  'output bytes' % (run.returncode,
                                                    len(run.stdout), expected))
            return list(struct.unpack('<%dQ' % len(values), run.stdout))


def _last_error(stderr):
    lines = [line.strip() for line in (stderr or '').splitlines() if line.strip()]
    return lines[-1] if lines else None
