#!/usr/bin/env python3
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile

tool = Path(__file__).with_name("normalize-initramfs.py")


def archive(timestamp):
    data = bytearray()
    for inode, name, mode, body in [(1, ".", 0o40755, b""),
                                   (2, "bin/tool", 0o100755, b"\x7fELFfixture"),
                                   (3, "link", 0o120777, b"bin/tool"),
                                   (0, "TRAILER!!!", 0, b"")]:
        encoded = name.encode() + b"\0"
        fields = [inode, mode, 0, 0, 1, timestamp, len(body), 0, 0, 0, 0,
                  len(encoded), 0]
        data += b"070701" + b"".join(f"{value:08x}".encode() for value in fields)
        data += encoded
        data += b"\0" * (-len(data) % 4)
        data += body
        data += b"\0" * (-len(data) % 4)
    data += b"\0" * (-len(data) % 512)
    return bytes(data)


with tempfile.TemporaryDirectory(prefix="initramfs-normalize-") as directory:
    root = Path(directory).resolve()
    assert root.parent == Path(tempfile.gettempdir()).resolve()
    assert root.name.startswith("initramfs-normalize-")
    for timestamp in [0, 123, 0xffffffff]:
        source, target = root / f"source-{timestamp}", root / f"output-{timestamp}"
        original = archive(timestamp)
        source.write_bytes(original)
        subprocess.run([sys.executable, tool, source, target], check=True)
        assert target.read_bytes() == archive(0)
        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(original).digest()
        occupied = subprocess.run([sys.executable, tool, source, target], capture_output=True)
        assert occupied.returncode != 0 and target.read_bytes() == archive(0)
    for number, invalid in enumerate([b"bad" + archive(1)[3:], archive(1)[:112],
                                     archive(1)[:-1] + b"x"]):
        source, target = root / f"invalid-{number}", root / f"refused-{number}"
        source.write_bytes(invalid)
        refused = subprocess.run([sys.executable, tool, source, target], capture_output=True)
        assert refused.returncode != 0 and not target.exists()
        assert source.read_bytes() == invalid
print("initramfs normalization: same member bytes, fixed mtimes, unchanged source; malformed/occupied output refused")
