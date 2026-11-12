import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// The moves (DESIGN.md §1, Motion). Every move but one is left out (ui/glide.ts still, motion.css): the rail's ink
// going from the place left to the place come to. Here that one is seen to go where it says and to end there, the
// rest are seen not to be there (a page come to by the rail is whole at once, at its own size), and the caret the OS
// draws follows what is written.

test.use({reducedMotion: 'no-preference'});

/**
 * Every move with an end has ended (the caret's blink, which has none, goes on): waited for as each says it ends, and
 * looked at again a frame later for those its end set going, not polled at intervals that outlast it.
 */
const still = (app: App) => app.page.evaluate(async () => {
  const moving = () => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
  const until = performance.now() + 10_000;
  // A frame first: what the last key or press set going in its next frame is going by then.
  for (;;) {
    await new Promise(requestAnimationFrame);
    const now = moving();
    if (!now.length) return;
    if (performance.now() > until) throw new Error(`still moving after 10 s: ${now.map((a) => (a as CSSAnimation).animationName ?? a.id).join(', ')}`);
    await Promise.all(now.map((a) => a.finished.catch(() => {})));
  }
});

test('going along the rail, the next page stands whole at once, its cards each in place', async ({app}) => {
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

test('leaving a frameless page releases its camera before the shared page is reused, including repeated and redirected pans', async ({app}) => {
  // Runtime's ground is #page itself; Home's ground is below its frame. A transform left on the shared
  // parent made Home half-size even after its own camera had landed, and compounded on further trips.
  const whole = async () => {
    await still(app);
    expect(await app.main.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    expect(await app.main.evaluate((el) => Math.abs(el.getBoundingClientRect().width - (el as HTMLElement).offsetWidth))).toBeLessThan(1);
  };
  for (const place of ['home', 'runtime', 'home', 'runtime', 'remote', 'home'] as const) {
    await app.rail.go(place);
    await whole();
  }
  await app.rail.go('runtime');
  await whole();
  // A newer request before leaving Runtime replaces the first destination, without keeping its camera.
  await app.page.evaluate(() => { document.getElementById('purpose-home')!.click(); document.getElementById('purpose-git')!.click(); });
  await expect(app.rail.button('git')).toHaveAttribute('aria-current', 'page');
  await whole();
  await app.rail.go('home');
  await whole();
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

test('Home\'s right pane put away and brought back: its switch stays under the hand, the band\'s search stays where it is', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  const toggle = app.main.getByRole('button', {name: 'Right pane'});
  const search = app.main.getByRole('searchbox', {name: /^Search/});
  const at = (await toggle.boundingBox())!;
  const where = (await search.boundingBox())!;
  await toggle.click();
  // Put away, it is gone at once: nothing of it is left on its way.
  await expect(app.main.getByRole('complementary', {name: 'Recent activity'})).toBeHidden();
  await still(app);
  // The switch where it stood, and the search on the band where it was: neither is the pane's to take away.
  expect(Math.abs((await toggle.boundingBox())!.x - at.x)).toBeLessThan(1);
  expect(Math.abs((await toggle.boundingBox())!.y - at.y)).toBeLessThan(1);
  await expect(search).toBeVisible();
  expect(Math.abs((await search.boundingBox())!.x - where.x)).toBeLessThan(1);
  await toggle.click();
  await still(app);
  await expect(app.main.getByRole('complementary', {name: 'Recent activity'})).toBeVisible();
  expect(Math.abs((await toggle.boundingBox())!.x - at.x)).toBeLessThan(1);
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
  // A letter written puts it after the letter in the frame the letter is drawn in: it never glides there, over the
  // letter just written, a letter behind at every key.
  // (Written and looked at in one go in the page: a key sent from here comes back after the glide would be over.)
  const drawn = await caret.evaluate(async (e) => {
    document.execCommand('insertText', false, 's');
    await new Promise((go) => requestAnimationFrame(go));
    return new DOMMatrix(getComputedStyle(e).transform).e;
  });
  expect(Math.abs(drawn - (await at()).x)).toBeLessThan(0.5);
  expect(drawn).toBeGreaterThan(b.x + 4);
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

test('nothing moves but the rail\'s ink: a place pressed, its page is there at once at its own size, and only the ink is on its way', async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('home');
  await still(app);
  // Pressed, in the same frame: Forge is the page, nothing of Home left, nothing scaled or carried, no picture of a page
  // going by; what is on its way is the rail's ink and nothing else.
  const at = await app.page.evaluate(async () => {
    document.getElementById('purpose-forge')!.click();
    await new Promise(requestAnimationFrame);
    const moving = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => ((a.effect as KeyframeEffect).target as Element | null)?.className ?? '');
    return {moving, forge: !!document.querySelector('#page .desk:not([hidden])'), home: !!document.querySelector('#page .home-layout'),
      panning: document.documentElement.matches('.panning, :active-view-transition')};
  });
  expect(at.forge).toBe(true);
  expect(at.home).toBe(false);
  expect(at.panning).toBe(false);
  expect(at.moving.filter((c) => c !== 'glide-ink')).toEqual([]);
  expect(at.moving).toContain('glide-ink');
  // The desk is not stood back by the rail: no camera went with the press, its plane at its own size.
  expect(await app.page.evaluate(() => getComputedStyle(document.querySelector('#page .desk:not([hidden]) .desk-plane')!).transform)).toBe('none');
  await still(app);
  // And back: Home whole at once, as large as it is read (nothing of it scaled or carried).
  await app.page.evaluate(() => document.getElementById('purpose-home')!.click());
  await expect(app.main.getByRole('heading', {name: 'Servers', exact: true})).toBeVisible();
  expect(await app.page.evaluate(() => { const cs = getComputedStyle(document.querySelector('#page .home-layout')!); return `${cs.scale} ${cs.transform} ${cs.translate}`; })).toBe('none none none');
});
