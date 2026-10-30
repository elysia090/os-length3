import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title),
// and the one scaffold (a README, docs/ and issue/), its file named in the box (nothing to choose); made,
// it is gone into in Forge, the caret in its README. A name taken is said under the name, with
// the keyboard back on it. What is written stays while other pages are seen.

test('with no repo at all, Forge and Git offer to make the first, and that is New repo', async ({app}) => {
  for (const place of ['forge', 'git'] as const) {
    await app.rail.go(place);
    const first = app.main.getByRole('button', {name: /^Create your first repo/});
    await expect(first).toBeVisible();
    await first.click();
    await expect(app.rail.button('new-repo')).toHaveAttribute('aria-current', 'page');
  }
});

test('a repo made from the scaffold has its README, its summary under the title, and no language of its own', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {summary: 'Says hello.'});
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nSays hello.\n');
  await expect(app.forge.editor('README.md')).toBeFocused();
  // C's files are `l3 repo new -t c`'s, not every repo's.
  await expect(app.forge.editor('src/main.c')).toHaveCount(0);
  await expect(app.forge.editor('Makefile')).toHaveCount(0);
});

test('what will be made is shown as File will show it: /root, the repos there, and the new one among them by its name', async ({app}) => {
  await app.newRepo.make('tide', {summary: 'Tide tables.'});
  await expect(app.forge.editor('README.md')).toHaveValue('# tide\n\nTide tables.\n');
  await app.rail.go('new-repo');
  // There is nothing to choose, and nothing to name in the box: its files are named in File.
  await expect(app.main.getByRole('radiogroup')).toHaveCount(0);
  await expect(app.main.locator('.tree-still input')).toHaveCount(0);
  const card = app.main.locator('.tree-still');
  await app.newRepo.name.fill('harbour');
  // The new one stands where its name puts it among those there (harbour before tide), its scaffold under it.
  await expect(card.locator('.tree-name')).toHaveText(['root', 'harbour', 'docs', 'issue', 'README.md', 'tide']);
  await app.newRepo.name.fill('wharf');
  await expect(card.locator('.tree-name')).toHaveText(['root', 'tide', 'wharf', 'docs', 'issue', 'README.md']);
  // Only the new one is the card's: /root and tide, there already, do not answer the pointer; wharf's rows do.
  const row = (name: string) => card.locator('.tree-row', {has: app.page.locator('.tree-name', {hasText: new RegExp(`^${name}$`)})});
  for (const there of ['root', 'tide']) await expect(row(there)).toHaveCSS('pointer-events', 'none');
  for (const ours of ['wharf', 'docs']) await expect(row(ours)).toHaveCSS('pointer-events', 'auto');
});

test('what is written before Create stays while another page is seen, and goes once made', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('harbour');
  await app.newRepo.summary.fill('Tide tables for the harbour.');

  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('harbour');
  await expect(app.newRepo.summary).toHaveValue('Tide tables for the harbour.');

  await app.newRepo.create.click();
  await expect(app.newRepo.madeIn('harbour')).toBeVisible();
  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.summary).toHaveValue('');
});

test('nothing named yet, the new row is a quiet place for the name, and Create asks for one first', async ({app}) => {
  await app.rail.go('new-repo');
  // The field holds no example to be taken for a name; the row it would be is dashed, saying what goes there.
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.name).not.toHaveAttribute('placeholder');
  const slot = app.main.locator('.tree-still .tree-new');
  await expect(slot).toHaveClass(/tree-unnamed/);
  await expect(slot.locator('.tree-name')).toHaveText('name');
  await expect(app.newRepo.problem).toBeHidden();
  await app.newRepo.create.click();
  await expect(app.newRepo.problem).toHaveText('Please enter a name first');
  await expect(app.newRepo.name).toBeFocused();
  // Written, it is the repo to be made, filled as File fills it.
  await app.newRepo.name.pressSequentially('tide');
  await expect(app.newRepo.problem).toBeHidden();
  await expect(slot).not.toHaveClass(/tree-unnamed/);
  await expect(slot.locator('.tree-name')).toHaveText('tide');
});

test('a name already taken is said under the name, and the name keeps the keyboard', async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');

  await app.newRepo.fill('notes');
  await expect(app.newRepo.problem).toHaveText('There is a repo named notes already');
  await expect(app.newRepo.name).toBeFocused();
  await expect(app.newRepo.name).toHaveValue('notes');
  // Typing in it again clears what was said.
  await app.newRepo.name.pressSequentially('-2');
  await expect(app.newRepo.problem).toBeHidden();
});
