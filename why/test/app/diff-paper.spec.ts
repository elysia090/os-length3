import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import type {DiffFixture} from './fixtures/diff-paper.ts';

declare global { interface Window { diffFixture: DiffFixture } }

/**
 * Exercise the production TS/CSS in Chromium without starting the core, guest or Remote. The
 * inert surrounding sheet is ours; the actual folding, scrolling, marking and reveal are not.
 */
let js: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {write: false, minify: false, lib: {
      entry: fileURLToPath(new URL('./fixtures/diff-paper.ts', import.meta.url)),
      formats: ['iife'], name: 'DiffPaperFixture',
    }},
  });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []);
  const script = output.find(item => item.type === 'chunk');
  if (!script || script.type !== 'chunk') throw new Error('Expected one browser bundle');
  js = script.code;
  const sheet = output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  if (!sheet || sheet.type !== 'asset' || typeof sheet.source !== 'string') throw new Error('Expected one stylesheet');
  css = sheet.source;
});

test.beforeEach(async ({page}) => {
  await page.route('http://localhost/diff-fixture', (route) => route.fulfill({contentType: 'text/html', body: `<!doctype html>
    <style>
      body { margin: 0; padding: 24px; height: 140vh; background: #dcd9d4; }
      main { box-sizing: border-box; padding: 24px; width: min(960px, 100%); background: #fdfaf4; }
      h1 { font: 700 32px/48px sans-serif; margin: 0; }
      aside { font: 17px/24px sans-serif; width: 220px; }
      .sample { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
      @media (max-width: 600px) { .sample { grid-template-columns: minmax(0, 1fr); } }
    </style>
    <main><h1>Return an error when output fails</h1><div class="sample">
      <aside>Flush stdout before returning</aside><div id="diff-fixture"></div>
    </div><footer>Comment &nbsp; Approve</footer></main><p>History</p>`}));
  await page.goto('http://localhost/diff-fixture');
  await page.addStyleTag({content: css});
  await page.addScriptTag({content: js});
});

test('the file name alone folds; reopening returns to the same line and horizontal position', async ({page}) => {
  const view = page.getByRole('region', {name: 'Diff'});
  const name = view.getByRole('button', {name: 'src/main.c', exact: true});
  const fixed = await Promise.all([page.locator('h1'), page.locator('aside'), page.locator('footer'), page.getByText('History')].map(x => x.boundingBox()));
  const position = () => view.evaluate(el => [el.scrollTop, el.scrollLeft]);
  const area = (await view.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + 90);
  await page.mouse.wheel(0, 960);
  await expect.poll(async () => (await position())[0]).toBeGreaterThan(500);
  const beforeX = await page.locator('.git-diff-number').first().evaluate(el => el.getBoundingClientRect().left);
  await page.mouse.wheel(470, 0);
  await expect.poll(async () => (await position())[1]).toBeGreaterThan(300);
  expect(await page.locator('.git-diff-number').first().evaluate(el => el.getBoundingClientRect().left)).toBe(beforeX);
  const before = await position();
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await expect(view.locator('.git-diff-line').first()).toBeHidden();
  expect(await view.boundingBox()).toEqual(area);
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  expect(await position()).toEqual(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await Promise.all([page.locator('h1'), page.locator('aside'), page.locator('footer'), page.getByText('History')].map(x => x.boundingBox()))).toEqual(fixed);
  await page.evaluate(() => window.diffFixture.mount('demo/1/base/other'));
  await expect.poll(position).toEqual([0, 0]);
  await page.evaluate(() => window.diffFixture.mount('demo/1/base/head'));
  await expect.poll(position).toEqual(before);
});

test('direct gutter marking keeps old and new addresses distinct and leaves the ink bands alone', async ({page}) => {
  const view = page.getByRole('region', {name: 'Diff'});
  const after = (at: number) => view.getByRole('button', {name: `After: line ${at} in src/main.c`, exact: true});
  const before = view.getByRole('button', {name: 'Before: line 2 in src/main.c', exact: true});
  const first = (await after(2).boundingBox())!, last = (await after(4).boundingBox())!;
  await page.mouse.move(first.x + 12, first.y + 9);
  await page.mouse.down();
  await page.mouse.move(last.x + 12, last.y + 9, {steps: 5});
  expect(await page.evaluate(() => window.diffFixture.events.length)).toBe(0);
  await page.mouse.up();
  await expect(after(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(after(4)).toHaveAttribute('aria-pressed', 'true');
  await expect(before).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.diffFixture.events.at(-1))).toEqual([2, 3, 4].map(line => ({path: 'src/main.c', side: 'new', line})));
  const row = after(2).locator('xpath=../..');
  expect(await row.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(215, 234, 220)');
  expect(await row.locator('.git-diff-words').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(236, 202, 95)');
  expect(await row.locator('.git-diff-gutter').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(215, 234, 220)');
  await before.press('Space');
  await expect(before).toHaveAttribute('aria-pressed', 'true');
  await before.press('Shift+ArrowDown');
  await expect(view.getByRole('button', {name: 'Before: line 3 in src/main.c', exact: true})).toBeFocused();
  expect(await page.evaluate(() => window.diffFixture.events.at(-1))).toContainEqual({path: 'src/main.c', side: 'old', line: 3});
  expect(await page.evaluate(() => window.diffFixture.events.at(-1))).not.toContainEqual({path: 'src/main.c', side: 'old', line: 5});
});

test('code is still selectable and copies plain text without line numbers, signs or a draft mark', async ({page}) => {
  const code = page.locator('.git-diff-line.is-add .git-diff-code');
  const from = (await code.first().boundingBox())!, to = (await code.nth(1).boundingBox())!;
  const selected = await page.evaluate(() => {
    const code = document.querySelectorAll('.git-diff-line.is-add .git-diff-code');
    const start = code[0].firstChild!, finish = code[1].lastElementChild!.firstChild!;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(start, 2, finish, finish.textContent!.length);
    const payload = new DataTransfer();
    code[1].dispatchEvent(new ClipboardEvent('copy', {clipboardData: payload, bubbles: true, cancelable: true}));
    return payload.getData('text/plain');
  });
  expect(selected).toBe('  if (puts("hello") == EOF || fflush(stdout) == EOF)\n        return 1;');
  // A real pointer selection from the source surface does not use the gutter's press listener.
  await page.mouse.move(from.x + 45, from.y + 9);
  await page.mouse.down();
  await page.mouse.move(to.x + 160, to.y + 9, {steps: 8});
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toContain('return');
  await page.evaluate(() => {
    document.addEventListener('copy', event => { document.body.dataset.copy = event.clipboardData?.getData('text/plain'); }, {once: true});
  });
  await page.keyboard.press('Control+c');
  await expect(page.locator('body')).toHaveAttribute('data-copy', /fflush\(stdout\).*\n +return 1;/);
  expect(await page.evaluate(() => window.diffFixture.events)).toEqual([]);
});

test('a reference reveals its exact side and line, not a neighboring row or the page below', async ({page}) => {
  const view = page.getByRole('region', {name: 'Diff'});
  const name = view.getByRole('button', {name: 'src/main.c', exact: true});
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.diffFixture.reveal({path: 'src/main.c', side: 'old', line: 6}))).toBe(false);
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.diffFixture.reveal({path: 'src/main.c', side: 'new', line: 125}))).toBe(true);
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await expect(view.getByRole('button', {name: 'After: line 125 in src/main.c', exact: true})).toBeFocused();
  expect(await view.evaluate(el => el.scrollTop)).toBeGreaterThan(2000);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => window.diffFixture.mount('demo/1/base/head', [{path: 'docs/usage:notes.md', side: 'new', line: 1}], false));
  expect(await page.evaluate(() => window.diffFixture.reveal({path: 'docs/usage:notes.md', side: 'new', line: 1}))).toBe(true);
  await expect(view.locator('.git-diff-line.is-marked')).toHaveCount(1);
  await expect(view.locator('.git-diff-line.is-marked')).toHaveText('1+Usage');
  await expect(view.locator('button.git-diff-number')).toHaveCount(0);
  expect(await page.evaluate(() => window.diffFixture.events)).toEqual([]);
});

test('the same file name, gutters and single inner scroller work at 390px', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const view = page.getByRole('region', {name: 'Diff'});
  const name = view.getByRole('button', {name: 'src/main.c', exact: true});
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await view.getByRole('button', {name: 'After: line 2 in src/main.c', exact: true}).press('Space');
  await expect(view.locator('.git-diff-line.is-marked')).toHaveCount(1);
  expect(await view.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test.describe('touch', () => {
  test.use({hasTouch: true, viewport: {width: 390, height: 844}});
  test('touch in the gutter marks a line without reaching the surrounding issue swipe', async ({page}) => {
    await page.evaluate(() => {
      document.querySelector('main')!.addEventListener('pointerdown', () => { document.body.dataset.swipe = 'started'; });
    });
    const line = page.getByRole('button', {name: 'After: line 2 in src/main.c', exact: true});
    await line.tap();
    await expect(line).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('body')).not.toHaveAttribute('data-swipe');
    expect(await page.evaluate(() => window.diffFixture.events)).toEqual([[{path: 'src/main.c', side: 'new', line: 2}]]);
  });
});
