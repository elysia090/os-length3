import {expect, test} from './fixtures.ts';
import {EYE} from '../../root3/app/pages/forge/desk-layout.ts';

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
  // The room left of the numbers is the same line.
  await app.page.mouse.click(box.x - 6, box.y + 3.5 * height);
  await expect.poll(() => app.forge.selected('src/main.c')).toBe(lines[3]);
  // Below the text, as before: the caret at the end. (The file's foot brought into view first: the prompt box lies
  // over the center's foot, and what is under it is not the file's.)
  await app.main.locator('.desk-file[data-path="src/main.c"] .sheet').evaluate((e) => e.scrollIntoView({block: 'center'}));
  const sheet = (await app.main.locator('.desk-file[data-path="src/main.c"] .sheet').boundingBox())!;
  await app.page.mouse.click(sheet.x + sheet.width / 2, sheet.y + sheet.height - 8);
  expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([text.length, text.length]);
});

test('what was written is undone after going to Runtime and back, and to another repo and back; Redo writes it again', async ({app}) => {
  // The page's clock is the test's from before anything is written here, so the pause that saves is passed, not waited out.
  await app.page.clock.install();
  await app.newRepo.make('other');
  await app.rail.go('forge');
  const more = app.forge.band.getByRole('button', {name: /^Add all repos to band/});
  if (await more.isEnabled()) await more.click();
  await expect(app.forge.band.getByRole('button', {name: 'other', exact: true})).toBeVisible();
  await app.forge.band.getByRole('button', {name: 'hello', exact: true}).click();
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

  await app.forge.band.getByRole('button', {name: 'other', exact: true}).click();
  await expect(app.forge.editor('README.md')).toBeVisible();
  await app.forge.band.getByRole('button', {name: 'hello', exact: true}).click();
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

test('the right pane holds the runs alone; Issue, diff and Output are the search\'s, on the band, and what one opens goes back up once the keyboard is in the file', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nA line written in Forge, long enough to run on past the middle of its box.\n');
  const pane = app.main.getByRole('complementary', {name: 'Plugins and Prompt'});
  // Nothing in the pane says what else there is to see: no heads over its rows.
  await expect(pane.getByRole('group', {name: 'Search target'})).toHaveCount(0);
  await app.forge.show('diff');
  await expect(app.forge.results.getByRole('button', {name: /^README\.md/})).toBeVisible();
  // The search lies on the band, at its left, before the repos.
  const search = (await app.forge.search.boundingBox())!, band = (await app.forge.band.boundingBox())!;
  expect(search.x + search.width).toBeLessThan(band.x + 1);
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

test('the right pane put away gives the center the width; the search on the band and the switch at the foot stay where they are', async ({app}) => {
  await app.git.write('hello', 'Fix: the first');
  await app.rail.go('forge');
  await app.forge.show('Issue');
  await app.forge.reference.getByRole('button', {name: /#1 Fix：the first/}).click();
  await expect(app.forge.reference.getByRole('button', {name: 'Edit description'})).toBeVisible();
  const center = app.main.locator('.center');
  const wide = (await center.boundingBox())!.width;
  const box = (await app.forge.search.boundingBox())!;

  const foot = (await app.forge.paneSwitch.boundingBox())!;
  // The switch is at the foot, its middle level with the person's at the rail's foot.
  const me = (await app.me.button.boundingBox())!;
  expect(Math.abs(foot.y + foot.height / 2 - (me.y + me.height / 2))).toBeLessThan(1.5);

  await app.forge.paneSwitch.click();
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
  await expect(app.main.getByRole('complementary', {name: 'Plugins and Prompt'})).toBeHidden();
  expect((await center.boundingBox())!.width).toBeGreaterThan(wide + 200);
  // The search is the band's, not the pane's: it stays, and so does the switch, the way back. What was read under
  // the search goes up as the pane goes (nothing searched stays over the desk).
  const away = (await app.forge.search.boundingBox())!, footAway = (await app.forge.paneSwitch.boundingBox())!;
  expect(Math.abs(away.x - box.x)).toBeLessThan(1);
  expect(Math.abs(footAway.x - foot.x)).toBeLessThan(1);
  await expect(app.forge.results).toBeHidden();

  // Back: each where it was; and it stays as left when the page is opened again.
  await app.forge.paneSwitch.click();
  await expect(app.main.getByRole('complementary', {name: 'Plugins and Prompt'})).toBeVisible();
  const still = (await app.forge.search.boundingBox())!;
  expect(Math.abs(still.x - box.x)).toBeLessThan(1);
  expect(Math.abs(still.width - box.width)).toBeLessThan(1);
  await expect(app.forge.results).toBeHidden();
  await app.forge.paneSwitch.click();
  await app.page.reload();
  await app.settled();
  await app.rail.go('forge');
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
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

test('the plug opens a plain plugin area at the top of the center, and closes it', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  await expect(area).toBeHidden();
  await app.rail.button('plugin').click();
  await expect(area).toBeVisible();
  // With none installed it is a plain area, no words in it (issue #45).
  await expect(area).toBeEmpty();
  await expect(app.rail.button('plugin')).toHaveAttribute('aria-expanded', 'true');
  await app.rail.button('plugin').click();
  await expect(area).toBeHidden();
  // Home has the same right pane: the plug opens the area there, and the pane with it (issue #45).
  await app.rail.go('home');
  await app.page.getByRole('button', {name: 'Right pane'}).click();
  await expect(app.page.getByRole('button', {name: 'Right pane'})).toHaveAttribute('aria-expanded', 'false');
  await app.rail.button('plugin').click();
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  await expect(app.page.getByRole('button', {name: 'Right pane'})).toHaveAttribute('aria-expanded', 'true');
  await expect(area).not.toHaveAttribute('hidden');
  // Elsewhere it opens Forge with it out.
  await app.rail.go('runtime');
  await app.rail.button('plugin').click();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(area).toBeVisible();
});

test('the plug says the area is out only where it is, and Escape on it puts the area away', async ({app}) => {
  const area = app.main.getByRole('region', {name: 'Plugins', exact: true});
  const plug = app.rail.button('plugin');
  await plug.click();
  await expect(area).toBeVisible();
  // Runtime has no plugin area: the plug is not shown out there, and the area waits for Forge.
  await app.rail.go('runtime');
  await expect(plug).toHaveAttribute('aria-expanded', 'false');
  await app.rail.go('forge');
  await expect(area).toBeVisible();
  await expect(plug).toHaveAttribute('aria-expanded', 'true');
  await plug.focus();
  await plug.press('Escape');
  await expect(area).toBeHidden();
  await expect(plug).toHaveAttribute('aria-expanded', 'false');
});

test('the current repo\'s pill shows which part has the keyboard, in ground over its ink, and the ring is not cut', async ({app}) => {
  const pill = app.forge.band.locator('.pill[aria-current]');
  await pill.locator('.pill-close').focus();
  await app.page.keyboard.press('Shift+Tab');
  const name = pill.locator('.pill-name');
  await expect(name).toBeFocused();
  const ring = await name.evaluate((el) => { const s = getComputedStyle(el); return {color: s.outlineColor, style: s.outlineStyle}; });
  const ground = await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(ring).toEqual({color: ground, style: 'solid'});
  // Its scroller leaves room for the ring above and below the pill.
  const scroller = (await app.forge.band.locator('.pills').boundingBox())!;
  const at = (await pill.boundingBox())!;
  expect(at.y - scroller.y).toBeGreaterThanOrEqual(4);
});

test('the files tool on the band brings out the deeds for what is read now, under it in Forge, and does them there', async ({app}) => {
  // What is read now: the Makefile, gone to from File (the page opens at its first file, the README).
  await app.file.open('hello', 'Makefile');
  await app.rail.go('forge');
  // The tools first on the top line (>_, the files, the search), then the repos, ⊕ after them.
  const tools = app.forge.tools.getByRole('button');
  await expect(tools).toHaveCount(2);
  await expect(tools.first()).toHaveAccessibleName('Terminal');
  const files = tools.nth(1);
  await expect(files).toHaveAccessibleName('Files: New, Rename, Delete');
  await expect(app.forge.band.getByRole('button').last()).toHaveAccessibleName(/^Add all repos to band/);
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

test('the Prompt stands at the desk\'s foot: its line taken, what it printed stands on it and stays while a file is written in; pressed anywhere there, the caret is in its line; Escape and the band\'s >_ put it away', async ({app}) => {
  await app.rail.go('forge');
  const stand = app.page.locator('.desk-term.stand'), own = app.forge.editor('README.md');
  const tool = app.forge.tools.getByRole('button', {name: 'Terminal', exact: true});
  await own.focus();
  await expect(stand).not.toHaveClass(/\bup\b/);
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  // It stands under the desk, on plain ground: the desk (its dots, its boxes) ends above it, at rest and up.
  const apart = async () => {
    const [d, t] = [(await app.page.locator('.desk:not([hidden])').boundingBox())!, (await stand.boundingBox())!];
    return d.y + d.height <= t.y;
  };
  expect(await apart()).toBe(true);
  // Its line taken: up, the band's >_ on, the file in hand still in hand.
  await app.forge.promptBox.click();
  await expect(stand).toHaveClass(/\bup\b/);
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect(app.page.locator('.desk-box[data-key="README.md"]')).toHaveClass(/held/);
  expect(await apart()).toBe(true);
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
  // It stays up while the file is written in: what a run said is read beside the file it is about.
  await own.focus();
  await expect(stand).toHaveClass(/\bup\b/);
  // Pressed in its room (not on its line): the keyboard in its line.
  const box = (await stand.boundingBox())!;
  await app.page.mouse.click(box.x + box.width / 2, box.y + 6);
  await expect(app.forge.promptBox).toBeFocused();
  // Escape: put away, the keyboard back in the file.
  await app.page.keyboard.press('Escape');
  await expect(stand).not.toHaveClass(/\bup\b/);
  await expect(own).toBeFocused();
  // The band's >_ puts it up, the keyboard in its line, and away again.
  await tool.click();
  await expect(stand).toHaveClass(/\bup\b/);
  await expect(app.forge.promptBox).toBeFocused();
  await tool.click();
  await expect(stand).not.toHaveClass(/\bup\b/);
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
});

test('the Prompt\'s line is text alone, in the OS\'s body size on whole lines: no lamp, its prompt quiet until a shell is there; its × comes with what was printed, on that line\'s middle; 80 columns fit', async ({app}) => {
  await app.rail.go('forge');
  const stand = app.page.locator('.desk-term.stand'), chip = stand.locator('.prompt-chip'), shut = stand.locator('.term-shut');
  // 15 px on lines of 24: the box 52 high, its line a whole step of the grid (before: 14 px, a line 22.4, 50.4).
  const size = () => stand.evaluate((el) => {
    const line = el.querySelector('.prompt-in')!;
    return {box: el.getBoundingClientRect().height, line: line.getBoundingClientRect().height, font: getComputedStyle(line).fontSize};
  });
  expect(await size()).toEqual({box: 52, line: 24, font: '15px'});
  // No lamp, nothing lit: the prompt's own colour says whether a shell is there, quiet until one is.
  await expect(stand.locator('.prompt-chip > .lamp')).toBeHidden();
  const colour = () => chip.evaluate((el) => getComputedStyle(el).color);
  await expect(chip).not.toHaveAttribute('data-state', 'on');
  const quiet = await colour();
  // Its line taken with nothing printed: the same box, and no × (there is nothing to put away).
  await app.forge.promptBox.click();
  await expect(stand).toHaveClass(/\bup\b/);
  await expect(shut).toBeHidden();
  expect(await size()).toEqual({box: 52, line: 24, font: '15px'});
  // A line run: a shell is there, the prompt in its green; what it printed is 80 columns wide on one line.
  await app.forge.run('printf "%080d\\n" 7');
  const printed = stand.locator('.term-out .term-lines').first();
  await expect(printed).toHaveText(`${'0'.repeat(79)}7`);
  await expect(chip).toHaveAttribute('data-state', 'on');
  expect(await colour()).not.toBe(quiet);
  expect((await printed.boundingBox())!.height).toBe(24);
  // Its ×: with what was printed, on the first line's middle, as far in from the frame as the words are.
  await expect(shut).toBeVisible();
  const at = await stand.evaluate((el) => {
    const r = (q: string) => el.querySelector(q)!.getBoundingClientRect();
    const [x, mark, out] = [r('.term-shut'), r('.term-shut > *'), r('.term-out')];
    return {middle: x.top + x.height / 2 - out.top, right: out.right - mark.right, left: out.left - el.getBoundingClientRect().left};
  });
  expect(at.middle).toBeCloseTo(12, 0);
  expect(Math.abs(at.right)).toBeLessThanOrEqual(1);
  expect(at.left).toBe(18);
  // Put away, nothing of it stays on the line.
  await shut.click();
  await expect(stand).not.toHaveClass(/\bup\b/);
  await expect(shut).toBeHidden();
  expect(await size()).toEqual({box: 52, line: 24, font: '15px'});
});

test('the Prompt\'s line stays at the desk\'s foot while the desk is read: turned by the wheel or gone through by the keys, it is still there to press', async ({app}) => {
  await app.rail.go('forge');
  const dock = app.main.locator('.desk-term.stand .dock'), line = app.main.locator('.desk-term.stand .prompt-in');
  const desk = app.page.locator('.desk:not([hidden])');
  await app.forge.editor('README.md').click();
  // The desk turned by the wheel, then the keyboard out on it and an arrow: reading, as far as the old box could tell.
  const at = (await desk.boundingBox())!;
  await app.page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await app.page.mouse.wheel(0, 120);
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('ArrowDown');
  // (Stepped back, it was there but unseen, and a press went through it.)
  await expect(dock).not.toHaveClass(/resting/);
  expect(await dock.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await line.click();
  await expect(line).toBeFocused();
});

test('a box in sight pressed stays where it stands, the caret where it was pressed; looking along the desk takes no other box in hand while one is written in', async ({app}) => {
  await app.rail.go('forge');
  const box = (key: string) => app.page.locator(`.desk-box[data-key="${key}"]`);
  const where = async (key: string) => { const b = (await box(key).boundingBox())!; return [Math.round(b.x), Math.round(b.y)]; };
  await app.forge.editor('README.md').click();
  await expect(box('README.md')).toHaveClass(/held/);
  // The box under it, in sight: pressed in its text, it is in hand where it stands, and so is the one above.
  const main = app.forge.editor('src/main.c');
  const before = [await where('README.md'), await where('src/main.c')];
  const text = (await main.boundingBox())!;
  await app.page.mouse.click(text.x + 160, text.y + 30);
  await expect(box('src/main.c')).toHaveClass(/held/);
  await expect(main).toBeFocused();
  expect([await where('README.md'), await where('src/main.c')]).toEqual(before);
  // Written in, it stays the one in hand as the desk is turned under the wheel.
  const desk = (await app.page.locator('.desk:not([hidden])').boundingBox())!;
  await app.page.mouse.move(desk.x + desk.width / 2, desk.y + desk.height / 2);
  await app.page.mouse.wheel(0, 96);
  await expect.poll(async () => (await where('src/main.c'))[1]).toBe(before[1][1] - 96);
  await expect(box('src/main.c')).toHaveClass(/held/);
  await expect(main).toBeFocused();
});

test('the desk turns from its first file to its last: turned to its top the first file is at the top of the face, never half way down it; turned to its end the last one stands there, never bare ground', async ({app}) => {
  await app.rail.go('forge');
  const desk = app.page.locator('.desk:not([hidden])');
  await expect(desk.locator('.desk-plane > .desk-box')).not.toHaveCount(0);
  const at = () => desk.evaluate((d) => {
    const face = d.getBoundingClientRect();
    const tops = [...d.querySelectorAll<HTMLElement>('.desk-plane > .desk-box')].map((b) => Math.round(b.getBoundingClientRect().top - face.top));
    return {first: Math.min(...tops), last: Math.max(...tops), turned: [d.scrollLeft, d.scrollTop], room: [d.scrollWidth - d.clientWidth, d.scrollHeight - d.clientHeight]};
  });
  const face = (await desk.boundingBox())!;
  await app.page.mouse.move(face.x + face.width - 30, face.y + face.height / 2);
  // Turned up as far as it goes: the first file at the eye, at the top (before: half a face of bare ground over it,
  // the files beginning half way down).
  await app.page.mouse.wheel(0, -20000);
  await expect.poll(async () => (await at()).first).toBe(EYE);
  expect((await at()).turned).toEqual([0, 0]);
  // Turned down as far as it goes: the last file at the eye, or, the files all in sight from the top, not turned at
  // all (before: a face of bare ground under the last).
  await app.page.mouse.wheel(0, 20000);
  await expect.poll(async () => { const a = await at(); return a.room[1] === 0 ? a.first : a.last; }).toBe(EYE);
  // One column: nothing beside it to turn to.
  expect((await at()).room[0]).toBe(0);
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

test('Tab in a file is the text\'s, the indent written; out of the text an arrow or Tab takes the next box in hand and a letter goes into it; a box is not carried about: Ctrl and an arrow are the text\'s', async ({app}) => {
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
  // Out of the text, an arrow takes the next box down its column in hand, and back; Tab goes on to the next too.
  await app.page.keyboard.press('Escape');
  await expect(desk).toBeFocused();
  await app.page.keyboard.press('ArrowDown');
  await expect(box('src/main.c')).toHaveClass(/held/);
  await app.page.keyboard.press('ArrowUp');
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

test('a box put beside the desk is a second screen: the desk the left half, the box the right, both written in; another put there sends the first back; put back, it lies where it lay', async ({app}) => {
  await app.rail.go('forge');
  const room = app.page.locator('.desk-room'), side = app.page.locator('.desk-side');
  const box = (key: string) => app.page.locator(`.desk-box[data-key="${key}"]`);
  const main = app.forge.editor('src/main.c'), readme = app.forge.editor('README.md');
  const order = () => app.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('section.desk:not([hidden]) .desk-box')]
    .map((b) => ({key: b.dataset.key!, y: b.getBoundingClientRect().top})).sort((a, b) => a.y - b.y).map((b) => b.key));
  await main.focus();
  const before = await order();
  // Its button, beside its close: beside the desk, the keyboard still in it.
  await box('src/main.c').getByRole('button', {name: 'Put main.c beside', exact: true}).click();
  await expect(room).toHaveClass(/split/);
  await expect(side.locator('.desk-box')).toHaveAttribute('data-key', 'src/main.c');
  await expect(main).toBeFocused();
  // Two screens: the box now in hand on the desk and the one beside it, each in its half, neither over the other, as
  // wide as each other, their tops level.
  const left = app.page.locator('section.desk:not([hidden]) .desk-box.held');
  await expect.poll(async () => {
    const [l, r, c] = [(await left.boundingBox())!, (await box('src/main.c').boundingBox())!, (await room.boundingBox())!];
    return l.x >= c.x && l.x + l.width < r.x && r.x + r.width <= c.x + c.width + 1 && Math.abs(l.width - r.width) < 2 && Math.abs(l.y - r.y) < 2;
  }).toBe(true);
  // Both are written in where they stand.
  await readme.focus();
  await app.page.keyboard.type('L');
  await expect(readme).toHaveValue(/L/);
  await main.click();
  await app.page.keyboard.type('R');
  await expect(main).toHaveValue(/R/);
  await expect(room).toHaveClass(/split/);
  // Another put beside (Ctrl, Alt and →, the box in hand): the first goes back where it lay.
  await readme.focus();
  await app.page.keyboard.press('Control+Alt+ArrowRight');
  await expect(side.locator('.desk-box')).toHaveAttribute('data-key', 'README.md');
  await expect(side.locator('.desk-box')).toHaveCount(1);
  await expect(readme).toBeFocused();
  await expect(app.page.locator('section.desk:not([hidden]) .desk-box[data-key="src/main.c"]')).toHaveCount(1);
  // Put back (Ctrl, Alt and ← from it; its button says so too): one screen, the box where it lay, in hand, the keyboard in it.
  await expect(box('README.md').getByRole('button', {name: 'Put README.md back', exact: true})).toBeVisible();
  await app.page.keyboard.press('Control+Alt+ArrowLeft');
  await expect(room).not.toHaveClass(/split/);
  await expect(side).toBeHidden();
  await expect(box('README.md')).toHaveClass(/held/);
  await expect(readme).toBeFocused();
  expect(await order()).toEqual(before);
  // Kept as it was left: beside the desk again after a reload.
  await app.page.keyboard.press('Control+Alt+ArrowRight');
  await expect(side.locator('.desk-box')).toHaveAttribute('data-key', 'README.md');
  await app.page.reload();
  await expect(side.locator('.desk-box')).toHaveAttribute('data-key', 'README.md');
  await expect(room).toHaveClass(/split/);
  // A window too narrow for two boxes read side by side: one screen, the box back where it lay, and no box offers it.
  await app.page.setViewportSize({width: 900, height: 800});
  await expect(room).not.toHaveClass(/split/);
  await expect(side).toBeHidden();
  expect(await order()).toEqual(before);
  await expect(app.page.locator('.desk-aside').first()).toBeHidden();
  await app.page.setViewportSize({width: 1280, height: 800});
  // Its close, beside the desk: the file's box gone, the desk the whole face again.
  await box('README.md').click({position: {x: 100, y: 30}});
  await box('README.md').getByRole('button', {name: 'Put README.md beside', exact: true}).click();
  await expect(room).toHaveClass(/split/);
  await side.getByRole('button', {name: 'Close README.md', exact: true}).click();
  await expect(room).not.toHaveClass(/split/);
  await expect(box('README.md')).toHaveCount(0);
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

test('Shift+N from the Prompt\'s line put away, the keyboard on the desk: a new file under the one in hand, named as it is', async ({app}) => {
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
    return a && b && Math.abs(a.x - b.x) < 1 && b.y > a.y + a.height ? 'under' : 'not yet';
  }).toBe('under');
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

test('a pill dragged along the band lands where it is let go', async ({app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('forge');
  const more = app.forge.band.getByRole('button', {name: /^Add all repos to band/});
  if (await more.isEnabled()) await more.click();
  const names = () => app.forge.band.locator('.pill').evaluateAll((ps) => ps.map((p) => (p as HTMLElement).dataset.repo));
  const before = await names();
  const first = app.forge.band.locator('.pill').first(), last = app.forge.band.locator('.pill').last();
  const lb = (await last.boundingBox())!;
  await first.dragTo(last, {targetPosition: {x: lb.width - 4, y: lb.height / 2}});
  await expect.poll(names).toEqual([...before.slice(1), before[0]]);
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

test('the keys an editor knows: Ctrl+K and Ctrl+P go to the search, Ctrl+` to the prompt box, Ctrl+B puts the pane away and back', async ({app}) => {
  await app.forge.editor('README.md').focus();
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await app.forge.editor('README.md').focus();
  await app.page.keyboard.press('Control+p');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Control+Backquote');
  await expect(app.forge.promptBox).toBeFocused();
  await app.page.keyboard.press('Control+b');
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
  await app.page.keyboard.press('Control+b');
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'true');
});

