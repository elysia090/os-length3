"""next.py's pins: one that is fetched and is its digest is checked; one that is another file, or cannot be had, is
said and fails the run; a newest release not looked up or not taken is said and does not."""
import contextlib
import hashlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ricebox_next', Path(__file__).with_name('next.py'))
nxt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nxt)

GOOD, NEWER = b'the archive pinned', b'the archive after it'
sha = lambda data: hashlib.sha256(data).hexdigest()


def run(newest, served, digest=sha(GOOD)):
    """The table and how the run ends, for one pin (ONE 1.0) whose makers' newest is `newest()` and whose site
    serves `served` (a URL to its bytes: a URL not in it cannot be had)."""
    def get(url, binary=False):
        if url not in served:
            raise RuntimeError(f'{url}: curl: (22) The requested URL returned error: 404')
        if isinstance(served[url], Exception):
            raise served[url]
        return served[url]
    with tempfile.TemporaryDirectory() as folder:
        pins = Path(folder, 'pins', 'sources.env')
        pins.parent.mkdir()
        pins.write_text(f'# a pin\nONE_VERSION=1.0\nONE_URL=https://site/one-1.0.tar\nONE_SHA256={digest}\n')
        out, before = io.StringIO(), os.getcwd()
        os.chdir(folder)
        try:
            with patch.object(nxt, 'get', get), patch.dict(nxt.NEWEST, {'ONE': newest}, clear=True), \
                 patch.object(sys, 'argv', ['next.py', str(pins)]), contextlib.redirect_stdout(out):
                try:
                    nxt.main()
                    code = 0
                except SystemExit as e:
                    code = e.code
            proposed = Path(folder, 'sources.env.next').read_text()
        finally:
            os.chdir(before)
    return out.getvalue(), code, proposed


def fails():
    raise RuntimeError('its listing is away')


class Pins(unittest.TestCase):
    def test_a_pin_fetched_and_its_digest_is_checked(self):
        table, code, proposed = run(lambda: '1.0', {'https://site/one-1.0.tar': GOOD})
        self.assertIn('pin checked', table)
        self.assertIn('0 pins broken, 0 pins not reached, 0 whose newest is not known', table)
        self.assertEqual(code, 0)
        self.assertIn(f'ONE_SHA256={sha(GOOD)}', proposed)

    def test_a_pin_that_is_not_there_fails_the_run(self):
        table, code, _ = run(lambda: '1.0', {})
        self.assertIn('PIN NOT REACHED: https://site/one-1.0.tar', table)
        self.assertNotIn('pin checked', table)
        self.assertIn('1 pins not reached', table)
        self.assertEqual(code, 1)

    def test_a_connection_cut_fails_the_run(self):
        table, code, _ = run(lambda: '1.0', {'https://site/one-1.0.tar': RuntimeError('curl: (18) transfer closed with 9 bytes remaining')})
        self.assertIn('PIN NOT REACHED', table)
        self.assertEqual(code, 1)

    def test_a_pin_that_is_another_file_fails_the_run(self):
        table, code, _ = run(lambda: '1.0', {'https://site/one-1.0.tar': b'another file'})
        self.assertIn('PIN BROKEN: https://site/one-1.0.tar is not its SHA256', table)
        self.assertIn('1 pins broken, 0 pins not reached', table)
        self.assertEqual(code, 1)

    def test_a_newest_not_looked_up_is_said_and_the_pin_still_checked(self):
        table, code, _ = run(fails, {'https://site/one-1.0.tar': GOOD})
        self.assertIn('RuntimeError: its listing is away; pin checked', table)
        self.assertIn('1 whose newest is not known', table)
        self.assertEqual(code, 0)

    def test_a_newest_not_looked_up_over_a_pin_not_there_fails_the_run(self):
        table, code, _ = run(fails, {})
        self.assertIn('its listing is away; PIN NOT REACHED', table)
        self.assertEqual(code, 1)

    def test_a_newer_release_is_proposed_with_its_digest(self):
        table, code, proposed = run(lambda: '1.1', {'https://site/one-1.1.tar': NEWER})
        self.assertIn('1 newer, 0 pins broken', table)
        self.assertEqual(code, 0)
        self.assertIn('ONE_VERSION=1.1\nONE_URL=https://site/one-1.1.tar\n' + f'ONE_SHA256={sha(NEWER)}', proposed)

    def test_a_newer_release_not_taken_keeps_the_pin_and_checks_it(self):
        table, code, proposed = run(lambda: '1.1', {'https://site/one-1.0.tar': GOOD})
        self.assertIn('newer not taken: https://site/one-1.1.tar', table)
        self.assertIn('pin checked', table)
        self.assertIn('0 newer, 0 pins broken, 0 pins not reached, 1 whose newest is not known', table)
        self.assertEqual(code, 0)
        self.assertIn('ONE_VERSION=1.0', proposed)

    def test_a_newer_release_not_taken_over_a_pin_not_there_fails_the_run(self):
        table, code, _ = run(lambda: '1.1', {})
        self.assertIn('PIN NOT REACHED', table)
        self.assertEqual(code, 1)


if __name__ == '__main__':
    unittest.main()
