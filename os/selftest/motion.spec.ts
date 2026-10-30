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

test('the two pages of a pan go as one sheet: the one come to adjoins the one left, whatever their heights', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  // Home runs past the window's foot, Git stops short of it. Frame by frame, the page left (its picture) and the page
  // come to keep the same distance apart: neither runs over the other, and no band of nothing opens between them.
  const apart = app.page.evaluate(() => new Promise<number[]>((done) => {
    const seen: number[] = [], t0 = performance.now();
    const tick = () => {
      const old = getComputedStyle(document.documentElement, '::view-transition-old(page)').transform;
      const part = document.querySelector('#page > :not([hidden])');
      if (old !== 'none' && part) seen.push(new DOMMatrix(getComputedStyle(part).transform).f - new DOMMatrix(old).f);
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else done(seen);
    };
    requestAnimationFrame(tick);
  }));
  await app.rail.button('git').click();
  const seen = await apart;
  expect(seen.length).toBeGreaterThan(3);
  expect(Math.max(...seen) - Math.min(...seen)).toBeLessThan(2);
  // As far apart as the window is from the page's top line to its foot: the next floor starts where this one is cut.
  const room = await app.page.evaluate(() => innerHeight - document.getElementById('page')!.getBoundingClientRect().top);
  expect(Math.abs(seen[0] - room)).toBeLessThan(2);
});

test('pressed again before the pan has moved, the rail goes straight to the place pressed last; pressed back, it stays', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  // Which pages are drawn on the way, and how many inks the rail has at once.
  const watch = () => app.page.evaluate(() => {
    const w = window as unknown as {drawn: string[]; inks: number};
    w.drawn = [];
    w.inks = 0;
    new MutationObserver(() => { const at = document.getElementById('page')!.getAttribute('aria-labelledby')!; if (w.drawn.at(-1) !== at) w.drawn.push(at); })
      .observe(document.getElementById('page')!, {attributes: true, attributeFilter: ['aria-labelledby']});
    const tick = () => { w.inks = Math.max(w.inks, document.querySelectorAll('#rail-tabs .glide-ink').length); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const seen = () => app.page.evaluate(() => { const w = window as unknown as {drawn: string[]; inks: number}; return {drawn: w.drawn, inks: w.inks}; });
  // Git, then Remote in the same moment: Remote is the page come to, from Home, and Git is never drawn on the way.
  await watch();
  await app.page.evaluate(() => { document.getElementById('purpose-git')!.click(); document.getElementById('purpose-remote')!.click(); });
  await expect(app.rail.button('remote')).toHaveAttribute('aria-current', 'page');
  await still(app);
  expect((await seen()).drawn).toEqual(['purpose-remote']);
  expect((await seen()).inks).toBeLessThanOrEqual(1);
  await expect(app.main.getByRole('heading', {name: 'Remote', level: 1})).toBeVisible();
  // Home, then Remote again at once: back where it began, it stays; no page comes, none goes.
  await watch();
  await app.page.evaluate(() => { document.getElementById('purpose-home')!.click(); document.getElementById('purpose-remote')!.click(); });
  await still(app);
  await expect(app.rail.button('remote')).toHaveAttribute('aria-current', 'page');
  expect((await seen()).drawn.filter((d) => d !== 'purpose-remote')).toEqual([]);
});

test('File\'s tree out and away: the rail\'s ink goes from the page\'s place to File and back, never an icon ink on ink', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  // Every place on the rail, frame by frame: none drawn in ink on a fill of ink, as an icon would be gone.
  const watch = () => app.page.evaluate(() => new Promise<string[]>((done) => {
    const t0 = performance.now(), bad: string[] = [];
    let inks = 0;
    const tick = () => {
      for (const b of document.querySelectorAll<HTMLElement>('#rail-tabs > .rail-item')) {
        const cs = getComputedStyle(b), bg = cs.backgroundColor, fg = cs.color;
        // Ink on a fill dark enough to hide it (the fill a third of the way to ink, or more).
        const dark = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return (m[3] ?? 1) > .35 && m[0] + m[1] + m[2] < 300; };
        if (dark(bg) && dark(fg)) bad.push(`${b.id} ${bg} ${fg} @${Math.round(performance.now() - t0)}`);
      }
      inks = Math.max(inks, document.querySelectorAll('#rail-tabs .glide-ink').length);
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else done([...bad, `inks ${inks}`]);
    };
    requestAnimationFrame(tick);
  }));
  const out = watch();
  await app.rail.button('file').click();
  await expect(app.file.tree).toBeVisible();
  expect(await out).toEqual(['inks 1']);
  const back = watch();
  await app.page.keyboard.press('Escape');
  await expect(app.file.tree).toBeHidden();
  expect(await back).toEqual(['inks 1']);
  // Out, File is the one inked place; away, the page's own again.
  await still(app);
  expect(await app.rail.button('home').evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
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

test('Home\'s right pane put away and brought back: its switch stays under the hand, what it holds goes with its edge, its search never squeezed', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  const toggle = app.main.getByRole('button', {name: 'Right pane'});
  const search = app.main.getByRole('searchbox', {name: /^Search/});
  const at = (await toggle.boundingBox())!;
  const wide = (await search.boundingBox())!.width;
  // Frame by frame as it goes: the search box and Lately, how much of each is to be seen.
  const going = (ms: number) => app.page.evaluate((ms) => new Promise<{search: number; lately: string; width: number}[]>((done) => {
    const box = document.querySelector<HTMLElement>('.home-bar > .search-box')!, side = document.querySelector<HTMLElement>('.home-side')!;
    const seen: {search: number; lately: string; width: number}[] = [], t0 = performance.now();
    const tick = () => {
      // Drawn at all (not taken out of the page), and then how much.
      const drawn = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
      seen.push({search: drawn(box) ? +getComputedStyle(box).opacity : 0, lately: drawn(side) ? 'visible' : 'hidden', width: box.getBoundingClientRect().width});
      if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(seen);
    };
    requestAnimationFrame(tick);
  }), ms);
  const away = going(300);
  await toggle.click();
  const put = await away;
  // Not gone at the press: the search fades from where it was, and Lately is still there for the start of the move.
  expect(put[0].search).toBeGreaterThan(.5);
  expect(put.slice(0, 3).every((f) => f.lately === 'visible')).toBe(true);
  await still(app);
  await expect(search).toBeHidden();
  // The switch where it stood, not a gap's width to the right of it.
  expect(Math.abs((await toggle.boundingBox())!.x - at.x)).toBeLessThan(1);
  const back = going(1500);
  await toggle.click();
  const came = await back;
  await still(app);
  await expect(search).toBeVisible();
  // Never squeezed on the way: as wide as it is out, every frame it is to be seen at all.
  for (const f of came.filter((f) => f.search > .05)) expect(f.width).toBeGreaterThan(wide - 1);
  expect(Math.abs((await toggle.boundingBox())!.x - at.x)).toBeLessThan(1);
});

test('a TODO started between two: the lines under it make way from where they stood, not there at once', async ({app}) => {
  await app.rail.go('home');
  const items = app.home.items;
  await app.home.title(items.first()).fill('Fix: one');
  await app.home.title(items.first()).press('Enter');
  await app.home.detail(items.first()).press('Enter');
  await app.home.title(items.nth(1)).fill('Feat: two');
  await app.home.title(items.first()).press('Enter');
  await still(app);
  const two = app.home.title(items.nth(1));
  const stood = (await two.boundingBox())!.y;
  // The frame after the list is drawn again with the new line in it: where "Feat: two" is seen.
  const first = app.page.evaluate(() => new Promise<number>((done) => {
    const list = document.querySelector('.todo-items')!;
    const drawn = new MutationObserver(() => {
      drawn.disconnect();
      requestAnimationFrame(() => {
        const field = [...list.querySelectorAll<HTMLInputElement>('input')].find((f) => f.value === 'two')!;
        done(field.getBoundingClientRect().top);
      });
    });
    drawn.observe(list, {childList: true});
  }));
  await app.home.detail(items.first()).press('Enter');
  const seen = await first;
  await expect(app.home.title(items.nth(1))).toBeFocused();
  await still(app);
  const now = (await app.home.title(items.nth(2)).boundingBox())!.y;
  expect(now).toBeGreaterThan(stood + 4);
  // Set off from where it stood (a frame's way at most), not drawn where it ends.
  expect(Math.abs(seen - stood)).toBeLessThan((now - stood) / 2);
});

test('a menu put away and opened again on its way out comes back from where it had got to, not at once', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  const gear = app.main.getByRole('button', {name: 'Actions for hello'}).first();
  const menu = app.main.getByRole('menu', {name: 'Actions for hello'});
  await gear.click();
  await expect(menu).toBeVisible();
  await still(app);
  // Put away, and pressed again a moment later, as it fades.
  const back = await gear.evaluate((g) => new Promise<number[]>((done) => {
    const list = document.getElementById(g.getAttribute('aria-controls') ?? '') ?? g.closest('.card')!.querySelector<HTMLElement>('.repo-gear-pop')!;
    (g as HTMLElement).click();
    setTimeout(() => {
      (g as HTMLElement).click();
      const seen: number[] = [];
      const tick = () => { seen.push(+getComputedStyle(list).opacity); if (seen.length < 40 && seen.at(-1)! < 1) requestAnimationFrame(tick); else done(seen); };
      requestAnimationFrame(tick);
    }, 60);
  }));
  // Neither gone nor whole at once: it fades back from where it was.
  expect(back[0]).toBeGreaterThan(.1);
  expect(back[0]).toBeLessThan(.99);
  await expect(menu).toBeVisible();
  await still(app);
  expect(await menu.evaluate((e) => +getComputedStyle(e).opacity)).toBe(1);
  await expect(menu.getByRole('menuitem', {name: 'Rename'})).toBeEnabled();
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

test('the Prompt put back on its way up turns there, and brought up on its way down turns there: never first whole, or back in the pill', async ({app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  await still(app);
  // How much of the glass is seen (its height less its clip's top and foot): as last drawn before it is turned (the
  // bench says it is up, or going down), then frame by frame for 900 ms. Set going before the key is pressed (a key can
  // be taken before a script sent ahead of it has run), and read once it is over.
  type Watched = Window & {turned?: Promise<number[]>};
  const watch = async () => {
    await app.page.evaluate(() => {
      const work = document.querySelector<HTMLElement>('.work.bench:not([hidden])')!, glass = work.querySelector<HTMLElement>('.screen > .glass')!;
      const now = () => {
        const m = /inset\(([-\d.]+)px(?: ([-\d.]+)px)?(?: ([-\d.]+)px)?/.exec(getComputedStyle(glass).clipPath);
        const h = glass.getBoundingClientRect().height;
        return m ? h - parseFloat(m[1]) - parseFloat(m[3] ?? m[1]) : h;
      };
      const was = work.classList.contains('prompting');
      (window as Watched).turned = new Promise<number[]>((done) => {
        // As last drawn before it is turned (each frame until then), then each frame after.
        const out: number[] = [now()];
        let t0 = 0;
        // Only while it is a screen at all: back in the pill, the glass is the box's again, and not seen.
        const shown = () => work.classList.contains('prompting') || work.classList.contains('prompt-leaving');
        const turned = new MutationObserver(() => {
          if (work.classList.contains('prompting') === was) return;
          turned.disconnect();
          t0 = performance.now();
        });
        turned.observe(work, {attributes: true, attributeFilter: ['class']});
        const tick = () => {
          if (!t0) out[0] = now();
          else if (shown()) out.push(now());
          if (!t0 || performance.now() - t0 < 900) requestAnimationFrame(tick); else done(out);
        };
        requestAnimationFrame(tick);
      });
    });
    return () => app.page.evaluate(() => (window as Watched).turned!);
  };
  await app.page.keyboard.press('Control+Backquote');
  await app.page.waitForTimeout(120);
  const down = await watch();
  await app.page.keyboard.press('Escape');
  const d = await down();
  // From the Escape on, it only ever gets smaller (a frame's sampling aside).
  for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThanOrEqual(d[0] + 2);
  await still(app);
  await app.page.keyboard.press('Control+Backquote');
  await still(app);
  await app.page.keyboard.press('Escape');
  await app.page.waitForTimeout(140);
  const up = await watch();
  await app.page.keyboard.press('Control+Backquote');
  const u = await up();
  // From the press on, it only ever gets bigger.
  for (let i = 1; i < u.length; i++) expect(u[i]).toBeGreaterThanOrEqual(u[0] - 2);
  await still(app);
  await app.page.keyboard.press('Escape');
  await still(app);
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

test('Edit profile opened and put away, what is under it goes one way only, with the sheet, never up and then down', async ({signedIn: app}) => {
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
  // The sheet as tall as the profile it stands for (name, handle, a line about them) moves what is under it a pixel
  // or none; whatever it moves, it moves one way.
  expect(Math.min(...opened)).toBeGreaterThan(opened[0] - 1);
  expect(opened.at(-1)!).toBeGreaterThanOrEqual(opened[0] - 1);
  await still(app);
  const shut = await track('Cancel');
  expect(Math.max(...shut)).toBeLessThan(shut[0] + 1);
  expect(Math.abs(shut.at(-1)! - opened[0])).toBeLessThan(1);
});

test('a message joining a run: the one before narrows to its words from its side, and the note over the field stays as it goes', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  await ada.inbox.writeTo(bo.handle, 'Are you coming on Saturday?');
  await expect(ada.main.getByText('Sent as request: recipient will see it once accepted.')).toBeVisible();
  await still(ada);
  // Its width, and the note's height, each frame from the press until both have settled.
  const watch = ada.page.evaluate(() => new Promise<{wide: number[]; tall: number[]}>((done) => {
    const first = document.querySelector<HTMLElement>('.inbox-messages > .bubble')!;
    const note = [...document.querySelectorAll<HTMLElement>('main [role=alert]')].find((e) => (e.textContent ?? '').startsWith('Sent as a request'))!;
    const wide: number[] = [], tall: number[] = [], t0 = performance.now();
    const tick = () => {
      wide.push(first.getBoundingClientRect().width);
      tall.push(note.isConnected ? note.getBoundingClientRect().height : 0);
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else done({wide, tall});
    };
    requestAnimationFrame(tick);
  }));
  await ada.inbox.message.fill('With the tent?');
  await ada.inbox.message.press('Control+Enter');
  const {wide, tall} = await watch;
  const from = wide[0], to = wide.at(-1)!;
  // It narrowed (its time went to the one after it)…
  expect(to).toBeLessThan(from - 8);
  // …over frames, not in one: some frame stood well between where it was and where it ended.
  expect(wide.some((w) => w < from - 2 && w > to + 2)).toBe(true);
  // The note never left its line on the way.
  expect(Math.min(...tall)).toBeGreaterThan(0);
});
