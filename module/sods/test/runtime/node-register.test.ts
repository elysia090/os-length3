import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {test, type TestContext} from 'node:test';
import {createGuest, type GuestReply, type GuestRequest} from '../../runtime/host/node/execution.ts';

// Private transport evidence only. This deliberately is not translated x86,
// Rust admission/receipt evidence, or an implementation of Linux arch_prctl.
// The only observation of fs comes from the actual Worker's Wasm, after its
// syscall import returns, through stores into the supplied shared memory.
const INITIAL_FS = 0x1122334455667788n;
const BASES = [0x0123456789abcdefn, 0xfedcba9876543210n] as const;
type FsKind = 'mutable-i64' | 'missing' | 'mutable-i32' | 'immutable-i64';
type Bridge = ReturnType<typeof createGuest>;

const leb = (n: number): number[] => n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)];
function signedLeb(n: bigint): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = Number(n & 127n);
    n >>= 7n;
    const last = (n === 0n && !(byte & 64)) || (n === -1n && !!(byte & 64));
    bytes.push(byte | (last ? 0 : 128));
    if (last) return bytes;
  }
}
const name = (s: string) => [...leb(s.length), ...new TextEncoder().encode(s)];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
const i64 = (n: bigint) => [0x42, ...signedLeb(n)];
const address = (n: number) => [0x41, ...signedLeb(BigInt(n))];

function fixture(fsKind: FsKind = 'mutable-i64') {
  // (import "env" "memory" (memory 1 1 shared))
  // (import "env" "syscall" (func (param i64 x 8) (result i64)))
  // (export "run" (func (param i64)))
  // For each of two calls: store its reply, store fs, then publish progress.
  // No main-thread instance or Global is created by this fixture.
  const hasFs = fsKind !== 'missing', fsI32 = fsKind === 'mutable-i32';
  const body = [0]; // no locals
  for (let index = 0; index < 2; index++) {
    body.push(...address(16 + index * 16));
    for (const value of [BigInt(index + 1), 11n, 12n, 13n, 14n, 15n, 16n, BigInt(100 + index)]) body.push(...i64(value));
    body.push(0x10, 0, 0x37, 3, 0); // call syscall; i64.store reply
    body.push(...address(8 + index * 16));
    if (!hasFs) body.push(...i64(0n));
    else body.push(0x23, 0, ...(fsI32 ? [0xad] : [])); // global.get; i64.extend_i32_u
    body.push(0x37, 3, 0, ...address(0), ...i64(BigInt(index + 1)), 0x37, 3, 0);
  }
  body.push(0x0b);
  const exports = [[...name('run'), 0, 1], ...(hasFs ? [[...name('fs'), 3, 0]] : [])];
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [2, 0x60, 8, ...Array<number>(8).fill(0x7e), 1, 0x7e, 0x60, 1, 0x7e, 0]),
    ...section(2, [2, ...name('env'), ...name('memory'), 2, 3, 1, 1, ...name('env'), ...name('syscall'), 0, 0]),
    ...section(3, [1, 1]),
    ...(hasFs ? section(6, [1, fsI32 ? 0x7f : 0x7e, fsKind === 'immutable-i64' ? 0 : 1,
      ...(fsI32 ? [0x41, ...signedLeb(23n)] : i64(INITIAL_FS)), 0x0b]) : []),
    ...section(7, [exports.length, ...exports.flat()]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
  return {
    module: new WebAssembly.Module(bytes),
    memory: new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
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
async function usingGuest(t: TestContext, input: ReturnType<typeof fixture>, body: (bridge: Bridge, cleanup: (release: () => void) => void) => Promise<void>) {
  const bridge = createGuest(input), releases: (() => void)[] = [];
  const stop = () => bridge.requestStop();
  t.signal.addEventListener('abort', stop, {once: true});
  try {
    await guarded(t, bridge.ready);
    await body(bridge, release => releases.push(release));
  } finally {
    for (const release of releases) release();
    bridge.requestStop();
    await bridge.stopped;
    await bridge.requestsSettled();
    t.signal.removeEventListener('abort', stop);
  }
  assert.equal(bridge.diagnostics().exited, true);
  assert.equal((await bridge.stopEvidence()).stopped, true);
}
const snapshot = (memory: WebAssembly.Memory) => Array.from(new BigUint64Array(memory.buffer, 0, 5));

test('Node FS ACK applies two bases to the real Worker Global without resuming either paused syscall', {timeout: 10_000}, async t => {
  const input = fixture(), applied = [deferred<GuestRequest>(), deferred<GuestRequest>()];
  const replies = [deferred<void>(), deferred<void>()];
  await usingGuest(t, input, async (bridge, cleanup) => {
    cleanup(() => { for (const reply of replies) reply.resolve(); });
    await assert.rejects(bridge.stopEvidence(), /Stop has not been requested/);
    let requests = 0, completed = false;
    const running = bridge.run(7n, 1234n, async request => {
      const index = requests++;
      assert.ok(index < 2);
      assert.equal(request.invocation, 7n);
      assert.equal(request.sequence, index + 1);
      assert.equal(request.nr, BigInt(index + 1));
      assert.deepEqual(request.args, [11n, 12n, 13n, 14n, 15n, 16n]);
      assert.equal(request.next, BigInt(100 + index));
      assert.equal(await bridge.applyFs(request, 0n, BASES[index]), 'applied');
      applied[index].resolve(request);
      await replies[index].promise;
      return {kind: 'return', value: index === 0 ? -5n : 42n};
    }).then(outcome => { completed = true; return outcome; });
    for (let index = 0; index < 2; index++) {
      await guarded(t, applied[index].promise);
      const expected = index === 0 ? [0n, 0n, 0n, 0n, 0n] : [1n, BASES[0], BigInt.asUintN(64, -5n), 0n, 0n];
      assert.deepEqual(snapshot(input.memory), expected);
      // Give a wrongly resumed Worker an opportunity to publish its stores or
      // its next request. ACK alone must never let either one happen.
      await delay(30, undefined, {signal: t.signal});
      assert.deepEqual(snapshot(input.memory), expected);
      assert.equal(requests, index + 1);
      assert.equal(completed, false);
      assert.equal(bridge.diagnostics().pendingRequest, true);
      replies[index].resolve();
    }
    assert.deepEqual(await guarded(t, running), {kind: 'returned', unwound: true});
    await bridge.requestsSettled();
    assert.deepEqual(snapshot(input.memory), [2n, BASES[0], BigInt.asUintN(64, -5n), BASES[1], 42n]);
    assert.equal(requests, 2);
    assert.equal(bridge.diagnostics().failureCount, 0);
    assert.equal(bridge.diagnostics().exited, false);
    await assert.rejects(bridge.applyFs(await applied[1].promise, 0n, 0n), /Register dispatch unavailable/);
  });
});

test('Node FS dispatch consumes one exact request and rejects clones, duplicates and stale requests', {timeout: 10_000}, async t => {
  const input = fixture();
  await usingGuest(t, input, async bridge => {
    let first!: GuestRequest, requests = 0;
    const outcome = await guarded(t, bridge.run(1n, 0n, async request => {
      requests++;
      await assert.rejects(bridge.applyFs({...request}, 0n, BASES[0]), /Register dispatch unavailable/);
      if (requests === 1) first = request;
      else await assert.rejects(bridge.applyFs(first, 0n, BASES[0]), /Register dispatch unavailable/);
      const applying = bridge.applyFs(request, 0n, BASES[requests - 1]);
      await assert.rejects(bridge.applyFs(request, 0n, 0n), /Register dispatch unavailable/);
      assert.equal(await applying, 'applied');
      await assert.rejects(bridge.applyFs(request, 0n, 0n), /Register dispatch unavailable/);
      return {kind: 'return', value: 0n};
    }));
    assert.deepEqual(outcome, {kind: 'returned', unwound: true});
    assert.equal(requests, 2);
    assert.deepEqual(snapshot(input.memory), [2n, BASES[0], 0n, BASES[1], 0n]);
    assert.equal(bridge.diagnostics().failureCount, 0);
  });
});

test('Node FS dispatch rejects a genuine foreign Worker request despite matching invocation and sequence', {timeout: 10_000}, async t => {
  const inputs = [fixture(), fixture()], entered = [deferred<GuestRequest>(), deferred<GuestRequest>()];
  const replies = [deferred<void>(), deferred<void>()];
  await usingGuest(t, inputs[0], async (left, cleanupLeft) => {
    cleanupLeft(() => replies[0].resolve());
    await usingGuest(t, inputs[1], async (right, cleanupRight) => {
      cleanupRight(() => replies[1].resolve());
      const bridges = [left, right];
      const running = bridges.map((bridge, index) => bridge.run(1n, 0n, async request => {
        if (request.sequence !== 1) return {kind: 'leave'};
        entered[index].resolve(request);
        await replies[index].promise;
        return {kind: 'return', value: 0n};
      }));
      const requests = await guarded(t, Promise.all(entered.map(item => item.promise)));
      assert.deepEqual(requests[0], requests[1]);
      assert.notEqual(requests[0], requests[1]);
      await assert.rejects(left.applyFs(requests[1], 0n, BASES[1]), /Register dispatch unavailable/);
      await assert.rejects(right.applyFs(requests[0], 0n, BASES[0]), /Register dispatch unavailable/);
      assert.deepEqual(await guarded(t, Promise.all(bridges.map((bridge, index) => bridge.applyFs(requests[index], 0n, BASES[index])))), ['applied', 'applied']);
      for (const input of inputs) assert.deepEqual(snapshot(input.memory), [0n, 0n, 0n, 0n, 0n]);
      for (const reply of replies) reply.resolve();
      assert.deepEqual(await guarded(t, Promise.all(running)), [{kind: 'left', unwound: true}, {kind: 'left', unwound: true}]);
      for (let index = 0; index < 2; index++) {
        assert.deepEqual(snapshot(inputs[index].memory), [1n, BASES[index], 0n, 0n, 0n]);
        assert.equal(bridges[index].diagnostics().failureCount, 0);
      }
    });
  });
});

for (const fsKind of ['missing', 'mutable-i32', 'immutable-i64'] as const) {
  test(`Node FS ${fsKind} never reports applied`, {timeout: 10_000}, async t => {
    const input = fixture(fsKind);
    await usingGuest(t, input, async bridge => {
      let requests = 0;
      const outcome = await guarded(t, bridge.run(1n, 0n, async request => {
        if (++requests !== 1) return {kind: 'leave'};
        const result = await bridge.applyFs(request, 0n, BASES[1]);
        assert.equal(result, fsKind === 'immutable-i64' ? 'unknown' : 'not-applied');
        await assert.rejects(bridge.applyFs(request, 0n, BASES[0]), /Register dispatch unavailable/);
        assert.deepEqual(snapshot(input.memory), [0n, 0n, 0n, 0n, 0n]);
        return {kind: 'return', value: 0n};
      }));
      assert.deepEqual(outcome, {kind: 'left', unwound: true});
      assert.equal(requests, 2);
      assert.deepEqual(snapshot(input.memory), [1n, fsKind === 'missing' ? 0n : fsKind === 'mutable-i32' ? 23n : INITIAL_FS, 0n, 0n, 0n]);
      assert.equal(bridge.diagnostics().failureCount, 0);
    });
  });
}

test('Node actual Worker exit settles a pending FS dispatch as unknown, not not-applied', {timeout: 10_000}, async t => {
  const input = fixture(), registered = deferred<void>(), finish = deferred<GuestReply>();
  await usingGuest(t, input, async (bridge, cleanup) => {
    cleanup(() => finish.resolve({kind: 'leave'}));
    const running = bridge.run(1n, 0n, async request => {
      const applying = bridge.applyFs(request, 0n, BASES[0]);
      // No message event can run between these synchronous calls. Even if the
      // Worker has already set fs, the host register operation is still pending.
      // Termination is real, not a synthetic receipt or a mocked exit event.
      bridge.requestStop();
      assert.equal(bridge.diagnostics().exited, false);
      assert.equal(await applying, 'unknown');
      assert.equal(bridge.diagnostics().exited, true);
      registered.resolve();
      return finish.promise;
    });
    await guarded(t, registered.promise);
    const stopped = await guarded(t, bridge.stopped);
    assert.equal(typeof stopped.code, 'number');
    const outcome = await guarded(t, running);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.unwound, false);
    assert.equal(bridge.diagnostics().pendingRequest, true);
    assert.equal((await bridge.stopEvidence()).stopped, true);
    assert.deepEqual(snapshot(input.memory), [0n, 0n, 0n, 0n, 0n]);
    finish.resolve({kind: 'leave'});
    await guarded(t, bridge.requestsSettled());
    assert.equal(bridge.diagnostics().pendingRequest, false);
  });
});
