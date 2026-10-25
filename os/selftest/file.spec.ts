import {expect, test} from './fixtures.ts';

// File: the tree of "/" laid over the page. A file chosen in a repo is the
// one to work on: the tree goes, Forge shows it with the caret in it, and
// the tree marks it as where one is. Inside a repo each row has its deeds
// (New file, New folder, Rename, Delete), and what they do is the repo's,
// as Forge then shows it.

test.describe("on 'hello', made from C's files", () => {
  // Made once for the worker and kept (fixtures.ts, helloC), as making it is new-repo.spec.ts's to see (and its
  // files made from a row's menu, this file's own tests below); opened again here, and signed in.
  test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

  test('a file opened from the tree is the one Forge works on, and the tree marks it', async ({signedIn: app}) => {
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

  test('a file renamed and a file deleted from their rows change the repo', async ({signedIn: app}) => {
    await app.newRepo.openInForge();

    await app.file.named('hello', 'README.md', 'Rename', 'READ-ME.md');
    await expect(app.file.name('READ-ME.md')).toBeFocused();
    await expect(app.file.name('README.md')).toHaveCount(0);

    const menu = await app.file.deeds('hello', 'Makefile');
    await menu.getByRole('menuitem', {name: 'Delete'}).click();
    await expect(menu).toContainText('Makefile goes');
    await app.answer(menu.getByRole('button', {name: 'Delete', exact: true}), menu);
    await expect(app.file.name('Makefile')).toHaveCount(0);

    await app.file.close();
    await expect(app.forge.editor('READ-ME.md')).toBeVisible();
    await expect(app.forge.editor('Makefile')).toHaveCount(0);
  });
});

test('a new file made from a repo\'s row opens in Forge, ready to write', async ({signedIn: app}) => {
  await app.newRepo.make('hello');

  await app.file.named('hello', '', 'New file', 'notes.txt');

  await expect(app.file.tree).toBeHidden();
  await expect(app.forge.editor('notes.txt')).toBeFocused();
  await app.forge.editFile('notes.txt', 'Bring a tent.\n');
  await app.file.openTree();
  await expect(app.file.name('notes.txt')).toHaveAttribute('aria-current', 'location');
});

test('a new folder takes a file of its own, and Forge shows the file under it', async ({signedIn: app}) => {
  await app.newRepo.make('hello');

  await app.file.named('hello', '', 'New folder', 'plans');
  // Made, the folder is in the tree with the keyboard on it.
  await expect(app.file.name('plans')).toBeFocused();
  await app.file.named('hello', 'plans', 'New file', 'trip.md');

  await expect(app.forge.editor('plans/trip.md')).toBeFocused();
  await app.forge.editFile('plans/trip.md', '# Trip\n');
  await app.forge.show('diff');
  await expect(app.forge.reference.getByText('plans/trip.md', {exact: true})).toBeVisible();
});

test('a name taken is said in the menu, and the name keeps the keyboard', async ({signedIn: app}) => {
  await app.newRepo.make('hello');

  await app.file.named('hello', '', 'New file', 'README.md');

  const menu = app.page.getByRole('menu', {name: 'hello', exact: true});
  await expect(menu.getByRole('alert')).toHaveText('README.md is there already');
  await expect(menu.getByRole('textbox')).toBeFocused();
});

test('a name being written stays, with the keyboard, however long the pointer is away; Create makes it', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.page.clock.install();
  const menu = await app.file.deeds('hello');
  await menu.getByRole('menuitem', {name: 'New file'}).click();
  const field = menu.getByRole('textbox', {name: 'File name'});
  await field.pressSequentially('a-long-name-being-written');
  // The pointer goes far away for longer than the tree lingers.
  await app.page.mouse.move(1000, 700);
  await app.page.clock.runFor(9000);
  await expect(app.file.tree).toBeVisible();
  await expect(field).toHaveValue('a-long-name-being-written');
  await expect(field).toBeFocused();
  // Seen how to finish: Create (Enter does the same), with Not now beside it.
  await expect(menu.getByRole('button', {name: 'Not now'})).toBeVisible();
  await field.fill('kept.txt');
  await menu.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(app.forge.editor('kept.txt')).toBeFocused();
  await app.page.clock.resume();
});

test('New folder and Rename finish the same way, and Not now puts the row back as it was', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  let menu = await app.file.deeds('hello');
  await menu.getByRole('menuitem', {name: 'New folder'}).click();
  await menu.getByRole('textbox', {name: 'Folder name'}).fill('plans');
  await menu.getByRole('button', {name: 'Not now'}).click();
  await expect(menu.getByRole('menuitem', {name: 'New folder'})).toBeVisible();
  await expect(app.file.name('plans')).toHaveCount(0);
  await menu.getByRole('menuitem', {name: 'New folder'}).click();
  await menu.getByRole('textbox', {name: 'Folder name'}).fill('plans');
  await menu.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(app.file.name('plans')).toBeFocused();

  menu = await app.file.deeds('hello', 'plans');
  await menu.getByRole('menuitem', {name: 'Rename'}).click();
  await menu.getByRole('textbox', {name: 'New name'}).fill('trips');
  await menu.getByRole('button', {name: 'Rename', exact: true}).click();
  await expect(app.file.name('trips')).toBeFocused();
});

test('File pressed keeps out the tree its hover brought out, however late the press; pressed again it goes', async ({app}) => {
  const file = app.rail.button('file');
  await file.hover();
  await expect(app.file.tree).toBeVisible();
  await app.page.waitForTimeout(1200);
  await file.click();
  await expect(app.file.tree).toBeVisible();
  await file.click();
  await expect(app.file.tree).toBeHidden();
  await file.click();
  await expect(app.file.tree).toBeVisible();
});
