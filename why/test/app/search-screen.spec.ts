import {expect, test} from './fixtures.ts';

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
  await expect(editor).toHaveCount(0);
  expect(await port.boundingBox()).toEqual(geometry);
  await expect(page).toHaveTitle(/^Search/);
  await input.fill('Needle');
  const choices = screen.getByRole('button', {name: /Needle (first|last)\./});
  await expect(choices).toHaveCount(2);
  await input.press('Escape');
  await expect(screen).toHaveCount(0);
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
  await expect.poll(() => forge.lineChosen('README.md')).toBe('Needle last.');
  await expect.poll(() => port.evaluate(el => el.scrollTop)).toBeGreaterThan(684);
  await page.evaluate(() => history.back());
  await expect(input).toHaveValue('Needle');
  await expect(choices).toHaveCount(2);
  await screen.getByRole('button', {name: 'Back', exact: true}).click();
  await expect(editor).toBeFocused();
  expect(await backAt()).toEqual(where);
  await expect(editor).toHaveValue(working);
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

  // Focus alone (including moving away and tabbing back) is not a request to suggest.
  await input.press('Shift+Tab');
  await expect(stage.getByRole('button', {name:'Back',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  await input.click();
  await expect(first).toBeVisible();
  expect(await input.boundingBox()).toEqual(emptyAt);

  await input.press('Tab');
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
phone('on a phone Search has its own full screen and uses actual saved files, with no horizontal overflow', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width:390,height:844});
  await app.newRepo.make('hello', {template:'C'});
  const lens = app.main.getByRole('button',{name:'Search',exact:true});
  await lens.click();
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
  const form = stage.getByRole('search'), lensInside = form.locator('svg.mark');
  const paper = stage.locator('.search-screen-paper'), region = stage.getByRole('region', {name: 'Search results'});
  await expect(paper).toHaveCSS('border-radius', '8px');
  await expect(paper).toHaveCSS('overflow', 'clip');
  await expect(paper).toHaveCSS('background-image', /^conic-gradient\(/);
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
  await expect(region).toHaveCSS('border-top-width', '0px');
  await expect(region.locator('.found-sec')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await input.boundingBox()).toEqual(at);
  expect(await stage.evaluate(el => el.scrollWidth)).toBe(await stage.evaluate(el => el.clientWidth));
  // Chrome's native clear button is inside the writing field, 27 px from the right edge.
  await input.click({position: {x: at.width - 27, y: at.height / 2}});
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(suggested).toHaveCount(0);
  expect(await input.boundingBox()).toEqual(at);
  await input.tap();
  await expect(suggested.getByRole('button')).toHaveCount(3);
  await input.fill('return');
  await hit.click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => forge.lineChosen('src/main.c')).toBe('    return 0;');
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
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('git');
  const lens = app.main.getByRole('button', {name: 'Search', exact: true});
  await expect(lens).toBeVisible();
  const git = app.main.getByRole('region', {name: 'Git', exact: true});
  await git.focus();
  await lens.click();
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  const query = stage.getByRole('searchbox');
  await expect(query).toBeFocused();
  await query.fill('return');
  await stage.getByRole('button', {name: /src\/main\.c.*return 0/}).click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => forge.lineChosen('src/main.c')).toBe('    return 0;');
  await page.evaluate(() => history.back());
  await expect(query).toHaveValue('return');
  await query.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(git).toBeFocused();
});
