import {expect, test} from './fixtures.ts';
import {App} from './app.ts';

type Gate = {hold(): void; reject(): void; release(): void; writes: number; waiting: boolean};
type GatedWindow = typeof window & {forgeGate: Gate};

/** Delay one real repo_write and let a test reject one at the core boundary. No production test hooks. */
const writeGate = () => {
  type Call = {id: number; name: string; args: {repo: string; path: string}};
  const post = Worker.prototype.postMessage;
  let next = false, release: ((ack: boolean) => void) | null = null;
  const answer = (ack: boolean) => { const run = release; release = null; gate.waiting = false; run?.(ack); };
  const gate: Gate = {
    hold: () => { next = true; },
    reject: () => answer(false),
    release: () => answer(true),
    writes: 0, waiting: false,
  };
  (window as GatedWindow).forgeGate = gate;
  Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
    const message = args[0] as Call | {batch: Call[]};
    const entries = 'batch' in message ? message.batch : [message];
    const write = entries.find((c) => c.name === 'repo_write' && c.args.repo === 'pine' && c.args.path === 'README.md');
    if (!write) { Reflect.apply(post, this, args); return; }
    gate.writes++;
    if (!next) { Reflect.apply(post, this, args); return; }
    next = false;
    gate.waiting = true;
    release = (ack) => {
      if (ack) { Reflect.apply(post, this, args); return; }
      const rest = entries.filter((c) => c !== write);
      if (rest.length) Reflect.apply(post, this, [{batch: rest}]);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: {id: write.id, error: 'test write refused'}})));
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
  await expect.poll(position).toEqual(before);

  await right.press('Shift+F10');
  await expect(menu.getByRole('menuitem', {name: 'Select All', exact: true})).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(right).toBeFocused();

  await page.evaluate(() => (window as GatedWindow).forgeGate.hold());
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
  expect(await page.evaluate(() => (window as GatedWindow).forgeGate.writes)).toBe(1);
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
