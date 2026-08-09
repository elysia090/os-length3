"""The browser boundary.

These tests drive exactly what `web/worker.js` drives — `plan` then `finish` —
and they use the native Clang toolchain to stand in for clang.wasm.  The
compiler and the execution model differ between the two paths; the protocol
does not, so a break here is a break in the browser.
"""

import json
import os
import re
import subprocess
import tempfile
import unittest

from qm.browser import (artifact, capabilities, evaluate, fallback, finish,
                        plan, prepare, prepare_run, prepare_state)
from qm.clang import NATIVE, read_signature

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'web', 'qm-manifest.json')

SOURCE = '''#include <stdint.h>
uint64_t ranks8(uint8_t m)
{
    uint64_t r = 0;
    for (unsigned i = 0; i < 8; ++i)
        r |= (uint64_t)__builtin_popcount(m & ((1u << i) - 1)) << (8 * i);
    return r;
}
'''

LOOKUP = '''#include <stdint.h>
uint32_t lookup(uint8_t x)
{
    switch (x & 7) {
    case 0: return 19;
    case 1: return 3;
    case 2: return 41;
    case 3: return 7;
    case 4: return 23;
    case 5: return 11;
    case 6: return 29;
    default: return 5;
    }
}
'''


class TestPreparedSource(unittest.TestCase):
    """What Clang is handed, and who decides it.

    The worker used to pass its raw text straight to clang.wasm, so the
    freestanding prelude and the intrinsic definitions in `clang.py` applied on
    the native path and nowhere else. `#include <immintrin.h>` reached a wasm32
    compile — where it declares nothing — and QM's own emitted `_pdep_u64` came
    back as an undeclared function. The Python was right the whole time; the
    wiring was not, which is why this checks both.
    """

    EMITTED = '''#include <stdint.h>
#include <immintrin.h>

uint64_t ranks8_qm(uint8_t x)
{
    uint64_t t1 = _pdep_u64((uint64_t)x, 0x0101010101010101ull);
    uint64_t t2 = t1 * 0x0101010101010100ull;
    return (uint64_t)t2;
}
'''

    def test_includes_go_and_the_intrinsic_arrives(self):
        prepared = prepare(self.EMITTED)
        self.assertNotIn('#include', prepared)
        self.assertIn('uint64_t;', prepared)          # the freestanding prelude
        self.assertIn('_pdep_u64(unsigned long long', prepared)
        self.assertNotIn('_pext_u64(unsigned', prepared)   # only what is used

    def test_a_paste_that_brings_its_own_keeps_it(self):
        own = ('unsigned long long _pdep_u64(unsigned long long v,'
               ' unsigned long long m) { return v & m; }\n'
               'unsigned long long f(unsigned char x)'
               ' { return _pdep_u64(x, 3ull); }\n')
        self.assertEqual(prepare(own).count('_pdep_u64(unsigned long long v'), 1)

    @unittest.skipUnless(NATIVE.available(), 'no native Clang')
    def test_it_compiles_where_the_browser_compiles(self):
        prepared = prepare(self.EMITTED)
        for machine in ('wasm32', 'x86_64-unknown-linux-gnu'):
            with self.subTest(target=machine):
                with tempfile.TemporaryDirectory() as tmp:
                    src = os.path.join(tmp, 'in.c')
                    with open(src, 'w') as handle:
                        handle.write(prepared)
                    built = subprocess.run(
                        [NATIVE.binary, '--target=%s' % machine, '-std=gnu11',
                         '-ffreestanding', '-O2', '-nostdlib', '-c', src,
                         '-o', os.path.join(tmp, 'out.o')],
                        capture_output=True, text=True)
                    self.assertEqual(built.returncode, 0, built.stderr)

    def test_the_worker_compiles_the_prepared_text(self):
        """The bug was here, not in Python: the worker never called it."""
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            worker = handle.read()
        self.assertIn("callPython('prepare'", worker)
        kernel_compile = worker.split('async function compileWithClang')[1]
        kernel_compile = kernel_compile.split('// Running the paste')[0]
        for call in re.findall(r'clang\.(?:assembly|wasm)\(\s*(\w+)',
                               kernel_compile):
            self.assertEqual(call, 'prepared',
                             'clang is being handed %r rather than the '
                             'prepared source' % call)
        self.assertIn("const driver = callPython('prepare_run'", worker)
        self.assertIn('clang.wasm(driver', worker)

    def test_the_default_compiler_enters_the_core_directly(self):
        with open(os.path.join(ROOT, 'web', 'clang.js')) as handle:
            clang = handle.read()
        self.assertIn("./drivers/compiler-core.js", clang)
        self.assertNotIn(
            "DEFAULT_DRIVER = new URL('./drivers/yowasp-clang.js'", clang)
        with open(os.path.join(ROOT, 'web', 'drivers',
                               'compiler-core.js')) as handle:
            driver = handle.read()
        self.assertIn("'llvm.core.wasm'", driver)
        self.assertIn("'llvm-resources.tar'", driver)
        self.assertIn('WebAssembly.compile(coreBytes)', driver)
        self.assertNotIn("from '@yowasp/clang'", driver)
        self.assertNotIn('bundle.js', driver)

    def test_cold_start_warms_the_independent_wasm_runtimes_in_parallel(self):
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            worker = handle.read()
        boot = worker.split('async function boot(config) {', 1)[1]
        boot = boot.split('\n}', 1)[0]
        compiler = boot.index('const compilerWarm = clang.load(progress)')
        vm = boot.index('const vmWarm = loadVm()')
        python = boot.index('const pythonWarm = loadPyodide_()')
        wait = boot.index('await Promise.all([compilerWarm, vmWarm])')
        self.assertLess(max(compiler, vm, python), wait)
        self.assertNotIn('await clang.load(progress)', boot[:wait])
        self.assertNotIn('await loadVm()', boot[:wait])

    def test_run_replaces_only_the_selected_function(self):
        source = '''#include <stdint.h>
uint64_t kernel(uint8_t x) { return (uint64_t)x + 1; }
static uint64_t bias = 4;
uint64_t helper(uint8_t a, uint8_t b) { return kernel(a) + b + bias; }
int main(void) { return (int)helper(1, 2); }
'''
        prepared = prepare_run(source)
        self.assertIn('extern uint64_t kernel(uint8_t);', prepared)
        self.assertNotIn('return (uint64_t)x + 1', prepared)
        self.assertIn('static uint64_t bias = 4', prepared)
        self.assertIn('uint64_t helper(uint8_t a, uint8_t b)', prepared)
        self.assertIn('int main(void)', prepared)

    def test_state_analysis_compiles_the_complete_unit(self):
        source = '''#include <stdint.h>
uint64_t kernel(uint8_t x) { return (uint64_t)x + 1; }
int main(void) { return (int)kernel((uint8_t)getchar()); }
'''
        prepared = prepare_state(source)
        self.assertIn('uint64_t kernel(uint8_t x)', prepared)
        self.assertIn('int main(void)', prepared)
        self.assertIn('static int getchar(void)', prepared)


class TestRunTheMinimizedProgram(unittest.TestCase):
    """The page could show a program and not try it.

    The lowered sequence is a live object that `to_json_safe` strips at the
    worker boundary, and the wasm listing is text rather than a module, so the
    only side that can still run the answer is the one that built it.
    """

    def solved(self, name):
        from tests.support import read_example
        result = json.loads(fallback(read_example(name), '{}'))
        self.assertTrue(result['ok'], result.get('error'))

    def test_it_runs_the_program_it_just_built(self):
        self.solved('ranks8.c')
        out = json.loads(evaluate('', '5'))
        self.assertTrue(out['ok'], out.get('error'))
        # ranks8(0b101): exclusive prefix popcounts, one per byte lane.
        expected = sum(bin(5 & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))
        self.assertEqual(int(out['output']), expected)

    def test_a_64_bit_answer_survives_as_a_string(self):
        self.solved('range_spread8.c')
        out = json.loads(evaluate('', '0x3030303030303030'))
        self.assertTrue(out['ok'], out.get('error'))
        # Every lane is an ASCII zero, so every lane flag is set.  As a JSON
        # number this value would come back rounded.
        self.assertEqual(out['output'], str(0x8080808080808080))
        self.assertTrue(isinstance(out['output'], str))

    def test_hex_and_decimal_are_both_accepted(self):
        self.solved('ranks8.c')
        self.assertEqual(json.loads(evaluate('', '0x0A'))['output'],
                         json.loads(evaluate('', '10'))['output'])

    def test_an_input_too_wide_for_the_kernel_is_refused(self):
        self.solved('ranks8.c')
        out = json.loads(evaluate('', '256'))
        self.assertFalse(out['ok'])
        self.assertIn('8 bits', out['error'])

    def test_the_target_being_viewed_does_not_change_the_answer(self):
        """One artifact per solve, not one per target.

        The artifact always comes from the minimized wasm32 sequence, so the
        target currently displayed cannot change what Run executes.
        """
        self.solved('ranks8.c')
        answers = [json.loads(evaluate(name, '5'))
                   for name in ('', 'codec', 'x86-64-bmi2-pclmul', 'x86-64',
                                'wasm32', 'no-such-target')]
        for out in answers:
            self.assertTrue(out['ok'], out.get('error'))
            self.assertEqual(out['target'], 'codec')
        self.assertEqual({out['output'] for out in answers},
                         {answers[0]['output']})
        self.assertEqual({out['artifact_bytes'] for out in answers},
                         {answers[0]['artifact_bytes']})

    def test_the_codec_is_one_of_the_targets_you_can_look_at(self):
        from tests.support import read_example
        result = json.loads(fallback(read_example('ranks8.c'), '{}'))
        codec = next((t for t in result['targets'] if t['name'] == 'codec'),
                     None)
        self.assertIsNotNone(codec, 'the codec is not in the target list')
        self.assertTrue(codec['ok'])
        self.assertEqual(codec['instructions'], ['ROW'])
        # Physical run quantities, not the instruction count: span is one per
        # transition and work is that plus the incidences each write repairs,
        # so work exceeds span exactly when some write had rows reading it.
        self.assertGreater(codec['work'], codec['span'])
        self.assertGreater(codec['quiet'], 0)
        # The view is the codeword first and the decode after it.
        self.assertIn('pack(code(z))', codec['asm'])
        self.assertLess(codec['asm'].index('00000000  '),
                        codec['asm'].index('subleq'))
        self.assertIn('qm-input-bits: 8', codec['asm'])
        self.assertEqual(codec['L_bytes'],
                         json.loads(artifact())['bytes'])

    def test_a_program_with_no_artifact_says_so(self):
        # Preserve a compiler failure as a visible error rather than showing a
        # blank Run result. The injected message checks that it is propagated.
        self.solved('ranks8.c')
        from qm import browser
        saved = dict(browser._LAST)
        try:
            browser._LAST.pop('*artifact')
            browser._LAST['*artifact_error'] = 'no bit-sliced form for TABLE'
            out = json.loads(evaluate('', '5'))
            self.assertFalse(out['ok'])
            self.assertIn('TABLE', out['error'])
        finally:
            browser._LAST.clear()
            browser._LAST.update(saved)

    def test_a_periodic_lookup_is_compact_and_runs_through_wasm(self):
        result = json.loads(fallback(LOOKUP, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        op = result['program']['ops'][0]
        self.assertEqual(op['class'], 'TABLE')
        self.assertEqual(op['detail']['input_bits'], 3)
        self.assertEqual(len(op['detail']['table']), 8)

        wasm = next(t for t in result['targets'] if t['name'] == 'wasm32')
        self.assertEqual(wasm['instructions'], ['LUT'])
        self.assertLess(wasm['L_bits'], 1000)
        self.assertTrue(json.loads(artifact())['ok'])
        self.assertEqual(json.loads(evaluate('', '255'))['output'], '5')

    def test_nonsense_is_an_error_not_an_exception(self):
        self.solved('ranks8.c')
        self.assertFalse(json.loads(evaluate('', 'nope'))['ok'])

    def test_run_executes_the_pastes_own_main(self):
        """Same lesson as `prepare`: the fix only counts if it is called.

        Automatic function-level analysis prepares the exact minimized
        artifact and an import-only main driver. Run reuses that source-keyed
        snapshot instead of repeating QM or the optional state closure.
        """
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            worker = handle.read()
        self.assertIn("msg.type === 'exec'", worker)
        self.assertIn("callPython('split'", worker)
        self.assertIn("callPython('prepare_run'", worker)
        self.assertIn("callPython('prepare_state'", worker)
        self.assertIn("'stateful_wasm'", worker)
        self.assertIn('qm_getchar', worker)
        self.assertIn('qm_putchar', worker)
        # paste -> QM -> codec -> run: the kernel the driver calls is an
        # import, answered by the artifact rather than by Clang's own build of
        # it. `tests/test_browser_run.py` drives the whole chain.
        self.assertIn("callPython('run_plan'", worker)
        self.assertIn('prepareEvaluator', worker)
        self.assertIn('env[plan.function] = evaluator.fn', worker)
        self.assertIn('const runCache = new Map()', worker)
        self.assertIn('prepareRunSnapshot(request.source)', worker)
        # Every reply from a solve carries whether there was a `main`; the page
        # has no second opinion about what the source contains.
        self.assertEqual(worker.count("has_main: hasMain"),
                         worker.count("post('done'"))

        with open(os.path.join(ROOT, 'web', 'app.js')) as handle:
            app = handle.read()
        self.assertIn("type: 'exec'", app)
        self.assertIn("msg.type === 'ran'", app)
        self.assertIn("Done. [${elapsed}ms]", app)
        self.assertIn("stdin ? `> ${stdin}\\n` : '> '", app)
        # There is one Run control, not a mode-changing Run/Compile label and
        # no value box left to reference.
        self.assertNotIn("btn-optimize", app)
        self.assertIn("$('run-label').textContent = 'Run'", app)
        self.assertIn("tab.hasMain = Boolean(msg.has_main)", app)
        self.assertIn("tab.runReady = Boolean(msg.run_ready)", app)
        self.assertIn("tab.source !== request.source", app)
        self.assertIn('if (state.busy || state.pending || !state.ready || !tab', app)
        self.assertIn('|| !hasSource || !canRun', app)
        self.assertIn("type: 'exec', source: tab.source, stdin", app)
        self.assertNotIn('analyze_main:', app)
        self.assertNotIn('request.run', app)
        self.assertLess(app.index("type: 'solve', source"),
                        app.index("type: 'exec', source: tab.source"))
        self.assertNotIn("run-input", app)

        # Compile latency is not reported as VM latency. The clock starts
        # after the driver and artifact are prepared.
        self.assertIn('const runStarted = performance.now()', worker)
        self.assertIn('prepare_ms: runStarted - prepareStarted', worker)
        self.assertNotIn('result.elapsed_ms = performance.now() - started', worker)

        with open(os.path.join(ROOT, 'web', 'vm.js')) as handle:
            vm = handle.read()
        self.assertIn('vm_prepare_eval', vm)
        self.assertIn('vm_eval_${input}_${output}', vm)

    def test_the_page_compiles_without_being_asked(self):
        with open(os.path.join(ROOT, 'web', 'app.js')) as handle:
            app = handle.read()
        self.assertIn('scheduleCompile', app)
        self.assertIn("editor.addEventListener('input'", app)
        with open(os.path.join(ROOT, 'web', 'index.html')) as handle:
            html = handle.read()
        self.assertNotIn('id="btn-optimize"', html)
        self.assertNotIn('id="run-input"', html)
        self.assertIn('id="term-in"', html)
        # Run stays in the source heading. The + opens one chooser where both
        # the New tab heading and the + before the examples create a tab.
        self.assertIn('id="btn-run"', html)
        self.assertIn('id="run-label"', html)
        self.assertIn('id="btn-run" type="button" disabled', html)
        self.assertNotIn('id="btn-examples"', html)
        self.assertIn('aria-label="New tab or example"', html)
        self.assertNotIn('Empty tab', html)
        self.assertNotIn('id="btn-settings"', html)
        self.assertNotIn('id="settings"', html)
        self.assertIn('data-new-tab="1"', app)
        self.assertIn("$('dlg-title-action').addEventListener('click'", app)
        self.assertIn("card.addEventListener('dblclick'", app)
        self.assertIn("board.classList.add('is-focused')", app)
        self.assertIn('tabindex="0"', html)
        self.assertIn("$('btn-newtab').addEventListener('click', showExamples)", app)
        self.assertIn("state.tabs.length > 1 ? '' : 'disabled'", app)
        self.assertIn("event.key === 'Delete'", app)
        head = html.split('id="card-write"')[1].split('</div>')[0]
        self.assertIn('id="btn-run"', head)


class TestCapabilities(unittest.TestCase):
    def test_capabilities_are_json_and_complete(self):
        caps = json.loads(capabilities())
        names = [f['name'] for f in caps['frontends']]
        self.assertIn('clang', names)
        self.assertIn('cfront', names)
        self.assertIn('precompiled', names)
        self.assertTrue(caps['targets'])
        self.assertTrue(any(o['spec'] == 'exact' for o in caps['observers']))


class TestPlan(unittest.TestCase):
    def test_plan_returns_the_domain_the_worker_must_evaluate(self):
        result = json.loads(plan(SOURCE, '{}'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['function'], 'ranks8')
        self.assertEqual(result['input_bits'], 8)
        self.assertEqual(result['output_bits'], 64)
        self.assertEqual(len(result['values']), 256)
        # Decimal strings, not JSON numbers: a double cannot carry a 64-bit
        # input, and most of a 64-bit domain is above 2^53.
        self.assertTrue(all(isinstance(v, str) for v in result['values']))
        self.assertEqual([int(v) for v in result['values']], list(range(256)))

    def test_a_64_bit_domain_survives_the_json_round_trip(self):
        source = 'unsigned long long f(unsigned long long x) { return x; }'
        values = [int(v) for v in json.loads(plan(source, '{}'))['values']]
        # The point of the strings: as numbers these arrive rounded, and the
        # worker would evaluate the kernel at inputs neither side asked for.
        self.assertIn((1 << 64) - 1, values)
        self.assertTrue(any(v > (1 << 53) for v in values))

    def test_a_paste_of_several_functions_plans_the_one_it_can_take(self):
        source = ('#include <stdint.h>\n'
                  'uint64_t starts8(uint8_t m) { uint64_t x = m;'
                  ' return x & ~(x << 1); }\n'
                  'uint64_t combine(uint8_t a, uint8_t b)'
                  ' { return starts8(a) | starts8(b); }\n')
        result = json.loads(plan(source, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['function'], 'starts8')
        # And the reason the other one was passed over travels with it: only
        # this side parses the source, so the page cannot work it out again.
        self.assertEqual([f['name'] for f in result['other_functions']],
                         ['combine'])
        self.assertIn('takes 2 arguments', result['other_functions'][0]['reason'])

    def test_the_worker_carries_the_other_functions_to_finish(self):
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            self.assertIn('other_functions: compiled.plan.other_functions',
                          handle.read())

    def test_plan_reports_errors_as_data_not_exceptions(self):
        result = json.loads(plan('not C at all', '{}'))
        self.assertFalse(result['ok'])
        self.assertIn('text', result['error'])


class TestFinish(unittest.TestCase):
    def _table(self, values):
        """Stand in for the wasm oracle with a Python evaluation."""
        def ref(m):
            return sum(bin(m & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))
        return [str(ref(int(v))) for v in values]

    def test_finish_accepts_decimal_strings(self):
        # A JSON number cannot carry 64 bits, so the worker sends strings.
        planned = json.loads(plan(SOURCE, '{}'))
        options = json.dumps({'function': 'ranks8', 'input_bits': 8,
                              'output_bits': 64})
        result = json.loads(finish(SOURCE, options,
                                   self._table(planned['values']), ''))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)

    def test_finish_rejects_a_table_of_the_wrong_length(self):
        options = json.dumps({'function': 'ranks8', 'input_bits': 8,
                              'output_bits': 64})
        result = json.loads(finish(SOURCE, options, ['0', '1'], ''))
        self.assertFalse(result['ok'])

    def test_finish_reports_the_functions_it_did_not_analyse(self):
        options = json.dumps({
            'function': 'ranks8', 'input_bits': 8, 'output_bits': 64,
            'other_functions': [{'name': 'combine',
                                 'reason': 'takes 2 arguments'}],
        })
        planned = json.loads(plan(SOURCE, '{}'))
        result = json.loads(finish(SOURCE, options,
                                   self._table(planned['values']), ''))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['other_functions'][0]['name'],
                         'combine')
        self.assertIn('combine', result['frontend']['functions_in_source'])

    def test_fallback_runs_without_a_compiler(self):
        result = json.loads(fallback(SOURCE, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)


@unittest.skipUnless(NATIVE.available(), 'clang is not installed')
class TestWorkerProtocolWithRealClang(unittest.TestCase):
    def test_plan_then_compile_then_finish(self):
        planned = json.loads(plan(SOURCE, '{}'))
        signature = read_signature(SOURCE)
        table = NATIVE.evaluate(SOURCE, signature,
                                [int(v) for v in planned['values']])
        assembly = NATIVE.assembly(SOURCE)

        options = json.dumps({
            'function': planned['function'],
            'input_bits': planned['input_bits'],
            'output_bits': planned['output_bits'],
        })
        result = json.loads(finish(SOURCE, options,
                                   [str(v) for v in table], assembly))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['residual_freedom'], 502)
        self.assertTrue(result['frontend']['assembly_stats']['available'])
        primary = next(t for t in result['targets']
                       if t['name'] == result['primary_target'])
        self.assertEqual(primary['instructions'], ['PDEP', 'IMUL'])
        self.assertTrue(primary['verification']['pass'])

    def test_wasm32_target_compiles_and_exports_the_kernel(self):
        # The browser's oracle is this compile plus WebAssembly.instantiate.
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            from qm.clang import prepare_source
            csrc = os.path.join(tmp, 'k.c')
            out = os.path.join(tmp, 'k.wasm')
            with open(csrc, 'w') as handle:
                handle.write(prepare_source(SOURCE))
            build = subprocess.run(
                [NATIVE.binary, '--target=wasm32', '-O2', '-ffreestanding',
                 '-nostdlib', '-Wl,--no-entry', '-Wl,--export-all',
                 csrc, '-o', out],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            with open(out, 'rb') as handle:
                blob = handle.read()
        self.assertEqual(blob[:4], b'\x00asm')
        self.assertIn(b'ranks8', blob)


def _have(binary):
    from shutil import which
    return which(binary) is not None


@unittest.skipUnless(NATIVE.available() and _have('node'),
                     'needs native Clang and node')
class TestValueTransport(unittest.TestCase):
    """Getting the domain into the wasm and the results back out.

    Two separate things used to go wrong on the way, and neither shows up in a
    Python test, because neither is in Python:

      * an i64 parameter takes a BigInt across the JS boundary — a Number
        throws `Cannot convert 255 to a BigInt`, so every 64-bit kernel died
        the moment the oracle was called;
      * a JSON number is a double, and 4,177 of the 4,287 points in a 64-bit
        domain are above 2^53, so the inputs QM verified against were not the
        inputs the kernel was evaluated at.

    So this runs the shipped `web/clang.js` — the file itself, copied, not a
    restatement of it — against a module the real compiler produced.
    """

    def _evaluate(self, source, function, values, output_bits, input_bits):
        """`evaluateWasm` from web/clang.js, on a real WebAssembly engine."""
        with tempfile.TemporaryDirectory() as tmp:
            from qm.clang import prepare_source
            csrc = os.path.join(tmp, 'k.c')
            wasm = os.path.join(tmp, 'k.wasm')
            with open(csrc, 'w') as handle:
                handle.write(prepare_source(source))
            build = subprocess.run(
                [NATIVE.binary, '--target=wasm32', '-O2', '-ffreestanding',
                 '-nostdlib', '-Wl,--no-entry', '-Wl,--export-all',
                 csrc, '-o', wasm],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)

            # .mjs because the repo has no "type": "module"; the bytes are the
            # shipped file's, so a break in it is a break here.
            with open(os.path.join(ROOT, 'web', 'clang.js')) as handle:
                shipped = handle.read()
            with open(os.path.join(tmp, 'clang.mjs'), 'w') as handle:
                handle.write(shipped)
            with open(os.path.join(tmp, 'run.mjs'), 'w') as handle:
                handle.write(
                    "import { readFileSync } from 'node:fs';\n"
                    "import { evaluateWasm } from './clang.mjs';\n"
                    "const [wasm, fn, bits, inBits] = process.argv.slice(2);\n"
                    "const values = JSON.parse(readFileSync(0, 'utf8'));\n"
                    "const out = await evaluateWasm(readFileSync(wasm), fn,"
                    " values, Number(bits), Number(inBits));\n"
                    "process.stdout.write(JSON.stringify(out));\n")
            run = subprocess.run(
                ['node', os.path.join(tmp, 'run.mjs'), wasm, function,
                 str(output_bits), str(input_bits)],
                input=json.dumps(values), capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            return json.loads(run.stdout)

    def test_a_64_bit_kernel_is_evaluated_at_the_inputs_qm_planned(self):
        source = ('#include <stdint.h>\n'
                  'uint64_t mix64(uint64_t x) { return x ^ (x >> 32); }\n')
        planned = json.loads(plan(source, '{}'))
        self.assertEqual(planned['input_bits'], 64)

        table = self._evaluate(source, 'mix64', planned['values'],
                               planned['output_bits'], planned['input_bits'])
        expected = [str(int(v) ^ (int(v) >> 32)) for v in planned['values']]
        self.assertEqual(table, expected)

    def test_the_widest_input_is_not_rounded_on_the_way_in(self):
        # The one point that proves the strings are doing something: as a JSON
        # number 0xFFFFFFFFFFFFFFFF arrives as 2^64, and the kernel would be
        # evaluated at zero.
        source = ('#include <stdint.h>\n'
                  'uint64_t low8(uint64_t x) { return x & 0xFFull; }\n')
        widest = str((1 << 64) - 1)
        self.assertEqual(
            self._evaluate(source, 'low8', [widest], 64, 64), ['255'])

    def test_a_narrow_kernel_still_takes_a_plain_number(self):
        # The other side of the branch: an i32 parameter rejects a BigInt just
        # as firmly as an i64 rejects a Number.
        planned = json.loads(plan(SOURCE, '{}'))
        table = self._evaluate(SOURCE, 'ranks8', planned['values'],
                               planned['output_bits'], planned['input_bits'])

        def ref(m):
            return sum(bin(m & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))
        self.assertEqual(table, [str(ref(int(v))) for v in planned['values']])

    def test_every_64_bit_example_now_reaches_the_oracle(self):
        # These five are what the bug cost: a `uint64_t` parameter is an i64,
        # so each of them threw before the first input was evaluated.  The
        # native harness is an independent oracle — a different compiler and a
        # different calling convention — so agreeing means the transport is
        # right, not that one mistake was made twice.
        from tests.support import read_example
        examples = ['block_offsets8.c', 'byte_mask_from_spread.c',
                    'changes64.c', 'mask_from_spread.c', 'prefix_xor64.c',
                    'zero_spread8.c', 'eq_spread8.c', 'lt_spread8.c',
                    'range_spread8.c']
        for name in examples:
            with self.subTest(example=name):
                source = read_example(name)
                planned = json.loads(plan(source, '{}'))
                self.assertEqual(planned['input_bits'], 64)
                native = NATIVE.evaluate(source, read_signature(source),
                                         [int(v) for v in planned['values']])
                self.assertEqual(
                    self._evaluate(source, planned['function'],
                                   planned['values'], planned['output_bits'],
                                   planned['input_bits']),
                    [str(v) for v in native])

    def test_the_worker_tells_the_oracle_how_wide_the_input_is(self):
        """Same lesson as `prepare`: the fix only counts if it is called."""
        with open(os.path.join(ROOT, 'web', 'worker.js')) as handle:
            worker = handle.read()
        call = re.search(r'evaluateWasm\(([^;]*?)\)\s*;', worker, re.S)
        self.assertIsNotNone(call, 'the worker no longer calls evaluateWasm')
        self.assertIn('plan.input_bits', call.group(1))


class TestManifest(unittest.TestCase):
    def test_manifest_matches_the_package_on_disk(self):
        import sys
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import gen_manifest

        with open(MANIFEST) as handle:
            stored = json.load(handle)
        self.assertEqual(stored, gen_manifest.build(),
                         'web/qm-manifest.json is stale; run '
                         'python3 tools/gen_manifest.py')

    def test_every_listed_file_exists(self):
        with open(MANIFEST) as handle:
            stored = json.load(handle)
        for rel in stored['files']:
            self.assertTrue(os.path.exists(os.path.join(ROOT, rel)), rel)

    def test_the_deployed_site_contains_what_the_manifest_names(self):
        """Being on disk is not the same as being deployed.

        `qm-manifest.json` is checked against the source tree, and the source
        tree was right — but `build_site.py` copied a fixed list of directories,
        so adding a second package left the manifest naming files the deploy did
        not contain. The suite stayed green and the build broke, which is the
        one shape of failure this repo keeps having to close.
        """
        import sys
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import build_site

        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, 'dist')
            build_site.build(out)
            with open(MANIFEST) as handle:
                stored = json.load(handle)
            for rel in stored['files']:
                self.assertTrue(os.path.exists(os.path.join(out, rel)),
                                '%s is in the manifest and not in the build'
                                % rel)
            # And the files the page fetches directly rather than through the
            # manifest.
            for rel in ('web/vm.wasm', 'web/vm.js', 'web/qm-manifest.json',
                        'web/examples.json', 'index.html'):
                self.assertTrue(os.path.exists(os.path.join(out, rel)), rel)


class TestExamplesJson(unittest.TestCase):
    """The page's copy of the examples is generated, so it can go stale.

    An example that differs between `examples/` and the page would mean the
    tests measure one text and the user runs another.
    """

    PATH = os.path.join(ROOT, 'web', 'examples.json')

    def test_examples_json_matches_the_directory(self):
        import sys
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import gen_examples

        with open(self.PATH) as handle:
            stored = json.load(handle)
        self.assertEqual(stored, gen_examples.build(),
                         'web/examples.json is stale; run '
                         'python3 tools/gen_examples.py')

    def test_the_listing_examples_are_present(self):
        with open(self.PATH) as handle:
            stored = json.load(handle)
        languages = set(e['language'] for e in stored['examples'])
        self.assertEqual(languages, {'c', 'asm'})



class TestAssemblyListings(unittest.TestCase):
    """The listing's ISA is detected, never assumed.

    Which one a Clang bundle can emit depends on the targets it was built with:
    the bundled browser toolchain is WebAssembly-only, the native one here is
    x86-64. A count must never be labelled with the wrong architecture.
    """

    WASM_LISTING = '''\t.file\t"in.c"
\t.functype\tranks8 (i32) -> (i64)
\t.section\t.text.ranks8,"",@
\t.globl\tranks8
ranks8:
\t.functype\tranks8 (i32) -> (i64)
\tlocal.get\t0
\ti32.const\t127
\ti32.and
\ti32.popcnt
\ti64.extend_i32_u
\ti64.const\t56
\ti64.shl
\tend_function
'''

    X86_LISTING = '''\t.text
\t.globl\tranks8
ranks8:
\tmovl\t%edi, %ecx
\tandl\t$1, %ecx
\tshll\t$8, %ecx
\timulq\t%rax, %rdx
\tretq
'''

    def test_wasm_listing_is_named_wasm(self):
        from qm.asmstats import analyze
        stats = analyze(self.WASM_LISTING, 'ranks8')
        self.assertTrue(stats['available'])
        self.assertEqual(stats['isa'], 'wasm32')
        self.assertEqual(stats['instructions'], 8)
        self.assertIn('wasm32', stats['note'])

    def test_x86_listing_is_named_x86(self):
        from qm.asmstats import analyze
        stats = analyze(self.X86_LISTING, 'ranks8')
        self.assertEqual(stats['isa'], 'x86-64')
        self.assertEqual(stats['instructions'], 5)

    def test_declared_isa_wins_over_detection(self):
        from qm.asmstats import analyze
        stats = analyze(self.WASM_LISTING, 'ranks8', isa='wasm32-declared')
        self.assertEqual(stats['isa'], 'wasm32-declared')

    def test_finish_labels_the_baseline_with_the_listing_isa(self):
        planned = json.loads(plan(SOURCE, '{}'))

        def ref(m):
            return sum(bin(m & ((1 << k) - 1)).count('1') << (8 * k)
                       for k in range(8))

        options = json.dumps({
            'function': 'ranks8', 'input_bits': 8, 'output_bits': 64,
            'compile': {'opt': '-O2', 'listing_isa': 'wasm32'},
        })
        result = json.loads(finish(
            SOURCE, options,
            [str(ref(int(v))) for v in planned['values']], self.WASM_LISTING))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['assembly_stats']['isa'], 'wasm32')
        self.assertIn('wasm32', result['frontend']['reference_ops']['metric'])
        # QM still lowers to x86-64: the compiler's target is not QM's target.
        self.assertIn('x86-64-bmi2-pclmul',
                      [t['name'] for t in result['targets']])

if __name__ == '__main__':
    unittest.main()
