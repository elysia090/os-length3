import {expect, test} from './fixtures.ts';

// The box at the foot does more than run: its pill says what it does and, pressed, brings out the three it can
// (box-modes.ts). None of it needs the Prompt running.

// Each test opens the app on 'hello', made from C's files once for the worker and kept (fixtures.ts, helloC).
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
});

test('the box\'s pill chooses what the box does: an issue written there is the repo\'s next, a line for TODO is on Home', async ({app}) => {
  const box = app.forge.promptBox, said = app.main.locator('.box-said');
  const pill = app.main.getByRole('button', {name: /^What the box does/});
  await expect(pill).toHaveAccessibleName('What the box does: Run');
  // Pressed, it brings out the three; Issue chosen, the pill is the repo's next issue and the keyboard is in the box.
  await pill.click();
  await app.main.getByRole('menuitemradio', {name: /Write an issue/}).click();
  await expect(pill).toHaveAccessibleName('What the box does: Create');
  await expect(pill).toHaveText('hello #1', {useInnerText: true});
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('placeholder', 'Write an issue in hello');
  // Written in for an issue, it stays the box: only Run brings the Prompt up over the center.
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(0);
  await box.fill('Feat: A trellis for the tomatoes\nSix feet, of bamboo.');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(said).toHaveText('Written as #1 in hello');
  await expect(pill).toHaveText('hello #2', {useInnerText: true});
  // Alt+3 from the box: TODO, at once.
  await box.press('Alt+3');
  await expect(pill).toHaveAccessibleName('What the box does: Add');
  await box.fill('Water the basil at eleven');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Added to TODO');
  // Ctrl+` is the Prompt's, so the box runs again.
  await app.page.keyboard.press('Control+Backquote');
  await expect(pill).toHaveAccessibleName('What the box does: Run');
  await app.rail.go('git');
  await expect(app.git.issue('#1 Feat：A trellis for the tomatoes')).toBeVisible();
  await app.rail.go('home');
  await expect(app.home.title(app.home.items.first())).toHaveValue('Water the basil at eleven');
  await expect(app.home.todo).toContainText('1 of 1 left');
});
