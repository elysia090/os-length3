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

test('real core preparation completing after freeze disposes only its unpublished tree', {skip: !process.env.SODS_TRANSLATOR_WASM || !process.env.SODS_CORE_WASM, timeout: 15_000}, async () => {
  const {readFileSync} = await import('node:fs');
  const core = readFileSync(process.env.SODS_CORE_WASM!);
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
    await host.onmessage!({data: {type: 'start', translator: readFileSync(process.env.SODS_TRANSLATOR_WASM!), fileCore: {module: core, maxFileBytes: 4096}, root: {url: '/unused/', index: {codec: 'zstd', dirs: [], links: [], packs: [{name: 'unused-pack', bytes: 3}], files: [{path: '/lazy', mode: 420, size: 3, pack: 0, at: 0, len: 3, raw: true}]}}, muk: new Uint8Array([1]), box: {config: '{}', words: []}, cwd: '/'}});
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
