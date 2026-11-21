import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/linux/process.ts';

// Guest syscall-table tests: no translated program or host Wayland session.
const SEAL = 1, SHRINK = 2, GROW = 4, ADD = 1033, GET = 1034;
const EPERM = -1n, EINVAL = -22n;
function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
function memfd(p: Process, flags = 2): number {
  p.bytes.set(new TextEncoder().encode('seal-test\0'), 1024);
  const fd = Number(call(p, 319, 1024, flags)); assert.ok(fd >= 0); return fd;
}
const seals = (p: Process, fd: number) => call(p, 72, fd, GET);
const add = (p: Process, fd: number, mask: number) => call(p, 72, fd, ADD, mask);
function contents(p: Process, fd: number): number[] {
  const size = Number(call(p, 17, fd, 2048, 32, 0)); assert.ok(size >= 0);
  return [...p.bytes.subarray(2048, 2048 + size)];
}
function filled(p: Process): number {
  const fd = memfd(p); p.bytes.set([10, 20, 30, 40], 1536);
  assert.equal(call(p, 1, fd, 1536, 4), 4n); return fd;
}

test('memfd default seals and monotonic additions belong to the inode', () => {
  const p = guest(), locked = memfd(p, 0), fd = memfd(p, 3);
  assert.equal(seals(p, locked), BigInt(SEAL));
  assert.equal(add(p, locked, 0), EPERM);
  assert.equal(add(p, locked, SHRINK), EPERM);
  assert.equal(seals(p, fd), 0n);
  assert.equal(call(p, 72, fd, 1), 1n, 'CLOEXEC remains a descriptor flag');
  const dup = Number(call(p, 32, fd)); assert.ok(dup >= 0);
  assert.equal(add(p, dup, SHRINK), 0n);
  assert.equal(add(p, fd, SHRINK), 0n);
  assert.equal(seals(p, dup), BigInt(SHRINK));
  assert.equal(add(p, fd, GROW | SEAL), 0n);
  assert.equal(seals(p, dup), 7n);
  assert.equal(add(p, dup, 0), EPERM);
  assert.equal(add(p, fd, SHRINK), EPERM);
});

test('unsupported seals fail atomically rather than claiming write protection', () => {
  const p = guest(), fd = filled(p);
  for (const unsupported of [8, 16, 32, 64]) {
    assert.equal(add(p, fd, SHRINK | unsupported), EINVAL);
    assert.equal(seals(p, fd), 0n);
    assert.deepEqual(contents(p, fd), [10, 20, 30, 40]);
  }
  p.kernel.vfs.writeFile('/ordinary', new Uint8Array([1]));
  p.bytes.set(new TextEncoder().encode('/ordinary\0'), 1024);
  const ordinary = Number(call(p, 2, 1024, 2));
  assert.equal(seals(p, ordinary), EINVAL);
  assert.equal(add(p, ordinary, SHRINK), EINVAL);
});

test('size seals refuse truncate, write and fallocate growth without changing bytes or offsets', () => {
  const p = guest(), fd = filled(p);
  assert.equal(add(p, fd, SHRINK | GROW), 0n);
  assert.equal(call(p, 8, fd, 3, 0), 3n);
  p.bytes.set([90, 91], 1536);
  for (const ask of [
    () => call(p, 77, fd, 3), () => call(p, 77, fd, 5),
    () => call(p, 1, fd, 1536, 2), () => call(p, 18, fd, 1536, 2, 3),
    () => call(p, 285, fd, 0, 3, 2), () => call(p, 285, fd, 1, 3, 2),
    () => call(p, 285, fd, 0x10, 3, 2), () => call(p, 285, fd, 0x11, 3, 2),
  ]) {
    assert.equal(ask(), EPERM);
    assert.deepEqual(contents(p, fd), [10, 20, 30, 40]);
    assert.equal(call(p, 8, fd, 0, 1), 3n);
    assert.equal(call(p, 8, fd, 0, 2), 4n);
    assert.equal(call(p, 8, fd, 3, 0), 3n);
  }
  assert.equal(call(p, 77, fd, 4), 0n, 'unchanged size is allowed');
  assert.equal(call(p, 18, fd, 1536, 1, 1), 1n, 'ordinary in-range write remains allowed');
  assert.equal(call(p, 285, fd, 3, 3, 2), 0n, 'PUNCH_HOLE|KEEP_SIZE clips at EOF');
  assert.deepEqual(contents(p, fd), [10, 90, 30, 0]);
  assert.equal(call(p, 8, fd, 0, 1), 3n);
});

test('each size seal permits the other size direction', () => {
  const p = guest(), shrink = filled(p), grow = filled(p);
  assert.equal(add(p, shrink, SHRINK), 0n);
  assert.equal(call(p, 77, shrink, 8), 0n);
  assert.equal(call(p, 77, shrink, 4), EPERM);
  assert.equal(add(p, grow, GROW), 0n);
  assert.equal(call(p, 77, grow, 2), 0n);
  assert.equal(call(p, 77, grow, 4), EPERM);
});

test('SCM_RIGHTS preserves the sealed inode and writable shared mappings still work', () => {
  const p = guest(), fd = filled(p);
  // Map at a fixed unused page inside this test's one-page guest memory.
  assert.equal(call(p, 9, 16384, 4096, 3, 0x11, fd, 0), 16384n);
  assert.equal(add(p, fd, SHRINK | GROW | SEAL), 0n);
  p.bytes[16385] = 88;
  assert.deepEqual(contents(p, fd), [10, 88, 30, 40]);
  assert.equal(call(p, 53, 1, 2, 0, 64), 0n);
  const sender = p.view.getInt32(64, true), receiver = p.view.getInt32(68, true);
  p.bytes.fill(0, 128, 280);
  p.view.setBigUint64(144, 192n, true); p.view.setBigUint64(152, 1n, true);
  p.view.setBigUint64(160, 224n, true); p.view.setBigUint64(168, 24n, true);
  p.view.setBigUint64(192, 512n, true); p.view.setBigUint64(200, 1n, true);
  p.view.setBigUint64(224, 20n, true);
  p.view.setInt32(232, 1, true); p.view.setInt32(236, 1, true); p.view.setInt32(240, fd, true);
  assert.equal(call(p, 46, sender, 128, 0), 1n);
  assert.equal(call(p, 47, receiver, 128, 0), 1n);
  const received = p.view.getInt32(240, true); assert.notEqual(received, fd);
  assert.equal(seals(p, received), 7n);
  assert.equal(call(p, 3, fd), 0n);
  assert.equal(call(p, 77, received, 3), EPERM);
  assert.deepEqual(contents(p, received), [10, 88, 30, 40]);
  assert.equal(call(p, 11, 16384, 4096), 0n);
  for (const open of [received, sender, receiver]) assert.equal(call(p, 3, open), 0n);
});

test('read-only reopened memfd can query seals but cannot add them or truncate the inode', () => {
  const p = guest(), fd = filled(p);
  p.pid = p.pgid = p.sid = 1; p.kernel.procs.set(1, p);
  p.bytes.set(new TextEncoder().encode(`/proc/self/fd/${fd}\0`), 1024);
  const ro = Number(call(p, 2, 1024, 0)); assert.ok(ro >= 0);
  assert.equal(seals(p, ro), 0n);
  assert.equal(add(p, ro, SHRINK), EPERM);
  assert.equal(call(p, 1, ro, 1536, 1), -9n, 'a reopen is not a writable dup');
  assert.equal(call(p, 77, ro, 1), EINVAL);
  assert.equal(call(p, 8, ro, 0, 1), 0n);
  assert.equal(seals(p, fd), 0n);
  assert.equal(add(p, fd, SHRINK), 0n);
  assert.equal(seals(p, ro), BigInt(SHRINK));
  assert.equal(call(p, 2, 1024, 2 | 0x200), EPERM, 'O_TRUNC cannot bypass the inode seal');
  assert.deepEqual(contents(p, fd), [10, 20, 30, 40]);
  assert.equal(call(p, 8, fd, 0, 1), 4n);
  for (const open of [ro, fd]) assert.equal(call(p, 3, open), 0n);
});

test('GROW permits only completed pages before an EOF-crossing write and reports its exact count', () => {
  for (const size of [4096, 4097]) {
    const p = guest(), fd = memfd(p);
    assert.equal(call(p, 77, fd, size), 0n);
    assert.equal(add(p, fd, GROW), 0n);
    p.bytes.set([90, 91, 92, 93, 94], 1536);
    assert.equal(call(p, 8, fd, 4095, 0), 4095n);
    assert.equal(call(p, 1, fd, 1536, 5), 1n);
    assert.equal(call(p, 8, fd, 0, 1), 4096n, 'offset advances only by the accepted prefix');
    assert.equal(call(p, 1, fd, 1536, 2), EPERM, 'the partial final page is refused as a whole');
    assert.equal(call(p, 8, fd, 0, 1), 4096n);
    const read = Number(call(p, 17, fd, 2048, 8, 4095));
    assert.equal(read, size - 4095);
    assert.deepEqual([...p.bytes.subarray(2048, 2048 + read)], size === 4096 ? [90] : [90, 0]);
    assert.equal(call(p, 8, fd, 0, 2), BigInt(size));
    assert.equal(call(p, 3, fd), 0n);
  }
});

test('a growth-sealed destination reports only the accepted prefix to vectored and file-to-file writes', () => {
  for (const kind of ['writev', 'sendfile', 'copy_file_range']) {
    const p = guest(), from = filled(p), to = memfd(p);
    assert.equal(call(p, 8, from, 0, 0), 0n);
    assert.equal(call(p, 77, to, 4097), 0n);
    assert.equal(add(p, to, GROW), 0n);
    assert.equal(call(p, 8, to, 4095, 0), 4095n);
    if (kind === 'writev') {
      p.view.setBigUint64(128, 1536n, true); p.view.setBigUint64(136, 2n, true);
      p.view.setBigUint64(144, 1538n, true); p.view.setBigUint64(152, 2n, true);
      assert.equal(call(p, 20, to, 128, 2), 1n);
    } else {
      const written = kind === 'sendfile' ? call(p, 40, to, from, 0, 4) : call(p, 326, from, 0, to, 0, 4, 0);
      assert.equal(written, 1n);
      assert.equal(call(p, 8, from, 0, 1), 1n);
    }
    assert.equal(call(p, 8, to, 0, 1), 4096n);
    assert.equal(call(p, 17, to, 2048, 8, 4095), 2n);
    assert.deepEqual([...p.bytes.subarray(2048, 2050)], [10, 0]);
    for (const open of [from, to]) assert.equal(call(p, 3, open), 0n);
  }
});
