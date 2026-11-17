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

test('actual child Wasm preparation trap does not establish a nonexistent namespace init', async () => {
  const {PidNs} = await import('../../runtime/linux/space.ts');
  const k = new Kernel({console: {write() {}, read: () => new Uint8Array(0)}});
  const freed: number[] = [];
  Object.defineProperty(k, 'x87', {value: {check() {}, make() { return 7; }, free(id: number) { freed.push(id); }, fpu() { return 0n; }}});
  const p = new Process(k, null), t = k.newTask(p);
  p.tasks.add(t); p.task = t; p.pid = t.tid; k.tasks.set(t.tid, t); k.procs.set(p.pid, p);
  p.memory = t.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  Object.assign(p, {free: [], fixed: [], stackLow: 0, stackTop: 0, mapBase: 0, mapEnd: 0});
  p.image = new Image(moduleOf(true));
  const ns = new PidNs(k.spaces.children, p.cred.ns);
  const beforeRefs = p.fs.root.mnt.refs, identity = p.readIdentity();
  assert.throws(() => p.forkProcess(0n, {vm: true, ns: {...p.ns, children: ns}}), WebAssembly.RuntimeError);
  assert.equal(ns.init, 0); assert.equal(ns.ended, false);
  assert.equal(k.procs.size, 1); assert.equal(p.children.size, 0);
  assert.equal(p.cgroup.procs.size, 1); assert.equal(p.memory.users, 1);
  assert.equal(p.fs.root.mnt.refs, beforeRefs); assert.deepEqual(freed, [7]);
  identity(); // Returning the child's shared owner did not retire the parent's epoch.
  assert.equal(ns.numbers.size, 1, 'PID reservation cleanup remains separate');
});

async function trappedFork() {
  const {Description} = await import('../../runtime/linux/fd.ts');
  const k = new Kernel({console: {write() {}, read: () => new Uint8Array(0)}}), freed: number[] = [];
  const fpu = {check() {}, make() { return 7; }, free(id: number) { freed.push(id); }, fpu() { return 0n; }};
  Object.defineProperty(k, 'x87', {value: fpu, configurable: true});
  const p = new Process(k, null), t = k.newTask(p);
  p.tasks.add(t); p.task = t; p.pid = t.tid; k.tasks.set(t.tid, t); k.procs.set(p.pid, p);
  p.memory = t.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  Object.assign(p, {free: [], fixed: [], stackLow: 0, stackTop: 0, mapBase: 0, mapEnd: 0});
  p.image = new Image(moduleOf(true));
  const fd = new Description('console', {path: 'stdout'}); p.fds.install(fd, {fd: 3});
  const newTask = k.newTask.bind(k); let prepared: Task | undefined;
  k.newTask = proc => (prepared = newTask(proc));
  return {k, p, t, fd, fpu, freed, prepared: () => prepared!};
}

for (const files of [false, true]) test(`trapped new child returns only its FD ownership, shared table=${files}`, async () => {
  const {p, fd, prepared} = await trappedFork(), before = p.fs.root.mnt.refs;
  assert.throws(() => p.forkProcess(0n, {vm: true, files}), WebAssembly.RuntimeError);
  assert.equal(fd.refs, 1); assert.equal(fd.closed, false); assert.equal(p.fds.holders, 1);
  assert.equal(p.fs.root.mnt.refs, before); assert.equal(p.memory!.users, 1);
  assert.equal(prepared().dead, true); assert.equal(prepared().proc.memory, null);
  assert.equal(prepared().proc.failedPreparation, undefined);
});

test('failed x87 cleanup preserves trap and continues independent owned retirement', async () => {
  const {k, p, fd, fpu, freed, prepared} = await trappedFork(), cleanup = new Error('FPU release failed');
  fpu.free = id => { freed.push(id); throw cleanup; };
  assert.throws(() => p.forkProcess(0n, {vm: true}), error => {
    assert.ok(error instanceof AggregateError); assert.ok(error.errors[0] instanceof WebAssembly.RuntimeError);
    assert.equal(error.errors[1], cleanup); return true;
  });
  assert.deepEqual(freed, [7]); assert.equal(prepared().x87, 0);
  assert.equal(fd.refs, 1); assert.equal(p.memory!.users, 1);
  assert.equal(p.cgroup.procs.size, 2, 'cleanup failure retains the diagnostic child root');
  const record = prepared().proc.failedPreparation!;
  assert.equal(record.x87Handle, 7); assert.equal(record.x87Owner, fpu);
  assert.equal(record.retirement.x87, 'uncertain'); assert.equal(record.retirement.memory, 'returned');
  assert.equal(record.retirement.cgroup, 'not-attempted');
  assert.equal(k.failedPreparations!.has(prepared().proc), true);
});

test('cleanup reentry publishing the child stops remaining ownership retirement', async () => {
  const {k, p, fd, fpu, prepared} = await trappedFork(), before = p.fs.root.mnt.refs;
  fpu.free = () => { const ct = prepared(); k.procs.set(ct.tid, ct.proc); };
  assert.throws(() => p.forkProcess(0n, {vm: true}), AggregateError);
  assert.equal(p.memory!.users, 2); assert.equal(fd.refs, 2);
  assert.equal(p.fs.root.mnt.refs, before + 2); assert.equal(prepared().dead, true);
});

test('failed backend retirement does not recycle child memory or drop its other owners', async () => {
  const {k, p, fd, freed} = await trappedFork(), newTask = k.newTask.bind(k), stop = new Error('backend not stopped');
  k.newTask = proc => { const t = newTask(proc); t.end = () => { throw stop; }; return t; };
  assert.throws(() => p.forkProcess(0n, {vm: true}), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], stop); return true;
  });
  assert.equal(p.memory!.users, 2); assert.equal(fd.refs, 2); assert.deepEqual(freed, []);
});

test('failed pooled-instance attachment is not treated as a failed new instance', async () => {
  const {p, fd, freed} = await trappedFork();
  p.image = new Image(moduleOf(false));
  const instance = new WebAssembly.Instance(p.image.module, {env: {memory: p.memory!}});
  p.image.extras.push({module: p.image.module, base: 0, count: 1, bytes: new Uint8Array(0)});
  p.memory!.pooled = [{image: p.image, instance, slot: {task: p.task, initial: []}, attached: 0}];
  assert.throws(() => p.forkProcess(0n, {vm: true}), AggregateError);
  assert.equal(p.memory!.users, 2); assert.equal(fd.refs, 2); assert.deepEqual(freed, []);
  assert.equal(p.memory!.pooled!.length, 0, 'taken pool entry was not falsely restored');
});

for (const change of ['task-memory', 'epoch'] as const) test(`backend retirement changing ${change} prevents later release`, async () => {
  const {retireMemoryView} = await import('../../runtime/linux/read-lifetime.ts');
  const {k, p, fd, freed} = await trappedFork(), newTask = k.newTask.bind(k);
  const replacement = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  k.newTask = proc => {
    const t = newTask(proc);
    t.end = () => { if (change === 'task-memory') t.memory = replacement; else retireMemoryView(t.memory); };
    return t;
  };
  assert.throws(() => p.forkProcess(0n, {vm: true}), AggregateError);
  assert.equal(p.memory!.users, 2); assert.equal(replacement.users, 1);
  assert.equal(fd.refs, 2); assert.deepEqual(freed, []);
});

test('failed private child load discards private memory without touching parent', async () => {
  const {k, p, t, fd, prepared} = await trappedFork();
  t.reg = () => 0n;
  p.stackLow = p.stackTop = p.mapBase = p.mapEnd = 4096;
  const parentMemory = p.memory, identity = p.readIdentity();
  assert.throws(() => p.forkProcess(0n), WebAssembly.RuntimeError);
  assert.equal(p.memory, parentMemory); assert.equal(parentMemory!.users, 1); identity();
  assert.equal(prepared().proc.memory, null); assert.equal(fd.refs, 1);
  assert.equal(k.spareMemories.length, 0); assert.notEqual(prepared().memory, parentMemory);
  assert.equal(prepared().memory.users, 0); assert.equal(prepared().memory.tainted, true);
});

test('failed child uses the allocator that acquired its FPU handle, not a replacement', async () => {
  const {k, p, freed} = await trappedFork(), newTask = k.newTask.bind(k);
  let wrongAllocator = 0;
  k.newTask = proc => {
    const t = newTask(proc);
    t.end = () => { Object.defineProperty(k, 'x87', {value: {free() { wrongAllocator++; }}, configurable: true}); };
    return t;
  };
  assert.throws(() => p.forkProcess(0n, {vm: true}), WebAssembly.RuntimeError);
  assert.deepEqual(freed, [7]); assert.equal(wrongAllocator, 0); assert.equal(p.memory!.users, 1);
});

test('private memory discard failure retains uncertain evidence without ordinary pool reuse', async () => {
  const {k, p, t, prepared} = await trappedFork(), cleanup = new Error('backend forget failed');
  t.reg = () => 0n; p.stackLow = p.stackTop = p.mapBase = p.mapEnd = 4096;
  k.forget = () => { throw cleanup; };
  assert.throws(() => p.forkProcess(0n), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], cleanup); return true;
  });
  const record = prepared().proc.failedPreparation!;
  assert.equal(record.retirement.memory, 'uncertain'); assert.equal(record.memory.users, 0);
  assert.equal(record.memory.tainted, true); assert.equal(k.spareMemories.length, 0);
  assert.equal(k.failedPreparations!.has(prepared().proc), true);
});

for (const vm of [false, true]) test(`failed load never reclassifies its memory acquisition, shared=${vm}`, async () => {
  const {k, p, t, prepared} = await trappedFork(), newTask = k.newTask.bind(k);
  t.reg = () => 0n; p.stackLow = p.stackTop = p.mapBase = p.mapEnd = 4096;
  k.newTask = proc => { const task = newTask(proc); task.end = () => { task.memory.users = vm ? 1 : 2; }; return task; };
  assert.throws(() => p.forkProcess(0n, {vm}), AggregateError);
  const record = prepared().proc.failedPreparation!;
  assert.equal(record.retirement.memory, 'uncertain');
  assert.equal(prepared().proc.memory, prepared().memory);
  assert.equal(prepared().memory.users, vm ? 1 : 2);
  assert.notEqual(prepared().memory.tainted, true); assert.equal(k.spareMemories.length, 0);
});

test('backend replacing a child FPU handle does not authorize freeing the replacement', async () => {
  const {k, p, fd, freed, prepared} = await trappedFork(), newTask = k.newTask.bind(k);
  k.newTask = proc => { const t = newTask(proc); t.end = () => { t.x87 = 99; }; return t; };
  assert.throws(() => p.forkProcess(0n, {vm: true}), AggregateError);
  assert.deepEqual(freed, []); assert.equal(prepared().x87, 99);
  assert.equal(prepared().proc.failedPreparation!.x87Handle, 7);
  assert.equal(fd.refs, 2); assert.equal(p.memory!.users, 2);
});

test('missing cgroup membership is not reported as successful retirement', async () => {
  const {p, fpu, prepared} = await trappedFork();
  fpu.free = () => { p.cgroup.procs.delete(prepared().proc); };
  assert.throws(() => p.forkProcess(0n, {vm: true}), AggregateError);
  assert.equal(prepared().proc.failedPreparation!.retirement.cgroup, 'uncertain');
});
