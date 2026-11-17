import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

test('Linux embedding excludes the standalone file-store ABI and its extra state', {skip: !artifact}, () => {
  assert.deepEqual(WebAssembly.Module.exports(moduleOf()).filter(e => e.name.startsWith('files_')), []);
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

const textBytes = (text: string) => new TextEncoder().encode(text);
const fileHost = (shared = false) => {
  const host = memoryHost(moduleOf(), 2, 8);
  const root = host.prepareFiles({inodes: 8, entries: 8, fileBytes: 1024, tables: 4, descriptions: 8, slots: 16, reads: 4});
  const dir = host.directory(root, textBytes('data'));
  const first = host.file(dir, textBytes('first'), textBytes('abcdef'));
  const second = host.file(root, textBytes('second'), textBytes('other'));
  host.sealFiles(16);
  return {host, root, first, second, memory: host.create(1, 2, shared)};
};

test('resident Rust file copies into real memory and commits the same OFD after copy', {skip: !artifact}, () => {
  for (const shared of [false, true]) {
    const {host, first, memory} = fileHost(shared);
    const fd = host.open(first), alias = host.dup(fd), independent = host.open(first);
    const read = host.beginRead(fd, memory, 12, 3);
    assert.equal(host.offset(alias), 0n);
    assert.throws(() => host.seek(alias, 0n), /admission/);
    assert.equal(host.copyRead(read), 3);
    assert.deepEqual(host.capture(memory, 12, 3), textBytes('abc'));
    assert.equal(host.offset(alias), 3n);
    assert.equal(host.offset(independent), 0n);
    assert.deepEqual(host.readResult(read), {state: 'finished', confirmed: 3n, length: 3, cancelRequested: false});
    assert.throws(() => host.copyRead(read), /admission/);
    host.retireRead(read);
    assert.throws(() => host.readResult(read), /Unknown read/);
  }
});

test('pending read retains the old OFD across close and FD number reuse', {skip: !artifact}, () => {
  const {host, first, second, memory} = fileHost();
  const fd = host.open(first), alias = host.dup(fd);
  const read = host.beginRead(fd, memory, 0, 4);
  host.close(fd);
  const replacement = host.open(second);
  assert.equal(replacement, fd);
  assert.equal(host.copyRead(read), 4);
  assert.deepEqual(host.capture(memory, 0, 4), textBytes('abcd'));
  assert.equal(host.offset(alias), 4n);
  assert.equal(host.offset(replacement), 0n);
  host.retireRead(read);
});

test('ready cancellation releases only its reservations and never copies', {skip: !artifact}, () => {
  const {host, first, memory} = fileHost();
  const fd = host.open(first), read = host.beginRead(fd, memory, 0, 4);
  assert.throws(() => host.grow(memory, 1), /admission/);
  host.cancelRead(read);
  assert.equal(host.readResult(read).state, 'cancelled');
  assert.equal(host.offset(fd), 0n);
  assert.deepEqual(host.capture(memory, 0, 4), new Uint8Array(4));
  assert.throws(() => host.copyRead(read), /admission/);
  host.retireRead(read);
  host.seek(fd, 1n);
  const next = host.grow(memory, 1);
  const complete = host.beginRead(fd, next, 65536, 2);
  assert.equal(host.copyRead(complete), 2);
  host.cancelRead(complete);
  assert.equal(host.readResult(complete).state, 'finished');
  assert.equal(host.offset(fd), 3n);
  host.retireRead(complete);
});

test('EOF uses no target view and large file offsets do not truncate to wasm32', {skip: !artifact}, () => {
  const {host, first, memory} = fileHost();
  const fd = host.open(first);
  host.seek(fd, 0xffffffffffffffffn);
  const read = host.beginRead(fd, memory, 999999, 8);
  assert.equal(host.copyRead(read), 0);
  assert.equal(host.offset(fd), 0xffffffffffffffffn);
  host.retireRead(read);
});

test('sealed source mutations and foreign inode/read handles are refused', {skip: !artifact}, () => {
  const a = fileHost(), b = fileHost();
  assert.throws(() => a.host.file(a.root, textBytes('late'), textBytes('bad')), /admission/);
  assert.throws(() => a.host.directory(a.root, textBytes('late')), /admission/);
  assert.throws(() => a.host.sealFiles(16), /admission/);
  assert.throws(() => a.host.open(b.first), /Unknown inode/);
  const fd = a.host.open(a.first), read = a.host.beginRead(fd, a.memory, 0, 1);
  assert.throws(() => b.host.copyRead(read), /Unknown read/);
  a.host.cancelRead(read); a.host.retireRead(read);
});

const readAbi = () => {
  const e = new WebAssembly.Instance(moduleOf()).exports;
  const call = (name: string, ...args: (number | bigint)[]) => (e[name] as (...a: (number | bigint)[]) => number)(...args);
  const result = () => (e.linux_result as () => bigint)();
  const length = () => Number((e.linux_result_length as () => bigint)());
  const state = () => (e.linux_result_state as () => number)();
  const ok = (name: string, ...args: (number | bigint)[]) => { assert.equal(call(name, ...args), 0, name); return result(); };
  const stage = (name: string, bytes: Uint8Array) => {
    const ptr = Number(ok(name, bytes.length));
    new Uint8Array((e.memory as WebAssembly.Memory).buffer, ptr, bytes.length).set(bytes);
  };
  ok('linux_init', 1, 4);
  const root = ok('linux_files_prepare', 4, 4, 1024, 2, 4, 8, 2);
  stage('linux_name', textBytes('source'));
  stage('linux_input', textBytes('abcdef'));
  const inode = ok('linux_tree_file', root, 0o600);
  ok('linux_files_seal', 8);
  const fd = Number(ok('linux_open', inode));
  const memory = new WebAssembly.Memory({initial: 1, maximum: 2});
  const binding = ok('linux_bind', BigInt(memory.buffer.byteLength));
  return {e, call, result, length, state, ok, fd, memory, binding};
};

test('unknown copy retains OFD and memory obligations until a monotone stopped receipt', {skip: !artifact}, () => {
  const a = readAbi();
  const read = a.ok('linux_read_begin', a.fd, a.binding, 10n, 4n);
  const pointer = Number(a.ok('linux_read_start', read));
  assert.equal(a.length(), 4);
  // A protocol fault injection: physically copy two bytes, then report uncertainty.
  {
    const source = new Uint8Array((a.e.memory as WebAssembly.Memory).buffer, pointer, 2);
    new Uint8Array(a.memory.buffer, 10, 2).set(source);
  }
  a.ok('linux_read_receipt', read, 2n, 1);
  assert.equal(a.ok('linux_offset', a.fd), 0n);
  assert.equal(a.ok('linux_read_query', read), 2n);
  assert.equal(a.state() & 0xff, 2);
  assert.ok(a.call('linux_read_start', read) < 0);
  assert.ok(a.call('linux_read_retire', read) < 0);
  assert.ok(a.call('linux_seek', a.fd, 0n) < 0);
  assert.ok(a.call('linux_change', a.binding, 131072n) < 0);
  a.ok('linux_read_cancel', read);
  assert.ok(a.call('linux_read_receipt', read, 1n, 0) < 0);
  a.ok('linux_read_receipt', read, 2n, 0);
  assert.equal(a.ok('linux_offset', a.fd), 2n);
  assert.equal(a.ok('linux_read_query', read), 2n);
  assert.equal(a.state() & 0xff, 3);
  assert.ok(a.state() & 0x100);
  assert.deepEqual(new Uint8Array(a.memory.buffer, 10, 4), new Uint8Array([97, 98, 0, 0]));
  assert.ok(a.call('linux_read_receipt', read, 2n, 0) < 0);
  a.ok('linux_read_retire', read);
  assert.ok(a.call('linux_read_query', read) < 0);
  assert.equal(a.result(), 0n);
});

test('read-owned actions reject generic token interference and short-view mutation', {skip: !artifact}, () => {
  const a = readAbi();
  const read = a.ok('linux_read_begin', a.fd, a.binding, 0n, 3n);
  // The first Domain action has sequence 0; knowing it does not grant ownership.
  for (const [name, args] of [
    ['linux_start', [0n]], ['linux_cancel', [0n]], ['linux_retire', [0n]],
    ['linux_receipt', [0n, 3n, 0]],
  ] as const) assert.ok(a.call(name, ...args) < 0, name);
  const pointer = Number(a.ok('linux_read_start', read));
  assert.equal(a.length(), 3);
  assert.ok(a.call('linux_open', 1n) < 0);
  assert.ok(a.call('linux_bind', 0n) < 0);
  assert.ok(a.call('linux_span', a.binding, 0n, 1n) < 0);
  assert.ok(a.call('linux_close', a.fd) < 0);
  assert.ok(a.call('linux_files_prepare', 4, 4, 10, 2, 4, 8, 2) < 0);
  {
    const source = new Uint8Array((a.e.memory as WebAssembly.Memory).buffer, pointer, 3);
    new Uint8Array(a.memory.buffer, 0, 3).set(source);
  }
  a.ok('linux_read_receipt', read, 3n, 0);
  assert.equal(a.ok('linux_offset', a.fd), 3n);
  a.ok('linux_read_retire', read);
});

test('terminal observations retain result capacity but no guest lifetime lease', {skip: !artifact}, () => {
  const {host, first, memory} = fileHost();
  const fd = host.open(first), finished = [];
  for (let i = 0; i < 4; i++) {
    const read = host.beginRead(fd, memory, i, 1);
    assert.equal(host.copyRead(read), 1);
    finished.push(read);
  }
  assert.throws(() => host.beginRead(fd, memory, 4, 1), /admission/);
  const grown = host.grow(memory, 1);
  for (const read of finished) {
    assert.equal(host.readResult(read).state, 'finished');
    host.retireRead(read);
  }
  const read = host.beginRead(fd, grown, 65536, 2);
  assert.equal(host.copyRead(read), 2);
  assert.deepEqual(host.capture(grown, 65536, 2), textBytes('ef'));
  host.retireRead(read);
});

const lazyHost = (size = 1) => {
  const host = memoryHost(moduleOf(), 3, 12);
  const root = host.prepareFiles({inodes: 8, entries: 8, fileBytes: 1024, tables: 4, descriptions: 8, slots: 16, reads: 8});
  const lazy = host.lazyFile(root, textBytes('lazy'), 7, size);
  const other = host.file(root, textBytes('other'), textBytes('other'));
  host.sealFiles(16);
  const admitted = host.execution(host.create(1, 2), new Uint8Array(0));
  return {host, lazy, other, ...admitted, fd: host.open(lazy)};
};

test('managed lazy delivery uses actual source size then reads resident payload without a new load', {skip: !artifact}, () => {
  const {host, fd, execution, memory} = lazyHost();
  const first = host.beginManagedRead(execution, fd, 32, 4);
  assert.equal(host.readResult(first).state, 'load-ready');
  const load = host.startLoad(first);
  assert.equal(load.source, 7);
  const input = textBytes('abcd');
  host.finishLoad(first, load.attempt, input); input.fill(99);
  assert.equal(host.copyRead(first), 4);
  assert.equal(host.offset(fd), 4n);
  assert.deepEqual(host.capture(memory, 32, 4), textBytes('abcd'));
  host.retireRead(first); host.seek(fd, 0n);
  const next = host.beginManagedRead(execution, fd, 48, 4);
  assert.equal(host.readResult(next).state, 'ready');
  assert.throws(() => host.startLoad(next), /admission/);
  assert.equal(host.copyRead(next), 4);
  host.retireRead(next);
});

test('managed requested range is checked before source admission, including metadata EOF', {skip: !artifact}, () => {
  const {host, fd, execution} = lazyHost();
  host.seek(fd, 99n);
  assert.throws(() => host.beginManagedRead(execution, fd, 65536, 1), /admission/);
  host.seek(fd, 0n); // failure did not reserve the original OFD
  const read = host.beginManagedRead(execution, fd, 0, 1);
  const load = host.startLoad(read);
  assert.equal(load.attempt, 1); // failed range did not begin a source attempt
  host.finishLoad(read, load.attempt, textBytes('a'));
  assert.equal(host.copyRead(read), 1);
});

test('cancelled started loader is retired once; late bytes do not become a new read', {skip: !artifact}, () => {
  const {host, fd, execution, memory} = lazyHost();
  const read = host.beginManagedRead(execution, fd, 8, 3);
  const load = host.startLoad(read);
  host.cancelRead(read);
  assert.equal(host.readResult(read).state, 'loading');
  assert.throws(() => host.retireRead(read), /admission/);
  assert.throws(() => host.seek(fd, 3n), /admission/);
  host.finishLoad(read, load.attempt, textBytes('old'));
  assert.equal(host.readResult(read).state, 'cancelled');
  assert.equal(host.offset(fd), 0n);
  assert.deepEqual(host.capture(memory, 8, 3), new Uint8Array(3));
  assert.throws(() => host.finishLoad(read, load.attempt, textBytes('old')), /admission/);
  host.retireRead(read);
  const fresh = host.beginManagedRead(execution, fd, 8, 3);
  const retry = host.startLoad(fresh); assert.notEqual(retry.attempt, load.attempt);
  host.finishLoad(fresh, retry.attempt, textBytes('new'));
  assert.equal(host.copyRead(fresh), 3);
  assert.deepEqual(host.capture(memory, 8, 3), textBytes('new'));
});

test('image replacement during loading prevents delivery to either incarnation', {skip: !artifact}, () => {
  const {host, fd, execution, memory} = lazyHost();
  const read = host.beginManagedRead(execution, fd, 8, 3), load = host.startLoad(read);
  const next = host.replaceImage(execution, new Uint8Array(16));
  assert.throws(() => host.capture(memory, 8, 3), /Unknown memory/);
  assert.throws(() => host.finishLoad(read, load.attempt, textBytes('abc')), /admission/);
  assert.equal(host.readResult(read).state, 'failed');
  assert.throws(() => host.copyRead(read), /admission/);
  assert.equal(host.offset(fd), 0n);
  assert.deepEqual(host.capture(next, 8, 3), new Uint8Array(3));
  host.retireRead(read);
});

test('source completion keeps the original OFD after close and fd reuse', {skip: !artifact}, () => {
  const {host, fd, other, execution, memory} = lazyHost();
  const dup = host.dup(fd), read = host.beginManagedRead(execution, fd, 8, 3);
  const load = host.startLoad(read);
  host.close(fd); const reused = host.open(other); assert.equal(reused, fd);
  host.finishLoad(read, load.attempt, textBytes('abc'));
  assert.equal(host.copyRead(read), 3);
  assert.equal(host.offset(dup), 3n); assert.equal(host.offset(reused), 0n);
  assert.deepEqual(host.capture(memory, 8, 3), textBytes('abc'));
});

test('same-inode loading reentry poisons the original attempt without fallback', {skip: !artifact}, () => {
  const {host, fd, lazy, execution, memory} = lazyHost();
  const secondFd = host.open(lazy);
  const read = host.beginManagedRead(execution, fd, 8, 3), load = host.startLoad(read);
  assert.throws(() => host.beginManagedRead(execution, secondFd, 32, 3), /admission/);
  assert.throws(() => host.finishLoad(read, load.attempt, textBytes('abc')), /admission/);
  assert.equal(host.readResult(read).state, 'failed');
  assert.deepEqual(host.capture(memory, 8, 3), new Uint8Array(3));
  assert.equal(host.offset(fd), 0n); host.retireRead(read);
  const retry = host.beginManagedRead(execution, fd, 8, 3), fresh = host.startLoad(retry);
  host.finishLoad(retry, fresh.attempt, textBytes('new'));
  assert.equal(host.copyRead(retry), 3);
});


test('stopped source input staging failure releases its reservation without adopting data', {skip: !artifact}, () => {
  const {host, fd, execution} = lazyHost();
  const read = host.beginManagedRead(execution, fd, 0, 3), load = host.startLoad(read);
  assert.throws(() => host.finishLoad(read, load.attempt, new Uint8Array(1025)), /Source completion|admission/);
  assert.equal(host.readResult(read).state, 'failed');
  host.seek(fd, 0n); host.retireRead(read);
  const retry = host.beginManagedRead(execution, fd, 0, 3), next = host.startLoad(retry);
  host.finishLoad(retry, next.attempt, textBytes('abc'));
  assert.equal(host.copyRead(retry), 3);
});

test('Node host-file source transport feeds the same Rust-owned lazy read', {skip: !artifact}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sods-managed-source-'));
  try {
    const path = join(directory, 'input'); writeFileSync(path, 'node-file');
    const {host, fd, execution, memory} = lazyHost(0);
    const read = host.beginManagedRead(execution, fd, 64, 9), load = host.startLoad(read);
    assert.equal(load.source, 7);
    await Promise.resolve(); // no guest/core view lives across host source work
    host.finishLoad(read, load.attempt, readFileSync(path));
    assert.equal(host.copyRead(read), 9);
    assert.equal(host.offset(fd), 9n);
    assert.deepEqual(host.capture(memory, 64, 9), textBytes('node-file'));
    host.retireRead(read);
  } finally { rmSync(directory, {recursive: true}); }
});

test('image-owned mutation tokens and managed canonical views reject generic interference', {skip: !artifact}, () => {
  const a = readAbi(), execution = a.ok('linux_execution_create', a.binding);
  a.ok('linux_image_begin', execution, 65536n);
  // First domain action is the image change; generic paths cannot control it.
  assert.ok(a.call('linux_cancel', 0n) < 0);
  assert.ok(a.call('linux_receipt', 0n, 1n, 0) < 0);
  assert.ok(a.call('linux_retire', 0n) < 0);
  const binding = a.ok('linux_image_finish', execution, 0);
  assert.notEqual(binding, a.binding);
  assert.ok(a.call('linux_change', binding, 65536n) < 0);
  const read = a.ok('linux_managed_read_begin', execution, a.fd, 0n, 3n);
  assert.ok(a.call('linux_image_begin', execution, 65536n) < 0);
  const pointer = Number(a.ok('linux_managed_read_start', execution, read));
  assert.ok(a.call('linux_load_input', 4) < 0);
  assert.ok(a.call('linux_execution_create', binding) < 0);
  new Uint8Array(a.memory.buffer, 0, 3).set(new Uint8Array((a.e.memory as WebAssembly.Memory).buffer, pointer, 3));
  a.ok('linux_read_receipt', read, 3n, 1);
  assert.ok(a.call('linux_image_begin', execution, 65536n) < 0);
  a.ok('linux_read_receipt', read, 3n, 0);
  a.ok('linux_image_begin', execution, 65536n);
  a.ok('linux_image_finish', execution, 1); // no initialization happened
  assert.equal(a.ok('linux_offset', a.fd), 3n);
});
