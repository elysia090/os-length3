import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
import {Vfs, FsError, E, type Mapping} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {Mirror} from '../../runtime/linux/mirror.ts';
const wasm = process.env.SODS_FILE_STORE_WASM, enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]) =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
const errno = (n: number) => (e: unknown) => e instanceof FsError && e.errno === n;

test('Rust payload participates in real Vfs/open/read/write and preserves replaced open inode', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs = new Vfs();
  const old = scope.writeFile(vfs, '/tmp/a', 'abcdef');
  const k = new Kernel({vfs, translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  p.bytes.set(enc.encode('/tmp/a\0'), 1024);
  const fd = Number(call(p, 2, 1024, 2)); assert.ok(fd >= 0);
  scope.writeFile(vfs, '/tmp/a', 'new');
  assert.equal(call(p, 0, fd, 4096, 3), 3n);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4099)), 'abc');
  p.bytes.set(enc.encode('XY'), 4096);
  assert.equal(call(p, 1, fd, 4096, 2), 2n);
  assert.equal(dec.decode(old.bytes()), 'abcXYf');
  assert.equal(dec.decode(vfs.readFile('/tmp/a')), 'new');
  const version = old.version;
  p.bytes.fill(65, 4096, 4129);
  assert.equal(call(p, 18, fd, 4096, 33, 0), -27n); // input alone exceeds scope limit
  assert.equal(call(p, 18, fd, 4096, 2, 31), -27n); // short input with overflowing extent
  assert.equal(old.version, version);
  assert.equal(call(p, 77, fd, 33), -27n);
  assert.equal(dec.decode(old.bytes()), 'abcXYf');
  const address = Number(call(p, 9, 8192, 4096, 3, 0x11, fd, 0));
  assert.equal(address, 8192);
  assert.equal(dec.decode(p.bytes.subarray(address, address + 6)), 'abcXYf');
  assert.equal(call(p, 3, fd), 0n);
  p.bytes[address + 1] = 90;
  assert.equal(dec.decode(old.bytes()), 'aZcXYf');
  old.write(2, enc.encode('Q'));
  assert.equal(p.bytes[address + 2], 81);
  assert.equal(call(p, 11, address, 4096), 0n);
  assert.equal(dec.decode(old.bytes()), 'aZQXYf');
  assert.throws(() => old.data, errno(E.OPNOTSUPP));
  assert.throws(() => old._data, errno(E.OPNOTSUPP));
  scope.dispose(); scope.dispose();
  assert.throws(() => old.bytes(), /scope is closed/);
});

test('Rust payload is the sole file authority for shared mappings, truncation and Mirror', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs = new Vfs();
  const file = scope.writeFile(vfs, '/tmp/a', 'abcdefgh');
  const mirror = new Mirror(vfs, '/tmp');
  const maps: Mapping[] = [0, 1].map(() => ({proc: {bytes: new Uint8Array(16)}, start: 4, length: 8, off: 0}));
  for (const m of maps) { file.readInto(0, m.proc.bytes, m.start, m.length); file.map(m); }
  maps[0].proc.bytes[5] = 88;
  assert.equal(dec.decode(file.bytes()), 'aXcdefgh');
  assert.equal(maps[1].proc.bytes[5], 88);
  file.write(2, enc.encode('YZ'));
  for (const m of maps) assert.equal(dec.decode(m.proc.bytes.subarray(4, 12)), 'aXYZefgh');
  assert.equal(dec.decode(mirror.changes()!.files[0].bytes), 'aXYZefgh');
  assert.equal(mirror.changes(), null);
  const snapshot = file.share();
  file.truncate(2); file.truncate(8);
  assert.deepEqual([...file.bytes()], [97, 88, 0, 0, 0, 0, 0, 0]);
  for (const m of maps) assert.deepEqual([...m.proc.bytes.subarray(4, 12)], [97, 88, 0, 0, 0, 0, 0, 0]);
  assert.equal(dec.decode(snapshot), 'aXYZefgh');
  for (const m of maps) file.unmap(m);
  scope.dispose();
});

test('two real processes retain one Rust inode across replacement, failure and mapping retirement', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs = new Vfs();
  const file = scope.writeFile(vfs, '/tmp/shared', 'abcdefgh');
  const k = new Kernel({vfs, translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const processes = [0, 1].map(() => {
    const p = new Process(k, null);
    p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
    p.bytes.set(enc.encode('/tmp/shared\0'), 1024);
    return p;
  });
  const [a, b] = processes;
  const [fa, fb] = processes.map(p => Number(call(p, 2, 1024, 2)));
  assert.ok(fa >= 0 && fb >= 0);
  assert.equal(call(a, 9, 8192, 4096, 3, 0x11, fa, 0), 8192n);
  assert.equal(call(b, 9, 12288, 4096, 3, 0x11, fb, 0), 12288n);
  a.bytes[8193] = 90;
  assert.equal(call(a, 26, 8192, 4096, 4), 0n);
  assert.equal(b.bytes[12289], 90);
  assert.equal(call(b, 17, fb, 4096, 8, 0), 8n);
  assert.equal(dec.decode(b.bytes.subarray(4096, 4104)), 'aZcdefgh');
  scope.writeFile(vfs, '/tmp/shared', 'replacement');
  assert.equal(call(a, 3, fa), 0n);
  b.bytes.set(enc.encode('XY'), 4096);
  assert.equal(call(b, 18, fb, 4096, 2, 2), 2n);
  assert.equal(dec.decode(file.bytes()), 'aZXYefgh');
  assert.equal(dec.decode(a.bytes.subarray(8192, 8200)), 'aZXYefgh');
  assert.equal(dec.decode(vfs.readFile('/tmp/shared')), 'replacement');
  const version = file.version, before = file.bytes();
  assert.equal(call(b, 18, fb, 4096, 2, 31), -27n);
  assert.equal(call(b, 77, fb, 33), -27n);
  assert.equal(file.version, version);
  assert.deepEqual(file.bytes(), before);
  assert.deepEqual(b.bytes.subarray(12288, 12296), before);
  assert.equal(call(b, 11, 12288, 4096), 0n);
  assert.equal(call(b, 9, 12288, 4096, 3, 0x32, -1, 0), 12288n); // new private anonymous mapping
  b.bytes.fill(77, 12288, 12296);
  file.write(0, enc.encode('Q'));
  assert.equal(a.bytes[8192], 81);
  assert.deepEqual([...b.bytes.subarray(12288, 12296)], new Array(8).fill(77));
  assert.equal(call(b, 11, 12288, 4096), 0n);
  assert.equal(call(b, 3, fb), 0n);
  assert.equal(call(a, 11, 8192, 4096), 0n);
  scope.dispose();
});

test('actual syscall offset commits only after core copy completion, and failed copy releases its lease', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 32), vfs = new Vfs();
  const file = scope.writeFile(vfs, '/tmp/a', 'abcdef');
  const k = new Kernel({vfs, translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  p.bytes.set(enc.encode('/tmp/a\0'), 1024);
  const fd = Number(call(p, 2, 1024, 0)), description = p.fds.get(fd)!;
  const readInto = file.readInto.bind(file);
  // Fault injection at the real adapter's copy destination, not a mocked core.
  file.readInto = (start, _into, _at, length, ready) => readInto(start, new Uint8Array(0), 0, length, ready);
  assert.throws(() => call(p, 0, fd, 4096, 2), RangeError);
  assert.equal(description.offset, 0);
  assert.deepEqual([...p.bytes.subarray(4096, 4098)], [0, 0]);
  file.readInto = readInto;
  assert.equal(call(p, 0, fd, 4096, 2), 2n);
  assert.equal(description.offset, 2);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4098)), 'ab');
  assert.equal(call(p, 17, fd, 4096, 2, 4), 2n);
  assert.equal(description.offset, 2);
  for (const [at, value] of [[2048, 4096], [2056, 2], [2064, 8192], [2072, 2]]) p.view.setBigUint64(at, BigInt(value), true);
  assert.equal(call(p, 19, fd, 2048, 2), 4n);
  assert.equal(description.offset, 6);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4098)), 'cd');
  assert.equal(dec.decode(p.bytes.subarray(8192, 8194)), 'ef');
  assert.equal(call(p, 0, fd, 4096, 2), 0n);
  assert.equal(call(p, 3, fd), 0n);
  scope.dispose();
});
