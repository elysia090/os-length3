import assert from 'node:assert/strict';
import {test} from 'node:test';

// A Remote that cannot be asked is told apart from one that offers nothing: not reached, not in time, not taking
// requests (a gateway's 503), what answered is a page (a host's fallback) or words that are not its JSON. Each is
// said as itself, the Remote is away meanwhile (so it is asked again), and the next good answer brings it back.
const shelf = new Map<string, string>();
Object.assign(globalThis, {localStorage: {getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k)}});
const remote = await import('./connection.ts');

/** The Remote answers the next asks with `f`. */
const answering = (f: (url: string, init?: RequestInit) => Promise<Response>) => Object.assign(globalThis, {fetch: f});
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const good = json({providers: ['github'], passkey: true});

test('a 200 with no way in keeps saying it offers none, and is the Remote answering', async () => {
  answering(json({providers: []}));
  const w = await remote.about();
  assert.deepEqual(w.providers, []);
  assert.equal(w.trouble, undefined);
  assert.equal(remote.remoteAway(), false);
});

test('each way of not being asked is said as itself, away meanwhile, and a good answer brings it back', async () => {
  const cases: [string, (url: string, init?: RequestInit) => Promise<Response>, RegExp][] = [
    ['503 page', async () => new Response('<html>Service Unavailable</html>', {status: 503, headers: {'Content-Type': 'text/html'}}), /^What answered is not the Remote \(503\)$/],
    ['503 plain', async () => new Response('upstream connect error', {status: 503, headers: {'Content-Type': 'text/plain'}}), /^The Remote is not taking requests just now \(503\)$/],
    ['200 page', async () => new Response('<!doctype html><html></html>', {status: 200, headers: {'Content-Type': 'text/html; charset=utf-8'}}), /^What answered is not the Remote \(200\)$/],
    ['bad JSON', async () => new Response('{"providers": [', {status: 200, headers: {'Content-Type': 'application/json'}}), /^The Remote's answer could not be read$/],
    ['not reached', async () => { throw new TypeError('fetch failed'); }, /^The Remote cannot be reached$/],
    ['not in time', async () => { throw new DOMException('signal timed out', 'TimeoutError'); }, /^The Remote did not answer in time$/],
  ];
  for (const [name, f, said] of cases) {
    answering(f);
    const w = await remote.about();
    assert.deepEqual(w.providers, [], name);
    assert.match(w.trouble ?? '', said, name);
    // Never the parser's own words.
    assert.doesNotMatch(w.trouble ?? '', /JSON|Unexpected token/, name);
    assert.equal(remote.remoteAway(), true, name);
    answering(good);
    assert.deepEqual((await remote.about()).providers, ['github'], name);
    assert.equal(remote.remoteAway(), false, name);
  }
});

test('what is read from the Remote says the same, not the parser\'s error', async () => {
  answering(async () => new Response('<!doctype html>', {status: 200, headers: {'Content-Type': 'text/html'}}));
  await assert.rejects(remote.json('/v1/open'), (e: unknown) => e instanceof remote.RemoteError && e.trouble === 'malformed' && !/JSON/.test(e.message));
  answering(async () => new Response('nope', {status: 200, headers: {'Content-Type': 'application/json'}}));
  await assert.rejects(remote.json('/v1/open'), (e: unknown) => e instanceof remote.RemoteError && e.trouble === 'malformed' && /could not be read/.test(e.message));
  // A Remote that holds no files says so itself with its 503: that is the Remote answering, not away.
  answering(json({error: 'No place for files', files: false}, 503));
  await assert.rejects(remote.json('/v1/blobs/missing'), /cannot hold files just now/);
  assert.equal(remote.remoteAway(), false);
});
