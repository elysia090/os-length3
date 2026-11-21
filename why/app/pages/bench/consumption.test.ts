import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Consumption} from './consumption.ts';
import type {WriteReceipt} from './repo-copy.ts';
const saved: WriteReceipt = {storeAccepted: true, excluded: 0, skipped: [], journalCreated: true};

test('ordered boundary waits for its slow save while separately counting accepted and discarded output', async () => {
  const c = new Consumption(); let complete!: (result: WriteReceipt) => void;
  c.output(5, false); c.output(3, true);
  c.write(new Promise(resolve => { complete = resolve; }));
  const result = c.boundary(8);
  assert.equal(await Promise.race([result.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('pending'), 5))]), 'pending');
  assert.throws(() => c.output(1, false), /after/); assert.throws(() => c.write(Promise.resolve(saved)), /after/);
  assert.throws(() => c.boundary(8), /Duplicate/);
  complete(saved);
  assert.deepEqual(await result, {sentBytes: 8, acceptedBytes: 5, discardedBytes: 3, prefixReceived: true, storeAccepted: true, excludedPaths: 0, incompleteBatches: 0, notificationFailures: 0});
});

test('prefix mismatch, storage failure and policy exclusion are independent outcomes', async () => {
  const c = new Consumption(), failure = new Error('store lost');
  c.output(2, false);
  c.write(Promise.resolve({...saved, storeAccepted: false, excluded: 2, failure}));
  const result = await c.boundary(3);
  assert.equal(result.prefixReceived, false); assert.equal(result.storeAccepted, false);
  assert.equal(result.firstFailure, failure); assert.equal(result.excludedPaths, 2);
  assert.equal(result.incompleteBatches, 1);
});

test('a rejected later save is consumed while the earlier sink is still blocked', async () => {
  const c = new Consumption(), failure = new Error('late sink rejected'); let resolve!: (r: WriteReceipt) => void;
  c.write(new Promise(done => { resolve = done; }));
  c.write(Promise.reject(failure));
  const result = c.boundary(0);
  await new Promise(done => setImmediate(done));
  resolve(saved);
  assert.equal((await result).firstFailure, failure);
  assert.equal((await result).incompleteBatches, 1);
});

test('invalid and missing output accounting cannot certify a received prefix', async () => {
  const c = new Consumption(); assert.throws(() => c.output(-1, false), /Invalid/);
  assert.equal((await c.boundary(NaN)).prefixReceived, false);
});

test('completed later receipts aggregate while only the genuinely blocked receipt remains pending', async () => {
  const c = new Consumption(); let release!: (r: WriteReceipt) => void;
  c.write(new Promise(resolve => { release = resolve; }));
  for (let i = 0; i < 1000; i++) c.write(Promise.resolve({...saved, excluded: 1}));
  await new Promise(resolve => setImmediate(resolve));
  const observed = c as unknown as {pending: number; saved: {excludedPaths: number}};
  assert.equal(observed.pending, 1); assert.equal(observed.saved.excludedPaths, 1000);
  const boundary = c.boundary(0); release(saved);
  assert.equal((await boundary).excludedPaths, 1000);
});
