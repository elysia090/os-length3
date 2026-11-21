"""Native Debian Quickshell reference: no installation or host display."""
import hashlib
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time


QUICKSHELL_SHA256 = "5f108683b0e292772cd7c0bb1ce0265e1c3257a3214ec5cb712d1fcad174779c"
ABI_DIR = "/usr/lib/x86_64-linux-gnu"
DEB_LIB = "/packages" + ABI_DIR
BACKGROUND = bytes(4)
RECTANGLE = bytes.fromhex("ff804080")


def wait_frame(proc, path, sequence, width, height):
    expires = time.monotonic() + 8
    while proc.poll() is None and time.monotonic() < expires:
        if path.exists():
            frame = path.read_bytes()
            magic, serial, w, h = struct.unpack_from("<4sIII", frame)
            assert magic == b"RBF1" and 0 < serial <= sequence
            if serial == sequence:
                assert (w, h) == (width, height)
                assert len(frame) == 16 + w * h * 4
                for y in range(h):
                    for x in range(w):
                        start = 16 + 4 * (x + y * w)
                        expected = RECTANGLE if 10 <= x < 18 and 8 <= y < 14 else BACKGROUND
                        assert frame[start:start + 4] == expected, (x, y)
                return frame
        time.sleep(0.01)
    raise RuntimeError(f"missing Quickshell frame {sequence}; exit={proc.poll()}")


def check(overlay, launcher):
    for name in ("Core", "Quick", "Qml", "WaylandClient"):
        if not (Path(ABI_DIR) / f"libQt6{name}.so.6.8.2").is_file():
            raise SystemExit(f"this native control needs Debian Qt {name} private ABI 6.8.2")
    binary = overlay / "usr/bin/quickshell"
    if overlay == Path("/") or not binary.is_file() or hashlib.sha256(binary.read_bytes()).hexdigest() != QUICKSHELL_SHA256:
        raise SystemExit("pass an overlay from stage-debs.sh, with the pinned Quickshell binary")
    config = Path(__file__).with_name("shell.qml").resolve()
    with tempfile.TemporaryDirectory(prefix="native-quickshell-") as directory:
        result = Path(directory)
        cmd = [
            "bwrap", "--unshare-user", "--die-with-parent",
            "--ro-bind", "/usr", "/usr",
            "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
            "--symlink", "usr/lib64", "/lib64", "--dir", "/etc",
            "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run",
            "--perms", "0700", "--dir", "/tmp/user",
            "--perms", "0700", "--dir", "/tmp/xdg",
            "--ro-bind", overlay, "/packages",
            "--ro-bind", launcher, "/tmp/launch",
            "--ro-bind", config, "/tmp/shell.qml", "--bind", result, "/result",
            "--clearenv", "--setenv", "PATH", "/usr/bin",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "HOME", "/tmp/user", "--setenv", "XDG_RUNTIME_DIR", "/tmp/xdg",
            "--setenv", "LD_LIBRARY_PATH", DEB_LIB,
            "--setenv", "QT_PLUGIN_PATH", DEB_LIB + "/qt6/plugins",
            "--setenv", "QML_IMPORT_PATH", DEB_LIB + "/qt6/qml",
            "--setenv", "QT_QPA_PLATFORM", "wayland",
            "--setenv", "QT_QUICK_BACKEND", "software",
            "--setenv", "QT_WAYLAND_DISABLE_WINDOWDECORATION", "1",
            "--setenv", "QSG_INFO", "1",
            "/tmp/launch", "/result",
        ]
        frame, trace = result / "frame.rgba", result / "quickshell.log"
        with trace.open("wb") as log:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log)
            try:
                first = wait_frame(proc, frame, 1, 32, 24)
                proc.stdin.write(bytes([2, 47, 19]))
                proc.stdin.flush()
                resized = wait_frame(proc, frame, 2, 47, 19)
                proc.stdin.write(bytes([3, 0, 0]))
                proc.stdin.flush()
                assert proc.wait(timeout=6) == 0
                assert frame.read_bytes() == resized, "close must not publish another frame"
                lines = trace.read_text().splitlines()
                assert any("Loading backend software" in line for line in lines)
                assert any("Configuration Loaded" in line for line in lines)
                assert lines.count("WAYLAND_ALPHA format=argb8888") == 2
                marks = [
                    "WAYLAND_LAYER surface=top anchors=top-left output=explicit scope=ricebox-layer-proof",
                    "WAYLAND_COMMIT seq=1 size=32x24 configure=1 pointer=0 stride=128",
                    "WAYLAND_COMMIT seq=2 size=47x19 configure=2 pointer=0 stride=188",
                    "WAYLAND_LAYER_CLIENT_DESTROY",
                    "QUICKSHELL_NATIVE_WINDOW_CLOSED",
                ]
                previous = -1
                for mark in marks:
                    assert lines.count(mark) == 1
                    actual = lines.index(mark)
                    assert actual > previous
                    previous = actual
                for name, data in (("first", first), ("resize", resized)):
                    print("NATIVE_QUICKSHELL_RGBA", name, hashlib.sha256(data[16:]).hexdigest())
            except Exception:
                sys.stderr.write(trace.read_text(errors="replace"))
                raise
            finally:
                proc.stdin.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} DEB_OVERLAY WAYLAND_QUICKSHELL_LAUNCH")
    check(Path(sys.argv[1]).resolve(strict=True), Path(sys.argv[2]).resolve(strict=True))
