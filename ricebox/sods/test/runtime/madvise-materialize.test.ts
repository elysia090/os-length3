import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FsError, E} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
function setup() {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null); p.memory = memory();
  p.fixed = []; p.free = []; p.mapBase = 65536; p.mapEnd = 65536; p.stackLow = 0; p.stackTop = 65536;
  return p;
}
function map(p: Process, file: File) {
  p.kernel.vfs.dir('/tmp').entries.set('file', file); p.bytes.set(enc.encode('/tmp/file\0'), 1024);
  const fd = Number(call(p, 2, 1024, 2)); assert.ok(fd >= 0);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n); return fd;
}
test('madvise preserves shared bytes whose canonical TS payload aliases the advised memory', () => {
  const p = setup(); p.bytes.set(enc.encode('abc'), 8192);
  map(p, new File(new Uint8Array(p.memory!.buffer, 8192, 3)));
  assert.equal(call(p, 28, 8192, 4096, 4), 0n);
  assert.equal(dec.decode(p.bytes.subarray(8192, 8195)), 'abc');
  assert.equal(p.bytes[8195], 0);
});
test('later source failure does not zero any part of the advised range', () => {
  const p = setup(), first = new File(new Uint8Array(4096).fill(7)); map(p, first);
  class Later extends File { override snapshotRange(): never { throw new FsError(E.IO); } }
  p.mapShared(new Later(new Uint8Array(4096).fill(8)), 8192, 4096, 0);
  assert.equal(call(p, 28, 8192, 4096, 4), -5n);
  assert.equal(p.bytes[8192], 7); assert.equal(p.maps.length, 2);
});
test('overlapping records retain their previous restoration order', () => {
  const p = setup(); map(p, new File(new Uint8Array(4096).fill(7)));
  p.mapShared(new File(new Uint8Array(4096).fill(8)), 8192, 4096, 0);
  assert.equal(call(p, 28, 8192, 4096, 8), 0n);
  assert.equal(p.bytes[8192], 8);
});
test('madvise source replacement followed by throw retires without unrelated writeback', () => {
  const p = setup(), file = new File(new Uint8Array(4096).fill(7)); map(p, file);
  file.snapshotRange = () => { p.memory = memory(); throw new FsError(E.IO); };
  assert.throws(() => call(p, 28, 8192, 4096, 4), ReadLifetimeError);
  assert.equal(p.state, 'zombie'); assert.equal(file.bytes()[0], 7);
});
