import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {keeper, type RetirableReading} from '../../runtime/linux/keeper.ts';
import {packMain} from '../../runtime/translation/kept.ts';

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const body = Buffer.concat(packMain(wasm, null));
const sealed = Buffer.concat([body, createHash('sha256').update(body).digest()]);
const config = {cache: 'test', at: {program: {main: '/main', more: null}}};
async function finish(reading: RetirableReading): Promise<void> {
  for (let i = 0; i < 100 && reading.reading(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(reading.reading(), 0);
}
async function withCache(run: (release: () => void, requests: () => number, started: Promise<void>) => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  let release!: () => void, requests = 0, markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(globalThis, 'caches', {configurable: true, value: {async open() { return {async match() {
    requests++; markStarted(); await held;
    return {async arrayBuffer() { return sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength); }};
  }}; }}});
  try { await run(release, () => requests, started); }
  finally { release(); if (previous) Object.defineProperty(globalThis, 'caches', previous); else Reflect.deleteProperty(globalThis, 'caches'); }
}

test('close detaches delivery without claiming a pending cache read has stopped', async () => withCache(async (release, requests, started) => {
  let notifications = 0;
  const reading = keeper(config, () => { notifications++; }, () => { notifications++; });
  assert.equal(reading.take('program'), undefined);
  await started;
  assert.equal(requests(), 1);
  reading.close(); reading.close();
  assert.equal(reading.has('program'), false);
  assert.equal(reading.take('program'), null);
  assert.equal(reading.reading(), 1);
  release(); await finish(reading);
  assert.equal(notifications, 0);
  assert.equal(reading.take('program'), null);
  assert.equal(requests(), 1);
}));

test('read callback close suppresses ready and drops the unclaimed result', async () => withCache(async release => {
  let ready = 0, reads = 0;
  const reading = keeper(config, () => { ready++; }, () => { reads++; reading.close(); });
  reading.take('program'); release(); await finish(reading);
  assert.equal(reads, 1); assert.equal(ready, 0);
  assert.equal(reading.take('program'), null);
}));

test('read and ready failure are independent of successful cache capture', async () => withCache(async release => {
  const readError = new Error('read notification'), readyError = new Error('wake notification');
  const reading = keeper(config, () => { throw readyError; }, () => { throw readError; });
  reading.take('program'); release(); await finish(reading);
  assert.deepEqual(reading.failures, [readError, readyError]);
  const taken = reading.take('program');
  assert.ok(taken); assert.ok(taken.module instanceof WebAssembly.Module);
  reading.close();
  // Closing the owner cannot revoke a result already returned to a caller.
  assert.ok(new WebAssembly.Instance(taken.module));
}));

test('unclosed keeper delivers once and permits a subsequent fresh read', async () => withCache(async (release, requests) => {
  let ready = 0;
  const reading = keeper(config, () => { ready++; });
  reading.take('program'); release(); await finish(reading);
  assert.ok(reading.take('program'));
  assert.equal(reading.take('program'), undefined);
  await finish(reading);
  assert.ok(reading.take('program'));
  assert.equal(ready, 2); assert.equal(requests(), 2);
  reading.close();
}));
