import {expect, test} from './fixtures.ts';
import {App} from './app.ts';

type Gate = {
  hold(name?: 'repo_write' | 'repo_put' | 'repo_read', path?: string): void;
  reject(): void; release(): void; writes: number; waiting: boolean;
  core(name: 'repo_read' | 'repo_put' | 'repo_bytes', path: string, bytes?: string): Promise<unknown>;
};
type GatedWindow = typeof window & {forgeGate: Gate};

/** Delay one real repo_write and let a test reject one at the core boundary. No production test hooks. */
const writeGate = () => {
  type Call = {id: number; name: string; args: {repo: string; path: string}};
  type Message = Call | {batch: Call[]} | {init: {reader?: boolean}};
  const post = Worker.prototype.postMessage;
  let next: {name: string; path: string} | null = null, release: ((ack: boolean) => void) | null = null;
  let core: Worker | null = null, id = -1;
  const answer = (ack: boolean) => { const run = release; release = null; gate.waiting = false; run?.(ack); };
  const gate: Gate = {
    hold: (name = 'repo_write', path = 'README.md') => { next = {name, path}; },
    reject: () => answer(false),
    release: () => answer(true),
    writes: 0, waiting: false,
    core: (name, path, bytes) => {
      const worker = core;
      if (!worker) return Promise.reject(Error('Store worker is not ready'));
      const request = id--;
      return new Promise((done, fail) => {
        const on = (event: MessageEvent<{id: number; ok?: unknown; error?: string}>) => {
          if (event.data.id !== request) return;
          worker.removeEventListener('message', on);
          if (event.data.error !== undefined) fail(Error(event.data.error)); else done(event.data.ok);
        };
        worker.addEventListener('message', on);
        Reflect.apply(post, worker, [{id: request, name, args: {repo: 'pine', path, bytes}}]);
      });
    },
  };
  (window as GatedWindow).forgeGate = gate;
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
    const message = args[0] as Message;
    if (!message || typeof message !== 'object') { Reflect.apply(post, this, args); return; }
    if ('init' in message) {
      if (!message.init.reader) core ??= this;
      Reflect.apply(post, this, args);
      return;
    }
    const entries = 'batch' in message ? message.batch : [message];
    gate.writes += entries.filter((c) => c.name === 'repo_write' && c.args.repo === 'pine' && c.args.path === 'README.md').length;
    const match = next && entries.find((c) => c.name === next?.name && c.args.repo === 'pine' && c.args.path === next.path);
    if (!match) { Reflect.apply(post, this, args); return; }
    next = null;
    gate.waiting = true;
    release = (ack) => {
      if (ack) { Reflect.apply(post, this, args); return; }
      const rest = entries.filter((c) => c !== match);
      if (rest.length) Reflect.apply(post, this, [{batch: rest}]);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {id: match.id, error: 'test write refused'}})));
    };
  };
};

test('Beside is a first-paper toggle and cannot close before the shared draft is saved', async ({page}) => {
  // This flow is only the file editor. Its Prompt can never receive the guest root.
  await page.route('**/webroot/**', (route) => route.abort());
  await page.addInitScript(writeGate);
  await page.setViewportSize({width: 1320, height: 792});
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const left = app.forge.editor('README.md');
  const right = page.getByRole('textbox', {name: 'Edit README.md beside', exact: true});
  const menu = page.getByRole('menu', {name: 'Edit text', exact: true});
  const toggle = menu.getByRole('menuitemcheckbox', {name: 'Beside', exact: true});
  const position = () => left.evaluate((area: HTMLTextAreaElement) => {
    const r = area.getBoundingClientRect();
    return [r.x, r.y, area.selectionStart, area.selectionEnd, area.scrollTop, area.scrollLeft];
  });
  await expect(left).toHaveValue('# pine\n');
  await left.press('Control+Home');
  await left.press('Shift+ArrowRight');
  const before = await position();
  await left.press('Shift+F10');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(right).toBeFocused();
  await expect(right).toHaveValue('# pine\n');
  const paper = page.locator('.desk-box:has([data-view="beside"])');
  const source = page.locator('.desk-box:has([data-view="primary"])');
  await expect(paper).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
  await expect(source).toHaveCSS('box-shadow', 'none');
  await expect.poll(position).toEqual(before);

  await right.press('Shift+F10');
  await expect(menu.getByRole('menuitem', {name: 'Select All', exact: true})).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(right).toBeFocused();

  const initialWrites = await page.evaluate(() => {
    const g = (window as GatedWindow).forgeGate;
    g.hold();
    return g.writes;
  });
  await right.press('Control+End');
  await page.keyboard.insertText('Typed beside; stored once.');
  await expect(left).toHaveValue('# pine\nTyped beside; stored once.');
  // Opening the first paper's context menu initiates blur saving on the second.
  await left.click({button: 'right'});
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect.poll(() => page.evaluate(() => (window as GatedWindow).forgeGate.waiting)).toBe(true);
  await expect(right).toBeVisible();
  await expect(toggle).toBeDisabled();
  await page.evaluate(() => (window as GatedWindow).forgeGate.release());
  await expect(right).toHaveCount(0);
  await expect(left).toBeFocused();
  expect(await page.evaluate(() => (window as GatedWindow).forgeGate.writes)).toBe(initialWrites + 1);
  await page.reload();
  await app.settled();
  await expect(left).toHaveValue('# pine\nTyped beside; stored once.');

  // Reject the blur write and the collapse attempt. The paper and both values must remain.
  await left.press('Shift+F10');
  await toggle.click();
  await page.evaluate(() => (window as GatedWindow).forgeGate.hold());
  await right.press('Control+End');
  await page.keyboard.insertText(' Retry this edit.');
  await left.click({button: 'right'});
  await expect(right).toHaveValue('# pine\nTyped beside; stored once. Retry this edit.');
  await toggle.click();
  await expect(toggle).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as GatedWindow).forgeGate.waiting)).toBe(true);
  await page.evaluate(() => (window as GatedWindow).forgeGate.reject());
  await expect(menu.getByText('Could not save changes. Beside stays open.')).toBeVisible();
  await expect(right).toHaveValue('# pine\nTyped beside; stored once. Retry this edit.');
  await expect(left).toHaveValue('# pine\nTyped beside; stored once. Retry this edit.');
  await toggle.click();
  await expect(right).toHaveCount(0);
  await page.reload();
  await app.settled();
  await expect(left).toHaveValue('# pine\nTyped beside; stored once. Retry this edit.');
});

test('Files asks at the actual row; only the final Delete is red', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  await page.setViewportSize({width: 1320, height: 792});
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine', {template: 'C'});
  await app.forge.use('Files');
  const tree = page.getByRole('tree', {name: 'pine', exact: true});
  const row = tree.getByRole('treeitem', {name: 'Makefile', exact: true});
  const name = row.getByRole('button', {name: 'Makefile', exact: true});
  const before = row.getByRole('button', {name: 'Delete', exact: true});
  const ask = row.getByRole('group', {name: 'Delete Makefile?', exact: true});
  const yes = ask.getByRole('button', {name: 'Delete', exact: true});
  const cancel = ask.getByRole('button', {name: 'Cancel', exact: true});
  await name.hover();
  await expect(before).toBeVisible();
  await expect(row.getByRole('button', {name: 'Rename', exact: true})).toBeVisible();
  await expect(before).not.toHaveCSS('color', 'rgb(127, 43, 60)');
  await before.click();
  await expect(ask).toBeVisible();
  await expect(yes).toHaveCSS('color', 'rgb(127, 43, 60)');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(name).toBeFocused();
  await expect(ask).toHaveCount(0);
  await name.hover();
  await before.click();
  await app.answer(yes, ask);
  await expect(row).toHaveCount(0);
  await expect(tree.getByRole('button', {name: 'README.md', exact: true})).toBeFocused();
  await app.forge.use('Forge');
  await expect(app.forge.editor('README.md')).toHaveValue('# pine\n');
  await page.reload();
  await app.settled();
  await app.forge.use('Files');
  await expect(tree.getByRole('button', {name: 'README.md', exact: true})).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('in a narrow window Beside follows the same horizontal desk and returns to the original view', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  await page.setViewportSize({width: 390, height: 844});
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const left = app.forge.editor('README.md');
  const right = page.getByRole('textbox', {name: 'Edit README.md beside', exact: true});
  const toggle = page.getByRole('menuitemcheckbox', {name: 'Beside', exact: true});
  const desk = page.getByRole('region', {name: 'Files in pine', exact: true});
  const at = async () => await desk.evaluate((d) => d.scrollLeft);
  await expect.poll(at).toBe(0);
  await left.press('Shift+F10');
  await toggle.click();
  await expect(right).toBeFocused();
  await expect.poll(at).toBeGreaterThan(0);
  const row = page.locator('.row-map');
  await expect(row.locator('.row-sight')).toHaveCSS('display', 'none');
  const first = row.getByRole('button', {name: 'README.md', exact: true});
  const beside = row.getByRole('button', {name: 'Beside: README.md', exact: true});
  await expect(beside).toHaveAttribute('aria-current', 'true');
  await first.click();
  await expect.poll(at).toBe(0);
  await expect(first).toHaveAttribute('aria-current', 'true');
  await beside.press('Enter');
  await expect.poll(at).toBeGreaterThan(0);
  await expect(right).toBeFocused();
  await expect(beside).toHaveAttribute('aria-current', 'true');
  await first.click();
  await expect.poll(at).toBe(0);
  await left.press('Shift+F10');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(right).toHaveCount(0);
  await expect(left).toBeFocused();
  await expect.poll(at).toBe(0);
});

test('Files rename waits for the same pending draft and leaves both panes when its save is refused', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  await page.addInitScript(writeGate);
  await page.setViewportSize({width: 1320, height: 792});
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const old = app.forge.editor('README.md');
  await old.press('Shift+F10');
  await page.getByRole('menuitemcheckbox', {name: 'Beside', exact: true}).click();
  const beside = page.getByRole('textbox', {name: 'Edit README.md beside', exact: true});
  await page.evaluate(() => (window as GatedWindow).forgeGate.hold());
  await beside.fill('Rename keeps this draft');
  await app.forge.use('Files'); // The editor blurs while its write is held.
  const tree = page.getByRole('tree', {name: 'pine', exact: true});
  const row = tree.getByRole('treeitem', {name: 'README.md', exact: true});
  await row.getByRole('button', {name: 'README.md', exact: true}).hover();
  await row.getByRole('button', {name: 'Rename', exact: true}).click();
  const field = page.getByRole('textbox', {name: 'New name', exact: true});
  await field.fill('work.md');
  await field.press('Enter');
  await expect(old).toHaveJSProperty('readOnly', true);
  await expect.poll(() => page.evaluate(() => (window as GatedWindow).forgeGate.waiting)).toBe(true);
  await expect(tree.getByRole('button', {name: 'work.md', exact: true})).toHaveCount(0);
  await page.evaluate(() => (window as GatedWindow).forgeGate.reject());
  await expect(page.getByText('Could not save README.md. Nothing was moved.', {exact: true})).toBeVisible();
  await expect(old).toHaveValue('Rename keeps this draft');
  await expect(row.getByRole('button', {name: 'README.md', exact: true})).toBeVisible();
  await field.press('Enter');
  await expect(tree.getByRole('button', {name: 'work.md', exact: true})).toBeVisible();
  await expect(app.forge.editor('work.md')).toHaveValue('Rename keeps this draft');
  await expect(old).toHaveCount(0);
  await expect(beside).toHaveCount(0);
  const stored = await page.evaluate(() => (window as GatedWindow).forgeGate.core('repo_read', 'work.md'));
  expect(stored).toMatchObject({text: 'Rename keeps this draft'});
});

test('outside binary write blocks saving before classification can finish, then preserves an actual copy', async ({page, context}) => {
  await context.route('**/webroot/**', (route) => route.abort());
  await context.addInitScript(writeGate);
  await page.setViewportSize({width: 1320, height: 792});
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const editor = app.forge.editor('README.md');
  await expect(editor).toHaveValue('# pine\n');
  const outside = await context.newPage();
  try {
    await outside.goto(process.env.SELFTEST_APP!);
    await new App(outside).settled();
    const baseline = await page.evaluate(() => {
      const gate = (window as GatedWindow).forgeGate;
      gate.hold('repo_read');
      return gate.writes;
    });
    const binary = 'AP+A';
    await outside.evaluate((bytes) => (window as GatedWindow).forgeGate.core('repo_put', 'README.md', bytes), binary);
    await expect.poll(() => page.evaluate(() => (window as GatedWindow).forgeGate.waiting)).toBe(true);
    await expect(page.getByText('Checking file…', {exact: true})).toBeVisible();
    await editor.fill('Keep local work as another file.');
    await editor.press('Control+s');
    expect(await page.evaluate(() => (window as GatedWindow).forgeGate.writes)).toBe(baseline);
    await page.evaluate(() => (window as GatedWindow).forgeGate.release());
    const recover = page.getByRole('group', {name: 'Recover unsaved changes'});
    await expect(recover).toBeVisible();
    await expect(editor).toHaveValue('Keep local work as another file.');
    await recover.getByRole('button', {name: 'Keep a copy', exact: true}).click();
    await expect(recover.getByText('Draft kept as README.md.draft.', {exact: true})).toBeVisible();
    const copy = await outside.evaluate(() => (window as GatedWindow).forgeGate.core('repo_read', 'README.md.draft'));
    expect(copy).toMatchObject({text: 'Keep local work as another file.'});
    const original = await outside.evaluate(() => (window as GatedWindow).forgeGate.core('repo_bytes', 'README.md'));
    expect(original).toBe(binary);
    await recover.getByRole('button', {name: 'Reload original', exact: true}).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Binary · 3 B', {exact: true})).toBeVisible();
  } finally { await outside.close(); }
});

test('an oversized full save is its own acknowledgment, not an unreadable outside change', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  await page.addInitScript(writeGate);
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const editor = app.forge.editor('README.md');
  // Model one large paste without spending the test timeout on Chrome's synthetic keystroke machinery.
  await editor.evaluate((area: HTMLTextAreaElement) => {
    area.value = ('a'.repeat(1024) + '\n').repeat(260);
    area.setSelectionRange(0, 0);
    area.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
  });
  await editor.press('Control+s');
  const full = page.getByRole('button', {name: 'Save full file', exact: true});
  await expect(full).toBeVisible();
  await page.evaluate(() => (window as GatedWindow).forgeGate.hold('repo_put'));
  await full.click();
  await expect.poll(() => page.evaluate(() => (window as GatedWindow).forgeGate.waiting)).toBe(true);
  await editor.fill('Newer edit while the full write was being acknowledged.');
  await page.evaluate(() => (window as GatedWindow).forgeGate.release());
  await expect.poll(async () => (await page.evaluate(() => (window as GatedWindow).forgeGate.core('repo_read', 'README.md')) as {text: string | null}).text)
    .toBe('Newer edit while the full write was being acknowledged.');
  await expect(page.getByRole('group', {name: 'Recover unsaved changes'})).toHaveCount(0);
  await expect(editor).toHaveValue('Newer edit while the full write was being acknowledged.');
});

test('repo rename keeps both Forge views on the new repo, and their edit survives reload', async ({page}) => {
  await page.route('**/webroot/**', (route) => route.abort());
  const app = new App(page);
  await page.goto(process.env.SELFTEST_APP!);
  await app.settled();
  await app.newRepo.make('pine');
  const primary = app.forge.editor('README.md');
  const companion = page.getByRole('textbox', {name: 'Edit README.md beside', exact: true});
  await primary.press('Shift+F10');
  await page.getByRole('menuitemcheckbox', {name: 'Beside', exact: true}).click();
  await expect(companion).toBeFocused();

  await app.rail.go('home');
  const repos = app.main.getByRole('region', {name: 'Repos'});
  await repos.getByRole('button', {name: 'Actions for pine'}).click();
  const menu = repos.getByRole('menu', {name: 'Actions for pine'});
  await menu.getByRole('menuitem', {name: 'Rename', exact: true}).click();
  const name = menu.getByRole('textbox', {name: 'New name', exact: true});
  await name.fill('cedar');
  await name.press('Enter');
  await expect(repos.getByRole('group', {name: 'cedar', exact: true})).toBeVisible();
  await app.rail.go('forge');
  await expect(app.forge.desk).toHaveAttribute('data-repo', 'cedar');
  await expect(app.main.getByRole('heading', {name: /^\/root\/cedar\/README\.md/})).toHaveCount(2);
  await expect(primary).toHaveValue('# pine\n');
  await expect(companion).toHaveValue('# pine\n');

  const text = '# pine\n\nPersisted after renaming.\n';
  await companion.fill(text);
  await companion.press('Control+s');
  await expect(primary).toHaveValue(text);
  await app.forge.find('Persisted after renaming');
  await expect(app.forge.hit(/Persisted after renaming/)).toBeVisible();
  await page.reload();
  await app.settled();
  await expect(app.forge.desk).toHaveAttribute('data-repo', 'cedar');
  await expect(primary).toHaveValue(text);
});
