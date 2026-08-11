import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const wasm = process.argv[2] || new URL('../web/vm.wasm', import.meta.url);
const count = Number(process.argv[3] || 1092);
const rounds = Number(process.argv[4] || 8);
const repeats = Number(process.argv[5] || 7);
const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {});
const E = instance.exports;
const memory = new Uint8Array(E.memory.buffer);
const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
const records = new Uint8Array(count * 24);
const words = new DataView(records.buffer);
for (let index = 0; index < count; index += 1) {
  const at = index * 24;
  words.setUint32(at, index, true);
  words.setUint32(at + 4, index + 1, true);
  words.setUint32(at + 8, index + 2, true);
  words.setUint32(at + 12, index + 3, true);
  words.setBigUint64(at + 16, BigInt(index + 1), true);
}

function run() {
  memory.fill(0, E.vm_sponge_lanes(), E.vm_sponge_lanes() + 200);
  memory.fill(0, E.vm_sponge_tail(), E.vm_sponge_tail() + 136);
  memory.set(seed, E.vm_buffer());
  memory.set(records, E.vm_buffer() + 32);
  if (!E.vm_set_sponge_tail_size(0) || !E.vm_sponge_records(count, rounds)) {
    throw new Error('vm.wasm rejected the benchmark cut');
  }
}

run();
const samples = [];
for (let iteration = 0; iteration < repeats; iteration += 1) {
  const started = performance.now();
  run();
  samples.push(performance.now() - started);
}
samples.sort((left, right) => left - right);
const median = samples[Math.floor(samples.length / 2)];
process.stdout.write(JSON.stringify({
  records: count,
  digests: count * rounds,
  permutations: count * rounds + Math.floor(count * 40 / 136),
  median_ms: median,
  samples_ms: samples,
  tail_bytes: E.vm_sponge_tail_size(),
}, null, 2));
