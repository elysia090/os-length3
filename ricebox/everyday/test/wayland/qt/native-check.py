"""Opt-in native Qt control; do not run or install Qt in the browser test."""
import argparse
import hashlib
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time


QMLSCENE = "usr/lib/qt6/bin/qmlscene"
QMLSCENE_SHA256 = "315d0090f499b0117d6a9e10d0d9ea7f4639c4d9e4390169dbb6aec80d770fad"
LAYER_PLUGIN = "usr/lib/qt6/plugins/wayland-shell-integration/liblayer-shell.so"
LAYER_PLUGIN_SHA256 = "001b23f9ebd86fec11399e360630e4af620b59985d9fbc9db94f32e3db1d7a66"
BACKGROUND = bytes.fromhex("121c2aff")
RECTANGLE = bytes.fromhex("f83d69ff")


def check_frame(proc, path, sequence, width, height):
    expires = time.monotonic() + 8
    while proc.poll() is None and time.monotonic() < expires:
        if path.exists():
            data = path.read_bytes()  # The server publishes by atomic rename.
            magic, serial, actual_width, actual_height = struct.unpack_from("<4sIII", data)
            assert magic == b"RBF1" and 0 < serial <= sequence
            if serial == sequence:
                assert (actual_width, actual_height) == (width, height)
                assert len(data) == 16 + width * height * 4
                for y in range(height):
                    for x in range(width):
                        offset = 16 + 4 * (x + y * width)
                        expected = RECTANGLE if 10 <= x < 18 and 8 <= y < 14 else BACKGROUND
                        assert data[offset:offset + 4] == expected, (x, y)
                return data
        time.sleep(0.01)
    raise RuntimeError(f"no Qt SHM frame {sequence}; exit={proc.poll()}")


def check_digest(root, name, digest):
    path = root / name
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise SystemExit(f"missing or unexpected pinned {path.name}: {path}")


def check(root, launcher, layer):
    if root == Path("/"):
        raise SystemExit("pass a disposable pinned Alpine root, not the host root")
    check_digest(root, QMLSCENE, QMLSCENE_SHA256)
    platform = []
    if layer:
        check_digest(root, LAYER_PLUGIN, LAYER_PLUGIN_SHA256)
        platform = ["--setenv", "QT_WAYLAND_SHELL_INTEGRATION", "layer-shell"]
    scene = Path(__file__).with_name("panel.qml" if layer else "rectangle.qml").resolve()
    with tempfile.TemporaryDirectory(prefix="qt-wayland-native-") as directory:
        result = Path(directory)
        cmd = [
            "bwrap", "--unshare-user", "--die-with-parent",
            "--ro-bind", root, "/", "--dev", "/dev", "--tmpfs", "/tmp",
            "--perms", "0700", "--dir", "/tmp/xdg",
            "--ro-bind", launcher, "/tmp/qt-launch",
            "--ro-bind", scene, "/tmp/rectangle.qml",
            "--bind", result, "/tmp/result",
            "--clearenv", "--setenv", "PATH", "/bin:/usr/bin",
            "--setenv", "XDG_RUNTIME_DIR", "/tmp/xdg",
            "--setenv", "QT_QPA_PLATFORM", "wayland",
            "--setenv", "QT_QUICK_BACKEND", "software",
            "--setenv", "QT_WAYLAND_DISABLE_WINDOWDECORATION", "1",
            "--setenv", "QSG_INFO", "1",
            *platform, "/tmp/qt-launch", "/tmp/result",
        ]
        frame, trace = result / "frame.rgba", result / "qt.log"
        with trace.open("wb") as log:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log)
            try:
                first = check_frame(proc, frame, 1, 32, 24)
                proc.stdin.write(bytes([2, 47, 19]))
                proc.stdin.flush()
                resized = check_frame(proc, frame, 2, 47, 19)
                proc.stdin.write(bytes([3, 0, 0]))
                proc.stdin.flush()
                assert proc.wait(timeout=5) == 0
                assert frame.read_bytes() == resized, "close detach must not publish"
                lines = trace.read_text().splitlines()
                assert "qt.scenegraph.general: Loading backend software" in lines
                assert [line for line in lines if line.startswith("WAYLAND_COMMIT ")] == [
                    "WAYLAND_COMMIT seq=1 size=32x24 configure=1 pointer=0 stride=128",
                    "WAYLAND_COMMIT seq=2 size=47x19 configure=2 pointer=0 stride=188",
                ]
                layer_receipt = "WAYLAND_LAYER surface=top anchors=top-left output=explicit scope=ricebox-layer-proof"
                assert lines.count(layer_receipt) == int(layer), "unexpected window role"
                if layer:
                    print(layer_receipt)
                assert "QT_WAYLAND_WINDOW_CLOSED" in lines
                for name, data in (("first", first), ("resize", resized)):
                    print("NATIVE_QT_WAYLAND_RECTANGLE_RGBA", name, hashlib.sha256(data[16:]).hexdigest())
            except Exception:
                sys.stderr.write(trace.read_text(errors="replace"))
                raise
            finally:
                proc.stdin.close()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("alpine_root", type=Path)
    parser.add_argument("launcher", type=Path)
    parser.add_argument("--layer", action="store_true")
    args = parser.parse_args()
    check(args.alpine_root.resolve(), args.launcher.resolve(strict=True), args.layer)
