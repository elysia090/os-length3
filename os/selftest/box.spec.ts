import {expect, test} from './fixtures.ts';
import type {Locator} from '@playwright/test';

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

/** Where in `file` (the editor of a mono file) the gap before column `col` of line `line` (from 1) is, on the screen. */
async function placeIn(file: Locator, line: number, col: number) {
  const r = (await file.boundingBox())!;
  const {lh, left, w} = await file.evaluate((a: HTMLTextAreaElement) => {
    const cs = getComputedStyle(a), c = document.createElement('canvas').getContext('2d')!;
    c.font = cs.font;
    return {lh: parseFloat(cs.lineHeight), left: parseFloat(cs.paddingLeft), w: c.measureText('m').width};
  });
  return {x: r.x + left + col * w, y: r.y + (line - .5) * lh + parseFloat(String(await file.evaluate((a) => getComputedStyle(a).paddingTop)))};
}

test('Edit: the box holds a line of the file, written there as in the file, and a text\'s own keys go along it', async ({app}) => {
  const box = app.forge.promptBox, page = app.page, file = app.forge.editor('src/main.c');
  const pill = app.main.getByRole('button', {name: /^What the box does/});
  const before = '#include <stdio.h>\n\nint main(void) {\n    puts("hello");\n    return 0;\n}\n';
  const thrown: string[] = [];
  page.on('pageerror', (e) => thrown.push(e.message));
  await expect(file).toHaveValue(before);
  // Written in, the file is the one in front; Ctrl+G brings the box to it, holding the caret's line.
  await file.click();
  await page.keyboard.press('Control+g');
  await expect(box).toBeFocused();
  await expect(pill).toHaveAccessibleName('What the box does: Edit');
  // A line pressed while the box has the keyboard comes into it, the caret where it was pressed.
  const at = await placeIn(file, 5, 13);
  await page.mouse.click(at.x, at.y);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('    return 0;');
  await expect(pill).toContainText('main.c:5');
  // ↑: the line above. What is typed is in the file as it is typed.
  await box.press('ArrowUp');
  await expect(box).toHaveValue('    puts("hello");');
  await box.press('End');
  await box.pressSequentially(' // say it');
  await expect(file).toHaveValue(before.replace('puts("hello");', 'puts("hello"); // say it'));
  // Enter breaks the line: the box goes on to the new one, which keeps the indent.
  await box.press('Enter');
  await expect(box).toHaveValue('    ');
  await box.pressSequentially('fflush(stdout);');
  const two = before.replace('puts("hello");', 'puts("hello"); // say it\n    fflush(stdout);');
  await expect(file).toHaveValue(two);
  await expect(pill).toContainText('main.c:5');
  // Backspace at the start joins the line to the one above; Ctrl+Z takes it back.
  await box.press('Home');
  await box.press('Backspace');
  await expect(file).toHaveValue(two.replace('it\n    fflush', 'it    fflush'));
  await box.press('Control+z');
  await expect(file).toHaveValue(two);
  // Escape: the keyboard back in the file.
  await box.press('Escape');
  await expect(file).toBeFocused();
  await expect(page.locator('.edit-marks')).toHaveCount(0);
  // Written as typing is: saved.
  await expect(app.forge.fileState('src/main.c')).toBeHidden();
  expect(thrown).toEqual([]);
  await page.reload();
  await expect(app.forge.editor('src/main.c')).toHaveValue(two);
});

test('Edit: words marked on a line come into the box chosen, and what is typed writes over them', async ({app}) => {
  const box = app.forge.promptBox, page = app.page, file = app.forge.editor('src/main.c');
  const before = '#include <stdio.h>\n\nint main(void) {\n    puts("hello");\n    return 0;\n}\n';
  await file.click();
  await page.keyboard.press('Control+g');
  await expect(box).toBeFocused();
  // Drawn across "hello" on line 4.
  const a = await placeIn(file, 4, 10), b = await placeIn(file, 4, 15);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, {steps: 6});
  await page.mouse.up();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('hello');
  expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
  await page.keyboard.type('world');
  await expect(file).toHaveValue(before.replace('hello', 'world'));
  // Enter: the box goes on to the whole line the words are on.
  await box.press('Enter');
  await expect(box).toHaveValue('    puts("world");');
});
