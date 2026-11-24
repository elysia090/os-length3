"""Verify a frozen Quickshell fixture package set, without fetching or extracting it."""

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import io
import json
import lzma
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
LOCK = HERE / "debian-fixture.lock.json"
TRIXIE_SIGNER = "04B54C3CDCA79751B16BC6B5225629DF75B188BD"
INDEX_PATH = "main/binary-amd64/Packages.xz"
SNAPSHOT_BASE = "https://snapshot.debian.org/file/"
PACKAGE_FIELDS = ("Package", "Version", "Architecture", "Filename", "Size", "SHA256")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def deb_name(row):
    filename = row["Filename"]
    require(re.fullmatch(r"pool/main/(?:[a-z0-9][a-z0-9.+-]*/)+[a-zA-Z0-9][a-zA-Z0-9._+~-]*\.deb", filename),
            f"invalid Debian pool path: {filename}")
    return filename.rsplit("/", 1)[1]


def sealed_bytes(path, size, sha256, locator):
    require(type(size) is int and size > 0 and re.fullmatch(r"[0-9a-f]{64}", sha256)
            and re.fullmatch(r"[0-9a-f]{40}", locator), f"invalid seal: {path.name}")
    require(path.is_file() and not path.is_symlink(), f"missing regular input: {path.name}")
    with path.open("rb") as file:
        body = file.read(size + 1)
    check_seal(path.name, body, size, sha256, locator)
    return body


def check_seal(name, body, size, sha256, locator):
    require(len(body) == size, f"wrong byte count: {name}")
    require(hashlib.sha256(body).hexdigest() == sha256, f"SHA-256 mismatch: {name}")
    # A Snapshot SHA-1 is a transport locator, never the authenticity check.
    require(hashlib.sha1(body, usedforsecurity=False).hexdigest() == locator,
            f"Snapshot locator mismatch: {name}")


def control_stanzas(lines):
    stanza = {}
    for line in lines:
        line = line.rstrip("\r\n")
        if not line:
            if stanza:
                yield stanza
                stanza = {}
        elif line[0] not in " \t":
            name, sep, value = line.partition(":")
            require(sep and name and name not in stanza, "invalid or duplicate Debian control field")
            stanza[name] = value.strip()
    if stanza:
        yield stanza


def check_signatures(status, expected, since, reviewed):
    bad = {"BADSIG", "ERRSIG", "REVKEYSIG", "EXPKEYSIG", "EXPSIG", "KEYEXPIRED",
           "KEYREVOKED", "NO_PUBKEY", "NODATA", "BADARMOR", "FAILURE"}
    signers = []
    for line in status:
        tag, *fields = line.split()
        require(tag not in bad, f"bad Debian Release signature status: {tag}")
        if tag == "VALIDSIG":
            require(len(fields) in (9, 10), "unexpected VALIDSIG format")
            require(fields[7:9] == ["8", "01"], "Debian Release requires a SHA-256 text signature")
            when = datetime.fromtimestamp(int(fields[2]), timezone.utc)
            require(since <= when <= reviewed, "Debian Release signature outside the review interval")
            signers.append(fields[9] if len(fields) == 10 else fields[0])
    require(sorted(signers) == sorted(expected) and TRIXIE_SIGNER in signers,
            "unexpected Debian Release signer roster")


def clear_signed_release(body, keyring, home):
    # A private home, explicit public keyring, and no ambient config/key discovery.
    result = subprocess.run([
        "gpg", "--no-options", "--batch", "--homedir", home, "--no-default-keyring",
        "--keyring", str(keyring), "--no-auto-key-retrieve", "--no-auto-key-import",
        "--auto-key-locate", "clear", "--status-fd", "2", "--decrypt",
    ], input=body, capture_output=True, check=False, timeout=30)
    require(result.returncode == 0, "Debian InRelease signature verification failed")
    status = [line.removeprefix("[GNUPG:] ") for line in result.stderr.decode().splitlines()
              if line.startswith("[GNUPG:] ")]
    return result.stdout.decode(), status


def check_release(text, status, suite, catalog, review):
    stanzas = list(control_stanzas(text.splitlines()))
    require(len(stanzas) == 1, f"invalid signed Release: {suite}")
    release = stanzas[0]
    for field, expected in (("Codename", suite), ("Origin", catalog["origin"]),
                            ("Suite", catalog["suite"]), ("Version", catalog["version"])):
        require(release.get(field) == expected, f"wrong signed {field}: {suite}")
    since = datetime.fromisoformat(catalog["date"])
    expiry = datetime.fromisoformat(catalog["validUntil"]) if catalog["validUntil"] else None
    require(parsedate_to_datetime(release["Date"]) == since, f"wrong signed Release date: {suite}")
    actual_expiry = parsedate_to_datetime(release["Valid-Until"]) if "Valid-Until" in release else None
    require(actual_expiry == expiry and since <= review and (expiry is None or review <= expiry),
            f"signed Release outside frozen review interval: {suite}")
    check_signatures(status, catalog["signers"], since, review)
    # Do not match an MD5/SHA-512 field, substring path, or similarly named index.
    found = re.findall(r"(?m)^SHA256:\s*\n((?:[ \t]+[^\n]+\n)+)", text)
    require(len(found) == 1, f"missing signed SHA256 section: {suite}")
    lines = [line.split() for line in found[0].splitlines()]
    pinned = catalog["packagesIndex"]
    require([line for line in lines if line and line[-1] == INDEX_PATH] ==
            [[pinned["sha256"], str(pinned["bytes"]), INDEX_PATH]],
            f"wrong signed amd64 index: {suite}")


def package_tuple(row):
    return tuple(str(row.get(field, "")) for field in PACKAGE_FIELDS)


def check_package_records(stanzas, rows, suite):
    wanted = {package_tuple(row) for row in rows}
    found = set()
    for stanza in stanzas:
        key = package_tuple(stanza)
        if key in wanted:
            require(key not in found, f"duplicate locked Debian package in signed index: {key[0]}")
            found.add(key)
    for key in sorted(wanted - found):
        raise ValueError(f"locked Debian package is absent from signed {suite} index: {key[0]} {key[1]}")


def input_packages(lock):
    utc = lock["auxiliary"]["utc"]
    return lock["packages"] + ([utc["package"]] if utc else [])


def check_lock(lock, five_pins):
    require(lock["schema"] == 1 and lock["architecture"] == "amd64"
            and lock["snapshotBase"] == SNAPSHOT_BASE
            and set(lock["auxiliary"]) == {"utc"}, "unexpected Debian closure lock schema or auxiliary input")
    utc = lock["auxiliary"]["utc"]
    if utc is not None:
        require(isinstance(utc, dict) and set(utc) == {"package", "member"}
                and utc["package"]["Package"] == "tzdata" and utc["package"]["Suite"] == "trixie"
                and utc["package"]["Architecture"] == "all"
                and utc["member"]["path"] == "usr/share/zoneinfo/Etc/UTC"
                and type(utc["member"]["bytes"]) is int and 0 < utc["member"]["bytes"] <= 4096
                and re.fullmatch(r"[0-9a-f]{64}", utc["member"]["sha256"]), "invalid UTC auxiliary pin")
        require(all(row["Package"] != "tzdata" for row in lock["packages"]), "UTC aux package also in root closure")
    catalogs = lock["catalogs"]
    require(set(catalogs) == {"trixie", "trixie-backports"}, "unexpected Debian catalogs")
    require(all(re.fullmatch(r"[0-9A-F]{40}", fingerprint)
                and re.fullmatch(r"https://ftp-master[.]debian[.]org/keys/(?:archive-key|release)-[0-9]+[.]asc", url)
                for fingerprint, url in lock["archiveKeys"].items()), "unexpected archive public key references")
    for catalog in catalogs.values():
        require(catalog["packagesIndex"]["path"] == INDEX_PATH
                and TRIXIE_SIGNER in catalog["signers"]
                and set(catalog["signers"]) <= set(lock["archiveKeys"]), "unexpected Debian trust/index pins")
    rows = lock["packages"]
    require(len(rows) == lock["packageCount"] and len({row["Package"] for row in rows}) == len(rows)
            and sum(row["Size"] for row in rows) == lock["packageBytes"], "inconsistent exact Debian closure")
    by_filename = {}
    for row in input_packages(lock):
        name = deb_name(row)
        require(row["Suite"] in catalogs and row["Architecture"] in ("amd64", "all") and name not in by_filename,
                f"unexpected or duplicate locked Debian package: {name}")
        by_filename[name] = row["SHA256"]
    require(all(by_filename.get(name) == digest for name, digest in five_pins.items()),
            "the existing Quickshell .deb pins do not match the exact closure")


def load_lock():
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    five_pins = {name: digest for digest, name in map(str.split, (HERE / "debs.sha256").read_text().splitlines())}
    check_lock(lock, five_pins)
    return lock


def verify(catalog_dir, deb_dir, keyring):
    lock = load_lock()
    review = datetime.fromisoformat(lock["reviewedAt"])
    require(keyring.is_file(), "the explicit Debian archive keyring is missing")
    with TemporaryDirectory(prefix="ricebox-debian-keyring-") as home:
        for suite, catalog in lock["catalogs"].items():
            release = catalog["inRelease"]
            raw = sealed_bytes(catalog_dir / f"{suite}.InRelease", release["bytes"], release["sha256"],
                               release["snapshotFileId"])
            signed, status = clear_signed_release(raw, keyring.resolve(), home)
            check_release(signed, status, suite, catalog, review)
            index = catalog["packagesIndex"]
            packed = sealed_bytes(catalog_dir / f"{suite}.Packages.xz", index["bytes"], index["sha256"],
                                  index["snapshotFileId"])
            with lzma.open(io.BytesIO(packed), "rt", encoding="utf-8") as stream:
                rows = [row for row in input_packages(lock) if row["Suite"] == suite]
                check_package_records(control_stanzas(stream), rows, suite)
    # Only the exact locked filenames are read. No extraction or package scripts.
    for row in input_packages(lock):
        sealed_bytes(deb_dir / deb_name(row), row["Size"], row["SHA256"], row["SnapshotFileId"])
    return lock["packageCount"], lock["packageBytes"], lock["auxiliary"]["utc"] is not None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalogs", type=Path, help="local directory containing the four sealed catalog files")
    parser.add_argument("debs", type=Path, help="local cache containing the exact locked .deb files")
    parser.add_argument("--keyring", required=True, type=Path, help="trusted Debian archive verification keyring")
    args = parser.parse_args()
    try:
        count, size, utc = verify(args.catalogs, args.debs, args.keyring)
    except (ValueError, OSError, subprocess.TimeoutExpired, lzma.LZMAError) as error:
        parser.exit(1, f"Debian fixture input rejected: {error}\n")
    print(f"Verified two signed Debian catalogs and {count} root .debs ({size} bytes).")
    if utc:
        print("Verified the separate signed UTC .deb; the producer checks its extracted member.")
    else:
        print("UTC is not verified by this lock.")


if __name__ == "__main__":
    main()
