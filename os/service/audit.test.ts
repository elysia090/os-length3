import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {Hono} from 'hono';
import {LIMITS} from './budget.ts';
import {failed, sha256} from './request.ts';
import {APP, count, enc, service} from './testing.ts';

// What the server-side audit found, each held here so it stays fixed: who a request is, what R2 is asked, and
// how the Remote answers when its database is not there.

test('reads asked at once are counted once: 20 files read together cost 64 of the month, not 64 each', async () => {
  const s = await service({}, {limits: {...LIMITS}});
  const t = await s.start();
  const shas: string[] = [];
  for (let i = 0; i < 20; i++) {
    const bytes = enc.encode(`file ${i}`);
    const sha = await sha256(bytes);
    assert.equal((await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
    shas.push(sha);
  }
  const got = await s.call('POST', '/v1/blobs/read', {token: t, body: shas});
  assert.equal(Object.keys(got.json).length, 20);
  await Promise.all(shas.map((sha) => s.call('GET', `/v1/blobs/${sha}`, {token: t})));
  assert.ok(await count(s, sql`select coalesce(sum(n), 0)::int as n from usage where kind = 'r2:b'`) <= 128);
});

test('a file too large for one batch is left out of it, and the files after it are not', async () => {
  const s = await service();
  const t = await s.start();
  const big = new Uint8Array(9 << 20).fill(1), small = enc.encode('small');
  const [b, m] = [await sha256(big), await sha256(small)];
  assert.equal((await s.call('PUT', `/v1/blobs/${b}`, {token: t, bytes: big})).status, 201);
  assert.equal((await s.call('PUT', `/v1/blobs/${m}`, {token: t, bytes: small})).status, 201);
  assert.deepEqual(Object.keys((await s.call('POST', '/v1/blobs/read', {token: t, body: [b, m]})).json), [m]);
});

test('a session is the one credential a request names: a made-up bearer beside someone\'s cookie is no one, and is kept as no one', async () => {
  const s = await service({}, {sessionKept: 10_000});
  const t = await s.start('Ren');
  const cookie = s.sessions.get(t)!;
  const junk = {Authorization: 'Bearer junk.sig', Cookie: cookie};
  assert.equal((await s.call('PUT', '/v1/home/profile', {headers: junk, body: {json: '{}'}})).status, 401);
  assert.equal((await s.call('GET', '/v1/repos', {headers: {Authorization: 'Bearer junk.sig'}})).status, 401);
  // A cookie that only ends like the session's, set by another host of the domain, names nobody.
  const planted = `zz_session_token=${/session_token=([^;]+)/.exec(cookie)![1]}`;
  assert.equal((await s.call('GET', '/v1/repos', {headers: {Cookie: planted}})).status, 401);
  // The real one goes on, and is no longer taken once signed out.
  assert.equal((await s.call('GET', '/v1/repos', {token: t})).status, 200);
  assert.equal((await s.call('POST', '/api/auth/sign-out', {token: t, body: {}})).status, 200);
  assert.equal((await s.call('GET', '/v1/repos', {token: t})).status, 401);
});

test('entering by a link is held off after 20 tries an hour, and the refused tries are not kept', async () => {
  const s = await service({}, {enter: {as: 'banana000000', key: 'k'.repeat(40)}});
  const answers = [];
  for (let i = 0; i < 30; i++) answers.push((await s.call('POST', '/v1/enter', {body: {key: `wrong ${i}`}, headers: {'CF-Connecting-IP': '10.0.0.9'}})).status);
  assert.deepEqual([answers.filter((a) => a === 403).length, answers.filter((a) => a === 429).length], [20, 10]);
  assert.equal(await count(s, sql`select count(*)::int as n from throttle where key = 'enter:10.0.0.9'`), 20);
});

test('a database not reached, or gone mid-way, is 503 with when to try again, never 500', async () => {
  for (const message of ['timeout exceeded when trying to connect', 'Connection terminated unexpectedly']) {
    const app = new Hono();
    app.onError(failed);
    app.get('/', () => { throw new Error('query failed', {cause: new Error(message)}); });
    const error = console.error;
    console.error = () => {};
    const r = await Promise.resolve(app.request('http://remote.test/')).finally(() => { console.error = error; });
    assert.deepEqual([r.status, r.headers.get('Retry-After')], [503, '5'], message);
  }
});

test('a commit\'s going is checked by index, so a repo of many commits goes in time', async () => {
  const s = await service();
  const names = ((await s.db.execute(sql`select indexname from pg_indexes where tablename = 'cut'`)).rows as {indexname: string}[]).map((r) => r.indexname);
  for (const i of ['cut_parent_idx', 'cut_merged_idx']) assert.ok(names.includes(i), i);
  void APP;
});
