import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import {gzipSync} from 'node:zlib';
import {madeBy} from '../../../sods/runtime/translate.ts';
import {createRoot} from '../root.ts';
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
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const path = url(input); requests.push(path);
    const bytes = assets.get(path);
    return new Response(bytes && new Uint8Array(bytes), {status: bytes ? 200 : 404, headers: {'content-type': 'application/json'}});
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
  return {assets, requests, index, pack, entries, prefs, cache, root, publish, url, install};
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
