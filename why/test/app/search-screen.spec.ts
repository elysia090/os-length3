import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';
import {App} from './app.ts';

/** The title's offset is independent of the centered field, candidate depth and screen size. */
async function expectHeadingOffset(screen: Locator) {
  const offset = await screen.evaluate((el) => {
    const title = el.querySelector('h1')!, paper = el.querySelector('.search-screen-paper')!;
    const words = document.createRange();
    words.selectNodeContents(title);
    const ink = words.getBoundingClientRect(), box = paper.getBoundingClientRect();
    return (ink.x + ink.width / 2) - (box.x + box.width / 2);
  });
  expect(offset, 'Search heading sits 14.4 px left of the centered field').toBeCloseTo(-14.4, 1);
}

const paintedWord = (editor: Locator) => editor.locator('..').locator('.desk-match');
async function paintedLine(editor: Locator) {
  return editor.evaluate((area: HTMLTextAreaElement) => {
    const word = area.parentElement?.querySelector<HTMLElement>('.desk-match');
    return word ? area.value.split('\n')[Number(word.dataset.line) - 1] ?? null : null;
  });
}

test('Search is a separate history step, with the work kept and the matched line opened in Forge', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('corner');
  const editor = forge.editor('README.md'), previous = page.locator('#page');
  const lens = app.main.getByRole('button', {name: 'Search', exact: true});
  const screen = page.getByRole('main', {name: 'Search', exact: true});
  const input = screen.getByRole('searchbox', {name: 'Search this repo'});
  const port = previous.locator('.desk-file[data-path="README.md"]');
  const data = Array.from({length: 110}, (_, n) => n === 16 ? 'Needle first.' : n === 94 ? 'Needle last.' : `Notes on item ${n+1}.`).join('\n');
  await forge.editFile('README.md', data);
  await expect(input).toHaveCount(0);
  await expect(lens).toBeVisible();
  await editor.focus();
  await editor.press('End');
  await page.keyboard.insertText(' draft');
  const working = await editor.inputValue();
  await editor.evaluate((el: HTMLTextAreaElement, first) => {
    el.dataset.original = 'yes';
    el.setSelectionRange(first, first + 5, 'backward');
    el.closest('.desk-file')!.scrollTop = 684;
  }, data.indexOf('Notes on item 38.'));
  const backAt = () => previous.locator('textarea[data-original]').evaluate((el: HTMLTextAreaElement) =>
    [el.selectionStart, el.selectionEnd, el.selectionDirection, el.closest('.desk-file')!.scrollTop]);
  expect((await backAt())[3]).toBe(684);
  const where = await backAt(), geometry = await port.boundingBox();

  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.evaluate(() => {
    const capture = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const surface = target.closest<HTMLElement>('.search-screen-content');
      if (!surface) return;
      document.removeEventListener('focusin', capture);
      surface.dataset.entry = JSON.stringify({focus: target === document.activeElement, animation: surface.getAnimations().length});
    };
    document.addEventListener('focusin', capture);
  });
  // Trigger via the actual pointer even while the editor has a backwards selection.
  await lens.click();
  await expect(screen).toBeVisible();
  await expect(input).toBeFocused();
  await expect(screen.locator('.search-screen-content')).toHaveAttribute('data-entry', '{"focus":true,"animation":1}');
  await expect(previous).toHaveAttribute('inert', '');
  await expect(previous).toHaveCSS('visibility', 'visible');
  await expect(editor).toHaveCount(0);
  expect(await port.boundingBox()).toEqual(geometry);
  await expect(page).toHaveTitle(/^Search/);
  await page.keyboard.type('Needle');
  await expect(input).toHaveValue('Needle');
  const veil = page.locator('.page-veil.deep.search-veil');
  const layers = veil.locator('i');
  await expect(veil).toHaveClass(/\bout\b/);
  await expect(layers.nth(0)).toHaveCSS('backdrop-filter', 'blur(6px)');
  await expect(layers.nth(0)).toHaveCSS('background-color', /color\(srgb .* \/ 0\.65\)/);
  await expect(layers.nth(1)).toHaveCSS('backdrop-filter', 'blur(11px)');
  await expect(layers.nth(2)).toHaveCSS('backdrop-filter', 'blur(16px)');
  const choices = screen.getByRole('button', {name: /Needle (first|last)\./});
  await expect(choices).toHaveCount(2);
  await input.press('Escape');
  await expect(screen).toHaveCount(0);
  await expect(veil).not.toHaveClass(/\bout\b/);
  await expect(editor).toBeFocused();
  expect(await backAt()).toEqual(where);
  await expect(editor).toHaveValue(working);

  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.evaluate(() => history.forward());
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Needle');
  expect(await screen.locator('.search-screen-content').evaluate(el => el.getAnimations().length)).toBe(0);
  await expect(choices).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(choices.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(choices.last()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect.poll(() => paintedLine(editor)).toBe('Needle last.');
  await expect(paintedWord(editor)).toHaveText('Needle');
  await expect(paintedWord(editor)).toBeInViewport({ratio: 1});
  await expect(port.locator('.desk-mark')).toHaveCount(0);
  expect((await backAt()).slice(0, 3)).toEqual(where.slice(0, 3));
  await expect.poll(() => port.evaluate(el => el.scrollTop)).toBeGreaterThan(684);
  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('Needle');
  await expect(choices).toHaveCount(2);
  await expect(choices.last()).toBeFocused();
  await screen.getByRole('button', {name: 'Back', exact: true}).click();
  await expect(editor).toBeFocused();
  expect(await backAt()).toEqual(where);
  await expect(editor).toHaveValue(working);
});

test('a corner Search opens a new regular paper once, then switches and restores the picked row and original live draft', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width:1536,height:864});
  await page.emulateMedia({reducedMotion:'reduce'});
  const repo = 'landing', originPath = 'README.md', targetPath = 'interpreter.c';
  const originText = Array.from({length:125}, (_, n) => n < 55 ? `Note ${n+1} on the needle.` : `Other work, line ${n+1}.`).join('\n');
  const targetLine = '    int result = needle * 2; /* absolute location */';
  const targetText = [...Array.from({length:70}, (_, n) => `/* line ${n+1} */`), targetLine,
    ...Array.from({length:40}, (_, n) => `/* more detail ${n+1} */`)].join('\n');
  await app.newRepo.make(repo);
  await forge.editFile(originPath, originText);
  await app.file.named(repo, '', 'New file', targetPath);
  await forge.editFile(targetPath, targetText);
  await forge.piece(targetPath).getByRole('button', {name:'Close interpreter.c',exact:true}).click();
  await expect(forge.piece(targetPath)).toHaveCount(0);

  const origin = forge.editor(originPath), destination = forge.editor(targetPath);
  await forge.takePaper(originPath);
  await origin.focus();
  await origin.press('End');
  await page.keyboard.insertText(' Keep this draft.');
  const original = await origin.evaluate((area: HTMLTextAreaElement) => {
    const at = area.value.indexOf('Other work, line 66.');
    area.dataset.originalPaper = 'true';
    area.setSelectionRange(at, at + 10, 'backward');
    area.closest('.desk-file')!.scrollTop = 876;
    return [area.value, area.selectionStart, area.selectionEnd, area.selectionDirection, area.closest('.desk-file')!.scrollTop];
  });
  const lens = app.main.getByRole('button', {name:'Search',exact:true});
  const screen = page.getByRole('dialog', {name:'Search',exact:true}), input = screen.getByRole('searchbox');
  const result = screen.getByRole('button', {name:/interpreter\.c.*absolute location/});
  const lists = () => screen.evaluate(el => el.scrollTop);
  const deck = () => forge.piece(targetPath).locator('.desk-file').evaluate(el => el.scrollTop);
  const enterSearch = async () => {
    await lens.click();
    await expect(input).toBeFocused();
    await input.fill('needle');
    await result.scrollIntoViewIfNeeded();
  };
  await enterSearch();
  const listAt = await lists();
  expect(listAt).toBeGreaterThan(0);
  await result.click();
  await expect(screen).toHaveCount(0);
  await expect(destination).toBeFocused();
  await expect(forge.piece(targetPath)).toHaveClass(/\bheld\b/);
  await expect(forge.piece(targetPath)).toHaveCount(1);
  await expect(forge.piece(originPath)).toHaveCount(1);
  const mark = paintedWord(destination);
  await expect(mark).toHaveText('needle');
  await expect(mark).toHaveAttribute('data-line', '71');
  await expect(mark).toBeInViewport({ratio:1});
  await expect(mark).toHaveCSS('background-image', /rgb\(236, 202, 95\)/);
  await expect(mark).toHaveCSS('color', 'rgb(23, 22, 21)');
  await expect(mark.locator('..').locator('..')).toHaveAttribute('aria-hidden', 'true');
  expect(await forge.selected(targetPath)).toBe('');
  const targetScroll = await deck();
  expect(targetScroll).toBeGreaterThan(0);

  await forge.takePaper(originPath);
  await forge.takePaper(targetPath);
  await expect(mark).toHaveText('needle');
  expect(await deck()).toBe(targetScroll);
  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('needle');
  await expect(result).toBeFocused();
  expect(await lists()).toBe(listAt);
  await page.keyboard.press('Escape');
  await expect(screen).toHaveCount(0);
  await expect(forge.piece(originPath)).toHaveClass(/\bheld\b/);
  await expect(origin).toBeFocused();
  await expect(origin).toHaveAttribute('data-original-paper', 'true');
  expect(await origin.evaluate((area: HTMLTextAreaElement) => [
    area.value, area.selectionStart, area.selectionEnd, area.selectionDirection, area.closest('.desk-file')!.scrollTop,
  ])).toEqual(original);

  // This time the file already exists in the deck and the matched line is already visible. Keep its node and scroll.
  await destination.evaluate(el => { el.dataset.actualPaper = 'true'; });
  await enterSearch();
  await result.click();
  await expect(destination).toBeFocused();
  await expect(destination).toHaveAttribute('data-actual-paper', 'true');
  await expect(forge.piece(targetPath)).toHaveCount(1);
  await expect(paintedWord(destination)).toBeInViewport({ratio:1});
  expect(await deck()).toBe(targetScroll);
  // A saved line inserted above the match moves the result. Back finds the same text, not the old row position.
  await destination.press('Control+Home');
  await page.keyboard.insertText('/* inserted later */\n');
  await destination.press('Control+s');
  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('needle');
  await expect(result).toBeFocused();
  await expect(result).toHaveAttribute('data-hit-line', '72');
});

test('the right arrow and Return open the same first live result', async ({app}) => {
  const {page, forge} = app;
  await app.newRepo.make('go', {template:'C'});
  await app.main.getByRole('button', {name:'Search',exact:true}).click();
  const stage = page.getByRole('dialog', {name:'Search',exact:true});
  const input = stage.getByRole('searchbox'), arrow = stage.getByRole('button', {name:'Open first result',exact:true});
  await expect(input).toBeFocused();
  await expect(arrow).toBeDisabled();
  const position = await arrow.boundingBox();
  await page.keyboard.type('return');
  await expect(arrow).toBeEnabled();
  expect(await arrow.boundingBox()).toEqual(position);
  await input.press('Enter');
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => paintedLine(forge.editor('src/main.c'))).toBe('    return 0;');
  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('return');
  await arrow.click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => paintedLine(forge.editor('src/main.c'))).toBe('    return 0;');
});

test('the Search heading counts selectable filename and line matches, not distinct files', async ({app}) => {
  const {page, forge} = app;
  const repo = 'matches', name = 'named-anchor.txt';
  await app.newRepo.make(repo);
  await forge.editFile('README.md', [
    '# matches', 'interpreter interpreter', 'The interpreter runs.',
    'Use the interpreter here.', 'The interpreter reads from stdin.', 'One solitary line.',
  ].join('\n'));
  await app.file.named(repo, '', 'New file', name);
  await forge.editFile(name, 'The named-anchor opens the file.\n');
  await app.main.getByRole('button', {name:'Search',exact:true}).click();
  const screen = page.getByRole('dialog', {name:'Search',exact:true});
  const query = screen.getByRole('searchbox');
  await query.click();
  await expect(screen.getByRole('heading', {name:'Suggested files',exact:true})).toBeVisible();
  await expect(screen.locator('.found-sec')).toHaveCount(0);

  const files = screen.getByRole('region', {name:'files',exact:true});
  await query.fill('interpreter');
  await expect(files.getByRole('heading', {name:'4 matches for "interpreter"',exact:true})).toBeVisible();
  await expect(files.getByRole('button')).toHaveCount(4);
  await expect(files.getByRole('button', {name:/README\.md/})).toHaveCount(4);
  await query.fill('solitary');
  await expect(files.getByRole('heading', {name:'1 match for "solitary"',exact:true})).toBeVisible();
  await expect(files.getByRole('button')).toHaveCount(1);

  await query.fill('named-anchor');
  await expect(files.getByRole('heading', {name:'2 matches for "named-anchor"',exact:true})).toBeVisible();
  await expect(files.getByRole('button')).toHaveCount(2);
  await expect(files.getByRole('button', {name,exact:true})).toBeVisible();
  await expect(files.getByRole('button', {name:/opens the file/})).toBeVisible();
});

test('Forge Search keeps the Enter target distinct from a passing pointer on the existing sheet', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width:1536, height:864});
  await app.newRepo.make('field-notes');
  await forge.editFile('README.md', '# Field notes\n\nCheck the first launch gate.\nClose the last launch gate.\n');
  const editor = forge.editor('README.md');
  await editor.focus();
  const screen = page.getByRole('dialog', {name:'Search', exact:true});
  const input = screen.getByRole('searchbox');
  const paper = screen.locator('.search-screen-paper'), form = screen.getByRole('search');
  const stock = screen.getByRole('region', {name:'Search results'});
  const lens = app.main.getByRole('button', {name:'Search', exact:true});
  await lens.click();
  await expect(screen).toHaveClass(/\bsearch-on-forge\b/);
  await expect(page.locator('.search-veil.out')).toBeVisible();
  await expect(input).toBeFocused();
  await expect(paper).toHaveCSS('overflow', 'visible');
  await expect(paper).toHaveCSS('background-image', 'none');
  await expect(form).toHaveCSS('border-radius', '8px');
  await expect(form).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
  await expect(stock).toHaveCount(0);
  const position = await input.boundingBox(), formAt = (await form.boundingBox())!;
  const stage = screen.getByRole('main', {name:'Search', exact:true});
  await expectHeadingOffset(stage);
  expect(formAt).toEqual({x:388, y:218, width:760, height:50});
  const split = async () => {
    await expect(stock).toHaveCSS('border-radius', '8px');
    await expect(stock).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
    await expect(form).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 1.5px 0px 0px');
    expect((await stock.boundingBox())!.y - (formAt.y + formAt.height)).toBe(1.5);
    expect(await form.boundingBox()).toEqual(formAt);
    expect(await input.boundingBox()).toEqual(position);
    await expectHeadingOffset(stage);
  };
  const sans = await input.evaluate(el => getComputedStyle(el).fontFamily);

  await input.click();
  const suggestions = screen.getByRole('region', {name:'Suggested files', exact:true});
  const suggested = suggestions.getByRole('button', {name:'README.md', exact:true});
  await expect(suggestions.getByRole('heading')).toHaveCSS('font-family', sans);
  await expect(suggested).toHaveCSS('font-family', sans);
  await expect(suggested.locator('kbd')).toHaveCount(0);
  await split();

  await input.fill('launch');
  await expect(screen.getByRole('heading', {name:'2 matches for "launch"', exact:true})).toHaveCSS('font-family', sans);
  const first = screen.getByRole('button', {name:/Check the first launch gate/});
  const last = screen.getByRole('button', {name:/Close the last launch gate/});
  const excerpt = first.locator('.sheet-text'), number = first.locator('.sheet-line');
  const mono = await excerpt.evaluate(el => getComputedStyle(el).fontFamily);
  expect(mono).not.toBe(sans);
  await expect(number).toHaveCSS('font-family', mono);
  await expect(number).toHaveCSS('scale', '0.86');
  await expect(first.locator('.sheet-file')).toHaveCSS('font-family', sans);
  await expect(first).toHaveCSS('height', '24px');
  await split();
  await expect(first.locator('kbd')).toBeHidden();

  await last.hover();
  await expect(first).toHaveCSS('--search-selection-share', '57%');
  await expect(last).toHaveCSS('--search-selection-share', '40%');
  await expect(last.locator('kbd')).toBeHidden();
  await expect(last).toHaveCSS('outline-style', 'none');

  await input.press('ArrowDown');
  await expect(first).toBeFocused();
  await expect(first.locator('kbd')).toBeVisible();
  await expect(last.locator('kbd')).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await expect(last).toBeFocused();
  await expect(last.locator('kbd')).toBeVisible();
  await expect(first.locator('kbd')).toBeHidden();
  await expect(last).toHaveAccessibleName('README.md 4 Close the last launch gate.');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expect.poll(() => paintedLine(editor)).toBe('Close the last launch gate.');

  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('launch');
  await expect(last).toBeFocused();
  await screen.getByRole('button', {name:'Back', exact:true}).click();
  await expect(screen).toHaveCount(0);
  await expect(editor).toBeFocused();
});

test('the modal keeps its keyboard until a press on the mist gives it back to the Search key', async ({app}) => {
  const {page} = app;
  const key = app.main.getByRole('button', {name:'Search', exact:true});
  await key.focus();
  await page.keyboard.press('Enter');
  const modal = page.getByRole('dialog', {name:'Search', exact:true});
  const input = modal.getByRole('searchbox'), back = modal.getByRole('button', {name:'Back', exact:true});
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  await page.mouse.click(112, 140);
  await expect(modal).toHaveCount(0);
  await expect(key).toBeFocused();
});

test('an empty Search suggests real files only when asked by the hand', async ({app}) => {
  const {page, forge} = app;
  await app.newRepo.make('hello', {template:'C'});
  const editor = forge.editor('src/main.c');
  await editor.focus();
  await app.main.getByRole('button', {name:'Search', exact:true}).click();
  const stage = page.getByRole('main', {name:'Search', exact:true});
  const input = stage.getByRole('searchbox'), paper = stage.locator('.search-screen-paper');
  const suggested = stage.getByRole('region', {name:'Suggested files'});
  const first = suggested.getByRole('button').first();
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  await expect(paper).toHaveCSS('height', '50px');
  const emptyAt = await input.boundingBox();
  await expectHeadingOffset(stage);

  // Focus alone (including moving away and tabbing back) is not a request to suggest.
  await input.press('Shift+Tab');
  await expect(stage.getByRole('combobox', {name:'Search in', exact:true})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  await input.click();
  await expect(first).toBeVisible();
  expect(await input.boundingBox()).toEqual(emptyAt);
  await expectHeadingOffset(stage);

  await input.press('Tab');
  await expect(stage.getByRole('button', {name:'Open first result',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await expect(suggested).toBeVisible();
  await first.press('Escape');
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);

  await input.press('ArrowDown');
  await expect(first).toBeFocused();
  await first.press('ArrowUp');
  await expect(input).toBeFocused();
  await input.press('Shift+Tab');
  await expect(suggested).toHaveCount(0);

  await input.click();
  await expect(suggested).toBeVisible();
  await stage.getByRole('heading', {name:'Search',exact:true}).click();
  await expect(suggested).toHaveCount(0);
  await input.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(editor).toBeFocused();
});

const phone = test.extend({hasTouch: true});
test('desktop Search keeps the full accessible filename and excerpt in a visually shortened result row', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width:1536,height:864});
  const repo = 'long-result', name = 'notes-about-the-parser-and-the-runtime-compatibility-matrix-for-the-next-release.md';
  const excerpt = 'interpreter exits with an input parse error, stops reading stdin, and prints a diagnostic explaining which expression it rejected.';
  await app.newRepo.make(repo);
  await app.file.named(repo, '', 'New file', name);
  await forge.editFile(name, '\n'.repeat(6) + excerpt + '\n');
  await app.main.getByRole('button', {name:'Search',exact:true}).click();
  const modal = page.getByRole('dialog', {name:'Search',exact:true});
  const field = modal.getByRole('searchbox');
  await expect(field).toBeFocused();
  await page.keyboard.type('interpreter');
  const row = modal.getByRole('button', {name});
  await expect(row).toHaveAccessibleName(`${name} 7 ${excerpt}`);
  const filename = row.locator('.sheet-file'), words = row.locator('.sheet-text');
  await expect(filename).toHaveCSS('font-size', '15px');
  await expect(words).toHaveCSS('font-size', '17px');
  for (const part of [filename, words]) {
    await expect(part).toHaveCSS('text-overflow', 'ellipsis');
    expect(await part.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  await expect(row).toHaveCSS('height', '24px');
  await expect(row.locator('.sheet-line')).toHaveText('7');
  await expect(row.locator('mark')).toHaveText('interpreter');
  await field.press('ArrowDown');
  await expect(row).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(forge.editor(name)).toBeFocused();
  await expect.poll(() => paintedLine(forge.editor(name))).toBe(excerpt);
});

phone('on a phone the Search veil keeps the field in reach and uses actual saved files, with no horizontal overflow', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width:390,height:844});
  await app.newRepo.make('hello', {template:'C'});
  const lens = app.main.getByRole('button',{name:'Search',exact:true});
  await lens.tap();
  const stage = page.getByRole('main', {name:'Search',exact:true}), input = stage.getByRole('searchbox');
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport({ratio:1});
  const suggested = stage.getByRole('region', {name:'Suggested files'});
  await expect(suggested).toHaveCount(0);
  const initial = await input.boundingBox();
  await input.tap();
  await expect(suggested.getByRole('button')).toHaveCount(3);
  expect(await input.boundingBox()).toEqual(initial);
  await expect(suggested.getByRole('button', {name:'Makefile',exact:true})).toBeVisible();
  await expect(suggested.getByRole('button', {name:'src/main.c',exact:true})).toBeVisible();
  await suggested.getByRole('button', {name:'README.md',exact:true}).tap();
  await expect(forge.editor('README.md')).toBeFocused();
  await page.evaluate(() => history.back());
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  const form = stage.getByRole('search'), lensInside = form.locator(':scope > svg.mark');
  const paper = stage.locator('.search-screen-paper'), region = stage.getByRole('region', {name: 'Search results'});
  await expect(page.getByRole('dialog', {name:'Search'})).toHaveClass(/search-on-forge/);
  await expect(paper).toHaveCSS('overflow', 'visible');
  await expect(paper).toHaveCSS('background-image', 'none');
  await expect(form).toHaveCSS('border-radius', '8px');
  await expect(form).toHaveCSS('background-image', /rgb\(26, 39, 45\).*rgb\(30, 43, 49\)/);
  await expect(form).toHaveCSS('background-size', '4px 4px');
  await expect(form).toHaveCSS('border-bottom-width', '1px');
  await expect(form).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
  await expect(input).toHaveCSS('color', 'rgb(239, 235, 227)');
  await expect(input).toHaveCSS('caret-color', 'rgb(239, 235, 227)');
  await expect(lensInside).toHaveCSS('color', 'rgb(178, 164, 143)');
  expect(await input.evaluate(el => getComputedStyle(el, '::placeholder').color)).toBe('rgb(178, 164, 143)');
  await expect(input).toHaveCSS('background-image', 'none');
  await expect(input).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(region).toHaveCount(0);
  const at = (await input.boundingBox())!;
  const inner = (await lensInside.boundingBox())!;
  expect(at.x + at.width / 2).toBe(195);
  await expect(lensInside).toHaveAttribute('aria-hidden', 'true');
  expect([inner.x - at.x, inner.width, inner.height, at.height]).toEqual([16, 18, 18, 48]);
  expect(inner.y + inner.height / 2).toBe(at.y + at.height / 2);
  await input.fill('return');
  await expect(suggested).toHaveCount(0);
  const hit = stage.getByRole('button', {name: /src\/main\.c.*return 0/});
  await expect(hit).toBeInViewport({ratio:1});
  await expect(hit.locator('.sheet-file')).toHaveCSS('font-size', '17px');
  await expect(hit.locator('.sheet-text')).toHaveCSS('white-space', 'pre-wrap');
  await expect(region).toHaveCSS('border-top-width', '1px');
  await expect(region).toHaveCSS('background-image', /rgb\(219, 219, 211\).*rgb\(231, 231, 223\)/);
  await expect(region).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
  await expect(form).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 1.5px 0px 0px');
  const field = (await form.boundingBox())!;
  expect((await region.boundingBox())!.y - (field.y + field.height)).toBe(1.5);
  const seam = await paper.evaluate(el => {
    const cover = getComputedStyle(el, '::before');
    return [cover.content, cover.backgroundColor, cover.top, cover.blockSize, getComputedStyle(el, '::after').content];
  });
  expect(seam).toEqual(['""', 'rgb(26, 29, 23)', '50px', '2.5px', 'none']);
  await expect(region.locator('.found-sec')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await input.boundingBox()).toEqual(at);
  expect(await stage.evaluate(el => el.scrollWidth)).toBe(await stage.evaluate(el => el.clientWidth));
  // The end mark is not a separate query-clear control; the input clears from the keyboard.
  await input.selectText();
  await input.press('Backspace');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  expect(await input.boundingBox()).toEqual(at);
  await input.tap();
  await expect(suggested.getByRole('button')).toHaveCount(3);
  await input.fill('return');
  await hit.click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => paintedLine(forge.editor('src/main.c'))).toBe('    return 0;');
  await expect(stage).toHaveCount(0);
});

test('the keyboard shortcut is still the existing search in place, separate from the lens', async ({app}) => {
  const {page, forge} = app;
  await app.newRepo.make('hello', {template: 'C'});
  const editor = forge.editor('src/main.c');
  await editor.focus();
  await page.keyboard.press('Control+k');
  const inline = page.locator('#page').getByRole('searchbox', {name: 'Search this repo'});
  await expect(inline).toBeFocused();
  await expect(page.getByRole('main', {name: 'Search', exact: true})).toHaveCount(0);
  await inline.fill('return');
  await expect(forge.hit(/return 0/)).toBeVisible();
  await inline.press('Escape');
  await expect(inline).toHaveValue('');
  await inline.press('Escape');
  await expect(editor).toBeFocused();
});

test('from Git, a Search match opens the repo in Forge and Back revisits Search and Git', async ({app}) => {
  const {page, forge} = app;
  await app.newRepo.make('atlas', {template: 'C'});
  await forge.editFile('src/main.c', 'int main(void) {\n    return 7;\n}');
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('git');
  const lens = app.main.getByRole('button', {name: 'Search', exact: true});
  await expect(lens).toBeVisible();
  const git = app.main.getByRole('region', {name: 'Git', exact: true});
  await git.focus();
  await lens.click();
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  const query = stage.getByRole('searchbox');
  const scope = stage.getByRole('combobox', {name: 'Search in', exact: true});
  await expect(scope).toHaveValue('hello');
  await expect(query).toBeFocused();
  await query.fill('return 7');
  await scope.click();
  await stage.getByRole('option', {name:'atlas',exact:true}).click();
  const hit = stage.getByRole('button', {name: /src\/main\.c.*return 7/});
  await expect(hit).toBeVisible();
  // The joined edge and its clips still belong to this Search entry, not Home or Forge.
  const paper = stage.locator('.search-screen-paper');
  await expect(paper).toHaveCSS('overflow', 'clip');
  const [ink, upperClip, grain, mask, lowerClip] = await paper.evaluate(el => {
    const rim = getComputedStyle(el, '::before'), lower = getComputedStyle(el, '::after');
    return [rim.backgroundColor, rim.clipPath, lower.backgroundImage, lower.maskImage, lower.clipPath];
  });
  expect(ink).toBe('rgb(23, 22, 21)');
  expect(upperClip).toMatch(/^polygon\(.+44px.+6px 48px.+52px/);
  expect(grain).toMatch(/rgb\(227, 222, 213\).*rgb\(239, 235, 227\)/);
  expect(mask).toBe('none');
  expect(lowerClip).toMatch(/^polygon\(.+52px.+6px 48px/);
  await hit.click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => paintedLine(forge.editor('src/main.c'))).toBe('    return 7;');
  await page.evaluate(() => history.back());
  await expect(query).toHaveValue('return 7');
  await expect(scope).toHaveValue('atlas');
  await query.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(git).toBeFocused();
  await expect(git.getByRole('button', {name:'Git folder: hello',exact:true})).toBeVisible();
});

test('the repo named in Search changes scope without moving the query or losing the Forge desk', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 390, height: 844});
  const other = 'atlas-build-notes';
  await app.newRepo.make(other, {template: 'C'});
  await forge.editFile('README.md', '# Atlas\nUse local launch target.\nKeep this detail.');
  await app.newRepo.make('hello', {template: 'C'});
  const editor = forge.editor('src/main.c');
  await editor.focus();
  const before = await editor.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(4, 12, 'backward');
    return [el.selectionStart, el.selectionEnd, el.selectionDirection];
  });
  await app.main.getByRole('button', {name:'Search', exact:true}).click();
  const stage = page.getByRole('main', {name:'Search',exact:true}), query = stage.getByRole('searchbox');
  const scope = stage.getByRole('combobox', {name:'Search in',exact:true});
  const hit = stage.getByRole('button', {name:/README\.md.*Use local launch target/});
  await expect(scope).toHaveValue('hello');
  await expect(query).toBeFocused();
  await query.fill('launch target');
  await expect(stage.getByRole('status')).toHaveText('No results found for "launch target"');
  const title = stage.getByRole('heading', {name:'Search',exact:true});
  const at = (await query.boundingBox())!, head = (await title.boundingBox())!;
  const corner = (await scope.boundingBox())!;
  await expectHeadingOffset(stage);
  expect(corner.x).toBeGreaterThan(head.x + head.width);
  expect(corner.y + corner.height).toBeLessThan(head.y);

  await scope.click();
  await expect(scope).toHaveJSProperty('value', 'hello');
  const nextScope = stage.getByRole('option', {name:other,exact:true});
  await expect(nextScope).toBeVisible();
  const optionAt = (await nextScope.boundingBox())!;
  expect(optionAt.y + optionAt.height).toBeLessThan(at.y);
  await expect(stage.locator('.search-screen-paper')).toHaveCSS('box-shadow', 'none');
  expect(await title.boundingBox()).toEqual(head);
  await page.keyboard.press('Escape');
  await expect(stage).toBeVisible();
  await expect(scope).toBeFocused();

  await scope.click();
  await stage.getByRole('option', {name:other,exact:true}).click();
  await expect(query).toHaveValue('launch target');
  await expect(query).toBeFocused();
  await expect(scope).toHaveValue(other);
  expect(await query.boundingBox()).toEqual(at);
  expect(await title.boundingBox()).toEqual(head);
  const chosen = (await scope.boundingBox())!;
  expect(chosen.x + chosen.width).toBe(corner.x + corner.width);
  expect(chosen.y).toBe(corner.y);
  expect(await stage.evaluate(el => el.scrollWidth)).toBe(await stage.evaluate(el => el.clientWidth));
  await expect(hit).toBeVisible();
  await hit.click();
  const read = forge.editor('README.md');
  await expect(read).toBeFocused();
  await expect(read).toHaveValue('# Atlas\nUse local launch target.\nKeep this detail.');
  await expect.poll(() => paintedLine(forge.editor('README.md'))).toBe('Use local launch target.');

  await page.evaluate(() => history.back());
  await expect(scope).toHaveValue(other);
  await expect(query).toHaveValue('launch target');
  await expect(hit).toBeVisible();
  await query.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual(before);
});

type ReadGate = {hold: boolean; waiting: boolean; delivered: boolean; release(): void};
type ReadGateWindow = typeof window & {searchGate: ReadGate};

/** Hold one real read from A while B can read; pass all other traffic and the real A response unchanged. */
function holdSearchRead() {
  type Call = {id: number; name: string; args?: {repo?: string; path?: string}};
  const post = Worker.prototype.postMessage;
  const gate: ReadGate = {hold: false, waiting: false, delivered: false, release() {}};
  (window as ReadGateWindow).searchGate = gate;
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
    const message = args[0] as Call | {batch: Call[]} | null;
    const calls = !gate.hold || !message || typeof message !== 'object' ? [] : 'batch' in message ? message.batch : [message];
    const slow = calls.find(c => c.name === 'repo_read' && c.args?.repo === 'hello' && c.args.path === 'README.md');
    if (!slow) { Reflect.apply(post, this, args); return; }
    gate.hold = false; gate.waiting = true;
    const rest = calls.filter(c => c !== slow);
    if (rest.length) Reflect.apply(post, this, [{batch: rest}]);
    gate.release = () => {
      gate.waiting = false;
      const heard = (e: MessageEvent<{id?: number}>) => {
        if (e.data.id !== slow.id) return;
        gate.delivered = true;
        this.removeEventListener('message', heard);
      };
      this.addEventListener('message', heard);
      Reflect.apply(post, this, [slow]);
    };
  };
}

test('a delayed read from the old scope cannot replace or open a matching path in the new one', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  await page.addInitScript(holdSearchRead);
  const app = new App(page), {forge} = app;
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('atlas', {template:'C'});
  await forge.editFile('README.md', '# Atlas\nThree before it.\nOne more.\nLaunch target in Atlas.');
  const retiring = await app.main.locator('.desk-room > .row-map:visible').evaluateHandle((map) => {
    const desk = document.querySelector<HTMLElement>('.desk[data-repo="atlas"]')!;
    const state = {hidden: null as boolean | null};
    const watch = new MutationObserver(() => {
      if (!desk.hidden) return;
      state.hidden = map.hasAttribute('hidden');
      watch.disconnect();
    });
    watch.observe(desk, {attributes: true, attributeFilter: ['hidden']});
    return state;
  });
  await app.newRepo.make('hello', {template:'C'});
  // Both repos have a README, but only the map of the repo in hand can take the keyboard or clicks.
  await expect.poll(() => retiring.evaluate(state => state.hidden)).toBe(true);
  await expect(app.main.locator('.desk-room > .row-map').getByRole('button', {name: 'README.md', exact: true})).toHaveCount(1);
  await forge.editFile('README.md', '# Hello\nLaunch target in Hello.');
  const source = forge.editor('src/main.c');
  await source.focus();
  await source.press('End');
  const from = await source.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
  await app.main.getByRole('button', {name:'Search',exact:true}).click();
  const stage = page.getByRole('main', {name:'Search',exact:true}), field = stage.getByRole('searchbox');
  const scope = stage.getByRole('combobox', {name:'Search in',exact:true});
  const atlas = stage.getByRole('button', {name:/README\.md.*Launch target in Atlas/});
  const hello = stage.getByRole('button', {name:/README\.md.*Launch target in Hello/});

  const hold = () => page.evaluate(() => { const gate = (window as ReadGateWindow).searchGate; gate.hold = true; gate.delivered = false; });
  const switchTo = async (repo: string) => {
    await scope.click();
    await stage.getByRole('option', {name:repo,exact:true}).click();
  };
  const waiting = () => expect.poll(() => page.evaluate(() => (window as ReadGateWindow).searchGate.waiting)).toBe(true);
  const release = async () => {
    await page.evaluate(() => (window as ReadGateWindow).searchGate.release());
    await expect.poll(() => page.evaluate(() => (window as ReadGateWindow).searchGate.delivered)).toBe(true);
  };
  await hold();
  await field.fill('launch target');
  await waiting();
  await switchTo('atlas');
  await expect(field).toHaveValue('launch target');
  await expect(atlas).toBeVisible();
  // The old answer arrives while this very Search DOM is still alive.
  await release();
  await expect(hello).toHaveCount(0);
  await expect(atlas).toBeVisible();

  await hold();
  await switchTo('hello');
  await waiting();
  await switchTo('atlas');
  await atlas.click();
  await expect.poll(() => paintedLine(forge.editor('README.md'))).toBe('Launch target in Atlas.');
  // It may also answer after a match has already taken us away.
  await release();
  await expect(forge.editor('README.md')).toHaveValue('# Atlas\nThree before it.\nOne more.\nLaunch target in Atlas.');

  await page.evaluate(() => history.back());
  await expect(scope).toHaveValue('atlas');
  await expect(atlas).toBeVisible();
  await expect(hello).toHaveCount(0);
  await field.press('Escape');
  await expect(source).toBeFocused();
  expect(await source.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(from);
});
