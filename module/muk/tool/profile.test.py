import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("muk_profile", Path(__file__).with_name("profile.py"))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)

class Ownership(unittest.TestCase):
    def test_recycled_guest_pid_is_closed_before_cleanup_can_signal_it(self):
        box = object.__new__(profile.Box)
        box.process, box.pidfds = SimpleNamespace(pid=10), []
        original = {"pid":11,"ppid":10,"start":"100","state":"S"}
        replacement = {**original,"ppid":99,"start":"101"}
        with patch.object(profile,"descendants",return_value=[original]), patch.object(profile,"stamp",side_effect=[replacement,None]), patch.object(profile,"pss",return_value={}), patch.object(profile.os,"pidfd_open",return_value=88), patch.object(profile.os,"close") as close:
            box.observe()
            self.assertEqual(box.pidfds,[])
            close.assert_called_once_with(88)

    def test_pidfd_failure_rolls_back_only_the_owned_process_group(self):
        process=SimpleNamespace(pid=10,stdin=Mock(),stdout=Mock(),stderr=Mock(),wait=Mock())
        with patch.object(profile.subprocess,"Popen",return_value=process), patch.object(profile.os,"pidfd_open",side_effect=OSError("injected")), patch.object(profile.os,"killpg") as kill:
            with self.assertRaisesRegex(OSError,"injected"):
                profile.Box(Path("muk"),Path("bundle"),1,None)
            kill.assert_called_once_with(10,profile.signal.SIGKILL)
            process.wait.assert_called_once_with(timeout=1)
            for stream in (process.stdin,process.stdout,process.stderr): stream.close.assert_called_once()

if __name__ == "__main__": unittest.main()
