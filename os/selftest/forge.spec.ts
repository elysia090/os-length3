import {expect, test} from './fixtures.ts';

// Forge: each file a plain text editor that saves on its own; the diff
// follows every save and its lines can be marked as with a highlighter; the
// search finds a line and opens the center there with the line selected.

test.beforeEach(async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
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
  await expect(app.git.section('main')).toBeHidden();
  await app.rail.go('forge');
  const was = await app.forge.editor('README.md').inputValue();
  await app.forge.editFile('README.md', '# hello\n\nNot wanted.\n');

  await app.forge.putBack('README.md', 'What was changed here goes.');

  await expect(app.forge.editor('README.md')).toHaveValue(was);
  // Pressed with nothing typed, the box shows what is changed now: not README.md.
  await app.forge.show('diff');
  await expect(app.forge.reference.getByText('README.md', {exact: true})).toBeHidden();
});

test('a file added since the last commit goes when it is put back', async ({signedIn: app}) => {
  await app.git.commitOnMain('hello', 'Docs: The first');
  await expect(app.git.section('main')).toBeHidden();
  await app.file.named('hello', '', 'New file', 'scratch.txt');
  await app.forge.editFile('scratch.txt', 'for now\n');

  await app.forge.putBack('scratch.txt', 'It was not in the last commit, so it goes');

  await expect(app.forge.editor('scratch.txt')).toHaveCount(0);
  await app.file.openTree();
  await expect(app.file.name('scratch.txt')).toHaveCount(0);
});

test('a file saved on another device while written here is asked about, and Use the other takes it', async ({signedIn: app, another}) => {
  // The same person on a second device, with the repo brought there from the Remote.
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');
  const laptop = await another('Ada');
  await app.forge.open('hello');
  await laptop.file.bring('hello');

  await app.forge.writeOn('README.md', '# hello\n\nWritten here.\n');
  await laptop.forge.editFile('README.md', '# hello\n\nWritten on the laptop.\n');

  const ask = app.forge.changedElsewhere;
  await app.forge.lookUntil(ask);
  await expect(app.forge.fileState('README.md')).toHaveText('Changed elsewhere');
  // Nothing is decided for the person: theirs is still here until they choose.
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nWritten here.\n');
  await app.forge.writingDone();
  await ask.getByRole('button', {name: 'See what differs'}).click();
  await expect(ask.getByText('Written on the laptop.')).toBeVisible();

  await ask.getByRole('button', {name: 'Use the other'}).click();
  await expect(ask).toBeHidden();
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nWritten on the laptop.\n');
  await expect(app.forge.fileState('README.md')).toBeHidden();
});
