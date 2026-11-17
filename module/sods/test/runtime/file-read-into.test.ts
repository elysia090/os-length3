import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';

const enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));

test('consuming file reads copy only available bytes, including overlapping destinations', () => {
  const f = new File(enc.encode('abcde')), into = new Uint8Array(7).fill(99);
  assert.equal(f.readInto(3, into, 2, 8), 2);
  assert.deepEqual([...into], [99, 99, 100, 101, 99, 99, 99]);
  f.write(3, enc.encode('XY'));
  assert.equal(dec.decode(into.subarray(2, 4)), 'de');
  assert.equal(f.readInto(99, into, 7, 8), 0);
  assert.throws(() => f.readInto(0, into, 6, 2), RangeError);
  assert.equal(f.readInto(0, f.data, 1, 3), 3);
  assert.equal(dec.decode(f.bytes()), 'aabcY');
});

test('real Vfs and file syscalls retain old inode, advance only successful reads, and keep pread offset independent', () => {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  const old = k.vfs.writeFile('/tmp/a', 'abcdef');
  p.bytes.set(enc.encode('/tmp/a\0'), 1024);
  const fd = Number(call(p, 2, 1024, 0));
  assert.ok(fd >= 0);
  k.vfs.writeFile('/tmp/a', 'replacement');
  let copies = 0;
  const readInto = old.readInto.bind(old);
  old.readInto = (...args) => { copies++; return readInto(...args); };
  assert.equal(call(p, 0, fd, 4096, 2), 2n);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4098)), 'ab');
  assert.equal(call(p, 0, fd, 65536, 2), -14n); // invalid destination cannot consume an offset
  assert.equal(call(p, 17, fd, 4096, 2, 4), 2n);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4098)), 'ef');
  assert.equal(call(p, 0, fd, 4096, 2), 2n);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4098)), 'cd');
  assert.equal(call(p, 0, fd, 65535, 2), 1n); // valid prefix may complete before the fault
  assert.equal(p.bytes[65535], 101);
  assert.equal(call(p, 0, fd, 4096, 2), 1n);
  assert.equal(p.bytes[4096], 102);
  assert.equal(copies, 5);
  assert.equal(dec.decode(k.vfs.readFile('/tmp/a')), 'replacement');
  assert.equal(call(p, 3, fd), 0n);
  assert.equal(dec.decode(old.bytes()), 'abcdef'); // fd close is not payload close
});
