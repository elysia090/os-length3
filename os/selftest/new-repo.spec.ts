import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title),
// and the one scaffold (a README, docs/ and issue/), its file named in the box (nothing to choose); made,
// it is gone into in Forge, the caret in its README. A name taken is said under the name, with
// the keyboard back on it. What is written stays while other pages are seen.

test('a repo made from the scaffold has its README, its summary under the title, and no language of its own', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {summary: 'Says hello.'});
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nSays hello.\n');
  await expect(app.forge.editor('README.md')).toBeFocused();
  // C's files are `l3 repo new -t c`'s, not every repo's.
  await expect(app.forge.editor('src/main.c')).toHaveCount(0);
  await expect(app.forge.editor('Makefile')).toHaveCount(0);
});

test('a file named in the box is made under that name, and what it says does not change', async ({app}) => {
  await app.rail.go('new-repo');
  // There is nothing to choose: the scaffold is shown, its file's name in place.
  await expect(app.main.getByRole('radiogroup')).toHaveCount(0);
  await expect(app.newRepo.fileName('README.md')).toHaveValue('README.md');

  await app.newRepo.make('tide', {summary: 'Tide tables.', files: {'README.md': 'README.txt'}});
  await expect(app.forge.editor('README.txt')).toHaveValue('# tide\n\nTide tables.\n');
  await expect(app.forge.editor('README.md')).toHaveCount(0);
});

test('a file name that cannot be is said before Create, and Create takes the keyboard there', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('clash');
  await app.newRepo.fileName('README.md').fill('docs/README.md');
  await expect(app.main.getByRole('alert')).toHaveText('A name has no “/” and does not start with “.”');
  await app.newRepo.create.click();
  await expect(app.newRepo.fileName('README.md')).toBeFocused();
  await expect(app.newRepo.made).toHaveCount(0);
  // Put right in place, it goes.
  await app.newRepo.fileName('README.md').fill('READ-ME.md');
  await expect(app.main.getByRole('alert')).toBeHidden();
  await app.newRepo.create.click();
  await expect(app.newRepo.madeIn('clash')).toBeVisible();
});

test('what is written before Create stays while another page is seen, and goes once made', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('harbour');
  await app.newRepo.summary.fill('Tide tables for the harbour.');
  await app.newRepo.fileName('README.md').fill('ABOUT.md');

  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('harbour');
  await expect(app.newRepo.summary).toHaveValue('Tide tables for the harbour.');
  await expect(app.newRepo.fileName('README.md')).toHaveValue('ABOUT.md');

  await app.newRepo.create.click();
  await expect(app.newRepo.madeIn('harbour')).toBeVisible();
  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.fileName('README.md')).toHaveValue('README.md');
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
