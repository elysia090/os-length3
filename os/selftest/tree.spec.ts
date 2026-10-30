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
  const file = app.rail.button('file');
  await file.focus();
  await app.page.keyboard.press('ArrowRight');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(app.file.tree.locator('.tree-name').first()).toBeFocused();
  // Back on File with the tree out, → goes into it again.
  await file.focus();
  await app.page.keyboard.press('ArrowRight');
  await expect(app.file.tree.locator('.tree-name').first()).toBeFocused();
});
