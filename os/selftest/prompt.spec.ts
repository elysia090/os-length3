import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The prompt box and the Prompt (the repo's sh) behind it. Tab completes a
// path from the repo's tree as the store has it, so it needs no Prompt. The
// rest runs the root's BusyBox sh and l3 through the WebAssembly translator:
// slow (it fetches l3 and translates as it runs), so tagged @slow and run
// with SELFTEST_SLOW=1, as CI does. Those need l3 in public/l3 (`npm run l3`,
// or `node scripts/prompt-files.mjs` from the release), which the build then
// carries.

const PROMPT = join(OS, 'public', 'l3', 'l3.json');

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
    expect(existsSync(PROMPT), 'this build carries no l3 (public/l3): npm run l3, or node scripts/prompt-files.mjs').toBe(true);
    test.setTimeout(300_000);
    await app.forge.startPrompt('hello');
  });

  test('ls lists the repo\'s files, and Output keeps the run to be put back in the box', async ({app}) => {
    await app.forge.run('ls');
    await expect(app.forge.prompt).toContainText('Makefile');
    await expect(app.forge.prompt).toContainText('README.md');

    await app.forge.show('Output');
    await expect(app.forge.reference).toContainText(/\d+ ms/);
    await app.forge.readRun('ls');
    await app.forge.ran('ls').click();
    await expect(app.forge.promptBox).toHaveValue('ls');
    await expect(app.forge.promptBox).toBeFocused();
  });

  test('up, the box is the terminal\'s line: it starts with the prompt line the shell waits at, said once', async ({app}) => {
    const waits = app.main.locator('.screen .prompt-ps');
    await expect(waits).toHaveText('hello $');
    // The output's own last line, the same words, is not shown then.
    await expect(app.forge.prompt.locator('.term-out > .ps.waits')).toBeHidden();
    await app.forge.run('ls');
    // The line run is a prompt line among the output (in the green), and the box's line waits at the next.
    await expect(app.forge.prompt.locator('.term-out > .ps:not(.waits)').first()).toHaveText('hello $ ');
    await expect(waits).toHaveText('hello $');
    // Put back, the box is the plain box again: no prompt line, its words in the body's letters.
    await app.forge.promptBox.press('Escape');
    await expect(waits).toBeHidden();
    await expect(app.forge.promptBox).toHaveCSS('font-family', /system-ui/);
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

  test('stopped from Runtime, its repo no longer says a Prompt has it, without leaving the page', async ({app}) => {
    await app.forge.run('true');
    await app.runtime.open('This browser');
    const here = app.main.getByRole('region', {name: /^In this browser/});
    await expect(here).toContainText('A Prompt has it open');
    await app.runtime.part('Prompts running').click();
    await app.main.getByRole('tabpanel', {name: /^Prompts running/}).getByRole('button', {name: 'Stop', exact: true}).click();
    await app.runtime.part('This browser').click();
    await expect(here).not.toContainText('A Prompt has it open');
    // What holds it now, said whole (signed out, there is no Remote to free it to).
    await expect(here).toContainText('Sign in to the Remote to free it');
  });

  test('what the Prompt showed is still there after Git and back, and after Home and back', async ({app}) => {
    await app.forge.run('echo kept-here');
    await expect(app.forge.prompt).toContainText(/^kept-here$/m);
    for (const place of ['git', 'home'] as const) {
      await app.rail.go(place);
      await app.rail.go('forge');
      await expect(app.forge.prompt).toContainText(/^kept-here$/m);
    }
  });

  test('a Prompt stopped says so at its bottom right, with its power switch off beside it, under its output', async ({app}) => {
    await app.forge.run('echo before-stop');
    await expect(app.forge.prompt).toContainText(/^before-stop$/m);
    await app.runtime.open('Prompts running');
    await app.main.getByRole('tabpanel', {name: /^Prompts running/}).getByRole('button', {name: 'Stop', exact: true}).click();
    await app.rail.go('forge');
    const again = app.forge.prompt.getByRole('switch', {name: 'Start again'});
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute('aria-checked', 'false');
    // No taller than the line it is on.
    expect((await again.boundingBox())!.height).toBeLessThanOrEqual(32);
    const out = (await app.forge.prompt.getByText('before-stop').last().boundingBox())!;
    const at = (await again.boundingBox())!;
    const box = (await app.forge.prompt.boundingBox())!;
    expect(at.y).toBeGreaterThan(out.y);
    expect(box.x + box.width - (at.x + at.width)).toBeLessThan(40);
    await expect(app.forge.prompt.getByText('Stopped')).toBeVisible();
    await again.click();
    await expect(app.forge.prompt).toContainText(/hello \$/);
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

test('Enter is a new line in the prompt box, so confirming a conversion never runs it; Ctrl+Enter runs', async ({app}) => {
  const box = app.forge.promptBox;
  await box.fill('echo one');
  await box.press('Enter');
  await expect(box).toHaveValue('echo one\n');
  await box.fill('echo entered');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(app.forge.prompt).toContainText(/^entered$/m);
});
