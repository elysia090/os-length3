"""Function-local QM rewrites only closed wasm integer expressions."""

import unittest

from qm.wasmbinary import encode_uleb, optimize_module
from qm.wasmstate import decode_module, run_until_boundary, start_state


def section(kind, payload):
    return bytes([kind]) + encode_uleb(len(payload)) + payload


def module(body, kind=0x7E, memory=False, parameter_count=1):
    types = (b'\x01\x60' + encode_uleb(parameter_count)
             + bytes([kind]) * parameter_count + b'\x01' + bytes([kind]))
    functions = b'\x01\x00'
    exports = b'\x01\x01f\x00\x00'
    code = b'\x01' + encode_uleb(len(body)) + body
    memory_section = section(5, b'\x01\x00\x01') if memory else b''
    return (b'\x00asm\x01\x00\x00\x00'
            + section(1, types) + section(3, functions)
            + memory_section + section(7, exports) + section(10, code))


def call(raw, value):
    decoded = decode_module(raw)
    arguments = value if isinstance(value, tuple) else (value,)
    state = run_until_boundary(decoded, start_state(decoded, 'f', arguments))
    return state.result[0]


class TestLargeWasmFunctionOptimizer(unittest.TestCase):
    def test_whole_expression_substitution_combines_two_additions(self):
        # locals=0; get 0; i64.const 3; add; i64.const 4; add; end
        raw = module(b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        optimized, report = optimize_module(raw)
        self.assertEqual(report['replaced'], 1)
        self.assertEqual(report['physical_work'], 1)
        self.assertEqual(report['physical_span_sum'], 1)
        self.assertEqual(report['replacements'][0].before_ops,
                         ('ADD', 'ADD'))
        self.assertEqual(report['replacements'][0].after_ops, ('ADD',))
        self.assertLess(len(optimized), len(raw))
        for value in (0, 1, 0x1234, (1 << 64) - 1):
            self.assertEqual(call(raw, value), call(optimized, value))

    def test_a_memory_observation_is_preserved_byte_for_byte(self):
        # locals=0; get 0; i32.load align=2 offset=0; end
        raw = module(b'\x00\x20\x00\x28\x02\x00\x0b',
                     kind=0x7F, memory=True)
        optimized, report = optimize_module(raw)
        self.assertEqual(report['replaced'], 0)
        self.assertEqual(optimized, raw)

    def test_substitution_normalizes_an_expression_using_two_parameters(self):
        # (a + 3 + 4) xor b: the two additions become one without packing or
        # sampling the independent parameters.
        body = b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x20\x01\x85\x0b'
        raw = module(body, parameter_count=2)
        optimized, report = optimize_module(raw)
        self.assertEqual(report['replaced'], 1)
        self.assertLess(len(optimized), len(raw))
        for values in ((0, 0), (1, 2), (0x1234, 0x5678),
                       ((1 << 64) - 1, 9)):
            self.assertEqual(call(raw, values), call(optimized, values))

    def test_arithmetic_is_normalized_across_an_integer_comparison(self):
        # ((a & 255) & 15) == b. i32.eq remains an exact opaque node while its
        # bitwise input is substituted and normalized.
        body = b'\x00\x20\x00\x41\xff\x01\x71\x41\x0f\x71\x20\x01\x46\x0b'
        raw = module(body, kind=0x7F, parameter_count=2)
        optimized, report = optimize_module(raw)
        self.assertEqual(report['replaced'], 1)
        for values in ((0, 0), (1, 1), (0xffffffff, 15), (17, 99)):
            self.assertEqual(call(raw, values), call(optimized, values))


if __name__ == '__main__':
    unittest.main()
