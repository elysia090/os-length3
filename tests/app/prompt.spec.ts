import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The prompt box and the Prompt (the repo's sh) behind it. Tab completes a
// path from the repo's tree as the store has it, so it needs no Prompt. The
// rest runs the root's BusyBox sh and root3 through the WebAssembly translator:
// slow (it fetches root3 and translates as it runs), so tagged @slow and run
// with SELFTEST_SLOW=1, as CI does. Those need root3 in public/webroot (`npm run webroot`,
// or `node scripts/prompt-files.ts` from the release), which the build then
// carries.

const PROMPT = join(OS, 'public', 'webroot', 'webroot.json');

// Each test opens the app on 'hello', made from C's files and left open in Forge: made once for the worker and kept
// (fixtures.ts, helloC), as making it is new-repo.spec.ts's and file.spec.ts's to see.
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
});

test('→ at the end completes a path in the repo, and says the choices when there are several', async ({app}) => {
  const box = app.forge.promptBox;
  await box.fill('cat sr');
  await box.press('ArrowRight');
  await expect(box).toHaveValue('cat src/');
  await box.press('ArrowRight');
  await expect(box).toHaveValue('cat src/main.c ');
  await expect(box).toBeFocused();

  await box.fill('ls ./');
  await box.press('ArrowRight');
  await expect(box).toHaveValue('ls ./');
  await expect(app.forge.promptSays('Makefile')).toContainText('src/');
  // Anything else written there and the choices go.
  await box.press('d');
  await expect(app.forge.promptSays('Makefile')).toHaveCount(0);

  // Tab is the desk's: the finger to the next box, the keyboard out of the line.
  await box.fill('');
  await box.press('Tab');
  await expect(box).not.toBeFocused();
});

test.describe('the Prompt running', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  test.beforeEach(async ({app}) => {
    // Asked for, it is run: without the Prompt's files that is a failure, not a skip.
    expect(existsSync(PROMPT), 'this build carries no root3 (public/webroot): npm run webroot, or node scripts/prompt-files.ts').toBe(true);
    test.setTimeout(300_000);
    await app.forge.startPrompt('hello');
  });

  test('Ctrl+D ends what reads the terminal (cat ends) and the shell reads on; Ctrl+C at the prompt line lets the line written go', async ({app}) => {
    const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out');
    const ps = app.forge.prompt.page().locator('.desk-term.stand .prompt-ps');
    await box.fill('cat');
    await box.press('Enter');
    await expect(ps).toHaveText('');
    await box.fill('abc');
    await box.press('Enter');
    await expect(out).toContainText(/abc\s+abc/);
    await box.press('Control+d');
    await expect(ps).toHaveText(/hello \$/);
    await box.fill('echo still');
    await box.press('Enter');
    await expect(out).toContainText(/^still$/m);
    // A line written and let go: said cut, the prompt line again, nothing run.
    await box.fill('echo never');
    await box.press('Control+c');
    await expect(box).toHaveValue('');
    await expect(out).toContainText('echo never^C');
    await expect(out).not.toContainText(/^never$/m);
  });

  test('the line\'s keys are a terminal\'s: Ctrl+A and Ctrl+E to its start and end, Ctrl+U and Ctrl+W cut back, Ctrl+L clears the screen', async ({app}) => {
    const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out');
    await box.fill('echo abc def');
    await box.press('Control+a');
    await box.press('X');
    await expect(box).toHaveValue('Xecho abc def');
    await box.press('Control+e');
    await box.press('Z');
    await expect(box).toHaveValue('Xecho abc defZ');
    await box.press('Control+w');
    await expect(box).toHaveValue('Xecho abc ');
    await box.press('Control+u');
    await expect(box).toHaveValue('');
    await app.forge.run('echo seen');
    await expect(out).toContainText(/^seen$/m);
    await box.press('Control+l');
    await expect(out).not.toContainText('seen');
    await expect(app.forge.prompt.page().locator('.desk-term.stand .prompt-ps')).toHaveText(/hello \$/);
  });

  test('Ctrl+Z stops what runs, a job the shell holds, and fg brings it back; a pipeline\'s group is put in front whole', async ({app}) => {
    const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out');
    const ps = app.forge.prompt.page().locator('.desk-term.stand .prompt-ps');
    await box.fill('sleep 30');
    await box.press('Enter');
    await expect(ps).toHaveText('');
    // Stopped once it is seen running (the line under the terminal says so), as a person would: pressed before the
    // shell has put it in front, ^Z is the shell's, which an interactive shell lets go by, as on any terminal.
    await expect(app.forge.prompt.locator('.term-activity')).toContainText(/Running|Waiting/, {timeout: 30_000});
    await box.press('Control+z');
    await expect(out).toContainText(/Stopped\s+sleep 30/);
    await expect(ps).toHaveText(/hello \$/);
    await app.forge.run('jobs');
    // jobs's own listing (^Z's line says Stopped too) and the prompt after it: fg typed sooner is echoed before them.
    await expect(out).toContainText(/jobs\n\[1\]\+\s+Stopped\s+sleep 30/);
    await expect(ps).toHaveText(/hello \$/);
    await box.fill('fg');
    await box.press('Enter');
    // Brought back: the shell says the job's line as it puts it in front again, and it runs on till cut.
    await expect(out).toContainText(/^sleep 30$/m);
    await expect(ps).toHaveText('');
    await box.press('Control+c');
    await expect(ps).toHaveText(/hello \$/);
    for (let i = 0; i < 3; i++) await app.forge.run('echo 日本語テスト | wc -m');
    await expect(out).toContainText(/^7$/m);
    await expect(out).not.toContainText('process group');
  });

  test('ECHO put out hides what is typed (read -s: a dot for each letter, nothing said, nothing kept); stty echo, reset and a program killed keep the line the box\'s', async ({app}) => {
    const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out'), page = app.forge.prompt.page();
    const ps = page.locator('.desk-term.stand .prompt-ps');
    await box.fill('read -s pw; echo "got ${#pw}"');
    await box.press('Enter');
    await expect(page.locator('form.prompt[data-hushed]')).toHaveCount(1);
    await box.fill('hunter2');
    await box.press('Enter');
    await expect(out).toContainText(/^got 7$/m);
    await expect(out).not.toContainText('hunter2');
    await expect(page.locator('form.prompt[data-hushed]')).toHaveCount(0);
    await expect(app.forge.pane).not.toContainText('hunter2');
    // Put back as a terminal's own are (stty echo, reset): the line stays the box's, no screen of its own.
    await app.forge.run('stty echo; reset; tty');
    await expect(out).toContainText(/^\/dev\/pts\/0$/m);
    await expect(ps).toHaveText(/hello \$/);
    await expect(page.locator('form.prompt[data-raw]')).toHaveCount(0);
    await app.forge.run('echo still');
    await expect(out).toContainText(/^still$/m);
    await expect(page.locator('.vt-screen')).toHaveCount(0);
    // A program killed while it read each key as it came: the shell's line is a line again, not a screen.
    await app.forge.run("sh -c 'stty -icanon -echo; kill -9 $$'");
    await expect(out).toContainText('Killed');
    await expect(ps).toHaveText(/hello \$/);
    await expect(page.locator('.vt-screen')).toHaveCount(0);
    await app.forge.run('echo whole');
    await expect(out).toContainText(/^whole$/m);
  });

  test('exit puts the terminal away as a terminal\'s window closes, its line left at the desk\'s foot; the band\'s >_ puts it up again with a new shell in it', async ({app}) => {
    const stand = app.forge.prompt.page().locator('.desk-term.stand');
    await app.forge.run('echo before');
    await expect(stand).toHaveClass(/\bup\b/);
    await app.forge.promptBox.fill('exit');
    await app.forge.promptBox.press('Enter');
    await expect(stand).not.toHaveClass(/\bup\b/);
    await expect(app.forge.promptBox).toBeVisible();
    await app.forge.tools.getByRole('button', {name: 'Terminal', exact: true}).click();
    await expect(stand).toHaveClass(/\bup\b/);
    await expect(app.forge.promptBox).toBeFocused();
    await app.forge.run('echo again');
    await expect(app.forge.prompt.locator('.term-out')).toContainText(/^again$/m);
    await expect(app.forge.prompt.locator('.term-out')).not.toContainText('before');
  });

  test('on the desk, a line running has no prompt line after it, as a terminal has none till it is done; the line written is moved up at once', async ({app}) => {
    const ps = app.forge.prompt.page().locator('.desk-term.stand .prompt-ps');
    await expect(ps).toHaveText(/hello \$/);
    await app.forge.promptBox.fill('sleep 1; echo done');
    await app.forge.promptBox.press('Enter');
    await expect(app.forge.prompt.locator('.term-out')).toContainText('sleep 1; echo done');
    await expect(ps).toHaveText('');
    await expect(app.forge.prompt.locator('.term-out')).toContainText('done', {timeout: 30_000});
    await expect(ps).toHaveText(/hello \$/);
  });

  test('ls lists the repo\'s files in columns, as on a terminal 80 wide, and Output keeps the run to be put back in the box', async ({app}) => {
    await app.forge.run('ls');
    await expect(app.forge.prompt).toContainText('Makefile');
    await expect(app.forge.prompt).toContainText('README.md');
    // Its output is a terminal's screen to it: the names side by side, not one under another.
    await expect(app.forge.prompt.locator('.term-out')).toContainText(/Makefile\s{2,}\S/);

    await app.forge.show('Output');
    await expect(app.forge.reference).toContainText(/\d+ ms/);
    await app.forge.readRun('ls');
    await app.forge.ran('ls').click();
    await expect(app.forge.promptBox).toHaveValue('ls');
    await expect(app.forge.promptBox).toBeFocused();
  });

  test('the box\'s line is the terminal\'s: it starts with the prompt line the shell waits at, said once, green as the shell\'s', async ({app}) => {
    const waits = app.main.locator('.desk-term.stand .prompt-chip');
    await expect(waits).toHaveText('hello $');
    // The output's own last line, the same words, is not shown then.
    await expect(app.forge.prompt.locator('.term-out > .ps.waits')).toBeHidden();
    await app.forge.run('ls');
    // The line run is a prompt line among the output (in the green), and the box's line waits at the next.
    await expect(app.forge.prompt.locator('.term-out > .ps:not(.waits)').first()).toHaveText('hello $ ');
    await expect(waits).toHaveText('hello $');
    // No pill: the prompt as a terminal shows it, in the green of the prompt lines above it.
    await expect(waits).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const green = await app.forge.prompt.locator('.term-out > .ps:not(.waits)').first().evaluate((e) => getComputedStyle(e).color);
    await expect(waits).toHaveCSS('color', green);
  });

  test('Run chosen again after another of the box\'s deeds, a line sent runs in the Prompt\'s box: what it prints is seen', async ({app}) => {
    // Another of the box's deeds, the keyboard staying in the box; Run is chosen back from there.
    const pill = app.main.locator('.desk-term.stand .prompt-chip');
    await app.forge.promptBox.press('Alt+3');
    await expect(pill).toHaveText(/TODO/);
    await app.forge.promptBox.press('Alt+1');
    await expect(pill).toHaveText('hello $');
    await expect(app.forge.promptBox).toBeFocused();
    await app.forge.promptBox.fill('echo seen');
    await app.forge.promptBox.press('Control+Enter');
    await expect(app.forge.prompt.locator('.term-out').getByText('seen', {exact: true})).toBeInViewport();
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
    await expect(app.forge.prompt.locator('.term-activity')).toContainText(/Running|Waiting/, {timeout: 30_000});
    await app.forge.promptBox.press('Control+c');
    await expect(out).toContainText('^C');
    await expect(app.main.locator('.desk-term.stand .prompt-chip')).toHaveText('hello $');
    // A flood cut: what it had on its way and not yet shown goes with it, as a terminal flushes its output on ^C, so
    // ^C stands at the foot, where the run was cut, not buried under a megabyte of y. (yes is sent at the prompt line,
    // as a person sends it once clear has come back.)
    await app.forge.run('clear');
    await expect(out).toHaveText(/^\s*hello \$\s*$/);
    await app.forge.promptBox.fill('yes');
    await app.forge.promptBox.press('Control+Enter');
    await expect(out).toContainText('y\ny\ny');
    await app.forge.promptBox.press('Control+c');
    await expect(app.main.locator('.desk-term.stand .prompt-chip')).toHaveText('hello $');
    await expect.poll(async () => (await out.textContent())?.slice(-14)).toMatch(/y\n\^C\nhello \$ ?$/);
  });

  test('several lines sent at once run as they would one after another, the shell waiting once after them all', async ({app}) => {
    const out = app.forge.prompt.locator('.term-out');
    await app.forge.promptBox.fill('x=42\necho "sum=$((x + 8))"\nfor i in 1 2; do\n  echo "it=$i"\ndone');
    await app.forge.promptBox.press('Control+Enter');
    await expect(out).toContainText('it=2');
    // What they print together, as they print it: no prompt line said for each line read, nor > for a line going on.
    const said = await out.innerText();
    expect(said).toMatch(/sum=50\s+it=1\s+it=2/);
    expect(said).not.toMatch(/hello \$ hello \$|^> /m);
    await expect(app.main.locator('.desk-term.stand .prompt-chip')).toHaveText('hello $');
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

  test('the pane tells the line run, not what it printed; pressed there, the line is lit in the Prompt\'s box', async ({app}) => {
    await app.forge.run('echo folded-away');
    const out = app.forge.prompt.locator('.term-out');
    await expect(out.getByText('folded-away', {exact: true})).toBeVisible();
    // In the pane: that it ran (its bar green, it ended well), not what it printed.
    await expect(app.forge.paneRun('echo folded-away')).toHaveAttribute('data-state', 'done');
    await expect(app.forge.pane.getByText('folded-away', {exact: true})).toHaveCount(0);
    // Pressed: its line lit where it was run, in view, the keyboard on the box's line again.
    await app.forge.paneRun('echo folded-away').click();
    const lit = out.locator('.cmd.lit');
    await expect(lit).toContainText('echo folded-away');
    await expect(lit).toBeInViewport();
    await expect(app.forge.promptBox).toBeFocused();
  });

  test('lines run follow one another in the Prompt\'s box, as a terminal\'s; the pane lists each, newest last, a failure in red', async ({app}) => {
    await app.forge.run('echo first-run');
    await app.forge.run('false');
    const out = app.forge.prompt.locator('.term-out');
    // The box keeps what ran before it, as a terminal does.
    await expect(out.getByText('first-run', {exact: true})).toBeVisible();
    const rows = app.forge.pane.locator('.pane-row.run');
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toHaveAttribute('data-state', 'failed');
    await expect(rows.last()).toContainText('exit 1');
    await expect(rows.first()).toHaveAttribute('data-state', 'done');
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

  test('a Prompt stopped says so as the last thing under its output, its power switch off leading the words', async ({app}) => {
    await app.forge.run('echo before-stop');
    await expect(app.forge.prompt).toContainText(/^before-stop$/m);
    await app.runtime.open('Running Prompts');
    await app.main.getByRole('tabpanel', {name: /^Running Prompts/}).getByRole('button', {name: 'Stop', exact: true}).click();
    await app.rail.go('forge');
    const again = app.forge.prompt.getByRole('switch', {name: 'Restart'});
    await expect(again).toBeVisible();
    await expect(again).toHaveAttribute('aria-checked', 'false');
    // No taller than the letters of the line it is on.
    expect((await again.boundingBox())!.height).toBeLessThanOrEqual(18);
    // Under the last line run (the pane tells the lines run, not what they printed).
    const out = (await app.forge.prompt.getByText('echo before-stop').boundingBox())!;
    const at = (await again.boundingBox())!;
    const said = (await app.forge.prompt.getByText('Stopped').boundingBox())!;
    expect(at.y).toBeGreaterThan(out.y);
    // On the words' line, where the prompt stood, just before them: not across the Prompt at its other edge.
    expect(Math.abs(at.y + at.height / 2 - (said.y + said.height / 2))).toBeLessThan(4);
    expect(at.x + at.width).toBeLessThanOrEqual(said.x);
    expect(said.x - (at.x + at.width)).toBeLessThan(24);
    expect(at.x).toBeLessThan(out.x);
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

test('on the desk Enter runs the Prompt\'s line, as a terminal\'s does, Shift+Enter is a new line, and confirming a conversion never runs it', async ({app}) => {
  // Once the Prompt is up (before, a line sent waits for its first prompt line).
  await app.forge.startPrompt('hello');
  const box = app.forge.promptBox;
  await box.fill('echo one');
  await box.press('Shift+Enter');
  await expect(box).toHaveValue('echo one\n');
  // An Enter that confirms what an input method composes is the composing's, not a run.
  await box.fill('echo composing');
  await box.evaluate((el: HTMLTextAreaElement) => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true, cancelable: true})));
  await expect(box).toHaveValue('echo composing');
  await box.fill('echo entered');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(app.forge.prompt).toContainText(/^entered$/m);
});

test('the Prompt is a real terminal: colours as programs give them, a line rewritten in place, and vi has every key', async ({app}) => {
  test.setTimeout(240_000);
  const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out');
  await box.fill(`printf '\\033[1;31mred\\033[0m plain\\n'; for i in 1 2 3; do printf '\\rstep %s' $i; done; echo`);
  await box.press('Enter');
  await expect(out).toContainText('step 3', {timeout: 120_000});
  // Red, bold, as the page's own red; the counter counted in place, one line.
  await expect(out.locator('span', {hasText: /^red$/})).toHaveCSS('font-weight', '600');
  expect(await out.innerText()).not.toMatch(/step 1|step 2/);
  // vi on the whole screen: keys are its, Tab and Escape too (not the desk's), and what it writes is the file.
  await box.fill('vi README.md');
  await box.press('Enter');
  await expect(app.page.locator('.vt-screen')).toBeVisible({timeout: 120_000});
  await expect(app.page.locator('.vt-screen')).toContainText('README.md');
  await app.page.keyboard.press('G');
  await app.page.keyboard.press('o');
  await app.page.keyboard.press('Tab');
  await app.page.keyboard.type('Written in vi.');
  await app.page.keyboard.press('Escape');
  // (A beat after it, as a hand gives: Escape and : at once read as one key, Alt and :, as at any terminal.)
  await app.page.waitForTimeout(300);
  await app.page.keyboard.type(':wq');
  await app.page.keyboard.press('Enter');
  await expect(app.page.locator('.vt-screen')).toHaveCount(0, {timeout: 60_000});
  await expect(app.forge.editor('README.md')).toHaveValue(/\n\tWritten in vi\.\n?$/, {timeout: 60_000});
  // Given back, the line one types at is the box's again.
  await expect(app.page.locator('form.prompt[data-raw]')).toHaveCount(0);
  await box.fill('echo after');
  await box.press('Enter');
  await expect(out).toContainText(/^after$/m);
});

test('what draws on a screen runs on it: a pager, an editor, top and htop, a picker; watch draws in place; each gives the line back', async ({app}) => {
  test.setTimeout(600_000);
  const box = app.forge.promptBox, out = app.forge.prompt.locator('.term-out'), screen = app.page.locator('.vt-screen');
  const p = app.page;
  // Each one's screen comes up saying what it shows, takes its keys, and goes; the box is the line one types at again.
  const runs: [string, string, () => Promise<void>][] = [
    ['less README.md', 'README', () => p.keyboard.press('q')],
    ['top', 'PID', () => p.keyboard.press('q')],
    ['htop', 'Load', () => p.keyboard.press('q')],
    ['nano notes.txt', 'GNU nano', async () => {
      await p.keyboard.type('From nano.');
      await p.keyboard.press('Control+X');
      await expect(screen).toContainText('Save modified buffer');
      await p.keyboard.press('y');
      await expect(screen).toContainText('Write to File');
      await p.keyboard.press('Enter');
    }],
    ["printf 'alpha\\nbeta\\ngamma\\n' | fzf", 'gamma', async () => {
      await p.keyboard.type('bet');
      await expect(screen).toContainText('1/3');
      await p.keyboard.press('Enter');
    }],
  ];
  for (const [line, shows, leave] of runs) {
    await box.fill(line);
    await box.press('Enter');
    await expect(screen).toBeVisible({timeout: 150_000});
    await expect(screen).toContainText(shows, {timeout: 60_000});
    await leave();
    await expect(screen, line).toHaveCount(0, {timeout: 60_000});
    await expect(p.locator('form.prompt[data-raw]')).toHaveCount(0);
    // The shell's prompt line again before the next is typed, as a person waits for it (typed sooner, a line is typed
    // ahead, echoed before the prompt as a terminal echoes it).
    await expect(app.forge.prompt).toContainText(/hello \$\s*$/, {timeout: 30_000});
  }
  // What fzf was given back to the shell, and what nano wrote, are where they belong.
  await expect(out).toContainText(/^beta$/m);
  await box.fill('cat notes.txt');
  await box.press('Enter');
  await expect(out).toContainText(/^From nano\.$/m, {timeout: 60_000});
  await expect(app.forge.prompt).toContainText(/hello \$\s*$/, {timeout: 30_000});
  // watch draws in place on the Prompt's own lines, again each second, until Ctrl+C.
  await box.fill('watch -n 1 date +%s');
  await box.press('Enter');
  await expect(out).toContainText('Every 1.0s', {timeout: 120_000});
  const first = (await out.innerText()).match(/^\d{10}$/m)?.[0];
  await expect.poll(async () => (await out.innerText()).match(/^\d{10}$/m)?.[0], {timeout: 30_000}).not.toBe(first);
  // (Caps Lock on: the key comes as C, and is still Ctrl+C to what runs.)
  await box.dispatchEvent('keydown', {key: 'C', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true});
  await expect(app.forge.prompt).toContainText(/\^C\nhello \$\s*$/, {timeout: 15_000});
  await box.fill('echo after watch');
  await box.press('Enter');
  await expect(out).toContainText(/^after watch$/m, {timeout: 60_000});
});
