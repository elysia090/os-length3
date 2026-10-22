import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title),
// and the one scaffold, its files named in the box (nothing to choose); made,
// the page stays and offers Forge. A name taken is said under the name, with
// the keyboard back on it. What is written stays while other pages are seen.

test('a repo made from the scaffold has its files, and its summary under the README title', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {summary: 'Says hello in C.'});
  await expect(app.main.getByText('Made at /root/hello in File')).toBeVisible();

  await app.main.getByRole('button', {name: 'Open in Forge'}).click();
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nSays hello in C.\n');
  await expect(app.forge.editor('src/main.c')).toHaveValue(/puts\("hello"\)/);
  // What it builds is under build/, so no repo name meets a path of its own (a repo named src builds too).
  await expect(app.forge.editor('Makefile')).toHaveValue('build/hello: src/main.c\n\tmkdir -p build\n\tcc -O2 -o $@ src/main.c\n');
});

test('a file named in the box is made under that name; what names it follows, and what it says does not change', async ({app}) => {
  await app.rail.go('new-repo');
  // There is nothing to choose: the scaffold is shown, its files' names in place.
  await expect(app.main.getByRole('radiogroup')).toHaveCount(0);
  await expect(app.newRepo.fileName('src/main.c')).toHaveValue('main.c');

  await app.newRepo.make('tide', {summary: 'Tide tables.', files: {'src/main.c': 'main.rs', 'README.md': 'README.txt'}});
  await app.main.getByRole('button', {name: 'Open in Forge'}).click();
  await expect(app.forge.editor('README.txt')).toHaveValue('# tide\n\nTide tables.\n');
  await expect(app.forge.editor('README.md')).toHaveCount(0);
  // The extension is the name's: the words stay C, and the Makefile names the file where it now is.
  await expect(app.forge.editor('src/main.rs')).toHaveValue(/puts\("hello"\)/);
  await expect(app.forge.editor('src/main.c')).toHaveCount(0);
  await expect(app.forge.editor('Makefile')).toHaveValue(/build\/tide: src\/main\.rs\n.*\n\tcc -O2 -o \$@ src\/main\.rs\n/);
});

test('a file name that cannot be is said before Create, and Create takes the keyboard there', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('clash');
  await app.newRepo.fileName('Makefile').fill('README.md');
  await expect(app.main.getByRole('alert')).toHaveText('README.md is there already');
  await app.newRepo.create.click();
  await expect(app.newRepo.fileName('Makefile')).toBeFocused();
  await expect(app.newRepo.made).toHaveCount(0);
  // Put right in place, it goes.
  await app.newRepo.fileName('Makefile').fill('GNUmakefile');
  await expect(app.main.getByRole('alert')).toBeHidden();
  await app.newRepo.create.click();
  await expect(app.newRepo.made).toHaveText('Made clash');
});

test('what is written before Create stays while another page is seen, and goes once made', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('harbour');
  await app.newRepo.summary.fill('Tide tables for the harbour.');
  await app.newRepo.fileName('src/main.c').fill('tides.c');

  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('harbour');
  await expect(app.newRepo.summary).toHaveValue('Tide tables for the harbour.');
  await expect(app.newRepo.fileName('src/main.c')).toHaveValue('tides.c');

  await app.newRepo.create.click();
  await expect(app.newRepo.made).toHaveText('Made harbour');
  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.fileName('src/main.c')).toHaveValue('main.c');
});

test('a name already taken is said under the name, and the name keeps the keyboard', async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.main.getByRole('button', {name: 'Make another'}).click();
  await expect(app.newRepo.name).toHaveValue('');

  await app.newRepo.fill('notes');
  await expect(app.newRepo.problem).toHaveText('There is a repo named notes already');
  await expect(app.newRepo.name).toBeFocused();
  await expect(app.newRepo.name).toHaveValue('notes');
  // Typing in it again clears what was said.
  await app.newRepo.name.pressSequentially('-2');
  await expect(app.newRepo.problem).toBeHidden();
});
