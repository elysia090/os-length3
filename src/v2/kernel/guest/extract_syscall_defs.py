#!/usr/bin/env python3
"""Extract textual LKL syscall definitions from a relocatable Wasm object."""

from pathlib import Path
import sys


def uleb(data, offset):
    value = 0
    shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7


def data_segments(raw):
    offset = 8
    while offset < len(raw):
        section = raw[offset]
        size, offset = uleb(raw, offset + 1)
        payload = raw[offset:offset + size]
        offset += size
        if section != 11:
            continue
        count, cursor = uleb(payload, 0)
        for _index in range(count):
            flags, cursor = uleb(payload, cursor)
            if flags == 2:
                _memory, cursor = uleb(payload, cursor)
            if flags in (0, 2):
                if payload[cursor] not in (0x41, 0x42, 0x23):
                    raise ValueError('unsupported data offset expression')
                cursor += 1
                _value, cursor = uleb(payload, cursor)
                if payload[cursor] != 0x0b:
                    raise ValueError('unterminated data offset expression')
                cursor += 1
            elif flags != 1:
                raise ValueError('unsupported data segment flags %d' % flags)
            length, cursor = uleb(payload, cursor)
            yield payload[cursor:cursor + length]
            cursor += length


def main(paths):
    if paths[:1] == ['--thin-list']:
        root = Path(paths[1])
        members = Path(paths[2]).read_text().splitlines()
        paths = [Path(member) if Path(member).is_absolute()
                 else root / member for member in members]
    found = 0
    for path in paths:
        for payload in data_segments(Path(path).read_bytes()):
            if b'SYSCALL_DEFINE' not in payload:
                continue
            sys.stdout.buffer.write(payload.replace(b'\0', b''))
            found += 1
    return 0 if found else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
