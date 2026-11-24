"""Build Quickshell's on-demand browser inputs from a supplied signed cache, offline."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
PACKER = HERE.parents[4] / "distribution/build/distribution.ts"
LOCK = HERE / "debian-fixture.lock.json"
MAIN = "/usr/bin/quickshell"
MAIN_SHA256 = "5f108683b0e292772cd7c0bb1ce0265e1c3257a3214ec5cb712d1fcad174779c"
LIB = "/usr/lib/x86_64-linux-gnu"
LOADER = LIB + "/ld-linux-x86-64.so.2"
MAPPED_FILE_LIMIT = 64 << 20  # Match the Sods dynamic-file load limit.


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def copy_bytes(src, dst, size):
    require(src.is_file() and not src.is_symlink(), f"missing regular input: {src.name}")
    with src.open("rb") as file:
        body = file.read(size + 1)
    require(len(body) == size, f"wrong input length: {src.name}")
    dst.write_bytes(body)
    return body


def guest_real(root, path):
    """Resolve a guest path without ever following an absolute link on the host."""
    require(path.startswith("/"), f"expected absolute guest path: {path}")
    parts, resolved, hops = list(PurePosixPath(path).parts[1:]), [], 0
    while parts:
        name = parts.pop(0)
        if name == "..":
            require(resolved, f"guest path escapes root: {path}")
            resolved.pop()
            continue
        candidate = root.joinpath(*resolved, name)
        if candidate.is_symlink():
            hops += 1
            require(hops <= 40, f"too many guest symlinks: {path}")
            target = PurePosixPath(os.readlink(candidate))
            if target.is_absolute():
                resolved.clear()
            parts = list(target.parts[1:] if target.is_absolute() else target.parts) + parts
        else:
            resolved.append(name)
    return "/" + "/".join(resolved)


def readelf(*args):
    return subprocess.check_output(["readelf", *args], text=True, timeout=10,
                                   env={**os.environ, "LC_ALL": "C"})


def shared_object(path, size):
    with path.open("rb") as file:
        header = file.read(64)
        if len(header) != 64 or not header.startswith(b"\x7fELF\x02\x01") or struct.unpack_from("<HH", header, 16) != (3, 62):
            return False
        start, = struct.unpack_from("<Q", header, 32)
        width, count = struct.unpack_from("<HH", header, 54)
        if width != 56 or not 1 <= count <= 128 or start + width * count > size:
            return False
        file.seek(start)
        phdr = file.read(width * count)
    # libc is a DSO even though it also carries PT_INTERP.
    return ".so" in path.name or all(struct.unpack_from("<I", phdr, i * width)[0] != 3 for i in range(count))


def guest_sources(root):
    def at(path):
        return root / path.lstrip("/")

    require(guest_real(root, MAIN) == MAIN and digest(at(MAIN)) == MAIN_SHA256, "wrong Quickshell executable")
    match = re.search(r"Requesting program interpreter: (.*)\]", readelf("-lW", at(MAIN)))
    require(match and guest_real(root, match[1]) == LOADER and at(LOADER).is_file(),
            "wrong canonical Quickshell interpreter")
    libraries, oversized = set(), []
    for path in sorted((root / "usr/lib").rglob("*")):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o6000 or info.st_size < 64:
            continue
        name = "/" + path.relative_to(root).as_posix()
        if name == LOADER or not shared_object(path, info.st_size):
            continue
        if info.st_size > MAPPED_FILE_LIMIT:
            oversized.append({"path": name, "bytes": info.st_size})
        else:
            libraries.add(name)

    qt = LIB + "/qt6"
    platforms = [f"{qt}/plugins/platforms/libqwayland-{tail}.so" for tail in ("generic", "egl")]
    qml = tuple(f"{qt}/qml/{name}/" for name in ("Quickshell", "QtQuick", "QtQml"))
    require(all(name in libraries for name in platforms), "missing admitted Qt Wayland plugin")
    require(all(at(guest_real(root, f"{qt}/qml/{module}/qmldir")).is_file()
                for module in ("Quickshell", "Quickshell/Wayland", "QtQuick")),
            "missing Quickshell/QtQuick module")
    pending = [MAIN, LOADER, *platforms, *sorted(path for path in libraries if path.startswith(qml))]
    visited = set()
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        dynamic = readelf("-dW", at(path))
        origin = str(PurePosixPath(path).parent)
        hints = re.findall(r"\((?:RPATH|RUNPATH)\).*\[([^\]]+)\]", dynamic)
        dirs = [d.replace("${ORIGIN}", origin).replace("$ORIGIN", origin)
                for hint in hints for d in hint.split(":")]
        dirs = [d for d in dirs if d.startswith("/")] + [LIB, "/usr/lib", "/lib/x86_64-linux-gnu", "/lib"]
        for name in re.findall(r"\(NEEDED\).*Shared library: \[([^\]]+)\]", dynamic):
            source = next((p for d in dirs if (p := guest_real(root, d + "/" + name)) in libraries or p == LOADER), None)
            require(source is not None, f"{path}: DT_NEEDED {name} lacks a permitted canonical source")
            pending.append(source)
    return {"main": MAIN, "interpreter": LOADER, "libraries": sorted(libraries), "pin": MAIN_SHA256}, {
        "interpreterSha256": digest(at(LOADER)), "libraries": len(libraries),
        "staticDependencyFiles": len(visited), "oversizedNotGranted": oversized,
    }


def prepare_root(root, version):
    for path in ("bin", "sbin", "lib", "lib64"):
        require((root / path).is_symlink() and os.readlink(root / path) == "usr/" + path,
                f"missing merged-usr guest alias: {path}")
    for name, mode in (("dev", 0o755), ("proc", 0o755), ("sys", 0o755), ("root", 0o700),
                       ("tmp", 0o1777), ("run/user/0", 0o700), ("usr/local/bin", 0o755), ("etc/ricebox", 0o755)):
        path = root / name
        require(guest_real(root, "/" + name) == "/" + name, f"unexpected guest directory link: {name}")
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(mode)
    (root / "etc/ricebox/shell.qml").write_bytes((HERE / "shell.qml").read_bytes())
    release = root / "etc/os-release"
    require(release.is_symlink() and os.readlink(release) == "../usr/lib/os-release", "unexpected Debian os-release alias")
    original = (root / "usr/lib/os-release").read_text(encoding="utf-8")
    normalized, count = re.subn(r"(?m)^VERSION_ID=.*$", f'VERSION_ID="{version}"', original)
    require(count == 1, "no distinct VERSION_ID in Debian os-release")
    release.unlink()
    release.write_text(normalized, encoding="utf-8")


def validate_tools(fixture):
    # Compile only for format/export inspection. Do not instantiate or call the translator.
    subprocess.run(["node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
const names = new Set(WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(process.argv[1])))
  .filter(row => row.kind === 'function').map(row => row.name));
for (const name of ['sods_describe_dynamic_v2', 'sods_open_mapped_v2', 'sods_mapped_core_v4', 'sods_replay_mapped_v1'])
  if (!names.has(name)) throw new Error('Expected source-built mapped Sods: missing ' + name);
""", fixture / "sods.wasm"], check=True, timeout=30)
    info = readelf("-hW", "-lW", "-dW", fixture / "muk")
    require("ELF64" in info and "X86-64" in info and not re.search(r"\b(?:INTERP|NEEDED)\b", info),
            "expected source-built static x86-64 Muk")


def pack_root(work, version, fixture):
    tar = ["tar", "--format=pax", "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
           "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--hard-dereference",
           "-cf", "-", "root", "manifest"]
    compressed = work / "root.tar.zst"
    with compressed.open("wb") as out, subprocess.Popen(tar, cwd=work, stdout=subprocess.PIPE) as source:
        with source.stdout:
            subprocess.run(["zstd", "--quiet", "--no-progress", "-T1", "-8"], stdin=source.stdout,
                           stdout=out, check=True, timeout=120)
        require(source.wait(timeout=5) == 0, "root tar creation failed")
    root_sha = digest(compressed)
    release = compressed.rename(work / f"everyday-quickshell-{version}-x86_64-{root_sha}.tar.zst")
    subprocess.run(["node", PACKER, release, fixture / "web", "--translator", fixture / "sods.wasm", "--hot", ","],
                   check=True, timeout=120)
    return {"sha256": root_sha, "bytes": release.stat().st_size}


def generated_index_sha256(fixture):
    web = fixture / "web"
    indexes = list(web.glob("index-*.json"))
    require(len(indexes) == 1, "expected one generated index")
    path = indexes[0]
    sha = digest(path)
    about = json.loads((web / "webroot.json").read_bytes())
    require(path.name == f"index-{sha}.json" and
            about["index"] == {"path": path.name, "sha256": sha, "size": path.stat().st_size},
            "generated web root does not match the actual index bytes")
    return sha


def build(args, work):
    lock_bytes = LOCK.read_bytes()
    lock = json.loads(lock_bytes)
    utc = lock["auxiliary"]["utc"]
    require(utc, "a separately authenticated Debian UTC member is required")
    catalogs, debs, root, output = (work / name for name in ("catalogs", "debs", "root", "output"))
    fixture = output / "fixture"
    for path in (catalogs, debs, root, fixture):
        path.mkdir(parents=True)
    # Copy before verification; extraction never re-opens the caller's cache.
    for suite, row in lock["catalogs"].items():
        for kind, suffix in (("inRelease", "InRelease"), ("packagesIndex", "Packages.xz")):
            name = f"{suite}.{suffix}"
            copy_bytes(args.catalogs / name, catalogs / name, row[kind]["bytes"])
    def staged_deb(row):
        return debs / PurePosixPath(row["Filename"]).name
    for row in lock["packages"] + [utc["package"]]:
        dest = staged_deb(row)
        copy_bytes(args.debs / dest.name, dest, row["Size"])
    subprocess.run([sys.executable, "-B", HERE / "verify-debian-fixture.py", catalogs, debs,
                    "--keyring", args.keyring.resolve()], check=True, timeout=120)
    tools = ((args.sods, "sods.wasm", args.sods_sha256), (args.muk, "muk", args.muk_sha256))
    for source, name, expected in tools:
        require(re.fullmatch(r"[0-9a-f]{64}", expected), f"invalid independent SHA-256: {name}")
        length = source.stat().st_size
        require(0 < length <= MAPPED_FILE_LIMIT, f"invalid source-built artifact size: {name}")
        body = copy_bytes(source, fixture / name, length)
        require(hashlib.sha256(body).hexdigest() == expected, f"source-built SHA-256 mismatch: {name}")
    validate_tools(fixture)

    for row in lock["packages"]:
        subprocess.run(["dpkg-deb", "-x", staged_deb(row), root], check=True, timeout=30)
    utc_root = work / "timezone"
    subprocess.run(["dpkg-deb", "-x", staged_deb(utc["package"]), utc_root], check=True, timeout=30)
    member = utc["member"]
    utc_path = "/" + member["path"]
    require(guest_real(utc_root, utc_path) == utc_path, "unexpected UTC member alias")
    tzif = copy_bytes(utc_root / member["path"], fixture / "utc", member["bytes"])
    require(tzif.startswith(b"TZif") and hashlib.sha256(tzif).hexdigest() == member["sha256"],
            "wrong authenticated UTC member")
    version = lock["catalogs"]["trixie"]["version"] + ".0"
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "invalid Debian fixture version")
    prepare_root(root, version)
    sources, receipt = guest_sources(root)
    write_json(fixture / "guest-sources.json", sources)
    lock_sha = hashlib.sha256(lock_bytes).hexdigest()
    (work / "manifest").write_text(f"base.profile=everyday-quickshell-offline-fixture\ndebian.lock.sha256={lock_sha}\n")
    archive = pack_root(work, version, fixture)
    index = generated_index_sha256(fixture)
    # Handoff inside this trusted run only; not a pin for imported fixtures.
    (output / "index-sha256.txt").write_text(index + "\n")
    write_json(output / "fixture-receipt.json", {
        "mode": "on-demand",
        "inputPins": {"debianLockSha256": lock_sha, "sodsSha256": args.sods_sha256, "mukSha256": args.muk_sha256},
        "generatedIndex": {"sha256": index, "custody": "trusted-same-run-only"},
        "rootPackageCount": lock["packageCount"], "rootArchive": archive, **receipt,
        "files": {p.relative_to(fixture).as_posix(): {"bytes": p.stat().st_size, "sha256": digest(p)}
                  for p in sorted(fixture.rglob("*")) if p.is_file()},
    })
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("catalogs", "debs", "sods", "muk", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--keyring", required=True, type=Path)
    parser.add_argument("--sods-sha256", required=True, help="independently recorded mapped Sods build digest")
    parser.add_argument("--muk-sha256", required=True, help="independently recorded Muk build digest")
    args = parser.parse_args()
    os.umask(0o022)  # Stable modes for the generated fixture, not a system setting.
    try:
        require(not os.path.lexists(args.output), "fixture output already exists")
        with TemporaryDirectory(prefix=".quickshell-inputs-", dir=args.output.parent) as work:
            result = build(args, Path(work))
            require(not os.path.lexists(args.output), "fixture output appeared during assembly")
            result.rename(args.output)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Quickshell fixture staging failed: {error}\n")
    print(f"Staged on-demand Quickshell fixture inputs in {args.output}; no guest or browser run.")


if __name__ == "__main__":
    main()
