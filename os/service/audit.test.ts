import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {Hono} from 'hono';
import {LIMITS} from './budget.ts';
import {GRACE, type PlanConfig} from './plan.ts';
import {sweep} from './sweep.ts';
import {failed, sha256} from './request.ts';
import {accept, APP, count, enc, fakeStripe, idOf, named, sendEvent, service, stripeEvent, subscription} from './testing.ts';

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

// ---- servers, names, the plan ----

const asked = async (s: Awaited<ReturnType<typeof service>>, ren: string, mio: string) => {
  await named(s, [ren, 'ren'], [mio, 'mio']);
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}});
  return {sid: made.json.id as string, bid: (made.json.boards as {id: string}[])[0].id};
};

test('one removed from a server is not taken back by the invitation they had, only by a new one', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  const {sid, bid} = await asked(s, ren, mio);
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: ren, body: {to: 'mio@length3.test', body: 'join', target: {server: sid}}})).status, 201);
  await accept(s, mio, 'ren@length3.test');
  assert.equal((await s.call('GET', `/v1/boards/${bid}/posts`, {token: mio})).status, 200);
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/people/mio@length3.test`, {token: ren})).status, 204);
  await accept(s, mio, 'ren@length3.test');
  assert.equal((await s.call('GET', `/v1/boards/${bid}/posts`, {token: mio})).status, 404);
});

test('one with no name left is still removed, by the id the people list gives', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await named(s, [ren, 'ren'], [mio, 'mio']);
  await accept(s, ren, 'mio@length3.test'); await accept(s, mio, 'ren@length3.test');
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}});
  const sid = made.json.id as string, bid = (made.json.boards as {id: string}[])[0].id;
  await s.call('POST', `/v1/servers/${sid}/people`, {token: ren, body: {address: 'mio@length3.test'}});
  assert.equal((await s.call('DELETE', '/v1/inbox/addresses/mio@length3.test', {token: mio})).status, 200);
  await s.db.execute(sql`update address set released_at = now() - interval '31 days' where address = 'mio@length3.test'`);
  await sweep(s.db, s.files);
  const people = (await s.call('GET', `/v1/servers/${sid}/people`, {token: ren})).json as unknown as {address: string; id: string}[];
  const nameless = people.find((p) => !p.address)!;
  assert.equal((await s.call('DELETE', `/v1/servers/${sid}/people/${encodeURIComponent(nameless.id)}`, {token: ren})).status, 204);
  assert.equal((await s.call('GET', `/v1/boards/${bid}/posts`, {token: mio})).status, 404);
});

test('a TODO item\'s moment out of what a bigint holds is taken as now, not a 500', async () => {
  const s = await service();
  const ren = await s.start('Ren');
  await named(s, [ren, 'ren']);
  const bid = ((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).json.boards as {id: string}[])[0].id;
  assert.equal((await s.call('PUT', `/v1/boards/${bid}/todos/a1`, {token: ren, body: {title: 'x', place: 1, created: 1e300}})).status, 201);
});

test('a name on a domain whose DNS no longer names its holder writes nothing and makes no server', async () => {
  const s = await service();
  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await named(s, [ren, 'ren']);
  const rec = (await s.call('GET', '/v1/inbox/domains/example.org', {token: mio})).json as unknown as {value: string};
  s.publish('_length3.example.org', rec.value);
  assert.equal((await s.call('POST', '/v1/inbox/addresses', {token: mio, body: {name: 'mio', domain: 'example.org'}})).status, 201);
  s.unpublish('_length3.example.org');
  assert.equal((await s.call('POST', '/v1/servers', {token: mio, body: {name: 'Club', address: 'club@example.org'}})).status, 400);
  // Its only name's domain gone: nothing goes out from it.
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: mio, body: {to: 'ren', from: 'mio@example.org', body: 'hi'}})).status, 409);
});

test('Stripe: incomplete of the same second does not undo active; a failure delivered late does not spend the next one\'s grace', async () => {
  const st = fakeStripe();
  const PLAN: PlanConfig = {free: {repos: 2, bytes: 4096, names: 1}, grace: GRACE};
  const s = await service({}, {plan: PLAN, billing: st.billing});
  const t = await s.start('Ren');
  const user = await idOf(s, t);
  const now = Math.floor(Date.now() / 1000);
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {status: 'active'}), {created: now}));
  await sendEvent(s, stripeEvent('customer.subscription.created', subscription(user, {status: 'incomplete'}), {created: now}));
  assert.equal((await s.call('GET', '/v1/plan', {token: t})).json.plan, 'paid');
  const t2 = await s.start('Mio');
  const u2 = await idOf(s, t2);
  const cus = subscription(u2).customer;
  await sendEvent(s, stripeEvent('customer.subscription.created', subscription(u2), {created: now - 100}));
  await sendEvent(s, stripeEvent('invoice.paid', {object: 'invoice', customer: cus}, {created: now - 10}));
  await sendEvent(s, stripeEvent('invoice.payment_failed', {object: 'invoice', customer: cus}, {created: now - 20 * 86400}));
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(u2, {status: 'past_due'}), {created: now}));
  assert.equal((await s.call('GET', '/v1/plan', {token: t2})).json.plan, 'paid');
});

// ---- repos ----

test('a draft takes no path a disk or the database cannot hold, nor a file and a folder of one name', async () => {
  const s = await service();
  const t = await s.start();
  const bytes = enc.encode('x'), sha = await sha256(bytes);
  assert.equal((await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
  const patch = (version: number, set: Record<string, string | null>) => s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {version, set, remove: []}});
  for (const bad of ['a\u0000b', 'a\ud800', 'a\\b', 'c:d', '__proto__', 'x\u001fy']) assert.equal((await patch(0, {[bad]: sha})).status, 400, JSON.stringify(bad));
  assert.equal((await patch(0, {a: sha, 'a/b': sha})).status, 400);
  assert.equal((await patch(0, {a: sha})).status, 200);
  assert.equal((await patch(1, {'a/b': sha})).status, 400);
  assert.equal((await patch(1, {'b/c': sha})).status, 200);
});

test('a name longer than a repo keeps is kept as long as it may be, and nothing sent as text or a number answers 500', async () => {
  const s = await service();
  const t = await s.start('R'.repeat(250));
  assert.equal((await s.call('PATCH', '/v1/repos/long/draft', {token: t, body: {version: 0, set: {}, remove: []}})).status, 200);
  for (const version of [1.5, 1e20, 2 ** 31]) assert.equal((await s.call('PUT', '/v1/home/profile', {token: t, body: {value: '{}', version}})).status, 400);
  assert.equal((await s.call('PUT', '/v1/home/profile', {token: t, body: {value: 'a\u0000b', version: 0}})).status, 400);
});

test('merge3 says a file on one side and a folder of its name on the other as a conflict', async () => {
  const {merge3} = await import('./repos.ts');
  assert.deepEqual(merge3({}, {'a/x': 's1'}, {a: 's2'}).conflicts, ['a']);
});
