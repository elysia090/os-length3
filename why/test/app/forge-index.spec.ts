import {join} from 'node:path';
import {expect, test} from './fixtures.ts';

test.use({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'});

test('wide Files keeps the document fixed and separates opening a name from its actions', async ({app}) => {
  const {page, forge, file} = app;
  await page.route('**/webroot/**', route => route.abort());
  await app.newRepo.make('tidewatch', {template: 'C'});
  const content = Array.from({length: 80}, (_, i) => `Observation ${i + 1}: the tide rises.`).join('\n');
  await forge.editFile('README.md', content);
  for (const [path, label] of [['src/main.c', 'main.c'], ['Makefile', 'Makefile']]) {
    await file.open('tidewatch', path);
    await forge.piece(path).getByRole('button', {name: 'Close ' + label, exact: true}).click();
    await expect(forge.piece(path)).toHaveCount(0);
  }
  await file.open('tidewatch', 'README.md');
  const readme = forge.piece('README.md'), editor = forge.editor('README.md');
  await editor.press('Control+End');
  await editor.press('Shift+ArrowLeft');
  const state = () => editor.evaluate((area: HTMLTextAreaElement) => {
    const b = area.closest('.desk-box')!.getBoundingClientRect();
    return {paper: [b.x, b.y, b.width, b.height], scroll: area.closest('.desk-file')!.scrollTop,
      selection: [area.selectionStart, area.selectionEnd, area.selectionDirection]};
  });
  const before = await state();
  expect(before.paper.slice(0, 2)).toEqual([312, 96]);
  expect(before.scroll).toBeGreaterThan(0);
  expect(before.selection).toEqual([content.length - 1, content.length, 'backward']);
  expect((await forge.fileName('README.md').boundingBox())?.x).toBe(312);

  const tree = page.getByRole('tree', {name: 'tidewatch', exact: true});
  await expect(tree).toBeVisible();
  const index = page.locator('.file-tree.on-forge-desk[data-forge-index]');
  await expect(index).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const word = (name: string) => tree.getByRole('button', {name, exact: true});
  const mark = (name: string) => word(name).locator('xpath=..').locator(':scope > .tree-more');
  const sharp = (name: string) => word(name).locator('.file-shelf-primary');
  const menu = (name: string) => page.getByRole('menu', {name, exact: true});
  const clickWord = async (name: string, button: 'left' | 'right') => {
    const point = await sharp(name).evaluate(el => {
      const r = el.getBoundingClientRect(), text = document.createRange();
      text.selectNodeContents(el);
      const w = text.getBoundingClientRect(), x = (w.left + Math.min(r.right, w.right)) / 2, y = (r.top + r.bottom) / 2;
      return {x, y, isWord: el.contains(document.elementFromPoint(x, y))};
    });
    expect(point.isWord).toBe(true);
    await page.mouse.click(point.x, point.y, {button});
  };
  const pocket = async (name: string, sameRow = true) => {
    const anchored = await menu(name).boundingBox(), source = await word(name).boundingBox(), button = await mark(name).boundingBox();
    expect(anchored).not.toBeNull();
    if (sameRow) expect(anchored!.y).toBe(source!.y);
    expect(anchored!.x).toBeGreaterThan(source!.x);
    expect(anchored!.x + anchored!.width).toBeLessThan(button!.x);
    expect(anchored!.y + anchored!.height).toBeLessThanOrEqual((await page.viewportSize())!.height - 8);
  };
  const closed = async () => {
    await expect(word('src')).toHaveAttribute('aria-expanded', 'false');
    await expect(mark('src')).toHaveAttribute('aria-expanded', 'false');
    await expect(sharp('src')).toHaveCSS('background-image', 'none');
    await expect(word('main.c')).toHaveCount(0);
  };
  const photo = async (name: string) => {
    if (process.env.FORGE_INDEX_PROOF) await page.screenshot({path: join(process.env.FORGE_INDEX_PROOF, name + '.png')});
  };
  const unchanged = async () => {
    await expect(readme).toHaveClass(/\bheld\b/);
    expect(await state()).toEqual(before);
  };

  await closed();
  await expect(mark('src')).toBeVisible();
  await expect(mark('Makefile')).toBeHidden();
  const preview = tree.getByRole('button', {name: 'Open src/main.c', exact: true});
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS('font-size', await word('src').evaluate(el => getComputedStyle(el).fontSize));
  const nextRowY = (await word('Makefile').boundingBox())!.y;
  const closedMarkColor = await mark('src').evaluate(el => getComputedStyle(el).color);
  await clickWord('Makefile', 'right');
  await expect(menu('Makefile').getByRole('menuitem', {name: 'Rename', exact: true})).toBeVisible();
  await expect(forge.piece('Makefile')).toHaveCount(0);
  await pocket('Makefile');
  await unchanged();
  await photo('01-file-actions');
  await page.keyboard.press('ArrowDown');
  await expect(menu('Makefile').getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(word('Makefile')).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu('Makefile').getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(word('Makefile')).toBeFocused();

  await clickWord('src', 'right');
  await expect(menu('src')).toBeVisible();
  await pocket('src');
  await closed();
  await unchanged();
  await photo('02-folder-actions');
  await page.keyboard.press('Escape');
  await expect(word('src')).toBeFocused();
  await clickWord('src', 'left');
  await expect(menu('src')).toBeHidden();
  await expect(word('main.c')).toBeVisible();
  await expect(mark('src')).toHaveAttribute('aria-expanded', 'true');
  await expect(mark('src')).toBeVisible();
  await expect(mark('src')).not.toHaveCSS('color', closedMarkColor);
  await expect(mark('main.c')).toBeHidden();
  expect((await word('Makefile').boundingBox())!.y).toBe(nextRowY);
  await expect(index).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(sharp('src')).not.toHaveCSS('background-image', 'none');
  await expect(sharp('src')).toHaveCSS('background-size', 'calc(100% - 2px) 16px, 100% 14px');
  expect((await sharp('src').boundingBox())!.width).toBe(40);
  await unchanged();
  await photo('03-real-disclosure');

  await clickWord('src', 'right');
  await expect(menu('src')).toBeVisible();
  await expect(mark('src')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(word('src')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(word('main.c')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(word('src')).toBeFocused();
  // The existing right chevron is still the disclosure, not a second menu.
  await mark('src').click();
  await closed();

  await clickWord('Makefile', 'left');
  await expect(menu('Makefile')).toBeHidden();
  await expect(forge.editor('Makefile')).toBeFocused();
  expect(await forge.editor('Makefile').inputValue()).toContain('main.c');
  await photo('04-file-open');
  await clickWord('README.md', 'left');
  await expect(editor).toBeFocused();
  await unchanged();

  await page.setViewportSize({width: 1040, height: 284});
  await sharp('src').scrollIntoViewIfNeeded();
  const short = await state();
  await clickWord('src', 'right');
  await expect(menu('src')).toBeVisible();
  await pocket('src', false);
  expect(await state()).toEqual(short);
  await photo('05-short-window');
});

test('a preview links to the actual file, even when two long paths end in the same name', async ({app}) => {
  const {page, file, forge} = app;
  await page.route('**/webroot/**', route => route.abort());
  await app.newRepo.make('soundings');
  const dirs = ['samples-observation-series-morning', 'samples-observation-series-evening'];
  for (const dir of dirs) {
    await file.named('soundings', '', 'New folder', dir);
    await file.named('soundings', dir, 'New file', 'depth.txt');
    await forge.editFile(`${dir}/depth.txt`, dir + '\n');
  }
  const tree = page.getByRole('tree', {name: 'soundings', exact: true});
  for (const dir of dirs) {
    const link = tree.getByRole('button', {name: `Open ${dir}/depth.txt`, exact: true});
    await expect(link.locator('.near-link-context')).toHaveText(dir.endsWith('morning') ? '…morning' : '…evening');
    await link.click();
    await expect(forge.editor(`${dir}/depth.txt`)).toHaveValue(dir + '\n');
    await expect(forge.editor(`${dir}/depth.txt`)).toBeFocused();
    // The parent remains a shallow preview; taking the paper is not an expanded branch.
    await expect(tree.getByRole('button', {name: dir, exact: true})).toHaveAttribute('aria-expanded', 'false');
  }
});

test('a remembered paper cannot lose a real selection to a deferred File open', async ({app}) => {
  const {page, forge, file} = app;
  await page.route('**/webroot/**', route => route.abort());
  await page.setViewportSize({width: 1440, height: 900});
  await app.newRepo.make('tidegate');
  const writing = Array.from({length: 80}, (_, i) => 'Tide observation '+i).join('\n');
  await forge.editFile('README.md', writing);
  // Delay exactly the real read made on returning to Forge. No answer or file is fabricated.
  type G = {waiting: boolean; release: () => void};
  await page.evaluate(() => {
    const w = window as Window & {folderGate?: {waiting: boolean; release: () => void}};
    const post = Worker.prototype.postMessage;
    let delayed: (() => void) | null = null;
    let held = false;
    const gate: G = {waiting: false, release: () => {
      const cb = delayed; delayed = null; gate.waiting = false; cb?.();
    }};
    w.folderGate = gate;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      type Call = {name?: string};
      const msg = args[0] as Call & {batch?: Call[]};
      const listed = msg && (msg.name==='repo_names' || msg.batch?.some(c => c.name==='repo_names'));
      if (!held && listed && document.querySelector('#page[data-place="forge"]')) {
        held = gate.waiting = true;
        delayed = () => Reflect.apply(post, this, args);
      } else Reflect.apply(post, this, args);
    };
  });
  try {
    await file.open('tidegate','README.md');
    await expect.poll(() => page.evaluate(() => (window as Window & {folderGate?:G}).folderGate?.waiting)).toBe(true);
    await expect(page.locator('.place-left')).toHaveCount(0);
    const editor = forge.editor('README.md');
    await editor.click({position:{x:20,y:12}});
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Shift+ArrowLeft');
    const state = () => editor.evaluate((el: HTMLTextAreaElement) => ({
      selection: [el.selectionStart, el.selectionEnd, el.selectionDirection], scroll: el.closest('.desk-file')!.scrollTop,
    }));
    const selection = [writing.length-1,writing.length,'backward'];
    await expect.poll(async () => (await state()).selection).toEqual(selection);
    const before = await state();
    expect(before.scroll).toBeGreaterThan(0);
    await page.evaluate(() => (window as Window & {folderGate?: G}).folderGate?.release());
    await expect(page.getByRole('navigation',{name:'Files in tidegate',exact:true})).toBeVisible();
    await expect(editor).toBeFocused();
    expect(await state()).toEqual(before);
  } finally { await page.evaluate(() => (window as Window & {folderGate?:G}).folderGate?.release()); }
});
