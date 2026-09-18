// Measure one already-built VM module at its public byte boundary.
//
//   node bench.mjs vm.wasm BASE64_ARTIFACT [iterations]
//
// Loading is outside the timed region. The checksum makes every read visible
// to the host so a JavaScript engine cannot discard the loop.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const [modulePath, encoded, countText = '1000000'] = process.argv.slice(2);
if (!modulePath || !encoded) {
  throw new Error('usage: node bench.mjs vm.wasm BASE64_ARTIFACT [iterations]');
}

const bytes = readFileSync(modulePath);
const compileStarted = performance.now();
const module = await WebAssembly.compile(bytes);
const compileMs = performance.now() - compileStarted;
const instantiateStarted = performance.now();
const instance = await WebAssembly.instantiate(module, {});
const instantiateMs = performance.now() - instantiateStarted;
const E = instance.exports;
const artifact = Buffer.from(encoded, 'base64');
new Uint8Array(E.memory.buffer).set(artifact, E.vm_buffer());
const openStarted = performance.now();
if (!E.vm_load(artifact.length)) throw new Error('vm_load rejected artifact');
const openMs = performance.now() - openStarted;

const iterations = Number(countText);
let checksum = 0;
const start = performance.now();
for (let i = 0; i < iterations; i += 1) {
  const byte = i & 255;
  if (E.vm_feed(byte) !== 1) throw new Error(`vm_feed failed at ${i}`);
  checksum = (checksum + E.vm_read()) >>> 0;
}
const elapsedMs = performance.now() - start;
console.log(JSON.stringify({
  iterations,
  directByteState: E.vm_direct_byte_state ? E.vm_direct_byte_state() : 0,
  moduleBytes: bytes.length,
  memoryBytes: E.memory.buffer.byteLength,
  compileMs,
  instantiateMs,
  openMs,
  elapsedMs,
  nanosecondsPerFeedRead: elapsedMs * 1e6 / iterations,
  checksum,
}));
