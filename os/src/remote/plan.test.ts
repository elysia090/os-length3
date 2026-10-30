import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GRACE} from '../../service/plan.ts';
import {sign} from '../../service/stripe.ts';
import {fakeStripe, PRICES, WEBHOOK_SECRET} from '../../service/testing.ts';
import type {Plan} from './plan.ts';
import {browserOnRemote} from '../testing/remote.ts';

// The Plan part and the places the Remote refuses for the plan's sake, as the app has them: drawn from
// what the Remote says (planView), and against the Remote itself (a free allowance of one repo and 3 kB,
// Stripe a stand-in), what a refused repo, server and name come to here.

const stripe = fakeStripe();
/** What each paid tier says it adds besides its room and names. */
const ADDS = ['Make servers', 'Names on your own domain (name@yourdomain)'];
const b = await browserOnRemote({plan: {free: {repos: 1, bytes: 3000, names: 1}, grace: GRACE}, billing: stripe.billing});
const plan = await import('./plan.ts');
const lifecycle = await import('./lifecycle.ts');
const servers = await import('./servers.ts');
const inbox = await import('./inbox.ts');
const {RemoteError} = await import('./connection.ts');
const {setLang} = await import('../i18n.ts');

const DAY = 86_400_000, now = Date.UTC(2031, 9, 17);
const free = {repos: 3, bytes: 100_000_000, names: 1};

const GB = 1e9;
const go = {repos: null, bytes: 50 * GB, names: 5}, pro = {repos: null, bytes: 256 * GB, names: 10}, max = {repos: null, bytes: 512 * GB, names: 20};
const usd = (amount: number) => ({amount, currency: 'usd', interval: 'month' as const, every: 1});
const tiers = [{tier: 'free' as const, allowance: free}, {tier: 'go' as const, allowance: go, sold: true, price: usd(700)},
  {tier: 'pro' as const, allowance: pro, sold: true, price: usd(1400)}, {tier: 'max' as const, allowance: max, sold: true, price: usd(1900)}];

test('the Plan part, free: its use against the free allowance, and free and the three tiers side by side, each to subscribe to', () => {
  const f = plan.planView({plan: 'free', tier: 'free', status: null, usage: {repos: 2, bytes: 25_000_000, names: 1}, allowance: free, free, tiers, buy: true, manage: false}, now);
  assert.equal(f.title, 'Free plan');
  assert.equal(f.line, 'Keeps 3 repos and 100 MB on the Remote, and one name');
  assert.deepEqual(f.meters.map((m) => [m.label, m.used, m.of, m.share, m.over]),
    [['Repos on the Remote', '2', '3', 2 / 3, false], ['Kept on the Remote', '25.0 MB', '100 MB', 0.25, false], ['Names on this Remote', '1', '1', 1, false]]);
  assert.deepEqual(f.tiers.map((c) => [c.name, c.price, c.keeps, c.current, c.deed?.label ?? null]), [
    ['Free plan', 'No charge', ['100 MB on the Remote', '3 repos', '1 name here'], true, null],
    ['Go plan', '$7 a month', ['50 GB on the Remote', 'Repos as many as fit', '5 names here', ...ADDS], false, 'Subscribe'],
    ['Pro plan', '$14 a month', ['256 GB on the Remote', 'Repos as many as fit', '10 names here', ...ADDS], false, 'Subscribe'],
    ['Max plan', '$19 a month', ['512 GB on the Remote', 'Repos as many as fit', '20 names here', ...ADDS], false, 'Subscribe']]);
  // Free, nothing is managed; each tier is subscribed to from its own card.
  // Free as free is: its own card says what it keeps, so nothing is said again beside the tiers.
  assert.deepEqual([f.action, f.note, f.aside], [null, null, null]);
  // Over: the meter is full, and it says what happens to what is new.
  const over = plan.planView({plan: 'free', tier: 'free', usage: {repos: 5, bytes: 120_000_000, names: 1}, allowance: free, free, tiers, buy: true}, now);
  assert.deepEqual(over.meters.map((m) => [m.share, m.over]), [[1, true], [1, true], [1, false]]);
  assert.match(over.note!, /stays on your device/);
  // Ended: free again, Subscribe again, and what was made stays.
  const ended = plan.planView({plan: 'free', tier: 'free', status: 'canceled', ends: now - DAY, usage: {repos: 1, bytes: 0, names: 1}, allowance: free, free, tiers, buy: true, manage: true}, now);
  assert.deepEqual([ended.line.startsWith('Ended'), ended.tiers[1].deed?.kind, ended.action], [true, 'checkout', null]);
  // Billing off: no tiers to choose among, nothing to press, and it says why.
  const off = plan.planView({plan: 'free', tier: 'free', usage: {repos: 0, bytes: 0, names: 0}, allowance: free, free, tiers: [tiers[0]], buy: false}, now);
  assert.deepEqual([off.tiers, off.action, off.note], [[], null, 'Paid features cannot be bought on this Remote yet']);
  // The price not known (Stripe away): said to be shown at payment.
  const unpriced = plan.planView({plan: 'free', tier: 'free', allowance: free, free, tiers: [tiers[0], {tier: 'go', allowance: go, sold: true}], buy: true}, now);
  assert.equal(unpriced.tiers[1].price, 'Price shown at payment');
  setLang('ja');
  const ja = plan.planView({plan: 'free', tier: 'free', usage: {repos: 0, bytes: 0, names: 0}, allowance: free, free, tiers, buy: true}, now, 'ja');
  assert.deepEqual([ja.line, ja.tiers.map((c) => c.name), ja.tiers[2].keeps, ja.tiers[2].deed?.label],
    ['Remote に repo 3個と 100 MB、名前1つまで', ['無料プラン', 'Go プラン', 'Pro プラン', 'Max プラン'], ['Remote に 256 GB', 'repo は入るだけ', 'この Remote の名前10個', 'サーバーを作れる', '自分のドメインの名前（name@yourdomain）'], '登録する']);
  setLang('en');
});

test('the Plan part, paid: the tier marked, its use against what it keeps, Upgrade and Downgrade, Manage the plan', () => {
  const day = (ms: number) => new Date(ms).toLocaleDateString('en', {year: 'numeric', month: 'short', day: 'numeric'});
  const p = plan.planView({plan: 'paid', tier: 'pro', status: 'active', renews: now + 20 * DAY, usage: {repos: 5, bytes: 120 * GB, names: 2},
    allowance: pro, free, tiers, buy: true, manage: true}, now);
  assert.deepEqual([p.title, p.line, p.action, p.note], ['Pro plan', `Renews ${day(now + 20 * DAY)}`, {kind: 'portal', label: 'Manage the plan'}, null]);
  // Repos as many as fit: the figure alone; bytes and names against Pro's.
  assert.deepEqual(p.meters.map((m) => [m.used, m.of, m.share]), [['5', null, 0], ['120 GB', '256 GB', 120 / 256], ['2', '10', 0.2]]);
  // Pro is its own (nothing to press); Go is down, keeping less than is kept now; Max is up; free has nothing (cancelling is Manage's).
  assert.deepEqual(p.tiers.map((c) => [c.tier, c.current, c.deed, c.over]), [['free', false, null, true], ['go', false, {kind: 'change', label: 'Downgrade'}, true],
    ['pro', true, null, false], ['max', false, {kind: 'change', label: 'Upgrade'}, false]]);
  assert.match(plan.planView({plan: 'paid', tier: 'go', status: 'active', ends: now + DAY, allowance: go, free, tiers, buy: true, manage: true}, now).line, /^Ends /);
  // A payment that failed is put right first (Manage): no tier is changed to meanwhile.
  const owed = plan.planView({plan: 'paid', tier: 'go', status: 'past_due', graceUntil: now + 10 * DAY, allowance: go, free, tiers, buy: true, manage: true}, now);
  assert.match(owed.line, /did not go through · paid until/);
  assert.deepEqual([owed.tiers.every((c) => !c.deed), owed.action?.kind], [true, 'portal']);
});

test('what came back from the portal is said once against the plan as it was: a tier, an end set or taken back, the end', () => {
  const paid = (o: Partial<Plan>): Plan => ({plan: 'paid', tier: 'pro', renews: now + 9 * DAY, ...o});
  const was = {tier: 'pro' as const, ends: null, paid: true};
  assert.equal(plan.changedWords(was, paid({tier: 'max'})), 'You are on Max now.');
  assert.match(plan.changedWords(was, paid({renews: null, ends: now + 9 * DAY}))!, /^Cancelled: Pro stays until .+, and nothing more is charged\.$/);
  assert.match(plan.changedWords({...was, ends: now + 9 * DAY}, paid({}))!, /^Pro goes on: it renews /);
  assert.equal(plan.changedWords(was, {plan: 'free', tier: 'free'}), 'The plan has ended; what you made stays.');
  assert.equal(plan.changedWords(was, paid({})), null);
  // Two at once (a tier changed, then cancelled), one after the other, as the language writes sentences.
  const both = paid({tier: 'max', renews: null, ends: now + 9 * DAY});
  assert.match(plan.changedWords(was, both)!, /^You are on Max now\. Cancelled: Max stays until /);
  setLang('ja');
  assert.match(plan.changedWords(was, both)!, /^Max になりました。解約しました。Max は/);
  setLang('en');
});

test('a refusal of the plan\'s is known by its rule and tier, said in place, and says when paying is not offered here', () => {
  const e = new RemoteError(402, 'x', {rule: 'server', buy: true});
  assert.deepEqual(plan.planRefusal(e), {rule: 'server', buy: true, tier: 'free'});
  assert.equal(plan.refusalWords({rule: 'server', buy: true}), 'Making a server is part of the paid plan.');
  assert.match(plan.refusalWords({rule: 'repos', buy: false}), /stays on your device\. Paid features cannot be bought on this Remote yet\.$/);
  // A tier past what it keeps says so by its name.
  assert.deepEqual(plan.planRefusal(new RemoteError(402, 'x', {rule: 'bytes', buy: true, tier: 'go'})), {rule: 'bytes', buy: true, tier: 'go'});
  assert.equal(plan.refusalWords({rule: 'bytes', buy: true, tier: 'go'}), 'Go keeps no more on the Remote. What changed stays on your device.');
  setLang('ja');
  assert.equal(plan.refusalWords({rule: 'names', buy: true, tier: 'pro'}), 'Pro では、この Remote にこれ以上の名前を持てません。');
  setLang('en');
  for (const other of [new RemoteError(409, 'x', {rule: 'server'}), new RemoteError(402, 'x', {rule: 'what'}), new Error('x'), 'plan: x']) assert.equal(plan.planRefusal(other), null);
});

test('against the Remote: a repo past the allowance stays here and waits; a server and a domain name are refused in place', async () => {
  assert.deepEqual(await plan.plan().then((p) => [p.plan, p.buy, p.manage, p.free]), ['free', true, false, {repos: 1, bytes: 3000, names: 1}]);
  await b.store.create('one', 'standard');
  await b.draft.sync('one');
  await b.store.create('two', 'standard');
  const refused = await b.draft.sync('two').then(() => null, (e: unknown) => e);
  assert.deepEqual(plan.planRefusal(refused), {rule: 'repos', buy: true, tier: 'free'});
  // The app goes on with it: kept here, waiting, and the copy whole.
  await lifecycle.look();
  // The send the look began is done: at once if it has not begun yet (a look that asks the Remote nothing more after
  // reading what is here ends before it does), or once the next send of the same repo has its turn (one at a time).
  await lifecycle.settled();
  await b.draft.sync('two').catch(() => undefined);
  assert.equal(lifecycle.repoState('two')?.where, 'waits');
  assert.ok((await b.names('two')).length > 0);
  assert.deepEqual((await plan.plan()).usage?.repos, 1);
  await inbox.claim(`sora${process.pid}`);
  assert.deepEqual(plan.planRefusal(await servers.makeServer('Trip', `trip${process.pid}`).then(() => null, (e: unknown) => e)), {rule: 'server', buy: true, tier: 'free'});
  assert.deepEqual(plan.planRefusal(await inbox.claim('sora', 'sora.example').then(() => null, (e: unknown) => e)), {rule: 'domain', buy: true, tier: 'free'});
});

test('Subscribe opens Checkout; once Stripe says it is paid, the Plan says so and the repo that waited is sent', async () => {
  let went = '';
  Object.assign(globalThis, {location: {href: 'http://app.test/', assign: (u: string) => { went = u; }}});
  await plan.openPlan('checkout', {tier: 'pro'});
  assert.match(went, /^https:\/\/checkout\.stripe\.test\//);
  const checkout = stripe.asked.find((a) => a.call === 'checkout')!;
  // Back to the page it left, told how it went.
  assert.deepEqual([checkout.success, checkout.cancel], ['http://app.test/?plan=paid&tier=pro', 'http://app.test/?plan=cancelled']);
  // Stripe tells the Remote (the stand-in's event, signed as Stripe signs).
  const payload = JSON.stringify({id: `evt_client${process.pid}`, type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: {object: {
    id: 'sub_client', customer: checkout.customer, status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400, metadata: {user: checkout.user},
    items: {data: [{id: 'si_client', price: {id: PRICES.pro}}]}}}});
  const r = await fetch(`${b.URL}/v1/stripe/webhook`, {method: 'POST', body: payload, headers: {'Stripe-Signature': await sign(payload, WEBHOOK_SECRET), 'Content-Type': 'application/json'}});
  assert.equal(r.status, 200);
  const p = await plan.plan();
  assert.deepEqual([p.plan, p.tier, plan.planView(p).action?.kind, plan.planView(p).title], ['paid', 'pro', 'portal', 'Pro plan']);
  await lifecycle.flush();
  assert.equal(lifecycle.repoState('two')?.where, 'synced');
  await plan.openPlan('portal');
  assert.match(went, /^https:\/\/billing\.stripe\.test\//);
});

test('the price is said before paying, in the currency\'s own places, every period as Stripe says it', () => {
  assert.equal(plan.priceWords({amount: 800, currency: 'jpy', interval: 'month', every: 1}), '¥800 a month');
  assert.equal(plan.priceWords({amount: 500, currency: 'usd', interval: 'month', every: 3}), '$5 every 3 months');
  assert.equal(plan.priceWords({amount: 450, currency: 'usd', interval: 'week', every: 1}), '$4.50 a week');
  assert.equal(plan.priceWords({amount: 6000, currency: 'eur', interval: 'year', every: 1}), '€60 a year');
  // A currency no Intl knows still says its amount.
  assert.match(plan.priceWords({amount: 12, currency: 'zzz', interval: 'week', every: 1}), /12|ZZZ/);
  assert.equal(plan.TERMS('pro').length, 3);
});
