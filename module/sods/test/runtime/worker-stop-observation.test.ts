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
