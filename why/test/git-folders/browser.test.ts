// Run independently of the app's guest-booting suite:
// node --test why/test/git-folders/browser.test.ts
// WHY_TEST_CHROME may point to a system Chromium instead of the installed Playwright binary.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {before, test, after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium, expect, type Browser, type Page} from '@playwright/test';
import {build} from 'vite';
import type {} from './entry.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const fonts = fileURLToPath(new URL('../../app/public', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'why-git-folders-test-'));
const origin = 'http://git-folders.test';
const mime: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2'};
let browser: Browser;
before(async () => {
  await build({configFile: false, root, publicDir: false, logLevel: 'error',
    resolve: {alias: {
      './spawn.ts': fileURLToPath(new URL('../../api/spawn.desktop.ts', import.meta.url)),
      './terminal.ts': fileURLToPath(new URL('terminal.fixture.ts', import.meta.url)),
    }},
    worker: {format: 'es'}, build: {outDir: output, target: 'esnext', minify: false}});
  browser = await chromium.launch({executablePath: process.env.WHY_TEST_CHROME || undefined});
});
after(async () => { await browser?.close(); await rm(output, {recursive: true, force: true}); });

async function open(query = '') {
  const page = await browser.newPage({viewport: {width: 1320, height: 792}, reducedMotion: 'reduce'});
  // Fulfil everything through Playwright, without a server or network. Any guest/core Worker is a failure.
  await page.addInitScript(() => Object.defineProperty(globalThis, 'Worker', {
    value: class { constructor() { throw new Error('Worker in isolated Git fixture'); } }
  }));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const body = await readFile(join(path.startsWith('/fonts/') ? fonts : output, path));
      await route.fulfill({status: 200, contentType: mime[extname(path)] ?? 'application/octet-stream', body});
    } catch { await route.fulfill({status: 404, body: ''}); }
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/' + query);
  const close = async () => {
    const violations = await page.evaluate(() => window.gitFoldersFixture?.violations);
    await page.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(violations, []);
  };
  return {page, close};
}
const folder = (page: Page, name: string) => page.getByRole('button', {name: 'Git folder: ' + name, exact: true});
const menu = (page: Page) => page.getByRole('menu', {name: 'Git folders', exact: true});
const item = (page: Page, name: string) => menu(page).getByRole('menuitemradio', {name, exact: true});
const paper = (page: Page) => page.locator('.issue-slot[aria-current=true] > .issue-card');

test('the chosen name opens a quiet menu with no change to the issue or shadow', async () => {
  const {page, close} = await open();
  try {
    const key = folder(page, 'hello');
    await expect(key).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await paper(page).boundingBox();
    assert.ok(geometry);
    const clip = {...geometry, width: geometry.width + 14, height: geometry.height + 14};
    const before = await page.screenshot({clip, animations: 'disabled'});
    await key.click();
    await expect(item(page, 'hello')).toHaveAttribute('aria-checked', 'true');
    await expect(item(page, 'atlas')).toHaveAttribute('aria-checked', 'false');
    assert.deepEqual(await paper(page).boundingBox(), geometry);
    assert.deepEqual(await page.screenshot({clip, animations: 'disabled'}), before, 'the same pixels, including shadow');
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'atlas')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(key).toBeFocused();
    await expect(menu(page)).toBeHidden();
    await key.click();
    await page.mouse.click(6, 420);
    await expect(menu(page)).toBeHidden();
  } finally { await close(); }
});

test('switching keeps Git, leaves the old paper while it reads, and returns to the same issue and caret', async () => {
  const {page, close} = await open();
  try {
    await expect(folder(page, 'hello')).toBeVisible();
    await page.getByRole('button', {name: 'Next issue', exact: true}).first().click();
    await expect(paper(page)).toContainText('Record frame timings');
    const summary = paper(page).getByRole('textbox', {name: 'Summary', exact: true});
    await summary.evaluate(e => {
      const field = e as HTMLTextAreaElement;
      field.focus();
      field.setSelectionRange(1, 6, 'forward');
    });
    await page.evaluate(() => window.gitFoldersFixture.holdAtlas());
    await folder(page, 'hello').click();
    await item(page, 'atlas').click();
    await expect(paper(page)).toContainText('Record frame timings');
    await expect(folder(page, 'hello')).toBeVisible();
    await page.evaluate(() => window.gitFoldersFixture.releaseAtlas());
    await expect(folder(page, 'atlas')).toBeVisible();
    await expect(paper(page)).toContainText('No issues yet');
    assert.deepEqual(await page.evaluate(() => window.gitFoldersFixture.requests
      .filter(r => r.name === 'repo_tree' && r.repo === 'third')), [], 'not every other repo was read');
    await folder(page, 'atlas').press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(folder(page, 'hello')).toBeVisible();
    await expect(paper(page)).toContainText('Record frame timings');
    await expect(summary).toBeFocused();
    assert.deepEqual(await summary.evaluate(e => [(e as HTMLTextAreaElement).selectionStart, (e as HTMLTextAreaElement).selectionEnd]), [1, 6]);
    assert.equal(await page.evaluate(() => window.gitFoldersFixture.here()), 'hello');
  } finally { await close(); }
});

test('a newer folder choice never waits for an abandoned read', async () => {
  const {page, close} = await open();
  try {
    await expect(folder(page, 'hello')).toBeVisible();
    await page.evaluate(() => window.gitFoldersFixture.holdAtlas());
    await folder(page, 'hello').click();
    await item(page, 'atlas').click();
    await folder(page, 'hello').click();
    await item(page, 'third').click();
    await expect(paper(page)).toContainText('Third repo first issue');
    await page.evaluate(() => window.gitFoldersFixture.releaseAtlas());
    await expect(folder(page, 'third')).toBeVisible();
    await expect(paper(page)).toContainText('Third repo first issue');
  } finally { await close(); }
});

test('a deep link belongs to its actual repo; a lone repo does not offer a menu', async () => {
  const {page, close} = await open();
  const single = await open('?single');
  try {
    await expect(folder(page, 'hello')).toBeVisible();
    await page.evaluate(() => window.gitFoldersFixture.open('third', 'issue/001.md'));
    await expect(folder(page, 'third')).toBeVisible();
    await expect(paper(page)).toContainText('Third repo first issue');
    await expect(paper(single.page)).toContainText('Fix first frame');
    await expect(single.page.locator('.git-repo-name')).toHaveText('hello/');
    await expect(folder(single.page, 'hello')).toHaveCount(0);
  } finally { await single.close(); await close(); }
});
