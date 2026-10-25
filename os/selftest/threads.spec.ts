import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The page is cross-origin isolated (COOP and COEP, public/_headers and
// vite.config.ts), so it may share memory: the Prompt runs each guest
// thread in a Worker of its own, all at once, as Linux runs processes.
// What the Prompt then does is checked as Linux does it: a background job
// does not hold its shell, a trap runs, Ctrl-C reaches what runs in front,
// a job that computes without a system call is ended where it is.

const PROMPT = join(OS, 'public', 'l3', 'l3.json');

test('the page is cross-origin isolated, and what it loads from its own origin and the Remote still comes', async ({app}) => {
  await app.page.goto('/');
  const seen = await app.page.evaluate(async () => ({
    isolated: crossOriginIsolated,
    shared: typeof SharedArrayBuffer === 'function',
    about: (await fetch('/v1/about')).status,
  }));
  expect(seen).toEqual({isolated: true, shared: true, about: 200});
  const page = await app.page.request.get('/');
  expect(page.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  expect(page.headers()['cross-origin-opener-policy']).toBe('same-origin');
});

test.describe('the Prompt with its threads apart', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  // On 'hello', made from C's files once for the worker and kept (fixtures.ts, helloC), opened again in Forge.
  test.use({storageState: async ({helloC}, use) => { await use(helloC); }});
  test.beforeEach(async ({app}) => {
    expect(existsSync(PROMPT), 'this build carries no l3 (public/l3): npm run l3, or node scripts/prompt-files.mjs').toBe(true);
    test.setTimeout(300_000);
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
  });

  test('each thread runs in a Worker of its own', async ({app}) => {
    await expect(app.page.locator('.term[data-threads]')).toHaveAttribute('data-threads', 'apart');
  });

  test('a background job does not hold its shell: READY comes while it sleeps, DONE after', async ({app}) => {
    await app.forge.run('sleep 3 & echo READY; wait; echo DONE');
    await expect(app.forge.prompt).toContainText(/^READY$/m);
    await expect(app.forge.prompt).not.toContainText(/^DONE$/m);
    await expect(app.forge.prompt).toContainText(/^DONE$/m, {timeout: 30_000});
  });

  test('a trap runs its handler and the shell goes on; a pipe carries 65 MiB whole', async ({app}) => {
    await app.forge.run('trap "echo got USR1" USR1; kill -USR1 $$; echo after');
    await expect(app.forge.prompt).toContainText(/^got USR1\nafter$/m);
    await app.forge.run('dd if=/dev/zero bs=1M count=65 2>/dev/null | wc -c');
    await expect(app.forge.prompt).toContainText(/^68157440$/m, {timeout: 120_000});
  });

  test('Interrupt is SIGINT to what runs in front: a sleep, and a job that computes without a call', async ({app}) => {
    for (const [k, line] of ['sleep 60', '(while :; do :; done)'].entries()) {
      await app.forge.run(line);
      const cut = app.page.getByRole('button', {name: 'Interrupt', exact: true});
      await cut.click({timeout: 30_000});
      await expect(cut).toHaveCount(0, {timeout: 15_000});
      await app.forge.run(`echo "status $? after ${k}"`);
      await expect(app.forge.prompt).toContainText(new RegExp(`^status 130 after ${k}$`, 'm'));
    }
  });
});
