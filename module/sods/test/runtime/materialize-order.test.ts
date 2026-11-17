import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FsError, E} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
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
for (const operation of ['write', 'truncate']) test(`${operation} keeps reload ownership if materialization fails`, () => {
  let attempts = 0;
  const source = () => { if (++attempts === 1) throw new Error('retry source'); return enc.encode('abc'); };
  const file = new File(new Uint8Array(0), 0o644, source);
  const change = () => operation === 'write' ? file.write(0, enc.encode('X')) : file.truncate(1);
  assert.throws(change, (e: unknown) => e instanceof FsError && e.errno === E.IO);
  assert.equal(file.reload, source); assert.equal(file.load, source); assert.equal(file.version, 0);
  change();
  assert.equal(dec.decode(file.bytes()), operation === 'write' ? 'Xbc' : 'a');
  assert.equal(file.reload, null);
});

test('real append selects the loaded length, and source failure does not commit ownership or offset', () => {
  const {p} = setup(); let attempts = 0;
  const source = () => { if (++attempts === 1) throw new Error('retry append'); return enc.encode('abc'); };
  const file = new File(new Uint8Array(0), 0o644, source); file.size = 1;
  const fd = open(p, file, 0x401), d = p.fds.get(fd)!;
  p.bytes.set(enc.encode('d'), 4096);
  assert.equal(call(p, 1, fd, 4096, 1), -5n);
  assert.equal(d.offset, 0); assert.equal(file.reload, source); assert.equal(file.version, 0);
  assert.equal(call(p, 1, fd, 4096, 1), 1n);
  assert.equal(dec.decode(file.bytes()), 'abcd'); assert.equal(d.offset, 4);
});

for (const throws of [false, true]) test(`write materialization rejects retired identity even when loader throws=${throws}`, () => {
  const {p} = setup();
  const file = new File(new Uint8Array(0), 0o644, () => { p.memory = memory(); if (throws) throw new Error('source failed after replacement'); return enc.encode('abc'); });
  const fd = open(p, file), d = p.fds.get(fd)!;
  p.bytes.set(enc.encode('X'), 4096);
  assert.throws(() => call(p, 1, fd, 4096, 1), ReadLifetimeError);
  assert.equal(p.state, 'zombie'); assert.equal(d.offset, 0);
  assert.equal(file.version, 0);
  if (!throws) assert.equal(dec.decode(file.bytes()), 'abc');
});

