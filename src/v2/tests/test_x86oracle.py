"""Completeness fallback policy for x86-64 input."""

import unittest

from qm.x86oracle import (OracleError, available, function_name,
                          purity_issues)


class TestNativeOracleBoundary(unittest.TestCase):
    def test_function_selection_does_not_need_an_opcode_reader(self):
        source = '.globl crc\ncrc:\n  crc32q %rdi, %rax\n  ret\n'
        self.assertEqual(function_name(source), 'crc')

    def test_encoded_environment_observation_is_rejected_after_disassembly(self):
        disassembly = ('0000 <f>:\n'
                       '  0: 0f 31                 rdtsc\n'
                       '  2: 0f 05                 syscall\n')
        self.assertEqual(purity_issues(disassembly), ['rdtsc', 'syscall'])

    def test_a_missing_symbol_is_not_guessed(self):
        with self.assertRaises(OracleError):
            function_name('  movq %rdi, %rax\n')

    def test_windows_never_claims_to_have_the_linux_sandbox(self):
        import os
        if os.name != 'posix':
            self.assertFalse(available())


if __name__ == '__main__':
    unittest.main()
