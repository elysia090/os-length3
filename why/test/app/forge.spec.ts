import {expect, test} from './fixtures.ts';

// Forge: each file a plain text editor that saves on its own, put back as it was at the last commit from its own
// menu; the search finds a line and opens the center there with the line selected.

// Each test opens the app on 'hello', made from C's files and left open in Forge (fixtures.ts, helloC: made once for
// the worker, as making it is new-repo.spec.ts's and file.spec.ts's to see), signed in: the repo goes to the Remote
// then, as one made before signing in does.
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({signedIn: app}) => {
  await app.newRepo.openInForge();
});

test('a file edited is saved, and its own menu offers to put it back as it was at the last commit', async ({signedIn: app}) => {
  expect(await app.file.revertable('hello', 'README.md'), 'as committed: nothing to put back').toBe(false);
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  // Gone from and come back to, it is as it was written.
  await app.rail.go('home');
  await app.rail.go('forge');
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nWritten in Forge.\n');
  expect(await app.file.revertable('hello', 'README.md'), 'changed: put back').toBe(true);
});

test('summoned search opens a found line by pointer or keyboard, washed and with the caret on it', async ({signedIn: app}) => {
  const editor = app.forge.editor('src/main.c');
  const row = () => app.forge.hit(/puts\("hello"\);/);
  const open = async (choose: () => Promise<void>) => {
    await expect(app.forge.search).toBeHidden();
    await app.forge.find('puts');
    // What was found is said a kind at a time, how many beside each: one file.
    await expect(app.forge.results.locator('.found-sec-head')).toHaveText([/^files\s*1$/]);
    await choose();
    await expect(editor).toBeFocused();
    await expect.poll(() => app.forge.lineChosen('src/main.c')).toBe('    puts("hello");');
    await expect(app.forge.search).toBeHidden();
  };
  await open(() => row().click());
  await open(async () => {
    await app.forge.search.press('ArrowDown');
    await expect(row()).toBeFocused();
    await row().press('Enter');
  });
});

test('a file put back from its own menu is as it was at the last commit, and its menu offers it no more', async ({signedIn: app}) => {
  await app.rail.go('forge');
  const was = await app.forge.editor('README.md').inputValue();
  await app.forge.editFile('README.md', '# hello\n\nNot wanted.\n');

  await app.file.revert('hello', 'README.md', 'Local modifications discarded.');

  await expect(app.forge.editor('README.md')).toHaveValue(was);
  expect(await app.file.revertable('hello', 'README.md')).toBe(false);
});

test('a file added since the last commit goes when it is put back', async ({signedIn: app}) => {
  await app.file.named('hello', '', 'New file', 'scratch.txt');
  await app.forge.editFile('scratch.txt', 'for now\n');

  await app.file.revert('hello', 'scratch.txt', 'Not present in latest commit; removing');

  await expect(app.forge.editor('scratch.txt')).toHaveCount(0);
  await app.file.openTree();
  await expect(app.file.name('scratch.txt')).toHaveCount(0);
});

test('a file saved on another device while written here is asked about, and Keep external takes it', async ({signedIn: app, another}) => {
  // The same person on a second device, with the repo brought there from the Remote.
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');
  const laptop = await another('Ada');
  await app.forge.open('hello');
  await laptop.file.bring('hello');

  await app.forge.writeOn('README.md', '# hello\n\nWritten here.\n');
  await laptop.forge.editFile('README.md', '# hello\n\nWritten on the laptop.\n');

  const ask = app.forge.changedElsewhere;
  await app.forge.lookUntil(ask);
  await expect(app.forge.fileState('README.md')).toHaveText('Modified externally');
  // Nothing is decided for the person: theirs is still here until they choose.
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nWritten here.\n');
  await app.forge.writingDone();
  await ask.getByRole('button', {name: 'View diff'}).click();
  await expect(ask.getByText('Written on the laptop.')).toBeVisible();

  await ask.getByRole('button', {name: 'Keep external'}).click();
  await expect(ask).toBeHidden();
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nWritten on the laptop.\n');
  await expect(app.forge.fileState('README.md')).toBeHidden();
});

test('Escape out of an empty search gives the keyboard back to the Prompt that had it', async ({signedIn: app}) => {
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  await app.forge.find('hello');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toHaveValue('');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toBeHidden();
  await expect(app.forge.promptBox).toBeFocused();
});

test('a text grown past what Forge saves says so in its box, and is kept whole when asked, to read in part', async ({signedIn: app}) => {
  await app.file.named('hello', '', 'New file', 'big.txt');
  const editor = app.forge.editor('big.txt');
  await expect(editor).toBeFocused();
  /** `text` put in at once, as a paste or a cut is. */
  const put = (text: string) => editor.evaluate((el: HTMLTextAreaElement, t) => {
    el.value = t;
    el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
  }, text);
  await put(`${'x'.repeat(99)}\n`.repeat(3000));
  await editor.press('Control+s');
  // Not saved, and said so where it is, with how large it is and the way on; what was written stays.
  await expect(app.forge.fileState('big.txt')).toHaveText('Unsaved · Exceeds 262 KB');
  const ask = app.main.getByRole('group', {name: 'File too large to save here'});
  await expect(ask).toContainText('Size is 300 KB. Forge can only save files up to 262 KB.');
  await expect(editor).toHaveValue(/^x{99}\n/);
  // Made smaller, it saves as before and the ask goes.
  await put('small again\n');
  await editor.press('Control+s');
  await expect(ask).toBeHidden();
  await expect(app.forge.fileState('big.txt')).toBeHidden();
  // Grown again and saved whole: kept as written, and read in part from now on.
  await put(`${'y'.repeat(99)}\n`.repeat(3000));
  await editor.press('Control+s');
  await ask.getByRole('button', {name: 'Save full file'}).click();
  await expect(app.forge.fileState('big.txt')).toHaveText('First 262 KB only (total 300 KB) · Read-only');
  await expect(app.forge.editor('big.txt')).toHaveCount(0);
});

test('Places puts away its menus, and the Prompt shortcut returns to the paper in hand', async ({signedIn: app}) => {
  await app.newRepo.make('keys', {template: 'C'});
  await app.rail.go('forge');
  const {placesKey: key, places} = app.forge;
  const readme = app.forge.editor('README.md');
  await readme.focus();
  await expect(app.forge.piece('README.md')).toHaveClass(/held/);
  await key.click();
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(places.getByRole('menuitemradio', {name: 'Forge', exact: true})).toBeFocused();
  await key.click();
  await expect(key).toHaveAttribute('aria-expanded', 'false');
  await expect(places).toBeHidden();
  await key.click();
  await app.page.keyboard.press('Escape');
  await expect(key).toBeFocused();
  await expect(places).toBeHidden();

  const deeds = app.page.getByRole('menu', {name: 'README.md', exact: true});
  const showDeeds = async () => {
    await app.rail.open();
    await app.page.getByRole('button', {name: 'Files: New, Rename, Delete', exact: true}).click();
    await expect(deeds.getByRole('menuitem', {name: 'New file'})).toBeFocused();
    await expect(key).toHaveAttribute('aria-expanded', 'true');
  };
  await showDeeds();
  await key.click();
  await expect(deeds).toBeHidden();
  await expect(key).toHaveAttribute('aria-expanded', 'false');
  await showDeeds();
  await deeds.hover();
  await app.page.mouse.move(8, 400);
  await expect(deeds).toBeHidden();
  await expect(key).toHaveAttribute('aria-expanded', 'false');

  await readme.focus();
  await expect(app.forge.piece('README.md')).toHaveClass(/held/);
  const promptSlot = app.main.locator('.forge-prompt-slot');
  await expect(promptSlot).toBeHidden();
  await app.page.keyboard.press('Control+Backquote');
  await expect(promptSlot).toHaveClass(/held/);
  await expect(app.forge.promptBox).toBeFocused();
  await app.page.keyboard.press('Control+Backquote');
  await expect(promptSlot).toBeHidden();
  await expect(promptSlot).not.toHaveClass(/held/);
  await expect(readme).toBeFocused();
});
