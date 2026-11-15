import type {Page} from '@playwright/test';

// The weight of a shot, measured on what is drawn (DESIGN §5: a pixel's ink is how far its colour is from the ground's
// in CIE Lab, full at 50; the ground's dots are the ground).

/** Where the weight of what is drawn in the world lies across it, from its middle (-1 its left edge, 1 its right). */
export async function across(page: Page): Promise<number> {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width, c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const lab = (r: number, gr: number, b: number) => {
      const f = (v: number) => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; };
      r = f(r), gr = f(gr), b = f(b);
      let x = (r * .4124 + gr * .3576 + b * .1805) / .95047, y = r * .2126 + gr * .7152 + b * .0722, z = (r * .0193 + gr * .1192 + b * .9505) / 1.08883;
      const k = (t: number) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      x = k(x), y = k(y), z = k(z);
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const ground = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number), G = lab(ground[0], ground[1], ground[2]);
    // (The ground's dots are the ground: a pixel of the dot's colour is not ink.)
    const D = lab(0x96, 0x93, 0x8e);
    let sum = 0, sx = 0;
    for (let y = 48; y < H; y += 2) for (let x = 48; x < W; x += 2) {
      const i = 4 * (y * W + x), L = lab(d[i], d[i + 1], d[i + 2]);
      if (Math.hypot(L[0] - D[0], L[1] - D[1], L[2] - D[2]) < 6) continue;
      const ink = Math.min(1, Math.hypot(L[0] - G[0], L[1] - G[1], L[2] - G[2]) / 50);
      sum += ink, sx += ink * x;
    }
    return (sx / sum - (48 + W) / 2) / ((W - 48) / 2);
  }, `data:image/png;base64,${shot}`);
}
