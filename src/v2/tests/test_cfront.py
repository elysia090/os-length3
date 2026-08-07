"""The C subset: parser, type model, and compiler/interpreter agreement.

The last test class is the important one.  `cfront/compile.py` exists purely for
speed, so it is only trustworthy while it agrees with `cfront/interp.py` over
whole domains.
"""

import unittest

from qm.cfront import CFrontError, Interpreter, compile_unit, parse


def evaluate_both(source, name, values):
    """Return (interpreted, compiled) output lists for the same inputs."""
    unit = parse(source)
    interp = Interpreter(unit)
    compiled = compile_unit(unit).function(name)
    return ([interp.call(name, [x])[0] for x in values],
            [compiled(x) for x in values])


class TestParser(unittest.TestCase):
    def test_signature_and_body(self):
        unit = parse('uint64_t f(uint8_t m) { return m; }')
        fn = unit.by_name('f')
        self.assertEqual(fn.signature(), 'uint64_t f(uint8_t m)')

    def test_object_like_macros_expand(self):
        source = '#define LANES 8\nuint32_t f(uint8_t m) { return LANES + m; }'
        _, compiled = evaluate_both(source, 'f', [1, 2])
        self.assertEqual(compiled, [9, 10])

    def test_function_like_macro_is_reported_not_ignored(self):
        with self.assertRaises(CFrontError) as ctx:
            parse('#define SQ(x) ((x)*(x))\nuint32_t f(uint8_t m){return SQ(m);}')
        self.assertIn('function-like macro', str(ctx.exception))

    def test_pointers_are_rejected_with_a_location(self):
        with self.assertRaises(CFrontError) as ctx:
            parse('uint32_t f(uint8_t *p) { return *p; }')
        self.assertIsNotNone(ctx.exception.line)

    def test_missing_function(self):
        with self.assertRaises(CFrontError):
            parse('int x = 3;')


class TestCSemantics(unittest.TestCase):
    def check(self, body, expect, param='uint8_t', ret='uint64_t', arg=0):
        source = '%s f(%s m) { %s }' % (ret, param, body)
        _, compiled = evaluate_both(source, 'f', [arg])
        self.assertEqual(compiled[0], expect)

    def test_unsigned_wraparound(self):
        self.check('uint8_t x = 250; x += 10; return x;', 4)

    def test_integer_promotion(self):
        # uint8_t promotes to int before the shift, so the result is 0xFF << 4
        # and not a truncated 8-bit 0xF0.
        self.check('return (uint64_t)(m << 4);', 0xFF << 4, arg=0xFF)

    def test_signed_shift_is_arithmetic(self):
        self.check('int32_t v = -16; return (uint64_t)(int64_t)(v >> 2);',
                   (-4) & 0xFFFFFFFFFFFFFFFF)

    def test_division_truncates_toward_zero(self):
        self.check('int32_t v = -7; return (uint64_t)(int64_t)(v / 2);',
                   (-3) & 0xFFFFFFFFFFFFFFFF)

    def test_shift_out_of_range_is_an_error_not_a_silent_mask(self):
        with self.assertRaises(CFrontError):
            self.check('uint32_t v = 1; return v << 32;', 0)

    def test_arrays_and_loops(self):
        self.check(
            'uint8_t t[4] = {1,2,3,4}; uint32_t s = 0;'
            'for (unsigned i = 0; i < 4; ++i) s += t[i];'
            'return s;', 10)

    def test_switch_with_fallthrough(self):
        self.check('switch (m) { case 1: case 2: return 20; default: return 7; }',
                   20, arg=2)

    def test_helper_functions(self):
        source = ('static uint32_t twice(uint32_t v) { return v * 2; }\n'
                  'uint64_t f(uint8_t m) { return twice(m) + 1; }')
        _, compiled = evaluate_both(source, 'f', [5])
        self.assertEqual(compiled[0], 11)

    def test_builtins(self):
        self.check('return __builtin_popcount(m);', 4, arg=0b1111)
        self.check('return __builtin_ctz(m);', 2, arg=0b100)
        self.check('return __builtin_bswap32(m);', 0xFF000000, arg=0xFF)

    def test_infinite_loop_hits_the_budget(self):
        with self.assertRaises(CFrontError):
            self.check('while (1) { m += 0; } return 0;', 0)


class TestCompilerMatchesInterpreter(unittest.TestCase):
    """The fast path must never disagree with the reference path."""

    KERNELS = {
        'ranks8': '''uint64_t f(uint8_t m) {
            uint64_t r = 0;
            for (unsigned i = 0; i < 8; ++i)
                r |= (uint64_t)__builtin_popcount(m & ((1u << i) - 1)) << (8 * i);
            return r; }''',
        'select8': '''uint64_t f(uint8_t m) {
            uint64_t r = 0; unsigned j = 0;
            for (unsigned i = 0; i < 8; ++i)
                if ((m >> i) & 1) { r |= (uint64_t)i << (8 * j); j++; }
            return r; }''',
        'mixed_signs': '''uint64_t f(uint8_t m) {
            int32_t a = (int32_t)m - 128;
            int32_t b = a < 0 ? -a : a;
            uint32_t c = (uint32_t)b * 3u;
            return (uint64_t)(c ^ (c >> 3)); }''',
        'array_state': '''uint64_t f(uint8_t m) {
            uint8_t hist[8] = {0};
            for (unsigned i = 0; i < 8; ++i) hist[i] = (m >> i) & 1;
            uint64_t r = 0;
            for (unsigned i = 1; i < 8; ++i) hist[i] += hist[i - 1];
            for (unsigned i = 0; i < 8; ++i) r |= (uint64_t)hist[i] << (8 * i);
            return r; }''',
        'do_while': '''uint64_t f(uint8_t m) {
            unsigned i = 0; uint64_t r = 0;
            do { r = r * 3 + ((m >> i) & 1); i++; } while (i < 8);
            return r; }''',
    }

    def test_all_kernels_agree_over_the_whole_domain(self):
        for name, source in self.KERNELS.items():
            with self.subTest(kernel=name):
                interpreted, compiled = evaluate_both(source, 'f', range(256))
                self.assertEqual(interpreted, compiled)

    def test_errors_agree_too(self):
        source = 'uint64_t f(uint8_t m) { uint32_t v = 1; return v << m; }'
        unit = parse(source)
        interp = Interpreter(unit)
        compiled = compile_unit(unit).function('f')
        with self.assertRaises(CFrontError):
            interp.call('f', [40])
        with self.assertRaises(CFrontError):
            compiled(40)


if __name__ == '__main__':
    unittest.main()
