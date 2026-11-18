import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorkerLifetime} from '../worker-lifetime.ts';

test('freeze rejects reentrant admission but records in-flight and newly completed owners without collecting them', () => {
  const lifetime = new WorkerLifetime();
  const preparing = lifetime.enter('prepare');
  const tree = {dispose() { assert.fail('no collection authority'); }};
  lifetime.freeze();
  assert.throws(() => lifetime.enter('start'), /retiring/);
  const root = lifetime.observe('tree', tree);
  preparing.release(); preparing.release();
  assert.deepEqual(lifetime.snapshot(), {tree: 1});
  lifetime.freeze(); assert.equal(lifetime.accepting, false);
  root.release(); assert.deepEqual(lifetime.snapshot(), {});
});

test('same object under distinct operations has distinct ownership observations', () => {
  const lifetime = new WorkerLifetime(), value = {};
  const a = lifetime.observe('kernel', value), b = lifetime.observe('kernel', value);
  a.release(); assert.deepEqual(lifetime.snapshot(), {kernel: 1});
  lifetime.freeze(); b.release(); assert.deepEqual(lifetime.snapshot(), {});
});

test('actual Worker closes admission before acknowledgement reentry without claiming tree disposal', async () => {
  const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
  let reentered: Promise<void> | undefined;
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
    messages.push(message);
    if (message.type === 'retiring' && !reentered) reentered = host.onmessage!({data: {type: 'input', bytes: new Uint8Array([1])}});
  }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?retirement-admission', import.meta.url).href);
    await host.onmessage!({data: {type: 'retire'}}); await reentered;
    assert.equal(messages[0].type, 'retiring');
    assert.equal(messages[1].type, 'error'); assert.match(messages[1].message!, /retiring/);
    await host.onmessage!({data: {type: 'retire'}});
    assert.equal(messages[2].type, 'retiring');
    assert.ok(messages.every(m => m.type !== 'disposed' && m.type !== 'stopped'));
  } finally { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); }
});

test('retirement during actual asynchronous preparation prevents a foreground kernel publication', {skip: !process.env.SODS_TRANSLATOR_WASM, timeout: 10_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) { messages.push(message); }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?retirement-preparing', import.meta.url).href);
    const starting = host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: new Uint8Array([1]), box: {config: '{}', words: []}, cwd: '/'}});
    await host.onmessage!({data: {type: 'retire'}});
    const ack = messages.find(m => m.type === 'retiring')!;
    assert.equal(ack.owners?.preparation, 1); assert.equal(ack.owners?.['command:start'], 1);
    await starting;
    assert.ok(messages.some(m => m.type === 'error' && /retiring/.test(m.message ?? '')));
    assert.ok(messages.every(m => m.type !== 'threads'));
    await host.onmessage!({data: {type: 'retire'}});
    assert.deepEqual(messages.at(-1)?.owners, {});
  } finally { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); }
});

test('retire reentry from threads publication does not start serve or reject the message handler', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const messages: {type: string; message?: string}[] = [];
  let retiring: Promise<void> | undefined;
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
    messages.push(message);
    if (message.type === 'threads') retiring = host.onmessage!({data: {type: 'retire'}});
  }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?retirement-threads', import.meta.url).href);
    await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), box: {config: '{}', words: []}, cwd: '/'}});
    await retiring;
    assert.ok(messages.some(m => m.type === 'threads'));
    assert.ok(messages.some(m => m.type === 'retiring'));
    assert.ok(messages.every(m => m.type !== 'error'), JSON.stringify(messages));
  } finally { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); }
});

test('real core preparation completing after freeze disposes only its unpublished tree', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.SODS_FILE_STORE_WASM, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const core = readFileSync(process.env.SODS_FILE_STORE_WASM!);
  const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) { messages.push(message); }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'), compile = WebAssembly.compile;
  let retiring: Promise<void> | undefined;
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?retirement-core-result', import.meta.url).href);
    WebAssembly.compile = source => {
      if (source === core) retiring = host.onmessage!({data: {type: 'retire'}});
      return compile(source);
    };
    await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), fileStore: {module: core, maxFileBytes: 4096}, root: {url: '/unused/', index: {codec: 'zstd', dirs: [], links: [], packs: [{name: 'unused-pack', bytes: 3}], files: [{path: '/lazy', mode: 420, size: 3, pack: 0, at: 0, len: 3, raw: true}]}}, muk: new Uint8Array([1]), box: {config: '{}', words: []}, cwd: '/'}});
    await retiring;
    await host.onmessage!({data: {type: 'retire'}});
    assert.equal(messages.at(-1)?.owners?.['prepared-tree'], undefined);
    assert.equal(messages.at(-1)?.owners?.preparation, undefined);
    assert.ok(messages.every(m => m.type !== 'threads'));
    assert.ok(messages.some(m => m.type === 'error' && /retiring/.test(m.message ?? '')));
  } finally {
    WebAssembly.compile = compile;
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});

test('actual muk exit publishes one ordered byte boundary before exit and rejects later production', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const messages: {type: string; bytes?: Uint8Array; sentBytes?: number; message?: string}[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
    messages.push(message); if (message.type === 'exit' || message.type === 'error') finish();
  }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await import(new URL('../worker.ts?natural-output-boundary', import.meta.url).href);
    await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), box: {config: '{}', words: []}, cwd: '/', mirror: '/run/box'}});
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('guest did not exit')), 10_000); })]);
    const boundaries = messages.filter(m => m.type === 'output-boundary');
    assert.equal(boundaries.length, 1, JSON.stringify(messages.map(m => ({type: m.type, message: m.message}))));
    const boundaryAt = messages.findIndex(m => m.type === 'output-boundary'), exitAt = messages.findIndex(m => m.type === 'exit');
    assert.ok(boundaryAt < exitAt);
    assert.equal(boundaries[0].sentBytes, messages.slice(0, boundaryAt).reduce((n, m) => n + (m.type === 'output' ? m.bytes!.length : 0), 0));
    assert.ok(messages.some(m => m.type === 'changes'));
    assert.ok(messages.some(m => m.type === 'output'));
    await host.onmessage!({data: {type: 'input', bytes: new Uint8Array([1])}});
    assert.match(messages.at(-1)?.message ?? '', /boundary is closed/);
    assert.ok(messages.slice(boundaryAt + 1).every(m => m.type !== 'output' && m.type !== 'changes'));
  } finally {
    clearTimeout(timer); await host.onmessage?.({data: {type: 'retire'}});
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});

test('output-send reentry cannot establish a boundary before the send commits its bytes', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const messages: {type: string; bytes?: Uint8Array; sentBytes?: number; message?: string}[] = [];
  let reentered = false, nested: Promise<void> | undefined;
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
    messages.push(message);
    if (message.type === 'output' && !reentered) { reentered = true; nested = host.onmessage!({data: {type: 'drained', n: 0}}); }
  }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'), inline = process.env.SODS_INLINE;
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true}); process.env.SODS_INLINE = '1';
  try {
    await import(new URL('../worker.ts?output-send-reentry', import.meta.url).href);
    await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), box: {config: '{}', words: []}, cwd: '/'}});
    await nested;
    assert.equal(reentered, true);
    assert.ok(messages.some(m => m.type === 'error' && /already active/.test(m.message ?? '')));
    const boundaryAt = messages.findIndex(m => m.type === 'output-boundary');
    assert.ok(boundaryAt >= 0);
    assert.equal(messages[boundaryAt].sentBytes, messages.slice(0, boundaryAt).reduce((n, m) => n + (m.type === 'output' ? m.bytes!.length : 0), 0));
    assert.equal(messages.filter(m => m.type === 'output-boundary').length, 1);
  } finally {
    await host.onmessage?.({data: {type: 'retire'}});
    if (inline === undefined) delete process.env.SODS_INLINE; else process.env.SODS_INLINE = inline;
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});

for (const phase of ['construction', 'capture'] as const) {
  test(`Mirror ${phase} reentry cannot publish after retirement`, {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async t => {
    const {readFileSync} = await import('node:fs');
    const {Mirror, Kernel} = await import('../../../sods/runtime/linux.ts');
    const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
    const reached = Promise.withResolvers<void>();
    void reached.promise.catch(() => {}); // Start can fail before the caller reaches the barrier.
    const abort = () => reached.reject(t.signal.reason);
    t.signal.addEventListener('abort', abort, {once: true});
    let frozen = false, lateHeldReads = 0;
    const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
      messages.push(message);
      if (message.type === 'error' && !frozen) reached.reject(new Error(message.message));
    }};
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
    const now = Mirror.prototype.now, changes = Mirror.prototype.changes, held = Kernel.prototype.held;
    Kernel.prototype.held = function () { if (frozen) lateHeldReads++; return held.call(this); };
    let retiring: Promise<void> | undefined;
    const retire = () => {
      if (frozen) return;
      frozen = true;
      retiring = host.onmessage!({data: {type: 'retire'}});
      reached.resolve();
    };
    Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
    try {
      await import(new URL(`../worker.ts?mirror-retirement-${phase}`, import.meta.url).href);
      // Model a synchronous loader/mapping hook inside the actual Mirror call;
      // no UI, native session or positive host-stop claim is involved.
      if (phase === 'construction') Mirror.prototype.now = function () { const result = now.call(this); retire(); return result; };
      else Mirror.prototype.changes = function () { retire(); return {dirs: ['late'], files: [], removed: []}; };
      await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), box: {config: '{}', words: []}, cwd: '/', mirror: '/run/box'}});
      // Start can return before the Remote Worker first reaches report.
      // Observe the actual mirror hook, not elapsed time after admission.
      await reached.promise;
      assert.ok(retiring); await retiring;
      const at = messages.findIndex(m => m.type === 'retiring');
      assert.ok(at >= 0);
      assert.ok(messages.slice(at + 1).every(m => m.type !== 'changes'));
      if (phase === 'construction') assert.ok(messages.every(m => m.type !== 'threads'));
      await host.onmessage!({data: {type: 'retire'}});
      assert.equal(messages.at(-1)?.owners?.mirror, undefined);
      assert.equal(messages.at(-1)?.owners?.['prepared-tree'], 1); // still quarantined, not disposed
      assert.equal(lateHeldReads, 0); // late paused callbacks cannot inspect a retired kernel
    } finally {
      t.signal.removeEventListener('abort', abort);
      // Also close an admitted root when setup, the barrier, or an assertion
      // fails. Restoring hooks alone cannot stop its serving Worker.
      try { await host.onmessage?.({data: {type: 'retire'}}); }
      finally {
        Mirror.prototype.now = now; Mirror.prototype.changes = changes; Kernel.prototype.held = held;
        if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
      }
    }
  });
}

test('operation drain waits for all registered finally releases without consuming unknown owners', async () => {
  const lifetime = new WorkerLifetime();
  assert.throws(() => lifetime.settledOperations(), /admission closure/);
  const preparing = lifetime.enter('preparation'), serving = lifetime.enter('serve');
  lifetime.observe('unknown-image', {});
  lifetime.freeze();
  let done = false;
  const drained = lifetime.settledOperations();
  assert.equal(lifetime.settledOperations(), drained);
  void drained.then(() => { done = true; });
  preparing.release(); preparing.release();
  await Promise.resolve(); assert.equal(done, false);
  // Even a newly recorded late result is not a registered operation or proof
  // of safe disposal. It must remain visible after the operation drain.
  lifetime.observe('late-tree', {});
  serving.release(); await drained;
  assert.equal(done, true);
  assert.deepEqual(lifetime.snapshot(), {'unknown-image': 1, 'late-tree': 1});
  assert.throws(() => lifetime.enter('reentrant-start'), /retiring/);
});

test('operation finally after failure drains but does not erase the failure or the owner', async () => {
  const lifetime = new WorkerLifetime(), error = new Error('cleanup failed');
  const operation = lifetime.enter('rehearsal');
  lifetime.observe('kernel', {});
  let continueOperation!: () => void;
  const running = (async () => {
    try { await new Promise<void>(resolve => { continueOperation = resolve; }); throw error; }
    catch (failure) { lifetime.failures.push(failure); }
    finally { operation.release(); }
  })();
  lifetime.freeze();
  const drained = lifetime.settledOperations();
  continueOperation(); await drained; await running;
  assert.deepEqual(lifetime.failures, [error]);
  assert.deepEqual(lifetime.snapshot(), {kernel: 1});
});

for (const mode of ['inline', 'inline-rehearsal', 'inline-failure', 'inline-preparation-failure', 'node', 'node-rehearsal', 'node-unconfirmed'] as const) {
  test(`used ${mode} root drops only a proven inactive foreground reference`, {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
    const {readFileSync} = await import('node:fs');
    const {Kernel, RemoteKernel} = await import('../../../sods/runtime/linux.ts');
    const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
    let exited!: () => void;
    const done = new Promise<void>(resolve => { exited = resolve; });
    const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
      messages.push(message); if (message.type === 'exit' || message.type === 'error') exited();
    }};
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'), inline = process.env.SODS_INLINE;
    const held = Kernel.prototype.held, halt = Kernel.prototype.halt, stops = RemoteKernel.prototype.snapshotWorkerStops;
    let captured: InstanceType<typeof Kernel> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    Kernel.prototype.held = function () { captured = this; return held.call(this); };
    if (mode.startsWith('node')) delete process.env.SODS_INLINE; else process.env.SODS_INLINE = '1';
    Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
    try {
      await import(new URL(`../worker.ts?foreground-release-${mode}`, import.meta.url).href);
      await host.onmessage!({data: {rehearse: mode.endsWith('-rehearsal') ? {config: '{}', words: []} : undefined, type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), box: {config: '{}', words: []}, cwd: '/'}});
      await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('guest did not exit')), 10_000); })]);
      assert.ok(messages.some(m => m.type === 'exit'), JSON.stringify(messages));
      assert.ok(captured);
      const sources = [...captured.images.values()].map(entry => [entry.image, entry.image.source] as const);
      if (mode === 'inline-preparation-failure') {
        // Inject an unresolved preparation root through the public Kernel shape, not stop evidence.
        const roots: NonNullable<typeof captured.failedPreparations> = new Set();
        roots.add({} as Parameters<typeof roots.add>[0]);
        captured.failedPreparations = roots;
      }
      if (mode === 'inline-failure') Kernel.prototype.halt = () => { throw new Error('injected halt failure'); };
      if (mode === 'node-unconfirmed') RemoteKernel.prototype.snapshotWorkerStops = async () => ({captured: 1, observedStopped: 0, unconfirmed: 1, failures: []});
      await host.onmessage!({data: {type: 'retire'}});
      // Snapshot only the private field token. Unknown graph/tree owners must
      // survive regardless of whether this one reference is removed.
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        await host.onmessage!({data: {type: 'retire'}});
        if (mode === 'inline-failure' || mode === 'inline-preparation-failure' || mode === 'node-unconfirmed' || !messages.at(-1)?.owners?.['foreground-reference']) break;
      }
      const owners = messages.at(-1)?.owners;
      assert.equal(owners?.['foreground-reference'], mode === 'inline-failure' || mode === 'inline-preparation-failure' || mode === 'node-unconfirmed' ? 1 : undefined);
      assert.equal(owners?.['foreground-kernel'], 1);
      assert.equal(owners?.['prepared-tree'], 1);
      if (mode === 'inline-rehearsal') assert.equal(owners?.['rehearsal-initial-mounts-retired'], 1);
      if (mode === 'node-rehearsal') assert.equal(owners?.['rehearsal-host-unconfirmed'], 1);
      for (const [image, source] of sources) assert.equal(image.source, source); // no alias invalidation
      assert.ok(captured.vfs.file('/run/box/muk').bytes().length);
    } finally {
      clearTimeout(timer); Kernel.prototype.held = held; Kernel.prototype.halt = halt; RemoteKernel.prototype.snapshotWorkerStops = stops;
      if (inline === undefined) delete process.env.SODS_INLINE; else process.env.SODS_INLINE = inline;
      if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
    }
  });
}

test('failed optional rehearsal cannot become successful ownership evidence after a later run', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const {Kernel} = await import('../../../sods/runtime/linux.ts');
  const messages: {type: string; owners?: Record<string, number>; message?: string}[] = [];
  let exited!: () => void;
  const done = new Promise<void>(resolve => { exited = resolve; });
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) {
    messages.push(message); if (message.type === 'exit' || message.type === 'error') exited();
  }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'), inline = process.env.SODS_INLINE, pump = Kernel.prototype.pump;
  let injected = false, timer: ReturnType<typeof setTimeout> | undefined;
  Kernel.prototype.pump = function () {
    const result = pump.call(this);
    if (!injected && result.status !== undefined) { injected = true; throw new Error('rehearsal completion failed'); }
    return result;
  };
  process.env.SODS_INLINE = '1';
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?rehearsal-failure-owner', import.meta.url).href);
    const box = {config: '{}', words: []};
    await host.onmessage!({data: {type: 'ready', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), rehearse: box}});
    await host.onmessage!({data: {type: 'start', box, cwd: '/'}});
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('guest did not exit')), 10_000); })]);
    assert.equal(injected, true);
    assert.ok(messages.some(m => m.type === 'exit'), JSON.stringify(messages));
    await host.onmessage!({data: {type: 'retire'}});
    await new Promise(resolve => setTimeout(resolve, 10));
    await host.onmessage!({data: {type: 'retire'}});
    const owners = messages.at(-1)?.owners;
    assert.equal(owners?.['rehearsal-operation'], undefined); // settled != successful
    assert.equal(owners?.['foreground-reference'], 1); // failure remains a closed gate
    assert.equal(owners?.['rehearsal-kernel'], 1);
    assert.equal(owners?.['prepared-tree'], 1);
  } finally {
    clearTimeout(timer); Kernel.prototype.pump = pump;
    if (inline === undefined) delete process.env.SODS_INLINE; else process.env.SODS_INLINE = inline;
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});

test('rehearsal timer stop failure is retained without pretending the pending operation ended', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.RICEBOX_MUK_FILE, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const {Kernel} = await import('../../../sods/runtime/linux.ts');
  const messages: {type: string; owners?: Record<string, number>}[] = [];
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>), postMessage(message: typeof messages[number]) { messages.push(message); }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'), inline = process.env.SODS_INLINE;
  const pump = Kernel.prototype.pump, halt = Kernel.prototype.halt, schedule = globalThis.setTimeout;
  let captured: InstanceType<typeof Kernel> | undefined, fired!: () => void, timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<void>(resolve => { fired = resolve; });
  // Keep a real initialized inline kernel waiting, and accelerate only its
  // rehearsal deadline. The timer's stop callback is the production callback.
  Kernel.prototype.pump = function () { captured = this; return {waiting: true}; };
  Kernel.prototype.halt = function () { captured = this; fired(); throw new Error('timer stop failed'); };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => schedule(callback, ms === 2000 ? 1 : ms, ...args)) as typeof setTimeout;
  process.env.SODS_INLINE = '1';
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  try {
    await import(new URL('../worker.ts?rehearsal-timer-failure', import.meta.url).href);
    await host.onmessage!({data: {type: 'ready', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), muk: readFileSync(process.env.RICEBOX_MUK_FILE!), rehearse: {config: '{}', words: []}}});
    await Promise.race([stopped, new Promise((_, reject) => { timeout = schedule(() => reject(new Error('rehearsal timer did not fire')), 10_000); })]);
    await host.onmessage!({data: {type: 'retire'}});
    // Freeze stops the private loop later; timer failure itself did not release it.
    assert.equal(messages.find(m => m.type === 'retiring')?.owners?.['rehearsal-operation'], 1);
    await new Promise(resolve => schedule(resolve, 10));
    await host.onmessage!({data: {type: 'retire'}});
    assert.equal(messages.at(-1)?.owners?.['rehearsal-operation'], undefined);
    assert.equal(messages.at(-1)?.owners?.['prepared-tree'], 1);
    assert.equal(messages.at(-1)?.owners?.['rehearsal-kernel'], 1);
  } finally {
    clearTimeout(timeout); globalThis.setTimeout = schedule; Kernel.prototype.pump = pump; Kernel.prototype.halt = halt;
    if (captured) halt.call(captured); // test-owned cleanup, not managed disposal
    if (inline === undefined) delete process.env.SODS_INLINE; else process.env.SODS_INLINE = inline;
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});
