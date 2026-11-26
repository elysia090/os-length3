import {expect, test} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {browserOnRemote} from '../../app/testing/remote.ts';
import {coreWasmPath} from '../../build/core-wasm.ts';
import type {Answer} from '../../api/client.ts';

test('real Git paper posts only explicitly, and a comment links to the original immutable diff after another Submit', async ({page}, info) => {
  // The Rust core speaks to a fresh PGlite Remote in the same Node process.
  // Chromium receives the production view via an inert routed page, with
  // no app server, no portal, and no Prompt or guest.
  const b = await browserOnRemote();
  const {core} = await import('../../api/host.ts');
  await b.store.create('hello', 'standard');
  await b.store.mkdir('hello', 'src');
  await b.store.add('hello', 'src', 'main.c', 'int main(void) {\n    return 1;\n}\n');
  await b.store.add('hello', 'src', 'boot.c', 'int boot = 0;\n');
  await b.store.add('hello', 'src', 'zz-tail.c', 'int end = 0;\n');
  await b.store.mkdir('hello', 'issue');
  await b.store.add('hello', 'issue', '001.md', 'Fix: Return an error when output fails\n\nFlush stdout before returning, so a failed write reaches the caller.\n');
  await b.draft.sync('hello');
  await b.history.cut('hello', null, 'Initial work', '');
  const bundled = await build({
    configFile: false, logLevel: 'silent', publicDir: 'why/app/public',
    resolve: {alias: [{find: /^virtual:why-core\.wasm/, replacement: coreWasmPath()}]},
    build: {write: false, minify: false, lib: {
      entry: fileURLToPath(new URL('./fixtures/git-review.ts', import.meta.url)), formats: ['es'],
    }},
  });
  const output = (Array.isArray(bundled) ? bundled : [bundled]).flatMap(out => 'output' in out ? out.output : []);
  const js = output.find(out => out.type === 'chunk' && out.isEntry);
  const css = output.find(out => out.type === 'asset' && out.fileName.endsWith('.css'));
  expect(js?.type).toBe('chunk'); expect(css?.type).toBe('asset');
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  const entry = 'http://localhost/git-paper';
  await page.exposeBinding('gitAsk', async (_, name: string, args: Record<string, unknown>): Promise<Answer> => {
    try { return {ok: await core(name,args)}; }
    catch (e) {
      if (e instanceof Error && 'status' in e) return {error:e.message,status:Number(e.status),detail:'detail' in e ? e.detail as Record<string,unknown> : {}};
      return {error:e instanceof Error ? e.message : String(e)};
    }
  });
  await page.route('**/*', (r) => r.request().url() === entry ?
    r.fulfill({contentType: 'text/html', body: '<!doctype html><title>Git paper</title><h1 style="margin:0 0 24px;font:700 17px/24px sans-serif">Git</h1><main class="git-flow git-desk" role="main"></main><style>body{padding:24px 48px}</style>'}) : r.abort());
  await page.setViewportSize({width:1320,height:800});
  await page.goto(entry);
  await page.addStyleTag({content:String(css?.type === 'asset' ? css.source : '')});
  await page.addScriptTag({type:'module',content:js?.type === 'chunk' ? js.code : ''});
  const reload = () => page.evaluate(async () => (await window.gitPaper.read()));
  const step = (name: string) => page.locator('.git-switch').getByRole('button', {name, exact:true});
  await step('Start').click();
  await expect.poll(async () => (await b.history.work('hello')).line).toBe('001');

  const edit = async (value: string) => {
    await b.store.write('hello','src/main.c', value); await reload();
    await step('Commit').click();
    await expect(step('Commit')).toBeDisabled();
  };
  await edit('int main(void) {\n    return 0;\n}\n');
  await edit('int main(void) {\n    int ok = 0;\n    return ok;\n}\n');
  await expect(page.getByText('Not submitted')).toBeVisible();
  expect(await b.history.changesOf('hello')).toEqual([]);
  await step('Submit').click();
  await expect(page.getByRole('button',{name:'Version 1',exact:true})).toBeVisible();
  const [v1] = await b.history.changesOf('hello');
  expect(v1?.version).toBe(1);
  await expect(page.locator('.git-history-commit')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Request changes',exact:true})).toHaveCount(0);

  const line = (n: number) => page.getByRole('button',{name:`After: line ${n} in src/main.c`,exact:true});
  const foot = page.locator('.git-paper-review');
  const diff = page.getByRole('region',{name:'Diff',exact:true});
  const frame = () => diff.evaluate((el) => {
    const at = el.getBoundingClientRect(), paper = el.closest('.git-paper')!;
    const head = [...el.querySelectorAll('.git-diff-head')].find(h => h.getBoundingClientRect().bottom > at.top + 1)!;
    const start = getComputedStyle(head), end = getComputedStyle(el, '::after');
    const wordsAt = (selector: string) => {
      const range = document.createRange();
      range.selectNodeContents(paper.querySelector(selector)!);
      const {top, height} = range.getBoundingClientRect();
      return top + height / 2;
    };
    const open = head.getBoundingClientRect();
    return {
      start: [start.borderBottomWidth, start.borderBottomColor, start.inlineSize],
      end: [end.blockSize, end.backgroundColor, end.inlineSize],
      left: [open.left, at.left], startY: open.bottom,
      viewport: [at.top, at.bottom, at.height],
      gap: paper.querySelector('.git-paper-review')!.getBoundingClientRect().top - at.bottom,
      words: ['.git-total-files', '.git-review-comment', '.git-review-approve'].map(wordsAt),
      overflow: el.scrollHeight - el.clientHeight,
    };
  });
  const rules = (size: Awaited<ReturnType<typeof frame>>) => {
    expect(size.start[0]).toBe('1px');
    expect(size.end).toEqual(size.start);
    expect(size.left[0]).toEqual(size.left[1]);
    expect(size.gap).toBeGreaterThanOrEqual(6);
    expect(size.words).toEqual([size.words[0],size.words[0],size.words[0]]);
  };
  await expect(diff.locator('.git-diff-head')).toBeVisible();
  const short = await frame();
  rules(short);
  expect(short.overflow).toBe(0);

  const footer = await foot.boundingBox();
  await line(2).click(); await line(3).click();
  await expect(line(2)).toHaveAttribute('aria-pressed','true');
  expect((await b.history.changesOf('hello'))[0]?.reviews).toEqual([]);
  await expect(step('Merge')).toBeDisabled();
  await expect(page.locator('.git-compose')).toBeHidden();
  await page.screenshot({path:info.outputPath('git-paper-direct.png')});
  await foot.getByRole('button',{name:'Comment',exact:true}).click();
  const words = page.getByRole('textbox',{name:'Comment',exact:true});
  await words.fill('The two lines make the result explicit.');
  await expect(page.locator('.git-comment-refs')).toHaveText('src/main.c:2–3');
  await words.press('Control+Enter');
  const ref = page.getByRole('link',{name:'src/main.c:2–3',exact:true});
  await expect(ref).toBeVisible();
  expect(await foot.boundingBox()).toEqual(footer);
  await expect(step('Merge')).toBeDisabled();
  await foot.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(step('Merge')).toBeEnabled();

  const longLines = Array.from({length: 24}, (_,n) => '    // ' + n + ' ' + 'keep the changes readable '.repeat(5)).join('\n');
  await b.store.write('hello', 'src/boot.c', 'int boot = 1;\n');
  await b.store.write('hello', 'src/zz-tail.c', 'int end = 1;\n');
  await edit(`/* Second submit */\nint main(void) {\n${longLines}\n    return 4;\n}\n`);
  await step('Submit').click();
  await expect(page.getByRole('button',{name:'Version 2',exact:true})).toBeVisible();
  await expect(page.getByText('return ok;', {exact:true})).toBeVisible(); // not switched by arrival
  await page.getByRole('button',{name:'Version 2',exact:true}).click();
  await expect.poll(() => diff.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const long = await frame(), pageTop = await page.evaluate(() => scrollY);
  expect(long.viewport).toEqual(short.viewport);
  expect(long.words).toEqual(short.words);
  expect(long.start).toEqual(short.start);
  const first = diff.getByRole('button', {name:'src/boot.c',exact:true});
  const last = diff.getByRole('button', {name:'src/zz-tail.c',exact:true});
  await expect(first).toBeInViewport({ratio:1});
  await expect(diff.locator('.git-diff-name').first()).toHaveText('src/boot.c');
  await expect(diff.locator('.git-diff-head').first().locator('.git-diff-count')).toHaveText('+1 −1');
  await expect(diff.locator('.git-diff-file').first().locator('.git-diff-line')).toHaveCount(2);
  await expect(last).not.toBeInViewport();
  await diff.evaluate((el) => { el.scrollTop = 180; el.scrollLeft = 120; });
  await expect.poll(() => diff.evaluate((el) => [el.scrollLeft,el.scrollTop])).toEqual([120,180]);
  expect(await page.evaluate(() => scrollY)).toBe(pageTop);
  rules(await frame());
  expect((await frame()).startY).toBe(long.startY);

  // The leading file is short. The other file's real heading, rows and fold are still reached in the same scrollport.
  await diff.hover();
  await page.mouse.wheel(0, 1600);
  await expect(last).toBeInViewport({ratio:1});
  expect(await page.evaluate(() => scrollY)).toBe(pageTop);
  expect((await frame()).viewport).toEqual(short.viewport);
  await expect(diff.getByRole('button', {name:'After: line 1 in src/zz-tail.c',exact:true})).toBeInViewport({ratio:1});
  await last.click();
  await expect(last).toHaveAttribute('aria-expanded', 'false');
  await last.click();
  await expect(last).toHaveAttribute('aria-expanded', 'true');
  await expect(diff.getByRole('button', {name:'After: line 1 in src/zz-tail.c',exact:true})).toBeInViewport({ratio:1});

  await expect(page.getByText('return 4;', {exact:true})).toBeVisible();
  await expect(step('Merge')).toBeDisabled();
  await ref.click();
  await expect(page.locator('.git-diff-line.is-marked')).toHaveCount(2);
  await expect(page.getByText('return ok;',{exact:true})).toBeVisible();
  await expect(page.getByText('return 4;',{exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('git-paper-reference.png')});
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.getByText('return 4;',{exact:true})).toBeVisible();
  await expect(step('Merge')).toBeDisabled();
  await foot.getByRole('button',{name:'Approve',exact:true}).click();
  await expect(step('Merge')).toBeEnabled();
  await step('Merge').click();
  await expect.poll(async () => (await b.history.changesOf('hello'))[0]?.state).toBe('merged');
  expect(problems).toEqual([]);
});
