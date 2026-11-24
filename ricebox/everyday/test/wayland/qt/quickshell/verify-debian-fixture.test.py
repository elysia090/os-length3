"""Fast offline controls; no Debian package cache or private key is required."""

from copy import deepcopy
from datetime import datetime
from email.utils import format_datetime
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify_debian_fixture", ROOT / "verify-debian-fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
LOCK = json.loads(fixture.LOCK.read_text())
PINS = {name: sha for sha, name in map(str.split, (ROOT / "debs.sha256").read_text().splitlines())}
REVIEW = datetime.fromisoformat(LOCK["reviewedAt"])
BPO = LOCK["catalogs"]["trixie-backports"]
SINCE = datetime.fromisoformat(BPO["date"])


def signatures(signers=BPO["signers"], algorithm="8", when=SINCE):
    # Model the GnuPG status parser only; signature cryptography is exercised
    # separately by giving the real CLI the genuine sealed Debian catalogs.
    return [f"VALIDSIG {key} {when.date()} {int(when.timestamp())} 0 4 0 1 {algorithm} 01 {key}" for key in signers]


def release_text(index_line=None, section="SHA256"):
    return f"""Origin: {BPO["origin"]}
Suite: {BPO["suite"]}
Codename: trixie-backports
Date: {format_datetime(SINCE)}
Valid-Until: {format_datetime(datetime.fromisoformat(BPO["validUntil"]))}
{section}:
 {index_line or (BPO["packagesIndex"]["sha256"] + " " + str(BPO["packagesIndex"]["bytes"]) + " " + fixture.INDEX_PATH)}
"""


class DebianFixture(unittest.TestCase):
    def test_exact_frozen_quickshell_qt_and_loader_representatives(self):
        fixture.check_lock(LOCK, PINS)
        self.assertEqual((LOCK["packageCount"], LOCK["packageBytes"]), (206, 113_050_288))
        rows = {r["Package"]: r for r in LOCK["packages"]}
        for package, version, locator in (
            ("quickshell", "0.3.0-1~bpo13+1", "9267ac7e2d72f09a172013115b1d45507192d461"),
            ("qt6-wayland", "6.8.2-4", "7915a0f2c5afeca205e6d35f86b2d671360c1c19"),
            ("libc6", "2.41-12+deb13u5", "2814165ecd61dee3d64ca4dedfbe47fc9da5e3d1"),
        ):
            with self.subTest(package=package):
                self.assertEqual((rows[package]["Version"], rows[package]["SnapshotFileId"]), (version, locator))

    def test_existing_deb_pins_must_agree_with_lock(self):
        locked = deepcopy(LOCK)
        next(p for p in locked["packages"] if p["Package"] == "quickshell")["SHA256"] = "1" * 64
        with self.assertRaisesRegex(ValueError, "existing Quickshell .deb pins"):
            fixture.check_lock(locked, PINS)

    def test_utc_not_silently_admitted(self):
        locked = deepcopy(LOCK)
        locked["auxiliary"]["utc"] = {"sha256": "1" * 64}
        with self.assertRaisesRegex(ValueError, "auxiliary"):
            fixture.check_lock(locked, PINS)

    def test_unsafe_pool_filename_rejected(self):
        for filename in ("pool/main/../root.deb", "/pool/main/x/file.deb", "pool/contrib/x/file.deb"):
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, "invalid Debian pool path"):
                fixture.deb_name({"Filename": filename})

    def test_tampered_same_length_blob_rejected_even_under_its_locator(self):
        with TemporaryDirectory() as directory:
            file = Path(directory) / "test.deb"
            good = b"authentic"
            sha = hashlib.sha256(good).hexdigest()
            loc = hashlib.sha1(good, usedforsecurity=False).hexdigest()
            file.write_bytes(good)
            self.assertEqual(fixture.sealed_bytes(file, len(good), sha, loc), good)
            evil = b"Authentic"
            file.write_bytes(evil)
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                fixture.sealed_bytes(file, len(good), sha, hashlib.sha1(evil, usedforsecurity=False).hexdigest())

    def test_catalog_membership_requires_exact_full_tuple(self):
        row = next(r for r in LOCK["packages"] if r["Package"] == "quickshell")
        fixture.check_package_records([row], [row], "trixie-backports")
        for field, change in (("Version", "0.3.1"), ("Architecture", "arm64"),
                              ("Size", row["Size"] + 1), ("SHA256", "0" * 64)):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "absent from signed"):
                fixture.check_package_records([row | {field: change}], [row], "trixie-backports")
        with self.assertRaisesRegex(ValueError, "duplicate locked"):
            fixture.check_package_records([row, row], [row], "trixie-backports")

    def test_requires_locked_signer_roster_and_sha256(self):
        fixture.check_signatures(signatures(), BPO["signers"], SINCE, REVIEW)
        with self.assertRaisesRegex(ValueError, "signer roster"):
            fixture.check_signatures(signatures(BPO["signers"][:1]), BPO["signers"], SINCE, REVIEW)
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            fixture.check_signatures(signatures(algorithm="2"), BPO["signers"], SINCE, REVIEW)

    def test_rejects_bad_signature_even_if_a_valid_one_exists(self):
        with self.assertRaisesRegex(ValueError, "REVKEYSIG"):
            fixture.check_signatures(signatures() + ["REVKEYSIG revoked"], BPO["signers"], SINCE, REVIEW)

    def test_requires_the_index_in_signed_sha256_section(self):
        fixture.check_release(release_text(), signatures(), "trixie-backports", BPO, REVIEW)
        with self.assertRaisesRegex(ValueError, "missing signed SHA256"):
            fixture.check_release(release_text(section="SHA512"), signatures(), "trixie-backports", BPO, REVIEW)
        bogus_index_line = f"{'0' * 64} {BPO['packagesIndex']['bytes']} {fixture.INDEX_PATH}"
        with self.assertRaisesRegex(ValueError, "wrong signed amd64 index"):
            fixture.check_release(release_text(bogus_index_line), signatures(), "trixie-backports", BPO, REVIEW)

    def test_historical_freeze_must_have_been_inside_signed_validity(self):
        after_valid = datetime.fromisoformat("2026-12-02T00:00:00Z")
        with self.assertRaisesRegex(ValueError, "outside frozen review interval"):
            fixture.check_release(release_text(), signatures(), "trixie-backports", BPO, after_valid)


if __name__ == "__main__":
    unittest.main()
