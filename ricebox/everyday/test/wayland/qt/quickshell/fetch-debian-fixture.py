"""Capture the locked Debian Snapshot bytes; follow with the separate offline audit."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import os
from pathlib import Path
import re
from select import select
import subprocess
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from typing import NamedTuple
from urllib.parse import quote

spec = importlib.util.spec_from_file_location("debian_fixture", Path(__file__).with_name("verify-debian-fixture.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
require = audit.require

WORKERS, ATTEMPTS, REQUEST_SECONDS = 4, 3, 30
CAPTURE_SECONDS = 300  # ~118 MiB; at most a third of the 15-minute native CI job.
RETRY_HTTP = {408, 429, 500, 502, 503, 504}
RETRY_CURL = {5, 6, 7, 16, 18, 28, 52, 55, 56, 92}


class SnapshotObject(NamedTuple):
    target: str
    name: str
    size: int
    sha256: str
    locator: str

    @property
    def url(self):
        return f"{audit.SNAPSHOT_BASE}{self.locator}/{quote(self.name, safe='')}"


def objects(lock):
    rows = []
    for suite, catalog in sorted(lock["catalogs"].items()):
        for key, name in (("inRelease", "InRelease"), ("packagesIndex", "Packages.xz")):
            row = catalog[key]
            rows.append(SnapshotObject(f"catalogs/{suite}.{name}", name, row["bytes"],
                                       row["sha256"], row["snapshotFileId"]))
    for row in audit.input_packages(lock):
        name = audit.deb_name(row)
        rows.append(SnapshotObject(f"debs/{name}", name, row["Size"], row["SHA256"], row["SnapshotFileId"]))
    require(len(rows) <= 256 and all(type(row.size) is int and 0 < row.size <= (64 << 20)
            and re.fullmatch(r"[0-9a-f]{64}", row.sha256) and re.fullmatch(r"[0-9a-f]{40}", row.locator)
            for row in rows) and sum(row.size for row in rows) <= (256 << 20), "invalid or oversized Snapshot plan")
    return rows


class Retryable(Exception):
    pass


def remaining(deadline):
    left = deadline - monotonic()
    require(left >= 0.001, f"Snapshot capture exhausted its {CAPTURE_SECONDS}s time budget")
    return left


def fetch(row, deadline):
    left = min(REQUEST_SECONDS, remaining(deadline))
    expires = min(deadline, monotonic() + left)
    millis = int(left * 1000)  # curl uses milliseconds; zero would disable its timeout.
    # Skip curlrc and redirects. Keep the runner's normal proxy and CA environment.
    command = ["curl", "--disable", "--silent", "--show-error", "--fail", "--proto", "=https",
               "--connect-timeout", f"{min(8000, millis) / 1000:.3f}", "--max-time", f"{millis / 1000:.3f}",
               "--max-filesize", str(row.size),
               "--write-out", "%{stderr}\n%{http_code}\n", "--", row.url]
    try:
        remaining(deadline)
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            try:
                # Independently bound raw bytes and time, even for a stalled pipe.
                body = bytearray()
                fd = process.stdout.fileno()
                while len(body) <= row.size:
                    left = expires - monotonic()
                    if left <= 0 or not select([fd], [], [], left)[0]:
                        raise TimeoutError
                    chunk = os.read(fd, min(65536, row.size + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                require(len(body) <= row.size, f"response exceeds locked byte count: {row.target}")
                _, diagnostic = process.communicate(timeout=max(0, expires - monotonic()))
            except BaseException:
                process.kill()
                raise  # The subprocess context reaps it before the worker exits.
    except (TimeoutError, subprocess.TimeoutExpired) as exc:
        remaining(deadline)
        raise Retryable("curl request timed out") from exc
    remaining(deadline)
    status_text = diagnostic.rstrip().rsplit(b"\n", 1)[-1]
    status = int(status_text) if re.fullmatch(rb"[0-9]{3}", status_text) else 0
    if process.returncode == 63:
        raise ValueError(f"response exceeds locked byte count: {row.target}")
    if status in RETRY_HTTP or (status in (0, 200) and process.returncode in RETRY_CURL):
        raise Retryable(f"HTTP {status:03d}, curl {process.returncode}")
    require(status == 200 and process.returncode == 0,
            f"Snapshot capture failed: {row.target} (HTTP {status:03d}, curl {process.returncode})")
    return body


def capture_one(row, work, deadline):
    for attempt in range(ATTEMPTS):
        remaining(deadline)
        try:
            body = fetch(row, deadline)
        except Retryable as exc:
            left = remaining(deadline)
            if attempt + 1 == ATTEMPTS:
                raise ValueError(f"Snapshot capture failed: {row.target} after {ATTEMPTS} attempts ({exc})") from exc
            sleep(min(2 ** attempt, left))
            continue
        audit.check_seal(row.target, body, row.size, row.sha256, row.locator)
        remaining(deadline)
        (work / row.target).write_bytes(body)
        return


def capture(output):
    deadline = monotonic() + CAPTURE_SECONDS
    rows = objects(audit.load_lock())
    require(not os.path.lexists(output), "Snapshot output already exists")
    with TemporaryDirectory(prefix=".quickshell-snapshot-", dir=output.parent) as directory:
        work = Path(directory) / "cache"
        work.mkdir(mode=0o700)
        for name in ("catalogs", "debs"):
            (work / name).mkdir()
        # Complete the four catalog captures before starting the package batch.
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for start in range(0, len(rows), WORKERS):
                remaining(deadline)
                list(pool.map(lambda row: capture_one(row, work, deadline), rows[start:start + WORKERS]))
        require(not os.path.lexists(output), "Snapshot output appeared during capture")
        remaining(deadline)
        work.rename(output)
    return len(rows), sum(row.size for row in rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="fresh private output directory for catalogs/ and debs/")
    args = parser.parse_args()
    try:
        count, size = capture(args.output)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Debian Snapshot capture rejected: {error}\n")
    print(f"Captured {count} locked Debian Snapshot objects ({size} bytes); run the offline signature audit.")


if __name__ == "__main__":
    main()
