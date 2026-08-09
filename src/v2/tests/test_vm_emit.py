"""The image back out as C, wasm32 and x86-64.

`vm.lower` takes the minimized wasm32 sequence to one artifact; `vm.emit`
takes that artifact back to the three languages. Together they are why there
is one program rather than one per language: the artifact is what is kept,
and each listing is derived from it.

Emitting is easy to get subtly wrong and impossible to eyeball, so nothing here
inspects the text. Each form is compiled or assembled with a real toolchain,
run, and required to compute the same function as the artifact does.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from qm import isa as isa_mod
from qm.pipeline import solve
from vm import emit, lower, run

from tests.support import read_example

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAIN_C = '''\
#include <stdio.h>
#include <stdint.h>
uint64_t kernel(%(ctype_in)s x);
int main(void)
{
    for (unsigned i = 0; i < %(count)d; ++i)
        printf("%%llu\\n", (unsigned long long)kernel((%(ctype_in)s)i));
    return 0;
}
'''

WAT_DRIVER = '''\
import { readFileSync } from 'node:fs';
import wabtInit from 'wabt';
const wabt = await wabtInit();
const parsed = wabt.parseWat('emit.wat', readFileSync(process.argv[2], 'utf8'));
parsed.resolveNames();
parsed.validate();
const { buffer } = parsed.toBinary({ log: false });
const { instance } = await WebAssembly.instantiate(buffer, {});
const fn = instance.exports.kernel;
const out = [];
for (let i = 0; i < Number(process.argv[3]); i += 1) {
  out.push(fn(BigInt(i)).toString());
}
process.stdout.write(out.join('\\n'));
'''


def minimized(name):
    result = solve(read_example(name + '.c'), frontend='cfront')
    assert result['ok'], result.get('error')
    target = next(t for t in result['targets']
                  if t['name'] == 'wasm32' and t.get('ok'))
    return (target['seq'], result['frontend']['input_bits'],
            result['frontend']['output_bits'])


def image_for(name):
    seq, input_bits, output_bits = minimized(name)
    return (lower.lower_seq(seq, input_bits, output_bits),
            isa_mod.compile_seq(seq), input_bits, output_bits)


class TestEmittedTextIsWellFormed(unittest.TestCase):
    """Cheap checks that hold with no toolchain at all."""

    def test_each_language_names_the_kernel_and_its_entries(self):
        picture, _reference, input_bits, output_bits = image_for('starts8')
        for language in emit.LANGUAGES:
            with self.subTest(language=language):
                text = emit.emit(picture, language, 'kernel',
                                 input_bits, output_bits)
                self.assertIn('kernel', text)
                self.assertIn(str(picture.pc_out), text)
                self.assertIn(str(picture.pc_feed), text)

    def test_an_unknown_language_is_refused(self):
        picture, _r, _n, _m = image_for('starts8')
        with self.assertRaises(ValueError) as caught:
            emit.emit(picture, 'fortran')
        self.assertIn('fortran', str(caught.exception))


@unittest.skipUnless(shutil.which('gcc'), 'needs gcc')
class TestEmittedCAndX86Compute(unittest.TestCase):
    """Compiled with a real toolchain and run, not read."""

    def build_and_run(self, sources, ctype_in, count, extra=()):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for index, (suffix, text) in enumerate(sources):
                path = os.path.join(tmp, 'part%d%s' % (index, suffix))
                with open(path, 'w') as handle:
                    handle.write(text)
                paths.append(path)
            main = os.path.join(tmp, 'main.c')
            with open(main, 'w') as handle:
                handle.write(MAIN_C % {'ctype_in': ctype_in, 'count': count})
            binary = os.path.join(tmp, 'run')
            built = subprocess.run(['gcc', '-O2', '-o', binary]
                                   + paths + [main] + list(extra),
                                   capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            out = subprocess.run([binary], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            return [int(v) for v in out.stdout.split()]

    def check(self, name, language, count=256):
        picture, reference, input_bits, output_bits = image_for(name)
        text = emit.emit(picture, language, 'kernel', input_bits, output_bits)
        suffix = '.c' if language == 'c' else '.s'
        ctype_in = 'uint8_t' if input_bits <= 8 else 'uint16_t'
        got = self.build_and_run([(suffix, text)], ctype_in, count)
        self.assertEqual(got, [reference(i) for i in range(count)],
                         'emitted %s for %s computes a different function'
                         % (language, name))

    def test_c_from_a_wiring_only_program(self):
        self.check('starts8', 'c')

    def test_c_from_a_deposit_and_a_multiply(self):
        self.check('ranks8', 'c')

    def test_x86_from_a_wiring_only_program(self):
        self.check('starts8', 'x86')

    def test_x86_from_a_deposit_and_a_multiply(self):
        self.check('ranks8', 'x86')

    def test_a_sixteen_bit_kernel_keeps_its_framing(self):
        # Two input bytes rather than one: the feed loop has to run twice
        # before the kernel is entered at all.
        self.check('morton_dilate16', 'c', count=64)

    def test_the_three_languages_agree_with_each_other(self):
        picture, reference, input_bits, output_bits = image_for('ranks8')
        answers = {}
        for language in ('c', 'x86'):
            text = emit.emit(picture, language, 'kernel',
                             input_bits, output_bits)
            answers[language] = self.build_and_run(
                [('.c' if language == 'c' else '.s', text)], 'uint8_t', 64)
        self.assertEqual(answers['c'], answers['x86'])
        self.assertEqual(answers['c'], [reference(i) for i in range(64)])

    def test_it_agrees_with_the_artifact_it_came_from(self):
        # The point of the round trip: the listing and the artifact are the
        # same program, so running either has to give the same answers.
        seq, input_bits, output_bits = minimized('ranks8')
        picture = lower.lower_seq(seq, input_bits, output_bits)
        blob = run.artifact_for(seq, input_bits, output_bits)
        values = [0, 1, 5, 128, 255]

        text = emit.emit(picture, 'c', 'kernel', input_bits, output_bits)
        emitted = self.build_and_run([('.c', text)], 'uint8_t', 256)
        self.assertEqual([emitted[v] for v in values],
                         run.evaluate_many(blob, values, input_bits,
                                           output_bits))


def _has_wabt():
    if not shutil.which('node'):
        return None
    for root in (os.path.join(ROOT, 'node_modules'),
                 os.path.join(os.path.dirname(ROOT), 'node_modules'),
                 os.path.join(os.path.dirname(os.path.dirname(ROOT)),
                              'node_modules')):
        if os.path.isdir(os.path.join(root, 'wabt')):
            return root
    return None


@unittest.skipUnless(_has_wabt(), 'needs node and the wabt package')
class TestEmittedWasmComputes(unittest.TestCase):
    """The text form assembled by wabt and run on a real WebAssembly engine."""

    def check(self, name, count=256):
        picture, reference, input_bits, output_bits = image_for(name)
        text = emit.emit(picture, 'wat', 'kernel', input_bits, output_bits)
        modules = _has_wabt()
        with tempfile.TemporaryDirectory() as tmp:
            source = os.path.join(tmp, 'emit.wat')
            with open(source, 'w') as handle:
                handle.write(text)
            driver = os.path.join(modules, '..', 'qm_wat_driver.mjs')
            driver = os.path.abspath(driver)
            with open(driver, 'w') as handle:
                handle.write(WAT_DRIVER)
            try:
                out = subprocess.run(['node', driver, source, str(count)],
                                     capture_output=True, text=True)
            finally:
                os.unlink(driver)
        self.assertEqual(out.returncode, 0, out.stderr[-800:])
        self.assertEqual([int(v) for v in out.stdout.split()],
                         [reference(i) for i in range(count)],
                         'emitted wasm for %s computes a different function'
                         % name)

    def test_wasm_from_a_wiring_only_program(self):
        self.check('starts8')

    def test_wasm_from_a_deposit_and_a_multiply(self):
        self.check('ranks8', count=64)
