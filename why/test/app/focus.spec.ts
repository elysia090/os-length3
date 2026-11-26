import type {Page} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Where the ink is (the eye goes where the weight is): measured on what is drawn, not looked at. A pixel's ink is how
// far its colour is from the ground's (CIE Lab, full at a distance of 50). On a desk the piece in hand alone is
// filled and casts a shadow, so what is not words (fill, shadow, edge) weighs at least eight times as much in it as in
// any other piece in sight, whichever is in hand; and Home has one body of ink, the note.

test.use({storageState: async ({helloC}, use) => { await use(helloC); }, viewport: {width: 1536, height: 730}});

/** The ink in each of `rects` on the page as it is drawn now. */
async function ink(page: Page, rects: {x: number; y: number; r: number; b: number}[]): Promise<number[]> {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([src, rects]) => {
    const img = new Image();
    img.src = src as string;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width, c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width;
    const lab = (r: number, gr: number, b: number) => {
      const f = (v: number) => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; };
      r = f(r), gr = f(gr), b = f(b);
      let x = (r * .4124 + gr * .3576 + b * .1805) / .95047, y = r * .2126 + gr * .7152 + b * .0722, z = (r * .0193 + gr * .1192 + b * .9505) / 1.08883;
      const h = (t: number) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      x = h(x), y = h(y), z = h(z);
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const ground = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number), G = lab(ground[0], ground[1], ground[2]);
    return (rects as {x: number; y: number; r: number; b: number}[]).map((r) => {
      let sum = 0;
      for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(c.height, r.b); y++) for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(W, r.r); x++) {
        const i = 4 * (y * W + x), L = lab(d[i], d[i + 1], d[i + 2]);
        sum += Math.min(1, Math.hypot(L[0] - G[0], L[1] - G[1], L[2] - G[2]) / 50);
      }
      return sum;
    });
  }, [`data:image/png;base64,${shot}`, rects] as const);
}

test('on Forge\'s desk, the one document in hand is at least eight times as heavy as the other; Prompt is separate', async ({app}) => {
  const {forge, page} = app;
  await app.newRepo.openInForge();
  // The template opened three papers; keep two whole ones in the photograph.
  // Closing the third is an ordinary Forge action, not a test-only change to the layout.
  await forge.editor('Makefile').focus();
  await forge.piece('Makefile').getByRole('button', {name: 'Close Makefile', exact: true}).click();
  await expect(forge.desk.locator('.desk-box')).toHaveCount(2);
  const paths = ['README.md', 'src/main.c'];
  const shade = 4;
  const positions = async () => Promise.all(paths.map(async (path) => {
    const {x, y, width, height} = (await forge.piece(path).boundingBox())!;
    return {x, y, r: x + width + shade, b: y + height + shade};
  }));
  for (const [at, path] of paths.entries()) {
    await forge.editor(path).focus();
    await page.mouse.move(1530, 726);
    await expect(forge.desk.locator('.desk-box.held')).toHaveCount(1);
    const mine = forge.piece(path), other = forge.piece(paths[1 - at]!);
    await expect(mine).toHaveClass(/\bheld\b/);
    await expect(mine).toHaveCSS('box-shadow', / 4px 4px 0px 0px$/);
    await expect(other).toHaveCSS('box-shadow', 'none');
    await expect(mine).toBeInViewport({ratio: 1});
    await expect(other).toBeInViewport({ratio: 1});
    const seen = await positions();
    for (const box of seen) expect(box.x >= 48 && box.y >= 0 && box.r <= 1536 && box.b <= 730).toBe(true);
    // Weigh only the fill, the shadow and the edge, while the paper stays where it is.
    const style = await page.addStyleTag({content: '.desk-box, .desk-box * { color: transparent !important; caret-color: transparent !important; } .vt-cursor, .os-caret { visibility: hidden !important; }'});
    let weight: number[];
    try { weight = await ink(page, seen); } finally { await style.evaluate((el) => (el as Element).remove()); }
    expect(weight[at]! / weight[1 - at]!, `${path} in hand: ${Math.round(weight[at]!)} to ${Math.round(weight[1 - at]!)}`).toBeGreaterThanOrEqual(8);
  }

  // The adjacent Prompt is a peer place, not a third document or a competing shadow.
  const before = await positions();
  await forge.use('Prompt');
  await expect(forge.promptBox).toBeFocused();
  await expect(forge.desk.locator('.desk-box')).toHaveCount(2);
  for (const path of paths) await expect(forge.piece(path)).toHaveCSS('box-shadow', 'none');
  await expect.poll(positions).toEqual(before);
  await forge.use('Forge');
  await expect(forge.promptBox).toBeHidden();
  await expect(forge.editor('src/main.c')).toBeFocused();
  await expect(forge.piece('src/main.c')).toHaveCSS('box-shadow', / 4px 4px 0px 0px$/);
  await expect.poll(positions).toEqual(before);
});

test('Home has one body of ink, the note: it weighs at least eight times what waits beside it', async ({app}) => {
  await app.rail.go('home');
  await app.page.mouse.move(1530, 726);
  const box = async (sel: string) => { const r = (await app.main.locator(sel).first().boundingBox())!; return {x: r.x, y: r.y, r: r.x + r.width + 12, b: r.y + r.height + 12}; };
  const [note, slip] = await ink(app.page, [await box('.home-own > .section'), await box('.home-waits > .lately')]);
  expect(note / slip, `${Math.round(note)} to ${Math.round(slip)}`).toBeGreaterThanOrEqual(8);
});
