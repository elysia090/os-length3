import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {x87Of} from '../../runtime/translation/x87.ts';
import {CH, OUTBOX_BYTES, type Run} from '../../runtime/linux/channel.ts';
import {Image, Kernel, Process, Task} from '../../runtime/linux/process.ts';

const enc = new TextEncoder();
const leb = (n: number): number[] => n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)];
const str = (s: string) => [...leb(enc.encode(s).length), ...enc.encode(s)];
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
// Real Wasm: initialize the imported memory, then optionally trap in start.
// No translated program or FPU instructions; the x87 allocator below is a stub.
const moduleOf = (trap: boolean, grow = false, shared = false, fpuNames = '') => new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(0, [...str('sods.facts'), ...enc.encode('{"imageStart":16,"imageEnd":17}')]),
  ...section(0, [...str('sods.fpu'), ...enc.encode(fpuNames)]),
  ...section(1, [1, 0x60, 0, 0]),
  ...section(2, [1, ...str('env'), ...str('memory'), 2, ...(shared ? [3, 1, 2] : [0, 1])]),
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

const translator = process.env.SODS_TRANSLATOR_WASM;
for (const loseLock of [false, true]) test(`actual CPU Worker preparation failure, injected foreign lock=${loseLock}`,  {skip: !translator, timeout: 10_000}, async (t) => {
  const x87 = new WebAssembly.Module(readFileSync(translator!)), names = x87Of(x87).names;
  const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
  const gil = new SharedArrayBuffer(8), words = new Int32Array(gil);
  const cpu = new URL('../../runtime/linux/cpu.ts', import.meta.url);
  const worker = loseLock ? new Worker(`
    const {workerData} = require('node:worker_threads');
    const Original = WebAssembly.Instance;
    WebAssembly.Instance = class extends Original {
      constructor(module, imports) {
        if (imports?.env?.memory) {
          Atomics.store(new Int32Array(workerData.gil), 0, 99);
          throw new Error('injected lost lock');
        }
        super(module, imports);
      }
    };
    import(workerData.cpu);
  `, {eval: true, workerData: {gil, cpu: cpu.href}}) : new Worker(cpu);
  try {
    assert.equal((await once(worker, 'message', {signal: t.signal}))[0].type, 'up');
    for (const tid of loseLock ? [21] : [21, 22]) {
      new Uint8Array(memory.buffer)[16] = 99;
      const failure = once(worker, 'message', {signal: t.signal});
      const run: Run = {type: 'run', again: false, tid, memoryId: 1, imageId: 1,
        module: moduleOf(true, false, true, names), memory, x87, extrasFrom: 0, extras: [],
        channel: new SharedArrayBuffer(CH.SIZE), door: new SharedArrayBuffer(8), gil,
        count: new SharedArrayBuffer(8), outbox: new SharedArrayBuffer(OUTBOX_BYTES + 20),
        regs: [], resumeAt: 0n, fpu: null, keep: [16, 17], origin: performance.timeOrigin};
      worker.postMessage(run);
      const [reported] = await failure;
      assert.equal(reported.type, 'error');
      assert.match(reported.message, loseLock ? /injected lost lock/ : /unreachable/);
      if (loseLock) assert.match(reported.message, /lost its memory lock|no longer owns/);
      assert.deepEqual([new Uint8Array(memory.buffer)[16], Atomics.load(words, 0)], [99, loseLock ? 99 : 0]);
    }
  } finally { await worker.terminate(); }
});
