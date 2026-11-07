// Where each box of the desk lies (desk.ts), and where the camera looks: kept apart from the page so it is measured
// and tested as numbers. The desk is a plane on a 24 px grid; its boxes stand in columns, each box as wide as 80
// columns of code, one under another in its column with three grid steps between them, the columns two steps apart.
// The camera has three places, as a game's cameras do: its standard, every box at its own size, the box in hand in the
// middle (a balance found good: never nearer than that); a step back, the boxes beside it in sight; and the whole desk.

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
/** The standard: every box at its own size. A step back, the box in hand still read and those beside it in sight; the
 * whole desk, at most half of it. */
export const STANDARD = 1;
export const PULLED = 0.7;
export const WHOLE_MOST = 0.5;

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

/** How far down the face a short box stands at most: where the eye starts. */
export const EYE = .25;

/**
 * At the standard, on the box at `slot` (`h` high) in a face `w` by `hgt`: the box's middle in the face's middle across;
 * a box that fits in the middle of the height too, but never lower than a quarter of the way down (a short box stands
 * where the eye starts, not in a hole in the middle), a tall one from its top.
 */
export function standardOn(slot: Slot, h: number, w: number, hgt: number, s = STANDARD): View {
  const x = w / 2 - (slot.x + WIDTH / 2) * s;
  const top = Math.min(Math.max(TOP + 16, (hgt - h * s) / 2), Math.max(TOP + 16, hgt * EYE));
  return {s, x, y: top - slot.y * s};
}

/** A step back, on the box at `slot` (`h` high): as at the standard, smaller, the boxes beside it in sight. */
export function pulledOn(slot: Slot, h: number, w: number, hgt: number): View {
  return standardOn(slot, h, w, hgt, PULLED);
}

/** Stepped back: the whole desk (each box's slot and height, its name over it, its shadow) in the face, at most
 * WHOLE_MOST, centred. */
export function wholeOf(boxes: {slot: Slot; h: number}[], w: number, hgt: number): View {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const {slot, h} of boxes) { l = Math.min(l, slot.x); t = Math.min(t, slot.y - 24); r = Math.max(r, slot.x + WIDTH + 8); b = Math.max(b, slot.y + h + 8); }
  if (!isFinite(l)) return {s: WHOLE_MOST, x: 0, y: 0};
  const s = Math.min(WHOLE_MOST, (w - 96) / (r - l), (hgt - 96) / (b - t));
  return {s, x: (w - (r - l) * s) / 2 - l * s, y: Math.max(TOP, (hgt - (b - t) * s) / 2) - t * s};
}

/**
 * At the standard, over the boxes at `boxes` (each its slot and height) at once, as they lie: their middle in the
 * face's middle when they all fit in it; null when they do not (the camera goes along to the one at work instead,
 * never stepping back for them).
 */
export function overAll(boxes: {slot: Slot; h: number}[], w: number, hgt: number): View | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const {slot, h} of boxes) { l = Math.min(l, slot.x); t = Math.min(t, slot.y); r = Math.max(r, slot.x + WIDTH); b = Math.max(b, slot.y + h); }
  if (r - l > w - 2 * PAD || b - t > hgt - 2 * PAD) return null;
  return {s: STANDARD, x: (w - (r - l)) / 2 - l, y: Math.max(PAD, (hgt - (b - t)) / 2) - t};
}

/** The box after `from` (before it, `back`) as Tab goes: down each column, then the next column's top, round again. */
export function tabbed(cols: readonly (readonly string[])[], from: string, back = false): string | null {
  const all = cols.flat();
  const i = all.indexOf(from);
  if (i < 0) return all[0] ?? null;
  return all[(i + (back ? all.length - 1 : 1)) % all.length];
}

/** The box `from` hands over to going `way` (an arrow, the finger on it): along its column, or the next column's nearest. */
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
