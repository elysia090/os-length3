import {expect, test} from './fixtures.ts';

// The frame (DESIGN §4, its measure and its laws): the rail's column and the band's row, the camera's own
// instruments, held in every place at six screens from a large desk's to the smallest phone's. Measured, not looked at:
//
//   one degree      the frame is 2 cells (48 px, about 1° at arm's length) every way, on every screen
//   receding        it takes no more of a desk screen than film's safe-action margin does (13.5%)
//   one square      every place of the rail a 36 px square at a 48 px pitch from (6, 6), its mark 18 px drawn at 2 px
//   constant        the rail the same where it stands; a place name on the left and Search on the right even before a repo exists
//   two sides       no work through the top strip, or through the desk's left measure (one cell in narrow Forge)
//   quiet           at rest the frame's marks and words are the frame's quiet colour, its lines the quiet line, nothing
//                   in it filled with ink; ink only on the place one is in and what is chosen there

const U = 24, F = 2 * U;
const SIZES = [{width: 1920, height: 1080}, {width: 1536, height: 864}, {width: 1366, height: 768}, {width: 1024, height: 768}, {width: 390, height: 844}, {width: 320, height: 568}];
const PLACES = ['home', 'new-repo', 'forge', 'git', 'server', 'inbox', 'runtime', 'remote'] as const;
const INK = 'rgb(23, 22, 21)', FRAME = 'rgb(84, 82, 80)';
const QUIET = 'rgb(193, 190, 176)', PAPER = 'rgb(239, 235, 227)';
const CORNER: Partial<Record<typeof PLACES[number], string>> = {home: QUIET, 'new-repo': QUIET, forge: QUIET, git: QUIET, server: QUIET, inbox: PAPER, runtime: QUIET};

/** The frame as it stands now: run in the page. */
function framed() {
  // (In the page: the frame's two cells, and ink.)
  const W = innerWidth, H = innerHeight, F = 48, INK = 'rgb(23, 22, 21)';
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10); };
  const shown = (el: Element) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0; };
  const places = [...document.querySelectorAll('.rail .rail-item')].filter(shown).map((b) => {
    const mark = b.querySelector('svg.icon')!, path = mark.querySelector('path, line, circle, rect, polyline, polygon');
    return {label: b.getAttribute('aria-label') ?? '', box: box(b), mark: box(mark), stroke: path ? getComputedStyle(path).strokeWidth : '', colour: getComputedStyle(b).color, current: b.getAttribute('aria-current') === 'page'};
  });
  // What of the world is seen in the frame's strips: anything outside the frame's own that is painted there.
  const own = '.rail, .door, .home-band, .work > .bar, .server-top, .server-bar, .server-masthead, .server-sidebar, .server-overline, .band-tools, .band-held, .page-veil, .forge-title, .git-title, .inbox-title, .inbox-over, .runtime-masthead > h1, .forge-places-key, .forge-search-key, .sr-only';
  // A narrow desk can use one cell of left margin; the top strip does not change.
  const place = document.getElementById('page')?.dataset.place;
  const one = place === 'home' || place === 'runtime' || place === 'new-repo' ? 600 : place === 'forge' || place === 'inbox' || place === 'server' ? 999 : 0;
  const left = W <= one ? 24 : F;
  const intrudes: string[] = [];
  for (const el of document.querySelectorAll('#page *')) {
    if (el.closest(own) || !shown(el) || el.children.length) continue;
    const r = el.getBoundingClientRect();
    // A point of it in the top strip (in the middle of what of it is there), and one in the left strip. (A name set by
    // its ink against an edge has its box a pixel or two past it, its letters' side bearing: that is not in the frame.)
    const IN = F - 2;
    const mid = (a: number, b: number) => (a + b) / 2, clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const spots: [number, number][] = [];
    if (r.top < IN && r.bottom > 0 && r.right > 0 && r.left < W) spots.push([clamp(mid(r.left, r.right), 0, W - 1), mid(Math.max(r.top, 0), Math.min(r.bottom, IN))]);
    if (r.left < left - 2 && r.right > 0 && r.bottom > F && r.top < H) spots.push([mid(Math.max(r.left, 0), Math.min(r.right, left - 2)), clamp(mid(r.top, r.bottom), F, H - 1)]);
    for (const [x, y] of spots) {
      const at = document.elementFromPoint(x, y);
      if (at && (at === el || el.contains(at))) intrudes.push(`${el.tagName.toLowerCase()}.${el.className} at ${box(el)}`);
    }
  }
  // What is loud in the frame: marks or words in ink that are not the place one is in, nor chosen, nor under the hand;
  // lines of ink; anything filled with ink.
  const loud: string[] = [];
  for (const el of document.querySelectorAll('.rail *, .door, .door *, .band-tools, .band-tools *, .band-held, .server-top *, .server-bar *')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.top < F || r.left < F) || r.bottom <= 0) continue;
    const c = getComputedStyle(el), chosen = el.closest('[aria-current="page"], [aria-checked="true"], [aria-pressed="true"], [aria-expanded="true"], :focus-within, :hover');
    if (chosen) continue;
    const name = `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`;
    const marks = el.matches('svg, svg *') ? getComputedStyle(el.closest('svg')!).color : c.color;
    const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
    if ((words || el.matches('svg')) && marks === INK) loud.push(`${name}: ${words ? 'words' : 'a mark'} in ink`);
    if (c.backgroundColor === INK) loud.push(`${name}: filled with ink`);
    for (const line of [c.outlineStyle !== 'none' && c.outlineWidth !== '0px' ? c.outlineColor : '', c.boxShadow.includes(INK) && !c.boxShadow.includes('12px') ? INK : ''])
      if (line === INK) loud.push(`${name}: a line of ink`);
  }
  const placesKey = [...document.querySelectorAll('#page .forge-places-key')].filter(shown).map((key) => ({
    key: box(key), label: box(key.querySelector('.places-label')!), text: key.textContent, expanded: key.getAttribute('aria-expanded'),
  }));
  const search = [...document.querySelectorAll('#page .forge-search-key')].filter(shown).map((key) => {
    const mark = key.querySelector('svg')!, c = getComputedStyle(key);
    return {label: key.getAttribute('aria-label'), key: box(key), mark: box(mark), color: c.color,
      inked: c.backgroundColor === INK || c.outlineStyle !== 'none' || c.boxShadow !== 'none'};
  });
  const door = document.querySelector('.door:not([hidden])');
  return {W, H, places, placesKey, search, door: door && shown(door) ? box(door) : null, intrudes, loud};
}

test('the frame is the camera\'s: one degree, receding, one square, a stable rail or corner, on two sides only, and quiet at rest', async ({signedIn: app}) => {
  test.setTimeout(300_000);
  await app.newRepo.make('hello', {template: 'C'});
  await app.git.write('hello', 'Fix: Say hello louder');
  await app.git.step('Start').click();
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.inbox.named();
  for (const size of SIZES) {
    // Receding: the frame's share of the screen, against film's safe-action margin (SMPTE ST 2046-1: 93% each way is
    // safe action, so 13.5% of the area is margin). On a desk screen it is inside it; on a phone the finger's target
    // rules, and it takes at most the title-safe margin's (19%), or a little more on the smallest (22%).
    const share = (F * size.width + F * size.height - F * F) / (size.width * size.height);
    expect(share, `the frame's share at ${size.width}×${size.height}`).toBeLessThanOrEqual(size.width >= 1024 && size.height >= 768 ? .135 : .223);
    await app.page.setViewportSize(size);
    let rail: string | null = null;
    for (const place of PLACES) {
      await app.rail.go(place);
      // At rest: the pointer off the frame, nothing being written in.
      await app.page.mouse.move(size.width - 2, size.height - 2);
      await app.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const what = `${place} at ${size.width}×${size.height}`;
      await expect(async () => {
        const f = await app.page.evaluate(framed);
        // One square: every place a 36 px square at a 48 px pitch from (6, 6), its mark 18 px centred, drawn at 2 px.
        for (const [i, p] of f.places.entries()) {
          expect(p.box, `${what}: ${p.label}'s square`).toEqual([6, 6 + i * F, 36, 36]);
          expect(p.mark, `${what}: ${p.label}'s mark`).toEqual([15, 15 + i * F, 18, 18]);
          expect(p.stroke, `${what}: ${p.label}'s stroke`).toBe('2px');
          // Quiet: ink only on the place one is in.
          expect(p.colour, `${what}: ${p.label}'s mark`).toBe(p.current ? INK : FRAME);
        }
        // The door, where there is one: two cells wide, a place's height, from the desk's edge on the rail's first row.
        if (f.door) expect(f.door, `${what}: the door`).toEqual([F, 6, F, 36]);
        // Constant: the rail the same in every place.
        const now = JSON.stringify(f.places.map((p) => [p.label, p.box, p.mark]));
        if (CORNER[place]) {
          expect(f.places, `${what}: no permanent rail on a work desk`).toHaveLength(0);
          expect(f.door, `${what}: no second way beside the Places key`).toBeNull();
          expect(f.search, `${what}: only Search on the right`).toEqual([{
            label: 'Search', key: [size.width - 12 - 44, 12, 44, 44], mark: [size.width - 12 - 31, 25, 18, 18],
            color: CORNER[place], inked: false,
          }]);
          expect(f.placesKey).toHaveLength(1);
          const {label, key, text, expanded} = f.placesKey[0]!;
          expect(text?.toLowerCase()).toBe(place.replace('-', ' '));
          const edge = size.width <= 1000 ? U : F;
          expect([label[0], label[1], label[3]], `${what}: place name follows Forge's anchor`).toEqual([edge, U, U]);
          expect([key[0], key[1], key[3], expanded]).toEqual([edge - 8, 14, 44, 'false']);
          expect(key[2]).toBeGreaterThanOrEqual(44);
          await expect(app.forge.placesKey).toHaveAccessibleName(text!);
          if (place === 'runtime') {
            const name = app.main.getByRole('heading', {name: 'Runtime', exact: true});
            await expect(name.getByRole('button', {name: 'Runtime', exact: true})).toBeVisible();
          }
        } else {
          expect([...f.placesKey, ...f.search], `${what}: only the permanent rail here`).toHaveLength(0);
          rail ??= now;
          expect(now, `${what}: the permanent rail as on the other places`).toBe(rail);
        }
        // Two sides: nothing of the world seen in the frame's strips.
        expect(f.intrudes, `${what}: the world in the frame`).toEqual([]);
        // Quiet: nothing of the frame in ink at rest but what is chosen.
        expect(f.loud, `${what}: loud in the frame`).toEqual([]);
      }).toPass({timeout: 5000});
    }
  }
});

test('the frame is ink only under the hand: the corner and the rail each answer where pressed', async ({signedIn: app}) => {
  await app.rail.go('home');
  const search = app.main.getByRole('button', {name: 'Search', exact: true}), places = app.forge.placesKey;
  await app.page.mouse.move(800, 600);
  await expect(search).toHaveCSS('color', QUIET);
  await expect(places).toHaveCSS('color', PAPER);
  await search.hover();
  await expect(search).toHaveCSS('color', PAPER);
  await expect(places).toHaveCSS('color', PAPER);
  await places.press('Enter');
  await expect(places.locator('.places-label')).toHaveCSS('text-decoration-line', 'underline');
  await app.page.keyboard.press('Escape');
  await expect(places).toBeFocused();

  await app.rail.go('remote');
  const forge = app.rail.button('forge');
  await app.page.mouse.move(800, 600);
  await expect(forge).toHaveCSS('color', FRAME);
  await forge.hover();
  await expect(forge).toHaveCSS('color', INK);
});
