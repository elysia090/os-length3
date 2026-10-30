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

// Each test opens the app on 'hello', made from C's files and left open in Forge: made once for the worker and kept
// (fixtures.ts, helloC), as making it is new-repo.spec.ts's and file.spec.ts's to see.
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
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
    // Put back, the box is the box at rest again (no glass), and the prompt line it last waited at is in its pill.
    await app.forge.promptBox.press('Escape');
    await expect(app.main.locator('.screen > .glass')).toBeHidden();
    await expect(app.main.locator('.prompt-chip')).toHaveText('hello $');
    await expect(app.main.locator('.prompt-chip')).toHaveCSS('border-radius', /^(9999|999)px$/);
  });

  test('clear clears what the Prompt shows, and Ctrl+C on a run says ^C where it was cut, as a terminal does', async ({app}) => {
    const out = app.forge.prompt.locator('.term-out');
    await app.forge.run('ls');
    await expect(out).toContainText('Makefile');
    await app.forge.run('clear');
    await expect(out).not.toContainText('Makefile');
    await app.forge.promptBox.fill('sleep 5');
    await app.forge.promptBox.press('Control+Enter');
    await expect(app.forge.promptBox).toHaveValue('');
    await app.forge.promptBox.press('Control+c');
    await expect(out).toContainText('^C');
    await expect(app.main.locator('.screen .prompt-ps')).toHaveText('hello $');
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
    await expect(app.forge.prompt.getByText(/^Running \([2-9]s\)/)).toBeVisible({timeout: 30_000});
    await expect(app.forge.prompt).toContainText(/^slept$/m, {timeout: 60_000});
    await expect(app.forge.prompt.getByText(/^Running /)).toHaveCount(0);
  });

  test('stopped from Runtime, it goes from Running Prompts without leaving the page; what holds its repo is said as it is', async ({app}) => {
    await app.forge.run('true');
    await app.runtime.open('This browser');
    const here = app.main.getByRole('region', {name: /^In this browser/});
    // Signed out, there is no Remote to free it to, Prompt or none: that is what is said, not the Prompt.
    await expect(here).toContainText('Sign in to Remote to delete');
    await expect(here).not.toContainText('Locked by an active Prompt');
    await app.runtime.part('Running Prompts').click();
    await app.main.getByRole('tabpanel', {name: /^Running Prompts/}).getByRole('button', {name: 'Stop', exact: true}).click();
    await app.runtime.part('This browser').click();
    await expect(here).toContainText('Sign in to Remote to delete');
  });

  test('a repo whose Prompt waits is renamed from its gear, its Prompt stopped first as the field says', async ({app}) => {
    await app.forge.run('true');
    await app.rail.go('home');
    const card = app.main.getByRole('region', {name: 'Repos'}).getByRole('group', {name: 'hello', exact: true});
    await card.getByRole('button', {name: 'Actions for hello'}).click();
    const menu = card.getByRole('menu', {name: 'Actions for hello'});
    await menu.getByRole('menuitem', {name: 'Rename'}).click();
    await expect(menu).toContainText('Prompt is stopped; ready for maintenance.');
    await menu.getByRole('textbox', {name: 'New name'}).fill('hullo');
    await menu.getByRole('textbox', {name: 'New name'}).press('Enter');
    await expect(app.main.getByRole('region', {name: 'Repos'}).getByRole('group', {name: 'hullo', exact: true})).toBeVisible();
    await app.runtime.open('This browser');
    await expect(app.runtime.part('Running Prompts')).toHaveCount(0);
  });

  test('put back, the pane tells the line run; up again the Prompt starts at its line, what it printed folded under Earlier', async ({app}) => {
    await app.forge.run('echo folded-away');
    const said = (where: import('@playwright/test').Locator) => where.locator('.term-out').getByText('folded-away', {exact: true});
    await expect(said(app.forge.prompt)).toBeVisible();
    await app.page.keyboard.press('Escape');
    // In the pane: that it ran, not what it printed.
    const pane = app.main.locator('.term-home');
    await expect(pane.getByText('echo folded-away')).toBeVisible();
    await expect(said(pane)).toBeHidden();
    // Up again, it starts at its prompt line, what came before folded under one line that opens it.
    await app.forge.promptBox.focus();
    const earlier = app.forge.prompt.getByRole('button', {name: 'History (1)'});
    await expect(earlier).toBeVisible();
    await expect(said(app.forge.prompt)).toBeHidden();
    await earlier.click();
    await expect(said(app.forge.prompt)).toBeVisible();
    // Put back and the line pressed in the pane: up with what it printed, there.
    await app.forge.promptBox.focus();
    await app.page.keyboard.press('Escape');
    await pane.getByText('echo folded-away').click();
    await expect(said(app.forge.prompt)).toBeVisible();
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

  test('a Prompt stopped says so as the last thing under its output, with its power switch off beside the words', async ({app}) => {
    await app.forge.run('echo before-stop');
    await expect(app.forge.prompt).toContainText(/^before-stop$/m);
    await app.runtime.open('Running Prompts');
    await app.main.getByRole('tabpanel', {name: /^Running Prompts/}).getByRole('button', {name: 'Stop', exact: true}).click();
    await app.rail.go('forge');
    const again = app.forge.prompt.getByRole('switch', {name: 'Restart'});
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute('aria-checked', 'false');
    // No taller than the line it is on.
    expect((await again.boundingBox())!.height).toBeLessThanOrEqual(32);
    // Under the last line run (the pane tells the lines run, not what they printed).
    const out = (await app.forge.prompt.getByText('echo before-stop').boundingBox())!;
    const at = (await again.boundingBox())!;
    const said = (await app.forge.prompt.getByText('Stopped').boundingBox())!;
    expect(at.y).toBeGreaterThan(out.y);
    // On the words' line, just after them: not across the Prompt at its other edge.
    expect(Math.abs(at.y + at.height / 2 - (said.y + said.height / 2))).toBeLessThan(4);
    expect(at.x - (said.x + said.width)).toBeLessThan(24);
    await again.click();
    await expect(app.forge.prompt).toContainText(/hello \$/);
  });

  test('a dotfile saved while the Prompt runs says it gets it when it starts again', async ({app}) => {
    await app.forge.run('true');
    await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
    const note = app.runtime.dotfiles.getByRole('status');
    await expect(note).toContainText('Prompt in hello applies updates on restart');
    await note.getByRole('button', {name: 'Restart'}).click();
    await expect(note).toBeHidden();
  });
});

test.describe('the Prompt, started by writing to it', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');

  test('a repo shown starts no Prompt: none runs until the box is written in, and the line sent then waits for it', async ({app}) => {
    test.setTimeout(300_000);
    // Shown in Forge, read and gone from: nothing runs, and nothing holds the repo.
    await app.runtime.open('This browser');
    await expect(app.runtime.part('Running Prompts')).toHaveCount(0);
    await expect(app.main.getByRole('region', {name: /^In this browser/})).not.toContainText('Locked by an active Prompt');
    await app.rail.go('forge');
    await expect(app.main.locator('.prompt-chip')).toHaveAttribute('data-state', 'starting');
    // Written to, it starts; the line sent before its first prompt line runs once it is there.
    await app.forge.promptBox.fill('echo first');
    await app.forge.promptBox.press('Control+Enter');
    await expect(app.forge.promptBox).toHaveValue('');
    await expect(app.forge.prompt).toContainText(/^first$/m, {timeout: 240_000});
    await app.runtime.open('Running Prompts');
  });
});

test('Enter is a new line in the prompt box, so confirming a conversion never runs it; Ctrl+Enter runs', async ({app}) => {
  // Once the Prompt is up (before, a line sent waits for its first prompt line).
  await app.forge.startPrompt('hello');
  const box = app.forge.promptBox;
  await box.fill('echo one');
  await box.press('Enter');
  await expect(box).toHaveValue('echo one\n');
  await box.fill('echo entered');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(app.forge.prompt).toContainText(/^entered$/m);
});
