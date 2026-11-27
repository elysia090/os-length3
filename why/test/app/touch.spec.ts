import type {Page} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Touch (DESIGN §14), measured frame by frame with motion as a person who has not asked for less sees it. One local
// principle a kind of touch, each held where it is done:
//
//   hover       under the pointer a thing goes from quiet to ink, or takes paper under it: no other fill
//   press       the thing pressed answers in the frame the press goes down, sounds as it goes down, gives a few
//               pixels and comes home on let-go, never past where it was
//   the act     every place's subject holds the place's act: something to write in or to do
//   write       a letter typed is there in the frame after its key, and there still when the place is come back to
//   unfold      a folder's name opens it and shuts it again, and does nothing else: what is under it stays
//   close       Escape is the way out of what is asked, as of what is called up (remote.spec.ts holds an ask's)
//   switch      a part pressed is shown in the frame after, what it holds with it; the arrows go to the next
//   back        Back goes to the place before, Forward to the one after: never out of the OS from a place gone through

test.use({reducedMotion: 'no-preference'});
const PLACES = {
  home: '.home-own > .section', 'new-repo': '.nr-box', forge: '.desk-box.held', git: '.issue-slot[aria-current="true"] .issue-card',
  server: '.server-paper', inbox: '.inbox-thread', runtime: 'main#page', remote: 'main#page',
} as const;

/** In the page: the controls in sight, in order from the top right. */
function controls() {
  const sel = 'button, a[href], [role=button], [role=radio], [role=tab], [role=switch]';
  return [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => {
    const r = el.getBoundingClientRect(), c = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && c.visibility !== 'hidden'
      && !el.closest('.sr-only, [hidden], [inert], [aria-hidden=true]') && !(el as HTMLButtonElement).disabled;
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return {name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30), x: r.left + r.width / 2, y: r.top + r.height / 2, bg: getComputedStyle(el).backgroundColor};
  }).sort((a, b) => Math.floor(a.y / 24) - Math.floor(b.y / 24) || b.x - a.x);
}

/** What is under `x, y` now: its fill. */
/** Under the pointer at (x, y): the control's fill in each of the next four frames (at once, it is one colour). */
const fillAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => new Promise<string[] | null>((done) => {
  const el = (document.elementFromPoint(x, y) as Element | null)?.closest<HTMLElement>('button, a[href], [role=button], [role=radio], [role=tab], [role=switch]');
  if (!el) { done(null); return; }
  const seen: string[] = [];
  const step = () => { seen.push(getComputedStyle(el).backgroundColor); if (seen.length < 4) requestAnimationFrame(step); else done(seen); };
  requestAnimationFrame(step);
}), [x, y] as const);

test('under the pointer, a thing takes paper under it or nothing, at once: never a fill of another colour, never one on its way', async ({signedIn: app}) => {
  test.setTimeout(300_000);
  await app.newRepo.make('hello', {template: 'C'});
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.page.setViewportSize({width: 1536, height: 864});
  for (const place of Object.keys(PLACES) as (keyof typeof PLACES)[]) {
    await app.rail.go(place);
    await app.page.mouse.move(2, 700);
    await app.page.waitForTimeout(300);
    for (const c of (await app.page.evaluate(controls)).slice(0, 40)) {
      await app.page.mouse.move(c.x, c.y);
      const frames = await fillAt(app.page, c.x, c.y);
      if (frames === null) continue;
      // At once (DESIGN §14: what answers the hand is there in the frame, not on its way): one colour in every frame.
      expect(new Set(frames).size, `${place}: "${c.name}" under the pointer went ${frames.join(' → ')}`).toBe(1);
      const now = frames[0]!;
      const paper = /^rgb\(253, 250, 244\)$/.test(now);
      expect(paper || now === c.bg || now === 'rgba(0, 0, 0, 0)', `${place}: "${c.name}" under the pointer is ${now}, from ${c.bg}`).toBe(true);
    }
  }
});

test('a press answers in its own frame, sounds as it goes down, is held down a few pixels and is up the moment it is let go', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.page.setViewportSize({width: 1536, height: 864});
  await app.rail.go('home');
  type Trace = {down: number; up: number; sound: number; frames: {t: number; s: number}[]};
  const trace = () => app.page.evaluate(() => (window as unknown as {__press: Trace}).__press);
  for (const name of ['Home', 'Actions for hello', 'Search']) {
    const b = app.main.getByRole('button', {name, exact: true});
    await expect(b).toBeVisible();
    await b.hover();
    const box = (await b.boundingBox())!;
    await b.evaluate((el) => {
      const w = window as unknown as {__press: Trace};
      const press: Trace = w.__press = {down: 0, up: 0, sound: 0, frames: []};
      const proto = AudioBufferSourceNode.prototype as unknown as {start: (...a: unknown[]) => void; __o?: (...a: unknown[]) => void};
      if (!proto.__o) {
        proto.__o = proto.start;
        proto.start = function (this: unknown, ...a: unknown[]) {
          const current = w.__press;
          if (current.down && !current.up && !current.sound) current.sound = performance.now();
          return proto.__o!.apply(this, a);
        };
      }
      // Capture this exact button from its real pointerdown. A frame sampler left over from a previous button can
      // otherwise finish before the next press on a busy runner, or record the previous detached control.
      const begin = (e: PointerEvent) => {
        if (!(e.target instanceof Node) || !el.contains(e.target)) return;
        removeEventListener('pointerdown', begin, true);
        press.down = performance.now();
        addEventListener('pointerup', () => { press.up = performance.now(); }, {capture: true, once: true});
        let after = 0;
        const step = () => {
          const scale = parseFloat(getComputedStyle(el.querySelector(':scope > [data-press-face]') ?? el).scale);
          press.frames.push({t: performance.now(), s: Number.isNaN(scale) ? 1 : scale});
          if (!press.up || ++after < 4) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      addEventListener('pointerdown', begin, true);
    });
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    try { await expect.poll(async () => (await trace()).frames.length, {message: `${name}: actually pressed`}).toBeGreaterThanOrEqual(4); }
    finally { await app.page.mouse.up(); }
    await expect.poll(async () => { const t = await trace(); return t.frames.filter((f) => f.t > t.up).length; }).toBe(4);
    const t = await trace();
    const first = t.frames.find((f) => f.s < 1);
    expect(first, `${name}: it gives`).toBeTruthy();
    // In the frame it goes down: felt as instant at 50 ms (Swink), as one with the press within 85 (Kaaresoja), and
    // a screen's frame is 17. So it is counted in frames, not in a time a busy machine stretches: the first frame
    // drawn after the press, or the one after it (the press can come as a frame is already being drawn).
    // Heard as it goes down.
    const after = t.frames.filter((f) => f.t >= t.down);
    expect(after.indexOf(first!), `${name}: its own answer, in the frames after the press`).toBeLessThanOrEqual(1);
    expect(t.sound, `${name}: the press actually sounds`).toBeGreaterThanOrEqual(t.down);
    expect(t.sound - t.down, `${name}: its sound`).toBeLessThanOrEqual(17);
    // A few pixels: never under .92 of itself; home, never past.
    expect(Math.min(...t.frames.map((f) => f.s)), `${name}: its give`).toBeGreaterThanOrEqual(.92);
    expect(Math.max(...t.frames.map((f) => f.s)), `${name}: never past where it was`).toBeLessThanOrEqual(1);
    expect(t.frames.at(-1)!.s, `${name}: home`).toBe(1);
    // Home the moment it is let go: no frame on its way back (the ear hears the let-go; the eye is not told it twice).
    const back = t.frames.filter((f) => f.t > t.up);
    expect(back.slice(1).every((f) => f.s === 1), `${name}: up at once, not drawn coming home (${back.slice(0, 4).map((f) => f.s.toFixed(3)).join(' ')})`).toBe(true);
    await app.page.keyboard.press('Escape');
  }
});

test('a screen is for its act: every place\'s subject holds something to write in or to do', async ({signedIn: app, another}) => {
  test.setTimeout(240_000);
  await app.rail.go('home');
  await app.home.title(app.home.items.first()).pressSequentially('Fix: The tent leaks');
  await app.newRepo.make('hello', {template: 'C'});
  await app.git.write('hello', 'Fix: Say hello louder');
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.server.makeBoard('Packing');
  const bo = await another('Bo');
  await bo.inbox.named();
  await app.inbox.named();
  await app.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');
  for (const [place, subject] of Object.entries(PLACES)) {
    await app.rail.go(place as keyof typeof PLACES);
    if (place === 'forge') await app.forge.editor('README.md').focus();
    const within = subject === 'main#page' ? app.main : app.main.locator(subject).first();
    const acts = within.locator('textarea:not([disabled]), input:not([type=hidden]):not([disabled]), [contenteditable=true], [contenteditable=plaintext-only], button:not([disabled]), [role=switch]');
    await expect.poll(() => acts.count(), {message: `${place}: its subject holds its act`}).toBeGreaterThan(0);
  }
});

test('scrolled by hand, what is scrolled stays under the hand and nothing else moves: no easing laid on it, nothing coming or going', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.page.setViewportSize({width: 1536, height: 864});
  await app.rail.go('forge');
  await app.forge.editFile('README.md', Array.from({length: 120}, (_, i) => `line ${i + 1}`).join('\n'));
  const file = app.forge.editor('README.md');
  const box = (await file.boundingBox())!;
  await app.page.mouse.move(box.x + 60, box.y + 120);
  // (At rest first: the desk's own turn to the file, asked before, is over.)
  await app.page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await app.page.waitForTimeout(200);
  // Each frame while the wheel turns: where the file is scrolled to, and what is animating on the page.
  await app.page.evaluate(() => {
    const w = window as unknown as {__s: {t: number; top: number; moving: string[]}[]; __w: number[]};
    w.__s = []; w.__w = [];
    addEventListener('wheel', () => w.__w.push(performance.now()), {capture: true, passive: true});
    const area = document.querySelector('.desk-box.held .desk-file') as HTMLElement;
    const step = () => {
      const moving = document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
        const t = (a as CSSAnimation).effect && ((a.effect as KeyframeEffect).target as Element | null);
        return t ? t.className.toString().slice(0, 30) : '?';
      });
      w.__s.push({t: performance.now(), top: area.scrollTop, moving});
      if (w.__s.length < 60) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  for (let i = 0; i < 6; i++) { await app.page.mouse.wheel(0, 72); await app.page.waitForTimeout(30); }
  await app.page.waitForTimeout(700);
  const s = await app.page.evaluate(() => { const w = window as unknown as {__s: {t: number; top: number; moving: string[]}[]; __w: number[]}; return {__s: w.__s, __w: w.__w}; });
  // It went where the wheel took it, and in the frame after the wheel turned (Deber et al. 2015: a lag is seen at 11 ms).
  expect(s.__s.at(-1)!.top, 'scrolled by the wheel').toBeGreaterThan(0);
  const first = s.__w[0]!, moved = s.__s.find((f) => f.top > 0)!;
  expect(s.__s.filter((f) => f.t > first && f.t <= moved.t).length, 'in the frame after the wheel turned').toBeLessThanOrEqual(2);
  // Nothing animates while it scrolls: no easing laid on it, nothing faded in or out by it.
  expect([...new Set(s.__s.flatMap((f) => f.moving))], 'what moved besides the scrolled file').toEqual([]);
});

/** In the page: from now, for each letter keyed in the field the keyboard is in, whether it was there two frames after its key. */
const keepWatch = (page: Page) => page.evaluate(() => {
  const w = window as unknown as {__late: string[]; __keyed: number; __watching?: true};
  w.__late = []; w.__keyed = 0;
  if (w.__watching) return;
  w.__watching = true;
  const read = () => { const f = document.activeElement as HTMLInputElement | null; return f && 'value' in f ? String(f.value) : ''; };
  addEventListener('keydown', (e) => {
    if (e.key.length !== 1) return;
    w.__keyed++;
    const before = read();
    requestAnimationFrame(() => requestAnimationFrame(() => { if (read() === before) w.__late.push(e.key); }));
  }, {capture: true});
});
const late = (page: Page) => page.evaluate(() => { const w = window as unknown as {__late: string[]; __keyed: number}; return {late: w.__late, keyed: w.__keyed}; });

test('a letter typed is there in the frame after its key, in every field; and what was written is there still when its place is come back to', async ({signedIn: app, another}) => {
  test.setTimeout(240_000);
  await app.page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('hello', {template: 'C'});
  await app.git.write('hello', 'Fix: Say hello louder');
  const bo = await another('Bo');
  await bo.inbox.named();
  await app.inbox.named();
  await app.inbox.writeTo(bo.handle, 'Question: are you coming?');
  const fields = [
    {place: 'git', to: () => app.git.toNew(), field: () => app.git.firstLine, text: 'Fix: Mind the gap'},
    {place: 'forge', to: null, field: () => app.forge.editor('README.md'), text: 'tide'},
    {place: 'inbox', to: null, field: () => app.inbox.message, text: 'See you there'},
  ] as const;
  for (const f of fields) {
    await app.rail.go(f.place);
    await f.to?.();
    await f.field().click();
    await app.page.keyboard.press('End');
    await keepWatch(app.page);
    for (const ch of f.text) { await app.page.keyboard.type(ch); await app.page.waitForTimeout(30); }
    await app.page.waitForTimeout(100);
    const seen = await late(app.page);
    expect(seen.keyed, `${f.place}: keyed`).toBe(f.text.length);
    expect(seen.late, `${f.place}: letters not there in the frame after their key`).toEqual([]);
  }
  // Gone from and come back to, each place has what was written in it, where it was written.
  for (const f of fields) {
    await app.rail.go('home');
    await app.rail.go(f.place);
    await expect(f.field(), `${f.place}: kept`).toHaveValue(new RegExp(`${f.text}$`));
  }
});

test('a folder in File opens by its name and shuts by it again, and does nothing else: the page under the tree stays where it is', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('home');
  // The preceding Forge → Home move is setup, not a move caused by unfolding the folder.
  await expect(app.page.locator('.place-left')).toHaveCount(0);
  const src = await app.file.item('hello', 'src');
  const name = src.getByRole('button', {name: 'src', exact: true}).first();
  const title = await app.page.title();
  const shown = () => src.evaluate((el) => [...el.querySelectorAll('[role=treeitem]')].filter((r) => (r as HTMLElement).getClientRects().length).length);
  for (const open of [await src.getAttribute('aria-expanded') !== 'true', await src.getAttribute('aria-expanded') === 'true']) {
    await name.click();
    // At once (nothing folds on its way), and nothing else: still Home under the tree, no world's move.
    await expect(src).toHaveAttribute('aria-expanded', String(open));
    expect(await shown(), `what is in it, ${open ? 'open' : 'shut'}`)[open ? 'toBeGreaterThan' : 'toBe'](0);
    expect(await app.page.title(), 'the place under the tree').toBe(title);
    expect(await app.page.evaluate(() => document.querySelectorAll('.place-left').length), 'no world moving behind it').toBe(0);
  }
});

test('Back goes to the place before and Forward to the one after, however many were gone through; Back never leaves the OS', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  const at = () => app.page.evaluate(() => document.title.split(' · ')[0]);
  await app.rail.go('home');
  await app.rail.go('runtime');
  await app.rail.go('server');
  // (The place one is at, pressed, is no step.)
  await app.rail.go('server');
  const os = app.page.url();
  for (const [step, place] of [['back', 'Runtime'], ['back', 'Home'], ['forward', 'Runtime'], ['forward', 'Server']] as const) {
    if (step === 'back') await app.page.goBack(); else await app.page.goForward();
    await expect.poll(at, {message: `${step} to ${place}`}).toBe(place);
    expect(app.page.url(), 'still the OS').toBe(os);
    await expect(app.rail.button(place.toLowerCase() as 'home')).toHaveAttribute('aria-current', 'page');
  }
  // Remote in Home's Places is a step as any other choice: there and Back again.
  await app.rail.go('home');
  const remote = await app.rail.destination('remote');
  await expect(remote).toBeVisible();
  await remote.click();
  await expect.poll(at).toBe('Remote');
  await app.page.goBack();
  await expect.poll(at).toBe('Home');
});

test('a page\'s part pressed is shown in the frame after, what it holds with it; the arrows go to the next and the one before', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  for (const place of ['runtime', 'remote'] as const) {
    await app.rail.go(place);
    const tabs = app.main.getByRole('tab');
    const n = await tabs.count();
    expect(n, `${place}: its parts`).toBeGreaterThan(1);
    /** In the frame after now: which part is chosen, and whether what it holds is shown. */
    const chosen = () => app.page.evaluate(() => new Promise<{name: string; shown: boolean}>((done) => requestAnimationFrame(() => {
      const tab = document.querySelector<HTMLElement>('main [role=tab][aria-selected=true]');
      const panel = tab && document.getElementById(tab.getAttribute('aria-controls') ?? '');
      done({name: tab?.textContent?.trim() ?? '', shown: !!panel && !panel.hidden && panel.getClientRects().length > 0});
    })));
    await tabs.nth(1).click();
    const second = (await tabs.nth(1).textContent())!.trim();
    expect(await chosen(), `${place}: pressed`).toEqual({name: second, shown: true});
    await app.page.keyboard.press('ArrowRight');
    // (The last part's next is the first.)
    const next = n > 2 ? 2 : 0, third = (await tabs.nth(next).textContent())!.trim();
    expect(await chosen(), `${place}: the arrow to the next`).toEqual({name: third, shown: true});
    await expect(tabs.nth(next)).toBeFocused();
    await app.page.keyboard.press('ArrowLeft');
    expect(await chosen(), `${place}: the arrow back`).toEqual({name: second, shown: true});
  }
});
