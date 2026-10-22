#!/usr/bin/env python3
"""Fix newc member mtimes in a fresh archive without changing its source."""
import os
from pathlib import Path
import stat
import sys


def normalize(data):
    result = bytearray(data)
    offset = 0
    while offset + 110 <= len(result):
        if result[offset:offset + 6] != b"070701":
            raise ValueError("plain newc archive required")
        if any(byte not in b"0123456789abcdefABCDEF"
               for byte in result[offset + 6:offset + 110]):
            raise ValueError("invalid newc header")
        values = [int(result[offset + 6 + 8 * i:offset + 14 + 8 * i], 16)
                  for i in range(13)]
        size, name_size = values[6], values[11]
        end_name = offset + 110 + name_size
        if not 1 <= name_size <= 4096 or end_name > len(result):
            raise ValueError("invalid newc name extent")
        name = result[offset + 110:end_name]
        if name[-1] != 0 or 0 in name[:-1]:
            raise ValueError("invalid newc name")
        body = (end_name + 3) & ~3
        end_body = body + size
        if end_body > len(result):
            raise ValueError("truncated newc member")
        # --reproducible fixes inode/device coordinates, but not this field.
        # Signed boot payloads use epoch zero independently of construction time.
        result[offset + 46:offset + 54] = b"00000000"
        offset = (end_body + 3) & ~3
        if name == b"TRAILER!!!\0":
            if size != 0 or any(result[offset:]):
                raise ValueError("invalid newc trailer/padding")
            return result
    raise ValueError("newc trailer missing")


def main():
    if len(sys.argv) != 3:
        raise ValueError("usage: normalize-initramfs.py INPUT FRESH-OUTPUT")
    source, target = map(Path, sys.argv[1:])
    before = source.lstat()
    if not stat.S_ISREG(before.st_mode) or not 110 <= before.st_size <= 268435456:
        raise ValueError("bounded regular initramfs required")
    result = normalize(source.read_bytes())
    after = source.lstat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
        before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size,
                               after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError("initramfs source changed during normalization")
    with target.open("xb") as output:
        output.write(result)
        output.flush()
        if hasattr(os, "fchmod"):
            os.fchmod(output.fileno(), stat.S_IMODE(before.st_mode))
        else:
            os.chmod(target, stat.S_IMODE(before.st_mode))
        os.fsync(output.fileno())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"initramfs normalization: {error}", file=sys.stderr)
        sys.exit(1)
