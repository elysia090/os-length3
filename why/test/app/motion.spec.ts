import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// Purposeful feedback is enabled by default. Navigation is immediate and interruptible;
// motion preserves direction without zooming text or holding input on a snapshot.

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
  await app.page.evaluate(() => { document.getElementById('purpose-home')!.click(); document.getElementById('purpose-server')!.click(); });
  await expect(app.rail.button('server')).toHaveAttribute('aria-current', 'page');
  await whole();
  await app.rail.go('home');
  await whole();
});

/** Two choices in the same frame. Use the real, visible Places menu on the desk in hand, not its hidden rail. */
const chooseInOneFrame = (app: App, names: string[]) => app.page.evaluate(async (names) => {
  const page = document.getElementById('page')!;
  for (const name of names) {
    const key = [...page.querySelectorAll<HTMLButtonElement>('.forge-places-key')].find((b) => b.checkVisibility());
    if (!key) throw new Error('No visible Places key');
    if (key.getAttribute('aria-expanded') !== 'true') key.click();
    const menu = document.getElementById(key.getAttribute('aria-controls')!);
    const command = [...menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []].find((b) => b.getAttribute('aria-label') === name);
    if (!command?.checkVisibility()) throw new Error(`No visible Places command "${name}"`);
    command.click();
  }
  const frames: {place: string | undefined; inks: number}[] = [];
  const to = names.at(-1)?.toLowerCase();
  const until = performance.now() + 1500;
  let arrived = 0;
  do {
    await new Promise(requestAnimationFrame);
    frames.push({place: page.dataset.place,
      inks: [...document.querySelectorAll('.glide-ink')].filter((e) => e.checkVisibility()).length});
    arrived = page.dataset.place === to ? arrived + 1 : 0;
  } while (arrived < 4 && performance.now() < until);
  return frames;
}, names);

test('pressed again before a frame can paint, Places comes to its last choice; pressed back, it stays', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  const live = await chooseInOneFrame(app, ['Server', 'Runtime']);
  await expect(app.main).toHaveAttribute('data-place', 'runtime');
  await still(app);
  // If the module is still being brought, Home can still be on screen. No frame lands in Server on the way.
  expect([...new Set(live.map((f) => f.place))].filter((p) => p !== 'home')).toEqual(['runtime']);
  expect(live.every(({inks}) => inks === 0)).toBe(true);
  await expect(app.main.getByRole('heading', {name: 'Runtime', level: 1})).toBeVisible();
  const back = await chooseInOneFrame(app, ['Home', 'Runtime']);
  expect([...new Set(back.map((f) => f.place))]).toEqual(['runtime']);
  await still(app);
  await expect(app.main).toHaveAttribute('data-place', 'runtime');
  await expect(app.page.locator('.place-left')).toHaveCount(0);
});

test('File\'s tree out and away is a cut: Places stays on the same page and does not move the desk', async ({app}) => {
  await app.newRepo.make('field-notes');
  await app.rail.go('home');
  await still(app);
  const places = app.forge.placesKey;
  const before = await places.boundingBox();
  expect(before).not.toBeNull();
  // The tree may have its own appearance, but Home and its corner are fixed through both directions.
  const watch = () => places.evaluate((key) => new Promise<{page: string | undefined; x: number; y: number; passing: boolean}[]>((done) => {
    const seen: {page: string | undefined; x: number; y: number; passing: boolean}[] = [];
    const page = document.getElementById('page')!;
    const tick = () => {
      const {x, y} = key.getBoundingClientRect();
      seen.push({page: page.dataset.place, x, y,
        passing: !!document.querySelector('.place-left') || document.documentElement.matches(':active-view-transition')
          || [...document.querySelectorAll('.glide-ink')].some((e) => e.checkVisibility())});
      if (seen.length < 24) requestAnimationFrame(tick); else done(seen);
    };
    requestAnimationFrame(tick);
  }));
  const file = await app.rail.destination('file');
  const out = watch();
  await file.click();
  await expect(app.file.tree).toBeVisible();
  await expect(app.forge.places).toBeHidden();
  await expect(app.file.tree.getByRole('button', {name: 'field-notes', exact: true})).toBeFocused();
  const back = watch();
  await app.page.keyboard.press('Escape');
  await expect(app.file.tree).toBeHidden();
  await expect(places).toBeFocused();
  expect(await places.boundingBox()).toEqual(before);
  for (const f of [...await out, ...await back]) expect(f).toEqual({page: 'home', x: before!.x, y: before!.y, passing: false});
});

test('the rail pressed twice before the page has come: the place pressed last is the one inked, at once, and no ink goes between', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  await app.page.evaluate(() => { document.getElementById('purpose-server')!.click(); document.getElementById('purpose-runtime')!.click(); });
  await expect(app.rail.button('runtime')).toHaveAttribute('aria-current', 'page');
  expect(await app.page.locator('#rail-tabs .glide-ink').count()).toBe(0);
  await still(app);
  await expect(app.rail.button('runtime')).toHaveAttribute('aria-current', 'page');
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

test('navigation is immediately interactive while its content arrives, without scaling the desk', async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('home');
  await still(app);
  const at = await app.page.evaluate(() => new Promise<{moving: string[]; forge: boolean; home: boolean; panning: boolean}>((done) => {
    document.getElementById('purpose-forge')!.click();
    const now = {forge: !!document.querySelector('#page .desk:not([hidden])'), home: !!document.querySelector('#page .home-layout'),
      panning: document.documentElement.matches('.panning, :active-view-transition')};
    // What runs in the frames after the press: the world's one move, as soon as the page come to is drawn.
    const moving = new Set<string>();
    let n = 0;
    const step = () => {
      for (const a of document.getAnimations()) if (a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity) moving.add(((a.effect as KeyframeEffect).target as Element | null)?.className.toString() || 'body');
      if (++n < 12) requestAnimationFrame(step); else done({...now, moving: [...moving]});
    };
    requestAnimationFrame(step);
  }));
  expect(at.forge).toBe(true);
  expect(at.home).toBe(false);
  expect(at.panning).toBe(false);
  // The world moves (§8, the one move); nothing else goes between, the rail's ink included.
  expect(at.moving).not.toContain('glide-ink');
  expect(at.moving.length).toBeGreaterThan(0);
  expect(await app.page.evaluate(() => getComputedStyle(document.querySelector('#page .desk:not([hidden]) .desk-plane')!).transform)).toBe('none');
  // Redirect before arrival ends: the last page is the only one left, with no root transform.
  await app.page.evaluate(() => { document.getElementById('purpose-runtime')!.click(); document.getElementById('purpose-home')!.click(); });
  await still(app);
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  expect(await app.main.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

test('reduced motion settles an in-flight navigation and restores motion when switched back', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  await app.page.evaluate(() => document.getElementById('purpose-runtime')!.click());
  await app.page.emulateMedia({reducedMotion: 'reduce'});
  await still(app);
  expect(await app.page.locator('.glide-ink').count()).toBe(0);
  await app.page.evaluate(() => document.getElementById('purpose-home')!.click());
  expect(await app.page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  await expect(app.rail.button('home')).toHaveAttribute('aria-current', 'page');
  await app.page.emulateMedia({reducedMotion: 'no-preference'});
  // Motion back: the world moves again to a place gone to (its pages, under the frame).
  expect(await app.page.evaluate(() => new Promise<number>((done) => {
    document.getElementById('purpose-runtime')!.click();
    let most = 0, n = 0;
    const step = () => { most = Math.max(most, document.getAnimations().filter((a) => a.playState === 'running').length); if (++n < 12) requestAnimationFrame(step); else done(most); };
    requestAnimationFrame(step);
  }))).toBeGreaterThan(0);
  await still(app);
});

test('a press is let go when the pointer is cancelled, and being held is shown with less motion asked for too (a state, not a move)', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  const toggle = app.forge.placesKey;
  await expect(toggle).toBeVisible();
  await toggle.dispatchEvent('pointerdown', {button: 0});
  await expect.poll(() => toggle.evaluate((el) => Number(getComputedStyle(el).scale))).toBeLessThan(1);
  await toggle.dispatchEvent('pointercancel');
  await still(app);
  expect(await toggle.evaluate((el) => getComputedStyle(el).scale)).toBe('none');
  await app.page.emulateMedia({reducedMotion: 'reduce'});
  await toggle.dispatchEvent('pointerdown', {button: 0});
  expect(Number(await toggle.evaluate((el) => getComputedStyle(el).scale))).toBeLessThan(1);
  await toggle.dispatchEvent('pointerup', {button: 0});
  expect(await toggle.evaluate((el) => getComputedStyle(el).scale)).toBe('none');
  await expect(app.forge.places).toBeHidden();
});


test('less motion asked for during a held press keeps it held; let go, it is up at once and nothing is replayed', async ({app}) => {
  await app.rail.go('home');
  await still(app);
  const toggle = app.forge.placesKey;
  await expect(toggle).toBeVisible();
  const scale = () => toggle.evaluate((el) => getComputedStyle(el).scale);
  await toggle.dispatchEvent('pointerdown', {button: 0});
  await expect.poll(async () => Number(await scale())).toBeLessThan(1);
  // Held is a state, not a move: less motion asked for keeps it held, and let go it is up at once.
  await app.page.emulateMedia({reducedMotion: 'reduce'});
  expect(Number(await scale())).toBeLessThan(1);
  await app.page.emulateMedia({reducedMotion: 'no-preference'});
  await toggle.dispatchEvent('pointerup', {button: 0});
  expect(await scale()).toBe('none');
  // A subsequent real press still works after the preference is restored.
  await toggle.dispatchEvent('pointerdown', {button: 0});
  await expect.poll(async () => Number(await scale())).toBeLessThan(1);
  await toggle.dispatchEvent('pointercancel');
  await still(app);
  expect(await scale()).toBe('none');
  await expect(app.forge.places).toBeHidden();
});

test('going to another place the world goes by: the place left, the place come to and the ground move as one, a window\'s height in whole cells, off within 50 ms of the press and at rest within 420 ms', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  await still(app);
  const U = 24;
  const been = new Set<string>();
  for (const [to, dir] of [['forge', 1], ['home', -1], ['runtime', 1], ['home', -1]] as const) {
    // Measure the actual destination's press, not the press that opens the Places menu.
    const destination = await app.rail.destination(to);
    await still(app);
    await expect(destination).toBeVisible();
    const from = await app.main.getAttribute('data-place');
    const far = U * Math.round((await app.page.evaluate(() => innerHeight)) / U);
    // Every frame of the move: how far the place left has gone, the place come to, and the ground's dots.
    const frames = app.page.evaluate(() => new Promise<{t: number; left: number | null; come: number | null; dots: number; place: string}[]>((done) => {
      const out: {t: number; left: number | null; come: number | null; dots: number; place: string}[] = [], t0 = performance.now();
      // When the press went down (on the page's clock, as the frames are).
      addEventListener('pointerdown', (e) => { out.push({t: e.timeStamp - t0, left: null, come: null, dots: 0, place: 'pressed'}); }, {capture: true, once: true});
      const y = (el: Element | null) => (el ? new DOMMatrix(getComputedStyle(el).transform).m42 : null);
      const page = document.getElementById('page')!;
      let coming: Element | null = null;
      const step = () => {
        const t = performance.now() - t0;
        const left = document.querySelector('.place-left');
        // Look among the playing effects, not every descendant of the page on every measured frame.
        if (left && !coming?.isConnected) {
          const effects = document.getAnimations().map((a) => a.effect as KeyframeEffect | null);
          coming = effects.find((e) => e?.target && page.contains(e.target)
            && e.getKeyframes().some((k) => /translateY/.test(String(k.transform ?? ''))))?.target ?? null;
        }
        out.push({t, left: y(left), come: left ? y(coming) : null, dots: parseFloat(getComputedStyle(document.body).backgroundPositionY) || 0, place: page.dataset.place ?? ''});
        if (t < 800) requestAnimationFrame(step); else done(out);
      };
      requestAnimationFrame(step);
    }));
    await destination.click();
    const got = await frames, pressed = got.find((f) => f.place === 'pressed')!.t, all = got.filter((f) => f.place !== 'pressed');
    const moving = all.filter((f) => f.left !== null);
    const firstDrawn = moving.find((f) => Math.abs(f.left!) > .5);
    expect(firstDrawn, `${from} to ${to}: the world actually moves`).toBeDefined();
    // Caused by the press (Michotte: a motion is seen as caused by another that starts it within 50 ms): the world off
    // within 50 ms of the press going down, and a frame (what is measured is the frame it is drawn in). (Forge the
    // first time is not yet so, §11: its desk is built first.)
    if (!(to === 'forge' && !been.has(to))) expect(firstDrawn!.t - pressed, `${from} to ${to}: off within 50 ms of the press`).toBeLessThanOrEqual(50 + 1000 / 60);
    been.add(to);
    // The place left stays in sight as the world moves, and the one come to follows it at one distance: no gap
    // opens or closes between them, and the ground's dots go as they do.
    expect(moving.length, `to ${to}`).toBeGreaterThan(5);
    expect(moving.some((f) => f.come !== null), `to ${to}: the incoming page moves as well`).toBe(true);
    for (const f of moving) {
      if (f.come !== null) expect(Math.abs(f.come - dir * far - f.left!), `to ${to}: the two places a window apart`).toBeLessThan(1.5);
      expect(Math.abs(f.dots - f.left!), `to ${to}: the dots with the places`).toBeLessThan(1.5);
    }
    // One way, never back; most of the way in the first third of its time; at rest within 420 ms (and a frame).
    for (let i = 1; i < moving.length; i++) expect(dir * (moving[i - 1].left! - moving[i].left!), `to ${to}: one way`).toBeGreaterThanOrEqual(-.01);
    const first = moving[0], last = moving.at(-1)!, third = moving.find((f) => f.t - first.t >= (last.t - first.t) / 3)!;
    expect(Math.abs(third.left!) / far, `to ${to}: off at once`).toBeGreaterThan(.6);
    expect(last.t - first.t, `to ${to}: its time`).toBeLessThanOrEqual(470);
    // At rest: the place left is gone, the dots stand where they stood, and the way was whole cells.
    const end = all.at(-1)!;
    expect([end.left, end.dots, end.place], `to ${to}: at rest`).toEqual([null, 0, to]);
    expect(far % U).toBe(0);
    await still(app);
  }
});
