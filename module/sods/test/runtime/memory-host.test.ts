import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

const artifact = process.env.SODS_LINUX_WASM;
const moduleOf = () => new WebAssembly.Module(readFileSync(artifact!));

test('private host uses real Rust admission for memory capture and growth', {skip: !artifact}, () => {
  for (const shared of [false, true]) {
    const host = memoryHost(moduleOf(), 2, 4);
    const memory = host.create(1, 2, shared);
    const input = new Uint8Array([1, 2, 3]);
    host.write(memory, 9, input); input.fill(99);
    const before = host.capture(memory, 9, 3);
    assert.deepEqual(before, new Uint8Array([1, 2, 3]));
    before.fill(88);
    assert.equal(host.capture(memory, 9, 1)[0], 1);
    assert.throws(() => host.write(memory, 65535, new Uint8Array(2)), /admission/);
    assert.throws(() => host.capture(memory, -1, 1), RangeError);
    const next = host.grow(memory, 1);
    assert.notEqual(next, memory);
    assert.throws(() => host.capture(memory, 9, 1), /Unknown memory/);
    assert.equal(host.capture(next, 9, 1)[0], 1);
    host.write(next, 65536, new Uint8Array([4]));
    assert.equal(host.capture(next, 65536, 1)[0], 4);
  }
});

test('unexpected host mutation failure stays quarantined rather than silently retried', {skip: !artifact}, () => {
  const host = memoryHost(moduleOf(), 1, 2);
  const memory = host.create(1, 1);
  assert.throws(() => host.grow(memory, 1), RangeError);
  assert.throws(() => host.capture(memory, 0, 1), /admission/);
  assert.throws(() => host.grow(memory, 0), /admission/);
});

test('real ABI rejects duplicate starts, stale tokens, premature retire and reinit', {skip: !artifact}, () => {
  const e = new WebAssembly.Instance(moduleOf()).exports;
  const call = (name: string, ...args: (number | bigint)[]) => (e[name] as (...a: (number | bigint)[]) => number)(...args);
  const result = () => (e.linux_result as () => bigint)();
  assert.equal(call('linux_init', 1, 2), 0);
  assert.equal(call('linux_bind', 65536n), 0);
  const m = result();
  assert.equal(call('linux_span', m, 0n, 8n), 0);
  const a = result();
  assert.equal(call('linux_start', a), 0);
  assert.ok(call('linux_start', a) < 0);
  assert.equal(call('linux_receipt', a, 3n, 1), 0);
  assert.ok(call('linux_retire', a) < 0);
  assert.ok(call('linux_change', m, 131072n) < 0);
  assert.equal(call('linux_cancel', a), 0);
  assert.equal(call('linux_receipt', a, 5n, 0), 0);
  assert.equal(call('linux_retire', a), 0);
  assert.equal(call('linux_change', m, 131072n), 0);
  const change = result();
  assert.ok(call('linux_span', m, 0n, 1n) < 0);
  assert.ok(call('linux_start', a) < 0);
  assert.equal(call('linux_start', change), 0);
  assert.equal(call('linux_receipt', change, 1n, 0), 0);
  assert.equal(call('linux_retire', change), 0);
  const next = result();
  assert.notEqual(next, m);
  assert.ok(call('linux_span', m, 0n, 1n) < 0);
  assert.equal(result(), 0n);
  assert.equal(call('linux_span', next, 65536n, 1n), 0);
  assert.ok(call('linux_init', 1, 2) < 0);
  assert.equal(result(), 0n);
});

test('unmatched Wasm artifact is rejected before host memory creation', () => {
  const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.throws(() => memoryHost(empty, 1, 1), /Unsupported/);
});

test('host-local opaque bindings reject foreign and forged handles before effects', {skip: !artifact}, () => {
  const a = memoryHost(moduleOf(), 1, 2), b = memoryHost(moduleOf(), 1, 2);
  const ma = a.create(1, 1), mb = b.create(1, 1);
  for (const foreign of [ma, Object.freeze({kind: 'managed-memory' as const})]) {
    assert.throws(() => b.capture(foreign, 0, 1), /Unknown memory/);
    assert.throws(() => b.write(foreign, 0, new Uint8Array([9])), /Unknown memory/);
    assert.throws(() => b.grow(foreign, 0), /Unknown memory/);
  }
  assert.equal(b.capture(mb, 0, 1)[0], 0);
});


test('captured physical intrinsics cannot expose views through later prototype replacement', {skip: !artifact}, () => {
  const host = memoryHost(moduleOf(), 1, 3);
  const memory = host.create(1, 2);
  const slice = Uint8Array.prototype.slice, set = Uint8Array.prototype.set;
  const grow = WebAssembly.Memory.prototype.grow;
  let callbacks = 0;
  try {
    const replaced = () => { callbacks++; throw new Error('unexpected callback'); };
    Uint8Array.prototype.slice = replaced;
    Uint8Array.prototype.set = replaced;
    WebAssembly.Memory.prototype.grow = replaced;
    host.write(memory, 0, new Uint8Array([7]));
    assert.equal(host.capture(memory, 0, 1)[0], 7);
    const next = host.grow(memory, 1);
    assert.equal(host.capture(next, 0, 1)[0], 7);
  } finally {
    Uint8Array.prototype.slice = slice; Uint8Array.prototype.set = set;
    WebAssembly.Memory.prototype.grow = grow;
  }
  assert.equal(callbacks, 0);
  assert.throws(() => host.create(1, 1), /admission/);
});
