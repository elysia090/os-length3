"""Dependency-wave execution between exact WebAssembly barriers."""

import base64
from dataclasses import replace
import json
import unittest

from qm.wasmstate import decode_module, run_until_boundary, start_state
from qm.wasmcodec import (decode_plan, execute_mapped, pack, unpack,
                          WaveCodecError)
from qm.wasmwave import WaveExecutor, execute_slice, is_barrier
from tests.test_wasmbinary import module


class TestWaveExecutor(unittest.TestCase):
    def test_independent_integer_lanes_execute_in_the_same_wave(self):
        # (x & 255) + (x ^ 85): AND and XOR are independent, ADD joins them.
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        state = start_state(decoded, 'f', (0x1234,))

        plan = executor.plan(state.frames[-1])
        self.assertEqual(plan.waves.wave(1), (1, 2))
        self.assertEqual(plan.waves.wave(2), (3,))
        self.assertEqual(plan.layout()['max_parallel_width'], 2)

        state, cost = executor.step(state)
        self.assertEqual(state.frames[-1].pc, len(decoded.functions[0].code) - 1)
        self.assertEqual(state.frames[-1].stack,
                         (((0x1234 & 0xff) + (0x1234 ^ 0x55)) & 0xffffffff,))
        self.assertEqual(cost.layout(), {
            'wasm_instructions': 7,
            'work': 3,
            'span': 2,
            'pure_slices': 1,
            'barriers': 0,
            'max_parallel_width': 2,
        })

    def test_slice_codec_is_segmented_mmap_data(self):
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0x1234,))
        plan = WaveExecutor(decoded).plan(initial.frames[-1])

        blob = pack(plan)
        mapped = unpack(memoryview(blob))
        self.assertIs(mapped.data.obj, blob)
        self.assertEqual(mapped.wave(1), (1, 2))
        self.assertEqual(mapped.wave(2), (3,))
        self.assertEqual(mapped.layout()['slice_region'], [0, 7])
        self.assertEqual(mapped.layout()['wave_widths'], [2, 1])
        self.assertTrue(all(column['offset'] % 8 == 0
                            for column in mapped.layout()['columns'].values()))

        restored = decode_plan(mapped)
        self.assertEqual(restored.layout(), plan.layout())
        self.assertEqual(execute_slice(restored, initial),
                         execute_slice(plan, initial))
        self.assertEqual(execute_mapped(mapped, initial),
                         execute_slice(plan, initial))

    def test_slice_codec_rejects_a_second_encoding(self):
        body = b'\x00\x20\x00\x41\x01\x6a\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (2,))
        blob = bytearray(pack(WaveExecutor(decoded).plan(initial.frames[-1])))
        blob.extend(b'\0')
        with self.assertRaises(WaveCodecError):
            unpack(blob)

    def test_slice_codec_preserves_dropped_input_stack_extent(self):
        body = b'\x00\x1a\x1a\x41\x01\x0b'
        decoded = decode_module(module(body, kind=0x7f))
        initial = start_state(decoded, 'f', (0,))
        frame = replace(initial.frames[-1], stack=(23, 41))
        plan = WaveExecutor(decoded).plan(frame)

        self.assertEqual(plan.stack_inputs, 2)
        self.assertEqual([(value.kind, value.value) for value in plan.stack],
                         [('const', 1)])
        self.assertEqual(unpack(pack(plan)).stack_inputs, 2)

    def test_local_writes_are_renamed_and_committed_at_slice_end(self):
        # local 1 = x + 1; return x * 2 + local 1.
        body = (b'\x01\x01\x7f\x20\x00\x41\x01\x6a\x21\x01'
                b'\x20\x00\x41\x02\x6c\x20\x01\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        executor = WaveExecutor(decoded)
        initial = start_state(decoded, 'f', (7,))
        plan = executor.plan(initial.frames[-1])
        self.assertEqual(plan.waves.wave(1), (1, 2))
        self.assertEqual(plan.waves.wave(2), (3,))

        final, report = executor.run_with_report(initial)
        self.assertEqual(final.result, (22,))
        self.assertTrue(final.halted)
        self.assertEqual(report.barriers, 1)  # function end

    def test_load_store_call_and_branches_are_ordered_barriers(self):
        for op in ('i32.load', 'i64.store', 'call', 'call_indirect',
                   'br', 'br_if', 'br_table', 'return', 'if', 'loop', 'end',
                   'global.get', 'memory.grow'):
            with self.subTest(op=op):
                self.assertTrue(is_barrier(op))

    def test_default_runner_uses_the_wave_executor_without_changing_results(self):
        body = (b'\x00\x20\x00\x41\xff\x01\x71'
                b'\x20\x00\x41\xd5\x00\x73\x6a\x0b')
        decoded = decode_module(module(body, kind=0x7f))
        final = run_until_boundary(decoded, start_state(decoded, 'f', (9,)))
        self.assertEqual(final.result, ((9 & 255) + (9 ^ 0x55),))

    def test_shipped_vm_wasm_runs_through_pure_slices_and_barriers(self):
        with open('web/vm.wasm', 'rb') as handle:
            decoded = decode_module(handle.read())
        executor = WaveExecutor(decoded)
        final, report = executor.run_with_report(
            start_state(decoded, 'vm_load', (0,)))
        self.assertEqual(final.result, (0,))
        self.assertGreater(report.slices, 0)
        self.assertGreater(report.work, 0)
        self.assertGreater(report.barriers, 0)
        self.assertEqual(executor.total_cost, report)

    def test_state_frontend_supplies_zeroes_for_clang_style_entry_params(self):
        from qm.browser import stateful_wasm
        # Exported f(a, b) stands in for Clang's wasm main(argc, argv) ABI.
        body = b'\x00\x20\x00\x20\x01\x6a\x0b'
        raw = module(body, kind=0x7f, parameter_count=2)
        report = json.loads(stateful_wasm(
            base64.b64encode(raw).decode('ascii'), 'f',
            '{"state_max_states": 8}',
        ))
        self.assertTrue(report['ok'], report.get('error'))
        self.assertEqual(report['initial_observation'][2], [0])
        self.assertGreater(report['execution_layout']['pure_slices'], 0)
        self.assertIn('call', report['ordered_barriers'])


if __name__ == '__main__':
    unittest.main()
