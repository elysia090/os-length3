import {expect, test} from './fixtures.ts';

// Working in Forge without losing anything (issue #20): Tab moves lines in
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

test('Tab moves the selected lines in, keeps them selected, and one Undo takes it back before and after it is saved', async ({app}) => {
  // The page's clock is the test's from before anything is written here, so the pause that saves is passed, not waited out.
  await app.page.clock.install();
  const editor = app.forge.editor('README.md');
  const cases: {name: string; text: string; start: number; end: number; direction?: 'backward'; after: string}[] = [
    {name: 'a caret', text: 'ab\ncd\n', start: 1, end: 1, after: 'a\tb\ncd\n'},
    {name: 'part of a line', text: 'one two\nthree\n', start: 4, end: 7, after: '\tone two\nthree\n'},
    {name: 'two whole lines', text: 'one\ntwo\nthree\n', start: 0, end: 7, after: '\tone\n\ttwo\nthree\n'},
    {name: 'two lines selected backwards', text: 'one\ntwo\nthree\n', start: 1, end: 6, direction: 'backward', after: '\tone\n\ttwo\nthree\n'},
    {name: 'a selection ending in a newline', text: 'one\ntwo\nthree\n', start: 0, end: 8, after: '\tone\n\ttwo\nthree\n'},
  ];
  for (const c of cases) {
    await editor.fill(c.text);
    await editor.evaluate((el: HTMLTextAreaElement, c) => { el.focus(); el.setSelectionRange(c.start, c.end, c.direction ?? 'forward'); }, c);
    await editor.press('Tab');
    const done = await state(app, 'README.md');
    expect(done.text, c.name).toBe(c.after);
    // What was selected is still selected, moved with its lines.
    expect(done.text.slice(done.start, done.end).replaceAll('\t', ''), c.name).toBe(c.text.slice(c.start, c.end));
    if (c.direction) expect(done.direction, c.name).toBe('backward');
    await editor.press('Control+z');
    expect(await state(app, 'README.md'), c.name).toMatchObject({text: c.text, start: c.start, end: c.end});
  }
  // Saved in between (a pause in writing saves it): Undo and Redo still go both ways.
  await editor.fill('one\ntwo\n');
  await editor.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 7); });
  await editor.press('Tab');
  await app.page.clock.runFor(700);
  await expect(app.forge.fileState('README.md')).toBeHidden();
  await editor.press('Control+z');
  expect(await state(app, 'README.md')).toMatchObject({text: 'one\ntwo\n', start: 0, end: 7});
  await editor.press('Control+Shift+z');
  expect((await state(app, 'README.md')).text).toBe('\tone\n\ttwo\n');
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
  await expect.poll(() => app.forge.selected('README.md')).toBe('Written in Forge.');

  // The word changed: it is no longer found, and the search keeps what was typed.
  await app.forge.editFile('README.md', '# hello\n\nWrote it in Forge.\n');
  await app.forge.search.focus();
  await expect(app.forge.results).toContainText('No results found for "Written"');
  await expect(app.forge.search).toHaveValue('Written');
});

test('a file found by its name is opened to write in from the keyboard alone, and Escape and Shift+Tab come back', async ({app}) => {
  await app.forge.search.fill('main.c');
  await expect(app.forge.results.getByRole('button', {name: 'src/main.c', exact: true})).toBeVisible();
  // Enter takes the first found: the file found by its name, with the caret in it.
  await app.forge.search.press('Enter');
  await expect(app.forge.editor('src/main.c')).toBeFocused();
  expect(await app.forge.editor('src/main.c').evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);

  // ↓ walks what was found; Escape goes back up to the box.
  await app.page.keyboard.press('Escape');
  await app.page.keyboard.press('Shift+Tab');
  await app.page.keyboard.press('Shift+Tab');
  await expect(app.forge.search).toBeFocused();
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.results.getByRole('button', {name: 'src/main.c', exact: true})).toBeFocused();
  await app.page.keyboard.press('ArrowDown');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toBeFocused();
  await expect(app.forge.search).toHaveValue('main.c');
});

test('Enter in the search opens the first line found, selected; a file found by its lines is headed by how many, its diff apart and not a stop', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.forge.find('Written');
  // The head: its name, how many of its lines were found, and at its other end its diff, pressed rather than gone along.
  const head = app.forge.results.locator('.hit-head', {hasText: 'README.md'});
  await expect(head).toContainText('1 line');
  await expect(head.getByRole('button', {name: 'Diff of README.md'})).toContainText(/^diff\s*\+\d+/);
  await app.forge.search.press('ArrowDown');
  await expect(app.forge.hit(/Written in Forge/)).toBeFocused();
  await app.page.keyboard.press('ArrowUp');
  await expect(app.forge.search).toBeFocused();
  await app.forge.search.press('Enter');
  await expect(app.forge.editor('README.md')).toBeFocused();
  await expect.poll(() => app.forge.selected('README.md')).toBe('Written in Forge.');
});

test('at rest the right pane says Issue, diff, Output and Agent beside the Prompt\'s head; what one opens goes back up once the keyboard is in the file', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nA line written in Forge, long enough to run on past the middle of its box.\n');
  const heads = app.main.getByRole('complementary', {name: 'Plugins and Prompt'}).getByRole('group', {name: 'Search target'});
  const diff = heads.getByRole('button', {name: /^diff/});
  // diff says how many files are changed since the last commit.
  await expect(heads.getByRole('button')).toHaveText(['Issue', /^diff\s*\d+$/, 'Output', 'Agent']);
  await diff.click();
  await expect(diff).toHaveAttribute('aria-pressed', 'true');
  await expect(app.forge.kind('diff')).toHaveAttribute('aria-pressed', 'true');
  await expect(app.forge.results.getByRole('button', {name: /^README\.md/})).toBeVisible();
  // Back in the file and written in: nothing searched stays over the pane, and the head is let go.
  const editor = app.forge.editor('README.md');
  await editor.click({position: {x: 40, y: 20}});
  await app.page.keyboard.type('x');
  await expect(app.forge.results).toBeHidden();
  await expect(editor).toBeFocused();
  await expect(diff).toHaveAttribute('aria-pressed', 'false');
  // A file's diff read from there goes the same way.
  await diff.click();
  await app.forge.results.getByRole('button', {name: /^README\.md/}).click();
  await expect(app.forge.results.locator('.slide[aria-current="true"] > .found-card')).toBeVisible();
  await editor.click({position: {x: 40, y: 20}});
  await expect(app.forge.results).toBeHidden();
  await expect(editor).toBeFocused();
  // Agent's: what was asked of it here. Escape puts it away.
  const agent = heads.getByRole('button', {name: 'Agent'});
  await agent.click();
  await expect(app.forge.results).toContainText('Nothing asked of the Agent yet');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.results).toBeHidden();
  await expect(agent).toHaveAttribute('aria-pressed', 'false');
});

test('the right pane put away gives the center the width and takes the search with it; brought back, both are where they were', async ({app}) => {
  await app.git.write('hello', 'Fix: the first');
  await app.rail.go('forge');
  await app.forge.show('Issue');
  await app.forge.reference.getByRole('button', {name: /#1 Fix：the first/}).click();
  await expect(app.forge.reference.getByRole('button', {name: 'Edit description'})).toBeVisible();
  const center = app.main.locator('.center');
  const wide = (await center.boundingBox())!.width;
  const box = (await app.forge.search.boundingBox())!;

  await app.forge.paneSwitch.click();
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
  await expect(app.main.getByRole('complementary', {name: 'Plugins and Prompt'})).toBeHidden();
  expect((await center.boundingBox())!.width).toBeGreaterThan(wide + 200);
  // The search goes with the pane (issue #45); the switch stays, the way back.
  await expect(app.forge.search).toBeHidden();
  await expect(app.forge.paneSwitch).toBeVisible();

  // Back: the search where it was, what was read under it gone up with the pane (nothing searched stays over it, to
  // come back covering what the pane says); and it stays as left when the page is opened again.
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
  await app.forge.search.click();
  for (const part of ['Issue', 'diff', 'Output'] as const) await expect(app.forge.kind(part)).toBeVisible();
  await app.forge.openDiff('README.md');
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
  await app.forge.reference.getByRole('button', {name: /Revert README/}).focus();
  // Escape: from what is read back to the box, then everything under it away.
  await app.page.keyboard.press('Escape');
  await expect(app.forge.search).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.forge.results).toBeHidden();
  // The search reaches a changed file's diff as well (diff, still pressed, let go: what is found is every kind again).
  await app.forge.search.click();
  await app.forge.kind('diff').click();
  await app.forge.search.fill('README');
  await app.forge.results.getByRole('button', {name: 'Diff of README.md'}).click();
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
});

test('what is searched and read lines up sideways: the one in hand fills the box, its neighbours a sliver past its edges, pressed to move to them', async ({app}) => {
  await app.forge.editFile('README.md', '# hello\n\nWritten in Forge.\n');
  await app.forge.find('Written');
  await app.forge.results.getByRole('button', {name: 'Diff of README.md'}).click();
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
  // The search it came from is at its left, a sliver, and ← under the box: pressed, the search is in hand again, as typed.
  await expect(app.forge.results.locator('.found-here')).toHaveText(/^diff\s*README\.md\s*2 \/ 2$/);
  await app.forge.results.getByRole('button', {name: 'Search history Written', exact: true}).click();
  await expect(app.forge.hit(/Written in Forge/)).toBeVisible();
  await expect(app.forge.search).toHaveValue('Written');
  await app.forge.results.getByRole('button', {name: 'diff README.md', exact: true}).click();
  await expect(app.forge.diffLine('Written in Forge.')).toBeVisible();
  // ← → along the line from the keyboard.
  await app.page.keyboard.press('ArrowLeft');
  await expect(app.forge.hit(/Written in Forge/)).toBeVisible();
  // Pressed with nothing typed: what was searched and read, newest first.
  await app.forge.search.fill('');
  await app.forge.search.click();
  await expect(app.forge.results.locator('.found-item')).toHaveText([/^diff\s*README\.md$/, /^Search history\s*Written$/]);
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

test('the band\'s first button brings out the deeds for what is read now, under it in Forge, and does them there', async ({app}) => {
  // What is read now: the Makefile, gone to from File (the page opens at its first file, the README).
  await app.file.open('hello', 'Makefile');
  await app.rail.go('forge');
  const band = app.forge.band;
  // The files button first, ⊕ after the repos.
  const buttons = band.getByRole('button');
  const files = buttons.first();
  await expect(files).toHaveAccessibleName('Files: New, Rename, Delete');
  await expect(buttons.last()).toHaveAccessibleName(/^Add all repos to band/);
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
  await expect(app.forge.editor('src/untitled.c')).toBeFocused();
  await expect(near).toBeHidden();
  await app.forge.rename('src/untitled.c', 'src/util.c');
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

test('pressed anywhere in the Prompt\'s box, beside its line too, it comes close and the caret goes into its line', async ({app}) => {
  await app.rail.go('forge');
  // Stepped back to the whole desk, the Prompt's box pressed in its room (not on its line).
  await app.page.locator('.desk:not([hidden])').evaluate((d: HTMLElement) => d.focus());
  await app.page.keyboard.press('Escape');
  await expect(app.page.locator('.desk:not([hidden])')).toHaveClass(/whole/);
  const term = app.page.locator('.desk-box[data-key="term"]');
  const box = (await term.boundingBox())!;
  await app.page.mouse.click(box.x + 8, box.y + 8);
  await expect(app.forge.promptBox).toBeFocused();
  await expect(app.page.locator('.desk:not([hidden])')).not.toHaveClass(/whole/);
});

test('Home says where one left off: the line last written in a box on the desk', async ({app}) => {
  await app.rail.go('forge');
  const own = app.forge.editor('README.md');
  await own.focus();
  await app.page.keyboard.press('Control+End');
  await app.page.keyboard.type('\nWritten here last.');
  await app.page.waitForTimeout(300);
  await app.rail.go('home');
  await expect(app.main.locator('.lately-row').first()).toContainText('Written here last.');
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

