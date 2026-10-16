import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {migrate} from 'drizzle-orm/pglite/migrator';
import {createApp, sha256} from './app.ts';
import {createAuth} from './auth.ts';
import {memoryBucket} from './bucket.ts';
import * as schema from './schema.ts';

const BASE = 'http://remote.test';
const APP = 'http://app.test';

async function service() {
  const db = drizzle(new PGlite(), {schema});
  await migrate(db, {migrationsFolder: new URL('./migrations', import.meta.url).pathname});
  const auth = createAuth({db, secret: 'test-secret-'.repeat(4), baseURL: BASE, appOrigin: APP, rateLimit: false, dev: true});
  const bucket = memoryBucket();
  const app = createApp({db, auth, bucket, origins: [APP], providers: ['dev']});
  // The service asks its own stand-in provider for tokens over the network: here, itself.
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    (String(url instanceof Request ? url.url : url).startsWith(BASE) ? app.request(url as string, init) : real(url, init))) as typeof fetch;
  const call = async (method: string, path: string, opts: {token?: string; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>} = {}) => {
    const r = await app.request(BASE + path, {
      method,
      headers: {Origin: APP, ...(opts.token ? {Authorization: `Bearer ${opts.token}`} : {}), ...(opts.body !== undefined ? {'Content-Type': 'application/json'} : {}), ...opts.headers},
      body: (opts.bytes as BodyInit | undefined) ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {status: r.status, json: json as Record<string, unknown> & unknown[], headers: r.headers};
  };
  /** Signing in as a browser does: the provider's page, then back through the callback. */
  const start = async (name = 'Ren') => {
    const asked = await app.request(`${BASE}/api/auth/sign-in/social`, {method: 'POST', headers: {Origin: APP, 'Content-Type': 'application/json'},
      body: JSON.stringify({provider: 'dev', callbackURL: `${APP}/?signed-in`})});
    assert.equal(asked.status, 200, await asked.clone().text());
    const cookies = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const go = new URL(((await asked.json()) as {url: string}).url);
    const approve = new URL(`${BASE}/dev-oauth/approve`);
    for (const k of ['redirect_uri', 'state']) approve.searchParams.set(k, go.searchParams.get(k) ?? '');
    approve.searchParams.set('name', name);
    const back = (await app.request(approve.toString())).headers.get('Location')!;
    const done = await app.request(back, {headers: {Cookie: cookies}});
    assert.equal(done.status, 302, await done.clone().text());
    assert.equal(done.headers.get('Location'), `${APP}/?signed-in`);
    const token = done.headers.get('set-auth-token');
    assert.ok(token);
    return token!;
  };
  return {db, call, start, bucket};
}

const enc = new TextEncoder();

test('nothing of the work is answered without a session', async () => {
  const s = await service();
  assert.equal((await s.call('GET', '/v1/repos')).status, 401);
  assert.equal((await s.call('GET', '/v1/repos', {token: 'not-a-session'})).status, 401);
  const t = await s.start();
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: t})).json, []);
});

test('an account is a provider identity: the same person signs in to the same account', async () => {
  const s = await service();
  const a = await s.start('Ren'), b = await s.start('Ren'), other = await s.start('Mio');
  const who = async (t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {id: string; name: string}}).user;
  assert.equal((await who(a)).id, (await who(b)).id);
  assert.notEqual((await who(a)).id, (await who(other)).id);
  assert.equal((await who(a)).name, 'Ren');
  // The session's own token (as get-session gives it) works as the bearer too.
  const raw = ((await s.call('GET', '/api/auth/get-session', {token: a})).json as unknown as {session: {token: string}}).session.token;
  assert.equal((await s.call('GET', '/v1/repos', {token: raw})).status, 200);
  // No way in without a provider: there are no blank accounts.
  assert.notEqual((await s.call('POST', '/api/auth/sign-in/anonymous', {body: {}})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/about')).json, {passkey: true, providers: ['dev']});
});

test('a device asks for a code, a signed-in browser approves it, the device gets its own session', async () => {
  const s = await service();
  const t = await s.start();
  const asked = await s.call('POST', '/api/auth/device/code', {body: {client_id: 'l3'}});
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  const {device_code, user_code, verification_uri_complete} = asked.json as unknown as {device_code: string; user_code: string; verification_uri_complete: string};
  assert.ok(verification_uri_complete.startsWith(`${APP}/?device`));
  const poll = () => s.call('POST', '/api/auth/device/token', {body: {grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'l3'}});
  assert.equal((await poll()).json.error, 'authorization_pending');
  // Unknown clients cannot ask.
  assert.notEqual((await s.call('POST', '/api/auth/device/code', {body: {client_id: 'someone-else'}})).status, 200);
  // The browser first claims the code it was shown (the page asks which device), then approves.
  const claimed = await s.call('GET', `/api/auth/device?user_code=${encodeURIComponent(user_code)}`, {token: t});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
  const approved = await s.call('POST', '/api/auth/device/approve', {token: t, body: {userCode: user_code}});
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  // Polling sooner than the interval says so; after it, the token comes.
  await new Promise((r) => setTimeout(r, 2100));
  const got = await poll();
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const deviceToken = got.json.access_token as string;
  assert.ok(deviceToken && deviceToken !== t);
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: deviceToken})).json, []);
  // Each is a session of its own, listed together, and ended one by one.
  const list = await s.call('GET', '/api/auth/list-sessions', {token: t});
  assert.equal((list.json as unknown[]).length, 2);
});

test('a draft changes only from the version it was read at; a cut records it', async () => {
  const s = await service();
  const t = await s.start();
  const put = async (text: string) => {
    const bytes = enc.encode(text);
    const sha = await sha256(bytes);
    assert.equal((await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
    return sha;
  };
  const readme = await put('# notes\n');
  // A diff naming a blob not there yet says which.
  const ghost = await sha256(enc.encode('not uploaded'));
  assert.deepEqual((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 0, set: {'a.md': ghost}, remove: []}})).json, {missing: [ghost]});
  const v1 = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 0, set: {'README.md': readme, docs: null}, remove: []}});
  assert.deepEqual(v1.json, {version: 1, bytes: 8});
  // Two devices on version 1: one lands, the other gets the draft to merge.
  const plan = await put('plan\n');
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'docs/plan.md': plan}, remove: ['docs']}})).json.version, 2);
  const stale = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'x.md': plan}, remove: []}});
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json, {version: 2, draft: {'README.md': readme, 'docs/plan.md': plan}});
  // Paths that leave the repo or touch .git never get in.
  for (const p of ['../x', '.git/config', 'a//b', 'src/.GIT./hooks']) {
    assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 2, set: {[p]: null}, remove: []}})).status, 400, p);
  }
  // 区切る: the draft as it is at version 2.
  const first = await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 2, parent: null, kind: 'Fix', title: '最初', issue: 'issue/001.md', note: '', added: 2, removed: 0}});
  assert.equal(first.status, 201);
  const id = first.json.id as string;
  const one = await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t});
  assert.deepEqual([one.json.tree, one.json.added, one.json.title, 'userId' in one.json], [{'README.md': readme, 'docs/plan.md': plan}, 2, '最初', false]);
  // A cut from an older version, or an older parent, is refused with what is there.
  assert.deepEqual((await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 1, parent: id, title: 'x'}})).json, {head: id, version: 2});
  assert.equal((await s.call('POST', '/v1/repos/notes/cuts', {token: t, body: {version: 2, parent: null, title: 'x'}})).status, 409);
  const repos = await s.call('GET', '/v1/repos', {token: t});
  assert.deepEqual((repos.json as unknown as {name: string; head: string; version: number; bytes: number}[]).map((r) => [r.name, r.head, r.version, r.bytes]), [['notes', id, 2, 13]]);
  const log = await s.call('GET', '/v1/repos/notes/log', {token: t});
  assert.deepEqual((log.json as unknown as {id: string; title: string; tree: object}[]).map((c) => [c.id, c.title]), [[id, '最初']]);
  // A repo can go from the Remote, history and all.
  assert.equal((await s.call('DELETE', '/v1/repos/notes', {token: t})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: t})).json, []);
  assert.equal((await s.call('GET', `/v1/repos/notes/cuts/${id}`, {token: t})).status, 404);
});

test('an account sees only its own: blobs, repos, settings', async () => {
  const s = await service();
  const a = await s.start('A'), b = await s.start('B');
  const bytes = enc.encode('mine');
  const sha = await sha256(bytes);
  await s.call('PUT', `/v1/blobs/${sha}`, {token: a, bytes});
  assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: b})).status, 404);
  assert.deepEqual((await s.call('POST', '/v1/blobs/missing', {token: b, body: [sha]})).json, [sha]);
  await s.call('PATCH', '/v1/repos/r/draft', {token: a, body: {version: 0, set: {'a.txt': sha}, remove: []}});
  assert.deepEqual((await s.call('GET', '/v1/repos', {token: b})).json, []);
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '[]', version: 0}})).json.version, 1);
  assert.deepEqual((await s.call('GET', '/v1/home/todo', {token: b})).json, {value: null, version: 0});
  // A setting changes only from the version it was read at.
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["x"]', version: 1}})).json.version, 2);
  assert.deepEqual((await s.call('PUT', '/v1/home/todo', {token: a, body: {value: '["y"]', version: 1}})).json, {value: '["x"]', version: 2});
});

test('only the app\'s pages may call, and they can read a new session\'s token', async () => {
  const s = await service();
  const ok = await s.call('OPTIONS', '/v1/repos', {headers: {'Access-Control-Request-Method': 'GET'}});
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
  const r = await s.call('POST', '/api/auth/sign-in/social', {body: {provider: 'dev', callbackURL: `${APP}/`}});
  assert.equal(r.headers.get('Access-Control-Allow-Credentials'), 'true');
  const other = await s.call('OPTIONS', '/v1/repos', {headers: {Origin: 'http://evil.test', 'Access-Control-Request-Method': 'GET'}});
  assert.notEqual(other.headers.get('Access-Control-Allow-Origin'), 'http://evil.test');
});
