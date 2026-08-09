"""The production vm.wasm is itself closed and minimized by QM."""

import contextlib
import io
import json
import os
import tempfile
import unittest

from qm import wasmvm
from qm.wasmstate import WasmStateError, decode_module, invoke
from vm import codec, image, machine, seed


def artifact(picture):
    return codec.pack(codec.code(image.serialize(picture)))


class TestWasmVmSelfQuotient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open('web/vm.wasm', 'rb') as handle:
            cls.module = decode_module(handle.read())
        cls.blob = artifact(seed.ECHO)
        cls.initial = wasmvm.load(cls.module, cls.blob)

    def test_loaded_wasm_agrees_with_the_python_vm(self):
        mode = invoke(self.module, self.initial.snapshot,
                      'vm_direct_byte_state')
        self.assertEqual(mode.result, (1,))
        reference = machine.Residual(seed.ECHO)
        self.assertEqual(wasmvm.read(self.module, self.initial),
                         machine.read(reference))
        for byte in range(256):
            with self.subTest(byte=byte):
                wasm_after = wasmvm.feed(self.module, self.initial, byte)
                py_after = machine.feed(reference, byte)
                self.assertEqual(wasmvm.read(self.module, wasm_after),
                                 machine.read(py_after))

    def test_qm_closes_the_loaded_vm_not_a_reimplemented_transition(self):
        quotient = wasmvm.compile_vm(self.module, self.initial,
                                     max_states=300)
        self.assertEqual(quotient.reachable_states, 256)
        self.assertEqual(quotient.classes, 256)
        report = quotient.to_dict()
        self.assertEqual(report['build_form']['storage_cells'], 5)
        self.assertEqual(
            report['build_form']['transitions']['unique_rows'], 1)
        for byte in (0, 1, 42, 127, 255):
            state, output = quotient.run([byte])
            self.assertEqual(output, byte)
            _next, next_output = quotient.run([17], state=state)
            self.assertEqual(next_output, 17)

    def test_a_nonmatching_artifact_stays_on_the_generic_vm(self):
        picture = image.Image(dict(seed.ECHO.memory), pc_out=3, pc_feed=15)
        initial = wasmvm.load(self.module, artifact(picture))
        mode = invoke(self.module, initial.snapshot, 'vm_direct_byte_state')
        self.assertEqual(mode.result, (0,))
        wasm_after = wasmvm.feed(self.module, initial, 7)
        python_after = machine.feed(machine.Residual(picture), 7)
        self.assertTrue(wasm_after.dead)
        self.assertTrue(python_after.dead)
        self.assertEqual(wasmvm.read(self.module, wasm_after),
                         machine.read(python_after))

    def test_the_direct_step_still_obeys_the_public_budget(self):
        limited = invoke(self.module, self.initial.snapshot,
                         'vm_set_budget', (0, 0))
        state = wasmvm.VmState(limited, self.initial.cells_address)
        with self.assertRaisesRegex(WasmStateError, 'exhausted'):
            wasmvm.feed(self.module, state, 7)
        exhausted = invoke(self.module, limited, 'vm_exhausted')
        # The getter above reads the pre-feed snapshot, so the original state
        # is unchanged; pure calls cannot leak the failed transition backward.
        self.assertEqual(exhausted.result, (0,))

    def test_the_cli_puts_vm_wasm_through_qm(self):
        from qm.cli import main
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'echo.qm')
            with open(path, 'wb') as handle:
                handle.write(self.blob)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(['web/vm.wasm', '--vm-artifact', path, '--json',
                             '--state-max-states', '300'])
        self.assertEqual(code, 0)
        report = json.loads(output.getvalue())
        self.assertTrue(report['exact'])
        self.assertEqual(report['state_step'], 'direct-byte-register')
        self.assertEqual(report['classes'], 256)


if __name__ == '__main__':
    unittest.main()
