import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The Prompt in a browser: BusyBox sh and l3 running through the
// WebAssembly translator on the open repo. Slow (it fetches l3 and
// translates as it runs), so tagged @slow: CI runs it (SELFTEST_SLOW=1); a
// local run skips it unless asked. It needs the Prompt's files in public/
// (`npm run userland`, or `node scripts/prompt-files.mjs` from the release),
// which the build then carries.

const PROMPT = join(OS, 'public', 'userland', 'l3.json');

test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');

test('ls in a repo\'s Prompt lists the repo\'s files', {tag: '@slow'}, async ({app}) => {
  // Asked for, it is run: without the Prompt's files that is a failure, not a skip.
  expect(existsSync(PROMPT), 'this build carries no Prompt (public/userland): npm run userland, or node scripts/prompt-files.mjs').toBe(true);
  test.setTimeout(300_000);
  await app.newRepo.make('hello', {template: 'C'});
  await app.newRepo.openInForge();

  // Writing to the Prompt starts it; it is up once its prompt line shows (`hello $ `).
  await app.forge.promptBox.focus();
  await expect(app.forge.prompt).toContainText(/hello \$|Could not start/, {timeout: 240_000});
  await expect(app.forge.prompt).not.toContainText('Could not start');

  await app.forge.run('ls');
  await expect(app.forge.prompt).toContainText('Makefile');
  await expect(app.forge.prompt).toContainText('README.md');
  // The record of what was run, in the reference.
  await app.forge.show('Output');
  await expect(app.forge.reference).toContainText('ls');
});
