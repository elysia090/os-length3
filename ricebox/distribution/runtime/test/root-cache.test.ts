import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import {setImmediate as turn} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {madeBy} from '../../../sods/runtime/translate.ts';
import {createRoot, type Stage} from '../root.ts';
import {createAssetCache} from '../asset-cache.ts';
import type {About, Index} from '../root-types.ts';

const emptyWasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function fixture(t: TestContext, base: string) {
  const page = new URL('https://app.example.test/workspace/');
  const url = (name: string | Request) => name instanceof Request ? name.url : new URL(name, page).href;
  const install = (name: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  };
  const entries = new Map<string, Response>(), prefs = new Map<string, string>();
  const cache = {
    async keys() { return [...entries.keys()].map(absolute => new Request(absolute)); },
    async match(name: string | Request) { return entries.get(url(name))?.clone(); },
    async put(name: string | Request, response: Response) { entries.set(url(name), response); },
    async delete(name: string | Request) { return entries.delete(url(name)); },
  };
  install('location', page);
  install('caches', {async open() { return cache; }});
  install('localStorage', {
    getItem(key: string) { return prefs.get(key) ?? null; },
    setItem(key: string, value: string) { prefs.set(key, value); },
  });
  const requests: string[] = [], assets = new Map<string, Uint8Array>();
  const streams = new Map<string, () => ReadableStream<Uint8Array<ArrayBuffer>>>();
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const path = url(input); requests.push(path);
    const bytes = assets.get(path);
    return new Response(streams.get(path)?.() ?? (bytes && new Uint8Array(bytes)), {status: bytes ? 200 : 404, headers: {'content-type': 'application/json'}});
  });
  const translator = new Uint8Array(gzipSync(emptyWasm)), sha256 = hash(translator);
  const pack = 'b'.repeat(64);
  const index: Index = {
    name: 'fixture', version: '1', sha256: 'a'.repeat(64), codec: 'zstd',
    packs: [{name: `${pack}.pack`, owner: 'fixture', bytes: 100}], files: [], dirs: [], links: [], translations: [],
    translator: {path: `blobs/${sha256}.bin`, sha256, size: translator.length, bytes: emptyWasm.length, name: 'sods', version: '1', wasm: hash(emptyWasm)},
  };
  const publish = (metadata: Partial<About> = {}) => {
    const body = json(index), id = hash(body), path = `index-${id}.json`;
    const about: About = {name: index.name, version: '1', sha256: index.sha256, bytes: 1, file: 'root.tar.zst',
      root: {name: 'fixture', profile: 'fixture'}, index: {path, sha256: id, size: body.length},
      translator: {name: index.translator.name, version: index.translator.version}, ...metadata};
    assets.set(url(base + 'webroot.json'), json(about));
    assets.set(url(base + path), body);
    assets.set(url(base + index.translator.path), translator);
    return about;
  };
  const root = () => createRoot({base, usedKey: 'used', planKey: 'plan', message: key => key,
    missing: () => 'missing release', errorText: String});
  const blob = (bytes: Uint8Array) => {
    const stored = new Uint8Array(gzipSync(bytes));
    const sha256 = hash(stored), path = `blobs/${sha256}.bin`;
    assets.set(url(base + path), stored);
    return {path, sha256, size: stored.length, bytes: bytes.length};
  };
  return {assets, streams, requests, index, pack, entries, prefs, cache, root, publish, url, install, blob};
}

for (const base of ['layers/', 'https://assets.example.test/webroot/']) {
  test(`runtime retains live cached translations and drops old files for ${base}`, async t => {
    const f = fixture(t, base), about = f.publish(), root = f.root();
    const good = `${f.pack}_64_8`, old = `${'c'.repeat(64)}_64_8`;
    const tag = madeBy(f.index.translator.sha256, root.threadsApart());
    const main = `${base}tr/${good}-${tag}.wasm`, more = `${base}tr/${good}-${tag}.more`;
    const oldMain = `${base}tr/${old}-${tag}.wasm`;
    for (const path of [main, more, oldMain]) await f.cache.put(path, new Response('cached translation'));
    // Earlier builds wrote pathname and URL keys inconsistently; preserve
    // the last-use time for a live entry when reading the existing record.
    f.prefs.set('used', JSON.stringify({
      [new URL(f.url(main)).pathname]: 11, [more]: 16, [f.url(oldMain)]: 22,
    }));
    const loaded = await root.execution.load();
    await new Promise(resolve => setImmediate(resolve));
    const kept = await root.keptNow(loaded);
    assert.deepEqual(kept?.at, {[good]: {main: f.url(main), more: f.url(more)}});
    assert.equal(f.entries.has(f.url(oldMain)), false);
    assert.equal(f.entries.has(f.url(base + about.index.path)), true);
    assert.equal(f.entries.has(f.url(base + f.index.translator.path)), true);
    const uses = JSON.parse(f.prefs.get('used') ?? '{}');
    assert.equal(uses[f.url(main)], 11);
    assert.equal(uses[f.url(more)], 16);
    assert.equal(uses[f.url(oldMain)], undefined);
    // A new caller at the same address should only fetch the release and
    // optional maker metadata, not the already verified index or translator.
    f.requests.length = 0;
    await f.root().loadWebroot();
    assert.deepEqual(new Set(f.requests), new Set([f.url(base + 'webroot.json'), f.url(base + 'muk.json')]));
  });
}

test('all runtime readers bind an authenticated index to this release', async t => {
  const f = fixture(t, '/layers/');
  f.index.version = 'another version';
  f.publish();
  const root = f.root();
  for (const read of [root.rootIndex, root.loadWebroot, root.execution.load]) {
    await assert.rejects(read(), /distribution and index disagree/);
  }
});

test('overlapping metadata and execution demand read one exact index cold and warm', {timeout: 5000}, async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish();
  const indexURL = f.url(base + about.index.path);
  const body = f.assets.get(indexURL)!;
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.streams.set(indexURL, () => new ReadableStream({
    async start(stream) {
      started.resolve();
      await release.promise;
      stream.enqueue(new Uint8Array(body));
      stream.close();
    },
  }));
  const root = f.root();
  const cold = Promise.all([root.rootIndex(), root.execution.load()]);
  await started.promise;
  await turn(); // The second consumer reaches its read before the first body finishes.
  release.resolve();
  const [metadata, prepared] = await cold;
  assert.deepEqual(metadata, prepared.index);
  assert.notEqual(metadata, prepared.index, 'each consumer owns its parsed index');
  assert.notEqual(metadata?.files, prepared.index.files);
  assert.equal(f.requests.filter(url => url === indexURL).length, 1);
  assert.equal(f.requests.filter(url => url === f.url(base + 'webroot.json')).length, 2, 'not a shared release selection');
  await turn();
  assert.ok(f.entries.has(indexURL));

  const match = t.mock.method(f.cache, 'match');
  f.requests.length = 0;
  const warm = f.root();
  await Promise.all([warm.rootIndex(), warm.execution.load()]);
  assert.ok(!f.requests.includes(indexURL));
  assert.equal(match.mock.calls.filter(({arguments: [name]}) => f.url(name) === indexURL).length, 1);
});

test('sharing verified bytes does not share a release binding', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish();
  const get = fetch;
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) =>
    f.url(input) === f.url(base + 'webroot.json') && init?.cache === 'no-cache'
      ? Promise.resolve(Response.json({...about, version: 'another release'})) : get(input, init));
  const root = f.root();
  const [metadata, prepared] = await Promise.allSettled([root.rootIndex(), root.execution.load()]);
  assert.equal(metadata.status, 'rejected');
  assert.match(String(metadata.reason), /distribution and index disagree/);
  assert.equal(prepared.status, 'fulfilled');
  assert.equal(prepared.value.index.version, about.version);
});

test('same-path descriptors with different sizes cannot join the same read', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish(), at = base + about.index.path;
  // Both assets are already warm: a cold translator write also inspects the
  // cache's index response header for quota accounting, not an index demand.
  for (const url of [at, base + f.index.translator.path]) {
    await f.cache.put(url, new Response(new Uint8Array(f.assets.get(f.url(url))!)));
  }
  const get = fetch;
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) =>
    f.url(input) === f.url(base + 'webroot.json') && init?.cache === 'no-cache'
      ? Promise.resolve(Response.json({...about, index: {...about.index, size: about.index.size + 1}})) : get(input, init));
  const root = f.root(), match = t.mock.method(f.cache, 'match');
  const [metadata, prepared] = await Promise.allSettled([root.rootIndex(), root.execution.load()]);
  assert.equal(metadata.status, 'rejected');
  assert.match(String(metadata.reason), /wrong size/);
  assert.equal(prepared.status, 'fulfilled');
  assert.equal(prepared.value.generation, about.index.sha256);
  assert.equal(match.mock.calls.filter(({arguments: [name]}) => f.url(name) === f.url(at)).length, 2);
});

test('a shared index failure does not survive a retry in the same loader', {timeout: 5000}, async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish(), indexURL = f.url(base + about.index.path);
  const body = f.assets.get(indexURL)!;
  f.assets.delete(indexURL);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), get = fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (f.url(input) === indexURL) {
      started.resolve();
      await release.promise;
    }
    return get(input, init);
  });
  const root = f.root(), failed = Promise.allSettled([root.rootIndex(), root.execution.load()]);
  await started.promise;
  await turn();
  release.resolve();
  for (const result of await failed) {
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /404/);
  }
  assert.equal(f.requests.filter(url => url === indexURL).length, 1);

  f.assets.set(indexURL, body);
  const [metadata, prepared] = await Promise.all([root.rootIndex(), root.execution.load()]);
  assert.deepEqual(metadata, prepared.index);
  assert.equal(f.requests.filter(url => url === indexURL).length, 2);
});

test('a settled index read is not a second asset cache', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish(), root = f.root();
  await root.rootIndex();
  await turn();
  await f.cache.delete(base + about.index.path);
  await root.execution.load();
  assert.equal(f.requests.filter(url => url === f.url(base + about.index.path)).length, 2);
});

test('the read-only index does not accept a retired file owner', async t => {
  const f = fixture(t, '/layers/');
  Object.assign(f.index, {fileStore: null});
  f.publish();
  await assert.rejects(f.root().rootIndex(), /Unsupported file owner/);
});

test('runtime does not fetch an index from a noncanonical path', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish();
  const path = 'index.json';
  f.assets.set(f.url(base + path), f.assets.get(f.url(base + about.index.path))!);
  f.publish({index: {...about.index, path}});
  const root = f.root();
  for (const read of [root.rootIndex, root.loadWebroot, root.execution.load]) {
    await assert.rejects(read(), /invalid index descriptor/);
  }
  assert.equal(f.requests.includes(f.url(base + path)), false);
});

test('a saved startup plan cannot substitute its translator for the authenticated index', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish(), root = f.root();
  const changedWasm = Uint8Array.of(...emptyWasm, 0, 2, 1, 120); // one custom section named x
  const bytes = new Uint8Array(gzipSync(changedWasm)), sha256 = hash(bytes);
  const changed = {...f.index.translator, path: `blobs/${sha256}.bin`, sha256, size: bytes.length, bytes: changedWasm.length};
  const index = f.assets.get(f.url(base + about.index.path))!;
  await f.cache.put(base + about.index.path, new Response(new Uint8Array(index)));
  await f.cache.put(base + changed.path, new Response(bytes));
  f.prefs.set('plan', JSON.stringify({sha256: about.sha256, index: about.index, translator: changed, first: []}));

  const loaded = await root.loadWebroot();
  assert.equal(WebAssembly.Module.customSections(loaded.translator, 'x').length, 0);
  assert.ok(f.requests.includes(f.url(base + f.index.translator.path)), 'fetch translation named by the verified index');
});

test('a malformed saved startup plan is discarded without blocking a fresh load', async t => {
  const f = fixture(t, '/layers/'), about = f.publish();
  for (const first of [null, [null]]) {
    f.prefs.set('plan', JSON.stringify({sha256: about.sha256, index: about.index, translator: f.index.translator, first}));
    const loaded = await f.root().loadWebroot();
    assert.equal(loaded.index.sha256, about.sha256);
  }
});

test('cached bytes must still match the current release descriptor size', async t => {
  const base = '/layers/', f = fixture(t, base), about = f.publish();
  const bytes = f.assets.get(f.url(base + about.index.path))!;
  await f.cache.put(base + about.index.path, new Response(new Uint8Array(bytes)));
  f.publish({index: {...about.index, size: about.index.size + 1}});
  await assert.rejects(f.root().rootIndex(), /wrong size/);
});

test('quota eviction stops once the oldest asset makes room for a new one', async t => {
  const base = 'https://assets.example.test/webroot/', f = fixture(t, base);
  f.install('navigator', {storage: {async estimate() { return {quota: 400, usage: 390}; }}});
  const storage = createAssetCache({base, usedKey: 'used'});
  const old = base + 'old', recent = base + 'recent', adding = base + 'adding';
  const stored = () => new Response(new Uint8Array(30), {headers: {'content-length': '30'}});
  // Insert out of order: last use, not insertion order, selects the eviction.
  await f.cache.put(recent, stored());
  await f.cache.put(old, stored());
  f.prefs.set('used', JSON.stringify({[old]: 1, [new URL(recent).pathname]: 2}));

  assert.equal(await storage.keep(adding, new Uint8Array(20)), true);
  assert.equal(f.entries.has(old), false);
  assert.equal(f.entries.has(recent), true);
  assert.equal(f.entries.has(adding), true);
});

test('both execution profiles require the Muk descriptor to name its digest', async t => {
  const base = '/layers/', f = fixture(t, base);
  f.publish();
  const bytes = new TextEncoder().encode('fixture maker');
  const path = `blobs/${'c'.repeat(64)}.bin`;
  f.assets.set(f.url(base + path), bytes);
  f.assets.set(f.url(base + 'muk.json'), json({path, sha256: hash(bytes), size: bytes.length}));
  const root = f.root();
  for (const read of [root.loadWebroot, root.execution.load]) {
    await assert.rejects(read(), /invalid blob descriptor/);
  }
  assert.equal(f.requests.includes(f.url(base + path)), false);
});

test('asset checks copy shared buffers instead of trying to transfer them', async t => {
  const base = '/layers/', f = fixture(t, base);
  class CheckingWorker extends EventTarget {
    postMessage(data: {id: number; bytes: ArrayBuffer}, transfer: ArrayBuffer[]) {
      const received = structuredClone(data, {transfer});
      const bytes = new Uint8Array(received.bytes);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: {id: received.id, bytes: received.bytes, sha256: hash(bytes)},
      })));
    }
  }
  f.install('Worker', CheckingWorker);
  const storage = createAssetCache({base, usedKey: 'used'});
  const source = new Uint8Array(new SharedArrayBuffer(4));
  source.set([1, 2, 3, 4]);
  const answer = await storage.checked(source, false, true);
  assert.deepEqual(answer.bytes, source);
  assert.equal(answer.sha256, hash(source));
  assert.equal(source.byteLength, 4);
  assert.ok(answer.bytes.buffer instanceof ArrayBuffer);
});

test('asset operations fall back locally only when a Worker rejected the handoff', async t => {
  const base = '/layers/', f = fixture(t, base);
  class RejectingWorker extends EventTarget {
    postMessage() { throw new Error('handoff rejected'); }
  }
  f.install('Worker', RejectingWorker);
  const storage = createAssetCache({base, usedKey: 'used'});
  const source = Uint8Array.of(1, 2, 3), sha256 = hash(source);
  const answer = await storage.checked(source, false, true);
  assert.equal(answer.bytes, source);
  assert.equal(answer.sha256, sha256);
  assert.equal(await storage.keep(base + 'file', source), true);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(base + 'file'))!.arrayBuffer()), source);
});

test('a lost Worker reply fails the lent check without reusing detached bytes', {timeout: 5_000}, async t => {
  const base = '/layers/', f = fixture(t, base);
  let stopped = 0;
  class UnreadableWorker extends EventTarget {
    postMessage(message: unknown, transfer: ArrayBuffer[]) {
      structuredClone(message, {transfer});
      queueMicrotask(() => this.dispatchEvent(new Event('messageerror')));
    }
    terminate() { stopped++; }
  }
  f.install('Worker', UnreadableWorker);
  const storage = createAssetCache({base, usedKey: 'used'});
  const lent = Uint8Array.of(1, 2);
  await assert.rejects(storage.checked(lent, false, true), /could not be checked/);
  assert.equal(lent.byteLength, 0, 'the original buffer belongs to the retired Worker');
  assert.equal(stopped, 1);
  const usable = Uint8Array.of(3, 4);
  assert.deepEqual(await storage.checked(usable, false, false), {bytes: usable, sha256: hash(usable)});
});

test('the page owner aborts pending asset checks and cannot replace its checker', async t => {
  const base = '/layers/', f = fixture(t, base), owner = new AbortController();
  let created = 0, stopped = 0;
  class WaitingChecker extends EventTarget {
    constructor() { super(); created++; }
    postMessage(message: unknown, transfer: ArrayBuffer[]) { structuredClone(message, {transfer}); }
    terminate() { stopped++; }
  }
  f.install('Worker', WaitingChecker);
  const storage = createAssetCache({base, usedKey: 'used', checkSignal: owner.signal});
  const lent = Uint8Array.of(1, 2);
  const pending = storage.checked(lent, false, true);
  assert.equal(lent.byteLength, 0);
  assert.equal(created, 1);
  owner.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  await assert.rejects(storage.checked(Uint8Array.of(3), false, false), {name: 'AbortError'});
  assert.throws(() => storage.worker(), {name: 'AbortError'});
  assert.deepEqual({created, stopped}, {created: 1, stopped: 1});
});

test('an opted-in checker settles lends and cache writes before resting, then reopens for later work', async t => {
  const base = '/layers/', f = fixture(t, base), owner = new AbortController();
  t.mock.timers.enable({apis: ['setTimeout']});
  type Job = {id: number; bytes?: ArrayBuffer; keep?: {url: string; parts: Uint8Array[]}};
  const workers: CheckWorker[] = [];
  class CheckWorker extends EventTarget {
    jobs: Job[] = [];
    stopped = 0;
    constructor() { super(); workers.push(this); }
    postMessage(job: Job, transfer: ArrayBuffer[]) { this.jobs.push(structuredClone(job, {transfer})); }
    reply(data: object) { this.dispatchEvent(new MessageEvent('message', {data})); }
    terminate() { this.stopped++; }
  }
  f.install('Worker', CheckWorker);
  const storage = createAssetCache({base, usedKey: 'used', checkSignal: owner.signal});
  storage.worker();
  t.mock.timers.tick(5_000);
  assert.equal(workers[0]!.stopped, 0, 'do not age out a cold bootstrap');
  const lent = Uint8Array.of(2, 3);
  const pending = storage.checked(lent, false, true);
  const keep = storage.keep(base + 'file', Uint8Array.of(5, 7));
  await new Promise(resolve => setImmediate(resolve));
  storage.restChecker();
  const first = workers[0]!;
  const [checkJob, storeJob] = first.jobs;
  assert.ok(checkJob?.bytes && storeJob?.keep);
  assert.equal(lent.byteLength, 0);
  t.mock.timers.tick(5_000);
  assert.equal(first.stopped, 0, 'do not strand transferred bytes');
  first.reply({id: checkJob.id, bytes: checkJob.bytes, sha256: hash(Uint8Array.of(2, 3))});
  assert.deepEqual((await pending).bytes, Uint8Array.of(2, 3));
  t.mock.timers.tick(5_000);
  assert.equal(first.stopped, 0, 'wait for the cache write as well');
  const saved = Uint8Array.from(storeJob.keep.parts[0]!);
  await f.cache.put(storeJob.keep.url, new Response(saved));
  first.reply({id: storeJob.id, size: saved.length});
  assert.equal(await keep, true);
  t.mock.timers.tick(500);
  assert.equal(first.stopped, 1);
  assert.deepEqual(new Uint8Array(await (await f.cache.match(base + 'file'))!.arrayBuffer()), saved);

  const later = storage.checked(Uint8Array.of(11), false, true);
  const second = workers[1]!, reply = second.jobs[0]!;
  assert.equal(workers.length, 2);
  first.reply({id: reply.id, bytes: Uint8Array.of(0).buffer, sha256: 'old'});
  second.reply({id: reply.id, bytes: reply.bytes, sha256: hash(Uint8Array.of(11))});
  assert.deepEqual((await later).bytes, Uint8Array.of(11));
  owner.abort();
  t.mock.timers.tick(5_000);
  assert.deepEqual(workers.map(w => w.stopped), [1, 1]);
  assert.throws(() => storage.worker(), {name: 'AbortError'});
});

function addStartup(f: ReturnType<typeof fixture>, path: string, source: Uint8Array, wasm: Uint8Array) {
  const elf = f.blob(source), translated = f.blob(wasm);
  f.index.files.push({path, pack: 0, mode: 0o755, size: source.length, at: 32, len: source.length, raw: true});
  f.index.translations.push({path, elf, wasm: translated, sha256: hash(source)});
  return {elf, translated};
}

function phases(root: ReturnType<typeof createRoot>, t: TestContext): Stage[] {
  const stages: Stage[] = [];
  t.after(root.watchLoad(stage => stages.push(stage)));
  stages.length = 0; // Do not count the initial snapshot before this load.
  return stages;
}

test('legacy progress includes ELF bytes and counts identical content once', async t => {
  const base = '/layers/', f = fixture(t, base), source = new Uint8Array(24).map((_, i) => i);
  const {elf} = addStartup(f, '/usr/bin/bash', source, emptyWasm);
  addStartup(f, '/usr/bin/busybox', source, emptyWasm);
  f.publish();
  const root = f.root(), stages = phases(root, t), of = elf.size + f.index.translator.size;
  const loaded = await root.loadWebroot();
  assert.equal(loaded.files.length, 2);
  assert.deepEqual(stages[0], {at: 'fetch', got: 0, of});
  assert.deepEqual(stages.filter(stage => stage.at === 'fetch').at(-1), {at: 'fetch', got: of, of});
  assert.deepEqual(stages.slice(-2), [{at: 'prepare'}, {at: 'ready'}]);
});

test('prepared progress reports AOT chunks and never counts the lazy ELF', async t => {
  const base = '/layers/', f = fixture(t, base);
  const distinct = Uint8Array.of(...emptyWasm, 0, 2, 1, 120);
  const {elf, translated} = addStartup(f, '/usr/bin/bash', Uint8Array.of(1, 2, 3, 4), distinct);
  const translationUrl = f.url(base + translated.path), blob = f.assets.get(translationUrl)!;
  f.streams.set(translationUrl, () => new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(blob.subarray(0, 3)));
    controller.enqueue(new Uint8Array(blob.subarray(3)));
    controller.close();
  }}));
  f.publish();
  const root = f.root(), stages = phases(root, t), of = f.index.translator.size + translated.size;
  const loaded = await root.execution.load();
  assert.equal(loaded.executables.length, 1);
  assert.equal(f.requests.includes(f.url(base + elf.path)), false);
  assert.deepEqual(stages[0], {at: 'fetch', got: 0, of});
  const fetches = stages.filter(stage => stage.at === 'fetch');
  assert.ok(fetches.some(({got}) => got === 3 || got === f.index.translator.size + 3), 'the first AOT chunk was counted');
  assert.deepEqual(fetches.at(-1), {at: 'fetch', got: of, of});
  assert.deepEqual(stages.slice(-2), [{at: 'prepare'}, {at: 'ready'}]);
});
