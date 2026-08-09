"""Function-local QM rewrites only closed wasm integer expressions."""

import unittest

from qm.wasmbinary import (encode_uleb, optimize_module, section_layout,
                           strip_custom_sections)
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

    def test_custom_debug_sections_drop_without_changing_execution(self):
        raw = module(b'\x00\x20\x00\x42\x03\x7c\x0b')
        custom = (b'\x00' + encode_uleb(11)
                  + encode_uleb(5) + b'name!' + b'debug')
        decorated = raw + custom

        compact, removed = strip_custom_sections(decorated)

        self.assertEqual([item.name for item in removed], ['name!'])
        self.assertEqual(section_layout(decorated)['custom_section_bytes'], 13)
        self.assertEqual(section_layout(compact)['custom_section_bytes'], 0)
        for value in (0, 1, (1 << 64) - 1):
            self.assertEqual(call(decorated, value), call(compact, value))

    def test_selected_custom_metadata_can_be_retained(self):
        raw = module(b'\x00\x20\x00\x0b')
        name = b'target_features'
        payload = encode_uleb(len(name)) + name + b'features'
        decorated = raw + section(0, payload)

        compact, removed = strip_custom_sections(
            decorated, keep=('target_features',))

        self.assertEqual(compact, decorated)
        self.assertEqual(removed, ())

    def test_custom_ranges_are_skipped_from_a_view_without_source_copy(self):
        raw = module(b'\x00\x20\x00\x0b')
        custom = section(0, encode_uleb(5) + b'debug' + bytes(4096))
        source = memoryview(raw + custom)

        compact, removed = strip_custom_sections(source)

        self.assertIsInstance(compact, bytearray)
        self.assertEqual(compact, raw)
        self.assertEqual(sum(item.size for item in removed), len(custom))

    def test_no_replacement_reuses_the_single_semantic_buffer(self):
        # Memory is an observation boundary, so QM must keep this body and can
        # return the caller's already compact buffer without another copy.
        raw = bytearray(module(b'\x00\x20\x00\x28\x02\x00\x0b',
                               kind=0x7F, memory=True))

        optimized, report = optimize_module(raw)

        self.assertEqual(report['replaced'], 0)
        self.assertIs(optimized, raw)


if __name__ == '__main__':
    unittest.main()
