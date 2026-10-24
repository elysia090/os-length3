// The fixtures every spec starts from. Each test is its own person on the
// run's fresh Remote, so nothing one test does is seen by another and repo
// names can stay plain ('hello'): a repo's name is its owner's.
//
//   app         the app open in a fresh browser (no one signed in), whose
//               passkeys a virtual authenticator makes and gives at once
//   signedIn    the same, signed in through the development provider as
//               this test's own person (named after the test, so a failure
//               says whose it was, and a retry is someone new)
//   another     another person, in a browser of their own: another('Bo')
//   planApp     the app on the run's other Remote, the one with the plan (the
//               free allowance, the tiers, and Stripe's stand-in in test mode:
//               global-setup.ts), in a fresh browser, no one signed in
//   helloC      (one for each worker) what a browser keeps once someone, no one
//               signed in, has made 'hello' from C's files there and left it
//               open in Forge: a spec that starts its tests from it
//               (test.use({storageState: ({helloC}, use) => use(helloC)})) has
//               each open the app on that repo in a fresh browser of its own,
//               as on coming back to it, rather than making it again each time
//
// Nothing is read from outside the repository: no saved browser state, no
// fixed port (global-setup.ts says where the app is).

import {createHash} from 'node:crypto';
import {test as base, expect, type Browser, type BrowserContextOptions, type TestInfo} from '@playwright/test';
import {App} from './app.ts';
export {handleOf} from './app.ts';
import {BROWSER} from './paths.ts';

/** What a browser keeps (its localStorage, and IndexedDB, where the repos are), as Playwright reads and restores it. */
type Kept = Exclude<BrowserContextOptions['storageState'], string | undefined>;

/** Where the run's app is (global-setup.ts). */
function appURL(): string {
  const url = process.env.SELFTEST_APP;
  if (!url) throw new Error('SELFTEST_APP is not set: run the selftest with `npm run selftest` (global-setup.ts starts the app)');
  return url;
}

/** A name for this test's people: deterministic for the test, new for each retry. */
export function personName(info: TestInfo, who = 'Ada'): string {
  // The test's id begins with its file's: the whole of it tells tests apart.
  const id = createHash('sha256').update(info.testId).digest('hex').slice(0, 8);
  return `${who} ${id}${info.retry ? ` r${info.retry}` : ''}`;
}

/**
 * Where a person's browser is, as the Remote sees it (CF-Connecting-IP, as Cloudflare says it): an
 * address of its own for each, as people have, so the sign-ins of a whole run are not one address's.
 */
export function addressOf(info: TestInfo, who = 'Ada'): string {
  const [a, b, c] = createHash('sha256').update(`${info.testId} ${who} ${info.retry}`).digest();
  return `10.${a}.${b}.${c}`;
}

async function opened(browser: Browser, url: string, address: string): Promise<{app: App; close(): Promise<void>}> {
  // Its own browser context: its own storage and cookies, so its own person. (The trace records it too.)
  const context = await browser.newContext({...BROWSER, baseURL: url, extraHTTPHeaders: {'CF-Connecting-IP': address}});
  const app = new App(await context.newPage());
  await app.withPasskeys();
  await app.open();
  return {app, close: () => context.close()};
}

export const test = base.extend<{app: App; signedIn: App; another: (who: string) => Promise<App>; planApp: App}, {helloC: Kept}>({
  baseURL: async ({}, use) => {
    await use(appURL());
  },
  helloC: [async ({browser}, use, info) => {
    // Made through the app, as `app.newRepo.make` makes it, by a browser of its own that no test is.
    const [a, b, c] = createHash('sha256').update(`hello in C, worker ${info.workerIndex}`).digest();
    const o = await opened(browser, appURL(), `10.${a}.${b}.${c}`);
    await o.app.newRepo.make('hello', {template: 'C'});
    await o.app.newRepo.openInForge();
    // What the last write sets going a moment after (Forge's note of where one is, which Home's Lately reads) has run
    // before what is kept is read: a timer of the page's own, set after those, fires after them.
    await o.app.page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    const kept = await o.app.page.context().storageState({indexedDB: true});
    await o.close();
    await use(kept);
  }, {scope: 'worker'}],
  app: async ({page}, use, info) => {
    // The run's Remote answers, or the failure says so (and where its log is) rather than timing out in a page.
    const remote = process.env.SELFTEST_REMOTE;
    await fetch(`${remote}/v1/about`).catch(() => { throw new Error(`the selftest's Remote (${remote}) does not answer: see selftest/.logs/remote.log`); });
    await page.context().setExtraHTTPHeaders({'CF-Connecting-IP': addressOf(info)});
    const app = new App(page);
    await app.withPasskeys();
    await app.open();
    await use(app);
  },
  signedIn: async ({app}, use, info) => {
    await app.signIn(personName(info));
    await use(app);
  },
  another: async ({browser, baseURL}, use, info) => {
    const opened_: {close(): Promise<void>}[] = [];
    await use(async (who) => {
      // A second device of the same person is somewhere else too.
      const o = await opened(browser, baseURL!, addressOf(info, `${who} ${opened_.length + 1}`));
      opened_.push(o);
      await o.app.signIn(personName(info, who));
      return o.app;
    });
    for (const o of opened_) await o.close();
  },
  planApp: async ({browser}, use, info) => {
    const url = process.env.SELFTEST_PLAN_APP;
    if (!url) throw new Error('SELFTEST_PLAN_APP is not set: run the selftest with `npm run selftest` (global-setup.ts starts the Remote with the plan)');
    const o = await opened(browser, url, addressOf(info, 'Plan'));
    await use(o.app);
    await o.close();
  },
});

export {expect};
