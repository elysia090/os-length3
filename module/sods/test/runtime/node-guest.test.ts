import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test, type TestContext} from 'node:test';
import {prepare} from '../../runtime/translation/share.ts';
import {fixedTranslatedModule} from '../../runtime/linux/translated-image.ts';
import {createGuest, type GuestReply} from '../../runtime/host/node/execution.ts';

function fixture() {
  // Historical translator fixture: physical transport evidence, not current
  // translator, Rust syscall integration or the normal Node caller.
  const bytes = Buffer.from(readFileSync(new URL('../fixtures/managed-read-exit/translated.wasm.base64', import.meta.url), 'utf8'), 'base64');
  const prepared = prepare(bytes, {shared: true});
  assert.ok(prepared.segments);
  const module = fixedTranslatedModule(prepared.wasm, {externalData: true});
  const memory = new WebAssembly.Memory({initial: 69, maximum: 69, shared: true});
  const target = new Uint8Array(memory.buffer);
  for (const s of prepared.segments) {
    assert.ok(Number.isSafeInteger(s.offset) && s.offset >= 0 && s.bytes.length <= target.length - s.offset);
  }
  for (const s of prepared.segments) target.set(s.bytes, s.offset);
  return {module, memory};
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
}
async function guarded<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  if (t.signal.aborted) throw t.signal.reason;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(t.signal.reason);
    t.signal.addEventListener('abort', abort, {once: true});
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { t.signal.removeEventListener('abort', abort); }
}
for (const delayed of [false, true]) {
  test(`Node guest synchronous slot transports ${delayed ? 'delayed Promise' : 'immediate'} replies`, {timeout: 10_000}, async t => {
    const input = fixture(), bridge = createGuest(input);
    const stop = () => bridge.requestStop(); t.signal.addEventListener('abort', stop, {once: true});
    try {
      await guarded(t, bridge.ready);
      let requests = 0;
      const outcome = await guarded(t, bridge.run(1n, 4198400n, request => {
        assert.equal(request.invocation, 1n);
        assert.equal(request.sequence, ++requests);
        if (requests === 1) {
          assert.equal(request.nr, 0n);
          assert.equal(request.args[0], 3n); assert.equal(request.args[2], 4n);
          const answer = (): GuestReply => {
            new Uint8Array(input.memory.buffer, Number(request.args[1]), 4).set([97, 98, 99, 100]);
            return {kind: 'return', value: 4n};
          };
          return delayed ? new Promise<GuestReply>(resolve => setTimeout(() => resolve(answer()), 10)) : answer();
        }
        assert.equal(requests, 2); assert.equal(request.nr, 60n); assert.equal(request.args[0], 0n);
        return {kind: 'leave'};
      }));
      assert.deepEqual(outcome, {kind: 'left', unwound: true});
      assert.equal(requests, 2);
      assert.equal(bridge.diagnostics().exited, false); // unwind is not Worker exit
      assert.equal(bridge.diagnostics().failureCount, 0);
      await assert.rejects(bridge.run(2n, 4198400n, () => ({kind: 'leave'})), /unavailable/);
    } finally {
      bridge.requestStop();
      await bridge.stopped;
      await bridge.requestsSettled();
      t.signal.removeEventListener('abort', stop);
    }
    assert.equal(bridge.diagnostics().exited, true);
  });
}
test('Node guest ready failure retains a handle until actual exit', {timeout: 10_000}, async t => {
  const bridge = createGuest({module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), memory: new WebAssembly.Memory({initial: 1, maximum: 1, shared: true})});
  const stop = () => bridge.requestStop(); t.signal.addEventListener('abort', stop, {once: true});
  try {
    await assert.rejects(guarded(t, bridge.ready), /Unsupported guest exports/);
    assert.ok(bridge.diagnostics().failureCount > 0);
    assert.equal(bridge.diagnostics().created, true);
  } finally {
    bridge.requestStop(); await bridge.stopped;
    t.signal.removeEventListener('abort', stop);
  }
  assert.equal(bridge.diagnostics().exited, true);
});
for (const rejectLate of [false, true]) {
  test(`Node exit does not discard pending callback ${rejectLate ? 'rejection' : 'resolution'}`, {timeout: 10_000}, async t => {
    const bridge = createGuest(fixture());
    const entered = deferred<void>(), completion = deferred<GuestReply>();
    const stop = () => bridge.requestStop(); t.signal.addEventListener('abort', stop, {once: true});
    let settled = false;
    try {
      await guarded(t, bridge.ready);
      const running = bridge.run(1n, 4198400n, request => {
        assert.equal(request.nr, 0n); entered.resolve(); return completion.promise;
      });
      await guarded(t, entered.promise);
      bridge.requestStop();
      await guarded(t, bridge.stopped);
      assert.equal(bridge.diagnostics().pendingRequest, true);
      const outcome = await guarded(t, running);
      assert.equal(outcome.kind, 'failed');
      assert.equal(outcome.unwound, false); // host exit evidence is separate
      const before = bridge.diagnostics().failureCount;
      if (rejectLate) completion.reject(new Error('late source failure'));
      else completion.resolve({kind: 'return', value: 4n});
      settled = true;
      await guarded(t, bridge.requestsSettled());
      assert.equal(bridge.diagnostics().pendingRequest, false);
      assert.equal(bridge.diagnostics().failureCount, before + (rejectLate ? 1 : 0));
    } finally {
      bridge.requestStop(); await bridge.stopped;
      if (!settled) completion.resolve({kind: 'leave'});
      await bridge.requestsSettled();
      t.signal.removeEventListener('abort', stop);
    }
  });
}
