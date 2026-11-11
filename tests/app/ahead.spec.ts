import {existsSync} from 'node:fs';
import {basename, join} from 'node:path';
import {aheadFor} from '../../root3/app/prompt/ahead.ts';
import type {Index} from '../../root3/app/prompt/userland.ts';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// What a Prompt is likely to run next, translated by the browser while it waits for a line (root3/app/prompt/ahead.ts): the
// light programs of the root, what its shell runs itself as one moves first, then what anyone reaches for. Kept before
// they are asked for, they are not translated when they run. What building C runs is not among them, in a repo made
// from C's files ('hello') too: gcc's compiler proper (cc1, 40 MB of code) is the release's to translate. @slow, as the
// Prompt's other tests.

test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.describe('translated ahead', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');

  test('what is likely run next is translated while a Prompt waits, a C repo\'s compiler not', async ({app}) => {
    expect(existsSync(join(OS, 'public', 'webroot', 'webroot.json')), 'this build carries no root3 (public/webroot)').toBe(true);
    test.setTimeout(600_000);
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
    // The root this build carries, and where each program is in it (its pack and its place there): what its
    // translation is kept under.
    const index = await app.page.evaluate(async () => {
      const about = await (await fetch('/webroot/webroot.json')).json();
      return await (await fetch(`/webroot/${about.index.path}`)).json();
    }) as Index;
    const originOf = (path: RegExp) => {
      const f = index.files.find((x) => path.test(x.path));
      if (!f) throw new Error(`the root has no ${path}`);
      return `${index.packs[f.pack].name.replace(/\.pack$/, '')}_${f.at}_${f.len}`;
    };
    const ahead = aheadFor(index);
    expect(ahead.length, 'this root has none of the programs translated ahead').toBeGreaterThan(0);
    const keptOf = (origins: string[]) => app.page.evaluate(async (os) => {
      const urls = (await (await caches.open('webroot')).keys()).map((r) => r.url);
      return os.filter((o) => urls.some((u) => u.includes(`/webroot/tr/${o}-`)));
    }, origins);
    // Nothing is run: the Prompt only waits for its next line, and each is kept meanwhile, one after another.
    const origins = ahead.map((p) => originOf(new RegExp(`^${p}$`)));
    await expect.poll(async () => (await keptOf(origins)).length, {timeout: 420_000, intervals: [2000]}).toBe(origins.length);
    // All of them kept, the compiler is not: translated ahead in every Prompt on a repo with C, it held the Prompts
    // that started after it.
    expect(await keptOf([originOf(/\/cc1$/)])).toEqual([]);
    // The first of them run: read from what was kept.
    const started = Date.now();
    await app.forge.run(`${basename(ahead[0])} --version > /dev/null && echo ran-$((6 * 7))`);
    await expect(app.forge.prompt).toContainText(/^ran-42$/m, {timeout: 60_000});
    test.info().annotations.push({type: `${ahead[0]}, translated ahead, first run`, description: `${Date.now() - started} ms`});
  });
});
