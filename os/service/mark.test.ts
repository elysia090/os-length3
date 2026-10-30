import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApp} from './app.ts';
import {createAuth} from './auth.ts';
import {memoryBucket} from './bucket.ts';
import {MarkObject, memoryMarks, objectMarks, tagUntil, type MarkNamespace} from './mark.ts';
import {APP, BASE, fileDb, SECRET} from './testing.ts';

// The mark (mark.ts): a look whose answer nothing has written over since its tag is answered without the database,
// its session not looked up either; every write moves it, so the next look reads again; a device's beat the same.

const db = await fileDb();
/** Every statement the database is asked, counted (what a look answered by the mark must not ask at all). */
let asked = 0;
const client = (db as unknown as {$client: Record<string, (...a: unknown[]) => unknown>}).$client;
for (const k of ['query', 'exec', 'transaction']) {
  const real = client[k].bind(client);
  client[k] = (...a: unknown[]) => { asked++; return real(...a); };
}
const marks = memoryMarks();
const auth = createAuth({db, secret: SECRET, baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true});
const app = createApp({db, auth, bucket: memoryBucket(), origins: [APP], appOrigin: APP, providers: ['dev'], domain: 'length3.test', baseURL: BASE, secret: SECRET, marks});
const realFetch = globalThis.fetch;
// The stand-in provider is asked for its tokens over the network: here, this Remote.
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
  (String(url instanceof Request ? url.url : url).startsWith(BASE) ? app.request(url as string, init) : realFetch(url, init))) as typeof fetch;

const call = async (method: string, path: string, o: {token?: string; body?: unknown; headers?: Record<string, string>; origin?: boolean} = {}) => {
  const r = await app.request(BASE + path, {method, headers: {...(o.origin === false ? {} : {Origin: APP}), ...(o.token ? {Authorization: `Bearer ${o.token}`} : {}),
    ...(o.body !== undefined ? {'Content-Type': 'application/json'} : {}), ...o.headers}, body: o.body === undefined ? undefined : JSON.stringify(o.body)});
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* none */ }
  return {status: r.status, json, tag: r.headers.get('ETag'), headers: r.headers};
};
let people = 0;
/** Someone new, signed in through the stand-in provider: their token and its cookie. */
async function person() {
  const start = await app.request(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: APP, 'Content-Type': 'application/json'},
    body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/?signed-in`})});
  const cookies = start.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const go = new URL(((await start.json()) as {url: string}).url);
  const approve = new URL(`${BASE}/dev-oauth/approve`);
  for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
  approve.searchParams.set('name', `Mark ${process.pid}-${++people}`);
  const done = await app.request((await app.request(approve.toString())).headers.get('Location')!, {headers: {Cookie: cookies}});
  return {token: done.headers.get('set-auth-token')!, cookie: done.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')};
}
/** How many statements `f` asked the database. */
const counting = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const was = asked; const r = await f(); return [r, asked - was]; };

test('a look asked again with its tag, nothing written since, is 304 and asks the database nothing, its session neither', async () => {
  const {token} = await person();
  for (const path of ['/v1/moved', '/v1/news', '/v1/inbox/threads']) {
    const first = await call('GET', path, {token});
    assert.equal(first.status, 200, path);
    assert.match(first.tag ?? '', /^"[0-9a-z]+\.\.[0-9a-f]{32}"$/, path);
    const [again, n] = await counting(() => call('GET', path, {token, headers: {'If-None-Match': first.tag!}}));
    assert.equal(again.status, 304, path);
    assert.equal(again.tag, first.tag);
    assert.equal(n, 0, `${path}: the database was asked ${n} times`);
    // The Remote's headers all the same: nothing kept by a cache, as every answer.
    assert.equal(again.headers.get('Cache-Control'), 'no-store');
  }
});

test('any write by anyone moves the mark: the next look reads again, and sees it', async () => {
  const a = await person(), b = await person();
  const first = await call('GET', '/v1/moved', {token: a.token});
  assert.equal((await call('GET', '/v1/moved', {token: a.token, headers: {'If-None-Match': first.tag!}})).status, 304);
  // Another's write: read again (a write anywhere is what the mark knows), the same answer under a new tag.
  assert.equal((await call('PUT', '/v1/home/todo', {token: b.token, body: {value: '[]', version: 0}})).status, 200);
  const other = await call('GET', '/v1/moved', {token: a.token, headers: {'If-None-Match': first.tag!}});
  assert.equal(other.status, 200);
  assert.notEqual(other.tag, first.tag);
  assert.deepEqual(other.json, first.json);
  // One's own (another device's): seen at once.
  assert.equal((await call('PUT', '/v1/home/todo', {token: a.token, body: {value: '["x"]', version: 0}})).status, 200);
  const mine = await call('GET', '/v1/moved', {token: a.token, headers: {'If-None-Match': other.tag!}});
  assert.equal(mine.status, 200);
  assert.deepEqual((mine.json.home as Record<string, number>).todo, 1);
});

test('writes that write nothing a look reads do not move it', async () => {
  const a = await person();
  const before = marks.moves();
  assert.equal((await call('POST', '/v1/blobs/missing', {token: a.token, body: ['0'.repeat(64)]})).status, 200);
  // Taking a live line's signals (none here: it is refused, and still moves nothing).
  await call('POST', '/v1/inbox/signals/take', {token: a.token, body: {from: 'nobody@length3.test'}});
  assert.equal(marks.moves(), before);
  // What a look reads: moved, even when it is refused (what a refusal wrote, if anything, is read again).
  await call('PUT', '/v1/home/todo', {token: a.token, body: {value: '[]', version: 99}});
  assert.equal(marks.moves(), before + 1);
});

test('a tag is taken only from the token it was given to, for the look it was given for, and never with a cookie', async () => {
  const a = await person(), b = await person();
  const first = await call('GET', '/v1/moved', {token: a.token});
  assert.equal((await call('GET', '/v1/moved', {token: b.token, headers: {'If-None-Match': first.tag!}})).status, 200);
  assert.equal((await call('GET', '/v1/news', {token: a.token, headers: {'If-None-Match': first.tag!}})).status, 200);
  assert.equal((await call('GET', '/v1/moved', {token: 'made-up', headers: {'If-None-Match': first.tag!}})).status, 401);
  // A tag altered by a digit is no tag.
  const altered = first.tag!.replace(/[0-9a-f]"$/, (d) => `${d[0] === '0' ? '1' : '0'}"`);
  assert.equal((await call('GET', '/v1/moved', {token: a.token, headers: {'If-None-Match': altered}})).status, 200);
  // The cookie alone: looked up as ever (no page elsewhere can send a tag, but nothing is answered for a cookie unlooked-up).
  const cookieTag = (await call('GET', '/v1/moved', {headers: {Cookie: a.cookie}})).tag;
  assert.equal(cookieTag, null);
  assert.equal((await call('GET', '/v1/moved', {headers: {Cookie: a.cookie, 'If-None-Match': first.tag!}})).status, 200);
});

test('a session ended through the Remote moves the mark: its next look is refused, not answered from before', async () => {
  const a = await person();
  const first = await call('GET', '/v1/moved', {token: a.token});
  assert.equal((await call('POST', '/api/auth/sign-out', {token: a.token, body: {}})).status, 200);
  assert.equal((await call('GET', '/v1/moved', {token: a.token, headers: {'If-None-Match': first.tag!}})).status, 401);
});

test('a device\'s beat: on, without the database while nothing was written; off at its next beat once turned off elsewhere', async () => {
  const device = await person();
  assert.equal((await call('PUT', '/v1/ssh/this', {token: device.token, body: {scope: 'device'}, origin: false})).status, 200);
  const first = await call('POST', '/v1/ssh/this/beat', {token: device.token, body: {scope: 'device'}, origin: false});
  assert.equal(first.json.on, true);
  const tag = first.json.tag as string;
  assert.match(tag, /^[0-9a-z]+\.[A-Za-z0-9_-]+\.[0-9a-f]{32}$/);
  const [again, n] = await counting(() => call('POST', '/v1/ssh/this/beat', {token: device.token, body: {scope: 'device', tag}, origin: false}));
  assert.deepEqual(again.json, {on: true, tag});
  assert.equal(n, 0, `the database was asked ${n} times`);
  // Another scope said: the database is told (the tag is for the scope it was given with).
  assert.equal((await call('POST', '/v1/ssh/this/beat', {token: device.token, body: {scope: 'network', tag}, origin: false})).json.on, true);
  // The list says it was heard by the mark, later than the database last saw it.
  const listed = (await call('GET', '/v1/ssh', {token: device.token})).json as unknown as {device: string; seen: number}[];
  assert.equal(listed.length, 1);
  assert.ok(Date.now() - listed[0].seen < 5000);
  // Turned off from another session of the account (a page): the next beat, with its tag, hears it.
  const other = await (async () => {
    const s = await call('GET', '/v1/ssh', {token: device.token});
    return (s.json as unknown as {device: string}[])[0].device;
  })();
  const beat = await call('POST', '/v1/ssh/this/beat', {token: device.token, body: {scope: 'device'}, origin: false});
  assert.equal((await call('POST', `/v1/ssh/${other}/off`, {token: device.token, body: {}})).status, 200);
  assert.deepEqual((await call('POST', '/v1/ssh/this/beat', {token: device.token, body: {scope: 'device', tag: beat.json.tag}, origin: false})).json, {on: false});
});

test('a beat counts as heard only with the tag its session was given', async () => {
  const m = memoryMarks();
  await m.gave('s1', 'tag-one');
  const [before] = Object.values(await m.heard(['s1']));
  await new Promise((r) => setTimeout(r, 5));
  await m.now({session: 's1', tag: 'tag-other'});
  assert.equal((await m.heard(['s1'])).s1, before);
  await m.now({session: 's1', tag: 'tag-one'});
  assert.ok((await m.heard(['s1'])).s1 > before);
  await m.forget(Date.now() + 1);
  assert.deepEqual(await m.heard(['s1']), {});
});

test('a tag holds until the next six hours of UTC, never past its session\'s end', () => {
  const at = Date.UTC(2026, 9, 24, 5, 59, 59);
  assert.equal(tagUntil(at), Date.UTC(2026, 9, 24, 6));
  assert.equal(tagUntil(Date.UTC(2026, 9, 24, 6)), Date.UTC(2026, 9, 24, 12));
  assert.equal(tagUntil(at, at + 1000), at + 1000);
});

test('the mark not answering: the look is answered by the routes, given no tag', async () => {
  const broken = {...memoryMarks(), now: async () => { throw new Error('away'); }};
  const app2 = createApp({db, auth, bucket: null, origins: [APP], appOrigin: APP, providers: ['dev'], domain: 'length3.test', baseURL: BASE, secret: SECRET, marks: broken});
  const {token} = await person();
  const r = await app2.request(`${BASE}/v1/moved`, {headers: {Authorization: `Bearer ${token}`, 'If-None-Match': '"x"'}});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('ETag'), null);
});

test('the Durable Object keeps its mark across a start again, and a new one starts from an epoch no tag can match', async () => {
  const storage = new Map<string, unknown>();
  const store = {
    get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => storage.has(x)).map((x) => [x, storage.get(x)])) : storage.get(k)),
    put: async (k: string, v: unknown) => { storage.set(k, structuredClone(v)); },
    delete: async (ks: string[]) => { let n = 0; for (const k of ks) if (storage.delete(k)) n++; return n; },
    list: async (o: {prefix: string; limit?: number; startAfter?: string}) =>
      new Map([...storage].filter(([k]) => k.startsWith(o.prefix) && (!o.startAfter || k > o.startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, o.limit ?? 1000)),
  };
  const objectOn = (s: typeof store) => {
    let ready: Promise<unknown> = Promise.resolve();
    const o = new MarkObject({storage: s as never, blockConcurrencyWhile: async <T>(f: () => Promise<T>) => { const p = f(); ready = p; return p; }});
    const ns: MarkNamespace = {idFromName: () => 'remote', get: () => ({fetch: async (u: string, init?: RequestInit) => { await ready; return o.fetch(new Request(u, init)); }})};
    return objectMarks(ns);
  };
  const one = objectOn(store);
  const m0 = await one.now();
  await one.move();
  const m1 = await one.now();
  assert.notEqual(m1, m0);
  await one.gave('s1', 't1');
  await one.now({session: 's1', tag: 't1'});
  assert.ok((await one.heard(['s1', 's2'])).s1 > 0);
  assert.deepEqual(Object.keys(await one.heard(['s1', 's2'])), ['s1']);
  // Started again on the same storage: the same mark.
  assert.equal(await objectOn(store).now(), m1);
  await one.forget(Date.now() + 1);
  assert.deepEqual(await one.heard(['s1']), {});
  // A new object (nothing kept): a mark of another epoch.
  const fresh = await objectOn({...store, get: async () => undefined} as typeof store).now();
  assert.notEqual(fresh.split('.')[0], m1.split('.')[0]);
});
