import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {FREE, GB, GRACE, MB, PAID, planConfig, standing, type PlanConfig} from './plan.ts';
import * as schema from './schema.ts';
import {form, sign, stripeRest, verify} from './stripe.ts';
import {sweep} from './sweep.ts';
import {enc, fakeStripe, fileService, idOf, PRICES, sendEvent, stripeEvent, subscription, upload, WEBHOOK_SECRET, type Service} from './testing.ts';

// Billing on the Remote (plan.ts, stripe.ts): the plan's rules as contracts, free against each tier, one
// account against another, Stripe's webhook (its signature, an event sent again, events out of order, the
// tier read from the price), Checkout and the portal for a tier, and what is left when a subscription ends
// or goes down a tier; then the rules that need no database. Stripe itself is never reached: a stand-in
// answers (fakeStripe), and events are signed here as Stripe signs them.

const DAY = 86_400_000;
/** A small allowance, and small tiers, so a test reaches each with a few bytes. */
const PLAN: PlanConfig = {free: {repos: 2, bytes: 4096, names: 1}, grace: GRACE, paid: {
  go: {repos: null, bytes: 20_000, names: 3}, pro: {repos: null, bytes: 40_000, names: 5}, max: {repos: null, bytes: 80_000, names: 8}}};
const stripe = fakeStripe();
const s = await fileService({}, {plan: PLAN, billing: stripe.billing});
// The same plan, Go and Pro sold and not Max.
const fewer = fakeStripe({go: PRICES.go, pro: PRICES.pro});
const twoSold = await fileService({}, {plan: PLAN, billing: fewer.billing});
// The same plan, and nothing to buy it with: billing off.
const unsold = await fileService({}, {plan: PLAN});
// No plan at all (a Remote of one's own, dev unless asked): everything open.
const open = await fileService();

/** A repo `name` holding one file of `bytes` bytes (an empty repo with 0). */
async function repo(r: Service, t: string, name: string, bytes = 0) {
  const set: Record<string, string> = {};
  if (bytes) set['data.bin'] = (await upload(r, t, enc.encode(`${name}:`.padEnd(bytes, 'x')))).sha;
  return r.call('PATCH', `/v1/repos/${name}/draft`, {token: t, body: {version: 0, set, remove: []}});
}
/** Paid from now, to `tier` (Go unless said), as Stripe says it after Checkout. */
async function subscribe(t: string, o: Record<string, unknown> = {}, tier: keyof typeof PRICES = 'go') {
  const user = await idOf(s, t);
  const r = await sendEvent(s, stripeEvent('customer.subscription.created', subscription(user, o, tier)));
  assert.deepEqual([r.status, r.json.taken], [200, true], r.text);
  return user;
}
type Said = Record<string, unknown> & {usage: {repos: number; bytes: number; names: number}; tiers: {tier: string; allowance: unknown; sold?: boolean; price?: unknown}[]};
const planOf = async (r: Service, t: string) => (await r.call('GET', '/v1/plan', {token: t})).json as unknown as Said;
/** A refusal of the plan's: 402, the rule, the tier it is about (free unless said), and whether paying is offered here. */
function refused(r: {status: number; json: unknown; text: string}, rule: string, buy = true, tier = 'free') {
  assert.equal(r.status, 402, r.text);
  const j = r.json as Record<string, unknown>;
  assert.deepEqual([j.rule, j.plan, j.tier, j.buy, typeof j.error], [rule, tier === 'free' ? 'free' : 'paid', tier, buy, 'string'], r.text);
}
const name = async (r: Service, t: string, n: string, domain?: string) => r.call('POST', '/v1/inbox/addresses', {token: t, body: {name: n, ...(domain ? {domain} : {})}});

// ---- what an account has ----

test('a new account is free: its use against the allowance, the tiers beside it, and the way to subscribe', async () => {
  const t = await s.person('Aoi');
  assert.equal((await repo(s, t, 'notes', 100)).status, 200);
  const p = await planOf(s, t);
  assert.deepEqual([p.plan, p.tier, p.status, p.renews, p.buy, p.manage, p.usage.repos, p.free, p.allowance],
    ['free', 'free', null, null, true, false, 1, PLAN.free, PLAN.free]);
  assert.ok(p.usage.bytes >= 100, String(p.usage.bytes));
  // Free and each tier, the least first: what each keeps, and what it costs as Stripe says it.
  assert.deepEqual(p.tiers.map((x) => [x.tier, x.allowance, x.sold, x.price]), [['free', PLAN.free, undefined, undefined],
    ['go', PLAN.paid!.go, true, {amount: 700, currency: 'usd', interval: 'month', every: 1}],
    ['pro', PLAN.paid!.pro, true, {amount: 1400, currency: 'usd', interval: 'month', every: 1}],
    ['max', PLAN.paid!.max, true, {amount: 1900, currency: 'usd', interval: 'month', every: 1}]]);
  // A tier not sold here is not offered.
  assert.deepEqual((await planOf(twoSold, await twoSold.person('Aoi'))).tiers.map((x) => x.tier), ['free', 'go', 'pro']);
  // Without a plan, there is none to show; without Stripe, nothing to buy.
  assert.deepEqual(await planOf(open, await open.person('Aoi')), {plan: 'none'});
  const off = await planOf(unsold, await unsold.person('Aoi'));
  assert.deepEqual([off.buy, off.tiers.map((x) => x.tier)], [false, ['free']]);
});

test('the tiers as the deployment has them, unless said: 50 GB, 256 GB, 512 GB', () => {
  assert.deepEqual([PAID.go.bytes, PAID.pro.bytes, PAID.max.bytes], [50 * GB, 256 * GB, 512 * GB]);
});

// ---- rule 1: what the Remote keeps ----

test('free: a repo past the allowance is refused and nothing of it is kept; paid: taken', async () => {
  const t = await s.person('Ren');
  for (const n of ['one', 'two']) assert.equal((await repo(s, t, n)).status, 200);
  const third = await repo(s, t, 'three');
  refused(third, 'repos');
  assert.deepEqual([third.json.used, third.json.limit], [2, 2]);
  assert.equal((await s.call('GET', '/v1/repos/three', {token: t})).status, 404);
  assert.deepEqual(((await s.call('GET', '/v1/repos', {token: t})).json as {name: string}[]).map((r) => r.name).sort(), ['one', 'two']);
  // Writing to the repos it has goes on.
  assert.equal((await s.call('PATCH', '/v1/repos/one/draft', {token: t, body: {version: 1, set: {'a.txt': null}, remove: []}})).status, 200);
  await subscribe(t);
  assert.equal((await repo(s, t, 'three')).status, 200);
  assert.equal((await planOf(s, t)).plan, 'paid');
});

test('free: a draft growing past the allowance is refused and undone; one that does not grow is taken, however much is kept', async () => {
  const t = await s.person('Mio');
  assert.equal((await repo(s, t, 'notes', 1000)).status, 200);
  // A file sent ahead of its change is kept for the moment (it goes within a day unnamed): only the draft is refused.
  const big = await upload(s, t, enc.encode('b'.repeat(5000)));
  assert.equal(big.status, 201);
  const grow = await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'big.bin': big.sha}, remove: []}});
  refused(grow, 'bytes');
  assert.ok((grow.json.used as number) > PLAN.free.bytes && grow.json.limit === PLAN.free.bytes, grow.text);
  const now = (await s.call('GET', '/v1/repos/notes', {token: t})).json as unknown as {version: number; draft: Record<string, string>};
  assert.deepEqual([now.version, Object.keys(now.draft)], [1, ['data.bin']]);
  // Over the allowance (the unnamed file counts until it goes): the same file changed to the same size, and a file removed, are taken.
  assert.ok((await planOf(s, t)).usage.bytes > PLAN.free.bytes);
  const same = await upload(s, t, enc.encode('notes:'.padEnd(1000, 'y')));
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 1, set: {'data.bin': same.sha}, remove: []}})).status, 200);
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 2, set: {}, remove: ['data.bin']}})).status, 200);
  // Paid: it grows.
  await subscribe(t);
  assert.equal((await s.call('PATCH', '/v1/repos/notes/draft', {token: t, body: {version: 3, set: {'big.bin': big.sha}, remove: []}})).status, 200);
});

// ---- rule 2: making a server ----

test('free: making a server is refused; asked into a paid one, a free account is in and writes', async () => {
  const ren = await s.person('Ren'), mio = await s.person('Mio');
  const [rn, mn] = [`renp${process.pid}`, `miop${process.pid}`];
  assert.equal((await name(s, ren, rn)).status, 201);
  assert.equal((await name(s, mio, mn)).status, 201);
  refused(await s.call('POST', '/v1/servers', {token: mio, body: {name: 'Mine', address: `mine${process.pid}`}}), 'server');
  await subscribe(ren);
  const made = await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip', address: `trip${process.pid}`}});
  assert.equal(made.status, 201, made.text);
  await s.call('POST', '/v1/inbox/contacts', {token: ren, body: {address: `${mn}@length3.test`, state: 'accepted'}});
  await s.call('POST', '/v1/inbox/contacts', {token: mio, body: {address: `${rn}@length3.test`, state: 'accepted'}});
  assert.equal((await s.call('POST', `/v1/servers/${made.json.id}/people`, {token: ren, body: {address: `${mn}@length3.test`}})).status, 201);
  const board = (made.json.boards as {id: string}[])[0].id;
  assert.equal((await s.call('POST', `/v1/boards/${board}/posts`, {token: mio, body: {body: 'hello'}})).status, 201);
});

// ---- rule 3: names ----

test('free: one name on this Remote; a second, or one on a domain of one\'s own, is paid; taking one\'s own back is not new', async () => {
  const t = await s.person('Kai');
  const [a, b] = [`kaia${process.pid}`, `kaib${process.pid}`];
  assert.equal((await name(s, t, a)).status, 201);
  refused(await name(s, t, b), 'names');
  refused(await name(s, t, 'kai', 'kai.example'), 'domain');
  assert.equal((await s.call('DELETE', `/v1/inbox/addresses/${a}@length3.test`, {token: t})).status, 200);
  assert.equal((await name(s, t, a)).status, 201);
  await subscribe(t);
  assert.equal((await name(s, t, b)).status, 201);
  // Paid, the domain is asked of its DNS as before: not published, not claimed (and not for the plan's sake).
  assert.equal((await name(s, t, 'kai', 'kai.example')).status, 409);
});

// ---- one account against another ----

test('one account paying makes no other paid; each has its own customer, and the portal only for its own', async () => {
  const a = await s.person('Aoi'), b = await s.person('Sora');
  const ua = await subscribe(a);
  assert.equal((await planOf(s, b)).plan, 'free');
  refused(await s.call('POST', '/v1/servers', {token: b, body: {name: 'B', address: `bsrv${process.pid}`}}), 'server');
  // B has nothing to manage: A's customer is A's.
  assert.equal((await s.call('POST', '/v1/plan/portal', {token: b, body: {}})).status, 409);
  const portal = await s.call('POST', '/v1/plan/portal', {token: a, body: {}});
  assert.equal(portal.status, 200, portal.text);
  // Back to the app, which is told it came back from the portal (and reads what changed from here).
  assert.deepEqual(stripe.asked.at(-1), {call: 'portal', customer: subscription(ua).customer, back: 'http://app.test/?plan=managed'});
  // A, paid, is not sent to Checkout again.
  assert.equal((await s.call('POST', '/v1/plan/checkout', {token: a, body: {}})).status, 409);
  // An event naming an account by metadata does not take a customer that is someone else's.
  const ub = await idOf(s, b);
  await sendEvent(s, stripeEvent('customer.subscription.created', subscription(ub, {customer: subscription(ua).customer, id: 'sub_stolen'})));
  assert.equal((await planOf(s, b)).plan, 'free');
});

// ---- Stripe: Checkout, the webhook ----

test('Checkout: a customer made once for the account, the session for the tier asked, back to the app', async () => {
  const t = await s.person('Hana');
  const user = await idOf(s, t);
  const before = stripe.asked.length;
  const one = await s.call('POST', '/v1/plan/checkout', {token: t, body: {back: 'http://app.test/?part=plan', tier: 'pro'}});
  const two = await s.call('POST', '/v1/plan/checkout', {token: t, body: {back: 'https://elsewhere.example/'}});
  assert.deepEqual([one.status, two.status], [200, 200], one.text + two.text);
  assert.match(one.json.url as string, /^https:\/\/checkout\.stripe\.test\//);
  const asked = stripe.asked.slice(before).filter((x) => x.call !== 'price');
  assert.deepEqual(asked.map((x) => x.call), ['customer', 'checkout', 'checkout']);
  assert.equal(asked[0].user, user);
  assert.match(asked[0].email as string, /@/);
  // The tier asked, by its price; none asked (a client from before tiers), the least one sold.
  assert.deepEqual([asked[1].tier, asked[1].price, asked[2].tier, asked[2].price], ['pro', PRICES.pro, 'go', PRICES.go]);
  // Back only to the app's own pages: another is the app's origin instead; told how Checkout went, and to what.
  assert.deepEqual([asked[1].success, asked[1].cancel, asked[2].success, asked[1].user],
    ['http://app.test/?part=plan&plan=paid&tier=pro', 'http://app.test/?part=plan&plan=cancelled', 'http://app.test/?plan=paid&tier=go', user]);
  // A tier that is none, or not sold here, is refused before Stripe is asked.
  const n = stripe.asked.length;
  assert.deepEqual([(await s.call('POST', '/v1/plan/checkout', {token: t, body: {tier: 'gold'}})).status, stripe.asked.length], [400, n]);
  const h2 = await twoSold.person('Hana');
  const notSold = await twoSold.call('POST', '/v1/plan/checkout', {token: h2, body: {tier: 'max'}});
  assert.deepEqual([notSold.status, notSold.json.error], [400, 'That tier is not sold on this Remote']);
  const now = await planOf(s, t);
  assert.equal(now.manage, true);
  // What paying costs is said before anyone is sent to pay (Stripe asked once an hour for each price, not once a page).
  const priced = stripe.asked.filter((x) => x.call === 'price').length;
  await planOf(s, t);
  assert.equal(stripe.asked.filter((x) => x.call === 'price').length, priced);
  assert.deepEqual(new Set(stripe.asked.filter((x) => x.call === 'price').map((x) => x.id)), new Set(Object.values(PRICES)));
  // Billing off: nothing can be bought, and every refusal says so.
  const u = await unsold.person('Hana');
  const off = await unsold.call('POST', '/v1/plan/checkout', {token: u, body: {}});
  assert.deepEqual([off.status, off.json.error], [503, 'Paid features cannot be bought on this Remote yet']);
  for (const n of ['a', 'b']) await repo(unsold, u, n);
  refused(await repo(unsold, u, 'c'), 'repos', false);
  assert.equal((await sendEvent(unsold, stripeEvent('customer.subscription.created', subscription(await idOf(unsold, u))))).status, 404);
  // No plan: nothing is refused, and there is nothing to buy.
  const o = await open.person('Hana');
  for (const n of ['a', 'b', 'c', 'd']) assert.equal((await repo(open, o, n, 5000)).status, 200);
  assert.equal((await open.call('POST', '/v1/plan/checkout', {token: o, body: {}})).status, 404);
});

test('the webhook: a bad or old signature changes nothing; an event sent again is answered and taken once', async () => {
  const t = await s.person('Yui');
  const user = await idOf(s, t);
  const created = stripeEvent('customer.subscription.created', subscription(user));
  for (const bad of [{secret: 'whsec_wrong'}, {t: Math.floor(Date.now() / 1000) - 600}, {signature: 'v1=abc'}, {signature: ''}]) {
    const r = await sendEvent(s, created, bad);
    assert.deepEqual([r.status, r.json.error], [400, 'The signature does not match'], JSON.stringify(bad));
  }
  // Signed, but changed on the way.
  const sig = await sign(created, WEBHOOK_SECRET);
  assert.equal((await sendEvent(s, created.replace('"active"', '"trialing"'), {signature: sig})).status, 400);
  assert.equal((await planOf(s, t)).plan, 'free');
  assert.equal((await sendEvent(s, created)).json.taken, true);
  assert.equal((await planOf(s, t)).plan, 'paid');
  // It ends; then the first event comes again: answered, and nothing changes back.
  assert.equal((await sendEvent(s, stripeEvent('customer.subscription.deleted', subscription(user, {status: 'canceled'})))).json.taken, true);
  const again = await sendEvent(s, created);
  assert.deepEqual([again.status, again.json.taken], [200, false]);
  assert.equal((await planOf(s, t)).plan, 'free');
  // Out of order: an update made before the end, arriving after it, changes nothing either.
  const late = await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user), {created: Math.floor(Date.now() / 1000) - 60}));
  assert.deepEqual([late.json.taken, (await planOf(s, t)).plan], [true, 'free']);
  // One made longer ago than events are kept is not taken at all.
  const ancient = await sendEvent(s, stripeEvent('customer.subscription.created', subscription(user), {created: Math.floor((Date.now() - 31 * DAY) / 1000)}));
  assert.deepEqual([ancient.status, ancient.json.taken, (await planOf(s, t)).plan], [200, false, 'free']);
  // Not an event at all.
  assert.equal((await sendEvent(s, JSON.stringify({id: 'nope'}))).status, 400);
});

test('a failed payment: paid through the grace, then free until one goes through', async () => {
  const t = await s.person('Rio');
  const user = await subscribe(t);
  const customer = subscription(user).customer;
  await sendEvent(s, stripeEvent('invoice.payment_failed', {object: 'invoice', customer}));
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {status: 'past_due'})));
  let p = await planOf(s, t);
  assert.deepEqual([p.plan, p.status], ['paid', 'past_due']);
  assert.ok((p.graceUntil as number) > Date.now() + 13 * DAY);
  // Its grace spent (the first failure 15 days ago): free, and what is paid is refused.
  await s.db.update(schema.plan).set({failedAt: new Date(Date.now() - 15 * DAY)}).where(sql`user_id = ${user}`);
  assert.equal((await planOf(s, t)).plan, 'free');
  // A payment goes through: paid again.
  await sendEvent(s, stripeEvent('invoice.paid', {object: 'invoice', customer}));
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {status: 'active'})));
  p = await planOf(s, t);
  assert.deepEqual([p.plan, p.graceUntil], ['paid', null]);
});

// ---- the tiers ----

test('each tier keeps its own: Go past its bytes and names is refused as Go, and Pro, changed to in the portal, takes them', async () => {
  const t = await s.person('Ema');
  const user = await subscribe(t);
  let p = await planOf(s, t);
  assert.deepEqual([p.plan, p.tier, p.allowance], ['paid', 'go', PLAN.paid!.go]);
  // Repos as many as fit; bytes up to Go's.
  for (const n of ['a', 'b', 'c']) assert.equal((await repo(s, t, n, 6000)).status, 200);
  const over = await repo(s, t, 'd', 6000);
  refused(over, 'bytes', true, 'go');
  assert.deepEqual([over.json.limit, over.json.error], [20_000, 'Your plan keeps no more on the Remote']);
  for (const n of ['one', 'two', 'three']) assert.equal((await name(s, t, `ema${n}${process.pid}`)).status, 201);
  refused(await name(s, t, `emafour${process.pid}`), 'names', true, 'go');
  // Changed to Pro in the portal: the subscription's item is to Pro's price now, and the allowance is Pro's at once.
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {}, 'pro')));
  p = await planOf(s, t);
  assert.deepEqual([p.tier, p.allowance], ['pro', PLAN.paid!.pro]);
  assert.equal((await repo(s, t, 'd', 6000)).status, 200);
  assert.equal((await name(s, t, `emafour${process.pid}`)).status, 201);
  // Down to Go again: nothing is taken away; only what would grow is refused, as Go.
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {}, 'go')));
  p = await planOf(s, t);
  assert.deepEqual([p.tier, p.usage.repos], ['go', 4]);
  assert.ok(p.usage.bytes > PLAN.paid!.go.bytes);
  for (const n of ['a', 'b', 'c', 'd']) assert.equal((await s.call('GET', `/v1/repos/${n}`, {token: t})).status, 200);
  refused(await repo(s, t, 'e', 10), 'bytes', true, 'go');
});

test('the tier is read from the price; a price this Remote does not sell, from what Checkout said, and else it stays', async () => {
  const t = await s.person('Rin');
  const user = await idOf(s, t);
  const other = (o: Record<string, unknown>) => subscription(user, {items: {data: [{id: 'si_testother', price: {id: 'price_someoneelse'}}]}, ...o});
  await sendEvent(s, stripeEvent('customer.subscription.created', other({metadata: {user, tier: 'max'}})));
  assert.equal((await planOf(s, t)).tier, 'max');
  // An update that says no tier (an old API version's shape, a price not sold here) keeps it.
  await sendEvent(s, stripeEvent('customer.subscription.updated', other({metadata: {user}, items: undefined})));
  assert.equal((await planOf(s, t)).tier, 'max');
  // A subscription from before there were tiers is the least one while it is paid.
  await s.db.update(schema.plan).set({tier: null}).where(sql`user_id = ${user}`);
  assert.equal((await planOf(s, t)).tier, 'go');
  // Ended: free, whatever it was.
  await sendEvent(s, stripeEvent('customer.subscription.deleted', subscription(user, {status: 'canceled'}, 'pro')));
  assert.deepEqual([(await planOf(s, t)).plan, (await planOf(s, t)).tier], ['free', 'free']);
});

test('another tier, paid already, is the portal at the step that changes to it; the one there is, or none, is refused there', async () => {
  const t = await s.person('Mei');
  // Free, even with a customer: there is nothing to change, so Checkout it is.
  assert.equal((await s.call('POST', '/v1/plan/checkout', {token: t, body: {tier: 'go'}})).status, 200);
  const none = await s.call('POST', '/v1/plan/portal', {token: t, body: {tier: 'pro'}});
  assert.deepEqual([none.status, none.json.checkout], [409, true]);
  const user = await subscribe(t);
  // Paid, another tier is not a second Checkout.
  const again = await s.call('POST', '/v1/plan/checkout', {token: t, body: {tier: 'pro'}});
  assert.deepEqual([again.status, again.json.tier, again.json.manage], [409, 'go', true]);
  const r = await s.call('POST', '/v1/plan/portal', {token: t, body: {back: 'http://app.test/?x=1', tier: 'max'}});
  assert.equal(r.status, 200, r.text);
  const sub = subscription(user);
  assert.deepEqual(stripe.asked.at(-1), {call: 'portal', customer: sub.customer, back: 'http://app.test/?x=1&plan=managed',
    change: {subscription: sub.id, item: sub.items.data[0].id, price: PRICES.max}});
  assert.equal((await s.call('POST', '/v1/plan/portal', {token: t, body: {tier: 'go'}})).status, 409);
  assert.equal((await s.call('POST', '/v1/plan/portal', {token: t, body: {tier: 'gold'}})).status, 400);
  // A payment that failed is put right first (its card), not changed past.
  await sendEvent(s, stripeEvent('customer.subscription.updated', subscription(user, {status: 'past_due'})));
  const owed = await s.call('POST', '/v1/plan/portal', {token: t, body: {tier: 'max'}});
  assert.deepEqual([owed.status, owed.json.manage], [409, true]);
});

// ---- when a subscription ends ----

test('a subscription that ends takes nothing away: what was made goes on, only what would be new is refused', async () => {
  const t = await s.person('Nao');
  const user = await subscribe(t, {cancel_at_period_end: true});
  const handle = `nao${process.pid}`;
  assert.equal((await name(s, t, handle)).status, 201);
  assert.equal((await name(s, t, `nao2${process.pid}`)).status, 201);
  const made = await s.call('POST', '/v1/servers', {token: t, body: {name: 'Club', address: `club${process.pid}`}});
  assert.equal(made.status, 201);
  for (const n of ['a', 'b', 'c']) assert.equal((await repo(s, t, n, 3000)).status, 200);
  // Set to end at the period's end: still paid, and it says when it ends.
  let p = await planOf(s, t);
  assert.deepEqual([p.plan, p.renews === null, typeof p.ends], ['paid', true, 'number']);
  await sendEvent(s, stripeEvent('customer.subscription.deleted', subscription(user, {status: 'canceled', ended_at: Math.floor(Date.now() / 1000)})));
  p = await planOf(s, t);
  assert.deepEqual([p.plan, p.status, p.usage.repos], ['free', 'canceled', 3]);
  assert.ok(p.usage.bytes > PLAN.free.bytes);
  // The server goes on: its board is written in, a board is added, it is renamed.
  const sid = made.json.id as string, board = (made.json.boards as {id: string}[])[0].id;
  assert.equal((await s.call('POST', `/v1/boards/${board}/posts`, {token: t, body: {body: 'still here'}})).status, 201);
  assert.equal((await s.call('POST', `/v1/servers/${sid}/boards`, {token: t, body: {name: 'more'}})).status, 201);
  assert.equal((await s.call('PATCH', `/v1/servers/${sid}`, {token: t, body: {name: 'Club 2'}})).status, 200);
  // Both names still answer.
  assert.equal((await s.call('GET', `/v1/inbox/lookup?address=nao2${process.pid}`, {token: t})).json.reachable, true);
  // Every repo is there, read and written, so long as no draft grows.
  for (const n of ['a', 'b', 'c']) assert.equal((await s.call('GET', `/v1/repos/${n}`, {token: t})).status, 200);
  assert.equal((await s.call('PATCH', '/v1/repos/c/draft', {token: t, body: {version: 1, set: {}, remove: ['data.bin']}})).status, 200);
  assert.equal((await s.call('POST', '/v1/repos/a/cuts', {token: t, body: {version: 1, parent: null, title: 'kept'}})).status, 201);
  // What would be new is refused.
  refused(await repo(s, t, 'd'), 'repos');
  refused(await s.call('PATCH', '/v1/repos/c/draft', {token: t, body: {version: 2, set: {'x': (await upload(s, t, enc.encode('more'))).sha}, remove: []}}), 'bytes');
  refused(await s.call('POST', '/v1/servers', {token: t, body: {name: 'Another', address: `another${process.pid}`}}), 'server');
  refused(await name(s, t, `nao3${process.pid}`), 'names');
});

test('the sweep lets go of events taken long ago, and counts each room again from its rows', async () => {
  const t = await s.person('Eri');
  const user = await idOf(s, t);
  await repo(s, t, 'notes', 500);
  await s.db.insert(schema.billingEvent).values({id: `evt_old${process.pid}`, type: 'invoice.paid', at: new Date(Date.now() - 31 * DAY)});
  // A room that disagrees with its rows (as if a row had been written past its triggers).
  const right = (await planOf(s, t)).usage.bytes;
  await s.db.execute(sql`update room set used = used + 999999, unswept = true where user_id = ${user}`);
  assert.equal((await planOf(s, t)).usage.bytes, right + 999999);
  const gone = await sweep(s.db, s.bucket);
  assert.ok(gone.billing_event >= 1 && gone.recounted >= 1, JSON.stringify(gone));
  assert.equal((await planOf(s, t)).usage.bytes, right);
});

// ---- the rules that need no database ----

test('standing: paid while active or trialing; set to end, until then; a failed payment, through its grace; ended, free', () => {
  const now = Date.UTC(2031, 9, 17), at = (days: number) => new Date(now + days * DAY);
  const row = (o: Partial<{status: string; periodEnd: Date; cancelAt: Date; failedAt: Date}>) =>
    ({customer: 'cus_x', subscription: 'sub_x', status: null, periodEnd: null, cancelAt: null, failedAt: null, ...o});
  const cases: [string, ReturnType<typeof row> | undefined, Partial<ReturnType<typeof standing>>][] = [
    ['no row', undefined, {paid: false, status: null}],
    ['no status', row({}), {paid: false}],
    ['active', row({status: 'active', periodEnd: at(20)}), {paid: true, renews: at(20).getTime(), ends: null}],
    ['trialing', row({status: 'trialing', periodEnd: at(5)}), {paid: true}],
    ['set to end', row({status: 'active', periodEnd: at(20), cancelAt: at(20)}), {paid: true, renews: null, ends: at(20).getTime()}],
    ['set to end, and the end came', row({status: 'active', periodEnd: at(-1), cancelAt: at(-1)}), {paid: false}],
    ['active, its renewal never heard of', row({status: 'active', periodEnd: at(-15)}), {paid: false}],
    ['active, a day past its period', row({status: 'active', periodEnd: at(-1)}), {paid: true}],
    ['past due, in its grace', row({status: 'past_due', failedAt: at(-3)}), {paid: true, graceUntil: at(11).getTime()}],
    ['past due, its grace spent', row({status: 'past_due', failedAt: at(-15)}), {paid: false}],
    ['unpaid, from its period', row({status: 'unpaid', periodEnd: at(-20)}), {paid: false}],
    ['canceled', row({status: 'canceled', periodEnd: at(-2), cancelAt: at(-2)}), {paid: false, ends: at(-2).getTime()}],
    ['incomplete', row({status: 'incomplete'}), {paid: false}],
  ];
  for (const [why, r, want] of cases) {
    const got = standing(r, GRACE, now);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k as keyof typeof got], v, `${why}: ${k}`);
  }
});

test('the plan as the deployment says it, and what it leaves out', () => {
  assert.deepEqual(planConfig({}), {free: FREE, paid: PAID, grace: GRACE});
  assert.deepEqual(FREE, {repos: 3, bytes: 100_000_000, names: 1});
  assert.deepEqual(PAID, {go: {repos: null, bytes: 50e9, names: 5}, pro: {repos: null, bytes: 256e9, names: 10}, max: {repos: null, bytes: 512e9, names: 20}});
  assert.deepEqual(planConfig({FREE_REPOS: '10', FREE_MB: '1.5', GRACE_DAYS: '3'}), {free: {repos: 10, bytes: 1.5 * MB, names: 1}, paid: PAID, grace: 3 * DAY});
  assert.deepEqual(planConfig({FREE_REPOS: 'many', FREE_MB: '-1', GRACE_DAYS: ' '}), {free: FREE, paid: PAID, grace: GRACE});
});

test('billing on Workers: the keys and a price for each tier sold; with a key or every price missing, none', async () => {
  const {billingOf} = await import('./worker.ts');
  const keys = {STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x'};
  assert.deepEqual(billingOf({...keys, STRIPE_PRICE_GO: 'price_go', STRIPE_PRICE_MAX: ' price_max '})?.prices, {go: 'price_go', max: 'price_max'});
  assert.equal(billingOf({...keys}), undefined);
  assert.equal(billingOf({STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_GO: 'price_go'}), undefined);
});

test('a webhook signature: the HMAC of the time and the body, within five minutes, any v1 of several', async () => {
  const body = '{"id":"evt_1"}', secret = 'whsec_abc', now = 1_800_000_000_000, t = now / 1000;
  const good = await sign(body, secret, t);
  assert.match(good, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(await verify(body, good, secret, now), true);
  assert.equal(await verify(body, `t=${t},v1=${'0'.repeat(64)},${good.split(',')[1]}`, secret, now), true);
  assert.equal(await verify(body, good, 'whsec_other', now), false);
  assert.equal(await verify(`${body} `, good, secret, now), false);
  assert.equal(await verify(body, good, secret, now + 301_000), false);
  assert.equal(await verify(body, good, secret, now - 301_000), false);
  for (const h of [undefined, '', 'v1=abc', `t=${t}`, `t=x,v1=${'0'.repeat(64)}`]) assert.equal(await verify(body, h, secret, now), false, String(h));
  assert.equal(await verify(body, good, '', now), false);
});

test('Stripe\'s REST API: form encoded, the version pinned, the price and the account named; its words never handed on', async () => {
  assert.deepEqual(form({a: 1, b: {c: 'x y', d: {0: {e: 'f'}}}, n: null}), ['a=1', 'b%5Bc%5D=x%20y', 'b%5Bd%5D%5B0%5D%5Be%5D=f']);
  const sent: {url: string; init: RequestInit}[] = [];
  const answer = (j: unknown, status = 200) => () => new Response(JSON.stringify(j), {status});
  let next = answer({id: 'cs_1', url: 'https://checkout.stripe.com/c/1'});
  const api = stripeRest('sk_test_key', (async (url: string, init: RequestInit) => { sent.push({url, init}); return next(); }) as typeof fetch);
  assert.equal(await api.checkout({customer: 'cus_1', user: 'u1', tier: 'pro', price: 'price_1', success: 'https://app/', cancel: 'https://app/'}), 'https://checkout.stripe.com/c/1');
  const [{url, init}] = sent;
  const h = init.headers as Record<string, string>;
  assert.deepEqual([url, init.method, h.Authorization, h['Stripe-Version'], h['Content-Type']],
    ['https://api.stripe.com/v1/checkout/sessions', 'POST', 'Bearer sk_test_key', '2024-06-20', 'application/x-www-form-urlencoded']);
  const q = new URLSearchParams(init.body as string);
  assert.deepEqual([q.get('mode'), q.get('customer'), q.get('line_items[0][price]'), q.get('line_items[0][quantity]'), q.get('client_reference_id'),
    q.get('subscription_data[metadata][user]'), q.get('subscription_data[metadata][tier]')], ['subscription', 'cus_1', 'price_1', '1', 'u1', 'u1', 'pro']);
  // The same tier asked again from the same page is the same Checkout; another tier is another.
  await api.checkout({customer: 'cus_1', user: 'u1', tier: 'pro', price: 'price_1', success: 'https://app/', cancel: 'https://app/'});
  await api.checkout({customer: 'cus_1', user: 'u1', tier: 'max', price: 'price_3', success: 'https://app/', cancel: 'https://app/'});
  const key = (i: number) => (sent[i].init.headers as Record<string, string>)['Idempotency-Key'];
  assert.deepEqual([key(0) === key(1), key(0) === key(2)], [true, false]);
  // A change of tier opens the portal at its step: the subscription's item to the new price, then back.
  next = answer({id: 'bps_1', url: 'https://billing.stripe.com/p/1'});
  await api.portal({customer: 'cus_1', back: 'https://app/?plan=managed', change: {subscription: 'sub_1', item: 'si_1', price: 'price_3'}});
  const flow = new URLSearchParams(sent.at(-1)!.init.body as string);
  assert.deepEqual([flow.get('flow_data[type]'), flow.get('flow_data[subscription_update_confirm][subscription]'),
    flow.get('flow_data[subscription_update_confirm][items][0][id]'), flow.get('flow_data[subscription_update_confirm][items][0][price]'),
    flow.get('flow_data[after_completion][redirect][return_url]')], ['subscription_update_confirm', 'sub_1', 'si_1', 'price_3', 'https://app/?plan=managed']);
  next = answer({id: 'cus_9'});
  assert.equal(await api.customer({user: 'u1', email: 'a@b.c', name: 'A'}), 'cus_9');
  assert.equal((sent.at(-1)!.init.headers as Record<string, string>)['Idempotency-Key'], 'customer-u1');
  next = answer({error: {message: 'No such price: sk_live_secret'}}, 400);
  const errors: unknown[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try { await assert.rejects(api.portal({customer: 'cus_9', back: 'https://app/'}), (e: Error) => e.message === 'Stripe 400'); } finally { console.error = was; }
  assert.equal(errors.length, 1);
});
