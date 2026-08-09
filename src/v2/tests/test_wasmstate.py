"""The wasm binary frontend is a pure, clonable whole-program machine."""

import base64
import contextlib
import io
import json
import os
import tempfile
import unittest

from qm.transducer import StateLimit
from qm.wasmstate import (EOF, WasmStateError, compile_stream, decode_module,
                          observe, PagedMemory, run_until_boundary, start_state,
                          stream_initial, stream_step)


def _u(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _name(value):
    encoded = value.encode('utf-8')
    return _u(len(encoded)) + encoded


def _section(kind, payload):
    return bytes([kind]) + _u(len(payload)) + payload


def echo_driver():
    """A linked module with the same two imports as a compiled C main."""
    types = (b'\x03'
             b'\x60\x00\x01\x7f'
             b'\x60\x01\x7f\x00'
             b'\x60\x00\x01\x7f')
    imports = (b'\x02'
               + _name('env') + _name('qm_getchar') + b'\x00\x00'
               + _name('env') + _name('qm_putchar') + b'\x00\x01')
    functions = b'\x01\x02'
    exports = b'\x01' + _name('main') + b'\x00\x02'
    # getchar(); add 1; putchar(); return 7.
    expression = b'\x00\x10\x00\x41\x01\x6a\x10\x01\x41\x07\x0b'
    code = b'\x01' + _u(len(expression)) + expression
    return (b'\x00asm\x01\x00\x00\x00'
            + _section(1, types) + _section(2, imports)
            + _section(3, functions) + _section(7, exports)
            + _section(10, code))


class TestCompiledMainIsAStateStep(unittest.TestCase):
    def setUp(self):
        self.module = decode_module(echo_driver())

    def test_main_stops_at_input_and_resumes_from_the_same_snapshot(self):
        initial = stream_initial(self.module)
        self.assertEqual(initial.waiting.name, 'qm_getchar')
        self.assertEqual(observe(initial), (b'', False, ()))

        left = stream_step(self.module, initial, 40)
        right = stream_step(self.module, initial, 99)
        self.assertEqual(observe(left), (b')', True, (7,)))
        self.assertEqual(observe(right), (b'd', True, (7,)))
        self.assertEqual(observe(initial), (b'', False, ()))

    def test_eof_is_the_signed_minus_one_getchar_value(self):
        state = stream_step(self.module, stream_initial(self.module), EOF)
        self.assertEqual(state.output, b'\x00')

    def test_the_exact_future_quotient_includes_a_quiet_terminal(self):
        compiled = compile_stream(self.module, alphabet=(0, 1, EOF),
                                  max_states=8)
        self.assertEqual(compiled.reachable_states, 5)
        self.assertEqual(compiled.classes, 5)
        state, output = compiled.run([1])
        self.assertEqual(output, (b'\x02', True, (7,)))
        _state, quiet = compiled.run([1, 0])
        self.assertEqual(quiet, (b'', True, (7,)))

    def test_state_limit_is_a_refusal_not_a_bounded_proof(self):
        with self.assertRaises(StateLimit):
            compile_stream(self.module, alphabet=range(16), max_states=4)

    def test_the_browser_entry_takes_the_linked_wasm_not_c_syntax(self):
        from qm.browser import stateful_wasm
        encoded = base64.b64encode(echo_driver()).decode('ascii')
        report = json.loads(stateful_wasm(
            encoded, 'main', '{"state_max_states": 300}'))
        self.assertTrue(report['ok'], report.get('error'))
        # The public browser alphabet includes all bytes and EOF. Each emitted
        # byte is a distinct Moore state, followed by one quiet terminal.
        # EOF and byte 255 both wrap to output zero in this particular driver.
        self.assertEqual(report['reachable_states'], 258)
        self.assertEqual(report['classes'], 258)
        self.assertEqual(report['state_bits'], 9)

    def test_the_cli_accepts_a_linked_wasm_main(self):
        from qm.cli import main
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'driver.wasm')
            with open(path, 'wb') as handle:
                handle.write(echo_driver())
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main([path, '--state-main', '--state-max-states', '300'])
        self.assertEqual(code, 0)
        self.assertIn('reachable states 258', output.getvalue())


class TestPersistentLinearMemory(unittest.TestCase):
    def test_a_store_shares_all_unchanged_pages(self):
        original = PagedMemory(bytes(2 * 65536))
        changed = original.write(255, b'abc')
        self.assertEqual(original.read(252, 8), bytes(8))
        self.assertEqual(changed.read(252, 8), b'\0\0\0abc\0\0')
        self.assertEqual([index for index, _page in changed.pages], [0, 1])
        self.assertIs(changed.base, original.base)

    def test_memory_growth_keeps_the_old_snapshot(self):
        original = PagedMemory(bytes(65536)).write(7, b'x')
        grown = original.grow(2)
        self.assertEqual(len(original), 65536)
        self.assertEqual(len(grown), 3 * 65536)
        self.assertEqual(grown.read(7, 1), b'x')
        self.assertEqual(grown.read(2 * 65536, 4), bytes(4))


class TestProductionVmBinary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open('web/vm.wasm', 'rb') as handle:
            cls.module = decode_module(handle.read())

    def call(self, name, *args):
        state = start_state(self.module, name, args)
        state = run_until_boundary(self.module, state)
        self.assertTrue(state.halted)
        return state.result

    def test_reserved_linear_memory_is_demand_zero(self):
        memory = self.module.memory
        resident = len(memory.base) + sum(len(page) for _index, page in memory.pages)
        self.assertEqual(len(memory), 32 * 1024 * 1024)
        self.assertLessEqual(resident, 256)
        self.assertEqual(memory.read(2 * 1024 * 1024, 16), bytes(16))

    def test_the_lightweight_machine_reads_the_shipped_vm(self):
        buffer_address = self.call('vm_buffer')[0]
        cells_address = self.call('vm_cells')[0]
        self.assertGreaterEqual(buffer_address, 0)
        self.assertLessEqual(buffer_address + (1 << 20),
                             len(self.module.memory))
        self.assertGreaterEqual(cells_address, 0)
        self.assertLessEqual(cells_address + (1 << 23),
                             len(self.module.memory))
        self.assertEqual(self.call('vm_steps_low'), (0,))
        self.assertEqual(self.call('vm_load', 0), (0,))
        self.assertEqual(self.call('vm_feed', 42), (0,))

    def test_wrong_magic_is_rejected(self):
        with self.assertRaises(WasmStateError):
            decode_module(b'not wasm')


if __name__ == '__main__':
    unittest.main()
