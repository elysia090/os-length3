import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadCoreFiles} from '../../runtime/core/files.ts';

const wasm = process.env.SODS_CORE_WASM;
const enc = new TextEncoder(), dec = new TextDecoder();
// Explicit artifact input: no downloads, builds, fake core or silent native fallback.
test('real Rust Wasm owns payloads across growth, failure and closed handles', {skip: !wasm}, async () => {
  const files = await loadCoreFiles(readFileSync(wasm!), 200000);
  const input = enc.encode('old');
  const a = files.create(input);
  input.fill(120);
  assert.equal(dec.decode(a.read(0, 99)), 'old');
  const old = a.read(0, 99);
  a.write(5, enc.encode('z'));
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 100, 0, 0, 122]));
  a.truncate(2); a.truncate(6);
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 0, 0, 0, 0]));
  assert.equal(dec.decode(old), 'old');
  assert.throws(() => a.write(0xffffffff, enc.encode('x')));
  assert.throws(() => a.truncate(200001));
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 0, 0, 0, 0]));
  const large = files.create(new Uint8Array(150000).fill(23));
  assert.equal(large.read(149999, 8)[0], 23);
  assert.equal(dec.decode(old), 'old');
  a.close(); a.close();
  const b = files.create(enc.encode('new'));
  assert.throws(() => a.read(0, 1), /closed/);
  assert.equal(dec.decode(b.read(0, 99)), 'new');
  assert.throws(() => b.read(-1, 1), RangeError);
  assert.throws(() => b.write(0.5, input), RangeError);
  assert.throws(() => b.truncate(NaN), RangeError);
  large.close(); b.close();
});

test('unshared file core does not require SharedArrayBuffer global', {skip: !wasm}, async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
  try {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', {value: undefined, configurable: true});
    const files = await loadCoreFiles(readFileSync(wasm!), 8);
    const f = files.create(enc.encode('a'));
    f.write(4, new Uint8Array(0));
    assert.deepEqual(f.read(0, 8), new Uint8Array([97, 0, 0, 0]));
    f.close();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'SharedArrayBuffer', previous);
    else Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
  }
});

test('unversioned modules are rejected before file operations', async () => {
  const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  await assert.rejects(loadCoreFiles(empty, 8), /Unsupported core files ABI/);
});
