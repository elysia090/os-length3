import assert from 'node:assert/strict';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// l3 and the plan, end to end: a Remote of its own with the plan the Remote on Workers has (one repo
// free here, so it is reached at once) and dev.ts's stand-in for Stripe. What l3 says of the plan, a
// repo past the allowance kept on the device and waiting, and once a tier is paid for, sent.

const r = await remote({LENGTH3_PLAN: '1', LENGTH3_FREE_REPOS: '1'});
const sora = await r.browser('Sora Plan');
const laptop = r.device();
assert.equal((await laptop.login(sora)).code, 0);

function ok(x: Ran, says?: RegExp): Ran {
  assert.equal(x.code, 0, `${x.out}${x.err}`);
  if (says) assert.match(x.out, says);
  return x;
}

/** Pay in the stand-in's Checkout at `page` with Stripe's test card that pays, as its card form sends it. */
async function pay(page: string) {
  const r = await fetch(`${page}/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: 'sora@example.com', number: '4242 4242 4242 4242', exp: '12 / 34', cvc: '123', name: 'Sora', country: 'JP'})});
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json() as {next: string}).next;
}

test('l3 remote plan: free, the use against the allowance, the tiers, what paid adds; a repo past it waits here until paid', async () => {
  ok(laptop.l3(['remote', 'plan']), new RegExp(['^Plan {2}free', ' {2}Repos on the Remote {2}0 of 1', ' {2}Kept on the Remote {2}\\d+ B of 100 MB', ' {2}Names on this Remote {2}0 of 1',
    'Tiers', ' {2}Go {2}50 GB on the Remote · 7\\.00 USD a month', ' {2}Pro {2}256 GB on the Remote · 14\\.00 USD a month', ' {2}Max {2}512 GB on the Remote · 19\\.00 USD a month',
    'Paid adds', ' {2}Keep more than the free allowance on the Remote', '.*', '.*', 'l3 remote plan subscribe go\\|pro\\|max gives the page to subscribe on\\n$'].join('\\n')));
  ok(laptop.l3(['repo', 'new', 'one', '-t', 'empty']));
  laptop.l3(['repo', 'new', 'two', '-t', 'empty']);
  // The second stays here, whole, and says why it is not on the Remote.
  ok(laptop.l3(['remote']), /two {2}not sent: The free plan keeps no more repos on the Remote: this one stays on this device and waits \(l3 remote plan\)/);
  ok(laptop.l3(['file', 'two']));
  assert.deepEqual((await r.api(sora, 'GET', '/v1/repos')).json.map((x: {name: string}) => x.name), ['one']);
  // The page to subscribe to Pro on, the Remote's (here its stand-in for Stripe); paying there makes it Pro.
  const page = ok(laptop.l3(['remote', 'plan', 'subscribe', 'pro', '--json'])).json.url as string;
  assert.match(page, new RegExp(`^${r.url}/dev-billing/checkout/cs_dev\\w+$`));
  assert.match(await pay(page), /[?&]plan=paid&tier=pro$/);
  ok(laptop.l3(['remote', 'plan']), /^Plan {2}Pro · renews \d{4}-\d\d-\d\d\n {2}Repos on the Remote {2}1\n {2}Kept on the Remote {2}\d+ B of 256 GB\n/);
  ok(laptop.l3(['remote']), /two {2}in step/);
  assert.match(ok(laptop.l3(['remote', 'plan', 'manage'])).out, /^Open this page in a browser to manage or cancel the plan:\n {2}http:\/\/127\.0\.0\.1:\d+\/dev-billing\/portal\/bps_dev\w+\n$/);
  // Another tier is the portal at the step that changes to it; a tier that is none is said before the Remote is asked.
  assert.match(ok(laptop.l3(['remote', 'plan', 'switch', 'max'])).out, /^Open this page in a browser to change the tier:\n {2}http:\/\/127\.0\.0\.1:\d+\/dev-billing\/portal\/bps_dev\w+\/change\/max\n$/);
});
