import type {Page} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Touch (DESIGN §14), measured frame by frame with motion as a person who has not asked for less sees it. One local
// principle a kind of touch, each held where it is done:
//
//   hover       under the pointer a thing goes from quiet to ink, or takes paper under it: no other fill
//   press       the thing pressed answers in the frame the press goes down, sounds as it goes down, gives a few
//               pixels and comes home on let-go, never past where it was
//   the act     every place's subject holds the place's act: something to write in or to do

test.use({reducedMotion: 'no-preference'});
const PLACES = {
  home: '.home-own > .section', 'new-repo': '.nr-box', forge: '.desk-box.held', git: '.issue-slot[aria-current="true"] .issue-card',
  server: '.slide.full', inbox: '.inbox-thread', runtime: 'main#page', remote: 'main#page',
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
const fillAt = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => {
  const el = (document.elementFromPoint(x, y) as Element | null)?.closest<HTMLElement>('button, a[href], [role=button], [role=radio], [role=tab], [role=switch]');
  return el ? getComputedStyle(el).backgroundColor : null;
}, [x, y] as const);

test('under the pointer, a thing takes paper under it or nothing: never a fill of another colour', async ({signedIn: app}) => {
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
      await app.page.waitForTimeout(140);
      const now = await fillAt(app.page, c.x, c.y);
      if (now === null) continue;
      // (Paper on its way in, its colour's 90 ms not quite over, is paper.)
      const paper = /^rgba?\(251, 250, 247/.test(now);
      expect(paper || now === c.bg || now === 'rgba(0, 0, 0, 0)', `${place}: "${c.name}" under the pointer is ${now}, from ${c.bg}`).toBe(true);
    }
  }
});

test('a press answers in its own frame, sounds as it goes down, gives a few pixels and comes home never past where it was', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.page.setViewportSize({width: 1536, height: 864});
  await app.rail.go('home');
  for (const name of ['Terminal', 'Actions for hello', '1 repo']) {
    const b = app.main.getByRole('button', {name, exact: true}).first();
    if (!(await b.count())) continue;
    const box = (await b.boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.evaluate(() => {
      const w = window as unknown as {__t: {down: number; sound: number; frames: {t: number; s: number}[]}; __el?: Element};
      w.__t = {down: 0, sound: 0, frames: []};
      const proto = AudioBufferSourceNode.prototype as unknown as {start: (...a: unknown[]) => void; __o?: (...a: unknown[]) => void};
      if (!proto.__o) { proto.__o = proto.start; proto.start = function (this: unknown, ...a: unknown[]) { if (!w.__t.sound) w.__t.sound = performance.now(); return proto.__o!.apply(this, a); }; }
      addEventListener('pointerdown', (e) => { w.__t.down = performance.now(); w.__el = (e.target as Element).closest('button')!; }, {capture: true, once: true});
      const step = () => {
        if (w.__el) { const s = getComputedStyle(w.__el).scale; w.__t.frames.push({t: performance.now(), s: s === 'none' || Number.isNaN(parseFloat(s)) ? 1 : parseFloat(s)}); }
        if (w.__t.frames.length < 50) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    await app.page.mouse.down();
    await app.page.waitForTimeout(150);
    await app.page.mouse.up();
    await app.page.waitForTimeout(500);
    const t = await app.page.evaluate(() => (window as unknown as {__t: {down: number; sound: number; frames: {t: number; s: number}[]}}).__t);
    const first = t.frames.find((f) => f.s < 1);
    expect(first, `${name}: it gives`).toBeTruthy();
    // In the frame it goes down: felt as instant at 50 ms (Swink), as one with the press within 85 (Kaaresoja), and
    // a screen's frame is 17. So it is counted in frames, not in a time a busy machine stretches: the first frame
    // drawn after the press, or the one after it (the press can come as a frame is already being drawn).
    // Heard as it goes down.
    const after = t.frames.filter((f) => f.t >= t.down);
    expect(after.indexOf(first!), `${name}: its own answer, in the frames after the press`).toBeLessThanOrEqual(1);
    expect(t.sound - t.down, `${name}: its sound`).toBeLessThanOrEqual(17);
    // A few pixels: never under .92 of itself; home, never past.
    expect(Math.min(...t.frames.map((f) => f.s)), `${name}: its give`).toBeGreaterThanOrEqual(.92);
    expect(Math.max(...t.frames.map((f) => f.s)), `${name}: never past where it was`).toBeLessThanOrEqual(1);
    expect(t.frames.at(-1)!.s, `${name}: home`).toBe(1);
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
