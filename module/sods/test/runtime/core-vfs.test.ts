import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadFileScope} from '../../runtime/linux/core-files.ts';
import {Vfs, FsError, E, type Mapping} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {Mirror} from '../../runtime/linux/mirror.ts';
const wasm = process.env.SODS_CORE_WASM, enc = new TextEncoder(), dec = new TextDecoder();
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
