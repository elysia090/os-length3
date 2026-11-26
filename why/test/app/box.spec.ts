import {expect, test} from './fixtures.ts';


// The Prompt's input does more than run: its pill says what it does, with the rest under Alt+Down.
// Neither writing an issue nor adding a TODO needs a running shell.

// Each test opens the app on 'hello', made from C's files once for the worker and kept (fixtures.ts, helloC).
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
  const readme = app.forge.editor('README.md');
  await readme.focus();
  await expect(readme).toBeFocused();
  await expect(app.forge.prompt).toBeHidden();
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
});

test('the box\'s pill chooses what the box does: an issue written there is the repo\'s next, a line for TODO is on Home', async ({app}) => {
  const box = app.forge.promptBox, said = app.main.locator('.box-said');
  const pill = app.main.getByRole('button', {name: /^Input box action/});
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  // Pressed, it is the other of the two things the line does all day: TODO, the keyboard in the line; again, Run.
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
  // Writing an issue leaves the keyboard in the same Prompt.
  await box.fill('Feat: A trellis for the tomatoes\nSix feet, of bamboo.');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(said).toHaveText('Created as #1 in hello');
  await expect(box).toBeFocused();
  await expect(pill).toHaveText('hello #2', {useInnerText: true});
  // Files in this repo still lists documents, not the issue written in Prompt.
  await app.forge.use('Files');
  const files = app.page.getByRole('navigation', {name: 'Files in hello', exact: true}).getByRole('tree', {name: 'hello', exact: true});
  await expect(files.getByRole('treeitem', {name: 'README.md', exact: true})).toBeVisible();
  await expect(files.getByRole('treeitem', {name: /^(issue|#1)$/})).toHaveCount(0);
  await app.forge.use('Prompt');
  await expect(box).toBeFocused();
  // Alt+3 from the box: TODO, at once.
  await box.press('Alt+3');
  await expect(pill).toHaveAccessibleName('Input box action: Add');
  await box.fill('Water the basil at eleven');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Added to TODO');
  // The shortcut puts away the focused Prompt. Called back, it focuses the line in Run again.
  await box.press('Control+Backquote');
  await expect(app.forge.prompt).toBeHidden();
  await app.page.keyboard.press('Control+Backquote');
  await expect(box).toBeFocused();
  await expect(pill).toHaveAccessibleName('Input box action: Run');
  await app.rail.go('git');
  await expect(app.git.issue('#1 Feat：A trellis for the tomatoes')).toBeVisible();
  await expect(app.main.getByRole('textbox', {name: 'Summary', exact: true})).toHaveValue('Six feet, of bamboo.');
  await app.rail.go('home');
  await expect(app.home.title(app.home.items.first())).toHaveValue('Water the basil at eleven');
  await expect(app.home.todo).toContainText('1 of 1 remaining');
});

test('the Prompt keeps each issue and TODO line when put away; Git and Home show what was written', async ({app}) => {
  const box = app.forge.promptBox, said = app.main.locator('.box-said');
  await box.press('Alt+2');
  await box.fill('Fix: The table wraps on a phone');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Created as #1 in hello');
  await box.press('Alt+3');
  await box.fill('Water the mint');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Added to TODO');

  const out = app.forge.prompt.locator('.term-out');
  const written = /#1 Fix：The table wraps on a phone\s+TODO Water the mint/;
  await expect(out).toHaveText(written);
  await box.press('Escape');
  await expect(app.forge.prompt).toBeHidden();
  await expect(app.forge.editor('README.md')).toBeFocused();
  await app.forge.use('Prompt');
  await expect(out).toBeVisible();
  await expect(out).toHaveText(written);
  // Neither note ran a shell command; the shell never reached its live state.
  await expect(app.main.getByRole('button', {name: 'Input box action: Run'})).toHaveAttribute('data-state', 'starting');

  await app.rail.go('git');
  await expect(app.git.issue('#1 Fix：The table wraps on a phone')).toBeVisible();
  await app.rail.go('home');
  await expect(app.home.title(app.home.items.first())).toHaveValue('Water the mint');
  await expect(app.home.todo).toContainText('1 of 1 remaining');
});
