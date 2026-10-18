import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GRACE} from '../service/plan.ts';
import {sign} from '../service/stripe.ts';
import {fakeStripe, WEBHOOK_SECRET} from '../service/testing.ts';
import {browserOnRemote} from './testing-remote.ts';

// The Plan part and the places the Remote refuses for the plan's sake, as the app has them: drawn from
// what the Remote says (planView), and against the Remote itself (a free allowance of one repo and 3 kB,
// Stripe a stand-in), what a refused repo, server and name come to here.

const stripe = fakeStripe();
const b = await browserOnRemote({plan: {free: {repos: 1, bytes: 3000, names: 1}, grace: GRACE}, billing: stripe.billing});
const plan = await import('./plan.ts');
const lifecycle = await import('./lifecycle.ts');
const servers = await import('./servers.ts');
const inbox = await import('./inbox.ts');
const {RemoteError} = await import('./remote.ts');
const {setLang} = await import('./i18n.ts');

const DAY = 86_400_000, now = Date.UTC(2031, 9, 17);
const free = {repos: 3, bytes: 100_000_000, names: 1};

test('the Plan part: free, its use against the allowance and Subscribe; paid, when it renews or ends and Manage', () => {
  const f = plan.planView({plan: 'free', status: null, usage: {repos: 2, bytes: 25_000_000, names: 1}, free, buy: true, manage: false}, now);
  assert.equal(f.title, 'Free plan');
  assert.equal(f.line, 'Free: 3 repos on the Remote, 100 MB, one name');
  assert.deepEqual(f.meters.map((m) => [m.label, m.used, m.of, m.share, m.over]),
    [['Repos on the Remote', '2', '3', 2 / 3, false], ['Kept on the Remote', '25.0 MB', '100 MB', 0.25, false]]);
  assert.deepEqual([f.action, f.note, f.adds.length], [{kind: 'checkout', label: 'Subscribe'}, null, 3]);
  // Over: the meter is full, and it says what happens to what is new.
  const over = plan.planView({plan: 'free', usage: {repos: 5, bytes: 120_000_000, names: 1}, free, buy: true}, now);
  assert.deepEqual(over.meters.map((m) => [m.share, m.over]), [[1, true], [1, true]]);
  assert.match(over.note!, /stays on your device/);
  const paid = plan.planView({plan: 'paid', status: 'active', renews: now + 20 * DAY, usage: {repos: 5, bytes: 120_000_000, names: 2}, free, buy: true, manage: true}, now);
  assert.deepEqual([paid.title, paid.line, paid.action?.kind, paid.meters.map((m) => [m.of, m.share, m.over]), paid.note],
    ['Paid plan', `Renews ${new Date(now + 20 * DAY).toLocaleDateString('en', {year: 'numeric', month: 'short', day: 'numeric'})}`, 'portal', [[null, 0, false], [null, 0, false]], null]);
  assert.match(plan.planView({plan: 'paid', status: 'active', ends: now + DAY, buy: true, manage: true}, now).line, /^Ends /);
  assert.match(plan.planView({plan: 'paid', status: 'past_due', graceUntil: now + 10 * DAY, buy: true, manage: true}, now).line, /did not go through · paid until/);
  // Ended: free again, Subscribe again, and what was made stays.
  const ended = plan.planView({plan: 'free', status: 'canceled', ends: now - DAY, usage: {repos: 1, bytes: 0, names: 1}, free, buy: true, manage: true}, now);
  assert.deepEqual([ended.line.startsWith('Ended'), ended.action?.kind], [true, 'checkout']);
  // Billing off: nothing to press, and it says why.
  const off = plan.planView({plan: 'free', usage: {repos: 0, bytes: 0, names: 0}, free, buy: false}, now);
  assert.deepEqual([off.action, off.note], [null, 'Paid features cannot be bought on this Remote yet']);
  setLang('ja');
  assert.equal(plan.planView({plan: 'free', usage: {repos: 0, bytes: 0, names: 0}, free, buy: true}, now).line, '無料：Remote に repo 3個、100 MB、名前1つ');
  setLang('en');
});

test('a refusal of the plan\'s is known by its rule, said in place, and says when paying is not offered here', () => {
  const e = new RemoteError(402, 'x', {rule: 'server', buy: true});
  assert.deepEqual(plan.planRefusal(e), {rule: 'server', buy: true});
  assert.equal(plan.refusalWords({rule: 'server', buy: true}), 'Making a server is part of the paid plan.');
  assert.match(plan.refusalWords({rule: 'repos', buy: false}), /stays on your device\. Paid features cannot be bought on this Remote yet\.$/);
  for (const other of [new RemoteError(409, 'x', {rule: 'server'}), new RemoteError(402, 'x', {rule: 'what'}), new Error('x'), 'plan: x']) assert.equal(plan.planRefusal(other), null);
});

test('against the Remote: a repo past the allowance stays here and waits; a server and a domain name are refused in place', async () => {
  assert.deepEqual(await plan.plan().then((p) => [p.plan, p.buy, p.manage, p.free]), ['free', true, false, {repos: 1, bytes: 3000, names: 1}]);
  await b.store.create('one', 'standard');
  await b.draft.sync('one');
  await b.store.create('two', 'standard');
  const refused = await b.draft.sync('two').then(() => null, (e: unknown) => e);
  assert.deepEqual(plan.planRefusal(refused), {rule: 'repos', buy: true});
  // The app goes on with it: kept here, waiting, and the copy whole.
  await lifecycle.look();
  // The send the look began is done once the next send of the same repo has its turn (one at a time).
  await b.draft.sync('two').catch(() => undefined);
  assert.equal(lifecycle.repoState('two')?.where, 'waits');
  assert.ok((await b.names('two')).length > 0);
  assert.deepEqual((await plan.plan()).usage?.repos, 1);
  await inbox.claim(`sora${process.pid}`);
  assert.deepEqual(plan.planRefusal(await servers.makeServer('Trip', `trip${process.pid}`).then(() => null, (e: unknown) => e)), {rule: 'server', buy: true});
  assert.deepEqual(plan.planRefusal(await inbox.claim('sora', 'sora.example').then(() => null, (e: unknown) => e)), {rule: 'domain', buy: true});
});

test('Subscribe opens Checkout; once Stripe says it is paid, the Plan says so and the repo that waited is sent', async () => {
  let went = '';
  Object.assign(globalThis, {location: {href: 'http://app.test/', assign: (u: string) => { went = u; }}});
  await plan.openPlan('checkout');
  assert.match(went, /^https:\/\/checkout\.stripe\.test\//);
  const checkout = stripe.asked.find((a) => a.call === 'checkout')!;
  assert.equal(checkout.success, 'http://app.test/');
  // Stripe tells the Remote (the stand-in's event, signed as Stripe signs).
  const payload = JSON.stringify({id: `evt_client${process.pid}`, type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: {object: {
    id: 'sub_client', customer: checkout.customer, status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400, metadata: {user: checkout.user}}}});
  const r = await fetch(`${b.URL}/v1/stripe/webhook`, {method: 'POST', body: payload, headers: {'Stripe-Signature': await sign(payload, WEBHOOK_SECRET), 'Content-Type': 'application/json'}});
  assert.equal(r.status, 200);
  const p = await plan.plan();
  assert.deepEqual([p.plan, plan.planView(p).action?.kind], ['paid', 'portal']);
  await lifecycle.flush();
  assert.equal(lifecycle.repoState('two')?.where, 'synced');
  await plan.openPlan('portal');
  assert.match(went, /^https:\/\/billing\.stripe\.test\//);
});
