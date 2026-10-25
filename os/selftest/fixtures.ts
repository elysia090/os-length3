// The fixtures every spec starts from. Each test is its own person on the
// run's fresh Remote, so nothing one test does is seen by another and repo
// names can stay plain ('hello'): a repo's name is its owner's.
//
//   app         the app open in a fresh browser (no one signed in), whose
//               passkeys a virtual authenticator makes and gives at once
//   signedIn    the same, signed in through the development provider as
//               this test's own person (named after the test, so a failure
//               says whose it was, and a retry is someone new): signed in
//               over HTTP, and the app opened as on coming back from the
//               provider, where it opens (`signInAt`); the provider's pages,
//               and the card's way to them, are signin.spec.ts's (`app.signIn`)
//   another     another person, in a browser of their own: another('Bo')
//   planSignedIn
//               the app on the run's other Remote, the one with the plan (the
//               free allowance, the tiers, and Stripe's stand-in in test mode:
//               global-setup.ts), in a fresh browser, signed in there as this
//               test's own person, as signedIn is
//   helloC      (one for each worker) what a browser keeps once someone, no one
//               signed in, has made 'hello' from C's files there and left it
//               open in Forge: a spec that starts its tests from it
//               (test.use({storageState: ({helloC}, use) => use(helloC)})) has
//               each open the app on that repo in a fresh browser of its own,
//               as on coming back to it, rather than making it again each time
//   l3Ahead     (an option, false) true: the translation of l3 made ahead of
//               time, which a Prompt fetches and compiles for the Prompts after
//               it 3 s after its prompt line is up (src/userland.ts warmL3), is
//               served. Otherwise the browser refuses it, as a line that broke,
//               and the app goes without it: 20 MB unpacked, checked and
//               compiled, half of what a test that opens Forge spends on its
//               Prompt, for l3 in a later Prompt, which only first-prompt.spec.ts
//               runs. The Prompt itself (BusyBox's sh) starts and runs in every
//               test, as it does for a person.
//
// Nothing is read from outside the repository: no saved browser state, no
// fixed port (global-setup.ts says where the app is).

import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test as base, expect, type Browser, type BrowserContextOptions, type Page, type TestInfo} from '@playwright/test';
import {App} from './app.ts';
export {handleOf} from './app.ts';
import {BROWSER, OUT} from './paths.ts';

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

/**
 * The files of what a Prompt is given ahead of time for the Prompts after it (each translation in the build's l3 but
 * BusyBox's, which a Prompt starts with: src/userland.ts FIRST), as the browser's blocked URLs say them; none in a
 * build without l3.
 */
const AHEAD: string[] = (() => {
  const about = join(OUT, 'l3', 'l3.json');
  if (!existsSync(about)) return [];
  const index = JSON.parse(readFileSync(join(OUT, 'l3', (JSON.parse(readFileSync(about, 'utf8')) as {index: {path: string}}).index.path), 'utf8')) as
    {translations: {path: string; elf: {path: string}; wasm: {path: string}}[]};
  return index.translations.filter((t) => t.path !== '/usr/bin/busybox').flatMap((t) => [`*/l3/${t.elf.path}`, `*/l3/${t.wasm.path}`]);
})();

/**
 * In `page`, what a Prompt is given ahead of time does not come (fixtures.ts, l3Ahead), unless `ahead`: refused by the
 * browser, which the app takes as a line that broke and, after a few tries, goes without. (Not by a route: a route
 * has every request of the page go through Playwright, and the HTTP cache off.)
 */
async function holdAhead(page: Page, ahead: boolean) {
  if (ahead || !AHEAD.length) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', {urls: AHEAD});
}

/** The run's Remote answers, or the failure says so (and where its log is) rather than timing out in a page. */
async function remoteAnswers() {
  const remote = process.env.SELFTEST_REMOTE;
  await fetch(`${remote}/v1/about`).catch(() => { throw new Error(`the selftest's Remote (${remote}) does not answer: see selftest/.logs/remote.log`); });
}

/**
 * `app` signed in as `name` through the Remote's development provider, the way coming back from it leaves the app:
 * this browser asks the Remote to sign in with the provider (with its own cookies, as the page's request does), the
 * provider's Allow goes on to the Remote's callback, which sets the session, and the app is opened where that sends
 * it (`url`/?signed-in), taking the session up there, at the place it opens at (Home in a browser new to it). Only
 * the provider's two pages are not drawn, nor the app before them (signing in through them was 1 to 2 s of a test):
 * those, the card's way there and what it says after are signin.spec.ts's.
 */
async function signInAt(app: App, url: string, name: string) {
  const request = app.page.context().request;
  const asked = await request.post('/api/auth/sign-in/social', {headers: {Origin: url},
    data: {provider: 'dev', callbackURL: `${url}/?signed-in`, errorCallbackURL: `${url}/?sign-in-failed`}});
  expect(asked.ok(), `signing in with the development provider: ${asked.status()} ${await asked.text()}`).toBe(true);
  // Its page (…/dev-oauth/authorize), whose Continue and Allow come to its approve with who one is.
  const at = new URL((await asked.json() as {url: string}).url);
  const allow = new URL('approve', at);
  for (const k of ['redirect_uri', 'state']) allow.searchParams.set(k, at.searchParams.get(k) ?? '');
  allow.searchParams.set('name', name);
  const back = await request.get(allow.href);
  expect(back.url(), 'where the provider sends the app back to, signed in').toBe(`${url}/?signed-in`);
  app.person = name;
  // What the app asks first, coming back: the session the Remote set, which it keeps as its own.
  const taken = app.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/get-session');
  await app.page.goto(back.url());
  expect((await (await taken).json() as {session?: unknown} | null)?.session, 'the session the app takes up').toBeTruthy();
  await app.settled();
}

/** A browser of its own (its own storage and cookies, so its own person) at `address`, the app not opened yet. */
async function browserAt(browser: Browser, url: string, address: string, ahead = false): Promise<{app: App; close(): Promise<void>}> {
  // Empty, whatever the test's own browser starts from (what a spec's test.use gives is every browser's made in its
  // tests, unless said otherwise). The trace records it too.
  const context = await browser.newContext({...BROWSER, baseURL: url, extraHTTPHeaders: {'CF-Connecting-IP': address}, storageState: undefined});
  const app = new App(await context.newPage());
  await holdAhead(app.page, ahead);
  await app.withPasskeys();
  return {app, close: () => context.close()};
}

async function opened(browser: Browser, url: string, address: string): Promise<{app: App; close(): Promise<void>}> {
  const o = await browserAt(browser, url, address);
  await o.app.open();
  return o;
}

export const test = base.extend<{l3Ahead: boolean; app: App; signedIn: App; another: (who: string) => Promise<App>; planSignedIn: App}, {helloC: Kept}>({
  baseURL: async ({}, use) => {
    await use(appURL());
  },
  l3Ahead: [false, {option: true}],
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
  app: async ({page, l3Ahead}, use, info) => {
    await remoteAnswers();
    await page.context().setExtraHTTPHeaders({'CF-Connecting-IP': addressOf(info)});
    await holdAhead(page, l3Ahead);
    const app = new App(page);
    await app.withPasskeys();
    await app.open();
    await use(app);
  },
  // Opened once, already signed in: not opened signed out first, then signed in.
  signedIn: async ({page, baseURL, l3Ahead}, use, info) => {
    await remoteAnswers();
    await page.context().setExtraHTTPHeaders({'CF-Connecting-IP': addressOf(info)});
    await holdAhead(page, l3Ahead);
    const app = new App(page);
    await app.withPasskeys();
    await signInAt(app, baseURL!, personName(info));
    await use(app);
  },
  another: async ({browser, baseURL, l3Ahead}, use, info) => {
    const opened_: {close(): Promise<void>}[] = [];
    await use(async (who) => {
      // A second device of the same person is somewhere else too.
      const o = await browserAt(browser, baseURL!, addressOf(info, `${who} ${opened_.length + 1}`), l3Ahead);
      opened_.push(o);
      await signInAt(o.app, baseURL!, personName(info, who));
      return o.app;
    });
    for (const o of opened_) await o.close();
  },
  planSignedIn: async ({browser, l3Ahead}, use, info) => {
    const url = process.env.SELFTEST_PLAN_APP;
    if (!url) throw new Error('SELFTEST_PLAN_APP is not set: run the selftest with `npm run selftest` (global-setup.ts starts the Remote with the plan)');
    const o = await browserAt(browser, url, addressOf(info, 'Plan'), l3Ahead);
    await signInAt(o.app, url, personName(info));
    await use(o.app);
    await o.close();
  },
});

export {expect};
