// Where each box of the desk lies (desk.ts), and where the camera looks: kept apart from the page so it is measured
// and tested as numbers. The desk is a plane on a 24 px grid; its boxes stand in columns, each box as wide as 80
// columns of code, one under another in its column with three grid steps between them, the columns two steps apart.
// The camera has two distances: the base, every box at its own size, and close, as near as the box still fits the
// face across (an eighth to a quarter nearer), for work on a few lines. It never steps back further than the base:
// what is not in sight there is a scroll away.

/** The grid the desk is laid on. */
export const GRID = 24;
/** A box's width: 80 columns of the desk's code (14 px, 8.42 px a column), its numbers and its padding, up to the grid. */
export const WIDTH = up(80 * 8.42 + 72);
/** Between two columns, and between two boxes of one column. */
export const GAP = 2 * GRID;
export const VGAP = 3 * GRID;
/** The desk's margin round its boxes. */
export const PAD = 36;
/** Room above a column's first box for its name. */
export const TOP = 48;
/** The camera's two distances: the base, and close (between the least and the most, as near as the box fits across). */
export const BASE = 1;
export const CLOSE_LEAST = 1.12;
export const CLOSE_MOST = 1.25;

function up(v: number): number { return GRID * Math.ceil(v / GRID); }

export interface Slot { x: number; y: number }

/** Each box's place: `cols` (each column's keys, top first), `heights` each box's height. */
export function slots(cols: readonly (readonly string[])[], heights: (key: string) => number): Map<string, Slot> {
  const out = new Map<string, Slot>();
  cols.forEach((col, c) => {
    let y = TOP;
    for (const key of col) {
      out.set(key, {x: PAD + c * (WIDTH + GAP), y});
      y += up(heights(key)) + VGAP;
    }
  });
  return out;
}

/** The camera: the plane's scale, and where its origin is on the face. */
export interface View { s: number; x: number; y: number }

/**
 * At the base, on the box at `slot` (`h` high) in a face `w` by `hgt`: the box's middle in the face's middle across, its
 * top a little under the face's top (all of it, when it fits; its top, when it does not).
 */
export function baseOn(slot: Slot, h: number, w: number, hgt: number): View {
  const s = BASE;
  const x = w / 2 - (slot.x + WIDTH / 2) * s;
  const fits = h * s + 2 * TOP <= hgt;
  const y = fits ? Math.min(TOP, (hgt - h * s) / 2) - slot.y * s : TOP - slot.y * s;
  return {s, x, y};
}

/**
 * Close on the box at `slot` (`h` high), where the work is in it (`at`, from the box's top left; none: its top): the
 * box in the middle across when it fits, else from its left edge, `at` kept in sight; `at` a little over the face's
 * middle, never past the box's top or foot when the box is taller than the face.
 */
export function closeOn(slot: Slot, h: number, w: number, hgt: number, at: {x: number; y: number} | null): View {
  const s = Math.min(CLOSE_MOST, Math.max(CLOSE_LEAST, (w - 2 * PAD) / WIDTH)), bw = WIDTH * s, bh = h * s;
  let x = bw + 2 * PAD <= w ? w / 2 - (slot.x + WIDTH / 2) * s : PAD - slot.x * s;
  // The work past the face's right: along with it, never so far that the box's right edge comes in off the margin.
  if (at && x + (slot.x + at.x) * s > w - 2 * PAD) x = Math.max(w * 2 / 3 - (slot.x + at.x) * s, w - PAD - (slot.x + WIDTH) * s);
  let y: number;
  if (bh + 2 * TOP <= hgt) y = Math.min(TOP, (hgt - bh) / 2) - slot.y * s;
  else {
    y = at ? hgt * .42 - (slot.y + at.y) * s : TOP - slot.y * s;
    y = Math.min(y, TOP - slot.y * s);
    y = Math.max(y, hgt - TOP - (slot.y + h) * s);
  }
  return {s, x, y};
}

/**
 * At the base, over the boxes at `boxes` (each its slot and height) at once, as they lie: their middle in the face's
 * middle when they all fit in it; null when they do not (the camera goes to the one last at work instead).
 */
export function overAll(boxes: {slot: Slot; h: number}[], w: number, hgt: number): View | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const {slot, h} of boxes) { l = Math.min(l, slot.x); t = Math.min(t, slot.y); r = Math.max(r, slot.x + WIDTH); b = Math.max(b, slot.y + h); }
  if (r - l > w - 2 * PAD || b - t > hgt - 2 * PAD) return null;
  return {s: BASE, x: (w - (r - l)) / 2 - l, y: Math.max(PAD, (hgt - (b - t)) / 2) - t};
}

/** The box `from` hands over to going `way` (Alt and an arrow): along its column, or the next column's nearest. */
export function next(cols: readonly (readonly string[])[], from: string, way: 'up' | 'down' | 'left' | 'right'): string | null {
  const c = cols.findIndex((col) => col.includes(from));
  if (c < 0) return null;
  const i = cols[c].indexOf(from);
  if (way === 'up') return cols[c][i - 1] ?? null;
  if (way === 'down') return cols[c][i + 1] ?? null;
  const to = cols[c + (way === 'left' ? -1 : 1)];
  if (!to?.length) return null;
  return to[Math.min(i, to.length - 1)];
}

/**
 * `cols` with `key` carried a slot `way` (Ctrl and an arrow): along its column, the others stepping over; or into the
 * next column at the same height (a new column past the last, none emptied but its own going).
 */
export function carried(cols: readonly (readonly string[])[], key: string, way: 'up' | 'down' | 'left' | 'right'): string[][] {
  const out = cols.map((col) => [...col]);
  const c = out.findIndex((col) => col.includes(key));
  if (c < 0) return out;
  const i = out[c].indexOf(key);
  if (way === 'up' || way === 'down') {
    const j = i + (way === 'up' ? -1 : 1);
    if (j < 0 || j >= out[c].length) return out;
    [out[c][i], out[c][j]] = [out[c][j], out[c][i]];
    return out;
  }
  const d = c + (way === 'left' ? -1 : 1);
  if (d < 0) return out;
  out[c].splice(i, 1);
  if (d === out.length) out.push([]);
  out[d].splice(Math.min(i, out[d].length), 0, key);
  return out.filter((col, k) => col.length || k === 0);
}
