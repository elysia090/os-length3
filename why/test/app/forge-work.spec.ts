import {expect, test} from './fixtures.ts';
import {GAP, GRID, PAD, SHADOW, TOP, WIDTH} from '../../app/pages/forge/desk-layout.ts';

/** The Forge paper, its ground, and the separate neutral terminal work face. */
const FORGE_GROUND = 'rgb(58, 61, 54)', PAPER = 'rgb(239, 235, 227)', CAST = 'rgb(26, 29, 23)', INK = 'rgb(23, 22, 21)';
const TERMINAL_FACE = 'rgb(237, 234, 229)', TERMINAL_INK = 'rgb(27, 27, 27)';

// Working in Forge without losing anything (issue #20): Tab or Ctrl+] moves lines in
// and Undo takes it back, a press on a line's number is that line, Undo
// still works after going elsewhere, the search follows what is saved and
// is used from the keyboard, the right pane is put away and brought back as
// it was, every part of it is reached on a narrow window, and the plug opens
// a plain plugin area. No Prompt is needed for any of it.

// Each test opens the app on 'hello', made from C's files and left open in Forge: made once for the worker and kept
// (fixtures.ts, helloC), as making it is new-repo.spec.ts's and file.spec.ts's to see.
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
});

/** The text of an editor and what is selected in it, its direction too. */
const state = (app: {forge: {editor(p: string): import('@playwright/test').Locator}}, path: string) =>
  app.forge.editor(path).evaluate((el: HTMLTextAreaElement) => ({text: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection}));

test('Ctrl+] moves the lines in by the file\'s own indent and Ctrl+[ out, keeps them selected, and one Undo takes it back before and after it is saved', async ({app}) => {
  // The page's clock is the test's from before anything is written here, so the pause that saves is passed, not waited out.
  await app.page.clock.install();
  const editor = app.forge.editor('README.md');
  const cases: {name: string; text: string; start: number; end: number; direction?: 'backward'; after: string}[] = [
    {name: 'a caret', text: 'ab\ncd\n', start: 1, end: 1, after: '\tab\ncd\n'},
    {name: 'part of a line', text: 'one two\nthree\n', start: 4, end: 7, after: '\tone two\nthree\n'},
    {name: 'two whole lines', text: 'one\ntwo\nthree\n', start: 0, end: 7, after: '\tone\n\ttwo\nthree\n'},
    {name: 'two lines selected backwards', text: 'one\ntwo\nthree\n', start: 1, end: 6, direction: 'backward', after: '\tone\n\ttwo\nthree\n'},
    {name: 'a selection ending in a newline', text: 'one\ntwo\nthree\n', start: 0, end: 8, after: '\tone\n\ttwo\nthree\n'},
    {name: 'a file indented with spaces', text: 'if (x) {\n  one;\ntwo;\n', start: 17, end: 17, after: 'if (x) {\n  one;\n  two;\n'},
  ];
  for (const c of cases) {
    await editor.fill(c.text);
    await editor.evaluate((el: HTMLTextAreaElement, c) => { el.focus(); el.setSelectionRange(c.start, c.end, c.direction ?? 'forward'); }, c);
    await editor.press('Control+BracketRight');
    const done = await state(app, 'README.md');
    expect(done.text, c.name).toBe(c.after);
    // What was selected is still selected, moved with its lines.
    expect(done.text.slice(done.start, done.end).replace(/^[\t ]+|(?<=\n)[\t ]+/g, ''), c.name).toBe(c.text.slice(c.start, c.end));
    if (c.direction) expect(done.direction, c.name).toBe('backward');
    await editor.press('Control+z');
    expect(await state(app, 'README.md'), c.name).toMatchObject({text: c.text, start: c.start, end: c.end});
  }
  // Out by one: a tab, or the spaces of one indent.
  await editor.fill('\tone\n    two\nthree\n');
  await editor.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(2, 12); });
  await editor.press('Control+BracketLeft');
  expect(await state(app, 'README.md')).toMatchObject({text: 'one\ntwo\nthree\n', start: 1, end: 7});
  // Saved in between (a pause in writing saves it): Undo and Redo still go both ways.
  await editor.fill('one\ntwo\n');
  await editor.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 7); });
  await editor.press('Control+BracketRight');
  await app.page.clock.runFor(700);
  await expect(app.forge.fileState('README.md')).toBeHidden();
  await editor.press('Control+z');
  expect(await state(app, 'README.md')).toMatchObject({text: 'one\ntwo\n', start: 0, end: 7});
  await editor.press('Control+Shift+z');
  expect((await state(app, 'README.md')).text).toBe('\tone\n\ttwo\n');
});

test('Alt and an arrow move what is written, the lines up and down and the letters sideways; Enter keeps the indent', async ({app}) => {
  const editor = app.forge.editor('README.md');
  const at = async (text: string, start: number, end = start) => {
    await editor.fill(text);
    await editor.evaluate((el: HTMLTextAreaElement, [a, b]) => { el.focus(); el.setSelectionRange(a, b); }, [start, end]);
  };
  await at('one\ntwo\nthree\n', 5);
  await editor.press('Alt+ArrowUp');
  expect(await state(app, 'README.md')).toMatchObject({text: 'two\none\nthree\n', start: 1, end: 1});
  await editor.press('Alt+ArrowDown');
  await editor.press('Alt+ArrowDown');
  expect(await state(app, 'README.md')).toMatchObject({text: 'one\nthree\ntwo\n', start: 11, end: 11});
  // One Undo takes the last move back, the caret with it.
  await editor.press('Control+z');
  expect(await state(app, 'README.md')).toMatchObject({text: 'one\ntwo\nthree\n', start: 5, end: 5});
  // The letter after the caret, and what is selected, moved a letter, the caret before it, the selection kept.
  await at('ab', 0);
  await editor.press('Alt+ArrowRight');
  expect(await state(app, 'README.md')).toMatchObject({text: 'ba', start: 1, end: 1});
  await at('abcd', 1, 3);
  await editor.press('Alt+ArrowLeft');
  expect(await state(app, 'README.md')).toMatchObject({text: 'bcad', start: 0, end: 2});
  // A new line keeps the indent of the one it breaks.
  await at('\tif (x)\n', 7);
  await editor.press('Enter');
  expect(await state(app, 'README.md')).toMatchObject({text: '\tif (x)\n\t\n', start: 9});
});

test('a press on a line\'s number selects that line; below the text, the caret goes to its end', async ({app}) => {
  const editor = app.forge.editor('src/main.c');
  // Its box in hand (the keyboard gone into it), the camera come to it.
  await editor.focus();
  await app.page.waitForTimeout(700);
  const text = await editor.inputValue();
  const lines = text.split('\n');
  const gutter = app.main.locator('.desk-file[data-path="src/main.c"] .gutter');
  const box = (await gutter.boundingBox())!;
  const height = box.height / Math.max(lines.length, 1);
  for (const n of [3, 4, 2]) {
    await app.page.mouse.click(box.x + box.width / 2, box.y + (n - 0.5) * height);
    await expect(editor).toBeFocused();
    await expect.poll(() => app.forge.selected('src/main.c')).toBe(lines[n - 1]);
  }
  // Below the text, as before: the caret at the end.
  const sheet = (await app.main.locator('.desk-file[data-path="src/main.c"] .sheet').boundingBox())!;
  await app.page.mouse.click(sheet.x + sheet.width / 2, sheet.y + sheet.height - 8);
  expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([text.length, text.length]);
});

test('what was written is undone after going to Runtime and back, and to another repo and back; Redo writes it again', async ({app}) => {
  // The page's clock is the test's from before anything is written here, so the pause that saves is passed, not waited out.
  await app.page.clock.install();
  await app.newRepo.make('other');
  await app.forge.open('hello');
  const editor = app.forge.editor('README.md');
  const was = await editor.inputValue();
  await editor.click();
  await app.page.keyboard.press('Control+End');
  // One edit, one Undo (typed key by key, each key is its own step, as it was before).
  await app.page.keyboard.insertText('typed here');
  // A pause in writing saves it.
  await app.page.clock.runFor(700);
  await expect(app.forge.fileState('README.md')).toBeHidden();

  await app.rail.go('runtime');
  await app.rail.go('forge');
  await editor.focus();
  await app.page.keyboard.press('Control+z');
  await expect(editor).toHaveValue(was);
  await app.page.keyboard.press('Control+Shift+z');
  await expect(editor).toHaveValue(`${was}typed here`);

  await app.forge.open('other');
  await expect(app.forge.editor('README.md')).toBeVisible();
  await app.forge.open('hello');
  await editor.focus();
  await app.page.keyboard.press('Control+z');
  await expect(editor).toHaveValue(was);
});

test('what the search found follows what is saved, and a line found opens where it is now', async ({app}) => {
  const editor = app.forge.editor('README.md');
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.forge.find('Written');
  await expect(app.forge.hit(/Written in Forge/)).toContainText('3');

  // Lines added above it and saved: the count, the line and where it opens are the saved text's.
  await app.forge.editFile('README.md', '# hello\n\none\ntwo\n\nWritten in Forge.\n');
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toHaveValue('Written');
  await expect(app.forge.hit(/Written in Forge/)).toContainText('6');
  await app.forge.hit(/Written in Forge/).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => app.forge.lineChosen('README.md')).toBe('Written in Forge.');

  // The word changed: it is no longer found, and the search keeps what was typed.
  await app.forge.editFile('README.md', '# hello\n\nWrote it in Forge.\n');
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.results).toContainText('No results found for "Written"');
  await expect(app.forge.search).toHaveValue('Written');
});

test('a file found by its name is opened to write in from the keyboard alone, and Escape and / come back', async ({app}) => {
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toBeFocused();
  await app.forge.search.fill('main.c');
  await expect(app.forge.results.getByRole('button', {name: 'src/main.c', exact: true})).toBeVisible();
  // Enter takes the first found: the file found by its name, with the caret in it.
  await app.forge.search.press('Enter');
  await expect(app.forge.editor('src/main.c')).toBeFocused();
  expect(await app.forge.editor('src/main.c').evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);

  // Out of the file, / goes back to the search on the band; ↓ walks what was found; Escape goes back up to the box.
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('/');
  await expect(app.forge.search).toBeFocused();
  await expect(app.forge.search).toHaveValue('main.c');
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.results.getByRole('button', {name: 'src/main.c', exact: true})).toBeFocused();
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toBeFocused();
  await expect(app.forge.search).toHaveValue('main.c');
});

test('Enter in the search opens the first line found, washed, the caret on it; a line found is a row of its file\'s name, its number and its words, as the mock\'s', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.forge.find('Written');
  // A row a line found, read across: the file's name, the line's number, its words; nothing else beside it (no count,
  // no diff), and the section says how many rows it found.
  const row = app.forge.hit(/Written in Forge/);
  await expect(row).toHaveText(/^README\.md\s*3\s*Written in Forge\.$/);
  await expect(app.forge.results.getByRole('button', {name: /^Diff of/})).toHaveCount(0);
  await expect(app.forge.results.locator('.found-sec-head', {hasText: 'files'})).toHaveText(/^files\s*1$/);
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.hit(/Written in Forge/)).toBeFocused();
  await app.page.keyboard.press('ArrowUp');
  await expect(app.forge.search).toBeFocused();
  await app.forge.search.press('Enter');
  await expect(app.forge.editor('README.md')).toBeFocused();
  await expect.poll(() => app.forge.lineChosen('README.md')).toBe('Written in Forge.');
});

test('Forge has no pane: summoned search leaves the document where it is and goes away when the keyboard returns to the file', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nA line written in Forge, long enough to run on past the middle of its box.\n');
  // The page is the desk: nothing stands beside it, and nothing puts a pane away or brings one back.
  await expect(app.main.getByRole('complementary')).toHaveCount(0);
  await expect(app.main.getByRole('button', {name: 'Right pane', exact: true})).toHaveCount(0);
  await expect(app.forge.search).toBeHidden();
  const editor = app.forge.editor('README.md');
  const before = await editor.boundingBox();
  expect(before).not.toBeNull();
  await app.forge.find('written');
  await expect(app.forge.results.getByRole('button', {name: /^README\.md/}).first()).toBeVisible();
  await expect.poll(() => editor.boundingBox()).toEqual(before);
  // Back in the file (the sheet lies over the desk: the keyboard goes there, as Alt and an arrow take it) and written
  // in: nothing searched stays over the desk.
  await editor.focus();
  await app.page.keyboard.type('x');
  await expect(app.forge.results).toBeHidden();
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.boundingBox()).toMatchObject({x: before!.x, y: before!.y, width: before!.width});
});

test('a narrow window searches from the box as a wide one does, and Escape puts what it found away', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.page.setViewportSize({width: 552, height: 800});
  await expect(app.forge.results).toBeHidden();
  // Ask for the band's existing search with its keyboard shortcut; nothing drops until something is typed.
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toBeFocused();
  await expect(app.forge.results).toBeHidden();
  await app.forge.search.fill('Written');
  await expect(app.forge.results.getByRole('button', {name: /^README\.md/}).first()).toBeVisible();
  // Escape: what is typed goes, then everything under the box goes away.
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toHaveValue('');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.results).toBeHidden();
  await expect(app.forge.search).toBeHidden();
});

test('what is searched lines up sideways: the one in hand fills the box, the search before it a sliver past its edge, pressed to move to it', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nthe first written\n');
  await app.forge.find('written');
  const first = app.forge.results.getByRole('button', {name: /the first written/}).first();
  await expect(first).toBeVisible();
  // Taken (Enter: the first found), the file opens at its line, and the search is kept in the line.
  await app.forge.search.press('Enter');
  await expect.poll(() => app.forge.lineChosen('README.md')).toBe('the first written');
  await app.forge.find('hello');
  // The search before is at its left, a sliver: pressed, it is in hand again, as typed.
  await app.forge.results.getByRole('button', {name: 'Search history written', exact: true}).click();
  await expect(app.forge.search).toHaveValue('written');
  await expect(first).toBeVisible();
  // Asked for with nothing typed (↓): what was searched and opened, newest first.
  await app.forge.search.fill('');
  await app.forge.search.click();
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.results.locator('.found-item')).toHaveText([/^File\s*README\.md$/, /^Search history\s*written$/]);
});

test('the Plugin command toggles the plain Home area, and leads there from desks without it', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  const plugin = () => app.rail.destination('plugin');
  const home = () => expect(app.main).toHaveAttribute('data-place', 'home');
  await expect(area).toHaveCount(0);
  await (await plugin()).click();
  await home();
  await expect(area).toBeVisible();
  // With none installed, the area is plain, with neither copy nor fake controls (issue #45).
  await expect(area).toBeEmpty();
  await expect(app.forge.placesKey).toBeFocused({timeout: 1500});
  await (await plugin()).click();
  await expect(area).toBeHidden();
  await home();
  await (await plugin()).click();
  await expect(area).toBeVisible();
  await (await plugin()).click();
  await expect(area).toBeHidden();
  // Forge, Runtime and the current Git desk have no plugin area of their own.
  for (const place of ['forge', 'runtime', 'git'] as const) {
    await app.rail.go(place);
    await expect(area).toHaveCount(0);
    await (await plugin()).click();
    await home();
    await expect(area).toBeVisible();
    await expect(app.forge.placesKey).toBeFocused({timeout: 1500});
    await (await plugin()).click();
    await expect(area).toBeHidden();
  }
});

test('the Plugin area waits off Home; Escape puts away Places first, then the plain area', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  await (await app.rail.destination('plugin')).press('Enter');
  await expect(area).toBeVisible();
  await app.rail.go('runtime');
  await expect(area).toHaveCount(0);
  await app.rail.go('forge');
  await expect(area).toHaveCount(0);
  await app.rail.go('home');
  await expect(area).toBeVisible();
  const places = app.forge.placesKey;
  await places.press('Enter');
  await expect(app.forge.places).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.places).toBeHidden();
  await expect(area).toBeVisible();
  await expect(places).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(area).toBeHidden({timeout: 1500});
  await expect(places).toBeFocused();
  // It can be opened with the same keys again without changing pages.
  await (await app.rail.destination('plugin')).press('Space');
  await expect(area).toBeVisible();
  await expect(places).toBeFocused();
});

test('the repo Files row keeps its real deeds without a second command in Places', async ({app}) => {
  await app.forge.use('Files');
  const files = app.page.getByRole('tree', {name: 'hello', exact: true});
  const src = files.getByRole('treeitem', {name: 'src', exact: true});
  if (await src.getAttribute('aria-expanded') === 'false') await src.getByRole('button', {name: 'Open src', exact: true}).click();
  const action = async (name: string) => {
    if (!await files.isVisible()) await app.forge.use('Files');
    const row = files.getByRole('button', {name, exact: true});
    await row.press('Shift+F10');
    const menu = app.page.getByRole('menu', {name, exact: true});
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAttribute('aria-busy', 'true');
    return {row, menu};
  };
  const {menu, row} = await action('main.c');
  await expect(menu.getByRole('menuitem')).toHaveText(['New file', 'New folder', 'Rename', 'Delete']);
  await expect(menu.getByRole('menuitem', {name: 'New file'})).toBeFocused();
  await menu.getByRole('menuitem', {name: 'New file'}).press('Escape');
  await expect(menu).toBeHidden();
  await expect(row).toBeFocused();

  // Made by the file's folder, its ending is kept and the new name is written in its own sheet.
  const {menu: near} = await action('main.c');
  await near.getByRole('menuitem', {name: 'New file'}).click();
  await expect(app.main.getByRole('textbox', {name: 'New name', exact: true})).toBeFocused();
  await expect(near).toBeHidden();
  await app.forge.rename('src/untitled.c', 'util.c');
  await expect(app.forge.editor('src/util.c')).toBeFocused();

  // Reopen the repo's catalogue after editing the new name. A path renamed from its row moves the actual file.
  await app.forge.use('Forge');
  await app.forge.use('Files');
  const field = files.getByRole('textbox', {name: 'New name', exact: true});
  const {menu: util} = await action('util.c');
  await util.getByRole('menuitem', {name: 'Rename'}).click();
  await expect(field).toHaveValue('util.c');
  await field.fill('support.c');
  await field.press('Enter');
  await expect(src.getByRole('button', {name: 'support.c', exact: true})).toBeFocused();
  await expect(app.forge.editor('src/support.c')).toBeVisible();
  await expect(util).toBeHidden();

  const {menu: support} = await action('support.c');
  await support.getByRole('menuitem', {name: 'Rename'}).click();
  await field.fill('lib/util.c');
  await field.press('Enter');
  await expect(files.getByRole('button', {name: 'util.c', exact: true})).toBeFocused();
  await expect(app.forge.editor('lib/util.c')).toBeVisible();
  await expect(support).toBeHidden();

  const {menu: moved} = await action('util.c');
  await moved.getByRole('menuitem', {name: 'Rename'}).click();
  await expect(field).toBeFocused();
  await field.fill('Not kept.c');
  // On down outside the field, there is no popup margin to swallow a press on its parent row.
  const folder = files.getByRole('treeitem', {name: 'lib', exact: true});
  await folder.getByRole('button', {name: 'lib', exact: true}).click({position: {x: 18, y: 20}});
  await expect(field).toBeHidden();
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(app.forge.editor('lib/util.c')).toBeVisible();
});

test('Files Rename leaves caret movement and Shift selection to the name field', async ({app, page}) => {
  await app.forge.use('Files');
  const files = page.getByRole('tree', {name: 'hello', exact: true});
  const src = files.getByRole('treeitem', {name: 'src', exact: true});
  if (await src.getAttribute('aria-expanded') === 'false') await src.getByRole('button', {name: 'Open src', exact: true}).click();
  const row = src.getByRole('button', {name: 'main.c', exact: true});
  await row.press('Shift+F10');
  await page.getByRole('menu', {name: 'main.c', exact: true}).getByRole('menuitem', {name: 'Rename', exact: true}).press('Enter');
  const name = files.getByRole('textbox', {name: 'New name', exact: true});
  const range = () => name.evaluate((f: HTMLInputElement) => [f.selectionStart, f.selectionEnd]);
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('main.c');
  expect(await range()).toEqual([0, 4]);
  for (const [key, first, last] of [['End', 6, 6], ['Shift+ArrowLeft', 5, 6], ['Home', 0, 0], ['ArrowRight', 1, 1], ['Shift+End', 1, 6]] as const) {
    await page.keyboard.press(key);
    await expect(name).toBeFocused();
    expect(await range(), key).toEqual([first, last]);
  }
  await page.keyboard.press('Escape');
  await expect(name).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(src.getByRole('button', {name: 'src', exact: true})).toBeFocused();
});

test('Prompt keeps its own steady material when the file has focus; a note has a send word, and Escape returns to the document', async ({app}) => {
  await app.rail.go('forge');
  const term = app.main.locator('.forge-prompt-slot'), stand = term.locator('.desk-term.stand:visible'), own = app.forge.editor('README.md');
  await expect(term).toBeHidden();
  await expect(app.forge.desk.locator('section[aria-label="Prompt"]')).toHaveCount(0);
  await own.focus();
  const before = await own.boundingBox();
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  await expect.poll(() => own.boundingBox()).toEqual(before);
  await expect(term.getByRole('heading', {name: 'Prompt', exact: true})).toBeVisible();
  await expect(term.locator('.desk-close')).toHaveCount(0);
  await expect(term).toHaveClass(/held/);
  await expect(app.forge.piece('README.md')).toHaveCSS('box-shadow', 'none');
  await expect(stand).toHaveCSS('background-color', TERMINAL_FACE);
  // A line is run with Enter, as at a terminal: nothing to press beside it. A note takes more than a line, so what
  // sends it stands at the line's end once something is written.
  const send = stand.locator('.prompt-run');
  await app.forge.promptBox.fill('true');
  await expect(send).toBeHidden();
  await app.forge.promptBox.fill('');
  await app.forge.promptBox.press('Alt+3');
  await expect(send).toBeHidden();
  await app.forge.promptBox.fill('Fix: a note');
  await expect(send).toBeVisible();
  await expect(send).toHaveText('Add');
  await app.forge.promptBox.fill('');
  await app.forge.promptBox.press('Alt+1');
  // The file gone back to: it is in hand, and the terminal face stays readable.
  await own.focus();
  await expect(app.forge.piece('README.md')).toHaveClass(/held/);
  await expect(term).not.toHaveClass(/held/);
  await expect(stand).toHaveCSS('background-color', TERMINAL_FACE);
  await expect(term).toHaveCSS('box-shadow', 'none');
  await expect(stand).toBeVisible();
  // Pressed in its room (not on its line): the keyboard in its line.
  await term.click({position: {x: 120, y: 240}});
  await expect(app.forge.promptBox).toBeFocused();
  // Escape puts the slot away and returns the keyboard to the file without moving it.
  await app.page.keyboard.press('Escape');
  await expect(term).toBeHidden();
  await expect(own).toBeFocused();
  await expect.poll(() => own.boundingBox()).toEqual(before);
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  await expect(term).toHaveClass(/held/);
});

test('the Prompt slot keeps its neutral material, 20 lines and print wrapping without resizing the document row', async ({app}) => {
  await app.page.setViewportSize({width: 1300, height: 864});
  await app.rail.go('forge');
  const own = app.forge.editor('README.md'), term = app.main.locator('.forge-prompt-slot');
  const stand = term.locator('.desk-term.stand:visible'), chip = stand.locator('.prompt-chip');
  const papers = () => app.forge.desk.locator('.desk-box').evaluateAll((boxes) => boxes.map((el) => {
    const {x, y, width, height} = el.getBoundingClientRect();
    return [x, y, width, height];
  }));
  const size = () => term.evaluate((el) => {
    const line = el.querySelector('.prompt-in')!, c = getComputedStyle(line), r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height, line: line.getBoundingClientRect().height, pitch: parseFloat(c.lineHeight), font: c.fontSize};
  });
  await own.focus();
  const row = await papers();
  await expect(term).toBeHidden();
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  const measure = await size();
  expect(measure).toMatchObject({line: 18, pitch: 18, font: '16px'});
  const face = (await stand.boundingBox())!, paper = (await app.forge.piece('README.md').boundingBox())!;
  expect(face.y).toBeCloseTo(paper.y, 0);
  expect(face.x).toBeGreaterThanOrEqual(paper.x + paper.width);
  expect((face.height - 24) / measure.pitch).toBe(20);
  await expect(stand).toHaveCSS('background-color', TERMINAL_FACE);
  await expect(app.forge.promptBox).toHaveCSS('color', TERMINAL_INK);
  expect(await papers()).toEqual(row);

  // The separate surface stays put to be read when the document is taken back in hand.
  await own.focus();
  await expect(term).not.toHaveClass(/held/);
  await expect(stand).toHaveCSS('background-color', TERMINAL_FACE);
  expect(await size()).toEqual(measure);
  await app.forge.promptBox.focus();
  await expect(term).toHaveClass(/held/);
  await expect(stand.locator('.prompt-chip > .lamp')).toBeHidden();
  const colour = () => chip.evaluate((el) => getComputedStyle(el).color);
  await expect(chip).not.toHaveAttribute('data-state', 'on');
  expect(await colour()).not.toBe(TERMINAL_INK);

  // The actual shell completes a long printed line; it wraps to whole lines within this slot.
  await app.forge.run('printf "%080d\\n" 7');
  const digits = `${'0'.repeat(79)}7`;
  const printed = stand.locator('.term-out .term-lines').filter({hasText: digits});
  await expect(printed).toHaveText(digits);
  await expect(chip).toHaveAttribute('data-state', 'on');
  await expect(chip).toHaveCSS('color', TERMINAL_INK);
  await expect.poll(async () => (await printed.boundingBox())!.height).toBeGreaterThan(measure.pitch);
  expect((await printed.boundingBox())!.height % measure.pitch).toBe(0);
  expect(await size()).toEqual(measure);
  expect(await papers()).toEqual(row);
  await expect(stand.locator('.term-shut')).toBeHidden();
});

test('Places brings Prompt into its slot from wherever the desk is turned without resetting the documents', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.forge.desk, term = app.main.locator('.forge-prompt-slot');
  // The last file taken in hand: the desk turns along its row to show it.
  const keys = await desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.key!));
  await app.forge.editor(keys.at(-1)!).focus();
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBeGreaterThan(0);
  const before = await desk.evaluate((d) => d.scrollLeft);
  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  await expect(term).toHaveClass(/held/);
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(before);
});

test('a piece whole in sight pressed is in hand where it lies, the caret where it was pressed: nothing moves; one gone to by the keyboard comes to the desk\'s edge; scrolled by hand, the desk rests with the nearest piece at its edge and keeps what is in hand', async ({app}) => {
  await app.rail.go('forge');
  const box = (key: string) => app.forge.piece(key), desk = app.forge.desk, pitch = WIDTH + GAP;
  // Where each piece is in the window, and its size.
  const lie = () => desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }));
  const own = app.forge.editor('README.md'), term = app.main.locator('.forge-prompt-slot');
  await own.focus();
  await own.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await app.forge.use('Prompt');
  await expect(term).toHaveClass(/held/);
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(0);
  // The file beside it, whole in sight: pressed in its text, it is in hand where it lies, the keyboard in it. No
  // piece moves or changes size, then or a moment after, and the desk is not turned: what is pressed does not go from
  // under the hand that pressed it.
  const before = await lie();
  const text = (await own.boundingBox())!;
  await app.page.mouse.click(text.x + 60, text.y + 10);
  await expect(box('README.md')).toHaveClass(/held/);
  await expect(own).toBeFocused();
  await expect(term).not.toHaveClass(/held/);
  const caret = await state(app, 'README.md');
  expect(caret.start).toBe(caret.end);
  expect(caret.start).toBeGreaterThan(0);
  expect(caret.start).toBeLessThan(caret.text.indexOf('\n'));
  expect(await lie()).toEqual(before);
  await app.page.waitForTimeout(600);
  expect(await lie()).toEqual(before);
  expect(await desk.evaluate((d) => d.scrollLeft)).toBe(0);
  // The last file, gone to by the keyboard (not pressed): the desk turns to its own rest, the file at the desk's edge,
  // where the eye was (DESIGN §2, eye-trace; §6), the row's ground ahead of it.
  const keys = await desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.key!));
  const last = keys.at(-1)!;
  const rest = pitch * (keys.length - 1);
  await own.press('Escape');
  await expect(desk).toBeFocused();
  for (const key of keys.slice(1)) {
    await app.page.keyboard.press('ArrowRight');
    await expect(box(key)).toHaveClass(/held/);
  }
  await app.page.keyboard.press('Enter');
  await expect(app.forge.editor(last)).toBeFocused();
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(rest);
  const [d, b] = [(await desk.boundingBox())!, (await box(last).boundingBox())!];
  expect(b.x).toBeCloseTo(d.x, 0);
  expect(b.x + b.width + SHADOW).toBeLessThanOrEqual(d.x + d.width);
  // Scrolled sideways, as anything is, and let go between two pieces: the desk comes to rest with the nearer at its
  // edge; what is in hand stays in hand with the keyboard in it.
  await app.page.mouse.move(d.x + d.width / 2, d.y + d.height - 12);
  await app.page.mouse.wheel(-pitch * .7, 0);
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(rest - pitch);
  await expect(box(last)).toHaveClass(/held/);
  await expect(app.forge.editor(last)).toBeFocused();
  // The desk is a row: it is never turned down.
  await app.page.mouse.wheel(0, 400);
  expect(await desk.evaluate((d) => d.scrollTop)).toBe(0);
});

test('the desk is a row on the grid: a piece\'s place is its number in the row, every paper one width and half a cell from the next, every top on one line, whichever is in hand; it turns as far as brings its last piece to the edge, and never down', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.forge.desk;
  await expect(desk.locator('.desk-plane > .desk-box')).not.toHaveCount(0);
  const at = () => desk.evaluate((d) => {
    const face = d.getBoundingClientRect();
    const boxes = [...d.querySelectorAll<HTMLElement>('.desk-plane > .desk-box')].map((b) => { const r = b.getBoundingClientRect(); return {x: Math.round(r.left - face.left + d.scrollLeft), y: Math.round(r.top - face.top), w: Math.round(r.width)}; });
    return {boxes, turned: [d.scrollLeft, d.scrollTop], room: [d.scrollWidth - d.clientWidth, d.scrollHeight - d.clientHeight], face: Math.round(face.width)};
  });
  const row = (n: number) => Array.from({length: n}, (_, i) => ({x: PAD + i * (WIDTH + GAP), y: TOP, w: WIDTH}));
  const own = app.forge.editor('README.md'), term = app.main.locator('.forge-prompt-slot');
  await own.focus();
  await expect.poll(async () => (await at()).turned).toEqual([0, 0]);
  const laid = await at();
  expect(laid.boxes).toEqual(row(3));
  // A right bay reduces the available viewport, not the paper geometry or either scroll position.
  await app.forge.use('Prompt');
  await expect(term).toHaveClass(/held/);
  const beside = await at();
  expect(beside.boxes).toEqual(laid.boxes);
  expect(beside.turned).toEqual(laid.turned);
  expect(beside.face).toBeLessThan(laid.face);
  await app.page.keyboard.press('Escape');
  await expect(term).toBeHidden();
  await expect(own).toBeFocused();
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('ArrowRight');
  await expect(app.forge.piece('src/main.c')).toHaveClass(/held/);
  await expect.poll(async () => (await at()).turned).toEqual([WIDTH + GAP, 0]);
  expect((await at()).boxes).toEqual(laid.boxes);
  // Turned along as far as it goes: the last piece at the desk's edge, no further.
  await desk.evaluate((d) => { d.scrollLeft = d.scrollWidth; });
  await expect.poll(async () => { const a = await at(); return a.turned[0] === a.room[0]; }).toBe(true);
  const end = await at(), last = end.boxes.at(-1)!;
  expect(end.room[0]).toBe(last.x - PAD);
  expect(end.room[0] % GRID).toBe(0);
  // And back to its start; nothing lies under the row to turn down to.
  await desk.evaluate((d) => { d.scrollLeft = 0; });
  await expect.poll(async () => (await at()).turned).toEqual([0, 0]);
  expect(end.room[1]).toBe(0);
});

test('Escape out of a text only takes the keyboard out onto the desk; the desk has one size, and no key steps back from it; Enter goes into the box in hand', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.page.locator('.desk:not([hidden])');
  const own = app.forge.editor('README.md');
  await own.focus();
  const readme = app.page.locator('.desk-box[data-key="README.md"]');
  const at = (await readme.boundingBox())!;
  // Ctrl and -, + and 0 are the window's own: the desk takes none of them (before: a step back, and back).
  for (const key of ['Control+Minus', 'Control+Equal', 'Control+Digit0']) {
    await app.page.keyboard.press(key);
    expect((await readme.boundingBox())!).toEqual(at);
  }
  await expect(own).toBeFocused();
  // Out of the text: the keyboard on the desk, and that is all. The desk is as large as it was, the box where it was,
  // and nothing is drawn for it (before: a pointing hand beside the box's name).
  await app.page.keyboard.press('Escape');
  await expect(desk).toBeFocused();
  expect((await readme.boundingBox())!).toEqual(at);
  await expect(desk.locator('.desk-hand')).toHaveCount(0);
  // On the desk, Escape again changes nothing (before: the desk three quarters its size, then half, then round).
  for (let i = 0; i < 3; i++) {
    await app.page.keyboard.press('Escape');
    await expect(desk).toBeFocused();
    expect((await readme.boundingBox())!).toEqual(at);
  }
  expect(await desk.locator('.desk-plane').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  // Enter goes into the box in hand, where it stands.
  await app.page.keyboard.press('Enter');
  await expect(own).toBeFocused();
  expect((await readme.boundingBox())!).toEqual(at);
});

test('Tab in a file is the text\'s, the indent written; out of the text ← and → or Tab take the next piece in hand and a letter goes into it; a piece is not carried about: Ctrl and an arrow are the text\'s', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.page.locator('.desk:not([hidden])');
  const box = (key: string) => app.page.locator(`.desk-box[data-key="${key}"]`);
  const own = app.forge.editor('README.md');
  await own.focus();
  // Tab in a file writes the file's own indent where the caret is, as in any editor, and Shift+Tab takes the line
  // out again: the keyboard stays in the text, the box in hand.
  await own.evaluate((el: HTMLTextAreaElement) => { el.value = 'one'; el.setSelectionRange(0, 0); });
  await app.page.keyboard.press('Tab');
  await expect(own).toBeFocused();
  await expect(own).toHaveValue('\tone');
  await app.page.keyboard.press('Shift+Tab');
  await expect(own).toHaveValue('one');
  await expect(own).toBeFocused();
  await expect(box('README.md')).toHaveClass(/held/);
  // Out of the text, arrows go along the document row. The first paper's left edge is not a route to Prompt.
  // Tab still wraps among the papers, with the keyboard on the desk.
  await app.page.keyboard.press('Escape');
  await expect(desk).toBeFocused();
  await app.page.keyboard.press('ArrowRight');
  await expect(box('src/main.c')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowLeft');
  await expect(box('README.md')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowLeft');
  await expect(box('README.md')).toHaveClass(/held/);
  await expect(app.main.locator('.forge-prompt-slot')).toBeHidden();
  await app.page.keyboard.press('Shift+Tab');
  await expect(box('Makefile')).toHaveClass(/held/);
  await app.page.keyboard.press('Tab');
  await expect(box('README.md')).toHaveClass(/held/);
  await app.page.keyboard.press('Tab');
  await expect(box('src/main.c')).toHaveClass(/held/);
  await app.page.keyboard.press('Shift+Tab');
  await expect(box('README.md')).toHaveClass(/held/);
  await expect(desk).toBeFocused();
  // A letter typed goes into the box in hand.
  await app.page.keyboard.type('Q');
  await expect(own).toBeFocused();
  await expect(own).toHaveValue(/Q/);
  // Ctrl and an arrow in a text are the text's own (a word along), as on every system: the box stays where it lies.
  await own.evaluate((el: HTMLTextAreaElement) => { el.value = 'one two'; el.setSelectionRange(7, 7); });
  const at = (await box('README.md').boundingBox())!;
  await app.page.keyboard.press('Control+ArrowLeft');
  expect(await own.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(4);
  const now = (await box('README.md').boundingBox())!;
  expect([Math.round(now.x), Math.round(now.y)]).toEqual([Math.round(at.x), Math.round(at.y)]);
  await expect(box('README.md')).not.toHaveClass(/lifted/);
  await expect(own).toBeFocused();
});

test('nothing on the desk changes size: a piece pressed twice is as wide as it was, its letters 17 px; twice in its words chooses a word, as in any text', async ({app}) => {
  await app.rail.go('forge');
  const readme = app.forge.piece('README.md'), main = app.forge.piece('src/main.c'), own = app.forge.editor('README.md');
  const size = (piece: typeof readme) => piece.evaluate((el) => ({w: Math.round(el.getBoundingClientRect().width * 10) / 10, font: Math.round(parseFloat(getComputedStyle(el.querySelector('.code')!).fontSize) * 10) / 10}));
  await own.fill('one two\n');
  await own.press('Escape');
  expect(await size(readme)).toEqual({w: WIDTH, font: 17});
  const lies = async (piece: typeof main) => Math.round((await piece.boundingBox())!.x + await app.forge.desk.evaluate((d) => d.scrollLeft));
  const next = await lies(main);
  // On its numbers' margin, twice: as it was, and the piece after it where it was (before: twice as large).
  await readme.locator('.gutter').dblclick({position: {x: 6, y: 6}});
  await app.page.waitForTimeout(500);
  expect(await size(readme)).toEqual({w: WIDTH, font: 17});
  expect(await lies(main)).toBe(next);
  // In its words, twice chooses a word.
  await own.focus();
  const text = (await own.boundingBox())!;
  await app.page.mouse.dblclick(text.x + 20, text.y + 12);
  expect(await app.forge.selected('README.md')).toBe('one');
  // A piece not yet gone into, pressed twice: taken in hand, as pressed once, and no larger.
  await main.locator('.code').dblclick({position: {x: 30, y: 12}});
  await expect(main).toHaveClass(/held/);
  expect(await size(main)).toEqual({w: WIDTH, font: 17});
});

test('only the paper in hand is filled, casts a thin shadow and exposes Close; Prompt does not activate a second paper', async ({app}) => {
  await app.rail.go('forge');
  const term = app.main.locator('.forge-prompt-slot');
  const look = () => app.forge.desk.locator('.desk-box').evaluateAll((boxes) => boxes.map((b) => {
    const c = getComputedStyle(b), close = b.querySelector('.desk-close'), words = b.querySelector('.code')!;
    const r = b.getBoundingClientRect();
    return {key: (b as HTMLElement).dataset.key!, ground: c.backgroundColor, shadow: c.boxShadow,
      close: !!close && getComputedStyle(close).display !== 'none', words: getComputedStyle(words).color,
      inView: r.x >= 24 && r.right <= innerWidth};
  }));
  const quiet = (paper: Awaited<ReturnType<typeof look>>[number], ground = FORGE_GROUND) => {
    expect({ground: paper.ground, shadow: paper.shadow, close: paper.close, quieter: paper.words !== INK && paper.words !== TERMINAL_INK})
      .toEqual({ground, shadow: 'none', close: false, quieter: true});
  };
  for (const key of ['README.md', 'src/main.c']) {
    await app.forge.editor(key).focus();
    await expect(app.forge.piece(key)).toHaveClass(/held/);
    const all = await look(), hand = all.find((b) => b.key === key)!;
    expect(hand).toMatchObject({ground: PAPER, shadow: `${CAST} ${SHADOW}px ${SHADOW}px 0px 0px`, words: INK, close: true});
    const rest = all.filter((b) => b.key !== key);
    rest.forEach((paper) => quiet(paper));
    const other = rest.find((b) => b.inView)!;
    await app.forge.piece(other.key).hover({position: {x: 8, y: 8}});
    quiet((await look()).find((b) => b.key === other.key)!);
  }

  await app.forge.use('Prompt');
  await expect(app.forge.promptBox).toBeFocused();
  await expect(term.locator('.desk-term:visible')).toHaveCSS('background-color', TERMINAL_FACE);
  await expect(term).toHaveCSS('box-shadow', / 4px 4px 0px 0px$/);
  await expect(app.forge.promptBox).toHaveCSS('color', TERMINAL_INK);
  (await look()).forEach((paper) => quiet(paper));
  await app.page.keyboard.press('Escape');
  await expect(term).toBeHidden();
  await expect(app.forge.editor('src/main.c')).toBeFocused();
  await expect(app.forge.piece('src/main.c')).toHaveCSS('box-shadow', `${CAST} ${SHADOW}px ${SHADOW}px 0px 0px`);
});

test('Shift+N makes a new file beside the one in hand where nothing is being written; written in a file, it is an N', async ({app}) => {
  const main = app.forge.editor('src/main.c');
  await main.focus();
  const was = await main.inputValue();
  await app.page.keyboard.press('Shift+N');
  await expect(main).toHaveValue(new RegExp(`N`));
  await main.fill(was);
  // The keyboard out on the desk (Escape takes it there): Shift+N makes the file.
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Shift+N');
  // Its name written over at once in its head, as a new file's is; Enter keeps it and goes on into it.
  const field = app.main.getByRole('textbox', {name: 'New name', exact: true});
  await expect(field).toBeFocused();
  await expect(field).toHaveText('untitled.c');
  await app.page.keyboard.type('count');
  await app.page.keyboard.press('Enter');
  await expect(app.forge.editor('src/count.c')).toBeFocused();
});

test('Shift+N with the keyboard on the desk: a new file set down after the one in hand, on the row\'s line, named as it is', async ({app}) => {
  await app.rail.go('forge');
  const readme = app.forge.editor('README.md');
  await readme.focus();
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Shift+N');
  const field = app.main.getByRole('textbox', {name: 'New name', exact: true});
  await expect(field).toBeFocused();
  await expect(field).toHaveText('untitled.md');
  // Its stem chosen: what is typed is its name.
  expect(await field.evaluate(() => getSelection()!.toString())).toBe('untitled');
  const above = app.main.locator('.desk-box[data-key="README.md"]'), made = app.main.locator('.desk-box[data-key="untitled.md"]');
  await expect.poll(async () => {
    const [a, b] = [await above.boundingBox(), await made.boundingBox()];
    return a && b && Math.abs(a.y - b.y) < 1 && Math.abs(b.x - (a.x + a.width + GAP)) < 1 ? 'after' : 'not yet';
  }).toBe('after');
});

test('a line chosen from search closes the sheet and clears the field; summoned again, its words come back selected', async ({app}) => {
  await app.forge.find('puts');
  await app.forge.hit(/puts\("hello"\);/).click();
  await expect(app.forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => app.forge.lineChosen('src/main.c')).toBe('    puts("hello");');
  await expect(app.forge.search).toBeHidden();
  await expect(app.main.getByRole('searchbox', {name: 'Search this repo', exact: true, includeHidden: true})).toHaveValue('');
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('/');
  await expect(app.forge.search).toBeFocused();
  await expect(app.forge.search).toHaveValue('puts');
  expect(await app.forge.search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
  await expect(app.forge.hit(/puts\("hello"\);/)).toBeVisible();
});

test('Home says where one left off: the line last written in a box on the desk', async ({app}) => {
  await app.rail.go('forge');
  const own = app.forge.editor('README.md');
  await own.focus();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.type('\nWritten here last.');
  await app.page.waitForTimeout(300);
  await app.rail.go('home');
  await expect(app.main.getByRole('region', {name: 'Recent activity'}).getByRole('button').first()).toContainText('Written here last.');
});

test('a file dragged in from the desktop goes into the folder of the box it is let go over, never over one already there', async ({app}) => {
  const sheet = app.main.locator('.desk-file[data-path="src/main.c"]');
  await expect(sheet).toBeVisible();
  const drop = (names: string[]) => sheet.evaluate((el, names) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File([`dropped ${n}\n`], n, {type: 'text/plain'}));
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: dt}));
  }, names);
  await drop(['notes.txt']);
  await expect(app.forge.editor('src/notes.txt')).toHaveValue('dropped notes.txt\n');
  // The same name again: it comes in beside, as "notes (2).txt".
  await drop(['notes.txt']);
  await expect(app.forge.editor('src/notes (2).txt')).toHaveValue('dropped notes.txt\n');
  await expect(app.forge.editor('src/notes.txt')).toHaveValue('dropped notes.txt\n');
});

test('the keys an editor knows: Ctrl+K and Ctrl+P go to the search, Ctrl+` to the terminal\'s line', async ({app}) => {
  await app.forge.editor('README.md').focus();
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await app.forge.editor('README.md').focus();
  await app.page.keyboard.press('Control+p');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Control+Backquote');
  await expect(app.forge.promptBox).toBeFocused();
  await expect(app.main.locator('.forge-prompt-slot')).toHaveClass(/\bheld\b/);
});


test('Apple Option arrows pass through the editor and desk without rewriting text or cancelling native movement', async ({app}) => {
  const editor = app.forge.editor('README.md');
  await editor.fill('one two');
  await editor.focus();
  const observed = await editor.evaluate((area: HTMLTextAreaElement) => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {value: 'MacIntel', configurable: true});
    let inputs = 0;
    const changed = () => inputs++;
    area.addEventListener('input', changed);
    try {
      return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].flatMap((key) => [false, true].map((shiftKey) => {
        area.setSelectionRange(4, 4);
        const e = new KeyboardEvent('keydown', {key, altKey: true, shiftKey, bubbles: true, cancelable: true});
        area.dispatchEvent(e);
        return {key, shiftKey, prevented: e.defaultPrevented, value: area.value, inputs};
      }));
    } finally {
      area.removeEventListener('input', changed);
      if (original) Object.defineProperty(navigator, 'platform', original);
      else delete (navigator as unknown as {platform?: string}).platform;
    }
  });
  for (const result of observed) {
    expect(result.prevented, `${result.key}, shift=${result.shiftKey}`).toBe(false);
    expect(result.value).toBe('one two');
    expect(result.inputs).toBe(0);
  }
  // Synthetic events verify the app's handlers, not the OS's word movement. A macOS run still checks native
  // Option/Shift+Option selection and Undo with real key events.
});
