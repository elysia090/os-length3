import type {Locator, Page} from '@playwright/test';
import {App} from './app.ts';
import {expect, test} from './fixtures.ts';

const names = ['README.md', 'src/main.c', 'Makefile'];

async function documents(page: Page) {
  // Use the real app and browser-local repo; these document tests do not need a guest.
  await page.route('**/webroot/**', (route) => route.abort());
  await page.setViewportSize({width: 1536, height: 864});
  await page.goto(process.env.SELFTEST_APP!);
  const app = new App(page);
  await app.settled();
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('forge');
  return app;
}

const scroll = (port: Locator) => port.evaluate((el) => ({
  top: el.scrollTop, height: el.clientHeight, range: el.scrollHeight - el.clientHeight,
}));

test('short, long and blank documents share a full writing surface without adding lines', async ({page}) => {
  const {forge} = await documents(page);
  await page.locator('.row-map').getByRole('button', {name: 'README.md', exact: true}).click();
  await expect.poll(() => forge.desk.evaluate((el) => el.scrollLeft)).toBe(0);
  const boxes = () => Promise.all(names.map((name) => forge.piece(name).boundingBox()));
  const full = await boxes();
  expect(full).toEqual([312, 900, 1488].map((x) => ({x, y: 96, width: 576, height: 744})));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(58, 61, 54)');
  for (const name of names) {
    await expect(forge.piece(name)).toHaveCSS('background-image', /^conic-gradient/);
  }

  const readme = forge.editor('README.md'), readmePort = forge.piece('README.md').locator('.desk-file');
  await expect(readmePort.locator('.gutter')).toHaveText('1 2');
  expect(await scroll(readmePort)).toEqual({top: 0, height: 720, range: 0});
  // The blank part is part of the writeable sheet, not 35 fake lines.
  await readmePort.locator('.sheet').click({position: {x: 156, y: 410}});
  await expect(readme).toBeFocused();
  expect(await readme.evaluate((a: HTMLTextAreaElement) =>
    [a.selectionStart, a.selectionEnd, a.value.length])).toEqual([8, 8, 8]);
  expect(await readme.inputValue()).toBe('# hello\n');

  const name = 'src/main.c', main = forge.piece(name), editor = forge.editor(name), port = main.locator('.desk-file');
  await editor.click({position: {x: 65, y: 12}});
  const text = Array.from({length: 119}, (_, i) => `line ${i + 1}\n`).join('');
  await forge.editFile(name, text);
  await editor.press('Control+Home');
  await expect(editor).toBeFocused();
  await expect(main).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
  await expect(port).toHaveCSS('scrollbar-color', 'rgb(131, 125, 113) rgba(0, 0, 0, 0)');
  await expect(forge.piece('README.md')).toHaveCSS('box-shadow', 'none');
  await expect(forge.desk.locator('.desk-close:visible')).toHaveCount(1);
  expect(await boxes()).toEqual(full);
  expect(await editor.evaluate((a) => Math.floor(a.closest('.desk-file')!.clientHeight /
    parseFloat(getComputedStyle(a).lineHeight)))).toBe(37);

  const glyph = (n: number) => port.locator('.gutter').evaluate((g, n) => {
    const node = g.firstChild as Text, lines = node.data.split('\n'), line = lines[n - 1]!;
    const start = lines.slice(0, n - 1).reduce((sum, number) => sum + number.length + 1, 0);
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + line.length);
    const {left, right, top, bottom} = range.getBoundingClientRect();
    return {left, right, top, bottom, code: g.nextElementSibling!.getBoundingClientRect().left};
  }, n);
  const [one, two, three] = await Promise.all([glyph(1), glyph(37), glyph(100)]);
  expect(two.right).toBe(one.right);
  expect(three.right).toBe(one.right);
  expect(three.left - full[1]!.x).toBe(10);
  expect(one.code - one.right).toBe(19);

  await port.hover({position: {x: 200, y: 250}});
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => (await scroll(port)).top).toBe(1800);
  expect(await scroll(readmePort)).toEqual({top: 0, height: 720, range: 0});
  const hundred = await glyph(100), clipped = (await port.boundingBox())!;
  expect(hundred.top).toBe(three.top - 1800);
  expect(hundred.top).toBeGreaterThan(clipped.y);
  expect(hundred.bottom).toBeLessThan(clipped.y + clipped.height);
  expect(await boxes()).toEqual(full);

  // The real button is aligned with the name but never overlaps the work surface.
  const close = main.getByRole('button', {name: 'Close main.c', exact: true});
  await expect(close.locator('svg')).toHaveCount(1);
  await expect(close).toHaveText('');
  expect(await close.boundingBox()).toEqual({x: 1452, y: 72, width: 24, height: 24});
  await close.click();
  await expect(main).toHaveCount(0);
  await expect(readme).toHaveValue('# hello\n');
  await expect(forge.editor('Makefile')).not.toHaveValue('');

  await forge.use('Files');
  const folder = page.getByRole('tree', {name: 'hello', exact: true}).getByRole('treeitem', {name: 'src', exact: true});
  const toggle = folder.getByRole('button', {name: 'src', exact: true});
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await folder.getByRole('button', {name: 'main.c', exact: true}).click();
  await expect(editor).toHaveValue(text);

  await editor.fill('');
  await expect(port.locator('.gutter')).toHaveText('1');
  await expect.poll(() => scroll(port)).toEqual({top: 0, height: 720, range: 0});
  expect((await main.boundingBox())!.height).toBe(744);
});

test('closing the document context leaves its reading position and selection in place', async ({page}) => {
  const {forge} = await documents(page);
  const name = 'README.md', editor = forge.editor(name);
  await forge.editFile(name, Array.from({length: 96}, (_, i) => `line ${i + 1} to read\n`).join(''));
  await editor.focus();
  const where = () => editor.evaluate((area: HTMLTextAreaElement) => [
    area.selectionStart, area.selectionEnd, area.selectionDirection, area.closest('.desk-file')!.scrollTop]);
  await editor.evaluate((area: HTMLTextAreaElement) => {
    const from = area.value.split('\n').slice(0, 16).join('\n').length + 1;
    area.setSelectionRange(from, from + 4, 'backward');
    area.closest('.desk-file')!.scrollTop = 150;
  });
  const before = await where();
  expect(before[3]).toBe(150);

  // Both actions can happen before the next paint. No queued key should turn the reading surface then.
  await editor.evaluate(async (area) => {
    const key = (target: Element, key: string, shiftKey = false) =>
      target.dispatchEvent(new KeyboardEvent('keydown', {key, shiftKey, bubbles: true, cancelable: true}));
    key(area, 'Shift', true);
    key(area, 'F10', true);
    const menu = document.querySelector('.forge-document-menu[aria-label="Edit text"]');
    if (!menu) throw new Error('The document never owned its context menu');
    key(menu, 'Escape');
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await expect(editor).toBeFocused();
  expect(await where()).toEqual(before);
  await editor.press('Control+End');
  await expect.poll(async () => Number((await where())[3])).toBeGreaterThan(150);
});

test('the half-cell seam stays part of the real row at phone width', async ({page}) => {
  const {forge} = await documents(page);
  await page.setViewportSize({width: 390, height: 844});
  const stops = [0, 348, 696];
  const map = page.locator('.row-map');
  for (const [i, name] of names.entries()) {
    const bar = map.getByRole('button', {name, exact: true});
    if (i % 2) await bar.press('Enter'); else await bar.click();
    await expect.poll(() => forge.desk.evaluate((el) => el.scrollLeft)).toBe(stops[i]);
    await expect.poll(async () => {
      const box = await forge.piece(name).boundingBox();
      return box && [box.x, box.width];
    }).toEqual([24, 336]);
    await expect(bar).toHaveAttribute('aria-current', 'true');
    await expect(forge.editor(name)).toBeFocused();
  }
  await map.getByRole('button', {name: names[0], exact: true}).press('Enter');
  await expect.poll(() => forge.desk.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(map.locator('.row-sight')).toBeHidden();
});

test('an outgoing Forge paper keeps its writing surface and position during Places travel', async ({page}) => {
  const app = await documents(page);
  // Let Git finish loading before the frame whose departed geometry we measure.
  await app.git.write('hello', 'Fix: Preserve the writing frame');
  await app.rail.go('forge');
  await app.forge.editor('README.md').focus();
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const before = await page.evaluate(() => {
    type Sample = {ground: string; paper: string; pattern: string; shadow: string; box: number[]};
    const sample = (root: Element, plane: Element): Sample => {
      const el = root.querySelector('.desk-box.held:not([data-kind])')!;
      const c = getComputedStyle(el), r = el.getBoundingClientRect(), at = root.getBoundingClientRect();
      return {ground: getComputedStyle(plane).backgroundColor, paper: c.backgroundColor, pattern: c.backgroundImage,
        shadow: c.boxShadow, box: [r.x - at.x, r.y - at.y, r.width, r.height].map(Math.round)};
    };
    const current = document.querySelector('#page')!;
    const state = window as Window & {forgeDeparture?: Sample};
    const observe = new MutationObserver(() => {
      if (current.getAttribute('data-place') !== 'git') return;
      const left = document.querySelector('.place-left > .page[data-place=forge]');
      if (!left) return;
      state.forgeDeparture = sample(left, left);
      observe.disconnect();
    });
    observe.observe(document.body, {attributes: true, attributeFilter: ['data-place'], childList: true, subtree: true});
    setTimeout(() => observe.disconnect(), 3000);
    return sample(current, document.body);
  });
  await app.forge.use('Git');
  await expect.poll(() => page.evaluate(() => (window as Window & {forgeDeparture?: unknown}).forgeDeparture)).toEqual(before);
  await expect(app.page.locator('.place-left')).toHaveCount(0);
});
