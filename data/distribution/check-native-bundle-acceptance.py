#!/usr/bin/env python3
"""Isolated binding fixtures; never run the product, keys, or diagnostic ELF."""

import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
spec = importlib.util.spec_from_file_location("acceptance", HERE / "native-bundle-acceptance.py")
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)
CAPTURED_RECEIPTS = []


class FixtureSetup:
    def setUp(self):
        parent = (REPO / "temp").resolve()
        parent.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="native-acceptance-fixture-", dir=parent)
        self.scratch = Path(self.directory.name)
        def cleanup():
            if self.scratch.resolve().parent != parent:
                raise ValueError("fixture cleanup escaped its owned parent")
            self.directory.cleanup()
        self.addCleanup(cleanup)
        self.repo = self.scratch / "repo"
        for name in acceptance.POLICY_FILES:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, target)
        self.inputs = []
        for name, data in zip(acceptance.INPUT_FILES, (b"archive-before", b"inputs-before",
                                                     b"#!/bin/sh\nexit 0\n", b"source-before"), strict=True):
            path = self.scratch / name
            path.write_bytes(data)
            path.chmod(0o700 if name == "postlink-verify" else 0o600)
            self.inputs.append(path)
        self.expected = acceptance.context(self.repo, self.inputs)
        self.receipt = dict(self.expected, results=acceptance.RESULTS)
        self.output = self.scratch / "acceptance.json"
        self.sentinel = self.scratch / "caller-work-difference"
        self.sentinel.write_bytes(b"retain\n")

    def unchanged(self, operation):
        paths = self.inputs + [self.sentinel]
        if self.output.exists():
            paths.append(self.output)
        before = [path.read_bytes() for path in paths]
        with self.assertRaises((ValueError, OSError, subprocess.CalledProcessError)):
            operation()
        self.assertEqual(before, [path.read_bytes() for path in paths])


class BindingFixture(FixtureSetup, unittest.TestCase):
    def test_valid_binding_is_explicitly_unqualified(self):
        acceptance.validate_receipt(self.receipt, acceptance.context(self.repo, self.inputs))
        self.assertEqual(self.receipt["producer-source-binding"], "unknown")
        self.assertEqual(self.receipt["product-qualification"], "pending")

    def test_same_size_artifact_edit_rejects_old_green(self):
        self.inputs[0].write_bytes(b"archive-after!")
        self.assertEqual(len(b"archive-before"), len(b"archive-after!"))
        self.unchanged(lambda: acceptance.validate_receipt(
            self.receipt, acceptance.context(self.repo, self.inputs)))

    def test_verifier_binary_mismatch(self):
        self.inputs[2].write_bytes(b"#!/bin/sh\nexit 1\n")
        self.unchanged(lambda: acceptance.validate_receipt(
            self.receipt, acceptance.context(self.repo, self.inputs)))

    def test_release_input_mismatch(self):
        self.inputs[1].write_bytes(b"inputs-after!")
        self.unchanged(lambda: acceptance.validate_receipt(
            self.receipt, acceptance.context(self.repo, self.inputs)))

    def test_development_source_mismatch(self):
        self.inputs[3].write_bytes(b"source-after!")
        self.unchanged(lambda: acceptance.validate_receipt(
            self.receipt, acceptance.context(self.repo, self.inputs)))

    def test_policy_revision_mismatch(self):
        with (self.repo / acceptance.POLICY_FILES[2]).open("ab") as stream:
            stream.write(b"\n# stricter policy\n")
        self.unchanged(lambda: acceptance.validate_receipt(
            self.receipt, acceptance.context(self.repo, self.inputs)))

    def test_changed_conditions(self):
        receipt = copy.deepcopy(self.receipt)
        receipt["conditions"]["kernel"] = "another-host"
        self.unchanged(lambda: acceptance.validate_receipt(receipt, self.expected))

    def test_unbacked_verified_source_claim(self):
        receipt = dict(self.receipt, **{"producer-source-binding": "verified"})
        self.unchanged(lambda: acceptance.validate_receipt(receipt, self.expected))

    def test_self_declared_source_snapshot_is_not_evidence(self):
        receipt = dict(self.receipt, **{"producer-source.sha256": "a" * 64})
        self.unchanged(lambda: acceptance.validate_receipt(receipt, self.expected))

    def test_self_declared_product_approval(self):
        receipt = dict(self.receipt, **{"product-qualification": "passed"})
        self.unchanged(lambda: acceptance.validate_receipt(receipt, self.expected))

    def test_failed_or_missing_check(self):
        for results in ({"root": "passed"}, dict(acceptance.RESULTS, https="failed")):
            self.unchanged(lambda: acceptance.validate_receipt(dict(self.receipt, results=results), self.expected))

    def test_legacy_record_retained(self):
        self.output.write_bytes(b"format=native-release-acceptance-v2\nextracted-native-runtime=green\n")
        self.unchanged(lambda: acceptance.publish_record(self.output, self.receipt))

    def test_no_clobber_idempotent_receipt(self):
        acceptance.publish_record(self.output, self.receipt)
        identity = self.output.stat().st_ino
        acceptance.publish_record(self.output, self.receipt)
        self.assertEqual(identity, self.output.stat().st_ino)
        self.unchanged(lambda: acceptance.publish_record(self.output, dict(self.receipt, scope="other")))

    def test_duplicate_record_fields(self):
        self.output.write_bytes(b'{"format":"old", "format":"new"}\n')
        self.unchanged(lambda: acceptance.load_record(self.output))

    def test_existing_receipt_directory_retained(self):
        self.output.mkdir()
        retained = self.output / "caller-data"
        retained.write_bytes(b"retain directory contents\n")
        with self.assertRaises(OSError):
            acceptance.publish_record(self.output, self.receipt)
        self.assertEqual(list(self.output.iterdir()), [retained])
        self.assertEqual(retained.read_bytes(), b"retain directory contents\n")
        self.assertEqual(self.sentinel.read_bytes(), b"retain\n")

    def test_owned_copies_detach_original_inodes(self):
        stage = self.scratch / "cut"
        captured = acceptance.context(self.repo, self.inputs, stage)
        original = self.inputs[0].read_bytes()
        self.inputs[0].write_bytes(b"archive-after!")
        private = [stage / "inputs" / name for name in acceptance.INPUT_FILES]
        self.assertEqual(private[0].read_bytes(), original)
        self.assertEqual(acceptance.context(stage / "policy", private), captured)
        self.assertNotEqual(acceptance.context(self.repo, self.inputs), captured)

    def test_diagnostic_overrides_rejected(self):
        with patch.dict(os.environ, {"QM_NATIVE_FAULT_TRACER": "/fixture/not-executed"}):
            self.unchanged(acceptance.reject_diagnostic_overrides)


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0 and shutil.which("zstd"),
                     "end-to-end capture fixtures require Linux root and zstd")
class CapturedChecksFixture(FixtureSetup, unittest.TestCase):
    def setUp(self):
        super().setUp()
        # Only this disposable policy copy is replaced. The real runtime/HTTPS
        # suite (including scratch key generation) is never executed by fixtures.
        scripts = {
            "check-root.sh": '#!/bin/bash\nset -e\ntest "$(cat "$1/payload")" = before\n"$2" "$1"\n',
            "check-native-runtime.sh": '#!/bin/bash\nset -e\ntest "$(cat "$1/payload")" = before\n',
            "check-native-development.sh": '#!/bin/bash\nset -e\ntest "$(cat "$2")" = source-before\n',
            "check-native-https.py": 'import pathlib,sys\nassert (pathlib.Path(sys.argv[1])/"payload").read_bytes()==b"before\\n"\n',
        }
        for name, data in scripts.items():
            (self.repo / "data/distribution" / name).write_text(data, encoding="utf-8")
        self.inputs[1].write_bytes(b"format=canonical-release-inputs-v4\nprofile=fixture\n")
        self.inputs[2].write_bytes(b'#!/bin/sh\ntest "$(cat "$1/payload")" = before\n')
        self.make_bundle(self.inputs[1].read_bytes())

    def make_bundle(self, manifest):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for name, data in (("manifest", manifest), ("root/payload", b"before\n")):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
        self.inputs[0].write_bytes(subprocess.check_output(["zstd", "-q", "-c"], input=archive.getvalue()))

    def remember_receipt(self):
        receipt = acceptance.load_record(self.output)
        CAPTURED_RECEIPTS.append({"fixture": self.id().split(".")[-1],
                                 "archive": receipt["inputs"]["bundle.tar.zst"],
                                 "receipt": acceptance.read_file(self.output),
                                 "policy.sha256": receipt["policy"]["sha256"],
                                 "conditions": receipt["conditions"],
                                 "scope": "isolated-fixture-policy-only"})

    def test_full_capture_and_repeat(self):
        counter = self.scratch / "runtime-runs"
        (self.repo / "data/distribution/check-native-runtime.sh").write_text(
            '#!/bin/bash\nset -e\ntest "$(cat "$1/payload")" = before\n'
            f"printf 'run\\n' >> {shlex.quote(str(counter))}\n", encoding="utf-8")
        acceptance.check(self.repo, self.inputs, self.output)
        receipt = acceptance.load_record(self.output)
        acceptance.validate_receipt(receipt, acceptance.context(self.repo, self.inputs))
        identity = self.output.stat().st_ino
        acceptance.check(self.repo, self.inputs, self.output)
        self.assertEqual(identity, self.output.stat().st_ino)
        self.assertEqual(counter.read_bytes(), b"run\nrun\n")
        self.remember_receipt()

    def test_failed_check_never_emits_receipt(self):
        (self.repo / "data/distribution/check-native-development.sh").write_bytes(b"#!/bin/sh\nexit 7\n")
        self.unchanged(lambda: acceptance.check(self.repo, self.inputs, self.output))
        self.assertFalse(self.output.exists())

    def test_archive_manifest_mismatch(self):
        self.make_bundle(b"format=canonical-release-inputs-v4\nprofile=other\n")
        self.unchanged(lambda: acceptance.check(self.repo, self.inputs, self.output))
        self.assertFalse(self.output.exists())

    def test_original_substitution_after_capture_fails_publication(self):
        script = self.repo / "data/distribution/check-root.sh"
        original = shlex.quote(str(self.inputs[2]))
        marker = self.scratch / "captured-verifier-consumed"
        # Controlled TOCTOU changes only the caller-owned fixture verifier.
        # The captured verifier must still pass after that original substitution;
        # the changed original cannot receive the prior cut's green receipt.
        script.write_text('#!/bin/bash\nset -e\ntest "$(cat "$1/payload")" = before\n'
                          f"printf '#!/bin/sh\\nexit 9\\n' > {original}\n"
                          '"$2" "$1"\n'
                          f"printf 'captured\\n' > {shlex.quote(str(marker))}\n", encoding="utf-8")
        sentinel = self.sentinel.read_bytes()
        with self.assertRaises(ValueError):
            acceptance.check(self.repo, self.inputs, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.sentinel.read_bytes(), sentinel)
        self.assertIn(b"exit 9", self.inputs[2].read_bytes())
        self.assertEqual(marker.read_bytes(), b"captured\n")

    def test_bundle_substitution_before_extraction_uses_prior_cut(self):
        old_identity = acceptance.read_file(self.inputs[0])
        real_run = subprocess.run
        consumed = []
        def replace_original(command, **kwargs):
            self.inputs[0].write_bytes(b"substituted-not-an-archive")
            result = real_run(command, **kwargs)
            staged_receipt = acceptance.load_record(Path(command[-1]) / "receipt.json")
            consumed.append(staged_receipt["inputs"]["bundle.tar.zst"])
            return result
        with patch.object(acceptance.subprocess, "run", side_effect=replace_original):
            with self.assertRaises(ValueError):
                acceptance.check(self.repo, self.inputs, self.output)
        self.assertEqual(consumed, [old_identity])
        self.assertFalse(self.output.exists())
        self.assertEqual(self.sentinel.read_bytes(), b"retain\n")

    def test_failed_retest_preserves_existing_green(self):
        acceptance.check(self.repo, self.inputs, self.output)
        self.remember_receipt()
        (self.repo / "data/distribution/check-native-development.sh").write_bytes(b"#!/bin/sh\nexit 7\n")
        self.unchanged(lambda: acceptance.check(self.repo, self.inputs, self.output))


if __name__ == "__main__":
    if "--require-capture" in sys.argv[1:] and not (
            sys.platform == "linux" and os.geteuid() == 0 and shutil.which("zstd")):
        sys.exit("capture fixtures require Linux root and zstd; refusing a skipped CI gate")
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    print("scope=isolated-native-acceptance-binding-fixtures-only")
    print(f"tests={result.testsRun} skipped={len(result.skipped)}")
    print("fixture.sha256=" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    print("policy.helper.sha256=" + hashlib.sha256((HERE / "native-bundle-acceptance.py").read_bytes()).hexdigest())
    print("fixture.receipts=" + json.dumps(CAPTURED_RECEIPTS, sort_keys=True))
    sys.exit(0 if result.wasSuccessful() else 1)
