import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import {gzipSync} from 'node:zlib';
import {madeBy} from '../../../sods/runtime/translate.ts';
import {createRoot} from '../root.ts';
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
  const publish = () => {
    const body = json(index), id = hash(body), path = `index-${id}.json`;
    const about: About = {name: index.name, version: '1', sha256: index.sha256, bytes: 1, file: 'root.tar.zst',
      root: {name: 'fixture', profile: 'fixture'}, index: {path, sha256: id, size: body.length},
      translator: {name: index.translator.name, version: index.translator.version}};
    assets.set(url(base + 'webroot.json'), json(about));
    assets.set(url(base + path), body);
    assets.set(url(base + index.translator.path), translator);
    return about;
  };
  const root = () => createRoot({base, usedKey: 'used', planKey: 'plan', message: key => key,
    missing: () => 'missing release', errorText: String});
  return {assets, requests, index, pack, entries, prefs, cache, root, publish, url};
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
