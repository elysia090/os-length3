#!/usr/bin/env python3
"""Bind existing native checks to a private cut of their artifact and policy.

This unsigned local receipt is not producer provenance or product approval.
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import tempfile


POLICY_FILES = (
    "distribution/packaging/check-native-bundle-runtime.sh",
    "distribution/packaging/native-bundle-acceptance.py",
    "distribution/packaging/check-root.sh",
    "distribution/packaging/profile.env",
    "distribution/sources.env",
    "distribution/bootstrap/packages.sha256",
    "distribution/bootstrap/installed.lock",
    "distribution/packaging/check-native-runtime.sh",
    "distribution/packaging/check-native-development.sh",
    "distribution/packaging/check-native-https.py",
    "distribution/packaging/check-native-https.sh",
)
INPUT_FILES = ("bundle.tar.zst", "release.inputs", "postlink-verify", "zlib-source.tar.xz")
RESULTS = {name: "passed" for name in ("root", "runtime", "development", "https")}
ENVIRONMENT = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C", "TZ": "UTC",
               "QM_NATIVE_TRACE": "0", "PYTHONHASHSEED": "0"}


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode("utf-8")


def generation(info):
    # Windows stat/fstat disagree about the legacy ctime field. Native product
    # checks run on Linux; portable binding fixtures still compare inode/mtime.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_mtime_ns, info.st_nlink,
            info.st_ctime_ns if os.name == "posix" else None)


def read_file(source, destination=None):
    """Hash and optionally copy the same opened regular inode; reject read drift."""
    source = Path(source).resolve(strict=True)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(source, flags), "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("acceptance input must be a regular file")
        digest = hashlib.sha256()
        size = 0
        output = None
        try:
            if destination is not None:
                destination.parent.mkdir(parents=True, exist_ok=True)
                output = destination.open("xb")
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                if output is not None:
                    output.write(chunk)
            if (size != before.st_size or generation(before) != generation(os.fstat(stream.fileno()))
                    or generation(before) != generation(source.stat(follow_symlinks=False))):
                raise ValueError("acceptance input changed during capture/read")
        finally:
            if output is not None:
                output.close()
        if destination is not None:
            destination.chmod(0o700 if before.st_mode & 0o111 else 0o600)
    return {"sha256": digest.hexdigest(), "bytes": size}


def conditions():
    return {"system": platform.system(), "machine": platform.machine(),
            "kernel": platform.release(), "euid": os.geteuid() if hasattr(os, "geteuid") else None,
            "python": sys.version, "environment": ENVIRONMENT,
            "execution": "native-linux-private-mount-namespaces"}


def context(repo, inputs, destination=None):
    policy = {}
    for name in POLICY_FILES:
        target = destination / "policy" / name if destination is not None else None
        policy[name] = read_file(repo / name, target)
    captured = {}
    for name, source in zip(INPUT_FILES, inputs, strict=True):
        target = destination / "inputs" / name if destination is not None else None
        captured[name] = read_file(source, target)
    if os.name == "posix" and not Path(inputs[2]).stat().st_mode & 0o111:
        raise ValueError("postlink verifier is not executable")
    return {"format": "native-bundle-runtime-acceptance-v1",
            "scope": "extracted-root-runtime-development-https",
            "inputs": captured,
            "policy": {"sha256": hashlib.sha256(encode(policy)).hexdigest(), "files": policy},
            "conditions": conditions(), "producer-source-binding": "unknown",
            "product-qualification": "pending"}


def validate_receipt(receipt, expected):
    # Exact comparison rejects extra/unsupported provenance or approval claims,
    # old schemas, changed conditions, and records for any other artifact/policy.
    if encode(receipt) != encode(dict(expected, results=RESULTS)):
        raise ValueError("native acceptance does not bind this artifact, policy and conditions")


def load_record(path):
    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate acceptance record field")
            value[key] = item
        return value
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)


def publish_record(path, receipt):
    data = encode(receipt)
    path = Path(path)
    # Hardlink publication keeps an existing receipt intact, including a legacy
    # or conflicting one. The stage is on the same filesystem as this output.
    with tempfile.TemporaryDirectory(prefix=".native-acceptance-record-", dir=path.parent) as directory:
        staged = Path(directory) / "receipt.json"
        staged.write_bytes(data)
        staged.chmod(0o600)
        try:
            os.link(staged, path)
        except FileExistsError:
            if path.is_symlink() or path.read_bytes() != data:
                raise ValueError("existing native acceptance receipt conflicts; choose a new output")


def run_captured(stage):
    environment = dict(ENVIRONMENT, HOME=str(stage / "home"), TMPDIR=str(stage / "tmp"))
    if (platform.system() != "Linux" or os.geteuid() != 0
            or dict(os.environ) != environment):
        raise ValueError("captured checks require the recorded isolated environment")
    expected = load_record(stage / "capture.json")
    repo = stage / "policy"
    inputs = [stage / "inputs" / name for name in INPUT_FILES]
    if context(repo, inputs) != expected:
        raise ValueError("private acceptance cut changed before testing")
    opened = stage / "opened"
    opened.mkdir()
    subprocess.run(["bash", "-c",
                    'set -euo pipefail; zstd -q -dc -- "$1" | tar -C "$2" -xf -',
                    "native-bundle-extract", inputs[0], opened], check=True)
    root = opened / "root"
    manifest = opened / "manifest"
    if not root.is_dir() or manifest.is_symlink() or not manifest.is_file():
        raise ValueError("native bundle is missing root or manifest")
    if read_file(manifest) != expected["inputs"]["release.inputs"]:
        raise ValueError("native bundle manifest differs from captured release inputs")
    here = repo / "distribution/packaging"
    checks = (["bash", here / "check-root.sh", root, inputs[2]],
              ["bash", here / "check-native-runtime.sh", root],
              ["bash", here / "check-native-development.sh", root, inputs[3]],
              [sys.executable, here / "check-native-https.py", root])
    for command in checks:
        subprocess.run(command, check=True)
    if context(repo, inputs) != expected:
        raise ValueError("private acceptance cut changed while testing")
    (stage / "receipt.json").write_bytes(encode(dict(expected, results=RESULTS)))


def reject_diagnostic_overrides():
    if any(name.startswith("QM_NATIVE_") and value for name, value in os.environ.items()):
        raise ValueError("native acceptance requires the standard checks without diagnostic overrides")


def check(repo, inputs, output=None):
    reject_diagnostic_overrides()
    if platform.system() != "Linux" or os.geteuid() != 0:
        raise ValueError("native acceptance requires Linux root for private mount namespaces")
    bundle = Path(inputs[0]).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix=".native-bundle-check-", dir=bundle.parent) as directory:
        stage = Path(directory)
        expected = context(repo, inputs, stage)
        (stage / "capture.json").write_bytes(encode(expected))
        (stage / "home").mkdir()
        (stage / "tmp").mkdir()
        environment = dict(ENVIRONMENT, HOME=str(stage / "home"), TMPDIR=str(stage / "tmp"))
        # Execute the captured helper too, so the recorded test revision is the
        # code consumed by the checks, rather than a later read of a source path.
        subprocess.run([sys.executable, stage / "policy/distribution/packaging/native-bundle-acceptance.py",
                        "_captured", stage], check=True, env=environment)
        receipt = load_record(stage / "receipt.json")
        validate_receipt(receipt, expected)
        # Fail publication if the caller's coordinates changed after the cut.
        # Existing files/receipts remain intact on all failures.
        if context(repo, inputs) != expected:
            raise ValueError("native acceptance original inputs or policy changed while testing")
        if output is None:
            identity = hashlib.sha256(encode(receipt)).hexdigest()
            output = Path(str(bundle) + ".acceptance-" + identity + ".json")
        if Path(output).resolve() in {Path(item).resolve() for item in inputs}:
            raise ValueError("acceptance output must not alias an input")
        publish_record(output, receipt)
    print("native bundle runtime: green (captured archive, policy and verifier; source binding unknown)")
    print(f"receipt={Path(output).resolve()}")


def main():
    repo = Path(__file__).resolve().parents[2]
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "_captured":
        run_captured(Path(args[1]).resolve(strict=True))
    elif len(args) in (5, 6) and args[0] == "check":
        check(repo, args[1:5], args[5] if len(args) == 6 else None)
    elif len(args) == 6 and args[0] == "verify":
        reject_diagnostic_overrides()
        validate_receipt(load_record(args[1]), context(repo, args[2:]))
        print("native acceptance binding: green; product qualification remains pending")
    else:
        raise ValueError("usage: native-bundle-acceptance.py check BUNDLE INPUTS VERIFY ZLIB [RECEIPT]\n"
                         "       native-bundle-acceptance.py verify RECEIPT BUNDLE INPUTS VERIFY ZLIB")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"native acceptance: {error}", file=sys.stderr)
        sys.exit(1)
