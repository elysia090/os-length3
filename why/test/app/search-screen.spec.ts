import {expect, test} from './fixtures.ts';
import {App} from './app.ts';

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
  await expect(stage.getByRole('combobox', {name:'Search in', exact:true})).toBeFocused();
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
  await stage.getByRole('button', {name: /src\/main\.c.*return 7/}).click();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect.poll(() => forge.lineChosen('src/main.c')).toBe('    return 7;');
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
  expect(head.x + head.width / 2).toBe(at.x + at.width / 2 - 4);
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
  await expect.poll(() => forge.lineChosen('README.md')).toBe('Use local launch target.');

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
  await app.newRepo.make('hello', {template:'C'});
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
  await expect.poll(() => forge.lineChosen('README.md')).toBe('Launch target in Atlas.');
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
