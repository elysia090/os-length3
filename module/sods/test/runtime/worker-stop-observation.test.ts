import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';

// Host evidence only: this runs a real Node Worker over shared Wasm memory,
// not a translated guest or a new managed-disposal implementation.
test('Node terminate completion follows exit after shared Wasm memory activity', {timeout: 10_000}, async (t) => {
  const memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
  const words = new Int32Array(memory.buffer), order: string[] = [];
  const worker = new Worker(`
    const {parentPort, workerData} = require('node:worker_threads');
    const words = new Int32Array(workerData.buffer);
    Atomics.store(words, 0, 1);
    parentPort.postMessage('ready');
    for (;;) Atomics.wait(words, 1, 0);
  `, {eval: true, workerData: memory});
  let completed = false;
  try {
    const [message] = await once(worker, 'message'); assert.equal(message, 'ready');
    worker.once('exit', () => order.push('exit'));
    const termination = worker.terminate().then(code => { completed = true; order.push('fulfilled'); return code; });
    order.push('requested');
    assert.equal(completed, false); // Request return is not completion.
    assert.equal(await termination, 1);
    assert.deepEqual(order, ['requested', 'exit', 'fulfilled']);
    assert.equal(worker.threadId, -1);
    assert.equal(Atomics.load(words, 0), 1);
    t.diagnostic(`actual host ${process.version}: stop request -> exit -> fulfilled`);
  } finally {
    // A failed assertion does not abandon a still-live host Worker.
    if (!completed) await worker.terminate();
  }
});

test('Node natural exit delivers its final message before the observed stop boundary', {timeout: 10_000}, async () => {
  const seen: string[] = [];
  const worker = new Worker(`require('node:worker_threads').parentPort.postMessage('final');`, {eval: true});
  let exited = false;
  worker.on('message', value => seen.push(value));
  const stopped = once(worker, 'exit');
  try {
    const [code] = await stopped; exited = true; seen.push('exit');
    assert.equal(code, 0); assert.deepEqual(seen, ['final', 'exit']);
  } finally { if (!exited) await worker.terminate(); }
});

import {WorkerStop} from '../../runtime/linux/worker-stop.ts';

test('production stop boundary latches actual Node exit independently of request return', {timeout: 10_000}, async () => {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); parentPort.postMessage('ready'); setInterval(()=>{},1000);`, {eval: true});
  const stop = new WorkerStop(() => worker.terminate(), exit => { worker.once('exit', exit); });
  const failures: unknown[] = [];
  try {
    await once(worker, 'message');
    stop.request(error => failures.push(error));
    assert.equal(stop.requested, true); assert.equal(stop.exitCode, undefined);
    stop.request(() => assert.fail('duplicate failure recipient'));
    assert.equal(await stop.stopped, 1);
    assert.equal(stop.exitCode, 1); assert.deepEqual(failures, []);
  } finally { if (stop.exitCode === undefined) await worker.terminate(); }
});

test('rejected request stays unconfirmed until independent late exit', async () => {
  let exit!: (code: number) => void, requests = 0;
  const failure = new Error('stop rejected'), errors: unknown[] = [];
  const stop = new WorkerStop(() => { requests++; return Promise.reject(failure); }, fn => { exit = fn; });
  stop.request(error => errors.push(error));
  await Promise.resolve();
  assert.equal(stop.failure?.error, failure); assert.deepEqual(errors, [failure]);
  assert.equal(stop.exitCode, undefined);
  stop.request(() => assert.fail('second recipient')); assert.equal(requests, 1);
  // An abandoned waiter does not remove the matching exit observer.
  exit(7); assert.equal(await stop.stopped, 7); assert.equal(stop.failure?.error, failure);
  exit(8); assert.equal(stop.exitCode, 7);
});

test('early natural exit needs no stop request and synchronous failure remains observable', async () => {
  const early = new WorkerStop(() => { throw new Error('must not request'); }, exit => exit(0));
  early.request(() => assert.fail()); assert.equal(await early.stopped, 0); assert.equal(early.requested, false);
  let exit!: (code: number) => void;
  const failure = new Error('sync stop'), errors: unknown[] = [];
  const stop = new WorkerStop(() => { throw failure; }, fn => { exit = fn; });
  assert.throws(() => stop.request(error => errors.push(error)), error => error === failure);
  assert.equal(stop.exitCode, undefined); assert.deepEqual(errors, [failure]);
  exit(1); assert.equal(await stop.stopped, 1); assert.equal(stop.failure?.error, failure);
});

test('notification failure is preserved without converting rejection into an unhandled promise', async () => {
  const failure = new Error('terminate'), notification = new Error('recipient');
  const stop = new WorkerStop(() => Promise.reject(failure), () => {});
  stop.request(() => { throw notification; });
  await Promise.resolve();
  assert.equal(stop.failure?.error, failure); assert.equal(stop.notificationFailure?.error, notification);
  assert.equal(stop.exitCode, undefined);
});

import {RemoteKernel} from '../../runtime/linux/remote.ts';
test('production Node CPU adapter releases only hand bookkeeping after observed exit', {timeout: 10_000}, async () => {
  const k = new RemoteKernel({spares: 0, console: {write() {}, read() { return null; }}});
  const hand = k.spawnWorker();
  assert.ok(hand.stop);
  hand.kept = [{memoryId: 1, imageId: 2, extras: 0}];
  hand.channel = new SharedArrayBuffer(16);
  hand.end();
  assert.ok(hand.kept); assert.ok(hand.channel);
  await hand.stop.stopped;
  assert.equal(hand.kept, undefined); assert.equal(hand.channel, undefined);
  assert.equal(hand.kernel, k); // Other ownership is not disposed by this evidence.
  assert.deepEqual(k.stopFailures, []);
  k.keep(hand); assert.equal(k.spares.length, 0);
  hand.end();
});

test('request failure resolves evidence as unconfirmed, while late exit remains independently observable', async () => {
  let exit!: (code: number) => void;
  const failure = new Error('request rejected');
  const stop = new WorkerStop(() => Promise.reject(failure), fn => { exit = fn; });
  stop.request(() => {});
  const initial = await stop.evidence();
  assert.equal(initial.stopped, false); assert.equal(initial.requestFailure, failure);
  exit(3);
  const late = await stop.evidence();
  assert.equal(late.stopped, true); assert.equal(late.exitCode, 3); assert.equal(late.requestFailure, failure);
});

test('a successful adapter request without matching exit is not stop evidence', async () => {
  const stop = new WorkerStop(() => Promise.resolve(0), () => {});
  stop.request(() => {});
  assert.deepEqual(await stop.evidence(), {stopped: false});
});

test('actual Node kernel close exposes captured stop evidence without disposing other owners', {timeout: 10_000}, async () => {
  const k = new RemoteKernel({spares: 1, console: {write() {}, read() { return null; }}});
  await assert.rejects(k.snapshotWorkerStops(), /close first/);
  k.close();
  const evidence = await k.snapshotWorkerStops();
  assert.equal(evidence.captured, 1); assert.equal(evidence.observedStopped, 1);
  assert.equal(evidence.unconfirmed, 0); assert.deepEqual(evidence.failures, []);
  assert.ok(k.vfs); assert.ok(k.images); // Host evidence never disposes these owners.
});

test('completed Worker history remains diagnostic even when the remaining-owner snapshot is empty', async () => {
  const k = new RemoteKernel({spares: 0, console: {write() {}, read() { return null; }}});
  // Production diagnostics outlive removal of an observed-stopped Hand.
  const failure = new Error('earlier stop request failed before late exit');
  k.stopFailures.push(failure);
  k.close();
  const result = await k.snapshotWorkerStops();
  assert.equal(result.captured, 0); assert.equal(result.unconfirmed, 0);
  assert.deepEqual(result.failures, [failure]);
});

test('concurrent evidence queries share one pending observation and late exit remains readable', async () => {
  let reject!: (error: unknown) => void, exit!: (code: number) => void;
  const stop = new WorkerStop(() => new Promise((_resolve, fail) => { reject = fail; }), fn => { exit = fn; });
  stop.request(() => {});
  const a = stop.evidence(), wait = (stop as unknown as {evidenceWait: Promise<unknown>}).evidenceWait;
  const b = stop.evidence();
  assert.equal((stop as unknown as {evidenceWait: Promise<unknown>}).evidenceWait, wait);
  reject(new Error('unconfirmed request'));
  assert.equal((await a).stopped, false); assert.equal((await b).stopped, false);
  for (let i = 0; i < 100; i++) assert.equal((await stop.evidence()).stopped, false);
  assert.equal((stop as unknown as {evidenceWait: Promise<unknown>}).evidenceWait, wait);
  exit(0); assert.equal((await stop.evidence()).stopped, true);
});
