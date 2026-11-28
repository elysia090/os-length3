import type {Page} from '@playwright/test';

// The weight of a shot, measured on what is drawn (DESIGN §5: a pixel's ink is how far its colour is from the ground's
// in CIE Lab, full at 50; the ground's dots are the ground).

/** Where the weight of what is drawn in the world lies across it, from its middle (-1 its left edge, 1 its right). */
export function across(page: Page): Promise<number> { return measure(page, 'weight'); }

/** The world in cells of 24 px from the frame's corner, each as drawn: 'g' bare ground (its colour and its dot only), 'p'
 * bare paper, 'x' a mark on it (DESIGN §2, the negative space). */
export function emptiness(page: Page, pitch = 24): Promise<string[]> { return measure(page, 'cells', pitch); }

function measure(page: Page, mode: 'weight'): Promise<number>;
function measure(page: Page, mode: 'cells', pitch: number): Promise<string[]>;
async function measure(page: Page, mode: 'weight' | 'cells', pitch = 24): Promise<number | string[]> {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({source, mode, pitch}) => {
    const img = new Image();
    img.src = source;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const lab = (r: number, gr: number, b: number) => {
      const f = (v: number) => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; };
      r = f(r); gr = f(gr); b = f(b);
      let x = (r * .4124 + gr * .3576 + b * .1805) / .95047, y = r * .2126 + gr * .7152 + b * .0722, z = (r * .0193 + gr * .1192 + b * .9505) / 1.08883;
      const k = (t: number) => (t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      x = k(x); y = k(y); z = k(z);
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const paint = (color: string): number[] => {
      g.fillStyle = 'transparent';
      g.fillStyle = color.trim();
      const hex = g.fillStyle;
      if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected opaque material, got ${color}`);
      return lab(...([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]));
    };
    const body = getComputedStyle(document.body);
    const G = paint(body.backgroundColor);
    const dot = /radial-gradient\(circle,\s*(rgb\([^)]*\))/.exec(body.backgroundImage)?.[1];
    const D = dot ? paint(dot) : null;
    const pixels = (x: number, y: number) => {
      const i = 4 * (y * W + x);
      return lab(d[i], d[i + 1], d[i + 2]);
    };
    const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const isDot = (p: number[]) => !!D && far(p, D) < 6;
    if (mode === 'weight') {
      let sum = 0, sx = 0;
      for (let y = 48; y < H; y += 2) for (let x = 48; x < W; x += 2) {
        const p = pixels(x, y);
        if (isDot(p)) continue;
        const ink = Math.min(1, far(p, G) / 50);
        sum += ink; sx += ink * x;
      }
      return (sx / sum - (48 + W) / 2) / ((W - 48) / 2);
    }

    // Git and other desks can keep their paper local even when the body lays that place's ground.
    const page = document.querySelector('#page') ?? document.body;
    const surface = getComputedStyle(page);
    const P = paint(surface.getPropertyValue('--paper'));
    const grain = surface.getPropertyValue('--forge-paper-grain');
    const GP = grain ? paint(grain) : null;
    // Only inside the Home note's actual rectangle is its yellow stock bare paper. A mark elsewhere stays a mark.
    const note = page.matches('[data-place="home"]') ? page.querySelector('.home-portrait .home-own > .section') : null;
    const home = note?.getClientRects().length ? {at: note.getBoundingClientRect(), fill: paint(getComputedStyle(note).backgroundColor)} : null;
    // The slate face and its tiny check are stock, not writing, and only inside the visible work sheet.
    const work = page.matches('[data-place="forge"]')
      ? page.querySelector('.desk-room[data-hand="Forge"] > .desk:not([hidden],[inert]) .desk-box.held:not([data-kind])') : null;
    const sheet = work?.getClientRects().length ? (() => {
      const css = getComputedStyle(work);
      if (css.visibility === 'hidden') return null;
      const colors = [css.backgroundColor, ...css.backgroundImage.match(/rgb\([^)]*\)/g) ?? []];
      return {at: work.getBoundingClientRect(), colors: [...new Set(colors)].map(paint)};
    })() : null;
    const rows: string[] = [];
    for (let j = 0; j < Math.floor((H - 48) / pitch); j++) {
      let line = '';
      for (let i = 0; i < Math.floor((W - 48) / pitch); i++) {
        let ground = 0, paper = 0, n = 0;
        for (let y = 48 + j * pitch; y < 48 + (j + 1) * pitch; y += 2) for (let x = 48 + i * pitch; x < 48 + (i + 1) * pitch; x += 2) {
          const p = pixels(x, y);
          n++;
          if (far(p, G) < 3 || isDot(p)) ground++;
          else if (far(p, P) < 3 || GP && far(p, GP) < 3 || home && x >= home.at.left && x < home.at.right &&
            y >= home.at.top && y < home.at.bottom && far(p, home.fill) < 3 ||
            sheet && x >= sheet.at.left && x < sheet.at.right && y >= sheet.at.top && y < sheet.at.bottom &&
              sheet.colors.some(fill => far(p, fill) < 3)) paper++;
        }
        line += ground === n ? 'g' : paper === n ? 'p' : 'x';
      }
      rows.push(line);
    }
    return rows;
  }, {source:`data:image/png;base64,${shot}`, mode, pitch});
}

/** The bare ground's fields (joined cells of it): each one's size, and whether it reaches the world's edge (the frame's
 * line or the window's), its open sides (the window's right or foot). */
export function fields(rows: string[]): {n: number; edge: boolean; open: boolean}[] {
  const R = rows.length, C = rows[0]?.length ?? 0, seen = rows.map((r) => [...r].map(() => false)), out: {n: number; edge: boolean; open: boolean}[] = [];
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
    if (rows[j]![i] !== 'g' || seen[j]![i]) continue;
    const todo: [number, number][] = [[j, i]];
    seen[j]![i] = true;
    let n = 0, edge = false, open = false;
    while (todo.length) {
      const [y, x] = todo.pop()!;
      n++;
      if (y === 0 || x === 0 || y === R - 1 || x === C - 1) edge = true;
      if (y === R - 1 || x === C - 1) open = true;
      for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ny = y + dy, nx = x + dx;
        if (ny >= 0 && ny < R && nx >= 0 && nx < C && !seen[ny]![nx] && rows[ny]![nx] === 'g') { seen[ny]![nx] = true; todo.push([ny, nx]); }
      }
    }
    out.push({n, edge, open});
  }
  return out.sort((a, b) => b.n - a.n);
}

/** How much of a part of the world is empty (bare ground or bare paper): rows `r0` to `r1`, columns `c0` to `c1`. */
export function emptyIn(rows: string[], r0: number, r1: number, c0: number, c1: number): number {
  let empty = 0, all = 0;
  for (let j = r0; j < r1; j++) for (let i = c0; i < c1; i++) { all++; if (rows[j]![i] !== 'x') empty++; }
  return all ? empty / all : 0;
}
