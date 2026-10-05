// Native records through the actual C table dispatcher, not a JS guest loop.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
import {seedNativeSelector} from './selector-observation.mjs';
const [providerFile, directory] = process.argv.slice(2);
if (!providerFile || !directory)
  throw new Error('usage: node check-wasm-dispatch.mjs VM.WASM PURE-NATIVE-RECORD-DIRECTORY');
const provider = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider), [{ module: 'machine', name: 'memory', kind: 'memory' }]);
let comparisons = 0, legacyTwinModules = 0, zeroRepresentatives = 0;
const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
assert(names.length > 0);
for (const name of names) {
  const prefix = path.join(directory, name.slice(0, -5));
  const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  assert(Number.isInteger(meta.operandBinding),'fresh complete C attestation required');
  if (meta.summary?.nativeLegacyPrefixTwin) ++legacyTwinModules;
  const cases = await readFile(`${prefix}.cases`);
  assert.equal(cases.length, 512 * 35 * 8);
  const records = new DataView(cases.buffer, cases.byteOffset, cases.byteLength);
  const masks = await readFile(`${prefix}.flags-masks`).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (masks) assert.equal(masks.length, 512 * 8);
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32 });
  const vm = (await WebAssembly.instantiate(provider, { machine: { memory } })).exports;
  const cut = (await WebAssembly.instantiate(await readFile(`${prefix}.wasm`), { machine: { memory } })).instance.exports.cut;
  const table = vm.__indirect_function_table, slot = table.grow(1);
  assert(slot >= vm.vm_slot_min()); table.set(slot, cut);
  const pageRows = vm.vm_arena_min(), cutRows = pageRows + 512, base = pageRows + 4096;
  const state = base, port = base + 2048, entry = BigInt(meta.entry);
  assert(entry >> 12n === (entry + BigInt(meta.sourceBytes) - 1n) >> 12n);
  const view = new DataView(memory.buffer);
  const codePage = await readFile(`${prefix}.source-page`);
  assert.equal(codePage.length, 4096);
  Buffer.from(memory.buffer, base + 24576, 4096).set(codePage);
  for (let rank = 0; rank < 5; ++rank) {
    const row = pageRows + rank * 32;
    view.setBigUint64(row, BigInt(rank < 4 ? (rank + 1) * 4096 : 0x8000), true);
    view.setUint32(row + 8, (rank + 2) * 4096, true);
    view.setUint32(row + 12, 3, true); view.setUint32(row + 16, 1, true);
  }
  const shifts = [39n, 30n, 21n, 12n];
  for (let rank = 0; rank < 4; ++rank) {
    const at = base + (rank + 2) * 4096 + Number((entry >> shifts[rank]) & 511n) * 8;
    view.setBigUint64(at, BigInt(rank === 3 ? 0x8000 : (rank + 2) * 4096) | 103n, true);
  }
  view.setBigUint64(cutRows, entry, true);
  view.setUint32(cutRows + 8, meta.sourceBytes, true);
  view.setUint32(cutRows + 12, meta.instructions, true);
  view.setUint32(cutRows + 16, slot, true);
  view.setUint32(cutRows + 20, meta.operandBinding, true);
  assert.equal(vm.vm_open(base,memory.buffer.byteLength - base,4096,pageRows,5,5,pageRows + 1024,9n), 0);
  assert.equal(vm.vm_bind_state(state), 0);
  const bind = () => assert.equal(vm.vm_bind_execution(cutRows, 1, 9n), 0);
  for (let row = 0; row < 512; ++row) {
    const word = rank => records.getBigUint64((row * 35 + rank) * 8, true);
    new Uint8Array(memory.buffer, state, 4096).fill(0xa5);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8, word(reg), true);
    view.setBigUint64(state + 384, entry, true); view.setBigUint64(state + 392, word(16), true);
    view.setBigUint64(state + 400, 0x80010001n, true); view.setBigUint64(state + 408, 0x1000n, true);
    view.setBigUint64(state + 416, 32n, true); view.setBigUint64(state + 424, 0xd00n, true);
    view.setBigUint64(state + 432 + 7 * 8, 0x10n, true);
    seedNativeSelector(view, state, meta);
    seedDisabledDebug(view, state);
    view.setBigUint64(state + 1128, 42n, true); view.setBigUint64(port, 9n, true);
    bind(); const saved = Buffer.from(memory.buffer, state, meta.stateBytes).slice();
    assert.equal(vm.vm_run(port, 9n, 1), 1n, `${name}: C table/native row ${row}`);
    const expected = new DataView(saved.buffer, saved.byteOffset, saved.byteLength);
    for (let reg = 0; reg < 16; ++reg) expected.setBigUint64(reg * 8, word(17 + reg), true);
    if (meta.summary?.undefinedZeroDestination
        && !(word(meta.summary.source) & ((1n<<BigInt(meta.summary.width))-1n))) {
      expected.setBigUint64(meta.summary.destination*8,word(meta.summary.destination),true);
      ++zeroRepresentatives;
    }
    expected.setBigUint64(384, word(34), true); expected.setBigUint64(1128, 42n + BigInt(meta.instructions), true);
    const flags = view.getBigUint64(state + 392, true);
    const mask = masks ? masks.readBigUInt64LE(row * 8) : BigInt(meta.flagsMask);
    assert.equal(flags & mask, word(33) & mask, `${name}: defined flags row ${row}`);
    expected.setBigUint64(392, flags, true);
    assert.deepEqual(Buffer.from(memory.buffer, state, meta.stateBytes), saved);
    assert.equal(vm.vm_completed(), 1); assert.equal(vm.vm_source_retired(), BigInt(meta.instructions));
    ++comparisons;
  }
  // Missing, stale and changed context must not execute even one function.
  view.setBigUint64(state + 384, entry + 1n, true); bind();
  const saved = Buffer.from(memory.buffer, state, meta.stateBytes).slice();
  assert.equal(vm.vm_run(port, 9n, 2), 6n); assert.equal(vm.vm_completed(), 0);
  assert.deepEqual(Buffer.from(memory.buffer, state, meta.stateBytes), saved);
  view.setBigUint64(state + 384, entry, true); bind();
  assert.equal(vm.vm_run(port, 8n, 2), 5n); assert.equal(vm.vm_completed(), 0);
  view.setBigUint64(state + 408, 0x2000n, true);
  assert.equal(vm.vm_run(port, 9n, 2), 5n); assert.equal(vm.vm_completed(), 0);
  view.setBigUint64(state + 408, 0x1000n, true); bind();
  // A/D writes can alias executable physical RAM: stop before invoking a stale
  // source snapshot, even when this fetch succeeds at the MMU boundary.
  const rootPte = base + 8192 + Number((entry >> 39n) & 511n) * 8;
  view.setBigUint64(rootPte, view.getBigUint64(rootPte, true) & ~32n, true);
  const beforeFetch = Buffer.from(memory.buffer, state, meta.stateBytes).slice();
  assert.equal(vm.vm_run(port, 9n, 1), 5n); assert.equal(vm.vm_completed(), 0);
  assert.deepEqual(Buffer.from(memory.buffer, state, meta.stateBytes), beforeFetch);
  bind();
  // A successful payload write revokes the code snapshot even outside run.
  view.setBigUint64(port, 9n, true);
  assert.equal(vm.vm_access(port, entry, 1, 2, 0x90n), 0n);
  assert.equal(vm.vm_run(port, 9n, 1), 5n); assert.equal(vm.vm_completed(), 0);
  vm.vm_close(); table.set(slot, null);
}
console.log(`C compiled-table dispatcher/native: green (${names.length} modules, ${comparisons} comparisons; ${legacyTwinModules} legacy-prefix native twins, ${zeroRepresentatives} chosen undefined zero destinations; not Linux boot)`);
