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
  expect(full).toEqual([48, 636, 1224].map((x) => ({x, y: 90, width: 576, height: 744})));
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
  expect(await close.boundingBox()).toEqual({x: 1188, y: 66, width: 24, height: 24});
  await close.click();
  await expect(main).toHaveCount(0);
  await expect(readme).toHaveValue('# hello\n');
  await expect(forge.editor('Makefile')).not.toHaveValue('');

  await forge.use('Files');
  const folder = page.getByRole('tree', {name: 'hello', exact: true}).getByRole('treeitem', {name: 'src', exact: true});
  const toggle = folder.getByRole('button', {name: /^(Open|Close) src$/}).first();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await folder.getByRole('button', {name: 'main.c', exact: true}).click();
  await expect(editor).toHaveValue(text);

  await editor.fill('');
  await expect(port.locator('.gutter')).toHaveText('1');
  await expect.poll(() => scroll(port)).toEqual({top: 0, height: 720, range: 0});
  expect((await main.boundingBox())!.height).toBe(744);
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
    await expect.poll(async () => (await forge.piece(name).boundingBox())?.x).toBe(24);
    expect((await forge.piece(name).boundingBox())!.width).toBe(336);
    await expect(bar).toHaveAttribute('aria-current', 'true');
    await expect(forge.editor(name)).toBeFocused();
  }
  await map.getByRole('button', {name: names[0], exact: true}).press('Enter');
  await expect.poll(() => forge.desk.evaluate((el) => el.scrollLeft)).toBe(0);
  await expect(map.locator('.row-sight')).toBeHidden();
});
