"""A minimized wasm32 sequence becomes one rSUBLEQ artifact.

QM accepts C through the browser's wasm32 compiler, or x86-64 and wasm32
listings directly. It produces a minimized wasm32 instruction sequence, and
`vm.lower` compiles that sequence to `pack(code(z))` over a canonical image.

What makes it worth anything is that the artifact computes the same function,
which is what these check — on the whole domain where the domain can be walked.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from qm import isa as isa_mod
from qm.pipeline import solve
from kernel.pagefabric import (build_erasure_recovery_directory,
                               _combine, _generator)
from vm import codec, image, lower, machine, run

from tests.support import EXAMPLES, read_example

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIPPED_WASM = os.path.join(ROOT, 'web', 'vm.wasm')
WASM_SOURCE = os.path.join(ROOT, 'vm', 'wasm', 'vm.c')
VM_JS = os.path.join(ROOT, 'web', 'vm.js')
ERASURE_JS = os.path.join(ROOT, 'web', 'erasure-recovery.js')

# The shapes the lowering has to handle: pure wiring, a deposit and a multiply,
# an extract, a carry-less multiply, and the lane comparisons with their
# adders.  The dynamic gather is much the most expensive and has its own test.
CASES = ['starts8', 'ranks8', 'byte_mask8', 'middle_bits_u16',
         'morton_dilate16', 'changes64', 'eq_spread8']

# A few inputs, spread out.  The Python machine walks every SUBLEQ transition,
# so a whole 2^16 domain here would cost minutes for no extra claim: the
# artifact either computes the function or it does not, and one wrong bit shows
# up on the boundary values as readily as anywhere.
PROBES = [0, 1, 2, 5, 127, 128, 254, 255]


def minimized(name):
    """(seq, input_bits, output_bits) for one example."""
    result = solve(read_example(name + '.c'), frontend='cfront')
    assert result['ok'], result.get('error')
    target = next(t for t in result['targets']
                  if t['name'] == 'wasm32' and t.get('ok'))
    return (target['seq'], result['frontend']['input_bits'],
            result['frontend']['output_bits'])


def artifact_result(result):
    """Compile a solved result through the one wasm32-to-codec boundary."""
    target = next(t for t in result['targets']
                  if t['name'] == 'wasm32' and t.get('ok'))
    bits = (result['frontend']['input_bits'],
            result['frontend']['output_bits'])
    return run.artifact_for(target['seq'], *bits)


class TestTheArtifactComputesTheKernel(unittest.TestCase):

    def check(self, name, values=None):
        seq, input_bits, output_bits = minimized(name)
        blob = run.artifact_for(seq, input_bits, output_bits)
        reference = isa_mod.compile_seq(seq)
        mask = (1 << input_bits) - 1
        if values is None:
            values = sorted(set(x & mask for x in PROBES + [mask]))
        got = run.evaluate_many(blob, values, input_bits, output_bits)
        self.assertEqual(got, [reference(x) for x in values],
                         'the artifact for %s computes a different function'
                         % name)
        return blob

    def test_an_eight_bit_kernel_over_its_whole_domain(self):
        # The one exhaustive case. `starts8` lowers to pure wiring and gates,
        # so all 256 inputs are affordable and the claim is a proof rather than
        # a sample.
        self.check('starts8', values=list(range(256)))

    def test_every_shape_the_lowering_has_to_handle(self):
        for name in CASES:
            with self.subTest(example=name):
                self.check(name)

    def test_the_dynamic_gather(self):
        # PEXT_DYN is a rank computation, not wiring: the artifact is two
        # thirds of a megabyte and each input walks all of it.
        self.check('select8', values=[0, 1, 0x5A, 0xFF])

    def test_the_artifact_is_a_canonical_round_trip(self):
        seq, input_bits, output_bits = minimized('starts8')
        blob = run.artifact_for(seq, input_bits, output_bits)
        payload = codec.unpack(blob)
        picture = image.parse(payload)
        self.assertIsNot(picture, image.DEAD)
        self.assertEqual(image.serialize(picture), payload)

    def test_reading_twice_gives_the_same_byte(self):
        # `read` never commits, so the stream moves only on a feed. If it did
        # not hold, the second output byte would depend on who looked first.
        seq, input_bits, output_bits = minimized('ranks8')
        blob = run.artifact_for(seq, input_bits, output_bits)
        residual = machine.feed_all(machine.open_payload(codec.unpack(blob)), [5])
        self.assertEqual([machine.read(residual) for _ in range(4)], [0] * 4)

    def test_a_feed_advances_the_output_stream(self):
        seq, input_bits, output_bits = minimized('ranks8')
        blob = run.artifact_for(seq, input_bits, output_bits)
        residual = machine.feed_all(machine.open_payload(codec.unpack(blob)), [255])
        seen = []
        for _ in range(8):
            seen.append(machine.read(residual))
            residual = machine.feed(residual, 0)
        # ranks8(0xFF) is the byte-lane iota, so the stream is 0..7.
        self.assertEqual(seen, list(range(8)))

    def test_a_lookup_table_has_a_vm_form(self):
        from qm.isa import Seq
        seq = Seq()
        seq.emit('LUT', [0], const=(19, 3, 41, 7, 23, 11, 29, 5))
        picture = lower.lower_seq(seq, 8, 32)
        blob = codec.pack(codec.code(image.serialize(picture)))
        values = [0, 1, 7, 8, 13, 255]
        expected = [seq.ins[0].const[value & 7] for value in values]
        self.assertEqual(run.evaluate_many(blob, values, 8, 32), expected)


class TestTheThreeEntryArrowsAgree(unittest.TestCase):
    """C, x86-64 and wasm32 in; one artifact out, byte for byte.

    This is the normalization stated as a property rather than as a diagram. If
    the three arrows produced different artifacts, "the program" would still be
    whichever language you happened to paste.
    """

    def test_a_listing_normalizes_to_the_same_artifact_as_its_source(self):
        from_c = solve(read_example('starts8.c'), frontend='cfront')
        primary = next(t for t in from_c['targets']
                       if t['name'] == from_c['primary_target'])
        wasm_target = next((t for t in from_c['targets']
                            if t['name'] == 'wasm32' and t.get('ok')), None)
        self.assertIsNotNone(wasm_target, 'no wasm32 listing to feed back')

        want = artifact_result(from_c)

        for label, listing in (('x86-64', primary['asm']),
                               ('wasm32', wasm_target['asm'])):
            with self.subTest(entry=label):
                back = solve(listing)
                self.assertTrue(back['ok'], back.get('error'))
                self.assertEqual(artifact_result(back), want,
                                 '%s came back as a different artifact' % label)


@unittest.skipUnless(shutil.which('node'), 'needs node')
class TestTheShippedModuleRunsTheSameArtifacts(unittest.TestCase):
    """`web/vm.wasm` is what the page runs, so it is what gets checked.

    The reference in `vm/machine.py` and the compiled machine are run on the same
    artifacts and required to agree. A committed binary that had drifted from
    `vm.c` would pass every Python test in the suite and be wrong in the only
    place it is used.
    """

    def setUp(self):
        self.assertTrue(os.path.exists(SHIPPED_WASM),
                        'run vm/wasm/build.py --out web/vm.wasm')

    def test_the_shipped_module_is_the_current_source(self):
        if not shutil.which('clang'):
            self.skipTest('needs clang')
        with tempfile.TemporaryDirectory() as tmp:
            fresh = os.path.join(tmp, 'vm.wasm')
            build = subprocess.run(
                ['python3', os.path.join(ROOT, 'vm', 'wasm', 'build.py'),
                 '--out', fresh],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            with open(fresh, 'rb') as handle:
                rebuilt = handle.read()
            fresh_base = os.path.splitext(fresh)[0]
            rebuilt_delivery = {}
            for extension in ('.pages', '-regions.pages', '-steps.pages', '.json'):
                with open(fresh_base + extension, 'rb') as handle:
                    rebuilt_delivery[extension] = handle.read()
        with open(SHIPPED_WASM, 'rb') as handle:
            shipped = handle.read()
        self.assertEqual(shipped, rebuilt,
                         'web/vm.wasm is stale; rebuild it from vm.c')
        shipped_base = os.path.splitext(SHIPPED_WASM)[0]
        for extension in ('.pages', '-regions.pages', '-steps.pages', '.json'):
            with open(shipped_base + extension, 'rb') as handle:
                shipped_delivery = handle.read()
            self.assertEqual(
                shipped_delivery, rebuilt_delivery[extension],
                'web/vm%s is stale; rebuild it from vm.c' % extension)

    def drive(self, blob, values, input_bits, output_bits):
        """Every input in one node run; spawning per input is all overhead."""
        in_bytes = -(-input_bits // 8)
        with tempfile.TemporaryDirectory() as tmp:
            driver = os.path.join(tmp, 'drive.mjs')
            with open(driver, 'w') as handle:
                handle.write(DRIVER)
            job = {
                'artifact': list(blob),
                'out': -(-output_bits // 8),
                'cases': [[(x >> (8 * k)) & 0xFF for k in range(in_bytes)]
                          for x in values],
            }
            result = subprocess.run(['node', driver, SHIPPED_WASM],
                                    input=json.dumps(job),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def check(self, name, values):
        seq, input_bits, output_bits = minimized(name)
        blob = run.artifact_for(seq, input_bits, output_bits)
        got = self.drive(blob, values, input_bits, output_bits)
        self.assertNotIn('error', got, got.get('error'))
        reference = isa_mod.compile_seq(seq)
        self.assertEqual([int(v) for v in got['outputs']],
                         [reference(x) for x in values],
                         'the compiled machine disagrees on %s' % name)
        # And with the Python machine, on the same artifact, so a failure says
        # which of the two moved.
        self.assertEqual([int(v) for v in got['outputs']],
                         run.evaluate_many(blob, values, input_bits,
                                           output_bits))

    def drive_kernel_abi(self, blob, values, input_bits, output_bits):
        with tempfile.TemporaryDirectory() as tmp:
            driver = os.path.join(tmp, 'eval.mjs')
            with open(driver, 'w') as handle:
                handle.write(EVAL_DRIVER)
            job = {'artifact': list(blob), 'input_bits': input_bits,
                   'output_bits': output_bits,
                   'in_bytes': -(-input_bits // 8),
                   'out_bytes': -(-output_bits // 8),
                   'values': [str(value) for value in values]}
            result = subprocess.run(['node', driver, SHIPPED_WASM],
                                    input=json.dumps(job),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def drive_byte_combine(self, blob, sources, fixed_bytes):
        with tempfile.TemporaryDirectory() as tmp:
            driver = os.path.join(tmp, 'combine.mjs')
            with open(driver, 'w') as handle:
                handle.write(BYTE_COMBINE_DRIVER)
            job = {
                'artifact': list(blob),
                'sources': [list(source) for source in sources],
                'fixed_bytes': list(fixed_bytes),
            }
            result = subprocess.run([
                'node', driver, SHIPPED_WASM,
                Path(VM_JS).resolve().as_uri(),
            ],
                                    input=json.dumps(job),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def drive_erasure_recovery(self, blob, geometry, rows, target,
                               unavailable):
        with tempfile.TemporaryDirectory() as tmp:
            driver = os.path.join(tmp, 'recover.mjs')
            with open(driver, 'w') as handle:
                handle.write(ERASURE_DRIVER)
            job = {
                'artifact': list(blob),
                'data_shards': geometry.data_shards,
                'parity_shards': geometry.parity_shards,
                'ordinal_by_mask': list(geometry.ordinal_by_mask),
                'coefficients': list(geometry.coefficients),
                'rows': [list(row) for row in rows],
                'target': target,
                'unavailable': list(unavailable),
            }
            result = subprocess.run([
                'node', driver, SHIPPED_WASM,
                Path(ERASURE_JS).resolve().as_uri(),
            ], input=json.dumps(job), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_the_wasm_kernel_abi_runs_the_same_minimized_artifact(self):
        seq, input_bits, output_bits = minimized('ranks8')
        blob = run.artifact_for(seq, input_bits, output_bits)
        values = [0, 1, 5, 255, 5]
        got = self.drive_kernel_abi(blob, values, input_bits, output_bits)
        self.assertTrue(got['ok'], got)
        reference = isa_mod.compile_seq(seq)
        self.assertEqual([int(value) for value in got['outputs']],
                         [reference(value) for value in values])
        self.assertEqual(got['calls'], len(values))
        self.assertEqual(got['misses'], len(set(values)))

    def test_the_kernel_abi_carries_an_i64_result(self):
        result = solve('''
            #include <stdint.h>
            uint64_t repeat8(uint8_t c) {
                return (uint64_t)c * 0x0101010101010101ull;
            }
        ''', frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        blob = artifact_result(result)
        values = [0, 1, 65, 255, 65]
        got = self.drive_kernel_abi(blob, values, 8, 64)
        self.assertTrue(got['ok'], got)
        self.assertEqual([int(value) for value in got['outputs']],
                         [value * 0x0101010101010101 for value in values])
        self.assertEqual(got['misses'], len(set(values)))

    def test_byte_vectors_use_the_exact_sixteen_bit_cache_inside_wasm(self):
        source_path = os.path.join(
            os.path.dirname(os.path.dirname(ROOT)), 'corpus', 'storage',
            'erasure_gf256_mul.c')
        with open(source_path, encoding='utf-8') as handle:
            result = solve(handle.read(), frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        blob = artifact_result(result)
        values = bytes(range(256)) * 2 + b'\x00'
        sources = [values, values[::-1]]
        coefficients = [0x1d, 0x53]
        got = self.drive_byte_combine(blob, sources, coefficients)

        def multiply(left, right):
            product = 0
            for _ in range(8):
                product ^= left if right & 1 else 0
                left = ((left << 1) & 0xff) ^ (0x1d if left & 0x80 else 0)
                right >>= 1
            return product

        expected = [multiply(left, coefficients[0])
                    ^ multiply(right, coefficients[1])
                    for left, right in zip(*sources)]
        self.assertTrue(got['ok'], got)
        self.assertEqual(got['first'], expected)
        self.assertEqual(got['second'], expected)
        self.assertEqual(got['calls_after_first'], len(values) * len(sources))
        self.assertEqual(got['calls_after_second'], 2 * len(values) * len(sources))
        self.assertLessEqual(got['misses_after_first'], 512)
        self.assertEqual(got['misses_after_second'], got['misses_after_first'])

    def test_ciphertext_erasure_recovery_has_no_scalar_browser_path(self):
        source_path = os.path.join(
            os.path.dirname(os.path.dirname(ROOT)), 'corpus', 'storage',
            'erasure_gf256_mul.c')
        with open(source_path, encoding='utf-8') as handle:
            result = solve(handle.read(), frontend='cfront')
        self.assertTrue(result['ok'], result.get('error'))
        blob = artifact_result(result)
        geometry = build_erasure_recovery_directory(3, 2)
        data = [bytes((slot * 43 + index) & 255 for index in range(1025))
                for slot in range(3)]
        rows = [_combine(coefficients, data, len(data[0]))
                for coefficients in _generator(3, 2)]
        got = self.drive_erasure_recovery(
            blob, geometry, rows, target=1, unavailable=(0,))

        self.assertTrue(got['ok'], got)
        self.assertEqual(got['first'], list(data[1]))
        self.assertEqual(got['second'], list(data[1]))
        self.assertGreater(got['calls_after_first'], 0)
        self.assertEqual(got['calls_after_second'], 2 * got['calls_after_first'])
        self.assertEqual(got['misses_after_second'], got['misses_after_first'])

    def test_it_agrees_on_an_eight_bit_kernel(self):
        self.check('ranks8', [0, 1, 5, 128, 254, 255])

    def test_it_agrees_on_a_sixteen_bit_kernel(self):
        self.check('morton_dilate16', [0, 1, 0x1234, 0xFFFF])

    def test_it_agrees_where_the_adders_are(self):
        self.check('eq_spread8', [0, 0x2C, 0x2C2C2C2C2C2C2C2C,
                                  0xFFFFFFFFFFFFFFFF])


DRIVER = '''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const job = JSON.parse(readFileSync(0, 'utf8'));
const mem = new Uint8Array(E.memory.buffer);
const artifact = Uint8Array.from(job.artifact);
mem.set(artifact, E.vm_buffer());
if (!E.vm_load(artifact.length)) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'did not open' }));
} else {
  let bad = null;
  const outputs = [];
  for (const feed of job.cases) {
    // Each input starts from a freshly opened artifact; nothing carries over.
    mem.set(artifact, E.vm_buffer());
    E.vm_load(artifact.length);
    for (const b of feed) {
      const s = E.vm_feed(b);
      if (s !== 1) { bad = `feed ${b} -> ${s}`; break; }
    }
    let out = 0n;
    for (let k = 0; k < job.out && !bad; k += 1) {
      const byte = E.vm_read();
      if (byte < 0) { bad = `read ${k} -> ${byte}`; break; }
      out |= BigInt(byte) << BigInt(8 * k);
      if (k + 1 < job.out) E.vm_feed(0);
    }
    if (bad) break;
    outputs.push(out.toString());
  }
  process.stdout.write(JSON.stringify(
    bad ? { error: bad } : { outputs }));
}
'''

EVAL_DRIVER = '''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const job = JSON.parse(readFileSync(0, 'utf8'));
const artifact = Uint8Array.from(job.artifact);
new Uint8Array(E.memory.buffer).set(artifact, E.vm_buffer());
const prepared = E.vm_prepare_eval(
  artifact.length, job.input_bits, job.in_bytes, job.out_bytes);
const input = job.input_bits > 32 ? 'i64' : 'i32';
const output = job.output_bits > 32 ? 'i64' : 'i32';
const evaluate = E[`vm_eval_${input}_${output}`];
const outputs = prepared ? job.values.map(value => {
  const argument = input === 'i64' ? BigInt(value) : Number(BigInt(value));
  const result = evaluate(argument);
  return BigInt.asUintN(job.output_bits, BigInt(result)).toString();
}) : [];
process.stdout.write(JSON.stringify({
  ok: Boolean(prepared && E.vm_eval_ok()), outputs,
  calls: E.vm_eval_calls(), misses: E.vm_eval_misses(),
  table_full: E.vm_table_full(), load_error: E.vm_load_error(),
  dead: E.vm_dead(),
}));
'''

BYTE_COMBINE_DRIVER = '''\
import { readFileSync } from 'node:fs';
const V = await import(process.argv[3]);
const module = await WebAssembly.compile(readFileSync(process.argv[2]));
const job = JSON.parse(readFileSync(0, 'utf8'));
const artifact = Uint8Array.from(job.artifact);
const combiner = await V.prepareByteCombiner(artifact, module);
const sources = job.sources.map(source => Uint8Array.from(source));
const run = () => {
  return Array.from(combiner.combine(sources, job.fixed_bytes));
};
const first = run();
const callsAfterFirst = combiner.calls();
const missesAfterFirst = combiner.misses();
const second = run();
process.stdout.write(JSON.stringify({
  ok: combiner.ok(), first, second,
  calls_after_first: callsAfterFirst,
  misses_after_first: missesAfterFirst,
  calls_after_second: combiner.calls(),
  misses_after_second: combiner.misses(),
}));
'''

ERASURE_DRIVER = '''\
import { readFileSync } from 'node:fs';
const R = await import(process.argv[3]);
const module = await WebAssembly.compile(readFileSync(process.argv[2]));
const job = JSON.parse(readFileSync(0, 'utf8'));
const geometry = {
  dataShards: job.data_shards,
  parityShards: job.parity_shards,
  ordinalByMask: Int16Array.from(job.ordinal_by_mask),
  coefficients: Uint8Array.from(job.coefficients),
};
const recover = await R.createErasureRecovery({
  artifact: Uint8Array.from(job.artifact), geometries: [geometry],
  precompiled: module,
});
const rows = job.rows.map(row => Uint8Array.from(row));
const unavailable = new Set(job.unavailable);
const directory = {
  groups: [{
    dataShards: job.data_shards,
    rows: rows.map((_row, slot) => ({ slot })),
  }],
};
const fetch = async candidate => {
  if (unavailable.has(candidate.slot)) throw new Error('unavailable');
  return rows[candidate.slot];
};
const request = {
  directory, group: 0, target: job.target, fetch,
};
const first = Array.from(await recover(request));
const callsAfterFirst = recover.calls();
const missesAfterFirst = recover.misses();
const second = Array.from(await recover(request));
process.stdout.write(JSON.stringify({
  ok: recover.ok(), first, second,
  calls_after_first: callsAfterFirst,
  misses_after_first: missesAfterFirst,
  calls_after_second: recover.calls(),
  misses_after_second: recover.misses(),
}));
'''
