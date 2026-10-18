// The fixtures every spec starts from. Each test is its own person on the
// run's fresh Remote, so nothing one test does is seen by another and repo
// names can stay plain ('hello'): a repo's name is its owner's.
//
//   app         the app open in a fresh browser (no one signed in)
//   signedIn    the same, signed in through the development provider as
//               this test's own person (named after the test, so a failure
//               says whose it was, and a retry is someone new)
//   another     another person, in a browser of their own: another('Bo')
//
// Nothing is read from outside the repository: no saved browser state, no
// fixed port (global-setup.ts says where the app is).

import {createHash} from 'node:crypto';
import {test as base, expect, type Browser, type TestInfo} from '@playwright/test';
import {App} from './app.ts';
export {handleOf} from './app.ts';
import {BROWSER} from './paths.ts';

/** A name for this test's people: deterministic for the test, new for each retry. */
export function personName(info: TestInfo, who = 'Ada'): string {
  // The test's id begins with its file's: the whole of it tells tests apart.
  const id = createHash('sha256').update(info.testId).digest('hex').slice(0, 8);
  return `${who} ${id}${info.retry ? ` r${info.retry}` : ''}`;
}

async function opened(browser: Browser, url: string): Promise<{app: App; close(): Promise<void>}> {
  // Its own browser context: its own storage and cookies, so its own person. (The trace records it too.)
  const context = await browser.newContext({...BROWSER, baseURL: url});
  const app = new App(await context.newPage());
  await app.open();
  return {app, close: () => context.close()};
}

export const test = base.extend<{app: App; signedIn: App; another: (who: string) => Promise<App>}>({
  baseURL: async ({}, use) => {
    const url = process.env.SELFTEST_APP;
    if (!url) throw new Error('SELFTEST_APP is not set: run the selftest with `npm run selftest` (global-setup.ts starts the app)');
    await use(url);
  },
  app: async ({page}, use) => {
    // The run's Remote answers, or the failure says so (and where its log is) rather than timing out in a page.
    const remote = process.env.SELFTEST_REMOTE;
    await fetch(`${remote}/v1/about`).catch(() => { throw new Error(`the selftest's Remote (${remote}) does not answer: see selftest/.logs/remote.log`); });
    const app = new App(page);
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
      const o = await opened(browser, baseURL!);
      opened_.push(o);
      await o.app.signIn(personName(info, who));
      return o.app;
    });
    for (const o of opened_) await o.close();
  },
});

export {expect};
