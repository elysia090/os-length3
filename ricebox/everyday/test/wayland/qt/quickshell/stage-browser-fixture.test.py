"""Offline controls for the producer's private-copy and guest-path boundary."""

import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stage_browser_fixture", HERE / "stage-browser-fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class StageBrowserFixture(unittest.TestCase):
    def test_absolute_link_resolves_inside_guest(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "lib64").symlink_to("/usr/lib64")
            (root / "usr/lib64").mkdir(parents=True)
            (root / "usr/lib64/ld.so").symlink_to("../lib/x86_64-linux-gnu/ld.so")
            self.assertEqual(fixture.guest_real(root, "/lib64/ld.so"), "/usr/lib/x86_64-linux-gnu/ld.so")

    def test_guest_link_cannot_escape_or_loop(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "up").symlink_to("../../outside")
            (root / "loop").symlink_to("loop")
            with self.assertRaisesRegex(ValueError, "escapes root"):
                fixture.guest_real(root, "/up")
            with self.assertRaisesRegex(ValueError, "too many guest symlinks"):
                fixture.guest_real(root, "/loop")

    def test_copy_reads_only_expected_file_length(self):
        with TemporaryDirectory() as directory:
            src = Path(directory) / "supplied"
            dest = Path(directory) / "private"
            src.write_bytes(b"three")
            with self.assertRaisesRegex(ValueError, "wrong input length"):
                fixture.copy_bytes(src, dest, 3)
            self.assertFalse(dest.exists())
            self.assertEqual(fixture.copy_bytes(src, dest, 5), b"three")
            src.write_bytes(b"other")
            self.assertEqual(dest.read_bytes(), b"three")

    def test_generated_index_digest_is_recomputed_from_bytes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            web = root / "web"
            web.mkdir()
            payload = b"{}"
            sha = hashlib.sha256(payload).hexdigest()
            name = f"index-{sha}.json"
            index = web / name
            index.write_bytes(payload)
            (web / "webroot.json").write_text(json.dumps({"index": {"path": name, "sha256": sha, "size": len(payload)}}))
            self.assertEqual(fixture.generated_index_sha256(root), sha)
            index.write_bytes(b"[]")
            with self.assertRaisesRegex(ValueError, "does not match the actual index bytes"):
                fixture.generated_index_sha256(root)

    def test_utc_is_pinned_and_not_a_root_package(self):
        lock = json.loads(fixture.LOCK.read_text())
        utc = lock["auxiliary"]["utc"]
        self.assertEqual(utc["package"]["Package"], "tzdata")
        self.assertEqual(utc["member"]["bytes"], 114)
        self.assertFalse(any(row["Package"] == "tzdata" for row in lock["packages"]))


if __name__ == "__main__":
    unittest.main()
