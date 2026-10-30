import {expect, test} from './fixtures.ts';

// Forge: each file a plain text editor that saves on its own; the diff
// follows every save and its lines can be marked as with a highlighter; the
// search finds a line and opens the center there with the line selected.

// Each test opens the app on 'hello', made from C's files and left open in Forge (fixtures.ts, helloC: made once for
// the worker, as making it is new-repo.spec.ts's and file.spec.ts's to see), signed in: the repo goes to the Remote
// then, as one made before signing in does.
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({signedIn: app}) => {
  await app.newRepo.openInForge();
});

test('a file edited is saved, and what changed shows in the diff', async ({signedIn: app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');

  await app.forge.show('diff');
  await expect(app.forge.reference.getByText('README.md', {exact: true})).toBeVisible();
  await app.forge.openDiff('README.md');
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
});

test('a diff line pressed is marked, and pressed again is not', async ({signedIn: app}) => {
  await app.forge.editFile('README.md', '# hello\n\nMark this line.\n');
  await app.forge.openDiff('README.md');

  const line = app.forge.diffLine('Mark this line.');
  await expect(line).toHaveAttribute('aria-pressed', 'false');
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'false');
});

test('the search finds a line and opens the file there, the line selected', async ({signedIn: app}) => {
  await app.forge.find('puts');

  await expect(app.forge.results.getByText('1 file · 1 line')).toBeVisible();
  await app.forge.hit(/puts\("hello"\);/).click();

  await expect(app.forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => app.forge.selected('src/main.c')).toBe('    puts("hello");');
});

test('a file put back from the diff is as it was at the last commit, and leaves the diff', async ({signedIn: app}) => {
  await app.git.commitOnMain('hello', 'Docs: The first');
  await expect(app.git.mainCard('hello')).toBeHidden();
  await expect(app.git.committed('The first')).toBeVisible();
  await app.rail.go('forge');
  const was = await app.forge.editor('README.md').inputValue();
  await app.forge.editFile('README.md', '# hello\n\nNot wanted.\n');

  await app.forge.putBack('README.md', 'Local modifications discarded.');

  await expect(app.forge.editor('README.md')).toHaveValue(was);
  // Pressed with nothing typed, the box shows what is changed now: not README.md.
  await app.forge.show('diff');
  await expect(app.forge.reference.getByText('README.md', {exact: true})).toBeHidden();
});

test('a file added since the last commit goes when it is put back', async ({signedIn: app}) => {
  await app.git.commitOnMain('hello', 'Docs: The first');
  await expect(app.git.mainCard('hello')).toBeHidden();
  await expect(app.git.committed('The first')).toBeVisible();
  await app.file.named('hello', '', 'New file', 'scratch.txt');
  await app.forge.editFile('scratch.txt', 'for now\n');

  await app.forge.putBack('scratch.txt', 'Not present in latest commit; removing');

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

test('Escape out of an empty search gives the keyboard back to what had it', async ({signedIn: app}) => {
  await app.forge.promptBox.click();
  await app.forge.search.click();
  await app.forge.search.fill('hello');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toHaveValue('');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.promptBox).toBeFocused();
});

test('a pill pressed on its edge, round its name, goes to its repo', async ({signedIn: app}) => {
  await app.newRepo.make('world');
  await app.forge.open('hello');
  await app.forge.open('world');
  const pill = app.forge.band.locator('.pill', {hasText: 'hello'});
  const box = (await pill.boundingBox())!;
  await app.page.mouse.click(box.x + 3, box.y + box.height / 2);
  await expect(pill).toHaveAttribute('aria-current', 'page');
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
  await expect(app.forge.fileState('big.txt')).toHaveText('Not saved · over 262 KB');
  const ask = app.main.getByRole('group', {name: 'File too large to save here'});
  await expect(ask).toContainText('It is 300 KB: Forge saves what it edits up to 262 KB.');
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
  await expect(app.forge.fileState('big.txt')).toHaveText('Only the first 262 KB (of 300 KB) · read only');
  await expect(app.forge.editor('big.txt')).toHaveCount(0);
});
