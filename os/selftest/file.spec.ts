import {expect, test} from './fixtures.ts';

// File: the tree of "/" laid over the page. A file chosen in a repo is the
// one to work on: the tree goes, Forge shows it with the caret in it, and
// the tree marks it as where one is.

test('a file opened from the tree is the one Forge works on, and the tree marks it', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('home');

  await app.file.open('hello', 'src/main.c');

  await expect(app.file.tree).toBeHidden();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.forge.editor('src/main.c')).toBeFocused();

  await app.file.openTree();
  await expect(app.file.name('main.c')).toHaveAttribute('aria-current', 'location');
  await expect(app.file.name('README.md')).not.toHaveAttribute('aria-current', 'location');
  await expect(app.file.name('hello')).toHaveAttribute('aria-current', 'page');
});
