import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FsError, E, counted} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {readFileSync} from 'node:fs';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
const enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
const memory = () => Object.assign(new WebAssembly.Memory({initial: 2}), {users: 1, written: [], keeps: false, imageOf: null});
function setup() {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null); p.memory = memory();
  p.fixed = []; p.free = []; p.mapBase = 65536; p.mapEnd = 65536; p.stackLow = 0; p.stackTop = 65536;
  return {k, p};
}
function open(p: Process, file: File, flags = 2) {
  p.kernel.vfs.dir('/tmp').entries.set('file', file);
  p.bytes.set(enc.encode('/tmp/file\0'), 1024);
  const fd = Number(call(p, 2, 1024, flags)); assert.ok(fd >= 0); return fd;
}
test('failed MAP_FIXED source leaves the previous mapping and its bytes intact', () => {
  const {p} = setup(), old = new File(new Uint8Array(4096).fill(7));
  const oldFd = open(p, old);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, oldFd, 0), 8192n);
  const before = p.maps[0], fixed = p.fixed.length;
  const lazy = new File(new Uint8Array(0), 0o644, () => { throw new Error('no source'); });
  const fd = open(p, lazy);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x12, fd, 0), -5n);
  assert.equal(p.maps[0], before); assert.equal(p.maps.length, 1);
  assert.equal(p.fixed.length, fixed); assert.equal(p.bytes[8192], 7);
});

test('MAP_FIXED snapshots an embedding source before zeroing an aliased destination', () => {
  const {p} = setup(); p.bytes.set(enc.encode('abc'), 8192);
  const fd = open(p, new File(new Uint8Array(p.memory!.buffer, 8192, 3)));
  assert.equal(call(p, 9, 8192, 4096, 3, 0x12, fd, 0), 8192n);
  assert.equal(dec.decode(p.bytes.subarray(8192, 8195)), 'abc');
});

test('mremap tail capture failure precedes reserve, unmap and publication', () => {
  const {p} = setup(); let refuse = true;
  class Tail extends File {
    override snapshotRange(start: number, end: number) { if (start === 4096 && refuse) throw new FsError(E.IO); return super.snapshotRange(start, end); }
  }
  const file = new Tail(new Uint8Array(8192).fill(7)), fd = open(p, file);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  const before = p.maps[0], end = p.mapEnd, free = [...p.free];
  assert.equal(call(p, 25, 8192, 4096, 8192), -5n);
  assert.equal(p.maps[0], before); assert.equal(p.mapEnd, end); assert.deepEqual(p.free, free);
  refuse = false;
  assert.equal(call(p, 25, 8192, 4096, 8192), BigInt(end));
  assert.equal(p.maps[0].start, end); assert.equal(p.maps[0].length, 8192);
  assert.equal(p.bytes[end + 4096], 7);
});

test('MAP_FIXED of the same dirty shared inode snapshots after settling, not before', () => {
  const {p} = setup(), file = new File(new Uint8Array(4096).fill(7)), fd = open(p, file);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  const previous = p.maps[0]; p.bytes[8192] = 9;
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  assert.equal(p.bytes[8192], 9); assert.equal(file.bytes()[0], 9);
  assert.notEqual(p.maps[0], previous); assert.equal(p.maps.length, 1);
});

test('a later tail failure leaves all old mappings published and reserves no destination', () => {
  const {p} = setup();
  const first = new File(new Uint8Array(8192).fill(7));
  class Later extends File {
    override snapshotRange(start: number, end: number) { if (start === 4096) throw new FsError(E.IO); return super.snapshotRange(start, end); }
  }
  const later = new Later(new Uint8Array(8192).fill(7)), fd = open(p, first);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  // Explicit multi-record fixture for the mremap source list; later source fails.
  p.mapShared(later, 8192, 4096, 0);
  const maps = [...p.maps], end = p.mapEnd, free = [...p.free];
  assert.equal(call(p, 25, 8192, 4096, 8192), -5n);
  assert.deepEqual(p.maps, maps); assert.equal(p.mapEnd, end); assert.deepEqual(p.free, free);
  assert.equal(p.bytes[8192], 7);
});

const wasm = process.env.SODS_FILE_STORE_WASM;
test('real Rust pending read supplies mmap and mremap snapshots through the existing kernel', {skip: !wasm}, async () => {
  const {p} = setup(), scope = await loadFileScope(readFileSync(wasm!), 16384);
  const file = scope.writeFile(p.kernel.vfs, '/tmp/file', new Uint8Array(8192).fill(7));
  const fd = open(p, file);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  p.bytes[8192] = 9;
  const to = Number(call(p, 25, 8192, 4096, 8192));
  assert.equal(to, 65536); assert.equal(p.bytes[to], 9); assert.equal(p.bytes[to + 4096], 7);
  file.write(5000, Uint8Array.of(12)); assert.equal(p.bytes[to + 5000], 12);
  assert.equal(call(p, 11, to, 8192), 0n); assert.equal(call(p, 3, fd), 0n);
  scope.dispose();
});

test('snapshot replacement then throw is fatal without settling retired mappings from the new memory', () => {
  const {p} = setup(), old = new File(new Uint8Array(4096).fill(7)), oldFd = open(p, old);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, oldFd, 0), 8192n);
  const oldMemory = p.memory!; p.bytes[8192] = 9;
  const lazy = new File(new Uint8Array(0), 0o644, () => {
    p.memory = Object.assign(new WebAssembly.Memory({initial: 2}), {users: 1, written: [], keeps: false, imageOf: null});
    throw new Error('source replaced process memory');
  });
  const fd = open(p, lazy);
  assert.throws(() => call(p, 9, 8192, 4096, 3, 0x12, fd, 0), /lost its process/);
  assert.equal(p.state, 'zombie');
  assert.equal(new Uint8Array(oldMemory.buffer)[8192], 9);
  assert.equal(old.bytes()[0], 7); // no fabricated zero writeback from the replacement memory
});

test('abnormal retirement preserves last committed bytes and another process mapping', () => {
  const {p} = setup(), file = new File(new Uint8Array(4096).fill(7)), fd = open(p, file);
  assert.equal(call(p, 9, 8192, 4096, 3, 0x11, fd, 0), 8192n);
  const q = new Process(p.kernel, null);
  q.memory = Object.assign(new WebAssembly.Memory({initial: 2}), {users: 1, written: [], keeps: false, imageOf: null});
  q.fixed = []; q.free = []; q.mapBase = 65536; q.mapEnd = 65536;
  const qfd = open(q, file);
  assert.equal(call(q, 9, 12288, 4096, 3, 0x11, qfd, 0), 12288n);
  p.bytes[8192] = 9; file.settle();
  const abandoned = p.maps[0], mapped = counted.mapped;
  const lazy = new File(new Uint8Array(0), 0o644, () => {
    p.memory = Object.assign(new WebAssembly.Memory({initial: 2}), {users: 1, written: [], keeps: false, imageOf: null});
    throw new Error('replace while another process retains the file');
  });
  const lazyFd = open(p, lazy);
  assert.throws(() => call(p, 9, 8192, 4096, 3, 0x12, lazyFd, 0), /lost its process/);
  assert.equal(p.maps.length, 0); assert.equal(file.maps!.size, 1);
  assert.equal(file.bytes()[0], 9); assert.equal(q.bytes[12288], 9);
  file.abandon(abandoned); // duplicate discard cannot decrement the global count
  assert.equal(counted.mapped, mapped);
  file.write(0, Uint8Array.of(12)); assert.equal(q.bytes[12288], 12);
  assert.equal(call(q, 11, 12288, 4096), 0n);
  assert.equal(counted.mapped, mapped - 1);
});
