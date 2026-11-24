"""Offline tests for the fixed Snapshot plan and the curl response boundary."""

import hashlib
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import current_thread
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

spec = importlib.util.spec_from_file_location("snapshot_capture", Path(__file__).with_name("fetch-debian-fixture.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

GOOD = b"body"
ROW = capture.SnapshotObject("catalogs/trixie.InRelease", "InRelease", len(GOOD),
                             hashlib.sha256(GOOD).hexdigest(), hashlib.sha1(GOOD, usedforsecurity=False).hexdigest())
POPEN = subprocess.Popen


class Clock:
    now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def future():
    return capture.monotonic() + 60


class CaptureDebianFixture(unittest.TestCase):
    def test_exact_official_plan(self):
        rows = capture.objects(capture.audit.load_lock())
        self.assertEqual((len(rows), sum(row.size for row in rows)), (211, 123503330))
        self.assertEqual(len({row.target for row in rows}), len(rows))
        self.assertEqual(rows[0].url,
                         "https://snapshot.debian.org/file/484bd29ebf2e1869e0d7014fe0146a417052b4f2/InRelease")
        self.assertEqual(rows[-1].name, "tzdata_2026f-0+deb13u1_all.deb")
        self.assertIn("%2B", rows[-1].url)
        for row in rows:
            url = urlsplit(row.url)
            self.assertEqual((url.scheme, url.netloc, url.query, url.fragment), ("https", "snapshot.debian.org", "", ""))
            self.assertEqual(unquote(url.path), f"/file/{row.locator}/{row.name}")

    def test_invalid_locator_or_size_stops_before_fetching(self):
        for field, invalid in (("snapshotFileId", "../unsafe"), ("bytes", 128 << 20)):
            lock = capture.audit.load_lock()
            lock["catalogs"]["trixie"]["inRelease"][field] = invalid
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "invalid or oversized"):
                capture.objects(lock)

    def response(self, body, status, result):
        def transport(command, **stdio):
            self.assertEqual(command[:2], ["curl", "--disable"])
            self.assertEqual(command[-4:], ["--write-out", "%{stderr}\n%{http_code}\n", "--", ROW.url])
            self.assertNotIn("--location", command)
            self.assertNotIn("env", stdio)
            self.assertEqual(command[command.index("--proto") + 1], "=https")
            self.assertEqual(command[command.index("--max-filesize") + 1], str(ROW.size))
            return POPEN([sys.executable, "-c", f"import sys; sys.stdout.buffer.write({body!r}); "
                          f"sys.stderr.write('\\n{status}\\n'); sys.exit({result})"], **stdio)
        return patch.object(capture.subprocess, "Popen", side_effect=transport)

    def test_exact_success_and_permanent_statuses(self):
        with self.response(GOOD, 200, 0):
            self.assertEqual(capture.fetch(ROW, future()), GOOD)
        for status, result in ((301, 0), (206, 0), (404, 22), ("000", 60)):
            with self.subTest(status=status), self.response(GOOD, status, result):
                with self.assertRaisesRegex(ValueError, f"HTTP {status}"):
                    capture.fetch(ROW, future())

    def test_response_byte_ceiling_and_transient_status(self):
        for body, status, result in ((GOOD + b"extra", 200, 0), (b"", 200, 63)):
            with self.subTest(result=result), self.response(body, status, result):
                with self.assertRaisesRegex(ValueError, "exceeds locked byte count"):
                    capture.fetch(ROW, future())
        for status, result in ((503, 22), (429, 22), ("000", 28)):
            with self.subTest(status=status), self.response(b"", status, result):
                with self.assertRaises(capture.Retryable):
                    capture.fetch(ROW, future())

    def test_stalled_curl_is_clamped_killed_and_reaped(self):
        for span, cutoff, failure in ((0.25, 0.25, ValueError), (60, 30, capture.Retryable)):
            with self.subTest(span=span):
                clock, children = Clock(), []

                def transport(command, **stdio):
                    self.assertEqual(command[command.index("--max-time") + 1], f"{cutoff:.3f}")
                    self.assertEqual(command[command.index("--connect-timeout") + 1], f"{min(8, cutoff):.3f}")
                    child = POPEN([sys.executable, "-c", "import time; time.sleep(60)"], **stdio)
                    children.append(child)
                    return child

                def no_readable_pipe(_read, _write, _error, timeout):
                    self.assertAlmostEqual(timeout, cutoff)
                    clock.advance(timeout)
                    return [], [], []

                with (patch.object(capture, "monotonic", clock),
                      patch.object(capture, "select", side_effect=no_readable_pipe),
                      patch.object(capture.subprocess, "Popen", side_effect=transport)):
                    with self.assertRaisesRegex(failure, "time budget" if span < 1 else "request timed out"):
                        capture.fetch(ROW, clock() + span)
                self.assertEqual(len(children), 1)
                self.assertEqual(children[0].returncode, -signal.SIGKILL)

    def test_retry_uses_fresh_body_and_is_bounded(self):
        error = capture.Retryable("test transient")
        with TemporaryDirectory() as directory, patch.object(capture, "sleep") as sleep:
            work = Path(directory)
            (work / "catalogs").mkdir()
            with patch.object(capture, "fetch", side_effect=[error, GOOD]) as fetch:
                capture.capture_one(ROW, work, future())
                self.assertEqual(fetch.call_count, 2)
                self.assertEqual((work / ROW.target).read_bytes(), GOOD)
            (work / ROW.target).unlink()
            sleep.reset_mock()
            with patch.object(capture, "fetch", side_effect=error) as fetch:
                with self.assertRaisesRegex(ValueError, "after 3 attempts"):
                    capture.capture_one(ROW, work, future())
                self.assertEqual(fetch.call_count, 3)
                self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])
                self.assertFalse((work / ROW.target).exists())

    def test_expiry_during_backoff_prevents_the_next_curl(self):
        clock = Clock()
        with (TemporaryDirectory() as directory, patch.object(capture, "monotonic", clock),
              patch.object(capture, "sleep", side_effect=clock.advance) as sleep,
              patch.object(capture, "fetch", side_effect=capture.Retryable("transient")) as fetch):
            deadline = clock() + 0.25
            with self.assertRaisesRegex(ValueError, "time budget"):
                capture.capture_one(ROW, Path(directory), deadline)
            sleep.assert_called_once_with(0.25)
            fetch.assert_called_once_with(ROW, deadline)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_expired_batch_has_no_following_admission_or_promotion(self):
        for rows in ([ROW], [ROW, ROW._replace(target="debs/next.deb")]):
            with self.subTest(planned=len(rows)), TemporaryDirectory() as directory:
                clock, workers = Clock(), []
                parent = Path(directory)
                capture_one = capture.capture_one

                def completes_at_cutoff(row, work, deadline):
                    workers.append(current_thread())
                    capture_one(row, work, deadline)
                    clock.advance(deadline - clock())

                with (patch.object(capture, "monotonic", clock), patch.object(capture, "WORKERS", 1),
                      patch.object(capture, "objects", return_value=rows),
                      patch.object(capture, "fetch", return_value=GOOD) as fetch,
                      patch.object(capture, "capture_one", side_effect=completes_at_cutoff)):
                    with self.assertRaisesRegex(ValueError, "time budget"):
                        capture.capture(parent / "new")
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual(len(workers), 1)
                self.assertFalse(workers[0].is_alive())
                self.assertEqual(list(parent.iterdir()), [])

    def test_bad_body_leaves_no_named_or_partial_cache_and_never_retries(self):
        for bad, message in ((b"bod", "wrong byte count"), (b"Body", "SHA-256 mismatch")):
            with self.subTest(bad=bad), TemporaryDirectory() as directory:
                parent = Path(directory)
                with patch.object(capture, "objects", return_value=[ROW]), patch.object(capture, "fetch", return_value=bad) as fetch:
                    with self.assertRaisesRegex(ValueError, message):
                        capture.capture(parent / "new")
                    self.assertEqual(fetch.call_count, 1)
                    self.assertEqual(list(parent.iterdir()), [])

    def test_success_is_private_and_refuses_an_existing_cache(self):
        with TemporaryDirectory() as directory:
            output = Path(directory) / "new"
            with patch.object(capture, "objects", return_value=[ROW]), patch.object(capture, "fetch", return_value=GOOD) as fetch:
                self.assertEqual(capture.capture(output), (1, len(GOOD)))
                self.assertEqual((output / ROW.target).read_bytes(), GOOD)
                self.assertEqual(output.stat().st_mode & 0o777, 0o700)
                with self.assertRaisesRegex(ValueError, "already exists"):
                    capture.capture(output)
                self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
