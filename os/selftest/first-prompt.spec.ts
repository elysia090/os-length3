import {writeFileSync} from 'node:fs';
import {expect, test} from './fixtures.ts';

// The first Prompt in a browser: what it fetches before its prompt line
// comes, and how long that takes, from a cold browser (nothing cached) and
// again after a reload (what it fetched before is the browser's). l3 is
// the whole root, but a Prompt reads only what its programs open, so the
// first prompt costs the index, the translator, sh's translation and the
// few files sh reads, not the root. @slow, as the Prompt's other tests.

const MB = 1e6;
/** What a cold first Prompt may fetch at most: the index, the translator, BusyBox and its translation, sh's files. */
const BUDGET = 4 * MB;

test.describe('the first Prompt', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  // l3 runs in a Prompt after the first, from what the first was given ahead of time (fixtures.ts, l3Ahead).
  test.use({l3Ahead: true});

  test('comes with a few megabytes, not the whole root, and sooner again once cached', async ({app}) => {
    test.setTimeout(300_000);
    // Made from New repo alone (no file written in Forge first), so opening it in Forge is the Prompt's first start.
    await app.newRepo.make('hello');
    let counting = false;
    const got: {url: string; bytes: number}[] = [];
    // Every response the page and its workers take while the Prompt starts (a worker's synchronous reads too).
    // What comes once its prompt line is there (l3's translation, a few seconds after, for the Prompts after it) is not the first Prompt's.
    app.page.context().on('requestfinished', async (r) => {
      if (!counting || !/\/(l3|userland|root)\//.test(r.url())) return;
      const s = await r.sizes().catch(() => null);
      if (s) got.push({url: new URL(r.url()).pathname, bytes: s.responseBodySize + s.responseHeadersSize});
    });
    // From opening the repo (Forge reads l3 ahead as it shows it) to the Prompt's first prompt line, once written to.
    const first = async (open: () => Promise<unknown>, reloads: boolean) => {
      got.length = 0;
      counting = true;
      const since = reloads ? 0 : await app.page.evaluate(() => performance.now());
      const started = Date.now();
      await open();
      await app.forge.startPrompt('hello');
      const ms = Date.now() - started;
      counting = false;
      // What the page itself fetched, as its own clock has it (bytes over the wire: none for what it had); the Worker's reads into the packs, as heard above.
      const page = await app.page.evaluate((t) => (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter((e) => e.startTime >= t && /\/(l3|userland|root)\//.test(e.name)).map((e) => ({url: new URL(e.name).pathname, bytes: e.transferSize})), since);
      const all = [...page, ...got.filter((g) => g.url.includes('/packs/'))];
      return {ms, bytes: all.reduce((n, g) => n + g.bytes, 0), requests: all.length, largest: [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 6)};
    };
    const cold = await first(() => app.newRepo.openInForge(), false);
    const warm = await first(async () => { await app.page.reload(); await app.forge.promptBox.waitFor(); }, true);
    // l3 itself in that Prompt: translated as it runs (its translation made ahead of time comes after the prompt line, for later Prompts).
    let started = Date.now();
    await app.forge.run('l3 --version');
    await expect(app.forge.prompt).toContainText(/^l3 \d+\.\d+\.\d+/m, {timeout: 120_000});
    const l3 = {ms: Date.now() - started};
    // A Prompt started after it in this page is given l3's translation: l3 runs again from it.
    await app.forge.run('exit');
    await app.forge.prompt.getByRole('switch', {name: 'Start again'}).click();
    await expect(app.forge.prompt).toContainText(/hello \$/, {timeout: 120_000});
    started = Date.now();
    await app.forge.run('l3 --version');
    await expect(app.forge.prompt).toContainText(/^l3 \d+\.\d+\.\d+/m, {timeout: 120_000});
    const l3Ready = {ms: Date.now() - started};
    const said = JSON.stringify({cold, warm, l3, l3Ready}, null, 2);
    console.log(`first Prompt: ${said}`);
    if (process.env.FIRST_PROMPT_OUT) writeFileSync(process.env.FIRST_PROMPT_OUT, said);
    expect(cold.bytes, said).toBeLessThan(BUDGET);
    expect(warm.bytes, said).toBeLessThan(cold.bytes);
  });
});
