import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FILE_MOST} from '../../runtime/linux/fs.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const enc = new TextEncoder(), dec = new TextDecoder();
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
function setup() {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null); p.memory = memory();
  p.fixed = []; p.free = []; p.mapBase = 65536; p.mapEnd = 65536; p.stackLow = 0; p.stackTop = 65536;
  p.bytes.set(enc.encode('/tmp/file\0'), 1024);
  return {k, p};
}
for (const full of [false, true]) test(`O_TRUNC reselects its descriptor after loading, full=${full}`, () => {
  const {k, p} = setup(), other = new File(enc.encode('keep'));
  let installed = -1;
  const source = () => { installed = p.fds.install(new Description('file', {node: other, flags: 2})); return enc.encode('abc'); };
  const file = new File(new Uint8Array(0), 0o644, source); file.size = 3;
  k.vfs.dir('/tmp').entries.set('file', file);
  if (full) p.fds.limit = 1;
  const result = call(p, 2, 1024, 0x201);
  assert.equal(installed, 0); assert.equal(p.fds.get(installed)!.node, other);
  assert.equal(dec.decode(other.bytes()), 'keep');
  if (full) {
    assert.equal(result, -24n); assert.equal(file.version, 0);
    assert.equal(dec.decode(file.bytes()), 'abc'); assert.equal(file.reload, source);
  } else {
    assert.equal(result, 1n); assert.equal(p.fds.get(1)!.node, file);
    assert.equal(file.size, 0); assert.equal(file.version, 1);
  }
});
test('initial descriptor exhaustion still precedes source loading', () => {
  const {k, p} = setup(); let loads = 0;
  k.vfs.dir('/tmp').entries.set('file', new File(new Uint8Array(0), 0o644, () => { loads++; return enc.encode('abc'); }));
  p.fds.limit = 0;
  assert.equal(call(p, 2, 1024, 0x201), -24n); assert.equal(loads, 0);
});
for (const operation of ['open', 'truncate', 'ftruncate']) test(`${operation} rejects source replacement even when the loader throws`, () => {
  const {k, p} = setup();
  const file = new File(new Uint8Array(0), 0o644, () => { p.memory = memory(); throw new Error('replacement source'); });
  file.size = 3; k.vfs.dir('/tmp').entries.set('file', file);
  const fd = operation === 'ftruncate' ? Number(call(p, 2, 1024, 2)) : -1;
  assert.throws(() => operation === 'open' ? call(p, 2, 1024, 0x201)
    : operation === 'truncate' ? call(p, 76, 1024, 0) : call(p, 77, fd, 0), ReadLifetimeError);
  assert.equal(p.state, 'zombie'); assert.equal(file.version, 0); assert.equal(file.size, 3);
});
test('truncate refusal order is retained before loading', () => {
  const {k, p} = setup(); let loads = 0;
  const file = new File(new Uint8Array(0), 0o644, () => { loads++; throw new Error('must not load'); });
  k.vfs.dir('/tmp').entries.set('file', file); const fd = Number(call(p, 2, 1024, 2));
  assert.equal(call(p, 77, fd, FILE_MOST + 1), -27n);
  assert.equal(call(p, 76, 1024, -1), -22n);
  assert.equal(loads, 0);
});
