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
  // And the page is no layer of its own after (named, the search's shade would lie over the search with it).
  expect(await app.page.evaluate(() => getComputedStyle(document.getElementById('page')!).viewTransitionName)).toBe('none');
});

test('the rail pressed again as its ink goes: one ink, going on from where it is', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  // The ink, frame by frame: how many there are, and where the one there is stands.
  const trip = app.page.evaluate(() => new Promise<{most: number; tops: number[]; landedFill: string[]}>((done) => {
    const t0 = performance.now(), tops: number[] = [], landedFill: string[] = [];
    let most = 0;
    const tick = () => {
      const inks = document.querySelectorAll<HTMLElement>('#rail-tabs .glide-ink');
      most = Math.max(most, inks.length);
      const remote = document.getElementById('purpose-remote')!;
      if (inks.length) {
        tops.push(inks[0].getBoundingClientRect().top);
        // The place it lands on waits with no fill of its own while the ink comes (no second box under it).
        if (remote.hasAttribute('aria-current')) landedFill.push(getComputedStyle(remote).backgroundColor);
      }
      if (performance.now() - t0 < 1600) requestAnimationFrame(tick); else done({most, tops, landedFill});
    };
    requestAnimationFrame(tick);
  }));
  await app.rail.button('git').click();
  await app.page.waitForFunction(() => {
    const ink = document.querySelector('#rail-tabs .glide-ink'), git = document.getElementById('purpose-git')!;
    return ink && ink.getBoundingClientRect().top > git.getBoundingClientRect().top - 60;
  });
  await app.rail.button('remote').click();
  const {most, tops, landedFill} = await trip;
  expect(most).toBe(1);
  // Down all the way, never back up toward where it began.
  for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeGreaterThanOrEqual(tops[i - 1] - 1);
  expect(landedFill.every((c) => c === 'rgba(0, 0, 0, 0)')).toBe(true);
});

test('the right pane brought out lands a touch past its edge and settles, its mark filled; put away, it goes at once and quickly', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  const side = app.main.getByRole('complementary', {name: 'Plugins and Prompt'});
  const fill = app.forge.paneSwitch.locator('.mark-fill');
  const filled = () => fill.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
  await still(app);
  const open = (await side.boundingBox())!.width;
  expect(await filled()).toBeCloseTo(1, 2);

  // Put away, it moves from the press and is gone in a fraction of its coming (--leave): sampled frame by frame.
  const going = app.page.evaluate(() => new Promise<{first: number; gone: number}>((done) => {
    const el = document.querySelector('.work.bench:not([hidden]) > .side')!, w0 = el.getBoundingClientRect().width;
    let first = -1, t0 = 0;
    const tick = () => {
      const w = el.getBoundingClientRect().width, at = performance.now() - t0;
      if (first < 0 && w < w0 - 2) first = at;
      if (w < 1 || at > 2000) done({first, gone: at}); else requestAnimationFrame(tick);
    };
    // Timed from the press itself, not from the test's asking for it.
    addEventListener('click', () => { t0 = performance.now(); requestAnimationFrame(tick); }, {once: true, capture: true});
  }));
  await app.forge.paneSwitch.click();
  const {first, gone} = await going;
  expect(first).toBeLessThan(60);
  expect(gone).toBeLessThan(400);
  await expect(app.forge.paneSwitch).toHaveAttribute('aria-expanded', 'false');
  await still(app);
  await expect(side).toBeHidden();
  expect(await filled()).toBeCloseTo(0, 2);

  // Brought out: its width, frame by frame, goes past where it stops and comes back to it (for as long as the move
  // lasts at the OS's pace).
  const widths = app.page.evaluate(() => new Promise<number[]>((done) => {
    const el = document.querySelector('.work.bench:not([hidden]) > .side')!, seen: number[] = [], t0 = performance.now();
    const pace = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pace')) || 1;
    const tick = () => { seen.push(el.getBoundingClientRect().width); if (performance.now() - t0 < 700 * pace) requestAnimationFrame(tick); else done(seen); };
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

test('a field that moves once the caret is in it (a page still coming in) carries the caret with it', async ({app}) => {
  await app.rail.go('home');
  const field = app.home.title(app.home.items.first());
  await field.focus();
  const caret = app.page.locator('.os-caret');
  await expect(caret).toHaveClass(/\bon\b/);
  // Moved after the caret was put in it, with nothing typed or pressed: the caret goes with it.
  await field.evaluate((e) => { e.closest<HTMLElement>('[role=listitem]')!.style.translate = '40px 24px'; });
  await expect.poll(async () => {
    const [m, r] = await Promise.all([caret.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform)), field.boundingBox()]);
    return Math.abs(m.e - r!.x) < 2 && m.f > r!.y && m.f < r!.y + r!.height;
  }).toBe(true);
});

test('a box emptied by the page, not by a key (a message sent), has its caret back at its start', async ({app}) => {
  await app.rail.go('home');
  // A box of lines as a page's own, emptied a moment after Ctrl+Enter as a sent message's is (after the Remote answers).
  await app.page.evaluate(() => {
    const box = Object.assign(document.createElement('textarea'), {className: 'line-in', rows: 1});
    box.setAttribute('aria-label', 'Say');
    box.style.cssText = 'position: fixed; left: 300px; top: 300px; width: 400px; z-index: 20';
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); setTimeout(() => { box.value = ''; }, 150); } });
    document.body.append(box);
  });
  const box = app.page.getByRole('textbox', {name: 'Say'});
  await box.focus();
  const caret = app.page.locator('.os-caret');
  const x = () => caret.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).e);
  await expect(caret).toHaveClass(/\bon\b/);
  const start = await x();
  await app.page.keyboard.type('Seeds on Saturday');
  await expect.poll(x).toBeGreaterThan(start + 40);
  await app.page.keyboard.press('Control+Enter');
  await expect(box).toHaveValue('');
  await expect.poll(async () => Math.abs(await x() - start)).toBeLessThan(2);
});

test('switching repos on the band, the ink goes all the way from one pill to the other, not cut by the band drawn again', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.make('notes');
  await still(app);
  const pill = (name: string) => app.forge.band.locator(`.pill[data-repo="${name}"]`);
  const to = (await pill('hello').boundingBox())!;
  // The ink, frame by frame, from the press until it has landed.
  const trip = app.page.evaluate(() => new Promise<{alive: number; left: number}>((done) => {
    const t0 = performance.now();
    let alive = 0, left = NaN;
    const tick = () => {
      const ink = document.querySelector<HTMLElement>('.repo-strip .glide-ink');
      if (ink) { alive = performance.now() - t0; left = ink.getBoundingClientRect().left; }
      if (performance.now() - t0 < 600) requestAnimationFrame(tick); else done({alive, left});
    };
    requestAnimationFrame(tick);
  }));
  await pill('hello').getByRole('button', {name: 'hello', exact: true}).click();
  const {alive, left} = await trip;
  expect(alive).toBeGreaterThan(150);
  expect(Math.abs(left - to.x)).toBeLessThan(4);
});

test('a page coming in never shows a part and then takes it away to bring it in', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.make('notes');
  await app.rail.go('remote');
  await still(app);
  // Each of the band's pills, each file and each card, by what it is (drawn again, it is a new element of the same
  // thing): once seen at all, never gone back to nothing while the page arrives (Home's cards are drawn again once
  // the Remote has said what it holds, Forge's band once its repos are read).
  const flashes = () => app.page.evaluate(() => new Promise<string[]>((done) => {
    const t0 = performance.now(), most = new Map<string, number>(), back: string[] = [];
    const tick = () => {
      for (const el of document.querySelectorAll<HTMLElement>('.repo-strip .pill, .col:not([hidden]) section.file, .home-repos .card')) {
        // What it is and which: a card and a pill of the same repo are two things.
        const key = `${el.className.split(' ')[0]} ${el.dataset.repo ?? el.dataset.path ?? (el.textContent ?? '').trim().slice(0, 16)}`;
        // Only what is on the screen: a page kept out of sight (Forge's, while Home is shown) is not seen.
        if (!el.checkVisibility()) continue;
        let o = 1;
        for (let p: HTMLElement | null = el; p; p = p.parentElement) o *= +getComputedStyle(p).opacity;
        const had = most.get(key) ?? 0;
        if (had > .9 && o < .4) back.push(`${key} ${had.toFixed(2)}→${o.toFixed(2)} @${Math.round(performance.now() - t0)}ms`);
        most.set(key, Math.max(had, o));
      }
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else done(back);
    };
    requestAnimationFrame(tick);
  }));
  const home = flashes();
  await app.rail.go('home');
  expect(await home).toEqual([]);
  const forge = flashes();
  await app.rail.go('forge');
  expect(await forge).toEqual([]);
});

test('the Prompt\'s screen comes up out of the box and goes back into it over its whole length, as built', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  // What the glass is doing, as long as each of its moves is: a build writes its lengths its own way (320ms as
  // .32s), and every one must still be read as the length it is, not a fraction of a millisecond.
  const lengths = () => app.page.evaluate(() => document.querySelector('.work.bench:not([hidden]) .screen > .glass')!
    .getAnimations().map((a) => Number(a.effect!.getComputedTiming().duration)));
  await app.page.keyboard.press('Control+Backquote');
  expect(Math.max(0, ...await lengths())).toBeGreaterThanOrEqual(400);
  await still(app);
  await app.page.keyboard.press('Escape');
  expect(Math.max(0, ...await lengths())).toBeGreaterThanOrEqual(300);
  await still(app);
});

test('Edit profile opened and put away, what is under it goes one way only, with the sheet, never up and then down', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  // Where the TODO's heading stands, frame by frame from the press until the sheet has settled.
  const track = (press: string) => app.page.evaluate((press) => new Promise<number[]>((done) => {
    const todo = [...document.querySelectorAll('h2')].find((e) => e.textContent?.startsWith('TODO'))!;
    const ys: number[] = [], t0 = performance.now();
    const tick = () => { ys.push(todo.getBoundingClientRect().top); if (performance.now() - t0 < 1400) requestAnimationFrame(tick); else done(ys); };
    [...document.querySelectorAll<HTMLButtonElement>('.profile button')].find((b) => b.textContent === press)!.click();
    requestAnimationFrame(tick);
  }), press);
  const opened = await track('Edit profile');
  expect(Math.min(...opened)).toBeGreaterThan(opened[0] - 1);
  expect(opened.at(-1)!).toBeGreaterThan(opened[0] + 8);
  await still(app);
  const shut = await track('Cancel');
  expect(Math.max(...shut)).toBeLessThan(shut[0] + 1);
  expect(Math.abs(shut.at(-1)! - opened[0])).toBeLessThan(1);
});
