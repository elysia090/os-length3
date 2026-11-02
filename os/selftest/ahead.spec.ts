import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// What a repo is likely to run next, translated by the browser while its Prompt waits for a line (src/prompt/ahead.ts):
// here 'hello', made from C's files, whose first build runs gcc's compiler proper (cc1, the longest of the root's
// programs to translate). Kept before it is asked for, it is not translated when the build runs it. @slow, as the
// Prompt's other tests.

test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.describe('translated ahead', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');

  test('a C repo\'s compiler is translated while its Prompt waits, and its first build then runs it from there', async ({app}) => {
    expect(existsSync(join(OS, 'public', 'l3', 'l3.json')), 'this build carries no l3 (public/l3)').toBe(true);
    test.setTimeout(600_000);
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
    // Where cc1 is in the root (its pack and its place there): what its translation is kept under.
    const origin = await app.page.evaluate(async () => {
      const about = await (await fetch('/l3/l3.json')).json();
      const index = await (await fetch(`/l3/${about.index.path}`)).json();
      const f = index.files.find((x: {path: string}) => /\/cc1$/.test(x.path));
      return `${index.packs[f.pack].name.replace(/\.pack$/, '')}_${f.at}_${f.len}`;
    });
    // Nothing is run: the Prompt only waits for its next line, and cc1 is kept meanwhile.
    const kept = () => app.page.evaluate(async (o) => (await (await caches.open('l3')).keys()).some((r) => r.url.includes(`/l3/tr/${o}-`)), origin);
    await expect.poll(kept, {timeout: 420_000, intervals: [2000]}).toBe(true);
    // The first build: cc1 read from what was kept, not translated now.
    const started = Date.now();
    await app.forge.run('make && echo built-$((6 * 7))');
    await expect(app.forge.prompt).toContainText(/^built-42$/m, {timeout: 300_000});
    test.info().annotations.push({type: 'first build, cc1 translated ahead', description: `${Date.now() - started} ms`});
  });
});
