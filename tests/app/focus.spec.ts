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

test('on Forge\'s desk, what is not words weighs at least eight times as much in the piece in hand as in any other in sight, whichever is in hand', async ({app}) => {
  await app.newRepo.openInForge();
  const pieces = () => app.forge.desk.locator('.desk-box').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return {key: (b as HTMLElement).dataset.key!, held: b.classList.contains('held'), x: r.left, y: r.top, r: r.right + 12, b: r.bottom + 12}; }));
  for (const take of [() => app.forge.promptBox.click(), () => app.forge.editor('README.md').focus()]) {
    await take();
    await app.page.mouse.move(1530, 726);
    await expect.poll(async () => (await pieces()).filter((p) => p.held).length).toBe(1);
    await app.page.waitForTimeout(300);
    // The words out of sight: what is weighed is the fill, the shadow and the edge.
    const style = await app.page.addStyleTag({content: '.desk-box, .desk-box * { color: transparent !important; caret-color: transparent !important; } .vt-cursor, .os-caret { visibility: hidden !important; }'});
    const seen = (await pieces()).filter((p) => p.x >= 48 && p.r - 12 <= 1536);
    expect(seen.length).toBeGreaterThan(1);
    const weight = await ink(app.page, seen);
    await style.evaluate((el) => (el as Element).remove());
    const mine = weight[seen.findIndex((p) => p.held)], other = Math.max(...weight.filter((_, i) => !seen[i].held));
    expect(mine / other, `${seen.find((p) => p.held)!.key} in hand: ${Math.round(mine)} to ${Math.round(other)}`).toBeGreaterThanOrEqual(8);
  }
});

test('Home has one body of ink, the note: it weighs at least eight times what waits beside it', async ({app}) => {
  await app.rail.go('home');
  await app.page.mouse.move(1530, 726);
  const box = async (sel: string) => { const r = (await app.main.locator(sel).first().boundingBox())!; return {x: r.x, y: r.y, r: r.x + r.width + 12, b: r.y + r.height + 12}; };
  const [note, slip] = await ink(app.page, [await box('.home-own > .section'), await box('.home-waits > .lately')]);
  expect(note / slip, `${Math.round(note)} to ${Math.round(slip)}`).toBeGreaterThanOrEqual(8);
});
