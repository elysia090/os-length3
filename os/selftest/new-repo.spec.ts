import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title), a
// template; made, the page stays and offers Forge. A name taken is said
// under the name, with the keyboard back on it.

test('a repo made from a template has its files, and its summary under the README title', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C', summary: 'Says hello in C.'});
  await expect(app.main.getByText('Made at /root/hello in File')).toBeVisible();

  await app.main.getByRole('button', {name: 'Open in Forge'}).click();
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nSays hello in C.\n');
  await expect(app.forge.editor('src/main.c')).toHaveValue(/puts\("hello"\)/);
  await expect(app.forge.editor('Makefile')).toBeVisible();
});

test('a name already taken is said under the name, and the name keeps the keyboard', async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.main.getByRole('button', {name: 'Make another'}).click();

  await app.newRepo.fill('notes');
  await expect(app.newRepo.problem).toHaveText('There is a repo named notes already');
  await expect(app.newRepo.name).toBeFocused();
  await expect(app.newRepo.name).toHaveValue('notes');
  // Typing in it again clears what was said.
  await app.newRepo.name.pressSequentially('-2');
  await expect(app.newRepo.problem).toBeHidden();
});
