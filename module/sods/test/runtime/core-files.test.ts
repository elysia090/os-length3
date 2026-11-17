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
  const into = new Uint8Array(5).fill(33);
  assert.equal(a.readInto(1, into, 2, 99), 2);
  assert.deepEqual([...into], [33, 33, 108, 100, 33]);
  assert.throws(() => a.readInto(0, into, 4, 3), RangeError);
  assert.equal(a.readInto(99, into, 5, 1), 0);
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

test('real core owns the read lease and rejects overwrite and invalid completion', {skip: !wasm}, () => {
  const exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm!)), {}).exports;
  const call = (name: string, ...args: number[]) => (exports[name] as (...n: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  assert.equal(call('files_abi_version'), 3);
  assert.equal(call('files_init', 32), 0);
  assert.equal(call('files_input', 3), 0);
  new Uint8Array(memory.buffer, call('files_ptr'), 3).set(enc.encode('abc'));
  const id = call('files_create'); assert.ok(id > 0);
  const operation = call('files_read_begin', id, 0, 8); assert.ok(operation > 0);
  assert.equal(call('files_input', 2), -6);
  assert.equal(call('files_create'), -6);
  assert.equal(call('files_write', id, 0), -6);
  assert.equal(call('files_read_begin', id, 0, 2), -6);
  assert.equal(call('files_truncate', id, 1), -6);
  assert.equal(call('files_close', id), -6);
  assert.equal(dec.decode(new Uint8Array(memory.buffer, call('files_ptr'), call('files_len'))), 'abc');
  assert.equal(call('files_read_finish', operation + 1, 0, 3), -7);
  assert.equal(call('files_read_finish', operation, 0, 2), -7);
  assert.equal(call('files_read_finish', operation, 2, 0), -7);
  assert.equal(call('files_close', id), -6);
  assert.equal(call('files_read_finish', operation, 0, 3), 3);
  assert.equal(call('files_read_finish', operation, 0, 3), -7);
  const next = call('files_read_begin', id, 0, 1); assert.ok(next > operation);
  assert.equal(call('files_read_finish', next, 1, 0), 0);
  assert.equal(call('files_close', id), 0);
});

test('previous files ABI is rejected rather than assumed compatible', async () => {
  const name = [...enc.encode('files_abi_version')];
  const section = (id: number, data: number[]) => [id, data.length, ...data];
  const module = new WebAssembly.Module(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 1, 0x7f]), ...section(3, [1, 0]),
    ...section(7, [1, name.length, ...name, 0, 0]), ...section(10, [1, 4, 0, 0x41, 1, 0x0b]),
  ]));
  await assert.rejects(loadCoreFiles(module, 8), /Unsupported core files ABI/);
});
