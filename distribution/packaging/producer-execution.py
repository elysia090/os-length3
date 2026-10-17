#!/usr/bin/env python3
"""Execute the measured ELF descriptor; bind actual calls to a clean-build cut.

Unsigned execution evidence belongs to the trusted local build runner. It does
not turn an arbitrary caller-supplied manifest into authenticated provenance.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def read_json(path):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError("duplicate manifest field")
            result[key] = value
        return result
    return json.loads(Path(path).read_bytes(), object_pairs_hook=pairs)


def inspect(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o111:
        raise ValueError("producer must be an executable regular inode")
    os.lseek(fd, 0, os.SEEK_SET)
    digest, size, prefix = hashlib.sha256(), 0, b""
    while chunk := os.read(fd, 1048576):
        prefix = (prefix + chunk)[:4]
        digest.update(chunk)
        size += len(chunk)
    after = os.fstat(fd)
    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("producer changed during descriptor capture")
    if prefix != b"\x7fELF":
        raise ValueError("native producer ELF required")
    return {"bytes": size, "sha256": digest.hexdigest()}


def run(manifest_path, log_path, role, executable, arguments):
    if os.name != "posix" or os.execve not in os.supports_fd:
        raise ValueError("native descriptor execution required")
    manifest = read_json(manifest_path)
    if manifest.get("format") != "fixed-native-producer-cut-v1":
        raise ValueError("fixed native producer cut required")
    expected = manifest["producers"][role]
    fd = os.open(executable, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        measured = inspect(fd)
        if measured != expected:
            raise ValueError("executed producer differs from reproduced cut")
        # The cut directory must be read-only in the private mount namespace.
        # fexecve removes name substitution; the mount removes in-place writes.
        if not os.fstatvfs(fd).f_flag & getattr(os, "ST_RDONLY", 1):
            raise ValueError("producer cut must be mounted read-only")
        pid = os.fork()
        if pid == 0:
            try:
                os.execve(fd, [executable, *arguments], dict(os.environ))
            except BaseException:
                os._exit(126)
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
        if inspect(fd) != measured:
            raise ValueError("executed descriptor drift")
        event = {"role": role, "producer": measured, "argv": arguments,
                 "exit": code, "execution": "read-only-fexecve",
                 "cutSha256": hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest()}
        log = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            body = (json.dumps(event, sort_keys=True) + "\n").encode()
            if os.write(log, body) != len(body):
                raise ValueError("incomplete producer execution record")
            os.fsync(log)
        finally:
            os.close(log)
        return code if code >= 0 else 128 - code
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) < 6 or sys.argv[1] != "run":
            raise ValueError("usage: producer-execution.py run MANIFEST LOG ROLE ELF [ARG...]")
        sys.exit(run(*sys.argv[2:6], sys.argv[6:]))
    except (ValueError, OSError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
