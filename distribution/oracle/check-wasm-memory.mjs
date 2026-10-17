// The access callback is a test double of the C RAM boundary, never a product
// browser backend. Test C preflight independently with vm/check/memory.c.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
import {seedNativeSelector} from './selector-observation.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('usage: node check-wasm-memory.mjs RECORD-DIRECTORY');
const names = (await readdir(directory)).filter(name => /^memory-[0-9]+\.json$/.test(name)).sort();
assert(names.length > 0);
let comparisons = 0;
for (const name of names) {
  const prefix = path.join(directory, name.slice(0, -5));
  const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  assert(Number.isInteger(meta.operandBinding) && meta.operandBinding>=0 && meta.operandBinding<=0xffffffff);
  const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'machine', name: 'memory', kind: 'memory' },
    { module: 'machine', name: 'access', kind: 'function' },
  ]);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  const state = 0, port = 2048, payload = 8192;
  let expectedAddress, expectedValue, currentResult = 0n, calls = 0;
  const instance = await WebAssembly.instantiate(module, { machine: { memory,
    access(offset, address, bytes, access, value) {
      ++calls;
      assert.equal(offset, port);
      assert.equal(BigInt.asUintN(64, address), expectedAddress, `${name}: guest address`);
      assert.equal(bytes, meta.bytes);
      assert.equal(access, meta.access);
      if (currentResult) return currentResult;
      const view = new DataView(memory.buffer);
      if (access & 2) {
        assert.equal(BigInt.asUintN(64, value), expectedValue & ((1n << BigInt(bytes * 8)) - 1n));
        for (let i = 0; i < bytes; ++i)
          view.setUint8(payload + i, Number((value >> BigInt(i * 8)) & 255n));
      } else {
        let loaded = 0n;
        for (let i = 0; i < bytes; ++i) loaded |= BigInt(view.getUint8(payload + i)) << BigInt(i * 8);
        view.setBigUint64(port + 8, loaded, true);
      }
      return 0n;
    },
  } });
  const cases = await readFile(`${prefix}.cases`);
  assert.equal(instance.exports.cut.length,4,'ABI-3 fixture required; regenerate, never adapt old modules');
  assert.equal(cases.length, 512 * 38 * 8);
  const records = new DataView(cases.buffer, cases.byteOffset, cases.byteLength);
  for (let row = 0; row < 512; ++row) {
    if (row === 256) memory.grow(1);
    const all = Buffer.from(memory.buffer); all.fill(0xa5);
    const view = new DataView(memory.buffer);
    const word = rank => records.getBigUint64((row * 38 + rank) * 8, true);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8, word(reg), true);
    view.setBigUint64(meta.ripOffset, BigInt(meta.entry), true);
    view.setBigUint64(meta.flagsOffset, word(16), true);
    view.setBigUint64(meta.retiredOffset, 42n, true);
    seedNativeSelector(view, state, meta);
    seedDisabledDebug(view, state);
    view.setBigUint64(port, 9n, true);
    view.setBigUint64(payload, word(36), true);
    expectedAddress = word(35); expectedValue = word(37);
    const initial = Buffer.from(all);
    const expected = Buffer.from(all);
    const expectedView = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    for (let reg = 0; reg < 16; ++reg) expectedView.setBigUint64(reg * 8, word(17 + reg), true);
    expectedView.setBigUint64(meta.ripOffset, word(34), true);
    expectedView.setBigUint64(meta.flagsOffset, word(33), true);
    expectedView.setBigUint64(meta.retiredOffset, 43n, true);
    if (meta.access & 2) expectedView.setBigUint64(payload, word(37), true);
    else expectedView.setBigUint64(port + 8, word(36) & ((1n << BigInt(meta.bytes * 8)) - 1n), true);
    currentResult = 0n; calls = 0;
    assert.equal(instance.exports.cut(state, port,BigInt(meta.entry),meta.operandBinding), 1n);
    assert.equal(calls, 1, 'one typed C boundary, no per-byte host calls');
    assert.deepEqual(all, expected, `${name}: native memory/register row ${row}`);
    ++comparisons;
    // RF restored by an architectural return is accepted; it clears only
    // after a successful access. It is not a debug-entry refusal like TF.
    all.set(initial); view.setBigUint64(meta.flagsOffset,word(16)|0x10000n,true);
    currentResult=0n; calls=0;
    assert.equal(instance.exports.cut(state,port,BigInt(meta.entry),meta.operandBinding),1n); assert.equal(calls,1);
    assert.deepEqual(all,expected,`${name}: successful memory RF clear`);
    for (const result of [2n, (14n << 3n) | 3n, 5n, 6n]) {
      all.set(initial);
      currentResult = result; calls = 0;
      const saved = Buffer.from(all);
      assert.equal(instance.exports.cut(state, port,BigInt(meta.entry),meta.operandBinding), result);
      assert.equal(calls, 1);
      assert.deepEqual(all, saved, `${name}: failure must not retire/partially commit`);
    }
  }
  const all = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
  view.setBigUint64(meta.ripOffset, BigInt(meta.entry), true);
  view.setBigUint64(meta.flagsOffset, 0x202n, true);
  for (const invalidPort of [1, -1, 0, 8, meta.stateBytes - 8, all.length - 24, all.length]) {
    calls = 0; const saved = Buffer.from(all);
    assert.equal(instance.exports.cut(0, invalidPort,BigInt(meta.entry),meta.operandBinding), 6n, `${name}: invalid/aliased port`);
    assert.equal(calls, 0);
    assert.deepEqual(all, saved);
  }
  for (const invalidState of [1, -1, all.length - meta.stateBytes + 8]) {
    calls = 0; const saved = Buffer.from(all);
    assert.equal(instance.exports.cut(invalidState, port,BigInt(meta.entry),meta.operandBinding), 6n);
    assert.equal(calls, 0); assert.deepEqual(all, saved);
  }
  for (const flags of [0x302n, 0x10302n, 0x40202n]) {
    view.setBigUint64(meta.flagsOffset, flags, true); calls = 0;
    const saved = Buffer.from(all);
    assert.equal(instance.exports.cut(state, port,BigInt(meta.entry),meta.operandBinding), 6n);
    assert.equal(calls, 0); assert.deepEqual(all, saved);
  }
  if (meta.prefixEntry !== meta.entry) {
    const prefixModule = await WebAssembly.compile(await readFile(`${prefix}.prefix.wasm`));
    assert.deepEqual(WebAssembly.Module.imports(prefixModule), [
      { module: 'machine', name: 'memory', kind: 'memory' },
    ]);
    const preceding = await WebAssembly.instantiate(prefixModule, { machine: { memory } });
    view.setBigUint64(meta.ripOffset, BigInt(meta.prefixEntry), true);
    view.setBigUint64(meta.flagsOffset, 0x202n, true);
    view.setBigUint64(meta.retiredOffset, 100n, true);
    const expected = Buffer.from(all);
    const expectedView = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    // Rewind the address to the prefix input; the native memory record starts
    // after that prefix, at the memory cut's architectural entry.
    view.setBigUint64(7 * 8, BigInt.asUintN(64, view.getBigUint64(7 * 8, true) - 8n), true);
    expectedView.setBigUint64(7 * 8, BigInt.asUintN(64, view.getBigUint64(7 * 8, true) + 8n), true);
    expectedView.setBigUint64(meta.ripOffset, BigInt(meta.entry), true);
    expectedView.setBigUint64(meta.retiredOffset, 101n, true);
    calls = 0;
    assert.equal(preceding.exports.cut(state,0,BigInt(meta.prefixEntry),meta.operandBinding), 1n);
    assert.equal(calls, 0); assert.deepEqual(all, expected);
    currentResult = 2n;
    assert.equal(instance.exports.cut(state, port,BigInt(meta.entry),meta.operandBinding), 2n);
    assert.equal(calls, 1);
    assert.deepEqual(all, expected, 'failed memory instruction preserves already committed pure prefix');
  }
}
console.log(`Generated memory cuts/native x86: green (${names.length} modules, ${comparisons} comparisons; C-Wasm provider/MMU/boot not tested)`);
