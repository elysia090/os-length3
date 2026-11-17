import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process, Task} from '../../runtime/linux/process.ts';
import {PidNs} from '../../runtime/linux/space.ts';

const kernel = () => new Kernel({console: {write() {}, read: () => new Uint8Array(0)}});
for (const existing of [false, true]) test(`Task metadata refusal acquires no PID/Fs, existing=${existing}`, () => {
  const k = kernel(), ns = new PidNs(k.spaces.children, k.spaces.children.owner);
  const p = new Process(k, null, false, false, {...k.spaces, children: ns});
  if (existing) { const t = k.newTask(p); p.tasks.add(t); }
  const fs = p.fs, before = [k.nextPid, ns.last, ns.numbers.size, k.numbers.size, fs.users, p.taken];
  const original = new Error('metadata refused');
  Object.defineProperty(p, 'own', {configurable: true, get() { throw original; }});
  assert.throws(() => k.newTask(p), error => error === original);
  assert.deepEqual([k.nextPid, ns.last, ns.numbers.size, k.numbers.size, fs.users, p.taken], before);
  Reflect.deleteProperty(p, 'own');
  const t = k.newTask(p); assert.equal(ns.numbers.get(ns.last), t.tid);
});

for (const existing of [false, true]) test(`late Task field initialization precedes Fs transfer, existing=${existing}`, () => {
  const k = kernel(), p = new Process(k, null);
  if (existing) { const t = k.newTask(p); p.tasks.add(t); }
  const fs = p.fs, before = [fs.users, p.taken], original = new Error('late field refused');
  class RefusesCpu extends Task {}
  Object.defineProperty(RefusesCpu.prototype, 'cpu', {set() { throw original; }});
  assert.throws(() => new RefusesCpu(p, 99), error => error === original);
  assert.deepEqual([fs.users, p.taken], before);
});

test('explicit Task number retains the existing raw constructor behavior', () => {
  const k = kernel(), p = new Process(k, null), before = k.nextPid;
  const t = new Task(p, 73);
  assert.equal(t.tid, 73); assert.equal(k.nextPid, before); assert.equal(p.taken, true);
});

for (const existing of [false, true]) test(`numbering refusal acquires no Fs owner, existing=${existing}`, () => {
  const k = kernel(), p = new Process(k, null);
  if (existing) { const t = k.newTask(p); p.tasks.add(t); }
  const fs = p.fs, before = [fs.users, p.taken], original = new Error('PID allocator refused');
  k.numbered = () => { throw original; };
  assert.throws(() => k.newTask(p), error => error === original);
  assert.deepEqual([fs.users, p.taken], before);
});

test('normal Task preparation acquires exactly one owner per thread', () => {
  const k = kernel(), p = new Process(k, null), fs = p.fs;
  const first = k.newTask(p); p.tasks.add(first);
  assert.equal(fs.users, 1); assert.equal(p.taken, true);
  const next = k.newTask(p);
  assert.equal(fs.users, 2); assert.equal(next.fs, first.fs); assert.notEqual(next.tid, first.tid);
});

test('cross-kernel Task construction refuses before numbering or channel acquisition', async () => {
  const {RemoteKernel} = await import('../../runtime/linux/remote.ts');
  const owner = kernel(), p = new Process(owner, null), other = kernel();
  const remote = new RemoteKernel({spares: 0, console: {write() {}, read: () => null}});
  let channels = 0; remote.channel = () => { channels++; throw new Error('must not acquire'); };
  const before = [owner.nextPid, other.nextPid, remote.nextPid, p.taken, p.fs.users];
  assert.throws(() => other.newTask(p), /another kernel/);
  assert.throws(() => remote.newTask(p), /another kernel/);
  assert.equal(channels, 0);
  assert.deepEqual([owner.nextPid, other.nextPid, remote.nextPid, p.taken, p.fs.users], before);
});
