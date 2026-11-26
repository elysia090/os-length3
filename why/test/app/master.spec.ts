import {expect, test} from './fixtures.ts';

// Master and servant (DESIGN §1): at every rest one thing is the master, and it alone holds the top of every channel a
// thing can be raised by: the fill, the ink edge, the shadow, the keyboard, what is written. Each channel has one top
// and the same thing holds all of them (no two centres of interest, no two violins); every other thing is its servant,
// a step under it in each. What can be done is the master's act, or taking another thing up (which makes it the
// master), or going elsewhere: nothing is done to a servant where it lies.

/** In the page: of the pieces of a desk in sight, which hold each channel's top. */
function channels(sel: string) {
  const EDGE = 'rgb(104, 101, 92)', GROUND = getComputedStyle(document.body).backgroundColor;
  const pieces = [...document.querySelectorAll<HTMLElement>(sel)].filter((p) => { const r = p.getBoundingClientRect(); return r.width && r.right > 48 && r.left < innerWidth; });
  const name = (p: HTMLElement) => p.dataset.key ?? p.getAttribute('aria-label') ?? p.className.toString().slice(0, 30);
  const has = (p: HTMLElement, what: (c: CSSStyleDeclaration) => boolean) => what(getComputedStyle(p));
  return {
    all: pieces.length,
    filled: pieces.filter((p) => has(p, (c) => c.backgroundColor !== GROUND && c.backgroundColor !== 'rgba(0, 0, 0, 0)')).map(name),
    inked: pieces.filter((p) => has(p, (c) => c.outlineColor === EDGE && c.outlineStyle !== 'none')).map(name),
    shadowed: pieces.filter((p) => has(p, (c) => c.boxShadow !== 'none')).map(name),
    keyboard: pieces.filter((p) => p.contains(document.activeElement)).map(name),
  };
}

test('one master holds every channel\'s top, and what is written goes to it alone', async ({signedIn: app}) => {
  await app.page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('hello', {template: 'C'});
  await app.rail.go('forge');
  for (const key of ['README.md', 'src/main.c']) {
    await app.forge.editor(key).focus();
    await expect(app.forge.piece(key)).toHaveClass(/held/);
    const c = await app.page.evaluate(channels, 'section.desk:not([hidden]) .desk-box');
    expect(c.all, 'pieces in sight').toBeGreaterThan(1);
    // Each channel has one top, and the same one holds them all.
    for (const [channel, holders] of Object.entries({fill: c.filled, edge: c.inked, shadow: c.shadowed, keyboard: c.keyboard})) {
      expect(holders, `${key} in hand: the ${channel}`).toEqual([key]);
    }
    await expect(app.forge.piece(key)).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 4px 4px 0px 0px');
    // What is written goes to the master alone: every servant's text is as it was.
    const before = await app.page.evaluate(() => [...document.querySelectorAll<HTMLTextAreaElement>('section.desk:not([hidden]) .desk-box:not(.held) textarea')].map((t) => t.value));
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.type(' x');
    const after = await app.page.evaluate(() => [...document.querySelectorAll<HTMLTextAreaElement>('section.desk:not([hidden]) .desk-box:not(.held) textarea')].map((t) => t.value));
    expect(after, `${key} in hand: the servants untouched`).toEqual(before);
    await expect(app.forge.editor(key)).toHaveValue(/ x$/);
  }
});
