import {expect, test} from './fixtures.ts';

// The box at the foot does more than run: its pill says what it does and, pressed, brings out the four it can
// (box-modes.ts), Edit among them (edit-box.ts). None of it needs the Prompt running.

// Each test opens the app on 'hello', made from C's files once for the worker and kept (fixtures.ts, helloC).
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.beforeEach(async ({app}) => {
  await app.newRepo.openInForge();
});

test('the box\'s pill chooses what the box does: an issue written there is the repo\'s next, a line for TODO is on Home', async ({app}) => {
  const box = app.forge.promptBox, said = app.main.locator('.box-said');
  const pill = app.main.getByRole('button', {name: /^What the box does/});
  await expect(pill).toHaveAccessibleName('What the box does: Run');
  // Pressed, it brings out the three; Issue chosen, the pill is the repo's next issue and the keyboard is in the box.
  await pill.click();
  await app.main.getByRole('menuitemradio', {name: /Write an issue/}).click();
  await expect(pill).toHaveAccessibleName('What the box does: Create');
  await expect(pill).toHaveText('hello #1', {useInnerText: true});
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('placeholder', 'Write an issue in hello');
  // Written in for an issue, it stays the box: only Run brings the Prompt up over the center.
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(0);
  await box.fill('Feat: A trellis for the tomatoes\nSix feet, of bamboo.');
  await box.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect(said).toHaveText('Written as #1 in hello');
  await expect(pill).toHaveText('hello #2', {useInnerText: true});
  // Alt+3 from the box: TODO, at once.
  await box.press('Alt+3');
  await expect(pill).toHaveAccessibleName('What the box does: Add');
  await box.fill('Water the basil at eleven');
  await box.press('Control+Enter');
  await expect(said).toHaveText('Added to TODO');
  // Ctrl+` is the Prompt's, so the box runs again.
  await app.page.keyboard.press('Control+Backquote');
  await expect(pill).toHaveAccessibleName('What the box does: Run');
  await app.rail.go('git');
  await expect(app.git.issue('#1 Feat：A trellis for the tomatoes')).toBeVisible();
  await app.rail.go('home');
  await expect(app.home.title(app.home.items.first())).toHaveValue('Water the basil at eleven');
  await expect(app.home.todo).toContainText('1 of 1 left');
});

test('what the box writes comes into the Prompt\'s flow as it came, and pressed opens where it stands', async ({app}) => {
  const box = app.forge.promptBox;
  const flow = app.page.locator('.work.bench:not([hidden]) .term-out');
  await box.click();
  await box.press('Alt+2');
  await box.fill('Fix: The table wraps on a phone');
  await box.press('Control+Enter');
  await box.press('Alt+3');
  await box.fill('Water the mint');
  await box.press('Control+Enter');
  await box.press('Escape');
  // Each a line of its own, in the order written, before the prompt line the shell waits at.
  const issue = flow.getByRole('button', {name: '#1 Fix：The table wraps on a phone'});
  const todo = flow.getByRole('button', {name: 'TODO Water the mint'});
  await expect(issue).toBeVisible();
  await expect(todo).toBeVisible();
  // Written before the shell was up or after, they stand before the line it waits at.
  await expect.poll(() => flow.evaluate((el) => el.textContent!.replace(/\u2063/g, '').trimEnd().split('\n').slice(-3)), {timeout: 60_000}).toEqual(
    ['#1 Fix：The table wraps on a phone', 'TODO Water the mint', 'hello $']);

  // The TODO: its mark, done right there, and Home's list has it done; the page stays Forge.
  await todo.click();
  const card = app.page.getByRole('dialog', {name: 'TODO'});
  await card.getByRole('button', {name: 'Mark as done'}).click();
  await expect(card.getByRole('button', {name: 'Mark as not done'})).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(todo).toBeFocused();

  // The issue: its summary written right there, kept as the card goes; Git is the card's last deed, at the issue.
  await issue.click();
  const sheet = app.page.getByRole('dialog', {name: '#1'});
  await sheet.getByRole('textbox', {name: 'Summary'}).fill('At 320 px, the last column goes under.');
  await app.page.keyboard.press('Escape');
  await issue.click();
  await expect(app.page.getByRole('dialog', {name: '#1'}).getByRole('textbox', {name: 'Summary'})).toHaveValue('At 320 px, the last column goes under.');
  await app.page.getByRole('dialog', {name: '#1'}).getByRole('button', {name: 'Open in Git'}).click();
  await expect(app.git.issue('#1 Fix：The table wraps on a phone')).toBeVisible();
  await app.rail.go('home');
  await expect(app.home.todo).toContainText('0 of 1 left');
});

test('the Prompt up over the center is put back by its ×, as by Escape', async ({app}) => {
  const box = app.forge.promptBox;
  await box.click();
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(1);
  await app.page.locator('.work.bench:not([hidden]) .term-shut').click();
  await expect(app.page.locator('.work.bench.prompting')).toHaveCount(0);
  await expect(box).not.toBeFocused();
  // Down, there is no × to press.
  await expect(app.page.locator('.work.bench:not([hidden]) .term-shut')).toBeHidden();
});

test('Edit: a line in the box edits the file in front, shown on it first, done with Enter, Ctrl+Z taking it back', async ({app}) => {
  const box = app.forge.promptBox, page = app.page, file = app.forge.editor('src/main.c');
  const pill = app.main.getByRole('button', {name: /^What the box does/}), note = app.main.locator('.prompt-note');
  const before = '#include <stdio.h>\n\nint main(void) {\n    puts("hello");\n    return 0;\n}\n';
  await expect(file).toHaveValue(before);
  // Written in, the file is the one in front; Ctrl+G brings the box to it, saying what can be written there.
  await file.click();
  await page.keyboard.press('Control+g');
  await expect(box).toBeFocused();
  await expect(pill).toHaveAccessibleName('What the box does: Apply');
  await expect(note).toContainText('to the line');
  await box.fill('4');
  await box.press('Enter');
  await expect(pill).toContainText('main.c:4');
  await expect(box).toHaveValue('');
  // What it would do is said (and drawn on the file) before Enter does it; nothing is written until then.
  await box.fill('puts → printf');
  await expect(note).toHaveText('1 to write as “printf”');
  await expect(page.locator('.edit-marks .edit-mark.gone')).toHaveCount(1);
  await expect(file).toHaveValue(before);
  await box.press('Enter');
  await expect(file).toHaveValue(before.replace('puts', 'printf'));
  // A line under the caret's, as indented as it is; the box is ready for the next.
  await box.fill('+ return 1;');
  await box.press('Enter');
  await expect(box).toHaveValue('+ ');
  await expect(file).toHaveValue(before.replace('puts', 'printf').replace('    return 0;', '    return 1;\n    return 0;'));
  await expect(pill).toContainText('main.c:5');
  // What the box did, taken back from the empty box one at a time, and put back.
  await box.fill('');
  await box.press('Control+z');
  await expect(file).toHaveValue(before.replace('puts', 'printf'));
  await box.press('Control+Shift+z');
  await expect(file).toHaveValue(/return 1;/);
  await box.press('Control+z');
  await expect(file).toHaveValue(before.replace('puts', 'printf'));
  // Escape, in the empty box: the keyboard back in the file.
  await box.press('Escape');
  await expect(file).toBeFocused();
  await expect(page.locator('.edit-marks')).toHaveCount(0);
  // Written as typing is: saved.
  await expect(app.forge.fileState('src/main.c')).toBeHidden();
  await page.reload();
  await expect(app.forge.editor('src/main.c')).toHaveValue(before.replace('puts', 'printf'));
});

test('Edit: a line of the file pressed comes into the box as it is, written anew there and put back with Enter', async ({app}) => {
  const box = app.forge.promptBox, page = app.page, file = app.forge.editor('src/main.c');
  const note = app.main.locator('.prompt-note');
  const before = '#include <stdio.h>\n\nint main(void) {\n    puts("hello");\n    return 0;\n}\n';
  await file.click();
  await page.keyboard.press('Control+g');
  await expect(note).toContainText('Click a line');
  // Pressed while the box has the keyboard: the line comes into the box, which keeps the keyboard.
  const r = (await file.boundingBox())!, lh = await file.evaluate((a) => parseFloat(getComputedStyle(a).lineHeight));
  await page.mouse.click(r.x + r.width - 8, r.y + 4.5 * lh);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('    return 0;');
  await expect(note).toHaveText('Line 5: write it anew here, Enter puts it back');
  // ↑, nothing written in it yet: the line above instead.
  await box.press('ArrowUp');
  await expect(box).toHaveValue('    puts("hello");');
  await box.fill('    puts("hello, world");');
  await expect(file).toHaveValue(before);
  await box.press('Enter');
  await expect(file).toHaveValue(before.replace('"hello"', '"hello, world"'));
  await expect(box).toHaveValue('');
  await expect(note).toHaveText('Line 4 written');
  // Escape lets a line taken go as it was.
  await page.mouse.click(r.x + r.width - 8, r.y + 4.5 * lh);
  await box.fill('gone');
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(file).toHaveValue(before.replace('"hello"', '"hello, world"'));
  // What the box wrote is taken back from the empty box, as any of its edits.
  await box.press('Control+z');
  await expect(file).toHaveValue(before);
});
