import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {LIMITS} from './budget.ts';
import {GRACE, type PlanConfig} from './plan.ts';
import {sha256} from './request.ts';
import {sweep} from './sweep.ts';
import {accept, count, enc, fakeStripe, idOf, named, sendEvent, service, stripeEvent, subscription} from './testing.ts';

// What the second audit found in the Remote's abnormal cases, each held here so it stays fixed.

test('bytes let go between their put and their row (the sweep, another upload refused) are put again, never a row with nothing', async () => {
  const s = await service();
  const t = await s.start();
  const bytes = enc.encode('reverted to again'), sha = await sha256(bytes);
  // As the sweep does under the account's lock, in the moment after this upload put its bytes and before its row.
  const put = s.bucket.put.bind(s.bucket);
  let once = true;
  s.bucket.put = async (k, b) => { await put(k, b); if (once) { once = false; await s.bucket.delete([k]); } };
  assert.equal((await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
  assert.deepEqual((await s.call('POST', '/v1/blobs/missing', {token: t, body: [sha]})).json, []);
  assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: t})).text, 'reverted to again');
});

test('a file is asked whether it is had, and whether it fits, before its bytes are read', async () => {
  const s = await service({}, {quota: 10});
  const t = await s.start();
  const bytes = enc.encode('more than ten bytes'), sha = await sha256(bytes);
  const r = await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes});
  assert.equal(r.status, 507);
});

test('a tag asked weakly, or in a list, is the file had already: 304, nothing read', async () => {
  const s = await service();
  const t = await s.start();
  const bytes = enc.encode('kept'), sha = await sha256(bytes);
  await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes});
  for (const tag of [`W/"${sha}"`, `"other", "${sha}"`, '*']) {
    assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: t, headers: {'If-None-Match': tag}})).status, 304, tag);
  }
  assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: t, headers: {'If-None-Match': '"other"'}})).status, 200);
  // A release file by its digest too, asked of nothing at all.
  assert.equal((await s.call('GET', `/v1/os/${sha}`, {headers: {'If-None-Match': `"${sha}"`}})).status, 304);
});

test('every answer is JSON: a path no route has too', async () => {
  const s = await service();
  const r = await s.call('GET', '/no-such-thing');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('content-type')?.split(';')[0], 'application/json');
});

test('a count that is not whole is taken whole, not refused', async () => {
  const s = await service();
  const t = await s.start();
  await s.call('PATCH', '/v1/repos/r/draft', {token: t, body: {base: null, set: {}}});
  assert.equal((await s.call('GET', '/v1/repos/r/log?limit=1.5', {token: t})).status, 200);
});

test('a contact\'s state mistyped is refused, not taken as accepted', async () => {
  const s = await service();
  const [a, b] = [await s.start('Ren'), await s.start('Mio')];
  await named(s, [a, 'ren'], [b, 'mio']);
  assert.equal((await accept(s, a, 'mio@length3.test', 'block')).status, 400);
  assert.equal(await count(s, sql`select count(*)::int as n from contact`), 0);
});

test('a message sent again with its own id is the one message', async () => {
  const s = await service();
  const [a, b] = [await s.start('Ren'), await s.start('Mio')];
  await named(s, [a, 'ren'], [b, 'mio']);
  const id = crypto.randomUUID();
  const send = () => s.call('POST', '/v1/inbox/messages', {token: a, body: {id, to: 'mio@length3.test', body: 'hello'}});
  const [one, two] = [await send(), await send()];
  assert.deepEqual([one.status, two.status, one.json.id, two.json.id], [201, 201, id, id]);
  assert.equal(await count(s, sql`select count(*)::int as n from message`), 1);
  // Another's id is not taken over.
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: b, body: {id, to: 'ren@length3.test', body: 'mine?'}})).status, 409);
  assert.equal((await s.call('POST', '/v1/inbox/messages', {token: a, body: {id: 'not-a-uuid', to: 'mio@length3.test', body: 'x'}})).status, 400);
});

test('a refusal that says when says it in its words too: the database full waits an hour', async () => {
  const s = await service({}, {limits: {...LIMITS, database: 1}});
  const t = await s.start();
  const r = await s.call('PUT', '/v1/home/profile', {token: t, body: {value: '{}', version: 0}});
  assert.equal(r.status, 507);
  assert.equal(r.json.retryAfter, 3600);
  assert.equal(r.headers.get('Retry-After'), '3600');
});

test('Stripe: a subscription whose payment failed is paid in the portal, and a new one paid for takes its place', async () => {
  const st = fakeStripe();
  const PLAN: PlanConfig = {free: {repos: 2, bytes: 4096, names: 1}, grace: GRACE};
  const s = await service({}, {plan: PLAN, billing: st.billing});
  const t = await s.start('Ren');
  const user = await idOf(s, t);
  const now = Math.floor(Date.now() / 1000);
  await sendEvent(s, stripeEvent('customer.subscription.created', subscription(user, {status: 'active'}), {created: now - 25 * 86400}));
  await sendEvent(s, stripeEvent('invoice.payment_failed', {object: 'invoice', customer: subscription(user).customer}, {created: now - 20 * 86400}));
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {status: 'past_due'}), {created: now - 20 * 86400}));
  assert.equal((await s.call('GET', '/v1/plan', {token: t})).json.plan, 'free');
  const r = await s.call('POST', '/v1/plan/checkout', {token: t, body: {}});
  assert.deepEqual([r.status, r.json.manage], [409, true]);
  // Paid again another way (a subscription made in Stripe's dashboard): it is the one now.
  await sendEvent(s, stripeEvent('customer.subscription.created', subscription(user, {id: 'sub_testnew', status: 'active'}), {created: now}));
  assert.equal((await s.call('GET', '/v1/plan', {token: t})).json.plan, 'paid');
});

// ---- what goes on for years ----

test('bytes in R2 that no row names, put more than a day ago, are found by the sweep and go; a named file and a new one stay', async () => {
  const s = await service();
  const t = await s.start();
  const user = await idOf(s, t);
  const bytes = enc.encode('named'), sha = await sha256(bytes);
  await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes});
  const loose = `u/${user}/${'a'.repeat(64)}`, fresh = `u/${user}/${'b'.repeat(64)}`;
  await s.bucket.put(loose, enc.encode('left by a failed upload'));
  await s.bucket.put(fresh, enc.encode('an upload under way'));
  s.bucket.at.set(loose, Date.now() - 2 * 86_400_000);
  s.bucket.at.set(`u/${user}/${sha}`, Date.now() - 2 * 86_400_000);
  const gone = await sweep(s.db, s.bucket);
  assert.equal(gone.loose, 1);
  assert.deepEqual(s.bucket.keys().filter((k) => k.startsWith('u/')).sort(), [`u/${user}/${sha}`, fresh].sort());
  // Went round: the next day starts from the first key again.
  assert.equal(await count(s, sql`select count(*)::int as n from sweep_mark where name = 'r2' and at = ''`), 1);
});

test('a name held by someone still here is renewed before its term ends; one whose holder is gone is not', async () => {
  const s = await service();
  const [a, b] = [await s.start('Ren'), await s.start('Mio')];
  await named(s, [a, 'ren'], [b, 'mio']);
  await s.db.execute(sql`update address set until = now() + interval '30 days'`);
  await s.db.execute(sql`delete from session where user_id = ${await idOf(s, b)}`);
  await sweep(s.db, s.bucket);
  const left = (await s.db.execute(sql`select name, until > now() + interval '4 years' as renewed from address order by name`)).rows;
  assert.deepEqual(left, [{name: 'mio', renewed: false}, {name: 'ren', renewed: true}]);
});

test('how much room the database\'s rows let go of is asked of it, and is nothing where it cannot say', async () => {
  const s = await service();
  assert.equal(await count(s, sql`select room_free()::int as n`), 0);
});
