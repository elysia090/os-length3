import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Image, Kernel, Process, Task} from '../../runtime/linux/process.ts';

const enc = new TextEncoder();
const str = (s: string) => [enc.encode(s).length, ...enc.encode(s)];
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
// Real Wasm: initialize the imported memory, then optionally trap in start.
// No translated program or FPU instructions; the x87 allocator below is a stub.
const moduleOf = (trap: boolean, grow = false) => new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(0, [...str('sods.facts'), ...enc.encode('{"imageStart":16,"imageEnd":17}')]),
  ...section(1, [1, 0x60, 0, 0]),
  ...section(2, [1, ...str('env'), ...str('memory'), 2, 0, 1]),
  ...section(3, [1, 0]),
  ...section(8, [0]),
  ...section(10, [1, (trap ? 3 : 2) + (grow ? 5 : 0), 0, ...(grow ? [0x41, 1, 0x40, 0, 0x1a] : []), ...(trap ? [0] : []), 0x0b]),
  ...section(11, [1, 0, 0x41, 16, 0x0b, 1, 1]),
]));

test('failed Wasm instantiation can already have overwritten imported memory', () => {
  const memory = new WebAssembly.Memory({initial: 1}), bytes = new Uint8Array(memory.buffer);
  bytes[16] = 99;
  assert.throws(() => new WebAssembly.Instance(moduleOf(true), {env: {memory}}), WebAssembly.RuntimeError);
  assert.equal(bytes[16], 1, 'the runtime must restore the live parent, not assume instantiate is atomic');
});
for (const [trap, grow] of [[false, false], [true, false], [true, true]]) test(`child load preserves the live parent image bytes, start traps=${trap}, grows=${grow}`, () => {
  const k = new Kernel({console: {write() {}, read: () => new Uint8Array(0)}});
  Object.defineProperty(k, 'x87', {value: {check() {}, make() { return 0; }, free() {}, fpu() { return 0n; }}});
  const p = new Process(k, null), from = new Task(p, 1), child = new Task(p, 2);
  const memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  p.memory = from.memory = memory;
  const source = () => Uint8Array.of(127, 69, 76, 70), image = new Image(moduleOf(trap, grow), source);
  const bytes = new Uint8Array(memory.buffer); bytes[16] = 99; bytes[17] = 73;
  if (trap) assert.throws(() => child.load(image, memory, from), WebAssembly.RuntimeError);
  else child.load(image, memory, from);
  const after = new Uint8Array(memory.buffer);
  assert.equal(after[16], 99); assert.equal(after[17], 73);
  assert.equal(memory.buffer.byteLength, grow ? 131072 : 65536);
  assert.equal(image.source, source, 'an image alias is not revoked by failed child preparation');
  assert.equal(from.memory, memory);
});
