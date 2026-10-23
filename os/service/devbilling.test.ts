import assert from 'node:assert/strict';
import {test} from 'node:test';
import {brandOf, cardOutcome, cardTrouble, devBilling, luhn} from './devbilling.ts';
import {GRACE, type PlanConfig} from './plan.ts';
import {APP, BASE, enc, fileService, WEBHOOK_SECRET, type Service} from './testing.ts';

// The stand-in for Stripe (devbilling.ts) against the Remote it serves, in this process: its Checkout takes
// Stripe's test cards as Stripe does (paid, declined with nothing sent, 3-D Secure first), each step that
// changes something reaches the Remote as Stripe's signed events, and its portal changes the tier, cancels
// and keeps it, changes the card, and has its test controls. What the pages say is read as a person would.

const PLAN: PlanConfig = {free: {repos: 2, bytes: 4096, names: 1}, grace: GRACE};
let s: Service | null = null;
const stand = devBilling(BASE, WEBHOOK_SECRET, [APP], async (payload, signature) => {
  const r = await s!.call('POST', '/v1/stripe/webhook', {bytes: enc.encode(payload), headers: {'Stripe-Signature': signature, 'Content-Type': 'application/json'}});
  return new Response(r.text, {status: r.status});
});
s = await fileService({}, {plan: PLAN, billing: {stripe: stand.api, webhookSecret: WEBHOOK_SECRET, prices: stand.prices}});
const r = s;

/** A page or a step of the stand-in's, by the address it gave (under /dev-billing/), as dev.ts passes it on. */
async function at(url: string, init: RequestInit = {}) {
  assert.ok(url.startsWith(`${BASE}/dev-billing/`), url);
  const res = await stand.app.request(url.slice(`${BASE}/dev-billing`.length), init);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* a page */ }
  return {status: res.status, text, json, to: res.headers.get('Location'), policy: res.headers.get('Content-Security-Policy') ?? ''};
}
const post = (url: string, body?: unknown) => at(url, body === undefined ? {method: 'POST'}
  : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const card = (number: string, o: Record<string, string> = {}) => ({email: 'ada@example.com', number, exp: '12 / 34', cvc: '123', name: 'Ada', country: 'US', ...o});
const planOf = async (t: string) => (await r.call('GET', '/v1/plan', {token: t})).json as Record<string, unknown>;
async function checkout(t: string, tier: string) {
  const made = await r.call('POST', '/v1/plan/checkout', {token: t, body: {back: `${APP}/`, tier}});
  assert.equal(made.status, 200, made.text);
  return made.json.url as string;
}
async function portal(t: string, tier?: string) {
  const made = await r.call('POST', '/v1/plan/portal', {token: t, body: {back: `${APP}/`, ...(tier ? {tier} : {})}});
  assert.equal(made.status, 200, made.text);
  return made.json.url as string;
}

test('Checkout: the tier, its price and what it keeps; the card form in test mode; Back to the app', async () => {
  const t = await r.person('Ada');
  const page = await at(await checkout(t, 'pro'));
  assert.equal(page.status, 200);
  for (const said of ['Subscribe to Pro', '$14.00', '256 GB on the Remote', 'Test mode', 'Email', 'Card information', 'Cardholder name', 'Country or region', 'Total due today']) {
    assert.ok(page.text.includes(said), said);
  }
  // Its script is the page's own, by a nonce; nothing else runs, and it is never framed.
  assert.match(page.policy, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(page.policy, /frame-ancestors 'none'/);
  // Back is the app's cancel page.
  assert.ok(page.text.includes(`href="${APP}/?plan=cancelled"`));
});

test('Checkout: 0002 is declined under the card and nothing is sent; 4242 pays, and the Remote has the tier', async () => {
  const t = await r.person('Bo');
  const url = await checkout(t, 'pro');
  const declined = await post(`${url}/pay`, card('4000 0000 0000 0002'));
  assert.deepEqual([declined.status, declined.json?.wrong], [402, {field: 'number', message: 'Your card was declined.'}]);
  assert.deepEqual([(await planOf(t)).plan, (await planOf(t)).tier], ['free', 'free']);
  // What is wrong before the card is tried is said for its own field.
  assert.deepEqual((await post(`${url}/pay`, card('4242 4242 4242 4241'))).json?.wrong, {field: 'number', message: 'Your card number is invalid.'});
  assert.deepEqual((await post(`${url}/pay`, card('4242 4242 4242 4242', {exp: '01 / 20'}))).json?.wrong, {field: 'exp', message: 'Your card\'s expiration year is in the past.'});
  assert.deepEqual((await post(`${url}/pay`, card('4242 4242 4242 4242', {cvc: '1'}))).json?.wrong, {field: 'cvc', message: 'Your card\'s security code is incomplete.'});
  assert.deepEqual((await post(`${url}/pay`, card('4242 4242 4242 4242', {email: 'ada'}))).json?.wrong, {field: 'email', message: 'Your email address is invalid.'});
  const paid = await post(`${url}/pay`, card('4242 4242 4242 4242'));
  assert.deepEqual(paid.json, {next: `${APP}/?plan=paid&tier=pro`});
  const p = await planOf(t);
  assert.deepEqual([p.plan, p.tier, p.status, p.manage], ['paid', 'pro', 'active', true]);
  // A session paid is done: it cannot be paid twice.
  assert.equal((await at(url)).status, 404);
});

test('Checkout: 3155 asks for 3-D Secure; Fail goes back to Checkout and says so, Complete pays', async () => {
  const t = await r.person('Cy');
  const url = await checkout(t, 'max');
  const asked = await post(`${url}/pay`, card('4000 0025 0000 3155'));
  const secure = asked.json?.next as string;
  assert.match(secure, /\/dev-billing\/3ds\/payatt_/);
  const step = await at(secure);
  assert.ok(step.text.includes('3D Secure 2 Test Page') && step.text.includes('$19.00') && step.text.includes('•••• 3155'));
  const failed = await post(`${secure}/fail`);
  assert.deepEqual([failed.status, failed.to], [303, `${url}?declined=3ds`]);
  assert.ok((await at(failed.to!)).text.includes('We are unable to authenticate your payment method.'));
  assert.equal((await planOf(t)).plan, 'free');
  // Asked again and completed: paid, back to the app.
  const again = (await post(`${url}/pay`, card('4000 0025 0000 3155'))).json?.next as string;
  const done = await post(`${again}/complete`);
  assert.deepEqual([done.status, done.to], [303, `${APP}/?plan=paid&tier=max`]);
  assert.deepEqual([(await planOf(t)).plan, (await planOf(t)).tier], ['paid', 'max']);
});

test('the portal: the tier and the next payment; a change of tier, up then down, as the events Stripe sends; its invoices', async () => {
  const t = await r.person('Di');
  await post(`${await checkout(t, 'go')}/pay`, card('4242 4242 4242 4242'));
  const home = await portal(t);
  const first = await at(home);
  for (const said of ['Current subscription', 'Go', '$7.00 per month', 'Your plan renews on', 'Visa •••• 4242', 'Invoice history', 'Paid', 'Test controls', 'Return to length3']) {
    assert.ok(first.text.includes(said), said);
  }
  // Up from the portal's own list: what it costs now, then Confirm; the Remote has Max at once, and an invoice for the rest of the period.
  const list = await at(`${home}/change`);
  assert.ok(list.text.includes('Current plan') && list.text.includes('Select Max'));
  const confirm = await at(`${home}/change/max`);
  assert.ok(confirm.text.includes('Confirm your updated plan') && confirm.text.includes('Amount due today'));
  const up = await post(`${home}/change/max`);
  assert.deepEqual([up.status, up.to], [303, `${home}?done=change`]);
  assert.equal((await planOf(t)).tier, 'max');
  const after = await at(up.to!);
  assert.ok(after.text.includes('Your subscription has been updated.') && after.text.includes('Go → Max'));
  // Down, asked from the app for that one change: credited, and back to the app once confirmed.
  const down = await portal(t, 'pro');
  assert.match(down, new RegExp(`^${BASE}/dev-billing/portal/bps_[A-Za-z0-9_]+/change/pro$`));
  assert.ok((await at(down)).text.includes('Credited to your next invoice'));
  const back = await post(down);
  assert.deepEqual([back.status, back.to], [303, `${APP}/?plan=managed`]);
  assert.equal((await planOf(t)).tier, 'pro');
});

test('the portal: cancelling ends it at the period\'s end, Renew plan keeps it; the test controls', async () => {
  const t = await r.person('Eve');
  await post(`${await checkout(t, 'pro')}/pay`, card('4242 4242 4242 4242'));
  const home = await portal(t);
  assert.ok((await at(`${home}/cancel`)).text.includes('still available until the end of your billing period'));
  await post(`${home}/cancel`);
  let p = await planOf(t);
  assert.deepEqual([p.plan, p.renews, typeof p.ends], ['paid', null, 'number']);
  const page = await at(home);
  assert.ok(page.text.includes('Your subscription will be canceled on') && page.text.includes('Renew plan'));
  await post(`${home}/renew`);
  p = await planOf(t);
  assert.deepEqual([p.plan, typeof p.renews, p.ends], ['paid', 'number', null]);
  // A payment fails: past due, paid through the grace; a card that pays puts it right at once.
  await post(`${home}/test/fail`);
  p = await planOf(t);
  assert.deepEqual([p.plan, p.status, typeof p.graceUntil], ['paid', 'past_due', 'number']);
  assert.deepEqual((await post(`${home}/card`, card('4000 0000 0000 0002'))).json?.wrong, {field: 'number', message: 'Your card was declined.'});
  assert.equal((await planOf(t)).status, 'past_due');
  assert.deepEqual((await post(`${home}/card`, card('5555 5555 5555 4444'))).json, {next: `${home}?done=card`});
  p = await planOf(t);
  assert.deepEqual([p.status, p.graceUntil], ['active', null]);
  assert.ok((await at(home)).text.includes('Mastercard •••• 4444'));
  // The next period paid; then it ends now.
  await post(`${home}/test/paid`);
  assert.equal((await planOf(t)).plan, 'paid');
  await post(`${home}/test/end`);
  p = await planOf(t);
  assert.deepEqual([p.plan, p.status], ['free', 'canceled']);
  assert.ok((await at(home)).text.includes('Your subscription was canceled on'));
});

test('cards as Stripe\'s test mode takes them: Luhn, brands, an expiry to come, a CVC; the test cards\' outcomes', () => {
  assert.deepEqual(['4242424242424242', '4000000000000002', '4000002500003155', '378282246310005', '4242424242424241'].map(luhn), [true, true, true, true, false]);
  assert.deepEqual(['4242', '5555', '2223', '3782', '6011', '9999'].map(brandOf), ['visa', 'mastercard', 'mastercard', 'amex', 'discover', '']);
  const now = new Date(Date.UTC(2026, 9, 23));
  assert.equal(cardTrouble({number: '4242 4242 4242', exp: '12/34', cvc: '123'}, now)?.message, 'Your card number is incomplete.');
  assert.equal(cardTrouble({number: '4242424242424242', exp: '09/26', cvc: '123'}, now)?.message, 'Your card\'s expiration date is in the past.');
  assert.equal(cardTrouble({number: '4242424242424242', exp: '10/26', cvc: '123'}, now), null);
  assert.equal(cardTrouble({number: '378282246310005', exp: '10/26', cvc: '123'}, now)?.field, 'cvc');
  assert.equal(cardTrouble({number: '378282246310005', exp: '10/26', cvc: '1234'}, now), null);
  assert.deepEqual(cardOutcome('4242 4242 4242 4242'), {ok: true});
  assert.deepEqual(cardOutcome('4000 0025 0000 3155'), {secure: true});
  assert.deepEqual(cardOutcome('4000 0000 0000 0002'), {field: 'number', message: 'Your card was declined.'});
  // A card that is not one of the test cards is declined, as test mode declines a real one.
  assert.match((cardOutcome('4111 1111 1111 1111') as {message: string}).message, /test mode/);
});
