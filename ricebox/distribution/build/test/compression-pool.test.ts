import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {zstdDecompressSync} from 'node:zlib';
import {test} from 'node:test';
import {withCompression} from '../compression-pool.ts';

const normal = () => new Worker(new URL('../compress.worker.ts', import.meta.url));
const unused = () => {};

test('the scope drains private stored results and confirms every Worker stopped', {timeout: 10000}, async () => {
  const workers: Worker[] = [];
  const inputs = Array.from({length: 9}, (_, i) => i % 2 ? Buffer.from(`input-${i}`) : Buffer.alloc(1024, i));
  const result = await withCompression(async compress => {
    const out: Buffer[] = [];
    for (const [i, bytes] of inputs.entries()) await compress(bytes, (stored, raw) => {
      assert.equal(raw, !!(i % 2));
      if (raw) assert.strictEqual(stored, bytes, 'use the original raw fallback');
      out[i] = raw ? stored : zstdDecompressSync(stored);
    });
    return out;
  }, () => { const worker = normal(); workers.push(worker); return worker; });
  assert.equal(workers.length, 3);
  assert.deepEqual(result, inputs);
  assert.ok(workers.every(w => w.threadId === -1));
});

test('only a disposable complete input is moved and raw fallback returns its exact bytes', async () => {
  const ownedRaw = Buffer.alloc(5, 33), ownedCompressed = Buffer.alloc(1024, 42);
  const larger = Buffer.alloc(8, 27), alias = larger.subarray(0, 3), kept = Buffer.alloc(2, 31);
  const result = await withCompression(async compress => {
    const bodies: Buffer[] = [];
    for (const [i, bytes] of [ownedRaw, ownedCompressed, alias, kept].entries()) {
      await compress(bytes, (stored, raw) => {
        assert.equal(raw, i !== 1);
        bodies[i] = raw ? stored : zstdDecompressSync(stored);
      }, i !== 3);
    }
    assert.equal(ownedRaw.byteLength, 0, 'moved from the archive owner');
    assert.equal(ownedCompressed.byteLength, 0);
    assert.equal(larger.byteLength, 8, 'never move a view of other live bytes');
    assert.equal(kept.byteLength, 2, 'a hot input stays with the archive owner');
    return bodies;
  });
  assert.deepEqual(result, [Buffer.alloc(5, 33), Buffer.alloc(1024, 42), Buffer.alloc(3, 27), Buffer.alloc(2, 31)]);
});

class ManualWorker extends EventEmitter {
  active?: {id: number; bytes: Buffer};
  terminated = 0;
  postMessage(job: NonNullable<ManualWorker['active']>) {
    assert.equal(this.active, undefined, 'one member per Worker');
    this.active = job;
  }
  finish() {
    const job = this.active;
    assert.ok(job);
    this.active = undefined;
    this.emit('message', {id: job.id, bytes: null, raw: true});
  }
  async terminate() { this.active = undefined; this.terminated++; return 0; }
}
const manualPool = (workers: ManualWorker[]) => () => {
  const worker = new ManualWorker();
  workers.push(worker);
  return worker as unknown as Worker;
};

test('a producer waits at the byte or slot limit; an oversized file runs alone', {timeout: 10000}, async () => {
  const workers: ManualWorker[] = [], reads: number[] = [], stored: number[] = [];
  const result = withCompression(async compress => {
    for (const size of [6, 4, 11, 2, 2, 2, 2]) {
      reads.push(size); // The producer has read one member before requesting admission.
      await compress(Buffer.alloc(size), b => { stored.push(b.length); });
    }
  }, manualPool(workers), 10);
  const active = () => workers.flatMap(w => w.active ? [w.active.bytes.length] : []);
  const finish = (size: number) => workers.find(w => w.active?.bytes.length === size)!.finish();

  await setImmediate();
  assert.deepEqual(active(), [6, 4]);
  assert.deepEqual(reads, [6, 4, 11], 'only one member waits outside the budget');
  finish(6);
  await setImmediate();
  assert.deepEqual(active(), [4], 'oversized member cannot overlap another');
  finish(4);
  await setImmediate();
  assert.deepEqual(active(), [11]);
  assert.deepEqual(reads, [6, 4, 11, 2]);
  finish(11);
  await setImmediate();
  assert.deepEqual(active(), [2, 2, 2], 'a full pool does not queue the fourth small input');
  assert.equal(reads.length, 7);
  finish(2);
  await setImmediate();
  assert.deepEqual(active(), [2, 2, 2]);
  for (const w of workers) w.finish();
  await result;
  assert.deepEqual(stored, reads);
  assert.ok(workers.every(w => w.terminated === 1));
});

test('partial construction failure retires all previously constructed Workers', {timeout: 10000}, async () => {
  const workers: Worker[] = [], failure = new Error('third constructor');
  let called = false;
  await assert.rejects(withCompression(async () => { called = true; }, () => {
    if (workers.length === 2) throw failure;
    const worker = normal(); workers.push(worker); return worker;
  }), error => error === failure);
  assert.equal(called, false);
  assert.ok(workers.every(w => w.threadId === -1));
});

for (const [name, source, pattern] of [
  ['error', "throw new Error('worker failed')", /worker failed/],
  ['unexpected exit', 'process.exit(0)', /exited unexpectedly \(0\)/],
  ['wrong result', "require('node:worker_threads').parentPort.on('message',m=>require('node:worker_threads').parentPort.postMessage({id:m.id+1,bytes:null,raw:true}))", /unowned response/],
] as const) test(`${name} releases the waiting producer and attempts every retirement`, {timeout: 10000}, async () => {
  const workers: Worker[] = [];
  let accepted = 0;
  await assert.rejects(withCompression(async compress => {
    for (let i = 0; i < 8; i++) await compress(Buffer.alloc(8, 22), () => { accepted++; }, true);
  }, () => { const w = new Worker(source, {eval: true}); workers.push(w); return w; }), pattern);
  assert.equal(accepted, 0);
  assert.ok(workers.every(w => w.threadId === -1));
});

test('a synchronous send failure preserves its cause and retires Workers', async () => {
  const workers: ManualWorker[] = [], start = manualPool(workers), failure = new Error('send failed');
  await assert.rejects(withCompression(async compress => {
    await compress(Buffer.alloc(8), unused);
  }, () => {
    const worker = start();
    worker.postMessage = () => { throw failure; };
    return worker;
  }), error => error === failure);
  assert.ok(workers.every(w => w.terminated === 1));
});

test('an undecodable reply stops admission while the next input is waiting', {timeout: 10000}, async () => {
  const workers: ManualWorker[] = [], failure = new Error('reply unavailable');
  const result = withCompression(async compress => {
    await compress(Buffer.alloc(1), unused);
    await compress(Buffer.alloc(1), unused);
    assert.fail('a failed reply cannot free authority to admit a new member');
  }, manualPool(workers), 1);
  const rejected = assert.rejects(result, error => error === failure);
  await setImmediate();
  workers[0]!.emit('messageerror', failure);
  await rejected;
  assert.ok(workers.every(w => w.terminated === 1));
});

test('an abandoned admission is woken and subsequent offers do not form a queue', async () => {
  const workers: ManualWorker[] = [];
  let waiting!: Promise<void>;
  await assert.rejects(withCompression(async compress => {
    await compress(Buffer.alloc(1), unused);
    waiting = compress(Buffer.alloc(1), unused);
    void waiting.catch(unused);
    await assert.rejects(compress(Buffer.alloc(1), unused), /await compression admission/);
  }, manualPool(workers), 1), /unadmitted member/);
  await assert.rejects(waiting, /unadmitted member/);
  assert.ok(workers.every(w => w.terminated === 1));
});

test('owner failure keeps its cause; all retirements are attempted even if one fails', {timeout: 10000}, async () => {
  const workers: Worker[] = [], original = new Error('owner'), cleanup = new Error('termination');
  let accepted = 0;
  try {
    await assert.rejects(withCompression(async compress => {
      await compress(Buffer.alloc(100), () => { accepted++; });
      throw original;
    }, () => {
      const w = normal();
      if (!workers.length) w.terminate = () => Promise.reject(cleanup);
      workers.push(w); return w;
    }), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup);
    assert.equal(accepted, 0);
    assert.ok(workers.slice(1).every(w => w.threadId === -1));
    assert.notEqual(workers[0].threadId, -1, 'failed termination is not evidence of a stopped Worker');
  } finally { await Promise.all(workers.map(w => Worker.prototype.terminate.call(w))); }
});

test('a forgotten worker exit is reported before further admission or success', {timeout: 10000}, async () => {
  const workers: Worker[] = [];
  await assert.rejects(withCompression(async () => {
    await once(workers[0], 'exit');
  }, () => { const w = new Worker('process.exit(0)', {eval: true}); workers.push(w); return w; }), /exited unexpectedly/);
  assert.ok(workers.every(w => w.threadId === -1));
});

test('a retained producer cannot admit work after its scope closes', async () => {
  let late!: Parameters<Parameters<typeof withCompression>[0]>[0];
  await withCompression(async compress => { late = compress; });
  await assert.rejects(late(Buffer.from('late'), unused), /scope is closed/);
});
