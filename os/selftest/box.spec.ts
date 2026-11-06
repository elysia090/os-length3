import {expect, test} from './fixtures.ts';


// The box at the foot does more than run: its pill says what it does and, pressed, brings out what it can
// (box-modes.ts), Edit among them (edit-box.ts). None of it needs the Prompt running.

// Each test opens the app on 'hello', made from C's files once for the worker and kept (fixtures.ts, helloC).
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
});

test('the box\'s pill chooses what the box does: an issue written there is the repo\'s next, a line for TODO is on Home', async ({app}) => {
  const box = app.forge.promptBox, said = app.main.locator('.box-said');
  const pill = app.main.getByRole('button', {name: /^Input box action/});
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  // Pressed, it brings out the three; Issue chosen, the pill is the repo's next issue and the keyboard is in the box.
  // (On the desk the Prompt's box is gone to first, as a person goes to it: the box beside the file in hand.)
  await box.focus();
  await pill.click();
  await app.main.getByRole('menuitemradio', {name: /Create issue/}).click();
  await expect(pill).toHaveAccessibleName('Input box action: Create');
  await expect(pill).toHaveText('hello #1', {useInnerText: true});
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('placeholder', 'Create issue in hello');
  // Written in for an issue, it stays the box: only Run brings the Prompt up over the center.
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(0);
  await box.fill('Feat: A trellis for the tomatoes\nSix feet, of bamboo.');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(said).toHaveText('Created as #1 in hello');
  await expect(pill).toHaveText('hello #2', {useInnerText: true});
  // An issue is met as an issue (the pane, Git), never as a file: Forge shows no box for it, File no folder of them.
  await app.page.waitForTimeout(600);
  await expect(app.main.locator('section.file[data-path^="issue/"], section.dir[data-path="issue"]')).toHaveCount(0);
  const hello = await app.file.item('hello', '', {open: true});
  await expect(hello.getByRole('treeitem', {name: 'README.md', exact: true})).toBeVisible();
  await expect(hello.getByRole('treeitem', {name: /^(issue|#1)$/})).toHaveCount(0);
  await app.file.close();
  await box.focus();
  // Alt+3 from the box: TODO, at once.
  await box.press('Alt+3');
  await expect(pill).toHaveAccessibleName('Input box action: Add');
  await box.fill('Water the basil at eleven');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Added to TODO');
  // Ctrl+` is the Prompt's, so the box runs again.
  await app.page.keyboard.press('Control+Backquote');
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  await app.rail.go('git');
  await expect(app.git.issue('#1 Feat：A trellis for the tomatoes')).toBeVisible();
  await app.rail.go('home');
  await expect(app.home.title(app.home.items.first())).toHaveValue('Water the basil at eleven');
  await expect(app.home.todo).toContainText('1 of 1 remaining');
});

test('what the box writes comes into the Prompt\'s flow as it came, and pressed goes to where it is', async ({app}) => {
  const box = app.forge.promptBox;
  const flow = app.page.locator('.work.bench:not([hidden]) .term-out');
  await box.focus();
  await box.press('Alt+2');
  await box.fill('Fix: The table wraps on a phone');
  await box.press('Control+Enter');
  await box.press('Alt+3');
  await box.fill('Water the mint');
  await box.press('Control+Enter');
  await box.press('Escape');
  // Each a line of its own, in the order written, before the prompt line the shell waits at.
  const issue = flow.getByRole('button', {name: '#1 Fix：The table wraps on a phone'});
  const todo = flow.getByRole('button', {name: 'TODO Water the mint'});
  await expect(issue).toBeVisible();
  await expect(todo).toBeVisible();
  // In the order written; and an issue or a TODO is not a line written to the shell, so neither started it.
  await expect.poll(() => flow.evaluate((el) => el.textContent!.replace(/\u2063/g, '').trimEnd().split('\n').slice(-2)), {timeout: 60_000}).toEqual(
    ['#1 Fix：The table wraps on a phone', 'TODO Water the mint']);
  await expect(app.main.locator('.prompt-chip')).toHaveAttribute('data-state', 'starting');

  // Pressed, each goes to where it is: the TODO on Home, the issue in Git.
  await todo.click();
  await expect(app.home.todo).toContainText('1 of 1 remaining');
  await app.rail.go('forge');
  await issue.click();
  await expect(app.git.issue('#1 Fix：The table wraps on a phone')).toBeVisible();
});

