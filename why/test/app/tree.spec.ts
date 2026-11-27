import {expect, test} from './fixtures.ts';

// File's tree: the person's repos on top, in /root; the rest of / (the kernel's, the distribution's) put away under
// System at its foot, shut until it is wanted, and kept open once it is.

test('File\'s tree has the repos on top and the rest of / under System, shut until opened', async ({app}) => {
  await app.newRepo.make('tide');
  await app.file.openTree();
  const top = app.file.tree.locator(':scope > li > .tree-row .tree-name');
  await expect(top).toHaveText(['root', 'System']);
  await expect(app.file.name('tide')).toBeVisible();
  await expect(app.file.name('etc')).toBeHidden();
  await app.file.tree.getByRole('button', {name: 'Open System'}).click();
  await expect(app.file.name('etc')).toBeVisible();
  // Out again later, it is as it was left.
  await app.page.keyboard.press('Escape');
  await expect(app.file.tree).toBeHidden();
  await app.file.openTree();
  await expect(app.file.name('etc')).toBeVisible();
});

test('→ on File brings the tree out with the keyboard on its first row', async ({app}) => {
  await app.newRepo.make('tide');
  // Creation opens Forge. Remote still shows the rail's own File key, including its directional shortcut.
  await app.rail.go('remote');
  const file = app.rail.button('file');
  // /root is structural; the first focusable row is the repo.
  const first = app.file.name('tide');
  await expect(file).toBeVisible();
  await file.focus();
  await expect(file).toBeFocused();
  await app.page.keyboard.press('ArrowRight');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(first).toBeFocused();

  // Back on File with the tree out, → goes into it again rather than toggling it shut.
  await file.focus();
  await expect(file).toBeFocused();
  await app.page.keyboard.press('ArrowRight');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(first).toBeFocused();
});
