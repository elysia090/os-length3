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
  // Pressed, it is the other of the two things the line does all day: TODO, the keyboard in the line; again, Run.
  await box.focus();
  await pill.click();
  await expect(pill).toHaveAccessibleName('Input box action: Add');
  await expect(box).toBeFocused();
  await pill.click();
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  await expect(box).toBeFocused();
  // The rest come out of it at Alt+↓: Issue chosen, the pill is the repo's next issue and the keyboard is in the box.
  await box.press('Alt+ArrowDown');
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

test('what the box writes is said in the terminal it was written in, a line each as it came, and is a row of Git\'s pane; pressed there it goes to where it is', async ({app}) => {
  const box = app.forge.promptBox;
  await box.focus();
  await box.press('Alt+2');
  await box.fill('Fix: The table wraps on a phone');
  await box.press('Control+Enter');
  await box.press('Alt+3');
  await box.fill('Water the mint');
  await box.press('Control+Enter');
  await box.press('Escape');
  // In the terminal, in the order written: what each is (heavier), then its words. An issue or a TODO is not a line
  // written to the shell, so neither started it.
  const out = app.forge.prompt.locator('.term-out');
  await expect(out).toContainText(/#1 Fix：The table wraps on a phone\s+TODO Water the mint/);
  await expect(app.main.locator('.prompt-chip')).toHaveAttribute('data-state', 'starting');
  // In Git's pane, a row each among what was run, in the same order.
  await app.rail.go('git');
  const flow = app.git.pane;
  const issue = flow.getByRole('button', {name: '#1 Fix：The table wraps on a phone'});
  const todo = flow.getByRole('button', {name: 'TODO Water the mint'});
  await expect(issue).toBeVisible();
  await expect(todo).toBeVisible();
  await expect.poll(() => flow.locator('.pane-row').evaluateAll((rows) => rows.slice(-2).map((r) => r.getAttribute('aria-label'))), {timeout: 60_000}).toEqual(
    ['#1 Fix：The table wraps on a phone', 'TODO Water the mint']);

  // Pressed, each goes to where it is: the TODO on Home, the issue in Git.
  await todo.click();
  await expect(app.home.todo).toContainText('1 of 1 remaining');
  await app.rail.go('git');
  await issue.click();
  await expect(app.git.issue('#1 Fix：The table wraps on a phone')).toBeVisible();
});

