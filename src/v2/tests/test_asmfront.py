"""Assembly as an input: x86 -> wasm, wasm -> x86, and back to itself.

SPEC §2 draws the arrow `optimized assembly -> Quotient Minimizer`. Once that
arrow exists, x86 -> wasm is not a translator: it is the ordinary pipeline with
an assembly frontend on one end and a wasm target on the other. These tests
hold it to the property that makes it worth anything — the round trip is a
fixed point, in both directions, on both machines.

The readers are deliberately partial. Each covers the integer subset a small
kernel compiles to, and refuses the rest by name; the last class here checks
that a refusal says what it could not read rather than guessing.
"""

import os
import unittest

from qm import isa as isa_mod
from qm.asmfront import (CFrontError, compile_function, detect, parse, wasm,
                         x86)
from qm.cfront.errors import UnsupportedC

from tests.support import EXAMPLES, example, read_example, solved as solve, target

# Examples with a small enough input to enumerate, which is what lets the
# reader be checked against the sequence rather than against a sample.  The
# wasm column is checked only where wasm has the instructions for it (no
# deposit, no carry-less multiply).
CASES = ['ranks8', 'inclusive_rank8', 'byte_mask8', 'ranks16_nibble',
         'morton_dilate16', 'morton_compact_even16', 'prefix_parity_mask8',
         'quote_state_before8', 'select8', 'shuffle_control8', 'run_ids8',
         'starts8', 'ends8', 'spread_high8', 'expand_nibbles8',
         'middle_bits_u16',
         # The whole-word half: a case analysis blended under a mask, and a
         # reduction lowered to a reciprocal multiply.  Both go through the
         # normalizer on the way out, so a fixed point here is also the
         # statement that normalizing twice changes nothing.
         'float_power2_bits', 'float_scale2_bits', 'rabin_karp_roll']

# 64-bit inputs: the round trip still has to be a fixed point, but the reader
# cannot be checked by enumeration.
SAMPLED_CASES = ['prefix_xor64', 'changes64', 'mask_from_spread',
                 'byte_mask_from_spread',
                 # Whole-word comparison, the idiom chains, and the halving
                 # tournament: the longest listing QM emits, and the one most
                 # sensitive to the register allocator repeating itself.
                 'is_less_or_equal_i32', 'min_i32', 'mod_add_u32',
                 'least_bit_mask_u64', 'round_up_pow2_u64',
                 'how_many_bits_i32', 'max_u8x8',
                 # The lane comparisons: eight AND/ADD/SUB/OR/XOR/NOT steps
                 # with no PDEP or CLMUL in them, which is a different path
                 # through both readers than anything above.
                 'zero_spread8', 'eq_spread8', 'lt_spread8', 'range_spread8']


def listings(name):
    """(x86 text, wasm text) for one example; either may be None."""
    result = solve(example(name), frontend='cfront')
    assert result['ok'], result.get('error')
    primary = target(result)
    w = target(result, 'wasm32')
    return (primary and primary.get('asm'),
            (w.get('asm') if w and w.get('ok') else None))


def table(function, bits):
    return [function(x) for x in range(1 << bits)]


class TestReadsItsOwnOutput(unittest.TestCase):
    """The listing has to mean what the C meant, or nothing below matters."""

    def test_x86_evaluates_to_the_same_function(self):
        for name in CASES:
            text, _ = listings(name)
            with self.subTest(example=name):
                self.assertIsNotNone(text, 'no x86 emitted for %s' % name)
                fn, dialect = parse(text)
                self.assertEqual(dialect, 'x86-64')
                bits = x86.declared_input_bits(text)
                self.assertIsNotNone(bits, 'the width annotation was not written')
                reference = solve(example(name), frontend='cfront')
                lowered = isa_mod.compile_seq(target(reference)['seq'])
                self.assertEqual(table(fn, bits), table(lowered, bits))

    def test_wasm_evaluates_to_the_same_function(self):
        checked = 0
        for name in CASES:
            _, text = listings(name)
            if text is None:
                continue          # wasm has no PDEP; nothing to read back
            checked += 1
            with self.subTest(example=name):
                fn, dialect = parse(text)
                self.assertEqual(dialect, 'wasm32')
                bits = wasm.declared_input_bits(text)
                self.assertIsNotNone(bits)
                reference = solve(example(name), frontend='cfront')
                lowered = isa_mod.compile_seq(target(reference, 'wasm32')['seq'])
                self.assertEqual(table(fn, bits), table(lowered, bits))
        self.assertTrue(checked, 'no example lowered to wasm at all')


class TestTheTwoEvaluationForms(unittest.TestCase):
    """Reading one input and sweeping a domain go through the same closures.

    Extracting semantics evaluates a listing on every point of the domain, so
    each instruction is resolved once and the sweep runs the resolved form. A
    reader whose two forms disagreed would mean the semantics QM analysed were
    not the semantics anyone could reproduce by hand.
    """

    def test_both_readers_agree_with_themselves(self):
        for name in ('ranks8', 'run_ids8', 'byte_mask8'):
            x86_text, wasm_text = listings(name)
            for text in (x86_text, wasm_text):
                if text is None:
                    continue
                function, dialect = parse(text)
                swept = compile_function(function)
                with self.subTest(example=name, dialect=dialect):
                    for x in range(256):
                        self.assertEqual(function(x), swept(x),
                                         'input 0x%X' % x)


class TestRoundTrip(unittest.TestCase):
    """x86 -> QM -> x86 and wasm -> QM -> wasm return the same listing.

    Text equality is the strong form on purpose. A weaker check — same
    instruction names, same constants — would pass even if the emitter had
    started renaming registers on every pass, and a fixed point that drifts is
    not a fixed point.
    """

    def test_x86_is_a_fixed_point(self):
        for name in CASES:
            text, _ = listings(name)
            with self.subTest(example=name):
                again = solve(text)
                self.assertTrue(again['ok'],
                                'QM cannot read its own x86: %s'
                                % (again.get('error') or {}).get('text'))
                self.assertEqual(target(again)['asm'], text)

    def test_wasm_is_a_fixed_point(self):
        for name in CASES:
            _, text = listings(name)
            if text is None:
                continue
            with self.subTest(example=name):
                again = solve(text)
                self.assertTrue(again['ok'],
                                'QM cannot read its own wasm: %s'
                                % (again.get('error') or {}).get('text'))
                self.assertEqual(target(again, 'wasm32')['asm'], text)

    def test_x86_in_wasm_out_and_wasm_in_x86_out_agree(self):
        """The cross arrows land where the C did, not merely somewhere."""
        crossed = 0
        for name in CASES:
            x86_text, wasm_text = listings(name)
            if wasm_text is None:
                continue
            crossed += 1
            with self.subTest(example=name):
                from_x86 = solve(x86_text)
                self.assertTrue(from_x86['ok'], from_x86.get('error'))
                self.assertEqual(target(from_x86, 'wasm32')['asm'], wasm_text)

                from_wasm = solve(wasm_text)
                self.assertTrue(from_wasm['ok'], from_wasm.get('error'))
                self.assertEqual(target(from_wasm)['asm'], x86_text)
        self.assertTrue(crossed, 'no example produced both listings')

    def test_a_sampled_domain_is_a_fixed_point_too(self):
        """A 64-bit input is probed, not enumerated — deterministically.

        If the probe set moved between runs the round trip would drift here and
        nowhere else, so this is the case that pins it down.
        """
        for name in SAMPLED_CASES:
            x86_text, wasm_text = listings(name)
            with self.subTest(example=name):
                self.assertIsNotNone(x86_text)
                again = solve(x86_text)
                self.assertTrue(again['ok'], again.get('error'))
                self.assertEqual(target(again)['asm'], x86_text)
                if wasm_text is not None:
                    self.assertEqual(target(again, 'wasm32')['asm'], wasm_text)

    def test_the_name_does_not_grow_a_suffix_each_pass(self):
        text, _ = listings('ranks8')
        self.assertIn('ranks8_qm', text)
        again = solve(text)
        self.assertNotIn('ranks8_qm_qm', target(again)['asm'])


class TestInputWidth(unittest.TestCase):
    """`%rdi` is 64 bits whatever the kernel meant, so the width is written."""

    def test_the_annotation_is_read_back(self):
        text, _ = listings('ranks8')
        result = solve(text)
        self.assertEqual(result['semantics']['input_bits'], 8)
        self.assertEqual(result['frontend']['compile']['input_width_via'],
                         'qm-input-bits annotation')

    def test_without_the_annotation_the_assumption_is_reported(self):
        text, _ = listings('ranks8')
        stripped = '\n'.join(line for line in text.splitlines()
                             if 'qm-input-bits' not in line)
        result = solve(stripped, options={'input_bits': 8})
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['compile']['input_width_via'],
                         'caller')
        self.assertIsNone(
            result['frontend']['compile']['declared_input_bits'])

    def test_a_caller_supplied_width_wins(self):
        text, _ = listings('ranks8')
        result = solve(text, options={'input_bits': 4})
        self.assertEqual(result['semantics']['input_bits'], 4)


class TestDetection(unittest.TestCase):
    """Sending C to an assembly reader would produce a useless error."""

    def test_c_is_not_mistaken_for_assembly(self):
        for name in sorted(os.listdir(EXAMPLES)):
            if not name.endswith(('.c', '.h')):
                continue
            with self.subTest(example=name):
                with open(os.path.join(EXAMPLES, name)) as handle:
                    self.assertIsNone(detect(handle.read()))

    def test_each_dialect_is_recognised(self):
        x86_text, wasm_text = listings('ranks8')
        self.assertEqual(detect(x86_text), 'x86-64')
        self.assertEqual(detect(wasm_text), 'wasm32')

    def test_prose_is_neither(self):
        self.assertIsNone(detect('this is not a program at all\n'))


class TestRefusals(unittest.TestCase):
    """A partial reader that guesses would produce a wrong semantics."""

    def test_an_unmodelled_x86_instruction_is_named(self):
        source = ('f:\n'
                  '    movq %rdi, %rax\n'
                  '    cpuid\n'
                  '    ret\n')
        fn, _ = parse(source)
        with self.assertRaises(UnsupportedC) as caught:
            fn(1)
        self.assertIn('cpuid', str(caught.exception))

    def test_a_branching_listing_is_refused(self):
        source = ('f:\n'
                  '    movq %rdi, %rax\n'
                  '.L1:\n'
                  '    ret\n')
        with self.assertRaises(UnsupportedC) as caught:
            parse(source)
        self.assertIn('straight-line', str(caught.exception))

    def test_an_unmodelled_wasm_instruction_is_named(self):
        source = ('(module\n'
                  '  (func $f (export "f") (param i64) (result i64)\n'
                  '    local.get 0\n'
                  '    i64.load\n'
                  '  )\n'
                  ')\n')
        fn, _ = parse(source)
        with self.assertRaises(UnsupportedC) as caught:
            fn(1)
        self.assertIn('i64.load', str(caught.exception))

    def test_a_folded_expression_says_what_to_paste_instead(self):
        source = ('(module (func $f (param i64) (result i64)\n'
                  '  (i64.mul (local.get 0) (i64.const 5))))\n')
        with self.assertRaises(UnsupportedC) as caught:
            parse(source)
        self.assertIn('flat', str(caught.exception.hint or ''))

    def test_a_two_parameter_wasm_function_is_refused(self):
        source = ('(module (func $f (param i64) (param i64) (result i64)\n'
                  '  local.get 0\n'
                  '))\n')
        with self.assertRaises(CFrontError):
            parse(source)


class TestClangStyleListing(unittest.TestCase):
    """Not only QM's own output: what a toolchain emits has to read too."""

    GCC_STYLE = '''\t.text
\t.globl\tdouble_it
\t.type\tdouble_it, @function
double_it:
\tmovq\t%rdi, %rax
\taddq\t%rax, %rax
\tret
\t.size\tdouble_it, .-double_it
'''

    CLANG_WASM_STYLE = '''\t.functype\tdouble_it (i64) -> (i64)
double_it:
\tlocal.get\t0
\ti64.const\t2
\ti64.mul
\tend_function
'''

    def test_gcc_style_x86(self):
        fn, dialect = parse(self.GCC_STYLE)
        self.assertEqual((dialect, fn.name), ('x86-64', 'double_it'))
        self.assertEqual([fn(x) for x in range(4)], [0, 2, 4, 6])

    def test_clang_style_wasm(self):
        fn, dialect = parse(self.CLANG_WASM_STYLE)
        self.assertEqual((dialect, fn.name), ('wasm32', 'double_it'))
        self.assertEqual([fn(x) for x in range(4)], [0, 2, 4, 6])

    def test_a_toolchain_listing_goes_through_the_pipeline(self):
        result = solve(self.GCC_STYLE, options={'input_bits': 8})
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['frontend']['listing'], 'x86-64')
        best = target(result)
        self.assertTrue(best['verification']['pass'])
        # x + x on 8 bits is a doubling, and QM lowers it to one instruction
        # rather than carrying the two the listing spelled.  Which family
        # expresses it — a linear map, or a multiply by two — is a tie between
        # two one-instruction answers, and not what this test is about.
        self.assertEqual(result['program']['core_ops'], 1)
        self.assertEqual(len(best['instructions']), 1)


class TestSeveralFunctionsInOneListing(unittest.TestCase):
    """A module of several functions is what `clang -S` actually emits.

    The reader used to stop at the first header, so a two-parameter helper at
    the top of a file hid every kernel below it — the same defect the C path
    had, in the other reader.
    """

    MODULE = '''(module
  (func $combine (param i64 i64) (result i64)
    local.get 0
    local.get 1
    i64.or
  )
  (func $double_it (export "double_it") (param i64) (result i64)
    local.get 0
    i64.const 2
    i64.mul
  )
)
'''

    def test_the_unary_function_is_read_past_a_binary_one(self):
        fn, dialect = parse(self.MODULE)
        self.assertEqual((dialect, fn.name), ('wasm32', 'double_it'))
        self.assertEqual([fn(x) for x in range(4)], [0, 2, 4, 6])

    def test_a_named_request_still_names_its_own_problem(self):
        with self.assertRaises(CFrontError) as caught:
            wasm.parse(self.MODULE, requested='combine')
        self.assertIn('combine takes 2 parameters', str(caught.exception))

    def test_a_request_for_something_absent_says_what_is_there(self):
        with self.assertRaises(CFrontError) as caught:
            wasm.parse(self.MODULE, requested='nope')
        self.assertIn('double_it', caught.exception.hint)

    def test_the_repeated_functype_clang_emits_is_one_function(self):
        # `clang -S` writes `.functype` twice, once in the preamble and once
        # under the label.  Read as two functions, the first is empty and the
        # reader would answer about a body that was never there.
        listing = ('\t.functype\tdouble_it (i64) -> (i64)\n'
                   'double_it:\n'
                   '\t.functype\tdouble_it (i64) -> (i64)\n'
                   '\tlocal.get\t0\n\ti64.const\t2\n\ti64.mul\n'
                   '\tend_function\n')
        fn, _ = parse(listing)
        self.assertEqual(fn.name, 'double_it')
        self.assertEqual([fn(x) for x in range(4)], [0, 2, 4, 6])

    def test_instructions_are_not_pooled_across_functions(self):
        fn, _ = parse(self.MODULE)
        # Reading the module used to concatenate every body it walked past.
        self.assertEqual([op for op, _ in fn.instructions],
                         ['local.get', 'i64.const', 'i64.mul'])


class TestListingExamples(unittest.TestCase):
    """The two pasteable listings in `examples/`, held to what they claim.

    Their comments tell the reader what will happen when they press Compile.
    If that stops being true the example is worse than no example, so it is
    checked here rather than trusted.
    """

    read = staticmethod(read_example)

    def test_the_x86_example_is_already_its_own_minimum(self):
        source = self.read('ranks8.s')
        result = solve(source)
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['semantics']['input_bits'], 8)
        best = target(result)
        self.assertEqual(best['instructions'], ['PDEP', 'IMUL'])
        # The header comment says minimizing it returns the same listing.
        self.assertIn(best['asm'], source)

    def test_the_wasm_example_collapses_where_pclmul_exists(self):
        source = self.read('prefix_xor64.wat')
        result = solve(source)
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['semantics']['input_bits'], 64)
        self.assertEqual(target(result)['instructions'], ['CLMUL'])
        # ...and stays six shift/XOR doublings on the machine it came from.
        self.assertEqual(target(result, 'wasm32')['instructions'],
                         ['SCANXOR'] * 6)
        self.assertIn(target(result, 'wasm32')['asm'], source)


if __name__ == '__main__':
    unittest.main()
