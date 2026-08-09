"""Run closes the loop: paste -> QM -> codec -> run.

A driver that called Clang's compilation of the kernel would be testing the
compiler. What Run has to execute is the *minimized program*, so the paste is
split, only `main` is compiled, and the kernel is left undefined — an import,
answered by feeding the artifact.

These drive exactly what `web/worker.js` drives, with the native toolchain
standing in for clang.wasm and node for the page.
"""

import base64
import json
import os
import subprocess
import tempfile
import unittest

from qm.browser import artifact, fallback, prepare_run, run_plan
from qm.clang import NATIVE, split_main

from tests.support import read_example

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def hex_words(values):
    """What the shipped drivers read: whitespace-separated hex words."""
    return (' '.join('%x' % v for v in values) + '\n').encode()

# What the page does, with node for the browser: load the machine, then hand
# `main` the kernel as an import that runs the artifact.
HARNESS = '''
import { readFileSync } from 'node:fs';
const V2 = process.argv[2];
globalThis.fetch = async () => ({
  ok: true,
  arrayBuffer: async () => readFileSync(V2 + '/web/vm.wasm').buffer,
});
const vm = await import(V2 + '/web/vm.js');
await vm.load();

const artifact = new Uint8Array(readFileSync(process.argv[4]));
const plan = JSON.parse(process.argv[5]);
const stdin = [...Buffer.from(process.argv[6], 'base64')];
let at = 0; const out = []; let ran = 0;
const env = {
  qm_getchar: () => (at < stdin.length ? stdin[at++] : -1),
  qm_putchar: (c) => out.push(c & 255),
};
env[plan.function] = (x) => {
  const v = BigInt.asUintN(64, BigInt(x));
  const feed = [];
  for (let i = 0; i < plan.in_bytes; i += 1) {
    feed.push(Number((v >> BigInt(8 * i)) & 255n));
  }
  ran += 1;
  const y = vm.evaluateLoaded(artifact, feed, plan.out_bytes);
  return plan.output_bits > 32 ? y : Number(BigInt.asUintN(32, y));
};
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[3]), { env });
const code = instance.exports.main();
process.stdout.write(JSON.stringify({
  stdout: Buffer.from(out).toString('utf8'), code: Number(code), ran,
}));
'''


def has_node():
    try:
        subprocess.run(['node', '--version'], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


@unittest.skipUnless(NATIVE.available() and has_node(), 'needs clang and node')
class TestRunGoesThroughTheCodec(unittest.TestCase):

    def drive(self, example, values):
        """Run the example exactly as it ships, over `values`."""
        return self.drive_source(read_example(example + '.c'),
                                 hex_words(values))

    def drive_source(self, source, stdin):
        kernel, span = split_main(source)
        self.assertIsNotNone(span, 'the driver was not found')

        result = json.loads(fallback(kernel, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        plan = json.loads(run_plan())
        self.assertTrue(plan['ok'], plan.get('error'))
        built = json.loads(artifact(''))
        self.assertTrue(built['ok'], built.get('error'))

        with tempfile.TemporaryDirectory() as tmp:
            csrc = os.path.join(tmp, 'in.c')
            with open(csrc, 'w') as handle:
                handle.write(prepare_run(source))
            wasm = os.path.join(tmp, 'out.wasm')
            built_ok = subprocess.run(
                [NATIVE.binary, '--target=wasm32', '-O2', '-ffreestanding',
                 '-nostdlib', '-Wl,--no-entry', '-Wl,--export-all',
                 '-Wl,--allow-undefined', '-Wall', '-o', wasm, csrc],
                capture_output=True, text=True)
            self.assertEqual(built_ok.returncode, 0, built_ok.stderr)

            blob = os.path.join(tmp, 'artifact.bin')
            with open(blob, 'wb') as handle:
                handle.write(base64.b64decode(built['artifact']))
            harness = os.path.join(tmp, 'run.mjs')
            with open(harness, 'w') as handle:
                handle.write(HARNESS)

            ran = subprocess.run(
                ['node', harness, ROOT, wasm, blob, json.dumps(plan),
                 base64.b64encode(bytes(stdin)).decode('ascii')],
                capture_output=True, text=True)
            self.assertEqual(ran.returncode, 0, ran.stderr[-2000:])
            return json.loads(ran.stdout)

    def test_main_drives_the_artifact(self):
        out = self.drive('starts8', [5, 1, 0xFF])
        want = ['0x%016x' % (v & ~(v << 1) & 0xFFFFFFFFFFFFFFFF)
                for v in (5, 1, 0xFF)]
        self.assertEqual(out['stdout'].split('\n')[:3], want)
        self.assertEqual(out['code'], 0)
        # The claim: every call went through the codec, not through Clang's
        # compilation of the kernel.
        self.assertEqual(out['ran'], 3)

    def test_the_kernel_is_not_in_the_compiled_driver(self):
        """If Clang still had the body, the import would never be called."""
        prepared = prepare_run(read_example('starts8.c'))
        self.assertIn('extern uint64_t starts8(uint8_t);', prepared)
        self.assertNotIn('x & ~(x << 1)', prepared)
        self.assertIn('getchar()', prepared)

    def test_a_kernel_with_a_multiply_in_it_too(self):
        out = self.drive('ranks8', [0, 5, 0xFF])
        rows = out['stdout'].split('\n')[:3]
        want = []
        for v in (0, 5, 0xFF):
            want.append('0x%016x' % sum(
                bin(v & ((1 << k) - 1)).count('1') << (8 * k) for k in range(8)))
        self.assertEqual(rows, want)
        self.assertEqual(out['ran'], 3)

    def test_the_shipped_example_runs(self):
        """Every example ships with a driver, so every one can be pressed Run on.

        `ranks8` stands for all of them here: the check is that the shipped
        text works as written, and that what gets minimized is the kernel and
        not `main`.
        """
        source = read_example('ranks8.c')
        kernel, span = split_main(source)
        self.assertIsNotNone(span, 'the shipped example lost its main')
        # The comment at the top names `getchar`, so the check is that the
        # driver's *body* is gone rather than every mention of it.
        self.assertNotIn('int main(void)', kernel)
        self.assertIn('uint64_t ranks8(uint8_t m)', kernel)

        result = json.loads(fallback(kernel, '{}'))
        self.assertTrue(result['ok'], result.get('error'))
        self.assertEqual(result['frontend']['function']['name'], 'ranks8')

        out = self.drive_source(source, hex_words([0, 5, 0xFF]))
        want = ['0x%016x' % sum(bin(v & ((1 << k) - 1)).count('1') << (8 * k)
                                for k in range(8))
                for v in (0, 5, 0xFF)]
        self.assertEqual(out['stdout'].split('\n')[:3], want)
        self.assertEqual(out['ran'], 3)

    def test_hello_world_is_a_greeting_and_a_kernel(self):
        """The first thing the Examples menu offers, so it has to work.

        Both halves at once: the greeting is ordinary C, and everything after
        it came back through the artifact.
        """
        out = self.drive_source(read_example('HelloWorld.c'), b'Hi')
        lines = out['stdout'].split('\n')
        self.assertEqual(lines[0], 'Hello, world!')
        self.assertEqual(lines[1], 'H' * 8)
        self.assertEqual(lines[2], 'i' * 8)
        self.assertEqual(out['ran'], 2)

    def test_stdin_ends_the_loop_rather_than_hanging(self):
        out = self.drive('starts8', [])
        self.assertEqual(out['stdout'], '')
        self.assertEqual(out['ran'], 0)
