import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// The moves (DESIGN.md §1, Motion): every other spec asks for less motion (paths.ts), so a step there waits on what
// the OS does rather than on a move settling. Here the moves are asked for, and each is seen to go where it says
// and to end there: the page panned along the rail, a page staged, the right pane brought out past its edge and
// settling, its switch's mark filled, and the caret the OS draws following what is written.

test.use({reducedMotion: 'no-preference'});

/** Every move with an end has ended (the caret's blink, which has none, goes on). */
const still = (app: App) => expect.poll(() => app.page.evaluate(() => document.getAnimations()
  .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);

test('going along the rail pans to the next page, which stands whole once it lands, its cards each in place', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.make('notes');
  await app.rail.go('home');
  await still(app);
  const cards = app.main.locator('.home-repos .card');
  await expect(cards).toHaveCount(3);
  // Staged, each came in from below and ended where it stands, wholly there.
  for (const o of await cards.evaluateAll((els) => els.map((e) => [getComputedStyle(e).opacity, getComputedStyle(e).translate]))) expect(o).toEqual(['1', 'none']);
  await app.rail.go('git');
  await expect(app.main.getByRole('heading', {name: 'Git', level: 1})).toBeVisible();
  await still(app);
  // Landed: one page, the one gone to, and nothing of the last left over it.
  await expect(app.main.locator('.home-repos')).toHaveCount(0);
  expect(await app.page.evaluate(() => document.documentElement.matches(':active-view-transition'))).toBe(false);
});

test('the right pane brought out lands a touch past its edge and settles, its mark filled; put away, it goes', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  const side = app.main.getByRole('complementary', {name: 'Plugins and Prompt'});
  const fill = app.forge.paneSwitch.locator('.mark-fill');
  const filled = () => fill.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
  await still(app);
  const open = (await side.boundingBox())!.width;
  expect(await filled()).toBeCloseTo(1, 2);

  await app.forge.paneSwitch.click();
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
  await still(app);
  await expect(side).toBeHidden();
  expect(await filled()).toBeCloseTo(0, 2);

  // Brought out: its width, frame by frame, goes past where it stops and comes back to it.
  const widths = app.page.evaluate(() => new Promise<number[]>((done) => {
    const el = document.querySelector('.work.bench:not([hidden]) > .side')!, seen: number[] = [], t0 = performance.now();
    const tick = () => { seen.push(el.getBoundingClientRect().width); if (performance.now() - t0 < 700) requestAnimationFrame(tick); else done(seen); };
    requestAnimationFrame(tick);
  }));
  await app.forge.paneSwitch.click();
  const seen = await widths;
  await still(app);
  await expect(side).toBeVisible();
  expect(Math.max(...seen)).toBeGreaterThan(open + 4);
  expect(Math.abs(seen.at(-1)! - open)).toBeLessThan(1);
  expect(await filled()).toBeCloseTo(1, 2);
});

test('the caret is drawn by the OS: it follows what is written along the line, and Enter takes it to the next', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  const editor = app.forge.editor('README.md');
  await editor.focus();
  await app.page.keyboard.press('Control+End');
  const caret = app.page.locator('.os-caret');
  const at = async () => { await still(app); return caret.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform)).then((m) => ({x: m.e, y: m.f})); };
  await expect(caret).toHaveClass(/\bon\b/);
  // The browser's own is not drawn over it.
  expect(await editor.evaluate((e) => getComputedStyle(e).caretColor)).toBe('rgba(0, 0, 0, 0)');
  const a = await at();
  await app.page.keyboard.type('more');
  const b = await at();
  expect(b.x).toBeGreaterThan(a.x + 10);
  expect(Math.abs(b.y - a.y)).toBeLessThan(1);
  await app.page.keyboard.press('Enter');
  const c = await at();
  expect(c.y).toBeGreaterThan(b.y + 8);
  expect(c.x).toBeLessThan(b.x);
});
