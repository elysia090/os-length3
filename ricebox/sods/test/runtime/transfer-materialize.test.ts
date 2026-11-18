import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FILE_MOST} from '../../runtime/linux/fs.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const enc = new TextEncoder(), dec = new TextDecoder();
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
function setup() {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k, null); p.memory = memory();
  p.fixed = []; p.free = []; p.mapBase = 65536; p.mapEnd = 65536; p.stackLow = 0; p.stackTop = 65536;
  const fd = (node: File) => p.fds.install(new Description('file', {node, flags: 2}));
  return {k, p, fd};
}
test('fallocate KEEP_SIZE uses materialized length, not the lazy hint', () => {
  const {p, fd} = setup();
  const node = new File(new Uint8Array(0), 0o644, () => enc.encode('abcdef')); node.size = 2;
  assert.equal(call(p, 285, fd(node), 0x11, 2, 3), 0n);
  assert.deepEqual([...node.bytes()], [97, 98, 0, 0, 0, 102]);
});
for (const throwing of [false, true]) test(`copy_file_range rejects input identity replacement, throw=${throwing}`, () => {
  const {p, fd} = setup(); const target = new File(enc.encode('keep'));
  const source = new File(new Uint8Array(0), 0o644, () => { p.memory = memory(); if (throwing) throw new Error('load'); return enc.encode('abc'); });
  assert.throws(() => call(p, 326, fd(source), 0, fd(target), 0, 3, 0), ReadLifetimeError);
  assert.equal(dec.decode(target.bytes()), 'keep');
});
test('copy captures source before destination loading mutates it', () => {
  const {p, fd} = setup(); const source = new File(enc.encode('abc'));
  const target = new File(new Uint8Array(0), 0o644, () => { source.write(0, enc.encode('xyz')); return enc.encode('---'); });
  assert.equal(call(p, 326, fd(source), 0, fd(target), 0, 3, 0), 3n);
  assert.equal(dec.decode(target.bytes()), 'abc');
});
test('copy rejects descriptor offset ABA in destination loader before write', () => {
  const {p, fd} = setup(); const source = new File(enc.encode('abc')); const input = fd(source);
  const target = new File(new Uint8Array(0), 0o644, () => { const d = p.fds.get(input)!; d.offset = 1; d.offset = 0; return enc.encode('keep'); });
  assert.throws(() => call(p, 326, input, 0, fd(target), 0, 3, 0), ReadLifetimeError);
  assert.equal(dec.decode(target.bytes()), 'keep');
});

for (const operation of ['fallocate', 'copy']) test(`${operation} destination load failure preserves payload and offsets`, () => {
  const {p, fd} = setup(); let fail = true;
  const target = new File(new Uint8Array(0), 0o644, () => { if (fail) throw new Error('expected load failure'); return enc.encode('keep'); });
  target.size = 4; const output = fd(target), input = fd(new File(enc.encode('abc')));
  const run = () => operation === 'copy' ? call(p, 326, input, 0, output, 0, 3, 0) : call(p, 285, output, 0x11, 0, 3);
  assert.equal(run(), -5n); assert.equal(target.version, 0);
  assert.equal(p.fds.get(input)!.offset, 0); assert.equal(p.fds.get(output)!.offset, 0);
  fail = false; assert.equal(run(), operation === 'copy' ? 3n : 0n);
});

test('fallocate invalid expansion is refused before loading', () => {
  const {p, fd} = setup(); let loads = 0;
  const file = new File(new Uint8Array(0), 0o644, () => { loads++; throw new Error('must not load'); });
  assert.equal(call(p, 285, fd(file), 0, FILE_MOST, 1), -27n);
  assert.equal(loads, 0);
});
test('copy destination replacement and throw leave explicit offsets untouched', () => {
  const {p, fd} = setup(), original = p.memory, replacement = memory();
  assert.ok(original);
  p.view.setBigInt64(128, 1n, true); p.view.setBigInt64(136, 2n, true);
  const target = new File(new Uint8Array(0), 0o644, () => { p.memory = replacement; throw new Error('target changed process'); });
  assert.throws(() => call(p, 326, fd(new File(enc.encode('abc'))), 128, fd(target), 136, 2, 0), ReadLifetimeError);
  const old = new DataView(original.buffer);
  assert.equal(old.getBigInt64(128, true), 1n); assert.equal(old.getBigInt64(136, true), 2n);
  const next = new DataView(replacement.buffer);
  assert.equal(next.getBigInt64(128, true), 0n); assert.equal(next.getBigInt64(136, true), 0n);
  assert.equal(target.version, 0);
});
