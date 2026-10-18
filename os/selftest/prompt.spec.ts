import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The prompt box and the Prompt (the repo's sh) behind it. Tab completes a
// path from the repo's tree as the store has it, so it needs no Prompt. The
// rest runs BusyBox sh and l3 through the WebAssembly translator: slow (it
// fetches l3 and translates as it runs), so tagged @slow and run with
// SELFTEST_SLOW=1, as CI does. Those need the Prompt's files in public/
// (`npm run userland`, or `node scripts/prompt-files.mjs` from the release),
// which the build then carries.

const PROMPT = join(OS, 'public', 'userland', 'l3.json');

test.beforeEach(async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.newRepo.openInForge();
});

test('Tab completes a path in the repo, and says the choices when there are several', async ({app}) => {
  const box = app.forge.promptBox;
  await box.fill('cat sr');
  await box.press('Tab');
  await expect(box).toHaveValue('cat src/');
  await box.press('Tab');
  await expect(box).toHaveValue('cat src/main.c ');
  await expect(box).toBeFocused();

  await box.fill('ls ./');
  await box.press('Tab');
  await expect(box).toHaveValue('ls ./');
  await expect(app.forge.promptSays('Makefile')).toContainText('src/');
  // Anything else written there and the choices go.
  await box.press('d');
  await expect(app.forge.promptSays('Makefile')).toHaveCount(0);

  // With no path before the caret, Tab moves on as everywhere.
  await box.fill('');
  await box.press('Tab');
  await expect(box).not.toBeFocused();
});

test.describe('the Prompt running', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  test.beforeEach(async ({app}) => {
    // Asked for, it is run: without the Prompt's files that is a failure, not a skip.
    expect(existsSync(PROMPT), 'this build carries no Prompt (public/userland): npm run userland, or node scripts/prompt-files.mjs').toBe(true);
    test.setTimeout(300_000);
    await app.forge.startPrompt('hello');
  });

  test('ls lists the repo\'s files, and Output keeps the run to be put back in the box', async ({app}) => {
    await app.forge.run('ls');
    await expect(app.forge.prompt).toContainText('Makefile');
    await expect(app.forge.prompt).toContainText('README.md');

    await app.forge.show('Output');
    await expect(app.forge.reference).toContainText(/\d+ ms/);
    await app.forge.ran('ls').click();
    await expect(app.forge.promptBox).toHaveValue('ls');
    await expect(app.forge.promptBox).toBeFocused();
  });

  test('↑ and ↓ walk the lines run before, and come back to what was being written', async ({app}) => {
    await app.forge.run('echo one');
    await expect(app.forge.prompt).toContainText(/^one$/m);
    await app.forge.run('echo two');
    await expect(app.forge.prompt).toContainText(/^two$/m);

    const box = app.forge.promptBox;
    await box.fill('ec');
    await box.press('ArrowUp');
    await expect(box).toHaveValue('echo two');
    await box.press('ArrowUp');
    await expect(box).toHaveValue('echo one');
    await box.press('ArrowDown');
    await expect(box).toHaveValue('echo two');
    await box.press('ArrowDown');
    await expect(box).toHaveValue('ec');
  });

  test('a run that takes a while says how long it has run, until it is done', async ({app}) => {
    await app.forge.run('sleep 4; echo slept');
    await expect(app.forge.prompt.getByText(/^Running [2-9]s/)).toBeVisible({timeout: 30_000});
    await expect(app.forge.prompt).toContainText(/^slept$/m, {timeout: 60_000});
    await expect(app.forge.prompt.getByText(/^Running /)).toHaveCount(0);
  });

  test('a dotfile saved while the Prompt runs says it gets it when it starts again', async ({app}) => {
    await app.forge.run('true');
    await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
    const note = app.runtime.dotfiles.getByRole('status');
    await expect(note).toContainText('The Prompt in hello gets it when it starts again');
    await note.getByRole('button', {name: 'Start again'}).click();
    await expect(note).toBeHidden();
  });
});
