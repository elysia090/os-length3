import assert from 'node:assert/strict';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// l3 and the plan, end to end: a Remote of its own with the plan the Remote on Workers has (one repo
// free here, so it is reached at once) and dev.ts's stand-in for Stripe. What l3 says of the plan, a
// repo past the allowance kept on the device and waiting, and once paid, sent.

const r = await remote({LENGTH3_PLAN: '1', LENGTH3_FREE_REPOS: '1'});
const sora = await r.browser('Sora Plan');
const laptop = r.device();
assert.equal((await laptop.login(sora)).code, 0);

function ok(x: Ran, says?: RegExp): Ran {
  assert.equal(x.code, 0, `${x.out}${x.err}`);
  if (says) assert.match(x.out, says);
  return x;
}

test('l3 remote plan: free, the use against the allowance, what paid adds; a repo past it waits here until paid', async () => {
  ok(laptop.l3(['remote', 'plan']), /^Plan {2}free\n {2}Repos on the Remote {2}0 of 1\n {2}Kept on the Remote {2}\d+ B of 100 MB\nPaid adds\n {2}Keep more than the free allowance on the Remote\n.*\n.*\nl3 remote plan subscribe gives the page to subscribe on\n$/);
  ok(laptop.l3(['repo', 'new', 'one', '-t', 'empty']));
  laptop.l3(['repo', 'new', 'two', '-t', 'empty']);
  // The second stays here, whole, and says why it is not on the Remote.
  ok(laptop.l3(['remote']), /two {2}not sent: The free plan keeps no more repos on the Remote: this one stays on this device and waits \(l3 remote plan\)/);
  ok(laptop.l3(['file', 'two']));
  assert.deepEqual((await r.api(sora, 'GET', '/v1/repos')).json.map((x: {name: string}) => x.name), ['one']);
  // The page to subscribe on, the Remote's (here its stand-in for Stripe); subscribing there makes it paid.
  const page = ok(laptop.l3(['remote', 'plan', 'subscribe', '--json'])).json.url as string;
  assert.match(page, new RegExp(`^${r.url}/dev-billing/checkout\\?`));
  const act = new URL(page.replace('/dev-billing/checkout', '/dev-billing/act'));
  act.searchParams.set('do', 'subscribe');
  assert.equal((await fetch(act, {redirect: 'manual'})).status, 302);
  ok(laptop.l3(['remote', 'plan']), /^Plan {2}paid · renews \d{4}-\d\d-\d\d\n {2}Repos on the Remote {2}1\n/);
  ok(laptop.l3(['remote']), /two {2}in step/);
  assert.match(ok(laptop.l3(['remote', 'plan', 'manage'])).out, /^Open this page in a browser to manage or cancel the plan:\n {2}http:\/\/127\.0\.0\.1:\d+\/dev-billing\/portal\?/);
});
