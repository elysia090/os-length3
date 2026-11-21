import assert from 'node:assert/strict';
import {test} from 'node:test';
import {retireRootWorker, type RootWorkerControl} from '../retire-worker.ts';

function fixture() {
  let listener: ((e: MessageEvent) => void) | null = null;
  const w = {
    sent: 0, ended: 0,
    postMessage() { w.sent++; },
    terminate() { w.ended++; },
    addEventListener(_type: 'message', fn: (e: MessageEvent) => void) { listener = fn; },
    removeEventListener() { listener = null; },
    emit(data: unknown) { listener?.({data} as MessageEvent); },
  } satisfies RootWorkerControl & {sent: number; ended: number; emit(data: unknown): void};
  return w;
}

test('acknowledgement permits one termination request, never a host-stopped claim', async () => {
  const w = fixture();
  const pending = retireRootWorker(w);
  assert.equal(retireRootWorker(w), pending); assert.equal(w.sent, 1); assert.equal(w.ended, 0);
  w.emit({type: 'output'}); assert.equal(w.ended, 0);
  w.emit({type: 'retiring', owners: {'prepared-tree': 1}});
  const result = await pending;
  assert.equal(result.admission, 'acknowledged'); assert.equal(result.hostStopped, 'unconfirmed'); assert.equal(w.ended, 1);
  w.emit({type: 'retiring'}); assert.equal(w.ended, 1);
});

test('timeout aborts once without treating late acknowledgement as quiescence', async () => {
  const w = fixture(), result = await retireRootWorker(w, 1);
  assert.equal(result.reason, 'timeout'); assert.equal(result.admission, 'unconfirmed');
  assert.equal(result.hostStopped, 'unconfirmed'); assert.equal(w.ended, 1);
  w.emit({type: 'retiring'}); assert.equal(w.ended, 1);
});

test('acknowledge-then-throw request and termination failure both survive reentry', async () => {
  const w = fixture(), request = new Error('post failed'), termination = new Error('terminate failed');
  let reentered: Promise<unknown> | undefined;
  w.postMessage = () => { w.sent++; reentered = retireRootWorker(w); w.emit({type: 'retiring'}); throw request; };
  w.terminate = () => { w.ended++; throw termination; };
  const pending = retireRootWorker(w), result = await pending;
  assert.equal(reentered, pending); assert.equal(w.sent, 1); assert.equal(w.ended, 1);
  assert.equal(result.admission, 'acknowledged'); assert.equal(result.reason, 'request-failure');
  assert.deepEqual(result.failures.map(f => f.error), [request, termination]);
});

test('listener cleanup failure cannot prevent termination request', async () => {
  const w = fixture(), failure = new Error('unlisten failed');
  w.removeEventListener = () => { throw failure; };
  const pending = retireRootWorker(w); w.emit({type: 'retiring'});
  const result = await pending;
  assert.equal(w.ended, 1); assert.equal(result.failures[0].error, failure);
});


test('retirement acknowledgement carries cleanup failures before caller termination', async () => {
  const w = fixture(), pending = retireRootWorker(w);
  w.emit({type: 'retiring', failures: ['Error: mapping publication failed']});
  const result = await pending;
  assert.equal(result.failures[0].phase, 'retire');
  assert.match(String(result.failures[0].error), /mapping publication failed/);
  assert.equal(w.ended, 1); assert.equal(result.hostStopped, 'unconfirmed');
});

test('caller helper consumes the actual private Worker admission acknowledgement', async () => {
  let listener: ((e: MessageEvent) => void) | null = null;
  let handling: Promise<void> | undefined, ended = 0;
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(data: unknown) { listener?.({data} as MessageEvent); }};
  const control: RootWorkerControl = {
    postMessage(message) { handling = host.onmessage!({data: message}); },
    terminate() { ended++; },
    addEventListener(_type, fn) { listener = fn; },
    removeEventListener() { listener = null; },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?retirement-caller', import.meta.url).href);
    const result = await retireRootWorker(control); await handling;
    assert.equal(result.admission, 'acknowledged'); assert.equal(result.hostStopped, 'unconfirmed');
    assert.equal(ended, 1); assert.deepEqual(result.failures, []);
  } finally { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); }
});
