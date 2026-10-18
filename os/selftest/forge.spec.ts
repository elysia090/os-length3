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
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
});

test('a diff line pressed is marked, and pressed again is not', async ({signedIn: app}) => {
  await app.forge.editFile('README.md', '# hello\n\nMark this line.\n');
  await app.forge.show('diff');

  const line = app.forge.diffLine('Mark this line.');
  await expect(line).toHaveAttribute('aria-pressed', 'false');
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'false');
});

test('the search finds a line and opens the file there, the line selected', async ({signedIn: app}) => {
  await app.forge.find('puts');

  await expect(app.forge.reference.getByText('1 file · 1 line')).toBeVisible();
  await app.forge.hit(/puts\("hello"\);/).click();

  await expect(app.forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => app.forge.selected('src/main.c')).toBe('    puts("hello");');
});
