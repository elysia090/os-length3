import {expect, test} from './fixtures.ts';
import {BIG, GAP, GRID, PAD, SHADOW, TERM, TERM_GAP, TERM_HELD, TOP, WIDTH} from '../../root3/app/pages/forge/desk-layout.ts';

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
  await app.forge.search.focus();
  await expect(app.forge.hit(/Written in Forge/)).toContainText('6');
  await app.forge.hit(/Written in Forge/).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => app.forge.lineChosen('README.md')).toBe('Written in Forge.');

  // The word changed: it is no longer found, and the search keeps what was typed.
  await app.forge.editFile('README.md', '# hello\n\nWrote it in Forge.\n');
  await app.forge.search.focus();
  await expect(app.forge.results).toContainText('No results found for "Written"');
  await expect(app.forge.search).toHaveValue('Written');
});

test('a file found by its name is opened to write in from the keyboard alone, and Escape and / come back', async ({app}) => {
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

test('Forge has no pane: Issue, diff and Output are the search\'s, on the band before the name in hand, and what one opens goes back up once the keyboard is in the file', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nA line written in Forge, long enough to run on past the middle of its box.\n');
  // The page is the desk: nothing stands beside it, and nothing puts a pane away or brings one back.
  await expect(app.main.getByRole('complementary')).toHaveCount(0);
  await expect(app.main.getByRole('button', {name: 'Right pane', exact: true})).toHaveCount(0);
  await app.forge.show('diff');
  await expect(app.forge.results.getByRole('button', {name: /^README\.md/})).toBeVisible();
  // The search lies on the band, after its keys; the name of what is in hand is against the band's other end.
  const search = (await app.forge.search.boundingBox())!, held = (await app.main.locator('.band-held').boundingBox())!;
  expect(search.x + search.width).toBeLessThan(held.x + 1);
  // Back in the file (the sheet lies over the desk: the keyboard goes there, as Alt and an arrow take it) and written
  // in: nothing searched stays over the desk.
  const editor = app.forge.editor('README.md');
  await editor.focus();
  await app.page.keyboard.type('x');
  await expect(app.forge.results).toBeHidden();
  await expect(editor).toBeFocused();
  // A file's diff read from there goes the same way.
  await app.forge.show('diff');
  await app.forge.results.getByRole('button', {name: /^README\.md/}).click();
  await expect(app.forge.results.locator('.slide[aria-current="true"] > .found-card')).toBeVisible();
  await editor.focus();
  await expect(app.forge.results).toBeHidden();
  await expect(editor).toBeFocused();
});

test('a narrow window reaches the issues, the diff and the output from the search box, and Escape puts them away', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.page.setViewportSize({width: 552, height: 800});
  await expect(app.forge.results).toBeHidden();
  // Pressed, nothing drops yet (nothing is typed); ↓ lets down the kinds.
  await app.forge.search.click();
  await expect(app.forge.results).toBeHidden();
  await app.forge.search.press('ArrowDown');
  for (const part of ['Issue', 'diff', 'Output'] as const) await expect(app.forge.kind(part)).toBeVisible();
  await app.forge.openDiff('README.md');
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
  await app.forge.reference.getByRole('button', {name: /Revert README/}).focus();
  // Escape: from what is read back to the box, then everything under it away.
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.results).toBeHidden();
  // The search reaches a changed file's diff as well (diff still pressed: what is found is the changed files).
  await app.forge.search.click();
  await app.forge.search.fill('README');
  await app.forge.results.getByRole('button', {name: /^README\.md/}).click();
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
});

test('what is searched and read lines up sideways: the one in hand fills the box, its neighbours a sliver past its edges, pressed to move to them', async ({app}) => {
  await app.git.write('hello', 'Fix: the first written');
  await app.rail.go('forge');
  await app.forge.find('written');
  await app.forge.results.getByRole('button', {name: '#1 Fix：the first written', exact: true}).click();
  const issue = app.forge.reference.getByRole('heading', {name: /the first written/});
  await expect(issue).toBeVisible();
  // The search it came from is at its left, a sliver, and ← under the box: pressed, the search is in hand again, as typed.
  await expect(app.forge.results.locator('.found-here')).toHaveText(/^Issue\s*#1.*2 \/ 2$/);
  await app.forge.results.getByRole('button', {name: 'Search history written', exact: true}).click();
  const found = app.forge.results.getByRole('button', {name: '#1 Fix：the first written', exact: true});
  await expect(found).toBeVisible();
  await expect(app.forge.search).toHaveValue('written');
  await app.forge.results.getByRole('button', {name: /^Issue #1/}).click();
  await expect(issue).toBeVisible();
  // ← → along the line from the keyboard.
  await app.page.keyboard.press('ArrowLeft');
  await expect(found).toBeVisible();
  // Asked for with nothing typed (↓): what was searched and read, newest first.
  await app.forge.search.fill('');
  await app.forge.search.click();
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.results.locator('.found-item')).toHaveText([/^Issue\s*#1/, /^Search history\s*written$/]);
});

test('the plug opens a plain plugin area on Home, over what waits there, and closes it; Forge is all desk and has none, so from there it goes to Home with it out', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  await expect(area).toHaveCount(0);
  await app.rail.button('plugin').click();
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  await expect(area).toBeVisible();
  // With none installed it is a plain area, no words in it (issue #45).
  await expect(area).toBeEmpty();
  await expect(app.rail.button('plugin')).toHaveAttribute('aria-expanded', 'true');
  // On Home the plug opens and closes it there, Home staying.
  await app.rail.button('plugin').click();
  await expect(area).toBeHidden();
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  await app.rail.button('plugin').click();
  await expect(area).not.toHaveAttribute('hidden');
  await app.rail.button('plugin').click();
  await expect(area).toBeHidden();
  // Elsewhere it opens Home with it out.
  await app.rail.go('runtime');
  await app.rail.button('plugin').click();
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  await expect(area).toBeVisible();
});

test('the plug says the area is out only where it is, and Escape on it puts the area away', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  const plug = app.rail.button('plugin');
  await plug.click();
  await expect(area).toBeVisible();
  // Runtime has no plugin area: the plug is not shown out there, and the area waits for Home.
  await app.rail.go('runtime');
  await expect(plug).toHaveAttribute('aria-expanded', 'false');
  await app.rail.go('forge');
  await expect(plug).toHaveAttribute('aria-expanded', 'false');
  await app.rail.go('home');
  await expect(area).toBeVisible();
  await expect(plug).toHaveAttribute('aria-expanded', 'true');
  await plug.focus();
  await plug.press('Escape');
  await expect(area).toBeHidden();
  await expect(plug).toHaveAttribute('aria-expanded', 'false');
});

test('the files tool on the band brings out the deeds for what is read now, under it in Forge, and does them there', async ({app}) => {
  // What is read now: the Makefile, gone to from File (the page opens at its first file, the README).
  await app.file.open('hello', 'Makefile');
  await app.rail.go('forge');
  // The band's keys on the top line: >_, the files, then the search; no repo is listed there.
  const tools = app.forge.tools.getByRole('button');
  await expect(tools).toHaveCount(2);
  await expect(tools.first()).toHaveAccessibleName('Terminal');
  const files = tools.nth(1);
  await expect(files).toHaveAccessibleName('Files: New, Rename, Delete');
  await expect(app.main.getByRole('navigation', {name: 'repo'})).toHaveCount(0);
  await files.click();
  // Its menu, under it, here: File stays where it is.
  const menu = app.page.getByRole('menu', {name: 'Makefile', exact: true});
  await expect(menu).toBeVisible();
  await expect(app.file.tree).toBeHidden();
  await expect(menu.getByRole('menuitem')).toHaveText(['New file', 'New folder', 'Rename', 'Delete']);
  const under = (await files.boundingBox())!, at = (await menu.boundingBox())!;
  expect(at.y).toBeGreaterThan(under.y + under.height - 1);
  await expect(menu.getByRole('menuitem', {name: 'New file'})).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(files).toBeFocused();

  // A new file from there is made at once in the folder of the file read now, with its ending, and is the one to
  // work on; its name is written in its head.
  await app.file.open('hello', 'src/main.c');
  await app.rail.go('forge');
  await files.click();
  const near = app.page.getByRole('menu', {name: 'main.c', exact: true});
  await near.getByRole('menuitem', {name: 'New file'}).click();
  await expect(app.main.getByRole('textbox', {name: 'New name', exact: true})).toBeFocused();
  await expect(near).toBeHidden();
  await app.forge.rename('src/untitled.c', 'util.c');
  await expect(app.forge.editor('src/util.c')).toBeFocused();

  // Renamed (a path moves it), it is shown where it went.
  await files.click();
  const util = app.page.getByRole('menu', {name: 'util.c', exact: true});
  await util.getByRole('menuitem', {name: 'Rename'}).click();
  await util.getByRole('textbox').fill('lib/util.c');
  await util.getByRole('textbox').press('Enter');
  await expect(app.forge.editor('lib/util.c')).toBeVisible();
  await expect(app.file.tree).toBeHidden();
});

test('the terminal is the desk\'s first piece, a sheet of ink lying askew until it is in hand; a line is run with Enter, a note sent by the word at its end; pressed anywhere on it the caret is in its line, Escape puts the keyboard out on the desk, and the band\'s >_ takes its line', async ({app}) => {
  await app.rail.go('forge');
  const term = app.forge.piece('term'), stand = app.page.locator('.desk-term.stand'), own = app.forge.editor('README.md');
  const tool = app.forge.tools.getByRole('button', {name: 'Terminal', exact: true});
  // First in the row: every file lies right of it.
  expect((await app.forge.desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.key)))[0]).toBe('term');
  await own.focus();
  await expect(app.forge.piece('README.md')).toHaveClass(/held/);
  // At rest it lies turned to the left, ink, no name over it and nothing to close it by.
  const lying = () => term.evaluate((el) => { const c = getComputedStyle(el); return {rotate: c.rotate, ground: c.backgroundColor}; });
  expect(await lying()).toEqual({rotate: '-4deg', ground: 'rgb(23, 22, 20)'});
  await expect(term.locator('.desk-label, .desk-close')).toHaveCount(0);
  // Its line taken: in hand, square to the grid, the file no longer in hand.
  await app.forge.promptBox.click();
  await expect(term).toHaveClass(/held/);
  await expect(app.forge.piece('README.md')).not.toHaveClass(/held/);
  await expect.poll(async () => (await lying()).rotate).toBe('0deg');
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
  // The file gone back to: it is in hand, the terminal askew again, still there to be read.
  await own.focus();
  await expect(app.forge.piece('README.md')).toHaveClass(/held/);
  await expect.poll(async () => (await lying()).rotate).toBe('-4deg');
  await expect(stand).toBeVisible();
  // Pressed in its room (not on its line): the keyboard in its line.
  await term.click({position: {x: 120, y: 240}});
  await expect(app.forge.promptBox).toBeFocused();
  // Escape leaves its line as it leaves a text: the keyboard out on the desk, the terminal still in hand.
  await app.page.keyboard.press('Escape');
  await expect(app.forge.desk).toBeFocused();
  await expect(term).toHaveClass(/held/);
  // The band's >_ takes its line, the keyboard in it.
  await tool.click();
  await expect(app.forge.promptBox).toBeFocused();
  await expect(term).toHaveClass(/held/);
});

test('the terminal\'s words are its own green on ink, at the size one writes at on whole lines; no lamp, its prompt quieter until a shell is there; a line it printed breaks at its last column; nothing in it puts it away', async ({app}) => {
  await app.rail.go('forge');
  const term = app.forge.piece('term'), stand = app.page.locator('.desk-term.stand'), chip = stand.locator('.prompt-chip');
  await app.forge.promptBox.click();
  // In hand it is opened out: twenty-two cells wide and twenty lines tall, a cell over and under them; 14 px on
  // lines of 24, a whole step of the grid.
  const size = () => term.evaluate((el) => {
    const line = el.querySelector('.prompt-in')!, c = getComputedStyle(line);
    return {w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight, line: line.getBoundingClientRect().height, font: c.fontSize, colour: c.color};
  });
  expect(await size()).toEqual({w: TERM_HELD, h: 22 * GRID, line: 24, font: '14px', colour: 'rgb(155, 224, 191)'});
  // No lamp, nothing lit: the prompt's own colour says whether a shell is there, quieter until one is.
  await expect(stand.locator('.prompt-chip > .lamp')).toBeHidden();
  const colour = () => chip.evaluate((el) => getComputedStyle(el).color);
  await expect(chip).not.toHaveAttribute('data-state', 'on');
  const quiet = await colour();
  // A line run: a shell is there, the prompt in the full green; 80 letters printed break at the sheet's last column,
  // on whole lines.
  await app.forge.run('printf "%080d\\n" 7');
  const printed = stand.locator('.term-out .term-lines').first();
  await expect(printed).toHaveText(`${'0'.repeat(79)}7`);
  await expect(chip).toHaveAttribute('data-state', 'on');
  expect(await colour()).not.toBe(quiet);
  const tall = (await printed.boundingBox())!.height;
  expect(tall).toBeGreaterThan(24);
  expect(tall % 24).toBe(0);
  // The sheet is as it was (what it printed scrolls inside it), and nothing in it closes it.
  expect(await size()).toEqual({w: TERM_HELD, h: 22 * GRID, line: 24, font: '14px', colour: 'rgb(155, 224, 191)'});
  await expect(stand.locator('.term-shut')).toBeHidden();
});

test('the band\'s >_ brings the terminal back from wherever the desk is turned: its line is always a press away', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.forge.desk, term = app.forge.piece('term');
  // The last file taken in hand: the desk turns along its row to show it, the terminal out past its start.
  const keys = await desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.key!));
  await app.forge.editor(keys.at(-1)!).focus();
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBeGreaterThan(0);
  await app.forge.tools.getByRole('button', {name: 'Terminal', exact: true}).click();
  await expect(app.forge.promptBox).toBeFocused();
  await expect(term).toHaveClass(/held/);
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(0);
});

test('a piece in sight pressed is in hand where it lies, the caret where it was pressed; one cut by the window\'s edge is brought in by as little as shows it; a wheel over the bare ground turns the desk and takes nothing else in hand', async ({app}) => {
  await app.rail.go('forge');
  const box = (key: string) => app.forge.piece(key), desk = app.forge.desk;
  const where = async (key: string) => { const b = (await box(key).boundingBox())!; return [Math.round(b.x), Math.round(b.y)]; };
  await app.forge.promptBox.click();
  await expect(box('term')).toHaveClass(/held/);
  // The file beside it, in sight: pressed in its text, it is in hand where it lies and the desk is not turned; the
  // terminal, let go, closes to its size at rest a moment after (a second press may come first), and the files come
  // back along the row by what it gave up.
  const own = app.forge.editor('README.md');
  const before = await where('README.md');
  const text = (await own.boundingBox())!;
  await app.page.mouse.click(text.x + 60, text.y + 10);
  await expect(box('README.md')).toHaveClass(/held/);
  await expect(own).toBeFocused();
  expect(await where('README.md')).toEqual(before);
  await expect.poll(() => where('README.md')).toEqual([before[0] - (TERM_HELD - TERM), before[1]]);
  expect(await desk.evaluate((d) => d.scrollLeft)).toBe(0);
  // The last file is cut by the window's edge: taken in hand, the desk turns only as far as shows it and its shadow.
  const keys = await desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.key!));
  const last = keys.at(-1)!;
  await app.forge.editor(last).focus();
  await expect(box(last)).toHaveClass(/held/);
  await expect.poll(async () => {
    const [d, b] = [(await desk.boundingBox())!, (await box(last).boundingBox())!];
    return Math.round(d.x + d.width - (b.x + b.width));
  }).toBe(SHADOW + GRID);
  // Written in, it stays the one in hand as the desk is turned under the wheel over its bare ground.
  const face = (await desk.boundingBox())!, turned = await desk.evaluate((d) => d.scrollLeft);
  await app.page.mouse.move(face.x + face.width / 2, face.y + face.height - 12);
  await app.page.mouse.wheel(0, -96);
  await expect.poll(() => desk.evaluate((d) => d.scrollLeft)).toBe(turned - 96);
  await expect(box(last)).toHaveClass(/held/);
  await expect(app.forge.editor(last)).toBeFocused();
  // The desk is a row: it is never turned down.
  expect(await desk.evaluate((d) => d.scrollTop)).toBe(0);
});

test('the desk is a row on the grid: the terminal at the edge of the desk (opened out in hand), three cells before the first file, the files three cells apart, every top on one line; turned to its end the last sheet stands with its shadow and a cell of ground, never bare ground past it', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.forge.desk;
  await expect(desk.locator('.desk-plane > .desk-box')).not.toHaveCount(0);
  await app.forge.promptBox.click();
  await expect(app.forge.piece('term')).toHaveClass(/held/);
  const at = () => desk.evaluate((d) => {
    const face = d.getBoundingClientRect();
    const boxes = [...d.querySelectorAll<HTMLElement>('.desk-plane > .desk-box')].map((b) => { const r = b.getBoundingClientRect(); return {x: Math.round(r.left - face.left), y: Math.round(r.top - face.top), w: Math.round(r.width)}; });
    return {boxes, turned: [d.scrollLeft, d.scrollTop], room: [d.scrollWidth - d.clientWidth, d.scrollHeight - d.clientHeight], face: Math.round(face.width)};
  });
  // (The terminal in hand is square to the grid: its box is its sheet.)
  await expect.poll(async () => (await at()).boxes[0]).toEqual({x: PAD, y: TOP, w: TERM_HELD});
  const laid = await at();
  expect(laid.turned).toEqual([0, 0]);
  let x = PAD + TERM_HELD + TERM_GAP;
  for (const b of laid.boxes.slice(1)) { expect(b).toEqual({x, y: TOP, w: WIDTH}); x += WIDTH + GAP; }
  // Turned along as far as it goes: the last sheet, its shadow and a cell of ground, at the face's right edge.
  const face = (await desk.boundingBox())!;
  await app.page.mouse.move(face.x + face.width / 2, face.y + face.height - 12);
  await app.page.mouse.wheel(0, 20000);
  await expect.poll(async () => { const a = await at(); return a.turned[0] === a.room[0]; }).toBe(true);
  const end = await at(), last = end.boxes.at(-1)!;
  expect(end.room[0]).toBeGreaterThan(0);
  expect(last.x + last.w).toBe(end.face - SHADOW - GRID);
  // And back to its start; nothing lies under the row to turn down to.
  await app.page.mouse.wheel(0, -20000);
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
  // Out of the text, an arrow takes the next piece along the row in hand, and back (the terminal is the row's first);
  // Tab goes on to the next too.
  await app.page.keyboard.press('Escape');
  await expect(desk).toBeFocused();
  await app.page.keyboard.press('ArrowRight');
  await expect(box('src/main.c')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowLeft');
  await expect(box('README.md')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowLeft');
  await expect(box('term')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowRight');
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

test('a piece pressed twice on its margin is twice as large, its letters 28 px, the pieces after it making way; twice in the words one writes in chooses a word; Escape on the desk, or twice again, and it is its own size', async ({app}) => {
  await app.rail.go('forge');
  const readme = app.forge.piece('README.md'), main = app.forge.piece('src/main.c'), own = app.forge.editor('README.md');
  const size = () => readme.evaluate((el) => ({w: Math.round(el.getBoundingClientRect().width * 10) / 10, font: Math.round(parseFloat(getComputedStyle(el.querySelector('.code')!).fontSize) * 10) / 10}));
  await own.fill('one two\n');
  await own.press('Escape');
  expect(await size()).toEqual({w: WIDTH, font: 14});
  // (Where a piece lies on the desk, however far the desk is turned.)
  const lies = async (piece: typeof main) => Math.round((await piece.boundingBox())!.x + await app.forge.desk.evaluate((d) => d.scrollLeft));
  const next = await lies(main);
  // On its numbers' margin, twice: large, the piece after it moved along by what it grew; and it is the page's one
  // sheet, brought to the desk's own edge under the band's keys.
  await readme.locator('.gutter').dblclick({position: {x: 6, y: 6}});
  await expect(readme).toHaveClass(/big/);
  await expect.poll(size).toEqual({w: WIDTH * BIG, font: 28});
  await expect.poll(async () => await lies(main) - next).toBe(WIDTH * (BIG - 1));
  await expect.poll(async () => Math.round((await readme.boundingBox())!.x - (await app.forge.desk.boundingBox())!.x)).toBe(0);
  // In its words, the piece being the one written in, twice chooses a word: its size stays.
  await own.focus();
  const text = (await own.boundingBox())!;
  await app.page.mouse.dblclick(text.x + 20, text.y + 20);
  expect(await app.forge.selected('README.md')).toBe('one');
  await expect(readme).toHaveClass(/big/);
  // Out on the desk, Escape puts it back to its own size.
  await app.page.keyboard.press('Escape');
  await expect(app.forge.desk).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(readme).not.toHaveClass(/big/);
  await expect.poll(size).toEqual({w: WIDTH, font: 14});
  // A piece not yet gone into, pressed twice anywhere on it: taken in hand and made large; twice on its margin, back.
  await main.locator('.code').dblclick({position: {x: 30, y: 30}});
  await expect(main).toHaveClass(/held/);
  await expect(main).toHaveClass(/big/);
  await main.locator('.gutter').dblclick({position: {x: 6, y: 6}});
  await expect(main).not.toHaveClass(/big/);
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

test('a line chosen from the band\'s search: the box says Search again once the sheet is up, and its words come back chosen', async ({app}) => {
  await app.forge.find('puts');
  await app.forge.hit(/puts\("hello"\);/).click();
  await expect(app.forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => app.forge.lineChosen('src/main.c')).toBe('    puts("hello");');
  await expect(app.forge.search).toHaveValue('');
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
  await expect(app.forge.piece('term')).toHaveClass(/held/);
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
