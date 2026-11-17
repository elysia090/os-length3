import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File} from '../../runtime/linux/fs.ts';
import {Kernel, Process, type Image} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const enc = new TextEncoder();
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
const call = (p: Process, nr: number, ...args: number[]) =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
function setup() {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null); p.memory = memory();
  p.fixed = []; p.free = []; p.mapBase = 65536; p.mapEnd = 65536; p.stackLow = 0; p.stackTop = 65536;
  const old = p.memory;
  p.bytes.set(enc.encode('/tmp/lazy\0'), 1024);
  return {k, p, old};
}
for (const change of ['replace', 'throw-after-replace', 'aba', 'image', 'grow', 'renew', 'mapping', 'mmap', 'mremap', 'cover', 'offset-aba']) {
  test(`lazy read rejects ${change} before destination copy and retires the execution owner`, () => {
    const {k, p, old} = setup(); let fd = -1, current = old;
    const file = new File(new Uint8Array(0), 0o644, () => {
      if (change === 'replace' || change === 'throw-after-replace') p.memory = current = memory();
      if (change === 'throw-after-replace') throw new Error('loader failed after replacement');
      if (change === 'aba') { p.memory = memory(); p.memory = old; }
      if (change === 'image') p.image = {facts: {}} as Image;
      if (change === 'grow') old.grow(1);
      if (change === 'renew') k.renew(old, null, 1, {facts: {}} as Image);
      if (change === 'mmap') assert.equal(call(p, 9, 4096, 4096, 3, 0x32, -1, 0), 4096n);
      if (change === 'mremap') { p.mapEnd = 8192; assert.equal(call(p, 25, 4096, 4096, 4096), 8192n); }
      if (change === 'cover') p.cover(65536);
      if (change === 'mapping') p.unmapShared(8192, 4096);
      if (change === 'offset-aba') { const d = p.fds.get(fd)!; d.offset = 7; d.offset = 0; }
      return enc.encode('abc');
    });
    file.size = 3; k.vfs.dir('/tmp').entries.set('lazy', file);
    fd = Number(call(p, 2, 1024, 0)); const description = p.fds.get(fd)!;
    assert.throws(() => call(p, 0, fd, 4096, 3), ReadLifetimeError);
    assert.equal(description.offset, 0);
    assert.equal(p.state, 'zombie');
    assert.equal(p.memory, null);
    assert.deepEqual([...new Uint8Array(old.buffer, 4096, 3)], [0, 0, 0]);
    assert.deepEqual([...new Uint8Array(current.buffer, 4096, 3)], [0, 0, 0]);
  });
}

test('readv never turns a stale later segment into a successful prefix result', () => {
  const {k, p, old} = setup(); let reads = 0;
  class ChangingFile extends File {
    override read(start: number, end: number) {
      if (++reads === 2) p.memory = memory();
      return super.read(start, end);
    }
  }
  k.vfs.dir('/tmp').entries.set('lazy', new ChangingFile(enc.encode('abcd')));
  const fd = Number(call(p, 2, 1024, 0)), description = p.fds.get(fd)!;
  for (const [at, value] of [[2048, 4096], [2056, 2], [2064, 8192], [2072, 2]]) p.view.setBigUint64(at, BigInt(value), true);
  assert.throws(() => call(p, 19, fd, 2048, 2), ReadLifetimeError);
  assert.equal(p.state, 'zombie');
  assert.equal(description.offset, 2); // committed prefix is not rolled back
  assert.deepEqual([...new Uint8Array(old.buffer, 4096, 2)], [97, 98]);
  assert.deepEqual([...new Uint8Array(old.buffer, 8192, 2)], [0, 0]);
});

test('lost-read identity remains the primary failure when retirement cleanup also fails', () => {
  const {k, p, old} = setup(), cleanup = new Error('cleanup failed');
  const file = new File(new Uint8Array(0), 0o644, () => { p.memory = memory(); return enc.encode('abc'); });
  file.size = 3; k.vfs.dir('/tmp').entries.set('lazy', file);
  const fd = Number(call(p, 2, 1024, 0));
  p.retireShared = () => { throw cleanup; }; // Fault at the process-exit mapping retirement boundary.
  assert.throws(() => call(p, 0, fd, 4096, 3), (error: unknown) =>
    error instanceof ReadLifetimeError && error.cleanupFailure === cleanup);
  assert.equal(p.state, 'zombie');
  assert.ok(p.stopped);
  assert.deepEqual([...new Uint8Array(old.buffer, 4096, 3)], [0, 0, 0]);
});

test('ordinary loader failure with unchanged identity remains retryable EIO', () => {
  const {k, p} = setup(); let loads = 0;
  const file = new File(new Uint8Array(0), 0o644, () => {
    if (++loads === 1) throw new Error('transient source error');
    return enc.encode('abc');
  });
  file.size = 3; k.vfs.dir('/tmp').entries.set('lazy', file);
  const fd = Number(call(p, 2, 1024, 0)), description = p.fds.get(fd)!;
  assert.equal(call(p, 0, fd, 4096, 3), -5n);
  assert.equal(p.state, 'live');
  assert.equal(description.offset, 0);
  assert.equal(call(p, 0, fd, 4096, 3), 3n);
  assert.deepEqual([...p.bytes.subarray(4096, 4099)], [97, 98, 99]);
  assert.equal(description.offset, 3);
});
