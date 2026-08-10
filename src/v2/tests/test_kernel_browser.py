"""Browser protocol over the existing Linux machine-step runtime."""

import base64
import json
import unittest

from kernel import browser
from tests.test_linuxhost import nccc_time_module


class TestBrowserLinuxSession(unittest.TestCase):
    def tearDown(self):
        for handle, session in enumerate(browser._SESSIONS):
            if session is not None:
                browser.release(handle)

    def test_clock_is_one_explicit_browser_event(self):
        handle = browser.boot_bytes(nccc_time_module(), entry='main')

        waiting = json.loads(browser.step(handle))
        self.assertEqual(waiting['event']['operation'], 'clock')
        self.assertFalse(waiting['state']['stopped'])

        done = json.loads(browser.step(handle, {
            'operation': 'clock', 'coordinate': [], 'data': 123456,
        }))
        self.assertIsNone(done['event'])
        self.assertTrue(done['state']['stopped'])
        self.assertEqual(done['state']['result'], 123456)
        self.assertGreater(done['state']['physical_pages'], 0)

    def test_root_image_is_supplied_by_direct_page_coordinate(self):
        module = nccc_time_module(6, 2, (0, 4090, 512, 24))
        handle = browser.boot_bytes(module, rootfs_bytes=8192, entry='main')

        first = json.loads(browser.step(handle))
        self.assertEqual(first['event']['coordinate'], [0, 0])
        second = json.loads(browser.step(handle, {
            'operation': 'block_read',
            'coordinate': [0, 0],
            'data_base64': base64.b64encode(bytes(4096)).decode('ascii'),
        }))
        self.assertEqual(second['event']['coordinate'], [0, 1])

        page = bytes((index & 255) for index in range(4096))
        done = json.loads(browser.step(handle, {
            'operation': 'block_read',
            'coordinate': [0, 1],
            'data_base64': base64.b64encode(page).decode('ascii'),
        }))
        self.assertIsNone(done['event'])
        self.assertTrue(done['state']['stopped'])

    def test_release_drops_the_retained_machine(self):
        handle = browser.boot_bytes(nccc_time_module(), entry='main')
        self.assertTrue(json.loads(browser.release(handle))['ok'])
        with self.assertRaisesRegex(ValueError, 'not live'):
            browser.layout(handle)


if __name__ == '__main__':
    unittest.main()
