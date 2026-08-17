#!/usr/bin/env python3
"""Prove the C continuation codec against the Python writer.

`selftest --vectors` prints one row per encoded continuation:

    control field0 field1 field2 field3 <hex bytes>

Every row is re-encoded with kernel/x86snapshot.py and must produce exactly
those bytes, and decoding those bytes with the Python reader must return the
same five words.  Any divergence between the two implementations fails here
rather than in an artifact.

This is a repository check, not part of the distributable: it exists only
while the Python writer still produces artifacts, and is deleted with it.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kernel.x86snapshot import (_decode_native_x86_continuation,
                                _encode_native_x86_continuation)


def main(stream=None):
    stream = sys.stdin if stream is None else stream
    rows = 0
    for line in stream:
        line = line.strip()
        if not line:
            continue
        *words, encoded = line.split()
        if len(words) != 5:
            raise SystemExit('vector %r does not name five words' % line)
        continuation = tuple(int(word) for word in words)
        payload = bytes.fromhex(encoded)

        written = _encode_native_x86_continuation(continuation)
        if written != payload:
            raise SystemExit(
                'continuation %r: C wrote %s, Python writes %s'
                % (continuation, payload.hex(), written.hex()))

        read = _decode_native_x86_continuation(payload)
        if tuple(read) != continuation:
            raise SystemExit(
                'continuation %r: Python reads %r back' % (continuation, read))
        rows += 1

    if not rows:
        raise SystemExit('no vectors on stdin')
    print('format parity: %d continuation rows agree' % rows)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
